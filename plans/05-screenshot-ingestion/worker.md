# Screenshot Ingestion — Worker

This plan replaces the `process-screenshot` stub from [`apps/api/src/workers/process-screenshot.ts`](../../apps/api/src/workers/process-screenshot.ts) with the real implementation.

The worker's job: take an `uploaded` screenshot, generate a thumbnail (and a blurred full if the project requests it), write both to R2, and flip the row to `processed`. On failure, retry; after exhaustion, mark `failed`.

## Stub today

```ts
export const process = async (_job: Job<ProcessScreenshotJob>): Promise<void> => {
  // Stub. Real implementation lands with the screenshot pipeline plan.
};
```

That's the entirety of the existing implementation. Plan 01 wired the BullMQ Worker; Plan 05 fills the body.

## Real implementation

### Top-level shape

```ts
import { Worker, type Job } from 'bullmq';
import sharp from 'sharp';

import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import {
  getObjectBytes,
  putObjectBytes,
  __setR2Provider, // re-exported for tests
} from '../lib/r2.js';
import { thumbnailKey, blurredKey } from '../lib/screenshot-keys.js';

export const PROCESS_SCREENSHOT_QUEUE = 'process-screenshot';

export interface ProcessScreenshotJob {
  screenshotId: string;
}

const THUMB_LONG_EDGE = 480;
const THUMB_QUALITY = 70;
const BLUR_SIGMA = 20;

export const process = async (job: Job<ProcessScreenshotJob>): Promise<void> => {
  const { screenshotId } = job.data;

  const row = await prisma.screenshot.findUnique({
    where: { id: screenshotId },
    include: {
      timeEntry: {
        include: {
          project: { select: { id: true, orgId: true, blurScreenshots: true } },
          user: { select: { id: true } },
        },
      },
    },
  });

  if (!row) {
    logger.warn({ screenshotId }, 'process-screenshot: row not found; treating as success');
    return;
  }

  if (row.status === 'processed') {
    // Idempotent re-run; nothing to do.
    return;
  }

  if (row.status !== 'uploaded') {
    // pending → either presign succeeded but confirm hasn't arrived; or pre-confirm replay.
    // failed → already given up; needs manual intervention.
    logger.warn(
      { screenshotId, status: row.status },
      'process-screenshot: unexpected status; skipping',
    );
    return;
  }

  const original = await getObjectBytes(row.s3Key);
  const project = row.timeEntry.project;
  const userId = row.timeEntry.user.id;

  // Always generate a thumbnail.
  const baseSharp = sharp(original).rotate(); // honor EXIF orientation
  const thumbBuffer = await baseSharp
    .clone()
    .resize({
      width: THUMB_LONG_EDGE,
      height: THUMB_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();

  const thumbKey = thumbnailKey({
    orgId: project.orgId,
    userId,
    capturedAt: row.capturedAt,
    screenshotId: row.id,
  });
  await putObjectBytes(thumbKey, thumbBuffer, 'image/webp');

  // If the project blurs screenshots, also write a blurred original.
  let blurKey: string | null = null;
  if (project.blurScreenshots) {
    // Apply blur to the *thumbnail too* — not to the served thumbnail above
    // (we already PUT it). Re-render the thumbnail blurred and overwrite.
    const blurredThumb = await baseSharp
      .clone()
      .resize({ width: THUMB_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .blur(BLUR_SIGMA)
      .webp({ quality: THUMB_QUALITY })
      .toBuffer();
    await putObjectBytes(thumbKey, blurredThumb, 'image/webp');

    // Blurred full — same dimensions as original, blurred. Used by the member view.
    const ctOriginal = mimeFromKey(row.s3Key); // 'image/jpeg' | 'image/png' | 'image/webp'
    const blurredFull = await baseSharp.clone().blur(BLUR_SIGMA).toBuffer();
    blurKey = blurredKey(
      { orgId: project.orgId, userId, capturedAt: row.capturedAt, screenshotId: row.id },
      ctOriginal,
    );
    await putObjectBytes(blurKey, blurredFull, ctOriginal);
  }

  await prisma.screenshot.update({
    where: { id: row.id },
    data: {
      status: 'processed',
      thumbnailS3Key: thumbKey,
      blurredS3Key: blurKey,
      blurred: project.blurScreenshots,
    },
  });
};

const mimeFromKey = (key: string): string => {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
};
```

### Worker registration

The existing [`registerProcessScreenshotWorker`](../../apps/api/src/workers/process-screenshot.ts) wraps this in a BullMQ `Worker`. We only need to update the `process` body and tweak the registration to set retry options:

```ts
export const registerProcessScreenshotWorker = (): Worker<ProcessScreenshotJob> => {
  const worker = new Worker<ProcessScreenshotJob>(PROCESS_SCREENSHOT_QUEUE, process, {
    connection: redis,
    concurrency: 2, // small parallel — sharp is CPU-heavy
  });
  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err }, 'process-screenshot job failed');
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 5)) {
      // Final failure — mark the row as failed for visibility.
      await prisma.screenshot
        .update({
          where: { id: job.data.screenshotId },
          data: { status: 'failed' },
        })
        .catch((e) => logger.error({ err: e }, 'failed to mark screenshot as failed'));
    }
  });
  return worker;
};
```

## Job options on enqueue

The screenshots service (in [modules.md](./modules.md#confirmscreenshot-caller-screenshotid-input)) enqueues with:

```ts
queue.add(
  'process-screenshot',
  { screenshotId },
  {
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 }, // 30s, 60s, 120s, 240s, 480s
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
    removeOnFail: { age: 30 * 24 * 60 * 60 },
  },
);
```

Five attempts spaced by exponential backoff covers ~17 minutes. After that the row is `failed`; an operator can re-enqueue manually if they want a retry. We don't auto-retry forever — at our scale, manual triage is cheaper than building self-healing logic.

## Worker characteristics worth pinning down

- **Concurrency: 2.** Sharp is CPU-heavy. On a small VM (1–2 vCPU), 2 in flight pegs the box but doesn't queue starve. We can revisit if backlog grows.
- **Memory: ~50–100 MB per concurrent job.** A 1080p JPEG decompressed in `sharp` is ~6 MB raw; with two passes (thumbnail + blur) we peak at ~12 MB plus the SDK buffers. Add headroom for V8 and we land at ~50 MB. With `concurrency: 2`, plan ~150 MB of working memory for the worker process.
- **No long-running connections.** Each job opens an R2 GET, processes in memory, opens a PUT (or two), closes. The worker process can be restarted at any time without losing state — BullMQ requeues the in-flight job.

## Idempotency at the worker level

Three forces at play:

1. **BullMQ retries** — same job, same data, can be re-run. Our `process` short-circuits if `status === 'processed'`.
2. **Re-confirm via `Idempotency-Key`** — the confirm endpoint replays the _same response_ but doesn't re-enqueue (idempotency-cached path). Even if it did, see (1).
3. **R2 PUT is idempotent** — same key + same bytes overwrites with the same content; same key + different bytes (rare; only if `sharp` is non-deterministic) wins-last but the row reflects the latest write.

## What this worker does NOT do

- **No image hashing for dedup.** Per [docs/07-screenshot-pipeline.md:115](../../docs/07-screenshot-pipeline.md#L115).
- **No OCR.** Same source.
- **No object lifecycle management.** Retention sweeper is v0.9.
- **No status push to the desktop.** The desktop polls (`GET /screenshots/:id` or relies on the next list page). No WebSocket here.
- **No metric emission yet.** When we add observability, processing time and queue depth go in. For Plan 05, log lines are sufficient.

## Failure modes and how the worker reacts

| Failure                             | What `process()` does                                                                 | Final outcome                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| R2 GET 404 (object never landed)    | Throws; BullMQ retries                                                                | After 5 attempts → `failed`. Operator inspects R2 + DB. |
| R2 GET 5xx                          | Throws; BullMQ retries                                                                | Usually succeeds within retries.                        |
| `sharp` throws (corrupt image)      | Throws; BullMQ retries (won't help)                                                   | After 5 attempts → `failed`. Manual delete or repair.   |
| R2 PUT 5xx                          | Throws; BullMQ retries                                                                | Usually succeeds within retries.                        |
| DB write failed after PUT succeeded | Throws; BullMQ retries — re-runs `process()`, idempotent on R2 keys but re-runs sharp | Eventually succeeds. Wasted CPU on retry; acceptable.   |
| Process killed mid-job              | BullMQ requeues                                                                       | New worker picks up, idempotent path.                   |

The combination of idempotent R2 writes + idempotent DB updates + bounded retries is enough; we don't add complex saga-style state tracking.

## Worker test seam

Tests don't run BullMQ. They call `process(job)` directly with a fake `Job` object and `__setR2Provider` swapped to a stub that captures keys + buffers. See [testing.md](./testing.md).

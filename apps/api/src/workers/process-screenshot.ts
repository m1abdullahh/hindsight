import { Worker, type Job } from 'bullmq';
import sharp from 'sharp';

import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getObjectBytes, putObjectBytes } from '../lib/r2.js';
import { redis } from '../lib/redis.js';
import { blurredKey, mimeFromKey, thumbnailKey } from '../lib/screenshot-keys.js';

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
    return;
  }

  if (row.status !== 'uploaded') {
    logger.warn(
      { screenshotId, status: row.status },
      'process-screenshot: unexpected status; skipping',
    );
    return;
  }

  const project = row.timeEntry.project;
  const userId = row.timeEntry.user.id;
  const original = await getObjectBytes(row.s3Key);

  const baseSharp = sharp(original).rotate();

  // Always render the thumbnail.
  const renderThumb = async (): Promise<Buffer> => {
    const pipeline = baseSharp.clone().resize({
      width: THUMB_LONG_EDGE,
      height: THUMB_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    });
    if (project.blurScreenshots) pipeline.blur(BLUR_SIGMA);
    return pipeline.webp({ quality: THUMB_QUALITY }).toBuffer();
  };

  const thumbBuffer = await renderThumb();
  const thumbKey = thumbnailKey({
    orgId: project.orgId,
    userId,
    capturedAt: row.capturedAt,
    screenshotId: row.id,
  });
  await putObjectBytes(thumbKey, thumbBuffer, 'image/webp');

  let blurKey: string | null = null;
  if (project.blurScreenshots) {
    const ctOriginal = mimeFromKey(row.s3Key);
    const blurredFull = await baseSharp.clone().blur(BLUR_SIGMA).toBuffer();
    blurKey = blurredKey(
      {
        orgId: project.orgId,
        userId,
        capturedAt: row.capturedAt,
        screenshotId: row.id,
      },
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

export const registerProcessScreenshotWorker = (): Worker<ProcessScreenshotJob> => {
  const worker = new Worker<ProcessScreenshotJob>(PROCESS_SCREENSHOT_QUEUE, process, {
    connection: redis,
    concurrency: 2,
  });
  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err }, 'process-screenshot job failed');
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 5)) {
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

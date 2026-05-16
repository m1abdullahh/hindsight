import { Queue, Worker, type Job } from 'bullmq';

import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { deleteObject } from '../lib/r2.js';
import { redis } from '../lib/redis.js';

export const RETENTION_SWEEP_QUEUE = 'retention-sweep';

// Hard-coded for v1 until per-org configurability lands. The doc commits to
// "90-day default, configurable per org down to 14 days"
// (09-privacy-and-ethics.md §"Retention is finite"). When the
// Organization.retentionDays field exists, swap this for a per-row lookup.
const RETENTION_DAYS = 90;
const BATCH_SIZE = 500;
// Repeat once per 24h via BullMQ's repeatable jobs. The job is idempotent
// (the WHERE clause includes the cutoff, so running it twice does no extra
// work), so a late or missed run doesn't accumulate debt.
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Reserved for future per-org / per-tier scheduling. Empty payload today.
export type RetentionSweepJob = Record<string, never>;

const sweepOnce = async (): Promise<{ deletedRows: number; deletedObjects: number }> => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let deletedRows = 0;
  let deletedObjects = 0;

  // Page in fixed-size batches so a backlog (e.g. after the job hasn't run
  // for a while) doesn't load every expired row into memory at once.
  while (true) {
    const batch = await prisma.screenshot.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true, s3Key: true, thumbnailS3Key: true, blurredS3Key: true },
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      const keys = [row.s3Key, row.thumbnailS3Key, row.blurredS3Key].filter(
        (k): k is string => typeof k === 'string' && k.length > 0,
      );
      // R2 deletes are best-effort. A failure here doesn't block the DB
      // delete — the row goes away regardless, and an orphan blob is just
      // extra storage cost. If we ever want to reconcile, we'd add a
      // separate "list bucket, drop unknown keys" job.
      const results = await Promise.allSettled(keys.map((k) => deleteObject(k)));
      for (const r of results) {
        if (r.status === 'fulfilled') deletedObjects += 1;
        else logger.warn({ err: r.reason }, 'retention: r2 delete failed');
      }
      await prisma.screenshot.delete({ where: { id: row.id } });
      deletedRows += 1;
    }
  }

  return { deletedRows, deletedObjects };
};

const handle = async (_job: Job<RetentionSweepJob>): Promise<void> => {
  const { deletedRows, deletedObjects } = await sweepOnce();
  if (deletedRows > 0 || deletedObjects > 0) {
    logger.info(
      { deletedRows, deletedObjects, retentionDays: RETENTION_DAYS },
      'retention sweep complete',
    );
  }
};

// Schedule the recurring job. Idempotent — re-calling add() with the same
// jobId/repeat key is a no-op when the schedule already exists. Called once
// at worker startup.
export const ensureRetentionSweepScheduled = async (): Promise<void> => {
  const queue = new Queue<RetentionSweepJob>(RETENTION_SWEEP_QUEUE, { connection: redis });
  try {
    await queue.add(
      'sweep',
      {},
      {
        repeat: { every: SWEEP_INTERVAL_MS },
        jobId: 'retention-sweep-recurring',
        removeOnComplete: { count: 10 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    );
  } finally {
    await queue.close();
  }
};

export const registerRetentionSweepWorker = (): Worker<RetentionSweepJob> => {
  const worker = new Worker<RetentionSweepJob>(RETENTION_SWEEP_QUEUE, handle, {
    connection: redis,
    concurrency: 1,
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'retention sweep failed');
  });
  return worker;
};

// Test seam: invoke a single sweep in-process without going through the
// queue. Used by integration tests to verify the cutoff behavior.
export const _sweepOnceForTests = sweepOnce;

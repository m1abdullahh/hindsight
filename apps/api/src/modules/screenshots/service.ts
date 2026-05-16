import type { Prisma } from '@prisma/client';
import { type Membership } from '@prisma/client';
import { Queue } from 'bullmq';

import { writeAudit } from '../../auth/audit.js';
import { can } from '../../auth/capabilities.js';
import { AppError } from '../../lib/errors.js';
import { ulid } from '../../lib/id.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import {
  deleteObject,
  headObject,
  presignGetFull,
  presignGetThumbnail,
  presignPut,
} from '../../lib/r2.js';
import { mimeFromKey, originalKey } from '../../lib/screenshot-keys.js';
import { toScreenshotDto, type ScreenshotDto } from '../../lib/dto.js';
import { PROCESS_SCREENSHOT_QUEUE } from '../../workers/process-screenshot.js';

import type { ConfirmInput, ListScreenshotsQuery, PresignInput } from './schemas.js';

const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const CAPTURE_GRACE_AFTER_END_MS = 5 * 60 * 1000;
const CAPTURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CAPTURE_FUTURE_TOLERANCE_MS = 60 * 1000;
// How long a member retains the right to delete their own capture. Past this
// window, only admins/owners can delete — see 09-privacy-and-ethics.md §"Delete
// recent screenshots."
const MEMBER_DELETE_GRACE_MS = 5 * 60 * 1000;

let processScreenshotQueue: Queue | null = null;
const queue = (): Queue => {
  if (!processScreenshotQueue) {
    processScreenshotQueue = new Queue(PROCESS_SCREENSHOT_QUEUE, { connection: redis });
  }
  return processScreenshotQueue;
};

interface DeviceCaller {
  userId: string;
  deviceId: string;
}

export interface PresignResult {
  screenshotId: string;
  putUrl: string;
  expiresAt: string;
}

export const presignScreenshot = async (
  caller: DeviceCaller,
  input: PresignInput,
): Promise<PresignResult> => {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: input.timeEntryId },
    include: { project: { select: { orgId: true } } },
  });
  if (!entry) throw new AppError('not_found', 404, 'time entry not found');
  if (entry.userId !== caller.userId || entry.deviceId !== caller.deviceId) {
    throw new AppError('forbidden', 403, 'time entry not owned by this device');
  }

  // Time entry must be open OR closed within the grace window.
  const now = Date.now();
  if (entry.endedAt && entry.endedAt.getTime() < now - CAPTURE_GRACE_AFTER_END_MS) {
    throw new AppError('invalid_input', 422, 'time entry closed too long ago for new captures');
  }

  // capturedAt sanity bounds
  const capt = input.capturedAt.getTime();
  if (capt > now + CAPTURE_FUTURE_TOLERANCE_MS) {
    throw new AppError('invalid_input', 422, 'capturedAt is in the future');
  }
  if (capt < now - CAPTURE_MAX_AGE_MS) {
    throw new AppError('invalid_input', 422, 'capturedAt is too far in the past');
  }

  const screenshotId = ulid();
  const key = originalKey(
    {
      orgId: entry.project.orgId,
      userId: caller.userId,
      capturedAt: input.capturedAt,
      screenshotId,
    },
    input.contentType,
  );

  await prisma.screenshot.create({
    data: {
      id: screenshotId,
      timeEntryId: entry.id,
      capturedAt: input.capturedAt,
      s3Key: key,
      monitorIndex: input.monitorIndex,
    },
  });

  const presigned = await presignPut(key, input.contentType, MAX_OBJECT_BYTES);
  return {
    screenshotId,
    putUrl: presigned.putUrl,
    expiresAt: presigned.expiresAt.toISOString(),
  };
};

export const confirmScreenshot = async (
  caller: DeviceCaller,
  screenshotId: string,
  input: ConfirmInput,
): Promise<ScreenshotDto> => {
  const row = await prisma.screenshot.findUnique({
    where: { id: screenshotId },
    include: {
      timeEntry: { select: { userId: true, deviceId: true } },
    },
  });
  if (!row) throw new AppError('not_found', 404, 'screenshot not found');
  if (row.timeEntry.userId !== caller.userId || row.timeEntry.deviceId !== caller.deviceId) {
    throw new AppError('forbidden', 403, 'screenshot not owned by this device');
  }

  // Idempotent re-confirm: return current row, don't re-enqueue.
  if (row.status !== 'pending') {
    return toScreenshotDto(row);
  }

  // Verify the object actually arrived in R2 before flipping to 'uploaded'.
  const head = await headObject(row.s3Key);
  if (!head) {
    throw new AppError('invalid_input', 422, 'object not found in storage; retry presign + upload');
  }

  // Server-authoritative validation. The body's `sizeBytes` is taken on
  // trust by the desktop client (and therefore by anyone who steals a
  // device token) — replace it with what R2 actually stored, and reject
  // anything larger than the per-object cap or with a mismatched MIME.
  // On any rejection, delete the underlying object so the bucket doesn't
  // accumulate uploads that the DB never blessed.
  const expectedMime = mimeFromKey(row.s3Key);
  if (head.size > MAX_OBJECT_BYTES) {
    await deleteObject(row.s3Key).catch(() => undefined);
    await prisma.screenshot.update({
      where: { id: row.id },
      data: { status: 'failed' },
    });
    throw new AppError(
      'invalid_input',
      413,
      `uploaded object exceeds ${MAX_OBJECT_BYTES}-byte cap`,
    );
  }
  if (head.contentType && head.contentType !== expectedMime) {
    await deleteObject(row.s3Key).catch(() => undefined);
    await prisma.screenshot.update({
      where: { id: row.id },
      data: { status: 'failed' },
    });
    throw new AppError(
      'invalid_input',
      415,
      `uploaded content-type ${head.contentType} does not match presigned ${expectedMime}`,
    );
  }

  const updated = await prisma.screenshot.update({
    where: { id: row.id },
    data: {
      status: 'uploaded',
      width: input.width,
      height: input.height,
      // Use the R2-reported length as the source of truth; the client value
      // is kept only as a sanity input hint and discarded here.
      sizeBytes: head.size,
      activeWindowTitle: input.activeWindowTitle ?? null,
      activeApp: input.activeApp ?? null,
      keyboardEventsCount: input.keyboardEventsCount,
      mouseEventsCount: input.mouseEventsCount,
    },
  });

  // Enqueue processing. Settings are project-level decisions; the worker
  // re-fetches the row + project to know whether to blur.
  await queue().add(
    'process-screenshot',
    { screenshotId: row.id },
    {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 30 * 24 * 60 * 60 },
    },
  );

  return toScreenshotDto(updated);
};

// ── Listing / reading ──────────────────────────────────────────────────────

export interface ScreenshotListItem {
  screenshot: ScreenshotDto;
  thumbnailUrl: string | null;
  thumbnailExpiresAt: string | null;
}

export interface ScreenshotsPage {
  items: ScreenshotListItem[];
  nextCursor: string | null;
}

const encodeCursor = (capturedAt: Date, id: string): string =>
  Buffer.from(`${capturedAt.toISOString()}|${id}`).toString('base64url');

const decodeCursor = (s: string): { capturedAt: Date; id: string } | null => {
  try {
    const [iso, id] = Buffer.from(s, 'base64url').toString().split('|');
    if (!iso || !id) return null;
    return { capturedAt: new Date(iso), id };
  } catch {
    return null;
  }
};

export const listScreenshots = async (
  orgId: string,
  caller: Membership,
  query: ListScreenshotsQuery,
): Promise<ScreenshotsPage> => {
  const userId = caller.role === 'member' ? caller.userId : query.userId;

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const rows = await prisma.screenshot.findMany({
    where: {
      deletedAt: null,
      timeEntry: {
        project: { orgId },
        ...(userId ? { userId } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
      },
      ...(query.from || query.to
        ? {
            capturedAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(cursor
        ? {
            OR: [
              { capturedAt: { lt: cursor.capturedAt } },
              { capturedAt: cursor.capturedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
  });

  const hasMore = rows.length > query.limit;
  const sliced = hasMore ? rows.slice(0, query.limit) : rows;

  const items: ScreenshotListItem[] = await Promise.all(
    sliced.map(async (s) => {
      let thumbnailUrl: string | null = null;
      let thumbnailExpiresAt: string | null = null;
      if (s.thumbnailS3Key) {
        const presigned = await presignGetThumbnail(s.thumbnailS3Key);
        thumbnailUrl = presigned.url;
        thumbnailExpiresAt = presigned.expiresAt.toISOString();
      }
      return { screenshot: toScreenshotDto(s), thumbnailUrl, thumbnailExpiresAt };
    }),
  );

  const last = sliced[sliced.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.capturedAt, last.id) : null;
  return { items, nextCursor };
};

export interface ScreenshotDetail {
  screenshot: ScreenshotDto;
  fullUrl: string;
  expiresAt: string;
  // Owner = the user who tracked the time entry this capture belongs to.
  // Clients use this to decide whether the caller can delete it.
  ownerUserId: string;
  // The org this capture lives under — clients use it to invalidate
  // org-scoped caches (time-totals, time-entries) after a delete.
  orgId: string;
}

export const getScreenshot = async (
  caller: Membership,
  screenshotId: string,
): Promise<ScreenshotDetail> => {
  const row = await prisma.screenshot.findUnique({
    where: { id: screenshotId },
    include: {
      timeEntry: {
        include: {
          project: { select: { orgId: true, blurScreenshots: true } },
        },
      },
    },
  });
  if (!row || row.deletedAt) throw new AppError('not_found', 404, 'screenshot not found');
  if (row.timeEntry.project.orgId !== caller.orgId) {
    throw new AppError('forbidden', 403, 'screenshot not in your org');
  }
  if (
    !can(caller, {
      type: 'screenshots:read',
      ownerUserId: row.timeEntry.userId,
    })
  ) {
    throw new AppError('forbidden', 403, 'screenshot not accessible');
  }

  // Members of a blur-enabled project see only the blurred full.
  const useBlurred =
    row.timeEntry.project.blurScreenshots && caller.role === 'member' && !!row.blurredS3Key;

  const key = useBlurred && row.blurredS3Key ? row.blurredS3Key : row.s3Key;
  const presigned = await presignGetFull(key);

  return {
    screenshot: toScreenshotDto(row),
    fullUrl: presigned.url,
    expiresAt: presigned.expiresAt.toISOString(),
    ownerUserId: row.timeEntry.userId,
    orgId: row.timeEntry.project.orgId,
  };
};

export const deleteScreenshot = async (caller: Membership, screenshotId: string): Promise<void> => {
  const row = await prisma.screenshot.findUnique({
    where: { id: screenshotId },
    include: {
      timeEntry: {
        select: {
          id: true,
          userId: true,
          totalActiveSeconds: true,
          project: { select: { orgId: true, screenshotIntervalMinutes: true } },
        },
      },
    },
  });
  if (!row) throw new AppError('not_found', 404, 'screenshot not found');
  if (row.timeEntry.project.orgId !== caller.orgId) {
    throw new AppError('forbidden', 403, 'screenshot not in your org');
  }

  const withinGrace = Date.now() - row.capturedAt.getTime() <= MEMBER_DELETE_GRACE_MS;
  if (
    !can(caller, {
      type: 'screenshots:delete',
      ownerUserId: row.timeEntry.userId,
      withinGrace,
    })
  ) {
    throw new AppError('forbidden', 403, 'cannot delete this screenshot');
  }

  // Hard delete the row + subtract the screenshot's interval from the parent
  // TimeEntry.totalActiveSeconds (clamped at 0). Time totals on every report
  // sum this column, so without decrementing it the reported hours would
  // outlive the screenshots that backed them.
  const orgId = row.timeEntry.project.orgId;
  const intervalSeconds = row.timeEntry.project.screenshotIntervalMinutes * 60;
  const before = row.timeEntry.totalActiveSeconds;
  const after = Math.max(0, before - intervalSeconds);
  const subtracted = before - after;
  const objectKeys = [row.s3Key, row.thumbnailS3Key, row.blurredS3Key].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );

  await prisma.$transaction(async (tx) => {
    if (subtracted > 0) {
      await tx.timeEntry.update({
        where: { id: row.timeEntryId },
        data: { totalActiveSeconds: after },
      });
    }
    await tx.screenshot.delete({ where: { id: row.id } });
    await writeAudit(tx, {
      orgId,
      actorId: caller.userId,
      action: 'screenshot.deleted',
      targetType: 'screenshot',
      targetId: row.id,
      metadata: {
        byCaller: caller.userId,
        objectKeys,
        timeEntryId: row.timeEntryId,
        subtractedSeconds: subtracted,
      } satisfies Prisma.JsonObject,
    });
  });

  // R2 deletes run outside the txn so a transient R2 hiccup doesn't roll back
  // the DB delete — the row is gone either way, and orphaned objects are at
  // worst extra storage cost.
  await Promise.all(
    objectKeys.map((k) =>
      deleteObject(k).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);

        console.warn(`r2 delete failed for ${k}: ${msg}`);
      }),
    ),
  );
};

import type { Buffer } from 'node:buffer';

import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/lib/prisma.js';
import { ulid } from '../src/lib/id.js';
import { originalKey, thumbnailKey } from '../src/lib/screenshot-keys.js';
import { process as processScreenshot } from '../src/workers/process-screenshot.js';

import { isDbReachable, truncateAll } from './helpers/db.js';
import { r2Stub } from './helpers/r2-stub.js';

interface SetupResult {
  orgId: string;
  userId: string;
  deviceId: string;
  projectId: string;
  timeEntryId: string;
}

const seed = async (blurScreenshots = false): Promise<SetupResult> => {
  const orgId = ulid();
  const userId = ulid();
  const deviceId = ulid();
  const projectId = ulid();
  const timeEntryId = ulid();

  await prisma.organization.create({
    data: { id: orgId, name: 'Acme', slug: `acme-${orgId.slice(-6).toLowerCase()}` },
  });
  await prisma.user.create({
    data: { id: userId, email: `u-${userId}@example.com`, name: 'U', passwordHash: 'p' },
  });
  await prisma.membership.create({
    data: { id: ulid(), orgId, userId, role: 'owner' },
  });
  await prisma.device.create({
    data: { id: deviceId, userId, deviceName: 'Test', os: 'macos', appVersion: '1.0.0' },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      orgId,
      name: 'P1',
      blurScreenshots,
      createdBy: userId,
    },
  });
  await prisma.timeEntry.create({
    data: {
      id: timeEntryId,
      userId,
      projectId,
      deviceId,
      startedAt: new Date(),
    },
  });

  return { orgId, userId, deviceId, projectId, timeEntryId };
};

const makeRealJpeg = async (): Promise<Buffer> =>
  sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();

const insertUploadedScreenshot = async (fx: SetupResult, bytes: Buffer): Promise<string> => {
  const screenshotId = ulid();
  const capturedAt = new Date();
  const key = originalKey(
    { orgId: fx.orgId, userId: fx.userId, capturedAt, screenshotId },
    'image/jpeg',
  );
  await prisma.screenshot.create({
    data: {
      id: screenshotId,
      timeEntryId: fx.timeEntryId,
      capturedAt,
      s3Key: key,
      width: 64,
      height: 48,
      sizeBytes: bytes.length,
      status: 'uploaded',
    },
  });
  r2Stub.put(key, bytes, 'image/jpeg');
  return screenshotId;
};

const fakeJob = (screenshotId: string) =>
  // Minimal Job-like shape that process() reads.
  ({ data: { screenshotId } }) as Parameters<typeof processScreenshot>[0];

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('process-screenshot worker', () => {
  beforeEach(async () => {
    await truncateAll();
    r2Stub.reset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('happy path (no blur): row → processed; thumbnail object exists in R2', async () => {
    const fx = await seed(false);
    const bytes = await makeRealJpeg();
    const screenshotId = await insertUploadedScreenshot(fx, bytes);

    await processScreenshot(fakeJob(screenshotId));

    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: screenshotId } });
    expect(row.status).toBe('processed');
    expect(row.thumbnailS3Key).not.toBeNull();
    expect(row.blurredS3Key).toBeNull();
    expect(row.blurred).toBe(false);

    const expectedThumbKey = thumbnailKey({
      orgId: fx.orgId,
      userId: fx.userId,
      capturedAt: row.capturedAt,
      screenshotId,
    });
    expect(row.thumbnailS3Key).toBe(expectedThumbKey);
    expect(r2Stub.objects.has(expectedThumbKey)).toBe(true);
    expect(r2Stub.objects.get(expectedThumbKey)?.contentType).toBe('image/webp');
  });

  it('happy path (blur enabled): row → processed; both thumb and blurred-full exist', async () => {
    const fx = await seed(true);
    const bytes = await makeRealJpeg();
    const screenshotId = await insertUploadedScreenshot(fx, bytes);

    await processScreenshot(fakeJob(screenshotId));

    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: screenshotId } });
    expect(row.status).toBe('processed');
    expect(row.thumbnailS3Key).not.toBeNull();
    expect(row.blurredS3Key).not.toBeNull();
    expect(row.blurred).toBe(true);

    expect(r2Stub.objects.has(row.thumbnailS3Key!)).toBe(true);
    expect(r2Stub.objects.has(row.blurredS3Key!)).toBe(true);
  });

  it('idempotent: rerun on already-processed row is a no-op', async () => {
    const fx = await seed(false);
    const bytes = await makeRealJpeg();
    const screenshotId = await insertUploadedScreenshot(fx, bytes);

    await processScreenshot(fakeJob(screenshotId));
    const r2CountAfterFirst = r2Stub.objects.size;

    await processScreenshot(fakeJob(screenshotId));
    expect(r2Stub.objects.size).toBe(r2CountAfterFirst);
  });

  it('skips silently when row is in pending state', async () => {
    const fx = await seed(false);
    const screenshotId = ulid();
    const capturedAt = new Date();
    await prisma.screenshot.create({
      data: {
        id: screenshotId,
        timeEntryId: fx.timeEntryId,
        capturedAt,
        s3Key: originalKey(
          { orgId: fx.orgId, userId: fx.userId, capturedAt, screenshotId },
          'image/jpeg',
        ),
        status: 'pending',
      },
    });

    await processScreenshot(fakeJob(screenshotId));

    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: screenshotId } });
    expect(row.status).toBe('pending');
  });

  it('throws when original is missing in R2 (lets BullMQ retry)', async () => {
    const fx = await seed(false);
    const screenshotId = ulid();
    const capturedAt = new Date();
    const key = originalKey(
      { orgId: fx.orgId, userId: fx.userId, capturedAt, screenshotId },
      'image/jpeg',
    );
    await prisma.screenshot.create({
      data: {
        id: screenshotId,
        timeEntryId: fx.timeEntryId,
        capturedAt,
        s3Key: key,
        status: 'uploaded',
      },
    });
    // Don't put bytes.

    await expect(processScreenshot(fakeJob(screenshotId))).rejects.toThrow();

    const row = await prisma.screenshot.findUniqueOrThrow({ where: { id: screenshotId } });
    expect(row.status).toBe('uploaded'); // unchanged
  });
});

import { Buffer } from 'node:buffer';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/lib/prisma.js';
import { ulid } from '../src/lib/id.js';
import { _sweepOnceForTests } from '../src/workers/retention-sweep.js';

import { isDbReachable, truncateAll } from './helpers/db.js';
import { r2Stub } from './helpers/r2-stub.js';

const seedOrg = async (orgId: string, userId: string, projectId: string): Promise<void> => {
  const user = await prisma.user.create({
    data: { id: userId, email: `${userId}@example.com`, name: 'u', passwordHash: 'p' },
  });
  const org = await prisma.organization.create({
    data: { id: orgId, name: 'Acme', slug: `acme-${orgId}` },
  });
  await prisma.membership.create({
    data: { id: `m-${userId}`, orgId: org.id, userId: user.id, role: 'owner' },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      orgId: org.id,
      name: 'P',
      screenshotIntervalMinutes: 10,
      createdBy: user.id,
    },
  });
};

const seedScreenshot = async (
  projectId: string,
  userId: string,
  createdAt: Date,
): Promise<{ id: string; s3Key: string }> => {
  const device = await prisma.device.create({
    data: {
      id: `d-${ulid()}`,
      userId,
      deviceName: 'mac',
      os: 'macos',
      appVersion: '1.0',
    },
  });
  const entry = await prisma.timeEntry.create({
    data: {
      id: ulid(),
      userId,
      deviceId: device.id,
      projectId,
      startedAt: createdAt,
      totalActiveSeconds: 60,
    },
  });
  const s3Key = `orgs/x/users/${userId}/${ulid()}.jpg`;
  r2Stub.put(s3Key, Buffer.from('bytes'), 'image/jpeg');
  const row = await prisma.screenshot.create({
    data: {
      id: ulid(),
      timeEntryId: entry.id,
      capturedAt: createdAt,
      s3Key,
      monitorIndex: 0,
      status: 'processed',
      createdAt,
    },
  });
  return { id: row.id, s3Key };
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('retention sweep', () => {
  beforeEach(async () => {
    await truncateAll();
    r2Stub.reset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('deletes screenshot rows + R2 objects past the 90-day cutoff; leaves recent rows alone', async () => {
    await seedOrg('o1', 'u1', 'p1');

    const old = await seedScreenshot('p1', 'u1', new Date(Date.now() - 91 * 24 * 60 * 60 * 1000));
    const recent = await seedScreenshot('p1', 'u1', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

    const result = await _sweepOnceForTests();
    expect(result.deletedRows).toBe(1);
    expect(result.deletedObjects).toBe(1);

    expect(await prisma.screenshot.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.screenshot.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(r2Stub.objects.has(old.s3Key)).toBe(false);
    expect(r2Stub.objects.has(recent.s3Key)).toBe(true);
  });

  it('is idempotent: a second run with no new expirations does nothing', async () => {
    await seedOrg('o1', 'u1', 'p1');
    await seedScreenshot('p1', 'u1', new Date(Date.now() - 91 * 24 * 60 * 60 * 1000));

    const first = await _sweepOnceForTests();
    expect(first.deletedRows).toBe(1);

    const second = await _sweepOnceForTests();
    expect(second.deletedRows).toBe(0);
  });
});

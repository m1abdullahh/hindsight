import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { mintToken } from '../src/auth/tokens.js';
import { prisma } from '../src/lib/prisma.js';

import { makeTestApp } from './helpers/build-app.js';
import { isDbReachable, truncateAll } from './helpers/db.js';

const localPart = (e: string): string => e.split('@')[0]!;

const signup = async (email: string, organizationName: string) => {
  const app = makeTestApp();
  const res = await request(app)
    .post('/api/v1/auth/signup')
    .send({
      email,
      password: 'correct horse battery staple',
      name: localPart(email),
      organizationName,
    });
  if (res.status !== 201) throw new Error(`signup ${res.status}`);
  return { token: res.body.token, userId: res.body.user.id, orgId: res.body.organization.id };
};

const registerDevice = async (token: string) => {
  const app = makeTestApp();
  const res = await request(app)
    .post('/api/v1/devices/register')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ deviceName: 'Test Device', os: 'macos', appVersion: '1.0.0' });
  if (res.status !== 201) throw new Error(`device register ${res.status}`);
  return { deviceId: res.body.deviceId as string, deviceToken: res.body.deviceToken as string };
};

const seedClosedEntry = async (
  userId: string,
  projectId: string,
  deviceId: string,
  startedMinutesAgo: number,
  durationSeconds: number,
) => {
  const startedAt = new Date(Date.now() - startedMinutesAgo * 60 * 1000);
  const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);
  await prisma.timeEntry.create({
    data: {
      id: `te-${randomUUID()}`,
      userId,
      projectId,
      deviceId,
      startedAt,
      endedAt,
      totalActiveSeconds: durationSeconds,
    },
  });
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('reports/time-totals', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('owner sees totals for all members across all projects', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const ownerDev = await registerDevice(owner.token);

    // Create two projects.
    const app = makeTestApp();
    const p1 = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/projects`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Alpha' });
    const p2 = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/projects`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Beta' });

    // Seed a member.
    const memberUser = await prisma.user.create({
      data: { id: 'u-mem', email: 'mem@example.com', name: 'Member One', passwordHash: 'p' },
    });
    await prisma.membership.create({
      data: { id: 'm-mem', orgId: owner.orgId, userId: memberUser.id, role: 'member' },
    });
    const memberWebToken = (await mintToken({ userId: memberUser.id, kind: 'web' })).plaintext;
    const memberDev = await registerDevice(memberWebToken);

    // Assign member to Alpha at $30/hr.
    await prisma.projectAssignment.create({
      data: {
        id: 'a1',
        projectId: p1.body.id,
        userId: memberUser.id,
        hourlyRateCents: 3000,
      },
    });

    // Owner: 1 hour on Alpha, 30 min on Beta. Member: 2 hours on Alpha.
    await seedClosedEntry(owner.userId, p1.body.id, ownerDev.deviceId, 90, 3600);
    await seedClosedEntry(owner.userId, p2.body.id, ownerDev.deviceId, 50, 1800);
    await seedClosedEntry(memberUser.id, p1.body.id, memberDev.deviceId, 200, 7200);

    const res = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/reports/time-totals`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);

    const rows = res.body.rows as {
      userId: string;
      projectName: string;
      totalActiveSeconds: number;
      hourlyRateCents: number | null;
      earnedCents: number | null;
    }[];
    expect(rows).toHaveLength(3);

    // Sorted by project then user — Alpha rows first (Member, then owner alphabetically).
    const alphaMember = rows.find((r) => r.projectName === 'Alpha' && r.userId === memberUser.id);
    expect(alphaMember?.totalActiveSeconds).toBe(7200);
    expect(alphaMember?.hourlyRateCents).toBe(3000);
    expect(alphaMember?.earnedCents).toBe(6000); // 2h × $30 = $60.00

    const alphaOwner = rows.find((r) => r.projectName === 'Alpha' && r.userId === owner.userId);
    expect(alphaOwner?.totalActiveSeconds).toBe(3600);
    expect(alphaOwner?.hourlyRateCents).toBeNull();
    expect(alphaOwner?.earnedCents).toBeNull();
  });

  it('member sees only their own row even when querying for someone else', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const ownerDev = await registerDevice(owner.token);
    const app = makeTestApp();

    const p = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/projects`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Alpha' });

    const memberUser = await prisma.user.create({
      data: { id: 'u-mem', email: 'mem@example.com', name: 'Member', passwordHash: 'p' },
    });
    await prisma.membership.create({
      data: { id: 'm-mem', orgId: owner.orgId, userId: memberUser.id, role: 'member' },
    });
    const memberWebToken = (await mintToken({ userId: memberUser.id, kind: 'web' })).plaintext;
    const memberDev = await registerDevice(memberWebToken);

    await seedClosedEntry(owner.userId, p.body.id, ownerDev.deviceId, 60, 1800);
    await seedClosedEntry(memberUser.id, p.body.id, memberDev.deviceId, 60, 900);

    // Member queries with userId pointing at the owner — should be ignored.
    const res = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/reports/time-totals`)
      .query({ userId: owner.userId })
      .set('Authorization', `Bearer ${memberWebToken}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].userId).toBe(memberUser.id);
    expect(res.body.rows[0].totalActiveSeconds).toBe(900);
  });

  it('from/to filter restricts to the date range', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const ownerDev = await registerDevice(owner.token);
    const app = makeTestApp();

    const p = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/projects`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Alpha' });

    // Old entry (10 days ago) and recent entry (1 hour ago).
    await seedClosedEntry(owner.userId, p.body.id, ownerDev.deviceId, 14_400, 3600); // 10d
    await seedClosedEntry(owner.userId, p.body.id, ownerDev.deviceId, 60, 600);

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/reports/time-totals`)
      .query({ from })
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].totalActiveSeconds).toBe(600);
  });
});

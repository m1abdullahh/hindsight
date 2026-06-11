import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { mintToken } from '../src/auth/tokens.js';
import { prisma } from '../src/lib/prisma.js';

import { makeTestApp } from './helpers/build-app.js';
import { isDbReachable, truncateAll } from './helpers/db.js';

interface OrgFx {
  webToken: string;
  userId: string;
  orgId: string;
  deviceId: string;
  deviceToken: string;
  projectId: string;
}

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

const createProject = async (webToken: string, orgId: string): Promise<string> => {
  const app = makeTestApp();
  const res = await request(app)
    .post(`/api/v1/orgs/${orgId}/projects`)
    .set('Authorization', `Bearer ${webToken}`)
    .send({ name: 'P1' });
  if (res.status !== 201) throw new Error(`createProject ${res.status}`);
  return res.body.id as string;
};

const setupOrg = async (email = 'owner@example.com'): Promise<OrgFx> => {
  const su = await signup(email, 'Acme');
  const dev = await registerDevice(su.token);
  const projectId = await createProject(su.token, su.orgId);
  return {
    webToken: su.token,
    userId: su.userId,
    orgId: su.orgId,
    deviceId: dev.deviceId,
    deviceToken: dev.deviceToken,
    projectId,
  };
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('time entries', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('start with device token returns an open entry; auto-stops previous', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();

    const first = await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: fx.projectId, startedAt: new Date().toISOString() });
    expect(first.status).toBe(201);
    expect(first.body.endedAt).toBeNull();

    const second = await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: fx.projectId, startedAt: new Date().toISOString() });
    expect(second.status).toBe(201);

    const all = await prisma.timeEntry.findMany({ orderBy: { startedAt: 'asc' } });
    expect(all).toHaveLength(2);
    expect(all[0]!.endedAt).not.toBeNull(); // auto-stopped
    expect(all[1]!.endedAt).toBeNull();
  });

  it('start with web token returns 403', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();

    const res = await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${fx.webToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: fx.projectId, startedAt: new Date().toISOString() });
    expect(res.status).toBe(403);
  });

  it('member without assignment cannot start; admin can', async () => {
    const owner = await setupOrg();

    // Seed a member without project assignment.
    const memberUser = await prisma.user.create({
      data: { id: 'u-mem', email: 'mem@example.com', name: 'mem', passwordHash: 'p' },
    });
    await prisma.membership.create({
      data: { id: 'm-mem', orgId: owner.orgId, userId: memberUser.id, role: 'member' },
    });
    const memberWebToken = (await mintToken({ userId: memberUser.id, kind: 'web' })).plaintext;
    const memberDev = await registerDevice(memberWebToken);

    const app = makeTestApp();
    const denied = await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${memberDev.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: owner.projectId, startedAt: new Date().toISOString() });
    expect(denied.status).toBe(403);

    // Owner (admin role) can start without explicit assignment.
    const ok = await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${owner.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: owner.projectId, startedAt: new Date().toISOString() });
    expect(ok.status).toBe(201);
  });

  it('start with startedAt 8 days in the past returns 422', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();

    const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: fx.projectId, startedAt: eightDays });
    expect(res.status).toBe(422);
  });

  it('patch endedAt + counters; cannot patch already-closed endedAt', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();

    const start = await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: fx.projectId, startedAt: new Date().toISOString() });
    const id = start.body.id as string;

    const patch1 = await request(app)
      .patch(`/api/v1/time-entries/${id}`)
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ totalActiveSeconds: 60, totalIdleSeconds: 5 });
    expect(patch1.status).toBe(200);
    expect(patch1.body.totalActiveSeconds).toBe(60);

    const close = await request(app)
      .patch(`/api/v1/time-entries/${id}`)
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ endedAt: new Date().toISOString() });
    expect(close.status).toBe(200);

    const reClose = await request(app)
      .patch(`/api/v1/time-entries/${id}`)
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ endedAt: new Date().toISOString() });
    expect(reClose.status).toBe(409);
  });

  it('list (admin) sees all; member only sees own', async () => {
    const owner = await setupOrg();
    const app = makeTestApp();

    // Owner starts an entry.
    await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${owner.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: owner.projectId, startedAt: new Date().toISOString() });

    // Seed a member with assignment + their own entry.
    const memberUser = await prisma.user.create({
      data: { id: 'u-mem', email: 'mem@example.com', name: 'mem', passwordHash: 'p' },
    });
    await prisma.membership.create({
      data: { id: 'm-mem', orgId: owner.orgId, userId: memberUser.id, role: 'member' },
    });
    await prisma.projectAssignment.create({
      data: {
        id: 'pa-mem',
        projectId: owner.projectId,
        userId: memberUser.id,
      },
    });
    const memberWebToken = (await mintToken({ userId: memberUser.id, kind: 'web' })).plaintext;
    const memberDev = await registerDevice(memberWebToken);
    await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${memberDev.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: owner.projectId, startedAt: new Date().toISOString() });

    const ownerList = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/time-entries`)
      .set('Authorization', `Bearer ${owner.webToken}`);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.entries).toHaveLength(2);

    const memberList = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/time-entries?userId=${owner.userId}`)
      .set('Authorization', `Bearer ${memberWebToken}`);
    expect(memberList.status).toBe(200);
    // Member's userId override forces filter to themselves; should NOT see the owner's entry.
    expect(memberList.body.entries).toHaveLength(1);
    expect(memberList.body.entries[0].userId).toBe(memberUser.id);
  });

  it('admin editing another user’s time entry writes an audit row with before/after', async () => {
    const owner = await setupOrg();
    const app = makeTestApp();

    // Seed a member with assignment + an entry they own.
    const memberUser = await prisma.user.create({
      data: { id: 'u-target', email: 'target@example.com', name: 'target', passwordHash: 'p' },
    });
    await prisma.membership.create({
      data: { id: 'm-target', orgId: owner.orgId, userId: memberUser.id, role: 'member' },
    });
    await prisma.projectAssignment.create({
      data: { id: 'pa-target', projectId: owner.projectId, userId: memberUser.id },
    });
    const memberDev = await registerDevice(
      (await mintToken({ userId: memberUser.id, kind: 'web' })).plaintext,
    );
    const start = await request(app)
      .post('/api/v1/time-entries')
      .set('Authorization', `Bearer ${memberDev.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ projectId: owner.projectId, startedAt: new Date().toISOString() });
    const entryId = start.body.id as string;

    // Member sets their own totalActiveSeconds (no audit row expected — same user).
    const memberSelfPatch = await request(app)
      .patch(`/api/v1/time-entries/${entryId}`)
      .set('Authorization', `Bearer ${memberDev.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ totalActiveSeconds: 100 });
    expect(memberSelfPatch.status).toBe(200);

    // Owner (admin) bumps the member's totalActiveSeconds — should produce an audit row.
    const adminPatch = await request(app)
      .patch(`/api/v1/time-entries/${entryId}`)
      .set('Authorization', `Bearer ${owner.webToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ totalActiveSeconds: 9999 });
    expect(adminPatch.status).toBe(200);

    const audits = await prisma.auditLog.findMany({
      where: { action: 'time_entry.updated_by_admin', targetId: entryId },
    });
    expect(audits).toHaveLength(1);
    const meta = audits[0]!.metadata as {
      targetUserId: string;
      changes: { totalActiveSeconds: { from: number; to: number } };
    };
    expect(meta.targetUserId).toBe(memberUser.id);
    expect(meta.changes.totalActiveSeconds.from).toBe(100);
    expect(meta.changes.totalActiveSeconds.to).toBe(9999);
  });
});

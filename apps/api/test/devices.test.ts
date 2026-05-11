import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { mintToken } from '../src/auth/tokens.js';
import { prisma } from '../src/lib/prisma.js';

import { makeTestApp } from './helpers/build-app.js';
import { isDbReachable, truncateAll } from './helpers/db.js';

interface SignupFixture {
  token: string;
  userId: string;
  orgId: string;
}

const localPart = (e: string): string => e.split('@')[0]!;

const signup = async (email: string, organizationName: string): Promise<SignupFixture> => {
  const app = makeTestApp();
  const res = await request(app)
    .post('/api/v1/auth/signup')
    .send({
      email,
      password: 'correct horse battery staple',
      name: localPart(email),
      organizationName,
    });
  if (res.status !== 201)
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, userId: res.body.user.id, orgId: res.body.organization.id };
};

const seedMember = async (
  orgId: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ userId: string; token: string }> => {
  const user = await prisma.user.create({
    data: { id: `u-${email}`, email, name: localPart(email), passwordHash: 'placeholder' },
  });
  await prisma.membership.create({
    data: { id: `m-${email}`, orgId, userId: user.id, role },
  });
  const minted = await mintToken({ userId: user.id, kind: 'web' });
  return { userId: user.id, token: minted.plaintext };
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('devices', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('register returns deviceId + deviceToken; token authenticates GET /devices', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const reg = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ deviceName: 'Workstation', os: 'windows', appVersion: '1.0.0' });

    expect(reg.status).toBe(201);
    expect(typeof reg.body.deviceId).toBe('string');
    expect(typeof reg.body.deviceToken).toBe('string');
    expect(reg.body.device.os).toBe('windows');

    const list = await request(app)
      .get('/api/v1/devices')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(list.status).toBe(200);
    expect(list.body.devices).toHaveLength(1);

    const audits = await prisma.auditLog.findMany({ where: { action: 'device.registered' } });
    expect(audits).toHaveLength(1);
  });

  it('idempotent register replays the same response', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();
    const idem = randomUUID();

    const a = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', idem)
      .send({ deviceName: 'Mac', os: 'macos', appVersion: '1.0.0' });

    const b = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', idem)
      .send({ deviceName: 'Mac', os: 'macos', appVersion: '1.0.0' });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.deviceId).toBe(a.body.deviceId);
    expect(b.body.deviceToken).toBe(a.body.deviceToken);

    const devices = await prisma.device.findMany({});
    expect(devices).toHaveLength(1);
  });

  it('register with device token returns 403', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const reg = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ deviceName: 'D1', os: 'macos', appVersion: '1.0.0' });
    const deviceToken = reg.body.deviceToken as string;

    const second = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ deviceName: 'D2', os: 'macos', appVersion: '1.0.0' });
    expect(second.status).toBe(403);
  });

  it('heartbeat with web token returns 403; with device token updates lastSeenAt', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const reg = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ deviceName: 'D1', os: 'linux', appVersion: '1.0.0' });
    const deviceToken = reg.body.deviceToken as string;

    const webHb = await request(app)
      .post('/api/v1/devices/heartbeat')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ appVersion: '1.0.1' });
    expect(webHb.status).toBe(403);

    const hb = await request(app)
      .post('/api/v1/devices/heartbeat')
      .set('Authorization', `Bearer ${deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ appVersion: '1.0.1' });
    expect(hb.status).toBe(200);
    expect(hb.body.appVersion).toBe('1.0.1');
    expect(hb.body.lastSeenAt).not.toBeNull();
  });

  it('user revokes own device; subsequent device-token request returns 401', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const reg = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ deviceName: 'D1', os: 'macos', appVersion: '1.0.0' });

    const rev = await request(app)
      .delete(`/api/v1/devices/${reg.body.deviceId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(rev.status).toBe(204);

    const hb = await request(app)
      .post('/api/v1/devices/heartbeat')
      .set('Authorization', `Bearer ${reg.body.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ appVersion: '1.0.1' });
    expect(hb.status).toBe(401);

    const audits = await prisma.auditLog.findMany({ where: { action: 'device.revoked' } });
    expect(audits).toHaveLength(1);
  });

  it("admin revokes a member's device in same org", async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberFx = await seedMember(owner.orgId, 'm@example.com', 'member');
    const app = makeTestApp();

    const reg = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${memberFx.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ deviceName: 'M-Mac', os: 'macos', appVersion: '1.0.0' });
    expect(reg.status).toBe(201);

    const rev = await request(app)
      .delete(`/api/v1/devices/${reg.body.deviceId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(rev.status).toBe(204);
  });

  it("non-admin cannot revoke another user's device", async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const a = await seedMember(owner.orgId, 'a@example.com', 'member');
    const b = await seedMember(owner.orgId, 'b@example.com', 'member');
    const app = makeTestApp();

    const reg = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${a.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ deviceName: 'A-Dev', os: 'windows', appVersion: '1.0.0' });

    const denied = await request(app)
      .delete(`/api/v1/devices/${reg.body.deviceId}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(denied.status).toBe(403);
  });

  it('register without Idempotency-Key returns 400', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const reg = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ deviceName: 'D1', os: 'macos', appVersion: '1.0.0' });
    expect(reg.status).toBe(400);
  });
});

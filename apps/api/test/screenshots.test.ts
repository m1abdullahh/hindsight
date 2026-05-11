import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/lib/prisma.js';

import { makeTestApp } from './helpers/build-app.js';
import { isDbReachable, truncateAll } from './helpers/db.js';
import { r2Stub } from './helpers/r2-stub.js';

interface OrgFx {
  webToken: string;
  userId: string;
  orgId: string;
  deviceId: string;
  deviceToken: string;
  projectId: string;
  timeEntryId: string;
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

const createProject = async (
  webToken: string,
  orgId: string,
  blurScreenshots = false,
): Promise<string> => {
  const app = makeTestApp();
  const res = await request(app)
    .post(`/api/v1/orgs/${orgId}/projects`)
    .set('Authorization', `Bearer ${webToken}`)
    .send({ name: 'P1', blurScreenshots });
  if (res.status !== 201) throw new Error(`createProject ${res.status}`);
  return res.body.id as string;
};

const startEntry = async (deviceToken: string, projectId: string): Promise<string> => {
  const app = makeTestApp();
  const res = await request(app)
    .post('/api/v1/time-entries')
    .set('Authorization', `Bearer ${deviceToken}`)
    .set('Idempotency-Key', randomUUID())
    .send({ projectId, startedAt: new Date().toISOString() });
  if (res.status !== 201) throw new Error(`startEntry ${res.status}`);
  return res.body.id as string;
};

const setupOrg = async (email = 'owner@example.com', blur = false): Promise<OrgFx> => {
  const su = await signup(email, 'Acme');
  const dev = await registerDevice(su.token);
  const projectId = await createProject(su.token, su.orgId, blur);
  const timeEntryId = await startEntry(dev.deviceToken, projectId);
  return {
    webToken: su.token,
    userId: su.userId,
    orgId: su.orgId,
    deviceId: dev.deviceId,
    deviceToken: dev.deviceToken,
    projectId,
    timeEntryId,
  };
};

const dummyJpegBytes = (): Buffer => Buffer.from('FFD8FFE0fakejpeg', 'utf8');

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('screenshots', () => {
  beforeEach(async () => {
    await truncateAll();
    r2Stub.reset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('presign + confirm: row goes pending → uploaded; URL captured by stub', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();

    const presigned = await request(app)
      .post('/api/v1/screenshots/presign')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        timeEntryId: fx.timeEntryId,
        capturedAt: new Date().toISOString(),
        monitorIndex: 0,
        contentType: 'image/jpeg',
      });
    expect(presigned.status).toBe(201);
    expect(typeof presigned.body.screenshotId).toBe('string');
    expect(presigned.body.putUrl).toContain('stub.r2.local');
    expect(r2Stub.putUrls).toHaveLength(1);

    const row1 = await prisma.screenshot.findUniqueOrThrow({
      where: { id: presigned.body.screenshotId },
    });
    expect(row1.status).toBe('pending');

    // Simulate the desktop PUT.
    const expectedKey = r2Stub.putUrls[0]!.key;
    r2Stub.put(expectedKey, dummyJpegBytes(), 'image/jpeg');

    const confirm = await request(app)
      .post(`/api/v1/screenshots/${presigned.body.screenshotId}/confirm`)
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        width: 1920,
        height: 1080,
        keyboardEventsCount: 50,
        mouseEventsCount: 30,
        sizeBytes: dummyJpegBytes().length,
      });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe('uploaded');
  });

  it('idempotent presign returns the same screenshotId + putUrl', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();
    const idem = randomUUID();
    const capturedAt = new Date().toISOString();

    const a = await request(app)
      .post('/api/v1/screenshots/presign')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', idem)
      .send({
        timeEntryId: fx.timeEntryId,
        capturedAt,
        monitorIndex: 0,
        contentType: 'image/jpeg',
      });
    const b = await request(app)
      .post('/api/v1/screenshots/presign')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', idem)
      .send({
        timeEntryId: fx.timeEntryId,
        capturedAt,
        monitorIndex: 0,
        contentType: 'image/jpeg',
      });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.screenshotId).toBe(a.body.screenshotId);
    expect(b.body.putUrl).toBe(a.body.putUrl);

    const rows = await prisma.screenshot.findMany({});
    expect(rows).toHaveLength(1);
  });

  it('confirm without R2 object returns 422', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();

    const presigned = await request(app)
      .post('/api/v1/screenshots/presign')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        timeEntryId: fx.timeEntryId,
        capturedAt: new Date().toISOString(),
        monitorIndex: 0,
        contentType: 'image/jpeg',
      });
    // Don't put bytes in the stub.

    const confirm = await request(app)
      .post(`/api/v1/screenshots/${presigned.body.screenshotId}/confirm`)
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        width: 100,
        height: 100,
        keyboardEventsCount: 0,
        mouseEventsCount: 0,
        sizeBytes: 1024,
      });
    expect(confirm.status).toBe(422);
  });

  it('presign with web token returns 403', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();

    const res = await request(app)
      .post('/api/v1/screenshots/presign')
      .set('Authorization', `Bearer ${fx.webToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        timeEntryId: fx.timeEntryId,
        capturedAt: new Date().toISOString(),
        monitorIndex: 0,
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(403);
  });

  it('presign with invalid contentType returns 422', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();

    const res = await request(app)
      .post('/api/v1/screenshots/presign')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        timeEntryId: fx.timeEntryId,
        capturedAt: new Date().toISOString(),
        monitorIndex: 0,
        contentType: 'image/gif',
      });
    expect(res.status).toBe(422);
  });

  it("presign for someone else's time entry returns 403", async () => {
    const a = await setupOrg('a@example.com');
    const b = await setupOrg('b@example.com');
    const app = makeTestApp();

    const res = await request(app)
      .post('/api/v1/screenshots/presign')
      .set('Authorization', `Bearer ${a.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        timeEntryId: b.timeEntryId,
        capturedAt: new Date().toISOString(),
        monitorIndex: 0,
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(403);
  });

  it('list returns rows with thumbnailUrl null until processed; admin delete hard-deletes', async () => {
    const fx = await setupOrg();
    const app = makeTestApp();

    const presigned = await request(app)
      .post('/api/v1/screenshots/presign')
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        timeEntryId: fx.timeEntryId,
        capturedAt: new Date().toISOString(),
        monitorIndex: 0,
        contentType: 'image/jpeg',
      });
    r2Stub.put(r2Stub.putUrls[0]!.key, dummyJpegBytes(), 'image/jpeg');
    await request(app)
      .post(`/api/v1/screenshots/${presigned.body.screenshotId}/confirm`)
      .set('Authorization', `Bearer ${fx.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        width: 1,
        height: 1,
        keyboardEventsCount: 0,
        mouseEventsCount: 0,
        sizeBytes: 16,
      });

    const list = await request(app)
      .get(`/api/v1/orgs/${fx.orgId}/screenshots`)
      .set('Authorization', `Bearer ${fx.webToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].thumbnailUrl).toBeNull();

    const del = await request(app)
      .delete(`/api/v1/screenshots/${presigned.body.screenshotId}`)
      .set('Authorization', `Bearer ${fx.webToken}`);
    expect(del.status).toBe(204);

    const after = await request(app)
      .get(`/api/v1/orgs/${fx.orgId}/screenshots`)
      .set('Authorization', `Bearer ${fx.webToken}`);
    expect(after.body.items).toHaveLength(0);

    const audits = await prisma.auditLog.findMany({ where: { action: 'screenshot.deleted' } });
    expect(audits).toHaveLength(1);
  });

  it('cross-org: user in B cannot read screenshot in A', async () => {
    const a = await setupOrg('a@example.com');
    const b = await setupOrg('b@example.com');
    const app = makeTestApp();

    const presigned = await request(app)
      .post('/api/v1/screenshots/presign')
      .set('Authorization', `Bearer ${a.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        timeEntryId: a.timeEntryId,
        capturedAt: new Date().toISOString(),
        monitorIndex: 0,
        contentType: 'image/jpeg',
      });
    r2Stub.put(r2Stub.putUrls[0]!.key, dummyJpegBytes(), 'image/jpeg');
    await request(app)
      .post(`/api/v1/screenshots/${presigned.body.screenshotId}/confirm`)
      .set('Authorization', `Bearer ${a.deviceToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        width: 1,
        height: 1,
        keyboardEventsCount: 0,
        mouseEventsCount: 0,
        sizeBytes: 16,
      });

    const get = await request(app)
      .get(`/api/v1/screenshots/${presigned.body.screenshotId}`)
      .set('Authorization', `Bearer ${b.webToken}`);
    expect(get.status).toBe(403);
  });
});

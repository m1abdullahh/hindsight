import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { mintToken } from '../src/auth/tokens.js';
import { mailStub } from '../src/lib/mail.js';
import { prisma } from '../src/lib/prisma.js';

import { makeTestApp } from './helpers/build-app.js';
import { isDbReachable, truncateAll } from './helpers/db.js';

interface SignupFixture {
  token: string;
  userId: string;
  orgId: string;
}

const signup = async (email: string, organizationName: string): Promise<SignupFixture> => {
  const app = makeTestApp();
  const res = await request(app)
    .post('/api/v1/auth/signup')
    .send({
      email,
      password: 'correct horse battery staple',
      name: email.split('@')[0],
      organizationName,
    });
  if (res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.token,
    userId: res.body.user.id,
    orgId: res.body.organization.id,
  };
};

const lastTokenFromMail = (): string => {
  const m = mailStub.sent.at(-1);
  if (!m) throw new Error('no mail captured');
  const match = m.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('no token in mail');
  return decodeURIComponent(match[1]!);
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('auth extras', () => {
  beforeEach(async () => {
    await truncateAll();
    mailStub.reset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── Email verification ─────────────────────────────────────────────────────

  it('verify-email marks user verified and revokes the token', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).emailVerifiedAt,
    ).toBeNull();

    const minted = await mintToken({ userId: owner.userId, kind: 'email_verify' });

    const app = makeTestApp();
    const res = await request(app)
      .post('/api/v1/auth/email/verify')
      .send({ token: minted.plaintext });
    expect(res.status).toBe(200);
    expect(res.body.verifiedAt).toBeTruthy();

    const u = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(u.emailVerifiedAt).not.toBeNull();

    const reused = await request(app)
      .post('/api/v1/auth/email/verify')
      .send({ token: minted.plaintext });
    expect(reused.status).toBe(401);
  });

  it('resend-verification is silent on unknown email and 204 on real one', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    void owner;
    const app = makeTestApp();

    const ok = await request(app)
      .post('/api/v1/auth/email/resend-verification')
      .send({ email: 'owner@example.com' });
    expect(ok.status).toBe(204);
    expect(mailStub.sent).toHaveLength(1);

    mailStub.reset();
    const unknown = await request(app)
      .post('/api/v1/auth/email/resend-verification')
      .send({ email: 'nobody@example.com' });
    expect(unknown.status).toBe(204);
    expect(mailStub.sent).toHaveLength(0);
  });

  // ── Password reset flow ────────────────────────────────────────────────────

  it('forgot-password is silent on unknown email; mails for real one', async () => {
    await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const ok = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'owner@example.com' });
    expect(ok.status).toBe(204);
    expect(mailStub.sent).toHaveLength(1);

    mailStub.reset();
    const unknown = await request(app)
      .post('/api/v1/auth/password/forgot')
      .send({ email: 'nobody@example.com' });
    expect(unknown.status).toBe(204);
    expect(mailStub.sent).toHaveLength(0);
  });

  it('reset-password swaps the password, signs out other tokens, returns a fresh session', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const oldToken = owner.token;
    const app = makeTestApp();

    await request(app).post('/api/v1/auth/password/forgot').send({ email: 'owner@example.com' });
    const resetToken = lastTokenFromMail();

    const res = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: resetToken, password: 'a-totally-new-password' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    // Old token no longer authenticates.
    const meOld = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${oldToken}`);
    expect(meOld.status).toBe(401);

    // New token does.
    const meNew = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(meNew.status).toBe(200);

    // Logging in with the new password also works.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@example.com', password: 'a-totally-new-password' });
    expect(login.status).toBe(200);
  });

  it('reset-password rejects reused/expired tokens', async () => {
    await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    await request(app).post('/api/v1/auth/password/forgot').send({ email: 'owner@example.com' });
    const resetToken = lastTokenFromMail();

    const first = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: resetToken, password: 'fresh-password-here-1' });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ token: resetToken, password: 'another-fresh-pass-1' });
    expect(replay.status).toBe(401);
  });

  // ── Password change ────────────────────────────────────────────────────────

  it('change-password verifies current, swaps it, revokes other tokens', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const otherToken = (await mintToken({ userId: owner.userId, kind: 'web' })).plaintext;

    const app = makeTestApp();
    const ok = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        currentPassword: 'correct horse battery staple',
        newPassword: 'a-completely-new-pass',
      });
    expect(ok.status).toBe(204);

    // Current token survives, other is revoked.
    const meCurrent = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(meCurrent.status).toBe(200);

    const meOther = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(meOther.status).toBe(401);

    // Old password no longer logs in.
    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner@example.com', password: 'correct horse battery staple' });
    expect(oldLogin.status).toBe(401);
  });

  it('change-password preserves device tokens (deliberate per docs)', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const device = await prisma.device.create({
      data: {
        id: 'd-1',
        userId: owner.userId,
        deviceName: 'Mac',
        os: 'macos',
        appVersion: '1.0.0',
      },
    });
    const deviceToken = (
      await mintToken({ userId: owner.userId, kind: 'device', deviceId: device.id })
    ).plaintext;

    const app = makeTestApp();
    const ok = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        currentPassword: 'correct horse battery staple',
        newPassword: 'a-completely-new-pass',
      });
    expect(ok.status).toBe(204);

    // Device token still works after password change — desktop sessions
    // are intentionally not killed when a user rotates their web password.
    const heartbeat = await request(app)
      .post('/api/v1/devices/heartbeat')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ appVersion: '1.0.0' });
    expect(heartbeat.status).toBe(200);
  });

  it('change-password rejects wrong current password', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const res = await request(app)
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ currentPassword: 'wrong-current-pass', newPassword: 'a-totally-new-pass' });
    expect(res.status).toBe(401);
  });

  // ── Sign-out-everywhere ────────────────────────────────────────────────────

  it('sign-out-everywhere with keepCurrent: true keeps the calling token', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const t2 = (await mintToken({ userId: owner.userId, kind: 'web' })).plaintext;
    const t3 = (await mintToken({ userId: owner.userId, kind: 'web' })).plaintext;

    const app = makeTestApp();
    const res = await request(app)
      .post('/api/v1/auth/sign-out-everywhere')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ keepCurrent: true });
    expect(res.status).toBe(204);

    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${owner.token}`))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${t2}`)).status,
    ).toBe(401);
    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${t3}`)).status,
    ).toBe(401);
  });

  it('sign-out-everywhere with keepCurrent: false revokes everything', async () => {
    const owner = await signup('owner@example.com', 'Acme');

    const app = makeTestApp();
    const res = await request(app)
      .post('/api/v1/auth/sign-out-everywhere')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ keepCurrent: false });
    expect(res.status).toBe(204);

    expect(
      (await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${owner.token}`))
        .status,
    ).toBe(401);
  });

  // ── Profile update ─────────────────────────────────────────────────────────

  it('PATCH /auth/me updates name and audits auth.profile_updated', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Alice the Owner' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Alice the Owner');
    expect(res.body.memberships).toHaveLength(1);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(user.name).toBe('Alice the Owner');

    const audits = await prisma.auditLog.findMany({ where: { action: 'auth.profile_updated' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({ fields: ['name'] });
  });

  it('PATCH /auth/me with empty body returns 422', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_input');
  });

  it('PATCH /auth/me without auth returns 401', async () => {
    const app = makeTestApp();
    const res = await request(app).patch('/api/v1/auth/me').send({ name: 'X' });
    expect(res.status).toBe(401);
  });
});

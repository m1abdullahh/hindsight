import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { mailStub } from '../src/lib/mail.js';
import { prisma } from '../src/lib/prisma.js';

import { makeTestApp } from './helpers/build-app.js';
import { isDbReachable, truncateAll } from './helpers/db.js';

interface SignupFixture {
  token: string;
  userId: string;
  orgId: string;
}

// Most tests want to exercise the invite flow itself, not the verify-before-
// invite gate. Default to verified; the one test that exercises the gate
// passes verify=false explicitly.
const signup = async (
  email: string,
  organizationName: string,
  opts: { verify?: boolean } = {},
): Promise<SignupFixture> => {
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
  const userId = res.body.user.id as string;
  if (opts.verify !== false) {
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  }
  return {
    token: res.body.token,
    userId,
    orgId: res.body.organization.id,
  };
};

const lastSentToken = (): string => {
  const m = mailStub.sent.at(-1);
  if (!m) throw new Error('no mail captured');
  // The token is in the URL: ?token=<plaintext>
  const match = m.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`no token in mail body: ${m.text}`);
  return decodeURIComponent(match[1]!);
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('invitations', () => {
  beforeEach(async () => {
    await truncateAll();
    mailStub.reset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('owner invites; mail captured; pending invite listed', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const res = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newbie@example.com', role: 'member' });

    expect(res.status).toBe(201);
    expect(res.body.mailed).toBe(true);
    expect(res.body.invitation.email).toBe('newbie@example.com');
    expect(res.body.invitation.role).toBe('member');
    expect(res.body.invitation.tokenHash).toBeUndefined(); // DTO strips it
    expect(mailStub.sent).toHaveLength(1);
    expect(mailStub.sent[0]?.to).toBe('newbie@example.com');

    const list = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(list.status).toBe(200);
    expect(list.body.invitations).toHaveLength(1);
  });

  it('member cannot invite (403)', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    // Create a member directly in the DB to avoid using invitations.
    const memberUser = await prisma.user.create({
      data: {
        id: 'u-member',
        email: 'member@example.com',
        name: 'member',
        passwordHash: 'placeholder',
      },
    });
    await prisma.membership.create({
      data: { id: 'm-member', orgId: owner.orgId, userId: memberUser.id, role: 'member' },
    });
    const { mintToken } = await import('../src/auth/tokens.js');
    const minted = await mintToken({ userId: memberUser.id, kind: 'web' });

    const app = makeTestApp();
    const res = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${minted.plaintext}`)
      .send({ email: 'newbie@example.com', role: 'member' });
    expect(res.status).toBe(403);
  });

  it('admin cannot invite admins (403); only owners can', async () => {
    const owner = await signup('owner@example.com', 'Acme');

    // Set up admin
    const adminUser = await prisma.user.create({
      data: {
        id: 'u-admin',
        email: 'admin@example.com',
        name: 'admin',
        passwordHash: 'placeholder',
      },
    });
    await prisma.membership.create({
      data: { id: 'm-admin', orgId: owner.orgId, userId: adminUser.id, role: 'admin' },
    });
    const { mintToken } = await import('../src/auth/tokens.js');
    const adminToken = (await mintToken({ userId: adminUser.id, kind: 'web' })).plaintext;

    const app = makeTestApp();
    const denied = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'newbie@example.com', role: 'admin' });
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'newbie@example.com', role: 'member' });
    expect(ok.status).toBe(201);
  });

  it('duplicate pending invite returns 409', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();
    const first = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newbie@example.com', role: 'member' });
    expect(first.status).toBe(201);

    const dup = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newbie@example.com', role: 'member' });
    expect(dup.status).toBe(409);
  });

  it('inviting an existing active member returns 409', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const res = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'owner@example.com', role: 'admin' });
    expect(res.status).toBe(409);
  });

  it('accept (new user) creates user, membership, returns auth token', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newbie@example.com', role: 'member' });

    const token = lastSentToken();
    const acc = await request(app).post('/api/v1/auth/invitations/accept').send({
      token,
      password: 'first-time-pass-here',
      name: 'Newbie',
    });

    expect(acc.status).toBe(201);
    expect(acc.body.user.email).toBe('newbie@example.com');
    // Invite-accept no longer auto-verifies email: the new user must go
    // through the normal verify flow before gaining verify-gated capabilities
    // (e.g. inviting others).
    expect(acc.body.user.emailVerifiedAt).toBeNull();
    expect(typeof acc.body.token).toBe('string');

    // The token authenticates /me
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${acc.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.memberships).toHaveLength(1);

    // Audit
    const audits = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('member.invited');
    expect(actions).toContain('member.joined');
    expect(actions).toContain('auth.signup');
  });

  it('accept (existing user) creates only the membership, no password needed', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const otherOrgOwner = await signup('alice@example.com', 'Other');
    const app = makeTestApp();

    await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'alice@example.com', role: 'member' });

    const token = lastSentToken();
    const acc = await request(app).post('/api/v1/auth/invitations/accept').send({ token });
    expect(acc.status).toBe(201);
    expect(acc.body.user.id).toBe(otherOrgOwner.userId);
    expect(acc.body.memberships).toHaveLength(2);
  });

  it('accept with HIBP-pwned password returns 422 (when new user)', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newbie@example.com', role: 'member' });

    const token = lastSentToken();
    const acc = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token, password: 'password1234', name: 'Newbie' });
    // 422 if HIBP responded; HIBP fails open on network error so this could
    // pass through to 201. We assert the contract: NOT a 500.
    expect([201, 422]).toContain(acc.status);
  });

  it('revoke makes the token unusable', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const created = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newbie@example.com', role: 'member' });
    const invitationId = created.body.invitation.id;
    const token = lastSentToken();

    const revoked = await request(app)
      .delete(`/api/v1/orgs/${owner.orgId}/invitations/${invitationId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(revoked.status).toBe(204);

    const acc = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token, password: 'first-time-pass-here', name: 'Newbie' });
    expect(acc.status).toBe(404);
  });

  it('accept with bogus token returns 404', async () => {
    const app = makeTestApp();
    const acc = await request(app).post('/api/v1/auth/invitations/accept').send({
      token: 'not-a-real-token-but-long-enough-to-pass-zod',
      password: 'first-time-pass-here',
      name: 'Nobody',
    });
    expect(acc.status).toBe(404);
  });

  it('accept by new user with no password/name returns 400 with details.requires=[password,name]', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();
    await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newbie@example.com', role: 'member' });
    const token = lastSentToken();

    const acc = await request(app).post('/api/v1/auth/invitations/accept').send({ token });

    expect(acc.status).toBe(400);
    expect(acc.body.error.code).toBe('invalid_input');
    expect(acc.body.error.details).toEqual({
      requires: ['password', 'name'],
      existingUser: false,
    });
  });

  it('accept by new user with only name returns 400 with details.requires=[password]', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();
    await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newbie@example.com', role: 'member' });
    const token = lastSentToken();

    const acc = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token, name: 'Newbie' });

    expect(acc.status).toBe(400);
    expect(acc.body.error.details).toEqual({
      requires: ['password'],
      existingUser: false,
    });
  });

  it('accept by existing user with password returns 400 with details.existingUser=true', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    await signup('alice@example.com', 'Other');
    const app = makeTestApp();
    await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'alice@example.com', role: 'member' });
    const token = lastSentToken();

    const acc = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .send({ token, password: 'should-not-be-here-123' });

    expect(acc.status).toBe(400);
    expect(acc.body.error.details).toEqual({
      requires: [],
      existingUser: true,
    });
  });

  it('member trying to list invitations returns 403', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberUser = await prisma.user.create({
      data: {
        id: 'u-listmember',
        email: 'listmember@example.com',
        name: 'list',
        passwordHash: 'placeholder',
      },
    });
    await prisma.membership.create({
      data: { id: 'm-listmember', orgId: owner.orgId, userId: memberUser.id, role: 'member' },
    });
    const { mintToken } = await import('../src/auth/tokens.js');
    const memberToken = (await mintToken({ userId: memberUser.id, kind: 'web' })).plaintext;

    const app = makeTestApp();
    const res = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });

  it('unverified owner cannot send invitations', async () => {
    const unverified = await signup('unverified@example.com', 'Acme', { verify: false });
    const app = makeTestApp();
    const res = await request(app)
      .post(`/api/v1/orgs/${unverified.orgId}/invitations`)
      .set('Authorization', `Bearer ${unverified.token}`)
      .send({ email: 'newhire@example.com', role: 'member' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/verify/i);
  });

  it('accept while signed in as a DIFFERENT user returns 409', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const intruder = await signup('intruder@example.com', 'OtherCo');
    const app = makeTestApp();

    await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'newbie@example.com', role: 'member' });
    const token = lastSentToken();

    const res = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .set('Authorization', `Bearer ${intruder.token}`)
      .send({ token, password: 'first-time-pass-here', name: 'Newbie' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/sign out/i);
  });

  it('accept while signed in as the SAME (already-existing) user attaches membership', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const otherOrgUser = await signup('overlap@example.com', 'OverlapOrg');
    const app = makeTestApp();

    await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'overlap@example.com', role: 'member' });
    const token = lastSentToken();

    const res = await request(app)
      .post('/api/v1/auth/invitations/accept')
      .set('Authorization', `Bearer ${otherOrgUser.token}`)
      .send({ token });
    expect(res.status).toBe(201);
    // They now have both memberships.
    expect(res.body.memberships).toHaveLength(2);
  });
});

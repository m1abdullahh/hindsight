import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/lib/prisma.js';

import { makeTestApp } from './helpers/build-app.js';
import { isDbReachable, truncateAll } from './helpers/db.js';

interface SignupFixture {
  token: string;
  userId: string;
  orgId: string;
}

const localPart = (email: string): string => {
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
};

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
  if (res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.token,
    userId: res.body.user.id,
    orgId: res.body.organization.id,
  };
};

const inviteAsMember = async (
  orgId: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ userId: string; token: string }> => {
  // Plan 03 lands the invitation flow. For Plan 02 tests we directly insert
  // a user + membership through the DB layer to set up multi-member fixtures,
  // then mint a token via the same primitive the auth service uses.
  const user = await prisma.user.create({
    data: {
      id: `u-${email}`,
      email,
      name: localPart(email),
      passwordHash: 'placeholder',
    },
  });
  await prisma.membership.create({
    data: { id: `m-${email}`, orgId, userId: user.id, role },
  });

  const { mintToken } = await import('../src/auth/tokens.js');
  const minted = await mintToken({ userId: user.id, kind: 'web' });
  return { userId: user.id, token: minted.plaintext };
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('orgs endpoints', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('GET /orgs/:orgId returns the org for an active member', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();
    const res = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}`)
      .set('Authorization', `Bearer ${owner.token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(owner.orgId);
  });

  it('GET /orgs/:orgId returns 403 for non-member', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const outsider = await signup('outsider@example.com', 'Other Co');

    const app = makeTestApp();
    const res = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}`)
      .set('Authorization', `Bearer ${outsider.token}`);

    expect(res.status).toBe(403);
  });

  it('PATCH /orgs/:orgId allows owner, denies member', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const member = await inviteAsMember(owner.orgId, 'member@example.com', 'member');

    const app = makeTestApp();

    const ok = await request(app)
      .patch(`/api/v1/orgs/${owner.orgId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Acme Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Acme Renamed');

    const denied = await request(app)
      .patch(`/api/v1/orgs/${owner.orgId}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: 'Hacked' });
    expect(denied.status).toBe(403);
  });

  it('GET /members lists everyone in the org', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    await inviteAsMember(owner.orgId, 'member@example.com', 'member');

    const app = makeTestApp();
    const res = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/members`)
      .set('Authorization', `Bearer ${owner.token}`);

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(2);
  });

  it('PATCH member role works for owner, blocked when last owner would be demoted', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    // Demoting the only owner → 409
    const fail = await request(app)
      .patch(`/api/v1/orgs/${owner.orgId}/members/${owner.userId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'member' });
    expect(fail.status).toBe(409);

    // Promote a second user, then demoting the first should now work
    const second = await inviteAsMember(owner.orgId, 'second@example.com', 'admin');
    await request(app)
      .patch(`/api/v1/orgs/${owner.orgId}/members/${second.userId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'owner' });

    const ok = await request(app)
      .patch(`/api/v1/orgs/${owner.orgId}/members/${owner.userId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role: 'admin' });
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe('admin');
  });

  it('DELETE member: cannot remove last owner', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const res = await request(app)
      .delete(`/api/v1/orgs/${owner.orgId}/members/${owner.userId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(409);
  });
});

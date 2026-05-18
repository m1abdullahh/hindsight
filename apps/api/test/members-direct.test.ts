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
  return { token: res.body.token, userId, orgId: res.body.organization.id };
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('members direct add', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('owner adds member directly; user + active membership created; email auto-verified', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const res = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/members/direct`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        email: 'newhire@example.com',
        name: 'New Hire',
        role: 'member',
        password: 'admin-chosen-pass-12',
      });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('newhire@example.com');
    expect(res.body.user.name).toBe('New Hire');
    expect(res.body.user.emailVerifiedAt).not.toBeNull();
    expect(res.body.membership.role).toBe('member');
    expect(res.body.membership.status).toBe('active');

    // Persisted: user has a usable password hash, not a placeholder.
    const created = await prisma.user.findUnique({ where: { email: 'newhire@example.com' } });
    expect(created?.passwordHash).toBeTruthy();
    expect(created?.passwordHash?.length).toBeGreaterThan(20);

    // The new user can log in with the admin-set password.
    const login = await request(app).post('/api/v1/auth/login').send({
      email: 'newhire@example.com',
      password: 'admin-chosen-pass-12',
    });
    expect(login.status).toBe(200);
    expect(typeof login.body.token).toBe('string');
  });

  it('rejects passwords listed in HIBP (422)', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const res = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/members/direct`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        email: 'newhire@example.com',
        name: 'New Hire',
        role: 'member',
        password: 'password1234',
      });

    expect(res.status).toBe(422);
    expect(await prisma.user.findUnique({ where: { email: 'newhire@example.com' } })).toBeNull();
  });

  it('member cannot add directly (403)', async () => {
    const owner = await signup('owner@example.com', 'Acme');
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
      .post(`/api/v1/orgs/${owner.orgId}/members/direct`)
      .set('Authorization', `Bearer ${minted.plaintext}`)
      .send({
        email: 'newhire@example.com',
        name: 'New Hire',
        role: 'member',
        password: 'admin-chosen-pass-12',
      });
    expect(res.status).toBe(403);
  });

  it('admin cannot add admins (403); can add members', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const adminUser = await prisma.user.create({
      data: {
        id: 'u-admin',
        email: 'admin@example.com',
        name: 'admin',
        passwordHash: 'placeholder',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: { id: 'm-admin', orgId: owner.orgId, userId: adminUser.id, role: 'admin' },
    });
    const { mintToken } = await import('../src/auth/tokens.js');
    const adminToken = (await mintToken({ userId: adminUser.id, kind: 'web' })).plaintext;
    const app = makeTestApp();

    const denied = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/members/direct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'newadmin@example.com',
        name: 'New Admin',
        role: 'admin',
        password: 'admin-chosen-pass-12',
      });
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/members/direct`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'newmember@example.com',
        name: 'New Member',
        role: 'member',
        password: 'admin-chosen-pass-12',
      });
    expect(ok.status).toBe(201);
  });

  it('rejects unverified caller (403)', async () => {
    const owner = await signup('owner@example.com', 'Acme', { verify: false });
    const app = makeTestApp();

    const res = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/members/direct`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        email: 'newhire@example.com',
        name: 'New Hire',
        role: 'member',
        password: 'admin-chosen-pass-12',
      });
    expect(res.status).toBe(403);
  });

  it('rejects when an account with this email already exists (409)', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    // Existing user in a different org.
    await prisma.user.create({
      data: {
        id: 'u-existing',
        email: 'taken@example.com',
        name: 'someone',
        passwordHash: 'placeholder',
      },
    });
    const app = makeTestApp();

    const res = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/members/direct`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        email: 'taken@example.com',
        name: 'Taken',
        role: 'member',
        password: 'admin-chosen-pass-12',
      });
    expect(res.status).toBe(409);
  });

  it('rejects when a pending invitation exists for the email (409)', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    const invite = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/invitations`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'pending@example.com', role: 'member' });
    expect(invite.status).toBe(201);

    const res = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/members/direct`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        email: 'pending@example.com',
        name: 'Pending',
        role: 'member',
        password: 'admin-chosen-pass-12',
      });
    expect(res.status).toBe(409);
  });

  it('writes an audit log entry with action "member.directly_added"', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const app = makeTestApp();

    await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/members/direct`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        email: 'newhire@example.com',
        name: 'New Hire',
        role: 'member',
        password: 'admin-chosen-pass-12',
      });

    const log = await prisma.auditLog.findFirst({
      where: { orgId: owner.orgId, action: 'member.directly_added' },
    });
    expect(log).not.toBeNull();
    expect(log?.actorId).toBe(owner.userId);
  });
});

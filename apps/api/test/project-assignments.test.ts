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

const seedMember = async (
  orgId: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ userId: string; token: string }> => {
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
  const minted = await mintToken({ userId: user.id, kind: 'web' });
  return { userId: user.id, token: minted.plaintext };
};

const createProject = async (ownerToken: string, orgId: string): Promise<{ id: string }> => {
  const app = makeTestApp();
  const res = await request(app)
    .post(`/api/v1/orgs/${orgId}/projects`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ name: 'Project A' });
  if (res.status !== 201) {
    throw new Error(`createProject failed: ${res.status}`);
  }
  return { id: res.body.id };
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('project assignments', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('admin assigns a member; assignment row created with audit', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberFx = await seedMember(owner.orgId, 'member@example.com', 'member');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId, hourlyRateCents: 5000 });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(memberFx.userId);
    expect(res.body.hourlyRateCents).toBe(5000);
    expect(res.body.removedAt).toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { action: 'project.assignment_added' },
    });
    expect(audits).toHaveLength(1);
  });

  it('list assignments includes embedded user', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberFx = await seedMember(owner.orgId, 'member@example.com', 'member');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId });

    const list = await request(app)
      .get(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(list.status).toBe(200);
    expect(list.body.assignments).toHaveLength(1);
    expect(list.body.assignments[0].user.email).toBe('member@example.com');
  });

  it('PATCH updates hourly rate', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberFx = await seedMember(owner.orgId, 'member@example.com', 'member');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId, hourlyRateCents: 5000 });

    const res = await request(app)
      .patch(`/api/v1/projects/${project.id}/assignments/${memberFx.userId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ hourlyRateCents: 7500 });
    expect(res.status).toBe(200);
    expect(res.body.hourlyRateCents).toBe(7500);

    const audits = await prisma.auditLog.findMany({
      where: { action: 'project.assignment_updated' },
    });
    expect(audits).toHaveLength(1);
  });

  it('DELETE soft-removes; re-add reactivates the same row', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberFx = await seedMember(owner.orgId, 'member@example.com', 'member');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    const created = await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId });
    const originalId = created.body.id;

    const removed = await request(app)
      .delete(`/api/v1/projects/${project.id}/assignments/${memberFx.userId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(removed.status).toBe(204);

    const reAdded = await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId });
    expect(reAdded.status).toBe(201);
    expect(reAdded.body.id).toBe(originalId);
    expect(reAdded.body.removedAt).toBeNull();
  });

  it('duplicate active assignment returns 409', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberFx = await seedMember(owner.orgId, 'member@example.com', 'member');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId });

    const dup = await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId });
    expect(dup.status).toBe(409);
  });

  it('assigning a non-member returns 422', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const otherOrgUser = await signup('other@example.com', 'Other Co');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    const res = await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: otherOrgUser.userId });
    expect(res.status).toBe(422);
  });

  it('member cannot add/update/remove assignments', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const m1 = await seedMember(owner.orgId, 'm1@example.com', 'member');
    const m2 = await seedMember(owner.orgId, 'm2@example.com', 'member');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    // Owner adds m1 first so m2 has something to look at.
    await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: m1.userId });

    const memberAdd = await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${m1.token}`)
      .send({ userId: m2.userId });
    expect(memberAdd.status).toBe(403);

    const memberRemove = await request(app)
      .delete(`/api/v1/projects/${project.id}/assignments/${m1.userId}`)
      .set('Authorization', `Bearer ${m1.token}`);
    expect(memberRemove.status).toBe(403);
  });

  it('member of project can list its assignments; non-assigned member cannot', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const onProject = await seedMember(owner.orgId, 'on@example.com', 'member');
    const offProject = await seedMember(owner.orgId, 'off@example.com', 'member');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: onProject.userId });

    const onList = await request(app)
      .get(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${onProject.token}`);
    expect(onList.status).toBe(200);

    const offList = await request(app)
      .get(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${offProject.token}`);
    expect(offList.status).toBe(403);
  });

  it('hourlyRateCents validation rejects negative + too-large', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberFx = await seedMember(owner.orgId, 'member@example.com', 'member');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    const neg = await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId, hourlyRateCents: -1 });
    expect(neg.status).toBe(422);

    const huge = await request(app)
      .post(`/api/v1/projects/${project.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId, hourlyRateCents: 100_000_001 });
    expect(huge.status).toBe(422);
  });
});

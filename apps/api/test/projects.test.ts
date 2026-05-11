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

const createProject = async (
  ownerToken: string,
  orgId: string,
  body: { name?: string; screenshotIntervalMinutes?: number; blurScreenshots?: boolean } = {},
): Promise<{ id: string; name: string; orgId: string }> => {
  const app = makeTestApp();
  const res = await request(app)
    .post(`/api/v1/orgs/${orgId}/projects`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ name: body.name ?? 'Project A', ...body });
  if (res.status !== 201) {
    throw new Error(`createProject failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id, name: res.body.name, orgId: res.body.orgId };
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('projects', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── Create / list / get ────────────────────────────────────────────────────

  it('owner creates a project; appears in list with audit row', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const project = await createProject(owner.token, owner.orgId, { name: 'P1' });

    expect(project.name).toBe('P1');
    expect(project.orgId).toBe(owner.orgId);

    const app = makeTestApp();
    const list = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/projects`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(list.status).toBe(200);
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0].id).toBe(project.id);

    const audits = await prisma.auditLog.findMany({ where: { action: 'project.created' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(project.id);
  });

  it('admin can create a project; member cannot', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const admin = await seedMember(owner.orgId, 'admin@example.com', 'admin');
    const memberFx = await seedMember(owner.orgId, 'member@example.com', 'member');
    const app = makeTestApp();

    const adminCreate = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/projects`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ name: 'A' });
    expect(adminCreate.status).toBe(201);

    const memberCreate = await request(app)
      .post(`/api/v1/orgs/${owner.orgId}/projects`)
      .set('Authorization', `Bearer ${memberFx.token}`)
      .send({ name: 'M' });
    expect(memberCreate.status).toBe(403);
  });

  it('GET /projects/:id 200 for admin, 403 for unassigned member', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberFx = await seedMember(owner.orgId, 'member@example.com', 'member');
    const project = await createProject(owner.token, owner.orgId);
    const app = makeTestApp();

    const ownerGet = await request(app)
      .get(`/api/v1/projects/${project.id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(ownerGet.status).toBe(200);

    const memberGet = await request(app)
      .get(`/api/v1/projects/${project.id}`)
      .set('Authorization', `Bearer ${memberFx.token}`);
    expect(memberGet.status).toBe(403);
  });

  it('member sees only assigned projects in list', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const memberFx = await seedMember(owner.orgId, 'member@example.com', 'member');
    const p1 = await createProject(owner.token, owner.orgId, { name: 'Assigned' });
    await createProject(owner.token, owner.orgId, { name: 'Other' });
    await createProject(owner.token, owner.orgId, { name: 'Also Other' });

    const app = makeTestApp();
    await request(app)
      .post(`/api/v1/projects/${p1.id}/assignments`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: memberFx.userId });

    const list = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/projects`)
      .set('Authorization', `Bearer ${memberFx.token}`);
    expect(list.status).toBe(200);
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0].name).toBe('Assigned');
  });

  // ── Update ────────────────────────────────────────────────────────────────

  it('PATCH updates fields and writes a project.updated audit row', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const project = await createProject(owner.token, owner.orgId, { name: 'Old' });

    const app = makeTestApp();
    const res = await request(app)
      .patch(`/api/v1/projects/${project.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'New', screenshotIntervalMinutes: 5 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.screenshotIntervalMinutes).toBe(5);

    const audits = await prisma.auditLog.findMany({ where: { action: 'project.updated' } });
    expect(audits).toHaveLength(1);
    expect((audits[0]!.metadata as { fields: string[] }).fields).toEqual(
      expect.arrayContaining(['name', 'screenshotIntervalMinutes']),
    );
  });

  it('PATCH with empty body returns 422', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    const res = await request(app)
      .patch(`/api/v1/projects/${project.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});
    expect(res.status).toBe(422);
  });

  it('PATCH with out-of-range interval returns 422', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    const res = await request(app)
      .patch(`/api/v1/projects/${project.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ screenshotIntervalMinutes: 0 });
    expect(res.status).toBe(422);
  });

  // ── Archive / unarchive ──────────────────────────────────────────────────

  it('archive sets archivedAt; unarchive clears it; both write audit rows', async () => {
    const owner = await signup('owner@example.com', 'Acme');
    const project = await createProject(owner.token, owner.orgId);

    const app = makeTestApp();
    const archived = await request(app)
      .post(`/api/v1/projects/${project.id}/archive`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).not.toBeNull();

    // Default list excludes archived
    const list = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/projects`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(list.body.projects).toHaveLength(0);

    // includeArchived=true brings them back
    const all = await request(app)
      .get(`/api/v1/orgs/${owner.orgId}/projects?includeArchived=true`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(all.body.projects).toHaveLength(1);

    const unarchived = await request(app)
      .delete(`/api/v1/projects/${project.id}/archive`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(unarchived.status).toBe(200);
    expect(unarchived.body.archivedAt).toBeNull();

    const audits = await prisma.auditLog.findMany({});
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('project.archived');
    expect(actions).toContain('project.unarchived');
  });

  // ── Cross-org isolation ──────────────────────────────────────────────────

  it('user in org B cannot access project in org A', async () => {
    const a = await signup('a@example.com', 'Org A');
    const b = await signup('b@example.com', 'Org B');
    const project = await createProject(a.token, a.orgId);

    const app = makeTestApp();
    const res = await request(app)
      .get(`/api/v1/projects/${project.id}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(res.status).toBe(403);
  });

  it('GET /projects/:id with random ULID returns 404', async () => {
    const owner = await signup('owner@example.com', 'Acme');

    const app = makeTestApp();
    const res = await request(app)
      .get('/api/v1/projects/01HZZZZZZZZZZZZZZZZZZZZZZZ')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(404);
  });
});

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/lib/prisma.js';

import { makeTestApp } from './helpers/build-app.js';
import { isDbReachable, truncateAll } from './helpers/db.js';

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))(
  'POST /auth/* + GET /auth/me',
  () => {
    beforeAll(async () => {
      if (!(await isDbReachable())) {
        throw new Error(
          'Test database not reachable — set TEST_DATABASE_URL to a Neon test branch and run pnpm db:test:migrate first',
        );
      }
    });

    beforeEach(async () => {
      await truncateAll();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    const validSignup = {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      name: 'Alice',
      organizationName: 'Acme',
    };

    it('signup creates user + org + membership and returns a token', async () => {
      const app = makeTestApp();
      const res = await request(app).post('/api/v1/auth/signup').send(validSignup);

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ email: 'alice@example.com', name: 'Alice' });
      expect(res.body.organization).toMatchObject({ name: 'Acme' });
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.length).toBeGreaterThanOrEqual(40);

      const memberships = await prisma.membership.findMany({});
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.role).toBe('owner');

      const audit = await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      const actions = audit.map((a) => a.action);
      expect(actions).toContain('org.created');
      expect(actions).toContain('auth.signup');
    });

    it('signup normalizes email to lowercase', async () => {
      const app = makeTestApp();
      await request(app)
        .post('/api/v1/auth/signup')
        .send({ ...validSignup, email: 'ALICE@EXAMPLE.COM' });
      const u = await prisma.user.findUnique({ where: { email: 'alice@example.com' } });
      expect(u).toBeTruthy();
    });

    it('duplicate email returns 409', async () => {
      const app = makeTestApp();
      await request(app).post('/api/v1/auth/signup').send(validSignup);
      const res = await request(app).post('/api/v1/auth/signup').send(validSignup);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
    });

    it('login with correct password returns a token', async () => {
      const app = makeTestApp();
      await request(app).post('/api/v1/auth/signup').send(validSignup);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.com', password: validSignup.password });

      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.memberships).toHaveLength(1);
    });

    it('login with wrong password returns 401', async () => {
      const app = makeTestApp();
      await request(app).post('/api/v1/auth/signup').send(validSignup);

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.com', password: 'definitely-wrong' });

      expect(res.status).toBe(401);
    });

    it('login with unknown email also returns 401 (no existence leak)', async () => {
      const app = makeTestApp();
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'anything-at-all-here' });

      expect(res.status).toBe(401);
    });

    it('me returns user + memberships when authed', async () => {
      const app = makeTestApp();
      const signup = await request(app).post('/api/v1/auth/signup').send(validSignup);
      const token = signup.body.token as string;

      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('alice@example.com');
      expect(res.body.memberships).toHaveLength(1);
    });

    it('me without auth returns 401', async () => {
      const app = makeTestApp();
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('logout revokes the calling token', async () => {
      const app = makeTestApp();
      const signup = await request(app).post('/api/v1/auth/signup').send(validSignup);
      const token = signup.body.token as string;

      const out = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${token}`);
      expect(out.status).toBe(204);

      const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(401);
    });
  },
);

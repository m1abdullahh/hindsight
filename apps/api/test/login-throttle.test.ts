import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { flushLoginThrottleKeys } from '../src/auth/login-throttle.js';
import { prisma } from '../src/lib/prisma.js';

import { makeTestApp } from './helpers/build-app.js';
import { isDbReachable, truncateAll } from './helpers/db.js';

const signup = async (email: string): Promise<void> => {
  const app = makeTestApp();
  const res = await request(app)
    .post('/api/v1/auth/signup')
    .send({
      email,
      password: 'correct horse battery staple',
      name: email.split('@')[0],
      organizationName: 'Acme',
    });
  if (res.status !== 201) throw new Error(`signup failed ${res.status}`);
};

describe.skipIf(!process.env['CI'] && !(await isDbReachable()))('login throttle', () => {
  beforeEach(async () => {
    await truncateAll();
    await flushLoginThrottleKeys();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('locks an email after 5 failures and returns 429 with Retry-After', async () => {
    await signup('victim@example.com');
    const app = makeTestApp();

    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'victim@example.com', password: 'definitely-wrong-here' });
      expect(r.status).toBe(401);
    }

    const locked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'victim@example.com', password: 'correct horse battery staple' });
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeTruthy();
  });

  it('unknown emails also throttle (anti-enumeration)', async () => {
    const app = makeTestApp();

    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'ghost@example.com', password: 'whatever-pass-here' });
      expect(r.status).toBe(401);
    }

    const next = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: 'whatever-pass-here' });
    expect(next.status).toBe(429);
  });

  it('failures from one IP do NOT lock the victim from a different IP (account-DoS protection)', async () => {
    await signup('victim@example.com');
    const app = makeTestApp();

    // Attacker on 1.2.3.4 exhausts the (victim@…, 1.2.3.4) bucket.
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '1.2.3.4')
        .send({ email: 'victim@example.com', password: 'definitely-wrong-here' });
      expect(r.status).toBe(401);
    }

    // Attacker IP is now locked.
    const attackerLocked = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '1.2.3.4')
      .send({ email: 'victim@example.com', password: 'correct horse battery staple' });
    expect(attackerLocked.status).toBe(429);

    // But the legitimate user logging in from their own IP still succeeds.
    const victimOk = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '9.9.9.9')
      .send({ email: 'victim@example.com', password: 'correct horse battery staple' });
    expect(victimOk.status).toBe(200);
  });

  it('successful login below threshold clears the counter', async () => {
    await signup('user@example.com');
    const app = makeTestApp();

    for (let i = 0; i < 4; i++) {
      const r = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'wrong-pass-here-still' });
      expect(r.status).toBe(401);
    }

    const ok = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'correct horse battery staple' });
    expect(ok.status).toBe(200);

    // After success, 4 more failures still don't lock (counter was cleared).
    for (let i = 0; i < 4; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'wrong-again-here' });
    }
    const stillOk = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'correct horse battery staple' });
    expect(stillOk.status).toBe(200);
  });
});

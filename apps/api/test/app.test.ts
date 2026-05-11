import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { makeTestApp } from './helpers/build-app.js';

describe('GET /healthz', () => {
  it('returns 200 with ok payload', async () => {
    const app = makeTestApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(typeof res.body.version).toBe('string');
  });
});

// 404 + error-envelope coverage lives with the first feature plan that
// adds Redis-backed routes. Until then, exercising the rate-limit
// middleware in tests would require a reachable Upstash Redis.

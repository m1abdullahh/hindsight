import { beforeEach, describe, expect, it } from 'vitest';

import { http, HttpResponse, server } from '@/test/msw-server';

import { ApiError, api, apiGet, apiPost } from './api';
import { sessionStore } from './session-store';

describe('api wrapper', () => {
  beforeEach(() => {
    sessionStore.getState().clearSession();
  });

  it('builds URL with query params, skipping undefined/null', async () => {
    server.use(
      http.get('/api/v1/things', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('a')).toBe('1');
        expect(url.searchParams.get('b')).toBe('hello');
        expect(url.searchParams.has('c')).toBe(false);
        return HttpResponse.json({ ok: true });
      }),
    );
    await apiGet('/things', { a: 1, b: 'hello', c: undefined, d: null });
  });

  it('sets Content-Type only when body is present', async () => {
    server.use(
      http.post('/api/v1/x', ({ request }) => {
        expect(request.headers.get('content-type')).toBe('application/json');
        return HttpResponse.json({ ok: true });
      }),
      http.post('/api/v1/y', ({ request }) => {
        expect(request.headers.get('content-type')).toBeNull();
        return HttpResponse.json({ ok: true });
      }),
    );
    await apiPost('/x', { foo: 'bar' });
    await apiPost('/y');
  });

  it('attaches Authorization header when a token is set', async () => {
    server.use(
      http.get('/api/v1/secure', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer abc123');
        return HttpResponse.json({ ok: true });
      }),
    );
    sessionStore.setState({ token: 'abc123' });
    await apiGet('/secure');
  });

  it('returns undefined for 204 responses', async () => {
    server.use(http.post('/api/v1/n', () => new HttpResponse(null, { status: 204 })));
    const res = await apiPost('/n');
    expect(res).toBeUndefined();
  });

  it('throws ApiError on a 4xx with structured body', async () => {
    server.use(
      http.get('/api/v1/oops', () =>
        HttpResponse.json(
          { error: { code: 'forbidden', message: 'nope', details: { x: 1 } } },
          { status: 403 },
        ),
      ),
    );
    await expect(api('/oops')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'forbidden',
      status: 403,
      details: { x: 1 },
    });
  });

  it('clears session on 401 by default', async () => {
    sessionStore.setState({ token: 'tok' });
    server.use(
      http.get('/api/v1/whoami', () =>
        HttpResponse.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
      ),
    );
    await expect(api('/whoami')).rejects.toBeInstanceOf(ApiError);
    expect(sessionStore.getState().token).toBeNull();
  });

  it('does not clear session when swallow401 is true', async () => {
    sessionStore.setState({ token: 'tok' });
    server.use(
      http.get('/api/v1/whoami', () =>
        HttpResponse.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
      ),
    );
    await expect(api('/whoami', { swallow401: true })).rejects.toBeInstanceOf(ApiError);
    expect(sessionStore.getState().token).toBe('tok');
  });

  it('falls back to internal error when body is not JSON on a 5xx', async () => {
    server.use(http.get('/api/v1/boom', () => new HttpResponse('plain text', { status: 500 })));
    try {
      await api('/boom');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('internal');
    }
  });

  it('reads Retry-After on 429', async () => {
    server.use(
      http.post('/api/v1/login', () =>
        HttpResponse.json(
          { error: { code: 'too_many_attempts', message: 'wait' } },
          { status: 429, headers: { 'Retry-After': '120' } },
        ),
      ),
    );
    try {
      await apiPost('/login', {});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).retryAfter).toBe(120);
    }
  });
});

import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../lib/errors.js';
import { redis } from '../lib/redis.js';

interface CachedResponse {
  status: number;
  body: unknown;
}

const TTL_SECONDS = 24 * 60 * 60;

// Per-route middleware. Routes that must enforce idempotency
// (all mutating desktop endpoints — see docs/05-api-surface.md:13)
// attach this explicitly; it isn't applied globally.
//
// Cache keys are namespaced by user id. Without this, two callers reusing the
// same Idempotency-Key against the same path (most likely a buggy client that
// hardcodes a constant, but also a deliberate cross-account probe) receive
// each other's response — for /devices/register that leaks a device token,
// for /screenshots/presign it leaks a presigned PUT URL.
//
// Non-2xx responses are not cached: a transient 500 or a validation 4xx
// should not stick for 24 h and block legitimate retries.
export const idempotency =
  () =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.get('idempotency-key');
    if (!key) {
      next(new AppError('invalid_input', 400, 'Idempotency-Key header required'));
      return;
    }

    if (!req.caller) {
      // Routing bug: idempotency() was attached without an auth middleware in
      // front. Fail closed rather than caching anonymously.
      next(new AppError('internal', 500, 'idempotency requires authenticated caller'));
      return;
    }

    // Namespace by token id, not user id: two devices owned by the same user
    // that collide on an Idempotency-Key still get isolated cache entries,
    // which is the actual boundary a retrying client cares about.
    const tokenId = req.caller.token.id;
    const cacheKey = `idem:${tokenId}:${req.method}:${req.path}:${key}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedResponse;
      res.status(parsed.status).json(parsed.body);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void redis.set(
          cacheKey,
          JSON.stringify({ status: res.statusCode, body } satisfies CachedResponse),
          'EX',
          TTL_SECONDS,
        );
      }
      return originalJson(body);
    };
    next();
  };

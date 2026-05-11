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
export const idempotency =
  () =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.get('idempotency-key');
    if (!key) {
      next(new AppError('invalid_input', 400, 'Idempotency-Key header required'));
      return;
    }

    const cacheKey = `idem:${req.method}:${req.path}:${key}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedResponse;
      res.status(parsed.status).json(parsed.body);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      void redis.set(
        cacheKey,
        JSON.stringify({ status: res.statusCode, body } satisfies CachedResponse),
        'EX',
        TTL_SECONDS,
      );
      return originalJson(body);
    };
    next();
  };

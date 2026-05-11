# Backend — Bootstrap, Config, Errors, Testing

## Config loading (`src/config/env.ts`)

One Zod schema parses `process.env` once at startup. Throw on invalid → process exits before serving traffic. Export a typed `config` object; nothing else in the codebase reads `process.env` directly.

```ts
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PUBLIC_API_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(), // CORS allow-list — tokens go in Authorization header, no cookies
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  MAIL_PROVIDER_API_KEY: z.string().optional(),
});

export const config = Env.parse(process.env);
export type Config = z.infer<typeof Env>;
```

R2 + mail are optional in dev; the screenshot ingestion + invitation modules assert their presence at use site, returning a clear "not configured" error rather than crashing the API.

There is **no `SESSION_SECRET`**. Bearer tokens are 32-byte random strings; the server stores `sha256(token)` in the `tokens` table. The DB hash _is_ the verification — no HMAC key needed.

## App factory (`src/app.ts`)

```ts
import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { config } from './config/env.js';
import { logger } from './lib/logger.js';
import { ulid } from './lib/id.js';
import { AppError } from './lib/errors.js';
import { requestContext } from './middleware/request-context.js';
import { rateLimit } from './middleware/rate-limit.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRouter } from './modules/health/routes.js';
import { v1Routers } from './modules/index.js';

export function buildApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(helmet());
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: false }));
  app.use(compression());
  app.use(express.json({ limit: '256kb' }));
  app.use(requestContext);
  app.use(pinoHttp({ logger, genReqId: (req) => (req as any).id ?? ulid() }));
  app.use(rateLimit);

  app.use('/healthz', healthRouter);

  const v1 = Router();
  for (const r of v1Routers) v1.use(r);
  app.use('/api/v1', v1);

  app.use((req, _res, next) => next(new AppError('not_found', 404, 'route not found')));
  app.use(errorHandler);

  return app;
}
```

`buildApp()` doesn't listen. `server.ts` wraps it:

```ts
import { buildApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';

const app = buildApp();
const server = app.listen(config.PORT, '0.0.0.0', () => {
  logger.info({ port: config.PORT }, 'api listening');
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    server.close();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  });
}
```

Tests use supertest:

```ts
import request from 'supertest';
import { buildApp } from '../src/app.js';

const res = await request(buildApp()).get('/healthz');
expect(res.status).toBe(200);
```

## Worker bootstrap (`src/worker.ts`)

Same shared `prisma` + `redis` singletons from `lib/`, no Express. Imports each worker file from `src/workers/*`, which calls `new Worker(queueName, process, { connection })`. Graceful shutdown waits for `Worker.close()` on `SIGTERM` / `SIGINT`.

```ts
import { registerProcessScreenshotWorker } from './workers/process-screenshot.js';
import { registerRetentionWorker } from './workers/retention.js';
import { registerReconcileOrphansWorker } from './workers/reconcile-orphans.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';

const workers = [
  registerProcessScreenshotWorker(),
  registerRetentionWorker(),
  registerReconcileOrphansWorker(),
];

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await Promise.all(workers.map((w) => w.close()));
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  });
}
```

## Error model (`src/lib/errors.ts`)

```ts
export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_input'
  | 'rate_limited'
  | 'internal';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
```

The `error-handler` middleware (4-arg signature `(err, req, res, next)`) maps:

- `AppError` → `{ error: { code, message, details? } }` with the carried status
- Zod `ZodError` → `AppError('invalid_input', 422, …)`
- Prisma known errors (e.g. `P2002` unique violation) → `AppError('conflict', 409, …)`
- Anything else → log at `error` + `AppError('internal', 500, …)`. Body never leaks the internal message.

This matches [docs/05-api-surface.md:10](../../docs/05-api-surface.md#L10) and the codes table at the bottom of [docs/05-api-surface.md](../../docs/05-api-surface.md).

## Prisma + Redis singletons

`src/lib/prisma.ts`:

```ts
import { PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient({ log: ['warn', 'error'] });
```

`src/lib/redis.ts`:

```ts
import { Redis } from 'ioredis';
import { config } from '../config/env.js';
export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
```

Both are imported by `server.ts`, `worker.ts`, middleware, and services. Test helper points at a separate Neon branch (URL set via `TEST_DATABASE_URL`); a `truncateAll()` helper runs in `beforeEach`.

## Idempotency middleware (sketch)

Applied per-route on mutating endpoints that need it (per [docs/05-api-surface.md:13](../../docs/05-api-surface.md#L13), all mutating _desktop_ endpoints require it):

1. Read `Idempotency-Key`. If absent on a configured route → 400.
2. `redis.get(key)` — if hit, replay the cached response (status + body).
3. Otherwise, monkey-patch `res.json` so that on send we store the response under `key` with a 24h TTL.

## Bearer-auth middleware (sketch — implementation in auth plan)

```ts
import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import type { TokenKind } from '@prisma/client';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function requireAuth(opts: { kinds?: TokenKind[] } = {}) {
  return async (req, _res, next) => {
    try {
      const header = req.get('authorization');
      if (!header?.startsWith('Bearer ')) {
        throw new AppError('unauthorized', 401, 'missing token');
      }
      const presented = header.slice(7);
      const tokenHash = sha256(presented);

      const token = await prisma.token.findUnique({
        where: { tokenHash },
        include: { user: true, device: true },
      });
      if (!token) throw new AppError('unauthorized', 401, 'invalid token');
      if (token.revokedAt) throw new AppError('unauthorized', 401, 'token revoked');
      if (token.expiresAt && token.expiresAt < new Date()) {
        throw new AppError('unauthorized', 401, 'token expired');
      }
      if (opts.kinds && !opts.kinds.includes(token.kind)) {
        throw new AppError('forbidden', 403, 'wrong token kind');
      }

      await slideTokenIfWeb(token); // debounced internally — only writes if lastUsedAt is stale

      req.caller = {
        user: token.user,
        token,
        device: token.device ?? undefined,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}
```

`slideTokenIfWeb` writes `lastUsedAt = now()` and (for `kind=web`) `expiresAt = now() + 30d`, but only when the existing `lastUsedAt` is more than ~5 minutes old. This keeps the slide cheap on busy clients without losing the 30-day rolling-window behavior.

## Logging

- pino, JSON in production, pretty in dev.
- Per-request child logger via `pino-http`; reqId is a ULID.
- Log scrubbing: never log `password`, `passwordHash`, `tokenHash`, raw `Authorization` header, raw bearer tokens, or request bodies on auth routes. A pino `redact` config enforces it.

## Testing harness

- **Vitest** for unit + integration.
- Integration tests run against a real Neon branch (URL in `TEST_DATABASE_URL`) and the dev Upstash Redis — no mocks of Prisma, matching the "trust but verify" stance. A `test/helpers/db.ts` truncates all tenant-scoped tables in `beforeEach`.
- `test/helpers/build-app.ts` returns a fresh `Express` app per test file; `supertest(app)` for assertions.
- Capability matrix has its own pure-function unit test file with a row per `(role, action, resource)` combination — the docs explicitly call this out as worth exhaustive testing.

## Health check (the only route this plan ships)

```ts
// src/modules/health/routes.ts
import { Router } from 'express';
export const healthRouter = Router();
healthRouter.get('/', async (_req, res) => {
  res.json({ ok: true, version: process.env.APP_VERSION ?? 'dev' });
});
```

This is the smoke test for the whole skeleton — once `/healthz` returns 200 in dev, in tests, and on the deployed serverless host, the foundation is real and feature plans can start filling modules.

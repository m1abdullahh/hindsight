# Backend — Directory Layout

```
apps/api/
├── prisma/
│   ├── schema.prisma            # datasource + generator only at first
│   └── migrations/              # populated by feature plans
├── src/
│   ├── server.ts                # API entrypoint: buildApp() + listen()
│   ├── worker.ts                # Worker entrypoint: boots BullMQ workers
│   ├── app.ts                   # buildApp(): Express — testable
│   ├── config/
│   │   └── env.ts               # Zod-validated env, exported as `config`
│   ├── middleware/
│   │   ├── request-context.ts   # req.id (ulid) + req.log (pino-http child)
│   │   ├── error-handler.ts     # last in chain; maps AppError → JSON envelope
│   │   ├── rate-limit.ts        # express-rate-limit + Redis store
│   │   ├── bearer-auth.ts       # requireAuth({kinds?}): resolves token
│   │   ├── org-scope.ts         # orgScope(): resolves :orgId membership
│   │   ├── validate.ts          # validate(schema, 'body'|'query'|'params')
│   │   ├── idempotency.ts       # Idempotency-Key header replay
│   │   └── async-handler.ts     # asyncHandler(fn) — promise → next(err)
│   ├── modules/                 # feature modules — one folder each
│   │   ├── health/
│   │   │   └── routes.ts
│   │   ├── auth/                # populated by auth plan
│   │   ├── orgs/
│   │   ├── invitations/
│   │   ├── projects/
│   │   ├── devices/
│   │   ├── time-entries/
│   │   ├── screenshots/
│   │   ├── reports/
│   │   └── audit/
│   ├── auth/                    # auth primitives (not Express-specific)
│   │   ├── tokens.ts            # mint/verify/slide/revoke; sha256 hashing
│   │   ├── password.ts          # argon2id wrapper
│   │   └── capabilities.ts      # can(membership, action, resource?)
│   ├── workers/                 # BullMQ workers (one file per queue)
│   │   ├── index.ts             # registers all workers, shared graceful shutdown
│   │   ├── process-screenshot.ts
│   │   ├── retention.ts
│   │   └── reconcile-orphans.ts
│   ├── lib/
│   │   ├── id.ts                # ulid()
│   │   ├── logger.ts            # pino instance
│   │   ├── errors.ts            # AppError + error codes
│   │   ├── prisma.ts            # PrismaClient singleton
│   │   ├── redis.ts             # ioredis singleton
│   │   └── r2.ts                # S3-compatible client + presign helpers
│   └── types/
│       └── express.d.ts         # module augmentation: Request.caller, etc.
├── test/
│   ├── helpers/
│   │   ├── build-app.ts         # wraps buildApp() with test config
│   │   └── db.ts                # truncate-between-tests helpers
│   └── *.test.ts
├── package.json
├── tsconfig.json
└── README.md                    # how to run dev, worker, tests
```

## Why two entrypoints (`server.ts` and `worker.ts`)

The API process and the worker process **share code, not lifecycle**. They both import `prisma`, `redis`, BullMQ queue definitions, and `config` — but they listen on different things:

- `server.ts` → HTTP on `PORT`
- `worker.ts` → BullMQ queues on Redis

This matches [docs/02-architecture.md:46-47](../../docs/02-architecture.md#L46-L47): _"Background workers, not request-time work."_ It also matches the README quick-start showing them as separate commands ([README.md:80-81](../../README.md#L80-L81)).

`buildApp()` in `app.ts` exists so tests can call it without binding a port.

## Why `auth/` is separate from `modules/auth/`

- `modules/auth/` = HTTP routes (`/auth/login`, `/auth/signup`, `/auth/logout`, `/auth/me`, …). Express-specific.
- `auth/` = primitives reused everywhere: token mint/verify/slide/revoke (sha256 hashing in this file), password hashing, the `can()` function. Pure functions, no Express import.

This split keeps `modules/auth` thin and lets `middleware/bearer-auth.ts` and other modules (`devices`, `screenshots`) call the primitives directly without circular deps.

## Why `lib/prisma.ts` and `lib/redis.ts` are shared singletons

Both `server.ts` and `worker.ts` import the same `prisma` and `redis` instances. One pool / one connection per process; both entrypoints close them on shutdown. There is no factory and no DI container — at the size of this codebase, an `import` _is_ the wiring.

## What `types/express.d.ts` declares

```ts
import 'express';
import type { User, Membership, Token, Device } from '@prisma/client';

declare module 'express-serve-static-core' {
  interface Request {
    id: string; // ulid, set by request-context middleware
    log: import('pino').Logger; // child logger with reqId
    caller?: {
      user: User;
      token: Token;
      device?: Device; // present when token.kind === 'device'
      membership?: Membership; // populated by orgScope middleware
    };
  }
}

export {};
```

Module augmentation lives in one place so handlers get typed `req.caller` for free.

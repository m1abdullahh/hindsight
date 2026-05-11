# @hindsight/api

Express + Prisma + BullMQ backend for Hindsight. See the source-of-truth docs in [`../../docs/`](../../docs/) and the structural plan in [`../../plans/01-backend-structure/`](../../plans/01-backend-structure/).

## Run locally

Prerequisites: Node 20+, pnpm 9+, a Neon Postgres project, and an Upstash Redis database.

```bash
# from repo root — fill DATABASE_URL (Neon) and REDIS_URL (Upstash)
cp .env.example apps/api/.env

# install deps (already done if you ran pnpm install at the root)
pnpm install

# generate the Prisma client and apply migrations to Neon
pnpm --filter @hindsight/api db:generate
pnpm --filter @hindsight/api db:migrate

# start the API on PORT (default 3001)
pnpm --filter @hindsight/api dev

# in another terminal, start the worker
pnpm --filter @hindsight/api worker
```

Smoke test once the API is up:

```bash
curl http://localhost:3001/healthz
# => {"ok":true,"version":"dev"}
```

## Tests

```bash
pnpm --filter @hindsight/api test
```

The healthz suite uses `supertest` against the in-process Express app — no Postgres/Redis needed for that one. Feature tests require a reachable test database; set `TEST_DATABASE_URL` to a dedicated Neon branch (e.g. `test`) and run `pnpm db:test:migrate` before `pnpm test`.

## Layout

See [`../../plans/01-backend-structure/layout.md`](../../plans/01-backend-structure/layout.md). At a glance:

- `src/app.ts` — `buildApp()` factory (testable; doesn't listen)
- `src/server.ts` — HTTP entrypoint
- `src/worker.ts` — BullMQ worker entrypoint
- `src/middleware/` — Express middleware factories
- `src/modules/<feature>/` — feature modules (routes / handlers / service / schemas)
- `src/lib/` — shared singletons (prisma, redis, logger) + helpers
- `src/auth/` — auth primitives (populated by the auth plan)
- `prisma/schema.prisma` — datasource + generator (models added by feature plans)

## What's NOT in this skeleton yet

- Any Prisma models — every feature plan adds its own
- Real auth — `requireAuth` and `orgScope` are stubs that 401/403 with "not implemented"
- Mutation routes — only `/healthz` exists
- Real worker bodies — `process-screenshot` is a no-op

The auth plan fills in the first two; subsequent feature plans fill the rest.

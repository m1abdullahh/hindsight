# Plan 01 — Backend Structure (`apps/api`)

> Roadmap milestones: spans **v0.1 → v0.4** ([docs/10-roadmap.md](../../docs/10-roadmap.md))
> Priority bucket: **P0–P3** (this plan covers the _structure_; feature plans fill modules)

## Goal

Decide and document the shape of `apps/api` once: directory layout, middleware order, module convention, config loading, worker process boundary, testing harness. Subsequent feature plans (auth, orgs, projects, screenshots, …) drop into this skeleton without re-arguing structure.

## Source-of-truth references

- Tech stack: [docs/03-tech-stack.md](../../docs/03-tech-stack.md)
- Architecture (one API for both clients, direct-to-R2 uploads, BullMQ workers): [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model (Prisma schema, including unified `tokens` table): [docs/04-data-model.md](../../docs/04-data-model.md)
- API surface (paths, bearer auth, errors): [docs/05-api-surface.md](../../docs/05-api-surface.md)
- Auth (token model, capability matrix): [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md)
- Pipeline (presign / confirm / process): [docs/07-screenshot-pipeline.md](../../docs/07-screenshot-pipeline.md)

## Decisions captured here (not implementation yet)

1. **Express 4 + TypeScript.** Boring, ubiquitous, team familiarity. Validation is added explicitly via Zod middleware; perf is fine at our scale. Matches [docs/03-tech-stack.md](../../docs/03-tech-stack.md).
2. **One Express app, one worker process.** Both live in `apps/api`. Two entrypoints, one shared codebase. Matches [docs/02-architecture.md:42-47](../../docs/02-architecture.md#L42-L47).
3. **Feature-module layout** under `src/modules/<feature>/`. Each module owns routes, schemas, handlers, service. No layered top-level folders (`controllers/`, `services/`) — that scatters one feature across many directories.
4. **Bearer tokens only**, opaque, sha256-hashed in the unified `tokens` table. No cookies, no JWT, no `SESSION_SECRET`. Web tokens slide on use (30-day expiry); device tokens have no expiry. See [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md).
5. **Validation:** Zod schemas live next to the module that owns them; shared input/output types re-export from `@hindsight/shared` so the web app imports them directly. A `validate(schema, source)` middleware factory wraps Zod parsing and produces consistent 422 errors.
6. **DB / Redis access:** `PrismaClient` and `Redis` singletons live in `src/lib/` and are imported by both the API and the worker entrypoints. There is no DI container — at this size the import graph _is_ the wiring.
7. **Tenant scoping:** an `orgScope()` middleware resolves `:orgId`, looks up the active membership, and attaches `req.caller.membership`. Handlers never re-check membership.
8. **Capability checks:** a single `can(membership, action, resource?)` function in `src/auth/capabilities.ts`, exhaustively unit-tested.
9. **Error model:** thrown `AppError(code, status, message, details?)` mapped to the JSON shape in [docs/05-api-surface.md:10](../../docs/05-api-surface.md#L10) by a single error-handling middleware (last in the chain).
10. **Testing:** Vitest. App factory (`buildApp()`) returns the Express `app` without listening; tests call it with `supertest`. Integration tests run against a separate **Neon test branch** (URL in `TEST_DATABASE_URL`) and the same Upstash Redis used in dev — no mocks of the DB.

## Out of scope for this plan

- Actual Prisma schema content — lives in feature plans (auth/orgs first)
- Concrete route handlers — feature plans
- Worker job implementations beyond a registered stub
- Deployment to a serverless host (Railway/Fly.io/Render), CI, secrets — separate P0 items

## Files in this plan

- [layout.md](./layout.md) — directory tree of `apps/api/src`
- [modules.md](./modules.md) — feature module convention and middleware order
- [bootstrap.md](./bootstrap.md) — server/worker entrypoints, config loading, error handling, testing harness

## Ordered execution checklist (the structural slice only)

1. `apps/api/package.json` — deps: `express`, `cors`, `helmet`, `compression`, `express-rate-limit`, `rate-limit-redis`, `zod`, `@prisma/client`, `prisma` (dev), `bullmq`, `ioredis`, `pino`, `pino-http`, `pino-pretty` (dev), `argon2`, `ulid`, `@types/express` (dev), `vitest` (dev), `supertest` (dev), `tsx` (dev). Scripts: `dev`, `build`, `test`, `typecheck`, `worker`, `db:migrate`, `db:studio`.
2. `apps/api/tsconfig.json` extends base; `outDir: dist`; includes `src` + `prisma`.
3. `prisma/schema.prisma` — datasource + generator only; models added by feature plans.
4. `src/config/env.ts` — Zod-validated env loader. **No `SESSION_SECRET`.**
5. `src/lib/{logger.ts,errors.ts,id.ts,prisma.ts,redis.ts}` — logger, error class, ULID helper, Prisma + Redis singletons.
6. `src/middleware/{request-context.ts,error-handler.ts,rate-limit.ts,bearer-auth.ts,org-scope.ts,validate.ts,idempotency.ts}` — middleware factories. `bearer-auth.ts` and `org-scope.ts` are stubs that throw "not implemented" until the auth plan lands.
7. `src/app.ts` — `buildApp(): Express` factory; registers middleware in the documented order; mounts module routers from a list.
8. `src/server.ts` — calls `buildApp()` and `app.listen()`.
9. `src/worker.ts` — boots BullMQ workers from the same config; registers `process-screenshot` as a no-op stub returning success.
10. `src/modules/health/routes.ts` — `GET /healthz` returning `{ ok: true, version }`. Smoke test for the whole skeleton.
11. `test/app.test.ts` — `buildApp()` + `supertest(app).get('/healthz')` returns 200.

## Done when

- `pnpm --filter @hindsight/api dev` boots and `/healthz` returns 200
- `pnpm --filter @hindsight/api worker` boots and idles cleanly
- `pnpm --filter @hindsight/api test` runs the healthz integration test green
- `pnpm --filter @hindsight/api typecheck` passes
- The skeleton is empty enough that a feature plan adds a module by creating _one_ directory under `src/modules/` and adding _one_ line to the router list — no other edits required

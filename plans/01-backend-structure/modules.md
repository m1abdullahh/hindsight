# Backend — Module Convention & Middleware Order

## Feature module shape

Every folder under `src/modules/<feature>/` follows the same four-file split:

```
modules/auth/
├── routes.ts      # creates an Express Router; binds middleware + handlers
├── schemas.ts     # Zod input + output schemas
├── handlers.ts    # thin: parse → call service → format response
└── service.ts     # business logic + Prisma calls; framework-agnostic
```

Optional fifth file `repository.ts` only when query logic outgrows the service. Default: don't create it.

### Why this split

- **routes.ts** is the only file that imports Express. Tests can call `service.ts` functions directly.
- **schemas.ts** is the contract. Re-exported through `@hindsight/shared` when the web app needs the same type.
- **handlers.ts** is glue. If a handler grows past ~30 lines it's doing service work — push it down.
- **service.ts** has no `req`/`res` references, so it can be unit-tested without Express.

### Conventions inside a module

- Errors: throw `AppError`; never return `{ error }` shapes from services. The error middleware translates them.
- Logging: `req.log.info({...})` in handlers; `logger.info(...)` in services (imported from `lib/logger`).
- Transactions: services own them. `prisma.$transaction(async (tx) => …)` — never split across handler/service boundary.
- `Idempotency-Key`: enforced by the `idempotency` middleware on routes that opt in (see [docs/05-api-surface.md:13](../../docs/05-api-surface.md#L13)). Module routes attach the middleware explicitly per route.
- `async` handlers wrap with the `asyncHandler(fn)` helper to keep error propagation consistent on Express 4.

## Module loading

`app.ts` mounts each module's router under `/api/v1` (except `health`, which is mounted at root):

```ts
const v1Routers = [
  authRouter,
  orgsRouter,
  invitationsRouter,
  projectsRouter,
  devicesRouter,
  timeEntriesRouter,
  screenshotsRouter,
  reportsRouter,
  auditRouter,
];
```

A new feature = drop a folder under `modules/`, add one line here. No other edits.

## Middleware registration order (in `app.ts`)

Order is **load-bearing** — middleware below depends on what's registered above.

| #   | Middleware                                         | Why it goes here                                                                                                        |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | `helmet()`                                         | Security headers as early as possible                                                                                   |
| 2   | `cors({ origin: WEB_ORIGIN, credentials: false })` | No cookies; tokens are sent in `Authorization` header                                                                   |
| 3   | `compression()`                                    | Compress JSON responses                                                                                                 |
| 4   | `express.json({ limit: '256kb' })`                 | All bodies are small JSON                                                                                               |
| 5   | `requestContext` (custom)                          | Sets `req.id` (ulid) + `req.log` before anything logs                                                                   |
| 6   | `pino-http`                                        | Per-request structured logs with reqId                                                                                  |
| 7   | `/healthz` router                                  | Mounted **before** rate-limit so uptime checks don't consume rate budget and smoke tests don't depend on Redis being up |
| 8   | `rate-limit` (Redis store)                         | Before auth so invalid tokens still cost rate budget                                                                    |
| 9   | `/api/v1` sub-router with module routers           | Each module router applies its own `requireAuth`, `orgScope`, `validate`, `idempotency` per route                       |
| 10  | 404 catch-all                                      | Throws `AppError('not_found', 404, …)`                                                                                  |
| 11  | `error-handler` (custom, 4-arg)                    | **Must be last.** Catches everything thrown via `next(err)`                                                             |

`requireAuth` is **not** global — public routes (`/auth/login`, `/auth/signup`, `/auth/invitations/accept`, `/healthz`) skip it. Each module router declares its protection explicitly.

## Auth surface exposed to modules

Three middleware factories live in `middleware/`:

- `requireAuth({ kinds?: TokenKind[] })` — resolves `Authorization: Bearer …`, attaches `req.caller.user` + `req.caller.token`. Optionally restricts to one token kind (e.g. `kinds: ['device']` on screenshot endpoints). Default: both kinds accepted.
- `orgScope()` — for any route with `:orgId`; runs _after_ `requireAuth`, looks up active membership, attaches `req.caller.membership`. 403 if no active membership.
- `requireDevice()` — convenience wrapper: `requireAuth({ kinds: ['device'] })` + asserts `req.caller.device` is present.

Capability checks happen _inside_ the handler (or service) using `can(membership, action, resource?)`. Per [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md), capability logic stays in one file — handlers don't write `if (role === 'admin') …` themselves.

## Example wiring (sketch — implementation belongs to the auth plan)

```ts
// modules/projects/routes.ts
import { Router } from 'express';
import { requireAuth, orgScope, validate, asyncHandler } from '../../middleware/index.js';
import { listProjects, createProject } from './handlers.js';
import { createProjectInput } from './schemas.js';

export const projectsRouter = Router();

projectsRouter.get('/orgs/:orgId/projects', requireAuth(), orgScope(), asyncHandler(listProjects));

projectsRouter.post(
  '/orgs/:orgId/projects',
  requireAuth(),
  orgScope(),
  validate(createProjectInput, 'body'),
  asyncHandler(createProject),
);
```

The handler then calls `can(req.caller!.membership!, 'projects:create')` and either proceeds or throws `AppError('forbidden', 403, …)`.

## Worker module convention

Workers mirror the module layout but live under `src/workers/`. Each file exports:

- A queue name constant
- A `Worker` instance bound to that queue
- A pure `process(job)` function that the worker delegates to (so it's testable without Redis)

Worker entrypoint (`worker.ts`) imports them all, wires graceful shutdown (drain in-flight jobs, close Redis + Prisma), and exits.

Queues used (from the docs):

- `process-screenshot` — thumbnail + optional blur ([docs/07-screenshot-pipeline.md:74-86](../../docs/07-screenshot-pipeline.md#L74-L86))
- `retention-sweep` — daily, hard-deletes per [docs/04-data-model.md:275-281](../../docs/04-data-model.md#L275-L281); also sweeps expired/revoked rows from the `tokens` table
- `reconcile-orphans` — weekly R2/DB reconcile ([docs/07-screenshot-pipeline.md:99-100](../../docs/07-screenshot-pipeline.md#L99-L100))

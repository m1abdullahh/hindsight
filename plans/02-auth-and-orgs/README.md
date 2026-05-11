# Plan 02 — Auth & Orgs

> Roadmap milestone: **v0.1 Foundations** ([docs/10-roadmap.md:5-17](../../docs/10-roadmap.md#L5-L17))
> Priority bucket: **P0–P1** (auth + first real domain)
>
> **Addendum (Plan 06):** added `PATCH /auth/me` (name only) and the `auth.profile_updated` audit action. See [`apps/api/src/modules/auth/`](../../apps/api/src/modules/auth/).

## Goal

Land real authentication, the User/Organization/Membership data model, the unified `tokens` table, the capability matrix, and the org-management endpoints. After this plan executes, the API has the bones of every later feature: tenant scoping, role-based authorization, and audit logging.

This plan replaces the auth stubs from [Plan 01](../01-backend-structure/), drops the bootstrap [SchemaProbe](../../apps/api/prisma/schema.prisma) model, and turns the empty `req.caller` types into real Prisma types.

## Source-of-truth references

- Identity model + token contract: [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md)
- Prisma schema (User, Organization, Membership, Token, AuditLog): [docs/04-data-model.md](../../docs/04-data-model.md)
- API surface (`/auth/*`, `/orgs/:orgId`, members endpoints): [docs/05-api-surface.md](../../docs/05-api-surface.md)
- Glossary (membership, role, web token, etc.): [docs/11-glossary.md](../../docs/11-glossary.md)
- Skeleton this plan fills: [plans/01-backend-structure/](../01-backend-structure/)

## Decisions captured here (not implementation yet)

1. **Tokens are 32 random bytes, base64url, sha256-hashed in the DB.** Plaintext shown to client once, never persisted plaintext anywhere. Confirms [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md).
2. **Web tokens slide on use; the slide is debounced.** We only write `lastUsedAt = now()` and `expiresAt = now() + 30d` when the existing `lastUsedAt` is older than ~5 minutes. Avoids a DB write on every authenticated request from a busy client.
3. **Device tokens never expire by time** — only by explicit revocation. Same `tokens` table, `kind = device`, `expiresAt = null`.
4. **Email uniqueness is case-insensitive at the application layer.** We `toLowerCase()` on insert and compare lowercased on lookup. Avoids the `citext` Postgres extension (not all hosts have it) without losing the property. Single `@unique` index on `email` is enough because we always store lowercase.
5. **Argon2id, tuned for ~250ms.** Default starting parameters: `memoryCost: 64 MiB, timeCost: 3, parallelism: 1`. The tuning script ships in this plan at [`apps/api/scripts/tune-argon2.ts`](../../apps/api/scripts/tune-argon2.ts) (run via `pnpm --filter @hindsight/api tune:argon2`); update [`apps/api/src/auth/password.ts`](../../apps/api/src/auth/password.ts) when prod hardware lands.
6. **Capability matrix is one pure file with a discriminated-union action type.** `apps/api/src/auth/capabilities.ts` exports `can(membership, action, resource?)` and a typed `Action` union. Every row in the matrix from [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md) gets a matching test case.
7. **Audit log writes happen inside the same transaction as the action they log.** No "fire-and-forget" audit. If the action rolls back, the audit row rolls back with it. This is the only way to keep the log coherent with reality.
8. **Last-owner protection is enforced inside a `SERIALIZABLE` transaction.** Count owners; abort if change would leave zero. Database-only constraints can't express "must always have at least one row matching X".
9. **`req.caller` types tighten to real Prisma types.** [express.d.ts](../../apps/api/src/types/express.d.ts) gains `User`, `Token`, `Membership`, `Device` imports — replacing the `unknown` placeholders.
10. **Tests run against a real Neon branch** (URL set via `TEST_DATABASE_URL`), not a mock. A `truncateAll()` helper resets state between tests.

## Out of scope for this plan (deferred to Plan 03 — Members & Invites)

- Invitations (`Invitation` model, `/auth/invitations/accept`, `/orgs/:orgId/invitations` CRUD)
- Email sending (Resend / Postmark integration)
- Email verification flow + `email_verified_at` writes
- Password reset
- HIBP k-anonymity check on signup
- Login throttling beyond the global rate limit
- "Sign out everywhere" button (one-line endpoint, but UX-coupled — defer)

## Files in this plan

- [schema.md](./schema.md) — Prisma additions, migration sequence, deletion of `SchemaProbe`
- [auth-primitives.md](./auth-primitives.md) — `tokens.ts`, `password.ts`, `capabilities.ts`
- [middleware.md](./middleware.md) — replacing the `bearer-auth` and `org-scope` stubs
- [modules.md](./modules.md) — `modules/auth/` and `modules/orgs/` routes, schemas, handlers, services
- [audit.md](./audit.md) — the audit-log helper and which actions write entries
- [testing.md](./testing.md) — capability matrix unit tests + auth/orgs integration tests with real DB

## Ordered execution checklist

1. **Schema migration.** Add `User`, `Organization`, `Membership`, `Token`, `AuditLog` models + `Role`, `MembershipStatus`, `TokenKind` enums. Drop `SchemaProbe`. `prisma migrate dev --name auth_and_orgs`.
2. **Tighten `express.d.ts`** to import the new Prisma types into `req.caller`.
3. **Auth primitives:** `src/auth/{tokens,password,capabilities}.ts` with full implementations + a small `lib/sha256.ts` helper.
4. **Replace middleware stubs:** `src/middleware/bearer-auth.ts` (real lookup + slide), `src/middleware/org-scope.ts` (real membership check).
5. **Audit helper:** `src/auth/audit.ts` — `writeAudit(tx, { orgId, actorId, action, target?, metadata? })`.
6. **Auth module:** `src/modules/auth/` — `routes.ts`, `schemas.ts`, `handlers.ts`, `service.ts`. Endpoints: `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
7. **Orgs module:** `src/modules/orgs/` — same shape. Endpoints: `GET /orgs/:orgId`, `PATCH /orgs/:orgId`, `GET /orgs/:orgId/members`, `PATCH /orgs/:orgId/members/:userId`, `DELETE /orgs/:orgId/members/:userId`.
8. **Wire routers** into `src/modules/index.ts` (`v1Routers` array).
9. **Tests:** capability matrix unit tests (one per `(role × action)` cell), auth integration tests, orgs integration tests with real Postgres + last-owner protection edge cases.
10. **Lint, typecheck, and test all green** before merging.

## Done when

- A user can `POST /auth/signup` and receive `{ user, organization, token, expiresAt }`.
- That token, sent as `Authorization: Bearer …`, satisfies `requireAuth()` and resolves `req.caller.user`.
- Owner can `GET /orgs/:orgId` and `PATCH /orgs/:orgId/members/:userId` to change another user's role; non-owner cannot.
- Removing the last owner of an org returns 409 instead of leaving the org orphaned.
- `pnpm --filter @hindsight/api test` passes the capability-matrix unit tests + at least one happy-path integration test for each of: signup, login, logout, me, get-org, list-members, change-role, remove-member.
- `req.caller` is typed as `{ user: User; token: Token; device?: Device; membership?: Membership }` everywhere.
- The `SchemaProbe` model is gone; the migration that removes it is committed.
- `pnpm typecheck` and `pnpm lint` pass against the whole workspace.

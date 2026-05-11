# Auth & Orgs — Prisma Schema

The canonical schema for these models lives in [docs/04-data-model.md](../../docs/04-data-model.md). This file describes how this plan adds them to [`apps/api/prisma/schema.prisma`](../../apps/api/prisma/schema.prisma) and how the migration sequences.

## Models added by this plan

- `User`
- `Organization`
- `Membership` (+ `Role` + `MembershipStatus` enums)
- `Token` (+ `TokenKind` enum) — replaces the bootstrap `SchemaProbe`
- `Device` — added now because `Token.deviceId` references it; the device-registration flow lands later in the desktop plan
- `AuditLog`

## Models intentionally **not** in this plan

- `Invitation` — Plan 03
- `Project`, `ProjectAssignment` — Plan 04
- `TimeEntry`, `Screenshot` — later plans

## Schema content

Copy the `User`, `Organization`, `Membership`, `Token`, `Device`, `AuditLog` definitions, the `Role` / `MembershipStatus` / `TokenKind` enums, and the indexes verbatim from [docs/04-data-model.md](../../docs/04-data-model.md). Drop the `Project` and `Invitation` references inside `Organization` and `User` for now (they land in their own plans):

In `Organization`:

- Keep: `memberships`, `auditLogs`
- Remove for now: `invitations`, `projects` (re-added by their plans)

In `User`:

- Keep: `memberships`, `tokens`, `devices`
- Remove for now: `assignments`, `timeEntries`

In `Device`:

- Keep: `user`, `token` (1:1 reverse)
- Remove for now: `timeEntries`

The plan-by-plan additive growth keeps each migration small and reversible.

## Migration sequence

One Prisma migration: `prisma migrate dev --name auth_and_orgs`.

Migration body in plain SQL (Prisma generates this from the model diff; included here as the conceptual sequence):

1. `CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'member');`
2. `CREATE TYPE "MembershipStatus" AS ENUM ('active', 'suspended');`
3. `CREATE TYPE "TokenKind" AS ENUM ('web', 'device');`
4. `CREATE TABLE users (...)`
5. `CREATE TABLE organizations (...)`
6. `CREATE TABLE memberships (...)` with the `(org_id, user_id)` unique index
7. `CREATE TABLE devices (...)`
8. `CREATE TABLE tokens (...)` with indexes on `user_id`, `(kind, revoked_at)`, and the unique `device_id` partial constraint
9. `CREATE TABLE audit_logs (...)` with the `(org_id, created_at)` index
10. `DROP TABLE _schema_probe;`

Ordering matters because of foreign-key dependencies: enums first, then `users`, then anything that references it.

## Email normalization

Application-layer rule: every write to `users.email` lowercases the input. Every lookup also lowercases the comparand. The `email String @unique` constraint then doubles as a case-insensitive uniqueness guarantee without needing the `citext` Postgres extension.

This is a convention, not a DB feature, so it's enforced in `auth/service.ts` — never bypass it by writing raw SQL.

## Bootstrap probe deletion

Remove the `SchemaProbe` model from `schema.prisma` as part of the same migration. Prisma's diff will emit `DROP TABLE _schema_probe;`. Verify the generated migration file contains both the new tables AND the drop before applying.

## What gets committed

- `apps/api/prisma/schema.prisma` (updated)
- `apps/api/prisma/migrations/<timestamp>_auth_and_orgs/migration.sql`
- `apps/api/prisma/migrations/migration_lock.toml` (if not already present)

## Things to double-check before applying

- The unique index on `tokens.device_id` is `@unique` (one-active-token-per-device); revoked rows are filtered out at the application layer when issuing a new token.
- `audit_logs.actor_id` is nullable (system actions written by background jobs have no human actor).
- `users.password_hash` is nullable (rows created via invitation-accept-with-no-password-yet are valid; that branch lands in Plan 03 but the schema accommodates it now).
- `users.email_verified_at` is nullable; population happens in Plan 03.

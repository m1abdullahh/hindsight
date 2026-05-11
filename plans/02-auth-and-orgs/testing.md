# Auth & Orgs — Testing

Two layers of tests this plan ships:

1. **Capability matrix unit tests** — pure, no DB
2. **Integration tests** for auth and orgs flows — real Postgres, real bearer auth

## Test database

Tests run against a dedicated **Neon branch** (e.g. one named `test`), kept separate from the dev branch so `truncateAll()` cannot wipe your working data. Set `TEST_DATABASE_URL` to that branch's connection string. `test/helpers/build-app.ts` swaps it into `process.env` before booting the app:

```ts
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL'] ??
  (() => {
    throw new Error('TEST_DATABASE_URL is required for integration tests');
  })();
process.env['NODE_ENV'] = 'test';
```

Plan 02 adds:

1. A `db:test:migrate` script: `cross-env DATABASE_URL=$TEST_DATABASE_URL prisma migrate deploy` — applies migrations to the test branch.
2. The `truncateAll()` helper from [Plan 01](../01-backend-structure/) gets populated:
   ```ts
   const TABLES = ['audit_logs', 'tokens', 'memberships', 'devices', 'organizations', 'users'];
   ```
   Order matters because of foreign keys.
3. Vitest `globalSetup` runs `prisma migrate deploy` once against `TEST_DATABASE_URL`; per-test `beforeEach` calls `truncateAll()`.

## Capability matrix tests (`apps/api/src/auth/capabilities.test.ts`)

One pure file, no DB. Iterates through every `(role, action)` pair from [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md) capability table.

```ts
import { describe, it, expect } from 'vitest';
import { can, type Action } from './capabilities.js';

const member = (role: 'owner' | 'admin' | 'member') =>
  ({
    id: 'm',
    orgId: 'o',
    userId: 'u',
    role,
    status: 'active',
    createdAt: new Date(),
  }) as const;

const cases: Array<{ role: 'owner' | 'admin' | 'member'; action: Action; expect: boolean }> = [
  { role: 'owner', action: { type: 'org:manage' }, expect: true },
  { role: 'admin', action: { type: 'org:manage' }, expect: false },
  { role: 'member', action: { type: 'org:manage' }, expect: false },
  // … one row for every cell of the matrix in docs/08
];

describe('capability matrix', () => {
  for (const c of cases) {
    it(`${c.role} ${c.action.type} → ${c.expect}`, () => {
      expect(can(member(c.role), c.action)).toBe(c.expect);
    });
  }
});
```

The matrix has ~13 rows × 3 roles ≈ 40 cases. Cheap to run, catches refactor regressions instantly. Roles introduced later (e.g. a hypothetical `viewer`) get added here as a new column.

## Integration tests (`apps/api/test/auth.test.ts`, `orgs.test.ts`)

Each test file uses `supertest(buildApp())`. Real DB, real bcrypt-equivalent (argon2) hashing, real token round-trip.

### `auth.test.ts`

Happy paths:

- Signup creates user + org + membership, returns token, the token authenticates `/auth/me`.
- Login with correct password returns a token; wrong password returns 401.
- Logout revokes the calling token; subsequent `/auth/me` with the same token returns 401.

Edge cases:

- Signup with duplicate email returns 409.
- Signup normalizes email to lowercase; subsequent login with mixed-case email succeeds.
- Login with a non-existent email returns 401 (not 404 — don't leak existence).
- `/auth/me` without `Authorization` header returns 401.
- Expired token — manually update `expiresAt` to past, expect 401 on next request.
- Slide-on-use — call `/auth/me` twice with `lastUsedAt` already recent, second call should NOT update `lastUsedAt` (debounce).

### `orgs.test.ts`

Setup helper that signs up two users in the same org (one owner, one member) and returns their tokens.

- `GET /orgs/:orgId` returns the org for any active member; 403 for non-member.
- `PATCH /orgs/:orgId` allowed for owner, 403 for member.
- `GET /orgs/:orgId/members` returns the list for any active member.
- `PATCH /orgs/:orgId/members/:userId` — owner can change member role; member can't change anyone.
- Last-owner protection: try to demote the only owner → 409. Add a second owner; demoting the first now succeeds.
- `DELETE /orgs/:orgId/members/:userId` — admin removing a member works; member removing self works _unless_ they're the last owner; the last-owner-removes-self path returns 409.
- Cross-org isolation: user A in org A, user B in org B. A's token cannot read B's org (403).

### Audit assertions

Each integration test that performs a privileged action also queries `audit_logs` and asserts the row exists with the expected `action` and `actorId`. This catches "the action ran but we forgot the audit" regressions.

## Skip criteria

- Integration tests get a `describe.skipIf(!isDbReachable)` guard so a developer with no `TEST_DATABASE_URL` configured can still run capability-matrix tests via `pnpm --filter @hindsight/api vitest capabilities`.
- CI runs the full suite with `TEST_DATABASE_URL` set to a CI-only Neon branch.

## Coverage target

Not chasing a number for Plan 02. The aim is **at least one happy-path test per endpoint** plus the listed edge cases. Coverage thresholds get added later when we have a baseline.

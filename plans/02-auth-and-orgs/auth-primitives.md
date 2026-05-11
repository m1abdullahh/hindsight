# Auth & Orgs — Auth Primitives

Three pure files under [`apps/api/src/auth/`](../../apps/api/src/auth/), each with no Express imports. They're the building blocks the auth module and the bearer-auth middleware compose.

## `auth/password.ts` — Argon2id wrapper

```ts
import argon2 from 'argon2';

const PARAMS = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, PARAMS);

export const verifyPassword = async (hash: string, plain: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
};
```

- `verify` swallows malformed-hash errors so callers always get a boolean. Logging happens at the call site if needed.
- Tuning targets ~250ms on the deploy host's hardware ([docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md)). The tuning script ships at [`apps/api/scripts/tune-argon2.ts`](../../apps/api/scripts/tune-argon2.ts) — `pnpm --filter @hindsight/api tune:argon2` runs a parameter sweep on the current host and prints recommended values. Update the constants in `password.ts` if numbers drift from the targets.

## `auth/tokens.ts` — Mint, verify, slide, revoke

Token format: 32 random bytes, base64url-encoded plaintext (43 chars, URL-safe). Stored as `sha256(plaintext)` hex (64 chars).

```ts
import { randomBytes, createHash } from 'node:crypto';
import { TokenKind, type Token } from '@prisma/client';

import { prisma } from '../lib/prisma.js';
import { ulid } from '../lib/id.js';

const WEB_TTL_DAYS = 30;
const SLIDE_DEBOUNCE_MS = 5 * 60 * 1000; // only slide if lastUsedAt is older than 5 min

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const generatePlaintext = (): string => randomBytes(32).toString('base64url');

interface MintOptions {
  userId: string;
  kind: TokenKind;
  deviceId?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface MintedToken {
  plaintext: string; // returned to client ONCE
  token: Token; // DB row
  expiresAt: Date | null;
}

export async function mintToken(opts: MintOptions): Promise<MintedToken> {
  const plaintext = generatePlaintext();
  const tokenHash = sha256(plaintext);
  const now = new Date();
  const expiresAt =
    opts.kind === 'web' ? new Date(now.getTime() + WEB_TTL_DAYS * 86_400_000) : null;

  const token = await prisma.token.create({
    data: {
      id: ulid(),
      userId: opts.userId,
      kind: opts.kind,
      tokenHash,
      deviceId: opts.deviceId ?? null,
      expiresAt,
      userAgent: opts.userAgent ?? null,
      ipAddress: opts.ipAddress ?? null,
    },
  });

  return { plaintext, token, expiresAt };
}

export async function verifyAndSlide(
  presented: string,
): Promise<{ token: Token; sliding: boolean }> {
  const tokenHash = sha256(presented);
  const token = await prisma.token.findUnique({ where: { tokenHash } });

  if (!token) throw invalid('invalid token');
  if (token.revokedAt) throw invalid('token revoked');
  if (token.expiresAt && token.expiresAt < new Date()) throw invalid('token expired');

  // Debounced slide: only update DB if last-used is stale.
  const stale = !token.lastUsedAt || token.lastUsedAt.getTime() < Date.now() - SLIDE_DEBOUNCE_MS;

  if (!stale) return { token, sliding: false };

  const next = await prisma.token.update({
    where: { id: token.id },
    data: {
      lastUsedAt: new Date(),
      ...(token.kind === 'web'
        ? { expiresAt: new Date(Date.now() + WEB_TTL_DAYS * 86_400_000) }
        : {}),
    },
  });
  return { token: next, sliding: true };
}

export const revokeToken = (id: string): Promise<unknown> =>
  prisma.token.update({ where: { id }, data: { revokedAt: new Date() } });

export const revokeAllForUser = (userId: string, kind?: TokenKind): Promise<unknown> =>
  prisma.token.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(kind ? { kind } : {}),
    },
    data: { revokedAt: new Date() },
  });
```

The `invalid()` helper throws `AppError('unauthorized', 401, …)` so the bearer-auth middleware can pass it straight to `next(err)`.

## `auth/capabilities.ts` — The matrix

One file. Discriminated-union `Action` so every call site is statically checked against the known set. Resource checks for assignments and ownership accept the resource as a second argument.

```ts
import type { Membership, Project, Screenshot, TimeEntry } from '@prisma/client';

export type Action =
  | { type: 'org:manage' }
  | { type: 'org:delete' }
  | { type: 'members:invite' }
  | { type: 'members:remove' }
  | { type: 'members:change_role' }
  | { type: 'projects:create' }
  | { type: 'projects:read'; project: Pick<Project, 'orgId' | 'id'> }
  | { type: 'time_entries:read_all' }
  | { type: 'screenshots:read'; screenshot: Pick<Screenshot, 'timeEntryId'>; ownerUserId: string }
  | {
      type: 'screenshots:delete';
      screenshot: Pick<Screenshot, 'id' | 'createdAt'>;
      ownerUserId: string;
    }
  | { type: 'audit:read' }
  | { type: 'devices:register' };

export const can = (m: Membership, action: Action): boolean => {
  switch (action.type) {
    case 'org:manage':
    case 'org:delete':
      return m.role === 'owner';

    case 'members:invite':
    case 'members:change_role':
    case 'members:remove':
    case 'projects:create':
    case 'time_entries:read_all':
    case 'audit:read':
      return m.role === 'owner' || m.role === 'admin';

    // Pseudocode for resource-scoped checks. Plan 04 wires the project / screenshot
    // resources; for Plan 02 only the role-only actions above are used.
    case 'projects:read':
      return m.role !== 'member' || /* assigned check happens in service layer */ false;

    case 'screenshots:read':
    case 'screenshots:delete':
      return m.role !== 'member' || m.userId === action.ownerUserId;

    case 'devices:register':
      return true; // any active member can register their own device
  }
};
```

The matrix is exhaustively unit-tested. See [testing.md](./testing.md).

> **Note:** `projects:read` and the screenshot actions are sketched here so the type union is complete, but they aren't _exercised_ until later plans add the projects/screenshots routes. The unit tests for those rows live alongside their feature plans.

## What this plan ships out of `auth/`

- `auth/password.ts`
- `auth/tokens.ts`
- `auth/capabilities.ts` (full matrix in the union; only the role-only branches are wired)
- `auth/audit.ts` — see [audit.md](./audit.md)
- `scripts/tune-argon2.ts` — parameter sweep helper, run via `pnpm --filter @hindsight/api tune:argon2`

## What lives elsewhere

- The bearer-auth Express middleware that calls `verifyAndSlide`: [`apps/api/src/middleware/bearer-auth.ts`](../../apps/api/src/middleware/bearer-auth.ts) — see [middleware.md](./middleware.md).
- The HTTP routes that mint tokens: [`apps/api/src/modules/auth/`](../../apps/api/src/modules/auth/) — see [modules.md](./modules.md).

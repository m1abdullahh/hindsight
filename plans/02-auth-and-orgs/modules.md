# Auth & Orgs — HTTP Modules

Two new feature modules. Both follow the four-file convention from [plans/01-backend-structure/modules.md](../01-backend-structure/modules.md): `routes.ts` / `schemas.ts` / `handlers.ts` / `service.ts`.

## `modules/auth/`

### Schemas (`auth/schemas.ts`)

```ts
import { z } from 'zod';

const Email = z.string().trim().toLowerCase().email();
const Password = z.string().min(12).max(128);
const Name = z.string().trim().min(1).max(100);
const OrgName = z.string().trim().min(1).max(100);

export const signupInput = z.object({
  email: Email,
  password: Password,
  name: Name,
  organizationName: OrgName,
});

export const loginInput = z.object({
  email: Email,
  password: Password,
});

// Output schemas exported via @hindsight/shared so the web app shares them.
export const authSuccess = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  token: z.string(),
  expiresAt: z.date().nullable(),
});
```

### Routes (`auth/routes.ts`)

```ts
POST   /auth/signup    public                — body: signupInput    → authSuccess + organization
POST   /auth/login     public                — body: loginInput     → authSuccess + memberships
POST   /auth/logout    requireAuth()         — body: empty          → 204
GET    /auth/me        requireAuth()         — body: empty          → { user, memberships }
```

### Service (`auth/service.ts`)

Each function is a pure async function returning DTOs. Service signatures:

- `signup({ email, password, name, organizationName, ip?, ua? })` →
  - Lowercase the email.
  - In one transaction: insert `User`, insert `Organization` (slug from a slugified name + ULID suffix to avoid collisions), insert `Membership` (role=owner), mint a web `Token`. Write `auth.signup` audit row.
  - Return `{ user, organization, token: plaintext, expiresAt }`.
- `login({ email, password, ip?, ua? })` →
  - Lowercase email, look up user, `verifyPassword`, mint web token, return.
  - On miss: identical timing as a successful path-up-to-verify (use a dummy hash if user not found). Return 401 with `unauthorized`/`invalid credentials`.
- `logout({ tokenId })` →
  - Single update: `revokeToken(tokenId)`. Audit `auth.logout`.
- `me({ userId })` →
  - Return `{ user, memberships }` (memberships join `organizations`).

### Handlers (`auth/handlers.ts`)

Thin: pull validated body / `req.caller`, call service, set status, send JSON. `signup` and `login` set `201` and `200` respectively. `logout` sets `204` and sends no body.

## `modules/orgs/`

### Schemas (`orgs/schemas.ts`)

```ts
import { z } from 'zod';

export const updateOrgInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

export const updateMemberInput = z.object({
  role: z.enum(['owner', 'admin', 'member']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});
```

### Routes (`orgs/routes.ts`)

```ts
GET    /orgs/:orgId                          requireAuth() + orgScope()
PATCH  /orgs/:orgId                          requireAuth() + orgScope()    body: updateOrgInput
GET    /orgs/:orgId/members                  requireAuth() + orgScope()
PATCH  /orgs/:orgId/members/:userId          requireAuth() + orgScope()    body: updateMemberInput
DELETE /orgs/:orgId/members/:userId          requireAuth() + orgScope()
```

### Service (`orgs/service.ts`)

- `getOrg(orgId)` → returns the org row. Caller has already proven membership via `orgScope`.
- `updateOrg(orgId, patch, actor)` → asserts `can(actor.membership, { type: 'org:manage' })`. Update + audit `org.updated`.
- `listMembers(orgId)` → returns members with embedded user data, sorted by created_at.
- `updateMember(orgId, targetUserId, patch, actor)` →
  - Inside a `SERIALIZABLE` transaction:
    1. `can(actor.membership, { type: 'members:change_role' })` for role changes; admins cannot promote/demote owners.
    2. If the patch demotes the only remaining owner → throw `AppError('conflict', 409, 'cannot leave org without an owner')`.
    3. Apply the update.
    4. Audit `member.role_changed` or `member.status_changed`.
- `removeMember(orgId, targetUserId, actor)` →
  - Same `SERIALIZABLE` envelope:
    1. `can(actor.membership, { type: 'members:remove' })`. Admins can't remove owners.
    2. Cannot remove the last owner.
    3. Cannot remove yourself if you're the last owner. (Even owners follow this rule — leaving requires nominating a replacement first.)
    4. Soft-delete or hard-delete? **Hard-delete the membership row.** Tokens issued to the user keep working for _other_ orgs they belong to; the user record is untouched.
    5. Revoke any device tokens that referenced this user _only inside this org_? No — devices are per-user, not per-org. Token revocation on member removal is a Plan 03+ "sign-out-everywhere" story.
    6. Audit `member.removed`.

### Handlers (`orgs/handlers.ts`)

Standard thin shape. Each handler runs `can(...)` first, then calls into the service. Service layer owns transactions; handlers don't.

## Wiring

`apps/api/src/modules/index.ts` becomes:

```ts
import type { Router } from 'express';
import { authRouter } from './auth/routes.js';
import { orgsRouter } from './orgs/routes.js';

export const v1Routers: Router[] = [authRouter, orgsRouter];
```

This is the only file that changes outside the new modules — confirms the "one folder + one line" promise from [Plan 01](../01-backend-structure/README.md).

## Response shapes (DTOs)

We don't return raw Prisma rows. Each module exports a small mapping function (e.g. `toUserDto`, `toMembershipDto`) that strips internal fields like `passwordHash`, `tokenHash`, `deletedAt`, and reshapes dates to ISO strings. These DTOs are also re-exported from `@hindsight/shared` so the web app types its API responses against them.

The shape rule: **never let a Prisma row leave the API process.** Always go through a DTO map.

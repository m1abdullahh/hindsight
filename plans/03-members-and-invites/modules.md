# Members & Invites — HTTP Modules

This plan adds one new module (`invitations/`) and extends the existing `auth/` module with email-verify, password-reset, password-change, and sign-out-everywhere endpoints. Same four-file convention from [plans/01-backend-structure/modules.md](../01-backend-structure/modules.md).

## `modules/invitations/`

### Schemas (`invitations/schemas.ts`)

```ts
import { z } from 'zod';

const Email = z.string().trim().toLowerCase().email();
const Role = z.enum(['admin', 'member']); // Owner cannot be invited; only existing owners can promote.

export const createInviteInput = z.object({
  email: Email,
  role: Role,
});

export const acceptInviteInput = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(128).optional(), // required only when the email isn't already a User
  name: z.string().trim().min(1).max(100).optional(),
});
```

### Routes (`invitations/routes.ts`)

```ts
POST   /orgs/:orgId/invitations              requireAuth() + orgScope()    body: createInviteInput
GET    /orgs/:orgId/invitations              requireAuth() + orgScope()
DELETE /orgs/:orgId/invitations/:invitationId requireAuth() + orgScope()
POST   /auth/invitations/accept              public                         body: acceptInviteInput
```

The accept route lives under `/auth/...` (not `/orgs/...`) because the caller has no org context yet — the token _grants_ it.

### Service (`invitations/service.ts`)

- `createInvite(orgId, actor, input)`
  - `can(actor.membership, { type: 'members:invite' })` → 403 otherwise.
  - **Reject** if there's already a pending (un-accepted, un-revoked, un-expired) invite for `(orgId, email)` → 409.
  - **Reject** if the email already has an active membership in this org → 409 (use the members endpoint).
  - In one transaction: mint a 32-byte plaintext, hash it, `INSERT` invitation, write `member.invited` audit. Commit.
  - Outside the transaction: render the invitation template, call `sendMail`. Catch `mail_unavailable` / `mail_send_failed` and pass through to the response as `{ invitation, mailed: false, mailError }`.

- `listInvites(orgId)` → all invitations for the org with `acceptedAt = null AND revokedAt = null AND expiresAt > now()`. DTO strips `tokenHash`.

- `revokeInvite(orgId, invitationId, actor)`
  - `can(actor.membership, { type: 'members:invite' })`. (Same capability — anyone who can invite can cancel.)
  - Set `revokedAt = now()`. Audit `member.invitation_revoked` (new audit action — add to the union).

- `acceptInvite({ token, password?, name? }, ctx)`
  - Hash the presented token, look up the invitation row.
  - Reject (404 generic) if: not found, accepted, revoked, expired.
  - In a SERIALIZABLE transaction:
    1. Find an existing user by `invitation.email`.
       - If found and `passwordHash` is null and the body has no password → require password (400).
       - If found and password supplied → reject; setting a password on an existing account isn't this endpoint's job (use the password-reset flow).
       - If not found → require both `password` and `name` (400 otherwise). HIBP-check the password (see [security.md](./security.md)). Run `hashPassword`. Insert the user with `email_verified_at = now()` and the hash.
    2. Insert membership `(invitation.orgId, user.id, invitation.role, status='active')`.
    3. Stamp `invitation.acceptedAt = now()`, `acceptedBy = user.id`.
    4. Mint a `web` token for the user.
    5. Audit `member.joined` (and `auth.signup` if a new user was created).
  - Return `{ user, organization, token, expiresAt, memberships }`.

### Handlers (`invitations/handlers.ts`)

Thin glue: pull validated body, pull `req.caller` where applicable, call service, send JSON. The accept handler explicitly does **not** require auth — `requireAuth` is absent from its route.

## `modules/auth/` — extensions

### New schemas (`auth/schemas.ts` additions)

```ts
export const verifyEmailInput = z.object({ token: z.string().min(20).max(200) });

export const resendVerificationInput = z.object({ email: Email });

export const forgotPasswordInput = z.object({ email: Email });

export const resetPasswordInput = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(128),
});

export const changePasswordInput = z.object({
  currentPassword: z.string().min(12).max(128),
  newPassword: z.string().min(12).max(128),
});

export const signOutEverywhereInput = z.object({
  keepCurrent: z.boolean().default(true),
});
```

### New routes (`auth/routes.ts` additions)

```ts
POST   /auth/email/verify                    public                  body: verifyEmailInput
POST   /auth/email/resend-verification       public (rate-limited)   body: resendVerificationInput
POST   /auth/password/forgot                 public (rate-limited)   body: forgotPasswordInput
POST   /auth/password/reset                  public                  body: resetPasswordInput
POST   /auth/password/change                 requireAuth()           body: changePasswordInput
POST   /auth/sign-out-everywhere             requireAuth()           body: signOutEverywhereInput
```

The two `(rate-limited)` annotations point at the existing global rate limiter from Plan 01 plus the per-email throttle from [security.md](./security.md). Verify and forgot are public because the caller is by definition not authenticated yet.

### Service additions (`auth/service.ts`)

- `verifyEmail(token)`
  - Hash, look up the `email_verify` token, reject if missing/expired/revoked.
  - In one tx: set `user.email_verified_at = now()`, revoke the token (`revokedAt = now()`), audit `auth.email_verified`. Idempotent — verifying an already-verified account returns 200 with the existing timestamp; we still revoke the token.

- `resendVerification(email)`
  - Always return 204. (Anti-enumeration — never confirm whether the email is a known user.)
  - If the email matches a real user with `email_verified_at = null`, mint a fresh `email_verify` token (24h) and `sendMail`. Otherwise no-op.

- `forgotPassword(email)`
  - Always return 204. Same anti-enumeration rule.
  - If the email matches a user, mint a `password_reset` token (60min), audit `auth.password_reset_requested` (new audit action), `sendMail`.

- `resetPassword({ token, password })`
  - Hash, look up `password_reset` token, reject generic 404/401 if not found/expired/revoked.
  - HIBP-check the new password (fail with `422` if known-pwned).
  - In one tx: hash the new password, write `user.passwordHash`, revoke the reset token, **call `signOutEverywhere(userId, { keepCurrent: false })`** (no current token in this flow, so all tokens go), audit `auth.password_changed`.
  - Mint a fresh `web` token and return `{ user, token, expiresAt }` so the user is logged in immediately.

- `changePassword({ currentPassword, newPassword }, caller)`
  - `verifyPassword(user.passwordHash, currentPassword)` → 401 generic if wrong.
  - HIBP-check the new password.
  - In one tx: write the new hash, **call `signOutEverywhere(userId, { keepCurrent: true })`** so other tokens are wiped, audit `auth.password_changed`.
  - Return 204; current token still valid.

- `signOutEverywhere(userId, { keepCurrent })`
  - `revokeAllForUser(userId)` from [`auth/tokens.ts`](../../apps/api/src/auth/tokens.ts), with an optional `excludeId` parameter so the current token survives when `keepCurrent: true`.
  - Audit `auth.signed_out_everywhere`.

### Handlers

Thin. `verifyEmail` and `acceptInvite` are the only public POST routes that take a token in the body; the rest follow the standard pattern from Plan 02.

## Wiring

`apps/api/src/modules/index.ts`:

```ts
import { authRouter } from './auth/routes.js';
import { orgsRouter } from './orgs/routes.js';
import { invitationsRouter } from './invitations/routes.js'; // NEW

export const v1Routers: Router[] = [authRouter, orgsRouter, invitationsRouter];
```

One added line — confirms the "one folder + one line" promise once again.

## DTO additions

- `toInvitationDto(row)` — strips `tokenHash`. Includes `expiresAt`, `acceptedAt`, `revokedAt`, the inviter's name (joined).
- The invitation accept response reuses `toUserDto`, `toOrganizationDto`, `toMembershipDto` from Plan 02.

## Capability matrix additions

Add to the `Action` union in [`auth/capabilities.ts`](../../apps/api/src/auth/capabilities.ts):

```ts
| { type: 'members:invite' }       // already in the union from Plan 02
| { type: 'invitations:revoke' }   // alias used inside the service for clarity
```

`members:invite` is **the same** as `invitations:revoke` for the role check (owner + admin). We don't need a new branch in `can()` — both map to the same role check. Adding `invitations:revoke` to the union is bookkeeping, not new permissions.

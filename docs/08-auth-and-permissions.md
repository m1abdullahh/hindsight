# 08 — Auth & Permissions

## Identity model

- **One user, many memberships.** The `users` table is global. A `users.email` is unique across the entire system. To exist in an organization a user must have a row in `memberships`.
- **Role lives on the membership, not the user.** A user can be `owner` in their own org and `member` in someone else's. The role is *always* resolved with respect to a specific org.
- **No "super admin."** There is no platform-level role. Operators access data via DB tooling, not the application UI.

## Sessions (web)

- Created on login or signup. Stored in Postgres `sessions` table; cached in Redis for hot lookups.
- Cookie: `session=<id>`, `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day rolling expiry.
- Sliding window: each successful authenticated request bumps `expiresAt` by 30 days.
- Logout deletes the row.
- Password change revokes all sessions for that user.

## Device tokens (desktop)

- Issued by `POST /devices/register` after a normal web login. The login establishes the session; the desktop client trades it for a long-lived device token.
- Token format: 32 random bytes, base64url. Stored as `tokenHash` (sha-256) in the DB; the plaintext is shown to the client **once**.
- No expiry by default. Revocation is explicit:
  - User clicks "Sign out this device" in settings → `DELETE /devices/:id`.
  - Admin clicks "Revoke device" on a member.
  - Password change does NOT auto-revoke device tokens (they're for trusted machines). This is a deliberate trade-off; document it.
- Device tokens scope to a single user but **can be used to act in any org that user is a member of**, just like a session.

## Authentication flow

### Sign up
1. `POST /auth/signup` with `{ email, password, name, organizationName }`.
2. Server checks email is not in use, creates `user`, `organization`, `membership` (owner) in a single transaction.
3. Sends email verification link (gates certain actions until verified).
4. Creates session, sets cookie, returns `{ user, organization }`.

### Login
1. `POST /auth/login` with `{ email, password }`.
2. Server verifies password (Argon2id).
3. Creates session, sets cookie.
4. Returns `{ user, memberships }` so the UI can route them into their default org.

### Invitation acceptance
1. Recipient clicks a link with a token: `https://app.example.com/invitations/accept?token=...`
2. Frontend calls `POST /auth/invitations/accept`.
3. Server hashes token, finds invitation, verifies not expired/accepted.
4. Three branches:
   - Logged in as a user with the invited email → just create the membership.
   - Logged in as a different user → 409, "this invite was for X@…, log out first".
   - Not logged in, account exists for that email → require password to proceed.
   - Not logged in, no account → require password + name; create user, then membership.
5. Mark invitation `acceptedAt`. Return updated memberships.

## Authorization

Two layers:

### Layer 1: Org membership gate (middleware)

Every route with `:orgId` runs this middleware:
1. Resolve caller (session or device token).
2. Look up `membership(orgId, userId, status='active')`. If missing → 403.
3. Attach `{ user, membership }` to the request context.

Handlers below this can rely on caller belonging to the org.

### Layer 2: Capability check (handler-level)

A small function `can(membership, action, resource?)` returns boolean. Examples:

```ts
can(m, 'org:manage')           // owner only
can(m, 'members:invite')       // owner | admin
can(m, 'projects:create')      // owner | admin
can(m, 'projects:read', p)     // owner | admin always; member only if assigned
can(m, 'screenshots:read', s)  // owner | admin always; member only if their own
can(m, 'screenshots:delete', s)// owner | admin always; member only own + within grace
```

The capability matrix lives in one TypeScript file (`packages/server/src/auth/capabilities.ts`), tested exhaustively. Permissions logic does **not** sprawl across handlers.

## Capability matrix

| Action | Owner | Admin | Member |
|---|---|---|---|
| Manage billing/org settings | ✓ | | |
| Delete the org | ✓ | | |
| Promote/demote members | ✓ | ✓ (cannot touch owners) | |
| Invite members | ✓ | ✓ | |
| Remove members | ✓ | ✓ (not owners, not last owner) | |
| Create/edit/archive projects | ✓ | ✓ | |
| Assign members to projects | ✓ | ✓ | |
| View all projects | ✓ | ✓ | only assigned |
| View all time entries | ✓ | ✓ | only own |
| View all screenshots | ✓ | ✓ | only own |
| Delete screenshots | ✓ | ✓ | own, within grace window |
| View audit log | ✓ | ✓ | |
| Register a device | — | — | own |

## Last-owner protection

Database constraint isn't sufficient (race conditions). Enforce in the handler with a serializable transaction:
1. `BEGIN ISOLATION LEVEL SERIALIZABLE`.
2. Count owners in the org.
3. If the requested change would leave 0 owners, abort with 409.
4. Apply change; commit.

## Email verification

- Verification token sent on signup.
- Until verified:
  - Can use the app normally for their own work.
  - Cannot invite other users.
  - Cannot create new orgs (relevant if we add multi-org-creation later).
- Verification link is single-use, 7-day expiry.

## Password rules

- Argon2id, parameters tuned for ~250ms hash time on prod hardware.
- Minimum 12 characters. No max. No composition rules (per current best practice).
- Check against haveibeenpwned k-anonymity API on signup and password change; warn but don't block on hit.
- Throttle login: 5 failed attempts/15 min/IP+email pair before challenges (slow down responses, not lockout).

## Audit logging

Every privileged action writes an `audit_logs` row inside the same transaction:

- `org.created`, `org.deleted`
- `member.invited`, `member.joined`, `member.removed`, `member.role_changed`
- `project.created`, `project.archived`, `project.deleted`, `project.assignment_added`, `project.assignment_removed`
- `device.registered`, `device.revoked`
- `screenshot.deleted` (by whom)

Members can see their own related entries; admins see all entries in the org.

## What we are NOT doing in v1

- **No SSO / SAML.** Internal scale; password + magic-link is enough.
- **No 2FA.** (Add TOTP in v1.1; the schema doesn't preclude it.)
- **No OAuth provider.** We're not letting third parties log in *as* a user.
- **No public API tokens.** Only device tokens, which are scoped to the desktop app.

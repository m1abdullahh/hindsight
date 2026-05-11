# 08 — Auth & Permissions

## Identity model

- **One user, many memberships.** The `users` table is global. A `users.email` is unique across the entire system. To exist in an organization a user must have a row in `memberships`.
- **Role lives on the membership, not the user.** A user can be `owner` in their own org and `member` in someone else's. The role is _always_ resolved with respect to a specific org.
- **No "super admin."** There is no platform-level role. Operators access data via DB tooling, not the application UI.

## Token model (web and desktop)

Both clients authenticate with **opaque bearer tokens** sent on the `Authorization` header. There are no cookies. There is no JWT. Tokens are 32-byte random secrets stored as `sha256(token)` in the `tokens` table; the plaintext is shown to the client **once** at issue.

| Aspect                                  | Web token                                                                      | Device token                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `kind`                                  | `web`                                                                          | `device`                                                                            |
| Issued by                               | `POST /auth/login`, `POST /auth/signup`, `POST /auth/invitations/accept`       | `POST /devices/register` (requires a valid web token)                               |
| Lifetime                                | 30 days, **sliding** — each successful authenticated request bumps `expiresAt` | None — never expires by time                                                        |
| Revoked by                              | logout, password change, idle past expiry, "sign out everywhere"               | user-initiated "sign out this device", admin "revoke device", "sign out everywhere" |
| Scope                                   | The user, across every org they belong to                                      | The user, across every org they belong to                                           |
| Storage on client                       | `localStorage` in the web app                                                  | OS keychain on the desktop                                                          |
| `Idempotency-Key` required on mutations | No                                                                             | Yes (see [`05-api-surface.md`](./05-api-surface.md))                                |

### Why opaque tokens, not JWT

- Revocation is a single DB write; with JWT we'd need a denylist, which negates statelessness.
- Tokens never appear in URLs, cache keys, or logs (we redact the `Authorization` header at the logger).
- Server-side state is cheap at our scale (50–500 users).

### Why the same wire format for both kinds

Auth middleware resolves _any_ bearer token through one DB lookup. Handlers don't branch on web-vs-desktop unless a route is explicitly restricted to one kind (e.g. `POST /screenshots/presign` accepts device tokens only).

### Why `localStorage` for the web client (v1)

This is an internal authenticated dashboard at small scale. The XSS attack surface is small, the simplicity buys real velocity, and we can revisit (move to refresh-token-in-cookie + memory access token) if v1.1 onboards an external org. Decision recorded here so we don't drift into a half-cookie / half-storage hybrid.

## Authentication flow

### Sign up

1. `POST /auth/signup` with `{ email, password, name, organizationName }`.
2. Server checks email is not in use, creates `user`, `organization`, `membership` (owner) in a single transaction.
3. Sends email verification link (gates certain actions until verified).
4. Mints a web token, returns `{ user, organization, token, expiresAt }`.

### Login

1. `POST /auth/login` with `{ email, password }`.
2. Server verifies password (Argon2id).
3. Mints a web token, returns `{ user, memberships, token, expiresAt }`.

### Logout

1. `POST /auth/logout` with `Authorization: Bearer <token>`.
2. Server sets `revokedAt` on the matching token row. Subsequent requests with the token return 401.

### Device registration

1. Desktop app holds a valid web token from a normal login.
2. `POST /devices/register` with `{ deviceName, os, appVersion }` — uses the web token for auth.
3. Server creates a `devices` row + a `tokens` row (`kind=device`, `expiresAt=null`, `deviceId` linked) inside one transaction.
4. Returns `{ deviceId, deviceToken }` — plaintext shown **once**. Desktop persists it in the OS keychain.
5. After this point the desktop client uses the device token directly; it never holds the web token long-term.

### Invitation acceptance

1. Recipient clicks a link with an _invitation_ token (single-use, lives in `invitations.tokenHash` — distinct from auth tokens): `https://app.example.com/invitations/accept?token=...`
2. Frontend calls `POST /auth/invitations/accept`.
3. Server hashes the invitation token, finds the row, verifies not expired/accepted.
4. Four branches:
   - Logged in as a user with the invited email → just create the membership.
   - Logged in as a different user → 409, "this invite was for X@…, log out first".
   - Not logged in, account exists for that email → require password to proceed; mint a web token on success.
   - Not logged in, no account → require password + name; create user, then membership; mint a web token.
5. Mark invitation `acceptedAt`. Return `{ memberships, token, expiresAt }`.

## Authorization

Three layers — bearer auth, org scope, capability check.

### Layer 1: Bearer-token middleware

Every authenticated route runs this middleware:

1. Read `Authorization: Bearer <token>`. Missing or malformed → 401 `unauthorized`.
2. Compute `sha256(token)`, look up `tokens` row by `tokenHash` (joined with `users` and optionally `devices`).
3. If no row, or `revokedAt IS NOT NULL`, or (`expiresAt IS NOT NULL` AND `expiresAt < now()`) → 401.
4. If the route restricts kinds (e.g. `kinds: ['device']`) and the token's kind doesn't match → 403 `forbidden`.
5. Bump `lastUsedAt`. For web tokens, slide `expiresAt` forward by 30 days. The slide is debounced (only writes if `lastUsedAt` is older than ~5 minutes) to avoid hammering the DB on busy clients.
6. Attach `{ user, token, device? }` to the request.

### Layer 2: Org membership gate (only on routes with `:orgId`)

Runs after Layer 1:

1. Look up `membership(orgId, userId, status='active')`. If missing → 403 `forbidden`.
2. Attach `membership` to the request.

Handlers below this can rely on the caller belonging to the org.

### Layer 3: Capability check (handler-level)

A small function `can(membership, action, resource?)` returns boolean. Examples:

```ts
can(m, 'org:manage'); // owner only
can(m, 'members:invite'); // owner | admin
can(m, 'projects:create'); // owner | admin
can(m, 'projects:read', p); // owner | admin always; member only if assigned
can(m, 'screenshots:read', s); // owner | admin always; member only if their own
can(m, 'screenshots:delete', s); // owner | admin always; member only own + within grace
```

The capability matrix lives in one TypeScript file (`apps/api/src/auth/capabilities.ts`), tested exhaustively. Permissions logic does **not** sprawl across handlers.

## Capability matrix

| Action                       | Owner | Admin                          | Member                   |
| ---------------------------- | ----- | ------------------------------ | ------------------------ |
| Manage billing/org settings  | ✓     |                                |                          |
| Delete the org               | ✓     |                                |                          |
| Promote/demote members       | ✓     | ✓ (cannot touch owners)        |                          |
| Invite members               | ✓     | ✓                              |                          |
| Remove members               | ✓     | ✓ (not owners, not last owner) |                          |
| Create/edit/archive projects | ✓     | ✓                              |                          |
| Assign members to projects   | ✓     | ✓                              |                          |
| View all projects            | ✓     | ✓                              | only assigned            |
| View all time entries        | ✓     | ✓                              | only own                 |
| View all screenshots         | ✓     | ✓                              | only own                 |
| Delete screenshots           | ✓     | ✓                              | own, within grace window |
| View audit log               | ✓     | ✓                              |                          |
| Register a device            | —     | —                              | own                      |

## Last-owner protection

Database constraint isn't sufficient (race conditions). Enforce in the handler with a serializable transaction:

1. `BEGIN ISOLATION LEVEL SERIALIZABLE`.
2. Count owners in the org.
3. If the requested change would leave 0 owners, abort with 409 `conflict`.
4. Apply change; commit.

## Token revocation rules

| Trigger                                        | Web tokens                                                      | Device tokens                     |
| ---------------------------------------------- | --------------------------------------------------------------- | --------------------------------- |
| User logs out                                  | Calling token only                                              | —                                 |
| User changes password                          | All web tokens for that user                                    | **Not** auto-revoked (deliberate) |
| User clicks "sign out this device" in settings | —                                                               | That device's token               |
| Admin clicks "revoke device" on a member       | —                                                               | That device's token               |
| User clicks "sign out everywhere"              | All web tokens                                                  | All device tokens                 |
| Token reaches `expiresAt`                      | Lazy: 401 on next use; nightly worker hard-deletes expired rows | n/a                               |
| User deletion / org cascade                    | All tokens                                                      | All tokens                        |

The "password change does not revoke device tokens" rule is **deliberate** — desktop installs are trusted machines registered through an explicit flow. Users who want every device killed use the "sign out everywhere" button. Document it; don't re-litigate.

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
- `auth.login`, `auth.logout`, `auth.password_changed`, `auth.signed_out_everywhere`

Members can see their own related entries; admins see all entries in the org.

## What we are NOT doing in v1

- **No SSO / SAML.** Internal scale; password + bearer tokens are enough.
- **No 2FA.** (Add TOTP in v1.1; the schema doesn't preclude it.)
- **No OAuth provider.** We're not letting third parties log in _as_ a user.
- **No public API tokens.** Only web and device tokens, both scoped to a real user via the unified `tokens` table.
- **No JWT.** Opaque tokens with server-side revocation only.
- **No cookies.** The `WEB_ORIGIN` CORS allow-list is the only cookie-adjacent concern.

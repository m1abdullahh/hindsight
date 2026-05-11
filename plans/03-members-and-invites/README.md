# Plan 03 — Members & Invites

> Roadmap milestone: **v0.2 Members & invites** ([docs/10-roadmap.md:19-29](../../docs/10-roadmap.md#L19-L29))
> Priority bucket: **P1** (depends on Plan 02)
>
> **Addendum (Plan 06):** the invitation-accept 400 responses now carry `details: { requires: ['password'|'name'][], existingUser: boolean }` so the web client can render the right form without a "peek" round-trip. See [`apps/api/src/modules/invitations/service.ts`](../../apps/api/src/modules/invitations/service.ts).

## Goal

Land the full lifecycle for getting a person into an organization without them hand-typing a signup. Specifically: an owner/admin invites someone by email; they click a link; they accept (setting a password if first-time); they are an active `member` of that org.

While we're touching auth-adjacent code, this plan also closes the auth gaps that Plan 02 explicitly deferred: email verification, password reset, password change, "sign out everywhere", HIBP breach check on signup, and per-email login throttling.

After this plan executes, the auth surface is **complete enough to onboard a real team** to the API. The web pages that drive these flows live in the web plan that runs in parallel; this plan ships only the API.

## Source-of-truth references

- Identity model + token contract: [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md)
- Prisma schema (Invitation + supporting fields): [docs/04-data-model.md](../../docs/04-data-model.md)
- API surface (invitation + auth endpoints): [docs/05-api-surface.md](../../docs/05-api-surface.md)
- Glossary (invitation, accept, verify): [docs/11-glossary.md](../../docs/11-glossary.md)
- Plan this builds on: [plans/02-auth-and-orgs/](../02-auth-and-orgs/)

## Decisions captured here (not implementation yet)

1. **One-time-use invitation tokens**, 32 random bytes base64url, sha256-hashed in the DB column `invitations.token_hash`. Same shape as web/device tokens — the `Invitation` row is the verification record. **No JWT.**
2. **Invitation TTL: 7 days.** Long enough that a real human in a different timezone can act on it; short enough that a leaked email isn't valuable forever. Configurable via env if a customer asks.
3. **Pending invitations are visible to admins/owners only.** Members can't list invitations even within their own org — this avoids leaking who else is being onboarded.
4. **Accepting an invite for an email that already has an account** logs the existing user into the new org (just creates the `Membership` row). It does **not** require a fresh password. The route returns `{ user, organization, token }` shaped like signup.
5. **Accepting an invite for a new email** creates the `User` row, sets the password, marks `email_verified_at = now()` (the invite-link click _is_ the verification), creates the membership, mints a token. One transaction.
6. **Email is provided by Resend.** Postmark is a drop-in alternative; the abstraction is one `sendMail(MailMessage)` function with a Resend implementation by default. Provider key is required only when the mail-using endpoints are hit; missing key → `503 mail not configured`, not a startup crash.
7. **Mail templates are inline in code** (a `templates.ts` per module exporting `subject(data) → string` and `html(data) → string`). MJML / handlebars-in-files would be premature at this volume. We keep one HTML and one plaintext per template.
8. **Password reset uses the same token table** (`tokens` with a new `kind = 'password_reset'`) **with a 60-minute expiry**, single-use, sha256-hashed. Reusing the table keeps the auth mental model coherent — there is one place to look at every credential.
9. **Email verification likewise reuses `tokens`** with `kind = 'email_verify'`, 24-hour expiry, single-use. Marking the user verified revokes the token in the same transaction.
10. **HIBP k-anonymity** on signup AND on password change/reset. The first 5 chars of the SHA-1 hash go to `https://api.pwnedpasswords.com/range/<prefix>`; we never send the full hash. Network failure → permit (we don't block signup on a third-party outage). The check is best-effort.
11. **Per-email login throttle** with Redis: 5 failed attempts in 15 minutes locks login for that email for 15 more minutes. Returns `429 too_many_attempts`. The global IP rate limiter from Plan 01 still runs in front.
12. **"Sign out everywhere"** is one endpoint that revokes every active token for the calling user except (optionally) the current one. Useful when a user changes their password — we automatically run it from the password-change handler with `keepCurrent: true`.
13. **`User.passwordHash` becomes required** for users that finished signup (existing nullable column stays — invited users with no password yet still have `null`, until they accept).

## Out of scope for this plan (deferred to later plans)

- Web pages for any of these flows — the web plan handles UI
- Magic-link / passwordless sign-in — explicitly _not_ on the roadmap; revisit if a customer asks
- TOTP 2FA — v1.1 ([docs/10-roadmap.md:108-114](../../docs/10-roadmap.md#L108-L114))
- SSO / SAML — Future ([docs/10-roadmap.md:117-122](../../docs/10-roadmap.md#L117-L122))
- Audit-log read endpoint (`GET /orgs/:orgId/audit`) — v0.8 polish
- Resending an invitation that's already been accepted — return 409 instead

## Files in this plan

- [schema.md](./schema.md) — `Invitation` model, `TokenKind` enum additions, `User.passwordHash` policy
- [mail.md](./mail.md) — `sendMail` abstraction, Resend default, retry strategy, template structure
- [modules.md](./modules.md) — invitations / auth-extensions modules, routes, schemas, services
- [security.md](./security.md) — HIBP integration, login throttle, sign-out-everywhere semantics
- [testing.md](./testing.md) — invitation flow, password reset, email verification, throttle, HIBP

## Ordered execution checklist

1. **Schema migration.** Add `Invitation` model + relations. Extend `TokenKind` enum with `password_reset` and `email_verify`. `prisma migrate dev --name members_and_invites`. Run `pnpm db:test:migrate` against the test branch.
2. **Mail abstraction.** `apps/api/src/lib/mail.ts` with a `sendMail(message)` interface + Resend implementation behind a feature flag (`MAIL_PROVIDER_API_KEY` env). Idempotent retry up to 3× on 5xx.
3. **Invitations module.** `src/modules/invitations/` — routes / schemas / handlers / service. Endpoints: `POST/GET/DELETE /orgs/:orgId/invitations`, `POST /auth/invitations/accept`. Service uses a SERIALIZABLE transaction for accept.
4. **Email-verify endpoints.** `POST /auth/email/verify` and `POST /auth/email/resend-verification`. Lives in the existing `auth/` module.
5. **Password-reset endpoints.** `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/password/change`. Same `auth/` module.
6. **Sign-out-everywhere.** `POST /auth/sign-out-everywhere` with `keepCurrent` body flag.
7. **HIBP check.** `auth/hibp.ts` with k-anonymity + 1.5s timeout + fail-open behavior. Wired into signup and any password-write path.
8. **Login throttle.** `auth/login-throttle.ts` Redis helpers; wire into `login` service. Returns `429 too_many_attempts` with a `Retry-After` header.
9. **Audit additions.** Light up `member.invited`, `member.joined`, `auth.password_changed`, `auth.signed_out_everywhere`, `auth.email_verified`. Add to `AuditAction` union from Plan 02.
10. **Tests.** Per [testing.md](./testing.md): each new endpoint has at least one happy-path + the edge cases listed there.
11. **Lint, typecheck, test all green** before merging. Run with `TEST_DATABASE_URL` set (the truncate list expands to include `invitations`).

## Done when

- An owner can `POST /orgs/:orgId/invitations` with an email; an email lands in the test inbox.
- The acceptance link `POST /auth/invitations/accept` with `{ token, password? }` creates (or attaches) the user and returns a session token.
- A user can request a password reset, click the email link, set a new password, and log in with it.
- A signup with a known-pwned password (try `password123`) returns `422 invalid_input` with a clear message.
- 5 failed logins for `victim@example.com` within 15 minutes return `429`; correct password also returns `429` until the window passes.
- `POST /auth/sign-out-everywhere` revokes every other token; the current token still works (when `keepCurrent: true`).
- All audit rows from this plan exist on their respective endpoints.
- The `truncateAll()` test helper now also truncates `invitations`.
- `pnpm typecheck` and `pnpm test` pass against the whole workspace.

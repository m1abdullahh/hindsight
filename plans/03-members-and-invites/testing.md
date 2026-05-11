# Members & Invites — Testing

Two layers, same shape as Plan 02:

1. **Unit tests** for the new pure helpers (HIBP parser, throttle math)
2. **Integration tests** for every new endpoint, real DB, real bearer auth, **stubbed mail provider**

The capability matrix unit test from Plan 02 grows by exactly two rows (`members:invite` × `member`/`admin`/`owner`, `invitations:revoke` is the same role check so no new branches).

## Mail provider stub

We do not call Resend from CI. Add a test-only provider:

```ts
// test/helpers/mail-stub.ts
import type { MailMessage, MailProvider } from '../../src/lib/mail.js';

export const mailStub: MailProvider & { sent: MailMessage[] } = {
  sent: [],
  async send(message) {
    this.sent.push(message);
    return { providerMessageId: `stub-${this.sent.length}` };
  },
};
```

The `setup.ts` from Plan 02 sets `MAIL_PROVIDER_API_KEY=test-stub`; `lib/mail.ts` checks for that exact value and wires `mailStub` instead of Resend. (Yes, it's a string-compare; one branch in one file. Not worth a DI container.)

`beforeEach` clears `mailStub.sent`.

## `truncateAll()` update

Add `invitations` between `tokens` and `memberships`:

```ts
const TABLES = [
  'audit_logs',
  'tokens',
  'invitations',
  'memberships',
  'devices',
  'organizations',
  'users',
];
```

If a foreign-key error appears in CI, the order is wrong — `invitations` references `organizations(id)` and `users(id)` (via `invited_by_id`), so it must truncate before either of them.

## Invitation flow (`test/invitations.test.ts`)

Setup helper signs up an owner in org A and returns their token + orgId.

### Happy paths

- **Owner invites**: `POST /orgs/:orgId/invitations` with `{ email, role: 'admin' }` → 201, `mailed: true`, mailStub received one message with the token in the URL. The DB has an unaccepted invitation row.
- **Admin invites**: same, by an admin. 201.
- **Listing**: `GET /orgs/:orgId/invitations` returns the pending invite. `tokenHash` is not in the response.
- **Accept (new user)**: `POST /auth/invitations/accept` with `{ token, password, name }` → 201. User row created, `email_verified_at` non-null. Membership row created with the invited role. Returned token authenticates `/auth/me`.
- **Accept (existing user)**: signup user A in org A. Owner of org B invites `a@example.com`. A POSTs accept with `{ token }` (no password). 201. A now has memberships in both orgs.
- **Revoke**: `DELETE /orgs/:orgId/invitations/:id` → 204. The invitation row has `revokedAt` set. Subsequent accept with that token → 404 generic.

### Edge cases

- **Member tries to invite** → 403.
- **Invite for an existing active member's email** → 409.
- **Second pending invite for the same `(orgId, email)`** → 409.
- **Re-invite after acceptance** → 201 (the unique constraint allows it because the previous row's `acceptedAt` is non-null).
- **Accept with expired token** → 404 generic. The DB row stays unaccepted (the row will eventually be cleaned up by a TTL job; not in this plan).
- **Accept with revoked token** → 404 generic.
- **Accept missing required password for new user** → 400 with `invalid_input`.
- **Accept where the body's password is HIBP-pwned** → 422.
- **Two concurrent accepts of the same token** → exactly one wins; the other gets 404 generic. Use `Promise.all([accept, accept])` and assert exactly one 201 across both responses.
- **Audit**: `member.invited` exists after invite; `member.joined` exists after accept; `member.invitation_revoked` exists after revoke.

## Email verification (`test/email-verify.test.ts`)

Helper that creates an unverified user (signup gives `email_verified_at = null` per [plans/02-auth-and-orgs/schema.md:78](../02-auth-and-orgs/schema.md#L78)). The verify-token mint helper exists at `auth/tokens.ts`.

- **Resend**: `POST /auth/email/resend-verification` with the user's email → 204, mailStub received one message.
- **Resend for unknown email** → 204, mailStub received nothing (anti-enumeration).
- **Verify**: `POST /auth/email/verify` with `{ token }` → 200, user row's `email_verified_at` is now non-null.
- **Verify already-verified user** → 200 idempotent. Token is revoked either way.
- **Verify with expired/revoked token** → 401.
- **Audit**: `auth.email_verified` row exists.

## Password reset (`test/password-reset.test.ts`)

Setup: signup, capture user. Use the token-mint helper to skip the email step where it doesn't add coverage; one happy-path test goes through the email send to confirm wiring.

- **Forgot (real email)**: `POST /auth/password/forgot` → 204, mailStub received one message, audit `auth.password_reset_requested` written.
- **Forgot (unknown email)**: 204, mailStub received nothing, no audit row written.
- **Reset (happy path)**: mint a reset token, `POST /auth/password/reset` with `{ token, password: 'new-strong-pass-here' }` → 200, returned token authenticates `/auth/me`. Old web tokens (mint one before reset) now return 401 on `/auth/me` (sign-out-everywhere ran).
- **Reset with expired token** → 401.
- **Reset with revoked token (re-use)** → 401. Implement: call reset twice; second call must fail.
- **Reset with HIBP-pwned password** → 422.
- **Audit**: `auth.password_changed` and `auth.signed_out_everywhere` rows exist.

## Password change (`test/password-change.test.ts`)

Authenticated.

- **Happy path**: signup, mint a second token (simulate "logged in on another device"), call `POST /auth/password/change` with the first token. Body has correct current-password and new password. → 204. The first token still authenticates `/auth/me`. The second token now returns 401.
- **Wrong current password** → 401 generic. New password not written.
- **HIBP-pwned new password** → 422.
- **Audit**: `auth.password_changed` and `auth.signed_out_everywhere` rows exist.

## Sign-out-everywhere (`test/sign-out-everywhere.test.ts`)

- **keepCurrent: true (default)**: sign up, mint two extra tokens, call the endpoint with the first → 204. First still works. Other two return 401.
- **keepCurrent: false**: same setup. → 204. All three tokens now return 401.
- **Audit**: row exists.

## Login throttle (`test/login-throttle.test.ts`)

- **Lockout**: 5 failed logins for `victim@example.com` → 6th login (even with the correct password) returns 429 with a `Retry-After` header.
- **Unknown email also throttles**: 5 failed logins for `does-not-exist@example.com` → 6th attempt returns 429. (Anti-enumeration.)
- **Recovery on success below threshold**: 4 failed logins, then a correct login → 200. Counter cleared. 5 more failed logins are needed before the next lockout.
- **Lock TTL**: After locking, set the `login:lock:<email>` TTL to 0 manually (test helper) and assert next attempt is allowed again.

These tests need a clean Redis between cases. Add a `flushTestPrefix()` helper that scans `login:fail:*` and `login:lock:*` keys and deletes them. Don't `FLUSHALL` — that nukes BullMQ keys other tests might use later.

## HIBP unit tests (`src/auth/hibp.test.ts`)

Pure unit, no network — mock `fetch`.

- **Pwned**: response includes our suffix → returns `true`.
- **Not pwned**: response excludes our suffix → returns `false`.
- **Provider returns 500** → returns `false` (fail-open).
- **Network error / abort** → returns `false`.
- **Timeout** → returns `false`.

These run in milliseconds and prove the parsing matches what HIBP actually returns. Re-use a fixture with a real HIBP-style response body.

## What we explicitly don't test

- **The mail provider's HTTP shape** beyond the stub interface. If Resend changes their response shape, that breaks at runtime; integration with a real provider is verified manually in dev.
- **Email rendering visual fidelity.** We snapshot-test the plaintext body; HTML body is not snapshotted (too fragile to whitespace).
- **Browser-side URL parsing.** The web plan's tests cover that.

## Coverage target

Same stance as Plan 02 — at least one happy-path per endpoint plus the edge cases listed. No coverage-percentage threshold yet.

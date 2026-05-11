# Members & Invites — Security additions

Three pieces this plan adds:

1. **HIBP** k-anonymity password breach check
2. **Per-email login throttle** in Redis
3. **Sign-out-everywhere** semantics across password-write paths

The first two are public-internet hygiene we deferred from Plan 02; the third is the small piece of credential management that makes "I think my account got phished" survivable.

## HIBP — Have I Been Pwned k-anonymity

### What it is

HIBP exposes a free API: send the **first 5 hex chars** of `SHA1(password)` to `https://api.pwnedpasswords.com/range/<prefix>`, get back a list of suffixes with breach counts. If your password's full SHA-1 suffix is in the list, the password has been seen in a breach.

We never send the full hash and never send the password itself. The k-anonymity model means HIBP can't recover the password from what we send.

### Where we call it

Three places, all **before** writing a password hash to the DB:

- `POST /auth/signup`
- `POST /auth/invitations/accept` (when the body sets a password for a new user)
- `POST /auth/password/reset`
- `POST /auth/password/change`

### Implementation (`apps/api/src/auth/hibp.ts`)

```ts
import { createHash } from 'node:crypto';

const HIBP_TIMEOUT_MS = 1500;
const HIBP_URL = 'https://api.pwnedpasswords.com/range/';

export const isPasswordPwned = async (plaintext: string): Promise<boolean> => {
  const sha1 = createHash('sha1').update(plaintext).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HIBP_TIMEOUT_MS);

  try {
    const res = await fetch(`${HIBP_URL}${prefix}`, {
      headers: { 'Add-Padding': 'true' }, // disables count-based fingerprinting
      signal: ctrl.signal,
    });
    if (!res.ok) return false; // fail-open on provider error
    const text = await res.text();
    for (const line of text.split('\n')) {
      const [hashSuffix] = line.split(':');
      if (hashSuffix?.trim() === suffix) return true;
    }
    return false;
  } catch {
    return false; // fail-open on network error / timeout
  } finally {
    clearTimeout(timer);
  }
};
```

### Fail-open justification

HIBP is a third party we don't control. If it's down, blocking signup would mean a third-party outage stops new sign-ups in their tracks — a worse failure than briefly accepting a weak password. We log at `warn` when the call errors so the metric is visible.

### Response when pwned

`AppError('invalid_input', 422, 'this password appears in a known data breach — choose another')`. The client gets a clear remediation, not a generic 400.

## Per-email login throttle

### What it is

The global IP-based rate limiter from Plan 01 doesn't stop a credential-stuffing attack that comes from a botnet (different IPs, same email). This adds a per-email throttle in Redis: if `victim@example.com` has 5 failed logins in 15 minutes, that email is locked for the next 15 minutes — even with the correct password.

### Implementation (`apps/api/src/auth/login-throttle.ts`)

```ts
import { redis } from '../lib/redis.js';

const WINDOW_S = 15 * 60;
const LIMIT = 5;
const LOCK_S = 15 * 60;

const failKey = (email: string) => `login:fail:${email}`;
const lockKey = (email: string) => `login:lock:${email}`;

export interface ThrottleStatus {
  locked: boolean;
  retryAfter?: number; // seconds, present when locked
}

export const checkLogin = async (email: string): Promise<ThrottleStatus> => {
  const ttl = await redis.ttl(lockKey(email));
  if (ttl > 0) return { locked: true, retryAfter: ttl };
  return { locked: false };
};

export const recordFailure = async (email: string): Promise<void> => {
  const k = failKey(email);
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, WINDOW_S);
  if (count >= LIMIT) {
    await redis.set(lockKey(email), '1', 'EX', LOCK_S);
    await redis.del(k);
  }
};

export const recordSuccess = async (email: string): Promise<void> => {
  await Promise.all([redis.del(failKey(email)), redis.del(lockKey(email))]);
};
```

### How `login` uses it

```ts
const status = await checkLogin(email);
if (status.locked) {
  throw new AppError('too_many_attempts', 429, 'too many failed login attempts', {
    retryAfter: status.retryAfter,
  });
}

const ok = await verifyPassword(user.passwordHash, password);
if (!ok) {
  await recordFailure(email);
  throw genericInvalid(); // same 401 as user-not-found
}

await recordSuccess(email);
// ...mint token, return
```

Note: we record failure with `recordFailure(email)` even when the user doesn't exist. Otherwise an attacker can probe which emails are real by watching whose throttle counter ticks. Using `email` (not `userId`) for the key means we throttle the _attempt key_, which is what matters.

### Surfacing `Retry-After`

The error handler from Plan 01 maps `AppError` to JSON. For `429` specifically, also set the `Retry-After` HTTP header from `details.retryAfter`. This is conventional and lets clients display a real countdown.

### What this doesn't protect against

- **Slow attacks** — 4 failures every 15 minutes never trips the lock. Acceptable; we're not building a bank.
- **Cross-email enumeration** — Same attacker hits 1000 different victim emails. Each has its own counter. The global IP limiter from Plan 01 is what catches this.
- **Lockouts as a denial of service** — An attacker can lock a real user out by spamming wrong passwords. We accept this risk; the alternative (no per-email throttle) is worse. Recovery: 15 minutes, or password reset.

## Sign-out-everywhere semantics

`POST /auth/sign-out-everywhere` is a one-call answer to "I think my session got stolen." Service:

```ts
export const signOutEverywhere = async (
  userId: string,
  { keepCurrent, currentTokenId }: { keepCurrent: boolean; currentTokenId?: string },
): Promise<void> => {
  await prisma.token.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepCurrent && currentTokenId ? { id: { not: currentTokenId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
};
```

The handler sets `currentTokenId = caller.token.id` and reads `keepCurrent` from the body (default `true`).

### Auto-invocation paths

- `changePassword` calls it with `keepCurrent: true` — your other devices get logged out, but you stay logged in on the device you just used.
- `resetPassword` calls it with `keepCurrent: false` (no current token; the reset is initiated public) — the response then mints a fresh token so the user lands logged in.

Audit row `auth.signed_out_everywhere` written each time, regardless of caller (password-change handler, reset handler, or manual endpoint).

## Audit additions summary

Add to the `AuditAction` union from [plans/02-auth-and-orgs/audit.md](../02-auth-and-orgs/audit.md):

| Action                          | Written by                                                 |
| ------------------------------- | ---------------------------------------------------------- |
| `member.invited`                | `POST /orgs/:orgId/invitations`                            |
| `member.invitation_revoked`     | `DELETE /orgs/:orgId/invitations/:id`                      |
| `member.joined`                 | `POST /auth/invitations/accept` (always)                   |
| `auth.email_verified`           | `POST /auth/email/verify`                                  |
| `auth.password_reset_requested` | `POST /auth/password/forgot` (only when the email matched) |
| `auth.password_changed`         | reset + change handlers                                    |
| `auth.signed_out_everywhere`    | sign-out + auto-invocations                                |

`auth.signup` is reused inside the accept handler when a new user is created, matching Plan 02's existing semantics.

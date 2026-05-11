# Members & Invites — Mail

This plan introduces the first outbound email surface. Three kinds of mail go out:

- **Invitation** — "X invited you to Y. Click to join."
- **Email verification** — "Confirm this is your email address."
- **Password reset** — "Click here to reset your password."

That's the whole set for the lifetime of this plan. Notification mail (low-activity flags, weekly digests, etc.) is explicitly out of scope and lands later if at all.

## Provider choice

**Default: [Resend](https://resend.com).** Dead-simple HTTP API, free tier covers all of dev + early pilot, sane DKIM/SPF setup. Postmark is a drop-in replacement and keeps the abstraction honest — if Resend ever disappoints, swap one file.

We do **not** use SMTP. Provider HTTP APIs are simpler, observable, and don't need a connection pool.

## Abstraction (`src/lib/mail.ts`)

```ts
export interface MailMessage {
  to: string; // single recipient — no bcc/cc in this codebase yet
  subject: string;
  html: string; // primary
  text: string; // fallback for clients that won't render HTML
  tags?: Record<string, string>; // provider-side analytics labels
}

export interface MailProvider {
  send(message: MailMessage): Promise<{ providerMessageId: string }>;
}

export const sendMail = async (message: MailMessage): Promise<void> => {
  if (!provider) {
    throw new AppError('mail_unavailable', 503, 'mail provider not configured');
  }
  await retry(() => provider.send(message), { attempts: 3, baseDelayMs: 500 });
};
```

### Wiring

`provider` is `null` if `MAIL_PROVIDER_API_KEY` is unset; the assignment happens once at module load. Endpoints that need mail check for the `503` and surface it. Other endpoints don't import `sendMail` and never observe the missing key.

### Retry policy

- **5xx from provider** → retry up to 3 attempts with 500/1500/4500ms backoff.
- **4xx** → fail fast (bad payload — retrying won't help; log + audit + bubble up).
- **Network error** → counts as a 5xx for retry purposes.
- **Timeout per attempt: 5s.** Total worst-case 5s × 3 + backoff ≈ 21s. The endpoint's overall budget should be longer than that, or we accept a `503` after the budget burns.

Failure after exhausting retries: throw `AppError('mail_send_failed', 502, …)`. The handler-level catch logs at error and **does not** roll back the DB write that issued the mail. That trade-off is intentional and described per-endpoint below.

## Resend implementation (`src/lib/mail/resend.ts`)

Thin: one `fetch` call against Resend's `/emails` endpoint, body shape per their docs, `Authorization: Bearer ${API_KEY}` header. Map their response to `{ providerMessageId }`. No SDK — it's literally one POST.

We avoid the `resend` npm package because it pulls a lot of TS plumbing for one HTTP call. `fetch` + `zod` to parse the response is sufficient and forces us to think about timeout and error shape ourselves.

## Templates

One file per template under `src/modules/<owning-module>/templates/`. Each exports two functions:

```ts
export const subject = (data: TemplateData): string => `…`;

export const render = (data: TemplateData): { html: string; text: string } => ({
  html: `<!doctype html>…`,
  text: `…\n\nLink: ${data.url}\n…`,
});
```

Templates live next to the module that owns them — invitation templates under `modules/invitations/`, password-reset under `modules/auth/templates/`. **No global `templates/` folder.** Localized strings get added when we have a second locale; today everything is English.

### What every template includes

- A reason line: "You're getting this because someone at <org> invited you."
- A revoke / contact line: "If you didn't expect this, reply to this email."
- The action URL (linkable + plaintext) and an explicit expiry: "This link expires in 7 days."
- No tracking pixels.
- Plain HTML — no responsive frameworks, no images. The point is to convey one action.

## Idempotency vs. mail

The "send the email and write the DB row" pair is not atomic. We commit the DB row first, then send the email. Consequences:

- **Resend fails** → invitation row exists in DB but email never landed. Surfaced to the admin in the response: `{ invitation, mailed: false, mailError: '…' }`. The list endpoint shows pending invites; the admin can hit a `POST /orgs/:orgId/invitations/:id/resend` endpoint (small follow-up if we need it) to retry.
- **Resend succeeds, response lost** → row exists; email landed; we return success. Best case.
- **DB commits, process crashes before send** → row exists; email never landed. Same recovery as above.

We deliberately don't introduce an "outbox table + worker" pattern for this volume. The whole flow is initiated by an authenticated admin who is watching the request — surfacing the error in the response is the right ergonomics.

The desktop screenshot pipeline does have an outbox (Plan 05+), and that one is engineered for offline; this is a different shape of problem.

## URL construction

The action URLs in mail point to the **web app**, not the API. Pattern:

- Invitation: `${WEB_ORIGIN}/accept-invite?token=${plaintext}`
- Email verify: `${WEB_ORIGIN}/verify-email?token=${plaintext}`
- Password reset: `${WEB_ORIGIN}/reset-password?token=${plaintext}`

The web app extracts the token from the URL and POSTs it to the API. Tokens never sit in the browser address bar after that exchange.

`WEB_ORIGIN` is the existing env var from [plans/00-monorepo-scaffold/structure.md](../00-monorepo-scaffold/structure.md#L114) — **no new env var** needed for URL construction.

## Local development without a real mail provider

When `MAIL_PROVIDER_API_KEY` is empty in dev:

1. The `sendMail` call throws `503 mail not configured`.
2. The endpoint logs the would-have-been email at `info` level, including the action URL.
3. The HTTP response surfaces `mailed: false` for invitations; for password-reset/email-verify it returns 204 (we don't tell the caller whether mail landed — same anti-enumeration argument as login).

Developers grab the URL from logs and complete the flow manually. CI tests run with a stubbed provider (see [testing.md](./testing.md)).

## Mail-related audit

No new audit actions are added for "email sent" — mail delivery is a side-effect, not a domain event. The domain audit rows (`member.invited`, `auth.password_changed`, etc.) carry the meaning. Tracking provider message IDs in the audit row's `metadata` is acceptable but not required.

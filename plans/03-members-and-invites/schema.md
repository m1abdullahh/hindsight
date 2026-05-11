# Members & Invites — Prisma Schema

The canonical schema lives in [docs/04-data-model.md](../../docs/04-data-model.md). This plan adds one model, extends one enum, and tightens one comment about a nullable column.

## Models added by this plan

- `Invitation`

## Enums extended by this plan

- `TokenKind` gains two values: `password_reset`, `email_verify`

## Models intentionally **not** in this plan

- `Project`, `ProjectAssignment` — Plan 04
- `TimeEntry`, `Screenshot` — Plan 05+

## `Invitation` model

```prisma
model Invitation {
  id          String           @id
  orgId       String           @map("org_id")
  email       String                                   // lowercased on write
  role        Role
  tokenHash   String           @unique @map("token_hash")
  invitedById String           @map("invited_by_id")
  expiresAt   DateTime         @map("expires_at")
  acceptedAt  DateTime?        @map("accepted_at")
  acceptedBy  String?          @map("accepted_by")     // user id; nullable until accept
  revokedAt   DateTime?        @map("revoked_at")
  createdAt   DateTime         @default(now()) @map("created_at")

  organization Organization    @relation(fields: [orgId], references: [id], onDelete: Cascade)
  invitedBy    User            @relation("InvitedBy", fields: [invitedById], references: [id], onDelete: Restrict)

  @@unique([orgId, email, acceptedAt])   // one outstanding invite per (org,email); accepted rows allowed to dup
  @@index([email])
  @@index([orgId, createdAt])
  @@map("invitations")
}
```

The `@@unique([orgId, email, acceptedAt])` lets the _same_ email be re-invited after a previous invite was accepted (Postgres treats `null` as distinct in a multi-column unique). It blocks two **outstanding** (un-accepted) invites for the same `(org, email)` pair, which is the actual constraint we want.

### Required relation fields on existing models

- `Organization.invitations Invitation[]` — re-introduces the relation we removed in Plan 02 ([plans/02-auth-and-orgs/schema.md:25](../02-auth-and-orgs/schema.md#L25))
- `User.invitationsSent Invitation[] @relation("InvitedBy")` — the inverse for `invitedById`

## `TokenKind` enum extension

```prisma
enum TokenKind {
  web
  device
  password_reset    // NEW
  email_verify      // NEW
}
```

The `tokens` table doesn't change shape. Reset and verify tokens use the existing columns:

| Column         | Reset / Verify usage                    |
| -------------- | --------------------------------------- |
| `token_hash`   | sha256 of plaintext, same as web/device |
| `kind`         | `password_reset` or `email_verify`      |
| `expires_at`   | 60 min for reset; 24 h for verify       |
| `device_id`    | Always `null`                           |
| `revoked_at`   | Set on use to prevent reuse             |
| `last_used_at` | Set on consumption (informational only) |

This keeps "every credential lives in one table" — the property Plan 02 chose for its mental simplicity.

## `User.passwordHash` — clarification

The column was already `String?` in Plan 02. Plan 03 confirms the policy:

- A user created via signup → `passwordHash` is non-null.
- A user created via accepting an invite _with a password in the body_ → non-null.
- A user created via accepting an invite _without a password_ → `null` until they later set one.
  - That state cannot log in via `/auth/login` (login finds the user, finds null hash, returns the same generic 401 as a wrong-password reply).
  - They sign in via the invitation link's session token initially; password is set via `POST /auth/password/change` while authed, or via the password-reset flow.

No schema change for this; the policy is enforced in the auth service.

## Migration sequence

One Prisma migration: `prisma migrate dev --name members_and_invites`. Conceptual SQL order:

1. `ALTER TYPE "TokenKind" ADD VALUE 'password_reset';`
2. `ALTER TYPE "TokenKind" ADD VALUE 'email_verify';`
3. `CREATE TABLE invitations (...)` with FKs to `organizations(id)` and `users(id)`
4. Indexes: `(token_hash) UNIQUE`, `(org_id, email, accepted_at) UNIQUE`, `(email)`, `(org_id, created_at)`

Postgres requires `ADD VALUE` to be in its own transaction — Prisma handles that. If you ever need to revert, dropping enum values is non-trivial; treat enum extensions as forward-only.

## `truncateAll()` helper update

Add `invitations` to the truncation list, before `organizations` and `users`:

```ts
const TABLES = [
  'audit_logs',
  'tokens',
  'invitations', // NEW — must come before organizations + users
  'memberships',
  'devices',
  'organizations',
  'users',
];
```

## Email lowercasing — extends to invitations

The Plan 02 rule "every email write is lowercased" applies to `invitations.email` too. The Zod schema for `inviteInput.email` chains `.trim().toLowerCase().email()` exactly like signup/login.

## Things to double-check before applying

- The `acceptedBy` foreign key is **omitted** from the schema above intentionally — we store the accepting user's id but don't make Prisma manage the relation. The user already exists and isn't owned by the invitation; a real FK would force ordering complications on user delete. Application-layer integrity is sufficient here.
- The `invitedBy` relation uses `onDelete: Restrict` — you can't hard-delete a user who has sent invitations. In practice this never fires because we soft-delete users.
- `expiresAt` is **not nullable**: every invitation must have an expiry, defaulted to `now() + 7 days` at the application layer.

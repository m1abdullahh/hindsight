# Auth & Orgs — Audit Log

The `audit_logs` table from [docs/04-data-model.md](../../docs/04-data-model.md) records every privileged action. This plan ships:

- The model + index (covered in [schema.md](./schema.md))
- A typed helper that writes an audit row inside an existing transaction
- Audit writes for every action introduced by this plan

## Helper (`auth/audit.ts`)

```ts
import type { Prisma } from '@prisma/client';

import { ulid } from '../lib/id.js';

export type AuditAction =
  | 'org.created'
  | 'org.updated'
  | 'org.deleted'
  | 'member.invited'
  | 'member.joined'
  | 'member.removed'
  | 'member.role_changed'
  | 'member.status_changed'
  | 'project.created'
  | 'project.archived'
  | 'project.deleted'
  | 'project.assignment_added'
  | 'project.assignment_removed'
  | 'device.registered'
  | 'device.revoked'
  | 'screenshot.deleted'
  | 'auth.signup'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'auth.signed_out_everywhere';

export interface WriteAuditInput {
  orgId: string;
  actorId: string | null; // null for system actions
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.JsonObject;
}

export const writeAudit = (
  tx: Prisma.TransactionClient,
  input: WriteAuditInput,
): Promise<unknown> =>
  tx.auditLog.create({
    data: {
      id: ulid(),
      orgId: input.orgId,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? Prisma.JsonNull,
    },
  });
```

The first argument is the **transaction client**, not the global `prisma`. Forcing callers to pass `tx` makes it impossible to write an audit row that isn't atomic with its action.

The `AuditAction` union is the closed set of actions we audit. Plan 02 only emits a subset; the rest are reserved so the type is stable as later plans light them up.

## Actions written by this plan

| Endpoint                              | Audit action                                       | Target        |
| ------------------------------------- | -------------------------------------------------- | ------------- |
| `POST /auth/signup`                   | `org.created`                                      | org id        |
|                                       | `auth.signup`                                      | user id       |
| `POST /auth/login`                    | `auth.login`                                       | user id       |
| `POST /auth/logout`                   | `auth.logout`                                      | user id       |
| `PATCH /orgs/:orgId`                  | `org.updated`                                      | org id        |
| `PATCH /orgs/:orgId/members/:userId`  | `member.role_changed` _or_ `member.status_changed` | membership id |
| `DELETE /orgs/:orgId/members/:userId` | `member.removed`                                   | user id       |

Actions deferred to later plans:

- `member.invited`, `member.joined` — Plan 03
- `auth.password_changed`, `auth.signed_out_everywhere` — Plan 03
- `project.*`, `device.*`, `screenshot.deleted` — feature plans

## Visibility rules

- Members see their own related entries (filter by `actor_id = caller user` OR `target_id = caller user`).
- Admins/owners see every entry in the org.
- The audit-log read endpoint lands later (`GET /orgs/:orgId/audit`); for Plan 02 we only _write_ rows. Reading is its own UI surface and can sit until v0.8 polish.

## Idempotency considerations

Audit writes inside a transaction inherit the transaction's idempotency. If a request retries (e.g. `Idempotency-Key` replay on a desktop endpoint), the _whole transaction_ including the audit row replays — which means duplicate audit entries on replays. That's the right behavior: a replay is a separate physical attempt and we want it represented.

## What metadata to put in `metadata`

Be conservative. Examples:

- `member.role_changed`: `{ "from": "member", "to": "admin" }`
- `org.updated`: `{ "fields": ["name"] }` (NOT the new name; that's already in the row's history if we ever add one)

Never store secrets, raw tokens, hashes, or PII beyond what's already on the audited row.

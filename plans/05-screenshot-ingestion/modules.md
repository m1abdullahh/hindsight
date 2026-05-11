# Screenshot Ingestion — HTTP Modules

Three new modules: `devices/`, `time-entries/`, `screenshots/`. Same four-file convention from [plans/01-backend-structure/modules.md](../01-backend-structure/modules.md): `routes.ts` / `schemas.ts` / `handlers.ts` / `service.ts`.

Two cross-cutting middleware concerns this plan finally exercises:

- **`requireAuth({ kinds: ['device'] })`** — already supported by the bearer middleware; `requireDevice()` wraps it. Used by every screenshot ingestion route.
- **`idempotency()`** — already implemented in [`apps/api/src/middleware/idempotency.ts`](../../apps/api/src/middleware/idempotency.ts) but not yet wired anywhere. Attached to every device-token write endpoint.

## `modules/devices/`

### Schemas (`devices/schemas.ts`)

```ts
import { z } from 'zod';

const DeviceName = z.string().trim().min(1).max(100);
const Os = z.enum(['windows', 'macos', 'linux']);
const SemVer = z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/);

export const registerDeviceInput = z.object({
  deviceName: DeviceName,
  os: Os,
  appVersion: SemVer,
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceInput>;

export const heartbeatInput = z.object({
  appVersion: SemVer,
});
export type HeartbeatInput = z.infer<typeof heartbeatInput>;
```

### Routes (`devices/routes.ts`)

```
POST   /devices/register      requireAuth() (web token only) + idempotency()    body: registerDeviceInput
GET    /devices               requireAuth()
DELETE /devices/:deviceId     requireAuth()
POST   /devices/heartbeat     requireDevice() + idempotency()                   body: heartbeatInput
```

`requireAuth()` without `kinds` accepts both web and device tokens. The register route restricts to `kinds: ['web']` so a desktop can't bootstrap another device from a device token (would be a privilege escalation path).

### Service (`devices/service.ts`)

- `registerDevice(user, input, ctx)`:
  - One transaction: insert `Device` with `revokedAt = null`, mint a `device` token (the `Token.deviceId` ↔ `Device.id` 1:1 wiring already works from Plan 02).
  - Audit `device.registered`.
  - Return `{ device, deviceToken }` — plaintext **shown once** (per [docs/08-auth-and-permissions.md:60](../../docs/08-auth-and-permissions.md#L60)).
- `listDevices(userId)` → all non-revoked devices for the user. Sorted by `lastSeenAt DESC`, then `createdAt DESC`.
- `revokeDevice(userId, deviceId, actor)`:
  - Caller must own the device (`device.userId === actor.userId`) **or** be an org owner/admin in any org the target user belongs to. The cross-org-admin path matters when an admin needs to revoke a member's stolen laptop. (Permission check via `can(actor.membership, { type: 'members:remove' })` for now; revisit when we have a finer-grained device admin permission.)
  - One transaction: set `Device.revokedAt`, revoke the device's token (set `Token.revokedAt`).
  - Audit `device.revoked`.
- `heartbeat(device, input)`:
  - Update `device.lastSeenAt = now()`, optionally update `device.appVersion` if it changed.
  - No audit (heartbeats are noise).

### Handlers / wiring

Standard thin shape. `register` returns 201 with `{ deviceId, deviceToken, device }` (DTO without `tokenHash`). `heartbeat` returns 204.

## `modules/time-entries/`

### Schemas (`time-entries/schemas.ts`)

```ts
import { z } from 'zod';

const isoDate = (max?: { future?: number; past?: number }) =>
  z
    .string()
    .datetime()
    .transform((s) => new Date(s))
    .superRefine((d, ctx) => {
      const now = Date.now();
      if (max?.future !== undefined && d.getTime() > now + max.future) {
        ctx.addIssue({ code: 'custom', message: 'date is in the future beyond skew tolerance' });
      }
      if (max?.past !== undefined && d.getTime() < now - max.past) {
        ctx.addIssue({ code: 'custom', message: 'date is too far in the past' });
      }
    });

const Seconds = z.number().int().min(0).max(86_400);

export const createTimeEntryInput = z.object({
  projectId: z.string().min(1),
  startedAt: isoDate({ future: 60_000, past: 7 * 24 * 60 * 60 * 1000 }),
});
export type CreateTimeEntryInput = z.infer<typeof createTimeEntryInput>;

export const updateTimeEntryInput = z
  .object({
    endedAt: isoDate({ future: 60_000 }).optional(),
    totalActiveSeconds: Seconds.optional(),
    totalIdleSeconds: Seconds.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'must include at least one field',
  });
export type UpdateTimeEntryInput = z.infer<typeof updateTimeEntryInput>;

export const listTimeEntriesQuery = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
  from: isoDate().optional(),
  to: isoDate().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type ListTimeEntriesQuery = z.infer<typeof listTimeEntriesQuery>;
```

### Routes (`time-entries/routes.ts`)

```
POST   /time-entries                            requireAuth() + idempotency()    body: createTimeEntryInput
PATCH  /time-entries/:id                        requireAuth() + idempotency()    body: updateTimeEntryInput
GET    /orgs/:orgId/time-entries                requireAuth() + orgScope()       query: listTimeEntriesQuery
```

`requireAuth()` accepts both web and device tokens. `POST` and `PATCH` are typically called by device tokens; the list route is admin-facing.

### Service (`time-entries/service.ts`)

- `startTimeEntry(caller, input)`:
  - **Caller must be a device token** (the `requireAuth` middleware doesn't enforce this, the service does). Return 403 if not.
  - Verify the user is a member of the project's org.
  - Verify the user has an active assignment to the project. Per [docs/08-auth-and-permissions.md:121](../../docs/08-auth-and-permissions.md#L121), members can only track on projects they're assigned to. Owners/admins can track on any project in their org.
  - **Auto-stop any open time entry** for this device — see Plan 05 README decision 9. Set `endedAt = now()` on the previous open row before inserting the new one.
  - Insert `TimeEntry` with `userId`, `projectId`, `deviceId`, `startedAt = input.startedAt`.
  - Return `toTimeEntryDto(row)`.
- `updateTimeEntry(caller, id, patch)`:
  - **Device token must own the entry** (entry.userId === caller.userId) **or** the caller must be an admin/owner of the entry's org (the org-scope rule lives in the project the entry references).
  - **Cannot move `startedAt`** — only `endedAt`, `totalActiveSeconds`, `totalIdleSeconds`, `notes` are updatable.
  - **Cannot un-end an entry**. If `entry.endedAt` is non-null, `patch.endedAt` is ignored (or rejected with 409 — pick rejection for clarity).
  - Update fields, return DTO.
- `listTimeEntries(orgId, caller, query)`:
  - `caller.role === 'member'` → force `userId = caller.userId` regardless of what the query asks. Members only see their own entries.
  - Owners/admins → honor the query as-is.
  - Filter by `projectId`, `from`, `to`. Paginate with cursor (cursor encodes `(startedAt, id)`).
  - Embed the `project` and `user` slices for the dashboard view.

### DTOs

```ts
export interface TimeEntryDto {
  id: string;
  userId: string;
  projectId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  totalActiveSeconds: number;
  totalIdleSeconds: number;
  notes: string | null;
}
```

`toTimeEntryDto` lives in [`apps/api/src/lib/dto.ts`](../../apps/api/src/lib/dto.ts).

## `modules/screenshots/`

The big one. This is where the actual ingestion happens.

### Schemas (`screenshots/schemas.ts`)

```ts
import { z } from 'zod';

const isoDate = z
  .string()
  .datetime()
  .transform((s) => new Date(s));
const ContentType = z.enum(['image/jpeg', 'image/png', 'image/webp']);
const NonNegInt = (max: number) => z.number().int().min(0).max(max);

export const presignInput = z.object({
  timeEntryId: z.string().min(1),
  capturedAt: isoDate,
  monitorIndex: z.number().int().min(0).max(15),
  contentType: ContentType,
});
export type PresignInput = z.infer<typeof presignInput>;

export const confirmInput = z.object({
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  activeWindowTitle: z.string().max(500).nullable().optional(),
  activeApp: z.string().max(200).nullable().optional(),
  keyboardEventsCount: NonNegInt(1_000_000),
  mouseEventsCount: NonNegInt(1_000_000),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
});
export type ConfirmInput = z.infer<typeof confirmInput>;

export const listScreenshotsQuery = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type ListScreenshotsQuery = z.infer<typeof listScreenshotsQuery>;
```

### Routes (`screenshots/routes.ts`)

```
POST   /screenshots/presign              requireDevice() + idempotency()    body: presignInput
POST   /screenshots/:id/confirm          requireDevice() + idempotency()    body: confirmInput
GET    /orgs/:orgId/screenshots          requireAuth() + orgScope()         query: listScreenshotsQuery
GET    /screenshots/:id                  requireAuth()
DELETE /screenshots/:id                  requireAuth()
```

- **`requireDevice()`** is `requireAuth({ kinds: ['device'] })` — already shipped in Plan 02. Presign and confirm reject web tokens explicitly.
- **`/screenshots/:id` and `DELETE`** use `requireAuth()` (any token kind) but the service checks ownership / capability per [docs/08-auth-and-permissions.md:121-126](../../docs/08-auth-and-permissions.md#L121-L126).

### Service (`screenshots/service.ts`)

#### `presignScreenshot(caller, input)`

```
1. caller must be a device token (requireDevice gates the route, but assert again for safety).
2. Load the time entry by input.timeEntryId.
3. Verify entry.userId === caller.user.id AND entry.deviceId === caller.device.id.
4. Verify the entry is open OR was closed within the last 5 minutes.
5. Verify input.capturedAt is within sane bounds: not >7d old, not in the future >1m.
6. Generate screenshotId (ULID).
7. Compute originalKey via the helper from r2.md.
8. In one transaction:
   a. INSERT screenshots row with status='pending', s3Key=originalKey, monitorIndex,
      capturedAt, plus zero defaults for activity counters and dimensions
      (filled at confirm time).
   b. (No audit row — too noisy; we audit deletes only.)
9. Outside the transaction: presignPut(originalKey, contentType, 8 MB).
10. Return { screenshotId, putUrl, expiresAt }.
```

If the device token's `deviceId` somehow doesn't match `entry.deviceId`, return 403. This catches "user re-registered the same device but the desktop kept the old time entry id" — desktop should re-create the time entry; we won't paper over it.

#### `confirmScreenshot(caller, screenshotId, input)`

```
1. caller must be a device token.
2. Load the screenshot + its time entry.
3. Verify entry.userId === caller.user.id AND entry.deviceId === caller.device.id.
4. If status !== 'pending': return current row (idempotent re-confirm). Don't re-enqueue.
   This is belt-and-braces alongside the Idempotency-Key middleware.
5. Verify the object exists in R2 (head request). If not, 422 — desktop should retry presign+upload.
6. In one transaction:
   a. UPDATE screenshots SET status='uploaded', width, height, sizeBytes,
      activeWindowTitle, activeApp, keyboardEventsCount, mouseEventsCount.
   b. (No audit on confirm.)
7. Enqueue process-screenshot job with { screenshotId } (after the transaction commits).
8. Return updated DTO.
```

The order matters: enqueue **after** commit so a worker doesn't see a row that doesn't exist.

#### `listScreenshots(orgId, caller, query)`

Per-role filtering:

```
caller.role === 'member' → force userId = caller.user.id, ignore the query's userId.
caller.role === 'admin'  → honor the query, but constrain projectId to projects in this org.
caller.role === 'owner'  → same as admin.
```

Filter additionally by `projectId`, `from`/`to` on `capturedAt`, and `deletedAt IS NULL`.

Cursor pagination: cursor encodes `(capturedAt DESC, id)`. Default `limit = 50`, max `100`.

For each row, **presign a thumbnail GET URL** using `presignGetThumbnail(thumbnailS3Key)` if `thumbnailS3Key` is set. If not set (worker hasn't run yet), the response carries `thumbnailUrl: null` and the UI shows a placeholder.

Performance: don't sign URLs for rows the user can't see. Filter first, sign second.

#### `getScreenshot(caller, screenshotId)`

Capability check via `can(caller.membership, { type: 'screenshots:read', ownerUserId: entry.userId })`.

If the project has `blurScreenshots = true` and the caller is a member (not owner/admin), return the **blurred** full URL only — never the original. Otherwise, return both an original URL and (if it exists) the blurred URL, the caller's UI picks.

Returns:

```ts
{
  screenshot: ScreenshotDto,
  fullUrl: string,            // presigned 5-min GET on the appropriate object
  expiresAt: string,
}
```

#### `deleteScreenshot(caller, screenshotId)`

Per [docs/08-auth-and-permissions.md:123](../../docs/08-auth-and-permissions.md#L123):

- Owners/admins can delete any screenshot in their org.
- Members can delete their own, but only within a deletion grace window (default 60 minutes after `createdAt`). Expressed as `screenshots:delete` with `withinGrace: boolean`.

```
1. Load screenshot + entry + project.
2. Compute withinGrace = (now - createdAt) < 60 min.
3. can(caller.membership, { type: 'screenshots:delete', ownerUserId: entry.userId, withinGrace }).
4. In one transaction:
   a. UPDATE screenshots SET deletedAt = now() (soft delete; R2 cleanup is the retention worker's job).
   b. Audit screenshot.deleted with metadata { screenshotId, byCaller: caller.user.id }.
```

Returns 204.

### DTOs

```ts
export interface ScreenshotDto {
  id: string;
  timeEntryId: string;
  capturedAt: string;
  width: number;
  height: number;
  monitorIndex: number;
  activeWindowTitle: string | null;
  activeApp: string | null;
  keyboardEventsCount: number;
  mouseEventsCount: number;
  sizeBytes: number | null;
  blurred: boolean;
  status: ScreenshotStatus;
  createdAt: string;
}

export interface ScreenshotListItem {
  screenshot: ScreenshotDto;
  thumbnailUrl: string | null; // presigned, ~10min TTL; null until processed
  thumbnailExpiresAt: string | null;
}
```

The DTO **does not** carry `s3Key`, `thumbnailS3Key`, or `blurredS3Key`. Those are server-side details; clients see only presigned URLs.

## Wiring

Three routers, three lines added to `apps/api/src/modules/index.ts`:

```ts
import { authRouter } from './auth/routes.js';
import { devicesRouter } from './devices/routes.js'; // NEW
import { invitationsRouter } from './invitations/routes.js';
import { orgsRouter } from './orgs/routes.js';
import { projectsRouter } from './projects/routes.js';
import { screenshotsRouter } from './screenshots/routes.js'; // NEW
import { timeEntriesRouter } from './time-entries/routes.js'; // NEW

export const v1Routers: Router[] = [
  authRouter,
  orgsRouter,
  invitationsRouter,
  projectsRouter,
  devicesRouter,
  timeEntriesRouter,
  screenshotsRouter,
];
```

## Audit additions summary

Already in the union from Plan 02; this plan emits them:

- `device.registered` — on `POST /devices/register`
- `device.revoked` — on `DELETE /devices/:id`
- `screenshot.deleted` — on `DELETE /screenshots/:id`

No new audit actions needed.

# Screenshot Ingestion — Prisma Schema

The canonical schema lives in [docs/04-data-model.md](../../docs/04-data-model.md). This plan adds two models, one enum, and back-relations on three existing models. `Device` already exists from Plan 02; we don't change its shape, only add a back-relation field.

## Models added by this plan

- `TimeEntry`
- `Screenshot`

## Enums added by this plan

- `ScreenshotStatus`

## `TimeEntry` model

```prisma
model TimeEntry {
  id                 String    @id
  userId             String    @map("user_id")
  projectId          String    @map("project_id")
  deviceId           String    @map("device_id")
  startedAt          DateTime  @map("started_at")
  endedAt            DateTime? @map("ended_at")
  totalActiveSeconds Int       @default(0) @map("total_active_seconds")
  totalIdleSeconds   Int       @default(0) @map("total_idle_seconds")
  notes              String?

  user        User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  project     Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  device      Device       @relation(fields: [deviceId], references: [id])
  screenshots Screenshot[]

  @@index([userId, startedAt])
  @@index([projectId, startedAt])
  @@index([userId, endedAt])
  @@map("time_entries")
}
```

Differences from canonical [docs/04-data-model.md:201-220](../../docs/04-data-model.md#L201-L220):

- Added `@@index([userId, endedAt])` — needed for the "find user's open time entry" query (`WHERE userId = ? AND endedAt IS NULL`). Without it, Postgres scans every entry for the user; with it, the partial-null lookup is a single index probe.

`device` does **not** cascade on device delete (`onDelete` defaults to `Restrict`). A device with time entries is not hard-deletable; revoking it sets `revokedAt` instead.

## `Screenshot` model

```prisma
model Screenshot {
  id                  String           @id
  timeEntryId         String           @map("time_entry_id")
  capturedAt          DateTime         @map("captured_at")
  s3Key               String           @map("s3_key")
  thumbnailS3Key      String?          @map("thumbnail_s3_key")
  blurredS3Key        String?          @map("blurred_s3_key")
  width               Int
  height              Int
  monitorIndex        Int              @default(0) @map("monitor_index")
  activeWindowTitle   String?          @map("active_window_title")
  activeApp           String?          @map("active_app")
  keyboardEventsCount Int              @default(0) @map("keyboard_events_count")
  mouseEventsCount    Int              @default(0) @map("mouse_events_count")
  sizeBytes           Int?             @map("size_bytes")
  blurred             Boolean          @default(false)
  status              ScreenshotStatus @default(pending)
  deletedAt           DateTime?        @map("deleted_at")
  createdAt           DateTime         @default(now()) @map("created_at")

  timeEntry TimeEntry @relation(fields: [timeEntryId], references: [id], onDelete: Cascade)

  @@index([timeEntryId, capturedAt])
  @@index([status, createdAt])
  @@map("screenshots")
}
```

Differences from canonical [docs/04-data-model.md:222-244](../../docs/04-data-model.md#L222-L244):

- Added `blurredS3Key String?` to track the blurred-original object separately from the original. Per [docs/07-screenshot-pipeline.md:79-86](../../docs/07-screenshot-pipeline.md#L79-L86), projects with `blurScreenshots = true` get a blurred-full kept alongside the original.
- Added `sizeBytes Int?` (nullable, set on confirm). [docs/05-api-surface.md:118](../../docs/05-api-surface.md#L118) lists this in the confirm body.
- Added `@@index([status, createdAt])` — feeds the worker's "what's stuck in `pending` for too long?" reconciliation queries (the worker doesn't run yet but the index is cheap).

`status` transitions enforced at the application layer:

```
            presign           confirm           worker
   ──────────►  pending  ──────►  uploaded  ──────►  processed
                  │                                       ▲
                  │                                       │
                  └─── never directly ─────────────────────┘
                                                    worker (max retries)
                                                          │
                                                          ▼
                                                       failed
```

We never write `processed` from the request path; only the worker writes it. We never write `pending → failed` (rows in `pending` that never confirm are reconciliation candidates, not failures).

## `ScreenshotStatus` enum

```prisma
enum ScreenshotStatus {
  pending
  uploaded
  processed
  failed
}
```

## Required relation fields on existing models

Update `User`:

```prisma
model User {
  // ... existing fields ...
  memberships     Membership[]
  devices         Device[]
  tokens          Token[]
  invitationsSent Invitation[] @relation("InvitedBy")
  assignments     ProjectAssignment[]
  timeEntries     TimeEntry[]    // NEW
  // ...
}
```

Update `Project`:

```prisma
model Project {
  // ... existing fields ...
  organization Organization        @relation(fields: [orgId], references: [id], onDelete: Cascade)
  assignments  ProjectAssignment[]
  timeEntries  TimeEntry[]         // NEW
  // ...
}
```

Update `Device`:

```prisma
model Device {
  // ... existing fields ...
  user        User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  token       Token?
  timeEntries TimeEntry[]  // NEW
  // ...
}
```

## Migration sequence

One Prisma migration: `prisma migrate dev --name screenshot_ingestion`. Conceptual SQL order:

1. `CREATE TYPE "ScreenshotStatus" AS ENUM ('pending', 'uploaded', 'processed', 'failed');`
2. `CREATE TABLE time_entries (...)` with FKs to `users`, `projects` (CASCADE), `devices` (RESTRICT)
3. `CREATE TABLE screenshots (...)` with FK to `time_entries` (CASCADE)
4. Indexes:
   - `time_entries(user_id, started_at)`
   - `time_entries(project_id, started_at)`
   - `time_entries(user_id, ended_at)`
   - `screenshots(time_entry_id, captured_at)`
   - `screenshots(status, created_at)`

Apply to main DB, then test branch.

## `truncateAll()` helper update

Add the two new tables before the parent tables:

```ts
const TABLES = [
  'audit_logs',
  'tokens',
  'invitations',
  'screenshots', // NEW — child of time_entries
  'time_entries', // NEW — child of users / projects / devices
  'project_assignments',
  'projects',
  'memberships',
  'devices',
  'organizations',
  'users',
] as const;
```

`screenshots` truncates before `time_entries` (FK), which truncates before `users`, `projects`, and `devices` (FKs).

## Defaults & validation

Application-layer rules in the Zod schemas (see [modules.md](./modules.md)):

- **TimeEntry.startedAt**: ISO string, not in the future beyond a 1-minute clock-skew window. Zod refines to `Date`.
- **TimeEntry.totalActiveSeconds / totalIdleSeconds**: integers ≥ 0, max 86_400 (one day; sanity bound).
- **Screenshot.capturedAt**: ISO string, not more than 7 days old, not in the future beyond 1 minute.
- **Screenshot.width / height**: integers between 1 and 16_384 (8K's largest dimension; sanity bound).
- **Screenshot.monitorIndex**: integer ≥ 0, max 15 (no realistic 16+ monitor setups).
- **Screenshot.keyboardEventsCount / mouseEventsCount**: integers ≥ 0, max 1_000_000 (sanity bound for a 10-min window).
- **Screenshot.sizeBytes**: integer between 1 and 8 _ 1024 _ 1024 (8 MB cap).
- **Screenshot contentType (presign body, not stored)**: enum `image/jpeg | image/png | image/webp`.

## Things to double-check before applying

- **Time entries are never hard-deleted.** Per [docs/04-data-model.md:294](../../docs/04-data-model.md#L294), they're the financial record. The cascades from User/Project/Device are application concerns we shouldn't trigger casually; soft-delete is the path.
- **Screenshots cascade from `TimeEntry`** but the time entry itself rarely deletes. The cascade is a defense for org-delete, not a normal flow.
- **`screenshots.s3Key` is unique by construction** (ULID-based), but we don't add a UNIQUE constraint — there's no query that benefits from it, and an accidental duplicate in the DB would only cost one wasted R2 object.
- **Composite indexes match the listing query shape:**
  - "Show me screenshots for time entry X in capture order" → `(time_entry_id, captured_at)` — used by the time-entry detail view.
  - "Show me time entries for user U sorted by start" → `(user_id, started_at)` — used by the user dashboard.
  - "Show me time entries for project P sorted by start" → `(project_id, started_at)` — used by the project detail view.
    Anything else (filtering by `endedAt IS NULL` for "open entries") is covered by `(user_id, ended_at)`.
- **`size_bytes` nullability**: `null` while `status = pending`, set on confirm. Don't gate listings on it.

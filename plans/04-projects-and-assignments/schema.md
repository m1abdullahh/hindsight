# Projects & Assignments — Prisma Schema

The canonical schema lives in [docs/04-data-model.md](../../docs/04-data-model.md). This plan adds two models and one new relation field on existing models.

## Models added by this plan

- `Project`
- `ProjectAssignment`

## Models intentionally **not** in this plan

- `TimeEntry` — Plan 05 (it references `Project`, but the FK is added when `TimeEntry` lands)
- `Screenshot` — Plan 05

## `Project` model

```prisma
model Project {
  id                        String    @id
  orgId                     String    @map("org_id")
  name                      String
  description               String?
  screenshotIntervalMinutes Int       @default(10) @map("screenshot_interval_minutes")
  blurScreenshots           Boolean   @default(false) @map("blur_screenshots")
  archivedAt                DateTime? @map("archived_at")
  createdBy                 String    @map("created_by")
  createdAt                 DateTime  @default(now()) @map("created_at")

  organization Organization        @relation(fields: [orgId], references: [id], onDelete: Cascade)
  assignments  ProjectAssignment[]

  @@index([orgId])
  @@index([orgId, archivedAt])
  @@map("projects")
}
```

Differences from the canonical schema in [docs/04-data-model.md:166-183](../../docs/04-data-model.md#L166-L183):

- `timeEntries TimeEntry[]` is **not** in this plan's schema. Plan 05 adds the back-relation when it adds `TimeEntry`.
- Added `@@index([orgId, archivedAt])` — the project list query filters by both, so a composite index keeps the default "active projects" query fast.

`createdBy` is a `String` referencing `users.id` but **without** a Prisma relation. We do the same trick Plan 03 used for `Invitation.acceptedBy`: integrity is application-layer, no FK gets in the way of soft-deleting users in the rare case we need to.

## `ProjectAssignment` model

```prisma
model ProjectAssignment {
  id              String    @id
  projectId       String    @map("project_id")
  userId          String    @map("user_id")
  hourlyRateCents Int?      @map("hourly_rate_cents")
  assignedAt      DateTime  @default(now()) @map("assigned_at")
  removedAt       DateTime? @map("removed_at")

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@index([userId])
  @@index([projectId, removedAt])
  @@map("project_assignments")
}
```

Differences from canonical:

- Added `@@index([projectId, removedAt])` — the "list active assignees of this project" query uses both columns; this index keeps it sub-millisecond.
- `@@unique([projectId, userId])` is **without** the `removedAt` discriminator. Soft-removed rows still count for uniqueness — re-assigning flips `removedAt` back to `null` rather than inserting a new row. This avoids accumulating a row per assign/remove cycle.

## Required relation fields on existing models

Update `Organization`:

```prisma
model Organization {
  // ... existing fields ...
  memberships Membership[]
  invitations Invitation[]
  auditLogs   AuditLog[]
  projects    Project[]              // NEW
  // ...
}
```

Update `User`:

```prisma
model User {
  // ... existing fields ...
  memberships     Membership[]
  devices         Device[]
  tokens          Token[]
  invitationsSent Invitation[] @relation("InvitedBy")
  assignments     ProjectAssignment[]  // NEW
  // ...
}
```

`User.assignments` is the back-relation Prisma needs for the `ProjectAssignment.user` foreign key. Same for `Organization.projects`.

## Migration sequence

One Prisma migration: `prisma migrate dev --name projects_and_assignments`. Conceptual SQL order:

1. `CREATE TABLE projects (...)` with FK to `organizations(id) ON DELETE CASCADE`
2. `CREATE TABLE project_assignments (...)` with FKs to `projects(id) ON DELETE CASCADE` and `users(id) ON DELETE CASCADE`
3. Indexes:
   - `projects(org_id)`
   - `projects(org_id, archived_at)`
   - `project_assignments(project_id, user_id) UNIQUE`
   - `project_assignments(user_id)`
   - `project_assignments(project_id, removed_at)`

Migration is forward-only; rolling back means writing a down migration that drops both tables. Tests in CI re-apply against a clean test branch every run.

## `truncateAll()` helper update

Order matters because of foreign keys. Add the two new tables **before** `users` and `organizations`:

```ts
const TABLES = [
  'audit_logs',
  'tokens',
  'invitations',
  'project_assignments', // NEW
  'projects', // NEW
  'memberships',
  'devices',
  'organizations',
  'users',
] as const;
```

`project_assignments` truncates before `projects` because of the FK; `projects` truncates before `organizations` for the same reason. `TRUNCATE ... CASCADE` makes the order forgiving, but listing the dependents first is clearer and matches Plan 02/03's convention.

## Defaults & validation

Application-layer rules enforced in the Zod schemas (see [modules.md](./modules.md)):

- `name`: trimmed, 1–100 chars
- `description`: trimmed, max 2000 chars (nullable on input)
- `screenshotIntervalMinutes`: integer between 1 and 60 (the realistic capture-cadence band; 1 minute floor avoids accidental DOS of the worker, 60 ceiling avoids "we forgot to capture for hours" surprises)
- `blurScreenshots`: boolean
- `hourlyRateCents` (assignment): integer ≥ 0, max 1_000_000_00 (= $1,000,000.00 — anything beyond that is a typo)

The DB enforces nothing beyond NOT NULL and the unique index. Range checks live in Zod where the error messages can be useful.

## Things to double-check before applying

- The `@@unique([projectId, userId])` index lets Postgres treat re-adds as upserts (`ON CONFLICT (project_id, user_id) DO UPDATE`). Use that in the assignment service rather than "SELECT then INSERT" to avoid a race where two parallel adds for the same `(project, user)` collide.
- `Organization.deletedAt` cascades to `Project` via `onDelete: Cascade`. Soft-deleting an org is currently not exposed (no endpoint), but if it ever is, projects inherit the soft delete via the FK chain — confirm before any "delete org" feature lands.
- `archivedAt` is **not** the same as `deletedAt`. Archived projects still appear in admin lists if they explicitly ask for them (`?includeArchived=true`); soft-deleted ones never would. We're not modeling soft-delete for projects in this plan.

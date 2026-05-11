# 04 — Data Model

## Conventions

- Primary keys are `id` columns of type `String`, populated by ULIDs at the application layer (sortable + URL-safe).
- All timestamps are `DateTime` in UTC. Names end in `_at` (snake) / `At` (camel).
- Soft deletes use `deleted_at` (nullable). Hard deletes are reserved for retention sweeps.
- Every tenant-scoped table carries an `org_id` foreign key. **Every query filters by `org_id`.** No exceptions.
- Money is stored as integer cents in a `*_cents` column. Never floats.
- Booleans default to `false` and are non-nullable.

## Entity-relationship summary

```
organizations ──< memberships >── users
      │                              │
      ├──< invitations               │
      ├──< projects                  │
      │      └──< project_assignments >── (users)
      │             └──< time_entries     │
      │                    └──< screenshots
      │                                 ▲
      └──< devices >── users ───────────┘
              ▲
              └── (screenshots reference originating device)

audit_log (org-scoped, not shown above)
```

## Prisma schema (canonical)

```prisma
// schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Organization {
  id        String   @id
  name      String
  slug      String   @unique
  plan      String   @default("internal")
  createdAt DateTime @default(now()) @map("created_at")
  deletedAt DateTime? @map("deleted_at")

  memberships       Membership[]
  invitations       Invitation[]
  projects          Project[]
  auditLogs         AuditLog[]

  @@map("organizations")
}

model User {
  id              String   @id
  email           String   @unique
  passwordHash    String?  @map("password_hash")
  name            String
  emailVerifiedAt DateTime? @map("email_verified_at")
  createdAt       DateTime @default(now()) @map("created_at")
  deletedAt       DateTime? @map("deleted_at")

  memberships Membership[]
  devices     Device[]
  assignments ProjectAssignment[]
  timeEntries TimeEntry[]
  tokens      Token[]

  @@map("users")
}

model Membership {
  id        String   @id
  orgId     String   @map("org_id")
  userId    String   @map("user_id")
  role      Role
  status    MembershipStatus @default(active)
  createdAt DateTime @default(now()) @map("created_at")

  organization Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([orgId, userId])
  @@index([userId])
  @@map("memberships")
}

enum Role {
  owner
  admin
  member
}

enum MembershipStatus {
  active
  suspended
}

model Invitation {
  id         String   @id
  orgId      String   @map("org_id")
  email      String
  role       Role
  tokenHash  String   @unique @map("token_hash")
  invitedBy  String   @map("invited_by")
  expiresAt  DateTime @map("expires_at")
  acceptedAt DateTime? @map("accepted_at")
  createdAt  DateTime @default(now()) @map("created_at")

  organization Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@index([orgId, email])
  @@map("invitations")
}

model Token {
  id         String    @id
  userId     String    @map("user_id")
  kind       TokenKind
  tokenHash  String    @unique @map("token_hash")
  deviceId   String?   @unique @map("device_id")   // set only when kind = device
  expiresAt  DateTime? @map("expires_at")           // null for device tokens (no expiry by time)
  lastUsedAt DateTime? @map("last_used_at")
  createdAt  DateTime  @default(now()) @map("created_at")
  revokedAt  DateTime? @map("revoked_at")
  userAgent  String?   @map("user_agent")
  ipAddress  String?   @map("ip_address")

  user   User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  device Device? @relation(fields: [deviceId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([kind, revokedAt])
  @@map("tokens")
}

enum TokenKind {
  web
  device
}

model Device {
  id         String    @id
  userId     String    @map("user_id")
  deviceName String    @map("device_name")
  os         String
  appVersion String    @map("app_version")
  lastSeenAt DateTime? @map("last_seen_at")
  createdAt  DateTime  @default(now()) @map("created_at")
  revokedAt  DateTime? @map("revoked_at")

  user        User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  token       Token?
  timeEntries TimeEntry[]

  @@index([userId])
  @@map("devices")
}

model Project {
  id                        String   @id
  orgId                     String   @map("org_id")
  name                      String
  description               String?
  screenshotIntervalMinutes Int      @default(10) @map("screenshot_interval_minutes")
  blurScreenshots           Boolean  @default(false) @map("blur_screenshots")
  archivedAt                DateTime? @map("archived_at")
  createdBy                 String   @map("created_by")
  createdAt                 DateTime @default(now()) @map("created_at")

  organization Organization        @relation(fields: [orgId], references: [id], onDelete: Cascade)
  assignments  ProjectAssignment[]
  timeEntries  TimeEntry[]

  @@index([orgId])
  @@map("projects")
}

model ProjectAssignment {
  id              String   @id
  projectId       String   @map("project_id")
  userId          String   @map("user_id")
  hourlyRateCents Int?     @map("hourly_rate_cents")
  assignedAt      DateTime @default(now()) @map("assigned_at")
  removedAt       DateTime? @map("removed_at")

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@index([userId])
  @@map("project_assignments")
}

model TimeEntry {
  id                 String   @id
  userId             String   @map("user_id")
  projectId          String   @map("project_id")
  deviceId           String   @map("device_id")
  startedAt          DateTime @map("started_at")
  endedAt            DateTime? @map("ended_at")
  totalActiveSeconds Int      @default(0) @map("total_active_seconds")
  totalIdleSeconds   Int      @default(0) @map("total_idle_seconds")
  notes              String?

  user        User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  project     Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  device      Device       @relation(fields: [deviceId], references: [id])
  screenshots Screenshot[]

  @@index([userId, startedAt])
  @@index([projectId, startedAt])
  @@map("time_entries")
}

model Screenshot {
  id                  String   @id
  timeEntryId         String   @map("time_entry_id")
  capturedAt          DateTime @map("captured_at")
  s3Key               String   @map("s3_key")
  thumbnailS3Key      String?  @map("thumbnail_s3_key")
  width               Int
  height              Int
  monitorIndex        Int      @default(0) @map("monitor_index")
  activeWindowTitle   String?  @map("active_window_title")
  activeApp           String?  @map("active_app")
  keyboardEventsCount Int      @default(0) @map("keyboard_events_count")
  mouseEventsCount    Int      @default(0) @map("mouse_events_count")
  blurred             Boolean  @default(false)
  status              ScreenshotStatus @default(pending)
  deletedAt           DateTime? @map("deleted_at")
  createdAt           DateTime @default(now()) @map("created_at")

  timeEntry TimeEntry @relation(fields: [timeEntryId], references: [id], onDelete: Cascade)

  @@index([timeEntryId, capturedAt])
  @@map("screenshots")
}

enum ScreenshotStatus {
  pending
  uploaded
  processed
  failed
}

model AuditLog {
  id         String   @id
  orgId      String   @map("org_id")
  actorId    String?  @map("actor_id")
  action     String
  targetType String?  @map("target_type")
  targetId   String?  @map("target_id")
  metadata   Json?
  createdAt  DateTime @default(now()) @map("created_at")

  organization Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@index([orgId, createdAt])
  @@map("audit_logs")
}
```

## Indexes worth thinking about

- `screenshots(time_entry_id, captured_at)` — primary access pattern: "show me screenshots for this time entry, in order."
- `time_entries(user_id, started_at)` — timesheet queries.
- `time_entries(project_id, started_at)` — project hours rollups.
- `audit_logs(org_id, created_at)` — admin audit views.
- `memberships(org_id, user_id)` UNIQUE — prevents duplicate memberships, supports "is this user in this org?" lookups.

### Reporting access patterns

- **Time totals** (`GET /orgs/:orgId/reports/time-totals`) runs
  `prisma.timeEntry.groupBy({ by: ['userId', 'projectId'] })` filtered by
  `project.orgId` and an optional `startedAt` window. The composite indexes
  `time_entries(user_id, started_at)` and `time_entries(project_id, started_at)`
  already cover the range filter; the group-by itself is a small in-memory
  aggregation. No new index needed.
- **Earned-money calculation** reads `project_assignments.hourly_rate_cents`
  for each `(projectId, userId)` pair present in the aggregation. We use the
  _current_ (or last-known) rate per assignment; rate history is not modelled
  in v1. If billing-grade rate-history is needed, a separate
  `assignment_rate_history` table becomes required — see Plan 09 for the
  decision record.

## Things deliberately not in the schema

- **No `passwords` table.** Hash lives on the `users` row.
- **No separate `roles` table.** Three values, enum, done. If we ever need custom roles, this changes.
- **No `team` or `group` table.** Projects are the unit of grouping.
- **No `tags` on screenshots.** YAGNI.
- **No `comments`.** Same.
- **No separate `sessions` table.** Web logins and desktop devices both authenticate with bearer tokens; both kinds live in the unified `tokens` table, distinguished by `kind`.

## Retention

A scheduled worker runs daily and:

1. Hard-deletes `screenshots` rows where `deleted_at < now() - 30d`.
2. Hard-deletes screenshot objects from R2 for the same set.
3. Archives `audit_logs` older than 1 year to cold storage (deferred).

Default screenshot retention is **90 days**, configurable per org later. We never delete `time_entries`; those are the financial record.

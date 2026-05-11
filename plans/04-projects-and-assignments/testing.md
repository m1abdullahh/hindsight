# Projects & Assignments — Testing

Two layers, same shape as Plan 02 / 03:

1. **Capability matrix unit tests** — extended in [`apps/api/src/auth/capabilities.test.ts`](../../apps/api/src/auth/capabilities.test.ts), pure, no DB
2. **Integration tests** for every endpoint, real DB, real bearer auth

## Capability matrix tests

Already specified in [capabilities.md](./capabilities.md#capability-matrix-tests) — 12 new cases plus 2–3 suspended-status cases.

## Integration test files

Two new files. The `truncateAll()` helper update from [schema.md](./schema.md#truncateall-helper-update) lands as part of step 1.

- `test/projects.test.ts` — project CRUD, archive toggle, list filtering, cross-org isolation
- `test/project-assignments.test.ts` — assignment add/remove/reactivate, hourly rate updates, member visibility into assignments

## Setup helpers

The existing `signup` and `inviteAsMember`-style helpers from [`test/orgs.test.ts`](../../apps/api/test/orgs.test.ts) and [`test/invitations.test.ts`](../../apps/api/test/invitations.test.ts) cover the fixtures. Plan 04 adds one more:

```ts
const createProject = async (
  ownerToken: string,
  orgId: string,
  body: { name?: string; screenshotIntervalMinutes?: number; blurScreenshots?: boolean } = {},
): Promise<{ id: string; name: string }> => {
  const app = makeTestApp();
  const res = await request(app)
    .post(`/api/v1/orgs/${orgId}/projects`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ name: body.name ?? 'Project A', ...body });
  if (res.status !== 201) throw new Error(`createProject failed: ${res.status}`);
  return { id: res.body.id, name: res.body.name };
};
```

## `test/projects.test.ts`

### Happy paths

- **Owner creates a project** → 201 with `archivedAt: null`, `createdBy: ownerUserId`. The `audit_logs` row has `action: 'project.created'` with `targetId` set.
- **Admin creates a project** → 201 (same as owner).
- **Owner gets a project** by id → 200, returns the project DTO.
- **Owner updates a project** (`PATCH`) with `{ name, screenshotIntervalMinutes }` → 200, fields updated, `project.updated` audit row written with `metadata.fields = ['name', 'screenshotIntervalMinutes']`.
- **Owner archives** (`POST /:id/archive`) → 200, `archivedAt` non-null. Un-archives (`DELETE /:id/archive`) → 200, `archivedAt: null`. Two audit rows: `project.archived`, `project.unarchived`.
- **Admin lists projects** in org → returns all non-archived. Re-list with `?includeArchived=true` → includes archived ones.
- **Member assigned to a project** sees it in `GET /orgs/:orgId/projects`. Project they're not assigned to is **not** in the list.
- **Member assigned** → `GET /projects/:id` returns 200.
- **Member NOT assigned** → `GET /projects/:id` returns 403.

### Edge cases

- **Member tries to create** → 403.
- **Member tries to update / archive / un-archive** → 403.
- **Update with empty body** → 422 (Zod refines: must include at least one field).
- **Cross-org isolation:** owner of org A creates a project; user in org B tries `GET /projects/:id` → 403 (`projectScope` rejects).
- **Project not found** (random ULID) on any of the `/projects/:id/*` routes → 404.
- **Update with out-of-range `screenshotIntervalMinutes`** (0, 61, -5, 1.5) → 422.
- **List filtering** is **SQL-level**, not post-filter. Verify by creating 3 projects in an org, assigning a member to 1, and asserting the member's list response has length 1.
- **Suspended membership:** owner suspends a member; that member's list returns 403 (the `orgScope` middleware should reject suspended memberships per [docs/08-auth-and-permissions.md:88-92](../../docs/08-auth-and-permissions.md#L88-L92)).
- **Audit assertions** on each privileged action: `project.created`, `project.updated`, `project.archived`, `project.unarchived`. Each row has `actorId === caller.userId`.

## `test/project-assignments.test.ts`

### Happy paths

- **Admin assigns a member** to a project → 201 with `removedAt: null`, `hourlyRateCents: null` if not provided. Audit `project.assignment_added`.
- **Admin assigns a member with `hourlyRateCents: 5000`** → 201, value stored as integer cents.
- **Admin updates rate** (`PATCH`) → 200, `hourlyRateCents` updated. Audit `project.assignment_updated`.
- **Admin removes** (`DELETE`) → 204, `removedAt` non-null on subsequent read.
- **Re-add after remove** (same `(projectId, userId)`) → 201. The DB row is the **same row** (`@@unique([projectId, userId])`), `removedAt` flipped to `null`. Verify by checking `id` is unchanged.
- **Member calling `GET /projects/:id/assignments`** for a project they're on → 200 with the full list (per Plan 04 README decision: members see who else is on a project they're on).

### Edge cases

- **Add an assignment for a user who is not a member of the project's org** → 422 with a clear message ("user is not a member of this org").
- **Add an already-active assignment** (same `userId`, `removedAt = null`) → 409.
- **Remove an already-removed assignment** → 409.
- **Update rate on a removed assignment** → 409 (or 404 — pick one and stick to it; suggest 409 for symmetry).
- **Member tries to add an assignment** → 403.
- **Member tries to update/remove an assignment** → 403.
- **Member of a project tries to list assignments** for a project they're NOT on → 403 (`projectScope` allows org membership; service layer rejects via `projects:read`).
- **`hourlyRateCents` validation:** negative number, non-integer, > 1_000_000_00 → 422.
- **Cross-org isolation:** assignment endpoints reject when caller is in a different org than the project.
- **Audit assertions** on each privileged action.

### Concurrency edge case

- **Two parallel `POST /projects/:id/assignments`** with the same `userId` (use `Promise.all`) → exactly one returns 201, the other returns 409. The `@@unique([projectId, userId])` index makes this deterministic.

## What we explicitly don't test

- **Pagination** — not in this plan; the list endpoint returns everything.
- **Search/filter on project name** — not in this plan.
- **Performance** — no P95 thresholds. The composite indexes specified in [schema.md](./schema.md) are the bet; we don't measure them in tests.
- **Hourly-rate change history** — current value only, no audit trail beyond `project.assignment_updated`.

## Coverage target

Same stance as Plans 02–03: **at least one happy path per endpoint**, plus the listed edge cases. No coverage-percentage threshold.

## Skip criteria

- Integration tests still wrapped in `describe.skipIf(!process.env['CI'] && !(await isDbReachable()))` so a developer with no `TEST_DATABASE_URL` configured can still run capability tests via `pnpm vitest capabilities`.

## After this plan

The next plan (Plan 05 — Screenshot Ingestion) will add `TimeEntry` referencing both `Project` and `User`, plus `Screenshot` referencing `TimeEntry`. The schema additions in this plan are designed so Plan 05's relations land cleanly:

- `Project.timeEntries TimeEntry[]` is the back-relation Plan 05 will add.
- The `project_assignments(project_id, user_id) UNIQUE` index doubles as the integrity check Plan 05 needs ("does this user have an active assignment to this project at start-time?").

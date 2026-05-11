# Plan 04 — Projects & Assignments

> Roadmap milestone: **v0.3 Projects & assignments** ([docs/10-roadmap.md:31-37](../../docs/10-roadmap.md#L31-L37))
> Priority bucket: **P1** (depends on Plan 02 + 03; blocks Plan 05)

## Goal

Land the project model and the user-to-project assignment join table. After this plan, an owner/admin can create a project, edit it, archive it, and assign / unassign members. Members see only the projects they're assigned to. The screenshot ingestion plan (v0.4) attaches `time_entries` and `screenshots` to a `Project`, so this plan is on the critical path for everything that follows.

This is a **smaller** plan than 02 or 03 — no email, no HIBP, no throttle. Just CRUD, an assignment join table, capability checks, and audits.

## Source-of-truth references

- Data model (Project + ProjectAssignment + indexes): [docs/04-data-model.md:166-199](../../docs/04-data-model.md#L166-L199)
- API surface (project + assignment endpoints): [docs/05-api-surface.md:59-76](../../docs/05-api-surface.md#L59-L76)
- Capability matrix (assigned-vs-not-assigned reads, archive permissions): [docs/08-auth-and-permissions.md:111-126](../../docs/08-auth-and-permissions.md#L111-L126)
- Audit actions earmarked: [docs/08-auth-and-permissions.md:171](../../docs/08-auth-and-permissions.md#L171)
- Glossary terms (project, assignment, archive): [docs/11-glossary.md](../../docs/11-glossary.md)

## Decisions captured here (not implementation yet)

1. **Two URL shapes.** Project create/list lives under `/orgs/:orgId/projects` (org-scoped, follows the orgs/invitations pattern). Project detail/update/assignment endpoints live under `/projects/:projectId` (no `:orgId` in path — we resolve `orgId` from the project row and gate via the same `orgScope`-style middleware). This matches [docs/05-api-surface.md:59-76](../../docs/05-api-surface.md#L59-L76) verbatim.
2. **A new middleware `projectScope`.** Mirrors `orgScope` but takes `:projectId`, loads the project, ensures the caller has an active membership in the project's org, attaches both `req.caller.membership` and `req.caller.project`. Routes that already use `orgScope` keep using it; the `projectScope` cases are the `/projects/:projectId/...` family.
3. **Archive is a soft state, not a delete.** `archivedAt` toggles via `POST /projects/:id/archive` and `DELETE /projects/:id/archive` (per the API doc). Archived projects don't show in default lists; they still own their existing time entries and screenshots. **Hard delete is _not_ shipped in this plan** — we reserve `DELETE /projects/:id` for a later milestone where retention rules are clear.
4. **Assignments are a soft join.** The `project_assignments` row carries `assignedAt` and `removedAt`. Removing an assignment sets `removedAt` rather than deleting the row, so historical time entries can still resolve who was assigned when. Re-assignment to the same `(projectId, userId)` flips `removedAt` back to `null` rather than creating a duplicate row — the unique index is `(projectId, userId)`.
5. **Hourly rate is optional.** `hourlyRateCents` lives on the assignment row (per [docs/04-data-model.md:189](../../docs/04-data-model.md#L189)). It's `null` until set. The PATCH endpoint can update it; the model is positioned for billing reports later but no logic in this plan computes anything from it.
6. **Capability: `projects:read` is a discriminated branch.** Owners and admins read every project in the org. Members read only those where there's an active assignment. The `can()` matrix from Plan 02 already sketched this branch; this plan wires a real `assignedToCaller` boolean computed in the service.
7. **List endpoint filters by role at the SQL layer**, not by post-filter. `GET /orgs/:orgId/projects` joins `project_assignments` for member callers so the DB returns only assigned projects. Avoids "load 1000, drop 999".
8. **Member can read a project they're assigned to**, including its assignment list. The "view all assignments" power gates write only — every active member can see who else is on a project they're on. Removing an assignee whom they share a project with requires admin/owner.
9. **Cannot remove the last admin/owner from a project.** Wait — projects don't _have_ admins. Anyone in the org can be assigned, regardless of org-role. So there's **no** "last assignee" rule. Empty assignment list is fine; archived projects often look like that.
10. **Audit rows write inside the action's transaction**, same convention as Plan 02/03. Five new actions get lit up: `project.created`, `project.archived`, `project.deleted` (reserved), `project.assignment_added`, `project.assignment_removed`. They were already in the `AuditAction` union — Plan 04 just emits them.

## Out of scope for this plan (deferred)

- **Hard `DELETE /projects/:id`** — needs retention/archive policy decisions
- **Default screenshot interval / blur defaults at the org level** — projects override defaults per [docs/04-data-model.md:171-172](../../docs/04-data-model.md#L171-L172) but org-level defaults aren't part of this plan
- **Bulk assignment endpoints** ("assign 10 users at once") — single-user adds are enough for now
- **Project list pagination** — projects per org are bounded (rarely >100); add `?limit=&cursor=` later if a real org needs it
- **Members' own "my projects" endpoint** — `GET /orgs/:orgId/projects` already filters per role; no separate route needed
- **Hourly-rate change history** — current value only; if pay rates need an audit trail, that's a separate model

## Files in this plan

- [schema.md](./schema.md) — `Project` and `ProjectAssignment` Prisma additions, migration sequencing, index notes
- [modules.md](./modules.md) — routes / schemas / handlers / service for the new module
- [capabilities.md](./capabilities.md) — wiring the existing `projects:*` capability branches, new `projectScope` middleware, capability tests this plan adds
- [testing.md](./testing.md) — happy paths and edge cases per endpoint, including archive toggling and re-assignment

## Ordered execution checklist

1. **Schema migration.** Add `Project` and `ProjectAssignment` models + relations on `Organization` and `User`. `prisma migrate dev --name projects_and_assignments`. Run `pnpm db:test:migrate` against the test branch.
2. **Update `truncateAll()` test helper** to include `project_assignments` and `projects` (in that order — assignments first because of the FK).
3. **Add `projectScope` middleware.** `apps/api/src/middleware/project-scope.ts`. Loads `project` by `:projectId`, finds caller's membership in the project's org, throws 403 if absent. Attaches `req.caller.project` and `req.caller.membership`.
4. **Tighten the express type augmentation** to optionally include `project: Project` on `req.caller`.
5. **Wire `projects:read` and the new `projects:assign_members` action** into `auth/capabilities.ts`. The existing `projects:read` branch needs a real `assignedToCaller` argument; add it.
6. **Projects module:** `src/modules/projects/` — `routes.ts`, `schemas.ts`, `handlers.ts`, `service.ts`. Endpoints listed in [modules.md](./modules.md).
7. **Wire `projectsRouter`** into `apps/api/src/modules/index.ts` (one line).
8. **Tests:** capability matrix additions, project CRUD + archive toggle, assignment add/remove/reactivate, list filtering by role, cross-org isolation, audit assertions.
9. **Lint, typecheck, test all green** before merging.

## Done when

- An owner or admin can `POST /api/v1/orgs/:orgId/projects` and the project shows up in `GET /api/v1/orgs/:orgId/projects` for every active member of the org.
- An admin can `POST /api/v1/projects/:id/assignments` with `{ userId }` and the assignment row is created.
- A member calling `GET /api/v1/orgs/:orgId/projects` sees only projects they're assigned to (DB-filtered, not post-filtered).
- A member calling `GET /api/v1/projects/:id` returns 200 if they're assigned, 403 otherwise.
- `POST /api/v1/projects/:id/archive` sets `archivedAt`, `DELETE /.../archive` clears it.
- `DELETE /api/v1/projects/:id/assignments/:userId` sets `removedAt`. Re-adding the same assignment flips it back to `null` (no duplicate row).
- Capability matrix tests cover every `(role × projects-action)` cell, including `projects:read` with `assignedToCaller=true|false`.
- `pnpm typecheck` and `pnpm test` pass against the whole workspace; the test branch picks up the new migration.

# Plan 07 — Web: Projects & Assignments

> Roadmap milestone: **v0.3 Projects & assignments** ([docs/10-roadmap.md:31-37](../../docs/10-roadmap.md#L31-L37)) — the web-app side of it
> Priority bucket: **P1** (depends on Plan 04 server-side and Plan 06 web scaffold; the time-entries / screenshot-grid pieces ship in Plan 08)

## Goal

Add the projects layer to the Plan 06 web app. After this plan, an owner/admin can create projects, edit their settings (interval, blur), archive/unarchive them, and add or remove assigned members with optional hourly rates. Members see only the projects they're assigned to and can browse project details (read-only).

This is a **purely additive** plan — the route shell, layouts, sidebar, capability hook, and API client all exist from Plan 06. Plan 07 only adds: three new page files, a handful of `useCan` actions, two sidebar links, and one new query-key family. No scaffolding work.

The API side ([Plan 04](../04-projects-and-assignments/)) is already complete — every endpoint Plan 07 consumes is already shipped, tested, and audited.

## Source-of-truth references

- Server-side plan this builds on: [plans/04-projects-and-assignments/](../04-projects-and-assignments/)
- API surface (project + assignment endpoints): [docs/05-api-surface.md:56-73](../../docs/05-api-surface.md#L56-L73)
- Capability matrix: [docs/08-auth-and-permissions.md:109-126](../../docs/08-auth-and-permissions.md#L109-L126)
- Web scaffold this builds on: [plans/06-web-app/](../06-web-app/)
- Project DTO shape: [packages/shared/src/dto.ts](../../packages/shared/src/dto.ts)

## Pre-implementation verification (do these before building)

Three open questions to confirm against the API source. If any answer reveals a gap, **add the missing piece to the API** rather than working around it on the client (same posture as Plan 06).

1. **Does `GET /projects/:projectId/assignments` return joined user data per row?** The pages need `{ assignment, user }` to render names + emails next to assignment rows. Check [`apps/api/src/modules/projects/service.ts`](../../apps/api/src/modules/projects/service.ts) — the `listAssignments` function. If it returns assignments alone, add an `include: { user: true }` and update the DTO so each row carries a `user: UserDto`.
2. **Does the project list endpoint accept an `?includeArchived=true` query?** Plan 04's [modules.md:54-59](../04-projects-and-assignments/modules.md#L54-L59) describes a `listProjectsQuery` schema with this flag. Verify it's wired in `routes.ts`. Without it, the "Active / Archived" tab in the projects list page can't filter.
3. **Does `PATCH /projects/:projectId/assignments/:userId` exist for hourly-rate updates?** Plan 04's [modules.md:24](../04-projects-and-assignments/modules.md#L24) added it explicitly beyond the API doc. Verify it's mounted. If missing, the rate column on the assignments table is read-only.

If any of those gaps surface, add them as a tiny Plan 07 API extension step (mirrors Plan 06's pattern: `details.requires` + `PATCH /auth/me`).

## Decisions captured here (not implementation yet)

1. **Three new pages.** Projects list (`/orgs/:orgId/projects`), project detail (`/orgs/:orgId/projects/:projectId`), assignments tab (`/orgs/:orgId/projects/:projectId/members`). The detail and assignments tab share a layout (project name + tabs).
2. **Active/archived split via URL param.** `/orgs/:orgId/projects?archived=true` shows archived; default is active-only. Validated via TanStack Router's `validateSearch`. Bookmarkable, back-button friendly.
3. **No project list pagination.** Per [Plan 04 README:38](../04-projects-and-assignments/README.md#L38), the projects-per-org count is bounded; pagination is unnecessary for v0.x. Revisit if a real org hits 100+ projects.
4. **Member-role users see member-scoped data, server-filtered.** The list endpoint returns only assigned projects for members (no client-side filtering). The detail page 403s for unassigned members; we surface that as "You don't have access to this project" rather than 404.
5. **Capability hook gains four new actions** mapped to Plan 04's matrix:
   - `projects:create` — owner/admin
   - `projects:update` — owner/admin (edit name, interval, blur)
   - `projects:archive` — owner/admin (toggle archivedAt)
   - `projects:assign_members` — owner/admin (add/remove/rate-update assignments)
     These all collapse to "owner or admin" in the role-only check. The web `useCan` hook gets new union members; server already enforces.
6. **Assignment list shows BOTH assigned and removed members** when a "Show removed" toggle is checked. Default: hide removed. Removed rows render greyed out with `removedAt` timestamp and a "Re-add" button (which POSTs to `/assignments` with the same `userId` — the API flips `removedAt` back to null per [Plan 04 modules.md:195](../04-projects-and-assignments/modules.md#L195)).
7. **Hourly rate stored as integer cents in the DB**, displayed and edited as a decimal dollar amount in the UI. Helper: `centsToDollars(c)` and `dollarsToCents(s)` lives in `lib/money.ts`. Negative values rejected. The displayed currency symbol is hardcoded `$` for v1; per-org currency is a future enhancement.
8. **Edit project + edit assignment use the same dialog pattern as the invite-member dialog** from Plan 06 — RHF + Zod, dialog opens from a button, mutation invalidates the relevant query on success.
9. **Sidebar adds a Projects link.** The order in the AppShell sidebar becomes: Dashboard, Projects, Members, Settings. The link is always visible (members see the empty/filtered list, not a permission error).
10. **Project deletion is NOT in this plan.** Per Plan 04's decision, hard `DELETE /projects/:id` is reserved for a later plan that pairs with retention rules. Archive is the only "remove from view" action.
11. **Project counts on the dashboard.** The Plan 06 dashboard card list grows by one — "Projects" — counting active projects visible to the caller. Wired in this plan.

## Out of scope for this plan (deferred)

- **Time-entries view** (`/orgs/:orgId/time-entries`) — still deferred; no plan yet.
- **Screenshot grid + modal viewer** — ✅ shipped after Plan 07 as a Screenshots tab on the project layout. No dedicated plan folder; see `routes/_app.orgs.$orgId.projects.$projectId.screenshots.tsx`.
- **Reports / timesheet aggregation** — ✅ shipped as [Plan 09](../09-reports/). Added a Reports tab to the project layout and a sidebar-level org-wide page.
- **Bulk member assignment** — single-user only
- **Project templates / cloning** — future
- **Per-org currency selection** — hardcoded `$` for now
- **Assignment audit history** — write-only via `audit_logs`; no read UI

## Files in this plan

- [pages.md](./pages.md) — page-by-page UX, data shapes, mutation flows
- [testing.md](./testing.md) — RTL tests for the assignment dialog flow + smoke runbook

(No `routes.md` / `api-client.md` / `scaffold.md` — those existed in Plan 06 because the SPA was being scaffolded fresh. This plan is additive, so the existing files just gain new entries.)

## Ordered execution checklist

1. **Verify the three open questions** above against the API source. Note any gaps in this README. If gaps need fixing, do those first as a tiny API addendum (with tests).
2. **`useCan` extensions.** Add `projects:create`, `projects:update`, `projects:archive`, `projects:assign_members` to the action union in [`apps/web/src/lib/use-can.ts`](../../apps/web/src/lib/use-can.ts). Update the test file to cover the new cells. All four collapse to "owner or admin".
3. **Query-key additions.** Extend `queryKeys` in [`apps/web/src/lib/queries.ts`](../../apps/web/src/lib/queries.ts):
   ```ts
   projects: (orgId: string) => ['orgs', orgId, 'projects'] as const,
   project: (projectId: string) => ['projects', projectId] as const,
   assignments: (projectId: string) => ['projects', projectId, 'assignments'] as const,
   ```
4. **Money helper.** New file [`apps/web/src/lib/money.ts`](../../apps/web/src/lib/money.ts) with `centsToDollars` / `dollarsToCents` / `formatMoney`. Pure, unit-tested.
5. **Sidebar link.** Add a Projects nav item to [`apps/web/src/components/app-shell.tsx`](../../apps/web/src/components/app-shell.tsx) between Dashboard and Members. Use the existing `NavLink` component pattern.
6. **Projects list page.** New file `apps/web/src/routes/_app.orgs.$orgId.projects.index.tsx`. Per [pages.md](./pages.md#projects-list).
7. **Project detail layout + index.** New files `_app.orgs.$orgId.projects.$projectId.tsx` (layout with project name + tabs + Outlet) and `_app.orgs.$orgId.projects.$projectId.index.tsx` (overview tab). Per [pages.md](./pages.md#project-detail--overview).
8. **Project members tab.** New file `_app.orgs.$orgId.projects.$projectId.members.tsx`. Per [pages.md](./pages.md#project-members-tab).
9. **Dashboard card.** Add a Projects count card to [`_app.orgs.$orgId.index.tsx`](../../apps/web/src/routes/_app.orgs.$orgId.index.tsx) using the projects list endpoint.
10. **Tests.** Per [testing.md](./testing.md) — RTL tests for the assignment dialog flow (the most regression-prone part) + the money helper. `useCan` test gets the new cells.
11. **Lint, typecheck, test, build all green** before merging. `pnpm --filter @hindsight/web build` should still come in under 500 KB gzipped.
12. **Manual smoke test** per [testing.md](./testing.md). Done-when below covers the user-visible criteria.

## Done when

- An owner/admin sees a Projects nav link in the sidebar.
- Clicking it lands on the projects list. Empty state for fresh orgs prompts "Create your first project".
- Clicking **New project** opens a dialog (name, description, screenshot interval, blur toggle), submitting it adds a row to the table. The row links to the project detail page.
- Project detail page shows project metadata and an Edit button (admin only). Edit dialog mutates via `PATCH /projects/:projectId` and invalidates queries on success.
- Archive/Unarchive button toggles `archivedAt` and the active/archived URL filter respects it.
- The project's Members tab lists assignments with each member's name, email, hourly rate, and assignedAt. **Add member** picker shows only org members not currently active on the project. Submitting adds a row with optional rate.
- Hourly rate is editable inline (or via a small dialog). Empty input clears it (rate becomes `null`).
- Removing an assignment soft-deletes (sets `removedAt`); the row moves to the "removed" section if the toggle is on. Re-adding the same member flips it back to active without creating a duplicate row.
- A **member** account sees only assigned projects in the list. Visiting an unassigned project's detail URL renders an "access denied" state from the server's 403.
- Admin/owner-only buttons (New project, Edit, Archive, Add member, change rate, Remove member) are absent for member accounts. Server still 403s if bypassed.
- Dashboard's existing welcome card adds a "Projects" count next to Members and Pending invitations.
- `pnpm typecheck`, `pnpm test`, and `pnpm --filter @hindsight/web build` pass.
- Smoke test: create project → assign self + a teammate → log in as teammate → confirm visibility → archive → confirm hidden by default → unarchive → confirm restored.

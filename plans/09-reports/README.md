# Plan 09 — Reports: Time Totals

> Roadmap milestone: **v0.7 Admin dashboard** ([docs/10-roadmap.md](../../docs/10-roadmap.md)) — replaces the original "Timesheet view (hours by day grouped by project)" bullet with a slightly different shape (totals by user × project, not by day).
> Priority bucket: **P1** (depends on Plans 04 and 05; consumed by Plan 07's web pages and Plan 08's desktop UI)

## Goal

Give admins and members a single endpoint that answers: _how much time has each member tracked on each project, and what's that worth at their assigned rate?_ Surface that data in three places: the web app's per-project Reports tab, the web app's org-wide Reports page, and the desktop "My time" panel.

This plan was written **retroactively** — the feature shipped before the plan existed. Treat the README as a decision record. Future maintainers can read it to understand _why_ the endpoint is shaped this way and where to extend it.

## Source-of-truth references

- API surface for `time-totals`: [docs/05-api-surface.md](../../docs/05-api-surface.md) "Reports" section
- Data model (time entries, project_assignments): [docs/04-data-model.md](../../docs/04-data-model.md)
- Capability matrix (member vs admin scoping): [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md)
- Service code: [apps/api/src/modules/reports/service.ts](../../apps/api/src/modules/reports/service.ts)
- Tests: [apps/api/test/reports.test.ts](../../apps/api/test/reports.test.ts)

## Decisions captured here

1. **One endpoint, one row shape.** `GET /orgs/:orgId/reports/time-totals` returns flat rows of `{ userId, userName, userEmail, projectId, projectName, totalActiveSeconds, hourlyRateCents, earnedCents }`. Day/week/month rollups and CSV are deferred; clients pivot in the UI when they need to.
2. **`groupBy` in Postgres, not Node.** We use `prisma.timeEntry.groupBy({ by: ['userId', 'projectId'] })` so the aggregation stays in the DB. The composite indexes from Plan 04 (`time_entries(user_id, started_at)`, `time_entries(project_id, started_at)`) already cover the optional `from`/`to` range filter.
3. **Members are silently scoped to themselves.** If `caller.role === 'member'`, any `userId` query param is ignored and forcibly replaced with `caller.userId`. This is a server-side enforcement — no 403; just less data. This matches the [time-entries listing pattern](../../apps/api/src/modules/time-entries/service.ts).
4. **No pagination.** Typical orgs are <50 users × <50 active projects = at most a few thousand rows. Even at 10×, response is well under 1MB. If a real org pushes past 10k rows, revisit by either adding a `groupBy=project|user|day` parameter or a true paginated endpoint with a different name.
5. **Money math: `Math.round(seconds / 3600 * rateCents)`.** Round to nearest cent. `null` rate yields `null` earned (don't silently zero — the UI shows "—" so the absence is visible).
6. **Use current assignment rate, not a per-entry historical rate.** If a member's rate changed mid-period, the report uses the latest value on `project_assignments`. Rate history is not modelled in v1. If billing-grade accuracy is needed, a separate `assignment_rate_history` table becomes required — but that's a future decision; flagging it here so we don't pretend the current data is billing-quality.
7. **Sort: `(projectName, userName)`.** Stable, alphabetical. Clients re-sort or pivot at will.
8. **Three consumers, one endpoint:**
   - **Web per-project Reports tab** — filters by `projectId`, shows one table.
   - **Web org-wide Reports page** — no project filter, groups rows client-side by project or user (UI pivot).
   - **Desktop "My time" panel** — no `userId` filter (the API auto-scopes), no `projectId` filter, range toggle (Today / Week / All).
9. **Web app uses TanStack Query** with key `queryKeys.timeTotals(orgId, filters)`. Filters object becomes part of the key so different ranges/pivots are cached independently.
10. **Desktop uses plain fetch** (no React Query on desktop). Re-fetches when the range pill toggles. Cached in-memory only.
11. **Today's-baseline tracker timer (consumes the same endpoint).** On Start, the desktop calls `time-totals?projectId=…&from=<startOfToday>` once and uses `rows[0]?.totalActiveSeconds` as the on-screen timer's starting offset. See [docs/06-desktop-app.md](../../docs/06-desktop-app.md) "Today's-baseline tracker timer".

## Out of scope for this plan (deferred)

- **Day/week/month rollups.** Would add a `groupBy` parameter and a more complex SQL aggregation. Useful for "what did Alice work on each day this week."
- **CSV export.** Trivial to add as a sibling endpoint with `Accept: text/csv`; left out of v1.
- **Weekly email digest.** Mail provider integration only; the data path is already done.
- **Activity-density chart** (the original `/reports/activity` endpoint). Needs per-screenshot rollups; bigger change.
- **Idle-time exclusion from `totalActiveSeconds`.** The schema has `totalIdleSeconds` but the desktop currently treats wall-clock as active. Until that's wired, the "Earned" column is "session-duration × rate," not "active-time × rate." Cross-reference: [docs/05-api-surface.md](../../docs/05-api-surface.md) "totalActiveSeconds semantics."
- **Multi-currency.** Currently hardcoded `$`/USD via `formatMoney`. Per-org currency belongs in a settings page that doesn't exist yet.

## Files this plan added

API:

- `apps/api/src/modules/reports/routes.ts`
- `apps/api/src/modules/reports/handlers.ts`
- `apps/api/src/modules/reports/service.ts`
- `apps/api/src/modules/reports/schemas.ts`
- Registered in `apps/api/src/modules/index.ts`.

Tests:

- `apps/api/test/reports.test.ts` — three cases against the real test DB (owner-sees-all, member-self-scope, from/to filter).

Web:

- `apps/web/src/routes/_app.orgs.$orgId.projects.$projectId.reports.tsx` — per-project tab.
- `apps/web/src/routes/_app.orgs.$orgId.reports.tsx` — org-wide pivot page.
- `apps/web/src/lib/format.ts` — added `formatHours(seconds)` helper.
- `apps/web/src/lib/queries.ts` — added `queryKeys.timeTotals(orgId, filters)`.
- `apps/web/src/components/ui/table.tsx` — added `TableFooter` (used for subtotals).
- `apps/web/src/components/app-shell.tsx` — added Reports sidebar link with `BarChart3` icon.

Desktop:

- `apps/desktop/src/components/MyTimePanel.tsx`.
- `apps/desktop/src/lib/session-store.ts` — added `baselineTodaySeconds`.
- `apps/desktop/src/screens/PickingScreen.tsx` — `fetchTodaySecondsForProject(orgId, projectId)` before Start.
- `apps/desktop/src/screens/TrackingScreen.tsx` — display `baseline + elapsed`; 60s `totalActiveSeconds` flush; final flush on Stop.

Maintenance script:

- `apps/api/scripts/backfill-time-totals.mjs` — one-shot backfill for any closed `time_entries` with `totalActiveSeconds = 0`. Sets it to `(endedAt - startedAt)` seconds. Idempotent.

## Done when

- ✅ `GET /orgs/:orgId/reports/time-totals` returns the documented shape, scopes members correctly, and respects `projectId` / `userId` / `from` / `to` filters.
- ✅ Three API tests pass against the real test DB.
- ✅ Web per-project Reports tab and org-wide Reports page render real numbers with Today/Week/All and pivot toggles.
- ✅ Desktop "My time" panel renders on the picker screen with Today/Week/All.
- ✅ Desktop tracker timer starts at today's accumulated time on the project.
- ✅ `pnpm typecheck` clean across all three apps; eslint clean on new files.

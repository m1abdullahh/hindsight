# Plan 07 — Testing

Same posture as Plan 06: small, targeted unit/component tests for the parts most prone to regression, plus a manual smoke-test runbook.

## Required unit tests

### `lib/money.test.ts`

Pure helpers. Cheap to test, easy to get wrong.

- `centsToDollars(0)` → `0`
- `centsToDollars(2500)` → `25`
- `centsToDollars(2599)` → `25.99`
- `dollarsToCents(25)` → `2500`
- `dollarsToCents(25.99)` → `2599`
- `dollarsToCents(25.999)` → rounds to `2600`
- `dollarsToCents(-5)` → throws (negative)
- `dollarsToCents('25.50')` → `2550` (accept string input from form)
- `dollarsToCents('')` → `null` (empty clears the rate)
- `formatMoney(2599)` → `'$25.99'`
- `formatMoney(null)` → `'—'`

### `lib/use-can.test.ts` additions

The existing test file iterates every `(role × action)` cell. Adding four new actions means 12 new assertions (3 roles × 4 actions). Expected truth table:

| Action                    | Owner | Admin | Member |
| ------------------------- | ----- | ----- | ------ |
| `projects:create`         | ✓     | ✓     | ✗      |
| `projects:update`         | ✓     | ✓     | ✗      |
| `projects:archive`        | ✓     | ✓     | ✗      |
| `projects:assign_members` | ✓     | ✓     | ✗      |

## Required component tests

### `routes/__tests__/project-assignments.test.tsx` (RTL + MSW)

The interesting flow because it stitches three queries (project, assignments, org members) and exercises the picker filtering logic. This is also the part most likely to drift if the API shape changes.

Setup:

- Project with id `p1` exists.
- Three assignments active: members A, B, C.
- Org members list: A, B, C, D, E, F, G (7 total).
- Caller is owner.

Tests:

1. **Renders the active assignments table** with three rows (A, B, C), each showing name, email, hourly rate, assignedAt.
2. **Add member dialog filters out already-assigned members** — opening the picker shows D, E, F, G only (not A, B, C).
3. **Submitting the add-member form** posts to `/projects/p1/assignments` with `{ userId: 'd', hourlyRateCents: 5000 }` (from a $50 input). On success, the table re-renders with 4 rows (server returns the new assignment in the list refetch).
4. **Editing an existing rate** swaps the cell to an input on click, dispatches `PATCH /projects/p1/assignments/a` on blur with `{ hourlyRateCents: 7500 }` (from `$75`). Toast shows "Rate updated".
5. **Removing a member** opens a confirm dialog → click Remove → `DELETE /projects/p1/assignments/a`. Row moves out of the active section.
6. **Re-adding a removed member** with the toggle on shows the removed row with a Re-add button → click → `POST /projects/p1/assignments` with `{ userId: 'a' }`. The row's status flips back to active.
7. **409 on add (already-active)** renders an inline form error "This member is already on the project."

That suite covers the regression-prone pieces. We don't write tests for the projects list table or the overview card — they're trivial render-only and the smoke runbook catches breakage.

## What we're NOT testing automatically

- Projects list rendering (CSS / table layout)
- Sidebar link styling
- Dashboard card render
- Edit project dialog (essentially the same form as create + the same mutation pattern as everything in Plan 06)
- Archive toggle (one button, two API calls — covered by smoke)

These are all visual or one-liners. RTL tests for them cost more than they save.

## Manual smoke-test runbook

Run this before merging Plan 07 and before every release.

Prereqs:

- Plan 06 web app running (`pnpm --filter @hindsight/web dev`)
- API running with a working DB and Mailtrap (or alt mail provider) configured
- Two browser profiles or browser + incognito for the two-account flow

Sequence:

1. **Owner profile:** sign up with `owner+plan07@example.com` to a new org.
2. Land on dashboard. Confirm the new "Projects" card shows count `0`.
3. Click **Projects** in the sidebar. Empty state shows "Create your first project" with CTA.
4. Click **New project** → fill `Smoke Project`, default interval, blur off → submit. Row appears in the table.
5. Click the project row → land on detail. Verify metadata + tabs (Overview, Members).
6. Click **Edit project** → change description → save. Description updates.
7. Click **Archive** → confirm → archived badge appears, project disappears from default list. Switch to `?archived=true` tab → it shows. Unarchive → it returns to default tab.
8. **Invite a teammate** via the Members nav (Plan 06 functionality) → accept the invite as the teammate (incognito).
9. Back to **Owner profile:** open the project → **Members** tab → click **Add member** → pick the teammate, $50 rate → submit. Row appears.
10. Edit the rate inline to $75 → tab away → rate persists.
11. **Teammate profile (incognito):** navigate to `/orgs/:orgId/projects`. The Smoke Project shows. The teammate sees only this project (member-scoped filter).
12. Teammate visits the detail page → reads it OK. No Edit/Archive buttons. The Members tab shows the assignment list (read-only — no Add/Remove).
13. **Owner profile:** Members tab → Remove the teammate → confirm. Row moves out of active.
14. Toggle "Show removed" → row appears as removed. Click **Re-add** → row returns to active.
15. **Teammate profile:** refresh → project visibility restored.
16. **Owner profile:** dashboard card now shows "Projects: 1".

Any deviation → file a follow-up issue or fix in this plan before merging.

## Coverage target

Same posture as Plans 02–06: at least one test per new helper, a focused component test for the highest-risk flow, smoke runbook for visual / cross-page concerns. Coverage thresholds get set up later when the codebase has stabilised.

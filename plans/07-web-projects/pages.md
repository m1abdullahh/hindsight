# Plan 07 — Pages

Three new pages plus a layout. All follow the patterns established in Plan 06: TanStack Query for reads, `useMutation` for writes, react-hook-form + Zod for forms, shadcn UI components, toasts on every mutation.

## Projects list

**Route:** `/orgs/:orgId/projects`
**File:** `apps/web/src/routes/_app.orgs.$orgId.projects.index.tsx`

**Search params** (validated by Zod):

```ts
const searchSchema = z.object({
  archived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});
```

**Reads:**

- `GET /orgs/:orgId/projects?includeArchived={archived}` → `{ projects: ProjectDto[] }`

**Layout:**

- Page header: "Projects" + **New project** button (gated on `useCan('projects:create')`).
- Tabs: **Active** (default) and **Archived**, both linking with the `?archived=` search param.
- Body: a `<Table>` with columns Name, Description, Interval, Blur, Created, with an icon button on each row that links to the detail page. Empty state diverges by role:
  - Admin/owner with no projects: "No projects yet. Create your first project to get started." + CTA.
  - Member with no assigned projects: "You haven't been assigned to any projects yet — ask your org owner."

**New project dialog form:**

```ts
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).optional(),
  screenshotIntervalMinutes: z.number().int().min(1).max(60).default(10),
  blurScreenshots: z.boolean().default(false),
});
```

Submits to `POST /orgs/:orgId/projects`, invalidates `queryKeys.projects(orgId)` on success, toasts "Project created", closes dialog.

**Errors to surface inline on the form:**

- 422 → server validation message
- Anything else → toast destructive variant

## Project detail (layout)

**Route:** `/orgs/:orgId/projects/:projectId`
**File:** `apps/web/src/routes/_app.orgs.$orgId.projects.$projectId.tsx`

This is the layout file — shared header + tabs + `<Outlet />`. The two child routes (`.index.tsx` and `.members.tsx`) render inside.

**Reads:**

- `GET /projects/:projectId` → `ProjectDto`

**Layout:**

- Page header: project name (h1), then a row of muted-text metadata (created date, archived badge if applicable).
- Action row (admin/owner only):
  - **Edit project** button → opens dialog
  - **Archive** / **Unarchive** button → confirm dialog
- Tabs: **Overview** (links to detail index) and **Members** (links to members tab). Active state from `useRouterState().location.pathname`.
- `<Outlet />` for the tab content.

**Edit project dialog form:** same schema as create, all fields optional, must include at least one. Mutation: `PATCH /projects/:projectId`. Invalidates `queryKeys.project(projectId)` and `queryKeys.projects(orgId)`.

**Archive toggle:** confirm dialog → `POST /projects/:projectId/archive` (or `DELETE` to unarchive). Invalidates the same keys.

**403 from `GET /projects/:projectId`** (member who's not assigned): render an access-denied card instead of the layout. Don't redirect — back-button discoverability matters.

## Project detail — Overview

**Route:** `/orgs/:orgId/projects/:projectId/`
**File:** `apps/web/src/routes/_app.orgs.$orgId.projects.$projectId.index.tsx`

Renders inside the layout's `<Outlet />`.

Body is a `<Card>` with detail rows in a 2-column grid:

| Field               | Source                              | Notes                                                               |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| Description         | `project.description`               | Show "—" if null                                                    |
| Screenshot interval | `project.screenshotIntervalMinutes` | "X minutes"                                                         |
| Blur screenshots    | `project.blurScreenshots`           | "On" / "Off" badge                                                  |
| Created             | `project.createdAt`                 | `formatDateTime`                                                    |
| Archived            | `project.archivedAt`                | Show only if non-null                                               |
| Created by          | `project.createdBy`                 | User ID for now; resolving the name requires an extra fetch — defer |

No mutations on this page. Edits happen via the layout's Edit button.

## Project members tab

**Route:** `/orgs/:orgId/projects/:projectId/members`
**File:** `apps/web/src/routes/_app.orgs.$orgId.projects.$projectId.members.tsx`

**Reads:**

- `GET /projects/:projectId/assignments` → `{ assignments: { assignment: ProjectAssignmentDto, user: UserDto }[] }` (per the verification in [README.md#pre-implementation-verification](./README.md))
- `GET /orgs/:orgId/members` → `{ members: { membership: MembershipDto, user: UserDto }[] }` (used by the Add Member picker — same endpoint Plan 06's members page uses)

**Search params:**

```ts
const searchSchema = z.object({
  showRemoved: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});
```

**Layout:**

- Page header (inside the project layout's tab content): "Members" + **Add member** button (gated on `useCan('projects:assign_members')`).
- Toggle: "Show removed" (admin only — members don't need to see this).
- `<Table>` columns: Name, Email, Org role, Hourly rate, Assigned, Status (active/removed pill).
- Active assignments rendered solid; removed (when shown) rendered greyed with a "Re-add" button.
- Action column (admin only): Edit rate (inline), Remove (confirm).

**Add member dialog form:**

```ts
const addAssignmentSchema = z.object({
  userId: z.string().min(1, 'Pick a member'),
  hourlyRateCents: z.number().int().min(0).max(1_000_000_00).optional(),
});
```

The userId field is a `<Select>` (or combobox if member count > 20) populated from `members` minus those already actively assigned (filter by `assignmentRows.find((a) => a.assignment.userId === m.user.id && !a.assignment.removedAt)`). Hourly rate is a number input — display dollars, convert to cents on submit via `dollarsToCents`.

Mutation: `POST /projects/:projectId/assignments`. Invalidates `queryKeys.assignments(projectId)`.

**Edit rate flow:** inline pencil icon next to the rate cell → swaps to an input → on blur or Enter, mutation: `PATCH /projects/:projectId/assignments/:userId` with `{ hourlyRateCents }`. Empty input clears (`null`). Same invalidation.

**Remove flow:** confirm dialog → `DELETE /projects/:projectId/assignments/:userId`. Server sets `removedAt`. Row moves to "removed" section (or hides if toggle off). Toast "Member removed from project".

**Re-add flow:** click "Re-add" on a removed row → `POST /projects/:projectId/assignments` with `{ userId }`. Server flips `removedAt` to null on the existing row (no duplicate). Toast "Member re-added".

**409 on add:** "This member is already on the project." Inline form error.

## Dashboard card update

**File:** `apps/web/src/routes/_app.orgs.$orgId.index.tsx`

Add a third card alongside Members and Pending invitations:

```tsx
<Card>
  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
    <CardTitle className="text-base">Projects</CardTitle>
    <FolderKanban className="h-4 w-4 text-muted-foreground" />
  </CardHeader>
  <CardContent>
    <div className="text-3xl font-semibold">{projectsQuery.data?.projects.length ?? 0}</div>
    <CardDescription className="mt-1">
      <Link to="/orgs/$orgId/projects" params={{ orgId }} className="hover:underline">
        View all projects →
      </Link>
    </CardDescription>
  </CardContent>
</Card>
```

The query reuses `queryKeys.projects(orgId)` so once the projects page caches, the dashboard shares the data without an extra fetch.

## Sidebar

**File:** `apps/web/src/components/app-shell.tsx`

Add one nav item between Dashboard and Members:

```tsx
<NavLink
  to="/orgs/$orgId/projects"
  params={{ orgId: currentOrgId }}
  icon={<FolderKanban className="h-4 w-4" />}
  active={path.startsWith(`/orgs/${currentOrgId}/projects`)}
>
  Projects
</NavLink>
```

## Component summary

New files this plan creates:

- `routes/_app.orgs.$orgId.projects.index.tsx` — projects list
- `routes/_app.orgs.$orgId.projects.$projectId.tsx` — project layout
- `routes/_app.orgs.$orgId.projects.$projectId.index.tsx` — overview tab
- `routes/_app.orgs.$orgId.projects.$projectId.members.tsx` — members tab
- `lib/money.ts` — currency helpers + tests

Files modified:

- `lib/use-can.ts` — new actions
- `lib/use-can.test.ts` — new test cells
- `lib/queries.ts` — new query keys
- `components/app-shell.tsx` — Projects sidebar link
- `routes/_app.orgs.$orgId.index.tsx` — Projects dashboard card

## Tabs added by later plans (cross-references)

The project-detail layout now hosts four tabs: Overview, Members, Screenshots, and Reports. Plans 07 ships Overview + Members; the other two come later:

- **Screenshots tab** — `routes/_app.orgs.$orgId.projects.$projectId.screenshots.tsx`. Thumbnail grid + click-to-view modal. Wired into the layout's tab bar in the same plan that adds the gallery component. Not documented in its own plans/ folder yet; reach out before extending.
- **Reports tab** — `routes/_app.orgs.$orgId.projects.$projectId.reports.tsx`. See [plans/09-reports/](../09-reports/) for the decision record. Reads `GET /orgs/:orgId/reports/time-totals?projectId=…`.

When adding additional tabs in the future, follow the same pattern: add a `<Link>` inside the existing tab bar in `_app.orgs.$orgId.projects.$projectId.tsx`, and use a `path.startsWith(somePath)` check on the layout's `tabClasses()` for the active state.

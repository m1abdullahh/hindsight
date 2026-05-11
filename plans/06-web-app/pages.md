# Web App — Pages

One section per page. Each section lists: the route file, the API endpoints it consumes, the form schema (if any), the component layout, and edge cases worth pre-thinking.

The pattern across every page:

1. **Server reads** via `useQuery` with a stable `queryKey` of the form `[resource, ...params]`.
2. **Mutations** via `useMutation`, with `onSuccess` invalidating the relevant queries.
3. **Forms** use React Hook Form + Zod — same Zod schemas as the API where they fit; small client-only schemas where the API's are too tightly coupled to Express.
4. **Loading** = `<Skeleton />` lines or a spinner depending on layout. **Empty** = a friendly empty state. **Error** = an error toast plus a retry button on lists.

Components from shadcn we lean on heavily: `Form`, `Input`, `Button`, `Dialog`, `DropdownMenu`, `Table`, `Avatar`, `Skeleton`, `Toast`, `Select`, `Tabs`, `Pagination` (light wrapper around our cursor pagination).

## Auth pages

### `/signup` — `(unauth)/signup.tsx`

Form: `email`, `password`, `name`, `organizationName`. Submit calls `POST /auth/signup`. On success, `setSession({ token, user, organizations: [organization], memberships })` then `router.navigate({ to: '/' })`.

Validation: email shape, password ≥ 12 chars (matching the server's HIBP-aware rule). Show the server's 409 (`email_in_use`) under the email field.

Note: a known-pwned password returns 422 with `details.code = 'pwned'`; surface that as an inline error too.

### `/login` — `(unauth)/login.tsx`

Form: `email`, `password`. `POST /auth/login`. Search param `?next=...` honored on success: `router.navigate({ to: next ?? '/' })` (sanitize `next` to start with `/` to avoid open-redirect).

429 from the throttle ([plans/03-members-and-invites/security.md](../03-members-and-invites/security.md)) renders as "too many attempts, try again in N minutes" using the `Retry-After` header if present.

### `/forgot-password` — `(unauth)/forgot-password.tsx`

Form: `email`. `POST /auth/password/forgot`. Always shows the same success message ("If that email is registered, we've sent a reset link") regardless of result — server already enforces anti-enumeration so this is just matching copy.

### `/reset-password` — `(action)/reset-password.tsx`

Reads `?token=...` from URL. Form: `password`, `confirmPassword`. `POST /auth/password/reset`. On success, server returns a fresh session — pipe through `setSession`, redirect to `/`.

Edge case: missing/invalid token → render an error state with a "request a new link" link to `/forgot-password`.

### `/verify-email` — `(action)/verify-email.tsx`

On mount, `POST /auth/email/verify` with `?token=...`. Three states: pending spinner, success ("Email verified — you can close this tab"), error ("This link has expired or been used"). If the user is logged in, also offer "Resend verification" via `POST /auth/email/resend-verification`.

### `/invitations/accept` — `(unauth)/invitations/accept.tsx`

Reads `?token=...`. The component first calls `POST /auth/invitations/accept` with `{ token }` and **no body fields** to peek at what the server expects:

- If 422 with `details.requires = ['password', 'name']` → render the form for new-user signup.
- If 422 with `details.requires = ['password']` → render password-only form (existing user, no password yet — rare path).
- If 200 → existing user with already-set password got auto-logged-in; pipe through `setSession`, redirect.
- If 409 → "logged in as a different user, please sign out" with a sign-out button.

(The "peek" pattern needs a server-side tweak: the 422 response should include `details.requires`. Already implied by [plans/03-members-and-invites/modules.md:55-65](../03-members-and-invites/modules.md#L55-L65) — confirm the server returns it; if not, add it as a small follow-up to Plan 03 rather than guessing on the client.)

If the form is needed, on submit re-call `POST /auth/invitations/accept` with the full payload, then `setSession` and redirect.

## Org / members

### `/orgs/:orgId/members` — `(app)/orgs/$orgId/members/index.tsx`

Reads:

- `GET /orgs/:orgId/members` → table.
- `GET /orgs/:orgId/invitations` (admins only) → secondary list of pending invites.

Layout: a single page with two `<Card>` sections: "Members" (table) and "Pending invitations" (table). Admin-only "Invite member" button in the page header opens a `<Dialog>`.

Member row actions (admin only): "Change role" (DropdownMenu → owner/admin/member), "Remove from org" (confirm dialog). Both go through `PATCH /orgs/:orgId/members/:userId` and `DELETE /orgs/:orgId/members/:userId`. Last-owner protection surfaces from the server as a 409 toast: "You can't remove the last owner. Promote someone else first."

Invite-member dialog form: `email`, `role` (`admin` | `member`). Submit `POST /orgs/:orgId/invitations`. Success toast: "Invitation sent." 409 (already invited / already a member) → inline form error.

Pending-invite row actions: "Revoke" (DELETE) and "Copy link" (constructs the URL `/invitations/accept?token=...` from the response we got at create time — once a server roundtrip completes the token is hashed and unrecoverable, so this is only available right after creation, **deliberately**).

### `/settings/profile` — `(app)/settings/profile.tsx`

Form: `name`. `PATCH /auth/me` (the API today doesn't have a profile-update endpoint listed; if missing, defer this page to a follow-up. Verify before building. As of Plans 02–05, the only auth write surface is password / sign-out-everywhere — name change isn't there.)

If the endpoint isn't there: render a read-only profile card with email + "Change requested? Contact your org owner" copy and call out the gap in a follow-up plan. **Don't invent the endpoint client-side.**

### `/settings/password` — `(app)/settings/password.tsx`

Form: `currentPassword`, `newPassword`, `confirmNewPassword`. `POST /auth/password/change`. On success: toast "Password changed. Other sessions signed out." (the server runs `signOutEverywhere(keepCurrent: true)` per [plans/03-members-and-invites/modules.md:130-134](../03-members-and-invites/modules.md#L130-L134)). Stay on the page; don't redirect.

A "Sign out everywhere" button below the form calls `POST /auth/sign-out-everywhere` with `{ keepCurrent: true }`. `Confirm` dialog before firing.

### `/settings/devices` — `(app)/settings/devices.tsx`

Reads `GET /devices` (per [docs/05-api-surface.md:86-88](../../docs/05-api-surface.md#L86-L88)). Renders a table: name, OS, app version, last seen, actions.

Action: "Revoke" → `DELETE /devices/:deviceId` with confirm dialog. Toast on success, invalidate `['devices']`.

Two follow-ups to verify against the API before building this page:

1. Does `GET /devices` return only the caller's devices, or does an admin see all devices across the org? If per-user only, drop the admin "all devices" tab. The API surface doc is silent on this; check the implementation in [`apps/api/src/modules/devices/`](../../apps/api/src/modules/devices/).
2. The `lastSeenAt` field comes from the heartbeat. The desktop app isn't built yet, so this column will be empty for now — render `<span className="text-muted-foreground">—</span>` rather than an empty cell.

## Projects

### `/orgs/:orgId/projects` — `(app)/orgs/$orgId/projects/index.tsx`

Reads `GET /orgs/:orgId/projects`. The server already filters by role; the client renders whatever it gets.

Layout: page header ("Projects" + "New project" button gated on `useCan('projects:create')`). Below: `<Tabs>` for "Active" and "Archived" (driven by URL search param `?archived=true`). Body: a `<Table>` with name, description, screenshot interval, blur, members count, last activity (if/when we add it server-side; for now, omit). Each row is a `<Link>` to `/orgs/:orgId/projects/:projectId`.

"New project" dialog form: `name`, `description?`, `screenshotIntervalMinutes` (default 10), `blurScreenshots` (default false). `POST /orgs/:orgId/projects`. Invalidate `['projects', orgId]` on success.

Empty states differ by role:

- Admin, no projects: "Create your first project" with the new-project CTA.
- Member, no assigned projects: "You haven't been assigned to any projects yet — ask your org owner."

### `/orgs/:orgId/projects/:projectId` — `(app)/orgs/$orgId/projects/$projectId/index.tsx`

Reads `GET /projects/:projectId`. Page header: project name + actions (Edit, Archive/Unarchive — admin only). Tabs across the layout file at `(app)/orgs/$orgId/projects/$projectId/_layout.tsx`: "Overview" (this file), "Members" (next file).

Overview body: detail rows (`description`, `screenshotIntervalMinutes`, `blurScreenshots`, `createdAt`, `archivedAt` if archived). Edit dialog form ties to `PATCH /projects/:projectId`. Archive button toggles via `POST/DELETE /projects/:projectId/archive` with confirm dialog.

### `/orgs/:orgId/projects/:projectId/members` — `(app)/orgs/$orgId/projects/$projectId/members.tsx`

Reads:

- `GET /projects/:projectId/assignments` → main list.
- `GET /orgs/:orgId/members` → for the assignment picker (shows org members not yet assigned).

Body: a `<Table>` of assignees: avatar, name, role (org role from the joined member data), hourly rate, assignedAt, removedAt (if showing removed). Filter toggle "Show removed" (default off — hide rows with `removedAt`).

Row actions (admin only):

- "Edit rate" → `PATCH /projects/:projectId/assignments/:userId` with `hourlyRateCents`. Inline edit; show as "$X.XX/hr" formatted.
- "Remove" → `DELETE /projects/:projectId/assignments/:userId` with confirm.

"Add member" dialog: a `<Combobox>` filtered to org members not currently active on the project. Optional rate input. `POST /projects/:projectId/assignments`.

## Time entries

### `/orgs/:orgId/time-entries` — `(app)/orgs/$orgId/time-entries/index.tsx`

Reads `GET /orgs/:orgId/time-entries?userId=&projectId=&from=&to=`. Filters drive `?searchParams` (validated by Zod per [routes.md](./routes.md)).

The endpoint is _not_ paginated today (per [docs/05-api-surface.md:104](../../docs/05-api-surface.md#L104)). For initial volumes (a single team, weeks of data) this is acceptable; the empty state copy says "Showing all time entries matching your filters." If the response gets too big in practice, that's a server-side change to add cursor pagination.

Filters:

- User `<Select>` — admins see the org members list; members see only themselves.
- Project `<Select>` — admins see all projects; members see assigned projects.
- Date range: two `<Input type="date">` fields, defaulting to "last 7 days" if empty.

Body: a `<Table>` with project, user (if admin), startedAt, endedAt, duration (computed: ended-started, with "ongoing" if `endedAt` is null), active hours, idle hours. Click a row to expand inline showing notes and the underlying numbers.

No edit/delete on time entries from the web UI. The desktop app owns time entry mutation; admins who need to delete/correct entries do it through DB tooling for now (consistent with [docs/08-auth-and-permissions.md:8](../../docs/08-auth-and-permissions.md#L8) "operators access data via DB tooling").

## Screenshots

### `/orgs/:orgId/screenshots` — `(app)/orgs/$orgId/screenshots/index.tsx`

The dashboard centerpiece. Reads `GET /orgs/:orgId/screenshots?userId=&projectId=&from=&to=&cursor=&limit=50`.

Page header: filter form (User, Project, Date range — same shape as time-entries) + a result count.

Body: a CSS grid of thumbnail tiles. Each tile:

- `<img loading="lazy" src={thumbnailUrl} />` (presigned, comes from the server).
- Overlay on hover: capturedAt (relative — "2h ago"), user name, project name.
- Click → opens `(app)/orgs/$orgId/screenshots/$screenshotId.tsx` as a modal.

Pagination: "Load more" button at the bottom that re-runs the query with `cursor=nextCursor` and concatenates results. (We use `useInfiniteQuery` from TanStack Query for clean state.)

Empty state: "No screenshots match these filters."

Edge cases:

- A thumbnail URL might 403 if the user kept the page open longer than the 10-minute presign TTL ([plans/05-screenshot-ingestion/README.md:35](../05-screenshot-ingestion/README.md#L35)). On thumbnail load error, show a placeholder + "Refresh" button on the tile that triggers a refetch of just that page.
- Rows where `status !== 'processed'` won't have a thumbnail yet. Show a "processing…" placeholder. Polling: the parent query refetches every 10s while any tile shows processing — bound the polling to a 2-minute window then stop (a worker that hasn't processed in 2 minutes is `failed`, not pending).
- Members see only their own screenshots — the server filters; the client just renders.

### `/orgs/:orgId/screenshots/:screenshotId` — `(app)/orgs/$orgId/screenshots/$screenshotId.tsx`

Reads `GET /screenshots/:id`. Renders inside a `<Dialog>` opened on top of the grid (TanStack Router supports parallel routes via search-param tricks; simpler is to render the modal as a dedicated route and have it open `<Dialog defaultOpen onOpenChange={(o) => !o && router.history.back()}>` so the back button closes it).

Body: the full-res image (presigned), and a metadata panel: capturedAt, user, project, time entry id, monitor index, active app, active window title, dimensions, size in MB, keyboard/mouse counts.

Actions:

- "Delete" — gated on whether the row's `userId === useUser().id` (own) and the role is owner/admin OR within grace window. The button always shows for admins; for members it shows but the server may 422 it if past the grace window. On 422, surface the toast "Deletion window has passed." On success, close the modal and invalidate `['screenshots', orgId, ...filters]`.
- "Open in new tab" — `<a target="_blank">` to the presigned URL. Useful for inspection.

## Page index

| Route                                      | File                                              | Plan-step | Notes                  |
| ------------------------------------------ | ------------------------------------------------- | --------- | ---------------------- |
| `/login`                                   | `(unauth)/login.tsx`                              | 6         |                        |
| `/signup`                                  | `(unauth)/signup.tsx`                             | 6         |                        |
| `/forgot-password`                         | `(unauth)/forgot-password.tsx`                    | 6         |                        |
| `/reset-password`                          | `(action)/reset-password.tsx`                     | 6         |                        |
| `/verify-email`                            | `(action)/verify-email.tsx`                       | 6         |                        |
| `/invitations/accept`                      | `(unauth)/invitations/accept.tsx`                 | 6         |                        |
| `/orgs/:orgId/members`                     | `(app)/orgs/$orgId/members/index.tsx`             | 7         |                        |
| `/orgs/:orgId/projects`                    | `(app)/orgs/$orgId/projects/index.tsx`            | 8         |                        |
| `/orgs/:orgId/projects/:projectId`         | `(app)/orgs/$orgId/projects/$projectId/index.tsx` | 8         |                        |
| `/orgs/:orgId/projects/:projectId/members` | `.../members.tsx`                                 | 8         |                        |
| `/orgs/:orgId/time-entries`                | `.../time-entries/index.tsx`                      | 10        |                        |
| `/orgs/:orgId/screenshots`                 | `.../screenshots/index.tsx`                       | 11        |                        |
| `/orgs/:orgId/screenshots/:screenshotId`   | `.../$screenshotId.tsx`                           | 11        |                        |
| `/settings/profile`                        | `(app)/settings/profile.tsx`                      | 12        | Verify endpoint exists |
| `/settings/password`                       | `(app)/settings/password.tsx`                     | 12        |                        |
| `/settings/devices`                        | `(app)/settings/devices.tsx`                      | 9         |                        |

Plan-step numbers reference the ordered execution checklist in the [README](./README.md).

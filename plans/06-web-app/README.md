# Plan 06 — Web App (v0.2 MVP)

> Roadmap milestone: **v0.2 Members & invites** ([docs/10-roadmap.md:19-29](../../docs/10-roadmap.md#L19-L29)) — the web-app side of it
> Priority bucket: **P1** (depends on Plans 02–03; the projects/screenshots dashboard pieces ship in Plan 07)

## Goal

Stand up the React SPA at `apps/web` covering the **v0.2 MVP scope only**: auth, invitations, members, devices, plus a minimal landing dashboard. After this plan, an owner/admin can sign up, invite a teammate, see them join, manage roles, view their own devices, change their name and password, and sign out. Members get the same UX scoped to themselves.

Projects, project assignments, time entries, and the screenshot grid are **deferred to Plan 07 — Web Dashboard**, which ships after this plan has been dogfooded against a real team. The route shell, layouts, sidebar, and capability hook are built so adding those routes is purely additive.

This plan is **API-side complete** plus two small extensions added in step 1 (so every page can fully ship — no read-only stubs):

1. **`details.requires` on invitation-accept 400 responses.** Lets the accept page render the right form without a "peek" round-trip. See [`apps/api/src/modules/invitations/service.ts`](../../apps/api/src/modules/invitations/service.ts).
2. **`PATCH /auth/me { name? }`.** Lets the settings/profile page be functional rather than read-only. New audit action `auth.profile_updated`. See [`apps/api/src/modules/auth/`](../../apps/api/src/modules/auth/).

Reports and the audit-log viewer remain deferred — those server endpoints don't exist yet.

## Source-of-truth references

- Tech stack for the web app: [docs/03-tech-stack.md:34-52](../../docs/03-tech-stack.md#L34-L52)
- API surface the web client consumes: [docs/05-api-surface.md](../../docs/05-api-surface.md)
- Auth model (`localStorage` for the web token, sliding 30-day expiry): [docs/08-auth-and-permissions.md:34-35](../../docs/08-auth-and-permissions.md#L34-L35)
- Capability matrix (drives which UI a member sees vs an admin): [docs/08-auth-and-permissions.md:109-126](../../docs/08-auth-and-permissions.md#L109-L126)
- Plans this builds on: [plans/02-auth-and-orgs/](../02-auth-and-orgs/), [plans/03-members-and-invites/](../03-members-and-invites/)

## Verification findings (resolved)

Three open questions in the original draft were resolved by reading the API source. Decisions below incorporate the answers — do not re-litigate.

1. **`GET /devices` is caller-only.** [`devices/service.ts:75-81`](../../apps/api/src/modules/devices/service.ts#L75-L81) filters by `userId`. Cross-user revocation by an admin is supported (`DELETE /devices/:id`), but listing is per-user only. The settings/devices page renders the caller's own devices in this plan; an admin "all devices in org" view ships with Plan 07's member-detail page.
2. **Invitation-accept 400 responses now return `details.requires`** (added in step 1 above). The web client uses it to render the right form.
3. **`PATCH /auth/me { name }` now exists** (added in step 1). The settings/profile page is functional.

## Decisions captured here (not implementation yet)

1. **One Vite SPA, no SSR.** Per [docs/03-tech-stack.md:48-49](../../docs/03-tech-stack.md#L48-L49). Build output is a static bundle served by Cloudflare; the API stays separate. No Next.js, no server components.
2. **TanStack Router with file-based routing.** Routes live under `apps/web/src/routes/`. Type-safe loaders/search-params replace the per-page boilerplate that React Router v6 demands. Pin to TanStack Router v1.
3. **TanStack Query for every server read and mutation.** Stale time defaults to 30s; lists invalidate on mutation. Errors surface through an error boundary plus toast.
4. **Zustand holds session only.** One store: `{ token, user, organizations, memberships, currentOrgId }` plus `setSession` / `switchOrg` / `clearSession`. Persist `token` and `currentOrgId` only — `user` and `memberships` rehydrate from `/auth/me` on every boot.
5. **Tailwind + shadcn/ui, not a component library.** Components copied via the shadcn CLI live under `apps/web/src/components/ui/` and are _ours_. Light mode only for v1.
6. **Forms = React Hook Form + Zod.** Tiny client-side schemas mirror the API's where they diverge (the API's Zod schemas live in Express middleware and aren't cleanly portable).
7. **Auth token in `localStorage`.** Per [docs/08-auth-and-permissions.md:34-35](../../docs/08-auth-and-permissions.md#L34-L35) — internal app, small XSS surface. Stored under key `hindsight.session` (JSON `{ token, currentOrgId }`). 401 from any endpoint clears the store and redirects to `/login`.
8. **Capability gating reuses the server matrix.** A `useCan(action)` hook re-implements the same `can()` switch as the API, sourced from the currently-selected membership. UI gate is hint-only — server is authoritative. Tests cover every `(role × action)` cell.
9. **DTO types are shared via `@hindsight/shared/dto`** (done in step 2 of this plan). Both API and web import the same interfaces. Zod schemas stay in the API.
10. **The current org lives in the URL.** `currentOrgId` in the Zustand store is _only_ a redirect-after-login default; every org-scoped page reads `:orgId` from its route. Avoids cross-tab desync.
11. **Date handling uses `date-fns` + ISO strings on the wire.** UTC server-side, local TZ in the browser. Always go through `formatDate()` / `formatDateTime()` helpers.
12. **Three top-level layouts.** `(unauth)` for signup/login/forgot-password, `(action)` for token-bearing landings (verify-email, reset-password, accept-invite), and `(app)` for the authenticated shell with sidebar + topbar. `(settings)` is nested inside `(app)`.
13. **No dark mode, no i18n, no mobile-layout polish in this plan.** Theme tokens are wired so dark mode is a flip later; copy is hard-coded English.

## Out of scope for this plan (deferred)

- **Projects pages** (list, detail, assignments) — Plan 07.
- **Time-entries list** — Plan 07.
- **Screenshot grid + detail modal** — Plan 07.
- **Reports pages** (timesheet, activity) — separate plan.
- **Audit-log viewer** — server endpoint doesn't exist; v0.8 milestone.
- **Email change** — needs a verification flow; deferred.
- **Admin "all devices in org" view** — server is per-user; revisit when Plan 07's member-detail page lands.
- **Dark mode, i18n, mobile-layout polish, real-time updates** — all deferred.
- **Bulk actions** — single-target only.

## Files in this plan

- [scaffold.md](./scaffold.md) — Vite + React + Tailwind + shadcn + TanStack Router setup, package scripts, env vars
- [api-client.md](./api-client.md) — fetch wrapper, session store, TanStack Query setup, DTO sharing through `@hindsight/shared`. **Note:** the DTO and capability lists in this file include some types (TimeEntryDto, ScreenshotDto, etc.) that Plan 06 doesn't _use_ — they're already shared from step 2 because moving them once is cheaper than splitting the move across plans.
- [routes.md](./routes.md) — route tree, layouts, guards. **Note:** the file shows the eventual full tree; Plan 06 ships only the auth, settings, and members routes. Projects/time-entries/screenshots routes ship with Plan 07.
- [pages.md](./pages.md) — page-by-page UX. **Note:** sections for projects, time-entries, and screenshots in this file are Plan 07 reference, not Plan 06 deliverables.
- [testing.md](./testing.md) — Vitest + RTL + MSW; smoke runbook trimmed to the v0.2 MVP flow.

> Sub-files were originally drafted with the broader scope. Where they describe pages outside the v0.2 MVP, treat them as _Plan 07 reference material_ and skip during this plan's execution.

## Ordered execution checklist

1. **API extensions** — done before web work begins. Tiny additions to existing modules.
   - 1a. Invitation-accept 400 responses include `details: { requires, existingUser }`. Tests in [`apps/api/test/invitations.test.ts`](../../apps/api/test/invitations.test.ts).
   - 1b. `PATCH /auth/me { name? }` route + handler + service + audit (`auth.profile_updated`). Tests in [`apps/api/test/auth-extras.test.ts`](../../apps/api/test/auth-extras.test.ts).
   - 1c. Update [docs/05-api-surface.md](../../docs/05-api-surface.md) and Plan 02/03 addendum notes.
   - 1d. `pnpm --filter @hindsight/api typecheck` + `test` green.
2. **DTO move into `@hindsight/shared`.** Copy the type interfaces into `packages/shared/src/dto.ts` (literal-union enums so the browser never sees `@prisma/client`). API's `lib/dto.ts` re-exports the types and keeps the conversion functions.
3. **Web scaffold.** Vite + React 18 + Tailwind + shadcn + TanStack Router + TanStack Query + Zustand + RHF + Zod + date-fns. Wire `apps/web/package.json` scripts. Per [scaffold.md](./scaffold.md).
4. **API client + session store + Query provider + `useCan`.** Per [api-client.md](./api-client.md).
5. **Routing skeleton.** Layouts (`__root`, `(unauth)`, `(action)`, `(app)`, `(app)/settings`), route guards, 404, error boundary. Per [routes.md](./routes.md) — only the v0.2 routes.
6. **shadcn components.** `button`, `input`, `label`, `form`, `dialog`, `dropdown-menu`, `table`, `avatar`, `skeleton`, `toast`, `select`, `card`, `badge`. Generated via shadcn CLI; no customization in this step.
7. **Auth pages.** Signup, login, forgot-password, reset-password, verify-email, accept-invite. Per [pages.md](./pages.md) — auth section only.
8. **Org / members pages.** Members list (table with role/status pills), invite-member dialog, role change, remove member. Last-owner protection surfaces from the API as a 409 toast.
9. **Devices page (in settings).** List the caller's own devices; revoke confirm.
10. **Basic dashboard landing page.** A welcome card at `/orgs/:orgId/` showing org name, member count, and pending-invite count (admin only). Plus quick links to Members and Settings. Plan 07 replaces this with the real dashboard.
11. **Settings.** Profile (name update via the new `PATCH /auth/me`), password (change + sign out everywhere), devices (step 9).
12. **Tests.** Unit tests for `useCan`, `api.ts`, session store. RTL tests for the login form + invite-accept flow. MSW handlers for the API.
13. **Lint, typecheck, test, build all green** before merging. `pnpm --filter @hindsight/web build` should succeed.

## Done when

- `pnpm --filter @hindsight/web dev` boots Vite; `/login` renders.
- A new user can sign up via the web UI and land on the org dashboard.
- That user can invite a teammate; the teammate clicks the email link, the accept page renders the new-user form (driven by `details.requires`), they accept, and the member shows up in both accounts' members list.
- Capability gating works: a member account does not see "Invite member" or "Change role" buttons. The server still rejects those calls if bypassed.
- A user can change their name (via `PATCH /auth/me`) and password from settings.
- A user sees and can revoke their own devices in settings.
- 401 from any endpoint clears the session and redirects to `/login` with `?next=...` preserved.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm --filter @hindsight/web build` all pass.
- The smoke-test runbook in [testing.md](./testing.md) executes cleanly end-to-end against a real Neon DB.

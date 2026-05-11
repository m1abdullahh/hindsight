# Web App — Route Tree, Layouts, Guards

TanStack Router uses file-based routing: each file under `apps/web/src/routes/` is a route. Folders introduce nesting. The router's plugin (wired in [scaffold.md](./scaffold.md)) regenerates `routeTree.gen.ts` whenever files change.

## Tree

```
apps/web/src/routes/
├── __root.tsx                    # root layout (Toaster, error boundary)
├── index.tsx                     # / — redirects based on auth state
│
├── (unauth)/
│   ├── _layout.tsx               # centered card layout, no auth required
│   ├── login.tsx
│   ├── signup.tsx
│   ├── forgot-password.tsx
│   ├── reset-password.tsx        # ?token=...
│   ├── verify-email.tsx          # ?token=...
│   └── invitations/
│       └── accept.tsx            # ?token=...
│
├── (app)/
│   ├── _layout.tsx               # auth-gated shell: sidebar + topbar
│   ├── orgs/
│   │   └── $orgId/
│   │       ├── _layout.tsx       # org-scoped: validates membership exists
│   │       ├── members/
│   │       │   └── index.tsx
│   │       ├── projects/
│   │       │   ├── index.tsx
│   │       │   └── $projectId/
│   │       │       ├── _layout.tsx
│   │       │       ├── index.tsx       # project overview
│   │       │       └── members.tsx     # assignments tab
│   │       ├── time-entries/
│   │       │   └── index.tsx
│   │       └── screenshots/
│   │           ├── index.tsx           # the grid
│   │           └── $screenshotId.tsx   # detail (modal-style route)
│   └── settings/
│       ├── _layout.tsx
│       ├── profile.tsx
│       ├── password.tsx
│       └── devices.tsx
│
└── 404.tsx
```

The TanStack Router file-name rules used above:

- A folder with `_layout.tsx` is a layout route — its children render inside its `<Outlet />`.
- A folder name in **parens** (`(unauth)`) is a _pathless layout group_: it adds a layout but **doesn't** appear in the URL. So `/login` (not `/unauth/login`).
- A `$param` segment binds a path param. `$orgId` becomes `params.orgId`.

Pin `@tanstack/router-plugin` ≥ 1.50; earlier versions require manual `createFileRoute` boilerplate at the top of every file.

## Root route

`__root.tsx`:

```tsx
import { Outlet, ScrollRestoration, createRootRouteWithContext } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import type { QueryClient } from '@tanstack/react-query';

import { Toaster } from '@/components/ui/toaster';
import { ErrorBoundary } from '@/components/error-boundary';

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <ErrorBoundary>
        <ScrollRestoration />
        <Outlet />
      </ErrorBoundary>
      <Toaster />
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </>
  ),
});
```

`ErrorBoundary` is a small custom component (in `apps/web/src/components/error-boundary.tsx`) that catches React errors and renders a "Something went wrong — reload" page. Network/API errors are caught at the query level by the route's component, not here.

## Index redirect

`index.tsx`:

```tsx
import { createFileRoute, redirect } from '@tanstack/react-router';

import { sessionStore } from '@/lib/session-store';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    const { token, currentOrgId } = sessionStore.getState();
    if (!token) throw redirect({ to: '/login' });
    if (currentOrgId)
      throw redirect({ to: '/orgs/$orgId/projects', params: { orgId: currentOrgId } });
    throw redirect({ to: '/login' }); // edge case: token but no memberships → re-login
  },
});
```

The "no memberships" case is rare but real (e.g. a user whose only membership was revoked while their token was still valid). Forcing a re-login is the simplest recovery; the API will rebuild memberships on the next `/auth/me`.

## `(unauth)` layout

`(unauth)/_layout.tsx`:

```tsx
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

import { sessionStore } from '@/lib/session-store';

export const Route = createFileRoute('/(unauth)/_layout')({
  beforeLoad: () => {
    if (sessionStore.getState().token) {
      throw redirect({ to: '/' });
    }
  },
  component: () => (
    <div className="min-h-dvh flex items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-md">
        <Outlet />
      </div>
    </div>
  ),
});
```

Logged-in users hitting `/login` get bounced to the index redirect (which sends them to their last org). The `verify-email` and `reset-password` routes are deliberately under `(unauth)` because the token in the URL is the credential; if the user happens to also be logged in we still want them to land on the action page, not be bounced. **Override**: those two routes don't extend `(unauth)/_layout.tsx`. Instead, put them under a sibling pathless layout `(action)/` that doesn't redirect:

```
(action)/
├── _layout.tsx        # bare card; no auth check
├── reset-password.tsx
└── verify-email.tsx
```

Move them out of `(unauth)/`. Keep the same look so users don't notice; the difference is only the redirect behavior.

## `(app)` layout

`(app)/_layout.tsx`:

```tsx
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

import { AppShell } from '@/components/app-shell';
import { sessionStore } from '@/lib/session-store';

export const Route = createFileRoute('/(app)/_layout')({
  beforeLoad: ({ location }) => {
    const { token } = sessionStore.getState();
    if (!token) {
      throw redirect({
        to: '/login',
        search: { next: location.pathname + location.search },
      });
    }
  },
  loader: async ({ context }) => {
    // Trigger the boot fetch via the query client. AppShell will read the same query.
    return context.queryClient.ensureQueryData({ queryKey: ['auth', 'me'] });
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
```

`AppShell` (in `apps/web/src/components/app-shell.tsx`) renders:

- A topbar with the org switcher (`<Select>` over `state.organizations`), user menu (avatar → "Settings", "Sign out"), and a sign-out-everywhere shortcut for power users (in the user menu).
- A sidebar with: Projects, Members, Time entries, Screenshots, Settings. Members/Time entries are visible to everyone (with member-scoped data); Settings is always visible.
- Footer micro-copy: "Hindsight v0.x" + a link to the privacy page.

The sidebar uses `useCan` to **render** the items differently when admins land — e.g. "Members" is the same link, but admins see "Invite member" inside.

## `orgs/$orgId/_layout.tsx` — org scope guard

```tsx
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

import { sessionStore } from '@/lib/session-store';

export const Route = createFileRoute('/(app)/orgs/$orgId/_layout')({
  beforeLoad: ({ params }) => {
    const state = sessionStore.getState();
    const membership = state.memberships.find((m) => m.orgId === params.orgId);
    if (!membership) {
      throw redirect({ to: '/' });
    }
    if (state.currentOrgId !== params.orgId) {
      state.switchOrg(params.orgId);
    }
  },
  component: Outlet,
});
```

Two effects:

1. URL is the truth — visiting `/orgs/abc/...` always sets `currentOrgId = abc`.
2. Visiting an org you don't have a membership in 404-equivalents back to the index.

Note this **doesn't** validate against the server. If a membership was revoked since the last `/auth/me`, the user might briefly see the layout before the next API call returns 403 and the page surfaces an error. That's acceptable; tightening it requires a synchronous server check on every navigation, which is too expensive for a UX win this small.

## Auth-gated mutations

Most mutations don't need a route guard — calling `apiPost('/auth/sign-out-everywhere')` from a button works. The pattern that _does_ need a route hook:

- **Login success** → call `setSession`, then `router.navigate({ to: '/' })`.
- **Logout** → `apiPost('/auth/logout')` → `clearSession()` → `router.navigate({ to: '/login' })`.
- **401 from anywhere** → handled in the API wrapper (clears session). The next render of any `(app)` route triggers the `beforeLoad` redirect to `/login`.

## Capability gating

Two flavors:

### 1. Hide-the-button (UX)

```tsx
const canInvite = useCan('members:invite');
return (
  <div className="flex items-center justify-between">
    <h1>Members</h1>
    {canInvite && <Button onClick={() => setOpen(true)}>Invite member</Button>}
  </div>
);
```

### 2. Block-the-route (defensive)

For routes that have no business showing to a non-admin, gate at `beforeLoad`:

```tsx
beforeLoad: ({ params }) => {
  // example for a hypothetical /orgs/:orgId/audit route
  const m = sessionStore.getState().memberships.find((x) => x.orgId === params.orgId);
  if (!can(m ?? null, 'audit:read')) throw redirect({ to: `/orgs/${params.orgId}/projects` });
},
```

Almost every page in scope here is fine without route-level capability gates — members can land on the projects/screenshots pages and just see an empty state. The exception is anything explicitly admin-only that has no member-scoped fallback (currently none in this plan; revisit when reports / audit ship).

## URL contract for filters

Filters live in `?searchParams`, validated with TanStack Router's `validateSearch` (Zod):

```tsx
const screenshotsFilter = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
  from: z.string().optional(), // ISO date
  to: z.string().optional(),
  cursor: z.string().optional(),
});

export const Route = createFileRoute('/(app)/orgs/$orgId/screenshots/')({
  validateSearch: (s) => screenshotsFilter.parse(s),
  component: ScreenshotsPage,
});
```

This makes filters bookmarkable and back-button-friendly without us writing a state-sync layer.

## Not-found

`404.tsx`:

```tsx
import { Link, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/404')({
  component: () => (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-semibold">404</h1>
      <p className="text-muted-foreground">That page doesn't exist.</p>
      <Link to="/" className="underline">
        Go home
      </Link>
    </div>
  ),
});
```

The router's `notFoundComponent` option on `__root.tsx` points at this route.

## Summary of files this step ships

- `apps/web/src/routes/__root.tsx`
- `apps/web/src/routes/index.tsx`
- `apps/web/src/routes/404.tsx`
- `apps/web/src/routes/(unauth)/_layout.tsx`
- `apps/web/src/routes/(action)/_layout.tsx`
- `apps/web/src/routes/(app)/_layout.tsx`
- `apps/web/src/routes/(app)/orgs/$orgId/_layout.tsx`
- `apps/web/src/routes/(app)/orgs/$orgId/projects/$projectId/_layout.tsx`
- `apps/web/src/routes/(app)/settings/_layout.tsx`
- `apps/web/src/components/app-shell.tsx`
- `apps/web/src/components/error-boundary.tsx`

Page-level files (the components inside each layout) are listed in [pages.md](./pages.md).

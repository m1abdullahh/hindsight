# Web App — Testing

Three layers, in order of cost-to-maintain:

1. **Unit tests** (Vitest, no DOM) for pure functions: `useCan`, `api.ts` error mapping, the session store actions.
2. **Component tests** (Vitest + React Testing Library + MSW) for forms and high-traffic views: login, invite-accept, the project assignment dialog.
3. **A manual smoke-test runbook** end-to-end against a local API and a real R2 bucket. This is the v0.4 done-when style check ([docs/10-roadmap.md:39-47](../../docs/10-roadmap.md#L39-L47)) for the web client. We don't ship Playwright in this plan — the value-to-maintenance ratio for browser E2E at this stage is poor; the smoke runbook caught the same regressions during scaffolding.

## Vitest setup

`apps/web/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, afterAll } from 'vitest';
import { cleanup } from '@testing-library/react';

import { server } from './msw-server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  localStorage.clear();
});
afterAll(() => server.close());
```

`onUnhandledRequest: 'error'` is intentional — silent passthrough hides "I forgot to mock this endpoint" bugs.

## MSW handlers

`apps/web/src/test/msw-server.ts` exports `server` plus a small set of default happy-path handlers. Tests override on a per-test basis:

```ts
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import type { ErrorBody } from '@hindsight/shared/dto';

const ok = <T>(data: T) => HttpResponse.json(data);
const err = (status: number, code: ErrorBody['error']['code'], message: string) =>
  HttpResponse.json({ error: { code, message } } satisfies ErrorBody, { status });

export const defaultHandlers = [
  http.get('/api/v1/auth/me', () =>
    ok({
      user: {
        id: 'u1',
        email: 'a@b.co',
        name: 'A',
        emailVerifiedAt: null,
        createdAt: '2025-01-01T00:00:00Z',
      },
      organizations: [{ id: 'o1', name: 'Org', createdAt: '2025-01-01T00:00:00Z' }],
      memberships: [
        {
          id: 'm1',
          orgId: 'o1',
          userId: 'u1',
          role: 'owner',
          status: 'active',
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
    }),
  ),
  // …more
];

export const server = setupServer(...defaultHandlers);

// Convenience for tests:
export { http, HttpResponse, ok, err };
```

The default handlers exist so trivial pages can render without each test reciting the auth fixture. For tests that _care_ about the auth state (e.g. logged-out → login), override:

```ts
test('redirects to /login when no token', async () => {
  server.use(http.get('/api/v1/auth/me', () => err(401, 'unauthorized', 'no token')));
  // …
});
```

## Required unit tests

### `use-can.test.ts`

Iterate every `(role × action)` cell from the matrix in [docs/08-auth-and-permissions.md:111-126](../../docs/08-auth-and-permissions.md#L111-L126). One assertion per cell. Mirror the API's `capabilities.test.ts` shape from [`apps/api/src/auth/capabilities.test.ts`](../../apps/api/src/auth/capabilities.test.ts).

Also assert: `can(null, anything) === false` and `can({...status: 'suspended'}, anything) === false`.

### `api.test.ts`

- `apiGet` builds the right URL with query params (skipping undefined/null).
- `apiPost` sets `Content-Type: application/json` only when there's a body.
- 204 responses resolve to `undefined`, not throw on JSON parse.
- 401 with `swallow401: false` calls `clearSession`.
- 401 with `swallow401: true` does **not** call `clearSession`.
- A 4xx error throws an `ApiError` with the right `code`, `status`, and `message`.
- A 5xx with non-JSON body falls back to `{ code: 'internal', message: <statusText> }`.
- The `Authorization` header is set when there's a token, omitted when there isn't.
- The `Idempotency-Key` header is set only when caller passed `idempotencyKey`.

Mock with MSW; no need to mock `fetch` directly.

### `session-store.test.ts`

- `setSession` writes to localStorage with only `token` and `currentOrgId`.
- `setSession` defaults `currentOrgId` to the first membership's orgId when not previously set.
- `setSession` keeps the existing `currentOrgId` if it's still valid.
- `switchOrg` persists; `switchOrg` to an unknown orgId is a no-op.
- `clearSession` wipes both state and localStorage.
- A corrupt `localStorage` value doesn't crash boot — `persisted` falls back to `null`.

## Required component tests

### `login.test.tsx`

- Renders email + password inputs and a submit button.
- Submitting valid creds calls `POST /auth/login`, then navigates to `?next` if present, else `/`.
- 401 from the server renders an inline "Invalid email or password" error (not a toast — login is form-shaped).
- 429 from the throttle renders the "too many attempts" copy with the `Retry-After` value.
- The `?next` param is sanitized — `?next=https://evil.example.com/` is dropped (final navigation goes to `/`).

### `invitations-accept.test.tsx`

- New-user branch: server returns 422 `requires=['password','name']` → render the form → submit → `setSession` → redirect.
- Existing-user-with-password branch: server returns 200 with session → `setSession` → redirect.
- Different-user-logged-in branch: server returns 409 → render "sign out first" with a working sign-out button.
- Invalid token branch: server returns 404 → render "this invitation is no longer valid".

### `project-assignments.test.tsx`

The interesting flow because it stitches three queries:

- Render the page with a project, three assignments, and an org with seven members.
- Open the "Add member" combobox → only the four un-assigned members show.
- Pick one + a rate → submit → `POST /projects/:id/assignments` with the right body → optimistic UI shows the new row → `invalidateQueries(['assignments', projectId])` runs.
- Click "Remove" on an existing row → confirm dialog → `DELETE` → row gets a "removed" pill.
- Re-add the same member → existing row's `removedAt` flips to null (re-uses the row, doesn't duplicate).

That test exercises the parts of the flow most prone to regression — picker filtering, optimistic updates, query invalidation.

## What we are **not** covering with automated tests

- **The screenshot grid layout.** It's a CSS grid with lazy `<img>`. The risk is visual, not logical; one manual cycle per release in the smoke runbook beats a brittle screenshot test.
- **Date formatting.** `date-fns` is well-tested upstream; we don't re-verify it.
- **Routing-layer redirects.** TanStack Router's `beforeLoad` redirects are simple enough that mocking the router state to test them costs more than it saves. The smoke runbook clicks through every redirect path.
- **Auth-token expiry sliding.** Server-side concern; the API's tests cover it.

## Manual smoke-test runbook

Run before merging this plan and before every release.

Prereqs:

- A local API running against a dev Neon branch and a real R2 bucket (per [plans/05-screenshot-ingestion/README.md:97](../05-screenshot-ingestion/README.md#L97)).
- Mail provider env var set (`MAIL_PROVIDER_API_KEY`) so invitation emails actually send. If not set, accept that "send invite" returns `{ mailed: false }` and copy the token from the API response manually.
- Two browser profiles (or a browser + an incognito window) to play the "owner" and "invited member" roles.
- `pnpm --filter @hindsight/web dev` running in a third terminal.

Sequence:

1. **Owner profile**: visit `/signup`, create an account with org name "Smoke Co". Land on `/orgs/:orgId/projects` (empty).
2. **Owner**: navigate to `/orgs/:orgId/members`. Click "Invite member", enter an email you control, role `member`. Verify the toast.
3. **Owner**: click "Copy link" on the pending invite (or grab the token from the API response in DevTools).
4. **Invited profile** (incognito): paste the invite link. Form should ask for password + name (new-user branch). Submit. You should land on `/orgs/:orgId/projects` (empty for the member because no projects yet).
5. **Owner**: create a new project ("Smoke project"). Default interval, no blur.
6. **Owner**: navigate to project detail → Members → Add member → pick the invited account. Optional rate $25/hr.
7. **Invited profile**: refresh the projects page. The new project shows. Click into it. Members tab works (member can read but not write).
8. **Curl-driven device + time entry + screenshot upload** (the desktop app isn't built yet):
   - `POST /devices/register` with the invited user's web token → grab `deviceId` + `deviceToken`.
   - `POST /time-entries` with `{ projectId, startedAt: now }` and `Idempotency-Key` → grab the `timeEntryId`.
   - `POST /screenshots/presign` with `{ timeEntryId, capturedAt: now, monitorIndex: 0, contentType: 'image/jpeg' }` → grab `putUrl` and `screenshotId`.
   - `curl -T sample.jpg "<putUrl>" -H 'Content-Type: image/jpeg'` → 200.
   - `POST /screenshots/:id/confirm` with `{ width, height, ..., sizeBytes }` → 200.
9. **Invited profile**: navigate to `/orgs/:orgId/screenshots`. Wait up to 30s for the worker to process. The thumbnail appears.
10. **Invited profile**: click the thumbnail → modal opens with the full-res image and metadata.
11. **Invited profile**: try "Delete". Within the grace window → 200 → row disappears. Past grace → 422 toast "Deletion window has passed."
12. **Owner profile**: navigate to the same `/orgs/:orgId/screenshots` (same data, different access). Confirm the screenshot is visible to the owner regardless of who took it.
13. **Owner profile**: archive the project → `Archive` switch in the UI. Members tab on the archived project still loads (read-only). Member's projects list now shows zero (default filter excludes archived).
14. **Owner profile**: settings → password → change password. Toast "Password changed. Other sessions signed out." The current session keeps working.
15. **Owner profile**: log out from the user menu → land on `/login`. Logging back in works.

If any step deviates, file a follow-up issue or fix in this plan before merging.

## CI

`pnpm test` runs Vitest in `run` mode for every workspace. The web tests join the existing API test suite. No special CI changes for this plan beyond the standard `pnpm install && pnpm -r typecheck && pnpm -r lint && pnpm -r test`.

## Coverage target

Same posture as Plan 02 ([plans/02-auth-and-orgs/testing.md:107-110](../02-auth-and-orgs/testing.md#L107-L110)) — we're not chasing a coverage number for v0.x. The aim is **the unit tests listed above + the component tests listed above + the smoke runbook executed cleanly**. A coverage threshold gets added when the codebase has a few more sprints under it.

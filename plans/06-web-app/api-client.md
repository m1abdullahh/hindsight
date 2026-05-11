# Web App — API Client, Session Store, Query Setup

The web client talks to the API through a single typed `fetch` wrapper that handles base URL, auth header injection, JSON encoding, and error normalization. Every server read goes through TanStack Query; mutations go through `useMutation`. Session state — the bearer token, the user, their memberships, and the currently-selected org — lives in one Zustand store.

## DTO sharing through `@hindsight/shared`

The API today defines DTO interfaces inline in [`apps/api/src/lib/dto.ts`](../../apps/api/src/lib/dto.ts). Step 1 of this plan moves the **type declarations** (not the conversion functions) into `packages/shared/src/dto.ts` and re-exports them from the API for backwards compat:

```ts
// packages/shared/src/dto.ts
export interface UserDto {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: string | null;
  createdAt: string;
}

export interface OrganizationDto {
  id: string;
  name: string;
  createdAt: string;
}

export interface MembershipDto {
  id: string;
  orgId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  status: 'active' | 'suspended';
  createdAt: string;
}

export interface InvitationDto {
  id: string;
  orgId: string;
  email: string;
  role: 'admin' | 'member';
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  invitedBy: { id: string; name: string };
  createdAt: string;
}

export interface ProjectDto {
  /* per plans/04 */
}
export interface ProjectAssignmentDto {
  /* per plans/04 */
}

export interface DeviceDto {
  id: string;
  userId: string;
  deviceName: string;
  os: 'mac' | 'win' | 'linux';
  appVersion: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface TimeEntryDto {
  id: string;
  orgId: string;
  userId: string;
  projectId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  totalActiveSeconds: number;
  totalIdleSeconds: number;
  notes: string | null;
}

export type ScreenshotStatus = 'pending' | 'uploaded' | 'processed' | 'failed';

export interface ScreenshotDto {
  id: string;
  orgId: string;
  userId: string;
  projectId: string;
  timeEntryId: string;
  status: ScreenshotStatus;
  capturedAt: string;
  monitorIndex: number;
  width: number | null;
  height: number | null;
  activeApp: string | null;
  activeWindowTitle: string | null;
  keyboardEventsCount: number;
  mouseEventsCount: number;
  sizeBytes: number | null;
  thumbnailUrl: string | null; // presigned, short-lived
  fullResUrl: string | null; // populated only on detail endpoint
  deletedAt: string | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ErrorBody {
  error: {
    code:
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'invalid_input'
      | 'rate_limited'
      | 'internal'
      | 'too_many_attempts'
      | 'mail_unavailable'
      | 'r2_unavailable';
    message: string;
    details?: Record<string, unknown>;
  };
}
```

The exact field set for each DTO comes from whatever the API's `dto.ts` already exports — copy verbatim, don't redesign during the move. After the move, `apps/api/src/lib/dto.ts` looks like:

```ts
export type {
  UserDto,
  OrganizationDto,
  MembershipDto,
  InvitationDto,
  ProjectDto,
  ProjectAssignmentDto,
  DeviceDto,
  TimeEntryDto,
  ScreenshotDto,
  ScreenshotStatus,
  PaginatedResponse,
  ErrorBody,
} from '@hindsight/shared/dto';

// Conversion functions stay here:
export const toUserDto = (u: User): UserDto => ({
  /* ... */
});
// ... etc
```

`packages/shared/src/index.ts` re-exports `dto.ts`:

```ts
export * from './dto.js';
```

(The `.js` import suffix is the project's TS-with-NodeNext convention from [`tsconfig.base.json`](../../tsconfig.base.json) — keep it.)

## `apps/web/src/lib/api.ts` — the fetch wrapper

```ts
import type { ErrorBody } from '@hindsight/shared/dto';

import { sessionStore } from './session-store';

const BASE_URL = import.meta.env['VITE_API_BASE_URL'] ?? '';
// Empty string = same-origin (Vite dev proxy or production reverse proxy).

export class ApiError extends Error {
  readonly code: ErrorBody['error']['code'];
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: ErrorBody) {
    super(body.error.message);
    this.code = body.error.code;
    this.status = status;
    this.details = body.error.details;
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  // Mutations to desktop-tagged endpoints need this; web mutations don't.
  idempotencyKey?: string;
  // Set by callers that intentionally tolerate 401 (e.g. boot-time `/auth/me`).
  swallow401?: boolean;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const url = new URL(`${BASE_URL}/api/v1${path}`, window.location.origin);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = sessionStore.getState().token;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let body: ErrorBody;
    if (contentType.includes('application/json')) {
      body = (await res.json()) as ErrorBody;
    } else {
      body = { error: { code: 'internal', message: res.statusText } };
    }
    if (res.status === 401 && !opts.swallow401) {
      sessionStore.getState().clearSession();
      // The router redirect happens in the route guard; we just clear here.
    }
    throw new ApiError(res.status, body);
  }

  return (await res.json()) as T;
}
```

Notes:

- The wrapper does **not** retry. TanStack Query's retry policy handles network blips (default: 3 retries with exponential backoff for queries, 0 for mutations).
- `swallow401` exists for one place only: the boot-time `/auth/me` call that runs even if there's no token (or a stale one). Other callers want the auto-clear behavior.
- The wrapper is **agnostic to the response envelope.** Some endpoints return bare DTOs (`{ id, name, ... }`); list endpoints return `{ items, nextCursor }`. The caller types the response. We don't pretend everything is wrapped.
- We don't read the `expiresAt` from auth responses. The server slides expiry on every request; if the token is stale, we get a 401 and clear. Storing the expiry adds complexity for no benefit at our scale.
- `Idempotency-Key` is **not** generated automatically. Web mutations don't need it (per [docs/05-api-surface.md:13](../../docs/05-api-surface.md#L13)). The parameter exists so a caller can opt in if they want, e.g. for a flaky-network screenshot delete. Default: omit.

### Helper functions on top

```ts
export const apiGet = <T>(path: string, query?: ApiOptions['query']) =>
  api<T>(path, { method: 'GET', query });

export const apiPost = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });

export const apiPatch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });

export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });
```

These cut the noise in TanStack Query callsites without adding a layer that's hard to reason about.

## `apps/web/src/lib/session-store.ts` — Zustand store

```ts
import type { MembershipDto, OrganizationDto, UserDto } from '@hindsight/shared/dto';
import { create } from 'zustand';

const STORAGE_KEY = 'hindsight.session';

export interface SessionState {
  token: string | null;
  user: UserDto | null;
  organizations: Record<string, OrganizationDto>; // keyed by orgId
  memberships: MembershipDto[];
  currentOrgId: string | null;
  setSession: (s: {
    token: string;
    user: UserDto;
    organizations: OrganizationDto[];
    memberships: MembershipDto[];
  }) => void;
  switchOrg: (orgId: string) => void;
  clearSession: () => void;
}

const persisted = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Pick<SessionState, 'token' | 'currentOrgId'>;
  } catch {
    return null;
  }
})();

export const sessionStore = create<SessionState>((set, get) => ({
  token: persisted?.token ?? null,
  user: null, // hydrated from /auth/me on boot
  organizations: {},
  memberships: [],
  currentOrgId: persisted?.currentOrgId ?? null,
  setSession: ({ token, user, organizations, memberships }) => {
    const orgsByid = Object.fromEntries(organizations.map((o) => [o.id, o]));
    const currentOrgId =
      get().currentOrgId && orgsByid[get().currentOrgId!]
        ? get().currentOrgId
        : (memberships[0]?.orgId ?? null);
    set({ token, user, organizations: orgsByid, memberships, currentOrgId });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, currentOrgId }));
  },
  switchOrg: (orgId) => {
    if (!get().organizations[orgId]) return;
    set({ currentOrgId: orgId });
    const token = get().token;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, currentOrgId: orgId }));
  },
  clearSession: () => {
    set({ token: null, user: null, organizations: {}, memberships: [], currentOrgId: null });
    localStorage.removeItem(STORAGE_KEY);
  },
}));

// Selector helpers — use in components instead of grabbing the whole state.
export const useToken = () => sessionStore((s) => s.token);
export const useUser = () => sessionStore((s) => s.user);
export const useCurrentMembership = () =>
  sessionStore((s) =>
    s.currentOrgId ? (s.memberships.find((m) => m.orgId === s.currentOrgId) ?? null) : null,
  );
```

Why this shape:

- **Only `token` and `currentOrgId` are persisted.** User and memberships rehydrate from `/auth/me` on every page load. Persisting them invites stale-data bugs (a user whose role got demoted while a tab was closed shouldn't see their old permissions).
- **`switchOrg` is the only writeable cross-tab thing**, and it persists. The session store is _not_ synchronized across tabs — a user logging out in tab A doesn't clear tab B until tab B's next request returns 401. We accept this; it's correct behavior for an internal app.
- **No `setUser` / `setMemberships` actions** — `setSession` always sets the whole bundle. Refreshing memberships uses TanStack Query for `/auth/me` and pipes the result through `setSession`.

## `apps/web/src/lib/query.ts` — TanStack Query setup

```ts
import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          // Don't retry on 4xx — the server told us the answer.
          if (error.status >= 400 && error.status < 500) return false;
        }
        return failureCount < 3;
      },
    },
    mutations: {
      retry: 0,
    },
  },
});
```

Stale time of 30s means switching tabs and coming back triggers a refetch but tight in-page navigation doesn't hammer the API.

## Capability hook

`apps/web/src/lib/use-can.ts`:

```ts
import type { MembershipDto } from '@hindsight/shared/dto';

import { useCurrentMembership } from './session-store';

export type Action =
  | 'org:manage'
  | 'members:invite'
  | 'members:manage'
  | 'projects:create'
  | 'projects:assign_members'
  | 'projects:read_all'
  | 'devices:read_org'
  | 'screenshots:read_all'
  | 'audit:read';

export function can(membership: MembershipDto | null, action: Action): boolean {
  if (!membership || membership.status !== 'active') return false;
  const role = membership.role;
  switch (action) {
    case 'org:manage':
      return role === 'owner';
    case 'members:invite':
    case 'members:manage':
    case 'projects:create':
    case 'projects:assign_members':
    case 'projects:read_all':
    case 'devices:read_org':
    case 'screenshots:read_all':
    case 'audit:read':
      return role === 'owner' || role === 'admin';
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export function useCan(action: Action): boolean {
  const m = useCurrentMembership();
  return can(m, action);
}
```

Two rules for using this:

1. **The UI gate is hint-only.** Every server endpoint re-checks. If `useCan` is wrong, the worst outcome is a button that 403s when clicked.
2. **Mirror the server's `can()`** in [`apps/api/src/auth/capabilities.ts`](../../apps/api/src/auth/capabilities.ts) wherever it's a clean role-only branch. Branches that need resource context (e.g. `projects:read` for a member depends on whether they're assigned) **do not** belong in `useCan`. Use route loaders + the API to gate those — if the loader 404s or 403s, the page handles it.

`useCan` has unit tests: every `(role × action)` cell from the matrix in [docs/08-auth-and-permissions.md:111-126](../../docs/08-auth-and-permissions.md#L111-L126). Pure function, cheap, prevents drift.

## Boot sequence

`apps/web/src/lib/use-boot.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

import { api } from './api';
import { sessionStore } from './session-store';

interface MeResponse {
  user: UserDto;
  memberships: MembershipDto[];
  organizations: OrganizationDto[];
}

export function useBoot() {
  const token = sessionStore((s) => s.token);
  return useQuery({
    queryKey: ['auth', 'me'],
    enabled: !!token,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const me = await api<MeResponse>('/auth/me', { swallow401: true });
      sessionStore.getState().setSession({ token: token!, ...me });
      return me;
    },
  });
}
```

Used at the root layout. While `isLoading`, render a full-page spinner. On 401 → `clearSession` (handled inside the wrapper) → router redirects to `/login` because `useToken()` becomes null.

## Toasts and errors

shadcn ships a `<Toaster />` and a `useToast()` hook. Wrap mutations:

```ts
const mutation = useMutation({
  mutationFn: (input) => apiPost('/orgs/' + orgId + '/invitations', input),
  onSuccess: () => {
    toast({ title: 'Invitation sent' });
    queryClient.invalidateQueries({ queryKey: ['invitations', orgId] });
  },
  onError: (err) => {
    if (err instanceof ApiError && err.code === 'conflict') {
      toast({ title: 'Already invited', description: err.message, variant: 'destructive' });
      return;
    }
    toast({ title: 'Something went wrong', description: err.message, variant: 'destructive' });
  },
});
```

The pattern repeats — extract a `useApiMutation` helper if the same `onError` boilerplate shows up four times. Don't extract earlier.

## Why no Axios

`fetch` is in every browser we care about. Axios adds 14 KB gzipped for features (interceptors, automatic JSON, transformers) that we wire by hand in 80 lines. Pass.

## What this file ships

- `apps/web/src/lib/api.ts` — `api()`, `ApiError`, `apiGet`/`apiPost`/`apiPatch`/`apiDelete`
- `apps/web/src/lib/session-store.ts` — Zustand store + selector hooks
- `apps/web/src/lib/query.ts` — `queryClient`
- `apps/web/src/lib/use-can.ts` — capability hook + tests
- `apps/web/src/lib/use-boot.ts` — boot-time `/auth/me` fetch
- Updates to `apps/api/src/lib/dto.ts` (re-export from `@hindsight/shared/dto`) and `packages/shared/src/dto.ts` (the DTO interfaces)

After this step, [routes.md](./routes.md) wires the layouts and route guards on top.

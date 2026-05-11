# Desktop MVP — React UI

The Tauri window is a small narrow panel (480×720) with three states: **Login**, **Project picker**, **Tracking**. Plus a tray icon. No router — a single `App` component that conditionally renders based on session state.

This plan deliberately keeps the UI minimal. Polish (in-app screenshot grid, settings page, recent captures, capture flash) is Plan 09.

## State machine — one Zustand store

`apps/desktop/src/lib/session-store.ts`:

```ts
import type { OrganizationDto, ProjectDto, UserDto } from '@hindsight/shared/dto';
import { create } from 'zustand';

export type Stage = 'login' | 'picking' | 'tracking';

export interface DesktopSession {
  stage: Stage;
  // Set after login + device register.
  user: UserDto | null;
  organizations: OrganizationDto[];
  currentOrgId: string | null;
  // Set after pick.
  currentProject: ProjectDto | null;
  // Set after Start.
  timeEntryId: string | null;
  startedAt: string | null;
  pendingUploads: number;
  setLoggedIn: (s: { user: UserDto; orgs: OrganizationDto[] }) => void;
  setOrg: (orgId: string) => void;
  setProject: (project: ProjectDto) => void;
  startTracking: (timeEntryId: string, startedAt: string) => void;
  stopTracking: () => void;
  setPendingUploads: (count: number) => void;
  signOut: () => void;
}

export const session = create<DesktopSession>((set) => ({
  stage: 'login',
  user: null,
  organizations: [],
  currentOrgId: null,
  currentProject: null,
  timeEntryId: null,
  startedAt: null,
  pendingUploads: 0,
  setLoggedIn: ({ user, orgs }) =>
    set({
      user,
      organizations: orgs,
      currentOrgId: orgs[0]?.id ?? null,
      stage: 'picking',
    }),
  setOrg: (orgId) => set({ currentOrgId: orgId }),
  setProject: (project) => set({ currentProject: project }),
  startTracking: (timeEntryId, startedAt) => set({ timeEntryId, startedAt, stage: 'tracking' }),
  stopTracking: () => set({ timeEntryId: null, startedAt: null, stage: 'picking' }),
  setPendingUploads: (count) => set({ pendingUploads: count }),
  signOut: () =>
    set({
      stage: 'login',
      user: null,
      organizations: [],
      currentOrgId: null,
      currentProject: null,
      timeEntryId: null,
      startedAt: null,
    }),
}));
```

The session store **does not persist** any of this state. The device token is in Keychain (Rust-side); on app launch, if a token exists in Keychain, we hop straight to the picking stage with a `/auth/me` fetch. No tokens in localStorage, no JSON dumps.

## API client

`apps/desktop/src/lib/api.ts` — almost identical to the web app's, but with two differences:

1. **Base URL is the build-time constant** `__API_BASE_URL__` (defined in `vite.config.ts`), not a `VITE_*` env var with a same-origin default. The desktop is never same-origin with anything.
2. **Token comes from Tauri**, not from a Zustand store. The Rust side owns the device token in Keychain; JS asks for it via a Tauri command.

```ts
import { invoke } from '@tauri-apps/api/core';

declare const __API_BASE_URL__: string;

let cachedToken: string | null = null;

async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await invoke<string | null>('get_device_token');
  return cachedToken;
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const url = `${__API_BASE_URL__}/api/v1${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = await getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const apiGet = <T>(path: string) => api<T>(path);
export const apiPost = <T>(path: string, body?: unknown, idemKey?: string) =>
  api<T>(path, { method: 'POST', body, idempotencyKey: idemKey });
export const apiPatch = <T>(path: string, body: unknown, idemKey?: string) =>
  api<T>(path, { method: 'PATCH', body, idempotencyKey: idemKey });

export const clearTokenCache = () => {
  cachedToken = null;
};
```

The Rust side exposes:

```rust
#[tauri::command]
fn get_device_token(tokens: tauri::State<'_, DeviceTokenStore>) -> Option<String> {
    tokens.get()
}

#[tauri::command]
fn set_device_token(
    tokens: tauri::State<'_, DeviceTokenStore>,
    token: String,
) -> Result<(), String> {
    tokens.set(token).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_device_token(
    tokens: tauri::State<'_, DeviceTokenStore>,
) -> Result<(), String> {
    tokens.clear().map_err(|e| e.to_string())
}
```

Where `DeviceTokenStore` wraps the `keyring` crate:

```rust
pub struct DeviceTokenStore {
    entry: keyring::Entry,
    cache: parking_lot::Mutex<Option<String>>,
}

impl DeviceTokenStore {
    pub fn load(_: &tauri::AppHandle) -> Self {
        let entry = keyring::Entry::new("app.hindsight.desktop", "device_token")
            .expect("keyring entry");
        let cache = parking_lot::Mutex::new(entry.get_password().ok());
        Self { entry, cache }
    }
    pub fn get(&self) -> Option<String> {
        self.cache.lock().clone()
    }
    pub fn set(&self, token: String) -> keyring::Result<()> {
        self.entry.set_password(&token)?;
        *self.cache.lock() = Some(token);
        Ok(())
    }
    pub fn clear(&self) -> keyring::Result<()> {
        self.entry.delete_credential()?;
        *self.cache.lock() = None;
        Ok(())
    }
}
```

## App.tsx — top-level renderer

```tsx
import { useEffect } from 'react';

import { LoginScreen } from './screens/LoginScreen';
import { PickingScreen } from './screens/PickingScreen';
import { TrackingScreen } from './screens/TrackingScreen';
import { Toaster } from './components/ui/toaster';
import { session } from './lib/session-store';
import { apiGet, clearTokenCache } from './lib/api';
import { invoke } from '@tauri-apps/api/core';

export function App() {
  const stage = session((s) => s.stage);

  // On boot, if we have a device token in Keychain, validate it via /auth/me
  // and skip straight to picking.
  useEffect(() => {
    (async () => {
      const token = await invoke<string | null>('get_device_token');
      if (!token) return;
      try {
        const me = await apiGet<{ user: any; memberships: any[] }>('/auth/me');
        const orgs = await Promise.all(
          me.memberships.map((m) => apiGet<any>(`/orgs/${m.orgId}`).catch(() => null)),
        );
        session.getState().setLoggedIn({
          user: me.user,
          orgs: orgs.filter(Boolean),
        });
      } catch {
        // Token is bad. Clear and stay on login.
        await invoke('clear_device_token');
        clearTokenCache();
      }
    })();
  }, []);

  return (
    <>
      {stage === 'login' && <LoginScreen />}
      {stage === 'picking' && <PickingScreen />}
      {stage === 'tracking' && <TrackingScreen />}
      <Toaster />
    </>
  );
}
```

## Login screen

`apps/desktop/src/screens/LoginScreen.tsx`:

```tsx
import type { MembershipDto, UserDto } from '@hindsight/shared/dto';
import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Spinner } from '../components/ui/spinner';
import { useToast } from '../components/ui/use-toast';
import { apiPost, apiGet, clearTokenCache } from '../lib/api';
import { session } from '../lib/session-store';

interface LoginResponse {
  user: UserDto;
  memberships: MembershipDto[];
  token: string;
}
interface RegisterResponse {
  deviceId: string;
  deviceToken: string;
}

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      // 1. POST /auth/login — get a web token.
      const login = await apiPost<LoginResponse>('/auth/login', { email, password });

      // 2. Use the web token (in-memory only) to register a device.
      // The api wrapper reads from Keychain, so we need to push the web token
      // through a different path. Simplest: set it as the keyring value
      // temporarily, register, then overwrite with the device token.
      await invoke('set_device_token', { token: login.token });
      clearTokenCache();

      const reg = await apiPost<RegisterResponse>(
        '/devices/register',
        {
          deviceName: deviceName(),
          os: 'win',
          appVersion: __APP_VERSION__,
        },
        crypto.randomUUID(),
      );

      // 3. Replace the web token with the device token in Keychain.
      await invoke('set_device_token', { token: reg.deviceToken });
      clearTokenCache();

      // 4. Hydrate org list.
      const orgs = await Promise.all(
        login.memberships.map((m) => apiGet<any>(`/orgs/${m.orgId}`).catch(() => null)),
      );

      session.getState().setLoggedIn({
        user: login.user,
        orgs: orgs.filter(Boolean),
      });
    } catch (err) {
      toast({
        title: 'Could not sign in',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">Hindsight</h1>
          <p className="text-sm text-muted-foreground">Sign in to start tracking.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? <Spinner /> : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}

function deviceName(): string {
  // Best-effort host identifier. Plan 09 reads the actual hostname via Tauri.
  return `Windows · ${new Date().toISOString().slice(0, 10)}`;
}
```

(`__APP_VERSION__` is another Vite `define` constant — set from `package.json` version.)

## Picking screen

`apps/desktop/src/screens/PickingScreen.tsx`:

```tsx
import type { ProjectDto } from '@hindsight/shared/dto';
import { useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { useToast } from '../components/ui/use-toast';
import { apiGet, apiPost } from '../lib/api';
import { session } from '../lib/session-store';
import { invoke } from '@tauri-apps/api/core';

interface ProjectsResponse {
  projects: ProjectDto[];
}
interface TimeEntryResponse {
  id: string;
  startedAt: string;
}

export function PickingScreen() {
  const { user, currentOrgId, organizations } = session();
  const setOrg = session((s) => s.setOrg);
  const setProject = session((s) => s.setProject);
  const startTracking = session((s) => s.startTracking);
  const signOut = session((s) => s.signOut);
  const { toast } = useToast();

  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!currentOrgId) return;
    setLoading(true);
    apiGet<ProjectsResponse>(`/orgs/${currentOrgId}/projects`)
      .then((r) => setProjects(r.projects.filter((p) => !p.archivedAt)))
      .catch((e) =>
        toast({ title: 'Could not load projects', description: e.message, variant: 'destructive' }),
      )
      .finally(() => setLoading(false));
  }, [currentOrgId, toast]);

  const onStart = async () => {
    const project = projects.find((p) => p.id === selectedId);
    if (!project) return;
    setStarting(true);
    try {
      const startedAt = new Date().toISOString();
      const entry = await apiPost<TimeEntryResponse>(
        '/time-entries',
        { projectId: project.id, startedAt },
        crypto.randomUUID(),
      );
      setProject(project);
      startTracking(entry.id, entry.startedAt);

      // Tell Rust to start the capture loop.
      await invoke('set_tracking', {
        tracking: {
          time_entry_id: entry.id,
          interval_minutes: project.screenshotIntervalMinutes,
        },
      });
    } catch (err) {
      toast({
        title: "Couldn't start",
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setStarting(false);
    }
  };

  const onSignOut = async () => {
    await invoke('clear_device_token');
    signOut();
  };

  return (
    <div className="flex min-h-dvh flex-col p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{user?.name}</p>
          <p className="text-xs text-muted-foreground">{user?.email}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onSignOut}>
          Sign out
        </Button>
      </header>

      {organizations.length > 1 && (
        <div className="mb-4 space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Organization
          </label>
          <Select value={currentOrgId ?? ''} onValueChange={setOrg}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {organizations.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex-1 space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Project
          </label>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You haven&apos;t been assigned to any active projects yet. Ask an admin to add you.
            </p>
          ) : (
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <Button className="w-full" size="lg" disabled={!selectedId || starting} onClick={onStart}>
        {starting ? <Spinner /> : 'Start tracking'}
      </Button>
    </div>
  );
}
```

## Tracking screen

`apps/desktop/src/screens/TrackingScreen.tsx`:

```tsx
import { invoke } from '@tauri-apps/api/core';
import { Square } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { useToast } from '../components/ui/use-toast';
import { apiPatch } from '../lib/api';
import { session } from '../lib/session-store';

export function TrackingScreen() {
  const { currentProject, timeEntryId, startedAt, pendingUploads } = session();
  const stopTracking = session((s) => s.stopTracking);
  const { toast } = useToast();
  const [stopping, setStopping] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsedSec(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const onStop = async () => {
    if (!timeEntryId) return;
    setStopping(true);
    try {
      // Tell Rust to stop the capture loop.
      await invoke('set_tracking', { tracking: null });
      await apiPatch(
        `/time-entries/${timeEntryId}`,
        { endedAt: new Date().toISOString() },
        crypto.randomUUID(),
      );
      stopTracking();
    } catch (err) {
      toast({
        title: "Couldn't stop cleanly",
        description:
          (err instanceof Error ? err.message : 'Unknown error') +
          ' — your time entry may need to be closed from the web.',
        variant: 'destructive',
      });
      stopTracking(); // Always return to picker — server-side time entry can be patched later.
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="bg-destructive py-2 text-center text-xs font-semibold uppercase tracking-wide text-destructive-foreground">
        ● Tracking
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-muted-foreground">Working on</p>
        <p className="text-xl font-semibold">{currentProject?.name ?? '—'}</p>
        <p className="mt-4 text-5xl font-mono tabular-nums">{formatElapsed(elapsedSec)}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Captures every {currentProject?.screenshotIntervalMinutes ?? 10} min
        </p>
        {pendingUploads > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {pendingUploads} pending upload{pendingUploads === 1 ? '' : 's'}
          </p>
        )}
      </div>
      <div className="p-6">
        <Button
          variant="destructive"
          size="lg"
          className="w-full"
          onClick={onStop}
          disabled={stopping}
        >
          {stopping ? (
            <Spinner />
          ) : (
            <>
              <Square className="mr-2 h-4 w-4" />
              Stop
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

const formatElapsed = (totalSec: number): string => {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((n) => n.toString().padStart(2, '0')).join(':');
};
```

The big red banner at the top is the "tracking is active" affordance per [docs/06-desktop-app.md:136-138](../../docs/06-desktop-app.md#L136-L138). Combined with the tray icon's tracking state, the user can never accidentally forget the app is recording.

## Pending uploads counter

A Tauri event from Rust: every time the upload worker writes back (`uploaded_at = now`), it emits an event. The React side subscribes once and feeds the store:

```ts
// In App.tsx mount:
import { listen } from '@tauri-apps/api/event';

listen<{ pending: number }>('outbox.changed', (e) => {
  session.getState().setPendingUploads(e.payload.pending);
});
```

The Rust side emits this after every successful upload AND after every `persist_capture`:

```rust
// in scheduler.rs after persist_capture, in uploader.rs after marking uploaded:
let pending = sqlx::query_scalar!(
    "SELECT COUNT(*) FROM outbox_screenshots WHERE uploaded_at IS NULL"
).fetch_one(&db).await?;
let _ = app_handle.emit("outbox.changed", serde_json::json!({ "pending": pending }));
```

(Both functions take an `AppHandle` parameter to call `emit`.)

## Tray icon

`src-tauri/src/lib.rs` setup, after spawning the workers:

```rust
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
let stop = MenuItem::with_id(app, "stop", "Stop tracking", true, None::<&str>)?;
let open = MenuItem::with_id(app, "open", "Open Hindsight", true, None::<&str>)?;
let menu = Menu::with_items(app, &[&open, &stop, &quit])?;

let _tray = TrayIconBuilder::with_id("main")
    .icon(app.default_window_icon().unwrap().clone())
    .menu(&menu)
    .on_menu_event(|app, event| match event.id().as_ref() {
        "quit" => {
            app.exit(0);
        }
        "open" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        "stop" => {
            // Send a JS event the React side responds to by clicking Stop.
            let _ = app.emit("tray.stop", ());
        }
        _ => {}
    })
    .build(app)?;
```

The `tray.stop` event drives a `useEffect` listener in `TrackingScreen` that calls the same `onStop` function the Stop button does. The two-state icon (idle vs tracking) is updated from React when stage changes — emit a `set_tray_state` Tauri command that swaps icons.

**Tray icons:** prepare two PNGs in `src-tauri/icons/`:

- `tray-idle.png` — neutral
- `tray-tracking.png` — same shape with a small red dot in the corner

A real designer makes them; for v0.5 a basic SVG-derived PNG is fine.

## UI components reused from web

Copy these component files verbatim from `apps/web/src/components/ui/` into `apps/desktop/src/components/ui/`:

- `button.tsx`
- `input.tsx`
- `label.tsx`
- `select.tsx`
- `spinner.tsx`
- `toast.tsx`, `toaster.tsx`, `use-toast.ts`

Plus `lib/utils.ts` (the `cn` helper). They have no shared dependencies; they're identical to the web copies. We don't extract them into `@hindsight/shared` yet — that's a refactor for when we have three apps using them.

## What this plan does NOT include in the UI

- A "recent screenshots" list (Plan 09)
- A settings page in-app (Plan 09)
- An onboarding "what we record" screen (Plan 09)
- Capture-flash overlay or sound (v0.8)
- Forgot-password / signup flows (the desktop assumes you already have an account from the web)
- Permission-grant prompts (Windows doesn't have the macOS Screen Recording / Input Monitoring permission gates — that UX comes back when the macOS port lands in Plan 09)

If a user without an account tries to log in, they get an error — the toast tells them to go to the web app first. That's deliberate UX-narrowing for the MVP.

## Files this plan adds

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/main.tsx` (already from scaffold)
- `apps/desktop/src/lib/session-store.ts`
- `apps/desktop/src/lib/api.ts`
- `apps/desktop/src/screens/LoginScreen.tsx`
- `apps/desktop/src/screens/PickingScreen.tsx`
- `apps/desktop/src/screens/TrackingScreen.tsx`
- `apps/desktop/src/components/ui/{button,input,label,select,spinner,toast,toaster,use-toast}.tsx`
- `apps/desktop/src/lib/utils.ts`
- Tray-related code in `src-tauri/src/lib.rs`
- New Tauri commands: `get_device_token`, `set_device_token`, `clear_device_token`, `set_tracking`, `set_tray_state`
- New Tauri events: `outbox.changed`, `tray.stop`

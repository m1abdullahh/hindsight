import type { MembershipDto, OrganizationDto, UserDto } from '@hindsight/shared/dto';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

import { UpdaterDialog } from './components/UpdaterDialog';
import { Toaster } from './components/ui/toaster';
import { toast } from './components/ui/use-toast';
import { LoginScreen } from './screens/LoginScreen';
import { PermissionGateScreen } from './screens/PermissionGateScreen';
import { TrackerScreen } from './screens/TrackerScreen';
import { ApiError, apiGet, clearTokenCache } from './lib/api';
import { session } from './lib/session-store';
import { usePresenceHeartbeat } from './lib/use-presence-heartbeat';
import { useUpdater } from './lib/use-updater';

export function App() {
  const stage = session((s) => s.stage);
  const setLoggedIn = session((s) => s.setLoggedIn);
  const setPendingUploads = session((s) => s.setPendingUploads);
  const signOut = session((s) => s.signOut);
  const [booting, setBooting] = useState(true);
  // OS permission gate (macOS Screen Recording). Starts false so that on
  // Windows / X11 — where PermissionGateScreen reports granted immediately
  // — we never show the gate at all.
  const [permissionsOk, setPermissionsOk] = useState(false);

  usePresenceHeartbeat();
  const updater = useUpdater();

  // On boot, if a device token exists in Credential Manager, validate it
  // via /auth/me and skip straight to picking.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await invoke<string | null>('get_device_token').catch(() => null);
      if (!token || cancelled) {
        setBooting(false);
        return;
      }
      try {
        const me = await apiGet<{ user: UserDto; memberships: MembershipDto[] }>('/auth/me');

        // Desktop is for tracking members only. If the stored token belongs
        // to an admin/owner (e.g. an older install before this rule existed),
        // drop the token and stay on the login screen.
        if (me.memberships.some((m) => m.role !== 'member')) {
          await invoke('clear_device_token').catch(() => undefined);
          clearTokenCache();
          return;
        }

        const orgs = (
          await Promise.all(
            me.memberships.map((m) =>
              apiGet<OrganizationDto>(`/orgs/${m.orgId}`).catch(() => null),
            ),
          )
        ).filter((o): o is OrganizationDto => o !== null);
        if (cancelled) return;
        setLoggedIn({ user: me.user, orgs, memberships: me.memberships });
      } catch (err) {
        // Token invalid or server unreachable; clear and stay on login.
        if (err instanceof ApiError && err.status === 401) {
          await invoke('clear_device_token').catch(() => undefined);
          clearTokenCache();
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setLoggedIn]);

  // Subscribe to outbox-changed events from Rust. Tauri 2 rejects `.` in
  // event names so we use a dash.
  useEffect(() => {
    const unlistenPromise = listen<{ pending: number }>('outbox-changed', (e) => {
      setPendingUploads(e.payload.pending);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [setPendingUploads]);

  // `reauth-required` fires whenever any authenticated path sees a 401/403:
  // the Rust uploader on an upload attempt, AND api.ts on any other call
  // (presence heartbeat, manual fetches, start-tracking). Without the
  // api.ts path the desktop would sit silent on a revoked token while
  // idle, because the uploader only runs when there's outbox work to do.
  useEffect(() => {
    const unlistenPromise = listen<{ reason?: string }>('reauth-required', () => {
      // Clear both the in-memory cache and the persisted token file —
      // otherwise next launch would read the dead token from disk and
      // re-hit the same 401 silently before the user even sees the UI.
      clearTokenCache();
      void invoke('clear_device_token').catch(() => undefined);
      signOut();
      toast({
        title: 'Signed out',
        description:
          'Your session was revoked. Sign in again to resume tracking — captures are safe in the outbox until then.',
        variant: 'destructive',
      });
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [signOut]);

  return (
    <div className="flex h-dvh flex-col bg-background">
      <div className="flex flex-1 flex-col overflow-hidden">
        {booting ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-ink3">
            Loading…
          </div>
        ) : stage === 'login' ? (
          <LoginScreen />
        ) : !permissionsOk ? (
          <PermissionGateScreen onGranted={() => setPermissionsOk(true)} />
        ) : (
          <TrackerScreen />
        )}
      </div>
      <Toaster />
      <UpdaterDialog updater={updater} />
    </div>
  );
}

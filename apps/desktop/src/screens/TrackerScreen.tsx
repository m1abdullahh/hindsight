import type { ProjectDto, ScreenshotDto, TimeEntryDto } from '@hindsight/shared/dto';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  LogOut,
  Pause as PauseIcon,
  Play as PlayIcon,
  Settings as SettingsIcon,
  Square as StopIcon,
  Trash2,
  X as CloseIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ActivityBar, type ActivitySegment } from '@/components/ui/activity-bar';
import { AvatarLive } from '@/components/ui/avatar-live';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/use-toast';
import { apiDelete, apiGet, apiPatch, apiPost, clearTokenCache } from '@/lib/api';
import { formatElapsed } from '@/lib/format-elapsed';
import { session } from '@/lib/session-store';

declare const __APP_VERSION__: string;

// Fallback threshold when no project is loaded (e.g. between sessions).
const DEFAULT_IDLE_THRESHOLD_SECONDS = 300;

// Silent error swallow for fire-and-forget API calls (periodic flush, etc.).
// Lifting this to a module constant satisfies no-empty-function without
// pretending the error is handled.
const noop = (): void => undefined;

type Tab = 'track' | 'me' | 'settings';

interface ProjectsResponse {
  projects: ProjectDto[];
}
interface TimeEntryResponse {
  id: string;
  startedAt: string;
}
interface TimeTotalRow {
  userId: string;
  userName: string;
  userEmail: string;
  projectId: string;
  projectName: string;
  totalActiveSeconds: number;
  hourlyRateCents: number | null;
  earnedCents: number | null;
}
interface TimeTotalsResponse {
  rows: TimeTotalRow[];
}

const startOfTodayIso = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const startOfWeekIso = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const offset = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - offset);
  return d.toISOString();
};

const fetchTodaySecondsForProject = async (orgId: string, projectId: string): Promise<number> => {
  try {
    const res = await apiGet<TimeTotalsResponse>(
      `/orgs/${orgId}/reports/time-totals?projectId=${projectId}&from=${encodeURIComponent(startOfTodayIso())}`,
    );
    return res.rows[0]?.totalActiveSeconds ?? 0;
  } catch {
    return 0;
  }
};

const formatMoney = (cents: number | null): string => {
  if (cents === null) return '—';
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  });
};

const formatHoursShort = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
};

export function TrackerScreen() {
  const user = session((s) => s.user);
  const organizations = session((s) => s.organizations);
  const memberships = session((s) => s.memberships);
  const currentOrgId = session((s) => s.currentOrgId);
  const setOrg = session((s) => s.setOrg);
  const signOut = session((s) => s.signOut);

  const currentOrg = currentOrgId ? organizations.find((o) => o.id === currentOrgId) : null;
  const currentMembership = currentOrgId ? memberships.find((m) => m.orgId === currentOrgId) : null;

  const [tab, setTab] = useState<Tab>('track');

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-card">
      {/* User header */}
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        {user && <AvatarLive userId={user.id} name={user.name} size={30} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-tight">{user?.name ?? '—'}</div>
          <div className="truncate text-[11px] text-ink4">
            {currentOrg?.name ?? '—'} ·{' '}
            <span className="capitalize">{currentMembership?.role ?? 'member'}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setTab('settings')}
          className="grid h-7 w-7 place-items-center rounded text-ink3 hover:bg-muted"
          title="Settings"
        >
          <SettingsIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tabs */}
      <Tabs tab={tab} setTab={setTab} />

      {/* Tab content. All tabs stay mounted; inactive ones get `display: none`
          via Tailwind's `hidden` class so their state, effects, and polling
          intervals survive across tab switches. Switching back is instant —
          no loading spinner, no re-fetch — and TrackTab's idle-accumulation
          refs aren't reset out from under an active session. Each tab gets
          `isActive` so it can fire a silent background refetch on activation
          (stale-while-revalidate: show cached data immediately, refresh
          behind the scenes so e.g. an unassigned project quietly drops out
          of the picker before the user clicks Start). Active wrapper is
          `flex flex-1 flex-col` so children that rely on being a flex child
          (e.g. MeTab's centered empty state) still work. */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className={tab === 'track' ? 'flex flex-1 flex-col' : 'hidden'}>
          <TrackTab
            currentOrgId={currentOrgId}
            organizations={organizations}
            setOrg={setOrg}
            isActive={tab === 'track'}
          />
        </div>
        <div className={tab === 'me' ? 'flex flex-1 flex-col' : 'hidden'}>
          <MeTab currentOrgId={currentOrgId} isActive={tab === 'me'} />
        </div>
        <div className={tab === 'settings' ? 'flex flex-1 flex-col' : 'hidden'}>
          <SettingsTab signOut={signOut} />
        </div>
      </div>

      {/* Footer */}
      <TrackerFooter />
    </div>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string }[] = [
    { id: 'track', label: 'Track' },
    { id: 'me', label: 'Me' },
    { id: 'settings', label: 'Settings' },
  ];
  return (
    <div className="flex gap-0 border-b border-border bg-background px-3 pt-1">
      {items.map((it) => {
        const active = tab === it.id;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => setTab(it.id)}
            className={
              'border-b-2 px-3.5 py-2 text-[12.5px] transition-colors -mb-px ' +
              (active
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-ink3 hover:text-foreground')
            }
          >
            {it.label}
          </button>
        );
      })}
      <div className="flex-1" />
    </div>
  );
}

// ── Track tab ──────────────────────────────────────────────────────────

function TrackTab({
  currentOrgId,
  organizations,
  setOrg,
  isActive,
}: {
  currentOrgId: string | null;
  organizations: { id: string; name: string }[];
  setOrg: (id: string) => void;
  isActive: boolean;
}) {
  const stage = session((s) => s.stage);
  const currentProject = session((s) => s.currentProject);
  const setProject = session((s) => s.setProject);
  const startTracking = session((s) => s.startTracking);
  const stopTracking = session((s) => s.stopTracking);
  const rotateEntry = session((s) => s.rotateEntry);
  const timeEntryId = session((s) => s.timeEntryId);
  const startedAt = session((s) => s.startedAt);
  const baselineTodaySeconds = session((s) => s.baselineTodaySeconds);
  const pauseReason = session((s) => s.pauseReason);
  const pauseStartedAt = session((s) => s.pauseStartedAt);
  const accumulatedPausedMs = session((s) => s.accumulatedPausedMs);
  const pauseSession = session((s) => s.pause);
  const resumeSession = session((s) => s.resume);
  const { toast } = useToast();

  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  // `hasLoadedOnce` toggles once the first fetch (success OR failure) returns.
  // Spinner is shown when this is false; subsequent refetches stay silent and
  // just swap the data in. Reset on org change so the new org's first fetch
  // shows the spinner instead of stale (wrong-org) data.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const loadingProjects = !hasLoadedOnce;
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const tracking = stage === 'tracking';
  const isPaused = pauseReason !== null;

  // Live ticking
  useEffect(() => {
    if (!tracking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [tracking]);

  // Idle accumulation
  const idleSecondsRef = useRef(0);
  const lastIdleAccrualAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (pauseReason === 'idle') {
      lastIdleAccrualAtRef.current = Date.now();
    } else if (lastIdleAccrualAtRef.current !== null) {
      idleSecondsRef.current += Math.floor((Date.now() - lastIdleAccrualAtRef.current) / 1000);
      lastIdleAccrualAtRef.current = null;
    }
  }, [pauseReason]);

  const computeIdleSeconds = useCallback((): number => {
    let total = idleSecondsRef.current;
    if (pauseReason === 'idle' && lastIdleAccrualAtRef.current !== null) {
      total += Math.floor((Date.now() - lastIdleAccrualAtRef.current) / 1000);
    }
    return Math.min(86_400, total);
  }, [pauseReason]);

  const wallElapsedMs = startedAt ? Math.max(0, now - new Date(startedAt).getTime()) : 0;
  const currentPauseMs =
    pauseReason && pauseStartedAt !== null ? Math.max(0, now - pauseStartedAt) : 0;
  const activeMs = Math.max(0, wallElapsedMs - accumulatedPausedMs - currentPauseMs);
  const activeSec = Math.floor(activeMs / 1000);
  const displaySec = baselineTodaySeconds + activeSec;

  // Mirror live tick values into refs so the periodic flush effect can read
  // the latest activeSec/idleSeconds without re-subscribing on every tick.
  const activeSecRef = useRef(activeSec);
  activeSecRef.current = activeSec;
  const computeIdleSecondsRef = useRef(computeIdleSeconds);
  computeIdleSecondsRef.current = computeIdleSeconds;

  // Reset cached projects + the "have we loaded yet" flag on org change so
  // the new org's first fetch shows the spinner rather than briefly flashing
  // the previous org's projects (which would also be wrong to act on).
  useEffect(() => {
    setProjects([]);
    setHasLoadedOnce(false);
  }, [currentOrgId]);

  // Fetch projects whenever the tab becomes active for the current org.
  //   - First activation: `hasLoadedOnce` is false → spinner shows until the
  //     fetch returns.
  //   - Subsequent activations (user comes back from Me/Settings): silent
  //     refetch — cached projects stay visible, a no-longer-assigned project
  //     quietly drops out when the GET lands. The Start button's onStart
  //     handler is the safety net if the user clicks Start during the small
  //     window before the silent refetch has updated the list.
  useEffect(() => {
    if (!isActive || !currentOrgId) {
      if (!currentOrgId) setHasLoadedOnce(true);
      return;
    }
    let cancelled = false;
    apiGet<ProjectsResponse>(`/orgs/${currentOrgId}/projects`)
      .then((r) => {
        if (cancelled) return;
        const next = r.projects.filter((p) => !p.archivedAt);
        setProjects(next);
        // If the user had a project selected and it just disappeared (e.g.
        // unassigned in the web admin), drop the selection so the picker
        // doesn't dangle and the Start button correctly disables.
        setSelectedId((prev) => (prev && !next.some((p) => p.id === prev) ? '' : prev));
      })
      .catch(() => {
        // Silent. If the network is flaky we keep showing cached projects;
        // the next activation tries again.
      })
      .finally(() => {
        if (!cancelled) setHasLoadedOnce(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isActive, currentOrgId]);

  // Periodic flush of totalActiveSeconds while tracking. We deliberately keep
  // activeSec/computeIdleSeconds out of deps (read via refs) — otherwise the
  // 1s live tick would tear down and rebuild the interval every second and
  // it would never actually fire.
  useEffect(() => {
    if (!tracking || !timeEntryId || !startedAt) return;
    const id = window.setInterval(() => {
      void apiPatch(
        `/time-entries/${timeEntryId}`,
        {
          totalActiveSeconds: Math.min(86_400, activeSecRef.current),
          totalIdleSeconds: computeIdleSecondsRef.current(),
        },
        crypto.randomUUID(),
      ).catch(noop);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [tracking, timeEntryId, startedAt]);

  // Midnight session split. While tracking, watch the local calendar day.
  // When it rolls over, finalize the current entry at the boundary and open
  // a fresh one for the new day — so no time entry ever spans midnight and
  // each day's report bucket is exact. Without this an overnight session is
  // attributed entirely to its start day (see reports/service.ts), making
  // "today" totals on the desktop AND admin web wrong until the user stops.
  // Runs even while paused so an idle/locked overnight session still rotates.
  // The displayed timer resets to "since midnight" — the new entry genuinely
  // starts then.
  useEffect(() => {
    if (!tracking) return;
    let sessionDay = new Date().toDateString();
    let splitting = false;

    const performSplit = async (): Promise<void> => {
      const { timeEntryId: oldId, currentProject: proj, pauseReason: reason } = session.getState();
      if (!oldId || !proj) return;
      // Snapshot the old entry's totals before any await so they reflect the
      // split instant, not a value drifting during the round-trips.
      const finalActive = Math.min(86_400, activeSecRef.current);
      const finalIdle = computeIdleSecondsRef.current();

      // 1. Persist the old entry's final totals WHILE IT IS STILL OPEN.
      //    POST /time-entries below auto-closes any open entry on this
      //    device, and once closed a PATCH that carries endedAt is rejected
      //    with 409 — so we must flush the totals first, without endedAt.
      //    If this throws we abort before the POST, so tracking simply
      //    keeps running on the old entry and the next tick retries.
      await apiPatch(
        `/time-entries/${oldId}`,
        { totalActiveSeconds: finalActive, totalIdleSeconds: finalIdle },
        crypto.randomUUID(),
      );

      // 2. Create the new day's entry. The server auto-stops the still-open
      //    old entry (sets its endedAt) as part of this call, so one POST
      //    both closes yesterday's entry and opens today's.
      const fresh = await apiPost<TimeEntryResponse>(
        '/time-entries',
        { projectId: proj.id, startedAt: new Date().toISOString() },
        crypto.randomUUID(),
      );

      // If the user stopped tracking during the round-trips, abort: don't
      // re-point the scheduler or rotate. The fresh entry stays a harmless
      // zero-second row.
      const live = session.getState();
      if (live.stage !== 'tracking' || live.timeEntryId !== oldId) return;

      // 3. Point the native capture scheduler at the new entry.
      void invoke('set_tracking', {
        tracking: {
          time_entry_id: fresh.id,
          interval_minutes: proj.screenshotIntervalMinutes,
          paused: reason !== null,
        },
      });

      // 4. Reset local accumulators for the fresh entry, then rotate the store.
      idleSecondsRef.current = 0;
      lastIdleAccrualAtRef.current = reason === 'idle' ? Date.now() : null;
      rotateEntry(fresh.id, fresh.startedAt);
      console.log('[split] midnight split done — old=', oldId, 'new=', fresh.id);
    };

    const id = window.setInterval(() => {
      const today = new Date().toDateString();
      if (today === sessionDay || splitting) return;
      splitting = true;
      const prevDay = sessionDay;
      sessionDay = today; // advance up-front so a slow split doesn't re-fire
      void performSplit()
        .catch((err) => {
          console.warn('[split] midnight split failed; will retry next tick', err);
          sessionDay = prevDay; // allow the next tick to retry
        })
        .finally(() => {
          splitting = false;
        });
    }, 1000);
    return () => window.clearInterval(id);
  }, [tracking, rotateEntry]);

  // Per-project idle threshold (falls back to default when no project loaded).
  const idleThresholdSec = currentProject
    ? Math.max(60, currentProject.idleTimeoutMinutes * 60)
    : DEFAULT_IDLE_THRESHOLD_SECONDS;

  // OS idle detection — pauses on idle, fires toasts on pause + resume.
  // Also propagates the pause state to the native scheduler so screenshot
  // capture suspends along with time tracking. Idle time is always kept on
  // the entry (no Discard option in the UI); the activity % in reports
  // reflects the real ratio of active to idle.
  useEffect(() => {
    if (!tracking) return;

    console.log('[idle] listener armed, threshold =', idleThresholdSec, 's');
    const unlistenPromise = listen<{ idle_seconds: number }>('activity-changed', (e) => {
      const idle = e.payload.idle_seconds;
      const { pauseReason: reason, timeEntryId: teId, currentProject: proj } = session.getState();

      console.log('[idle] event idle=', idle, 's reason=', reason, 'threshold=', idleThresholdSec);
      if (idle >= idleThresholdSec && reason === null) {
        console.log('[idle] -> pausing session');
        pauseSession('idle');
        if (teId && proj) {
          void invoke('set_tracking', {
            tracking: {
              time_entry_id: teId,
              interval_minutes: proj.screenshotIntervalMinutes,
              paused: true,
            },
          });
        }
        // Heads-up toast: the user is usually away from the keyboard at this
        // point, so the inline "paused" UI inside the app is invisible to them.
        // The toast is the only way they learn captures have stopped until they
        // come back. Mirror show_idle_resume_toast: fire-and-forget, errors logged.
        void invoke('show_idle_pause_toast').catch((err) => {
          console.warn('[idle] pause toast invoke failed', err);
        });
      } else if (idle < idleThresholdSec && reason === 'idle') {
        // Compute the just-ended idle block's duration for the resume toast.
        // The user is usually focused on a different app when they come back,
        // so the toast is the only signal they get that tracking has resumed.
        const startedAt = lastIdleAccrualAtRef.current;

        console.log('[idle] -> resuming, startedAt=', startedAt);
        if (startedAt !== null) {
          const blockSec = Math.floor((Date.now() - startedAt) / 1000);

          console.log('[idle] block was', blockSec, 'seconds, firing resume toast');
          if (blockSec > 0) {
            void invoke('show_idle_resume_toast', { idleSeconds: blockSec }).catch((err) => {
              console.warn('[idle] toast invoke failed', err);
            });
          }
        }
        resumeSession();
        if (teId && proj) {
          void invoke('set_tracking', {
            tracking: {
              time_entry_id: teId,
              interval_minutes: proj.screenshotIntervalMinutes,
              paused: false,
            },
          });
        }
      }
    });
    return () => {
      void unlistenPromise.then((u) => u());
    };
  }, [tracking, idleThresholdSec, pauseSession, resumeSession]);

  // OS lock detection — Win+L, Ctrl+Cmd+Q (macOS), screensaver activation on
  // Linux. Reacts faster than idle (no 5-min threshold) because a locked
  // screen is unambiguous — the user is away from the machine, not just AFK.
  // Unlike the idle path, locked time is NOT accrued into totalIdleSeconds
  // (the idle accumulator only runs when `pauseReason === 'idle'`), so a
  // locked period appears as a clean gap in the session record.
  useEffect(() => {
    if (!tracking) return;
    const unlistenPromise = listen<{ locked: boolean }>('lock-state-changed', (e) => {
      const locked = e.payload.locked;
      const { pauseReason: reason, timeEntryId: teId, currentProject: proj } = session.getState();

      console.log('[lock] event locked=', locked, 'currentReason=', reason);
      if (locked && reason === null) {
        // Pause from active. If the user was already manually paused we
        // leave that alone — escalating to 'locked' would lose the manual
        // intent on unlock.
        pauseSession('locked');
        if (teId && proj) {
          void invoke('set_tracking', {
            tracking: {
              time_entry_id: teId,
              interval_minutes: proj.screenshotIntervalMinutes,
              paused: true,
            },
          });
        }
      } else if (!locked && reason === 'locked') {
        resumeSession();
        if (teId && proj) {
          void invoke('set_tracking', {
            tracking: {
              time_entry_id: teId,
              interval_minutes: proj.screenshotIntervalMinutes,
              paused: false,
            },
          });
        }
      }
    });
    return () => {
      void unlistenPromise.then((u) => u());
    };
  }, [tracking, pauseSession, resumeSession]);

  // Today's totals across all projects
  const todayQuery = useTodayTotalsForOrg(currentOrgId);

  // Activity ribbon — 24 segments
  const segments = useMemo<ActivitySegment[]>(() => {
    const total = 24;
    const out: ActivitySegment[] = [];
    if (!tracking) {
      // Show today's existing-tracked-on-this-org as a stable approximation.
      const todaySec = todayQuery.totalToday;
      const active = Math.min(total, Math.ceil(todaySec / 1800));
      for (let i = 0; i < total; i++) out.push(i < active ? 2 : 0);
      return out;
    }
    // While tracking, fill segments based on elapsed minutes.
    const elapsedMinutes = Math.floor(activeMs / 60_000);
    const buckets = Math.min(total, Math.ceil(elapsedMinutes / 5));
    for (let i = 0; i < total; i++) {
      if (i >= buckets) out.push(0);
      else out.push(pauseReason === 'idle' && i === buckets - 1 ? 'idle' : 2);
    }
    return out;
  }, [tracking, activeMs, pauseReason, todayQuery.totalToday]);

  const onStart = async () => {
    const cached = projects.find((p) => p.id === selectedId);
    if (!cached || starting || !currentOrgId) return;
    setStarting(true);
    try {
      const startedIso = new Date().toISOString();
      // Re-fetch the project so per-project settings (interval, idle timeout,
      // blur) are fresh — the projects list is only loaded on org change, so
      // edits made in the web app since this desktop session started would
      // otherwise be missed. Falls back to the cached row if the fetch fails.
      const [entry, baseline, freshProject] = await Promise.all([
        apiPost<TimeEntryResponse>(
          '/time-entries',
          { projectId: cached.id, startedAt: startedIso },
          crypto.randomUUID(),
        ),
        fetchTodaySecondsForProject(currentOrgId, cached.id),
        apiGet<ProjectDto>(`/projects/${cached.id}`).catch(() => cached),
      ]);
      // Keep the dropdown's cached row in sync so the picker also reflects
      // any setting changes for next time.
      setProjects((prev) => prev.map((p) => (p.id === freshProject.id ? freshProject : p)));
      setProject(freshProject);
      startTracking(entry.id, entry.startedAt, baseline);
      await invoke('set_tracking', {
        tracking: {
          time_entry_id: entry.id,
          interval_minutes: freshProject.screenshotIntervalMinutes,
          paused: false,
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

  const onTogglePause = async () => {
    if (!tracking || !timeEntryId || !currentProject) return;
    if (isPaused) {
      resumeSession();
      await invoke('set_tracking', {
        tracking: {
          time_entry_id: timeEntryId,
          interval_minutes: currentProject.screenshotIntervalMinutes,
          paused: false,
        },
      });
    } else {
      pauseSession('manual');
      await invoke('set_tracking', {
        tracking: {
          time_entry_id: timeEntryId,
          interval_minutes: currentProject.screenshotIntervalMinutes,
          paused: true,
        },
      });
    }
  };

  const onStop = async () => {
    if (!timeEntryId || stopping) return;
    setStopping(true);
    try {
      await invoke('set_tracking', { tracking: null });
      await apiPatch(
        `/time-entries/${timeEntryId}`,
        {
          endedAt: new Date().toISOString(),
          totalActiveSeconds: Math.min(86_400, activeSec),
          totalIdleSeconds: computeIdleSeconds(),
        },
        crypto.randomUUID(),
      );
      stopTracking();
    } catch (err) {
      toast({
        title: "Couldn't stop cleanly",
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
      stopTracking();
    } finally {
      setStopping(false);
    }
  };

  // Tray "Stop" event
  useEffect(() => {
    if (!tracking) return;
    const unlistenPromise = listen('tray-stop', () => {
      void onStop();
    });
    return () => {
      void unlistenPromise.then((u) => u());
    };
  }, [tracking, onStop]);

  return (
    <>
      {/* Org switcher (only if user has >1 org) */}
      {organizations.length > 1 && currentOrgId && (
        <div className="px-4 pt-3">
          <Select value={currentOrgId} onValueChange={setOrg}>
            <SelectTrigger className="h-8 w-full bg-card text-[12.5px]">
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

      {/* Timer block */}
      <div className="px-4 pb-4 pt-4 text-center">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink3">
          {tracking ? (isPaused ? 'Paused' : 'Now tracking') : 'Ready'}
        </div>
        <div className="mt-1 font-mono text-[42px] font-medium leading-none tracking-tight">
          {formatElapsed(tracking ? displaySec : 0)}
        </div>
        <div className="mt-2 text-[12px] text-ink3">
          {tracking ? (
            <>
              {currentProject?.name ?? '—'}
              {startedAt ? (
                <>
                  {' · started '}
                  {new Date(startedAt).toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </>
              ) : null}
            </>
          ) : (
            'Pick a project below to start tracking'
          )}
        </div>

        {/* Action buttons */}
        <div className="mt-3.5 flex justify-center gap-2">
          {tracking ? (
            <>
              <button
                type="button"
                onClick={onTogglePause}
                className="inline-flex h-9 w-[130px] items-center justify-center gap-1.5 rounded-md border border-border-strong bg-card text-[13px] font-medium hover:bg-muted"
              >
                {isPaused ? (
                  <>
                    <PlayIcon className="h-3.5 w-3.5" />
                    Resume
                  </>
                ) : (
                  <>
                    <PauseIcon className="h-3.5 w-3.5" />
                    Pause
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                className="inline-flex h-9 w-[130px] items-center justify-center gap-1.5 rounded-md bg-foreground text-[13px] font-medium text-background disabled:opacity-60"
              >
                {stopping ? (
                  <Spinner />
                ) : (
                  <>
                    <StopIcon className="h-3.5 w-3.5" />
                    Stop
                  </>
                )}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onStart}
              disabled={!selectedId || starting || loadingProjects}
              className="inline-flex h-9 w-full max-w-[270px] items-center justify-center gap-1.5 rounded-md bg-foreground text-[13px] font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? (
                <Spinner />
              ) : (
                <>
                  <PlayIcon className="h-3.5 w-3.5" />
                  Start tracking
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Project picker */}
      <div className="px-4 pb-3">
        <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink3">
          Project
        </div>
        {loadingProjects && !tracking ? (
          <div className="rounded-md border border-border bg-card px-3 py-2 text-[12.5px] text-ink3">
            Loading…
          </div>
        ) : tracking ? (
          // While tracking, render a static read-only chip
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[13px]">
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: 'hsl(var(--accent))' }}
            />
            <span className="flex-1 truncate">{currentProject?.name ?? '—'}</span>
            {currentProject && (
              <span className="font-mono text-[11px] text-ink3">
                Every {currentProject.screenshotIntervalMinutes} min
              </span>
            )}
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-strong bg-card px-3 py-3 text-[12px] text-ink3">
            You haven't been assigned to any active projects yet. Ask an admin to add you.
          </div>
        ) : (
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="h-10 w-full bg-card text-[13px]">
              <SelectValue placeholder="Pick a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-sm"
                      style={{ background: 'hsl(var(--accent))' }}
                    />
                    {p.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Today / Week / Earned tiles */}
      <div className="grid grid-cols-3 gap-2 px-4 pb-3">
        <StatTile label="Today" value={formatHoursShort(todayQuery.totalToday)} />
        <StatTile label="Week" value={formatHoursShort(todayQuery.totalWeek)} />
        <StatTile
          label="Earned"
          value={todayQuery.anyEarned ? formatMoney(todayQuery.totalEarnedToday) : '—'}
        />
      </div>

      {/* Activity ribbon */}
      <div className="px-4 pb-4">
        <div className="mb-1.5 flex items-baseline justify-between">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink3">
            Activity · Last 2h
          </div>
          {tracking && (
            <span className="font-mono text-[11px] text-ink3">
              last capture {todayQuery.lastCaptureRelative ?? '—'}
            </span>
          )}
        </div>
        <ActivityBar segments={segments} height={22} />
      </div>
    </>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted px-2.5 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.05em] text-ink3">{label}</div>
      <div className="mt-0.5 font-mono text-[16px] font-medium leading-tight">{value}</div>
    </div>
  );
}

// ── Settings tab ───────────────────────────────────────────────────────

function SettingsTab({ signOut }: { signOut: () => void }) {
  const onSignOut = async () => {
    await invoke('clear_device_token').catch(noop);
    clearTokenCache();
    signOut();
  };

  return (
    <div className="px-4 py-4">
      <h2 className="mb-1 text-[13px] font-medium">Settings</h2>
      <p className="text-[12px] text-ink3">App version, sign out, and preferences.</p>

      <div className="mt-4 space-y-2">
        <button
          type="button"
          onClick={onSignOut}
          className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2.5 text-[13px] hover:bg-muted"
        >
          <span className="flex items-center gap-2">
            <LogOut className="h-3.5 w-3.5 text-ink3" />
            Sign out
          </span>
          <span className="text-[11px] text-ink4">Clears the device token</span>
        </button>
      </div>
    </div>
  );
}

// ── Me tab ─────────────────────────────────────────────────────────────

interface TimeEntriesResponse {
  entries: TimeEntryDto[];
}
interface MeScreenshotListItem {
  screenshot: {
    id: string;
    capturedAt: string;
    activeApp: string | null;
    activeWindowTitle: string | null;
  };
  thumbnailUrl: string | null;
}
interface MeScreenshotsResponse {
  items: MeScreenshotListItem[];
}
interface ScreenshotDetailResponse {
  screenshot: ScreenshotDto;
  fullUrl: string;
  expiresAt: string;
  ownerUserId: string;
  orgId: string;
}

function MeTab({ currentOrgId, isActive }: { currentOrgId: string | null; isActive: boolean }) {
  const user = session((s) => s.user);
  const memberships = session((s) => s.memberships);
  const currentMembership = currentOrgId
    ? (memberships.find((m) => m.orgId === currentOrgId) ?? null)
    : null;
  const userId = user?.id ?? null;

  const [totals, setTotals] = useState<TimeTotalRow[]>([]);
  const [entries, setEntries] = useState<TimeEntryDto[]>([]);
  const [screenshots, setScreenshots] = useState<MeScreenshotListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openShotId, setOpenShotId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!currentOrgId || !userId) return;
    try {
      const [t, e, s] = await Promise.all([
        apiGet<TimeTotalsResponse>(
          `/orgs/${currentOrgId}/reports/time-totals?userId=${encodeURIComponent(userId)}`,
        ),
        apiGet<TimeEntriesResponse>(
          `/orgs/${currentOrgId}/time-entries?userId=${encodeURIComponent(userId)}&limit=5`,
        ),
        apiGet<MeScreenshotsResponse>(
          `/orgs/${currentOrgId}/screenshots?userId=${encodeURIComponent(userId)}&limit=6`,
        ),
      ]);
      setTotals(t.rows);
      setEntries(e.entries);
      setScreenshots(s.items);
      setLoaded(true);
    } catch {
      // Silent — next 30s tick will retry.
    }
  }, [currentOrgId, userId]);

  // Poll every 30s so the values stay in lockstep with the web dashboard.
  // The interval keeps ticking even while the tab is hidden (the component
  // stays mounted across switches), so coming back to this tab always shows
  // data that's at most 30s old.
  useEffect(() => {
    if (!currentOrgId || !userId) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [currentOrgId, userId, refresh]);

  // On every tab activation, kick a silent refresh so the user never sees
  // data older than ~the time they were on another tab. `refresh()` itself
  // doesn't touch `loaded` (the spinner gate), so this never flashes UI —
  // numbers and thumbnails just update in place when the GET lands.
  useEffect(() => {
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh]);

  const totalSeconds = useMemo(
    () => totals.reduce((s, r) => s + r.totalActiveSeconds, 0),
    [totals],
  );
  const totalEarned = useMemo(() => totals.reduce((s, r) => s + (r.earnedCents ?? 0), 0), [totals]);
  const anyEarned = useMemo(() => totals.some((r) => r.earnedCents !== null), [totals]);

  // Default rate = most common non-null per-project rate.
  const defaultRateCents = useMemo<number | null>(() => {
    const counts = new Map<number, number>();
    for (const r of totals) {
      if (r.hourlyRateCents === null) continue;
      counts.set(r.hourlyRateCents, (counts.get(r.hourlyRateCents) ?? 0) + 1);
    }
    let best: number | null = null;
    let top = 0;
    for (const [rate, c] of counts) {
      if (c > top) {
        best = rate;
        top = c;
      }
    }
    return best;
  }, [totals]);

  const sortedTotals = useMemo(
    () => [...totals].sort((a, b) => b.totalActiveSeconds - a.totalActiveSeconds),
    [totals],
  );

  if (!currentOrgId || !userId) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center text-[13px] text-ink3">
        Pick an organization to see your stats.
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center text-[12px] text-ink3">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  return (
    <div className="space-y-3.5 px-4 py-3">
      {/* Member info */}
      <section className="rounded-lg border border-border bg-background/60 px-3 py-2.5">
        <h3 className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink4">
          Member
        </h3>
        <InfoRow label="Role" value={titleCase(currentMembership?.role ?? 'member')} />
        <InfoRow
          label="Joined"
          value={currentMembership ? formatRelative(currentMembership.createdAt) : '—'}
        />
        <InfoRow
          label="Default rate"
          value={defaultRateCents !== null ? `${formatMoney(defaultRateCents)}/h` : '—'}
        />
        <InfoRow label="Total tracked" value={formatHoursShort(totalSeconds)} />
        <InfoRow label="Total earned" value={anyEarned ? formatMoney(totalEarned) : '—'} />
        <InfoRow label="Projects" value={String(totals.length)} />
      </section>

      {/* Project breakdown */}
      <section className="rounded-lg border border-border bg-background/60">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h3 className="text-[11.5px] font-medium">Project breakdown</h3>
          <span className="font-mono text-[10px] text-ink4">all time</span>
        </div>
        {sortedTotals.length === 0 ? (
          <p className="px-3 py-5 text-center text-[12px] text-ink3">No tracked time yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {sortedTotals.map((r) => {
              const share = totalSeconds > 0 ? (r.totalActiveSeconds / totalSeconds) * 100 : 0;
              const accent = projectAccent(r.projectId);
              return (
                <li
                  key={r.projectId}
                  className="grid grid-cols-12 items-center gap-2 px-3 py-2 text-[12px]"
                >
                  <div className="col-span-5 flex items-center gap-1.5 min-w-0">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-sm"
                      style={{ background: accent }}
                    />
                    <span className="truncate font-medium">{r.projectName}</span>
                  </div>
                  <div className="col-span-3 font-mono tabular-nums text-ink2">
                    {formatHoursShort(r.totalActiveSeconds)}
                  </div>
                  <div className="col-span-2 font-mono tabular-nums text-ink2">
                    {r.earnedCents !== null ? formatMoney(r.earnedCents) : '—'}
                  </div>
                  <div className="col-span-2 flex items-center gap-1">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${share}%`, background: accent }}
                      />
                    </div>
                    <span className="font-mono text-[9.5px] tabular-nums text-ink4">
                      {share.toFixed(0)}%
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Recent sessions */}
      <section className="rounded-lg border border-border bg-background/60">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <h3 className="text-[11.5px] font-medium">Recent sessions</h3>
          <span className="font-mono text-[10px] text-ink4">last 5</span>
        </div>
        {entries.length === 0 ? (
          <p className="px-3 py-5 text-center text-[12px] text-ink3">No sessions yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between px-3 py-2 text-[12px]">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11.5px] text-ink2">
                    {formatDateTime(e.startedAt)}
                  </div>
                  <div className="truncate text-[10.5px] text-ink4">
                    {e.endedAt ? `→ ${formatDateTime(e.endedAt)}` : 'in progress'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono font-medium tabular-nums">
                    {formatHoursShort(e.totalActiveSeconds)}
                  </div>
                  <div className="font-mono text-[10px] text-ink4">
                    {sessionActivityPercent(e).toFixed(0)}% active
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent screenshots */}
      <section className="mb-1 rounded-lg border border-border bg-background/60 px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[11.5px] font-medium">Recent screenshots</h3>
          <span className="font-mono text-[10px] text-ink4">last 6</span>
        </div>
        {screenshots.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-ink3">No screenshots yet.</p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {screenshots.map((it) => (
              <button
                key={it.screenshot.id}
                type="button"
                onClick={() => setOpenShotId(it.screenshot.id)}
                className="group relative aspect-video w-full overflow-hidden rounded border border-border bg-muted text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
                title={
                  it.screenshot.activeApp
                    ? `${it.screenshot.activeApp} · ${formatRelative(it.screenshot.capturedAt)}`
                    : formatRelative(it.screenshot.capturedAt)
                }
              >
                {it.thumbnailUrl ? (
                  <img
                    src={it.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="grid h-full place-items-center text-[10px] text-ink4">—</div>
                )}
              </button>
            ))}
          </div>
        )}
      </section>

      {openShotId && (
        <ScreenshotPreview
          id={openShotId}
          onClose={() => setOpenShotId(null)}
          onDeleted={() => {
            setOpenShotId(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-[12px]">
      <span className="text-ink3">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

function ScreenshotPreview({
  id,
  onClose,
  onDeleted,
}: {
  id: string;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { toast } = useToast();
  const callerUserId = session((s) => s.user?.id ?? null);
  const memberships = session((s) => s.memberships);
  const [detail, setDetail] = useState<ScreenshotDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<ScreenshotDetailResponse>(`/screenshots/${id}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load screenshot');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Esc to close (suppressed while a delete is in flight so the user can't
  // dismiss before the request resolves).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !deleting) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, deleting]);

  // Owner/admin can delete any capture; members can delete only their own.
  const canDelete = (() => {
    if (!detail || !callerUserId) return false;
    const mem = memberships.find((m) => m.orgId === detail.orgId);
    if (!mem) return false;
    if (mem.role === 'owner' || mem.role === 'admin') return true;
    return callerUserId === detail.ownerUserId;
  })();

  const handleDelete = async (): Promise<void> => {
    if (deleting || !detail) return;
    setDeleting(true);
    try {
      await apiDelete(`/screenshots/${id}`);
      toast({ title: 'Screenshot deleted' });
      onDeleted?.();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Delete failed';

      toast({ title: 'Could not delete', description: msg, variant: 'destructive' });
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
      <div
        className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]"
        onClick={deleting ? undefined : onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label="Screenshot preview"
        className="relative z-10 flex max-h-[92vh] w-full max-w-[460px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="min-w-0 text-[11.5px] text-ink3">
            {detail
              ? `${detail.screenshot.activeApp ?? '—'} · ${formatDateTime(detail.screenshot.capturedAt)}`
              : 'Loading…'}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            disabled={deleting}
            className="grid h-6 w-6 place-items-center rounded text-ink3 hover:bg-muted disabled:opacity-50"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center overflow-auto bg-[#0f1115] p-2">
          {error ? (
            <div className="p-6 text-center text-[12px] text-ink3">{error}</div>
          ) : detail ? (
            <img
              src={detail.fullUrl}
              alt="Full-resolution screenshot"
              className="max-h-[80vh] w-auto max-w-full object-contain"
            />
          ) : (
            <Spinner className="h-5 w-5 text-ink3" />
          )}
        </div>
        {canDelete && (
          <div className="flex justify-end border-t border-border px-3 py-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="h-8 gap-1.5"
            >
              {deleting ? <Spinner className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Me-tab helpers ────────────────────────────────────────────────────

function titleCase(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return 'just now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const yr = Math.floor(mo / 12);
  return `${yr} year${yr === 1 ? '' : 's'} ago`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function sessionActivityPercent(e: TimeEntryDto): number {
  const active = e.totalActiveSeconds ?? 0;
  const idle = e.totalIdleSeconds ?? 0;
  const total = active + idle;
  if (total <= 0) return 0;
  return (active / total) * 100;
}

// Stable color per projectId — same simple hash the web uses, kept inline so
// the Me tab doesn't pull in a new shared module just for this one helper.
function projectAccent(projectId: string): string {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 62%, 60%)`;
}

// ── Footer ─────────────────────────────────────────────────────────────

function TrackerFooter() {
  const pendingUploads = session((s) => s.pendingUploads);
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-border bg-card px-4 py-2 text-[11px] text-ink3">
      <span className="font-mono">uploading · {pendingUploads} queued</span>
      <span className="font-mono">v{__APP_VERSION__ ?? '0.1.0'}</span>
    </div>
  );
}

// ── Time totals helper ────────────────────────────────────────────────

interface UseTodayTotalsResult {
  rows: TimeTotalRow[];
  totalToday: number;
  totalWeek: number;
  totalEarnedToday: number;
  anyEarned: boolean;
  lastCaptureRelative: string | null;
}

function useTodayTotalsForOrg(orgId: string | null): UseTodayTotalsResult {
  const [rowsToday, setRowsToday] = useState<TimeTotalRow[]>([]);
  const [rowsWeek, setRowsWeek] = useState<TimeTotalRow[]>([]);

  // Fetch on org change AND every 30s so the TODAY/WEEK/EARNED tiles follow
  // the server, matching the web dashboard's polling cadence.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    const refresh = () => {
      const todayFrom = startOfTodayIso();
      const weekFrom = startOfWeekIso();
      Promise.all([
        apiGet<TimeTotalsResponse>(
          `/orgs/${orgId}/reports/time-totals?from=${encodeURIComponent(todayFrom)}`,
        ),
        apiGet<TimeTotalsResponse>(
          `/orgs/${orgId}/reports/time-totals?from=${encodeURIComponent(weekFrom)}`,
        ),
      ])
        .then(([t, w]) => {
          if (cancelled) return;
          setRowsToday(t.rows);
          setRowsWeek(w.rows);
        })
        .catch(noop);
    };
    refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [orgId]);

  const totalToday = rowsToday.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const totalWeek = rowsWeek.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const totalEarnedToday = rowsToday.reduce((s, r) => s + (r.earnedCents ?? 0), 0);
  const anyEarned = rowsToday.some((r) => r.earnedCents !== null);

  return {
    rows: rowsToday,
    totalToday,
    totalWeek,
    totalEarnedToday,
    anyEarned,
    lastCaptureRelative: null,
  };
}

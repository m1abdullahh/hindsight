import type { ProjectDto } from '@hindsight/shared/dto';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  AlertCircle,
  LogOut,
  Pause as PauseIcon,
  Play as PlayIcon,
  Settings as SettingsIcon,
  Square as StopIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ActivityBar, type ActivitySegment } from '@/components/ui/activity-bar';
import { AvatarLive } from '@/components/ui/avatar-live';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/use-toast';
import { apiGet, apiPatch, apiPost, clearTokenCache } from '@/lib/api';
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

      {/* Tab content */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {tab === 'track' && (
          <TrackTab currentOrgId={currentOrgId} organizations={organizations} setOrg={setOrg} />
        )}
        {tab === 'me' && <ComingSoon label="Your activity will live here." />}
        {tab === 'settings' && <SettingsTab signOut={signOut} />}
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
}: {
  currentOrgId: string | null;
  organizations: { id: string; name: string }[];
  setOrg: (id: string) => void;
}) {
  const stage = session((s) => s.stage);
  const currentProject = session((s) => s.currentProject);
  const setProject = session((s) => s.setProject);
  const startTracking = session((s) => s.startTracking);
  const stopTracking = session((s) => s.stopTracking);
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
  const [loadingProjects, setLoadingProjects] = useState(true);
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

  // Fetch projects on org change
  useEffect(() => {
    if (!currentOrgId) {
      setLoadingProjects(false);
      return;
    }
    setLoadingProjects(true);
    let cancelled = false;
    apiGet<ProjectsResponse>(`/orgs/${currentOrgId}/projects`)
      .then((r) => {
        if (cancelled) return;
        setProjects(r.projects.filter((p) => !p.archivedAt));
      })
      .catch(() => {
        if (cancelled) return;
        // Toast handled in start flow; here we just leave the list empty.
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrgId]);

  // Periodic flush of totalActiveSeconds while tracking
  useEffect(() => {
    if (!tracking || !timeEntryId || !startedAt) return;
    const id = window.setInterval(() => {
      void apiPatch(
        `/time-entries/${timeEntryId}`,
        {
          totalActiveSeconds: Math.min(86_400, activeSec),
          totalIdleSeconds: computeIdleSeconds(),
        },
        crypto.randomUUID(),
      ).catch(noop);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [tracking, timeEntryId, startedAt, activeSec, computeIdleSeconds]);

  // Per-project idle threshold (falls back to default when no project loaded).
  const idleThresholdSec = currentProject
    ? Math.max(60, currentProject.idleTimeoutMinutes * 60)
    : DEFAULT_IDLE_THRESHOLD_SECONDS;

  // Pending idle prompt: seconds the user just spent idle, awaiting Keep/Discard.
  const [pendingIdleSec, setPendingIdleSec] = useState<number | null>(null);

  // OS idle detection — pauses on idle, prompts to keep/discard on resume.
  // Also propagates the pause state to the native scheduler so screenshot
  // capture suspends along with time tracking.
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
      } else if (idle < idleThresholdSec && reason === 'idle') {
        // Capture how long the just-ended idle block lasted before clearing
        // the accrual cursor so the user can review it. Fire a Windows toast
        // too — when the user returns from being away they're usually focused
        // somewhere else, so the inline banner alone is easy to miss.
        const startedAt = lastIdleAccrualAtRef.current;

        console.log('[idle] -> resuming, startedAt=', startedAt);
        if (startedAt !== null) {
          const blockSec = Math.floor((Date.now() - startedAt) / 1000);

          console.log('[idle] block was', blockSec, 'seconds, firing toast + banner');
          if (blockSec > 0) {
            setPendingIdleSec(blockSec);
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

  const onKeepIdle = () => setPendingIdleSec(null);
  const onDiscardIdle = () => {
    // Remove the just-ended idle block from the accumulator so the server
    // never sees it in totalIdleSeconds on the next flush.
    if (pendingIdleSec !== null) {
      idleSecondsRef.current = Math.max(0, idleSecondsRef.current - pendingIdleSec);
    }
    setPendingIdleSec(null);
  };

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

      {/* Idle resume prompt — Keep / Discard the just-ended idle block. */}
      {pendingIdleSec !== null && (
        <IdleResumePrompt seconds={pendingIdleSec} onKeep={onKeepIdle} onDiscard={onDiscardIdle} />
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

function IdleResumePrompt({
  seconds,
  onKeep,
  onDiscard,
}: {
  seconds: number;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="mx-4 mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-foreground">
            You were idle for {formatHoursShort(seconds)}
          </div>
          <p className="mt-0.5 text-[11.5px] text-ink3">
            Keep the idle time on this entry, or discard it so it doesn&apos;t count.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={onDiscard}
              className="inline-flex h-7 items-center rounded-md border border-border-strong bg-card px-2.5 text-[12px] font-medium hover:bg-muted"
            >
              Discard idle
            </button>
            <button
              type="button"
              onClick={onKeep}
              className="inline-flex h-7 items-center rounded-md bg-foreground px-2.5 text-[12px] font-medium text-background hover:opacity-90"
            >
              Keep
            </button>
          </div>
        </div>
      </div>
    </div>
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

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="grid flex-1 place-items-center px-6 text-center text-[13px] text-ink3">
      {label}
    </div>
  );
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

  useEffect(() => {
    if (!orgId) return;
    const todayFrom = startOfTodayIso();
    const weekFrom = startOfWeekIso();
    let cancelled = false;
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
    return () => {
      cancelled = true;
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

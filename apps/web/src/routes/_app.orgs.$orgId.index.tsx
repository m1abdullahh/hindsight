import type { MembershipDto, PresenceEntryDto, ProjectDto, UserDto } from '@hindsight/shared/dto';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { ScreenshotDialog } from '@/components/screenshot-dialog';
import { ActivityBar, type ActivitySegment } from '@/components/ui/activity-bar';
import { AvatarLive } from '@/components/ui/avatar-live';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { apiGet } from '@/lib/api';
import { formatHours, formatRelative } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { queryKeys } from '@/lib/queries';
import { useCurrentMembership, useCurrentOrg, useUser } from '@/lib/session-store';

interface MemberRow {
  membership: MembershipDto;
  user: UserDto;
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
interface ScreenshotListItem {
  screenshot: {
    id: string;
    capturedAt: string;
    activeApp: string | null;
    activeWindowTitle: string | null;
    keyboardEventsCount: number;
    mouseEventsCount: number;
    status: string;
  };
  thumbnailUrl: string | null;
}
interface ScreenshotsResponse {
  items: ScreenshotListItem[];
}
interface PresenceResponse {
  entries: PresenceEntryDto[];
}

const startOfTodayIso = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const formatDay = (): string =>
  new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

export const Route = createFileRoute('/_app/orgs/$orgId/')({
  component: DashboardPage,
});

function DashboardPage() {
  const params = Route.useParams();
  const user = useUser();
  const org = useCurrentOrg();
  const membership = useCurrentMembership();
  const isAdmin = membership?.role === 'owner' || membership?.role === 'admin';
  const queryClient = useQueryClient();
  // Screenshot currently open in the full-image dialog; null = closed.
  const [openId, setOpenId] = useState<string | null>(null);
  void user;
  void org;

  const membersQuery = useQuery({
    queryKey: queryKeys.members(params.orgId),
    queryFn: () => apiGet<{ members: MemberRow[] }>(`/orgs/${params.orgId}/members`),
  });

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(params.orgId, false),
    queryFn: () => apiGet<{ projects: ProjectDto[] }>(`/orgs/${params.orgId}/projects`),
  });

  const todayFrom = startOfTodayIso();
  const todayTotalsQuery = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, { from: todayFrom }),
    queryFn: () =>
      apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {
        from: todayFrom,
      }),
    // Poll so KPIs and the timeline row times follow the desktop's
    // minute-pulse without a manual refresh.
    refetchInterval: 30_000,
  });

  const recentScreenshotsQuery = useQuery({
    queryKey: queryKeys.screenshots(params.orgId, {}),
    enabled: isAdmin,
    queryFn: () => apiGet<ScreenshotsResponse>(`/orgs/${params.orgId}/screenshots`, { limit: 24 }),
    // Always poll so new captures appear automatically. Fast (10s) while
    // anything is still being processed; relaxed (30s) when idle.
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      const anyPending = items.some(
        (it) => it.screenshot.status !== 'processed' || !it.thumbnailUrl,
      );
      return anyPending ? 10_000 : 30_000;
    },
  });

  // Live presence — every signed-in desktop heartbeats every 15s with its
  // state ('active' | 'idle' | 'offline'). The server applies a 35s
  // staleness window. Refetching every 15s keeps the UI tight.
  const presenceQuery = useQuery({
    queryKey: queryKeys.presence(params.orgId),
    queryFn: () => apiGet<PresenceResponse>(`/orgs/${params.orgId}/presence`),
    refetchInterval: 15_000,
    staleTime: 0,
  });

  // Only show members in the team timeline; admins/owners aren't trackers.
  const allMembers = membersQuery.data?.members ?? [];
  const members = allMembers.filter((m) => m.membership.role === 'member');
  const memberUserIds = new Set(members.map((m) => m.user.id));
  const todayRows = (todayTotalsQuery.data?.rows ?? []).filter((r) => memberUserIds.has(r.userId));
  const screenshotItems = recentScreenshotsQuery.data?.items ?? [];
  const presenceEntries = (presenceQuery.data?.entries ?? []).filter((e) =>
    memberUserIds.has(e.userId),
  );

  // Aggregate today's totals by user.
  const todayByUser = new Map<string, number>();
  for (const r of todayRows) {
    todayByUser.set(r.userId, (todayByUser.get(r.userId) ?? 0) + r.totalActiveSeconds);
  }

  const presenceByUser = new Map<string, PresenceEntryDto['state']>();
  for (const e of presenceEntries) {
    presenceByUser.set(e.userId, e.state);
  }

  // Sort members: those with tracking today first (desc), then the rest alphabetically.
  const sortedMembers = [...members].sort((a, b) => {
    const aSec = todayByUser.get(a.user.id) ?? 0;
    const bSec = todayByUser.get(b.user.id) ?? 0;
    if (aSec !== bSec) return bSec - aSec;
    return a.user.name.localeCompare(b.user.name);
  });

  // KPIs
  const trackedSeconds = todayRows.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const earnedCents = todayRows.reduce((s, r) => s + (r.earnedCents ?? 0), 0);
  const anyEarned = todayRows.some((r) => r.earnedCents !== null);
  const captureCount = screenshotItems.length; // proxy until we have a count endpoint
  const activeMemberCount = todayByUser.size;
  const lastCaptureAt = screenshotItems[0]?.screenshot.capturedAt ?? null;

  // Recent screenshots grouped by user (top 3 active users today).
  const screenshotsByUser = new Map<string, ScreenshotListItem[]>();
  for (const item of screenshotItems) {
    // We don't get userId on the screenshot list response — fall back to
    // grouping by capturedAt buckets. For now, show a flat strip until the
    // API surfaces userId on the list. Group key = first segment of the day.
    const key = '_all';
    const arr = screenshotsByUser.get(key) ?? [];
    arr.push(item);
    screenshotsByUser.set(key, arr);
  }

  return (
    <div className="px-7 py-6">
      {/* Hero */}
      <header className="mb-5">
        <div className="text-[11px] font-medium uppercase tracking-[0.05em] text-ink4">
          {formatDay()}
        </div>
        <h1 className="mt-1.5 text-[26px] font-semibold tracking-tight">Today across the team</h1>
        <div className="mt-1 text-[13px] text-ink3">
          {membersQuery.isLoading ? (
            <Skeleton className="inline-block h-3.5 w-72 align-middle" />
          ) : (
            <>
              {activeMemberCount} of {members.length} members{' '}
              {activeMemberCount > 0 ? 'tracked time' : 'have tracked time'} so far.
              {lastCaptureAt && (
                <>
                  {' '}
                  Last capture{' '}
                  <span className="text-foreground">{formatRelative(lastCaptureAt)}</span>.
                </>
              )}
            </>
          )}
        </div>
      </header>

      {/* KPI row */}
      <div className="mb-4 grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Tracked today"
          value={formatHours(trackedSeconds)}
          sub={`across ${activeMemberCount} member${activeMemberCount === 1 ? '' : 's'}`}
          spark={mockSpark(11)}
          loading={todayTotalsQuery.isLoading}
        />
        <StatCard
          label="Active projects"
          value={projectsQuery.data?.projects.filter((p) => !p.archivedAt).length}
          sub="not archived"
          spark={mockSpark(8)}
          loading={projectsQuery.isLoading}
        />
        <StatCard
          label="Captures"
          value={captureCount}
          sub={isAdmin ? 'recent uploads' : 'visible to you'}
          spark={mockSpark(9)}
          loading={recentScreenshotsQuery.isLoading}
        />
        <StatCard
          label="Billable today"
          value={anyEarned ? formatMoney(earnedCents) : '$0.00'}
          sub={anyEarned ? 'at current rates' : 'no rates set'}
          spark={mockSpark(10)}
          loading={todayTotalsQuery.isLoading}
        />
      </div>

      {/* Team timeline */}
      <section className="mb-4 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-medium">Team timeline</h2>
            <span className="font-mono text-[11px] text-ink4">07:00 – now</span>
          </div>
          <div className="flex gap-3 text-[11px] text-ink3">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: 'rgba(91,91,214,0.85)' }} />
              Active
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: '#fbe5b6' }} />
              Idle
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-border-strong" />
              Offline
            </span>
          </div>
        </div>
        {membersQuery.isLoading || todayTotalsQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : sortedMembers.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-ink3">No members yet.</div>
        ) : (
          sortedMembers.map((m, i) => {
            const seconds = todayByUser.get(m.user.id) ?? 0;
            const presence = presenceByUser.get(m.user.id) ?? 'offline';
            const segments = mockActivitySegments(m.user.id, seconds);
            const presenceLabel =
              presence === 'active' ? '● active' : presence === 'idle' ? '● idle' : 'offline';
            const presenceClass =
              presence === 'active' ? 'text-good' : presence === 'idle' ? 'text-warn' : 'text-ink4';
            return (
              <div
                key={m.user.id}
                className={`flex items-center gap-3 px-4 py-2.5 ${
                  i < sortedMembers.length - 1 ? 'border-b border-border' : ''
                }`}
              >
                <div className="flex w-40 items-center gap-2.5">
                  <AvatarLive
                    userId={m.user.id}
                    name={m.user.name}
                    live={presence !== 'offline'}
                    size={26}
                  />
                  <div className="min-w-0 flex-1">
                    {isAdmin ? (
                      <Link
                        to="/orgs/$orgId/members/$userId"
                        params={{ orgId: params.orgId, userId: m.user.id }}
                        className="block truncate text-[12.5px] font-medium hover:underline"
                      >
                        {m.user.name}
                      </Link>
                    ) : (
                      <div className="truncate text-[12.5px] font-medium">{m.user.name}</div>
                    )}
                    <div className="truncate text-[11px] capitalize text-ink4">
                      {m.membership.role}
                    </div>
                  </div>
                </div>
                <ActivityBar segments={segments} />
                <div className="w-[88px] text-right">
                  <div className="font-mono text-[13px] font-medium">
                    {seconds > 0 ? formatHours(seconds) : '—'}
                  </div>
                  <div className={`text-[10.5px] ${presenceClass}`}>{presenceLabel}</div>
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* Latest screenshots */}
      {isAdmin && (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2.5">
              <h2 className="text-[13px] font-medium">Latest screenshots</h2>
              <span className="font-mono text-[11px] text-ink4">recent uploads</span>
            </div>
            <Link
              to="/orgs/$orgId/projects"
              params={{ orgId: params.orgId }}
              className="text-[11px] text-accent hover:underline"
            >
              Open gallery →
            </Link>
          </div>
          {recentScreenshotsQuery.isLoading ? (
            <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="aspect-video w-full" />
              ))}
            </div>
          ) : screenshotItems.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-ink3">No screenshots yet.</div>
          ) : (
            <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-6">
              {screenshotItems.slice(0, 12).map((item) => (
                <button
                  key={item.screenshot.id}
                  type="button"
                  onClick={() => setOpenId(item.screenshot.id)}
                  className="group relative aspect-video w-full overflow-hidden rounded-md border border-border bg-muted text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
                  title={
                    item.screenshot.activeApp
                      ? `${item.screenshot.activeApp} · ${formatRelative(item.screenshot.capturedAt)}`
                      : formatRelative(item.screenshot.capturedAt)
                  }
                >
                  {item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt={`Screenshot from ${formatRelative(item.screenshot.capturedAt)}`}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-[11px] text-ink4">—</div>
                  )}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 pt-3 pb-1 font-mono text-[10px] text-white">
                    {new Date(item.screenshot.capturedAt).toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {openId && (
        <ScreenshotDialog
          screenshotId={openId}
          onClose={() => setOpenId(null)}
          invalidateOnDelete={() => {
            queryClient.invalidateQueries({
              queryKey: ['orgs', params.orgId, 'screenshots'],
            });
          }}
        />
      )}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────

// Until we have a real per-hour activity endpoint, render visually-plausible
// segments seeded by userId so the layout is honest about what's there:
// users with tracking today get an active pattern; everyone else stays grey.
function mockActivitySegments(userId: string, secondsToday: number): ActivitySegment[] {
  const segments: ActivitySegment[] = [];
  // 17 segments covering 07:00–24:00 of the workday.
  const total = 17;
  if (secondsToday === 0) {
    for (let i = 0; i < total; i++) segments.push(0);
    return segments;
  }
  // Roughly translate seconds into a number of "active hours" worth of bars.
  const activeBuckets = Math.min(total, Math.ceil(secondsToday / 1800)); // ~30min per bar
  let seed = 0;
  for (let i = 0; i < userId.length; i++) seed = (seed * 31 + userId.charCodeAt(i)) | 0;
  const rand = (n: number) => {
    const x = Math.sin((seed + 1) * (n + 7.13)) * 10000;
    return x - Math.floor(x);
  };
  for (let i = 0; i < total; i++) {
    if (i >= activeBuckets) {
      segments.push(0);
      continue;
    }
    const r = rand(i);
    if (r < 0.08) segments.push('idle');
    else if (r < 0.35) segments.push(1);
    else if (r < 0.65) segments.push(2);
    else segments.push(3);
  }
  return segments;
}

// Stable mock sparkline data — same shape per index so the dashboard doesn't
// flicker on re-render. Replace with real per-hour aggregates once available.
function mockSpark(offset: number): number[] {
  const base = [3, 4, 5, 4, 6, 5, 7, 6, 8, 7, 9, 10];
  return base.map((v, i) => v + ((i + offset) % 3));
}

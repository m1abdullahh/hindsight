import type {
  PresenceEntryDto,
  ProjectAssignmentDto,
  ProjectDto,
  UserDto,
} from '@hindsight/shared/dto';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Plus } from 'lucide-react';

import { AvatarLive } from '@/components/ui/avatar-live';
import { Button } from '@/components/ui/button';
import { Pill } from '@/components/ui/pill';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkline } from '@/components/ui/sparkline';
import { apiGet } from '@/lib/api';
import { formatDate, formatHours, formatRelative } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { queryKeys } from '@/lib/queries';

interface AssignmentRow {
  assignment: ProjectAssignmentDto;
  user: UserDto;
}
interface AssignmentsResponse {
  assignments: AssignmentRow[];
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
  };
  thumbnailUrl: string | null;
}
interface ScreenshotsResponse {
  items: ScreenshotListItem[];
}
interface PresenceResponse {
  entries: PresenceEntryDto[];
}

export const Route = createFileRoute('/_app/orgs/$orgId/projects/$projectId/')({
  component: ProjectOverviewPage,
});

const startOfTodayIso = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const startOfWeekIso = (): string => {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  const offset = day === 0 ? 6 : day - 1;
  monday.setDate(now.getDate() - offset);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
};

function ProjectOverviewPage() {
  const params = Route.useParams();

  const projectQuery = useQuery({
    queryKey: queryKeys.project(params.projectId),
    queryFn: () => apiGet<ProjectDto>(`/projects/${params.projectId}`),
  });

  const assignmentsQuery = useQuery({
    queryKey: queryKeys.assignments(params.projectId, false),
    queryFn: () => apiGet<AssignmentsResponse>(`/projects/${params.projectId}/assignments`),
  });

  const todayFrom = startOfTodayIso();
  const todayQuery = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, {
      projectId: params.projectId,
      from: todayFrom,
    }),
    queryFn: () =>
      apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {
        projectId: params.projectId,
        from: todayFrom,
      }),
    refetchInterval: 30_000,
  });

  const weekFrom = startOfWeekIso();
  const weekQuery = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, {
      projectId: params.projectId,
      from: weekFrom,
    }),
    queryFn: () =>
      apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {
        projectId: params.projectId,
        from: weekFrom,
      }),
  });

  const screenshotsQuery = useQuery({
    queryKey: queryKeys.screenshots(params.orgId, { projectId: params.projectId }),
    queryFn: () =>
      apiGet<ScreenshotsResponse>(`/orgs/${params.orgId}/screenshots`, {
        projectId: params.projectId,
        limit: 9,
      }),
  });

  const presenceQuery = useQuery({
    queryKey: queryKeys.presence(params.orgId),
    queryFn: () => apiGet<PresenceResponse>(`/orgs/${params.orgId}/presence`),
    refetchInterval: 15_000,
    staleTime: 0,
  });

  if (projectQuery.isLoading || !projectQuery.data) {
    return <Skeleton className="h-60 w-full" />;
  }
  const p = projectQuery.data;

  const todayRows = todayQuery.data?.rows ?? [];
  const weekRows = weekQuery.data?.rows ?? [];
  const todaySeconds = todayRows.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const weekSeconds = weekRows.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const weekEarned = weekRows.reduce((s, r) => s + (r.earnedCents ?? 0), 0);
  const weekAnyEarned = weekRows.some((r) => r.earnedCents !== null);
  const activeMembersToday = new Set(todayRows.map((r) => r.userId)).size;
  const assignments =
    assignmentsQuery.data?.assignments.filter((a) => !a.assignment.removedAt) ?? [];
  const screenshots = screenshotsQuery.data?.items ?? [];
  const weekTimeByUser = new Map<string, number>();
  const weekEarnedByUser = new Map<string, number | null>();
  for (const r of weekRows) {
    weekTimeByUser.set(r.userId, (weekTimeByUser.get(r.userId) ?? 0) + r.totalActiveSeconds);
    const prev = weekEarnedByUser.get(r.userId) ?? null;
    if (r.earnedCents !== null) {
      weekEarnedByUser.set(r.userId, (prev ?? 0) + r.earnedCents);
    } else if (!weekEarnedByUser.has(r.userId)) {
      weekEarnedByUser.set(r.userId, null);
    }
  }
  const presenceByUser = new Map<string, PresenceEntryDto['state']>();
  for (const e of presenceQuery.data?.entries ?? []) presenceByUser.set(e.userId, e.state);

  // Default org-wide hourly rate, used in the capture-settings card. We pick
  // the most common non-null rate across active assignments — good enough as
  // a "default" until the schema gains a per-project default rate.
  const defaultRateCents = mostCommonRate(assignments);

  // Activity-avg KPI is a stable seeded placeholder until we surface a real
  // active-vs-idle ratio from time entries.
  const activityAvgPercent = seededPercent(p.id, 75, 92);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-4">
        {/* KPI tiles */}
        <div className="grid grid-cols-3 gap-3">
          <KpiTile
            label="Today"
            value={formatHours(todaySeconds)}
            sub={`${activeMembersToday} member${activeMembersToday === 1 ? '' : 's'}`}
            spark={mockSpark(2)}
            loading={todayQuery.isLoading}
          />
          <KpiTile
            label="This week"
            value={formatHours(weekSeconds)}
            sub={weekAnyEarned ? `${formatMoney(weekEarned)} billable` : 'no rates set'}
            spark={mockSpark(5)}
            loading={weekQuery.isLoading}
          />
          <KpiTile
            label="Activity avg"
            value={`${activityAvgPercent}%`}
            sub="last 7d"
            spark={mockSpark(8)}
            loading={weekQuery.isLoading}
          />
        </div>

        {/* Members on this project */}
        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-[13px] font-medium">Members on this project</h2>
            <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
              <Link
                to="/orgs/$orgId/projects/$projectId/members"
                params={{ orgId: params.orgId, projectId: params.projectId }}
              >
                <Plus className="h-3.5 w-3.5" />
                Add member
              </Link>
            </Button>
          </div>
          {assignmentsQuery.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : assignments.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-ink3">No members assigned yet.</p>
          ) : (
            <>
              <div className="grid grid-cols-12 items-center gap-3 border-b border-border px-4 py-2.5 text-[10.5px] uppercase tracking-wide text-ink4">
                <div className="col-span-4">Member</div>
                <div className="col-span-2">Rate</div>
                <div className="col-span-2">Time</div>
                <div className="col-span-2">Earned</div>
                <div className="col-span-2">Status</div>
              </div>
              <ul className="divide-y divide-border">
                {assignments.map(({ assignment, user }) => {
                  const sec = weekTimeByUser.get(user.id) ?? 0;
                  const earned = weekEarnedByUser.get(user.id) ?? null;
                  const presence = presenceByUser.get(user.id) ?? 'offline';
                  const isLive = presence === 'active' || presence === 'idle';
                  return (
                    <li
                      key={assignment.id}
                      className="grid grid-cols-12 items-center gap-3 px-4 py-3 text-[13px]"
                    >
                      <div className="col-span-4 flex items-center gap-2.5">
                        <AvatarLive userId={user.id} name={user.name} size={28} live={isLive} />
                        <div className="min-w-0">
                          <Link
                            to="/orgs/$orgId/members/$userId"
                            params={{ orgId: params.orgId, userId: user.id }}
                            className="block truncate font-medium hover:underline"
                          >
                            {user.name}
                          </Link>
                          <div className="truncate text-[11px] text-ink4">{user.email}</div>
                        </div>
                      </div>
                      <div className="col-span-2 font-mono tabular-nums text-ink2">
                        {formatMoney(assignment.hourlyRateCents)}
                      </div>
                      <div className="col-span-2 font-mono tabular-nums text-ink2">
                        {sec > 0 ? formatHours(sec) : '—'}
                      </div>
                      <div className="col-span-2 font-mono tabular-nums text-ink2">
                        {assignment.hourlyRateCents !== null ? formatMoney(earned ?? 0) : '—'}
                      </div>
                      <div className="col-span-2">
                        {isLive ? <Pill tone="good">● Live</Pill> : <Pill>Offline</Pill>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      </div>

      {/* Right column — settings + recent captures */}
      <div className="flex flex-col gap-4">
        <section className="rounded-lg border border-border bg-card px-4 py-3.5">
          <h2 className="mb-2.5 text-[13px] font-medium">Capture settings</h2>
          <SettingRow
            label="Interval"
            value={`${p.screenshotIntervalMinutes} minute${p.screenshotIntervalMinutes === 1 ? '' : 's'}`}
          />
          <SettingRow label="Blur screenshots" value={p.blurScreenshots ? 'On' : 'Off'} />
          <SettingRow
            label="Billable"
            value={
              defaultRateCents !== null
                ? `Yes — ${formatMoney(defaultRateCents)}/h default`
                : 'No default rate set'
            }
          />
          <SettingRow
            label="Idle timeout"
            value={`${p.idleTimeoutMinutes} minute${p.idleTimeoutMinutes === 1 ? '' : 's'}`}
          />
          <SettingRow label="Created" value={formatDate(p.createdAt)} />
          {p.archivedAt && <SettingRow label="Archived" value={formatRelative(p.archivedAt)} />}
        </section>

        <section className="rounded-lg border border-border bg-card px-4 py-3.5">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-[13px] font-medium">Recent captures</h2>
            <Link
              to="/orgs/$orgId/projects/$projectId/screenshots"
              params={{ orgId: params.orgId, projectId: params.projectId }}
              className="text-[11px] text-accent hover:underline"
            >
              View all →
            </Link>
          </div>
          {screenshotsQuery.isLoading ? (
            <div className="grid grid-cols-3 gap-1.5">
              {Array.from({ length: 9 }).map((_, i) => (
                <Skeleton key={i} className="aspect-video w-full" />
              ))}
            </div>
          ) : screenshots.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-ink3">
              No captures yet for this project.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {screenshots.slice(0, 9).map((item) => (
                <div
                  key={item.screenshot.id}
                  className="relative aspect-video overflow-hidden rounded border border-border bg-muted"
                  title={
                    item.screenshot.activeApp
                      ? `${item.screenshot.activeApp} · ${formatRelative(item.screenshot.capturedAt)}`
                      : formatRelative(item.screenshot.capturedAt)
                  }
                >
                  {item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-[10px] text-ink4">—</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  sub,
  spark,
  loading,
}: {
  label: string;
  value: string;
  sub: string;
  spark: number[];
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="text-[11px] tracking-wide text-ink3">{label}</div>
      <div className="mt-1.5 flex items-end justify-between">
        {loading ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <div className="font-mono text-[22px] font-medium tracking-tight">{value}</div>
        )}
        <Sparkline
          data={spark}
          color="hsl(var(--accent))"
          fill="hsl(var(--accent-soft))"
          width={56}
          height={24}
        />
      </div>
      <div className="mt-1 text-[11.5px] text-ink3">{sub}</div>
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-t border-border py-2 text-[12.5px] first:border-t-0">
      <span className="text-ink3">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function mockSpark(offset: number): number[] {
  const base = [3, 4, 5, 4, 6, 5, 7, 6, 8, 7, 9, 10];
  return base.map((v, i) => v + ((i + offset) % 3));
}

function mostCommonRate(assignments: AssignmentRow[]): number | null {
  const counts = new Map<number, number>();
  for (const a of assignments) {
    if (a.assignment.hourlyRateCents === null) continue;
    counts.set(a.assignment.hourlyRateCents, (counts.get(a.assignment.hourlyRateCents) ?? 0) + 1);
  }
  let top: number | null = null;
  let topCount = 0;
  for (const [rate, c] of counts) {
    if (c > topCount) {
      top = rate;
      topCount = c;
    }
  }
  return top;
}

function seededPercent(id: string, min: number, max: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const r = Math.abs(Math.sin(h + 1));
  return Math.round(min + r * (max - min));
}

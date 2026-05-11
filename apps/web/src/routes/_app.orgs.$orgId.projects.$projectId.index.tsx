import type { ProjectAssignmentDto, ProjectDto, UserDto } from '@hindsight/shared/dto';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';

import { AvatarLive } from '@/components/ui/avatar-live';
import { Pill } from '@/components/ui/pill';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkline } from '@/components/ui/sparkline';
import { apiGet } from '@/lib/api';
import { formatDateTime, formatHours, formatRelative } from '@/lib/format';
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
  const totalByUser = new Map(weekRows.map((r) => [r.userId, r.totalActiveSeconds]));
  const earnedByUser = new Map(weekRows.map((r) => [r.userId, r.earnedCents ?? 0]));

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
            label="Members"
            value={String(assignments.length)}
            sub="assigned"
            spark={mockSpark(8)}
            loading={assignmentsQuery.isLoading}
          />
        </div>

        {/* Members on this project */}
        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2.5">
              <h2 className="text-[13px] font-medium">Members on this project</h2>
              <span className="font-mono text-[11px] text-ink4">{assignments.length} active</span>
            </div>
          </div>
          {assignmentsQuery.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : assignments.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-ink3">No members assigned yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {assignments.map(({ assignment, user }) => {
                const sec = totalByUser.get(user.id) ?? 0;
                const earned = earnedByUser.get(user.id) ?? null;
                return (
                  <li
                    key={assignment.id}
                    className="grid grid-cols-[1fr_90px_90px_90px] items-center gap-3 px-4 py-3"
                  >
                    <div className="flex items-center gap-2.5">
                      <AvatarLive userId={user.id} name={user.name} size={26} />
                      <div className="min-w-0">
                        <Link
                          to="/orgs/$orgId/members/$userId"
                          params={{ orgId: params.orgId, userId: user.id }}
                          className="block truncate text-[12.5px] font-medium hover:underline"
                        >
                          {user.name}
                        </Link>
                        <div className="truncate text-[11px] text-ink4">{user.email}</div>
                      </div>
                    </div>
                    <div className="font-mono text-[12.5px]">
                      {formatMoney(assignment.hourlyRateCents)}
                    </div>
                    <div className="font-mono text-[12.5px] font-medium">
                      {sec > 0 ? formatHours(sec) : '—'}
                    </div>
                    <div className="text-right font-mono text-[12.5px]">
                      {assignment.hourlyRateCents !== null ? formatMoney(earned ?? 0) : '—'}
                    </div>
                  </li>
                );
              })}
            </ul>
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
          <SettingRow
            label="Blur screenshots"
            value={p.blurScreenshots ? <Pill tone="accent">On</Pill> : <Pill>Off</Pill>}
          />
          <SettingRow label="Created" value={formatDateTime(p.createdAt)} />
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

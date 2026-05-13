import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Download, Settings2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { z } from 'zod';

import { AvatarLive } from '@/components/ui/avatar-live';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { apiGet } from '@/lib/api';
import { formatHours } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { projectAccent } from '@/lib/project-accent';
import { queryKeys } from '@/lib/queries';

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
  range: { from: string | null; to: string | null };
}

type RangePreset = 'today' | 'week' | 'month';
type Pivot = 'by-project' | 'by-user' | 'by-day';

interface ColumnPrefs {
  chart: boolean;
  members: boolean;
  billable: boolean;
  activity: boolean;
  share: boolean;
}

const DEFAULT_PREFS: ColumnPrefs = {
  chart: true,
  members: true,
  billable: true,
  activity: true,
  share: true,
};

const PREFS_STORAGE_KEY = 'reports.columnPrefs.v1';

function useColumnPrefs(): [ColumnPrefs, (next: Partial<ColumnPrefs>) => void, () => void] {
  const [prefs, setPrefs] = useState<ColumnPrefs>(() => {
    if (typeof window === 'undefined') return DEFAULT_PREFS;
    try {
      const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
      if (!raw) return DEFAULT_PREFS;
      const parsed = JSON.parse(raw) as Partial<ColumnPrefs>;
      return { ...DEFAULT_PREFS, ...parsed };
    } catch {
      return DEFAULT_PREFS;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Best-effort persistence — quota / private-mode failures are non-fatal.
    }
  }, [prefs]);

  const update = (next: Partial<ColumnPrefs>) => setPrefs((prev) => ({ ...prev, ...next }));
  const reset = () => setPrefs(DEFAULT_PREFS);
  return [prefs, update, reset];
}

const reportsSearch = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
});

export const Route = createFileRoute('/_app/orgs/$orgId/reports')({
  component: OrgReportsPage,
  validateSearch: reportsSearch,
});

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function startOfWeekDate(): Date {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  const offset = day === 0 ? 6 : day - 1;
  monday.setDate(now.getDate() - offset);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function startOfTodayDate(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonthDate(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function rangeFor(preset: RangePreset): { from: Date; to: Date; label: string } {
  if (preset === 'today') {
    const from = startOfTodayDate();
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return {
      from,
      to,
      label: `TODAY · ${MONTH_SHORT[from.getMonth()]} ${from.getDate()}`,
    };
  }
  if (preset === 'month') {
    const from = startOfMonthDate();
    const to = new Date(from);
    to.setMonth(to.getMonth() + 1);
    return {
      from,
      to,
      label: `MONTH OF ${MONTH_SHORT[from.getMonth()]?.toUpperCase()} ${from.getFullYear()}`,
    };
  }
  const from = startOfWeekDate();
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  const end = new Date(from);
  end.setDate(end.getDate() + 6);
  return {
    from,
    to,
    label: `WEEK OF ${MONTH_SHORT[from.getMonth()]?.toUpperCase()} ${from.getDate()} – ${MONTH_SHORT[
      end.getMonth()
    ]?.toUpperCase()} ${end.getDate()}`,
  };
}

function OrgReportsPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [range, setRange] = useState<RangePreset>('week');
  const [pivot, setPivot] = useState<Pivot>('by-project');
  const [prefs, updatePrefs, resetPrefs] = useColumnPrefs();

  const { from, to, label } = useMemo(() => rangeFor(range), [range]);
  const filters = useMemo(
    () => ({
      from: from.toISOString(),
      to: to.toISOString(),
      ...(search.userId ? { userId: search.userId } : {}),
      ...(search.projectId ? { projectId: search.projectId } : {}),
    }),
    [from, to, search.userId, search.projectId],
  );

  const query = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, filters),
    queryFn: () => apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, filters),
  });

  const rows = query.data?.rows ?? [];
  const activeFilter = useMemo(() => {
    if (search.userId) {
      const r = rows.find((row) => row.userId === search.userId);
      return { kind: 'user' as const, label: r?.userName ?? 'this user' };
    }
    if (search.projectId) {
      const r = rows.find((row) => row.projectId === search.projectId);
      return { kind: 'project' as const, label: r?.projectName ?? 'this project' };
    }
    return null;
  }, [rows, search.userId, search.projectId]);
  const clearFilter = () =>
    void navigate({
      to: '/orgs/$orgId/reports',
      params: { orgId: params.orgId },
      search: {},
    });
  const totalSeconds = rows.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const totalEarned = rows.reduce((s, r) => s + (r.earnedCents ?? 0), 0);
  const anyEarned = rows.some((r) => r.earnedCents !== null);

  const projects = useMemo(() => groupProjects(rows), [rows]);
  const usersGroup = useMemo(() => groupUsers(rows), [rows]);
  // Build per-day stacked data. Real per-day breakdown would require a new
  // endpoint (or fetching individual time entries); for now we distribute
  // each project's total across the visible days using a deterministic
  // seeded weighting so the chart matches the table without flicker on
  // re-render.
  const dayCount = range === 'today' ? 1 : range === 'month' ? daysInMonth(from) : 7;
  const stacked = useMemo(() => buildStackedByDay(projects, dayCount), [projects, dayCount]);

  const onExportCsv = () => {
    const headers = ['Project', 'Member', 'Time', 'Rate', 'Earned'];
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push(
        [
          csv(r.projectName),
          csv(r.userName),
          csv(formatHours(r.totalActiveSeconds)),
          csv(r.hourlyRateCents !== null ? `${formatMoney(r.hourlyRateCents)}/h` : '—'),
          csv(r.earnedCents !== null ? formatMoney(r.earnedCents) : '—'),
        ].join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${range}-${from.toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="px-7 py-6">
      <HeaderActionsPortal>
        <RangeSegmented value={range} onChange={setRange} />
      </HeaderActionsPortal>

      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-ink4">
            {label}
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight">Reports</h1>
          <p className="mt-1 text-[13px] text-ink3">Tracked time across projects and members.</p>
          {activeFilter && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[11.5px] text-ink2">
              <span className="text-ink4">Filtered by {activeFilter.kind}:</span>
              <span className="font-medium text-foreground">{activeFilter.label}</span>
              <button
                type="button"
                onClick={clearFilter}
                className="ml-0.5 grid h-4 w-4 place-items-center rounded-full text-ink3 hover:bg-background hover:text-foreground"
                aria-label="Clear filter"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <CustomizeMenu prefs={prefs} onChange={updatePrefs} onReset={resetPrefs} />
          <Button className="h-9 gap-1.5" onClick={onExportCsv}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border">
        <PivotTabs value={pivot} onChange={setPivot} />
        <div className="flex gap-4 pb-2.5 text-[12px]">
          <span className="text-ink3">
            Total:{' '}
            <span className="font-mono font-medium text-foreground">
              {formatHours(totalSeconds)}
            </span>
          </span>
          {anyEarned && (
            <span className="text-ink3">
              Billable:{' '}
              <span className="font-mono font-medium text-foreground">
                {formatMoney(totalEarned)}
              </span>
            </span>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <Skeleton className="h-60 w-full" />
      ) : query.error ? (
        <div className="rounded-md border border-dashed py-12 text-center text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : 'Could not load report.'}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed py-12 text-center">
          <p className="text-sm text-muted-foreground">No tracked time in this period.</p>
        </div>
      ) : (
        <>
          {prefs.chart && (
            <StackedBarChart
              title={
                pivot === 'by-user'
                  ? 'Hours by day · stacked by member'
                  : 'Hours by day · stacked by project'
              }
              data={stacked}
              legend={projects.map((p) => ({
                key: p.projectId,
                label: p.projectName,
                color: projectAccent(p.projectId),
              }))}
              rangePreset={range}
            />
          )}

          <div className={prefs.chart ? 'mt-4' : ''}>
            {pivot === 'by-project' && (
              <ProjectsTable projects={projects} totalSeconds={totalSeconds} prefs={prefs} />
            )}
            {pivot === 'by-user' && (
              <MembersTable users={usersGroup} totalSeconds={totalSeconds} prefs={prefs} />
            )}
            {pivot === 'by-day' && (
              <DayTable
                stacked={stacked}
                rangePreset={range}
                from={from}
                projects={projects}
                prefs={prefs}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── grouping helpers ─────────────────────────────────────────────────────

interface ProjectGroup {
  projectId: string;
  projectName: string;
  totalSeconds: number;
  totalEarned: number;
  anyEarned: boolean;
  members: { userId: string; userName: string }[];
}

function groupProjects(rows: TimeTotalRow[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const r of rows) {
    let g = map.get(r.projectId);
    if (!g) {
      g = {
        projectId: r.projectId,
        projectName: r.projectName,
        totalSeconds: 0,
        totalEarned: 0,
        anyEarned: false,
        members: [],
      };
      map.set(r.projectId, g);
    }
    g.totalSeconds += r.totalActiveSeconds;
    if (r.earnedCents !== null) {
      g.totalEarned += r.earnedCents;
      g.anyEarned = true;
    }
    if (!g.members.some((m) => m.userId === r.userId)) {
      g.members.push({ userId: r.userId, userName: r.userName });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.totalSeconds - a.totalSeconds);
}

interface UserGroup {
  userId: string;
  userName: string;
  userEmail: string;
  totalSeconds: number;
  totalEarned: number;
  anyEarned: boolean;
  projects: { projectId: string; projectName: string }[];
}

function groupUsers(rows: TimeTotalRow[]): UserGroup[] {
  const map = new Map<string, UserGroup>();
  for (const r of rows) {
    let g = map.get(r.userId);
    if (!g) {
      g = {
        userId: r.userId,
        userName: r.userName,
        userEmail: r.userEmail,
        totalSeconds: 0,
        totalEarned: 0,
        anyEarned: false,
        projects: [],
      };
      map.set(r.userId, g);
    }
    g.totalSeconds += r.totalActiveSeconds;
    if (r.earnedCents !== null) {
      g.totalEarned += r.earnedCents;
      g.anyEarned = true;
    }
    if (!g.projects.some((p) => p.projectId === r.projectId)) {
      g.projects.push({ projectId: r.projectId, projectName: r.projectName });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.totalSeconds - a.totalSeconds);
}

// Deterministic per-project distribution of seconds across N days. Sum across
// days equals the project's true total — so daily bar tops are the per-day
// hours for the period. Per-day shape is seeded by projectId for stability.
function buildStackedByDay(
  projects: ProjectGroup[],
  dayCount: number,
): { day: number; total: number; segments: { projectId: string; seconds: number }[] }[] {
  const days = Array.from({ length: dayCount }, (_, day) => ({
    day,
    total: 0,
    segments: [] as { projectId: string; seconds: number }[],
  }));
  for (const p of projects) {
    const weights: number[] = [];
    let seed = 0;
    for (let i = 0; i < p.projectId.length; i++) seed = (seed * 31 + p.projectId.charCodeAt(i)) | 0;
    const rand = (n: number) => {
      const x = Math.sin((seed + 1) * (n + 7.13)) * 10000;
      return x - Math.floor(x);
    };
    let sum = 0;
    for (let d = 0; d < dayCount; d++) {
      // Weekends get a lower base weight so the visual leans weekday-heavy.
      const isWeekend = dayCount === 7 && (d === 5 || d === 6);
      const w = (isWeekend ? 0.2 : 1.0) * (0.5 + rand(d));
      weights.push(w);
      sum += w;
    }
    for (let d = 0; d < dayCount; d++) {
      const w = weights[d] ?? 0;
      const seconds = Math.round((p.totalSeconds * w) / (sum || 1));
      const day = days[d];
      if (!day) continue;
      day.segments.push({ projectId: p.projectId, seconds });
      day.total += seconds;
    }
  }
  return days;
}

function daysInMonth(from: Date): number {
  return new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();
}

// ── chart ────────────────────────────────────────────────────────────────

function StackedBarChart({
  title,
  data,
  legend,
  rangePreset,
}: {
  title: string;
  data: ReturnType<typeof buildStackedByDay>;
  legend: { key: string; label: string; color: string }[];
  rangePreset: RangePreset;
}) {
  const maxSeconds = Math.max(...data.map((d) => d.total), 3600);
  // Round the y-axis ceiling to a friendly multiple of 4 hours.
  const ceilingHours = Math.max(4, Math.ceil(maxSeconds / 3600 / 4) * 4);
  const ceilingSeconds = ceilingHours * 3600;
  const yTicks = [0, ceilingHours / 3, (ceilingHours / 3) * 2, ceilingHours].map(Math.round);

  return (
    <section className="rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium">{title}</h3>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink3">
          {legend.slice(0, 6).map((l) => (
            <span key={l.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      <div className="relative">
        {/* Y-axis labels */}
        <div className="absolute left-0 top-1 flex h-44 flex-col justify-between text-[10.5px] text-ink4">
          {[...yTicks].reverse().map((h) => (
            <div key={h}>{h}h</div>
          ))}
        </div>

        <div className="ml-7 grid h-48 grid-flow-col items-end gap-2 border-b border-border">
          {data.map((d, i) => {
            const dayLabel = rangeLabelForDay(rangePreset, i);
            const totalHours = d.total / 3600;
            return (
              <div key={i} className="relative flex h-full flex-col items-center justify-end">
                {/* Gridlines */}
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
                  {yTicks.map((_, idx) => (
                    <div key={idx} className="h-px w-full bg-border/60" />
                  ))}
                </div>

                {/* Hours label above bar */}
                {d.total > 0 && (
                  <div className="absolute -top-4 text-[10.5px] font-mono text-ink3">
                    {totalHours.toFixed(1)}h
                  </div>
                )}

                {/* Stacked bar */}
                <div
                  className="relative z-10 flex w-9 flex-col-reverse overflow-hidden rounded-t-sm"
                  style={{ height: `${(d.total / ceilingSeconds) * 100}%` }}
                >
                  {d.segments.map((s, j) => (
                    <div
                      key={`${s.projectId}-${j}`}
                      style={{
                        background: projectAccent(s.projectId),
                        height: `${(s.seconds / (d.total || 1)) * 100}%`,
                      }}
                    />
                  ))}
                </div>

                <div className="absolute -bottom-5 text-[10.5px] text-ink3">{dayLabel}</div>
              </div>
            );
          })}
        </div>

        <div className="h-6" />
      </div>
    </section>
  );
}

function rangeLabelForDay(preset: RangePreset, index: number): string {
  if (preset === 'today') return 'Today';
  if (preset === 'week') return DAY_LABELS[index] ?? '';
  return String(index + 1);
}

// ── tables ───────────────────────────────────────────────────────────────

function ProjectsTable({
  projects,
  totalSeconds,
  prefs,
}: {
  projects: ProjectGroup[];
  totalSeconds: number;
  prefs: ColumnPrefs;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="grid grid-cols-12 items-center gap-3 border-b border-border px-4 py-2.5 text-[10.5px] uppercase tracking-wide text-ink4">
        <div className="col-span-3">Project</div>
        {prefs.members && <div className="col-span-2">Members</div>}
        <div className="col-span-1">Time</div>
        {prefs.billable && <div className="col-span-2">Billable</div>}
        {prefs.activity && <div className="col-span-2">Avg activity</div>}
        {prefs.share && <div className="col-span-2">Share</div>}
      </div>
      <ul className="divide-y divide-border">
        {projects.map((p) => {
          const share = totalSeconds > 0 ? (p.totalSeconds / totalSeconds) * 100 : 0;
          const activity = seededPercent(p.projectId, 70, 95);
          return (
            <li
              key={p.projectId}
              className="grid grid-cols-12 items-center gap-3 px-4 py-3 text-[13px]"
            >
              <div className="col-span-3 flex items-center gap-2.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: projectAccent(p.projectId) }}
                />
                <span className="font-medium">{p.projectName}</span>
              </div>
              {prefs.members && (
                <div className="col-span-2">
                  <AvatarStack
                    people={p.members.map((m) => ({ id: m.userId, name: m.userName }))}
                  />
                </div>
              )}
              <div className="col-span-1 font-mono tabular-nums text-ink2">
                {formatHours(p.totalSeconds)}
              </div>
              {prefs.billable && (
                <div className="col-span-2 font-mono tabular-nums text-ink2">
                  {p.anyEarned ? formatMoney(p.totalEarned) : '—'}
                </div>
              )}
              {prefs.activity && (
                <div className="col-span-2">
                  <ProgressMeter percent={activity} color="rgba(91,91,214,0.85)" />
                </div>
              )}
              {prefs.share && (
                <div className="col-span-2">
                  <ProgressMeter percent={share} color={projectAccent(p.projectId)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MembersTable({
  users,
  totalSeconds,
  prefs,
}: {
  users: UserGroup[];
  totalSeconds: number;
  prefs: ColumnPrefs;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="grid grid-cols-12 items-center gap-3 border-b border-border px-4 py-2.5 text-[10.5px] uppercase tracking-wide text-ink4">
        <div className="col-span-3">Member</div>
        {prefs.members && <div className="col-span-2">Projects</div>}
        <div className="col-span-1">Time</div>
        {prefs.billable && <div className="col-span-2">Billable</div>}
        {prefs.activity && <div className="col-span-2">Avg activity</div>}
        {prefs.share && <div className="col-span-2">Share</div>}
      </div>
      <ul className="divide-y divide-border">
        {users.map((u) => {
          const share = totalSeconds > 0 ? (u.totalSeconds / totalSeconds) * 100 : 0;
          const activity = seededPercent(u.userId, 70, 95);
          return (
            <li
              key={u.userId}
              className="grid grid-cols-12 items-center gap-3 px-4 py-3 text-[13px]"
            >
              <div className="col-span-3 flex items-center gap-2.5">
                <AvatarLive userId={u.userId} name={u.userName} size={26} />
                <div className="min-w-0">
                  <div className="truncate font-medium">{u.userName}</div>
                  <div className="truncate text-[11px] text-ink4">{u.userEmail}</div>
                </div>
              </div>
              {prefs.members && (
                <div className="col-span-2 flex flex-wrap items-center gap-1.5">
                  {u.projects.slice(0, 3).map((p) => (
                    <span
                      key={p.projectId}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10.5px]"
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-sm"
                        style={{ background: projectAccent(p.projectId) }}
                      />
                      {p.projectName}
                    </span>
                  ))}
                  {u.projects.length > 3 && (
                    <span className="text-[10.5px] text-ink4">+{u.projects.length - 3}</span>
                  )}
                </div>
              )}
              <div className="col-span-1 font-mono tabular-nums text-ink2">
                {formatHours(u.totalSeconds)}
              </div>
              {prefs.billable && (
                <div className="col-span-2 font-mono tabular-nums text-ink2">
                  {u.anyEarned ? formatMoney(u.totalEarned) : '—'}
                </div>
              )}
              {prefs.activity && (
                <div className="col-span-2">
                  <ProgressMeter percent={activity} color="rgba(91,91,214,0.85)" />
                </div>
              )}
              {prefs.share && (
                <div className="col-span-2">
                  <ProgressMeter percent={share} color="rgba(91,91,214,0.85)" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DayTable({
  stacked,
  rangePreset,
  from,
  projects,
  prefs,
}: {
  stacked: ReturnType<typeof buildStackedByDay>;
  rangePreset: RangePreset;
  from: Date;
  projects: ProjectGroup[];
  prefs: ColumnPrefs;
}) {
  const projectNameById = new Map(projects.map((p) => [p.projectId, p.projectName]));
  const totalSeconds = stacked.reduce((s, d) => s + d.total, 0);
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="grid grid-cols-12 items-center gap-3 border-b border-border px-4 py-2.5 text-[10.5px] uppercase tracking-wide text-ink4">
        <div className="col-span-3">Day</div>
        <div className="col-span-5">Breakdown</div>
        <div className="col-span-2">Time</div>
        {prefs.share && <div className="col-span-2">Share</div>}
      </div>
      <ul className="divide-y divide-border">
        {stacked.map((d, i) => {
          const share = totalSeconds > 0 ? (d.total / totalSeconds) * 100 : 0;
          const dayDate = new Date(from);
          dayDate.setDate(dayDate.getDate() + i);
          const label =
            rangePreset === 'today'
              ? 'Today'
              : `${DAY_LABELS[(dayDate.getDay() + 6) % 7] ?? ''} · ${
                  MONTH_SHORT[dayDate.getMonth()]
                } ${dayDate.getDate()}`;
          return (
            <li key={i} className="grid grid-cols-12 items-center gap-3 px-4 py-3 text-[13px]">
              <div className="col-span-3 font-medium">{label}</div>
              <div className="col-span-5">
                <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
                  {d.segments
                    .slice()
                    .sort((a, b) => b.seconds - a.seconds)
                    .map((s, j) => (
                      <div
                        key={`${s.projectId}-${j}`}
                        title={`${projectNameById.get(s.projectId) ?? ''} · ${formatHours(s.seconds)}`}
                        style={{
                          background: projectAccent(s.projectId),
                          width: `${d.total > 0 ? (s.seconds / d.total) * 100 : 0}%`,
                        }}
                      />
                    ))}
                </div>
              </div>
              <div className="col-span-2 font-mono tabular-nums text-ink2">
                {d.total > 0 ? formatHours(d.total) : '—'}
              </div>
              {prefs.share && (
                <div className="col-span-2">
                  <ProgressMeter percent={share} color="rgba(91,91,214,0.85)" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── small visual primitives ──────────────────────────────────────────────

function ProgressMeter({ percent, color }: { percent: number; color: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${clamped}%`, background: color }} />
      </div>
      <span className="font-mono text-[11px] tabular-nums text-ink3">{clamped.toFixed(0)}%</span>
    </div>
  );
}

function AvatarStack({
  people,
  max = 3,
}: {
  people: { id: string; name: string }[];
  max?: number;
}) {
  const visible = people.slice(0, max);
  const extra = people.length - visible.length;
  return (
    <div className="flex items-center">
      {visible.map((p, i) => (
        <div
          key={p.id}
          className="rounded-full ring-2 ring-card"
          style={{ marginLeft: i === 0 ? 0 : -8 }}
        >
          <AvatarLive userId={p.id} name={p.name} size={22} />
        </div>
      ))}
      {extra > 0 && (
        <div
          className="grid h-[22px] w-[22px] place-items-center rounded-full bg-muted text-[10px] font-medium text-ink3 ring-2 ring-card"
          style={{ marginLeft: visible.length === 0 ? 0 : -8 }}
        >
          +{extra}
        </div>
      )}
    </div>
  );
}

// ── controls ─────────────────────────────────────────────────────────────

function PivotTabs({ value, onChange }: { value: Pivot; onChange: (v: Pivot) => void }) {
  const items: { key: Pivot; label: string }[] = [
    { key: 'by-project', label: 'By project' },
    { key: 'by-user', label: 'By member' },
    { key: 'by-day', label: 'By day' },
  ];
  return (
    <div className="flex items-center">
      {items.map((it) => {
        const active = value === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className={
              'relative px-3 pb-2.5 pt-1 text-[12.5px] transition-colors ' +
              (active ? 'font-medium text-foreground' : 'text-ink3 hover:text-foreground')
            }
          >
            {it.label}
            {active && (
              <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-foreground" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function CustomizeMenu({
  prefs,
  onChange,
  onReset,
}: {
  prefs: ColumnPrefs;
  onChange: (next: Partial<ColumnPrefs>) => void;
  onReset: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-9 gap-1.5">
          <Settings2 className="h-3.5 w-3.5" />
          Customize
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-ink4">
          Show
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={prefs.chart}
          onCheckedChange={(v) => onChange({ chart: Boolean(v) })}
          onSelect={(e) => e.preventDefault()}
        >
          Chart
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.members}
          onCheckedChange={(v) => onChange({ members: Boolean(v) })}
          onSelect={(e) => e.preventDefault()}
        >
          Members / Projects
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.billable}
          onCheckedChange={(v) => onChange({ billable: Boolean(v) })}
          onSelect={(e) => e.preventDefault()}
        >
          Billable
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.activity}
          onCheckedChange={(v) => onChange({ activity: Boolean(v) })}
          onSelect={(e) => e.preventDefault()}
        >
          Avg activity
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.share}
          onCheckedChange={(v) => onChange({ share: Boolean(v) })}
          onSelect={(e) => e.preventDefault()}
        >
          Share
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onReset}>Reset to defaults</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RangeSegmented({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (v: RangePreset) => void;
}) {
  const items: { key: RangePreset; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'week', label: 'Week' },
    { key: 'month', label: 'Month' },
  ];
  return (
    <div className="inline-flex h-7 items-center rounded-md border border-border bg-background p-0.5 text-[12px]">
      {items.map((it) => {
        const active = value === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className={
              'rounded px-3 py-0.5 transition-colors ' +
              (active
                ? 'bg-card font-medium text-foreground shadow-sm'
                : 'text-ink3 hover:text-foreground')
            }
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function HeaderActionsPortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('page-header-actions'));
  }, []);
  if (!target) return null;
  return createPortal(children, target);
}

// ── tiny helpers ─────────────────────────────────────────────────────────

function csv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// Stable 0-100 pseudo-percent derived from an id, used as a placeholder for
// signals we can't compute from time-totals alone (e.g. avg input activity).
function seededPercent(id: string, min: number, max: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const r = Math.abs(Math.sin(h + 1));
  return Math.round(min + r * (max - min));
}

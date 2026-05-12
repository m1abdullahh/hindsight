import type { MembershipDto, ProjectDto, TimeEntryDto, UserDto } from '@hindsight/shared/dto';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Download, MoreHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { AvatarLive } from '@/components/ui/avatar-live';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { apiGet } from '@/lib/api';
import { formatHours } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { projectAccent } from '@/lib/project-accent';
import { queryKeys } from '@/lib/queries';
import { useUser } from '@/lib/session-store';

interface MemberRow {
  membership: MembershipDto;
  user: UserDto;
}
interface MembersResponse {
  members: MemberRow[];
}
interface TimeEntriesResponse {
  entries: TimeEntryDto[];
  nextCursor: string | null;
}
interface ProjectsResponse {
  projects: ProjectDto[];
}
interface TimeTotalRow {
  userId: string;
  projectId: string;
  totalActiveSeconds: number;
  hourlyRateCents: number | null;
  earnedCents: number | null;
}
interface TimeTotalsResponse {
  rows: TimeTotalRow[];
}

type RangePreset = 'today' | 'week' | 'month';
type SessionTab = 'all' | 'mine' | 'flagged';

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

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const Route = createFileRoute('/_app/orgs/$orgId/timesheet')({
  component: TimesheetPage,
});

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
function startOfWeek(d: Date): Date {
  const r = startOfDay(d);
  const day = r.getDay();
  const diff = day === 0 ? 6 : day - 1;
  r.setDate(r.getDate() - diff);
  return r;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function isoDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rangeFor(
  preset: RangePreset,
  anchor: Date,
): { from: Date; to: Date; eyebrow: string; sessionsTitle: string } {
  if (preset === 'today') {
    const from = startOfDay(anchor);
    const to = addDays(from, 1);
    return {
      from,
      to,
      eyebrow: `${MONTH_SHORT[from.getMonth()]?.toUpperCase()} ${from.getDate()}, ${from.getFullYear()}`,
      sessionsTitle: 'Today’s sessions',
    };
  }
  if (preset === 'month') {
    const from = startOfMonth(anchor);
    const to = addMonths(from, 1);
    return {
      from,
      to,
      eyebrow: `MONTH OF ${MONTH_SHORT[from.getMonth()]?.toUpperCase()} ${from.getFullYear()}`,
      sessionsTitle: 'Sessions this month',
    };
  }
  const from = startOfWeek(anchor);
  const to = addDays(from, 7);
  const end = addDays(from, 6);
  return {
    from,
    to,
    eyebrow: `WEEK OF ${MONTH_SHORT[from.getMonth()]?.toUpperCase()} ${from.getDate()} – ${MONTH_SHORT[
      end.getMonth()
    ]?.toUpperCase()} ${end.getDate()}`,
    sessionsTitle: 'This week’s sessions',
  };
}

function shiftAnchor(preset: RangePreset, anchor: Date, direction: -1 | 1): Date {
  if (preset === 'today') return addDays(anchor, direction);
  if (preset === 'month') return addMonths(anchor, direction);
  return addDays(anchor, direction * 7);
}

function TimesheetPage() {
  const params = Route.useParams();
  const me = useUser();
  const [range, setRange] = useState<RangePreset>('week');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [tab, setTab] = useState<SessionTab>('all');

  const { from, to, eyebrow, sessionsTitle } = useMemo(
    () => rangeFor(range, anchor),
    [range, anchor],
  );

  const membersQuery = useQuery({
    queryKey: queryKeys.members(params.orgId),
    queryFn: () => apiGet<MembersResponse>(`/orgs/${params.orgId}/members`),
  });

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(params.orgId, true),
    queryFn: () =>
      apiGet<ProjectsResponse>(`/orgs/${params.orgId}/projects`, { includeArchived: true }),
  });

  const entriesQuery = useQuery({
    queryKey: [
      'orgs',
      params.orgId,
      'time-entries',
      { from: from.toISOString(), to: to.toISOString() },
    ],
    queryFn: () =>
      apiGet<TimeEntriesResponse>(`/orgs/${params.orgId}/time-entries`, {
        from: from.toISOString(),
        to: to.toISOString(),
        limit: 100,
      }),
  });

  // Used purely to look up hourly rates per (userId, projectId) so we can show
  // an "Earned" column per session.
  const totalsQuery = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, {
      from: from.toISOString(),
      to: to.toISOString(),
    }),
    queryFn: () =>
      apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {
        from: from.toISOString(),
        to: to.toISOString(),
      }),
  });

  const members = membersQuery.data?.members ?? [];
  const memberById = useMemo(() => new Map(members.map((m) => [m.user.id, m])), [members]);
  const projectById = useMemo(
    () => new Map((projectsQuery.data?.projects ?? []).map((p) => [p.id, p])),
    [projectsQuery.data],
  );
  const rateByPair = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of totalsQuery.data?.rows ?? []) {
      if (r.hourlyRateCents !== null) {
        map.set(`${r.userId}::${r.projectId}`, r.hourlyRateCents);
      }
    }
    return map;
  }, [totalsQuery.data]);

  const entries = entriesQuery.data?.entries ?? [];

  // Build per-day totals stacked by user (top 4 + others) for the chart.
  const dayCount = range === 'today' ? 1 : range === 'month' ? daysInMonth(from) : 7;
  const days = useMemo(() => {
    const arr: { date: Date; key: string; byUser: Map<string, number>; total: number }[] = [];
    for (let i = 0; i < dayCount; i++) {
      const date = addDays(from, i);
      arr.push({ date, key: isoDateKey(date), byUser: new Map(), total: 0 });
    }
    for (const e of entries) {
      const d = new Date(e.startedAt);
      const key = isoDateKey(d);
      const day = arr.find((a) => a.key === key);
      if (!day) continue;
      const sec = e.totalActiveSeconds ?? 0;
      day.byUser.set(e.userId, (day.byUser.get(e.userId) ?? 0) + sec);
      day.total += sec;
    }
    return arr;
  }, [entries, from, dayCount]);

  const totalSec = days.reduce((s, d) => s + d.total, 0);
  const totalEarnedCents = entries.reduce((sum, e) => {
    const rate = rateByPair.get(`${e.userId}::${e.projectId}`);
    if (rate === undefined) return sum;
    return sum + Math.round((e.totalActiveSeconds / 3600) * rate);
  }, 0);
  const anyEarned = rateByPair.size > 0;

  const filteredEntries = useMemo(() => {
    const sorted = [...entries].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    if (tab === 'mine' && me) return sorted.filter((e) => e.userId === me.id);
    if (tab === 'flagged') return sorted.filter((e) => activityPercent(e) < 50);
    return sorted;
  }, [entries, tab, me]);

  const filteredTotalSec = filteredEntries.reduce((s, e) => s + e.totalActiveSeconds, 0);

  const memberColors = [
    'rgba(91,91,214,0.92)',
    'rgba(91,91,214,0.62)',
    'rgba(91,91,214,0.38)',
    'rgba(91,91,214,0.22)',
  ];

  const onExportCsv = () => {
    const headers = ['Member', 'Project', 'Start', 'End', 'Duration', 'Activity %', 'Earned'];
    const lines = [headers.join(',')];
    for (const e of filteredEntries) {
      const m = memberById.get(e.userId);
      const proj = projectById.get(e.projectId);
      const rate = rateByPair.get(`${e.userId}::${e.projectId}`);
      const earned = rate !== undefined ? Math.round((e.totalActiveSeconds / 3600) * rate) : null;
      lines.push(
        [
          csv(m?.user.name ?? ''),
          csv(proj?.name ?? ''),
          csv(new Date(e.startedAt).toLocaleString()),
          csv(e.endedAt ? new Date(e.endedAt).toLocaleString() : 'In progress'),
          csv(formatHours(e.totalActiveSeconds)),
          activityPercent(e).toFixed(0),
          csv(earned !== null ? formatMoney(earned) : '—'),
        ].join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `timesheet-${range}-${isoDateKey(from)}.csv`;
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
            {eyebrow}
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight">Timesheet</h1>
          <p className="mt-1 text-[13px] text-ink3">
            Every tracked session, across all members and projects.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="h-9 gap-1"
            onClick={() => setAnchor((a) => shiftAnchor(range, a, -1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </Button>
          <Button
            variant="outline"
            className="h-9 gap-1"
            onClick={() => setAnchor((a) => shiftAnchor(range, a, 1))}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button className="h-9 gap-1.5" onClick={onExportCsv}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </header>

      {/* Hours by day */}
      <section className="mb-4 rounded-lg border border-border bg-card px-4 py-3.5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[13px] font-medium">Hours by day</h2>
          <span className="font-mono text-[11px] text-ink4">
            {formatHours(totalSec)} total
            {anyEarned ? ` · ${formatMoney(totalEarnedCents)} billable` : ''}
          </span>
        </div>
        <div
          className="grid items-end gap-2.5"
          style={{ gridTemplateColumns: `repeat(${dayCount}, minmax(0, 1fr))` }}
        >
          {days.map((d) => {
            const segments = [...d.byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
            return (
              <div key={d.key} className="flex flex-col items-center gap-1.5">
                <div className="font-mono text-[11px] text-ink3">
                  {d.total > 0 ? `${(d.total / 3600).toFixed(1)}h` : '—'}
                </div>
                <div className="flex h-[100px] w-full flex-col-reverse overflow-hidden rounded bg-muted">
                  {segments.map(([uid, sec], i) => {
                    const height = `${(sec / (12 * 3600)) * 100}%`;
                    return (
                      <div
                        key={uid}
                        title={`${memberById.get(uid)?.user.name ?? uid}: ${formatHours(sec)}`}
                        style={{
                          height,
                          background: memberColors[i] ?? memberColors[memberColors.length - 1],
                          borderTop: i > 0 ? '1px solid hsl(var(--card))' : 'none',
                        }}
                      />
                    );
                  })}
                </div>
                <div className="text-[11.5px] font-medium text-ink2">
                  {dayCount === 1
                    ? 'Today'
                    : dayCount === 7
                      ? (DAY_SHORT[i(d.date)] ?? '')
                      : String(d.date.getDate())}
                </div>
                <div className="font-mono text-[10px] text-ink4">
                  {MONTH_SHORT[d.date.getMonth()]} {d.date.getDate()}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Sessions table */}
      <section className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-medium">{sessionsTitle}</h2>
            <span className="font-mono text-[11px] text-ink4">
              {filteredEntries.length} entries · {formatHours(filteredTotalSec)}
            </span>
          </div>
          <SessionTabs value={tab} onChange={setTab} />
        </div>
        {entriesQuery.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-ink3">
            {tab === 'flagged'
              ? 'No flagged sessions.'
              : tab === 'mine'
                ? 'No sessions of yours in this range.'
                : 'No tracked time in this range.'}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-12 items-center gap-3 border-b border-border px-4 py-2.5 text-[10.5px] uppercase tracking-wide text-ink4">
              <div className="col-span-3">Member</div>
              <div className="col-span-2">Project</div>
              <div className="col-span-1">Start</div>
              <div className="col-span-1">End</div>
              <div className="col-span-1">Duration</div>
              <div className="col-span-2">Activity</div>
              <div className="col-span-1 text-right">Earned</div>
              <div className="col-span-1" />
            </div>
            <ul className="divide-y divide-border">
              {filteredEntries.map((e) => {
                const m = memberById.get(e.userId);
                const proj = projectById.get(e.projectId);
                const rate = rateByPair.get(`${e.userId}::${e.projectId}`);
                const earned =
                  rate !== undefined ? Math.round((e.totalActiveSeconds / 3600) * rate) : null;
                const activity = activityPercent(e);
                return (
                  <li
                    key={e.id}
                    className="grid grid-cols-12 items-center gap-3 px-4 py-3 text-[13px]"
                  >
                    <div className="col-span-3 flex items-center gap-2.5">
                      {m ? (
                        <>
                          <AvatarLive userId={m.user.id} name={m.user.name} size={24} />
                          <span className="font-medium">{m.user.name}</span>
                        </>
                      ) : (
                        <span className="text-ink3">Unknown user</span>
                      )}
                    </div>
                    <div className="col-span-2 flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 rounded-sm"
                        style={{ background: projectAccent(e.projectId) }}
                      />
                      <span className="truncate">{proj?.name ?? '—'}</span>
                    </div>
                    <div className="col-span-1 font-mono text-[12px] text-ink2">
                      {formatTime(e.startedAt)}
                    </div>
                    <div className="col-span-1 font-mono text-[12px] text-ink2">
                      {e.endedAt ? formatTime(e.endedAt) : '—'}
                    </div>
                    <div className="col-span-1 font-mono text-[12.5px] font-medium tabular-nums">
                      {formatHours(e.totalActiveSeconds)}
                    </div>
                    <div className="col-span-2">
                      <ActivityBar percent={activity} />
                    </div>
                    <div className="col-span-1 text-right font-mono text-[12.5px] tabular-nums">
                      {earned !== null ? formatMoney(earned) : '—'}
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <SessionRowMenu />
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function daysInMonth(from: Date): number {
  return new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();
}

// Map a date to its 0-indexed Monday-start weekday.
function i(d: Date): number {
  const dow = d.getDay();
  return dow === 0 ? 6 : dow - 1;
}

function activityPercent(e: TimeEntryDto): number {
  const active = e.totalActiveSeconds ?? 0;
  const idle = e.totalIdleSeconds ?? 0;
  const total = active + idle;
  if (total <= 0) return 0;
  return (active / total) * 100;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function csv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function ActivityBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{ width: `${clamped}%`, background: 'rgba(91,91,214,0.85)' }}
        />
      </div>
      <span className="font-mono text-[11px] tabular-nums text-ink3">{clamped.toFixed(0)}%</span>
    </div>
  );
}

function SessionTabs({
  value,
  onChange,
}: {
  value: SessionTab;
  onChange: (v: SessionTab) => void;
}) {
  const items: { key: SessionTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'mine', label: 'Mine' },
    { key: 'flagged', label: 'Flagged' },
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

function SessionRowMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Session actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem disabled>View details</DropdownMenuItem>
        <DropdownMenuItem disabled>Flag for review</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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

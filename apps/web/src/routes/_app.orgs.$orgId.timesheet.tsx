import type { MembershipDto, TimeEntryDto, UserDto } from '@hindsight/shared/dto';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { AvatarLive } from '@/components/ui/avatar-live';
import { Button } from '@/components/ui/button';
import { Pill } from '@/components/ui/pill';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiGet } from '@/lib/api';
import { formatHours } from '@/lib/format';
import { queryKeys } from '@/lib/queries';

interface MemberRow {
  membership: MembershipDto;
  user: UserDto;
}
interface TimeEntriesResponse {
  entries: TimeEntryDto[];
  nextCursor: string | null;
}

export const Route = createFileRoute('/_app/orgs/$orgId/timesheet')({
  component: TimesheetPage,
});

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  const day = r.getDay();
  // Monday-start week.
  const diff = day === 0 ? 6 : day - 1;
  r.setDate(r.getDate() - diff);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function isoDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function TimesheetPage() {
  const params = Route.useParams();
  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeek(new Date()));
  const weekStart = weekAnchor;
  const weekEnd = addDays(weekStart, 7);

  const membersQuery = useQuery({
    queryKey: queryKeys.members(params.orgId),
    queryFn: () => apiGet<{ members: MemberRow[] }>(`/orgs/${params.orgId}/members`),
  });

  const entriesQuery = useQuery({
    queryKey: [
      'orgs',
      params.orgId,
      'time-entries',
      { from: weekStart.toISOString(), to: weekEnd.toISOString() },
    ],
    queryFn: () =>
      apiGet<TimeEntriesResponse>(`/orgs/${params.orgId}/time-entries`, {
        from: weekStart.toISOString(),
        to: weekEnd.toISOString(),
        limit: 100,
      }),
  });

  const members = membersQuery.data?.members ?? [];
  const memberById = new Map(members.map((m) => [m.user.id, m]));
  const entries = entriesQuery.data?.entries ?? [];

  // Build per-day totals, stacked by member (top-5 then "others").
  const days = useMemo(() => {
    const arr: { date: Date; key: string; byMember: Map<string, number>; total: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      arr.push({ date, key: isoDateKey(date), byMember: new Map(), total: 0 });
    }
    for (const e of entries) {
      const d = new Date(e.startedAt);
      const key = isoDateKey(d);
      const day = arr.find((a) => a.key === key);
      if (!day) continue;
      const sec = e.totalActiveSeconds ?? 0;
      day.byMember.set(e.userId, (day.byMember.get(e.userId) ?? 0) + sec);
      day.total += sec;
    }
    return arr;
  }, [entries, weekStart]);

  const weekTotalSec = days.reduce((s, d) => s + d.total, 0);
  const memberColors = [
    'rgba(91,91,214,0.92)',
    'rgba(91,91,214,0.62)',
    'rgba(91,91,214,0.38)',
    'rgba(91,91,214,0.22)',
  ];

  // 5 most-tracked sessions today/this week, freshest first.
  const sortedEntries = [...entries].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  return (
    <div className="px-7 py-6">
      <header className="mb-5 flex items-end justify-between">
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-ink4">
            Week of {weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} —{' '}
            {addDays(weekEnd, -1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight">Timesheet</h1>
          <p className="mt-1 text-[13px] text-ink3">
            Every tracked session, across all members and projects.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setWeekAnchor(addDays(weekStart, -7))}>
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            Prev
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWeekAnchor(addDays(weekStart, 7))}>
            Next
            <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {/* Week stacked-bar heatmap */}
      <section className="mb-4 rounded-lg border border-border bg-card px-4 py-3.5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[13px] font-medium">Hours by day</h2>
          <span className="font-mono text-[11px] text-ink4">{formatHours(weekTotalSec)} total</span>
        </div>
        <div className="grid grid-cols-7 items-end gap-2.5">
          {days.map((d) => {
            const segments = [...d.byMember.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
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
                  {d.date.toLocaleDateString('en-US', { weekday: 'short' })}
                </div>
                <div className="font-mono text-[10px] text-ink4">
                  {d.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Sessions table */}
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[13px] font-medium">This week&apos;s sessions</h2>
            <span className="font-mono text-[11px] text-ink4">
              {entries.length} entries · {formatHours(weekTotalSec)}
            </span>
          </div>
        </div>
        {entriesQuery.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : sortedEntries.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-ink3">
            No tracked time this week.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedEntries.map((e) => {
                const m = memberById.get(e.userId);
                return (
                  <TableRow key={e.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {m ? (
                          <>
                            <AvatarLive userId={m.user.id} name={m.user.name} size={22} />
                            <span className="text-[12.5px] font-medium">{m.user.name}</span>
                          </>
                        ) : (
                          <span className="text-[12.5px] text-ink3">Unknown user</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-[12px] text-ink2">
                      {new Date(e.startedAt).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}
                    </TableCell>
                    <TableCell className="font-mono text-[12px] text-ink2">
                      {e.endedAt ? (
                        new Date(e.endedAt).toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })
                      ) : (
                        <Pill tone="accent">In progress</Pill>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[12.5px] font-medium">
                      {formatHours(e.totalActiveSeconds)}
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-[12.5px] text-ink3">
                      {e.notes ?? '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

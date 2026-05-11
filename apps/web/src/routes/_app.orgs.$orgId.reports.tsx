import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiGet } from '@/lib/api';
import { formatHours } from '@/lib/format';
import { formatMoney } from '@/lib/money';
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

type RangePreset = 'week' | 'all';
type Pivot = 'by-project' | 'by-user';

export const Route = createFileRoute('/_app/orgs/$orgId/reports')({
  component: OrgReportsPage,
});

function startOfWeekIso(): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  const offset = day === 0 ? 6 : day - 1;
  monday.setDate(now.getDate() - offset);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

function OrgReportsPage() {
  const params = Route.useParams();
  const [range, setRange] = useState<RangePreset>('week');
  const [pivot, setPivot] = useState<Pivot>('by-project');

  const fromIso = range === 'week' ? startOfWeekIso() : undefined;
  const filters = fromIso ? { from: fromIso } : {};

  const query = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, filters),
    queryFn: () => apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, filters),
  });

  const rows = query.data?.rows ?? [];
  const grouped = useMemo(() => groupRows(rows, pivot), [rows, pivot]);

  const totalSeconds = rows.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const totalEarned = rows.reduce((s, r) => s + (r.earnedCents ?? 0), 0);
  const anyEarned = rows.some((r) => r.earnedCents !== null);

  return (
    <div className="px-7 py-6">
      <header className="mb-5">
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-ink4">
          {range === 'week' ? 'This week' : 'All time'}
        </div>
        <h1 className="text-[26px] font-semibold tracking-tight">Reports</h1>
        <p className="mt-1 text-[13px] text-ink3">Tracked time across projects and members.</p>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <RangeTabs value={range} onChange={setRange} />
          <PivotTabs value={pivot} onChange={setPivot} />
        </div>
        <div className="flex gap-4 text-[12px]">
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
      ) : grouped.length === 0 ? (
        <div className="rounded-md border border-dashed py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No tracked time {range === 'week' ? 'this week' : 'yet'}.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((g) => (
            <GroupTable key={g.key} group={g} pivot={pivot} />
          ))}
        </div>
      )}
    </div>
  );
}

interface Group {
  key: string;
  title: string;
  rows: TimeTotalRow[];
  totalSeconds: number;
  totalEarned: number;
  anyEarned: boolean;
}

function groupRows(rows: TimeTotalRow[], pivot: Pivot): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    const key = pivot === 'by-project' ? r.projectId : r.userId;
    const title = pivot === 'by-project' ? r.projectName : r.userName;
    let g = map.get(key);
    if (!g) {
      g = { key, title, rows: [], totalSeconds: 0, totalEarned: 0, anyEarned: false };
      map.set(key, g);
    }
    g.rows.push(r);
    g.totalSeconds += r.totalActiveSeconds;
    if (r.earnedCents !== null) {
      g.totalEarned += r.earnedCents;
      g.anyEarned = true;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title));
}

function GroupTable({ group, pivot }: { group: Group; pivot: Pivot }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-[13px] font-medium">{group.title}</h3>
        <span className="font-mono text-[11px] text-ink4">
          {formatHours(group.totalSeconds)}
          {group.anyEarned ? ` · ${formatMoney(group.totalEarned)}` : ''}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{pivot === 'by-project' ? 'Member' : 'Project'}</TableHead>
            <TableHead className="text-right">Time</TableHead>
            <TableHead className="text-right">Rate</TableHead>
            <TableHead className="text-right">Earned</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.rows
            .slice()
            .sort((a, b) =>
              pivot === 'by-project'
                ? a.userName.localeCompare(b.userName)
                : a.projectName.localeCompare(b.projectName),
            )
            .map((r) => (
              <TableRow key={`${r.userId}-${r.projectId}`}>
                <TableCell>
                  {pivot === 'by-project' ? (
                    <div>
                      <div className="font-medium">{r.userName}</div>
                      <div className="text-xs text-muted-foreground">{r.userEmail}</div>
                    </div>
                  ) : (
                    <div className="font-medium">{r.projectName}</div>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatHours(r.totalActiveSeconds)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatMoney(r.hourlyRateCents)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(r.earnedCents)}
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="font-medium">Subtotal</TableCell>
            <TableCell className="text-right tabular-nums font-medium">
              {formatHours(group.totalSeconds)}
            </TableCell>
            <TableCell />
            <TableCell className="text-right tabular-nums font-medium">
              {group.anyEarned ? formatMoney(group.totalEarned) : '—'}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function RangeTabs({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (v: RangePreset) => void;
}) {
  return (
    <div className="inline-flex rounded-md bg-muted p-0.5 text-[12.5px]">
      <TabButton active={value === 'week'} onClick={() => onChange('week')}>
        This week
      </TabButton>
      <TabButton active={value === 'all'} onClick={() => onChange('all')}>
        All time
      </TabButton>
    </div>
  );
}

function PivotTabs({ value, onChange }: { value: Pivot; onChange: (v: Pivot) => void }) {
  return (
    <div className="inline-flex rounded-md bg-muted p-0.5 text-[12.5px]">
      <TabButton active={value === 'by-project'} onClick={() => onChange('by-project')}>
        By project
      </TabButton>
      <TabButton active={value === 'by-user'} onClick={() => onChange('by-user')}>
        By member
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded px-3 py-1 transition-colors ' +
        (active
          ? 'bg-card font-medium text-foreground shadow-sm'
          : 'text-ink3 hover:text-foreground')
      }
    >
      {children}
    </button>
  );
}

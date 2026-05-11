import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

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

export const Route = createFileRoute('/_app/orgs/$orgId/projects/$projectId/reports')({
  component: ProjectReportsPage,
});

function startOfWeekIso(): string {
  const now = new Date();
  const day = now.getDay(); // Sunday = 0
  const monday = new Date(now);
  const offset = day === 0 ? 6 : day - 1;
  monday.setDate(now.getDate() - offset);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

function ProjectReportsPage() {
  const params = Route.useParams();
  const [range, setRange] = useState<RangePreset>('week');

  const fromIso = range === 'week' ? startOfWeekIso() : undefined;
  const filters = {
    projectId: params.projectId,
    ...(fromIso ? { from: fromIso } : {}),
  };

  const query = useQuery({
    queryKey: queryKeys.timeTotals(params.orgId, filters),
    queryFn: () =>
      apiGet<TimeTotalsResponse>(`/orgs/${params.orgId}/reports/time-totals`, {
        projectId: params.projectId,
        ...(fromIso ? { from: fromIso } : {}),
      }),
  });

  const rows = query.data?.rows ?? [];
  const totalSeconds = rows.reduce((s, r) => s + r.totalActiveSeconds, 0);
  const totalEarned = rows.reduce((s, r) => s + (r.earnedCents ?? 0), 0);
  const anyEarned = rows.some((r) => r.earnedCents !== null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Time totals</h2>
          <p className="text-sm text-muted-foreground">Tracked time per member on this project.</p>
        </div>
        <RangeTabs value={range} onChange={setRange} />
      </div>

      {query.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : query.error ? (
        <div className="rounded-md border border-dashed py-12 text-center text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : 'Could not load report.'}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No tracked time {range === 'week' ? 'this week' : 'yet'}.
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Email</TableHead>
              <TableHead className="text-right">Time</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Earned</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.userId}-${r.projectId}`}>
                <TableCell className="font-medium">{r.userName}</TableCell>
                <TableCell className="text-muted-foreground">{r.userEmail}</TableCell>
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
              <TableCell colSpan={2} className="font-medium">
                Total
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {formatHours(totalSeconds)}
              </TableCell>
              <TableCell />
              <TableCell className="text-right tabular-nums font-medium">
                {anyEarned ? formatMoney(totalEarned) : '—'}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      )}
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
    <div className="inline-flex rounded-md border bg-muted/30 p-0.5 text-xs">
      <RangeButton active={value === 'week'} onClick={() => onChange('week')}>
        This week
      </RangeButton>
      <RangeButton active={value === 'all'} onClick={() => onChange('all')}>
        All time
      </RangeButton>
    </div>
  );
}

function RangeButton({
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
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </button>
  );
}

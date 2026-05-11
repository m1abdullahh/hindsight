import { Skeleton } from '@/components/ui/skeleton';
import { Sparkline } from '@/components/ui/sparkline';

export interface StatCardProps {
  label: string;
  value: string | number | undefined;
  sub?: React.ReactNode;
  spark?: number[];
  loading?: boolean;
  /** Sparkline accent — defaults to indigo, override for warn/danger. */
  accent?: string;
  accentSoft?: string;
}

export function StatCard({
  label,
  value,
  sub,
  spark,
  loading,
  accent = 'hsl(var(--accent))',
  accentSoft = 'hsl(var(--accent-soft))',
}: StatCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="text-[11px] tracking-wide text-ink3">{label}</div>
      <div className="mt-1.5 flex items-end justify-between">
        {loading ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <div className="font-mono text-2xl font-medium tracking-tight tabular-nums">
            {value ?? '—'}
          </div>
        )}
        {spark && spark.length > 0 && <Sparkline data={spark} color={accent} fill={accentSoft} />}
      </div>
      {sub && <div className="mt-1 text-[11.5px] text-ink3">{sub}</div>}
    </div>
  );
}

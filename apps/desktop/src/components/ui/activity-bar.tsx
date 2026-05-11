import { cn } from '@/lib/utils';

export type ActivitySegment = 0 | 1 | 2 | 3 | 'idle' | null;

const ACTIVE_COLORS: Record<0 | 1 | 2 | 3, string> = {
  0: 'hsl(var(--border-strong))',
  1: 'rgba(91,91,214,0.28)',
  2: 'rgba(91,91,214,0.55)',
  3: 'rgba(91,91,214,0.9)',
};

const OFFLINE = 'hsl(var(--border-strong))';
const IDLE = '#fbe5b6';

export function ActivityBar({
  segments,
  height = 22,
  className,
}: {
  segments: ActivitySegment[];
  height?: number;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-0.5 rounded-md bg-muted p-0.5', className)} style={{ height }}>
      {segments.map((seg, i) => {
        const bg = seg === null ? OFFLINE : seg === 'idle' ? IDLE : ACTIVE_COLORS[seg];
        return <span key={i} className="flex-1 rounded-sm" style={{ background: bg }} />;
      })}
    </div>
  );
}

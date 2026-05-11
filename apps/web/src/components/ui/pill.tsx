import { cn } from '@/lib/utils';

export type PillTone = 'neutral' | 'accent' | 'good' | 'warn' | 'danger' | 'dark';

const TONES: Record<PillTone, string> = {
  neutral: 'bg-muted text-ink2 border-transparent',
  accent: 'bg-accent-soft text-accent border-transparent',
  good: 'bg-good/10 text-good border-transparent',
  warn: 'bg-warn/10 text-warn border-transparent',
  danger: 'bg-destructive/10 text-destructive border-transparent',
  dark: 'bg-foreground text-background border-transparent',
};

export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: PillTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

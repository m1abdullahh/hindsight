import { cn } from '@/lib/utils';

// Option A avatar palette: stable per userId so the same user gets the same
// color across views. Mirrors apps/web/src/components/ui/avatar-live.tsx.

const PALETTE: [string, string][] = [
  ['#e2e2f9', '#5b5bd6'],
  ['#fde2d3', '#c2410c'],
  ['#d8f0e1', '#16a34a'],
  ['#fce5f3', '#be185d'],
  ['#e2eef9', '#1d4ed8'],
];

function hashIndex(key: string | undefined | null): number {
  if (!key) return 0;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % PALETTE.length;
}

export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

export interface AvatarLiveProps {
  userId: string;
  name: string;
  size?: number;
  live?: boolean;
  className?: string;
}

export function AvatarLive({ userId, name, size = 28, live, className }: AvatarLiveProps) {
  const pair = PALETTE[hashIndex(userId)] ?? ['#e2e2f9', '#5b5bd6'];
  const bg = pair[0];
  const fg = pair[1];
  const dot = Math.max(8, Math.round(size * 0.3));
  return (
    <div
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <div
        className="grid h-full w-full place-items-center rounded-full font-medium"
        style={{ background: bg, color: fg, fontSize: size * 0.4 }}
      >
        {initialsOf(name)}
      </div>
      {live && (
        <span
          className="absolute -bottom-px -right-px rounded-full bg-good ring-2 ring-card"
          style={{ width: dot, height: dot }}
          aria-label="Live"
        />
      )}
    </div>
  );
}

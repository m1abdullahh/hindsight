import { format, formatDistanceToNow, parseISO } from 'date-fns';

const safeParse = (iso: string): Date | null => {
  try {
    const d = parseISO(iso);
    return Number.isFinite(d.getTime()) ? d : null;
  } catch {
    return null;
  }
};

export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = safeParse(iso);
  return d ? format(d, 'PP p') : '—';
};

export const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = safeParse(iso);
  return d ? format(d, 'PP') : '—';
};

export const formatRelative = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = safeParse(iso);
  return d ? formatDistanceToNow(d, { addSuffix: true }) : '—';
};

export const formatHours = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds));
  // Sub-minute durations: show seconds so the user doesn't see "0m" for real time.
  if (safe < 60) return `${safe}s`;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  if (h === 0) return `${m}m`;
  // Hours present: always show minutes too (including "0m") so the breakdown is unambiguous.
  return `${h}h ${m}m`;
};

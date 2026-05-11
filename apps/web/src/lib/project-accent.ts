// Stable per-project accent color until the Project schema gains a `color`
// field. Hashes the project id into one of six brand-friendly colors so the
// same project shows the same chip everywhere (list, detail, kicker, gallery).

const DEFAULT = '#5b5bd6';
const PALETTE = [DEFAULT, '#16a34a', '#d97706', '#9333ea', '#0891b2', '#be185d'];

export function projectAccent(id: string | undefined | null): string {
  if (!id) return DEFAULT;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length] ?? DEFAULT;
}

export function projectAccentSoft(id: string | undefined | null): string {
  const hex = projectAccent(id).replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}

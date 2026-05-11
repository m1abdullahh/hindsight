// Currency helpers — store as integer cents on the wire, render as decimal
// dollars in the UI. v1 hardcodes USD; per-org currency is a future change.

export const centsToDollars = (cents: number | null): number | null => {
  if (cents === null) return null;
  return Math.round(cents) / 100;
};

/**
 * Convert a user-entered dollar value (number or string) to integer cents.
 * - Empty string → null (clears the rate)
 * - Negative values throw
 * - Fractional cents round to nearest
 */
export const dollarsToCents = (input: number | string): number | null => {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw new Error('Enter a valid amount');
    }
    return dollarsToCents(n);
  }
  if (!Number.isFinite(input)) {
    throw new Error('Enter a valid amount');
  }
  if (input < 0) {
    throw new Error('Rate cannot be negative');
  }
  return Math.round(input * 100);
};

/** Display a cents amount as `$25.99`, or `—` for null. */
export const formatMoney = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined) return '—';
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

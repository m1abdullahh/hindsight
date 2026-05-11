import { describe, expect, it } from 'vitest';

import { centsToDollars, dollarsToCents, formatMoney } from './money';

describe('centsToDollars', () => {
  it('returns null for null', () => {
    expect(centsToDollars(null)).toBeNull();
  });
  it('handles whole dollars', () => {
    expect(centsToDollars(2500)).toBe(25);
  });
  it('handles fractional cents', () => {
    expect(centsToDollars(2599)).toBe(25.99);
  });
  it('handles zero', () => {
    expect(centsToDollars(0)).toBe(0);
  });
});

describe('dollarsToCents', () => {
  it('converts whole dollars', () => {
    expect(dollarsToCents(25)).toBe(2500);
  });
  it('converts decimal dollars', () => {
    expect(dollarsToCents(25.99)).toBe(2599);
  });
  it('rounds fractional cents to nearest', () => {
    expect(dollarsToCents(25.999)).toBe(2600);
  });
  it('throws on negative input', () => {
    expect(() => dollarsToCents(-5)).toThrow('Rate cannot be negative');
  });
  it('parses string input', () => {
    expect(dollarsToCents('25.50')).toBe(2550);
  });
  it('returns null for empty string', () => {
    expect(dollarsToCents('')).toBeNull();
  });
  it('returns null for whitespace-only string', () => {
    expect(dollarsToCents('   ')).toBeNull();
  });
  it('throws on non-numeric string', () => {
    expect(() => dollarsToCents('abc')).toThrow('Enter a valid amount');
  });
});

describe('formatMoney', () => {
  it('formats cents as USD', () => {
    expect(formatMoney(2599)).toBe('$25.99');
  });
  it('handles zero', () => {
    expect(formatMoney(0)).toBe('$0.00');
  });
  it('returns dash for null', () => {
    expect(formatMoney(null)).toBe('—');
  });
  it('returns dash for undefined', () => {
    expect(formatMoney(undefined)).toBe('—');
  });
});

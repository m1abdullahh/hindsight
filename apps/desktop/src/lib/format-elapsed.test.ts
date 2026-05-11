import { describe, expect, it } from 'vitest';

import { formatElapsed } from './format-elapsed';

describe('formatElapsed', () => {
  it('formats 0 seconds', () => {
    expect(formatElapsed(0)).toBe('00:00:00');
  });
  it('formats minutes', () => {
    expect(formatElapsed(75)).toBe('00:01:15');
  });
  it('formats hours', () => {
    expect(formatElapsed(3725)).toBe('01:02:05');
  });
  it('handles many hours', () => {
    expect(formatElapsed(36000)).toBe('10:00:00');
  });
  it('clamps negatives to 0', () => {
    expect(formatElapsed(-5)).toBe('00:00:00');
  });
  it('truncates fractional seconds', () => {
    expect(formatElapsed(60.7)).toBe('00:01:00');
  });
});

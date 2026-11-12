import { describe, expect, it } from 'vitest';
import {
  addBillingInterval,
  addCalendarDays,
  daysBetween,
  generateDueDates,
  getCardExpiryDate,
  getNextBillingDate,
  getTodayInTimeZone,
  isValidIsoDate,
  parseIsoDate,
} from '@domain/dates';

describe('dates domain logic', () => {
  it('validates strict calendar dates', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(() => parseIsoDate('2026-02-29')).toThrow();
  });

  it('handles month-end clamping on days 29-31 anchored to billingAnchorDate', () => {
    const anchor = '2026-01-31';
    expect(addBillingInterval(anchor, 'month', 1, 0)).toBe('2026-01-31');
    expect(addBillingInterval(anchor, 'month', 1, 1)).toBe('2026-02-28');
    expect(addBillingInterval(anchor, 'month', 1, 2)).toBe('2026-03-31');
    expect(addBillingInterval(anchor, 'month', 1, 3)).toBe('2026-04-30');
    expect(addBillingInterval(anchor, 'month', 1, 4)).toBe('2026-05-31');
  });

  it('handles leap years for Feb 29 anchors and month-end anchors', () => {
    // Leap year 2024: Jan 31 -> Feb 29 -> Mar 31
    expect(addBillingInterval('2024-01-31', 'month', 1, 1)).toBe('2024-02-29');
    expect(addBillingInterval('2024-01-31', 'month', 1, 2)).toBe('2024-03-31');

    // Yearly anchor on Feb 29 clamps to Feb 28 in non-leap years and returns to Feb 29 in 2028
    expect(addBillingInterval('2024-02-29', 'year', 1, 1)).toBe('2025-02-28');
    expect(addBillingInterval('2024-02-29', 'year', 1, 4)).toBe('2028-02-29');
  });

  it('supports every-N weekly, monthly, and yearly cycles', () => {
    expect(generateDueDates('2026-01-05', 'week', 2, '2026-02-10')).toEqual([
      '2026-01-05',
      '2026-01-19',
      '2026-02-02',
    ]);

    expect(generateDueDates('2026-01-31', 'month', 3, '2026-11-01')).toEqual([
      '2026-01-31',
      '2026-04-30',
      '2026-07-31',
      '2026-10-31',
    ]);

    expect(generateDueDates('2022-03-15', 'year', 2, '2026-04-01')).toEqual([
      '2022-03-15',
      '2024-03-15',
      '2026-03-15',
    ]);
  });

  it('computes next billing date inclusive or exclusive of fromDate', () => {
    expect(getNextBillingDate('2026-01-10', 'month', 1, '2026-03-10', true)).toBe(
      '2026-03-10',
    );
    expect(getNextBillingDate('2026-01-10', 'month', 1, '2026-03-10', false)).toBe(
      '2026-04-10',
    );
  });

  it('calculates card expiry as last day of expiry month', () => {
    expect(getCardExpiryDate(2, 2024)).toBe('2024-02-29');
    expect(getCardExpiryDate(2, 26)).toBe('2026-02-28');
    expect(getCardExpiryDate(12, 2028)).toBe('2028-12-31');
  });

  it('resolves today in Europe/Warsaw accurately around UTC midnight', () => {
    // 22:30 UTC in summer (CEST = UTC+2) is already 00:30 next day in Warsaw.
    const instant = new Date('2026-06-15T22:30:00.000Z');
    expect(getTodayInTimeZone('Europe/Warsaw', instant)).toBe('2026-06-16');
    expect(getTodayInTimeZone('UTC', instant)).toBe('2026-06-15');
  });

  it('adds and diffs calendar days cleanly across DST boundaries', () => {
    expect(addCalendarDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });
});

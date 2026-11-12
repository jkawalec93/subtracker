import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  differenceInCalendarDays,
  format,
  isValid,
  lastDayOfMonth,
  parse,
} from 'date-fns';
import type { IntervalUnit, IsoDate } from './types';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a strict YYYY-MM-DD string into a local Date (noon to avoid any DST edge cases).
 */
export function parseIsoDate(value: IsoDate): Date {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new Error(`Invalid ISO date format: "${value}". Expected YYYY-MM-DD.`);
  }
  const parsed = parse(value, 'yyyy-MM-dd', new Date(2000, 0, 1, 12, 0, 0, 0));
  if (!isValid(parsed) || format(parsed, 'yyyy-MM-dd') !== value) {
    throw new Error(`Invalid calendar date: "${value}".`);
  }
  parsed.setHours(12, 0, 0, 0);
  return parsed;
}

/** Formats a Date instance to YYYY-MM-DD. */
export function formatIsoDate(date: Date): IsoDate {
  return format(date, 'yyyy-MM-dd');
}

/** Checks whether a string is a valid calendar date in YYYY-MM-DD format. */
export function isValidIsoDate(value: string): value is IsoDate {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = parse(value, 'yyyy-MM-dd', new Date(2000, 0, 1, 12, 0, 0, 0));
  return isValid(parsed) && format(parsed, 'yyyy-MM-dd') === value;
}

/**
 * Returns today's calendar date in the given IANA timezone (defaults to Europe/Warsaw).
 */
export function getTodayInTimeZone(
  timeZone = 'Europe/Warsaw',
  now: Date = new Date(),
): IsoDate {
  // en-CA formats reliably as YYYY-MM-DD across modern JS engines.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return formatted;
}

/** Returns signed calendar days difference: targetDate - baseDate. */
export function daysBetween(baseDate: IsoDate, targetDate: IsoDate): number {
  return differenceInCalendarDays(parseIsoDate(targetDate), parseIsoDate(baseDate));
}

/** Adds signed days to a YYYY-MM-DD date. */
export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  return formatIsoDate(addDays(parseIsoDate(date), days));
}

/**
 * Computes the N-th billing date from the billing anchor date.
 * Always steps from the anchor (never iteratively from the previous date) so
 * month-end clamping (e.g. Jan 31 -> Feb 28 -> Mar 31) stays exact.
 */
export function addBillingInterval(
  anchorDate: IsoDate,
  unit: IntervalUnit,
  intervalCount: number,
  stepIndex: number,
): IsoDate {
  if (!Number.isInteger(intervalCount) || intervalCount < 1) {
    throw new Error(`intervalCount must be a positive integer, got ${intervalCount}.`);
  }
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new Error(`stepIndex must be a non-negative integer, got ${stepIndex}.`);
  }
  if (stepIndex === 0) {
    return formatIsoDate(parseIsoDate(anchorDate));
  }

  const anchor = parseIsoDate(anchorDate);
  const delta = intervalCount * stepIndex;

  switch (unit) {
    case 'week':
      return formatIsoDate(addWeeks(anchor, delta));
    case 'month':
      return formatIsoDate(addMonths(anchor, delta));
    case 'year':
      return formatIsoDate(addYears(anchor, delta));
  }
}

/**
 * Generates all billing dates starting from anchorDate up to upToDate (inclusive).
 */
export function generateDueDates(
  anchorDate: IsoDate,
  unit: IntervalUnit,
  intervalCount: number,
  upToDate: IsoDate,
): IsoDate[] {
  const results: IsoDate[] = [];
  for (let step = 0; ; step++) {
    const candidate = addBillingInterval(anchorDate, unit, intervalCount, step);
    if (candidate > upToDate) {
      break;
    }
    results.push(candidate);
  }
  return results;
}

/**
 * Finds the next billing date on or after `fromDate` (or strictly after if `inclusive` is false).
 */
export function getNextBillingDate(
  anchorDate: IsoDate,
  unit: IntervalUnit,
  intervalCount: number,
  fromDate: IsoDate,
  inclusive = true,
): IsoDate {
  for (let step = 0; ; step++) {
    const candidate = addBillingInterval(anchorDate, unit, intervalCount, step);
    if (inclusive ? candidate >= fromDate : candidate > fromDate) {
      return candidate;
    }
  }
}

/**
 * Normalizes a 2-digit or 4-digit expiry year and returns the last calendar day of MM/YYYY.
 * Per spec, a card MM/RR is valid through the last day of month MM inclusive.
 */
export function getCardExpiryDate(expiryMonth: number, expiryYear: number): IsoDate {
  if (!Number.isInteger(expiryMonth) || expiryMonth < 1 || expiryMonth > 12) {
    throw new Error(`Invalid card expiry month: ${expiryMonth}.`);
  }
  if (!Number.isInteger(expiryYear) || expiryYear < 0) {
    throw new Error(`Invalid card expiry year: ${expiryYear}.`);
  }
  const fullYear = expiryYear < 100 ? 2000 + expiryYear : expiryYear;
  const firstOfMonth = new Date(fullYear, expiryMonth - 1, 1, 12, 0, 0, 0);
  return formatIsoDate(lastDayOfMonth(firstOfMonth));
}

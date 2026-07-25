/**
 * Shared deterministic calendar-date helpers for the DueLogic policy engine
 * and plan-schedule resolver.
 *
 * Pure functions over YYYY-MM-DD strings using UTC millisecond maths only:
 * no clock reads, no locale parsing, no local Date getters, no environment
 * access and no mutation, so the server timezone can never influence a
 * result. Invalid input returns null — callers decide how to surface it.
 */

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Strictly parses a real YYYY-MM-DD calendar date, else null. */
export function parseCalendarDate(value: string): CalendarDate | null {
  if (typeof value !== "string" || !DATE_ONLY_PATTERN.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

function utcMs(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

export function formatCalendarDate(date: CalendarDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/**
 * Whole calendar days from `from` to `to` (negative when `to` is earlier),
 * or null when either date is invalid.
 */
export function calendarDaysBetween(from: string, to: string): number | null {
  const a = parseCalendarDate(from);
  const b = parseCalendarDate(to);
  if (a === null || b === null) {
    return null;
  }
  return Math.round((utcMs(b) - utcMs(a)) / MS_PER_DAY);
}

/** The date plus whole calendar days, or null when the date is invalid. */
export function addCalendarDays(value: string, days: number): string | null {
  const date = parseCalendarDate(value);
  if (date === null) {
    return null;
  }
  const shifted = new Date(utcMs(date) + days * MS_PER_DAY);
  return formatCalendarDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/**
 * The same day of month `months` calendar months later, or null when the
 * date is invalid. No clamping: callers must only pass days that exist in
 * every month (1-28) — never 30-day or average-month arithmetic.
 */
export function addCalendarMonthsSameDay(
  value: string,
  months: number,
): string | null {
  const date = parseCalendarDate(value);
  if (date === null) {
    return null;
  }
  const zeroBasedMonth = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(zeroBasedMonth / 12);
  const month = ((zeroBasedMonth % 12) + 12) % 12 + 1;
  return formatCalendarDate({ year, month, day: date.day });
}

/** Same calendar day `months` earlier, clamped to the target month length. */
export function monthsEarlier(date: CalendarDate, months: number): CalendarDate {
  const zeroBasedMonth = date.year * 12 + (date.month - 1) - months;
  const year = Math.floor(zeroBasedMonth / 12);
  const month = ((zeroBasedMonth % 12) + 12) % 12 + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

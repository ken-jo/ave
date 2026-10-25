/** Use host-local calendar getters for instants; use UTC only for arithmetic on existing civil-date keys to avoid DST shifts. */

/** Pad years to four digits so lexical range comparisons remain valid. */
export function localDateKey(date: Date): string {
  return `${padYear(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function padYear(year: number): string {
  return String(year).padStart(4, "0");
}

/** Pass malformed keys through; seed with a leap year and then stamp the real year to avoid the 0–99 year offset. */
export function shiftLocalDateKey(key: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return key;
  const shifted = new Date(Date.UTC(LEAP_SEED_YEAR, Number(match[2]) - 1, Number(match[3])));
  shifted.setUTCFullYear(Number(match[1]));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return utcDateKey(shifted);
}

/** Placeholder year for seeding a civil date: in range for `Date.UTC`, and a leap year. */
const LEAP_SEED_YEAR = 2000;

/** Usage weeks begin Monday; Work Board report weeks begin Sunday. */
export function localMondayWeekStartKey(date: Date): string {
  const day = date.getDay();
  const monday = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - (day === 0 ? 6 : day - 1),
  );
  return localDateKey(monday);
}

/** Return null for malformed civil dates; panel due dates and report boundaries share this conversion. */
export function localDayStart(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Date constructors offset years below 100 into the 1900s; setFullYear preserves the requested year.
  start.setFullYear(Number(match[1]));
  return start;
}

export function localMonthStartKey(date: Date): string {
  return `${padYear(date.getFullYear())}-${pad(date.getMonth() + 1)}-01`;
}

/** Length of a `YYYY-MM-DD` key; the prefix every UTC-partitioned file name starts with. */
export const UTC_DATE_KEY_LENGTH = 10;

/** UTC partitions stay stable across zone changes; user-facing dates use localDateKey. */
export function utcDateKey(instant: Date = new Date()): string {
  return instant.toISOString().slice(0, UTC_DATE_KEY_LENGTH);
}

/** Inclusive picked days become a half-open instant range ending at the next local day, including DST-shortened days. */
export function localDayRange(
  fromKey?: string,
  toKey?: string,
): { start?: Date; end?: Date } | null {
  const start = fromKey === undefined ? undefined : localDayStart(fromKey);
  const end = toKey === undefined ? undefined : localDayStart(shiftLocalDateKey(toKey, 1));
  if (start === null || end === null) return null;
  return { start, end };
}

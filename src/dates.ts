/**
 * Dates, in the one form braintrust uses them.
 *
 * `braintrust_items.published_at` and `braintrust_sources.backfill_floor` are both
 * `date`, not `timestamptz`: a publish date is a fact about a piece of writing, not
 * an instant, and Positions are dated to the day. Everything here works in UTC so
 * the operator's timezone cannot move a backfill floor.
 */

/** `YYYY-MM-DD`, which is what a Postgres `date` column wants. */
export function toDateOnly(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/**
 * UTC midnight `months` before `now`. Month arithmetic clamps rather than rolling
 * over: 12 months before 31 March is 31 March, but 1 month before 31 March is
 * 28 February, not 3 March.
 */
export function monthsBefore(now: Date, months: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  const day = now.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDayOfTarget)));
}

export const MS_PER_DAY = 86_400_000;

/** Whole and fractional days from `from` to `to`. Negative if `to` is earlier. */
export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

/** Parses a feed's date, or returns undefined — an undated entry is a normal case. */
export function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

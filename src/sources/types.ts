/**
 * What a Source is before it is a row.
 *
 * Registration has to describe a Source — and price it — before anything is
 * written, so these types carry the same facts as `braintrust_sources` minus the
 * identity the database assigns. See docs/design/schema.md, tier 1.
 */

export type Platform = 'substack' | 'youtube';

export const PLATFORMS: Platform[] = ['substack', 'youtube'];

/**
 * A pasted link, normalised. `resolvedFrom` is the link exactly as the human gave
 * it, and it stays attached all the way into the Plan: it is what makes a wrong
 * resolution visible in the approval surface, which is the one failure mode
 * pasting links introduces over a strict handle notation.
 * See docs/design/ingestion.md §2.
 */
export type ResolvedSource = {
  platform: Platform;
  /** Publication host, or `UC…` channel id — matching `braintrust_sources.handle`. */
  handle: string;
  /** The RSS/Atom feed. Discovery is generic across platforms; this is why. */
  discoveryUrl: string;
  resolvedFrom: string;
};

/** The three settings a human may override per Source. There is no fourth. */
export type SourceSettings = {
  windowMonths: number;
  excludeShorts: boolean;
  pollIntervalHours: number;
};

/**
 * `excludeShorts` and `pollIntervalHours` mirror `braintrust_sources`, and the DDL is
 * the source of truth for those two — "what braintrust does if you say nothing" is
 * readable in one place, and that place is schema.sql.
 * `test/follow.integration.test.ts` asserts they agree against a real database, so
 * this copy cannot drift silently.
 *
 * `windowMonths` is the exception, and honestly so: `backfill_floor` is a `date` with
 * no DDL default, because "twelve months ago" is not a value a column can hold. It is
 * computed at registration, which is the only place that writes it.
 */
export const DEFAULT_SETTINGS: SourceSettings = {
  windowMonths: 12,
  excludeShorts: true,
  pollIntervalHours: 24,
};

/** How a number in a Plan was arrived at — the same two words a Persona's layers use. */
export type Basis = 'measured' | 'estimated';

/**
 * The vocabularies `braintrust_items` enforces. Both are checked by the DDL, so a
 * value that is not in these unions is a constraint violation rather than a bad row.
 */
export type Audience = 'everyone' | 'paid' | 'unknown';
export type Retrieval = 'pending' | 'retrieved' | 'skipped_paywall' | 'failed';

/**
 * **The paywall line, as an allow-list.** Anything that is not exactly `everyone` is
 * paid. Live Substack values include `only_paid` and `founding`, and a deny-list built
 * from the ones known today would silently ingest whatever tier Substack invents next.
 *
 * The DDL only accepts `everyone`, `paid` and `unknown`, so this mapping is not a
 * convenience — an un-mapped `only_paid` is rejected by the database.
 */
export function audienceOf(raw: string | null | undefined): Audience {
  if (raw === undefined || raw === null || raw.trim() === '') return 'unknown';
  return raw === 'everyone' ? 'everyone' : 'paid';
}

/**
 * The 4s spacing between fetches. Measured on YouTube captions — 4 of 4 succeeded at
 * this spacing where per-video metadata failed every time — and it is the difference
 * between reading a feed and hammering a service. Substack keeps it too: the same
 * politeness costs a minute across a year of free posts.
 * See docs/research/source-terms-and-consent.md §7.
 */
export const RETRIEVAL_SPACING_SECONDS = 4;
export const RETRIEVAL_SPACING_MS = RETRIEVAL_SPACING_SECONDS * 1000;

/**
 * What a cheap look at a Source says it will cost. Produced by reading feeds and
 * catalogues only: no body, no caption, no Item row.
 */
export type SourceSurvey = {
  /** The feed's own title. Shown so a human can see braintrust landed on the right one. */
  feedTitle?: string | undefined;
  /** The feed's author, where it carries one. Raw material for the proposed name. */
  feedAuthor?: string | undefined;
  itemsInWindow: number;
  basis: Basis;
  /** How an estimate was reached. Required in practice whenever `basis` is `estimated`. */
  how?: string | undefined;
  /** Substack only: known from the archive metadata, before anything is fetched. */
  willSkipPaywalled?: number | undefined;
  /** Bodies or captions braintrust will retrieve — the expensive half. */
  bodyFetches: number;
  /**
   * Items whose publish date the feed does not carry, each costing an extra
   * ~1.3MB watch-page fetch. See docs/design/ingestion.md §1.
   */
  dateFetches: number;
};

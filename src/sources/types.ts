/**
 * What a Source is before it is a row.
 *
 * Registration has to describe a Source — and price it — before anything is
 * written, so these types carry the same facts as `braintrust_sources` minus the
 * identity the database assigns. See docs/design/schema.md, tier 1.
 */

/**
 * **`blog` is not a platform, and that is the point of the name.** There is no blog
 * API, no blog identity scheme and no blog operator — it is whatever a person publishes
 * on their own hosting, read through the two things the web already standardised: a
 * declared feed and a sitemap. braintrust does not branch on Ghost or on Bear Blog, so
 * one value covers all of them.
 * See docs/design/ingestion.md §8.
 */
export type Platform = 'substack' | 'youtube' | 'blog';

export const PLATFORMS: Platform[] = ['substack', 'youtube', 'blog'];

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
  /**
   * The RSS/Atom feed. Discovery is generic across platforms; this is why.
   *
   * **One column, and it stays a feed.** A blog that publishes none puts its sitemap
   * here instead — not as a second mechanism beside the feed, but as the same one: every
   * URL carries `<lastmod>`, the document is ordered newest-first by it, and a walk that
   * stops at the first unchanged URL is what reading a feed already does. The document
   * says which of the two it is, so nothing has to remember.
   */
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

/**
 * **`failed` means the source declined or could not answer. Everything braintrust
 * *decided* is `skipped_<reason>`** — a row of its own, carrying what would have to
 * change, reopened when it changes.
 *
 * That line is why there are four skips rather than one catch-all: each names a
 * different thing an operator could do about it, and each is undone by doing it.
 *
 * `skipped_not_a_post` is the one whose undoing nobody has to perform. A sitemap
 * enumerates URLs rather than posts, so an about page or a tag index is fetched, found to
 * carry no publish date, and recorded — and the sitemap's own `<lastmod>` moving is what
 * brings it back. A stub filled in next month becomes a post next month, at the cost of
 * one fetch, with no polling loop and no re-examination interval anybody had to choose.
 */
export type Retrieval =
  | 'pending'
  | 'retrieved'
  | 'skipped_paywall'
  | 'skipped_short'
  | 'skipped_window'
  | 'skipped_not_a_post'
  | 'failed';

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
 * Every kind of Source braintrust prices, including the two it does not yet read. The
 * spacing table has to be complete before the source tickets land, because each of them
 * prices its backfill against it — and a rate invented per source ticket is a rate nobody
 * compared to the others.
 */
export type SpacedSource = Platform | 'bluesky';

/**
 * **Seconds between one request and the next, per Source.**
 *
 * The unit is a *request braintrust issues*, not an Item. The two were the same number
 * for a reason that no longer holds: one YouTube Item is one request braintrust makes —
 * yt-dlp expands it into the date, the caption list and the track, and the spacing that
 * tested clean was measured around exactly that group — so spacing the Items *was* how
 * you priced the traffic. Nothing added since works that way. One Bluesky call returns
 * 100 posts and a blog feed carries every body, so an Item can cost a fraction of a
 * request, or a request can carry a hundred Items.
 *
 * Read per Item, the rule made the cheapest Source braintrust has the slowest one it
 * reads: a 12-month Bluesky backfill would take 102 minutes instead of ~16 seconds, and
 * buy no politeness at all, because the requests are identical either way and only the
 * waiting changes.
 *
 * **Substack and YouTube keep the traffic they have today.** 4s was measured on YouTube
 * captions — 4 of 4 succeeded at this spacing where per-video metadata failed every time
 * — and this is a re-expression of that measurement, not a loosening of it.
 *
 * **Bluesky at 1s** because the public AppView is open by design, is served from a CDN,
 * answered in 548ms and returns no rate-limit headers to respect. Deliberately not zero:
 * absence of a stated limit is not permission.
 *
 * **A blog page keeps 4s** for the opposite reason. It is the one place a braintrust
 * fetch lands on somebody's own hosting rather than on a platform, and erring slow costs
 * braintrust nothing that matters.
 *
 * See docs/design/ingestion.md §6 and docs/research/source-terms-and-consent.md §7.
 */
export const REQUEST_SPACING_SECONDS: Record<SpacedSource, number> = {
  substack: 4,
  youtube: 4,
  bluesky: 1,
  blog: 4,
};

export function requestSpacingMs(source: SpacedSource): number {
  return REQUEST_SPACING_SECONDS[source] * 1000;
}

/**
 * Paging a feed, an archive or a sitemap. One poll is one logical read that happens to
 * arrive in pages, and none of the pages is expensive — so the courtesy owed is between
 * pages of the same read rather than between reads.
 */
export const PAGE_SPACING_MS = 250;

/**
 * Five minutes. Below it a video is a Short or an advert for a longer one — measured
 * yields were 71, 203 and 313 words of promotional copy, against ~4,100 for a
 * long-form video. They add noise to a Persona and nothing to it.
 *
 * `braintrust_sources.exclude_shorts` decides whether the rule applies; this is where
 * the line is. Excluded Items are written as `skipped_short` rather than left out, so
 * turning the setting off brings them in instead of requiring a second crawl.
 */
export const SHORT_MAX_SECONDS = 300;

/**
 * The same line, drawn for text, because a blog has no duration to draw it by.
 *
 * **It exists to stop a Persona being built out of nav menus, and it works by measuring
 * rather than judging.** The extractor strips a page's chrome by cross-page repetition
 * and never decides what chrome *is*; what survives is either prose or it is short, and
 * this is the number that says which.
 *
 * The measurements bound it from both sides. The shortest thing that is unambiguously a
 * real post is **59 words** — a genuine Ghost article, alongside others at 88, 93, 111,
 * 125, 162 and 207 — and the longest thing that is unambiguously not one is the **30
 * words** the Bear Blog homepage yields. Forty sits between them. It is not a number
 * anybody measured directly, and like `BLOCK_AFTER_FAILURES` it is left to tuning against
 * real behaviour; what the measurements fix is the span it has to fall in.
 *
 * Governed by `exclude_shorts`, exactly as the video line is, so an operator who wants
 * the brief ones gets them back through `reopenShorts` and nothing loops.
 * See docs/design/ingestion.md §8.
 */
export const SHORT_MAX_WORDS = 40;

/**
 * **Whether a Source can be asked about a paywall before its body is fetched.**
 *
 * The allow-list — anything not exactly `everyone` is never fetched — is a *pre-fetch*
 * filter, and a pre-fetch filter needs something to ask. Substack answers in its
 * catalogue and YouTube has no paywall at all, so for both of them an Item still
 * `unknown` at retrieval time is an Item braintrust must not request.
 *
 * A blog has no catalogue that could ever answer. The gating markers are in the page, so
 * treating `unknown` as a refusal would mean refusing to read any blog at all. The line
 * is not moved, it is enforced one step later — after the fetch and before the row —
 * which is the whole cost of a blog having no `audience` field.
 * See docs/design/ingestion.md §8.
 */
export function audienceKnownBeforeFetch(platform: Platform): boolean {
  return platform !== 'blog';
}

/**
 * How many consecutive retrieval failures, across *distinct* Items of one Source, mean
 * the Source has stopped serving braintrust.
 *
 * **A block is measured, never judged from a response code.** A 403 can be a CDN
 * hiccup, a 429 is politeness (and is handled before this counter ever sees it), and a
 * captcha interstitial arrives as a 200 with HTML in it. braintrust classifies none of
 * that: it counts the only thing that matters, which is that request after request
 * against different Items came back with nothing usable.
 *
 * Distinct Items is the whole protection. One Item that fails five times proves the
 * Item is broken; five different Items failing in a row is the Source. And the count is
 * per run and in memory — a Source whose Backlog is smaller than this never reaches it,
 * which is correct, because a `failed` Item is terminal and a small Backlog exhausts
 * itself rather than looping.
 *
 * Five is a constant, deliberately left to tuning against real behaviour. It is the
 * number the spec declines to fix, and nothing else in braintrust depends on its value.
 * See docs/design/ingestion.md §5.
 */
export const BLOCK_AFTER_FAILURES = 5;

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
   * True where discovery itself carries the bodies, so `bodyFetches` is 0 because the
   * expensive half is already done rather than because there is nothing to do. A Plan
   * has to tell those two apart: *"nothing to retrieve"* and *"10 post bodies arriving
   * with the feed"* are different offers, and the second is the whole reason a
   * feed-bearing blog costs one request.
   */
  bodiesFromDiscovery?: boolean | undefined;
  /**
   * Items whose publish date the feed does not carry, each costing an extra
   * ~1.3MB watch-page fetch. See docs/design/ingestion.md §1.
   */
  dateFetches: number;
};

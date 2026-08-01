/**
 * A blog's archive: the sitemap enumerates, and the page dates itself.
 *
 * **The sitemap says which URLs exist. It never says which of them are posts, and it
 * never says when they were published.** Those are two different refusals and this module
 * is built out of both.
 *
 * *Which are posts* has no answer in a URL. Bear Blog's sitemap carries the homepage;
 * Ghost's posts-only sitemap does not; nothing in the shape of either address separates
 * them. So braintrust fetches the URL and lets the content decide — **a candidate is a
 * post only if it yields a publish date and a real body** — and pays one wasted fetch per
 * about page, once. *Rejected: learning the URL pattern from the feed*, which is cheaper
 * and genuinely clever and fails precisely on the blog with no feed, which is the only
 * blog that needs a sitemap walk at all.
 *
 * *When they were published* is the more dangerous one, because `<lastmod>` looks like an
 * answer. It is a **modification** date: on the reference site a post published
 * `2026-05-27` carries a `<lastmod>` of `2026-06-05`, and on the control site all 7,651
 * posts carry one inside the same fortnight because a migration re-saved the archive.
 * Reading it as a publish date would not merely blur dates — `held_since` is derived from
 * Item dates and revision detection refuses to judge a pair it cannot place in time, so
 * wrong dates do not produce missing revisions, they produce revisions pointing backwards.
 * A Persona appearing to change its mind in reverse. The date therefore comes from the
 * page's own metadata, on the fetch braintrust was making anyway.
 *
 * `<lastmod>` keeps exactly one job, which is the one thing it honestly measures: **this
 * URL changed.** That is what reopens a `skipped_not_a_post` row, and it is why a stub
 * that becomes an essay next month becomes a post next month with no polling loop and no
 * re-examination interval anybody had to invent.
 *
 * The words themselves are `./blog-body.js`, which is where the measurements that shaped
 * the extraction are recorded. This module is where the two meet: a candidate is judged
 * here, and the cheap answer — a feed that already carries the whole post — is reached
 * before a request is spent.
 *
 * See docs/design/ingestion.md §8.
 */

import { parseDate } from '../dates.js';
import type { Db } from '../db.js';
import type { Fetcher } from '../net/fetch.js';
import { blocks, decodeEntities, firstTag } from '../net/xml.js';
import {
  agreement,
  blogBodyText,
  countWords,
  densestContainer,
  gatedBy,
  gatedByFeed,
  repeatedLines,
  type FeedBody,
  type GateMarker,
} from './blog-body.js';
import { documentKind, resolveSitemap, SITEMAP_PATHS } from '../sources/blog.js';
import { PAGE_SPACING_MS, SHORT_MAX_WORDS } from '../sources/types.js';
import { reopenChangedNotPosts, type ArchiveItem, type SourceRow } from './items.js';
import { fetchPolitely, type Pause } from './pace.js';

export type BlogIngestDeps = {
  fetcher: Fetcher;
  pause?: Pause | undefined;
  /**
   * The document the poll has already read from `discovery_url`, where the caller has
   * one. A feedless blog's sitemap is the single most expensive document braintrust
   * fetches — 892KB on the large site measured, growing as the blog ages — so reading it
   * twice in one run would double the daily cost of the source this whole module exists
   * to make affordable.
   */
  polled?: string | undefined;
};

export type BlogWalkOutcome = {
  /** Candidate URLs handed to `onRecord`, including ones braintrust already knew. */
  seen: number;
  /**
   * True only when a sitemap was found and read to the end, because then braintrust has
   * seen the whole archive. A blog with no sitemap never sets it and never claims
   * `backfill_complete` — it knows it is behind and the Persona says so.
   */
  reachedFloor: boolean;
  /** Requests this walk spent, sitemap probes included. */
  pages: number;
  /** The sitemap actually walked, for the log. Absent when there was none. */
  sitemap?: string;
  /** Rows braintrust had decided were not posts, whose `<lastmod>` has since moved. */
  reopened: number;
  /**
   * The `<lastmod>` this walk saw, by URL. Empty when there was no sitemap.
   *
   * **The retrieval pass needs *this* walk's value rather than the one on the row.** A
   * `skipped_not_a_post` decision is made against the page as it is now, so it has to be
   * recorded against the `<lastmod>` the sitemap is serving now — record an older one and
   * the next walk sees a change that has already been accounted for, refetches, decides
   * the same thing, and does it again every day.
   */
  lastmods: Map<string, Date>;
};

/**
 * Enumerates the archive: find the sitemap, then hand over every URL in it as a candidate.
 *
 * **Every URL is a candidate and none is a post yet.** The walk does no filtering at all —
 * not by URL shape, not by `<lastmod>`, not by the window — because it has no evidence to
 * filter on. It costs one fetch per URL braintrust has never seen, which is the number the
 * Plan quoted as *at most N*, and `unique (source_id, external_id)` means a URL already
 * held is a statement that writes nothing.
 *
 * **A blog followed through its feed still looks for a sitemap, on every run.** That is
 * `backfill_complete` staying false doing its ordinary job — the same flag, the same
 * repair walk, no new machinery. `karpathy.github.io` serves `feed.xml` and 404s on
 * `sitemap.xml`, so the accepted cost is stated rather than engineered around: **two
 * requests a day, forever**, one per path braintrust knows to try. The alternative is
 * refusing to follow a real and valuable blog over a missing XML file.
 *
 * **The reopen happens here, and this is the one walk that touches rows itself.** Nothing
 * on a Substack archive page could revive a decision braintrust made, so that walk needs
 * no database. A sitemap can: this is the only moment where the `<lastmod>` a
 * `skipped_not_a_post` row was decided on and the `<lastmod>` the site serves today are
 * both in hand, and splitting them across two callers would leave the trigger to whoever
 * remembered to pull it.
 */
export async function walkBlogArchive(
  source: SourceRow,
  db: Db,
  deps: BlogIngestDeps,
  onRecord: (item: ArchiveItem) => Promise<void>,
): Promise<BlogWalkOutcome> {
  const { sitemap, pages } = await findSitemap(source, deps);
  if (!sitemap) return { seen: 0, reachedFloor: false, pages, reopened: 0, lastmods: new Map() };

  const entries = sitemapEntries(sitemap.document);
  const lastmods = new Map<string, Date>();
  for (const entry of entries) {
    if (entry.lastmod) lastmods.set(entry.loc, entry.lastmod);
  }

  // Before the candidates are recorded, so a reopened row is already `pending` when the
  // walk hands its URL over and the on-conflict write leaves it that way.
  const reopened = await reopenChangedNotPosts(db, source.id, lastmods);

  for (const entry of entries) {
    await onRecord({
      // A blog post's id is its URL. There is no identity scheme to borrow — no slug
      // that means anything off its own host, no opaque id — and the URL is the one
      // thing the sitemap, the feed and the citation all already agree on.
      externalId: entry.loc,
      url: entry.loc,
      // Nobody has been asked yet, and on a blog nobody can be until the page is in
      // hand. See `audienceKnownBeforeFetch`.
      audience: 'unknown',
      ...(entry.lastmod ? { lastmod: entry.lastmod } : {}),
    });
  }

  return { seen: entries.length, reachedFloor: true, pages, sitemap: sitemap.url, reopened, lastmods };
}

type SitemapSearch = { sitemap?: { url: string; document: string }; pages: number };

/**
 * The sitemap, from the cheapest place it can come from.
 *
 * Discovery already resolved a `<sitemapindex>` down to a concrete sitemap for a blog
 * that publishes no feed, so that case costs nothing here. A feed-following blog has
 * never been asked, so it is asked — at the two paths the protocol and the platforms
 * fix, which is not the path-guessing the feed rule rejects: `/sitemap.xml` is where the
 * protocol says to look, and `sitemap-posts.xml` is tried first because the sites that
 * serve one serve `/sitemap.xml` as an index pointing at it.
 */
async function findSitemap(source: SourceRow, deps: BlogIngestDeps): Promise<SitemapSearch> {
  let pages = 0;

  const read = async (url: string, cached?: string): Promise<string | undefined> => {
    if (cached !== undefined) return cached;
    pages += 1;
    try {
      return await fetchPolitely(deps.fetcher, url, `the sitemap for ${source.handle}`, {
        ...(deps.pause ? { pause: deps.pause } : {}),
      });
    } catch {
      // A 404 here is the ordinary answer for a blog that has no sitemap, not a failure
      // worth counting against the Source. The walk simply returns nothing found.
      return undefined;
    }
  };

  const candidates: { url: string; cached?: string }[] = [
    { url: source.discovery_url, ...(deps.polled !== undefined ? { cached: deps.polled } : {}) },
    ...SITEMAP_PATHS.map((path) => ({ url: new URL(path, source.discovery_url).toString() })),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);

    const document = await read(candidate.url, candidate.cached);
    if (document === undefined) continue;
    if (documentKind(document) !== 'sitemap') continue;

    const chosen = resolveSitemap(document, candidate.url);
    if (typeof chosen !== 'string') continue;
    if (chosen === candidate.url) return { sitemap: { url: chosen, document }, pages };

    // An index pointed somewhere else, so one more request buys the sitemap itself.
    await (deps.pause ?? (async () => {}))(PAGE_SPACING_MS);
    const child = await read(chosen);
    if (child !== undefined && documentKind(child) === 'sitemap') {
      return { sitemap: { url: chosen, document: child }, pages };
    }
  }

  return { pages };
}

export type SitemapEntry = { loc: string; lastmod?: Date | undefined };

/**
 * `<url><loc>…</loc><lastmod>…</lastmod></url>`, in the order the document gives them.
 *
 * Not sorted, and deliberately: the sitemaps measured are ordered newest-first by
 * `<lastmod>` and the order costs nothing to preserve, but a walk that depended on it
 * would be trusting a convention the protocol does not require. Every URL is handed over
 * either way, so order is a courtesy to whoever reads the log, not a mechanism.
 */
export function sitemapEntries(document: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];

  for (const block of blocks(document, 'url')) {
    const loc = firstTag(block, 'loc');
    if (!loc || !/^https?:/i.test(loc)) continue;

    // `firstTag` has already unwrapped CDATA and decoded entities, which matters here:
    // a sitemap escapes `&` in a query string and the URL braintrust fetches has to be
    // the one the site meant, not the one the XML spelled.
    const lastmod = parseDate(firstTag(block, 'lastmod'));
    entries.push({ loc, ...(lastmod ? { lastmod } : {}) });
  }

  return entries;
}

/** What one candidate turned out to be. */
export type BlogVerdict =
  | { kind: 'post'; publishedAt: Date; text: string; raw: BlogRaw }
  /** No publish date on the page: the homepage, an about page, a tag index. */
  | { kind: 'not_a_post'; why: string }
  /** A real post, and a very brief one. `exclude_shorts` is what decides its fate. */
  | { kind: 'short'; publishedAt: Date; words: number }
  /** The publisher is withholding it. Never stored, and never stored in part. */
  | { kind: 'paywalled'; marker: GateMarker; why: string };

export type BlogRaw = {
  platform: 'blog';
  url: string;
  /** Where the body came from, which is the fact a thin post is diagnosed from. */
  body_from: BodySource;
  /** Where the date came from, so a wrong one can be traced without a refetch. */
  dated_by: DateSource;
  published_at: string;
  words: number;
  /** Which feed element supplied the body, where one did. */
  feed_element?: string;
  /**
   * Share of the page's words also present in the feed body, where both were in hand.
   * Reported, never acted on — see `agreement`.
   */
  feed_agreement?: number;
  /** The markup as served, so a better extractor never means a second fetch. */
  html?: string;
};

/**
 * Which of the two the stored words are. `feed_element` alongside it says whether the
 * other was in hand and lost, so a thin post can be diagnosed without a refetch.
 */
export type BodySource = 'feed' | 'page';

export type BlogRetrieveOptions = {
  excludeShorts: boolean;
  /**
   * The body this URL's feed entry carried, where the poll read a feed. A declared whole
   * body ends the matter here and no request is spent.
   */
  feed?: FeedBody | undefined;
  /** The publish date the feed already gave, so a feed-bodied post needs no page at all. */
  publishedAt?: Date | undefined;
  /** Lines that repeat across this blog's other pages — see `repeatedLines`. */
  boilerplate?: ReadonlySet<string> | undefined;
};

/**
 * One candidate, judged — from the feed where the feed is enough, from the page where it
 * is not.
 *
 * **The cheap path is the common one.** A feed that declares a whole body has already
 * paid for the post: braintrust stores it and fetches nothing, which is why a whole blog
 * backfill can be one request. A feed that declares a body of *nothing* for a listed,
 * dated item has told braintrust the post is gated, and that costs nothing either.
 *
 * **The three halves of the post test land in different states, and the split is not
 * cosmetic.** No date means braintrust looked and this is not an article — Coverage says
 * *"3 URLs in the archive turned out not to be posts"*, which is braintrust doing its
 * job. Dated but tiny means a real post that is very brief, which is `skipped_short`.
 * A gating marker means the publisher is withholding it, which is `skipped_paywall`.
 * Rendering any of the three as `failed` would be a lie about a source that answered
 * perfectly.
 *
 * The window is deliberately not applied here. A blog's date arrives only with the body,
 * exactly as an undated YouTube video's does, and neither is re-skipped for being old
 * once the expensive request has already been spent.
 */
export async function retrieveBlogPost(
  source: SourceRow,
  url: string,
  deps: BlogIngestDeps,
  options: BlogRetrieveOptions,
): Promise<BlogVerdict> {
  const fromFeed = feedOnly(url, options);
  if (fromFeed) return fromFeed;

  const html = await fetchPolitely(deps.fetcher, url, `the post ${url}`, {
    ...(deps.pause ? { pause: deps.pause } : {}),
  });

  // The page describing itself first, and the feed entry that listed it second.
  //
  // **A feed entry is already a statement that this is a post, and it carries the date.**
  // Measured live: `karpathy.github.io` puts a `pubDate` on all ten entries and no date
  // metadata whatsoever in the pages — no `article:published_time`, no JSON-LD, no
  // `<time datetime>` — so asking only the page filed the whole blog as *not a post*.
  // The date test exists to tell a post from an about page; where a feed has already
  // answered that, re-asking the markup can only take the answer away.
  const dated =
    publishedFrom(html) ??
    (options.publishedAt ? { at: options.publishedAt, from: 'feed' as const } : undefined);
  if (!dated) {
    return {
      kind: 'not_a_post',
      why: `${url} carries no publish date, so braintrust read it as a page rather than a post`,
    };
  }

  // After the date and before the body. Before the body because the whole point of the
  // state is that what a gated page carries is never stored; after the date because a
  // gated post is dated and a *listing* page is not, and a homepage teasing three
  // members-only posts would otherwise be filed as a paywall rather than as a page.
  const marker = gatedBy(html);
  if (marker) {
    return {
      kind: 'paywalled',
      marker,
      why: `${url} carries the ${marker} marker, so braintrust read it as a members-only post and stored none of it`,
    };
  }

  const page = blogBodyText(html, options.boilerplate);
  const chosen = longerOf(page, options.feed);
  const words = countWords(chosen.text);

  if (options.excludeShorts && words < SHORT_MAX_WORDS) {
    return { kind: 'short', publishedAt: dated.at, words };
  }

  return {
    kind: 'post',
    publishedAt: dated.at,
    text: chosen.text,
    raw: {
      platform: 'blog',
      url,
      body_from: chosen.from,
      dated_by: dated.from,
      published_at: dated.at.toISOString(),
      words,
      ...(options.feed ? { feed_element: options.feed.element } : {}),
      ...(options.feed ? { feed_agreement: agreement(page, options.feed.text) } : {}),
      html,
    },
  };
}

/**
 * The answer the feed alone can give, where it can give one.
 *
 * A **declared** whole body — `content:encoded` or Atom `<content>` — is the post, and a
 * declared body of nothing on a listed, dated item is a gate. A `<description>` or
 * `<summary>` gets no answer here: measured, the element name does not separate a body
 * from a preview (Bear Blog's `<summary>` is 36 characters beside a 44,699-character
 * `<content>`, while the Jekyll blog's `<description>` *is* the whole post at 135,277),
 * so a synopsis element has to beat the page before braintrust will store it.
 */
function feedOnly(url: string, options: BlogRetrieveOptions): BlogVerdict | undefined {
  const feed = options.feed;
  if (!feed?.whole) return undefined;

  if (gatedByFeed(feed)) {
    return {
      kind: 'paywalled',
      marker: 'empty-feed-body',
      why: `${url} is listed in the feed with an empty ${feed.element}, which is how a members-only post is published`,
    };
  }

  // The feed carries the body but not always the date, and a post braintrust cannot
  // place in time is one the compiler declines to judge. Let the page answer that.
  if (!options.publishedAt) return undefined;

  if (options.excludeShorts && feed.words < SHORT_MAX_WORDS) {
    return { kind: 'short', publishedAt: options.publishedAt, words: feed.words };
  }

  return {
    kind: 'post',
    publishedAt: options.publishedAt,
    text: feed.text,
    raw: {
      platform: 'blog',
      url,
      body_from: 'feed',
      dated_by: 'feed',
      published_at: options.publishedAt.toISOString(),
      words: feed.words,
      feed_element: feed.element,
    },
  };
}

/**
 * The longer of the feed body and the page extraction.
 *
 * **The two failure modes are opposite and each covers the other:** a truncated feed
 * loses to the page, an over-capturing extraction loses to the feed. Both are in hand for
 * nothing here, since the page was fetched for its date regardless.
 *
 * The safeguard was validated by the site it was measured on. The reference Ghost blog's
 * feed came back longer than the extraction on all four posts (111 words against 59, 207
 * against 162, 88 against 64, 125 against 93), because its recent-posts widget repeats
 * real post headings on every page and boilerplate removal over-stripped them.
 */
function longerOf(page: string, feed: FeedBody | undefined): { text: string; from: BodySource } {
  if (!feed || feed.words === 0) return { text: page, from: 'page' };
  return feed.words > countWords(page) ? { text: feed.text, from: 'feed' } : { text: page, from: 'page' };
}

/**
 * How many pages of one blog braintrust learns its chrome from.
 *
 * More is not better past a point: a line has to appear on at least half the pages, so
 * twenty is already a comfortable majority to measure against, and the pool stops growing
 * there so the set is *stable* for the rest of a backfill rather than drifting from post
 * to post. It also bounds the work — the pool is re-measured each time it grows.
 */
export const BOILERPLATE_PAGES = 20;

/**
 * What this blog puts on every page, learned from the pages braintrust already has.
 *
 * **The markup is kept on the Item for exactly this**, so the steady state costs no
 * requests at all: a run with one new post seeds the pool from what is already stored and
 * extracts that post as well as a backfill would have. A first backfill has nothing
 * stored, so it learns as it goes and its first page or two get the densest container
 * alone — over-capturing rather than under-capturing, the direction that loses no prose.
 *
 * Undefined below two pages, because one page cannot establish that anything repeats.
 */
export function boilerplateFrom(pages: readonly string[]): ReadonlySet<string> | undefined {
  if (pages.length < 2) return undefined;
  return repeatedLines(pages.map((page) => densestContainer(page).text));
}

/** `feed` is the entry's own `pubDate`/`published`, on the path that fetches no page. */
export type DateSource = 'feed' | 'article:published_time' | 'json-ld' | 'time';

/**
 * The publish date, from the page's own metadata.
 *
 * **The order is about what each signal is a statement of.** `article:published_time` and
 * JSON-LD `datePublished` are the page describing itself, and the first survived every
 * custom theme measured. A `<time datetime>` element is somewhere in the markup — which
 * may be this post, or may be the "recent posts" widget in the sidebar listing three
 * other posts' dates — so it is asked last, and only because a blog with none of the
 * other two still deserves to be read.
 *
 * A blog carrying none of this leaves its Items undated. `published_at` is nullable and
 * the compiler already declines to judge undated pairs, so that degrades rather than
 * breaks — but here it means the URL is not a post, because a date is half the test.
 */
export function publishedFrom(html: string): { at: Date; from: DateSource } | undefined {
  const meta = metaContent(html, 'article:published_time');
  const fromMeta = parseDate(meta);
  if (fromMeta) return { at: fromMeta, from: 'article:published_time' };

  const jsonLd = /"datePublished"\s*:\s*"([^"]+)"/i.exec(html)?.[1];
  const fromJsonLd = parseDate(jsonLd);
  if (fromJsonLd) return { at: fromJsonLd, from: 'json-ld' };

  const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  const fromTime = parseDate(time);
  if (fromTime) return { at: fromTime, from: 'time' };

  return undefined;
}

function metaContent(html: string, property: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name)\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== property) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (content) return decodeEntities(content);
  }
  return undefined;
}

// The extraction itself lives in `./blog-body.js`, which is where the measurements that
// shaped it are recorded. Re-exported so a caller reads one module rather than two.
export {
  blogBodyText,
  countWords,
  feedBodies,
  normaliseUrl,
  repeatedLines,
  type FeedBody,
  type GateMarker,
} from './blog-body.js';

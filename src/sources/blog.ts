/**
 * A blog: found through what it declares, refused with the list of what was tried.
 *
 * **Never a guessed path.** Guessing was measured wrong on three of four blogs, and it
 * produced the one false premise the map had to correct: `agentics.org.nz` was recorded
 * as a blog with no feed, and it publishes one at `/blog/rss/` — declared on its
 * homepage the whole time, 404ing at `/rss/` only because the site sits under a path
 * prefix. There is no path that works everywhere, and the near-misses are 301s back to
 * the homepage rather than to feeds. So braintrust reads the page and takes the feed the
 * page names, which is the mechanism the web already has for exactly this.
 *
 * **Three answers, in order, and the third is a real answer.** A declared feed; failing
 * that a sitemap, which is a feed in every way that matters here — `<lastmod>` on every
 * URL, ordered newest-first, so a walk that stops at the first unchanged URL is what
 * reading a feed does; failing both, a refusal that names every URL it fetched. A
 * refusal nobody can act on is worse than following the wrong thing, because at least
 * the wrong thing is visible.
 *
 * **Index-page crawling stays out.** It would yield an archive from almost any blog, and
 * it is general web crawling — a different posture toward the sites braintrust visits,
 * not just more code. braintrust reads feeds and known catalogues.
 *
 * See docs/design/ingestion.md §8.
 */

import { monthsBefore } from '../dates.js';
import { BraintrustError } from '../errors.js';
import { readFeed } from '../ingest/feed.js';
import { fetchText, type Fetcher } from '../net/fetch.js';
import { allTags, channelPart, firstTag, mostCommonTag } from '../net/xml.js';
import type { ResolvedSource, SourceSettings, SourceSurvey } from './types.js';

/**
 * The two `type`s a feed declaration carries. JSON Feed and bare `application/xml` are
 * left out deliberately: `alternate` says *another representation of this page*, and
 * without a type braintrust recognises, that could be anything at all.
 */
const FEED_TYPE = /^application\/(?:rss|atom)\+xml\b/i;

/**
 * Where a sitemap lives when a blog publishes no feed. Two paths, and this is not the
 * path-guessing the feed rule rejects: `/sitemap.xml` is the location the protocol
 * fixes, and `sitemap-posts.xml` is tried first because the sites that serve one serve
 * `/sitemap.xml` as an *index* pointing at it.
 */
const SITEMAP_PATHS = ['/sitemap-posts.xml', '/sitemap.xml'];

export type BlogDeps = { fetcher: Fetcher; now: Date };

/** One URL braintrust fetched while looking, and what came back. Kept for the refusal. */
type Attempt = { url: string; outcome: string };

/**
 * Resolution, which is also the only place discovery is decided.
 *
 * `handle` is the host, matching every other Source: it is what `unique (person_id,
 * platform, handle)` protects, and a person does not run two blogs on one hostname. The
 * path lives in `discoveryUrl`, which is what a blog under a `/blog/` prefix needs.
 */
export async function resolveBlog(
  url: URL,
  resolvedFrom: string,
  fetcher: Fetcher,
): Promise<ResolvedSource> {
  const tried: Attempt[] = [];
  const discoveryUrl = await discover(url.toString(), tried, fetcher);
  if (!discoveryUrl) throw refusal(url.hostname, tried);

  return {
    platform: 'blog',
    handle: url.hostname.toLowerCase(),
    discoveryUrl,
    resolvedFrom,
  };
}

async function discover(
  pasted: string,
  tried: Attempt[],
  fetcher: Fetcher,
): Promise<string | undefined> {
  const document = await read(pasted, tried, fetcher);

  if (document !== undefined) {
    // The pasted link may already *be* the document. Someone who knows their blog's feed
    // URL pastes it, and this is also what makes the refusal's advice honest: it ends by
    // telling them to do exactly that.
    const kind = documentKind(document);
    if (kind === 'feed') return pasted;
    if (kind === 'sitemap') return chooseSitemap(document, pasted, tried);

    const declared = declaredFeed(document, pasted);
    if (declared) return declared;
    tried.push({ url: pasted, outcome: 'a page, declaring no feed' });
  }

  // A post page on a site whose posts do not carry the declaration, when its homepage
  // does. One more cheap request, and only on the path that is already failing.
  const home = new URL('/', pasted).toString();
  if (home !== pasted) {
    const page = await read(home, tried, fetcher);
    if (page !== undefined) {
      const declared = declaredFeed(page, home);
      if (declared) return declared;
      tried.push({ url: home, outcome: 'a page, declaring no feed' });
    }
  }

  for (const path of SITEMAP_PATHS) {
    const url = new URL(path, pasted).toString();
    const sitemap = await read(url, tried, fetcher);
    if (sitemap === undefined) continue;

    const chosen = chooseSitemap(sitemap, url, tried);
    if (chosen) return chosen;
  }

  return undefined;
}

/**
 * `<link rel="alternate" type="application/rss+xml" href="…">`, resolved against the
 * page it was found on so a relative `/blog/rss/` works — which is the case that started
 * all of this.
 */
export function declaredFeed(html: string, base: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?[^"'>]*\balternate\b/i.test(tag)) continue;

    const type = attribute(tag, 'type');
    if (!type || !FEED_TYPE.test(type)) continue;

    // WordPress declares a comments feed beside the posts feed, in the same shape. A
    // Persona built from the comments on someone's blog is not that person.
    if (/comment/i.test(attribute(tag, 'title') ?? '')) continue;

    const href = attribute(tag, 'href');
    if (href) {
      try {
        return new URL(href, base).toString();
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/**
 * A `<sitemapindex>` is the site saying where its sitemaps are, so following it is
 * reading a declaration rather than guessing one. Two cases are unambiguous — a child
 * that names itself the posts sitemap, or an index with exactly one child — and braintrust
 * declines the rest rather than picking the tags sitemap and calling it an archive.
 */
function chooseSitemap(document: string, url: string, tried: Attempt[]): string | undefined {
  if (documentKind(document) !== 'sitemap') {
    tried.push({ url, outcome: 'not a sitemap' });
    return undefined;
  }
  if (!/<sitemapindex\b/i.test(document)) return url;

  const children = allTags(document, 'loc').filter((child) => /^https?:/i.test(child));
  const posts = children.find((child) => /post/i.test(child));
  if (posts) return posts;
  if (children.length === 1) return children[0];

  tried.push({
    url,
    outcome:
      children.length === 0
        ? 'a sitemap index listing no sitemaps'
        : `a sitemap index of ${children.length} sitemaps, none of them posts`,
  });
  return undefined;
}

/**
 * **The document says which of the two it is**, so nothing has to remember. That is what
 * lets `discovery_url` stay one column with no companion flag beside it — and it stays
 * right when a blog that had no feed publishes one and the URL is repointed.
 */
export function documentKind(document: string): 'feed' | 'sitemap' | undefined {
  const head = document.slice(0, 2000);
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(document)) return undefined;
  if (/<(?:rss|feed)\b/i.test(head)) return 'feed';
  if (/<(?:urlset|sitemapindex)\b/i.test(head)) return 'sitemap';
  return undefined;
}

function refusal(host: string, tried: Attempt[]): BraintrustError {
  return new BraintrustError(
    `braintrust could not find a way to follow ${host}. A blog is followed through the feed its ` +
      'pages declare, or through its sitemap where it publishes none. braintrust does not guess ' +
      'feed paths and does not crawl index pages, so this is everything it fetched:\n' +
      tried.map((attempt) => `  - ${attempt.url} — ${attempt.outcome}`).join('\n') +
      `\n\nIf ${host} publishes a feed at a URL its pages do not declare, paste that URL itself and ` +
      'braintrust will follow it.',
  );
}

async function read(url: string, tried: Attempt[], fetcher: Fetcher): Promise<string | undefined> {
  let response;
  try {
    response = await fetcher(url);
  } catch (error) {
    tried.push({ url, outcome: `could not be reached (${(error as Error).message})` });
    return undefined;
  }

  if (!response.ok) {
    tried.push({ url, outcome: `HTTP ${response.status}` });
    return undefined;
  }
  return response.text();
}

function attribute(tag: string, name: string): string | undefined {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  if (quoted) return quoted[1];
  return new RegExp(`\\b${name}\\s*=\\s*([^\\s"'>]+)`, 'i').exec(tag)?.[1];
}

/**
 * The cheap survey. **Both bases are `estimated`, and each is honest about a different
 * thing it cannot see.**
 *
 * A sitemap gives an exact URL count and it is tempting to call that `measured`. It is
 * not, twice over: it includes non-posts — the Bear Blog sitemap contains the homepage —
 * and `<lastmod>` is a *modification* date, so nothing in it says which URLs fall inside
 * the window. One measured site had all 7,651 of its `<lastmod>`s inside a fortnight
 * after a migration. So the Plan quotes **at most N**: every URL is a candidate, and the
 * window and the non-posts can only remove. An upper bound braintrust can defend beats a
 * midpoint it cannot.
 *
 * A feed is a tail — ten entries on both blogs measured — so it cannot price an archive
 * it cannot enumerate, and it says so in the Plan rather than in Coverage a fortnight
 * later. **The Plan says the same thing the Persona will say:** a human agreeing to this
 * is agreeing to a permanently partial Corpus.
 *
 * See docs/design/ingestion.md §2 and §8.
 */
export async function surveyBlog(
  source: ResolvedSource,
  settings: SourceSettings,
  { fetcher, now }: BlogDeps,
): Promise<SourceSurvey> {
  const document = await fetchText(
    fetcher,
    source.discoveryUrl,
    `what braintrust follows ${source.handle} through`,
  );

  if (documentKind(document) === 'sitemap') return sitemapSurvey(document);

  const feed = readFeed(document, 'blog');
  const floor = monthsBefore(now, settings.windowMonths);
  // An undated entry is counted in rather than out: the feed is the whole archive
  // braintrust can see, and dropping the entries it cannot place would quote a smaller
  // job than the one it is about to do.
  const inWindow = feed.entries.filter((entry) => !entry.publishedAt || entry.publishedAt >= floor);

  const survey: SourceSurvey = {
    itemsInWindow: inWindow.length,
    basis: 'estimated',
    how:
      `${plural(feed.entries.length, 'post')} visible in the feed; the archive cannot be ` +
      'enumerated, so braintrust will follow forward and never claim to have read all of it',
    // The feed carries the bodies, so a whole backfill is the one request that read it.
    // See docs/design/ingestion.md §6: this is the cheapest Source braintrust has.
    bodyFetches: 0,
    bodiesFromDiscovery: true,
    // Only the entries the feed leaves undated cost a page fetch, exactly as an undated
    // YouTube video does.
    dateFetches: inWindow.filter((entry) => !entry.publishedAt).length,
  };

  const head = channelPart(document);
  const title = firstTag(head, 'title');
  const author = mostCommonTag(document, 'dc:creator') ?? firstTag(head, 'name');
  if (title) survey.feedTitle = title;
  if (author) survey.feedAuthor = author;

  return survey;
}

function sitemapSurvey(document: string): SourceSurvey {
  const urls = allTags(document, 'loc').filter((url) => /^https?:/i.test(url)).length;

  return {
    itemsInWindow: urls,
    basis: 'estimated',
    how:
      `at most ${urls}: the sitemap lists ${plural(urls, 'URL')} and dates changes rather than ` +
      'publications, so nothing in it says which of them fall inside the window',
    // No feed means no body from discovery: every candidate costs its own page fetch,
    // and that fetch is also what dates it and what proves it is a post at all.
    bodyFetches: urls,
    dateFetches: 0,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

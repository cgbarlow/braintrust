/**
 * Discovery, and it is the one generic layer.
 *
 * One RSS/Atom reader serves both platforms, because at the discovery layer they are
 * structurally identical: a rolling window of items with a stable id and a publish
 * date, and **no body**. Substack's `/feed` holds 20; YouTube's `videos.xml` holds 15.
 * Adding a third RSS-publishing source is a config entry, and this file is why.
 *
 * See docs/design/ingestion.md §1 and docs/research/substack-source-facts.md §8.
 */

import { parseDate } from '../dates.js';
import { blocks, firstTag } from '../net/xml.js';
import type { Platform } from '../sources/types.js';

export type FeedEntry = {
  /** The platform's own identifier, normalised by `identify` below. */
  externalId: string;
  url: string;
  title?: string | undefined;
  publishedAt?: Date | undefined;
};

export type FeedRead = {
  feedTitle?: string | undefined;
  entries: FeedEntry[];
};

/**
 * Reads a feed. Entries braintrust cannot identify or locate are dropped rather than
 * inserted with a made-up id: an Item row is a claim that something was published,
 * and a row keyed on a guess would be un-deduplicable forever.
 */
export function readFeed(xml: string, platform: Platform): FeedRead {
  const entries: FeedEntry[] = [];

  for (const block of [...blocks(xml, 'item'), ...blocks(xml, 'entry')]) {
    const entry = identify(block, platform);
    if (entry) entries.push(entry);
  }

  return { feedTitle: firstTag(channelHead(xml), 'title'), entries };
}

function identify(block: string, platform: Platform): FeedEntry | undefined {
  const guid = firstTag(block, 'guid');
  const link = linkOf(block);
  const published = parseDate(
    firstTag(block, 'pubDate') ?? firstTag(block, 'published') ?? firstTag(block, 'updated'),
  );
  const title = firstTag(block, 'title');

  // Both platforms can produce a canonical URL from their own id, so an entry that omits
  // `<link>` is still usable. Only an entry braintrust cannot *identify* is dropped.
  const externalId =
    platform === 'youtube' ? youtubeId(block) : substackId(guid ?? link);
  if (!externalId) return undefined;

  const url = link ?? urlFor(platform, externalId, guid);
  if (!url) return undefined;

  return { externalId, url, title, publishedAt: published };
}

/** `yt:videoId`, which is the id everywhere else on the platform too. */
function youtubeId(block: string): string | undefined {
  return firstTag(block, 'yt:videoId') ?? firstTag(block, 'videoId');
}

function urlFor(platform: Platform, externalId: string, guid: string | undefined): string | undefined {
  if (platform === 'youtube') return `https://www.youtube.com/watch?v=${externalId}`;
  // Substack's guid is the canonical URL, whatever `isPermaLink` says about it.
  return guid && /^https?:/i.test(guid) ? guid : undefined;
}

/**
 * The post slug — `use-ai-sensitive-files`.
 *
 * Note this is not the archive API's integer `id`, which is the more obviously stable
 * key and the one `ingestion.md` §1 names. It cannot be: the feed does not carry it,
 * and `braintrust_items` has one `external_id` per Item, so discovery and the archive
 * walk have to agree on a single key. The slug is the only identifier **both**
 * endpoints produce — the feed's `guid` is the canonical URL and the archive record
 * carries `slug` — so no lookup step is needed to reconcile them.
 */
function substackId(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const path = /\/p\/([^/?#]+)/.exec(from);
  return path ? decodeURIComponent(path[1]!) : undefined;
}

function linkOf(block: string): string | undefined {
  // RSS puts the URL in the element's text; Atom puts it in an href attribute.
  const text = firstTag(block, 'link');
  if (text && /^https?:/i.test(text)) return text;

  const href = /<link\b[^>]*\bhref\s*=\s*"([^"]+)"/i.exec(block);
  return href?.[1];
}

/** Everything before the first entry: the channel's own fields, not the newest post's. */
function channelHead(xml: string): string {
  const first = /<(?:item|entry)(?:\s|>)/i.exec(xml);
  return first ? xml.slice(0, first.index) : xml;
}

/**
 * **Falling behind is one comparison:** if the oldest entry a feed still holds is
 * newer than the cursor, something published in between was never seen — and an Item
 * braintrust never saw is not a missing row, it is no row at all. A `measured`
 * Coverage layer would then report a complete Corpus with a hole in it.
 *
 * The repair is to set `backfill_complete = false` and let the archive walk close it,
 * so the initial load and the catch-up are the same action.
 */
export function feedSkippedAhead(entries: FeedEntry[], cursor: Date | null): boolean {
  if (!cursor) return false; // Nothing seen yet: the backfill is the answer, not a gap.

  const dated = entries
    .map((entry) => entry.publishedAt)
    .filter((date): date is Date => date !== undefined);
  if (dated.length === 0) return false;

  const oldest = dated.reduce((a, b) => (a < b ? a : b));
  return oldest > cursor;
}

/** The newest publish date in a feed, which is what the cursor advances to. */
export function newestPublished(entries: FeedEntry[]): Date | undefined {
  const dated = entries
    .map((entry) => entry.publishedAt)
    .filter((date): date is Date => date !== undefined);
  return dated.length ? dated.reduce((a, b) => (a > b ? a : b)) : undefined;
}

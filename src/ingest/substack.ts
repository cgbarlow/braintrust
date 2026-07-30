/**
 * Substack: the backfill and the body, the two per-platform layers.
 *
 * The catalogue and the text are different endpoints, and that split is the whole
 * reason the paywall line can be a *pre-fetch* filter rather than an apology.
 * `/api/v1/archive` hands over id, date and **`audience`** with no body attached, so
 * braintrust knows a post is paid before it has asked for a word of it.
 *
 * Bodies come from `/api/v1/posts/<slug>`, which returns `body_html` directly. Measured
 * on a live free post: 30KB against 338KB for the same post's public page, and the
 * extracted text agrees with Substack's own `wordcount` to 99.3%. `ingestion.md` §1
 * names "the canonical post URL" as the body route; this is the same content, an
 * eleventh of the bandwidth, and structured rather than scraped.
 *
 * See docs/design/ingestion.md §1 and docs/research/substack-source-facts.md §3.
 */

import { parseDate } from '../dates.js';
import { BraintrustError } from '../errors.js';
import { htmlToText } from '../net/html.js';
import type { Fetcher } from '../net/fetch.js';
import { audienceOf, type Audience } from '../sources/types.js';
import { fetchPolitely, type Pause } from './pace.js';
import type { ArchiveItem, SourceRow } from './items.js';

const ARCHIVE_PAGE_SIZE = 50;

/** 2,000 posts. Past the largest publication measured (581), so reaching it is a bug. */
const MAX_ARCHIVE_PAGES = 40;

/** Politeness between catalogue pages. Cheaper work than a body, so a lighter pause. */
const PAGE_PAUSE_MS = 250;

export type SubstackDeps = {
  fetcher: Fetcher;
  pause?: Pause | undefined;
};

type ArchiveRecord = {
  id?: number;
  slug?: string;
  canonical_url?: string;
  title?: string;
  post_date?: string;
  audience?: string;
};

export type WalkOutcome = {
  /** Records handed to `onRecord`, including ones braintrust already knew. */
  seen: number;
  /** True when the walk ran out of archive or crossed the backfill floor. */
  reachedFloor: boolean;
  pages: number;
};

/**
 * Pages `/api/v1/archive` newest-first until it crosses `backfill_floor`.
 *
 * One walk serves both callers: the backfill, which wants every record down to the
 * floor, and the audience pass, which wants a handful of known slugs and stops as soon
 * as it has them. `stopWhen` is what makes the second cheap.
 */
export async function walkArchive(
  source: SourceRow,
  deps: SubstackDeps,
  onRecord: (item: ArchiveItem) => Promise<void>,
  stopWhen?: () => boolean,
): Promise<WalkOutcome> {
  const pause = deps.pause ?? (async () => {});
  const floor = new Date(`${source.backfill_floor}T00:00:00Z`);

  let seen = 0;
  let pages = 0;

  for (let page = 0; page < MAX_ARCHIVE_PAGES; page += 1) {
    if (page > 0) await pause(PAGE_PAUSE_MS);

    const url =
      `https://${source.handle}/api/v1/archive` +
      `?sort=new&limit=${ARCHIVE_PAGE_SIZE}&offset=${page * ARCHIVE_PAGE_SIZE}`;
    const records = parseArchive(
      await fetchPolitely(deps.fetcher, url, `the Substack archive for ${source.handle}`, { pause }),
      source.handle,
    );
    pages += 1;

    if (records.length === 0) return { seen, reachedFloor: true, pages };

    for (const record of records) {
      const item = toArchiveItem(record, source.handle);
      if (!item) continue;

      // `sort=new`, so the first record older than the floor means the rest are too.
      if (item.publishedAt && item.publishedAt < floor) return { seen, reachedFloor: true, pages };

      await onRecord(item);
      seen += 1;

      if (stopWhen?.()) return { seen, reachedFloor: false, pages };
    }

    if (records.length < ARCHIVE_PAGE_SIZE) return { seen, reachedFloor: true, pages };
  }

  return { seen, reachedFloor: false, pages };
}

function parseArchive(body: string, handle: string): ArchiveRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BraintrustError(`The Substack archive for ${handle} did not return JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new BraintrustError(`The Substack archive for ${handle} returned something other than a list.`);
  }
  return parsed as ArchiveRecord[];
}

function toArchiveItem(record: ArchiveRecord, handle: string): ArchiveItem | undefined {
  const slug = record.slug ?? slugFromUrl(record.canonical_url);
  if (!slug) return undefined;

  return {
    // The same key discovery uses, so the two paths write one row rather than two.
    externalId: slug,
    url: record.canonical_url ?? `https://${handle}/p/${slug}`,
    title: record.title,
    publishedAt: parseDate(record.post_date),
    audience: audienceOf(record.audience),
  };
}

function slugFromUrl(url: string | undefined): string | undefined {
  const match = url ? /\/p\/([^/?#]+)/.exec(url) : null;
  return match ? decodeURIComponent(match[1]!) : undefined;
}

export type SubstackBody = {
  text: string;
  raw: {
    platform: 'substack';
    slug: string;
    audience: Audience;
    /** The publication's own count, to check the extraction against. */
    wordcount?: number | undefined;
    post_date?: string | undefined;
    /** The markup as served, so a better extractor never means a second fetch. */
    html: string;
  };
};

/** Thrown when a post braintrust believed was free turns out not to be. */
export class PaywallChanged extends BraintrustError {}

type PostRecord = {
  slug?: string;
  audience?: string;
  body_html?: string | null;
  wordcount?: number;
  post_date?: string;
};

/**
 * Fetches one post's text.
 *
 * The audience is checked **again** here, against the post itself. The catalogue was
 * read minutes or hours earlier, and a post that has turned paid in between must not be
 * stored because an older answer said it was free. The check costs nothing — the field
 * arrives in the same payload as the body — and it means the hard line is enforced at
 * both ends of the only path that can cross it.
 */
export async function retrieveSubstackPost(
  source: SourceRow,
  externalId: string,
  deps: SubstackDeps,
): Promise<SubstackBody> {
  const url = `https://${source.handle}/api/v1/posts/${encodeURIComponent(externalId)}`;
  const body = await fetchPolitely(deps.fetcher, url, `the Substack post ${externalId}`, {
    ...(deps.pause ? { pause: deps.pause } : {}),
  });

  let post: PostRecord;
  try {
    post = JSON.parse(body) as PostRecord;
  } catch {
    throw new BraintrustError(`The Substack post ${externalId} did not return JSON.`);
  }

  const audience = audienceOf(post.audience);
  if (audience !== 'everyone') {
    throw new PaywallChanged(
      `${externalId} is ${post.audience ?? 'not public'} now, whatever the catalogue said. ` +
        'Recording it as skipped rather than reading it.',
    );
  }

  const html = post.body_html;
  if (!html || html.trim() === '') {
    throw new BraintrustError(`The Substack post ${externalId} came back without a body.`);
  }

  const text = htmlToText(html);
  if (text.trim() === '') {
    throw new BraintrustError(`The Substack post ${externalId} has markup but no text in it.`);
  }

  return {
    text,
    raw: {
      platform: 'substack',
      slug: post.slug ?? externalId,
      audience,
      wordcount: post.wordcount,
      post_date: post.post_date,
      html,
    },
  };
}

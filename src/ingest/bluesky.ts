/**
 * Bluesky: one cursored walk that is the poll, the backfill and the body all at once.
 *
 * **A day of posts is the Item.** Measured against `emollick.bsky.social` — 100 posts in 17
 * days, 3,359 words — that turns roughly 2,100 Items a year into ~365 model calls, which is
 * what makes Bluesky affordable at all. Read-once economics were built for ~4,000-word
 * videos and invert completely at a 34-word skeet.
 *
 * Three rules hold the batching together, and each removes a problem rather than mitigating
 * one.
 *
 * **braintrust never batches the current UTC day.** A day is eligible when `now` is past its
 * end — full stop, not "past its end plus a margin", because the boundary is exact and a
 * margin would be a guess dressed as caution. Read-once assumes an Item is immutable, and
 * this makes the assumption true *by construction*: a day that can still change is not yet
 * an Item, so nothing has to detect one changing.
 *
 * **The external id is the whole idempotency story: `<did>:<YYYY-MM-DD>`.** Deterministic
 * and derived from data every path already holds, so a backfill and a daily poll that reach
 * the same closed day compute the same key and `unique (source_id, external_id)` makes them
 * write one row. The same property Substack gets from its slug, obtained here by
 * construction rather than by luck.
 *
 * **A day is written only once nothing older can be added to it.** The feed arrives
 * newest-first in pages of 100, so a day sitting on a page boundary is incomplete until the
 * next page proves it is not — and an incomplete day written as an Item would be read once,
 * permanently, with half of it missing.
 *
 * See docs/design/ingestion.md §7.
 */

import { toDateOnly } from '../dates.js';
import type { Fetcher } from '../net/fetch.js';
import {
  authorFeedUrl,
  readAuthorFeed,
  type BlueskyDay,
  type BlueskyPost,
} from '../sources/bluesky.js';
import { requestSpacingMs } from '../sources/types.js';
import type { SourceRow } from './items.js';
import { fetchPolitely, sleep, type Pause } from './pace.js';

/**
 * A safety rail, not a policy. 200 pages is 20,000 posts — far past a year of the most
 * prolific account measured — so reaching it means the cursor is looping rather than that
 * somebody is talkative.
 */
export const MAX_FEED_PAGES = 200;

/** What one day becomes on its way to a row. */
export type DayBody = {
  externalId: string;
  url: string;
  title: string;
  publishedAt: string;
  text: string;
  raw: StoredDay;
};

export type StoredPost = {
  uri: string;
  url: string;
  created_at: string;
  char_start: number;
  char_end: number;
};

export type StoredDay = {
  platform: 'bluesky';
  did: string;
  day: string;
  posts: StoredPost[];
};

/**
 * The day as one body, with every post's character span recorded beside it.
 *
 * **That span is what lets a citation point at the individual post rather than at the
 * day.** It is the mechanism braintrust already uses rather than a new one: a quote is
 * located in the stored body when the Item is read, and the post — like the Chunk and the
 * timecode — is read off the spans at that moment instead of being asked of a model.
 *
 * The posts are joined in the order they were written, which is the reverse of the order
 * the feed serves them in. A day read backwards is a day whose argument runs backwards.
 */
export function dayBody(did: string, day: BlueskyDay): DayBody {
  const posts = [...day.posts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const parts: string[] = [];
  const spans: StoredPost[] = [];
  let at = 0;

  for (const post of posts) {
    spans.push({
      uri: post.uri,
      url: post.url,
      created_at: post.createdAt.toISOString(),
      char_start: at,
      char_end: at + post.text.length,
    });
    parts.push(post.text);
    at += post.text.length + 2; // the '\n\n' that joins them
  }

  return {
    externalId: `${did}:${day.day}`,
    // A day has no URL of its own. The first post is where a reader lands to read it,
    // and every citation resolves to its own post anyway.
    url: posts[0]!.url,
    title: `Posts on ${day.day}`,
    publishedAt: day.day,
    text: parts.join('\n\n'),
    raw: { platform: 'bluesky', did, day: day.day, posts: spans },
  };
}

/** The spans back out of a stored body, for the read pass. Empty for every other platform. */
export function storedPosts(raw: unknown): StoredPost[] {
  const stored = raw as StoredDay | null;
  if (!stored || stored.platform !== 'bluesky' || !Array.isArray(stored.posts)) return [];
  return stored.posts;
}

export type BlueskyIngestDeps = {
  fetcher: Fetcher;
  pause?: Pause | undefined;
  now: Date;
  /**
   * How far back this walk is being asked to read. The backfill floor while the archive is
   * still being reached, and otherwise the start of the newest day braintrust already
   * stored — which is what makes a steady-state poll exactly one request.
   */
  until: Date;
  /** The first page, already fetched by the poll. The walk is the poll; this is the proof. */
  polled?: string | undefined;
  stopping?: (() => boolean) | undefined;
};

export type BlueskyWalkOutcome = {
  requests: number;
  posts: number;
  /** Days handed to `onDay`. Some of them may already have been rows. */
  days: number;
  /**
   * True when the walk read everything it was asked for — it crossed `until`, or the
   * account ran out of posts. False means it stopped early, and the caller must not read
   * that as a finished backfill.
   */
  reachedEnd: boolean;
  /** The newest post this walk saw, for the Source's cursor. */
  newest?: Date | undefined;
  stopped: boolean;
};

/**
 * The walk. Pages `getAuthorFeed` newest-first, batching as it goes.
 *
 * **This is the poll and the backfill and the retrieval, and it is one loop because Bluesky
 * hands over all three in the same response.** Everywhere else those are separate passes
 * because a catalogue and a body are separate endpoints; here, insisting on the separation
 * would mean throwing away the words braintrust had already been given and asking for them
 * again.
 *
 * A day is flushed as soon as a post older than it appears, so a run killed mid-walk has
 * written whole days rather than partial ones — the rows are the progress, exactly as
 * everywhere else, and the accepted cost is that resuming re-reads pages it already read.
 */
export async function walkAuthorFeed(
  source: SourceRow,
  deps: BlueskyIngestDeps,
  onDay: (day: DayBody) => Promise<void>,
): Promise<BlueskyWalkOutcome> {
  const pause = deps.pause ?? sleep;
  const stopping = deps.stopping ?? (() => false);
  const today = toDateOnly(deps.now);

  const collected = new Map<string, BlueskyPost[]>();
  const outcome: BlueskyWalkOutcome = { requests: 0, posts: 0, days: 0, reachedEnd: false, stopped: false };

  let body = deps.polled;
  let cursor: string | undefined;
  let crossed = false;

  for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
    if (body === undefined) {
      if (stopping()) {
        outcome.stopped = true;
        return outcome;
      }
      // Between requests, which on this Source is also between hundreds of posts. The
      // AppView states no limit; the absence of one is not permission.
      await pause(requestSpacingMs('bluesky'));
      body = await fetchPolitely(
        deps.fetcher,
        authorFeedUrl(source.handle, cursor),
        `the Bluesky posts of ${source.handle}`,
        { pause },
      );
    }
    outcome.requests += 1;

    const read = readAuthorFeed(body, source.handle);
    let oldest: Date | undefined;

    for (const post of read.posts) {
      outcome.newest ??= post.createdAt;
      if (post.createdAt < deps.until) {
        crossed = true;
        break;
      }
      oldest = post.createdAt;
      outcome.posts += 1;

      const day = toDateOnly(post.createdAt);
      // The current UTC day is not an Item yet, and will be one tomorrow.
      if (day >= today) continue;

      const existing = collected.get(day);
      if (existing) existing.push(post);
      else collected.set(day, [post]);
    }

    // Everything strictly newer than the oldest post this page reached is complete: the
    // feed is ordered, so nothing still to come can belong to those days.
    if (oldest) outcome.days += await flush(source, collected, toDateOnly(oldest), onDay);

    if (crossed || !read.cursor) {
      outcome.reachedEnd = true;
      break;
    }
    cursor = read.cursor;
    body = undefined;
  }

  // Whatever is left is complete when the walk finished properly, and the oldest of it is
  // not when the walk was cut short by the page rail — so that one is left for next time
  // rather than written half-read.
  if (outcome.reachedEnd) outcome.days += await flush(source, collected, undefined, onDay);

  return outcome;
}

/** Writes every collected day newer than `boundary`, newest first. */
async function flush(
  source: SourceRow,
  collected: Map<string, BlueskyPost[]>,
  boundary: string | undefined,
  onDay: (day: DayBody) => Promise<void>,
): Promise<number> {
  const ready = [...collected.keys()]
    .filter((day) => boundary === undefined || day > boundary)
    .sort()
    .reverse();

  for (const day of ready) {
    const posts = collected.get(day)!;
    collected.delete(day);
    await onDay(dayBody(source.handle, { day, posts }));
  }

  return ready.length;
}

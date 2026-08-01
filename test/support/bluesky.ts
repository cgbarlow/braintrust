/**
 * A fake Bluesky account, shaped like the real AppView.
 *
 * The field names and the nesting come from `app.bsky.feed.getAuthorFeed` and
 * `app.bsky.actor.getProfile` as the public AppView actually serves them: the record under
 * `post.record`, the repost marker as a sibling `reason`, the reply's parent author under
 * `reply.parent.author`, and `postsCount` and `createdAt` free on the profile. The numbers
 * here are made up; the shapes are not.
 *
 * **Forty days of somebody's posting, with the awkward cases in it** — a day they only said
 * one thing, a day they passed something on, a reply to a stranger beside a reply to
 * themselves, and a picture with no words. Each one is a different reason an entry is or is
 * not this person's writing.
 */

import type { Route } from './sources.js';
import { NOW } from './sources.js';

export const BSKY_DID = 'did:plc:emollick00000000000000';
export const BSKY_HANDLE = 'emollick.bsky.social';
export const BSKY_NAME = 'Ethan Mollick';
export const BSKY_PROFILE_LINK = `https://bsky.app/profile/${BSKY_HANDLE}`;

/** Somebody else, so a repost and a reply have a plausible other end. */
export const OTHER_DID = 'did:plc:someoneelse0000000000';

/** Day 0 is the current UTC day, which braintrust must never batch. */
export const BSKY_DAYS = 40;
export const BSKY_CLOSED_DAYS = BSKY_DAYS - 1;

export const POSTS_PER_DAY = 6;

/** All before NOW's 12:00, so today's posts are posts rather than predictions. */
const SLOT_HOURS = [1, 3, 5, 7, 9, 11];

/** One post, and it is still real writing rather than a `skipped_short` row. */
export const QUIET_DAY = 6;
/** Slot 0 is somebody else's, passed on. */
export const REPOST_DAY = 2;
/** Slot 1 answers a stranger; slot 2 answers themselves, which is a thread. */
export const REPLY_DAY = 3;
/** Slot 3 is a picture with no caption. */
export const IMAGE_DAY = 4;

const LINES = [
  'The interesting part is not that the model can do it, but that nobody had agreed what doing it well would even look like.',
  'Every organisation I talk to has the same bottleneck and it is never the model — it is who is allowed to decide anything.',
  'People keep asking for a benchmark when what they actually want is permission to stop arguing about the benchmark they have.',
  'The teams getting value are the ones who wrote down what they were doing before, badly, and can now compare against it.',
  'A tool that saves an hour a week changes nothing. A tool that changes who does the work changes the whole shape of it.',
  'I keep coming back to this: the hard part was never generation, it was deciding what was worth generating in the first place.',
];

/** How many of that day's posts are this person's own words. */
export function postsOnDay(index: number): number {
  if (index === QUIET_DAY) return 1;
  if (index === REPOST_DAY || index === IMAGE_DAY) return POSTS_PER_DAY - 1;
  if (index === REPLY_DAY) return POSTS_PER_DAY - 1;
  return POSTS_PER_DAY;
}

/** `YYYY-MM-DD`, counting back from the fixture's own today. */
export function dayOf(index: number): string {
  return new Date(NOW.getTime() - index * 86_400_000).toISOString().slice(0, 10);
}

function slotsOn(index: number): number[] {
  return index === QUIET_DAY ? [0] : [0, 1, 2, 3, 4, 5];
}

export function rkeyOf(index: number, slot: number): string {
  return `3l${String(index).padStart(3, '0')}${slot}`;
}

export function postLink(index: number, slot: number): string {
  return `https://bsky.app/profile/${BSKY_DID}/post/${rkeyOf(index, slot)}`;
}

/**
 * The marker is at the **end** on purpose. A quote taken from the tail of a day's body is
 * then unique to one post, which is what lets a test say which post a citation resolved to
 * rather than which day it came from.
 */
export function textOf(index: number, slot: number): string {
  return `${LINES[(index + slot) % LINES.length]} (day ${index}, note ${slot})`;
}

function createdAt(index: number, slot: number): string {
  const day = new Date(NOW.getTime() - index * 86_400_000);
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), SLOT_HOURS[slot]!, 0, 0),
  ).toISOString();
}

function entry(index: number, slot: number): unknown {
  const at = createdAt(index, slot);

  // Somebody else's post, in this feed only because it was reposted.
  if (index === REPOST_DAY && slot === 0) {
    return {
      post: {
        uri: `at://${OTHER_DID}/app.bsky.feed.post/${rkeyOf(index, slot)}`,
        author: { did: OTHER_DID, handle: 'someone.else.example' },
        record: { $type: 'app.bsky.feed.post', text: 'Worth reading this one.', createdAt: at },
        indexedAt: at,
      },
      reason: { $type: 'app.bsky.feed.defs#reasonRepost', indexedAt: at },
    };
  }

  const post = {
    uri: `at://${BSKY_DID}/app.bsky.feed.post/${rkeyOf(index, slot)}`,
    cid: `bafy${rkeyOf(index, slot)}`,
    author: { did: BSKY_DID, handle: BSKY_HANDLE, displayName: BSKY_NAME },
    record: {
      $type: 'app.bsky.feed.post',
      // The picture with no caption. Real publishing, and no words to read.
      text: index === IMAGE_DAY && slot === 3 ? '' : textOf(index, slot),
      createdAt: at,
      langs: ['en'],
    },
    replyCount: 0,
    repostCount: 1,
    likeCount: 2,
    indexedAt: at,
  };

  if (index === REPLY_DAY && (slot === 1 || slot === 2)) {
    const parent = slot === 1 ? OTHER_DID : BSKY_DID;
    return {
      post,
      reply: {
        root: { author: { did: parent } },
        parent: { author: { did: parent } },
      },
    };
  }

  return { post };
}

/** Every entry the account has, newest first — which is the order the AppView serves. */
export function allEntries(): unknown[] {
  const entries: unknown[] = [];
  for (let index = 0; index < BSKY_DAYS; index += 1) {
    for (const slot of [...slotsOn(index)].reverse()) entries.push(entry(index, slot));
  }
  return entries;
}

export const BSKY_TOTAL_ENTRIES = allEntries().length;

/** Posts braintrust will read, across every closed day in the fixture. */
export function readablePosts(fromDay = 1, toDay = BSKY_DAYS - 1): number {
  let total = 0;
  for (let index = fromDay; index <= toDay; index += 1) total += postsOnDay(index);
  return total;
}

export const PAGE_SIZE = 100;

/** One page of `getAuthorFeed`. The cursor is an offset, which is all a fake needs. */
export function authorFeedPage(url: string): string {
  const offset = Number(new URL(url).searchParams.get('cursor') ?? '0');
  const entries = allEntries().slice(offset, offset + PAGE_SIZE);
  const next = offset + PAGE_SIZE;

  return JSON.stringify({
    feed: entries,
    ...(next < BSKY_TOTAL_ENTRIES ? { cursor: String(next) } : {}),
  });
}

export function blueskyProfile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    did: BSKY_DID,
    handle: BSKY_HANDLE,
    displayName: BSKY_NAME,
    description: 'Professor at Wharton. Posts about what actually happens when people use this stuff.',
    postsCount: BSKY_TOTAL_ENTRIES,
    followersCount: 250_000,
    followsCount: 900,
    // The account is younger than a twelve-month window, which is the case a plan has to
    // count honestly rather than quoting 365 days nobody lived.
    createdAt: new Date(NOW.getTime() - BSKY_DAYS * 86_400_000).toISOString(),
    indexedAt: NOW.toISOString(),
    labels: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The bridge, which braintrust refuses and redirects
// ---------------------------------------------------------------------------

export const BRIDGE_DID = 'did:plc:bridged00000000000000';
export const BRIDGE_HANDLE = 'karpathy.bearblog.dev.web.brid.gy';
export const BRIDGED_BLOG = 'karpathy.bearblog.dev';

export function bridgeProfile(): string {
  return JSON.stringify({
    did: BRIDGE_DID,
    handle: BRIDGE_HANDLE,
    displayName: 'karpathy [Unofficial]',
    description: 'Bridged from karpathy.bearblog.dev by Bridgy Fed.',
    postsCount: 15,
    createdAt: new Date(NOW.getTime() - 200 * 86_400_000).toISOString(),
    // Self-applied, and returned by the same getProfile call registration already makes.
    labels: [{ src: BRIDGE_DID, uri: `at://${BRIDGE_DID}/app.bsky.actor.profile/self`, val: 'bridged-from-bridgy-fed-web' }],
  });
}

// ---------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------

export function blueskyRoutes(): Route[] {
  return [
    {
      match: (url) => url.includes('com.atproto.identity.resolveHandle'),
      respond: (url) => {
        const handle = new URL(url).searchParams.get('handle');
        if (handle === BSKY_HANDLE) return { status: 200, body: JSON.stringify({ did: BSKY_DID }) };
        if (handle === BRIDGE_HANDLE) return { status: 200, body: JSON.stringify({ did: BRIDGE_DID }) };
        return { status: 400, body: JSON.stringify({ error: 'InvalidRequest' }) };
      },
    },
    {
      match: (url) => url.includes('app.bsky.actor.getProfile'),
      respond: (url) => {
        const actor = new URL(url).searchParams.get('actor');
        if (actor === BRIDGE_DID || actor === BRIDGE_HANDLE) {
          return { status: 200, body: bridgeProfile() };
        }
        return { status: 200, body: blueskyProfile() };
      },
    },
    { match: (url) => url.includes('app.bsky.feed.getAuthorFeed'), body: authorFeedPage },
  ];
}

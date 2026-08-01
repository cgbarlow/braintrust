/**
 * Bluesky: what a link resolves to, what a Plan promises, and how a day becomes an Item.
 *
 * The three things worth pinning here are the three that are cheap to get wrong and
 * expensive to notice: **identity is the DID**, **a day still being posted to is not an
 * Item**, and **the batch is a unit of reading and never a unit of citation**.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BraintrustError } from '../src/errors.js';
import {
  dayBody,
  MAX_FEED_PAGES,
  storedPosts,
  walkAuthorFeed,
  type DayBody,
} from '../src/ingest/bluesky.js';
import type { SourceRow } from '../src/ingest/items.js';
import { spanAt } from '../src/notes/verify.js';
import {
  bridgedFrom,
  bridgeLabel,
  FEED_PAGE_SIZE,
  isBlueskyHandle,
  isDid,
  postUrl,
  readAuthorFeed,
  surveyBluesky,
} from '../src/sources/bluesky.js';
import { resolveLinks } from '../src/sources/resolve.js';
import { DEFAULT_SETTINGS } from '../src/sources/types.js';
import {
  allEntries,
  authorFeedPage,
  blueskyProfile,
  blueskyRoutes,
  BRIDGE_HANDLE,
  BSKY_CLOSED_DAYS,
  BSKY_DAYS,
  BSKY_DID,
  BSKY_HANDLE,
  BSKY_NAME,
  BSKY_PROFILE_LINK,
  BSKY_TOTAL_ENTRIES,
  dayOf,
  IMAGE_DAY,
  postLink,
  postsOnDay,
  QUIET_DAY,
  readablePosts,
  REPLY_DAY,
  REPOST_DAY,
  rkeyOf,
  textOf,
} from './support/bluesky.js';
import { fakeFetcher, NOW, type Route } from './support/sources.js';

describe('resolving a Bluesky link', () => {
  it('takes the DID as the identity, whatever handle the human pasted', async () => {
    const [source] = await resolveLinks([BSKY_PROFILE_LINK], { fetcher: fakeFetcher(blueskyRoutes()) });

    assert.equal(source!.platform, 'bluesky');
    assert.equal(source!.handle, BSKY_DID);
    assert.equal(source!.resolvedFrom, BSKY_PROFILE_LINK);
    assert.match(source!.discoveryUrl, /app\.bsky\.feed\.getAuthorFeed/);
    assert.match(source!.discoveryUrl, /posts_and_author_threads/);
  });

  /**
   * A handle is a domain somebody rents. Keying rows on it would give a person who moves
   * from `emollick.bsky.social` to their own domain a second copy of their own archive.
   */
  it('costs no request at all when the link already carries the DID', async () => {
    const fetcher = fakeFetcher(blueskyRoutes());
    const [source] = await resolveLinks([`https://bsky.app/profile/${BSKY_DID}`], { fetcher });

    assert.equal(source!.handle, BSKY_DID);
    assert.deepEqual(fetcher.requests, []);
  });

  it('reads the person out of a link to one of their posts', async () => {
    const [source] = await resolveLinks([`${BSKY_PROFILE_LINK}/post/3l0010`], {
      fetcher: fakeFetcher(blueskyRoutes()),
    });
    assert.equal(source!.handle, BSKY_DID);
  });

  it('accepts a bare .bsky.social handle, with or without the @', async () => {
    const fetcher = fakeFetcher(blueskyRoutes());
    const sources = await resolveLinks([BSKY_HANDLE, `@${BSKY_HANDLE}`], { fetcher });

    assert.equal(sources.length, 1, 'two ways of naming one person are one Source');
    assert.equal(sources[0]!.handle, BSKY_DID);
  });

  it('accepts the explicit prefix, which is how a custom-domain handle gets in', async () => {
    const routes: Route[] = [
      {
        match: (url) => url.includes('resolveHandle') && url.includes('mollick.io'),
        body: JSON.stringify({ did: BSKY_DID }),
      },
      ...blueskyRoutes(),
    ];
    const [source] = await resolveLinks(['bluesky:mollick.io'], { fetcher: fakeFetcher(routes) });
    assert.equal(source!.handle, BSKY_DID);
  });

  /**
   * **A Bluesky handle is a domain, so recognising every domain as one would swallow every
   * blog address pasted at braintrust.** Somebody's own domain is their website first; the
   * prefix and the bsky.app link are how they say otherwise.
   */
  it('leaves a bare domain to the blog branch rather than guessing it is a handle', () => {
    assert.equal(isBlueskyHandle('karpathy.bearblog.dev'), false);
    assert.equal(isBlueskyHandle('emollick.bsky.social'), true);
    assert.equal(isDid('did:plc:abc123'), true);
    assert.equal(isDid('bsky.social'), false);
  });

  it('says so when Bluesky does not know the handle', async () => {
    await assert.rejects(
      resolveLinks(['nobody.bsky.social'], { fetcher: fakeFetcher(blueskyRoutes()) }),
      /does not know a handle/,
    );
  });
});

describe('the plan for a Bluesky account', () => {
  const survey = (routes = blueskyRoutes(), settings = DEFAULT_SETTINGS) =>
    surveyBluesky(
      { platform: 'bluesky', handle: BSKY_DID, discoveryUrl: '', resolvedFrom: BSKY_PROFILE_LINK },
      settings,
      { fetcher: fakeFetcher(routes), now: NOW },
    );

  /**
   * **The count is days somebody *posted on*, and it is a projection.** The first live run
   * is why: quoting the calendar days in the window and calling it `measured` promised 365
   * items and delivered 303, because a day with no posts is no Item. The ceiling is still
   * a fact and still stated — it is just not the number.
   */
  it('projects the days they posted on, and names the ceiling rather than quoting it', async () => {
    const found = await survey();

    assert.equal(found.basis, 'estimated');
    assert.ok(found.itemsInWindow > 0 && found.itemsInWindow <= BSKY_DAYS);
    assert.match(found.how!, /projected from their \d+ most recent posts/);
    assert.match(found.how!, /which is the ceiling/);
  });

  /**
   * The post count travels alongside because this is the Source where 1,530 posts become
   * ~365 model calls. It is a *recent* rate rather than a lifetime one — `postsCount` over
   * the account's life was 9.6× too high against a real account, because it counts replies
   * and reposts across years of somebody who no longer posts that way.
   */
  it('shows the posts as a labelled projection rather than as a count it cannot support', async () => {
    const found = await survey();

    assert.ok(found.postsInWindow, 'the thing being summarised travels with the summary');
    assert.match(found.postsInWindow!.how, /a recent rate/);
    assert.match(found.postsInWindow!.how, /not a count braintrust has verified/);
  });

  /**
   * A call returns 100 *entries* whether braintrust wants them or not, so the requests are
   * priced on entries. Counting only the keepers would quote a heavy reposter half the
   * requests their backfill actually costs.
   */
  it('prices the work in requests, and lands within one of what the walk spends', async () => {
    const found = await survey();
    const actual = Math.ceil(BSKY_TOTAL_ENTRIES / FEED_PAGE_SIZE);

    assert.ok(
      Math.abs(found.bodyFetches - actual) <= 1,
      `quoted ${found.bodyFetches} requests against ${actual} actually spent`,
    );
    assert.equal(found.bodiesFromDiscovery, true);
    assert.equal(found.dateFetches, 0, 'createdAt is on every record; nothing is fetched to date it');
  });

  /**
   * The one case that earns `measured`: the whole history arrived in the single call, so
   * the walk has effectively already happened and there is nothing left to project.
   */
  it('measures rather than projects when the whole account fits in one call', async () => {
    const routes: Route[] = [
      {
        match: (url) => url.includes('getAuthorFeed'),
        body: JSON.stringify({ feed: allEntries().slice(0, 20) }),
      },
      ...blueskyRoutes(),
    ];
    const found = await survey(routes);

    assert.equal(found.basis, 'measured');
    assert.match(found.how!, /it fits in one call/);
    assert.equal(found.postsInWindow!.how, 'counted, not projected: this is the whole account');
    assert.equal(found.bodyFetches, 1);
  });

  it('proposes the display name from the profile, which is a person’s name by construction', async () => {
    const found = await survey();
    assert.equal(found.feedAuthor, BSKY_NAME);
    assert.equal(found.feedTitle, `@${BSKY_HANDLE}`);
  });

  /**
   * **The refusal is a redirect**, because the profile hands over the canonical source. A
   * Bridgy Fed record carries the entire blog post, so following both would hold the same
   * words twice — and following the bridge is *easier* than following the source, which is
   * exactly when provenance has to win.
   */
  it('refuses a bridged account and names the blog it mirrors', async () => {
    const error = await surveyBluesky(
      { platform: 'bluesky', handle: BRIDGE_HANDLE, discoveryUrl: '', resolvedFrom: BRIDGE_HANDLE },
      DEFAULT_SETTINGS,
      { fetcher: fakeFetcher(blueskyRoutes()), now: NOW },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown as BraintrustError,
    );

    assert.ok(error instanceof BraintrustError);
    assert.match(error.message, /karpathy\.bearblog\.dev/);
    assert.match(error.message, /Unofficial/);
    assert.match(error.message, /Follow karpathy\.bearblog\.dev instead/);
  });

  it('reads the bridge from the label rather than from the handle suffix', () => {
    assert.equal(
      bridgeLabel({ labels: [{ val: 'bridged-from-bridgy-fed-web' }] }),
      'bridged-from-bridgy-fed-web',
    );
    assert.equal(bridgeLabel({ labels: [{ val: '!no-unauthenticated' }] }), undefined);
    assert.equal(bridgedFrom('karpathy.bearblog.dev.web.brid.gy'), 'karpathy.bearblog.dev');
    assert.equal(bridgedFrom('emollick.bsky.social'), undefined);
  });

  /**
   * A deep archive whose recent activity is one post gives nothing to measure a rate from.
   * The honest answer is the ceiling with its direction named — the same shape a
   * sitemap-bearing blog's *at most N* takes, and for the same reason.
   */
  it('falls back to the ceiling when there is too little recent posting to project from', async () => {
    const routes: Route[] = [
      {
        match: (url) => url.includes('getAuthorFeed'),
        body: JSON.stringify({ feed: allEntries().slice(0, 1), cursor: '1' }),
      },
      ...blueskyRoutes(),
    ];
    const found = await survey(routes);

    assert.equal(found.basis, 'estimated');
    assert.match(found.how!, /^at most \d+ — the closed UTC days in the window/);
    assert.match(found.how!, /too little recent posting/);
  });

  it('takes the window from the account when the account is younger than it', async () => {
    const found = await survey();
    const twoYears = await survey(blueskyRoutes(), { ...DEFAULT_SETTINGS, windowMonths: 24 });

    assert.equal(
      found.itemsInWindow,
      twoYears.itemsInWindow,
      'a wider window over the same short life is the same offer',
    );
  });
});

describe('reading one page of the author feed', () => {
  const page = () => readAuthorFeed(authorFeedPage('https://x/?cursor=0'), BSKY_DID);

  it('keeps their own posts and their own threads', () => {
    const posts = page().posts;
    const thread = posts.find((post) => post.rkey === rkeyOf(REPLY_DAY, 2));
    assert.ok(thread, 'a thread is one thought written in instalments');
  });

  it('drops a repost, because the words belong to whoever wrote them', () => {
    assert.equal(page().posts.some((post) => post.rkey === rkeyOf(REPOST_DAY, 0)), false);
  });

  it('drops a reply into somebody else’s thread, which is half a dialogue', () => {
    assert.equal(page().posts.some((post) => post.rkey === rkeyOf(REPLY_DAY, 1)), false);
  });

  it('drops a picture with no caption rather than storing an empty span', () => {
    assert.equal(page().posts.some((post) => post.rkey === rkeyOf(IMAGE_DAY, 3)), false);
  });

  it('carries the cursor while there is more, and drops it at the end', () => {
    assert.equal(page().cursor, String(FEED_PAGE_SIZE));
    const last = readAuthorFeed(
      authorFeedPage(`https://x/?cursor=${BSKY_TOTAL_ENTRIES - 1}`),
      BSKY_DID,
    );
    assert.equal(last.cursor, undefined);
  });

  it('refuses a body that is not the shape braintrust asked for', () => {
    assert.throws(() => readAuthorFeed('<html>nope</html>', BSKY_DID), /did not return JSON/);
    assert.throws(() => readAuthorFeed('{"ok":true}', BSKY_DID), /other than a list of posts/);
  });
});

describe('a day of posts as one Item', () => {
  const dayFor = (index: number): DayBody => {
    const posts = readAuthorFeed(authorFeedPage('https://x/?cursor=0'), BSKY_DID).posts.filter(
      (post) => post.createdAt.toISOString().slice(0, 10) === dayOf(index),
    );
    return dayBody(BSKY_DID, { day: dayOf(index), posts });
  };

  /**
   * `<did>:<YYYY-MM-DD>` is the whole idempotency story: deterministic, derived from data
   * both the backfill and the daily poll already hold, so the two reach the same closed day
   * and write one row.
   */
  it('is keyed by the DID and the day, so two paths write one row', () => {
    assert.equal(dayFor(1).externalId, `${BSKY_DID}:${dayOf(1)}`);
    assert.equal(dayFor(1).publishedAt, dayOf(1));
  });

  it('reads forward, because a day read backwards is an argument read backwards', () => {
    const day = dayFor(1);
    const first = day.text.indexOf(textOf(1, 0));
    const last = day.text.indexOf(textOf(1, 5));
    assert.ok(first >= 0 && last > first, 'the earliest post opens the day');
  });

  /**
   * **The batch is a unit of reading, never a unit of citation.** The spans are what let a
   * verified quote resolve to the post it actually came from.
   */
  it('records each post’s span, and every span is exactly that post’s words', () => {
    const day = dayFor(1);
    const posts = storedPosts(day.raw);

    assert.equal(posts.length, postsOnDay(1));
    for (const [slot, post] of posts.entries()) {
      assert.equal(day.text.slice(post.char_start, post.char_end), textOf(1, slot));
      assert.equal(post.url, postLink(1, slot));
    }
  });

  it('resolves a quote to the post it fell inside rather than to the day', () => {
    const day = dayFor(1);
    const posts = storedPosts(day.raw);

    const at = day.text.indexOf(textOf(1, 3));
    assert.equal(spanAt(posts, at)!.url, postLink(1, 3));
    // The first character of the day belongs to the first post, not to the fourth.
    assert.equal(spanAt(posts, 0)!.url, postLink(1, 0));
    assert.equal(spanAt(posts, day.text.length + 10), undefined);
  });

  /**
   * A one-post day is an Item of a few dozen words and is *not* `skipped_short`. That state
   * is braintrust's own policy about promotional filler; a one-post day is real writing.
   */
  it('makes an Item of a day somebody only said one thing on', () => {
    const day = dayFor(QUIET_DAY);
    assert.equal(storedPosts(day.raw).length, 1);
    assert.equal(day.url, postLink(QUIET_DAY, 0));
  });

  it('carries no post spans for anything that is not a batch', () => {
    assert.deepEqual(storedPosts({ platform: 'substack', slug: 'x' }), []);
    assert.deepEqual(storedPosts(null), []);
  });
});

describe('walking the author feed', () => {
  const source: SourceRow = {
    id: 'source-1',
    person_id: 'person-1',
    person: 'ethan-mollick',
    display_name: BSKY_NAME,
    platform: 'bluesky',
    handle: BSKY_DID,
    discovery_url: '',
    cursor_published_at: null,
    backfill_floor: dayOf(BSKY_DAYS + 10),
    backfill_complete: false,
    exclude_shorts: true,
    poll_interval_hours: 24,
    last_checked_at: null,
    blocked_at: null,
  };

  const walk = async (options: Partial<Parameters<typeof walkAuthorFeed>[1]> = {}) => {
    const days: DayBody[] = [];
    const fetcher = fakeFetcher(blueskyRoutes());
    const outcome = await walkAuthorFeed(
      source,
      {
        fetcher,
        pause: async () => {},
        now: NOW,
        until: new Date(`${source.backfill_floor}T00:00:00Z`),
        ...options,
      },
      async (day) => {
        days.push(day);
      },
    );
    return { outcome, days, fetcher };
  };

  /**
   * **Read-once assumes an Item is immutable, and this makes the assumption true by
   * construction rather than true in practice.** A day that can still change is not yet an
   * Item, so nothing has to detect one changing.
   */
  it('never batches the current UTC day', async () => {
    const { days } = await walk();
    assert.equal(days.some((day) => day.publishedAt === dayOf(0)), false);
    assert.equal(days.length, BSKY_CLOSED_DAYS);
  });

  it('hands back every closed day newest first, so an interrupted run has the recent half', async () => {
    const { days } = await walk();
    assert.deepEqual(
      days.map((day) => day.publishedAt),
      Array.from({ length: BSKY_CLOSED_DAYS }, (_, index) => dayOf(index + 1)),
    );
  });

  /**
   * A day sitting on a page boundary is incomplete until the next page proves it is not —
   * and an incomplete day written as an Item would be read once, permanently, half-missing.
   */
  it('never writes a day until nothing older can be added to it', async () => {
    const { days } = await walk();
    for (const day of days) {
      assert.equal(
        storedPosts(day.raw).length,
        postsOnDay(Number(daysBack(day.publishedAt))),
        `${day.publishedAt} was written with the wrong number of posts in it`,
      );
    }
  });

  it('reads a hundred posts a call, so a whole account costs a handful of requests', async () => {
    const { outcome } = await walk();
    assert.equal(outcome.requests, Math.ceil(BSKY_TOTAL_ENTRIES / FEED_PAGE_SIZE));
    assert.equal(outcome.posts, readablePosts(0));
    assert.equal(outcome.reachedEnd, true);
  });

  it('stops at the floor rather than reading an archive nobody asked for', async () => {
    const floor = dayOf(10);
    const { outcome, days } = await walk({ until: new Date(`${floor}T00:00:00Z`) });

    assert.equal(outcome.reachedEnd, true);
    assert.deepEqual(days[days.length - 1]!.publishedAt, floor);
    assert.ok(outcome.requests < Math.ceil(BSKY_TOTAL_ENTRIES / FEED_PAGE_SIZE));
  });

  it('takes the first page from the poll rather than fetching it twice', async () => {
    const { fetcher } = await walk({ polled: authorFeedPage('https://x/?cursor=0') });
    assert.equal(
      fetcher.requests.filter((url) => !url.includes('cursor=')).length,
      0,
      'the walk is the poll; asking for page one again would be paying twice for it',
    );
  });

  it('writes nothing partial when it is asked to stop', async () => {
    let seen = 0;
    const { outcome, days } = await walk({ stopping: () => ++seen > 1 });

    assert.equal(outcome.stopped, true);
    assert.equal(outcome.reachedEnd, false);
    assert.ok(days.length > 0 && days.length < BSKY_CLOSED_DAYS);
    for (const day of days) {
      assert.equal(storedPosts(day.raw).length, postsOnDay(Number(daysBack(day.publishedAt))));
    }
  });

  it('has a page rail well past any real account', () => {
    assert.ok(MAX_FEED_PAGES * FEED_PAGE_SIZE > 15_000);
  });

  function daysBack(day: string): number {
    return Math.round((NOW.getTime() - new Date(`${day}T12:00:00Z`).getTime()) / 86_400_000);
  }
});

describe('the permalink a citation resolves to', () => {
  /**
   * bsky.app resolves both forms, and a handle is a domain somebody can stop renting —
   * so the citation carries the DID. *Dated and cited back to what they actually published*
   * is the product, and a citation that stops resolving is one braintrust cannot defend.
   */
  it('carries the DID rather than the handle, so it survives a rename', () => {
    assert.equal(postUrl(BSKY_DID, '3l0010'), `https://bsky.app/profile/${BSKY_DID}/post/3l0010`);
  });

  it('is built from the record uri braintrust was given', () => {
    const posts = readAuthorFeed(JSON.stringify({ feed: [allEntries()[0]] }), BSKY_DID).posts;
    assert.equal(posts[0]!.url, postUrl(BSKY_DID, posts[0]!.rkey));
  });
});

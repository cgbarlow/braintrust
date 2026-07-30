/**
 * Call 1: the Plan.
 *
 * Two properties matter more than the numbers. Every number carries `measured` or
 * `estimated`, because a Plan is the surface a human approves and an unlabelled
 * figure invites more trust than it has earned. And `will_skip_paywalled` is there
 * *before* anything is fetched, so someone sees that most of a corpus will never be
 * read while they can still say no.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPlan, RETRIEVAL_SPACING_SECONDS } from '../src/follow/plan.js';
import { DEFAULT_SETTINGS } from '../src/sources/types.js';
import {
  CHANNEL_ID,
  NOW,
  SUBSTACK_FREE,
  SUBSTACK_HOST,
  SUBSTACK_IN_WINDOW,
  SUBSTACK_PAYWALLED,
  YOUTUBE_FEED_ENTRIES,
  fakeFetcher,
  natesRoutes,
} from './support/sources.js';

const LINKS = [`https://${SUBSTACK_HOST}/p/use-ai-sensitive-files`, '@NateBJones'];

/** No waiting between archive pages in tests; the pause is politeness, not logic. */
const deps = (fetcher = fakeFetcher(natesRoutes())) => ({
  fetcher,
  now: NOW,
  pause: async () => {},
});

/** 1.5 videos a day across a 365.5-day window. */
const YOUTUBE_ESTIMATE = 548;

describe('the plan', () => {
  it('proposes a name, and marks it as a proposal by asking for confirmation', async () => {
    const { plan, proposedName } = await buildPlan(LINKS, [], deps());

    assert.equal(plan.person, 'Nate B. Jones');
    assert.equal(proposedName, 'Nate B. Jones');
    // Neither feed's own name is the person's name, and both are shown so a human can see that.
    assert.equal(plan.sources[0]!.feed_title, "Nate's Substack");
    assert.equal(plan.sources[1]!.feed_title, 'AI News & Strategy Daily | Nate B Jones');
  });

  it('measures Substack exactly, because audience and post_date arrive with the catalogue', async () => {
    const { plan } = await buildPlan(LINKS, [], deps());
    const substack = plan.sources[0]!;

    assert.equal(substack.platform, 'substack');
    assert.equal(substack.items.basis, 'measured');
    assert.equal(substack.items.count, SUBSTACK_IN_WINDOW);
    assert.equal(substack.will_skip_paywalled, SUBSTACK_PAYWALLED);
  });

  it('counts founding-tier posts as paywalled, since the filter is an allow-list', async () => {
    const { plan } = await buildPlan(LINKS, [], deps());
    // 45 of 60 are only_paid or founding. A deny-list built from `only_paid` alone
    // would have ingested the 15 founding posts.
    assert.equal(plan.sources[0]!.will_skip_paywalled, 45);
    assert.equal(plan.sources[0]!.items.count - plan.sources[0]!.will_skip_paywalled!, SUBSTACK_FREE);
  });

  it('extrapolates YouTube from the publish rate, and says so', async () => {
    const { plan } = await buildPlan(LINKS, [], deps());
    const youtube = plan.sources[1]!;

    assert.equal(youtube.handle, CHANNEL_ID);
    assert.equal(youtube.items.basis, 'estimated');
    assert.equal(youtube.items.count, YOUTUBE_ESTIMATE);
    assert.equal(youtube.items.how, `1.5/day observed across ${YOUTUBE_FEED_ENTRIES} dated feed entries`);
    // Always public: reporting a paywall count of zero would read as a measurement.
    assert.equal(youtube.will_skip_paywalled, undefined);
  });

  it('labels every number in the plan', async () => {
    const { plan } = await buildPlan(LINKS, [], deps());

    for (const source of plan.sources) {
      assert.ok(['measured', 'estimated'].includes(source.items.basis));
      assert.ok(source.items.how, `${source.platform} should say how it got its count`);
    }
    // The duration is a number too, and its key names it an estimate.
    assert.ok(plan.estimated_duration_min > 0);
    assert.match(plan.estimated_duration_how, /at 4s per item/);
  });

  it('prices the wait per item, which is what the job actually spends', async () => {
    const { plan } = await buildPlan(LINKS, [], deps());

    // The 4s spacing sits between Items, not between requests — a video's date, caption
    // list and track go out back-to-back. Pricing the requests instead would tell the
    // person approving this that a 12-month backfill takes twice as long as it does.
    const items = YOUTUBE_ESTIMATE + SUBSTACK_FREE;
    assert.equal(plan.estimated_duration_min, Math.ceil((items * RETRIEVAL_SPACING_SECONDS) / 60));

    // The date fetches are still named: they are traffic the operator is agreeing to.
    const dateFetches = YOUTUBE_ESTIMATE - YOUTUBE_FEED_ENTRIES;
    assert.match(plan.estimated_duration_how, new RegExp(`${dateFetches} publish-date fetches alongside`));
    assert.match(plan.estimated_duration_how, new RegExp(`${SUBSTACK_FREE} posts`));
    assert.match(plan.estimated_duration_how, new RegExp(`${YOUTUBE_ESTIMATE} videos`));
  });

  it('keeps the link as pasted, so a wrong resolution is visible here', async () => {
    const { plan } = await buildPlan(LINKS, [], deps());

    assert.equal(plan.sources[0]!.resolved_from, LINKS[0]);
    assert.equal(plan.sources[1]!.resolved_from, '@NateBJones');
  });

  it('states the paywall line as a fact rather than a setting', async () => {
    const { plan } = await buildPlan(LINKS, [], deps());
    assert.match(plan.paywall, /never ingested/);
    assert.match(plan.paywall, /Not configurable/);
  });

  it('stops paging the archive at the backfill floor', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    await buildPlan([`https://${SUBSTACK_HOST}`], [], deps(fetcher));

    const archiveCalls = fetcher.requests.filter((url) => url.includes('/api/v1/archive'));
    // 60 in-window posts at 50 to a page: two pages, and the second one crosses the
    // floor. The 10 older posts are never paged past.
    assert.equal(archiveCalls.length, 2);
  });
});

describe('defaults and overrides', () => {
  it('takes the DDL defaults when nothing is said', async () => {
    const { plan, planned } = await buildPlan(LINKS, [], deps());

    assert.deepEqual(plan.overrides_applied, []);
    assert.equal(plan.window_months, DEFAULT_SETTINGS.windowMonths);
    for (const source of plan.sources) {
      assert.equal(source.settings.window_months, DEFAULT_SETTINGS.windowMonths);
      assert.equal(source.settings.exclude_shorts, DEFAULT_SETTINGS.excludeShorts);
      assert.equal(source.settings.poll_interval_hours, DEFAULT_SETTINGS.pollIntervalHours);
    }
    // A 12-month window from 2026-07-29.
    assert.equal(planned[0]!.backfillFloor, '2025-07-29');
  });

  it('applies an override to one platform and reports it in the plan', async () => {
    const { plan, planned } = await buildPlan(
      LINKS,
      [{ platform: 'youtube', window_months: 3, exclude_shorts: false, poll_interval_hours: 6 }],
      deps(),
    );

    assert.deepEqual(plan.overrides_applied, [
      `youtube ${CHANNEL_ID}: window_months 12 → 3`,
      `youtube ${CHANNEL_ID}: exclude_shorts true → false`,
      `youtube ${CHANNEL_ID}: poll_interval_hours 24 → 6`,
    ]);

    assert.equal(plan.sources[0]!.settings.window_months, 12);
    assert.equal(plan.sources[1]!.settings.window_months, 3);
    assert.equal(planned[1]!.backfillFloor, '2026-04-29');
    // Two sources, two windows, so there is no one window to report at the top.
    assert.equal(plan.window_months, undefined);
  });

  it('shrinks the estimate when the window shrinks', async () => {
    const wide = await buildPlan(['@NateBJones'], [], deps());
    const narrow = await buildPlan(['@NateBJones'], [{ platform: 'youtube', window_months: 1 }], deps());

    assert.ok(
      narrow.plan.sources[0]!.items.count < wide.plan.sources[0]!.items.count / 10,
      'a one-month window should be about a twelfth of a twelve-month one',
    );
  });

  it('refuses an override that matches no source, instead of quietly doing nothing', async () => {
    await assert.rejects(
      () => buildPlan([`https://${SUBSTACK_HOST}`], [{ platform: 'youtube', window_months: 3 }], deps()),
      /no such source came out of those links/,
    );
  });

  it('refuses a nonsense window', async () => {
    await assert.rejects(
      () => buildPlan(LINKS, [{ platform: 'youtube', window_months: 0 }], deps()),
      /window_months must be a whole number/,
    );
  });
});

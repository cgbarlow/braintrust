/**
 * Substack's two per-platform layers: the catalogue walk and the body.
 *
 * The paywall line lives here and nowhere else worth trusting: `audience` arrives with
 * the catalogue, so a paid post is known to be paid *before* braintrust asks for a word
 * of it, and it is checked a second time against the post itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaywallChanged, retrieveSubstackPost, walkArchive } from '../src/ingest/substack.js';
import type { ArchiveItem, SourceRow } from '../src/ingest/items.js';
import { MAX_BACKOFF_MS, fetchPolitely } from '../src/ingest/pace.js';
import {
  SUBSTACK_ARCHIVE,
  SUBSTACK_BODY_TEXT,
  SUBSTACK_HOST,
  SUBSTACK_IN_WINDOW,
  SUBSTACK_PAYWALLED,
  fakeFetcher,
  natesRoutes,
} from './support/sources.js';

const source = {
  id: 'source-1',
  person: 'nate-b-jones',
  platform: 'substack',
  handle: SUBSTACK_HOST,
  discovery_url: `https://${SUBSTACK_HOST}/feed`,
  backfill_floor: '2025-07-29',
  backfill_complete: false,
} as SourceRow;

const deps = (fetcher = fakeFetcher(natesRoutes())) => ({ fetcher, pause: async () => {} });

describe('walking the archive', () => {
  it('stops at the backfill floor rather than taking the whole history', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const seen: ArchiveItem[] = [];

    const outcome = await walkArchive(source, deps(fetcher), async (item) => void seen.push(item));

    assert.equal(outcome.reachedFloor, true);
    assert.equal(seen.length, SUBSTACK_IN_WINDOW);
    assert.equal(outcome.pages, 2);
    // The ten older posts exist in the fixture and are never touched.
    assert.ok(SUBSTACK_ARCHIVE.length > SUBSTACK_IN_WINDOW);
    assert.ok(!seen.some((item) => item.externalId.startsWith('old-')));
  });

  it('is an allow-list: only_paid and founding are both paid', async () => {
    const seen: ArchiveItem[] = [];
    await walkArchive(source, deps(), async (item) => void seen.push(item));

    const paid = seen.filter((item) => item.audience === 'paid');
    assert.equal(paid.length, SUBSTACK_PAYWALLED);
    assert.equal(seen.filter((item) => item.audience === 'everyone').length, 15);
    // Nothing keeps the raw platform value: the DDL only accepts everyone/paid/unknown.
    assert.ok(!seen.some((item) => ['only_paid', 'founding'].includes(item.audience)));
  });

  it('keys items by the same slug discovery uses, so the two paths write one row', async () => {
    const seen: ArchiveItem[] = [];
    await walkArchive(source, deps(), async (item) => void seen.push(item));

    assert.equal(seen[0]!.externalId, 'post-0');
    assert.equal(seen[0]!.url, `https://${SUBSTACK_HOST}/p/post-0`);
    assert.ok(seen[0]!.publishedAt instanceof Date);
  });

  it('stops early when the caller has what it came for', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const seen: ArchiveItem[] = [];

    const outcome = await walkArchive(
      source,
      deps(fetcher),
      async (item) => void seen.push(item),
      () => seen.length >= 3,
    );

    assert.equal(seen.length, 3);
    assert.equal(outcome.reachedFloor, false);
    // One page, because it never needed a second.
    assert.equal(fetcher.requests.filter((url) => url.includes('/archive')).length, 1);
  });

  it('refuses a response that is not a list of posts', async () => {
    const fetcher = fakeFetcher([
      { match: (url) => url.includes('/archive'), body: '{"error":"nope"}' },
    ]);

    await assert.rejects(
      () => walkArchive(source, deps(fetcher), async () => {}),
      /returned something other than a list/,
    );
  });
});

describe('retrieving a body', () => {
  it('takes the text out of body_html and drops the subscribe widget', async () => {
    const body = await retrieveSubstackPost(source, 'post-0', deps());

    assert.equal(body.text, SUBSTACK_BODY_TEXT('Post 0'));
    assert.equal(body.raw.platform, 'substack');
    assert.equal(body.raw.audience, 'everyone');
    // The markup is kept, so a better extractor later never means a second fetch.
    assert.match(body.raw.html, /subscription-widget/);
    assert.equal(body.raw.wordcount, 12);
  });

  it('asks the body endpoint, not the 338KB public page', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    await retrieveSubstackPost(source, 'post-0', deps(fetcher));

    assert.deepEqual(fetcher.requests, [`https://${SUBSTACK_HOST}/api/v1/posts/post-0`]);
  });

  it('refuses a post that has turned paid since the catalogue said otherwise', async () => {
    // post-1 is only_paid in the fixture. Nothing in the cycle would ask for it — this is
    // the second line of defence, for the case where a post changed in between.
    await assert.rejects(
      () => retrieveSubstackPost(source, 'post-1', deps()),
      (error: Error) => {
        assert.ok(error instanceof PaywallChanged);
        assert.match(error.message, /only_paid now/);
        return true;
      },
    );
  });

  it('will not store a post that came back without a body', async () => {
    const fetcher = fakeFetcher([
      {
        match: (url) => url.includes('/api/v1/posts/'),
        body: JSON.stringify({ slug: 'x', audience: 'everyone', body_html: null }),
      },
    ]);

    await assert.rejects(() => retrieveSubstackPost(source, 'x', deps(fetcher)), /without a body/);
  });

  it('will not store markup that has no text in it', async () => {
    const fetcher = fakeFetcher([
      {
        match: (url) => url.includes('/api/v1/posts/'),
        body: JSON.stringify({ slug: 'x', audience: 'everyone', body_html: '<div><br></div>' }),
      },
    ]);

    await assert.rejects(() => retrieveSubstackPost(source, 'x', deps(fetcher)), /no text in it/);
  });
});

describe('being asked to slow down', () => {
  it('waits the requested time and retries the same item once', async () => {
    let attempts = 0;
    const waited: number[] = [];
    const fetcher = fakeFetcher([
      {
        match: () => true,
        respond: () =>
          ++attempts === 1
            ? { status: 429, body: 'slow down', headers: { 'retry-after': '3' } }
            : { status: 200, body: 'the body' },
      },
    ]);

    const body = await fetchPolitely(fetcher, 'https://x/y', 'a thing', {
      pause: async (ms) => void waited.push(ms),
    });

    assert.equal(body, 'the body');
    assert.equal(attempts, 2);
    // Retry-After is in seconds, and braintrust honours it rather than picking its own.
    assert.deepEqual(waited, [3000]);
  });

  it('caps how long it will be told to wait', async () => {
    const waited: number[] = [];
    const fetcher = fakeFetcher([
      {
        match: () => true,
        respond: () => ({ status: 429, body: '', headers: { 'retry-after': '86400' } }),
      },
    ]);

    await assert.rejects(
      () => fetchPolitely(fetcher, 'https://x/y', 'a thing', { pause: async (ms) => void waited.push(ms) }),
      /asked braintrust to slow down twice/,
    );
    assert.deepEqual(waited, [MAX_BACKOFF_MS]);
  });

  it('leaves a source that keeps saying no for the next run', async () => {
    const fetcher = fakeFetcher([{ match: () => true, respond: () => ({ status: 429, body: '' }) }]);

    await assert.rejects(
      () => fetchPolitely(fetcher, 'https://x/y', 'a thing', { pause: async () => {} }),
      /Leaving it for the next run/,
    );
    // Twice, not forever: braintrust does not sit in a retry loop against a source.
    assert.equal(fetcher.requests.length, 2);
  });
});

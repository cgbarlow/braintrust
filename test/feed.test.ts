/**
 * Discovery, the one generic layer.
 *
 * The claim being tested is that one reader serves both platforms — that "adding a
 * third RSS-publishing source is a config entry" is true of this code and not just of
 * the design doc.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { feedSkippedAhead, newestPublished, readFeed } from '../src/ingest/feed.js';
import { NOW, SUBSTACK_FEED, SUBSTACK_HOST, YOUTUBE_FEED, YOUTUBE_FEED_ENTRIES } from './support/sources.js';

describe('one reader, both platforms', () => {
  it('reads Substack RSS: 20 items, each with a slug and a date', () => {
    const { feedTitle, entries } = readFeed(SUBSTACK_FEED, 'substack');

    assert.equal(feedTitle, "Nate's Substack");
    assert.equal(entries.length, 20);
    assert.equal(entries[0]!.externalId, 'post-0');
    assert.equal(entries[0]!.url, `https://${SUBSTACK_HOST}/p/post-0`);
    assert.ok(entries.every((entry) => entry.publishedAt instanceof Date));
    // No body at discovery, on either platform. Retrieval is always a separate step.
    assert.deepEqual(Object.keys(entries[0]!).sort(), ['externalId', 'publishedAt', 'title', 'url']);
  });

  it('reads YouTube Atom: 15 entries keyed by videoId', () => {
    const { feedTitle, entries } = readFeed(YOUTUBE_FEED, 'youtube');

    assert.equal(feedTitle, 'AI News & Strategy Daily | Nate B Jones');
    assert.equal(entries.length, YOUTUBE_FEED_ENTRIES);
    assert.equal(entries[0]!.externalId, 'vid00000000');
    assert.ok(entries.every((entry) => entry.publishedAt instanceof Date));
  });

  it('never mistakes the newest post title for the feed title', () => {
    // A feed with no channel title of its own. Looking for the first <title> anywhere
    // would report "Newest post" as the publication's name.
    const untitled = `<rss><channel><link>https://x.substack.com</link>
      <item><title>Newest post</title><link>https://x.substack.com/p/newest</link></item>
    </channel></rss>`;

    const { feedTitle, entries } = readFeed(untitled, 'substack');
    assert.equal(feedTitle, undefined);
    assert.equal(entries[0]!.title, 'Newest post');
  });

  it('drops an entry it cannot identify rather than inventing a key', () => {
    const broken = `<rss><channel><title>X</title>
      <item><title>No guid and no link</title><pubDate>Wed, 01 Jul 2026 00:00:00 GMT</pubDate></item>
      <item><title>Fine</title><link>https://x.substack.com/p/fine</link></item>
    </channel></rss>`;

    const { entries } = readFeed(broken, 'substack');
    assert.deepEqual(
      entries.map((entry) => entry.externalId),
      ['fine'],
    );
  });

  it('takes the slug from a guid even when the link is missing', () => {
    const feed = `<rss><channel><item>
      <guid isPermaLink="false">https://x.substack.com/p/use-ai-sensitive-files</guid>
    </item></channel></rss>`;

    assert.equal(readFeed(feed, 'substack').entries[0]!.externalId, 'use-ai-sensitive-files');
  });
});

describe('the cursor and the gap', () => {
  const { entries } = readFeed(SUBSTACK_FEED, 'substack');

  it('advances the cursor to the newest thing in the feed', () => {
    const newest = newestPublished(entries)!;
    // Two days before the fixture clock, which is the newest post in the archive.
    assert.equal(newest.toISOString().slice(0, 10), '2026-07-27');
  });

  it('sees no gap when the cursor is inside the window the feed still holds', () => {
    const insideWindow = new Date(NOW.getTime() - 30 * 86_400_000);
    assert.equal(feedSkippedAhead(entries, insideWindow), false);
  });

  it('detects a gap when every entry is newer than the cursor', () => {
    // The feed holds 20 posts spanning ~114 days; a cursor a year old means posts
    // published in between aged out of the feed and were never seen.
    const longAgo = new Date(NOW.getTime() - 365 * 86_400_000);
    assert.equal(feedSkippedAhead(entries, longAgo), true);
  });

  it('does not call a first-ever poll a gap', () => {
    // Nothing has been seen, so the backfill is the answer rather than a repair.
    assert.equal(feedSkippedAhead(entries, null), false);
  });
});

/**
 * YouTube's two per-platform layers: the channel walk and the captions.
 *
 * The measured facts these tests pin, all from 2026-07-30 against the live channel:
 * the listing pages 30 at a time and dates nothing precisely; the caption track comes
 * from the player endpoint rather than the watch page HTML; and one player call answers
 * both "how long is this" and "when was it published", which is what lets a Short be
 * excluded before ~500KB is spent on its transcript.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ArchiveItem, SourceRow } from '../src/ingest/items.js';
import {
  NoCaptions,
  coarseDate,
  parseTimecode,
  readListing,
  retrieveYoutubeCaptions,
  videoMetadata,
  walkChannel,
} from '../src/ingest/youtube.js';
import {
  CHANNEL_ID,
  NOW,
  YOUTUBE_LISTING_IN_WINDOW,
  YOUTUBE_LISTING_OLDER,
  YOUTUBE_LISTING_PAGE,
  YOUTUBE_NO_CAPTIONS,
  YOUTUBE_SHORT_IN_LISTING,
  YOUTUBE_SHORT_WITHOUT_BADGE,
  captionText,
  durationOf,
  fakeFetcher,
  listingPage,
  natesRoutes,
  publishedOf,
  videoId,
} from './support/sources.js';

const source = {
  id: 'source-1',
  person: 'nate-b-jones',
  platform: 'youtube',
  handle: CHANNEL_ID,
  discovery_url: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
  backfill_floor: '2025-07-29',
  backfill_complete: false,
  exclude_shorts: true,
} as SourceRow;

const deps = (fetcher = fakeFetcher(natesRoutes())) => ({
  fetcher,
  pause: async () => {},
  now: () => NOW,
});

describe('walking the channel listing', () => {
  it('follows continuations 30 at a time', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const seen: ArchiveItem[] = [];

    const outcome = await walkChannel(source, deps(fetcher), async (item) => void seen.push(item));

    assert.equal(seen.length, YOUTUBE_LISTING_IN_WINDOW);
    assert.equal(outcome.reachedFloor, true);
    // 80 videos, 30 to a page.
    assert.equal(outcome.pages, 3);
    assert.equal(fetcher.requests.filter((url) => url.endsWith('/browse')).length, 3);
  });

  it('asks for the channel by id on the first page and by token after it', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    await walkChannel(source, deps(fetcher), async () => {});

    const browses = fetcher.sent.filter((request) => request.url.endsWith('/browse'));
    assert.equal(browses[0]!.json.browseId, CHANNEL_ID);
    assert.equal(browses[1]!.json.continuation, 'page-1');
    assert.equal(browses[1]!.json.browseId, undefined, 'a continuation carries nothing else');
    // A browse without a client context is an HTTP 400 from the live endpoint.
    assert.ok(browses.every((request) => request.json.context.client.clientName));
  });

  it('leaves the videos that are unambiguously older than the floor', async () => {
    const seen: ArchiveItem[] = [];
    await walkChannel(source, deps(), async (item) => void seen.push(item));

    assert.ok(YOUTUBE_LISTING_OLDER > 0);
    assert.ok(!seen.some((item) => item.externalId === videoId(YOUTUBE_LISTING_IN_WINDOW)));
    assert.ok(seen.some((item) => item.externalId === videoId(YOUTUBE_LISTING_IN_WINDOW - 1)));
  });

  it('writes no publish date at all, because the listing only has "3 months ago"', async () => {
    const seen: ArchiveItem[] = [];
    await walkChannel(source, deps(), async (item) => void seen.push(item));

    // An approximate date stored as if measured would poison every dated Position.
    assert.ok(seen.every((item) => item.publishedAt === undefined));
    assert.ok(seen.every((item) => item.audience === 'everyone'));
    assert.equal(seen[0]!.url, `https://www.youtube.com/watch?v=${videoId(0)}`);
    assert.equal(seen[0]!.title, 'Video 0');
  });

  it('carries the duration where the listing measured one, so a short costs nothing', async () => {
    const seen: ArchiveItem[] = [];
    await walkChannel(source, deps(), async (item) => void seen.push(item));

    const short = seen.find((item) => item.externalId === videoId(YOUTUBE_SHORT_IN_LISTING))!;
    assert.equal(short.durationSeconds, durationOf(YOUTUBE_SHORT_IN_LISTING));

    // Not every entry carries a badge, and the walk does not pretend otherwise.
    const unbadged = seen.find((item) => item.externalId === videoId(YOUTUBE_SHORT_WITHOUT_BADGE))!;
    assert.equal(unbadged.durationSeconds, undefined);
  });

  it('stops early when the caller has what it came for', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const seen: ArchiveItem[] = [];

    const outcome = await walkChannel(
      source,
      deps(fetcher),
      async (item) => void seen.push(item),
      () => seen.length >= 5,
    );

    assert.equal(seen.length, 5);
    assert.equal(outcome.reachedFloor, false);
    assert.equal(fetcher.requests.filter((url) => url.endsWith('/browse')).length, 1);
  });

  it('says so loudly when the response shape is one it cannot read', async () => {
    const fetcher = fakeFetcher([{ match: (url) => url.endsWith('/browse'), body: '{"contents":{}}' }]);

    // YouTube renames its renderers. Walking zero videos silently would read as an
    // empty channel and quietly halve a Corpus.
    await assert.rejects(
      () => walkChannel(source, deps(fetcher), async () => {}),
      /could not read the YouTube listing at all/,
    );
  });

  // A channel with no videos has no Videos tab: YouTube answers the same browse with
  // Home instead. Measured 2026-08-05 against UC05PHiH74VWHuqh_AF9h21Q, which braintrust
  // had been recording as a failed fetch and retrying every night for as long as anyone
  // followed that person.
  const EMPTY_CHANNEL = JSON.stringify({
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { title: 'Home', selected: true, content: { sectionListRenderer: {} } } }],
      },
    },
  });

  it('reads a channel with no videos as empty rather than unreadable', () => {
    const listing = readListing(EMPTY_CHANNEL);

    assert.deepEqual(listing.videos, []);
    assert.equal(listing.empty, true);
  });

  it('finishes the backfill of an empty channel instead of failing it', async () => {
    const fetcher = fakeFetcher([{ match: (url) => url.endsWith('/browse'), body: EMPTY_CHANNEL }]);

    const outcome = await walkChannel(source, deps(fetcher), async () => {
      assert.fail('an empty channel has nothing to record');
    });

    assert.equal(outcome.seen, 0);
    // The half that matters: a source that reached the end of a listing it could read
    // has completed its backfill, and there is nothing here to come back for tomorrow.
    assert.equal(outcome.reachedFloor, true);
  });

  it('refuses a listing that is not JSON', () => {
    assert.throws(() => readListing('<html>consent page</html>'), /did not return JSON/);
  });

  it('reads both response shapes: a tab on page one, an append after it', () => {
    const first = readListing(listingPage(0));
    const second = readListing(listingPage(1));

    assert.equal(first.videos.length, YOUTUBE_LISTING_PAGE);
    assert.equal(first.continuation, 'page-1');
    assert.equal(second.videos.length, YOUTUBE_LISTING_PAGE);
    assert.equal(second.videos[0]!.videoId, videoId(YOUTUBE_LISTING_PAGE));
  });

  it('reads the last page as the end, with no continuation to follow', () => {
    const last = readListing(listingPage(2));

    assert.equal(last.videos.length, YOUTUBE_LISTING_IN_WINDOW + YOUTUBE_LISTING_OLDER - 60);
    assert.equal(last.continuation, undefined);
  });
});

describe('the metadata call', () => {
  it('buys a publish date and a duration for ~15KB, where the watch page costs 1.3MB', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const metadata = await videoMetadata(videoId(20), deps(fetcher));

    assert.equal(metadata.publishedAt!.toISOString(), publishedOf(20).toISOString());
    assert.equal(metadata.durationSeconds, durationOf(20));
    // The player endpoint, not the watch page.
    assert.deepEqual(fetcher.requests, ['https://www.youtube.com/youtubei/v1/player']);
  });

  it('takes the date even though the response says the video is unplayable', async () => {
    // Measured: the WEB client is refused for playback and answers with the date anyway.
    const fetcher = fakeFetcher(natesRoutes());
    await videoMetadata(videoId(20), deps(fetcher));

    assert.equal(fetcher.sent[0]!.json.context.client.clientName, 'WEB');
  });
});

describe('retrieving captions', () => {
  it('reads the track the player names, not the one printed in the watch page', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const result = await retrieveYoutubeCaptions(videoId(0), deps(fetcher));

    assert.ok(!('tooShort' in result));
    assert.equal(result.text, captionText(0));
    assert.equal(result.raw.kind, 'asr');
    assert.equal(result.raw.language, 'en');
    assert.equal(result.durationSeconds, durationOf(0));

    // Two requests: the player, then the track. The watch page is never fetched —
    // the timedtext URL printed in it returns a zero-byte body.
    assert.equal(fetcher.requests.length, 2);
    assert.ok(fetcher.requests[1]!.includes('/api/timedtext'));
    assert.ok(fetcher.requests[1]!.includes('fmt=json3'));
    assert.ok(!fetcher.requests.some((url) => url.includes('/watch?v=')));
  });

  it('names the iOS client, which is the one that hands over caption tracks', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    await retrieveYoutubeCaptions(videoId(0), deps(fetcher));

    assert.equal(fetcher.sent[0]!.json.context.client.clientName, 'IOS');
  });

  it('keeps the timings rather than only the words', async () => {
    const result = await retrieveYoutubeCaptions(videoId(0), deps());
    assert.ok(!('tooShort' in result));

    assert.equal(result.raw.segments.length, 4);
    assert.equal(result.raw.segments[0]!.at, 0);
    assert.equal(result.raw.video_id, videoId(0));
  });

  it('stops at the duration when the video is a short, before asking for the track', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const result = await retrieveYoutubeCaptions(videoId(YOUTUBE_SHORT_WITHOUT_BADGE), deps(fetcher), {
      excludeShorts: true,
    });

    assert.deepEqual(result, { tooShort: durationOf(YOUTUBE_SHORT_WITHOUT_BADGE) });
    // One request, and it is not the captions.
    assert.equal(fetcher.requests.length, 1);
    assert.ok(!fetcher.requests.some((url) => url.includes('/api/timedtext')));
  });

  it('reads a short when the operator asked for shorts', async () => {
    const result = await retrieveYoutubeCaptions(videoId(YOUTUBE_SHORT_WITHOUT_BADGE), deps(), {
      excludeShorts: false,
    });

    assert.ok(!('tooShort' in result));
    assert.equal(result.text, captionText(YOUTUBE_SHORT_WITHOUT_BADGE));
  });

  it('treats a video with no caption track as a fact about the video', async () => {
    await assert.rejects(
      () => retrieveYoutubeCaptions(videoId(YOUTUBE_NO_CAPTIONS), deps()),
      (error: Error) => {
        assert.ok(error instanceof NoCaptions);
        assert.match(error.message, /no caption track/);
        return true;
      },
    );
  });

  it('prefers a track a human wrote over one a model heard', async () => {
    const player = JSON.stringify({
      playabilityStatus: { status: 'OK' },
      videoDetails: { lengthSeconds: '1200' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://x/asr', languageCode: 'en', kind: 'asr' },
            { baseUrl: 'https://x/manual', languageCode: 'en' },
          ],
        },
      },
    });
    const fetcher = fakeFetcher([
      { match: (url) => url.endsWith('/player'), body: player },
      { match: (url) => url.startsWith('https://x/'), body: '{"events":[{"segs":[{"utf8":"written down"}]}]}' },
    ]);

    const result = await retrieveYoutubeCaptions('abc', deps(fetcher));
    assert.ok(!('tooShort' in result));
    assert.equal(result.raw.kind, 'manual');
    assert.ok(fetcher.requests[1]!.startsWith('https://x/manual'));
  });
});

describe('reading YouTube’s own labels', () => {
  it('parses a duration badge', () => {
    assert.equal(parseTimecode('20:17'), 1217);
    assert.equal(parseTimecode('0:45'), 45);
    assert.equal(parseTimecode('1:02:03'), 3723);
  });

  it('is not fooled by a badge that is not a duration', () => {
    for (const text of ['LIVE', 'Now playing', '', undefined, 12]) {
      assert.equal(parseTimecode(text), undefined);
    }
  });

  it('turns "3 months ago" into roughly when that was', () => {
    const three = coarseDate('3 months ago', NOW)!;
    assert.equal(Math.round((NOW.getTime() - three.getTime()) / 86_400_000), 90);
    assert.equal(coarseDate('19 hours ago', NOW)!.toISOString(), '2026-07-28T17:00:00.000Z');
    assert.equal(coarseDate('1 day ago', NOW)!.toISOString(), '2026-07-28T12:00:00.000Z');
  });

  it('has no opinion about a label it does not recognise', () => {
    assert.equal(coarseDate('Streamed live', NOW), undefined);
    assert.equal(coarseDate('7 fortnights ago', NOW), undefined);
  });
});

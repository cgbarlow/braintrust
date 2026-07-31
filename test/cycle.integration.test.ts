/**
 * The cycle against real Postgres: follow someone, then run the job.
 *
 * This is where the ticket's claims either hold or do not. The Backlog is a query over
 * rows, so "resumable by construction" is testable by stopping a run and starting
 * another one and looking at what is on disk in between — which is exactly what the
 * interruption test does.
 *
 * Skipped unless BRAINTRUST_TEST_DATABASE_URL is set. To run it locally:
 *
 *   docker run -d --name bt-pg -e POSTGRES_PASSWORD=bt -e POSTGRES_DB=braintrust \
 *     -p 55432:5432 pgvector/pgvector:pg16
 *   BRAINTRUST_TEST_DATABASE_URL=postgresql://postgres:bt@127.0.0.1:55432/braintrust \
 *     npm test
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createDb, type PostgresDb } from '../src/db.js';
import { followPerson, type PlanResponse } from '../src/follow/index.js';
import { createConfirmTokenStore } from '../src/follow/tokens.js';
import { runCycle, type CycleReport, type SourceReport } from '../src/ingest/cycle.js';
import { recordCatalogued, type SourceRow } from '../src/ingest/items.js';
import { createEmbedder } from '../src/retrieval/index.js';
import { RETRIEVAL_SPACING_MS } from '../src/sources/types.js';
import { fakeEmbeddings, testEmbeddingsConfig } from './support/embeddings.js';
import {
  NOW,
  SUBSTACK_BODY_TEXT,
  SUBSTACK_FREE,
  SUBSTACK_HOST,
  SUBSTACK_IN_WINDOW,
  SUBSTACK_PAYWALLED,
  YOUTUBE_FEED_ENTRIES,
  YOUTUBE_LISTING_IN_WINDOW,
  YOUTUBE_NO_CAPTIONS,
  YOUTUBE_SHORT_IN_LISTING,
  YOUTUBE_SHORT_WITHOUT_BADGE,
  captionText,
  fakeFetcher,
  natesRoutes,
  videoId,
  type FakeFetcher,
} from './support/sources.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const LINKS = [`https://${SUBSTACK_HOST}/p/post-0`, '@NateBJones'];

/** The Substack feed holds 20; the archive walk finds 60 in the twelve-month window. */
const FEED_ITEMS = 20;

/**
 * The YouTube half of one full run: 70 videos in the window, of which two are Shorts
 * (one the listing measured, one only the player did), one has no caption track, and
 * the rest are read.
 */
const YT_SHORTS = 2;
const YT_FAILED = 1;
const YT_RETRIEVED = YOUTUBE_LISTING_IN_WINDOW - YT_SHORTS - YT_FAILED;

/** The 55 the listing found beyond the feed's 15-entry window, each dated by a fetch. */
const YT_DATED = YOUTUBE_LISTING_IN_WINDOW - YOUTUBE_FEED_ENTRIES;

describe('the ingest cycle, against real Postgres', { skip }, () => {
  let db: PostgresDb;

  before(async () => {
    db = createDb(url!);
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (db) {
      await db.query('truncate braintrust_people cascade');
      await db.close();
    }
  });

  beforeEach(async () => {
    await db.query('truncate braintrust_people cascade');
  });

  /** Registration, which is #27's job and this test's setup. */
  async function follow(): Promise<void> {
    const deps = {
      db,
      tokens: createConfirmTokenStore(),
      fetcher: fakeFetcher(natesRoutes()),
      now: () => NOW,
      pause: async () => {},
    };
    const plan = (await followPerson({ links: LINKS }, deps)) as PlanResponse;
    await followPerson({ confirm_token: plan.confirm_token, display_name: 'Nate B. Jones' }, deps);
  }

  type RunOptions = {
    stopping?: () => boolean;
    now?: Date;
    fetcher?: FakeFetcher;
    /** Off by default: most of these tests are about what was fetched, not indexed. */
    embed?: boolean;
  };

  async function run(options: RunOptions = {}): Promise<{ report: CycleReport; fetcher: FakeFetcher }> {
    const fetcher = options.fetcher ?? fakeFetcher(natesRoutes());
    const report = await runCycle({
      db,
      fetcher,
      now: () => options.now ?? NOW,
      pause: async () => {},
      log: () => {},
      ...(options.embed ? { embedder: createEmbedder(testEmbeddingsConfig, fakeEmbeddings().fetcher) } : {}),
      ...(options.stopping ? { stopping: options.stopping } : {}),
    });
    return { report, fetcher };
  }

  const of = (report: CycleReport, platform: string): SourceReport =>
    report.sources.find((source) => source.platform === platform)!;

  async function items(where = 'true', params: unknown[] = []) {
    const { rows } = await db.query<{
      external_id: string;
      retrieval: string;
      audience: string;
      body_text: string | null;
      published_at: string | null;
      platform: string;
    }>(
      `select i.external_id, i.retrieval, i.audience, i.body_text,
              i.published_at::text as published_at, s.platform
         from braintrust_items i
         join braintrust_sources s on s.id = i.source_id
        where ${where}
        order by s.platform, i.external_id`,
      params,
    );
    return rows;
  }

  it('polls, backfills, retrieves the free posts and records the paywalled ones', async () => {
    await follow();
    const { report } = await run();

    const substack = of(report, 'substack');
    assert.equal(substack.discovered, FEED_ITEMS);
    assert.equal(substack.catalogued, SUBSTACK_IN_WINDOW);
    assert.equal(substack.skipped_paywall, SUBSTACK_PAYWALLED);
    assert.equal(substack.retrieved, SUBSTACK_FREE);
    assert.equal(substack.failed, 0);
    assert.equal(substack.backfill_complete, true);

    const rows = await items("s.platform = 'substack'");
    assert.equal(rows.length, SUBSTACK_IN_WINDOW);
    assert.equal(rows.filter((row) => row.retrieval === 'retrieved').length, SUBSTACK_FREE);
    assert.equal(rows.filter((row) => row.retrieval === 'skipped_paywall').length, SUBSTACK_PAYWALLED);
    assert.equal(rows.filter((row) => row.retrieval === 'pending').length, 0);
  });

  it('keeps a skipped post as a row, with no body, so Coverage can name it', async () => {
    await follow();
    await run();

    const skipped = (await items("i.retrieval = 'skipped_paywall'"))[0]!;
    // A row, not an absence — this is what lets a persona state its own blind spots.
    assert.equal(skipped.audience, 'paid');
    assert.equal(skipped.body_text, null);
    assert.ok(skipped.published_at, 'a skipped item still knows when it was published');
  });

  it('stores the text of a free post, extracted from the body endpoint', async () => {
    await follow();
    await run();

    const { rows } = await db.query<{ body_text: string; raw: { html: string; wordcount: number } }>(
      `select body_text, body_raw as raw from braintrust_items where external_id = 'post-0'`,
    );

    assert.equal(rows[0]!.body_text, SUBSTACK_BODY_TEXT('Post 0'));
    // The markup as served is kept, so a better extractor never costs a second fetch.
    assert.match(rows[0]!.raw.html, /subscription-widget/);
    assert.equal(rows[0]!.raw.wordcount, 12);
  });

  it('never asks for a paywalled post at all', async () => {
    await follow();
    const { fetcher } = await run();

    const bodyRequests = fetcher.requests.filter((request) => request.includes('/api/v1/posts/'));
    assert.equal(bodyRequests.length, SUBSTACK_FREE);
    // post-1, post-2 and post-3 are only_paid, only_paid and founding.
    for (const paid of ['post-1', 'post-2', 'post-3']) {
      assert.ok(
        !bodyRequests.some((request) => request.endsWith(paid)),
        `${paid} is paywalled and must never be requested`,
      );
    }
  });

  it('discovers YouTube through the same generic reader, then walks and reads it', async () => {
    await follow();
    const { report } = await run();

    const youtube = of(report, 'youtube');
    // The feed found 15; the channel walk found the other 55 in the same window.
    assert.equal(youtube.discovered, YOUTUBE_FEED_ENTRIES);
    assert.equal(youtube.catalogued, YOUTUBE_LISTING_IN_WINDOW);
    assert.equal(youtube.retrieved, YT_RETRIEVED);
    assert.equal(youtube.skipped_short, YT_SHORTS);
    assert.equal(youtube.failed, YT_FAILED);
    assert.equal(youtube.skipped_paywall, 0, 'YouTube has no paywall to respect');
    assert.equal(youtube.backfill_complete, true);

    const rows = await items("s.platform = 'youtube'");
    assert.equal(rows.length, YOUTUBE_LISTING_IN_WINDOW);
    assert.ok(rows.every((row) => row.audience === 'everyone'));
    assert.equal(rows.filter((row) => row.retrieval === 'pending').length, 0);
    // Every item ends up dated, whether the feed said so or a fetch had to ask.
    assert.ok(rows.every((row) => row.published_at !== null));
  });

  it('leaves the ten videos older than the floor alone', async () => {
    await follow();
    await run();

    const rows = await items("s.platform = 'youtube'");
    const ids = new Set(rows.map((row) => row.external_id));
    assert.ok(ids.has(videoId(YOUTUBE_LISTING_IN_WINDOW - 1)), 'the last in-window video is taken');
    assert.ok(!ids.has(videoId(YOUTUBE_LISTING_IN_WINDOW)), 'the first out-of-window video is not');
  });

  it('stores captions as prose, with the timings that make a citation checkable', async () => {
    await follow();
    await run();

    const { rows } = await db.query<{
      body_text: string;
      raw: { platform: string; kind: string; duration_seconds: number; segments: { at: number; text: string }[] };
    }>('select body_text, body_raw as raw from braintrust_items where external_id = $1', [videoId(0)]);

    const row = rows[0]!;
    assert.equal(row.body_text, captionText(0));
    // The rolling-window newline events are gone rather than sitting in the prose.
    assert.ok(!row.body_text.includes('\n'));
    assert.equal(row.raw.platform, 'youtube');
    assert.equal(row.raw.kind, 'asr', 'these are auto-captions and the row says so');
    assert.equal(row.raw.duration_seconds, 1200);
    // One start time per line: enough to link to a moment, without the per-word offsets.
    assert.equal(row.raw.segments.length, 4);
    assert.equal(row.raw.segments[0]!.at, 0);
    assert.equal(row.raw.segments[1]!.at, 4000);
  });

  it('dates the videos the feed never saw, and that is the only reason it fetches them twice', async () => {
    await follow();
    const { report, fetcher } = await run();

    assert.equal(of(report, 'youtube').dated, YT_DATED);

    // The WEB player is asked once per undated item and never for a dated one. The
    // listing walk speaks to the same client, so the endpoint is what distinguishes it.
    const metadataCalls = fetcher.sent.filter(
      (request) =>
        request.url.endsWith('/player') && request.json?.context?.client?.clientName === 'WEB',
    );
    assert.equal(metadataCalls.length, YT_DATED);
    assert.ok(!metadataCalls.some((call) => call.json.videoId === videoId(0)), 'the feed dated video 0');

    const dated = (await items('i.external_id = $1', [videoId(YOUTUBE_FEED_ENTRIES)]))[0]!;
    assert.ok(dated.published_at, 'a video only the listing found still ends up dated');
  });

  it('excludes a short before fetching its captions, whichever fetch measured it', async () => {
    await follow();
    const { fetcher } = await run();

    const listingShort = (await items('i.external_id = $1', [videoId(YOUTUBE_SHORT_IN_LISTING)]))[0]!;
    const playerShort = (await items('i.external_id = $1', [videoId(YOUTUBE_SHORT_WITHOUT_BADGE)]))[0]!;
    assert.equal(listingShort.retrieval, 'skipped_short');
    assert.equal(playerShort.retrieval, 'skipped_short');
    assert.equal(listingShort.body_text, null);

    // The one the listing measured cost nothing at all: no player call, no captions.
    assert.ok(
      !fetcher.sent.some((request) => request.json?.videoId === videoId(YOUTUBE_SHORT_IN_LISTING)),
      'a short the catalogue could measure is never asked about',
    );
    // The one without a badge cost a player call, and still no captions.
    const captionCalls = fetcher.requests.filter((request) => request.includes('/api/timedtext'));
    assert.ok(!captionCalls.some((request) => request.includes(videoId(YOUTUBE_SHORT_WITHOUT_BADGE))));
    assert.equal(captionCalls.length, YT_RETRIEVED);
  });

  it('brings the shorts back when the operator turns the rule off', async () => {
    await follow();
    await run();
    await db.query(`update braintrust_sources set exclude_shorts = false where platform = 'youtube'`);

    const { report } = await run({ now: new Date(NOW.getTime() + 25 * 3600_000) });
    const youtube = of(report, 'youtube');

    // No second crawl: the rows were always there, and now they are read.
    assert.equal(youtube.reopened_shorts, YT_SHORTS);
    assert.equal(youtube.retrieved, YT_SHORTS);

    const short = (await items('i.external_id = $1', [videoId(YOUTUBE_SHORT_IN_LISTING)]))[0]!;
    assert.equal(short.retrieval, 'retrieved');
    assert.equal(short.body_text, captionText(YOUTUBE_SHORT_IN_LISTING));
  });

  it('records a video with no captions as failed, not as something to retry', async () => {
    await follow();
    await run();

    const row = (await items('i.external_id = $1', [videoId(YOUTUBE_NO_CAPTIONS)]))[0]!;
    assert.equal(row.retrieval, 'failed');

    // Terminal: the next run leaves it alone rather than asking again forever.
    const { fetcher } = await run({ now: new Date(NOW.getTime() + 25 * 3600_000) });
    assert.ok(!fetcher.sent.some((request) => request.json?.videoId === videoId(YOUTUBE_NO_CAPTIONS)));
  });

  it('advances the cursor and marks the backfill done', async () => {
    await follow();
    await run();

    const { rows } = await db.query<{
      platform: string;
      cursor: Date | null;
      backfill_complete: boolean;
      last_checked_at: Date | null;
    }>(
      `select platform, cursor_published_at as cursor, backfill_complete, last_checked_at
         from braintrust_sources order by platform`,
    );

    const substack = rows.find((row) => row.platform === 'substack')!;
    assert.equal(substack.cursor!.toISOString().slice(0, 10), '2026-07-27');
    assert.equal(substack.backfill_complete, true);
    assert.equal(substack.last_checked_at!.toISOString(), NOW.toISOString());

    const youtube = rows.find((row) => row.platform === 'youtube')!;
    assert.equal(youtube.backfill_complete, true);
    // The newest feed entry, twelve hours before NOW.
    assert.equal(youtube.cursor!.toISOString(), new Date(NOW.getTime() - 12 * 3600_000).toISOString());
  });

  it('does nothing the second time, because the rows already say it is done', async () => {
    await follow();
    await run();
    const { report, fetcher } = await run({ now: new Date(NOW.getTime() + 25 * 3600_000) });

    const substack = of(report, 'substack');
    assert.equal(substack.discovered, 0);
    assert.equal(substack.retrieved, 0);
    assert.equal(substack.catalogued, 0);
    assert.deepEqual(report.rebuild_pending, []);

    // Two feeds and nothing else: no archive page, no body.
    assert.equal(fetcher.requests.filter((request) => request.includes('/api/v1/')).length, 0);
    assert.equal(fetcher.requests.length, 2);
  });

  it('respects poll_interval_hours without a second scheduler', async () => {
    await follow();
    await run();

    // An hour later nothing is due; a day later everything is.
    const soon = await run({ now: new Date(NOW.getTime() + 3600_000) });
    assert.equal(soon.report.sources.length, 0);
    assert.equal(soon.report.not_due, 2);

    const tomorrow = await run({ now: new Date(NOW.getTime() + 25 * 3600_000) });
    assert.equal(tomorrow.report.sources.length, 2);
  });

  it('is resumable: a run stopped halfway has written real rows', async () => {
    await follow();

    // Stop after three bodies, the way a platform timing out a cron run would.
    const fetcher = fakeFetcher(natesRoutes());
    const bodies = () => fetcher.requests.filter((request) => request.includes('/api/v1/posts/')).length;
    const first = await run({ fetcher, stopping: () => bodies() >= 3 });

    assert.equal(first.report.stopped_early, true);
    assert.equal(of(first.report, 'substack').retrieved, 3);
    // YouTube was never reached, so it is still due rather than quietly marked checked.
    assert.deepEqual(
      first.report.sources.map((source) => source.platform),
      ['substack'],
    );

    const midway = await items("s.platform = 'substack'");
    assert.equal(midway.filter((row) => row.retrieval === 'retrieved').length, 3);
    assert.equal(midway.filter((row) => row.retrieval === 'pending').length, SUBSTACK_FREE - 3);
    // The catalogue is on disk, so the second run does not walk the archive again.
    assert.equal(midway.filter((row) => row.retrieval === 'skipped_paywall').length, SUBSTACK_PAYWALLED);

    const second = await run({ now: new Date(NOW.getTime() + 25 * 3600_000) });
    assert.equal(of(second.report, 'substack').retrieved, SUBSTACK_FREE - 3);
    assert.equal(second.fetcher.requests.filter((request) => request.includes('/archive')).length, 0);

    const done = await items("s.platform = 'substack'");
    assert.equal(done.filter((row) => row.retrieval === 'pending').length, 0);
  });

  it('resumes a YouTube backfill killed partway, without walking the channel again', async () => {
    await follow();

    // Stop after five transcripts, the way a platform timing out a cron run would.
    const fetcher = fakeFetcher(natesRoutes());
    const captions = () => fetcher.requests.filter((request) => request.includes('/api/timedtext')).length;
    const first = await run({ fetcher, stopping: () => captions() >= 5 });

    assert.equal(first.report.stopped_early, false, 'the run finished; retrieval is what stopped');
    const partway = await items("s.platform = 'youtube'");
    assert.equal(partway.filter((row) => row.retrieval === 'retrieved').length, 5);
    assert.ok(partway.filter((row) => row.retrieval === 'pending').length > 0);
    // The catalogue is already on disk. That is what makes this resumable.
    assert.equal(partway.length, YOUTUBE_LISTING_IN_WINDOW);

    const second = await run({ now: new Date(NOW.getTime() + 25 * 3600_000) });
    assert.equal(of(second.report, 'youtube').retrieved, YT_RETRIEVED - 5);
    assert.equal(
      second.fetcher.requests.filter((request) => request.endsWith('/browse')).length,
      0,
      'no second walk of the channel',
    );

    const done = await items("s.platform = 'youtube'");
    assert.equal(done.filter((row) => row.retrieval === 'pending').length, 0);
  });

  it('spends four seconds per item, which is where the 26 minutes comes from', async () => {
    await follow();

    const waits: number[] = [];
    await runCycle({
      db,
      fetcher: fakeFetcher(natesRoutes()),
      now: () => NOW,
      pause: async (ms) => void waits.push(ms),
      log: () => {},
    });

    // One gap per item after the first, per source — and the gaps are between Items,
    // not between requests, because that is how the spacing was measured.
    const spacing = waits.filter((ms) => ms === RETRIEVAL_SPACING_MS);
    assert.equal(spacing.length, SUBSTACK_FREE - 1 + (YOUTUBE_LISTING_IN_WINDOW - 1 - 1));

    // The real channel: ~395 videos in twelve months at 4s apart.
    assert.equal(Math.round((395 * RETRIEVAL_SPACING_MS) / 60_000), 26);
  });

  it('ingests nothing at all for a paused person', async () => {
    await follow();
    await db.query('update braintrust_people set paused_at = now()');

    const { report, fetcher } = await run();

    assert.deepEqual(report.sources, []);
    assert.equal(report.paused_or_blocked, 2);
    assert.deepEqual(fetcher.requests, []);
    assert.equal((await items()).length, 0);

    const { rows } = await db.query<{ last_checked_at: Date | null }>(
      'select last_checked_at from braintrust_sources',
    );
    assert.ok(rows.every((row) => row.last_checked_at === null));
  });

  it('leaves a blocked source alone, and every other source running', async () => {
    await follow();
    await db.query(`update braintrust_sources set blocked_at = now() where platform = 'substack'`);

    const { report } = await run();

    // One source's bad day is not another's.
    assert.deepEqual(
      report.sources.map((source) => source.platform),
      ['youtube'],
    );
    assert.equal((await items("s.platform = 'substack'")).length, 0);
    assert.equal((await items("s.platform = 'youtube'")).length, YOUTUBE_LISTING_IN_WINDOW);
  });

  it('reopens the backfill when the feed proves something was missed', async () => {
    await follow();
    await run();

    // Pretend the job did not run for months: the cursor is far behind everything the
    // feed still holds, so posts published in between never became rows.
    await db.query(
      `update braintrust_sources
          set cursor_published_at = $1, last_checked_at = null
        where platform = 'substack'`,
      [new Date(NOW.getTime() - 400 * 86_400_000).toISOString()],
    );

    const { report } = await run();
    const substack = of(report, 'substack');

    assert.equal(substack.gap_detected, true);
    // The repair is the backfill it already has: same action as the initial load.
    assert.equal(substack.catalogued, SUBSTACK_IN_WINDOW);
    assert.equal(substack.backfill_complete, true);
  });

  it('describes a newly published post before deciding whether to read it', async () => {
    await follow();
    await run();

    // A new post appears in the feed. Discovery cannot know its audience — the feed has
    // no paywall flag — so the catalogue is asked before anything is fetched.
    await db.query(
      `delete from braintrust_items where external_id in ('post-0', 'post-1')`,
    );
    const { report, fetcher } = await run({ now: new Date(NOW.getTime() + 25 * 3600_000) });

    const substack = of(report, 'substack');
    assert.equal(substack.discovered, 2);
    assert.equal(substack.retrieved, 1, 'post-0 is free');
    assert.equal(substack.skipped_paywall, 1, 'post-1 is only_paid');

    // One archive page answered both, and only the free one was ever requested.
    assert.equal(fetcher.requests.filter((request) => request.includes('/archive')).length, 1);
    assert.deepEqual(
      fetcher.requests.filter((request) => request.includes('/api/v1/posts/')),
      [`https://${SUBSTACK_HOST}/api/v1/posts/post-0`],
    );
  });

  it('never records a paywall it did not see, even for a post it cannot describe', async () => {
    await follow();

    // A backfill floor nearer than the feed's own window: the feed carries posts the
    // archive walk stops short of, so their audience is never established. Found by a
    // live run, where 18 posts were being recorded as skipped_paywall on no evidence.
    await db.query(
      `update braintrust_sources set backfill_floor = $1::date where platform = 'substack'`,
      [new Date(NOW.getTime() - 20 * 86_400_000).toISOString().slice(0, 10)],
    );

    const { report, fetcher } = await run();
    const substack = of(report, 'substack');

    const undescribed = await items("i.retrieval = 'failed' and s.platform = 'substack'");
    assert.ok(undescribed.length > 0, 'the narrow floor leaves some posts undescribed');
    assert.ok(undescribed.every((row) => row.audience === 'unknown'));
    assert.equal(substack.failed, undescribed.length);

    // Every skipped_paywall row is one the catalogue actually called paid.
    const skipped = await items("i.retrieval = 'skipped_paywall' and s.platform = 'substack'");
    assert.ok(skipped.every((row) => row.audience === 'paid'));
    // And nothing undescribed was fetched: unknown is not `everyone`.
    for (const row of undescribed) {
      assert.ok(!fetcher.requests.some((request) => request.endsWith(row.external_id)));
    }
  });

  it('records a post it cannot describe as failed rather than reading it blind', async () => {
    await follow();
    await run();

    // In the feed, absent from the archive: braintrust cannot learn whether it is paid.
    const { rows } = await db.query<{ id: string }>(
      `select id from braintrust_sources where platform = 'substack'`,
    );
    await db.query(
      `insert into braintrust_items (source_id, external_id, url, published_at, audience)
       values ($1, 'ghost', 'https://x/p/ghost', '2026-07-20', 'unknown')`,
      [rows[0]!.id],
    );

    const { report, fetcher } = await run({ now: new Date(NOW.getTime() + 25 * 3600_000) });

    assert.equal(of(report, 'substack').failed, 1);
    assert.equal((await items("i.external_id = 'ghost'"))[0]!.retrieval, 'failed');
    // Never requested: unknown is not `everyone`, and the allow-list is the whole rule.
    assert.ok(!fetcher.requests.some((request) => request.includes('ghost')));
  });

  it('does not demote a post it has already read, even if it turns paid', async () => {
    await follow();
    await run();

    const { rows } = await db.query<SourceRow>(
      `select id, backfill_floor::text as backfill_floor from braintrust_sources where platform = 'substack'`,
    );
    const outcome = await recordCatalogued(db, rows[0]!, {
      externalId: 'post-0',
      url: `https://${SUBSTACK_HOST}/p/post-0`,
      audience: 'paid',
    });

    // Ingested text is kept permanently (ADR 0003). The audience updates; the reading does not.
    assert.equal(outcome, 'retrieved');
    const row = (await items("i.external_id = 'post-0'"))[0]!;
    assert.equal(row.audience, 'paid');
    assert.ok(row.body_text);
  });

  it('names the people whose corpus changed, and says nothing is rebuilt yet', async () => {
    await follow();
    const { report } = await run();

    assert.deepEqual(report.rebuild_pending, ['nate-b-jones']);
    assert.equal(report.corpus.retrieved, SUBSTACK_FREE + YT_RETRIEVED);
    assert.equal(report.corpus.skipped_paywall, SUBSTACK_PAYWALLED);
    assert.equal(report.corpus.skipped_short, YT_SHORTS);
    assert.equal(report.corpus.failed, YT_FAILED);
    // Nothing left over: one run drains the Backlog it opened.
    assert.equal(report.corpus.pending, 0);
  });

  it('leaves the corpus chunked and embedded, both platforms, in one run', async () => {
    await follow();
    const { report } = await run({ embed: true });

    // The whole point of running the index inside the cycle: a day's new content is
    // searchable when the job exits, not when someone remembers to index it.
    assert.equal(report.index.items_chunked, SUBSTACK_FREE + YT_RETRIEVED);
    assert.equal(report.index.chunks_embedded, report.index.chunks_written);
    assert.equal(report.index.model, testEmbeddingsConfig.model);

    const { rows } = await db.query<{ platform: string; items: string; chunks: string; embedded: string }>(
      `select s.platform,
              count(distinct i.id) as items,
              count(c.id) as chunks,
              count(e.chunk_id) as embedded
         from braintrust_items i
         join braintrust_sources s on s.id = i.source_id
         join braintrust_chunks c on c.item_id = i.id
         left join braintrust_embeddings e on e.chunk_id = c.id
        group by s.platform order by s.platform`,
    );

    assert.deepEqual(
      rows.map((row) => [row.platform, Number(row.items)]),
      [
        ['substack', SUBSTACK_FREE],
        ['youtube', YT_RETRIEVED],
      ],
    );
    for (const row of rows) assert.equal(row.chunks, row.embedded);

    // A transcript chunk knows where in the recording it came from; prose has no
    // moment to point at.
    const { rows: timings } = await db.query<{ platform: string; timed: string }>(
      `select s.platform, count(*) filter (where c.start_ms is not null) as timed
         from braintrust_chunks c
         join braintrust_items i on i.id = c.item_id
         join braintrust_sources s on s.id = i.source_id
        group by s.platform order by s.platform`,
    );
    assert.equal(Number(timings.find((row) => row.platform === 'substack')!.timed), 0);
    assert.ok(Number(timings.find((row) => row.platform === 'youtube')!.timed) > 0);
  });

  it('indexes nothing when the run was told to stop, and picks it up next time', async () => {
    await follow();
    await run({ embed: true, stopping: () => true });
    assert.equal(await scalar('select count(*) from braintrust_chunks'), 0);

    const { report } = await run({ embed: true });
    assert.ok(report.index.items_chunked > 0);
    assert.equal(report.index.chunks_embedded, report.index.chunks_written);
  });

  async function scalar(sql: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(sql);
    return Number(rows[0]!.count);
  }
});

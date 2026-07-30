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
import {
  NOW,
  SUBSTACK_BODY_TEXT,
  SUBSTACK_FREE,
  SUBSTACK_HOST,
  SUBSTACK_IN_WINDOW,
  SUBSTACK_PAYWALLED,
  YOUTUBE_FEED_ENTRIES,
  fakeFetcher,
  natesRoutes,
  type FakeFetcher,
} from './support/sources.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const LINKS = [`https://${SUBSTACK_HOST}/p/post-0`, '@NateBJones'];

/** The Substack feed holds 20; the archive walk finds 60 in the twelve-month window. */
const FEED_ITEMS = 20;

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

  type RunOptions = { stopping?: () => boolean; now?: Date; fetcher?: FakeFetcher };

  async function run(options: RunOptions = {}): Promise<{ report: CycleReport; fetcher: FakeFetcher }> {
    const fetcher = options.fetcher ?? fakeFetcher(natesRoutes());
    const report = await runCycle({
      db,
      fetcher,
      now: () => options.now ?? NOW,
      pause: async () => {},
      log: () => {},
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

  it('discovers YouTube through the same generic reader and leaves the bodies to #29', async () => {
    await follow();
    const { report } = await run();

    const youtube = of(report, 'youtube');
    assert.equal(youtube.discovered, YOUTUBE_FEED_ENTRIES);
    assert.equal(youtube.retrieved, 0);
    assert.match(youtube.awaiting!, /#29/);

    const rows = await items("s.platform = 'youtube'");
    assert.equal(rows.length, YOUTUBE_FEED_ENTRIES);
    // Always public, and dated from the feed — the two things captions cannot come with.
    assert.ok(rows.every((row) => row.audience === 'everyone'));
    assert.ok(rows.every((row) => row.retrieval === 'pending'));
    assert.ok(rows.every((row) => row.published_at !== null));
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

    // YouTube's archive walk is #29, so its backfill is honestly still incomplete.
    assert.equal(rows.find((row) => row.platform === 'youtube')!.backfill_complete, false);
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
    assert.equal((await items("s.platform = 'youtube'")).length, YOUTUBE_FEED_ENTRIES);
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
    assert.equal(report.corpus.retrieved, SUBSTACK_FREE);
    assert.equal(report.corpus.skipped_paywall, SUBSTACK_PAYWALLED);
    assert.equal(report.corpus.pending, YOUTUBE_FEED_ENTRIES);
    assert.equal(report.corpus.failed, 0);
  });
});

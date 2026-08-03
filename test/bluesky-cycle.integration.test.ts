/**
 * Bluesky, followed and read end to end, against real Postgres.
 *
 * **The economics are the design, and only rows can prove them.** 235 posts become 39 Items
 * because a day is the unit of reading — so what has to hold against a real database is
 * that the day key is idempotent across the two paths that reach it, that a day still being
 * posted to never becomes a row, and that a citation still points at the individual post
 * once the batch has been through the whole compiler.
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
import { findPositions } from '../src/find.js';
import { followPerson, type PlanResponse } from '../src/follow/index.js';
import { createConfirmTokenStore } from '../src/follow/tokens.js';
import { runCycle, summarise, type CycleReport, type SourceReport } from '../src/ingest/cycle.js';
import { createExtractor } from '../src/notes/index.js';
import { explainPersona, loadPersona } from '../src/personas.js';
import { createEmbedder, createQueryGate } from '../src/retrieval/index.js';
import {
  BSKY_CLOSED_DAYS,
  BSKY_DID,
  BSKY_HANDLE,
  BSKY_PROFILE_LINK,
  BSKY_TOTAL_ENTRIES,
  blueskyRoutes,
  dayOf,
  postLink,
  postsOnDay,
  QUIET_DAY,
  readablePosts,
  textOf,
} from './support/bluesky.js';
import { fakeEmbeddings, testEmbeddingsConfig } from './support/embeddings.js';
import { fakeExtractor, testExtractorConfig } from './support/notes.js';
import { NOW, fakeFetcher, type FakeFetcher, type Route } from './support/sources.js';
import { fakeSynthesiser } from './support/synthesiser.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

describe('reading Bluesky end to end, against real Postgres', { skip }, () => {
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
    await follow(BSKY_PROFILE_LINK, 'Ethan Mollick', blueskyRoutes());
  });

  async function follow(link: string, name: string, routes: Route[]): Promise<PlanResponse> {
    const deps = {
      db,
      tokens: createConfirmTokenStore(),
      fetcher: fakeFetcher(routes),
      now: () => NOW,
      pause: async () => {},
    };
    const plan = (await followPerson({ links: [link] }, deps)) as PlanResponse;
    assert.ok(plan.confirm_token, `following ${link} produced a Plan rather than a refusal`);
    await followPerson({ confirm_token: plan.confirm_token, display_name: name }, deps);
    return plan;
  }

  type RunOptions = { routes?: Route[]; stopping?: () => boolean; compile?: boolean; now?: Date };

  /** A day later, which is what makes a Source due again. There is no second scheduler. */
  const TOMORROW = new Date(NOW.getTime() + 25 * 3_600_000);

  async function run(options: RunOptions = {}): Promise<{ report: CycleReport; fetcher: FakeFetcher }> {
    const fetcher = fakeFetcher(options.routes ?? blueskyRoutes());
    const report = await runCycle({
      db,
      fetcher,
      now: () => options.now ?? NOW,
      pause: async () => {},
      log: () => {},
      ...(options.compile
        ? {
            embedder: createEmbedder(testEmbeddingsConfig, fakeEmbeddings().fetcher),
            extractor: createExtractor(testExtractorConfig, quotingExtractor()),
            synthesiser: fakeSynthesiser(),
          }
        : {}),
      ...(options.stopping ? { stopping: options.stopping } : {}),
    });
    return { report, fetcher };
  }

  /** Quotes the end of what it was given, so every claim verifies against the stored body. */
  function quotingExtractor() {
    return fakeExtractor({
      note: (user) => ({
        claims: [{ statement: 'They said this that day.', quote: user.slice(-60) }],
        argument: 'Circles one thing across the day, in instalments.',
        assumptions: ['The reader has been following along.'],
      }),
    }).fetcher;
  }

  const bsky = (report: CycleReport): SourceReport =>
    report.sources.find((source) => source.platform === 'bluesky')!;

  async function days() {
    const { rows } = await db.query<{
      external_id: string;
      url: string;
      title: string;
      retrieval: string;
      published_at: string;
      body_text: string;
      raw: { platform: string; did: string; posts: { url: string; char_start: number }[] };
    }>(
      `select i.external_id, i.url, i.title, i.retrieval, i.published_at::text as published_at,
              i.body_text, i.body_raw as raw
         from braintrust_items i
         join braintrust_sources s on s.id = i.source_id
        where s.handle = $1
        order by i.published_at desc`,
      [BSKY_DID],
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  it('registers the DID rather than the handle, so a rename is not a second archive', async () => {
    const { rows } = await db.query<{ platform: string; handle: string; discovery_url: string }>(
      'select platform, handle, discovery_url from braintrust_sources',
    );

    assert.equal(rows[0]!.platform, 'bluesky');
    assert.equal(rows[0]!.handle, BSKY_DID);
    assert.match(rows[0]!.discovery_url, /getAuthorFeed/);
  });

  /**
   * The Plan quotes days because days are the Items, and the posts travel beside them
   * because this is the Source where a thousand posts become a few hundred model calls.
   * Both are projections, and the run that follows is what says how close they were.
   */
  it('prices the follow in days, with the posts alongside, and lands near the truth', async () => {
    await db.query('truncate braintrust_people cascade');
    const plan = await follow(BSKY_PROFILE_LINK, 'Ethan Mollick', blueskyRoutes());
    const source = plan.plan.sources[0]!;

    assert.equal(source.items.basis, 'estimated');
    assert.equal(source.posts_in_window?.basis, 'estimated');
    assert.match(plan.plan.estimated_duration_how, /post-page requests at 1s each/);

    await run();
    const written = (await days()).length;
    assert.ok(
      Math.abs(source.items.count - written) / written < 0.2,
      `the plan offered ${source.items.count} days and the run wrote ${written}`,
    );
  });

  // -------------------------------------------------------------------------
  // The first run: the walk is the poll, the backfill and the body
  // -------------------------------------------------------------------------

  it('batches every closed day and reads the whole account in a handful of requests', async () => {
    const { report, fetcher } = await run();
    const source = bsky(report);

    assert.equal(source.discovered, BSKY_CLOSED_DAYS);
    assert.equal(source.retrieved, BSKY_CLOSED_DAYS);
    assert.equal(source.failed, 0);
    assert.equal(source.backfill_complete, true);

    // The whole economic claim, as a number: 235 posts, 3 requests, 39 model calls.
    assert.equal(fetcher.requests.length, Math.ceil(BSKY_TOTAL_ENTRIES / 100));
    assert.equal((await days()).length, BSKY_CLOSED_DAYS);
  });

  /**
   * Read-once assumes an Item is immutable. A day still being posted to is not an Item, so
   * the assumption is true by construction rather than true in practice.
   */
  it('never writes the current UTC day, however many posts are in it', async () => {
    await run();
    assert.equal((await days()).some((day) => day.published_at === dayOf(0)), false);
  });

  it('writes a day straight to retrieved, because the words came with the discovery', async () => {
    await run();
    const rows = await days();

    assert.ok(rows.every((day) => day.retrieval === 'retrieved'));
    assert.ok(rows.every((day) => day.body_text.length > 0));
    assert.equal(rows[0]!.external_id, `${BSKY_DID}:${dayOf(1)}`);
    assert.equal(rows[0]!.title, `Posts on ${dayOf(1)}`);
  });

  it('records the spans, so the day carries the posts it was made of', async () => {
    await run();
    const day = (await days()).find((row) => row.published_at === dayOf(1))!;

    assert.equal(day.raw.platform, 'bluesky');
    assert.equal(day.raw.posts.length, postsOnDay(1));
    assert.equal(day.raw.posts[0]!.url, postLink(1, 0));
  });

  it('makes an Item of a one-post day rather than calling it too short to read', async () => {
    const { report } = await run();
    const quiet = (await days()).find((row) => row.published_at === dayOf(QUIET_DAY))!;

    assert.ok(quiet, 'a one-post day is real writing');
    assert.equal(quiet.retrieval, 'retrieved');
    assert.equal(bsky(report).skipped_short, 0);
  });

  // -------------------------------------------------------------------------
  // The steady state, and what a killed run leaves behind
  // -------------------------------------------------------------------------

  /**
   * The walk always covers everything between the last stored day and now, so a gap repairs
   * itself and there is nothing for gap detection to detect.
   */
  /**
   * A day later, the day braintrust refused to batch has closed — so the steady-state run
   * picks up exactly that one, in one request, without anything having been reopened.
   */
  it('spends one request a day, and collects the day that closed overnight', async () => {
    await run();
    const { report, fetcher } = await run({ now: TOMORROW });

    assert.equal(fetcher.requests.length, 1);
    assert.equal(bsky(report).discovered, 1);
    assert.equal(bsky(report).gap_detected, false, 'the walk covers the gap, so there is none to find');

    const rows = await days();
    assert.equal(rows.length, BSKY_CLOSED_DAYS + 1);
    assert.equal(rows[0]!.published_at, dayOf(0));
    assert.equal(rows[0]!.raw.posts.length, postsOnDay(0));
  });

  /**
   * The day the poll stops at is re-read on purpose. Stopping at the newest *post* seen
   * would cut the day that post belongs to in half, permanently, and `on conflict do
   * nothing` makes the re-read cost a statement and change nothing.
   */
  it('re-reads the newest stored day and writes it once, not twice', async () => {
    await run();
    const before = await days();
    await run({ now: TOMORROW });
    const after = await days();

    const kept = after.filter((day) => before.some((old) => old.external_id === day.external_id));
    assert.equal(kept.length, before.length, 'every day braintrust already had is still one row');
    assert.equal(new Set(after.map((day) => day.external_id)).size, after.length);
  });

  /**
   * The rows are the progress. A Bluesky walk re-reads the pages it already read — 100
   * posts a request at 1s, so a year is 16 seconds — but it never re-reads a *day*, which
   * is what a model call is charged against.
   */
  it('continues from the rows when a run is killed mid-walk', async () => {
    let seen = 0;
    const { report: first } = await run({ stopping: () => ++seen > 1 });

    assert.equal(first.stopped_early, true);
    const half = await days();
    assert.ok(half.length > 0 && half.length < BSKY_CLOSED_DAYS, `${half.length} days is a real half`);
    assert.ok(half.every((day) => day.raw.posts.length === postsOnDay(daysBack(day.published_at))));

    const { report: second } = await run({ now: TOMORROW });
    assert.equal(second.stopped_early, false);
    // Every closed day, plus the one that closed while the first run was being killed.
    assert.equal((await days()).length, BSKY_CLOSED_DAYS + 1);
  });

  it('reports its work in days, because that is what the model calls are charged against', async () => {
    const { report } = await run();
    assert.match(summarise(report), new RegExp(`\\+${BSKY_CLOSED_DAYS} days batched`));
  });

  it('leaves the source unblocked when the AppView simply refuses', async () => {
    await db.query('truncate braintrust_people cascade');
    await follow(BSKY_PROFILE_LINK, 'Ethan Mollick', blueskyRoutes());

    const refusing: Route[] = [
      { match: (request) => request.includes('getAuthorFeed'), status: 503, body: 'no' },
      ...blueskyRoutes(),
    ];
    const { report } = await run({ routes: refusing });

    assert.match(bsky(report).error!, /HTTP 503/);
    // A block is measured across per-Item requests, and Bluesky makes none — so a refusal
    // is a failed poll that is tried again tomorrow, not a source braintrust has judged.
    assert.equal(bsky(report).blocked_since, undefined);
    assert.equal((await days()).length, 0);
  });

  // -------------------------------------------------------------------------
  // Through the compiler: the batch is a unit of reading, never of citation
  // -------------------------------------------------------------------------

  describe('once it has been compiled', () => {
    beforeEach(async () => {
      await run({ compile: true });
    });

    it('compiles a Persona from Bluesky alone and publishes it', async () => {
      const persona = await explainPersona(db, 'ethan-mollick');
      assert.ok(persona.layers.voice, 'a Persona built only from short-form is still a Persona');
      // Nothing here clears the long-form floor, so voice says which population it measured
      // rather than refusing to describe a voice at all.
      assert.match(persona.layers.coverage!.descriptive, /voice was measured over all/i);
    });

    it('cites the individual post, not the day it was read in', async () => {
      const found = await findPositions(
        { person: 'ethan-mollick', query: 'what the bottleneck actually is' },
        {
          db,
          embedder: createEmbedder(testEmbeddingsConfig, fakeEmbeddings().fetcher),
          retrieval: createQueryGate(db, testEmbeddingsConfig.model),
        },
      );

      const citations = found.positions.flatMap((position) => position.citations);
      assert.ok(citations.length > 0, 'a Position with no citations would have been dropped');

      for (const citation of citations) {
        assert.match(citation.url, /\/post\//, 'the day has no URL of its own to cite');
        assert.ok(citation.posted_at, 'the moment inside the day, like a transcript’s timecode');
      }

      // Every post says which one it is at the end of its own words, and the extractor
      // quotes the tail of the body — so the quote names the post the citation must
      // resolve to, and nothing about the day it was batched into can supply that.
      for (const citation of citations) {
        const named = /\(day (\d+), note (\d+)\)/.exec(citation.quote);
        assert.ok(named, `the quote should end inside one post: ${citation.quote}`);
        assert.equal(citation.url, postLink(Number(named[1]), Number(named[2])));
      }
    });

    it('keeps the day as the unit the corpus counts', async () => {
      const evidence = (await explainPersona(db, 'ethan-mollick')).layers.coverage!.evidence as {
        retrieved: number;
        by_form: { long_form: { items: number }; short_form: { items: number } };
      };

      assert.equal(evidence.retrieved, BSKY_CLOSED_DAYS);
      assert.equal(evidence.by_form.long_form.items, 0);
      assert.equal(evidence.by_form.short_form.items, BSKY_CLOSED_DAYS);
    });
  });

  function daysBack(day: string): number {
    return Math.round((NOW.getTime() - new Date(`${day}T12:00:00Z`).getTime()) / 86_400_000);
  }
});

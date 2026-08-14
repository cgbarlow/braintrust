/**
 * The retrieval index against real Postgres.
 *
 * The claims here are the ones that only a real database can settle: that a Chunk is
 * genuinely a slice of the stored body (asserted in SQL, not in the chunker's own
 * terms), that `model` being in the primary key really does let two models coexist,
 * and that stopping halfway leaves rows the next run continues from.
 *
 * Fails loudly rather than skipping: a suite that cannot reach its database used to
 * report as passing (skipped 0), which is how a database-only regression merged twice.
 * To run it locally:
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
import type { CaptionLine } from '../src/ingest/captions.js';
import {
  checkDimension,
  checkModelPresent,
  createEmbedder,
  declaredDimension,
  EMBED_BATCH,
  indexCorpus,
  indexCounts,
} from '../src/retrieval/index.js';
import { fakeEmbeddings, testEmbeddingsConfig, TEST_DIMENSION } from './support/embeddings.js';

import { testDatabaseUrl as url } from './support/database.js';

const MODEL = testEmbeddingsConfig.model;
const OTHER_MODEL = 'text-embedding-3-small';

const POSTS = 3;
const VIDEOS = 2;

function post(index: number): string {
  return Array.from(
    { length: 9 },
    (_unused, paragraph) =>
      `Post ${index}, paragraph ${paragraph}. The claim runs long enough to be worth ` +
      'retrieving on its own, and long enough that several of them fill a window rather ' +
      'than one filling it alone.',
  ).join('\n\n');
}

function captionLines(index: number): CaptionLine[] {
  return Array.from({ length: 80 }, (_unused, line) => ({
    at: line * 4_000,
    text: `video ${index} line ${line} and the words that keep it moving along`,
  }));
}

describe('the retrieval index, against real Postgres', () => {
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
    await seed();
  });

  /**
   * A corpus with both shapes in it, plus the three states that must never be indexed:
   * a paywalled skip, a failed item and one still pending.
   */
  async function seed(): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      `insert into braintrust_people (slug, display_name) values ('nate', 'Nate B. Jones') returning id`,
    );
    const person = rows[0]!.id;

    const source = async (platform: string, handle: string): Promise<string> => {
      const { rows } = await db.query<{ id: string }>(
        `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor)
         values ($1, $2, $3, 'https://example.test/feed', current_date - 365) returning id`,
        [person, platform, handle],
      );
      return rows[0]!.id;
    };

    const substack = await source('substack', 'nate.substack.com');
    const youtube = await source('youtube', 'UC0C');

    for (let index = 0; index < POSTS; index += 1) {
      await item(substack, `post-${index}`, 'retrieved', post(index), null);
    }
    for (let index = 0; index < VIDEOS; index += 1) {
      const lines = captionLines(index);
      await item(youtube, `video-${index}`, 'retrieved', lines.map((line) => line.text).join(' '), {
        platform: 'youtube',
        video_id: `video-${index}`,
        duration_seconds: 400,
        segments: lines,
      });
    }

    await item(substack, 'paid-post', 'skipped_paywall', null, null);
    await item(substack, 'gone-post', 'failed', null, null);
    await item(youtube, 'video-pending', 'pending', null, null);
  }

  async function item(
    sourceId: string,
    externalId: string,
    retrieval: string,
    bodyText: string | null,
    bodyRaw: unknown,
  ): Promise<void> {
    await db.query(
      `insert into braintrust_items
         (source_id, external_id, url, audience, retrieval, body_text, body_raw, published_at)
       values ($1, $2, $3, 'everyone', $4, $5, $6, current_date)`,
      [sourceId, externalId, `https://example.test/${externalId}`, retrieval, bodyText, bodyRaw ? JSON.stringify(bodyRaw) : null],
    );
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  type RunOptions = { model?: string; stopping?: () => boolean; embedder?: boolean };

  async function index(options: RunOptions = {}) {
    const endpoint = fakeEmbeddings();
    const report = await indexCorpus({
      db,
      ...(options.embedder === false
        ? {}
        : {
            embedder: createEmbedder(
              { ...testEmbeddingsConfig, model: options.model ?? MODEL },
              endpoint.fetcher,
            ),
          }),
      ...(options.stopping ? { stopping: options.stopping } : {}),
      log: () => {},
    });
    return { report, endpoint };
  }

  it('chunks every retrieved item and embeds every chunk', async () => {
    const { report, endpoint } = await index();

    assert.equal(report.items_chunked, POSTS + VIDEOS);
    assert.equal(report.chunks_written, await count('select count(*) from braintrust_chunks'));
    assert.equal(report.chunks_embedded, report.chunks_written);
    assert.equal(report.model, MODEL);
    assert.ok(endpoint.sent.length > 0);
    assert.equal(endpoint.inputs(), report.chunks_written);
  });

  it('stores chunks that are exactly what the item body says', async () => {
    // Asserted against the database rather than against the chunker, because this is
    // the property a citation's quote rests on and the chunker is the thing on trial.
    await index();

    const wrong = await count(
      `select count(*) from braintrust_chunks c
         join braintrust_items i on i.id = c.item_id
        where c.text <> substring(i.body_text from c.char_start + 1 for c.char_end - c.char_start)`,
    );
    assert.equal(wrong, 0);
  });

  it('never lets a chunk span two items', async () => {
    await index();

    const spanning = await count(
      `select count(*) from braintrust_chunks c
         join braintrust_items i on i.id = c.item_id
        where c.char_end > length(i.body_text)`,
    );
    assert.equal(spanning, 0);
  });

  it('carries timings for transcripts and nulls for prose', async () => {
    await index();

    const timed = await count(
      `select count(*) from braintrust_chunks c
         join braintrust_items i on i.id = c.item_id
        where i.external_id like 'video-%' and c.start_ms is null`,
    );
    const prose = await count(
      `select count(*) from braintrust_chunks c
         join braintrust_items i on i.id = c.item_id
        where i.external_id like 'post-%' and c.start_ms is not null`,
    );

    assert.equal(timed, 0, 'a transcript chunk with no timing is an uncitable moment');
    assert.equal(prose, 0, 'prose has no timings to carry');
  });

  it('indexes nothing that was skipped, failed or never fetched', async () => {
    await index();

    const forbidden = await count(
      `select count(*) from braintrust_chunks c
         join braintrust_items i on i.id = c.item_id
        where i.retrieval <> 'retrieved'`,
    );
    assert.equal(forbidden, 0);
  });

  it('writes vectors of the width the column declares', async () => {
    await index();
    assert.equal(await declaredDimension(db), TEST_DIMENSION);

    const wrong = await count(
      `select count(*) from braintrust_embeddings where vector_dims(embedding) <> $1`,
      [TEST_DIMENSION],
    );
    assert.equal(wrong, 0);
  });

  it('batches rather than spending one request per chunk', async () => {
    const { report, endpoint } = await index();

    assert.equal(endpoint.sent.length, Math.ceil(report.chunks_written / EMBED_BATCH));
    for (const call of endpoint.sent) assert.ok(call.input.length <= EMBED_BATCH);
  });

  it('costs nothing on a second run with nothing new', async () => {
    await index();
    const { report, endpoint } = await index();

    assert.equal(report.items_chunked, 0);
    assert.equal(report.chunks_embedded, 0);
    assert.equal(endpoint.sent.length, 0, 'an up-to-date index should not call the endpoint');
  });

  it('continues from the rows a stopped run wrote', async () => {
    // The Backlog is a query over rows, so being killed costs the time since the last
    // row and nothing else. No job table, no checkpointing.
    let items = 0;
    const first = await index({ stopping: () => items++ >= 2 });
    assert.ok(first.report.items_chunked > 0 && first.report.items_chunked < POSTS + VIDEOS);

    const partial = await indexCounts(db, MODEL);
    assert.ok(partial.items_to_chunk > 0);

    const second = await index();
    assert.equal(second.report.items_chunked, partial.items_to_chunk);
    assert.deepEqual(await indexCounts(db, MODEL), {
      items_to_chunk: 0,
      chunks: partial.chunks + second.report.chunks_written,
      chunks_to_embed: 0,
    });
  });

  it('chunks without an endpoint, and embeds those chunks on a later run', async () => {
    // An embeddings endpoint that is switched off is not a reason to stop: chunking is
    // local and free, and the vectors are the part that waits.
    const offline = await index({ embedder: false });
    assert.equal(offline.report.items_chunked, POSTS + VIDEOS);
    assert.equal(offline.report.chunks_embedded, 0);
    assert.equal(offline.report.model, undefined);

    const later = await index();
    assert.equal(later.report.items_chunked, 0);
    assert.equal(later.report.chunks_embedded, offline.report.chunks_written);
  });

  it('lets a second model coexist rather than migrating over the first', async () => {
    const first = await index();
    const chunks = await count('select count(*) from braintrust_chunks');

    const second = await index({ model: OTHER_MODEL });

    // Neither the chunks nor the first model's vectors were touched. That is what keeps
    // a persona answerable while a re-index runs.
    assert.equal(await count('select count(*) from braintrust_chunks'), chunks);
    assert.equal(second.report.chunks_embedded, first.report.chunks_embedded);
    assert.equal(
      await count('select count(*) from braintrust_embeddings where model = $1', [MODEL]),
      chunks,
    );
    assert.equal(
      await count('select count(*) from braintrust_embeddings where model = $1', [OTHER_MODEL]),
      chunks,
    );
  });

  it('refuses to serve a model that has no vectors here, and serves once it has', async () => {
    await index({ model: OTHER_MODEL });

    const swapped = await checkModelPresent(db, MODEL);
    assert.equal(swapped.ready, false);
    assert.match(swapped.reason!, new RegExp(OTHER_MODEL));

    await index({ model: MODEL });
    assert.deepEqual(await checkModelPresent(db, MODEL), { ready: true });
  });

  it('refuses an endpoint whose vectors do not fit the column', async () => {
    const endpoint = fakeEmbeddings({ dimension: 768 });
    await assert.rejects(
      checkDimension(db, createEmbedder(testEmbeddingsConfig, endpoint.fetcher)),
      /768-dimension vectors and braintrust_embeddings\.embedding is vector\(1024\)/,
    );
  });

  it("drops a chunk's vectors with the chunk, and an item's chunks with the item", async () => {
    await index();
    await db.query(`delete from braintrust_items where external_id = 'post-0'`);

    const orphaned = await count(
      `select count(*) from braintrust_embeddings e
        where not exists (select 1 from braintrust_chunks c where c.id = e.chunk_id)`,
    );
    assert.equal(orphaned, 0);
  });
});

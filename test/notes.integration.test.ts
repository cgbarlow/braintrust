/**
 * The read-once pass against real Postgres.
 *
 * The claims only a database can settle: that "an Item with no Note for this
 * generation" really is the whole Backlog, that bumping the prompt version writes a
 * second generation beside the first rather than over it, and that a Compile cannot
 * read Notes without saying which generation it is reading.
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
import {
  createExtractor,
  extractorGenerations,
  noteCounts,
  notesFor,
  readCorpus,
  type RawNote,
} from '../src/notes/index.js';
import { chunkItem } from '../src/retrieval/index.js';
import { fakeExtractor, TEST_GENERATION, testExtractorConfig } from './support/notes.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const ITEMS = 3;

function body(index: number): string {
  return [
    `The ${index}th thing everyone gets wrong is that speed is the constraint.`,
    'It is not. The constraint is knowing which of the twenty things in front of you is worth doing at all.',
    `Which is why the ${index}th team to adopt a tool usually beats the first one.`,
  ].join('\n\n');
}

/** What a well-behaved model returns: two real quotes and one it made up. */
function noteFor(index: number): RawNote {
  return {
    claims: [
      { statement: 'Speed is not the constraint.', quote: 'speed is the constraint.\n\nIt is not.' },
      { statement: 'Judgement is the constraint.', quote: 'worth doing at all' },
      { statement: 'Invented.', quote: `the ${index}th team always loses` },
    ],
    argument: `Starts from the assumption that ${index} teams are racing, and rejects it.`,
    assumptions: ['Tools are broadly interchangeable.'],
  };
}

describe('reading each item once, against real Postgres', { skip }, () => {
  let db: PostgresDb;
  let personId: string;

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

  async function seed(): Promise<void> {
    const person = await db.query<{ id: string }>(
      `insert into braintrust_people (slug, display_name) values ('nate', 'Nate B. Jones') returning id`,
    );
    personId = person.rows[0]!.id;

    const source = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor)
       values ($1, 'substack', 'nate.substack.com', 'https://example.test/feed', current_date - 365)
       returning id`,
      [personId],
    );

    for (let index = 0; index < ITEMS; index += 1) {
      const text = body(index);
      const item = await db.query<{ id: string }>(
        `insert into braintrust_items (source_id, external_id, url, audience, retrieval, body_text, published_at)
         values ($1, $2, $3, 'everyone', 'retrieved', $4, current_date) returning id`,
        [source.rows[0]!.id, `post-${index}`, `https://example.test/post-${index}`, text],
      );

      for (const chunk of chunkItem({ text, raw: null })) {
        await db.query(
          `insert into braintrust_chunks (item_id, ordinal, text, char_start, char_end, start_ms, end_ms)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [item.rows[0]!.id, chunk.ordinal, chunk.text, chunk.charStart, chunk.charEnd, chunk.startMs, chunk.endMs],
        );
      }
    }

    // Retrieved but never chunked: a claim carries the chunk its quote came from, so
    // this one is not readable yet.
    await db.query(
      `insert into braintrust_items (source_id, external_id, url, audience, retrieval, body_text, published_at)
       values ($1, 'unchunked', 'https://example.test/unchunked', 'everyone', 'retrieved', 'words', current_date)`,
      [source.rows[0]!.id],
    );
    // Skipped and pending items are not readable at all.
    await db.query(
      `insert into braintrust_items (source_id, external_id, url, audience, retrieval, published_at)
       values ($1, 'paid', 'https://example.test/paid', 'paid', 'skipped_paywall', current_date),
              ($1, 'waiting', 'https://example.test/waiting', 'everyone', 'pending', current_date)`,
      [source.rows[0]!.id],
    );
  }

  type RunOptions = { version?: string; stopping?: () => boolean; note?: RawNote | undefined };

  async function read(options: RunOptions = {}) {
    const endpoint = fakeExtractor({
      note: options.note ?? ((user) => noteFor(Number(/The (\d)th thing/.exec(user)?.[1] ?? 0))),
    });
    const model = options.version ? `${testExtractorConfig.model}-${options.version}` : testExtractorConfig.model;
    const report = await readCorpus({
      db,
      extractor: createExtractor({ ...testExtractorConfig, model }, endpoint.fetcher),
      ...(options.stopping ? { stopping: options.stopping } : {}),
      log: () => {},
    });
    return { report, endpoint };
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  it('writes exactly one note per item per generation', async () => {
    const { report, endpoint } = await read();

    assert.equal(report.items_read, ITEMS);
    assert.equal(report.generation, TEST_GENERATION);
    assert.equal(endpoint.sent.length, ITEMS, 'one model call per item, no more');
    assert.equal(await count('select count(*) from braintrust_item_notes'), ITEMS);
  });

  it('keeps the claims it can quote and drops the ones it cannot', async () => {
    const { report } = await read();

    assert.equal(report.claims_kept, ITEMS * 2);
    assert.equal(report.claims_dropped, ITEMS);

    const { rows } = await db.query<{ quote: string; chunk_id: string | null; statement: string }>(
      `select c->>'quote' as quote, c->>'chunk_id' as chunk_id, c->>'statement' as statement
         from braintrust_item_notes n, jsonb_array_elements(n.claims) c`,
    );

    assert.equal(rows.length, ITEMS * 2);
    for (const row of rows) {
      assert.notEqual(row.statement, 'Invented.');
      assert.ok(row.chunk_id, 'every kept claim points at a chunk');
    }
  });

  it('stores a quote that is verbatim in the item it came from', async () => {
    // Asked of Postgres rather than of the verifier: this is the property a citation
    // rests on, and the verifier is the thing on trial.
    await read();

    const unquotable = await count(
      `select count(*) from braintrust_item_notes n
         join braintrust_items i on i.id = n.item_id,
         jsonb_array_elements(n.claims) c
        where position(c->>'quote' in i.body_text) = 0`,
    );
    assert.equal(unquotable, 0);
  });

  it('points every claim at a chunk that really contains its quote', async () => {
    await read();

    const wrong = await count(
      `select count(*) from braintrust_item_notes n
         join braintrust_items i on i.id = n.item_id,
         jsonb_array_elements(n.claims) c
         join braintrust_chunks k on k.id = (c->>'chunk_id')::uuid
        where position(c->>'quote' in i.body_text) - 1 not between k.char_start and k.char_end`,
    );
    assert.equal(wrong, 0);
  });

  it('keeps the argument and the assumptions, not just a list of conclusions', async () => {
    await read();

    const { rows } = await db.query<{ argument_md: string; assumptions: string[] }>(
      'select argument_md, assumptions from braintrust_item_notes limit 1',
    );
    assert.match(rows[0]!.argument_md, /rejects it/);
    assert.deepEqual(rows[0]!.assumptions, ['Tools are broadly interchangeable.']);
  });

  it('reads nothing that is skipped, pending, or not yet chunked', async () => {
    await read();

    const forbidden = await count(
      `select count(*) from braintrust_item_notes n join braintrust_items i on i.id = n.item_id
        where i.retrieval <> 'retrieved' or i.external_id = 'unchunked'`,
    );
    assert.equal(forbidden, 0);
  });

  it('costs nothing on a second run', async () => {
    await read();
    const { report, endpoint } = await read();

    assert.equal(report.items_read, 0);
    assert.equal(endpoint.sent.length, 0, 'a corpus already read should not call the model');
    assert.equal(await count('select count(*) from braintrust_item_notes'), ITEMS);
  });

  it('continues from the notes a stopped run wrote', async () => {
    let seen = 0;
    const first = await read({ stopping: () => seen++ >= 2 });
    assert.ok(first.report.items_read > 0 && first.report.items_read < ITEMS);

    const owed = (await noteCounts(db, TEST_GENERATION)).items_to_read;
    assert.ok(owed > 0);

    const second = await read();
    assert.equal(second.report.items_read, owed);
    assert.equal((await noteCounts(db, TEST_GENERATION)).items_to_read, 0);
  });

  it('writes a new generation alongside the old one when the extractor changes', async () => {
    await read();
    const { report } = await read({ version: 'mk2' });

    // A prompt upgrade is a resumable re-read of the corpus, not a migration. The old
    // notes stay readable, so the persona built from them stays live for its duration.
    assert.equal(report.items_read, ITEMS);
    assert.deepEqual(await extractorGenerations(db), ['test-reader-mk2@notes-1', TEST_GENERATION]);
    assert.equal(await count('select count(*) from braintrust_item_notes'), ITEMS * 2);
    assert.equal((await noteCounts(db, TEST_GENERATION)).notes, ITEMS);
  });

  it('gives a compile only the generation it asked for', async () => {
    await read();
    await read({ version: 'mk2' });

    assert.equal((await notesFor(db, personId, TEST_GENERATION)).length, ITEMS);
    assert.equal((await notesFor(db, personId, 'test-reader-mk2@notes-1')).length, ITEMS);
    assert.deepEqual(await notesFor(db, personId, 'never-ran@notes-1'), []);
  });

  it('lets a compile record which generation it read', async () => {
    await read();
    await db.query(
      `insert into braintrust_compiles (person_id, compiler_version, extractor, status)
       values ($1, '0.1.0', $2, 'current')`,
      [personId, TEST_GENERATION],
    );

    const { rows } = await db.query<{ extractor: string }>(
      `select extractor from braintrust_compiles where person_id = $1`,
      [personId],
    );
    assert.equal(rows[0]!.extractor, TEST_GENERATION);
  });

  it('writes a note for an item that asserts nothing, rather than reading it every day', async () => {
    // The argument and the assumptions are the model's words about the item rather than
    // the author's, so quote verification has nothing to say about them. Leaving the
    // item unread instead would mean paying full price for the same answer daily.
    const { report } = await read({
      note: { claims: [], argument: 'A list of links. Nothing is asserted.', assumptions: [] },
    });

    assert.equal(report.items_read, ITEMS);
    assert.equal(report.claims_kept, 0);
    assert.equal((await noteCounts(db, TEST_GENERATION)).notes, ITEMS);
  });

  it('leaves an item the model refused in the backlog for the next run', async () => {
    const endpoint = fakeExtractor({ status: 500 });
    const failed = await readCorpus({
      db,
      extractor: createExtractor(testExtractorConfig, endpoint.fetcher),
      log: () => {},
    });

    assert.equal(failed.items_read, 0);
    assert.equal(failed.items_failed, ITEMS);
    assert.equal(await count('select count(*) from braintrust_item_notes'), 0);

    // No permanent verdict was recorded on the strength of one bad afternoon.
    assert.equal((await noteCounts(db, TEST_GENERATION)).items_to_read, ITEMS);
    assert.equal((await read()).report.items_read, ITEMS);
  });

  it('counts what it has and what it still owes', async () => {
    assert.deepEqual(await noteCounts(db, TEST_GENERATION), {
      items_to_read: ITEMS,
      notes: 0,
      claims: 0,
    });

    await read();

    assert.deepEqual(await noteCounts(db, TEST_GENERATION), {
      items_to_read: 0,
      notes: ITEMS,
      claims: ITEMS * 2,
    });
  });
});

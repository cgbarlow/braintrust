/**
 * `braintrust_find_positions` against real Postgres and real pgvector.
 *
 * The claims only a database can settle: that the question is embedded at serve time and
 * matched in the same space the Corpus was indexed in, that the Positions those Items
 * support come back with the Person's own words attached, that the passages fallback fires
 * exactly when the compiler formed no Position on a topic, and that a superseded Position
 * is served flagged rather than dropped — which is #35's rows and this ticket's read path.
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

import { compileCorpus } from '../src/compile/index.js';
import { createDb, type PostgresDb } from '../src/db.js';
import { DEFAULT_CITATIONS, DEFAULT_PASSAGES, findPositions, MATCH_FLOOR } from '../src/find.js';
import {
  chunkItem,
  createEmbedder,
  createQueryGate,
  storeEmbeddings,
  type QueryGate,
} from '../src/retrieval/index.js';
import { fakeEmbeddings, testEmbeddingsConfig } from './support/embeddings.js';
import { fakeSynthesiser, type FakeOptions } from './support/synthesiser.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const GENERATION = 'test-reader@notes-1';
const MODEL = testEmbeddingsConfig.model;

/**
 * Three topics, deliberately unalike, so a question can match one and not the others —
 * and a fourth nobody wrote a claim about, which is what the passages fallback is for.
 */
const ITEMS = [
  {
    external_id: 'evals',
    published_at: '2024-01-09',
    title: 'Evals precede the harness',
    body:
      'You write the evals before you write the harness. Every team that skips this ends up ' +
      'tuning prompts against a vibe. The eval is the specification, and the harness is only ' +
      'the thing that runs it.',
    claims: [
      {
        statement: 'Evals should be written before the harness that runs them.',
        quote: 'You write the evals before you write the harness',
      },
      {
        statement: 'An eval is a specification.',
        quote: 'The eval is the specification',
      },
    ],
  },
  {
    external_id: 'context',
    published_at: '2025-06-01',
    title: 'Context windows are not memory',
    body:
      'A context window is not memory. It is a buffer that forgets everything the moment the ' +
      'request ends, and treating it as memory is how people end up rebuilding a database ' +
      'badly inside a prompt.',
    claims: [
      { statement: 'A context window is a buffer rather than memory.', quote: 'A context window is not memory' },
      {
        statement: 'Treating a context window as memory rebuilds a database badly.',
        quote: 'rebuilding a database badly inside a prompt',
      },
    ],
  },
  {
    external_id: 'evals-again',
    published_at: '2026-03-11',
    title: 'Still writing evals first',
    body:
      'I said it two years ago and I will say it again: the eval comes first. If you cannot ' +
      'measure whether the change helped, you are not engineering, you are decorating.',
    claims: [
      { statement: 'The eval still comes before everything else.', quote: 'the eval comes first' },
      {
        statement: 'Unmeasured change is decoration rather than engineering.',
        quote: 'you are not engineering, you are decorating',
      },
    ],
  },
];

/** Every claim braintrust holds, in the order the compiler numbers them: newest item first. */
const CLAIMS_PER_ITEM = 2;

/** Indexed and read, but the note it carries asserts nothing — so no Position cites it. */
const UNCLAIMED = {
  external_id: 'pricing',
  published_at: '2025-09-09',
  title: 'A long aside about pricing',
  body:
    'Pricing an agent product is its own problem. Seat-based pricing collapses the moment the ' +
    'software does the work of the seat, and usage pricing punishes exactly the customers you ' +
    'most want. Nobody has a good answer to this yet.',
};

describe('finding positions, against real Postgres', { skip }, () => {
  let db: PostgresDb;
  let personId: string;
  let sourceId: string;

  const embedder = createEmbedder(testEmbeddingsConfig, fakeEmbeddings().fetcher);
  let retrieval: QueryGate;

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
    retrieval = createQueryGate(db, MODEL);
    await seed();
  });

  async function seed(): Promise<void> {
    const person = await db.query<{ id: string }>(
      `insert into braintrust_people (slug, display_name) values ('nate', 'Nate B. Jones') returning id`,
    );
    personId = person.rows[0]!.id;

    const source = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor,
                                       backfill_complete)
       values ($1, 'substack', 'nate.substack.com', 'https://example.test/feed', current_date - 3650, true)
       returning id`,
      [personId],
    );
    sourceId = source.rows[0]!.id;

    for (const item of ITEMS) {
      await addItem(
        item,
        item.claims.map((claim) => ({ ...claim, chunk_id: null, start_ms: null })),
      );
    }
    await addItem(UNCLAIMED, []);
  }

  /** Retrieved, chunked, embedded and read — an item with nothing left owed on it. */
  async function addItem(
    item: { external_id: string; published_at: string; title: string; body: string },
    claims: unknown[],
  ): Promise<string> {
    const inserted = await db.query<{ id: string }>(
      `insert into braintrust_items (source_id, external_id, url, title, audience, retrieval,
                                     body_text, published_at)
       values ($1, $2, $3, $4, 'everyone', 'retrieved', $5, $6) returning id`,
      [
        sourceId,
        item.external_id,
        `https://example.test/${item.external_id}`,
        item.title,
        item.body,
        item.published_at,
      ],
    );
    const itemId = inserted.rows[0]!.id;

    for (const chunk of chunkItem({ text: item.body, raw: null })) {
      const written = await db.query<{ id: string }>(
        `insert into braintrust_chunks (item_id, ordinal, text, char_start, char_end, start_ms, end_ms)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [itemId, chunk.ordinal, chunk.text, chunk.charStart, chunk.charEnd, chunk.startMs, chunk.endMs],
      );

      const [vector] = await embedder.embed([chunk.text]);
      await storeEmbeddings(db, MODEL, [{ chunkId: written.rows[0]!.id, vector: vector! }]);
    }

    await db.query(
      `insert into braintrust_item_notes (item_id, extractor, claims, argument_md, assumptions)
       values ($1, $2, $3::jsonb, 'an argument', '[]'::jsonb)`,
      [itemId, GENERATION, JSON.stringify(claims)],
    );
    return itemId;
  }

  /**
   * One position per claim, named after the item it came from. Grouping is the model's job
   * and this test is not about the model — it is about what braintrust does with the
   * grouping, which is where every guarantee in the answer comes from.
   */
  function compile(positionsFor?: FakeOptions['positionsFor']) {
    return compileCorpus({
      db,
      extractor: GENERATION,
      synthesiser: fakeSynthesiser({
        positionsFor:
          positionsFor ??
          ((claims) =>
            claims.map((claim, index) => ({
              slug: `position-${index}`,
              statement: `Position ${index}, as braintrust would put it.`,
              claims: [claim],
            }))),
      }),
      changed: ['nate'],
      log: () => {},
    });
  }

  function find(args: Partial<Parameters<typeof findPositions>[0]> = {}) {
    return findPositions(
      { person: 'nate', query: 'when should you write evals', ...args },
      { db, embedder, retrieval },
    );
  }

  /** The exact text of a chunk, which the deterministic fake embeds to distance zero. */
  async function chunkTextOf(externalId: string): Promise<string> {
    const { rows } = await db.query<{ text: string }>(
      `select c.text from braintrust_chunks c
         join braintrust_items i on i.id = c.item_id
        where i.external_id = $1 order by c.ordinal limit 1`,
      [externalId],
    );
    return rows[0]!.text;
  }

  it('answers with the positions the matching items support, and nothing they do not', async () => {
    await compile();

    const answer = await find({ query: await chunkTextOf('context') });

    assert.equal(answer.subject, 'braintrust model of Nate B. Jones');
    assert.ok(answer.positions.length > 0);

    const urls = new Set(
      answer.positions.flatMap((position) => position.citations.map((citation) => citation.url)),
    );
    assert.deepEqual(
      [...urls],
      ['https://example.test/context'],
      'a question about one topic does not drag in the nearest position on another',
    );
    assert.deepEqual(answer.passages, [], 'passages are the fallback, not a companion');
  });

  it('cites what the person published — quote, item, url and date', async () => {
    await compile();
    const answer = await find({ query: await chunkTextOf('evals') });

    const citation = answer.positions[0]!.citations[0]!;
    const quotes = ITEMS[0]!.claims.map((claim) => claim.quote);
    assert.ok(quotes.includes(citation.quote), `${citation.quote} should be one the note verified`);
    assert.equal(citation.url, 'https://example.test/evals');
    assert.equal(citation.item_title, 'Evals precede the harness');
    assert.equal(citation.published_at, '2024-01-09');

    // The quote is the one braintrust stored when it read the item, not one written now.
    const stored = await db.query<{ quote: string }>(
      'select quote from braintrust_position_citations order by quote',
    );
    assert.ok(stored.rows.some((row) => row.quote === quotes[0]));
  });

  it('comes back empty rather than confidently ranked when the corpus does not answer', async () => {
    await compile();

    const answer = await find({
      query: 'lunar module descent stage telemetry during the moon landing',
    });

    assert.deepEqual(answer.positions, []);
    assert.deepEqual(answer.passages, []);

    // An empty list on its own cannot tell "they never said this" from "this braintrust is
    // tuned wrong" — which is exactly what the live probe could not tell until this existed.
    assert.equal(answer.nothing_matched!.floor, MATCH_FLOOR);
    assert.ok(answer.nothing_matched!.nearest_similarity! < MATCH_FLOOR);
  });

  it('says the window itself was empty, which reads differently again', async () => {
    await compile();

    const answer = await find({ query: await chunkTextOf('evals'), since: '2030-01-01' });

    assert.deepEqual(answer.positions, []);
    assert.equal(answer.nothing_matched!.nearest_similarity, null);
  });

  it('says nothing about matching when it found something', async () => {
    await compile();

    const answer = await find({ query: await chunkTextOf('evals') });
    assert.equal(answer.nothing_matched, undefined);
  });

  it('returns a one-item position graded low rather than hiding it', async () => {
    await compile();
    const answer = await find({ query: await chunkTextOf('evals') });

    for (const position of answer.positions) {
      assert.equal(position.item_count, 1);
      assert.equal(position.confidence, 'low');
      assert.equal(position.basis, 'measured');
    }
  });

  it('recomputes held_since from the citations, so a backfill moves it earlier', async () => {
    // One position over every claim, so its held_since is the oldest item behind it.
    const together = (claims: string[]) => [
      { slug: 'evals-precede-the-harness', statement: 'Evals come first.', claims },
    ];

    await compile(together);
    const first = await find({ query: await chunkTextOf('evals') });
    assert.equal(first.positions[0]!.held_since, '2024-01-09');
    assert.equal(first.positions[0]!.item_count, ITEMS.length);
    assert.equal(first.positions[0]!.confidence, 'moderate');

    // A backfill reaching further back, and a rebuild that now sees it.
    await addItem(
      {
        external_id: 'evals-first-ever',
        published_at: '2022-11-02',
        title: 'The first time I said it',
        body: 'Write the eval first. I will keep saying this until it stops being necessary.',
      },
      [{ statement: 'Write the eval first.', quote: 'Write the eval first', chunk_id: null, start_ms: null }],
    );
    await compile(together);

    const second = await find({ query: await chunkTextOf('evals') });
    // Nothing carried the old value forward: it is derived from the citations every time.
    assert.equal(second.positions[0]!.held_since, '2022-11-02');
    assert.equal(second.positions[0]!.item_count, ITEMS.length + 1);
  });

  it('falls back to passages when the compiler formed no position on the topic', async () => {
    await compile();

    const answer = await find({ query: await chunkTextOf('pricing') });

    assert.deepEqual(answer.positions, []);
    assert.ok(answer.passages.length > 0);
    assert.equal(answer.passages[0]!.url, 'https://example.test/pricing');
    // Raw material, as stored: what they said, not what braintrust concluded.
    assert.ok(UNCLAIMED.body.includes(answer.passages[0]!.text.slice(0, 40)));
  });

  it('bounds passages for readability and says what it held back; full returns the rest', async () => {
    // Enough indexed material with no claims against it that the default has to trim.
    for (let index = 0; index < 12; index += 1) {
      await addItem(
        {
          external_id: `aside-${index}`,
          published_at: '2025-10-01',
          title: `Aside ${index}`,
          body: `${UNCLAIMED.body} This is the ${index}th time around the same ground.`,
        },
        [],
      );
    }
    await compile();

    const bounded = await find({ query: await chunkTextOf('pricing') });
    assert.equal(bounded.passages.length, DEFAULT_PASSAGES);
    assert.ok((bounded.more_available?.passages ?? 0) > 0);

    const whole = await find({ query: await chunkTextOf('pricing'), full: true });
    assert.ok(whole.passages.length > DEFAULT_PASSAGES);
    assert.equal(whole.more_available?.passages, undefined);
  });

  it('bounds a position own citations the same way, and full lifts that too', async () => {
    const all = ITEMS.length * CLAIMS_PER_ITEM;
    await compile((claims) => [
      { slug: 'everything', statement: 'One position over every claim.', claims },
    ]);

    const bounded = await find({ query: await chunkTextOf('evals') });
    assert.equal(bounded.positions[0]!.citations.length, DEFAULT_CITATIONS);
    assert.equal(bounded.positions[0]!.more_citations, all - DEFAULT_CITATIONS);

    const whole = await find({ query: await chunkTextOf('evals'), full: true });
    assert.equal(whole.positions[0]!.citations.length, all);
    assert.equal(whole.positions[0]!.more_citations, undefined);
  });

  it('filters what is searched by date, and says it filtered', async () => {
    await compile();

    const recent = await find({ query: await chunkTextOf('evals'), since: '2026-01-01' });
    assert.deepEqual(recent.window, { since: '2026-01-01' });

    // The 2024 item is outside the window, so nothing in the answer may come from it —
    // neither a position's citation nor a passage.
    const urls = [
      ...recent.positions.flatMap((position) => position.citations.map((citation) => citation.url)),
      ...recent.passages.map((passage) => passage.url),
    ];
    assert.ok(!urls.includes('https://example.test/evals'));
  });

  it('serves a superseded position flagged rather than dropping it', async () => {
    await compile();

    // The first two positions are the two claims of the newest item, which is the one
    // this test asks about — so both sides of the relation are in the answer.
    const { rows } = await db.query<{ id: string; slug: string }>(
      `select id, slug from braintrust_positions order by slug`,
    );

    // #35's row, written by hand: this ticket's job is that the read path already means
    // something when it arrives.
    await db.query(
      `insert into braintrust_position_relations
         (compile_id, from_position_id, to_position_id, relation, gap_days, rationale)
       values ((select compile_id from braintrust_positions where id = $1), $1, $2, 'revised', 793,
               'The later item withdraws the earlier framing in their own words.')`,
      [rows[0]!.id, rows[1]!.id],
    );

    const answer = await find({ query: await chunkTextOf('evals-again'), limit: 50 });
    const earlier = answer.positions.find((position) => position.slug === rows[0]!.slug)!;
    const later = answer.positions.find((position) => position.slug === rows[1]!.slug)!;

    // Retained and returned, which is the entire point of the design.
    assert.equal(earlier.current, false);
    assert.equal(earlier.relations[0]!.relation, 'revised');
    assert.equal(earlier.relations[0]!.direction, 'superseded_by');
    assert.equal(earlier.relations[0]!.other, rows[1]!.slug);
    assert.equal(earlier.relations[0]!.gap_days, 793);
    assert.match(earlier.relations[0]!.rationale!, /withdraws the earlier framing/);

    assert.equal(later.current, true);
    assert.equal(later.relations[0]!.direction, 'supersedes');
    assert.equal(later.relations[0]!.other, rows[0]!.slug);
  });

  it('says how many positions it held back rather than trimming silently', async () => {
    await compile();

    const one = await find({ query: await chunkTextOf('evals'), limit: 1 });
    assert.equal(one.positions.length, 1);
    assert.ok((one.more_available?.positions ?? 0) >= 1);
  });

  it('refuses for a person who has never been compiled rather than serving passages', async () => {
    await assert.rejects(find(), /has no persona/);
  });

  it('refuses while the configured model has no vectors here, and says why', async () => {
    await compile();

    const unready = createQueryGate(db, 'some-other-model');
    await assert.rejects(
      findPositions({ person: 'nate', query: 'evals' }, { db, embedder, retrieval: unready }),
      /re-embedded under the configured model/,
    );
  });

  it('is dropped with the compile it belongs to, like every other tier 3 row', async () => {
    await compile();
    assert.ok((await db.query('select 1 from braintrust_positions')).rows.length > 0);

    await db.query(`delete from braintrust_compiles where person_id = $1`, [personId]);

    assert.equal((await db.query('select 1 from braintrust_positions')).rows.length, 0);
    assert.equal((await db.query('select 1 from braintrust_position_citations')).rows.length, 0);
  });
});

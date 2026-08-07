/**
 * `braintrust_find_positions` against real Postgres and real pgvector.
 *
 * The claims only a database can settle: that the question is embedded at serve time and
 * matched in the same space the Corpus was indexed in, that the Positions those Items
 * support come back with the Person's own words attached, that the passages fallback fires
 * exactly when the compiler formed no Position on a topic, and that a Position the
 * compiler decided was superseded is served flagged rather than dropped — end to end,
 * from the judgement that wrote the row to the answer a client reads.
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
import { MAX_POSITIONS } from '../src/compile/synthesis.js';
import { createDb, type PostgresDb } from '../src/db.js';
import {
  DEFAULT_CITATIONS,
  DEFAULT_PASSAGES,
  findPositions,
  MATCH_FLOOR,
  MATCH_ITEMS,
} from '../src/find.js';
import {
  chunkItem,
  createEmbedder,
  createQueryGate,
  storeEmbeddings,
  type Embedder,
  type QueryGate,
} from '../src/retrieval/index.js';
import { UNMEASURED_RETRIEVAL_FLOOR } from '../src/unmeasured.js';
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

/**
 * The endpoint the compiler asks *which claims are near which* — near when they are about
 * the same subject, and orthogonal otherwise. Deliberately cruder than the bag of words
 * the corpus is indexed with: these tests are about what braintrust does with a
 * neighbourhood, and a neighbourhood nobody can predict tests nothing.
 */
const topical: Embedder = {
  model: 'test-topics',
  url: 'https://example.test/v1/embeddings',
  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map((text) =>
      /eval/i.test(text) ? [1, 0, 0] : /context|memory/i.test(text) ? [0, 1, 0] : [0, 0, 1],
    );
  },
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
  function compile(positionsFor?: FakeOptions['positionsFor'], options: FakeOptions = {}) {
    return compileCorpus({
      db,
      extractor: GENERATION,
      synthesiser: fakeSynthesiser({
        ...options,
        positionsFor:
          positionsFor ??
          ((claims) =>
            claims.map((claim, index) => ({
              slug: `position-${index}`,
              statement: `Position ${index}, as braintrust would put it.`,
              claims: [claim],
            }))),
      }),
      ...(options.judgementsFor ? { embedder: topical } : {}),
      log: () => {},
    });
  }

  /**
   * One position per item, oldest last — the shape the revision tests need, because a
   * revision is between two things said at different times and the default grouping puts
   * every claim in its own position.
   */
  const byItem: FakeOptions['positionsFor'] = (claims) =>
    [...ITEMS].reverse().map((item, index) => ({
      slug: item.external_id,
      statement: `What braintrust says ${item.external_id} holds.`,
      claims: claims.slice(index * CLAIMS_PER_ITEM, (index + 1) * CLAIMS_PER_ITEM),
    })).filter((position) => position.claims.length > 0);

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

  /**
   * **No second kind of silence.** An uncalibrated persona declines a question a calibrated
   * one also declines, and neither announces why. The caution lives in the number the gate
   * uses, never in the shape or the wording of what comes back — a reader must not be able
   * to tell "braintrust could not measure its own gate" from "they never wrote about this".
   */
  it('declines an off-corpus question the same way whether or not its gate was measured', async () => {
    await compile();
    const question = 'lunar module descent stage telemetry during the moon landing';
    const calibrated = await find({ query: question });

    // The same compile, with its measured floor removed — the one thing that differs.
    await db.query(
      `update braintrust_compiles set corpus_stats = corpus_stats - 'selectivity'
        where status = 'current'`,
    );
    const uncalibrated = await find({ query: question });

    assert.deepEqual(uncalibrated.positions, []);
    assert.deepEqual(uncalibrated.passages, []);
    assert.equal(uncalibrated.nothing_matched!.reason, calibrated.nothing_matched!.reason);
    assert.equal(uncalibrated.nothing_matched!.say, calibrated.nothing_matched!.say);
    assert.deepEqual(Object.keys(uncalibrated.nothing_matched!).sort(), Object.keys(calibrated.nothing_matched!).sort());

    // …and the caution is real: the floor it used is the unmeasured one, above the range.
    assert.equal(uncalibrated.nothing_matched!.floor, UNMEASURED_RETRIEVAL_FLOOR);
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

  it('carries the similarity each position was graded from, on the same scale as the floor', async () => {
    await compile();

    const answer = await find({ query: await chunkTextOf('evals') });
    const top = answer.positions[0]!;

    // The grade alone could not be checked: `fit` has shipped wrong twice and both times the
    // number behind it was computed and discarded, so a `close` on an uncovered question and
    // a `close` on a real one were indistinguishable from the payload.
    assert.ok(top.similarity >= MATCH_FLOOR, `${top.similarity} cleared the floor to be here`);
    assert.ok(top.similarity <= 1);

    // Same scale as the empty answer reports, so the two can be read against each other.
    assert.equal(top.similarity, Math.round(top.similarity * 1000) / 1000);

    // Ranked order is similarity order, which is what makes a mid-list `close` visible as
    // one rather than having to be taken on trust.
    const scores = answer.positions.map((one) => one.similarity);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
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

  /** A judge that always answers the same way, on whatever pairs it is sent. */
  function judgeSays(relation: 'revised' | 'unsettled' | 'drifting' | 'none', rationale: string) {
    return (pairs: string[]) => pairs.map((pair) => ({ pair, relation, rationale }));
  }

  it('serves a position the compiler superseded flagged, rather than dropping it', async () => {
    await compile(byItem, {
      judgementsFor: judgeSays(
        'revised',
        'The later item withdraws the earlier framing in their own words.',
      ),
    });

    // Two items on evals, 792 days apart, and one about context windows that is nowhere
    // near either. The compiler found the pair; nothing here inserted a row by hand.
    const answer = await find({ query: await chunkTextOf('evals'), limit: 50 });
    const earlier = answer.positions.find((position) => position.slug === 'evals')!;

    // Retained and returned, which is the entire point of the design.
    assert.equal(earlier.current, false);
    assert.equal(earlier.relations[0]!.relation, 'revised');
    assert.equal(earlier.relations[0]!.direction, 'superseded_by');
    assert.equal(earlier.relations[0]!.other, 'evals-again');
    // Counted from the two held_since dates a reader is shown, so it can be checked
    // against them rather than taken on trust.
    assert.equal(earlier.relations[0]!.gap_days, 792);
    assert.match(earlier.relations[0]!.rationale!, /withdraws the earlier framing/);

    // The later position, whether or not this question surfaced it, reads the same
    // relation from the other side.
    const later = await find({ query: await chunkTextOf('evals-again'), limit: 50 });
    const replacement = later.positions.find((position) => position.slug === 'evals-again')!;
    assert.equal(replacement.current, true);
    assert.equal(replacement.relations[0]!.direction, 'supersedes');
    assert.equal(replacement.relations[0]!.other, 'evals');

    // The position on another subject was never a candidate: a neighbourhood is what
    // decides that, and the third item is not in this one.
    const untouched = await find({ query: await chunkTextOf('context'), limit: 50 });
    assert.deepEqual(untouched.positions.find((one) => one.slug === 'context')!.relations, []);
  });

  it('leaves both positions current when the judge stops short of a revision', async () => {
    await compile(byItem, {
      judgementsFor: judgeSays('unsettled', 'Both readings are still argued for.'),
    });

    const answer = await find({ query: await chunkTextOf('evals'), limit: 50 });
    const earlier = answer.positions.find((position) => position.slug === 'evals')!;

    // Visible to anyone who goes looking, and never spoken as a change of mind.
    assert.equal(earlier.current, true);
    assert.equal(earlier.relations[0]!.relation, 'unsettled');
    assert.equal(earlier.relations[0]!.direction, 'earlier');
    assert.equal(earlier.relations[0]!.other, 'evals-again');
    assert.match(earlier.relations[0]!.rationale!, /still argued for/);
  });

  it('records nothing at all when the judge dismisses the pair', async () => {
    await compile(byItem, { judgementsFor: judgeSays('none', 'Two ways of saying one thing.') });

    const answer = await find({ query: await chunkTextOf('evals'), limit: 50 });

    for (const position of answer.positions) {
      assert.deepEqual(position.relations, []);
      assert.equal(position.current, true);
    }
  });

  it('says how many positions it held back rather than trimming silently', async () => {
    await compile();

    const one = await find({ query: await chunkTextOf('evals'), limit: 1 });
    assert.equal(one.positions.length, 1);
    assert.ok((one.more_available?.positions ?? 0) >= 1);
  });

  /**
   * The crowding-out fixture: one Item long enough to fill the candidate pool on its own,
   * and a spread of short Items around it.
   *
   * Every text here is built from the same three query words plus filler, because the
   * corpus is indexed with a bag of words and that makes the similarities arithmetic
   * rather than hopeful. The sharp Item is the query and nothing else, so it scores 1.0;
   * every Chunk of the lecture carries one filler word, so it scores 0.87; the fair Items
   * carry six, so they score 0.58 — above the floor, and behind every Chunk the lecture
   * has. Which is the whole trap: they lose to the *lecture's length*, not to its
   * relevance.
   */
  const QUERY_WORDS = 'harness evaluation specification';
  const SHARP = 'sharp-and-short';
  const LECTURE = 'four-hour-lecture';
  /**
   * Kept low enough that every claim in the fixture becomes a Position: the compiler bounds
   * one clustering pass to `MAX_POSITIONS`, and a fixture that tripped *that* would be
   * measuring the wrong layer. Fourteen is plenty — under the old ordering not one of them
   * survived.
   */
  const FAIR_ITEMS = MAX_POSITIONS - CLAIMS_PER_ITEM * ITEMS.length - 2;

  async function seedOneLongItemAndManyShort(): Promise<number> {
    // ~70 paragraphs, which the windower turns into ~70 overlapping Chunks — more than
    // MATCH_ITEMS on its own, so under the old ordering it alone exhausted the pool.
    const paragraph = `${QUERY_WORDS} alongside `.repeat(12).trim();
    await addItem(
      {
        external_id: LECTURE,
        published_at: '2025-02-02',
        title: 'Four hours on the same subject',
        body: Array.from({ length: 70 }, () => paragraph).join('\n\n'),
      },
      [{ statement: 'The lecture holds forth.', quote: QUERY_WORDS, chunk_id: null, start_ms: null }],
    );

    await addItem(
      {
        external_id: SHARP,
        published_at: '2025-03-03',
        title: 'One line, exactly on it',
        body: `${QUERY_WORDS}.`,
      },
      [{ statement: 'The short one nails it.', quote: QUERY_WORDS, chunk_id: null, start_ms: null }],
    );

    for (let index = 0; index < FAIR_ITEMS; index += 1) {
      await addItem(
        {
          external_id: `fair-${index}`,
          published_at: '2025-04-04',
          title: `A short post, number ${index}`,
          body: `${QUERY_WORDS}, considered against notebook drafting alongside pricing.`,
        },
        [
          {
            statement: `Something the ${index}th short post holds.`,
            quote: QUERY_WORDS,
            chunk_id: null,
            start_ms: null,
          },
        ],
      );
    }

    const { rows } = await db.query<{ chunks: string }>(
      `select count(*)::text as chunks from braintrust_chunks c
         join braintrust_items i on i.id = c.item_id
        where i.external_id = $1`,
      [LECTURE],
    );
    return Number(rows[0]!.chunks);
  }

  it('ranks items rather than passages, so one long item cannot crowd out a corpus', async () => {
    const lectureChunks = await seedOneLongItemAndManyShort();
    assert.ok(
      lectureChunks > MATCH_ITEMS,
      `the fixture only tests anything if the lecture alone can fill the pool: ${lectureChunks} chunks`,
    );
    // One Position per claim, named after the claim rather than its place in the batch —
    // which Items survived retrieval is only observable if no two Positions share a slug,
    // and the default naming restarts its numbering on every fold.
    await compile((claims) =>
      claims.map((claim) => ({
        slug: `holds-${claim}`,
        statement: `What braintrust says ${claim} asserts.`,
        claims: [claim],
      })),
    );

    const answer = await find({ query: QUERY_WORDS, limit: 50 });
    const cited = new Set(
      answer.positions.flatMap((position) => position.citations.map((citation) => citation.url)),
    );

    // The bug, stated as an assertion. Truncating to 60 *chunks* before collapsing to
    // Items left one slot for the sharp post and 59 for the lecture, and every fair post
    // fell off the end — not for being a worse match than the lecture, but for being
    // shorter than it.
    for (let index = 0; index < FAIR_ITEMS; index += 1) {
      assert.ok(
        cited.has(`https://example.test/fair-${index}`),
        `fair-${index} clears the floor, so no amount of lecture may evict it`,
      );
    }

    // And relevance still decides the order: the one-line post beats four hours of
    // adjacent material, on its single best passage against the lecture's single best.
    assert.equal(answer.positions[0]!.citations[0]!.url, `https://example.test/${SHARP}`);
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

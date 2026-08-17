/**
 * The golden-question eval, against real Postgres.
 *
 * ../src/qa is thin glue around two things that are already proven elsewhere: `findPositions`
 * (find-positions.integration.test.ts) and an `Interrogator`'s `judge` (interrogate.test.ts).
 * What is worth proving here, end to end, is that the glue holds — a question drawn from a
 * real item's title finds its way back to a position that cites that same item, and a
 * judge's verdict survives the trip into a QAOutcome unchanged.
 *
 * Same fixture shape as find-positions.integration.test.ts: a real compile, built by the
 * real compileCorpus over real chunks and a deterministic bag-of-words embedder.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { compileCorpus } from '../src/compile/index.js';
import { createDb, type PostgresDb } from '../src/db.js';
import type { Interrogator } from '../src/interrogate/index.js';
import type { Verdict } from '../src/interrogate/assertions.js';
import { chunkItem, createEmbedder, createQueryGate, storeEmbeddings, type QueryGate } from '../src/retrieval/index.js';
import { goldenQuestions } from '../src/qa/sample.js';
import { runQuestion } from '../src/qa/run.js';
import { answeredNothing, groundedOf, RUNGS, reachedOf, scoreOutcomes, type QAOutcome } from '../src/qa/score.js';
import { fakeEmbeddings, testEmbeddingsConfig } from './support/embeddings.js';
import { fakeSynthesiser } from './support/synthesiser.js';
import { testDatabaseUrl as url } from './support/database.js';

const GENERATION = 'test-reader@notes-1';
const MODEL = testEmbeddingsConfig.model;

/**
 * Three items, not two — the compiler needs at least four quotes to measure its own
 * retrieval floor (see `docs/design/compiler.md` §7); below that it falls back to the
 * conservative unmeasured default, which this fixture's bag-of-words similarities do not
 * clear. Two claims per item, as find-positions.integration.test.ts's fixture uses.
 *
 * Each body opens with its own title, the way a real post's opening sentence often carries
 * the title's words. That is load-bearing since #323 raised the gate to a 0.52 minimum:
 * a golden question *is* the item's title, and against this bag-of-words fake a title that
 * shares no words with its body scores 0.13–0.39 — below any floor the gate will serve. A
 * chunk braintrust actually indexes has to carry the asked words, or nothing is grounded.
 */
const ITEMS = [
  {
    external_id: 'evals',
    published_at: '2024-01-09',
    title: 'Evals precede the harness',
    body:
      'Evals precede the harness. You write the evals before you write the harness. Every team ' +
      'that skips this ends up tuning prompts against a vibe. The eval is the specification, and ' +
      'the harness is only the thing that runs it.',
    claims: [
      {
        statement: 'Evals should be written before the harness that runs them.',
        quote: 'You write the evals before you write the harness',
      },
      { statement: 'An eval is a specification.', quote: 'The eval is the specification' },
    ],
  },
  {
    external_id: 'context',
    published_at: '2025-06-01',
    title: 'Context windows are not memory',
    body:
      'Context windows are not memory. A context window is a buffer that forgets everything the ' +
      'moment the request ends, and treating it as memory is how people end up rebuilding a ' +
      'database badly inside a prompt.',
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
      'Still writing evals first. I said it two years ago and I will say it again: the eval comes ' +
      'first. If you cannot measure whether the change helped, you are not engineering, you are ' +
      'decorating.',
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
const CLAIM_STATEMENTS = [...ITEMS].reverse().flatMap((item) => item.claims.map((claim) => claim.statement));

describe('the golden-question eval, against real Postgres', () => {
  let db: PostgresDb;
  let sourceId: string;
  let retrieval: QueryGate;
  const embedder = createEmbedder(testEmbeddingsConfig, fakeEmbeddings().fetcher);

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
      `insert into braintrust_people (slug, display_name) values ('p', 'P') returning id`,
    );
    const personId = person.rows[0]!.id;

    const source = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor,
                                       backfill_complete)
       values ($1, 'substack', 'p.substack.com', 'https://example.test/feed', current_date - 3650, true)
       returning id`,
      [personId],
    );
    sourceId = source.rows[0]!.id;

    for (const item of ITEMS) await addItem(item);

    // Graded, the same way find-positions.integration.test.ts's `graded()` compile is: the
    // corpus's own embedder measures the floor and the fit cut, rather than falling back to
    // the conservative default — which is what lets a question this small a fixture answers
    // clear the gate at all.
    await compileCorpus({
      db,
      extractor: GENERATION,
      synthesiser: fakeSynthesiser({
        positionsFor: (claims) =>
          claims.map((claim, index) => ({
            slug: `position-${index}`,
            statement: CLAIM_STATEMENTS[index] ?? `Position ${index}, as braintrust would put it.`,
            claims: [claim],
          })),
      }),
      embedder,
      log: () => {},
    });
  }

  async function addItem(item: (typeof ITEMS)[number]): Promise<void> {
    const inserted = await db.query<{ id: string }>(
      `insert into braintrust_items (source_id, external_id, url, title, audience, retrieval,
                                     body_text, published_at)
       values ($1, $2, $3, $4, 'everyone', 'retrieved', $5, $6) returning id`,
      [sourceId, item.external_id, `https://example.test/${item.external_id}`, item.title, item.body, item.published_at],
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
      [
        itemId,
        GENERATION,
        JSON.stringify(item.claims.map((claim) => ({ ...claim, chunk_id: null, start_ms: null }))),
      ],
    );
  }

  /** Says whatever it is told to. A live judge is interrogate.test.ts's job, not this one's. */
  function stubInterrogator(options: { holds?: boolean; throws?: boolean } = {}): Interrogator {
    return {
      generation: 'stub@interrogation-x',
      async reply(): Promise<string> {
        return '';
      },
      async judge(): Promise<Verdict> {
        if (options.throws) throw new Error('judge unreachable');
        return { holds: options.holds ?? true, why: 'stub verdict' };
      },
    };
  }

  it('samples one question per titled item, the same way every time', async () => {
    const first = await goldenQuestions(db, 'p', 10);
    const second = await goldenQuestions(db, 'p', 10);

    assert.equal(first.length, 3);
    assert.deepEqual(
      first.map((question) => question.query).sort(),
      ['Context windows are not memory', 'Evals precede the harness', 'Still writing evals first'],
    );
    assert.deepEqual(
      first.map((question) => question.item_id),
      second.map((question) => question.item_id),
      'a sample that moves between runs cannot be scored against a fixed baseline',
    );
  });

  it('finds the position the question was drawn from, and marks it grounded', async () => {
    const [question] = await goldenQuestions(db, 'p', 1);
    const outcome = await runQuestion(question!, { db, embedder, retrieval }, stubInterrogator({ holds: true }));

    assert.equal(outcome.passed, true);
    assert.equal(outcome.detail, 'stub verdict');
    assert.equal(outcome.rung, 'grounded', 'the top position cites the very item the question was drawn from');
    assert.equal(groundedOf(outcome.rung), true, 'the derived grounded flag still travels with the rung');
    assert.equal(reachedOf(outcome.rung), true, 'and retrieval plainly reached it');
    assert.ok(outcome.fit, 'a position came back, so it has a fit grade');
  });

  it('scores a batched item on the post permalink, not the day it was read in', async () => {
    const [asked] = await goldenQuestions(db, 'p', 1);

    // What a Bluesky day looks like once compiled: every citation resolves to the
    // individual skeet the quote fell inside, so the item's own url appears nowhere in the
    // answer. Compared against that url alone, a perfect answer scored ungrounded.
    await db.query(`update braintrust_position_citations set post_url = $2 where item_id = $1`, [
      asked!.item_id,
      'https://example.test/skeet-1',
    ]);

    const [question] = await goldenQuestions(db, 'p', 1);
    assert.ok(
      question!.citation_urls.includes('https://example.test/skeet-1'),
      'the golden set collects the urls a citation can actually carry',
    );

    const outcome = await runQuestion(question!, { db, embedder, retrieval }, stubInterrogator({ holds: true }));
    assert.equal(outcome.rung, 'grounded', 'the batched item resolves, so the answer rests on it');
  });

  it('records a judge that could not be reached as unjudged, not failed', async () => {
    const [question] = await goldenQuestions(db, 'p', 1);
    const outcome = await runQuestion(question!, { db, embedder, retrieval }, stubInterrogator({ throws: true }));

    assert.equal(outcome.passed, null);
    assert.match(outcome.detail, /judge unreachable/);
    assert.ok(RUNGS.includes(outcome.rung), 'the ladder is scored even when no verdict is possible');
  });

  it('marks a question whose item no Position ever cites as uncovered', async () => {
    // A titled, retrieved item the compiler read and held — but formed no Position over.
    // The body opens with its title, the way #323's raised 0.52 gate demands of a golden
    // question (a title that shares no words with its body scores below the floor). The
    // served answer is the #325 uncovered shape — read_without_position beside the raw
    // passages — and what no compiled Position cites is exactly the uncovered rung.
    await addItem({
      external_id: 'unheld',
      published_at: '2025-01-02',
      title: 'Read aloud and never held',
      body: 'Read aloud and never held. Most posts are read once and never turned into a position, and that is fine.',
      claims: [],
    });

    const questions = await goldenQuestions(db, 'p', 100);
    const [question] = questions.filter((one) => one.item_url === 'https://example.test/unheld');
    assert.ok(question, 'the golden set asks about the item');

    const outcome = await runQuestion(question!, { db, embedder, retrieval }, stubInterrogator({ holds: true }));
    assert.equal(outcome.rung, 'uncovered');
    assert.equal(answeredNothing(outcome.rung), true, 'no Position came back, so there is nothing to judge');
    assert.equal(outcome.passed, null, 'an empty answer is reported as answered nothing, never passed');
  });

  it('assigns one rung per real question, so the ladder sums to the questions asked', async () => {
    const questions = await goldenQuestions(db, 'p', 10);
    const outcomes: QAOutcome[] = [];
    for (const question of questions) {
      outcomes.push(await runQuestion(question, { db, embedder, retrieval }, stubInterrogator()));
    }

    const card = scoreOutcomes('p', outcomes);
    assert.equal(card.asked, questions.length);
    assert.equal(
      RUNGS.reduce((sum, rung) => sum + card.rungs[rung], 0),
      card.asked,
      'each question lands on exactly one rung, end to end',
    );
    assert.ok(outcomes.every((outcome) => RUNGS.includes(outcome.rung)));
  });
});

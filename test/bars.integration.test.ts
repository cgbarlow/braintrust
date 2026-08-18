/**
 * The bars, end to end, against real Postgres.
 *
 * ../src/qa/bars.ts proves the rules and the ledger half with an in-memory database;
 * ../src/qa/measure.ts and ../src/qa/run.ts are thin glue around `findPositions` and
 * `candidateRank`, already proven by find-positions.integration.test.ts. What is worth
 * proving here, with real rows and real embeddings, is that the two join up: a persona
 * below the grounded bar opens exactly one deduped fault naming itself and the measured
 * number, a persona at or above it opens nothing, and a passing run clears the row — the
 * same rail the interrogation files on, with no judge call anywhere in the path.
 *
 * Same fixture shape as qa.integration.test.ts: a real compile built by the real
 * `compileCorpus` over real chunks and a deterministic bag-of-words embedder.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { compileCorpus } from '../src/compile/index.js';
import { createDb, type PostgresDb } from '../src/db.js';
import { runBarChecks } from '../src/interrogate/bars.js';
import { createQueryGate, type QueryGate } from '../src/retrieval/index.js';
import { GROUNDED_BAR_FAULT, OFF_DOMAIN_FAULT } from '../src/qa/bars.js';
import { measureFleetBars, measurePersonaBars } from '../src/qa/measure.js';
import { chunkItem, createEmbedder, storeEmbeddings } from '../src/retrieval/index.js';
import { fakeEmbeddings, testEmbeddingsConfig } from './support/embeddings.js';
import { fakeSynthesiser } from './support/synthesiser.js';
import { testDatabaseUrl as url } from './support/database.js';

const GENERATION = 'test-reader@notes-1';
const MODEL = testEmbeddingsConfig.model;

const GROUNDED = [
  {
    external_id: 'evals',
    published_at: '2024-01-09',
    title: 'Evals precede the harness',
    body:
      'Evals precede the harness. You write the evals before you write the harness. Every ' +
      'team that skips this ends up tuning prompts against a vibe.',
    claims: [
      { statement: 'Evals should be written before the harness that runs them.', quote: 'You write the evals before you write the harness' },
    ],
  },
  {
    external_id: 'context',
    published_at: '2025-06-01',
    title: 'Context windows are not memory',
    body:
      'Context windows are not memory. A context window is a buffer that forgets everything ' +
      'the moment the request ends.',
    claims: [
      { statement: 'A context window is a buffer rather than memory.', quote: 'A context window is not memory' },
    ],
  },
  {
    external_id: 'evals-again',
    published_at: '2026-03-11',
    title: 'Still writing evals first',
    body:
      'Still writing evals first. I said it two years ago and I will say it again: the eval ' +
      'comes first.',
    claims: [
      { statement: 'The eval still comes before everything else.', quote: 'the eval comes first' },
    ],
  },
];

/**
 * A drag item: titled, retrieved, and cited — so it is *covered* — but its body never uses
 * its title's words. Against the bag-of-words embedder a question that shares no words
 * with its body scores 0.13–0.39, below the gate, so the question lands on `withheld`.
 * Withheld stays in the denominator (§5.2), so a drag item lowers the grounded rate
 * without touching the coverage count.
 */
const DRAG = [
  {
    external_id: 'sovereign',
    published_at: '2025-02-10',
    title: 'What a sovereign speaks',
    body:
      'Every reading held a long running argument about fences and the bureaus that build ' +
      'them, and the argument survived the reading long after the pages were closed.',
    claims: [
      { statement: 'Fences are the province of bureaus.', quote: 'the bureaus that build them' },
    ],
  },
  {
    external_id: 'bands',
    published_at: '2024-11-20',
    title: 'The bands and the floors',
    body:
      'The afternoon spent in winter recovering cold fruit from a basket behind the kitchen ' +
      'door taught more about patience than any book.',
    claims: [
      { statement: 'Patience is learned from cold fruit.', quote: 'cold fruit from a basket' },
    ],
  },
];

/**
 * An item nobody asked about that nevertheless answers one of the canonical off-domain
 * questions: its body is dense with the words of "How do I feed and maintain a sourdough
 * starter?", so retrieval genuinely reaches it and counts as a false answer.
 */
const SOURDOUGH = {
  external_id: 'sourdough-shop',
  published_at: '2026-01-15',
  title: 'Bread at the corner shop',
  body:
    'To feed a sourdough starter you maintain it daily, and you maintain a sourdough ' +
    'starter by feeding it, because a sourdough starter that is not fed cannot rise and a ' +
    'sourdough starter that is fed and maintained rises. This sourdough starter is fed and ' +
    'maintained every day, so it rises, and the sourdough starter keeps rising because ' +
    'sourdough rises with a maintained and fed sourdough starter.',
  claims: [
    { statement: 'Bread rises with a kept starter.', quote: 'sourdough rises with a sourdough starter' },
  ],
};

const CLAIM_STATEMENTS = (items: readonly { claims: { statement: string }[] }[]): string[] =>
  [...items].reverse().flatMap((item) => item.claims.map((claim) => claim.statement));

describe('the bars, end to end, against real Postgres', () => {
  let db: PostgresDb;
  let retrieval: QueryGate;
  const embedder = createEmbedder(testEmbeddingsConfig, fakeEmbeddings().fetcher);

  before(async () => {
    db = createDb(url!);
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (db) {
      await db.query('truncate braintrust_people cascade');
      await db.query('truncate braintrust_faults');
      await db.close();
    }
  });

  beforeEach(async () => {
    await db.query('truncate braintrust_people cascade');
    await db.query('truncate braintrust_faults');
    retrieval = createQueryGate(db, MODEL);
  });

  async function seed(person: string, items: readonly (typeof GROUNDED)[number][]): Promise<void> {
    const inserted = await db.query<{ id: string }>(
      `insert into braintrust_people (slug, display_name) values ($1, $2) returning id`,
      [person, person.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())],
    );
    const personId = inserted.rows[0]!.id;

    const source = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor,
                                       backfill_complete)
       values ($1, 'substack', $2, 'https://example.test/feed', current_date - 3650, true)
       returning id`,
      [personId, `${person}.substack.com`],
    );
    const sourceId = source.rows[0]!.id;

    for (const item of items) {
      const written = await db.query<{ id: string }>(
        `insert into braintrust_items (source_id, external_id, url, title, audience, retrieval,
                                       body_text, published_at)
         values ($1, $2, $3, $4, 'everyone', 'retrieved', $5, $6) returning id`,
        [sourceId, item.external_id, `https://example.test/${person}/${item.external_id}`, item.title, item.body, item.published_at],
      );
      const itemId = written.rows[0]!.id;

      for (const chunk of chunkItem({ text: item.body, raw: null })) {
        const stored = await db.query<{ id: string }>(
          `insert into braintrust_chunks (item_id, ordinal, text, char_start, char_end, start_ms, end_ms)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [itemId, chunk.ordinal, chunk.text, chunk.charStart, chunk.charEnd, chunk.startMs, chunk.endMs],
        );
        const [vector] = await embedder.embed([chunk.text]);
        await storeEmbeddings(db, MODEL, [{ chunkId: stored.rows[0]!.id, vector: vector! }]);
      }

      await db.query(
        `insert into braintrust_item_notes (item_id, extractor, claims, argument_md, assumptions)
         values ($1, $2, $3::jsonb, 'an argument', '[]'::jsonb)`,
        [itemId, GENERATION, JSON.stringify(item.claims.map((claim) => ({ ...claim, chunk_id: null, start_ms: null })))],
      );
    }

    await compileCorpus({
      db,
      extractor: GENERATION,
      synthesiser: fakeSynthesiser({
        positionsFor: (claims) => {
          const statements = CLAIM_STATEMENTS(items);
          return claims.map((claim, index) => ({
            slug: `position-${index}`,
            statement: statements[index] ?? `Position ${index}, as braintrust would put it.`,
            claims: [claim],
          }));
        },
      }),
      embedder,
      log: () => {},
    });
  }

  function measureDeps() {
    return { db, embedder, retrieval };
  }

  it('measures a persona at or above the bar and opens no fault at all', async () => {
    await seed('above', GROUNDED);

    const measurement = await measurePersonaBars(db, 'above', measureDeps());
    assert.equal(measurement.covered, 3, 'all three items are covered');
    assert.equal(measurement.grounded, 3, 'and all three answers rest on the thing asked');
    assert.equal(measurement.groundedRate, 1);
    assert.equal(measurement.offDomainFalseAnswers, 0, 'off-domain questions are met with silence');

    const report = await runBarChecks({ db, measure: measureDeps(), log: () => {} });
    assert.equal(report!.opened.length, 0);
    assert.equal(report!.cleared.length, 0);
    const { rows } = await db.query<{ assertion: string }>('select assertion from braintrust_faults');
    assert.deepEqual(rows, []);
  });

  it('opens one deduped fault for a persona below the grounded bar, naming the persona and the number', async () => {
    await seed('below', [...GROUNDED, ...DRAG]);

    const measurement = await measurePersonaBars(db, 'below', measureDeps());
    assert.equal(measurement.covered, GROUNDED.length + DRAG.length, 'the drag items are covered too');
    assert.equal(measurement.grounded, GROUNDED.length, 'only the grounded items rest on the thing asked');
    assert.ok(measurement.groundedRate! < 0.7, `expected below the bar, got ${measurement.groundedRate}`);

    const first = await runBarChecks({ db, measure: measureDeps(), log: () => {} });
    assert.deepEqual(
      first!.opened.map((one) => [one.bar, one.person]),
      [[GROUNDED_BAR_FAULT, 'below']],
    );
    assert.match(first!.opened[0]!.detail, /below/);
    assert.match(first!.opened[0]!.detail, /below the 70% bar/);

    const { rows: once } = await db.query<{ assertion: string; person_slug: string; detail: string }>(
      'select assertion, person_slug, detail from braintrust_faults',
    );
    assert.deepEqual(once.map((row) => row.assertion), [GROUNDED_BAR_FAULT]);
    assert.match(once[0]!.detail, /below/);
    assert.match(once[0]!.detail, /below the 70% bar/);

    // The row is the deduplication: re-observing the same measurement files nothing new.
    await runBarChecks({ db, measure: measureDeps(), log: () => {} });
    const { rows: still } = await db.query<{ assertion: string }>('select assertion from braintrust_faults');
    assert.deepEqual(still.map((row) => row.assertion), [GROUNDED_BAR_FAULT]);
  });

  it('clears the fault on a passing run, and leaves no trace of the row behind', async () => {
    await seed('below', [...GROUNDED, ...DRAG]);
    await runBarChecks({ db, measure: measureDeps(), log: () => {} });

    // Remove the drag items — citations first, because `item_id` is not a casketed
    // reference — so the same persona's questions are only about what it grounds on.
    await db.query(
      `delete from braintrust_positions
        where id in (
          select pc.position_id
            from braintrust_position_citations pc
            join braintrust_items i on i.id = pc.item_id
           where i.title = any($1::text[])
        )`,
      [DRAG.map((item) => item.title)],
    );
    await db.query(`delete from braintrust_items where title = any($1::text[])`, [
      DRAG.map((item) => item.title),
    ]);

    const measurement = await measurePersonaBars(db, 'below', measureDeps());
    assert.equal(measurement.covered, GROUNDED.length);
    assert.equal(measurement.groundedRate, 1, 'the same persona now clears the bar');

    const report = await runBarChecks({ db, measure: measureDeps(), log: () => {} });
    assert.deepEqual(
      report!.cleared.map((one) => [one.bar, one.person]),
      [[GROUNDED_BAR_FAULT, 'below']],
    );
    const { rows } = await db.query<{ assertion: string }>('select assertion from braintrust_faults');
    assert.deepEqual(rows, [], 'the fault is gone, so the layer is not withdrawn and nothing more is told');
  });

  it('opens an off-domain fault when a persona answers a question it has no material for', async () => {
    await seed('offender', [...GROUNDED, SOURDOUGH]);

    const measurement = await measurePersonaBars(db, 'offender', measureDeps());
    assert.equal(measurement.offDomainAsked, 6);
    assert.ok(
      measurement.offDomainFalseAnswers > 0,
      `expected at least one off-domain answer, got ${measurement.offDomainFalseAnswers}`,
    );

    const report = await runBarChecks({ db, measure: measureDeps(), log: () => {} });
    const opened = report!.opened.find((one) => one.bar === OFF_DOMAIN_FAULT);
    assert.ok(opened, 'the off-domain bar opens its own fault');
    assert.match(opened!.detail, /offender/);
    assert.match(opened!.detail, /off-domain/);

    const { rows } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults where person_slug = $1',
      ['offender'],
    );
    assert.ok(rows.some((row) => row.assertion === OFF_DOMAIN_FAULT));
  });

  it('never opens a fleet-average fault — the row is per persona and names exactly one', async () => {
    await seed('chris-barlow', [...GROUNDED, ...DRAG]);
    await seed('stuart-winter-tear', GROUNDED);

    const measurements = await measureFleetBars(db, measureDeps());
    assert.equal(measurements.length, 2);
    assert.deepEqual(measurements.map((m) => m.person).sort(), ['chris-barlow', 'stuart-winter-tear']);

    const report = await runBarChecks({ db, measure: measureDeps(), log: () => {} });
    const opened = report!.opened;
    assert.deepEqual(
      opened.map((one) => [one.bar, one.person]),
      [[GROUNDED_BAR_FAULT, 'chris-barlow']],
      'the below-bar persona is faulted by name; the at-bar persona is untouched',
    );
    const { rows } = await db.query<{ assertion: string; person_slug: string }>(
      'select assertion, person_slug from braintrust_faults',
    );
    assert.deepEqual(rows.map((row) => [row.assertion, row.person_slug]), [
      [GROUNDED_BAR_FAULT, 'chris-barlow'],
    ]);
  });
});

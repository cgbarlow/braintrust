/**
 * Calibrating the gate at Compile time.
 *
 * The properties worth pinning are the ones that make this safe to run unattended, because
 * that is the whole point of it: it must never invent a number, never fail a Compile, and
 * never quietly report a threshold it could not measure as though it had.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANCHOR,
  calibrateSelectivity,
  MIN_IN_CORPUS,
  notMeasurable,
  OFF_CORPUS_PROBES,
} from '../src/compile/selectivity.js';
import { SELECTIVITY_MARGIN } from '../src/find.js';
import { fakeDb } from './support/fake-db.js';

/**
 * A database that answers the selectivity query with a chosen margin per question, and an
 * embedder whose vector encodes which question it was — so a test can say "this question
 * scores 0.4" without going near pgvector.
 */
function harness(margins: Record<string, number>, fallback = 0.01) {
  const order: string[] = [];
  const embedder = {
    model: 'test-embeddings',
    url: 'https://example.test/v1/embeddings',
    async embed(inputs: string[]): Promise<number[][]> {
      order.push(...inputs);
      return inputs.map((_, i) => [i]);
    },
  };
  let served = 0;
  const db = fakeDb(() => {
    const question = order[served++];
    const margin = question !== undefined && question in margins ? margins[question]! : fallback;
    // top - median is what the calibrator reads.
    return [{ top: 0.5 + margin, median: 0.5 }];
  });
  return { db, embedder };
}

const STATEMENTS = ['p one', 'p two', 'p three', 'p four', 'p five', 'p six'];

describe('calibrating the gate', () => {
  it('puts the threshold above every off-corpus probe and below every position', async () => {
    const margins: Record<string, number> = {};
    for (const s of STATEMENTS) margins[s] = 0.4;
    for (const q of OFF_CORPUS_PROBES) margins[q] = 0.1;

    const { db, embedder } = harness(margins);
    const result = await calibrateSelectivity({
      db,
      embedder,
      person: 'ethan-mollick',
      statements: STATEMENTS,
    });

    assert.equal(result.basis, 'separated');
    assert.ok(result.margin > 0.1, 'above every off-corpus probe');
    assert.ok(result.margin < 0.4, 'below every position this persona holds');
    assert.equal(result.in_low, 0.4);
    assert.equal(result.out_high, 0.1);
  });

  it('anchors near the off-corpus ceiling, not midway', async () => {
    // Position statements are an optimistic in-group — a real question is fuzzier and
    // scores lower — so a midpoint threshold would inherit that optimism and start
    // refusing real questions. This is the asymmetry, asserted rather than described.
    const margins: Record<string, number> = {};
    for (const s of STATEMENTS) margins[s] = 0.5;
    for (const q of OFF_CORPUS_PROBES) margins[q] = 0.1;

    const { db, embedder } = harness(margins);
    const result = await calibrateSelectivity({ db, embedder, person: 'p', statements: STATEMENTS });

    const midpoint = (0.5 + 0.1) / 2;
    assert.ok(result.margin < midpoint, 'sits below the midpoint');
    assert.equal(result.margin, 0.1 + (0.5 - 0.1) * ANCHOR);
  });

  it('reports an endpoint that cannot separate the two groups, rather than hiding it', async () => {
    const margins: Record<string, number> = {};
    for (const s of STATEMENTS) margins[s] = 0.2;
    for (const q of OFF_CORPUS_PROBES) margins[q] = 0.3; // off-corpus scores higher

    const { db, embedder } = harness(margins);
    const result = await calibrateSelectivity({ db, embedder, person: 'p', statements: STATEMENTS });

    assert.equal(result.basis, 'overlapping');
    assert.equal(result.margin, 0.3, 'the off-corpus ceiling — the most it can honestly claim');
    assert.match(result.note, /did not separate/);
  });

  it('falls back rather than guessing when there are too few positions to probe with', async () => {
    const { db, embedder } = harness({});
    const result = await calibrateSelectivity({
      db,
      embedder,
      person: 'p',
      statements: STATEMENTS.slice(0, MIN_IN_CORPUS - 1),
    });

    assert.equal(result.basis, 'not_measurable');
    assert.equal(result.margin, SELECTIVITY_MARGIN);
    assert.equal(result.in_low, null);
    assert.match(result.note, /not a measured value/);
  });

  it('never reports a measured basis without the evidence for one', async () => {
    const fallback = notMeasurable('No embeddings endpoint is configured.');
    assert.equal(fallback.basis, 'not_measurable');
    assert.equal(fallback.in_low, null);
    assert.equal(fallback.out_high, null);
    assert.deepEqual(fallback.probes, { in: 0, out: 0 });
  });

  it('samples positions across the list rather than taking the top of it', async () => {
    // Positions arrive grouped by topic, so the first N would measure one corner of the
    // corpus and call it the whole thing.
    const many = Array.from({ length: 60 }, (_, i) => `position ${i}`);
    const margins: Record<string, number> = {};
    for (const s of many) margins[s] = 0.4;
    for (const q of OFF_CORPUS_PROBES) margins[q] = 0.1;

    const { db, embedder } = harness(margins);
    const seen: string[] = [];
    const spy = {
      ...embedder,
      async embed(inputs: string[]) {
        seen.push(...inputs);
        return embedder.embed(inputs);
      },
    };

    await calibrateSelectivity({ db, embedder: spy, person: 'p', statements: many });
    const sampled = seen.filter((q) => q.startsWith('position '));
    const indices = sampled.map((q) => Number(q.split(' ')[1]));
    assert.ok(Math.max(...indices) > 30, 'reaches the far end of the list');
  });
});

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
import { RETRIEVAL_FLOOR } from '../src/find.js';
import { fakeDb } from './support/fake-db.js';

/**
 * A database that answers the selectivity query with a chosen margin per question, and an
 * embedder whose vector encodes which question it was — so a test can say "this question
 * scores 0.4" without going near pgvector.
 */
function harness(tops: Record<string, number>, fallback = 0.3) {
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
    const top = question !== undefined && question in tops ? tops[question]! : fallback;
    // Absolute top similarity is what the calibrator reads.
    return [{ top, median: 0.2 }];
  });
  return { db, embedder };
}

const STATEMENTS = ['p one', 'p two', 'p three', 'p four', 'p five', 'p six'];

describe('calibrating the gate', () => {
  it('puts the threshold above every off-corpus probe and below every position', async () => {
    const tops: Record<string, number> = {};
    for (const s of STATEMENTS) tops[s] = 0.8;
    for (const q of OFF_CORPUS_PROBES) tops[q] = 0.45;

    const { db, embedder } = harness(tops);
    const result = await calibrateSelectivity({
      db,
      embedder,
      person: 'ethan-mollick',
      statements: STATEMENTS,
    });

    assert.equal(result.separation, 'separated');
    assert.ok(result.floor > 0.45, 'above every off-corpus probe');
    assert.ok(result.floor < 0.8, 'below every position this persona holds');
    assert.equal(result.in_low, 0.8);
    assert.equal(result.out_high, 0.45);
    assert.equal(result.span, 0.35);
  });

  it('anchors near the off-corpus ceiling, not midway', async () => {
    // Position statements are an optimistic in-group — a real question is fuzzier and
    // scores lower — so a midpoint threshold would inherit that optimism and start
    // refusing real questions. This is the asymmetry, asserted rather than described.
    const tops: Record<string, number> = {};
    for (const s of STATEMENTS) tops[s] = 0.85;
    for (const q of OFF_CORPUS_PROBES) tops[q] = 0.45;

    const { db, embedder } = harness(tops);
    const result = await calibrateSelectivity({ db, embedder, person: 'p', statements: STATEMENTS });

    const midpoint = (0.85 + 0.45) / 2;
    assert.ok(result.floor < midpoint, 'sits below the midpoint');
    assert.equal(result.floor, 0.45 + (0.85 - 0.45) * ANCHOR);
  });

  it('reports an endpoint that cannot separate the two groups, rather than hiding it', async () => {
    const tops: Record<string, number> = {};
    for (const s of STATEMENTS) tops[s] = 0.5;
    for (const q of OFF_CORPUS_PROBES) tops[q] = 0.6; // off-corpus scores higher

    const { db, embedder } = harness(tops);
    const result = await calibrateSelectivity({ db, embedder, person: 'p', statements: STATEMENTS });

    assert.equal(result.separation, 'overlapping');
    // Deliberately permissive, and a reversal: the margin version enforced the off-corpus
    // ceiling here and refused a live persona's own subject. A persona that over-answers
    // can be challenged by a reader; one that refuses everything is worth less than none.
    assert.equal(result.floor, RETRIEVAL_FLOOR, 'the measurement is discarded, not enforced');
    assert.equal(result.span, null, 'and fit is given no scale it did not earn');
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

    assert.equal(result.separation, 'not_measurable');
    assert.equal(result.floor, RETRIEVAL_FLOOR);
    assert.equal(result.in_low, null);
    assert.match(result.note, /not a measured value/);
  });

  it('never reports a measured outcome without the evidence for one', async () => {
    const fallback = notMeasurable('No embeddings endpoint is configured.');
    assert.equal(fallback.separation, 'not_measurable');
    assert.equal(fallback.in_low, null);
    assert.equal(fallback.out_high, null);
    assert.deepEqual(fallback.probes, { in: 0, out: 0 });
  });

  it('samples positions across the list rather than taking the top of it', async () => {
    // Positions arrive grouped by topic, so the first N would measure one corner of the
    // corpus and call it the whole thing.
    const many = Array.from({ length: 60 }, (_, i) => `position ${i}`);
    const tops: Record<string, number> = {};
    for (const s of many) tops[s] = 0.8;
    for (const q of OFF_CORPUS_PROBES) tops[q] = 0.45;

    const { db, embedder } = harness(tops);
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

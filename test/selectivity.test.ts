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
  backgroundFor,
  calibrateSelectivity,
  MIN_IN_CORPUS,
  notMeasurable,
  OFF_CORPUS_PROBES,
} from '../src/compile/selectivity.js';
import { UNMEASURED_RETRIEVAL_FLOOR } from '../src/unmeasured.js';
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
    // Discarded rather than enforced, which is the lesson the margin version taught: it
    // put the threshold at the off-corpus ceiling — a number measured by the instrument
    // that had just failed — and refused a live persona its own subject. What stands in
    // its place is a constant measured nowhere, and the cautious one.
    assert.equal(
      result.floor,
      UNMEASURED_RETRIEVAL_FLOOR,
      'the measurement is discarded, not enforced — and what stands in its place is the cautious value',
    );
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
    assert.equal(result.floor, UNMEASURED_RETRIEVAL_FLOOR);
    assert.equal(result.in_low, null);
    assert.match(result.note, /unmeasured default/);
  });

  /**
   * The rule this file exists to hold up. An absence of evidence had been read as evidence
   * of absence: the fallback sat at 0.35 while every floor braintrust had ever measured sat
   * between 0.44 and 0.52, so the persona that knew least about its own gate was the one
   * most willing to answer. That is how a persona answered about poaching an egg.
   */
  it('falls back above the measured range, so an uncalibrated persona is cautious not credulous', async () => {
    const { db, embedder } = harness({});
    const result = await calibrateSelectivity({
      db,
      embedder,
      person: 'p',
      statements: STATEMENTS.slice(0, MIN_IN_CORPUS - 1),
    });

    assert.ok(result.floor > 0.52, 'above every floor braintrust has measured');
    // A constant, never a calculation over what other personas measured — one person's
    // calibration must not move another person's gate.
    assert.equal(result.floor, UNMEASURED_RETRIEVAL_FLOOR);
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

/**
 * The other half of what the off-corpus probes are for. The gate uses them to decide whether
 * a corpus will answer at all; this uses them to decide which of its positions answers best.
 */
describe('what a statement is worth net of being about everything', () => {
  // Three axes is enough: a statement can point at one probe, at all of them, or away.
  const probes = [
    [1, 0, 0],
    [0, 1, 0],
  ];

  it('scores a statement that leans towards everything above one that leans away', () => {
    const broad = [1, 1, 0];
    const specific = [0, 0, 1];

    const [broadBackground, specificBackground] = backgroundFor([broad, specific], probes);

    assert.ok(broadBackground! > specificBackground!);
    assert.equal(specificBackground, 0, 'a statement orthogonal to every probe leans nowhere');
  });

  it('is the mean rather than the best match, so one near probe cannot stand for the set', () => {
    // Dead-on one probe and orthogonal to the other. A maximum would call this as broad as
    // something near both, which is the opposite of what the number is for.
    const [background] = backgroundFor([[1, 0, 0]], probes);

    assert.equal(background, 0.5);
  });

  it('returns zero for every statement when there are no probes to measure against', () => {
    // The endpoint refused the probe batch. The correction is then unmeasured, and an
    // unmeasured correction is never an enforced one — the caller writes null and the
    // scorer coalesces it, so the persona ranks exactly as it did before this existed.
    assert.deepEqual(backgroundFor([[1, 0, 0], [0, 1, 0]], []), [0, 0]);
  });

  it('measures one number per statement, in the order it was handed them', () => {
    const backgrounds = backgroundFor([[1, 0, 0], [0, 0, 1], [0, 1, 0]], probes);

    assert.equal(backgrounds.length, 3);
    assert.equal(backgrounds[1], 0, 'the specific one is second in, and second out');
  });
});

/**
 * The `fit` grade, on its own.
 *
 * `fit` exists because #115 found that `measured` + `high` + four dated quotes reads as
 * licence to answer, and a Position can be well evidenced and still be no answer to the
 * question asked. It is the only thing in the payload whose job is to say *this one does
 * not answer you*.
 *
 * So the property worth a test of its own is the one it shipped without: that it can
 * actually say no. It has now failed at that three times and every failure was the same
 * shape — a grade about the question computed from a quantity every Position in the answer
 * shared. These tests pin the shape rather than the instance.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { calibrateFit, MIN_IN_CORPUS_QUOTES, notGradeable } from '../src/compile/fit.js';
import { ANCHOR, OFF_CORPUS_PROBES } from '../src/compile/selectivity.js';
import type { Db } from '../src/db.js';
import { fitOf } from '../src/find.js';
import type { Embedder } from '../src/retrieval/embed.js';

describe('fit', () => {
  const scale = { cut: 0.5, span: 0.3 };

  it('does not grade the best match close merely for being the best match', () => {
    // The first defect: fit divided by the query's own range, so the top match scored
    // exactly 1.0 and graded close for every query ever asked — including poaching an
    // egg. Nothing about being first in a list may earn `close`.
    const barelyClear = scale.cut + scale.span * 0.05;
    assert.notEqual(fitOf(barelyClear, scale), 'close');
  });

  it('grades a match that stands well above the cut close', () => {
    assert.equal(fitOf(scale.cut + scale.span * 0.8, scale), 'close');
  });

  it('grades a match that only middlingly clears the cut partial', () => {
    assert.equal(fitOf(scale.cut + scale.span * 0.4, scale), 'partial');
  });

  it('grades a match barely above the cut distant', () => {
    assert.equal(fitOf(scale.cut + scale.span * 0.1, scale), 'distant');
  });

  it('grades on height above the cut, not on rank', () => {
    // The same height above each persona's own cut means the same thing, whether that cut
    // sits high or low. A grade that moved with the answer would be the first defect
    // returning.
    assert.equal(
      fitOf(0.3 + scale.span * 0.8, { cut: 0.3, span: scale.span }),
      fitOf(0.7 + scale.span * 0.8, { cut: 0.7, span: scale.span }),
    );
  });

  /**
   * **The third defect, and the one that closes the class.** `fit` graded the best Chunk of
   * the best Item behind a Position, which every Position drawn from that Item shares: 41 of
   * 92 live Positions carried a number identical to another's, and three read `close` on a
   * question none of them answered. The grade now takes a number measured on the Position's
   * own statement, and the signature is what makes the old inputs unsayable.
   */
  it('is computed from a number about one position, and nothing an answer holds in common', async () => {
    const source = await readFile(new URL('../src/find.ts', import.meta.url), 'utf8');

    // The quantities that carried no information about the question: the query's own top,
    // the corpus's median, the item's chunk distance, and the gate's floor — which is
    // measured on a different quantity again. None may reach the grade.
    const signature = /export function fitOf\(([^)]*)\)/s.exec(source)![1]!;
    for (const banned of ['top', 'median', 'distance', 'floor']) {
      assert.doesNotMatch(signature, new RegExp(`\\b${banned}\\b`), `${banned} may not grade fit`);
    }
  });

  describe('when the persona has measured no scale of its own', () => {
    it('declines to grade rather than guessing', () => {
      // An `overlapping` persona has no measured scale. This used to answer `partial`,
      // which is a guess wearing the word for a middling match — and on the live probe 21
      // of 46 `close` grades went to positions a reader rejects outright, which is what a
      // grade against a number nobody measured looks like from the reader's side.
      assert.equal(fitOf(0.9, null), 'ungraded');
      assert.equal(fitOf(0.9, { cut: 0.5, span: 0 }), 'ungraded');
    });

    it('declines when there is no number to grade either', () => {
      // A position whose statement was never embedded. Nothing to grade is never a zero.
      assert.equal(fitOf(null, scale), 'ungraded');
    });
  });
});

/**
 * The cut, measured per Persona on every Compile.
 *
 * The in-group is the Person's own cited quotes and the out-group is the same fixed
 * off-corpus questions the floor uses, both scored against this Compile's own statements —
 * so the scale a grade is expressed in is one this Corpus actually produced rather than a
 * constant somebody picked. The naive alternative was measured and rejected: Chris Barlow's
 * floor of 0.44, borrowed, endorses the mean *unrelated* statement at 0.467.
 */
describe('calibrating the cut', () => {
  const QUOTES = [
    'You write the evals before you write the harness',
    'The eval is the specification',
    'A context window is not memory',
    'rebuilding a database badly inside a prompt',
    'the eval comes first',
  ];

  /**
   * An embedder that says which group a question came from and nothing else. The real one
   * is a similarity model and this test is not about similarity — it is about what
   * `calibrateFit` does with two groups of scores, so a vector that is legible in the query
   * is what lets the stand-in database answer the question braintrust actually posed.
   */
  const grouping: Embedder = {
    model: 'test-groups',
    url: 'https://example.test/v1/embeddings',
    async embed(inputs: string[]): Promise<number[][]> {
      return inputs.map((text) => (OFF_CORPUS_PROBES.includes(text) ? [1, 0] : [0, 1]));
    },
  };

  /** The statement rows, answering each group with a fixed score. */
  function scoring(inGroup: number | null, outGroup: number): Db {
    return {
      async query(sql: string, params?: unknown[]) {
        assert.match(sql, /braintrust_position_embeddings/, 'the statements are what it reads');
        const isOffCorpus = String(params?.[1] ?? '') === '[1,0]';
        const similarity = isOffCorpus ? outGroup : inGroup;
        return { rows: similarity === null ? [] : [{ position_id: 'p', similarity }] };
      },
    } as unknown as Db;
  }

  it('needs no cut at all when there are no positions to grade', async () => {
    const measured = await calibrateFit({
      db: scoring(0.7, 0.3),
      embedder: grouping,
      compileId: 'c',
      positionIds: [],
      quotes: QUOTES,
    });

    assert.equal(measured.cut, null);
    assert.equal(measured.separation, 'not_measurable');
  });

  it('declines when there are too few quotes for a minimum to mean anything', async () => {
    const measured = await calibrateFit({
      db: scoring(0.7, 0.3),
      embedder: grouping,
      compileId: 'c',
      positionIds: ['p'],
      quotes: QUOTES.slice(0, MIN_IN_CORPUS_QUOTES - 1),
    });

    assert.equal(measured.cut, null);
    assert.match(measured.note, /quote\(s\) to probe with/);
  });

  it('declines when the endpoint cannot tell a quote from a question about poaching an egg', async () => {
    // `overlapping`: an off-corpus question reaches the statements as strongly as the
    // person's own words do. There is no scale here, and inventing one is the whole family
    // of defects this grade has had.
    const measured = await calibrateFit({
      db: scoring(0.6, 0.6),
      embedder: grouping,
      compileId: 'c',
      positionIds: ['p'],
      quotes: QUOTES,
    });

    assert.equal(measured.separation, 'overlapping');
    assert.equal(measured.cut, null);
    assert.equal(measured.span, null);
    assert.equal(measured.in_low, 0.6, 'what it measured is recorded even when it is unusable');
    assert.equal(measured.out_high, 0.6);
  });

  it('anchors the cut near the off-corpus ceiling, because the in-group is optimistic', async () => {
    // A cited quote is a real published sentence about something this persona holds, so it
    // scores higher against the statement than a reader's fuzzier question will. A midpoint
    // would inherit that optimism and start grading real answers `distant`.
    const measured = await calibrateFit({
      db: scoring(0.7, 0.3),
      embedder: grouping,
      compileId: 'c',
      positionIds: ['p'],
      quotes: QUOTES,
    });

    assert.equal(measured.separation, 'separated');
    assert.equal(measured.in_low, 0.7);
    assert.equal(measured.out_high, 0.3);
    assert.equal(measured.span, 0.4);
    assert.equal(measured.cut, 0.3 + 0.4 * ANCHOR);
    assert.ok(measured.cut! < (0.7 + 0.3) / 2, 'below the midpoint, on purpose');
    assert.equal(measured.probes.out, OFF_CORPUS_PROBES.length);
  });

  it('declines when the endpoint returned nothing to score against', async () => {
    const measured = await calibrateFit({
      db: scoring(null, 0.3),
      embedder: grouping,
      compileId: 'c',
      positionIds: ['p'],
      quotes: QUOTES,
    });

    assert.equal(measured.cut, null);
    assert.match(measured.note, /did not return enough vectors/);
  });

  it('says why it is not grading, for whoever reads the receipts', () => {
    const declined = notGradeable('No embeddings endpoint is configured.');
    assert.match(declined.note, /no fit grade/);
    assert.match(declined.note, /positions and their citations are unaffected/);
  });
});

/**
 * The `fit` grade, on its own.
 *
 * `fit` exists because #115 found that `measured` + `high` + four dated quotes reads as
 * licence to answer, and a Position can be well evidenced and still be no answer to the
 * question asked. It is the only thing in the payload whose job is to say *this one does
 * not answer you*.
 *
 * So the property worth a test of its own is the one it shipped without: that it can
 * actually say no. A grade computed against the answer it is grading cannot — which is
 * what these tests pin.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fitOf, SELECTIVITY_MARGIN } from '../src/find.js';

describe('fit', () => {
  const median = 0.5;

  it('does not grade the best match close merely for being the best match', () => {
    // A degenerate field: the top barely clears the middle, which is exactly what an
    // off-corpus question produces. Live, this shape returned three positions on
    // "the correct water temperature for poaching an egg" — every one graded close.
    //
    // The old implementation divided by (top - median), so the top scored 1.0 whatever
    // that gap was. This is the regression that matters: nothing about being first in
    // a list may earn `close`.
    const top = median + SELECTIVITY_MARGIN / 6;
    assert.notEqual(fitOf(top, median), 'close');
  });

  it('grades a match that stands well clear of the corpus close', () => {
    assert.equal(fitOf(median + SELECTIVITY_MARGIN * 3, median), 'close');
  });

  it('grades a match that only just clears the corpus partial', () => {
    assert.equal(fitOf(median + SELECTIVITY_MARGIN, median), 'partial');
  });

  it('grades a match that does not clear the corpus distant', () => {
    assert.equal(fitOf(median + SELECTIVITY_MARGIN / 2, median), 'distant');
  });

  it('grades on the margin, not on rank — two answers with the same margin grade alike', () => {
    // The same absolute clearance means the same thing whether the corpus sits high or
    // low in the similarity range. A grade that moved with the corpus's own baseline
    // would be back to measuring the answer against itself.
    const margin = SELECTIVITY_MARGIN * 3;
    assert.equal(fitOf(0.3 + margin, 0.3), fitOf(0.7 + margin, 0.7));
  });

  it('falls back to partial when the corpus has no middle to measure against', () => {
    // Neither a warning nor an endorsement: braintrust cannot tell, and says so by
    // declining to grade rather than by guessing in either direction.
    assert.equal(fitOf(0.9, null), 'partial');
  });
});

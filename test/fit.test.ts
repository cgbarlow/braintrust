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

import { fitOf } from '../src/find.js';

describe('fit', () => {
  const floor = 0.5;
  const span = 0.3;

  it('does not grade the best match close merely for being the best match', () => {
    // The first defect: fit divided by the query's own range, so the top match scored
    // exactly 1.0 and graded close for every query ever asked — including poaching an
    // egg. Nothing about being first in a list may earn `close`.
    const barelyClear = floor + span * 0.05;
    assert.notEqual(fitOf(barelyClear, floor, span), 'close');
  });

  it('grades a match that stands well above the floor close', () => {
    assert.equal(fitOf(floor + span * 0.8, floor, span), 'close');
  });

  it('grades a match that only middlingly clears the floor partial', () => {
    assert.equal(fitOf(floor + span * 0.4, floor, span), 'partial');
  });

  it('grades a match barely above the floor distant', () => {
    assert.equal(fitOf(floor + span * 0.1, floor, span), 'distant');
  });

  it('grades on height above the floor, not on rank', () => {
    // The same height above each persona's own floor means the same thing, whether that
    // floor sits high or low. A grade that moved with the answer would be the first
    // defect returning.
    assert.equal(fitOf(0.3 + span * 0.8, 0.3, span), fitOf(0.7 + span * 0.8, 0.7, span));
  });

  it('declines to discriminate when the corpus produced no span of its own', () => {
    // An `overlapping` persona has no measured scale. Neither a warning nor an
    // endorsement: braintrust cannot tell, and says so rather than guessing.
    assert.equal(fitOf(0.9, 0.5, 0), 'partial');
  });
});

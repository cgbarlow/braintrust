/**
 * What braintrust does with a quantity it has not measured.
 *
 * **An unmeasured quantity takes its most conservative value, not its most convenient
 * one.** The rule is here because the first version of it pointed the wrong way: every
 * retrieval floor braintrust had measured sat between 0.44 and 0.52, and the fallback for a
 * persona that had measured none was 0.35 — below the whole range. The persona that knew
 * least about its own gate was the most willing to answer, which is how one answered a
 * question about poaching an egg.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { cutFor, fitOf, floorFor } from '../src/find.js';
import { UNMEASURED_RETRIEVAL_FLOOR } from '../src/unmeasured.js';

/** Every floor braintrust has measured on a real corpus, as recorded on #168. */
const MEASURED_RANGE = { low: 0.44, high: 0.52 };

describe('the floor a persona uses when it has measured none', () => {
  it('is the cautious value rather than the convenient one', () => {
    assert.equal(floorFor(null), UNMEASURED_RETRIEVAL_FLOOR);
    assert.ok(
      UNMEASURED_RETRIEVAL_FLOOR > MEASURED_RANGE.high,
      'above every floor braintrust has measured, so unmeasured is stricter rather than looser',
    );
    assert.ok(
      UNMEASURED_RETRIEVAL_FLOOR > 0.35,
      'and above the guess it replaces, which sat below the whole measured range',
    );
  });

  it('gets out of the way the moment there is a measurement', () => {
    // The fallback is what an absence means, never a floor under a real number.
    assert.equal(floorFor(MEASURED_RANGE.low), MEASURED_RANGE.low);
    assert.equal(floorFor(MEASURED_RANGE.high), MEASURED_RANGE.high);
  });

  /**
   * A constant, and not a calculation over what other personas measured. A fallback
   * derived from the fleet would let one Person's calibration move another Person's gate —
   * a coupling nobody can debug, and one nobody asked for.
   */
  it('is a constant, so one persona calibration never moves another persona gate', async () => {
    const source = await readFile(new URL('../src/unmeasured.ts', import.meta.url), 'utf8');

    assert.match(source, /export const UNMEASURED_RETRIEVAL_FLOOR = [\d.]+;/);
    assert.doesNotMatch(source, /\bimport\b/, 'nothing to derive it from is the strongest form of this');
  });
});

/**
 * **A grade is the exception, and it is the exception the rule needed.** A number has a
 * cautious direction; a judgement does not. `distant` on the answer a reader wanted and
 * `close` on the one they did not are both wrong and point opposite ways, so no setting of
 * the scale is the careful one — which is why an unmeasured `fit` is withheld rather than
 * widened. It previously fell back to a deliberately wide span, and a wide span does not
 * decline: it guesses `partial` on everything.
 */
describe('the rule generalises past the floor, and gains a third option', () => {
  it('declines to grade rather than grading against a borrowed number', () => {
    assert.equal(cutFor({ cut: null, span: null }), null);
    assert.equal(fitOf(0.9, null), 'ungraded');
  });

  it('never borrows the floor, which is measured on a different quantity', () => {
    // The naive version of this: Chris Barlow's measured floor of 0.44 would endorse the
    // mean *unrelated* statement, which sits at 0.467. Two scales, two measurements.
    assert.equal(cutFor({ cut: null, span: 0.2 }), null);
    assert.equal(cutFor({ cut: 0.44, span: null }), null);
  });

  it('gets out of the way the moment there is a measurement', () => {
    assert.deepEqual(cutFor({ cut: 0.54, span: 0.18 }), { cut: 0.54, span: 0.18 });
  });

  it('withholds the grade without withholding the position', async () => {
    // The cost of caution lands on a grade, never on a reader's access to the record: an
    // ungraded answer is a full answer with nothing claimed about relevance.
    const source = await readFile(new URL('../src/find.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /filter\([^)]*fit/,
      'nothing in the read path may drop a position on the strength of its grade',
    );
  });
});

/**
 * **No second kind of silence.** A persona that declines because it could not measure its
 * own gate must be indistinguishable from one that declines because the question is
 * genuinely off its corpus. A distinct reason code was recommended and declined: it would
 * tell a reader about braintrust's internals in the one place that is supposed to be about
 * the person.
 */
describe('a cautious empty answer reads exactly like a genuine one', () => {
  it('has one vocabulary for coming back empty, and calibration is not in it', async () => {
    const source = await readFile(new URL('../src/find.ts', import.meta.url), 'utf8');

    const union = source.match(/reason: ('[a-z_]+'(?: \| '[a-z_]+')*);/)![1]!;
    assert.deepEqual(union.split(' | '), ["'below_floor'", "'nothing_indexed'"]);
  });

  it('says the same sentence to a reader either way', async () => {
    const source = await readFile(new URL('../src/find.ts', import.meta.url), 'utf8');

    // The two sentences an empty answer can carry. Neither mentions measurement,
    // calibration or a compiler — the caution lives in the number, never in the wording.
    const said = [...source.matchAll(/'(braintrust has nothing indexed[^']*|This is outside[^']*)'/g)];
    assert.equal(said.length, 2, 'exactly two things an empty answer says');
    for (const [, sentence] of said) {
      assert.doesNotMatch(sentence!, /calibrat|measur|uncertain|version|compil/i);
    }
  });
});

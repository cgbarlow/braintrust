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

import { DEFAULT_SPAN, floorFor } from '../src/find.js';
import { UNMEASURED_FIT_SPAN, UNMEASURED_RETRIEVAL_FLOOR } from '../src/unmeasured.js';

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

describe('the rule generalises past the floor', () => {
  it('grades fit on a wide scale when no span was measured', () => {
    // Conservative here means wide: an uninformative grade is a smaller failure than one
    // that calls a weak match `close`.
    assert.equal(DEFAULT_SPAN, UNMEASURED_FIT_SPAN);
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

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

import { COMPILER_VERSION } from '../src/compile/version.js';
import { cutFor, fitOf, floorFor, nothingMatched, speakableProseIn } from '../src/find.js';
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
 * The other half of the same rule, on the read rather than on a clock: a floor measured
 * under rules that have since moved is not a measurement any more, so it takes the
 * unmeasured value too. This is what makes the staleness window zero for a reader — no
 * rebuild has to finish for it to take effect.
 */
describe('the floor a persona uses once its measurement rules have moved', () => {
  const BEHIND = '0.9.0+measured-4.core-1.positions-2.revisions-1';

  it('discards a floor measured under rules that have since moved', () => {
    assert.equal(floorFor(0.46, BEHIND), UNMEASURED_RETRIEVAL_FLOOR);
    assert.ok(UNMEASURED_RETRIEVAL_FLOOR > 0.46, 'tightened, never loosened');
  });

  it('keeps a floor measured under the rules still in force', () => {
    assert.equal(floorFor(0.46, COMPILER_VERSION), 0.46);
  });

  it('tightens for a version it cannot read, and for one that was never recorded', () => {
    assert.equal(floorFor(0.46, null), UNMEASURED_RETRIEVAL_FLOOR);
    assert.equal(floorFor(0.46, 'written-by-an-older-braintrust'), UNMEASURED_RETRIEVAL_FLOOR);
  });

  /**
   * Only the measurement part governs the gate. A synthesis prompt bump withholds prose —
   * that is the other half of the rule — but it says nothing about where the floor sits,
   * and tightening on it would be caution braintrust cannot justify.
   */
  it('does not tighten because a part that governs no measurement moved', () => {
    const [code, rest] = COMPILER_VERSION.split('+');
    const [measurement, , positions, revisions] = rest!.split('.');
    const synthesisMoved = `${code}+${measurement}.core-99.${positions}.${revisions}`;

    assert.equal(floorFor(0.46, synthesisMoved), 0.46);
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

  /**
   * **Stronger than it was, because there is now no sentence to compare.** This used to
   * assert that neither of the two sentences an empty answer carried mentioned calibration.
   * braintrust no longer supplies a sentence at all — the persona says it in their own
   * register — so an uncalibrated persona cannot announce itself even by accident.
   */
  it('says nothing to a reader either way, which is the same thing either way', () => {
    const cautious = nothingMatched({ nearest_similarity: 0.2, floor: 0.55, nearest: [] });
    const measured = nothingMatched({ nearest_similarity: 0.2, floor: 0.44, nearest: [] });

    assert.deepEqual(speakableProseIn(cautious as unknown as Record<string, unknown>), []);
    assert.deepEqual(Object.keys(cautious), Object.keys(measured));
    assert.equal(cautious.reason, measured.reason);
  });
});

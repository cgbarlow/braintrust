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
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  cutFor,
  fitOf,
  floorFor,
  MINIMUM_RETRIEVAL_FLOOR,
  nothingMatched,
  speakableProseIn,
} from '../src/find.js';
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
    // The fallback is what an absence means, never a floor under a real number — so a
    // measured value above the minimum is used unchanged.
    assert.equal(floorFor(0.58), 0.58);
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
 * **A minimum under a measured floor, never a flat offset.** Measured floors of 0.4427 and
 * 0.4645 — the two smallest Corpora — answered a question about Victorian brickwork one
 * time in ten, so the gate reads a measured floor as `max(measured, 0.52)`. A Persona whose
 * Compile measured a higher floor keeps *its own* number: taxing one Person's calibration
 * for another's is exactly why this is a minimum and not a constant.
 */
describe('the minimum the gate serves under a measured floor', () => {
  it('raises a measured floor that sits below it, rather than serving it', () => {
    assert.equal(floorFor(MEASURED_RANGE.low), MINIMUM_RETRIEVAL_FLOOR);
    assert.ok(
      MINIMUM_RETRIEVAL_FLOOR > MEASURED_RANGE.low,
      'the minimum walks the floor the negative set walked through',
    );
  });

  it('leaves a measured floor at or above the minimum exactly as measured', () => {
    assert.equal(floorFor(MEASURED_RANGE.high), MEASURED_RANGE.high);
    assert.equal(floorFor(0.58), 0.58);
  });

  it('does not disturb the no-measurement fallback, which already sits above it', () => {
    assert.equal(floorFor(null), UNMEASURED_RETRIEVAL_FLOOR);
    assert.ok(UNMEASURED_RETRIEVAL_FLOOR > MINIMUM_RETRIEVAL_FLOOR);
  });

  it('lets the operator override win outright, below the minimum included', () => {
    // The override is an explicit instruction, not a second measurement for the gate to
    // second-guess — so it wins over the minimum, over a measured floor, and over the
    // unmeasured fallback alike.
    assert.equal(floorFor(MEASURED_RANGE.low, undefined, 0.5), 0.5);
    assert.equal(floorFor(0.58, undefined, 0.5), 0.5);
    assert.equal(floorFor(null, undefined, 0.3), 0.3);
  });
});

/**
 * **`FLOOR_OVERRIDE` is read from the environment at import time, so the wiring that makes
 * it an operator's instruction is not the same code as the one this file usually tests.**
 * The parameter form above proves the rule; this proves the variable reaches the rule.
 * Spawned fresh so the module evaluates once with the variable set, the way the server
 * would.
 */
describe('the environment variable that sets the override', () => {
  const probe = [
    `import { floorFor, MINIMUM_RETRIEVAL_FLOOR, FLOOR_OVERRIDE } from ${JSON.stringify(
      new URL('../src/find.js', import.meta.url).href,
    )};`,
    `const belowTheMinimum = MINIMUM_RETRIEVAL_FLOOR - 0.01;`,
    `process.stdout.write(JSON.stringify({ override: FLOOR_OVERRIDE, below: floorFor(belowTheMinimum), above: floorFor(0.58), none: floorFor(null) }));`,
  ].join('\n');

  it('overrides the minimum, a measured floor and the fallback alike', () => {
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', probe],
      { env: { ...process.env, BRAINTRUST_RETRIEVAL_FLOOR: '0.5' }, encoding: 'utf8' },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      override: 0.5,
      below: 0.5,
      above: 0.5,
      none: 0.5,
    });
  });

  it('leaves the gate to its own arithmetic when it is unset', () => {
    const { BRAINTRUST_RETRIEVAL_FLOOR: _unset, ...withoutOverride } = process.env;
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', probe],
      { env: withoutOverride, encoding: 'utf8' },
    );

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      override: null,
      below: MINIMUM_RETRIEVAL_FLOOR,
      above: 0.58,
      none: UNMEASURED_RETRIEVAL_FLOOR,
    });
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

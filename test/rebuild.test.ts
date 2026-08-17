/**
 * A rules change still tightens the gate for whoever reads, immediately, on that read —
 * but the read no longer queues or starts a rebuild. Compiles run on the cron deployment.
 *
 * What survives on the read is the half that was always doing the work: the version
 * comparison, the tightened gate, and the withheld prose. What is gone is the queued
 * rebuild behind the reader.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMPILER_VERSION } from '../src/compile/version.js';
import { floorFor } from '../src/find.js';
import { UNMEASURED_RETRIEVAL_FLOOR } from '../src/unmeasured.js';

const BEHIND = '0.9.0+measured-4.core-1.positions-2.revisions-1';

/**
 * The half a reader actually feels. The gate tightens on the read, immediately,
 * so the staleness window is **zero** for anyone actually reading — nobody is ever
 * served a Persona built under rules braintrust has since changed.
 */
describe('the gate tightens for that reader, immediately', () => {
  it('discards a floor measured under rules that have since moved', () => {
    assert.equal(floorFor(0.46, BEHIND), UNMEASURED_RETRIEVAL_FLOOR);
    assert.ok(UNMEASURED_RETRIEVAL_FLOOR > 0.46, 'tightened, never loosened');
  });

  it('keeps a floor measured under the rules still in force', () => {
    // 0.54 is above the minimum the gate now enforces, so this asserts the version rule
    // rather than the minimum: under current rules the measured value is served unchanged.
    assert.equal(floorFor(0.54, COMPILER_VERSION), 0.54);
  });

  it('tightens for a version it cannot read, and for one that was never recorded', () => {
    assert.equal(floorFor(0.46, null), UNMEASURED_RETRIEVAL_FLOOR);
    assert.equal(floorFor(0.46, 'written-by-an-older-braintrust'), UNMEASURED_RETRIEVAL_FLOOR);
  });

  it('does not tighten because a part that governs no measurement moved', () => {
    const [code, rest] = COMPILER_VERSION.split('+');
    const [measurement, , positions, revisions] = rest!.split('.');
    const synthesisMoved = `${code}+${measurement}.core-99.${positions}.${revisions}`;

    assert.equal(floorFor(0.54, synthesisMoved), 0.54);
  });
});

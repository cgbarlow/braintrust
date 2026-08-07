/**
 * What a Persona's compiler version says, and what braintrust does about it.
 *
 * One rule holds the file up: **an unmeasured quantity takes its most conservative value.**
 * A version braintrust cannot decompose is an unmeasured quantity — it cannot tell which
 * rules moved — so it reports every part moved rather than none.
 *
 * The prose half is the other side of the same rule. A paragraph a model already wrote has
 * no cautious version of itself, so text governed by a part that has moved is absent until
 * a rebuild, and the persona reads exactly like one that never had it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPILER_PARTS,
  COMPILER_VERSION,
  compilerParts,
  compilerVersion,
  movedParts,
  SYNTHESISED_LAYERS,
  withheldLayers,
} from '../src/compile/version.js';

describe('the compound compiler version', () => {
  it('decomposes into the parts that move independently', () => {
    const parts = compilerParts('1.0.0+measured-5.core-1.positions-2.revisions-1');

    assert.deepEqual(parts, {
      code: '1.0.0',
      measurement: 'measured-5',
      synthesis: 'core-1',
      positions: 'positions-2',
      revisions: 'revisions-1',
    });
  });

  it('decomposes what the compiler actually writes, both ways it can be configured', () => {
    for (const revisions of [true, false]) {
      assert.ok(compilerParts(compilerVersion({ revisions })), `${revisions} should decompose`);
    }
  });

  it('reads a version it cannot decompose as no answer at all', () => {
    assert.equal(compilerParts('0.1.0+measured-1'), null, 'an older, shorter version');
    assert.equal(compilerParts('nonsense'), null);
    assert.equal(compilerParts('1.0.0+a.b.c.d.e'), null, 'a longer one from a later braintrust');
  });
});

describe('which rules have moved under a persona', () => {
  it('reports nothing moved for a persona built under the current rules', () => {
    assert.deepEqual(movedParts(COMPILER_VERSION), []);
  });

  it('reports only the part that differs', () => {
    assert.deepEqual(
      movedParts('1.0.0+measured-5.core-9.positions-2.revisions-1', '1.0.0+measured-5.core-1.positions-2.revisions-1'),
      ['synthesis'],
    );
    assert.deepEqual(
      movedParts('0.9.0+measured-5.core-1.positions-2.revisions-1', '1.0.0+measured-5.core-1.positions-2.revisions-1'),
      ['code'],
    );
  });

  /**
   * The conservative reading, and the whole rule in one assertion: braintrust cannot tell
   * which of these rules moved, so it does not get to assume none of them did.
   */
  it('reports every part moved when it cannot tell which one did', () => {
    assert.deepEqual(movedParts(null), COMPILER_PARTS);
    assert.deepEqual(movedParts('0.1.0+measured-1'), COMPILER_PARTS);
  });
});

describe('what a persona may still serve', () => {
  it('withholds nothing from a persona built under the current rules', () => {
    assert.deepEqual(withheldLayers(COMPILER_VERSION), []);
  });

  it('withholds the prose written by a part that has moved', () => {
    assert.deepEqual(
      withheldLayers('1.0.0+measured-5.core-9.positions-2.revisions-1', '1.0.0+measured-5.core-1.positions-2.revisions-1'),
      ['reasoning', 'beliefs'],
    );
  });

  /**
   * A count has a conservative direction and can take it; that is the *other* half of the
   * rule and it does not need an absence. Withholding coverage would tell a reader less
   * about what braintrust has not read, which is the opposite of cautious.
   */
  it('withholds no measured layer, because a measurement has a cautious value instead', () => {
    assert.deepEqual(SYNTHESISED_LAYERS.measurement, []);
    assert.deepEqual(
      withheldLayers('1.0.0+measured-1.core-1.positions-2.revisions-1', '1.0.0+measured-5.core-1.positions-2.revisions-1'),
      [],
    );
  });

  it('withholds every synthesised layer when it cannot tell which rules moved', () => {
    assert.deepEqual(withheldLayers(null), ['reasoning', 'beliefs']);
  });

  it('names each withheld layer once, however many parts moved', () => {
    const withheld = withheldLayers('nonsense');
    assert.deepEqual(withheld, [...new Set(withheld)]);
  });
});

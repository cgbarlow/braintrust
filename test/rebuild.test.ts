/**
 * A rules change rebuilds the persona, and readers never wait.
 *
 * braintrust watched two clocks and only one existed: new content triggered a rebuild, a
 * rules change triggered nothing. What this file holds up is the arrangement that replaced
 * it — **the catch happens on the read, not on a clock**, so the staleness window is zero
 * for anyone actually reading, and the rebuild is queued *behind* them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMPILER_VERSION } from '../src/compile/version.js';
import type { TransactionalDb } from '../src/db.js';
import { floorFor } from '../src/find.js';
import { createRebuildQueue } from '../src/rebuild.js';
import { UNMEASURED_RETRIEVAL_FLOOR } from '../src/unmeasured.js';
import { fakeSynthesiser } from './support/synthesiser.js';

const BEHIND = '0.9.0+measured-4.core-1.positions-2.revisions-1';

/**
 * A database that answers `compilablePeople` with one person who needs rebuilding and
 * everything else with nothing, and records how many compiles were started.
 */
function compilingDb(): TransactionalDb & { compiles: number; release: () => void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const db = {
    compiles: 0,
    release: () => release(),
    async query(sql: string) {
      if (sql.includes('as stale_compiler')) {
        db.compiles += 1;
        // Held open, so a test can observe a rebuild that is genuinely still in flight.
        await held;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    async transaction<T>(run: (tx: TransactionalDb) => Promise<T>): Promise<T> {
      return run(db as unknown as TransactionalDb);
    },
    async close() {},
  };

  return db as unknown as TransactionalDb & { compiles: number; release: () => void };
}

function queue(db: TransactionalDb) {
  return createRebuildQueue({
    db,
    extractor: 'test-reader@notes-1',
    synthesiser: fakeSynthesiser(),
    log: () => {},
  });
}

describe('a rules change triggers a rebuild in its own right', () => {
  it('rebuilds a persona whose version is behind, with no new content involved', async () => {
    const db = compilingDb();
    const rebuilds = queue(db);

    assert.equal(await rebuilds.requestIfBehind('nate', BEHIND), true);
    assert.deepEqual(rebuilds.inFlight(), ['nate']);
    db.release();
  });

  it('leaves a persona on the current rules alone', async () => {
    const db = compilingDb();
    const rebuilds = queue(db);

    assert.equal(await rebuilds.requestIfBehind('nate', COMPILER_VERSION), false);
    assert.deepEqual(rebuilds.inFlight(), []);
    assert.equal((db as unknown as { compiles: number }).compiles, 0);
    db.release();
  });

  /**
   * A version braintrust cannot decompose is one written by an older braintrust. It cannot
   * tell which rules moved, so it does not get to assume none of them did.
   */
  it('rebuilds a persona whose version it cannot read at all', async () => {
    const db = compilingDb();
    const rebuilds = queue(db);

    assert.equal(await rebuilds.requestIfBehind('nate', null), true);
    db.release();
  });
});

describe('the rebuild is queued behind the reader', () => {
  it('resolves before the rebuild does, so no reader waits for a compile', async () => {
    const db = compilingDb();
    const rebuilds = queue(db);

    const decided = await rebuilds.requestIfBehind('nate', BEHIND);

    // The compile is still running — the decision returned without it.
    assert.equal(decided, true);
    assert.deepEqual(rebuilds.inFlight(), ['nate'], 'still in flight when the reader was answered');
    db.release();
  });

  /**
   * A behind-version persona is exactly the one a burst of readers arrives at, so the guard
   * has to hold under that burst rather than only under one reader.
   */
  it('keeps at most one rebuild in flight per persona, however many readers arrive', async () => {
    const db = compilingDb();
    const rebuilds = queue(db);

    const asked = await Promise.all(
      Array.from({ length: 20 }, () => rebuilds.requestIfBehind('nate', BEHIND)),
    );

    assert.equal(asked.filter(Boolean).length, 1, 'one reader started it and nineteen did not');
    assert.deepEqual(rebuilds.inFlight(), ['nate']);
    assert.equal((db as unknown as { compiles: number }).compiles, 1);
    db.release();
  });

  it('lets two different personas rebuild at once, because the guard is per persona', async () => {
    const db = compilingDb();
    const rebuilds = queue(db);

    await rebuilds.requestIfBehind('nate', BEHIND);
    await rebuilds.requestIfBehind('ethan', BEHIND);

    assert.deepEqual(rebuilds.inFlight(), ['ethan', 'nate']);
    db.release();
  });

  it('takes the persona again once its rebuild has finished', async () => {
    const db = compilingDb();
    const rebuilds = queue(db);

    await rebuilds.requestIfBehind('nate', BEHIND);
    db.release();
    // Let the compile settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(rebuilds.inFlight(), []);
    assert.equal(await rebuilds.requestIfBehind('nate', BEHIND), true);
    db.release();
  });
});

/**
 * The half a reader actually feels. Queuing a rebuild fixes the persona eventually; this
 * is what makes the staleness window **zero** in the meantime.
 */
describe('the gate tightens for that reader, immediately', () => {
  it('discards a floor measured under rules that have since moved', () => {
    // A real measurement, from a compile whose measurement rules have changed.
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

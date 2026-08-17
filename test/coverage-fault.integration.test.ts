/**
 * The coverage report against real Postgres: the fraction of a persona's retrieved items
 * its current Compile formed Positions on, and the fault it opens when that fraction
 * falls below the floor.
 *
 * The count itself is the whole thing this ticket builds — "covered fraction is computed
 * per persona against the current compile only, SQL only" — and a count is exactly what
 * an in-memory fake cannot hold up. Rows here are real rows: compiles with a `current`
 * status no other compile shares, positions that cascade with them, citations that point
 * at items.
 *
 * Fails loudly rather than skipping, like every database-backed suite. See
 * test/support/database.ts for how to stand a database up.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createDb, type PostgresDb } from '../src/db.js';
import { COVERAGE_ASSERTION, checkCoverage, measureCoveredFraction } from '../src/verify/index.js';

import { testDatabaseUrl as url } from './support/database.js';

describe('the coverage report, against real Postgres', () => {
  let db: PostgresDb;

  before(async () => {
    db = createDb(url!);
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (db) {
      await db.query('truncate braintrust_people cascade');
      await db.query('truncate braintrust_faults');
      await db.close();
    }
  });

  beforeEach(async () => {
    await db.query('truncate braintrust_people cascade');
    // The ledger is not foreign-keyed to `braintrust_people`, so truncate cascade leaves
    // it holding the previous test's rows.
    await db.query('truncate braintrust_faults');
  });

  async function person(slug: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into braintrust_people (slug, display_name) values ($1, $2) returning id`,
      [slug, slug.replace(/-/g, ' ').toUpperCase()],
    );
    return rows[0]!.id;
  }

  async function source(personId: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into braintrust_sources
         (person_id, platform, handle, discovery_url, backfill_floor)
       values ($1, 'substack', 'feed', 'https://feed.example/feed', '2025-01-01')
       returning id`,
      [personId],
    );
    return rows[0]!.id;
  }

  async function item(sourceId: string, n: number): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into braintrust_items
         (source_id, external_id, url, title, published_at, retrieval)
       values ($1, $2, $3, $4, '2026-01-01', 'retrieved')
       returning id`,
      [sourceId, `item-${n}`, `https://feed.example/p/${n}`, `Item ${n}`],
    );
    return rows[0]!.id;
  }

  async function compile(personId: string, status: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into braintrust_compiles (person_id, compiler_version, status)
       values ($1, '1.0.0', $2) returning id`,
      [personId, status],
    );
    return rows[0]!.id;
  }

  async function position(compileId: string, citeThe: string[]): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      `insert into braintrust_positions
         (compile_id, slug, statement, basis, confidence, item_count)
       values ($1, $2, $3, 'measured', 'high', $4) returning id`,
      [compileId, `position-${citeThe.length}-${Math.random().toString(36).slice(2)}`, 'A held statement.', citeThe.length],
    );
    for (const item_id of citeThe) {
      await db.query(
        `insert into braintrust_position_citations (position_id, item_id, quote)
         values ($1, $2, 'a quote from the item.')`,
        [rows[0]!.id, item_id],
      );
    }
  }

  async function faults(): Promise<{ assertion: string; person_slug: string | null; detail: string }[]> {
    const { rows } = await db.query<{ assertion: string; person_slug: string | null; detail: string }>(
      'select assertion, person_slug, detail from braintrust_faults order by person_slug',
    );
    return rows;
  }

  /** One serving persona with `retrieved` items and a current Compile that cites `covered` of them. */
  async function seededPerson(slug: string, retrieved: number, covered: number): Promise<string> {
    const personId = await person(slug);
    const sourceId = await source(personId);
    const items = await Promise.all(Array.from({ length: retrieved }, (_, i) => item(sourceId, i)));
    const compileId = await compile(personId, 'current');
    if (covered > 0) await position(compileId, items.slice(0, covered));
    return personId;
  }

  it('reports each persona’s covered fraction against the current compile, and faults below half', async () => {
    await seededPerson('below-half', 5, 2); // 0.4
    await seededPerson('above-half', 5, 3); // 0.6
    await seededPerson('exactly-half', 10, 5); // 0.5 — below means *below*

    const measured = await measureCoveredFraction(db);
    const byPerson = Object.fromEntries(measured.map((one) => [one.person, one]));

    assert.equal(byPerson['below-half']!.retrieved, 5);
    assert.equal(byPerson['below-half']!.covered, 2);
    assert.ok(Math.abs(byPerson['below-half']!.covered_fraction! - 0.4) < 1e-12);
    assert.equal(byPerson['above-half']!.covered, 3);
    assert.equal(byPerson['exactly-half']!.covered_fraction, 0.5);

    await checkCoverage(db, { log: () => {} });

    // Only the below-floor persona opens a fault — exactly half is not below half.
    const open = await faults();
    assert.deepEqual(
      open.map((fault) => fault.person_slug),
      ['below-half'],
    );
  });

  it('counts citations of the current compile only — a superseded compile contributes nothing', async () => {
    const personId = await person('nate');
    const sourceId = await source(personId);
    const items = await Promise.all(Array.from({ length: 5 }, (_, i) => item(sourceId, i)));

    // A superseded compile that cited everything: it must not raise the measured fraction.
    const oldCompileId = await compile(personId, 'failed');
    await position(oldCompileId, items);
    // The current compile cites only two.
    const currentCompileId = await compile(personId, 'current');
    await position(currentCompileId, items.slice(0, 2));

    const [measured = null] = await measureCoveredFraction(db);
    assert.ok(measured, 'nate is serving, so he must be measured');
    assert.equal(measured.person, 'nate');
    assert.equal(measured.retrieved, 5);
    assert.equal(measured.covered, 2);
    assert.ok(Math.abs(measured.covered_fraction! - 0.4) < 1e-12);
  });

  it('opens a deduped fault on repeated observations, and clears it when a recompile rises above the floor', async () => {
    const personId = await person('matt');
    const sourceId = await source(personId);
    const items = await Promise.all(Array.from({ length: 5 }, (_, i) => item(sourceId, i)));
    const oldCompileId = await compile(personId, 'current');
    await position(oldCompileId, items.slice(0, 2)); // 0.4

    await checkCoverage(db, { log: () => {} });
    await checkCoverage(db, { log: () => {} }); // a second run re-observes it

    const open = await faults();
    assert.equal(open.length, 1, 'one live fault, however many runs re-observe it');
    assert.equal(open[0]!.assertion, COVERAGE_ASSERTION);
    assert.equal(open[0]!.person_slug, 'matt');

    // The recompile: the old compile stops being current, a new one cites four of five.
    await db.query(`update braintrust_compiles set status = 'failed' where id = $1`, [oldCompileId]);
    const freshCompileId = await compile(personId, 'current');
    await position(freshCompileId, items.slice(0, 4)); // 0.8

    const checks = await checkCoverage(db, { log: () => {} });
    const matt = checks.find((one) => one.person === 'matt')!;
    assert.equal(matt.failing, false);
    assert.equal((await faults()).length, 0, 'a pass clears the fault, no issue-closing required');
  });

  it('names a below-floor persona to the maintainer as a coverage report, never as a quality regression', async () => {
    const personId = await person('chris');
    const sourceId = await source(personId);
    const items = await Promise.all(Array.from({ length: 4 }, (_, i) => item(sourceId, i)));
    const compileId = await compile(personId, 'current');
    await position(compileId, items.slice(0, 1)); // 0.25

    await checkCoverage(db, { log: () => {} });

    const open = await faults();
    const detail = open[0]!.detail;
    assert.match(detail, /covered fraction is 25%/);
    assert.match(detail, /reports what braintrust compiled Positions about/);
    assert.match(detail, /not how chris answers/);
    assert.match(detail, /not a coverage target/);
    assert.match(detail, /manufacture Positions the person does not hold/);
    assert.match(detail, /clears itself/);
  });

  it('skips a persona with nothing retrieved, no current compile, or one that is paused', async () => {
    // Nothing retrieved: the corpus is empty, so there is no fraction to be under.
    const emptyPersonId = await person('empty');
    await source(emptyPersonId);
    await compile(emptyPersonId, 'current');

    // No current compile: no Positions exist to carry the measurement.
    const neverCompiled = await person('never-compiled');
    await source(neverCompiled);

    // Paused: standing below the floor is fine when nobody is being served.
    const paused = await person('paused');
    const pausedSourceId = await source(paused);
    const pausedItems = await Promise.all(Array.from({ length: 5 }, (_, i) => item(pausedSourceId, i)));
    const pausedCompileId = await compile(paused, 'current');
    await position(pausedCompileId, pausedItems.slice(0, 1)); // 0.2
    await db.query(`update braintrust_people set paused_at = now() where id = $1`, [paused]);

    const measured = await measureCoveredFraction(db);
    assert.deepEqual(measured, []);

    await checkCoverage(db, { log: () => {} });
    assert.deepEqual(await faults(), []);
  });
});

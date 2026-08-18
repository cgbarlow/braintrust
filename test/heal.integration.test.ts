/**
 * The SOUL.md heal check against real Postgres: the join against `braintrust_people`
 * that excludes a paused Person, and a report actually landing in
 * `braintrust_soul_heals` and then in `braintrust_faults`.
 *
 * Fails loudly rather than skipping, like every database-backed suite. See
 * test/support/database.ts for how to stand a database up.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createDb, type PostgresDb } from '../src/db.js';
import { checkSoulHeal, currentTemplateVersion, recordHeal, SOUL_HEAL_ASSERTION } from '../src/heal.js';

import { testDatabaseUrl as url } from './support/database.js';

const DAY = 24 * 60 * 60 * 1000;

describe('the soul-heal check, against real Postgres', () => {
  let db: PostgresDb;

  before(async () => {
    db = createDb(url!);
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (db) {
      await db.query('truncate braintrust_people cascade');
      await db.query('truncate braintrust_faults');
      await db.query('truncate braintrust_soul_heals');
      await db.close();
    }
  });

  beforeEach(async () => {
    await db.query('truncate braintrust_people cascade');
    // Neither ledger is foreign-keyed to braintrust_people, so truncate cascade leaves
    // both holding the previous test's rows.
    await db.query('truncate braintrust_faults');
    await db.query('truncate braintrust_soul_heals');
  });

  async function person(slug: string, pausedAt: Date | null = null): Promise<void> {
    await db.query(
      `insert into braintrust_people (slug, display_name, paused_at) values ($1, $2, $3)`,
      [slug, slug.replace(/-/g, ' ').toUpperCase(), pausedAt],
    );
  }

  async function faults(): Promise<{ assertion: string; person_slug: string | null; detail: string }[]> {
    const { rows } = await db.query<{ assertion: string; person_slug: string | null; detail: string }>(
      'select assertion, person_slug, detail from braintrust_faults order by person_slug nulls first',
    );
    return rows;
  }

  it('recordHeal upserts one row per profile, and checkSoulHeal reads it back as current', async () => {
    await person('nate-b-jones');
    const version = await currentTemplateVersion();

    await recordHeal(db, { profile: 'bt-nate-b-jones', person: 'nate-b-jones', template_version: version });

    const { rows } = await db.query('select person_slug, profile, template_version from braintrust_soul_heals');
    assert.deepEqual(rows, [{ person_slug: 'nate-b-jones', profile: 'bt-nate-b-jones', template_version: version }]);

    const result = await checkSoulHeal(db);
    assert.equal(result.fleet.state, 'current');
    assert.equal(result.profiles[0]!.state, 'current');
    assert.deepEqual(await faults(), []);
  });

  it('a second report from the same profile replaces the row rather than adding one', async () => {
    await person('nate-b-jones');
    await recordHeal(db, { profile: 'bt-nate-b-jones', person: 'nate-b-jones', template_version: 'v1' });
    await recordHeal(db, { profile: 'bt-nate-b-jones', person: 'nate-b-jones', template_version: 'v2' });

    const { rows } = await db.query('select template_version from braintrust_soul_heals');
    assert.deepEqual(rows, [{ template_version: 'v2' }]);
  });

  it('excludes a paused person\'s report from the fleet check, the same as the rest of the serving fleet', async () => {
    await person('paused-person', new Date());
    await recordHeal(db, {
      profile: 'bt-paused-person',
      person: 'paused-person',
      template_version: 'ancient',
    });

    const result = await checkSoulHeal(db);
    // The only report on file belongs to somebody nobody is serving, so this reads
    // exactly like nobody has ever reported — no fault, no false alarm.
    assert.equal(result.fleet.state, 'silent');
    assert.deepEqual(result.profiles, []);
    assert.deepEqual(await faults(), []);
  });

  it('files a fault a maintainer can read, naming the command, when the fleet has gone silent for a day', async () => {
    await person('nate-b-jones');
    // Seeded directly, bypassing recordHeal's now(), to simulate an old report.
    await db.query(
      `insert into braintrust_soul_heals (person_slug, profile, template_version, reported_at)
       values ('nate-b-jones', 'bt-nate-b-jones', 'old', now() - interval '2 days')`,
    );

    const stillSilent = await checkSoulHeal(db, Date.now());
    assert.equal(stillSilent.fleet.state, 'silent');

    const open = await faults();
    assert.equal(open.length, 1);
    assert.equal(open[0]!.assertion, SOUL_HEAL_ASSERTION);
    assert.equal(open[0]!.person_slug, null);
    assert.match(open[0]!.detail, /patch-hermes-profiles\.sh/);

    // The next run, a fresh report arrives — the fault clears the same run it passes.
    await recordHeal(db, { profile: 'bt-nate-b-jones', person: 'nate-b-jones', template_version: await currentTemplateVersion() });
    const healed = await checkSoulHeal(db, Date.now());
    assert.equal(healed.fleet.state, 'current');
    assert.deepEqual(await faults(), []);
  });

  it('is silent by construction more than a day past a report, using the ledger\'s own one-day limit', async () => {
    await person('nate-b-jones');
    const reportedAt = Date.now() - (DAY + 60_000);
    await db.query(
      `insert into braintrust_soul_heals (person_slug, profile, template_version, reported_at)
       values ('nate-b-jones', 'bt-nate-b-jones', 'whatever', to_timestamp($1 / 1000.0))`,
      [reportedAt],
    );

    const result = await checkSoulHeal(db, Date.now());
    assert.equal(result.fleet.state, 'silent');
  });
});


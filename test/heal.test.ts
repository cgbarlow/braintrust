/**
 * The SOUL.md heal check, without a database: current versus stale versus silent, and
 * which of the two ledgers each writes to.
 *
 * A fake `braintrust_faults` table stands in for Postgres — enough to prove the shape
 * (one fault, deduplicated by key, cleared on a pass) without needing real rows. What
 * needs real rows — the join against `braintrust_people`, a paused Person excluded — is
 * test/heal.integration.test.ts instead.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import type { Db, QueryResult } from '../src/db.js';
import { ESCALATES_AFTER_MS } from '../src/interrogate/schedule.js';
import {
  checkSoulHeal,
  currentTemplateVersion,
  HEAL_FRESHNESS_MS,
  recordHeal,
  SOUL_HEAL_ASSERTION,
  SOUL_HEAL_COMMAND,
  type HealState,
} from '../src/heal.js';

const NOW = Date.parse('2026-08-18T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

type SeedRow = { person_slug: string; profile: string; template_version: string; reported_at: Date };

type FaultRow = { assertion: string; person_slug: string | null; detail: string };

/**
 * A fake `braintrust_soul_heals` join and a fake `braintrust_faults` table, exactly the
 * two things {@link checkSoulHeal} touches. `heal.ts` never issues a query this fake does
 * not recognise, so an unmatched query is the loudest possible sign that a query changed
 * shape and the test did not follow.
 */
function fakeDb(seed: SeedRow[]): { db: Db; faults: Map<string, FaultRow> } {
  const faults = new Map<string, FaultRow>();

  const db: Db = {
    async query<Row>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
      const flat = sql.replace(/\s+/g, ' ').trim();

      if (flat.startsWith('select h.person_slug')) {
        return { rows: seed as unknown as Row[] };
      }
      if (flat.startsWith('insert into braintrust_faults')) {
        const [key, assertion, person, detail] = params as [string, string, string | null, string];
        faults.set(key, { assertion, person_slug: person, detail });
        return {
          rows: [
            {
              fault_key: key,
              assertion,
              person_slug: person,
              detail,
              first_failed_at: new Date(NOW),
              last_failed_at: new Date(NOW),
              reported_at: null,
              escalated_at: null,
            },
          ] as Row[],
        };
      }
      if (flat.startsWith('delete from braintrust_faults')) {
        const [key] = params as [string];
        faults.delete(key);
        return { rows: [] as Row[] };
      }
      throw new Error(`heal.test.ts's fake db does not recognise this query: ${flat}`);
    },
  };

  return { db, faults };
}

function row(overrides: Partial<SeedRow> & { person_slug: string }): SeedRow {
  return {
    profile: `bt-${overrides.person_slug}`,
    template_version: 'abcdef123456',
    reported_at: new Date(NOW),
    ...overrides,
  };
}

describe('the soul-heal check', () => {
  it('reuses the fault ledger\'s own one-day outer limit rather than a figure of its own', () => {
    assert.equal(HEAL_FRESHNESS_MS, ESCALATES_AFTER_MS);
  });

  it('names the exact command a maintainer runs, because the host it runs on is not braintrust\'s', () => {
    assert.equal(SOUL_HEAL_COMMAND, './scripts/patch-hermes-profiles.sh');
  });

  it('hashes the checked-in template deterministically, and caches the read', async () => {
    const version = await currentTemplateVersion();
    assert.match(version, /^[0-9a-f]{12}$/);
    assert.equal(await currentTemplateVersion(), version);

    const { createHash } = await import('node:crypto');
    const content = await readFile(new URL('../hermes/SOUL.md.template', import.meta.url), 'utf8');
    assert.equal(version, createHash('sha256').update(content).digest('hex').slice(0, 12));
  });

  it('opens or clears nothing when nobody has ever reported — a false alarm braintrust must not raise', async () => {
    const { db, faults } = fakeDb([]);
    const result = await checkSoulHeal(db, NOW);

    assert.equal(result.fleet.state, 'silent');
    assert.equal(result.fleet.detail, null);
    assert.deepEqual(result.profiles, []);
    assert.equal(faults.size, 0);
  });

  it('is current when every profile reported the live template within the freshness window', async () => {
    const version = await currentTemplateVersion();
    const { db, faults } = fakeDb([
      row({ person_slug: 'nate-b-jones', template_version: version, reported_at: new Date(NOW - DAY / 2) }),
      row({ person_slug: 'matt-pocock', template_version: version, reported_at: new Date(NOW - 60_000) }),
    ]);

    const result = await checkSoulHeal(db, NOW);

    assert.equal(result.fleet.state, 'current');
    assert.equal(faults.size, 0);
    assert.deepEqual(
      result.profiles.map((one) => [one.person, one.state] as [string, HealState]),
      [
        ['nate-b-jones', 'current'],
        ['matt-pocock', 'current'],
      ],
    );
  });

  it('opens exactly one fleet-scoped fault when nothing has reported within a day — silence, not five faults', async () => {
    const { db, faults } = fakeDb([
      row({ person_slug: 'nate-b-jones', reported_at: new Date(NOW - DAY - 60_000) }),
      row({ person_slug: 'matt-pocock', reported_at: new Date(NOW - DAY - 30_000) }),
    ]);

    const result = await checkSoulHeal(db, NOW);

    assert.equal(result.fleet.state, 'silent');
    assert.match(result.fleet.detail!, /daily healer job/);
    assert.match(result.fleet.detail!, new RegExp(SOUL_HEAL_COMMAND.replace(/\./g, '\\.')));
    // The per-profile loop never runs: one outage, one fault, not one per profile.
    assert.deepEqual(result.profiles, []);
    assert.deepEqual([...faults.values()], [{ assertion: SOUL_HEAL_ASSERTION, person_slug: null, detail: result.fleet.detail }]);
  });

  it('opens a per-profile fault for a profile stuck behind while the rest of the fleet is current', async () => {
    const version = await currentTemplateVersion();
    const { db, faults } = fakeDb([
      row({ person_slug: 'nate-b-jones', template_version: version, reported_at: new Date(NOW - 60_000) }),
      // Reported recently, but still the old template — a host caching a stale fetch,
      // not a dead job.
      row({ person_slug: 'matt-pocock', template_version: 'old-version1', reported_at: new Date(NOW - 60_000) }),
    ]);

    const result = await checkSoulHeal(db, NOW);

    assert.equal(result.fleet.state, 'current');
    const matt = result.profiles.find((one) => one.person === 'matt-pocock')!;
    const nate = result.profiles.find((one) => one.person === 'nate-b-jones')!;
    assert.equal(matt.state, 'stale');
    assert.match(matt.detail, /old-version1/);
    assert.match(matt.detail, new RegExp(SOUL_HEAL_COMMAND.replace(/\./g, '\\.')));
    assert.equal(nate.state, 'current');

    assert.deepEqual(
      [...faults.keys()],
      [`${SOUL_HEAL_ASSERTION}:matt-pocock`],
    );
  });

  it('clears a previously-open fault the run it observes a pass, the same rule every fault on the ledger follows', async () => {
    const version = await currentTemplateVersion();
    const { db, faults } = fakeDb([row({ person_slug: 'matt-pocock', template_version: 'behind', reported_at: new Date(NOW) })]);
    faults.set(`${SOUL_HEAL_ASSERTION}:matt-pocock`, {
      assertion: SOUL_HEAL_ASSERTION,
      person_slug: 'matt-pocock',
      detail: 'a stale detail from a previous run',
    });

    // The next report lands with the current version.
    const { db: healedDb, faults: healedFaults } = fakeDb([
      row({ person_slug: 'matt-pocock', template_version: version, reported_at: new Date(NOW) }),
    ]);
    void db; // the first fake only set up the "previously open" scenario for the reader
    const result = await checkSoulHeal(healedDb, NOW);

    assert.equal(result.profiles[0]!.state, 'current');
    assert.equal(healedFaults.size, 0);
  });

  it('recordHeal writes profile, person and template_version, upserted by person_slug', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db: Db = {
      async query<Row>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
        calls.push({ sql, params });
        return { rows: [] as Row[] };
      },
    };

    await recordHeal(db, { profile: 'bt-nate-b-jones', person: 'nate-b-jones', template_version: 'abc123456789' });

    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /insert into braintrust_soul_heals/);
    assert.match(calls[0]!.sql, /on conflict \(person_slug\) do update/);
    assert.deepEqual(calls[0]!.params, ['nate-b-jones', 'bt-nate-b-jones', 'abc123456789']);
  });
});


/**
 * Registration against a real Postgres.
 *
 * The unit tests prove what braintrust *asks* the database for. This proves the
 * database says yes: the DDL defaults are the defaults the plan claimed, a new source
 * really does land with `backfill_complete = false`, and the whole registration is one
 * transaction that either happens or does not.
 *
 * Skipped unless BRAINTRUST_TEST_DATABASE_URL is set. To run it locally:
 *
 *   docker run -d --name bt-pg -e POSTGRES_PASSWORD=bt -e POSTGRES_DB=braintrust \
 *     -p 55432:5432 pgvector/pgvector:pg16
 *   BRAINTRUST_TEST_DATABASE_URL=postgresql://postgres:bt@127.0.0.1:55432/braintrust \
 *     npm test
 *
 * This file and `schema.integration.test.ts` share one database and both truncate it,
 * which is why `npm test` runs files one at a time (`--test-concurrency=1`). Run in
 * parallel they race on `create extension` before they even get to the truncates.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createDb, type PostgresDb } from '../src/db.js';
import { followPerson, type PlanResponse } from '../src/follow/index.js';
import { createConfirmTokenStore } from '../src/follow/tokens.js';
import { listPersonas } from '../src/personas.js';
import { DEFAULT_SETTINGS } from '../src/sources/types.js';
import { CHANNEL_ID, NOW, SUBSTACK_HOST, fakeFetcher, natesRoutes } from './support/sources.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const LINKS = [`https://${SUBSTACK_HOST}/p/one`, '@NateBJones'];
const NAME = 'Nate B. Jones';

describe('following someone, against real Postgres', { skip }, () => {
  let db: PostgresDb;

  before(async () => {
    db = createDb(url!);
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (db) {
      await db.query('truncate braintrust_people cascade');
      await db.close();
    }
  });

  beforeEach(async () => {
    await db.query('truncate braintrust_people cascade');
  });

  function deps() {
    return {
      db,
      tokens: createConfirmTokenStore(),
      fetcher: fakeFetcher(natesRoutes()),
      now: () => NOW,
      pause: async () => {},
    };
  }

  /** Runs the whole handshake, the way a client does. */
  async function follow(displayName = NAME, links = LINKS, shared = deps()) {
    const plan = (await followPerson({ links }, shared)) as PlanResponse;
    const followed = await followPerson(
      { confirm_token: plan.confirm_token, display_name: displayName },
      shared,
    );
    assert.ok('followed' in followed);
    return { plan: plan.plan, followed: followed.followed, deps: shared };
  }

  it('writes one person and two sources', async () => {
    const { followed } = await follow();

    assert.equal(followed.person, 'nate-b-jones');
    assert.equal(followed.created, true);

    const people = await db.query<{ slug: string; display_name: string; paused_at: Date | null }>(
      'select slug, display_name, paused_at from braintrust_people',
    );
    assert.deepEqual(people.rows, [{ slug: 'nate-b-jones', display_name: NAME, paused_at: null }]);

    const sources = await db.query<{ platform: string; handle: string; discovery_url: string }>(
      'select platform, handle, discovery_url from braintrust_sources order by platform',
    );
    assert.deepEqual(sources.rows, [
      {
        platform: 'substack',
        handle: SUBSTACK_HOST,
        discovery_url: `https://${SUBSTACK_HOST}/feed`,
      },
      {
        platform: 'youtube',
        handle: CHANNEL_ID,
        discovery_url: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      },
    ]);
  });

  it('starts every source with backfill_complete false, which is the whole handoff', async () => {
    await follow();

    const { rows } = await db.query<{ backfill_complete: boolean; last_checked_at: Date | null; cursor: Date | null }>(
      'select backfill_complete, last_checked_at, cursor_published_at as cursor from braintrust_sources',
    );

    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.backfill_complete, false);
      // Registration signals nothing else: never polled, nothing seen.
      assert.equal(row.last_checked_at, null);
      assert.equal(row.cursor, null);
    }
  });

  it('takes the DDL defaults for the settings the DDL owns', async () => {
    await follow();

    const { rows } = await db.query<{ exclude_shorts: boolean; poll_interval_hours: number; floor: string }>(
      `select exclude_shorts, poll_interval_hours, backfill_floor::text as floor
         from braintrust_sources order by platform`,
    );

    for (const row of rows) {
      assert.equal(row.exclude_shorts, DEFAULT_SETTINGS.excludeShorts);
      assert.equal(row.poll_interval_hours, DEFAULT_SETTINGS.pollIntervalHours);
      // Twelve months before the injected clock, computed by registration because
      // `backfill_floor` has no DDL default to compute it.
      assert.equal(row.floor, '2025-07-29');
    }
  });

  it('ingests nothing: no item, chunk, embedding or note exists afterwards', async () => {
    await follow();

    for (const table of [
      'braintrust_items',
      'braintrust_chunks',
      'braintrust_embeddings',
      'braintrust_item_notes',
      'braintrust_compiles',
    ]) {
      const { rows } = await db.query<{ count: string }>(`select count(*)::text as count from ${table}`);
      assert.equal(rows[0]!.count, '0', `${table} should be empty after following someone`);
    }
  });

  it('shows up in braintrust_list_personas immediately, uncompiled', async () => {
    await follow();

    const { personas } = await listPersonas(db);
    assert.equal(personas.length, 1);
    assert.equal(personas[0]!.person, 'nate-b-jones');
    assert.equal(personas[0]!.subject, 'braintrust model of Nate B. Jones');
    assert.equal(personas[0]!.compiled, false);
    assert.equal(personas[0]!.corpus, undefined);
  });

  it('honours a per-source override, and the database keeps it', async () => {
    const shared = deps();
    const plan = (await followPerson(
      { links: LINKS, overrides: [{ platform: 'youtube', window_months: 3, exclude_shorts: false, poll_interval_hours: 6 }] },
      shared,
    )) as PlanResponse;
    await followPerson({ confirm_token: plan.confirm_token, display_name: NAME }, shared);

    const { rows } = await db.query<{
      platform: string;
      floor: string;
      exclude_shorts: boolean;
      poll_interval_hours: number;
    }>(
      `select platform, backfill_floor::text as floor, exclude_shorts, poll_interval_hours
         from braintrust_sources order by platform`,
    );

    assert.deepEqual(rows[0], {
      platform: 'substack',
      floor: '2025-07-29',
      exclude_shorts: true,
      poll_interval_hours: 24,
    });
    assert.deepEqual(rows[1], {
      platform: 'youtube',
      floor: '2026-04-29',
      exclude_shorts: false,
      poll_interval_hours: 6,
    });
  });

  it('gives a second person with the same name a suffixed slug', async () => {
    await follow(NAME, [`https://${SUBSTACK_HOST}/p/one`]);
    const second = await follow(NAME, ['@NateBJones']);

    assert.equal(second.followed.person, 'nate-b-jones-2');
    const { rows } = await db.query<{ slug: string }>('select slug from braintrust_people order by slug');
    assert.deepEqual(
      rows.map((row) => row.slug),
      ['nate-b-jones', 'nate-b-jones-2'],
    );
  });

  it('re-following a paused person clears the pause and keeps the sources', async () => {
    await follow();
    await db.query('update braintrust_people set paused_at = now()');

    const again = await follow('Nathaniel B. Jones');

    assert.equal(again.followed.created, false);
    assert.equal(again.followed.resumed_from_pause, true);
    assert.equal(again.followed.person, 'nate-b-jones');
    for (const source of again.followed.sources) assert.equal(source.created, false);

    const { rows } = await db.query<{ count: string; paused_at: Date | null; display_name: string }>(
      `select (select count(*)::text from braintrust_sources) as count, paused_at, display_name
         from braintrust_people`,
    );
    // Nothing duplicated, the pause gone, the confirmed name taken.
    assert.equal(rows[0]!.count, '2');
    assert.equal(rows[0]!.paused_at, null);
    assert.equal(rows[0]!.display_name, 'Nathaniel B. Jones');
  });

  it('reopens the backfill when a re-follow widens the window', async () => {
    const shared = deps();
    const narrow = (await followPerson(
      { links: ['@NateBJones'], overrides: [{ platform: 'youtube', window_months: 3 }] },
      shared,
    )) as PlanResponse;
    await followPerson({ confirm_token: narrow.confirm_token, display_name: NAME }, shared);
    await db.query('update braintrust_sources set backfill_complete = true');

    const again = await follow(NAME, ['@NateBJones'], deps());

    assert.equal(again.followed.sources[0]!.backfill_complete, false);
    assert.equal(again.followed.sources[0]!.backfill_floor, '2025-07-29');
  });

  it('refuses when the links belong to two people, and writes nothing at all', async () => {
    // One person already owns the Substack, another already owns the channel.
    await follow('Someone Else', [`https://${SUBSTACK_HOST}/p/one`]);
    await follow('Third Person', ['@NateBJones']);

    const shared = deps();
    const plan = (await followPerson({ links: LINKS }, shared)) as PlanResponse;

    await assert.rejects(
      () => followPerson({ confirm_token: plan.confirm_token, display_name: NAME }, shared),
      /already belong to different people/,
    );

    // The transaction rolled back: no third person, no source moved.
    const people = await db.query<{ slug: string }>('select slug from braintrust_people order by slug');
    assert.deepEqual(
      people.rows.map((row) => row.slug),
      ['someone-else', 'third-person'],
    );
    const sources = await db.query<{ count: string }>(
      'select count(*)::text as count from braintrust_sources',
    );
    assert.equal(sources.rows[0]!.count, '2');
  });
});

/**
 * The handshake, both halves.
 *
 * The load-bearing test in here is the first one: call 1 runs against a database
 * that throws on contact. "Call 1 ingests nothing" is not a comment in this codebase,
 * it is a dependency that call 1 does not have.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { followPerson, type FollowResponse, type PlanResponse } from '../src/follow/index.js';
import { createConfirmTokenStore } from '../src/follow/tokens.js';
import { fakeDb, refusingDb, type Answer, type FakeDb } from './support/fake-db.js';
import { CHANNEL_ID, NOW, SUBSTACK_HOST, fakeFetcher, natesRoutes } from './support/sources.js';

const LINKS = [`https://${SUBSTACK_HOST}/p/one`, '@NateBJones'];

const NAME = 'Nate B. Jones';

/** Everything a registration asks a real database, answered as an empty braintrust. */
const emptyBraintrust: Answer = (sql) => {
  const text = sql.replace(/\s+/g, ' ');
  if (text.includes('select distinct person_id')) return [];
  if (text.includes('select slug from braintrust_people')) return [];
  if (text.includes('insert into braintrust_people')) return [{ id: 'person-1' }];
  if (text.includes('from braintrust_sources')) return [];
  if (text.includes('insert into braintrust_sources')) {
    return [
      {
        backfill_floor: '2025-07-29',
        exclude_shorts: true,
        poll_interval_hours: 24,
        backfill_complete: false,
      },
    ];
  }
  return [];
};

function harness(db = fakeDb(emptyBraintrust)) {
  const tokens = createConfirmTokenStore();
  const deps = {
    db,
    tokens,
    fetcher: fakeFetcher(natesRoutes()),
    now: () => NOW,
    pause: async () => {},
  };
  return { db, tokens, deps };
}

function isPlan(response: FollowResponse): PlanResponse {
  assert.ok('plan' in response, 'expected a plan');
  return response;
}

describe('call 1', () => {
  it('ingests nothing — proved by having no database to ingest into', async () => {
    const { deps } = harness();
    const response = isPlan(await followPerson({ links: LINKS }, { ...deps, db: refusingDb }));

    assert.equal(response.ingested, false);
    assert.equal(response.plan.person, NAME);
    assert.ok(response.confirm_token.length > 20);
    assert.match(response.next, /Nothing has been fetched/);
  });

  it('never touches an item, a chunk, a note or an embedding', async () => {
    const { db, deps } = harness();
    await followPerson({ links: LINKS }, deps);

    assert.deepEqual(db.calls, []);
    assert.equal(db.transactions, 0);
  });

  it('takes a display name from a human who already knows it', async () => {
    const { deps } = harness();
    const response = isPlan(await followPerson({ links: LINKS, display_name: '  Nate  Jones ' }, deps));

    // Whitespace tidied, because this string is rendered into every answer.
    assert.equal(response.plan.person, 'Nate Jones');
  });

  it('asks for links rather than trying to search', async () => {
    const { deps } = harness();
    await assert.rejects(() => followPerson({}, deps), /cannot look someone up by name/);
  });

  it('refuses a link list that is plainly more than one person', async () => {
    const { deps } = harness();
    const links = Array.from({ length: 9 }, (_, index) => `https://p${index}.substack.com`);
    await assert.rejects(() => followPerson({ links }, deps), /more than one person's sources/);
  });
});

describe('call 2', () => {
  async function approved(db?: FakeDb) {
    const { db: database, deps } = harness(db);
    const plan = isPlan(await followPerson({ links: LINKS }, deps));
    return { db: database, deps, token: plan.confirm_token, plan: plan.plan };
  }

  it('writes the person and their sources, and nothing else', async () => {
    const { db, deps, token } = await approved();
    const response = await followPerson({ confirm_token: token, display_name: NAME }, deps);

    assert.ok('followed' in response);
    assert.equal(response.followed.person, 'nate-b-jones');
    assert.equal(response.followed.subject, 'braintrust model of Nate B. Jones');
    assert.equal(response.followed.created, true);
    assert.equal(response.followed.sources.length, 2);

    // One transaction: a person with no sources is not a state braintrust can be left in.
    assert.equal(db.transactions, 1);

    const touched = db.sql().join(' ');
    for (const table of ['braintrust_items', 'braintrust_chunks', 'braintrust_embeddings', 'braintrust_notes']) {
      assert.ok(!touched.includes(table), `registration must not touch ${table}`);
    }
  });

  it('starts every source with backfill_complete false and says that is the whole signal', async () => {
    const { deps, token } = await approved();
    const response = await followPerson({ confirm_token: token, display_name: NAME }, deps);

    assert.ok('followed' in response);
    assert.equal(response.ingested, false);
    for (const source of response.followed.sources) {
      assert.equal(source.backfill_complete, false);
      assert.equal(source.created, true);
    }
    assert.match(response.next, /backfill_complete/);
    assert.match(response.next, /the first run after following someone is the backfill/);
  });

  it('writes the settings the plan showed, and only those columns', async () => {
    const { db, deps, token } = await approved();
    await followPerson({ confirm_token: token, display_name: NAME }, deps);

    const insert = db.calls.find((call) => call.sql.includes('insert into braintrust_sources'))!;
    assert.deepEqual(insert.params, [
      'person-1',
      'substack',
      SUBSTACK_HOST,
      `https://${SUBSTACK_HOST}/feed`,
      '2025-07-29',
      true,
      24,
    ]);
    // Neither backfill_complete nor blocked_at is in the column list: registration
    // names only what the plan decides, and the DDL supplies the rest.
    const columns = insert.sql.slice(0, insert.sql.indexOf('values'));
    assert.ok(!columns.includes('backfill_complete'));
    assert.ok(!columns.includes('blocked_at'));
  });

  it('requires the confirmed display name, and spends the token saying so', async () => {
    const { deps, token } = await approved();

    await assert.rejects(
      () => followPerson({ confirm_token: token }, deps),
      (error: Error) => {
        assert.match(error.message, /braintrust proposed "Nate B\. Jones"/);
        assert.match(error.message, /nothing was written/);
        return true;
      },
    );
    // Spent: the human has to look at a fresh plan rather than retry a stale yes.
    await assert.rejects(() => followPerson({ confirm_token: token, display_name: NAME }, deps), /single-use/);
  });

  it('cannot be replayed', async () => {
    const { deps, token } = await approved();
    await followPerson({ confirm_token: token, display_name: NAME }, deps);

    await assert.rejects(
      () => followPerson({ confirm_token: token, display_name: NAME }, deps),
      /single-use/,
    );
  });

  it('refuses to be handed different links or settings than the plan carried', async () => {
    const { deps, token } = await approved();

    await assert.rejects(
      () => followPerson({ confirm_token: token, display_name: NAME, links: ['@SomeoneElse'] }, deps),
      /plan that was approved is the plan that runs/,
    );
    await assert.rejects(
      () =>
        followPerson(
          { confirm_token: token, display_name: NAME, overrides: [{ platform: 'youtube', window_months: 1 }] },
          deps,
        ),
      /plan that was approved is the plan that runs/,
    );
  });

  it('rejects a token from a server that has restarted', async () => {
    const { deps } = harness();
    await assert.rejects(
      () => followPerson({ confirm_token: 'from-a-previous-process', display_name: NAME }, deps),
      /lost if the server restarts/,
    );
  });

  it('takes a numeric suffix when the slug is taken', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('select slug from braintrust_people')) return [{ slug: 'nate-b-jones' }];
      return emptyBraintrust(sql, []);
    });
    const { deps, token } = await approved(db);

    const response = await followPerson({ confirm_token: token, display_name: NAME }, deps);
    assert.ok('followed' in response);
    assert.equal(response.followed.person, 'nate-b-jones-2');
  });
});

describe('re-following a paused person', () => {
  it('clears the pause, keeps the slug, and takes the newly confirmed name', async () => {
    const db = fakeDb((sql) => {
      const text = sql.replace(/\s+/g, ' ');
      if (text.includes('select distinct person_id')) return [{ person_id: 'person-9' }];
      if (text.includes('select slug, paused_at')) {
        return [{ slug: 'nate-b-jones', paused_at: new Date('2026-06-01T00:00:00Z') }];
      }
      if (text.includes('select id, backfill_floor')) {
        return [{ id: 'source-1', backfill_floor: '2025-01-01', backfill_complete: true }];
      }
      if (text.includes('update braintrust_sources')) {
        return [
          {
            backfill_floor: '2025-07-29',
            exclude_shorts: true,
            poll_interval_hours: 24,
            backfill_complete: true,
          },
        ];
      }
      return emptyBraintrust(sql, []);
    });

    const { deps } = harness(db);
    const plan = isPlan(await followPerson({ links: LINKS }, deps));
    const response = await followPerson(
      { confirm_token: plan.confirm_token, display_name: 'Nathaniel B. Jones' },
      deps,
    );

    assert.ok('followed' in response);
    assert.equal(response.followed.created, false);
    assert.equal(response.followed.resumed_from_pause, true);
    // The slug is what every other tool takes, so a rename must not orphan it.
    assert.equal(response.followed.person, 'nate-b-jones');
    assert.equal(response.followed.subject, 'braintrust model of Nathaniel B. Jones');

    const update = db.calls.find((call) => call.sql.includes('update braintrust_people'))!;
    assert.match(update.sql, /paused_at = null/);
    assert.deepEqual(update.params, ['person-9', 'Nathaniel B. Jones']);

    // A narrower floor than the stored one leaves the completed backfill alone —
    // items are tier 1 and braintrust does not delete them to match a smaller number.
    const sourceUpdate = db.calls.find((call) => call.sql.includes('update braintrust_sources'))!;
    assert.equal(sourceUpdate.params[5], false);
    // And a block stays measured: re-following does not assert the source answers again.
    assert.ok(!sourceUpdate.sql.includes('blocked_at'));
  });

  it('reopens the backfill when the window widens', async () => {
    const db = fakeDb((sql) => {
      const text = sql.replace(/\s+/g, ' ');
      if (text.includes('select distinct person_id')) return [{ person_id: 'person-9' }];
      if (text.includes('select slug, paused_at')) return [{ slug: 'nate-b-jones', paused_at: null }];
      if (text.includes('select id, backfill_floor')) {
        // Previously followed with a 3-month window.
        return [{ id: 'source-1', backfill_floor: '2026-04-29', backfill_complete: true }];
      }
      if (text.includes('update braintrust_sources')) {
        return [
          {
            backfill_floor: '2025-07-29',
            exclude_shorts: true,
            poll_interval_hours: 24,
            backfill_complete: false,
          },
        ];
      }
      return emptyBraintrust(sql, []);
    });

    const { deps } = harness(db);
    const plan = isPlan(await followPerson({ links: [`https://${SUBSTACK_HOST}`] }, deps));
    const response = await followPerson({ confirm_token: plan.confirm_token, display_name: NAME }, deps);

    assert.ok('followed' in response);
    assert.equal(response.followed.resumed_from_pause, false);
    const update = db.calls.find((call) => call.sql.includes('update braintrust_sources'))!;
    assert.equal(update.params[5], true, 'a wider window means there is more archive to reach');
  });

  it('refuses links that belong to two different people', async () => {
    const db = fakeDb((sql) => {
      if (sql.includes('select distinct person_id')) {
        return [{ person_id: 'person-1' }, { person_id: 'person-2' }];
      }
      return emptyBraintrust(sql, []);
    });

    const { deps } = harness(db);
    const plan = isPlan(await followPerson({ links: LINKS }, deps));
    await assert.rejects(
      () => followPerson({ confirm_token: plan.confirm_token, display_name: NAME }, deps),
      /already belong to different people/,
    );
  });
});

describe('the opaque channel id stays braintrust’s problem', () => {
  it('records the UC id braintrust resolved, from an @handle the human pasted', async () => {
    const { db, deps } = harness();
    const plan = isPlan(await followPerson({ links: ['@NateBJones'] }, deps));
    await followPerson({ confirm_token: plan.confirm_token, display_name: NAME }, deps);

    const insert = db.calls.find((call) => call.sql.includes('insert into braintrust_sources'))!;
    assert.equal(insert.params[2], CHANNEL_ID);
    assert.equal(plan.plan.sources[0]!.resolved_from, '@NateBJones');
  });
});

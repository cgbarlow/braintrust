/**
 * braintrust_refresh_persona and braintrust_unfollow_person, against real Postgres.
 *
 * braintrust_refresh_persona now fetches and reads only — compiles happen on the cron
 * deployment. This file tests that a refresh reaches the same rows by the same route as
 * the daily cycle, differs only in scope, and that unfollowing is a pause rather than a
 * delete no matter how it is described.
 *
 * Skipped unless BRAINTRUST_TEST_DATABASE_URL is set. To run it locally:
 *
 *   docker run -d --name bt-pg -e POSTGRES_PASSWORD=bt -e POSTGRES_DB=braintrust \
 *     -p 55432:5432 pgvector/pgvector:pg16
 *   BRAINTRUST_TEST_DATABASE_URL=postgresql://postgres:bt@127.0.0.1:55432/braintrust \
 *     npm test
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createDb, type PostgresDb } from '../src/db.js';
import { BraintrustError } from '../src/errors.js';
import { followPerson, type PlanResponse } from '../src/follow/index.js';
import { createConfirmTokenStore } from '../src/follow/tokens.js';
import { unfollowPerson } from '../src/follow/unfollow.js';
import { runCycle } from '../src/ingest/cycle.js';
import { createExtractor } from '../src/notes/index.js';
import { explainPersona, listPersonas, loadPersona } from '../src/personas.js';
import { refreshPersona, type RefreshResponse, type Refreshed } from '../src/refresh.js';
import { fakeExtractor, testExtractorConfig } from './support/notes.js';
import { NOW, SUBSTACK_HOST, fakeFetcher, natesRoutes, type FakeFetcher } from './support/sources.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const LINKS = [`https://${SUBSTACK_HOST}/p/post-0`, '@NateBJones'];
const NATE = 'nate-b-jones';

describe('refreshing and unfollowing, against real Postgres', { skip }, () => {
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

  /** The full handshake, which is the only way anyone gets into a braintrust. */
  async function follow(): Promise<void> {
    const deps = {
      db,
      tokens: createConfirmTokenStore(),
      fetcher: fakeFetcher(natesRoutes()),
      now: () => NOW,
      pause: async () => {},
    };
    const plan = (await followPerson({ links: LINKS }, deps)) as PlanResponse;
    await followPerson({ confirm_token: plan.confirm_token, display_name: 'Nate B. Jones' }, deps);
  }

  /** A reader that quotes what it was handed, so nothing is dropped as unquotable. */
  const quoting = () =>
    fakeExtractor({
      note: (user) => ({
        claims: [{ statement: 'It said this.', quote: user.slice(-40) }],
        argument: 'Argues from what it opened with to what it closed with.',
        assumptions: ['The reader has been paying attention.'],
      }),
    });

  type RefreshOptions = {
    person?: string;
    fetcher?: FakeFetcher;
    now?: () => Date;
    budgetMs?: number;
  };

  async function refresh(options: RefreshOptions = {}): Promise<RefreshResponse> {
    return refreshPersona(
      { person: options.person ?? NATE },
      {
        db,
        fetcher: options.fetcher ?? fakeFetcher(natesRoutes()),
        extractor: createExtractor(testExtractorConfig, quoting().fetcher),
        now: options.now ?? (() => NOW),
        pause: async () => {},
        log: () => {},
        ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
      },
    );
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  async function personId(slug = NATE): Promise<string> {
    const { rows } = await db.query<{ id: string }>('select id from braintrust_people where slug = $1', [
      slug,
    ]);
    return rows[0]!.id;
  }

  describe('braintrust_refresh_persona', () => {
    it('runs the fetch-and-read cycle for one person', async () => {
      await follow();

      const outcome = (await refresh()).refreshed;

      assert.equal(outcome.person, NATE);
      assert.equal(outcome.subject, 'braintrust model of Nate B. Jones');
      assert.deepEqual(
        outcome.polled.map((source) => source.platform).sort(),
        ['substack', 'youtube'],
      );
      assert.ok(outcome.discovered > 0, 'the feeds were polled');
      assert.ok(outcome.retrieved > 0, 'bodies were fetched');

      // A refresh fetches and reads; the compile happens on the daily run.
      assert.equal(
        await count('select count(*) from braintrust_chunks'),
        0,
        'chunks are written by the cycle but not by refresh',
      );
      assert.equal(await count('select count(*) from braintrust_compiles'), 0, 'no compile from refresh');
    });

    it('polls a source the daily job would leave until tomorrow', async () => {
      await follow();
      await refresh();

      // `last_checked_at` is now NOW, so nothing here is due on the daily clock. A
      // refresh is somebody asking now, so the interval has nothing to decide.
      const fetcher = fakeFetcher(natesRoutes());
      const outcome = (await refresh({ fetcher })).refreshed;

      assert.equal(outcome.polled.length, 2);
      assert.ok(
        fetcher.requests.some((request) => request.includes('/feed')),
        'the substack feed was fetched again',
      );
    });

    it('spends its minutes on the person it was asked about and nobody else', async () => {
      await follow();

      // A second person with a retrieved item and nothing done to it — the exact shape
      // of a backlog. A refresh of the first must not spend the operator's tokens on it.
      const other = await db.query<{ id: string }>(
        `insert into braintrust_people (slug, display_name) values ('someone-else', 'Someone Else')
         returning id`,
      );
      const source = await db.query<{ id: string }>(
        `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor,
                                         backfill_complete)
         values ($1, 'substack', 'other.substack.com', 'https://other.test/feed', current_date - 365, true)
         returning id`,
        [other.rows[0]!.id],
      );
      await db.query(
        `insert into braintrust_items (source_id, external_id, url, audience, retrieval, body_text,
                                        published_at)
         values ($1, 'other-1', 'https://other.test/1', 'everyone', 'retrieved',
                 'Something the other person published, at length and in prose.', '2025-05-01')`,
        [source.rows[0]!.id],
      );

      await refresh();

      const theirs = `select count(*) from braintrust_chunks c
                        join braintrust_items i on i.id = c.item_id
                       where i.external_id = 'other-1'`;
      assert.equal(await count(theirs), 0, 'the other person was not chunked');
      assert.equal(
        await count(
          `select count(*) from braintrust_item_notes n
             join braintrust_items i on i.id = n.item_id
            where i.external_id = 'other-1'`,
        ),
        0,
        'and not read, which is the expensive half',
      );
      assert.equal(await count('select count(*) from braintrust_compiles'), 0);
    });

    it('leaves a blocked source alone, because a refresh is not evidence it came back', async () => {
      await follow();
      await db.query(
        `update braintrust_sources set blocked_at = now() where platform = 'youtube'`,
      );

      const outcome = (await refresh()).refreshed;

      assert.deepEqual(
        outcome.polled.map((source) => source.platform),
        ['substack'],
      );

      // And said out loud, because "nothing new" and "half of it stopped answering" are
      // not the same news for the client that asked.
      assert.equal(outcome.blocked?.length, 1);
      assert.equal(outcome.blocked![0]!.platform, 'youtube');
      assert.match(outcome.blocked![0]!.since, /^\d{4}-\d{2}-\d{2}T/);
    });

    it('stops fetching when its budget runs out and says what is still owed', async () => {
      await follow();

      // A clock that jumps an hour once the run is under way: the budget expires
      // partway, which is what a first backfill through one HTTP request looks like.
      let ticks = 0;
      const now = () => new Date(NOW.getTime() + (ticks++ > 3 ? 60 * 60 * 1000 : 0));

      const outcome = (await refresh({ now })).refreshed;

      assert.equal(outcome.stopped_early, true);

      // Nothing was wasted: what it fetched is on disk, and the next run continues.
      assert.ok(await count('select count(*) from braintrust_items'), 'rows survive the stop');
    });

    it('reports the stop even when it lands inside the only source there is', async () => {
      // The stop lands between two items far more often than between two sources, and
      // with one source configured it can only land there. Reporting a clean finish to a
      // caller deciding whether to call again is the one wrong answer available here.
      await follow();
      await db.query(`update braintrust_sources set blocked_at = now() where platform = 'youtube'`);

      let ticks = 0;
      const now = () => new Date(NOW.getTime() + (ticks++ > 3 ? 60 * 60 * 1000 : 0));
      const outcome = (await refresh({ now })).refreshed;

      assert.equal(outcome.polled.length, 1);
      assert.equal(outcome.stopped_early, true);
    });

    it('refuses a paused person rather than resuming them behind the handshake', async () => {
      await follow();
      await unfollowPerson({ person: NATE }, { db });

      await assert.rejects(refresh(), (error: unknown) => {
        assert.ok(error instanceof BraintrustError);
        assert.match(error.message, /paused/);
        assert.match(error.message, /braintrust_follow_person/);
        return true;
      });

      assert.equal(await count('select count(*) from braintrust_items'), 0);
    });

    it('says who it does not follow rather than inventing them', async () => {
      await assert.rejects(refresh({ person: 'nobody' }), (error: unknown) => {
        assert.ok(error instanceof BraintrustError);
        assert.match(error.message, /braintrust_list_personas/);
        return true;
      });
    });
  });

  describe('braintrust_unfollow_person', () => {
    async function corpusSize(): Promise<{ items: number; chunks: number; notes: number }> {
      return {
        items: await count('select count(*) from braintrust_items'),
        chunks: await count('select count(*) from braintrust_chunks'),
        notes: await count('select count(*) from braintrust_item_notes'),
      };
    }

    it('pauses the person and deletes nothing at all', async () => {
      await follow();
      await refresh();
      const before = await corpusSize();
      assert.ok(before.items > 0);

      const response = await unfollowPerson({ person: NATE }, { db });

      assert.equal(response.deleted, 'nothing');
      assert.equal(response.paused.person, NATE);
      assert.equal(response.paused.was_already_paused, false);
      assert.equal(response.kept.sources, 2);
      assert.equal(response.kept.items, before.items);
      assert.equal(response.kept.persona?.still_queryable, true);
      assert.deepEqual(await corpusSize(), before);
      assert.equal(await count('select count(*) from braintrust_compiles'), 0);
    });

    it('leaves the persona answering, frozen at its last compile', async () => {
      await follow();
      const outcome = (await refresh()).refreshed;
      await unfollowPerson({ person: NATE }, { db });

      // No compile happened, so explainPersona should throw — never compiled.
      await assert.rejects(explainPersona(db, NATE), BraintrustError);
    });

    it('shows the pause in the listing, so nobody reads a frozen answer as a current one', async () => {
      await follow();
      await unfollowPerson({ person: NATE }, { db });

      const { personas } = await listPersonas(db);
      assert.ok(personas[0]!.paused, 'the pause is visible');
      assert.ok(personas[0]!.paused!.since);
    });

    it('stops the daily job touching them at all', async () => {
      await follow();
      await unfollowPerson({ person: NATE }, { db });

      const report = await runCycle({
        db,
        fetcher: fakeFetcher(natesRoutes()),
        now: () => NOW,
        pause: async () => {},
        log: () => {},
      });

      assert.deepEqual(report.sources, []);
      assert.equal(report.paused, 2);
      assert.equal(await count('select count(*) from braintrust_items'), 0);
    });

    it('is idempotent, and keeps the moment the user actually decided', async () => {
      await follow();
      const first = await unfollowPerson({ person: NATE }, { db });

      const second = await unfollowPerson({ person: NATE }, { db });

      assert.equal(second.paused.was_already_paused, true);
      assert.equal(second.paused.since, first.paused.since);
    });

    it('needs the whole handshake to undo, because resuming means fetching again', async () => {
      await follow();
      await unfollowPerson({ person: NATE }, { db });

      // A confirm token is the only way back in, and there is no shortcut past call 1.
      const deps = {
        db,
        tokens: createConfirmTokenStore(),
        fetcher: fakeFetcher(natesRoutes()),
        now: () => NOW,
        pause: async () => {},
      };
      await assert.rejects(
        followPerson({ confirm_token: 'made-up', display_name: 'Nate B. Jones' }, deps),
        BraintrustError,
      );
      assert.equal(await count('select count(*) from braintrust_people where paused_at is not null'), 1);

      const plan = (await followPerson({ links: LINKS }, deps)) as PlanResponse;
      const resumed = (await followPerson(
        { confirm_token: plan.confirm_token, display_name: 'Nate B. Jones' },
        deps,
      )) as { followed: { resumed_from_pause: boolean; person: string } };

      assert.equal(resumed.followed.resumed_from_pause, true);
      assert.equal(resumed.followed.person, NATE);
      assert.equal(await count('select count(*) from braintrust_people where paused_at is not null'), 0);
    });

    it('says who it does not follow rather than pausing nobody quietly', async () => {
      await assert.rejects(unfollowPerson({ person: 'nobody' }, { db }), (error: unknown) => {
        assert.ok(error instanceof BraintrustError);
        assert.match(error.message, /nothing to stop/);
        return true;
      });
    });
  });
});

/**
 * What happens at 3am when nobody is watching, and a Source stops answering.
 *
 * Everything here is measured rather than judged. Not one of these tests asserts on a
 * status code, because braintrust never reads one to decide a Source has blocked it: it
 * counts requests against *distinct* Items that came back with nothing usable, which is
 * the only signal that survives a 403 that is a CDN hiccup, a 429 that is politeness, and
 * a captcha interstitial that arrives as a 200 with HTML in it.
 *
 * Skipped unless BRAINTRUST_TEST_DATABASE_URL is set. See cycle.integration.test.ts for
 * how to stand one up.
 *
 * Spec: docs/design/ingestion.md §5.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  compileCorpus,
  coverageLayer,
  measureCoverage,
  withVoicePopulation,
} from '../src/compile/index.js';
import { createDb, type PostgresDb } from '../src/db.js';
import { followPerson, type PlanResponse } from '../src/follow/index.js';
import { createConfirmTokenStore } from '../src/follow/tokens.js';
import { runCycle, type CycleReport, type SourceReport } from '../src/ingest/cycle.js';
import { createExtractor } from '../src/notes/index.js';
import { explainPersona, listPersonas, loadPersona } from '../src/personas.js';
import { createEmbedder } from '../src/retrieval/index.js';
import { BLOCK_AFTER_FAILURES, MAX_RETRY_ATTEMPTS } from '../src/sources/types.js';
import { fakeEmbeddings, testEmbeddingsConfig } from './support/embeddings.js';
import { fakeExtractor, testExtractorConfig } from './support/notes.js';
import { fakeSynthesiser } from './support/synthesiser.js';
import {
  NOW,
  SUBSTACK_HOST,
  SUBSTACK_PAYWALLED,
  fakeFetcher,
  natesRoutes,
  substackPost,
  type FakeFetcher,
  type Route,
} from './support/sources.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const LINKS = [`https://${SUBSTACK_HOST}/p/post-0`, '@NateBJones'];

/** `/api/v1/posts/<slug>` — the request a block is measured on. */
const BODY_ENDPOINT = `https://${SUBSTACK_HOST}/api/v1/posts/`;
const slugOf = (request: string): string => decodeURIComponent(request.split('/api/v1/posts/')[1]!);

describe('a source that stops answering, against real Postgres', { skip }, () => {
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
    // The fault and stuck-rebuild ledgers are not foreign-keyed to `braintrust_people`,
    // so `truncate ... cascade` leaves them holding the previous test's rows — and this
    // file's whole point is that *one* fault means exactly that. Every test measures its
    // own episode against an empty ledger.
    await db.query('truncate braintrust_faults');
    await db.query('truncate braintrust_stuck_rebuilds');
  });

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

  /**
   * Substack's body endpoint, answering however the test says. Everything else — the
   * feed, the archive, the whole YouTube channel — behaves, which is what makes "a block
   * stops that source only" testable rather than asserted.
   */
  function routesWhereBodies(
    answer: (slug: string, attempt: number) => { status: number; body: string; headers?: Record<string, string> } | 'ok',
  ): Route[] {
    const attempts = new Map<string, number>();
    return [
      {
        match: (request: string) => request.startsWith(BODY_ENDPOINT),
        respond: (request: string) => {
          const slug = slugOf(request);
          const attempt = (attempts.get(slug) ?? 0) + 1;
          attempts.set(slug, attempt);
          const given = answer(slug, attempt);
          return given === 'ok' ? substackPost(slug) : given;
        },
      },
      ...natesRoutes(),
    ];
  }

  const refusing = (status: number, body = '<html>are you a robot?</html>') => () => ({ status, body });

  /**
   * The body endpoint answering for every slug — the unknown ones the test injects as
   * pending rows included. This is what an answering day looks like after the source was
   * refusing: the request it was refused yesterday is served today.
   */
  const servingBodies: Route[] = [
    {
      match: (request: string) => request.startsWith(BODY_ENDPOINT),
      respond: (request: string) => {
        const known = substackPost(slugOf(request));
        return known.status === 200
          ? known
          : { status: 200, body: JSON.stringify({ slug: slugOf(request), audience: 'everyone', body_html: '<p>Back.</p>' }) };
      },
    },
    ...natesRoutes(),
  ];

  async function run(
    options: { fetcher?: FakeFetcher; now?: Date; extract?: boolean } = {},
  ): Promise<{ report: CycleReport; fetcher: FakeFetcher }> {
    const fetcher = options.fetcher ?? fakeFetcher(natesRoutes());
    const report = await runCycle({
      db,
      fetcher,
      now: () => options.now ?? NOW,
      pause: async () => {},
      log: () => {},
      ...(options.extract
        ? {
            embedder: createEmbedder(testEmbeddingsConfig, fakeEmbeddings().fetcher),
            extractor: createExtractor(
              testExtractorConfig,
              fakeExtractor({
                note: (user) => ({
                  claims: [{ statement: 'It said this.', quote: user.slice(-40) }],
                  argument: 'Argues from what it opened with to what it closed with.',
                  assumptions: ['The reader has been paying attention.'],
                }),
              }).fetcher,
            ),
            synthesiser: fakeSynthesiser(),
          }
        : {}),
    });
    return { report, fetcher };
  }

  const of = (report: CycleReport, platform: string): SourceReport =>
    report.sources.find((source) => source.platform === platform)!;

  const bodyRequests = (fetcher: FakeFetcher): string[] =>
    fetcher.requests.filter((request) => request.startsWith(BODY_ENDPOINT));

  async function blockedAt(platform = 'substack'): Promise<Date | null> {
    const { rows } = await db.query<{ blocked_at: Date | null }>(
      'select blocked_at from braintrust_sources where platform = $1',
      [platform],
    );
    return rows[0]!.blocked_at;
  }

  /** Makes a source due again, as the next day's run would find it. */
  async function nextDay(): Promise<Date> {
    await db.query('update braintrust_sources set last_checked_at = null');
    return new Date(NOW.getTime() + 86_400_000);
  }

  /** A body request braintrust has not yet asked for, put in the backlog. */
  async function addPending(platform: string, externalId: string): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      'select id from braintrust_sources where platform = $1',
      [platform],
    );
    await db.query(
      `insert into braintrust_items (source_id, external_id, url, title, published_at, audience)
       values ($1, $2, 'https://x/y', $2, current_date, 'everyone')`,
      [rows[0]!.id, externalId],
    );
  }

  /** The counter and the block, read off the row the loop is supposed to keep straight. */
  async function sourceState(
    platform: string,
  ): Promise<{ consecutive_failures: number; blocked_at: Date | null }> {
    const { rows } = await db.query<{ consecutive_failures: number; blocked_at: Date | null }>(
      'select consecutive_failures, blocked_at from braintrust_sources where platform = $1',
      [platform],
    );
    return rows[0]!;
  }

  /** Every open fault. One row is the whole deduplication story. */
  async function faults(): Promise<{ assertion: string; person_slug: string | null; detail: string }[]> {
    const { rows } = await db.query<{ assertion: string; person_slug: string | null; detail: string }>(
      'select assertion, person_slug, detail from braintrust_faults',
    );
    return rows;
  }

  describe('measuring a block', () => {
    it('stops after N consecutive failures and never asks for the item after them', async () => {
      await follow();
      const { report, fetcher } = await run({ fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });

      const substack = of(report, 'substack');
      assert.equal(substack.failed, 0, 'every failed item is retried, none is terminal');
      assert.ok(substack.blocked_since, 'the source is recorded as having stopped answering');
      assert.equal(
        bodyRequests(fetcher).length,
        BLOCK_AFTER_FAILURES,
        'the crawl stops at the measurement, not at the end of the backlog',
      );
      assert.ok(await blockedAt());
    });

    it('measures across distinct items, so one broken item never blocks a source', async () => {
      await follow();
      // The same post fails every time it is asked for; every other post is served. On the
      // first run it is refused once and stays pending — a retry, not a lost item — while
      // the whole backlog still runs.
      const broken = routesWhereBodies((slug) => (slug === 'post-0' ? { status: 500, body: '' } : 'ok'));
      const first = await run({ fetcher: fakeFetcher(broken) });

      assert.equal(of(first.report, 'substack').failed, 0, 'one refusal is a retry, not a lost item');
      assert.equal(of(first.report, 'substack').blocked_since, undefined, 'one bad item is an item, not a source');
      assert.equal(await blockedAt(), null);
      assert.ok(bodyRequests(first.fetcher).length > BLOCK_AFTER_FAILURES, 'the rest of the backlog ran');

      // It is the only thing left to ask, and it keeps failing — so on the run that
      // spends its last retry, whatever the retry budget is, it is the one terminal item
      // that run reports. The streak never once came close to a block.
      let terminal: { report: CycleReport; fetcher: FakeFetcher } | undefined;
      for (let attempt = 1; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
        terminal = await run({ fetcher: fakeFetcher(broken), now: await nextDay() });
      }
      assert.equal(of(terminal!.report, 'substack').failed, 1, 'the one broken item, once its retries are spent');
      assert.equal(of(terminal!.report, 'substack').blocked_since, undefined, 'one bad item is an item, not a source');
      assert.equal(await blockedAt(), null);
    });

    it('counts consecutive failures, so a source that keeps answering is never blocked', async () => {
      await follow();
      // Every other post fails: far more than the threshold in total, never in a row. None
      // is asked twice yet, so none has exhausted its retries — the refusals are measured
      // as pending rows carrying an attempt, and there are far more of those than the
      // threshold while the streak never once ran away.
      let seen = 0;
      const { report } = await run({
        fetcher: fakeFetcher(routesWhereBodies(() => (seen++ % 2 === 0 ? { status: 403, body: '' } : 'ok'))),
      });

      const substack = of(report, 'substack');
      assert.equal(substack.failed, 0, 'plenty of refusals, none of them exhausting a retry');
      assert.equal(substack.blocked_since, undefined);
      assert.equal(await blockedAt(), null);

      const attempted = await db.query<{ count: string }>(
        `select count(*)::text as count
           from braintrust_items i
           join braintrust_sources s on s.id = i.source_id
          where s.platform = 'substack'
            and i.retrieval = 'pending'
            and i.attempt_count > 0`,
      );
      assert.ok(
        Number(attempted.rows[0]!.count) > BLOCK_AFTER_FAILURES,
        'the run really observed far more refusals than the threshold, never in a row',
      );
    });

    it('treats a paywall as an answer, because a source that says no is a source that spoke', async () => {
      await follow();
      // Failures broken up by posts that turned paid: never N in a row, and a paywall is
      // a source answering rather than a source refusing.
      let seen = 0;
      const { report } = await run({
        fetcher: fakeFetcher(
          routesWhereBodies(() => {
            seen += 1;
            if (seen % BLOCK_AFTER_FAILURES === 0) {
              return {
                status: 200,
                body: JSON.stringify({ slug: 'x', audience: 'only_paid', body_html: null }),
              };
            }
            return { status: 403, body: '' };
          }),
        ),
      });

      const substack = of(report, 'substack');
      assert.equal(substack.skipped_paywall > 0, true);
      assert.equal(substack.blocked_since, undefined);
      assert.equal(await blockedAt(), null);
    });

    it('waits out a 429 and retries the same item, so the counter never sees it', async () => {
      await follow();
      const waits: number[] = [];
      const fetcher = fakeFetcher(
        routesWhereBodies((_slug, attempt) =>
          attempt === 1 ? { status: 429, body: '', headers: { 'retry-after': '2' } } : 'ok',
        ),
      );

      const report = await runCycle({
        db,
        fetcher,
        now: () => NOW,
        pause: async (ms) => {
          waits.push(ms);
        },
        log: () => {},
      });

      const substack = of(report, 'substack');
      assert.equal(substack.failed, 0, 'rate limiting is the source asking braintrust to slow down');
      assert.equal(substack.blocked_since, undefined);
      assert.equal(await blockedAt(), null);
      assert.ok(waits.includes(2000), 'braintrust waited the time it was asked to wait');
    });

    it('blocks that source only, and every other source finishes its run', async () => {
      await follow();
      const { report } = await run({ fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });

      assert.ok(of(report, 'substack').blocked_since);
      const youtube = of(report, 'youtube');
      assert.equal(youtube.blocked_since, undefined);
      assert.ok(youtube.retrieved > 0, 'the two sources share nothing but a person');
      assert.equal(await blockedAt('youtube'), null);
    });

    it('keeps everything it already had, and leaves the rest of the backlog as rows', async () => {
      await follow();
      const { report } = await run({ fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });
      assert.ok(of(report, 'substack').blocked_since);

      // Nothing is deleted and nothing is invented. The refused items are `pending` rows
      // waiting for retry (none exhausted MAX_RETRY_ATTEMPTS yet), the ones never reached
      // are still `pending` rows, and the paywalled ones are still the skips they were —
      // all of which Coverage counts as a shortfall the persona names.
      assert.equal(await items('substack', 'failed'), 0, 'no item exhausted its retries');
      assert.ok((await items('substack', 'pending')) > BLOCK_AFTER_FAILURES, 'the backlog includes the retries');
      assert.equal(await items('substack', 'skipped_paywall'), SUBSTACK_PAYWALLED);
      assert.ok((await items('youtube', 'retrieved')) > 0, 'and the other source is untouched');
    });
  });

  describe('the backlog, suppressed', () => {
    it('still compiles a persona, on what braintrust actually has', async () => {
      await follow();
      // A full clean run, so there are notes to build from.
      await run({ extract: true });

      // Now the source stops answering, with a real backlog outstanding.
      await db.query(
        `insert into braintrust_items (source_id, external_id, url, title, published_at, audience)
         select id, 'never-served', 'https://x/y', 'Never served', current_date, 'everyone'
           from braintrust_sources where platform = 'substack'`,
      );
      await db.query(`update braintrust_sources set blocked_at = now() where platform = 'substack'`);

      const compile = await compileCorpus({
        db,
        extractor: createExtractor(testExtractorConfig, fakeExtractor({}).fetcher).generation,
        synthesiser: fakeSynthesiser(),
        now: () => NOW,
        log: () => {},
      });

      // A pending item on a blocked source is a real shortfall the persona names — but
      // waiting on it would hand the platform a veto over whether braintrust works.
      assert.deepEqual(compile.waiting, []);
      assert.deepEqual(compile.compiled, ['nate-b-jones']);
    });

    it('generates no requests for a blocked source beyond the one', async () => {
      await follow();
      const first = await run({ fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });
      assert.ok(of(first.report, 'substack').blocked_since);

      const { report, fetcher } = await run({
        fetcher: fakeFetcher(routesWhereBodies(refusing(403))),
        now: await nextDay(),
      });

      const substack = of(report, 'substack');
      assert.equal(substack.probed, true);
      assert.equal(substack.unblocked, undefined);
      assert.equal(bodyRequests(fetcher).length, 1, 'one request a day, forever');
      assert.equal(
        fetcher.requests.filter((request) => request.includes(SUBSTACK_HOST)).length,
        1,
        'and nothing else at all — no feed, no archive walk',
      );
      assert.ok(await blockedAt(), 'still blocked');
    });

    it('keeps backfill_complete false, because the corpus genuinely is incomplete', async () => {
      await follow();
      // A source that stopped answering partway through its first archive walk: the
      // honest state, and the one a repair loop would live in forever.
      const { fetcher } = await run({ fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });
      const walked = fetcher.requests.filter((request) => request.includes('/archive')).length;
      await db.query(`update braintrust_sources set backfill_complete = false`);

      const next = await run({
        fetcher: fakeFetcher(routesWhereBodies(refusing(403))),
        now: await nextDay(),
      });

      const { rows } = await db.query<{ backfill_complete: boolean }>(
        `select backfill_complete from braintrust_sources where platform = 'substack'`,
      );
      // The flag keeps telling the truth — a block merely stops it generating requests.
      assert.equal(rows[0]!.backfill_complete, false);
      assert.ok(walked > 0, 'the first run really did walk the archive');
      assert.equal(
        next.fetcher.requests.filter((request) => request.includes('/archive')).length,
        0,
        'and the blocked run walked none of it, which is what stops the repair loop',
      );
    });
  });

  describe('asking again tomorrow', () => {
    it('sends one ordinary request, unchanged — the same one it was refused', async () => {
      await follow();
      const blocked = await run({ fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });
      const refused = bodyRequests(blocked.fetcher);

      const { fetcher } = await run({
        fetcher: fakeFetcher(routesWhereBodies(refusing(403))),
        now: await nextDay(),
      });

      // No backoff, no rotation, no user-agent change: there is one host and one address
      // and nothing to rotate. The probe retries an item that was refused yesterday — the
      // fetch did not complete and the system retries it rather than leaving it failed.
      assert.equal(bodyRequests(fetcher).length, 1);
      const probe = bodyRequests(fetcher)[0]!;
      assert.ok(probe.startsWith(BODY_ENDPOINT));
      assert.ok(refused.includes(probe), 'a refused item is retried, not abandoned');
      assert.deepEqual(
        fetcher.sent.filter((request) => request.url === probe),
        [{ url: probe }],
        'a plain request with nothing added to it',
      );
    });

    it('clears the block when the source answers, and works it normally the next run', async () => {
      await follow();
      await run({ fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });
      assert.ok(await blockedAt());

      const probe = await run({ now: await nextDay() });
      assert.equal(of(probe.report, 'substack').unblocked, true);
      assert.equal(bodyRequests(probe.fetcher).length, 1, 'the probe is still one request');
      assert.equal(await blockedAt(), null);

      const back = await run({ now: await nextDay() });
      assert.equal(of(back.report, 'substack').probed, undefined);
      assert.ok(of(back.report, 'substack').retrieved > 1, 'normal work resumed');
    });

    it('falls back to the feed only when there is nothing left to retrieve', async () => {
      await follow();
      await run();
      await db.query(`update braintrust_sources set blocked_at = now() where platform = 'substack'`);

      const { report, fetcher } = await run({ now: await nextDay() });

      // The backlog is empty, so the feed is the only ordinary request there is.
      assert.equal(bodyRequests(fetcher).length, 0);
      assert.equal(
        fetcher.requests.filter((request) => request === `https://${SUBSTACK_HOST}/feed`).length,
        1,
      );
      assert.equal(of(report, 'substack').unblocked, true);
    });

    it('does not let a refresh clear a block, because asking is not evidence', async () => {
      await follow();
      await run({ fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });

      const { report } = await runCycle({
        db,
        fetcher: fakeFetcher(natesRoutes()),
        only: await scope(),
        now: () => NOW,
        pause: async () => {},
        log: () => {},
      }).then((report) => ({ report }));

      assert.deepEqual(
        report.sources.map((source) => source.platform),
        ['youtube'],
        'a refresh skips a blocked source entirely; the daily job finds out for itself',
      );
      assert.ok(await blockedAt());
    });
  });

  /**
   * The count is a column now, so the thing that used to reset to zero every night —
   * a daily backlog of one or two Items — is what finally reaches the threshold. And
   * the fault that reports the streak is deduplicated per source, not per run.
   */
  describe('the run-spanning failure count', () => {
    it('reaches the block one item a day, and opens exactly one fault across the episode', async () => {
      await follow();
      await run({ fetcher: fakeFetcher(natesRoutes()) });

      // One fresh item each day, each refused — but the steady-state Backlog is not one
      // item: yesterday's refusal is still pending until it exhausts its retries, so the
      // run re-asks it and the count accrues faster than the calendar. What the column
      // has to prove is that the streak survives the run boundary at all.
      let reached = 0;
      let blocked: { blocked_at: Date | null; consecutive_failures: number } | undefined;
      const DIET_CAP = BLOCK_AFTER_FAILURES + MAX_RETRY_ATTEMPTS;
      for (let day = 1; day <= DIET_CAP; day += 1) {
        await addPending('substack', `day-${day}`);
        const { report } = await run({
          fetcher: fakeFetcher(routesWhereBodies(refusing(403))),
          now: await nextDay(),
        });
        const state = await sourceState('substack');
        if (!blocked) {
          assert.ok(
            state.consecutive_failures > reached,
            'the count survives the run boundary rather than resetting each night',
          );
          reached = state.consecutive_failures;
          if (state.blocked_at) {
            blocked = state;
          } else if (day < BLOCK_AFTER_FAILURES) {
            assert.equal(of(report, 'substack').blocked_since, undefined, `not yet blocked at ${day}`);
            assert.equal(state.blocked_at, null);
          }
        }
        assert.equal((await faults()).length, 1, 'one fault, however many failures observed it');
      }

      assert.ok(blocked, 'a one-item-a-day diet still reaches the block');
      // The counter is incremented one failure at a time and the block fires the first
      // time it reaches the threshold, so the row that set `blocked_at` reads exactly
      // the threshold.
      assert.equal(blocked!.consecutive_failures, BLOCK_AFTER_FAILURES, 'the block fired on the count, not a guess');

      // A blocked source is probed once a day; a refusal changes nothing, so the fault
      // stays the one fault and reads at its highest count.
      await addPending('substack', 'day-after');
      await run({
        fetcher: fakeFetcher(routesWhereBodies(refusing(403))),
        now: await nextDay(),
      });
      assert.equal((await faults()).length, 1, 'still one fault, not one per run');
      const [fault] = await faults();
      assert.match(fault!.detail, /5 consecutive retrieval failures/);
    });

    it('keeps the fault for the source that failed, not the person and not another source', async () => {
      await follow();
      await run({ fetcher: fakeFetcher(natesRoutes()) });

      await addPending('substack', 'only-substack-fails');
      await run({
        fetcher: fakeFetcher(routesWhereBodies(refusing(403))),
        now: await nextDay(),
      });

      const { rows } = await db.query<{ id: string }>(
        "select id from braintrust_sources where platform = 'substack'",
      );
      const [fault] = await faults();
      assert.equal(fault!.assertion, `source_consecutive_failures:${rows[0]!.id}`);
      assert.equal(fault!.person_slug, 'nate-b-jones');
      // YouTube stayed healthy all along — no second fault with the same streak behind it.
      assert.equal((await faults()).length, 1);
      assert.match(fault!.detail, /substack/);
    });

    it('clears the fault the day an item comes back, exactly as the counter resets', async () => {
      await follow();
      await run({ fetcher: fakeFetcher(natesRoutes()) });

      await addPending('substack', 'bad-day');
      await run({
        fetcher: fakeFetcher(routesWhereBodies(refusing(403))),
        now: await nextDay(),
      });
      assert.equal((await sourceState('substack')).consecutive_failures, 1);
      assert.equal((await faults()).length, 1);

      // The day an item comes back — the same request that was refused yesterday, served
      // today — the streak breaks and the fault goes with it.
      await addPending('substack', 'good-day');
      await run({ fetcher: fakeFetcher(servingBodies), now: await nextDay() });
      assert.equal((await sourceState('substack')).consecutive_failures, 0);
      assert.equal((await faults()).length, 0, 'an answer retires the fault');
    });

    it('opens no fault for a source that simply published nothing', async () => {
      await follow();
      await run({ fetcher: fakeFetcher(natesRoutes()) });

      const { report } = await run({
        fetcher: fakeFetcher(routesWhereBodies(refusing(403))),
        now: await nextDay(),
      });

      assert.equal(report.corpus.failed, 0, 'nothing was asked, so nothing could fail');
      assert.equal((await faults()).length, 0, 'silence is not failure');
      assert.deepEqual(await sourceState('substack'), {
        consecutive_failures: 0,
        blocked_at: null,
      });
    });
  });

  describe('what the persona says about it', () => {
    it('names the blocked source in coverage, and never as the user pausing', async () => {
      await follow();
      // Substack stops answering during the run that builds the persona. YouTube does
      // not, and the compile happens anyway — on what braintrust actually has.
      await run({ extract: true, fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });

      const persona = await explainPersona(db, 'nate-b-jones');
      const coverage = persona.layers.coverage!;
      assert.match(coverage.descriptive, /Stopped answering/);
      assert.match(coverage.descriptive, /the source refusing braintrust, not the user choosing/i);

      const evidence = coverage.evidence as {
        by_source: Record<string, { blocked_since?: string }>;
      };
      assert.ok(evidence.by_source[`substack:${SUBSTACK_HOST}`]!.blocked_since);
      assert.equal(evidence.by_source['youtube:UCn4Cy9nCg2VwSlXcRPz9DTQ']?.blocked_since, undefined);
    });

    it('states that its corpus is incomplete for as long as backfill_complete is false', async () => {
      await follow();
      await run({ fetcher: fakeFetcher(routesWhereBodies(refusing(403))) });

      // The gap repair and the honesty flag are one column. Between noticing that
      // something was never seen and closing it — and here the block is what stops it
      // closing — the persona says its corpus is part of the archive rather than all of it.
      await db.query(`update braintrust_sources set backfill_complete = false`);
      const { rows } = await db.query<{ id: string }>('select id from braintrust_people');
      const coverage = coverageLayer(
        withVoicePopulation(await measureCoverage(db, rows[0]!.id), {
          min_words: 300,
          items: 0,
          median_words: 0,
          items_excluded: 0,
        }),
      );

      assert.match(coverage.descriptive_md, /Incomplete/);
      assert.match(coverage.descriptive_md, /part of the archive rather than all of it/);
      assert.equal(
        coverage.evidence.by_source[`substack:${SUBSTACK_HOST}`]!.backfill_complete,
        false,
      );
      // Two facts that read alike and are not alike, and both are its own field.
      assert.ok(coverage.evidence.by_source[`substack:${SUBSTACK_HOST}`]!.blocked_since);
    });

    it('carries the block in the listing, beside the pause and never as one', async () => {
      await follow();
      await db.query(`update braintrust_sources set blocked_at = now() where platform = 'substack'`);

      const { personas } = await listPersonas(db);
      const listing = personas[0]!;

      assert.equal(listing.paused, undefined, 'nobody paused anything');
      assert.equal(listing.blocked?.length, 1);
      assert.equal(listing.blocked![0]!.platform, 'substack');
      assert.equal(listing.blocked![0]!.handle, SUBSTACK_HOST);
      assert.match(listing.blocked![0]!.since, /^\d{4}-\d{2}-\d{2}T/);
    });

    it('reports a pause and a block as two separate facts on one person', async () => {
      await follow();
      await db.query(`update braintrust_sources set blocked_at = now() where platform = 'substack'`);
      await db.query('update braintrust_people set paused_at = now()');

      const { personas } = await listPersonas(db);
      const listing = personas[0]!;

      // Two columns, two facts, two fields. A persona reporting the second as the first
      // would be blaming its own user for a platform's decision.
      assert.ok(listing.paused);
      assert.equal(listing.blocked?.length, 1);
    });
  });

  async function scope(): Promise<{ id: string; slug: string }> {
    const { rows } = await db.query<{ id: string; slug: string }>(
      'select id, slug from braintrust_people limit 1',
    );
    return rows[0]!;
  }

  async function items(platform: string, retrieval: string): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count
         from braintrust_items i
         join braintrust_sources s on s.id = i.source_id
        where s.platform = $1 and i.retrieval = $2`,
      [platform, retrieval],
    );
    return Number(rows[0]!.count);
  }
});

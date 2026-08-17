/**
 * The one line the cron log gets. Nobody watches this job, so the summary is the
 * whole interface — and a summary that describes the wrong half of the run is worse
 * than none.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarise, type CycleReport, type SourceReport } from '../src/ingest/cycle.js';
import type { StuckRebuild } from '../src/compile/store.js';
import type { CoverageCheck } from '../src/verify/index.js';

function report(overrides: Partial<CycleReport> = {}): CycleReport {
  return {
    started: '2026-07-31T00:00:00.000Z',
    finished: '2026-07-31T00:00:01.000Z',
    sources: [],
    not_due: 2,
    paused: 0,
    blocked: 0,
    rebuild_pending: [],
    serving_behind: [],
    stuck: [] as StuckRebuild[],
    coverage: [] as CoverageCheck[],
    stopped_early: false,
    corpus: {
      pending: 0,
      retrieved: 70,
      skipped_paywall: 16,
      skipped_short: 9,
      skipped_window: 4,
      skipped_not_a_post: 0,
      skipped_no_captions: 0,
      failed: 3,
    },
    index: { items_chunked: 0, chunks_written: 0, chunks_embedded: 0, stopped_early: false },
    ...overrides,
  };
}

describe('the run summary', () => {
  it('says nothing was due when nothing was', () => {
    assert.equal(summarise(report()), 'braintrust: nothing was due — 0 of 2 sources were polled.');
  });

  it('reports the index even when no source was due', () => {
    // Yesterday's endpoint was switched off, so today's run has chunks to embed and no
    // feeds to poll. "Nothing was due" would be true and useless.
    const summary = summarise(
      report({
        index: {
          items_chunked: 0,
          chunks_written: 0,
          chunks_embedded: 1_199,
          model: 'qwen3-embedding:0.6b',
          stopped_early: false,
        },
      }),
    );

    assert.match(summary, /1199 embedded as qwen3-embedding:0\.6b/);
  });

  it('reports the notes, including the claims it could not quote', () => {
    // The drop count is the number worth watching: it is how a model tidying quotes
    // shows up as a number rather than as a persona that cites itself.
    const summary = summarise(
      report({
        notes: {
          generation: 'claude-sonnet-5@notes-1',
          items_read: 70,
          claims_kept: 412,
          claims_nearly: 0,
      claims_dropped: 9,
          items_failed: 1,
          stopped_early: false,
        },
      }),
    );

    assert.match(summary, /notes: 70 items read as claude-sonnet-5@notes-1, 412 claims/);
    assert.match(summary, /9 unquotable, dropped/);
    assert.match(summary, /1 failed/);
  });

  it('says nothing was due when the extractor had nothing to read either', () => {
    const summary = summarise(
      report({
        notes: {
          generation: 'claude-sonnet-5@notes-1',
          items_read: 0,
          claims_kept: 0,
          claims_nearly: 0,
      claims_dropped: 0,
          items_failed: 0,
          stopped_early: false,
        },
      }),
    );

    assert.equal(summary, 'braintrust: nothing was due — 0 of 2 sources were polled.');
  });

  it('names the personas it rebuilt, and the version that built them', () => {
    const summary = summarise(
      report({
        compile: {
          compiler_version: '0.1.0+measured-1.core-1',
          compiled: ['nate-b-jones'],
          waiting: [],
          failed: [],
          rejected: [],
        },
      }),
    );

    assert.match(summary, /compile: rebuilt nate-b-jones as 0\.1\.0\+measured-1\.core-1/);
  });

  it('says why a persona was not rebuilt, because nothing retries it later in the run', () => {
    const summary = summarise(
      report({
        index: { items_chunked: 3, chunks_written: 40, chunks_embedded: 0, stopped_early: false },
        compile: {
          compiler_version: '0.1.0+measured-1.core-1',
          compiled: [],
          waiting: [{ person: 'nate-b-jones', reason: '3 item(s) still owed' }],
          failed: [],
          rejected: [],
        },
      }),
    );

    // A rebuild waits for an empty backlog, so "nothing rebuilt" on a day with new
    // content is a normal outcome and an unexplained one is not.
    assert.match(summary, /compile: nothing rebuilt, 1 waiting \(3 item\(s\) still owed\)/);
  });

  it('says nothing was due when the only compile outcome was waiting', () => {
    const summary = summarise(
      report({
        compile: {
          compiler_version: '0.1.0+measured-1.core-1',
          compiled: [],
          waiting: [{ person: 'nate-b-jones', reason: 'nothing has been retrieved yet' }],
          failed: [],
          rejected: [],
        },
      }),
    );

    assert.equal(summary, 'braintrust: nothing was due — 0 of 2 sources were polled.');
  });

  it('reports a compile that failed, rather than a run that did nothing', () => {
    const summary = summarise(
      report({
        compile: {
          compiler_version: '0.1.0+measured-1.core-1',
          compiled: [],
          waiting: [],
          failed: [{ person: 'nate-b-jones', reason: 'the database went away' }],
          rejected: [],
        },
      }),
    );

    // The previous persona is still serving, which is exactly why a failure here would
    // otherwise be invisible.
    assert.match(summary, /1 failed: nate-b-jones/);
  });

  it('reports a compile the gate refused to publish, which is not the same as one that failed', () => {
    const summary = summarise(
      report({
        compile: {
          compiler_version: '0.1.0+measured-1.core-1',
          compiled: [],
          waiting: [],
          failed: [],
          rejected: [{ person: 'nate-b-jones', reason: 'reasoning carried no prose' }],
        },
      }),
    );

    // Nothing in v1 reads `rejected_reason`, so this line is the only place a
    // persistently rejected compiler is visible at all — an accepted cost, and the
    // reason it is worth a line rather than a counter.
    assert.match(summary, /1 rejected by the gate, not published: nate-b-jones/);
  });

  it('reports an index that could not finish, rather than a clean run', () => {
    const summary = summarise(
      report({ index: { ...report().index, error: 'braintrust could not reach the embeddings endpoint' } }),
    );

    assert.match(summary, /error: braintrust could not reach the embeddings endpoint/);
  });

  it('names both halves after a real run', () => {
    const summary = summarise(
      report({
        sources: [
          {
            person: 'nate-b-jones',
            platform: 'youtube',
            handle: 'UC0C',
            discovered: 15,
            catalogued: 70,
            retrieved: 69,
            skipped_paywall: 0,
            skipped_short: 9,
            skipped_window: 0,
            skipped_not_a_post: 0,
            skipped_no_captions: 0,
            failed: 0,
            backfill_complete: true,
            gap_detected: false,
            dated: 62,
          },
        ],
        index: {
          items_chunked: 70,
          chunks_written: 1_199,
          chunks_embedded: 1_199,
          model: 'qwen3-embedding:0.6b',
          stopped_early: false,
        },
      }),
    );

    assert.match(summary, /69 retrieved, 9 skipped \(short\), 62 dated/);
    assert.match(summary, /index: 70 items chunked, 1199 chunks, 1199 embedded/);
  });

  /**
   * Nobody is watching a 3am job, so these three lines are the only account of a source
   * that stopped answering — and each is a different piece of news to whoever reads the
   * logs a fortnight later.
   */
  describe('a source that stopped answering', () => {
    const source = (extra: Partial<SourceReport>): SourceReport => ({
      person: 'nate-b-jones',
      platform: 'substack',
      handle: 'natesnewsletter.substack.com',
      discovered: 0,
      catalogued: 0,
      retrieved: 0,
      skipped_paywall: 0,
      skipped_short: 0,
      skipped_window: 0,
      skipped_not_a_post: 0,
      skipped_no_captions: 0,
      failed: 0,
      backfill_complete: false,
      gap_detected: false,
      dated: 0,
      ...extra,
    });

    it('says so on the run that measured it', () => {
      const summary = summarise(
        report({ sources: [source({ failed: 5, blocked_since: '2026-07-31T00:00:00.000Z' })] }),
      );
      assert.match(summary, /stopped answering; blocked, backlog left alone/);
    });

    it('says it asked again, and how long it has been refusing', () => {
      const summary = summarise(
        report({
          sources: [source({ probed: true, blocked_since: '2026-07-14T00:00:00.000Z' })],
        }),
      );
      assert.match(summary, /still blocked since 2026-07-14T00:00:00\.000Z, asked once/);
    });

    it('says when it came back, which is the line worth finding', () => {
      const summary = summarise(
        report({
          sources: [
            source({ probed: true, unblocked: true, blocked_since: '2026-07-14T00:00:00.000Z' }),
          ],
        }),
      );
      assert.match(summary, /answered again; block cleared/);
      assert.doesNotMatch(summary, /still blocked/);
    });
  });

  /**
   * The scheduled check reaches the one line nobody reads unless something is wrong. A
   * check whose result never leaves the report is not a check — one persona differed on
   * part of its compiler version for three days with nothing watching.
   */
  describe('a persona still serving on rules that have moved', () => {
    it('says so, and names who', () => {
      const summary = summarise(report({ serving_behind: ['ethan-mollick', 'nate-b-jones'] }));

      assert.match(summary, /serving behind the compiler: ethan-mollick, nate-b-jones/);
      // …and what a reader gets in the meantime, so the line is actionable rather than alarming.
      assert.match(summary, /tightened gate/);
      assert.match(summary, /next run retries the rebuild/);
    });

    it('says nothing at all when the run left nobody behind', () => {
      assert.doesNotMatch(summarise(report({ serving_behind: [] })), /serving behind/);
    });

    /**
     * A run where nothing was due is exactly when a persona left behind by a rules change
     * goes unnoticed — which is how one differed on part of its compiler version for three
     * days. The check runs every cycle, and so does the line that reports it.
     */
    it('says so even on a run where nothing was due', () => {
      const idle = summarise(
        report({ sources: [], notes: undefined, compile: undefined, serving_behind: ['nate-b-jones'] }),
      );

      assert.match(idle, /nothing was due/);
      assert.match(idle, /serving behind the compiler: nate-b-jones/);
    });
  });

  describe('a persona stuck behind the compiler for two or more cycles', () => {
    const stuckReport = (cycles: number) =>
      report({
        serving_behind: ['nate-b-jones'],
        stuck: [{ person_slug: 'nate-b-jones', first_stuck_at: '2026-08-08T09:00:00.000Z', cycles_behind: cycles }],
      });

    it('says nothing when nobody is stuck', () => {
      assert.doesNotMatch(summarise(report()), /stuck behind/);
    });

    it('reports the stuck persona with the cycle count when two or more', () => {
      const summary = summarise(stuckReport(2));

      assert.match(summary, /stuck behind the compiler: nate-b-jones/);
      assert.match(summary, /2\+ cycles/);
      assert.match(summary, /issue filed/);
    });

    it('says so even on a run where nothing was due', () => {
      const idle = summarise(
        report({
          sources: [],
          notes: undefined,
          compile: undefined,
          serving_behind: [],
          stuck: [{ person_slug: 'nate-b-jones', first_stuck_at: '2026-08-08T09:00:00.000Z', cycles_behind: 2 }],
        }),
      );

      assert.match(idle, /nothing was due/);
      assert.match(idle, /stuck behind/);
    });
  });

  describe('a persona whose current Compile covers less than half of what it read', () => {
    const coverageReport = (covered: number, retrieved: number) =>
      report({
        serving_behind: [],
        coverage: [
          {
            person: 'nate-b-jones',
            retrieved,
            covered,
            covered_fraction: covered / retrieved,
            failing: covered / retrieved < 0.5,
          },
        ],
      });

    it('says nothing when nobody is under-covered', () => {
      assert.doesNotMatch(summarise(report()), /under-covered/);
    });

    it('names the below-floor persona and the fraction, and says it is a report not a gate', () => {
      const summary = summarise(coverageReport(2, 5));

      assert.match(summary, /under-covered: nate-b-jones \(40% covered\)/);
      assert.match(summary, /issue filed/);
      // The line that keeps the finding from sounding like the persona stopped answering.
      assert.match(summary, /a report, not a gate/);
    });

    it('says so even on a run where nothing was due', () => {
      const idle = summarise(
        report({
          sources: [],
          notes: undefined,
          compile: undefined,
          serving_behind: [],
          coverage: [
            {
              person: 'nate-b-jones',
              retrieved: 524,
              covered: 236,
              covered_fraction: 236 / 524,
              failing: true,
            },
          ],
        }),
      );

      assert.match(idle, /nothing was due/);
      assert.match(idle, /under-covered: nate-b-jones \(45% covered\)/);
    });
  });
});

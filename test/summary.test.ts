/**
 * The one line the cron log gets. Nobody watches this job, so the summary is the
 * whole interface — and a summary that describes the wrong half of the run is worse
 * than none.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarise, type CycleReport } from '../src/ingest/cycle.js';

function report(overrides: Partial<CycleReport> = {}): CycleReport {
  return {
    started: '2026-07-31T00:00:00.000Z',
    finished: '2026-07-31T00:00:01.000Z',
    sources: [],
    not_due: 2,
    paused_or_blocked: 0,
    rebuild_pending: [],
    stopped_early: false,
    corpus: { pending: 0, retrieved: 70, skipped_paywall: 16, skipped_short: 9, failed: 3 },
    index: { items_chunked: 0, chunks_written: 0, chunks_embedded: 0, stopped_early: false },
    ...overrides,
  };
}

describe('the run summary', () => {
  it('says nothing was due when nothing was', () => {
    assert.equal(summarise(report()), 'braintrust: nothing was due.');
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
          claims_dropped: 0,
          items_failed: 0,
          stopped_early: false,
        },
      }),
    );

    assert.equal(summary, 'braintrust: nothing was due.');
  });

  it('names the personas it rebuilt, and the version that built them', () => {
    const summary = summarise(
      report({
        compile: {
          compiler_version: '0.1.0+measured-1',
          compiled: ['nate-b-jones'],
          waiting: [],
          failed: [],
        },
      }),
    );

    assert.match(summary, /compile: rebuilt nate-b-jones as 0\.1\.0\+measured-1/);
  });

  it('says why a persona was not rebuilt, because nothing retries it later in the run', () => {
    const summary = summarise(
      report({
        index: { items_chunked: 3, chunks_written: 40, chunks_embedded: 0, stopped_early: false },
        compile: {
          compiler_version: '0.1.0+measured-1',
          compiled: [],
          waiting: [{ person: 'nate-b-jones', reason: '3 item(s) still owed' }],
          failed: [],
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
          compiler_version: '0.1.0+measured-1',
          compiled: [],
          waiting: [{ person: 'nate-b-jones', reason: 'nothing has been retrieved yet' }],
          failed: [],
        },
      }),
    );

    assert.equal(summary, 'braintrust: nothing was due.');
  });

  it('reports a compile that failed, rather than a run that did nothing', () => {
    const summary = summarise(
      report({
        compile: {
          compiler_version: '0.1.0+measured-1',
          compiled: [],
          waiting: [],
          failed: [{ person: 'nate-b-jones', reason: 'the database went away' }],
        },
      }),
    );

    // The previous persona is still serving, which is exactly why a failure here would
    // otherwise be invisible.
    assert.match(summary, /1 failed: nate-b-jones/);
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
});

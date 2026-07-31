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

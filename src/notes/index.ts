/**
 * The read-once pass.
 *
 * Every retrieved Item is read exactly once per extractor generation, and what was read
 * is kept. Every subsequent Compile reads those Notes rather than the Corpus, which is
 * what makes a rebuild cost cents instead of dollars — and what makes ADR-0001 survive:
 * the Persona is still wholly rebuilt from evidence and still cannot drift, it just
 * rebuilds from Notes *about* the Corpus rather than from the Corpus.
 *
 * See docs/design/compiler.md §1.
 */

import type { Db } from '../db.js';
import { BraintrustError } from '../errors.js';
import type { Extractor } from './extractor.js';
import { chunkSpans, unreadItems, writeNote } from './store.js';
import { verifyClaims } from './verify.js';

export * from './extractor.js';
export * from './store.js';
export * from './verify.js';

/** Items pulled at a time. Bodies are large and each one costs a model call anyway. */
const READ_PAGE = 10;

export type ReadDeps = {
  db: Db;
  extractor: Extractor;
  stopping?: (() => boolean) | undefined;
  log?: ((line: string) => void) | undefined;
};

export type ReadReport = {
  generation: string;
  items_read: number;
  claims_kept: number;
  /** Claims whose quote was not in the body. The number worth watching. */
  claims_dropped: number;
  items_failed: number;
  stopped_early: boolean;
  error?: string;
};

export async function readCorpus(deps: ReadDeps): Promise<ReadReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const stopping = deps.stopping ?? (() => false);

  const report: ReadReport = {
    generation: deps.extractor.generation,
    items_read: 0,
    claims_kept: 0,
    claims_dropped: 0,
    items_failed: 0,
    stopped_early: false,
  };

  // An Item the extractor refuses is handed back by the same query forever. Remembering
  // what this run has already tried is what makes the loop terminate; the Item stays in
  // the Backlog, so the next run tries it again rather than recording a permanent verdict
  // on the strength of one bad afternoon at somebody's endpoint.
  const attempted = new Set<string>();

  try {
    while (!stopping()) {
      const items = (await unreadItems(deps.db, deps.extractor.generation, READ_PAGE)).filter(
        (item) => !attempted.has(item.id),
      );
      if (items.length === 0) break;

      for (const item of items) {
        if (stopping()) break;
        attempted.add(item.id);
        await readItem(item, deps, report, log);
      }
    }
  } catch (error) {
    // The Notes already written are real, and an endpoint that went away mid-run costs
    // this run's remainder and nothing else.
    report.error = error instanceof BraintrustError ? error.message : String(error);
  }

  if (stopping()) report.stopped_early = true;
  return report;
}

async function readItem(
  item: { id: string; external_id: string; title: string | null; body_text: string },
  deps: ReadDeps,
  report: ReadReport,
  log: (line: string) => void,
): Promise<void> {
  let raw;
  try {
    raw = await deps.extractor.read({
      ...(item.title ? { title: item.title } : {}),
      text: item.body_text,
    });
  } catch (error) {
    report.items_failed += 1;
    log(
      `braintrust: could not read ${item.external_id} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const verified = verifyClaims(raw.claims, item.body_text, await chunkSpans(deps.db, item.id));

  // The Note is written even when every quote failed: the argument and the assumptions
  // are the model's own words about the Item rather than the author's, so they are not
  // the sort of thing quote verification can speak to. Leaving the Item unread instead
  // would mean re-reading it every day at full price for the same answer.
  await writeNote(deps.db, item.id, deps.extractor.generation, {
    claims: verified.claims,
    argument: raw.argument,
    assumptions: raw.assumptions,
  });

  report.items_read += 1;
  report.claims_kept += verified.claims.length;
  report.claims_dropped += verified.dropped;

  if (verified.dropped > 0) {
    log(
      `braintrust: ${verified.dropped} of ${raw.claims.length} claim(s) about ${item.external_id} ` +
        'quoted words that are not in it. Dropped rather than stored — a claim braintrust ' +
        'cannot cite is a claim it does not have.',
    );
  }
}

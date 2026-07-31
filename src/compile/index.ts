/**
 * The compiler: build a Persona under `running`, then promote it in one transaction.
 *
 * This ticket delivers the half of the Core that **no model ever writes** — Voice,
 * counted over raw Item text, and Coverage, counted over Item rows. Both are free at
 * every Compile, and both stay correct while the Note prompt is mid-upgrade, which is
 * why the two layers a client most relies on to sound like someone are the two that cost
 * nothing.
 *
 * **What is deliberately not here.** The publish gate is #33's, and until it lands a
 * Compile carrying two of the four Core layers is promotable. Saying that is better than
 * half-building a check whose whole value is being complete — a gate that passes a
 * two-layer Core today would have to be rewritten to fail it tomorrow, and in the
 * meantime it would read like a guarantee.
 *
 * See docs/design/compiler.md §2 and §5.
 */

import type { TransactionalDb } from '../db.js';
import { VERSION } from '../version.js';
import { coverageLayer } from './coverage.js';
import {
  abandonStale,
  backlogOwed,
  beginCompile,
  compilablePeople,
  failCompile,
  measurableItems,
  measureCoverage,
  promote,
  runningCompile,
  writeLayer,
  type CompilablePerson,
} from './store.js';
import { voiceLayer } from './voice.js';

/**
 * Bumped when the measured layers change shape or the voice patterns change — the
 * hypothesis is part of the compiler, so a Persona should say which version of it
 * produced the numbers. `compiler_version` is on the Compile row and travels out through
 * both read tools.
 */
export const MEASUREMENT_VERSION = 'measured-1';
export const COMPILER_VERSION = `${VERSION}+${MEASUREMENT_VERSION}`;

/**
 * How long a `running` Compile may sit before a later run treats its process as gone.
 * Longer than any plausible Compile, shorter than the daily clock — so the recovery is
 * simply tomorrow's run, and a crash costs a day rather than a Persona.
 */
export const STALE_COMPILE_MS = 6 * 60 * 60 * 1000;

export type CompileDeps = {
  db: TransactionalDb;
  /** Which Note generation this Compile declares it read. On the row, never inferred later. */
  extractor: string;
  /** Slugs whose Corpus changed on this run. New content triggers a rebuild; the clock does not. */
  changed?: string[] | undefined;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
};

export type CompileReport = {
  compiler_version: string;
  /** Personas rebuilt and promoted on this run. */
  compiled: string[];
  /** Reached and left alone, with the reason. Not an error — usually just nothing to do. */
  waiting: { person: string; reason: string }[];
  /** Started and could not finish. The previous Persona is untouched and still serving. */
  failed: { person: string; reason: string }[];
};

export async function compileCorpus(deps: CompileDeps): Promise<CompileReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const changed = new Set(deps.changed ?? []);
  const report: CompileReport = {
    compiler_version: COMPILER_VERSION,
    compiled: [],
    waiting: [],
    failed: [],
  };

  for (const person of await compilablePeople(deps.db)) {
    // New content triggers the rebuild, not the clock — with one addition the clock does
    // not cover: a Person who has never been compiled has work waiting whether or not
    // today brought news, and would otherwise stay `compiled: false` forever.
    if (!changed.has(person.slug) && person.compiled_at !== null) continue;

    const outcome = await compilePerson({ ...deps, log }, person);
    if (outcome.kind === 'compiled') {
      report.compiled.push(person.slug);
      log(
        `braintrust: rebuilt ${person.slug} from ${outcome.items_measured} item` +
          `${outcome.items_measured === 1 ? '' : 's'} as ${COMPILER_VERSION}.`,
      );
    } else if (outcome.kind === 'waiting') {
      report.waiting.push({ person: person.slug, reason: outcome.reason });
    } else {
      report.failed.push({ person: person.slug, reason: outcome.reason });
      log(`braintrust: ${person.slug} could not be rebuilt — ${outcome.reason}`);
    }
  }

  return report;
}

type Outcome =
  | { kind: 'compiled'; compile_id: string; items_measured: number }
  | { kind: 'waiting'; reason: string }
  | { kind: 'failed'; reason: string };

export async function compilePerson(deps: CompileDeps, person: CompilablePerson): Promise<Outcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));

  const abandoned = await abandonStale(deps.db, person.id, new Date(now().getTime() - STALE_COMPILE_MS));
  if (abandoned > 0) {
    log(
      `braintrust: a rebuild of ${person.slug} was still marked running after ` +
        `${STALE_COMPILE_MS / 3_600_000} hours, so its process is gone. Recorded as failed and ` +
        'starting a fresh one.',
    );
  }

  const running = await runningCompile(deps.db, person.id);
  if (running) {
    return {
      kind: 'waiting',
      reason: `a rebuild that started at ${running.started_at} is still running`,
    };
  }

  // A rebuild waits for an empty Backlog, because a Persona built halfway through a
  // backfill is a voice measured over half a corpus — precisely the mistake the first
  // prototype made when it described someone from four items.
  const owed = await backlogOwed(deps.db, person.id, deps.extractor);
  const outstanding = owed.to_retrieve + owed.to_chunk + owed.to_read;
  if (outstanding > 0) {
    return {
      kind: 'waiting',
      reason:
        `${outstanding} item(s) still owed — ${owed.to_retrieve} to retrieve, ${owed.to_chunk} to ` +
        `chunk, ${owed.to_read} to read. The previous persona stays live until the backlog is empty`,
    };
  }

  const items = await measurableItems(deps.db, person.id);
  if (items.length === 0) {
    return { kind: 'waiting', reason: 'nothing has been retrieved for this person yet' };
  }

  const compileId = await beginCompile(deps.db, person.id, COMPILER_VERSION, deps.extractor);

  try {
    const voice = voiceLayer(items);
    const coverage = coverageLayer(await measureCoverage(deps.db, person.id));

    await writeLayer(deps.db, compileId, {
      layer: 'voice',
      basis: 'measured',
      descriptive_md: voice.descriptive_md,
      generative_md: voice.generative_md,
      evidence: voice.evidence,
    });
    await writeLayer(deps.db, compileId, {
      layer: 'coverage',
      basis: 'measured',
      descriptive_md: coverage.descriptive_md,
      evidence: coverage.evidence,
    });

    await promote(deps.db, person.id, compileId, {
      items_retrieved: coverage.evidence.retrieved,
      items_skipped_paywall: coverage.evidence.skipped_paywall,
      items_skipped_short: coverage.evidence.skipped_short,
      items_failed: coverage.evidence.failed,
      words_retrieved: coverage.evidence.words_retrieved,
      ...(coverage.evidence.window ? { window: coverage.evidence.window } : {}),
    });

    return { kind: 'compiled', compile_id: compileId, items_measured: items.length };
  } catch (error) {
    // The rows stay for inspection and the previous Persona is untouched — it was never
    // deleted, because the delete and the promotion are the same transaction.
    const reason = error instanceof Error ? error.message : String(error);
    await failCompile(deps.db, compileId, reason).catch(() => {
      // The database is what just failed. The thrown reason is the one worth having.
    });
    return { kind: 'failed', reason };
  }
}

export * from './coverage.js';
export * from './store.js';
export * from './voice.js';

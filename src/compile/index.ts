/**
 * The compiler: build a Persona under `running`, check it, then promote it in one
 * transaction.
 *
 * Four layers, two of which no model ever writes — Voice, counted over raw Item text, and
 * Coverage, counted over Item rows — and two of which a model does, and which say so in
 * their own first line. The measured pair are free at every Compile and stay correct while
 * the Note prompt is mid-upgrade; the inferred pair read Notes rather than the Corpus,
 * which is what makes a daily rebuild cost cents.
 *
 * Between building and promoting sits [the gate](./gate.ts). A rebuild deletes its
 * predecessor and there is no archive, so the only protection against a bad Compile is
 * refusing to publish it — and refusing costs nothing, because yesterday's Persona is
 * still there and tomorrow's run tries again.
 *
 * See docs/design/compiler.md §2, §3 and §5.
 */

import type { TransactionalDb } from '../db.js';
import { notesFor } from '../notes/store.js';
import { VERSION } from '../version.js';
import { coverageLayer } from './coverage.js';
import { checkCompile } from './gate.js';
import { inferLayer, INFERRED_LAYERS } from './infer.js';
import {
  abandonStale,
  backlogOwed,
  beginCompile,
  compilablePeople,
  failCompile,
  gateFacts,
  measurableItems,
  measureCoverage,
  promote,
  rejectCompile,
  runningCompile,
  writeLayer,
  type CompilablePerson,
} from './store.js';
import { SYNTHESIS_VERSION, type Synthesiser } from './synthesis.js';
import { voiceLayer } from './voice.js';

/**
 * Bumped when the measured layers change shape or the voice patterns change — the
 * hypothesis is part of the compiler, so a Persona should say which version of it
 * produced the numbers. `compiler_version` is on the Compile row and travels out through
 * both read tools, alongside the synthesis prompt version that wrote the other half.
 */
export const MEASUREMENT_VERSION = 'measured-1';
export const COMPILER_VERSION = `${VERSION}+${MEASUREMENT_VERSION}.${SYNTHESIS_VERSION}`;

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
  /** What writes Reasoning and Beliefs. It reads Notes; nothing here re-reads the Corpus. */
  synthesiser: Synthesiser;
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
  /** Finished and did not earn the right to replace its predecessor. Rows kept; nothing published. */
  rejected: { person: string; reason: string }[];
};

export async function compileCorpus(deps: CompileDeps): Promise<CompileReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const changed = new Set(deps.changed ?? []);
  const report: CompileReport = {
    compiler_version: COMPILER_VERSION,
    compiled: [],
    waiting: [],
    failed: [],
    rejected: [],
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
    } else if (outcome.kind === 'rejected') {
      report.rejected.push({ person: person.slug, reason: outcome.reason });
      // A rejection does not stop the schedule, and this line is the only place it
      // surfaces. **Nothing in v1 reads `rejected_reason`** — an accepted cost recorded
      // in compiler.md §5, and the shape of the failure it buys is a compiler that is
      // persistently rejected while a Persona quietly ages.
      log(
        `braintrust: ${person.slug} was rebuilt and not published — ${outcome.reason}. ` +
          'The previous persona is still answering; the next run tries again.',
      );
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
  | { kind: 'rejected'; reason: string }
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

  // The inferred half has nothing to read without Notes. An empty Backlog and no Notes
  // is a real state — every Item failed to be read, or the generation was just bumped —
  // and waiting is the honest outcome: the previous Persona keeps answering, and the
  // next run has Notes to work with.
  const notes = await notesFor(deps.db, person.id, deps.extractor);
  if (notes.length === 0) {
    return {
      kind: 'waiting',
      reason: `no notes exist for this person under ${deps.extractor}, so nothing can be inferred yet`,
    };
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

    // The measured layers first, so a synthesis endpoint that goes away mid-Compile
    // leaves rows that show exactly how far it got. They are the cheap ones anyway.
    for (const kind of INFERRED_LAYERS) {
      const inferred = await inferLayer(kind, notes, deps.synthesiser);
      await writeLayer(deps.db, compileId, {
        layer: kind,
        basis: 'inferred',
        descriptive_md: inferred.descriptive_md,
        evidence: inferred.evidence,
      });
    }

    // The gate, on the rows as a client would be served them rather than on the
    // compiler's own view of what it just built.
    const verdict = checkCompile(await gateFacts(deps.db, person.id, compileId));
    if (!verdict.passed) {
      await rejectCompile(deps.db, compileId, verdict.reason!);
      return { kind: 'rejected', reason: verdict.reason! };
    }

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
export * from './gate.js';
export * from './infer.js';
export * from './store.js';
export * from './synthesis.js';
export * from './voice.js';

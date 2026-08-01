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
import type { Embedder } from '../retrieval/embed.js';
import { VERSION } from '../version.js';
import { coverageLayer, withVoicePopulation } from './coverage.js';
import { checkCompile } from './gate.js';
import { inferLayer, INFERRED_LAYERS } from './infer.js';
import { compilePositions } from './positions.js';
import { compileRevisions } from './revisions.js';
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
  writePositions,
  writeRelations,
  type CompilablePerson,
} from './store.js';
import {
  POSITION_VERSION,
  REVISION_VERSION,
  SYNTHESIS_VERSION,
  type Synthesiser,
} from './synthesis.js';
import { voiceLayer } from './voice.js';

/**
 * Bumped when the measured layers change shape or the voice patterns change — the
 * hypothesis is part of the compiler, so a Persona should say which version of it
 * produced the numbers. `compiler_version` is on the Compile row and travels out through
 * both read tools, alongside the synthesis prompt version that wrote the other half.
 *
 * **`measured-2` is the mixed-Corpus change**: Voice now selects a population by length
 * and names it, and Coverage leads with words and carries `by_form`. The counts are the
 * same counts; *which Items they are counted over* is not, and a Persona has to be able
 * to say which rule measured it. `VOICE_MIN_WORDS` rides here too, so tuning the floor
 * rebuilds every Persona and the change is visible rather than silent.
 */
export const MEASUREMENT_VERSION = 'measured-2';

/**
 * What a Compile that could not compare revisions records instead of `revisions-1`.
 *
 * Revision detection needs an embeddings endpoint to find candidate pairs, and that
 * endpoint is allowed to be absent — the Core is measured from Item text and synthesised
 * from Notes, so a missing embedder delays the vectors rather than the Persona. But a row
 * claiming `revisions-1` when nothing was compared is a Persona asserting it looked for
 * changes of mind and found none, which is a different sentence from *nobody looked*.
 */
export const REVISION_SKIPPED = 'revisions-none';

/**
 * **The version records what this Compile could actually do, not what the code supports.**
 *
 * It is not a constant, because the same code produces a different Persona depending on
 * what it was configured with — and the difference is exactly the thing a later run has to
 * notice, via `CompilablePerson.stale_compiler`.
 */
export function compilerVersion(options: { revisions: boolean }): string {
  const revisions = options.revisions ? REVISION_VERSION : REVISION_SKIPPED;
  return `${VERSION}+${MEASUREMENT_VERSION}.${SYNTHESIS_VERSION}.${POSITION_VERSION}.${revisions}`;
}

/** The fully-capable string. Kept for callers that mean "the current code", not "this run". */
export const COMPILER_VERSION = compilerVersion({ revisions: true });

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
  /**
   * What finds the similarity neighbourhoods revisions are judged inside. Absent means no
   * pair is compared and every Position is returned current — the same posture the read
   * side takes, where a deployment with no embeddings endpoint does not register a search
   * tool. A Persona that says less is honest; one that guesses at supersession is not.
   */
  embedder?: Embedder | undefined;
  /**
   * One Person, by slug. Absent is the daily job: everyone with unseen content. A
   * refresh names one, because it was asked about one.
   */
  person?: string | undefined;
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

  // What this run can do, which is not always what the code can do. Everything below
  // compares against this rather than against the constant.
  const version = compilerVersion({ revisions: deps.embedder !== undefined });

  const report: CompileReport = {
    compiler_version: version,
    compiled: [],
    waiting: [],
    failed: [],
    rejected: [],
  };

  for (const person of await compilablePeople(deps.db, version, deps.person)) {
    // **Two questions, because there are two ways to be stale.**
    //
    // New content triggers a rebuild, not the clock — rebuilding a Persona from a Corpus
    // it has already read costs real money to produce the same answer. But a Persona can
    // also be current with everything its subject published and out of date with what
    // braintrust can now do with it: an embeddings endpoint that was missing and now is
    // not, a measurement that changed shape, a synthesis prompt that was bumped. Nothing
    // in the rows changes in any of those cases, so `has_unseen` never fires and the
    // Persona would keep answering with a compiler that no longer exists.
    if (!person.has_unseen && !person.stale_compiler) continue;

    const outcome = await compilePerson({ ...deps, log }, person);
    if (outcome.kind === 'compiled') {
      report.compiled.push(person.slug);
      log(
        `braintrust: rebuilt ${person.slug} from ${outcome.items_measured} item` +
          `${outcome.items_measured === 1 ? '' : 's'} as ${version}, with ` +
          `${outcome.positions} position${outcome.positions === 1 ? '' : 's'} and ` +
          `${outcome.revisions} relation${outcome.revisions === 1 ? '' : 's'} between them` +
          // Said out loud, because a burst of rebuilds on a day nothing was published
          // is otherwise an unexplained cost. This is the line that explains it.
          `${!person.has_unseen ? ' — rebuilt because the compiler changed, not the corpus' : ''}.`,
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
  | {
      kind: 'compiled';
      compile_id: string;
      items_measured: number;
      positions: number;
      revisions: number;
    }
  | { kind: 'waiting'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed'; reason: string };

export async function compilePerson(deps: CompileDeps, person: CompilablePerson): Promise<Outcome> {
  // Composed here as well as in the loop, so a direct caller records the truth too.
  const version = compilerVersion({ revisions: deps.embedder !== undefined });
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

  const compileId = await beginCompile(deps.db, person.id, version, deps.extractor);

  try {
    const voice = voiceLayer(items);
    // Coverage names the Voice population as a blind spot, so it has to be told what that
    // population was — the only number in Coverage that no query over tier 1 can answer.
    const coverage = coverageLayer(
      withVoicePopulation(await measureCoverage(deps.db, person.id), voice.evidence.measured_over),
    );

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

    // The growing layer, last, because it is the one that scales with the Corpus and the
    // one a Compile can most afford to lose: a synthesis endpoint that gives out here has
    // left four complete Core layers in the rows, and the gate will still refuse to
    // publish the Compile — but the failure is legible rather than a Persona missing a
    // limb for reasons nobody can reconstruct.
    const grouped = await compilePositions(notes, deps.synthesiser);
    const positionIds = await writePositions(deps.db, compileId, grouped.positions);

    if (grouped.dropped_uncitable > 0) {
      log(
        `braintrust: dropped ${grouped.dropped_uncitable} position(s) of ${person.slug} that ` +
          'resolved to no claim braintrust issued. A position it cannot cite is one it does not have.',
      );
    }

    // Revisions last, because they are about the Positions that were just written and
    // because they are the only part of a Compile that can take a view off the record.
    let revisions = 0;
    if (deps.embedder) {
      const found = await compileRevisions(grouped.positions, grouped.claims, {
        embedder: deps.embedder,
        synthesiser: deps.synthesiser,
      });

      const written = await writeRelations(deps.db, compileId, found.revisions, positionIds);
      revisions = written.written;

      if (found.dropped_unknown > 0 || written.dropped > 0) {
        log(
          `braintrust: dropped ${found.dropped_unknown + written.dropped} judgement(s) of ` +
            `${person.slug} that named a pair or a position braintrust never issued.`,
        );
      }

      if (found.bounded_out > 0) {
        log(
          `braintrust: ${found.candidates} pair(s) of ${person.slug} were judged and ` +
            `${found.bounded_out} more above the floor were not reached. The nearest are judged ` +
            'first; the rest wait for a compile with fewer of them.',
        );
      }

      // Distinct positions rather than relations: one position superseded by three later
      // ones is one view off the record, and counting rows would read as three.
      const superseded = new Set(
        found.revisions.filter((one) => one.relation === 'revised').map((one) => one.from),
      ).size;

      if (superseded > 0) {
        log(
          `braintrust: ${superseded} position(s) of ${person.slug} were superseded and are kept, ` +
            'flagged, alongside what replaced them.',
        );
      }
    } else {
      // Said out loud, because the silent version of this is a Persona that looks like it
      // found no revisions when it never looked for any.
      log(
        `braintrust: no embeddings endpoint is configured, so no positions of ${person.slug} were ` +
          'compared for revisions. Every position is returned as current.',
      );
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
      items_skipped_window: coverage.evidence.skipped_window,
      items_skipped_not_a_post: coverage.evidence.skipped_not_a_post,
      items_failed: coverage.evidence.failed,
      words_retrieved: coverage.evidence.words_retrieved,
      ...(coverage.evidence.window ? { window: coverage.evidence.window } : {}),
    });

    return {
      kind: 'compiled',
      compile_id: compileId,
      items_measured: items.length,
      positions: grouped.positions.length,
      revisions,
    };
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
export * from './positions.js';
export * from './revisions.js';
export * from './store.js';
export * from './synthesis.js';
export * from './voice.js';

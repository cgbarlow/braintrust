/**
 * The compiler: build a Persona under `running`, check it, then promote it in one
 * transaction.
 *
 * Three layers, and **not one of them states a conclusion**. Voice is counted over raw Item
 * text and Coverage over Item rows, so no model is in the path at all; Reasoning is chosen
 * from an authored menu, so the words a reader gets were written in this repository. What
 * someone broadly holds left the Core with the Beliefs layer: it is a
 * [through-line](./throughlines.ts) now, and a persona has to retrieve it beside something
 * quotable rather than recite it from a standing brief.
 *
 * The measured pair are free at every Compile and stay correct while the Note prompt is
 * mid-upgrade; everything a model touches reads Notes rather than the Corpus, which is what
 * makes a daily rebuild cost cents.
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
import { vectorLiteral, type Embedder } from '../retrieval/embed.js';
import { checkStatementSupport } from '../verify/support.js';
import { coverageLayer, withVoicePopulation } from './coverage.js';
import { calibrateFit, notGradeable } from './fit.js';
import { checkCompile } from './gate.js';
import { compileHabits } from './infer.js';
import { compilePositions, deserializePositionSet, serializePositionSet, type PositionSet } from './positions.js';
import { compileThroughLines } from './throughlines.js';
import { compileRevisions } from './revisions.js';
import { calibrateSelectivity, notMeasurable } from './selectivity.js';
import {
  abandonStale,
  backlogOwed,
  beginCompile,
  clearResumeMarker,
  compilablePeople,
  failCompile,
  gateFacts,
  measurableItems,
  measureCoverage,
  positionIdsFor,
  promote,
  rejectCompile,
  reopenCompile,
  resumeMarkerFor,
  runningCompile,
  writeLayer,
  writePositions,
  writeRelations,
  writeResumeMarker,
  writeStatementVectors,
  writeThroughLines,
  type CompilablePerson,
  type CompileStage,
} from './store.js';
import type { Synthesiser } from './synthesis.js';
import { compilerVersion } from './version.js';
import { voiceLayer } from './voice.js';

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
  /** What chooses habits and infers through-lines. It reads Notes, never the Corpus. */
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
          `${!person.has_unseen ? ' — rebuilt because the compiler changed, not the corpus' : ''}` +
          // The other unexplained cost this run could be mistaken for: a rebuild that
          // looks routine but is actually cheaper than it reads, because an earlier
          // attempt already paid for part of it.
          `${outcome.resumed_from ? ` — resumed after an earlier attempt reached ${outcome.resumed_from}, so ${skippedStages(outcome.resumed_from)} were not repeated` : ''}.`,
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
      /** Set when a prior attempt's stages were reused rather than repeated. See below. */
      resumed_from?: CompileStage;
    }
  | { kind: 'waiting'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed'; reason: string };

/** The stages a resume at `stage` did not have to repeat, for the one line that says so. */
function skippedStages(stage: CompileStage): string {
  const names: Record<CompileStage, string> = {
    habits: 'habits',
    positions: 'habits and positions',
    through_lines: 'habits, positions and through-lines',
  };
  return names[stage];
}

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

  // A marker from an earlier attempt at this Person, under this compiler version. Reopens
  // that attempt's compile row rather than starting another: its habits/positions/
  // through-lines rows are already committed, and beginning a fresh row here would leave
  // them orphaned under a compile_id nothing ever promotes or resumes into again.
  const marker = await resumeMarkerFor(deps.db, person.id, version);
  const reopened = marker && (await reopenCompile(deps.db, marker.compile_id, person.id));
  if (marker && !reopened) await clearResumeMarker(deps.db, person.id);

  const compileId = reopened || (await beginCompile(deps.db, person.id, version, deps.extractor));
  const resumedFrom = reopened ? marker!.stage : undefined;

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

    // Reasoning: chosen from the menu rather than written. Same evidence rule, same place
    // in the order — what changed is that the words a reader gets are authored in the repo.
    //
    // Skipped on a resume that reached any stage: every stage implies habits already ran,
    // and its layer row is already committed under the compile_id just reopened. Nothing
    // downstream reads the `habits` value itself — only the row, which this attempt never
    // touches — so there is nothing to reconstruct here, unlike positions below.
    if (!resumedFrom) {
      const habits = await compileHabits(notes, deps.synthesiser);
      await writeLayer(deps.db, compileId, {
        layer: 'reasoning',
        basis: 'inferred',
        descriptive_md: habits.descriptive_md,
        evidence: habits.evidence,
      });
      await writeResumeMarker(deps.db, person.id, compileId, version, 'habits', null);
    }

    // The growing layer, next, because it is the one that scales with the Corpus and the
    // one a Compile can most afford to lose: a synthesis endpoint that gives out here has
    // left three complete Core layers in the rows, and the gate will still refuse to
    // publish the Compile — but the failure is legible rather than a Persona missing a
    // limb for reasons nobody can reconstruct.
    //
    // Skipped on a resume that already reached 'positions' or 'through_lines' — the rows
    // `writePositions` and `writeStatementVectors` wrote are already committed, and a
    // second pass would insert them a second time. `grouped` is reconstructed from the
    // marker's payload instead of the rows, because Revisions below needs a claim's
    // paraphrase and a citation only ever carries its verbatim quote — see
    // `serializePositionSet`.
    let grouped: PositionSet;
    let positionIds: Map<string, string>;
    if (!resumedFrom || resumedFrom === 'habits') {
      grouped = await compilePositions(notes, deps.synthesiser);
      positionIds = await writePositions(deps.db, compileId, grouped.positions);

      // The statements, embedded — what `fit` grades on, and the reason two Positions drawn
      // from one Item can be told apart at all. Before the gate, because the check that no two
      // Positions in one answer carry the same score reads these rows.
      //
      // A statement the endpoint would not embed is a statement with no vector, and the gate
      // refuses to publish a Compile where some Positions are graded and others are not — so
      // this either writes all of them or the Persona is not published, and yesterday's keeps
      // answering. Silently grading half an answer is the one outcome not on the table.
      if (deps.embedder) {
        const statements = grouped.positions.map((position) => position.statement);
        const vectors = await deps.embedder.embed(statements);

        await writeStatementVectors(
          deps.db,
          deps.embedder.model,
          grouped.positions.flatMap((position, index) => {
            const vector = vectors[index];
            const id = positionIds.get(position.slug);
            return vector && id ? [{ positionId: id, vector: vectorLiteral(vector) }] : [];
          }),
        );
      }

      await writeResumeMarker(
        deps.db,
        person.id,
        compileId,
        version,
        'positions',
        serializePositionSet(grouped),
      );
    } else {
      grouped = deserializePositionSet(marker!.payload as ReturnType<typeof serializePositionSet>);
      positionIds = await positionIdsFor(deps.db, compileId);
    }

    if (grouped.dropped_uncitable > 0) {
      log(
        `braintrust: dropped ${grouped.dropped_uncitable} position(s) of ${person.slug} that ` +
          'resolved to no claim braintrust issued. A position it cannot cite is one it does not have.',
      );
    }

    // Map #300 §6: a Position's statement, checked against its own citations. Keyed by
    // content rather than by the row `writePositions` just inserted, so a Position that
    // recurs unchanged in tomorrow's rebuild is recognised as already judged — this is
    // what keeps the cost proportional to new material rather than to every Compile.
    //
    // Wrapped, like calibration below: nothing here may cost a Persona its rebuild, and a
    // failure here reports nothing rather than opening a fault it cannot stand behind.
    try {
      const support = await checkStatementSupport(deps.db, person.slug, grouped.positions, deps.synthesiser, {
        log,
      });
      if (support.checked > 0) {
        log(
          `braintrust: checked ${support.checked} newly written position(s) of ${person.slug} against ` +
            `their own citations (${support.already_checked} already judged, unchanged).`,
        );
      }
    } catch (error) {
      log(
        `braintrust: could not check statement support for ${person.slug} — ${String(error)}. Its ` +
          'positions are unaffected; an unjudged Position is asked about again on the next compile.',
      );
    }

    // What this person broadly holds — the four best, for everyone. Beside the quoted claims
    // rather than above them: a through-line rides with an answer that already matched, so it
    // needs no embedding, no citations and no place in the gate — and it may never be the
    // whole of an answer, which is the only reason it is allowed to be spoken flatly.
    //
    // Skipped on a resume that already reached 'through_lines'. Nothing downstream reads
    // its output — only the rows, already committed — so there is nothing to reconstruct.
    if (resumedFrom !== 'through_lines') {
      const inferred = await compileThroughLines(notes, deps.synthesiser);
      const throughLines = await writeThroughLines(
        deps.db,
        compileId,
        person.id,
        inferred.through_lines,
        inferred.candidates,
      );

      log(
        inferred.readings === 0
          ? `braintrust: ${person.slug} has too little to divide, so through-lines are ranked on breadth alone.`
          : `braintrust: ${throughLines} through-line(s) of ${person.slug} across ${inferred.readings} readings; ` +
            `${inferred.dropped_single_reading} appeared in only one.`,
      );

      await writeResumeMarker(
        deps.db,
        person.id,
        compileId,
        version,
        'through_lines',
        serializePositionSet(grouped),
      );
    }

    // The growth of a Corpus, visible before it becomes a failure. Positions are rows
    // rather than a prose layer, so this line is the only place an operator can watch a
    // Corpus approach the fold — and the only place a fold that gave up can be seen.
    if (grouped.merged) {
      log(
        `braintrust: grouped the positions of ${person.slug} in ${grouped.passes} passes and ` +
          `${grouped.rounds === 1 ? 'one merge' : `${grouped.rounds} rounds of merging`}.`,
      );
    }

    if (!grouped.converged) {
      log(
        `braintrust: the merge of ${person.slug}'s positions stopped before it ran out of ` +
          'duplicates, so some may still be the same position in different words. The layer is ' +
          'published either way — a cosmetic limit is not a reason to withhold a persona.',
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
      // Every stage a marker could point at has already run — rejected or not, there is
      // nothing left downstream of this compile_id to resume into.
      await clearResumeMarker(deps.db, person.id);
      return { kind: 'rejected', reason: verdict.reason! };
    }

    // Calibrate this Persona's own off-corpus gate, using the Positions just written as
    // the questions the Corpus must be able to answer. After the gate, because there is no
    // point measuring a Compile that will not be published; before promote, because the
    // measurement travels in the same row it describes.
    //
    // Wrapped, and deliberately: nothing about calibration may cost a Persona its rebuild.
    // A Compile that could not be measured still serves — it falls back and says so.
    let calibrated = notMeasurable('No embeddings endpoint is configured.');
    if (deps.embedder) {
      calibrated = await calibrateSelectivity({
        db: deps.db,
        embedder: deps.embedder,
        person: person.slug,
        statements: grouped.positions.map((position) => position.statement),
      }).catch((error: unknown) => {
        log(
          `braintrust: could not calibrate the gate for ${person.slug} — ${String(error)}. The ` +
            'persona is unaffected and falls back to the shipped default.',
        );
        return notMeasurable('The calibration pass failed.');
      });
    }

    log(
      `braintrust: floor for ${person.slug} is ${calibrated.floor} (${calibrated.separation}` +
        `${calibrated.separation === 'separated' ? `, ${calibrated.probes.in} in / ${calibrated.probes.out} out` : ''}).`,
    );

    // And the second measurement, for the second job. The gate decides what reaches this
    // Corpus, on Chunks; this decides how what came back is ordered and graded, on the
    // statements. Two numbers on two scales, because one number asked to carry both is how
    // `fit` came to order answers no better than a coin.
    //
    // Wrapped for the same reason: a Persona whose grade could not be calibrated still
    // serves every Position it holds, ungraded.
    let graded = notGradeable('No embeddings endpoint is configured.');
    if (deps.embedder) {
      graded = await calibrateFit({
        db: deps.db,
        embedder: deps.embedder,
        compileId,
        positionIds: [...positionIds.values()],
        quotes: grouped.positions.flatMap((position) =>
          position.citations.map((citation) => citation.quote),
        ),
      }).catch((error: unknown) => {
        log(
          `braintrust: could not calibrate the fit grade for ${person.slug} — ${String(error)}. ` +
            'Its positions are unaffected and come back ungraded.',
        );
        return notGradeable('The calibration pass failed.');
      });
    }

    log(
      graded.cut === null
        ? `braintrust: ${person.slug} grades nothing — ${graded.separation}. ${graded.note}`
        : `braintrust: fit cut for ${person.slug} is ${graded.cut} in a span of ${graded.span} ` +
          `(${graded.probes.in} quotes / ${graded.probes.out} off-corpus).`,
    );

    await promote(deps.db, person.id, compileId, {
      selectivity: calibrated,
      fit: graded,
      items_retrieved: coverage.evidence.retrieved,
      items_skipped_paywall: coverage.evidence.skipped_paywall,
      items_skipped_short: coverage.evidence.skipped_short,
      items_skipped_window: coverage.evidence.skipped_window,
      items_skipped_not_a_post: coverage.evidence.skipped_not_a_post,
      items_failed: coverage.evidence.failed,
      words_retrieved: coverage.evidence.words_retrieved,
      ...(coverage.evidence.window ? { window: coverage.evidence.window } : {}),
    });
    await clearResumeMarker(deps.db, person.id);

    return {
      kind: 'compiled',
      compile_id: compileId,
      items_measured: items.length,
      positions: grouped.positions.length,
      revisions,
      ...(resumedFrom ? { resumed_from: resumedFrom } : {}),
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
export * from './fit.js';
export * from './gate.js';
export * from './infer.js';
export * from './positions.js';
export * from './revisions.js';
export * from './store.js';
export * from './support.js';
export * from './synthesis.js';
export * from './throughlines.js';
export * from './version.js';
export * from './voice.js';

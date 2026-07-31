/**
 * `braintrust_refresh_persona`: the daily cycle, aimed at one Person, right now.
 *
 * **This module runs no ingest logic of its own.** It resolves a slug, refuses the two
 * cases that should be refused, calls `runCycle` with a scope, and describes what came
 * back. Everything that decides what a poll or a rebuild *is* lives in the cycle, which
 * is the point of "one code path, three triggers" — a refresh that reimplemented the
 * steps would drift from the schedule and nobody would notice until a Persona built by
 * one disagreed with a Persona built by the other.
 *
 * Two refusals, and they are the interesting part:
 *
 * - **A rebuild is already running** — the second return shape the spec names. The
 *   database enforces it (`unique … where status = 'running'`), so the refusal is a fact
 *   rather than a courtesy, and that is what makes an ungated, AI-callable refresh safe.
 * - **The Person is paused.** Refreshing them would resume fetching somebody's work
 *   without the handshake that exists to authorise exactly that, so a refresh is not a
 *   way around it. Re-following is.
 *
 * See docs/design/mcp-surface.md §5 and docs/design/ingestion.md §3.
 */

import { backlogOwed, runningCompile, type Synthesiser } from './compile/index.js';
import type { TransactionalDb } from './db.js';
import { subjectFor } from './disclosure.js';
import { BraintrustError } from './errors.js';
import { runCycle, type CycleReport } from './ingest/cycle.js';
import type { Pause } from './ingest/pace.js';
import type { Fetcher } from './net/fetch.js';
import type { Extractor } from './notes/index.js';
import { personBySlug } from './personas.js';
import type { Embedder } from './retrieval/embed.js';

/**
 * How long a refresh spends fetching before it stops and reports.
 *
 * A refresh is one HTTP request with a client waiting on it, and a first backfill is
 * ~395 fetches at 4s spacing. Something has to give, and it is not going to be the
 * spacing. So the fetch half is time-boxed and the answer says what is left — which
 * costs nothing, because the Backlog is rows: the work this call did is on disk, and
 * the next run (or the next refresh) continues from it rather than starting again.
 *
 * The rebuild is not inside the budget. It only happens when the Backlog is empty, so
 * a call that hits this limit does not reach it anyway.
 */
export const REFRESH_BUDGET_MS = 30_000;

export type RefreshArgs = { person: string };

export type RefreshDeps = {
  db: TransactionalDb;
  fetcher: Fetcher;
  /** Required, unlike in the cycle: a refresh that cannot read or rebuild is not a refresh. */
  extractor: Extractor;
  synthesiser: Synthesiser;
  embedder?: Embedder | undefined;
  now?: (() => Date) | undefined;
  budgetMs?: number | undefined;
  pause?: Pause | undefined;
  log?: ((line: string) => void) | undefined;
};

export type RefreshedSource = {
  platform: string;
  handle: string;
  discovered: number;
  retrieved: number;
  skipped_paywall: number;
  skipped_short: number;
  failed: number;
  backfill_complete: boolean;
  error?: string;
};

export type Refreshed = {
  person: string;
  subject: string;
  polled: RefreshedSource[];
  discovered: number;
  retrieved: number;
  /** Items this Person still owes before a rebuild can honestly happen. */
  still_owed: number;
  rebuilt: boolean;
  compiled_at: string | null;
  compiler_version: string | null;
  /** Why there was no rebuild. Absent when there was one. */
  not_rebuilt?: string;
  took_seconds: number;
  /** True when the fetch budget ran out. The rows written are the progress. */
  stopped_early: boolean;
};

export type RefreshResponse =
  | { refreshed: Refreshed; next: string }
  | { already_running: { person: string; subject: string; started_at: string }; next: string };

export async function refreshPersona(
  { person: slug }: RefreshArgs,
  deps: RefreshDeps,
): Promise<RefreshResponse> {
  const now = deps.now ?? (() => new Date());
  const person = await personBySlug(deps.db, slug);

  if (!person) {
    throw new BraintrustError(
      `braintrust does not follow anyone with the slug "${slug}". braintrust_list_personas ` +
        'has the slugs; braintrust_follow_person is how somebody new is added, and only a ' +
        'human can complete it.',
    );
  }

  // A pause is the user's decision to stop fetching this person's work. Resuming it is
  // the same act as following them, so it goes through the same gate — otherwise the
  // handshake would be a lock with the key left in an ungated tool next to it.
  if (person.paused_at) {
    throw new BraintrustError(
      `${person.display_name} is paused — the user unfollowed them at ${person.paused_at}, and ` +
        'nothing has been fetched for them since. A refresh would start downloading their work ' +
        'again, which is the decision braintrust_follow_person exists to put in front of a ' +
        'human, so refresh will not make it. Their persona is still queryable, frozen at its ' +
        'last compile. To resume, follow them again — the full two-call handshake, with the ' +
        'plan shown to a person.',
    );
  }

  // Asked before the cycle rather than left to the compiler, because the answer is the
  // whole reason this tool has a second return shape: 26 minutes of duplicated work is a
  // worse answer than one sentence saying somebody else is already doing it.
  const running = await runningCompile(deps.db, person.id);
  if (running) {
    return {
      already_running: {
        person: person.slug,
        subject: subjectFor(person.display_name),
        started_at: running.started_at,
      },
      next:
        'Nothing was started. One rebuild per person at a time is enforced by the database, so ' +
        'this call could not have duplicated it even by accident. That rebuild is either the ' +
        'daily job or another client; wait for it to finish and load the persona then.',
    };
  }

  const started = now();
  const deadline = started.getTime() + (deps.budgetMs ?? REFRESH_BUDGET_MS);

  const report = await runCycle({
    db: deps.db,
    fetcher: deps.fetcher,
    extractor: deps.extractor,
    synthesiser: deps.synthesiser,
    embedder: deps.embedder,
    only: { id: person.id, slug: person.slug },
    now,
    ...(deps.pause ? { pause: deps.pause } : {}),
    stopping: () => now().getTime() >= deadline,
    ...(deps.log ? { log: deps.log } : {}),
  });

  const owed = await backlogOwed(deps.db, person.id, deps.extractor.generation);
  const after = await personBySlug(deps.db, person.slug);

  return {
    refreshed: describe(person.slug, person.display_name, report, {
      still_owed: owed.to_retrieve + owed.to_chunk + owed.to_read,
      compiled_at: after?.compiled_at ?? null,
      compiler_version: after?.compiler_version ?? null,
      took_seconds: Math.round((now().getTime() - started.getTime()) / 1000),
    }),
    next: nextStep(report, owed.to_retrieve + owed.to_chunk + owed.to_read),
  };
}

function describe(
  slug: string,
  displayName: string,
  report: CycleReport,
  extra: {
    still_owed: number;
    compiled_at: string | null;
    compiler_version: string | null;
    took_seconds: number;
  },
): Refreshed {
  const rebuilt = report.compile?.compiled.includes(slug) ?? false;

  // Waiting, rejected and failed are three different sentences and one field. The
  // person reading this wants to know why their persona is not newer, and "the backlog
  // is not empty" and "it was built and refused" are not the same news.
  const held =
    report.compile?.waiting.find((one) => one.person === slug) ??
    report.compile?.rejected.find((one) => one.person === slug) ??
    report.compile?.failed.find((one) => one.person === slug);

  const refreshed: Refreshed = {
    person: slug,
    subject: subjectFor(displayName),
    polled: report.sources.map((source) => ({
      platform: source.platform,
      handle: source.handle,
      discovered: source.discovered,
      retrieved: source.retrieved,
      skipped_paywall: source.skipped_paywall,
      skipped_short: source.skipped_short,
      failed: source.failed,
      backfill_complete: source.backfill_complete,
      ...(source.error ? { error: source.error } : {}),
    })),
    discovered: report.sources.reduce((total, source) => total + source.discovered, 0),
    retrieved: report.sources.reduce((total, source) => total + source.retrieved, 0),
    still_owed: extra.still_owed,
    rebuilt,
    compiled_at: extra.compiled_at,
    compiler_version: extra.compiler_version,
    took_seconds: extra.took_seconds,
    stopped_early: report.stopped_early,
  };

  if (!rebuilt) {
    refreshed.not_rebuilt = held
      ? held.reason
      : 'nothing has arrived that this persona has not already read';
  }

  return refreshed;
}

function nextStep(report: CycleReport, owed: number): string {
  if (report.stopped_early || owed > 0) {
    return (
      `${owed} item(s) are still owed, so nothing was rebuilt — a persona measured over half a ` +
      'corpus is the mistake the wait exists to prevent. The rows this call wrote are on disk ' +
      'and nothing repeats work: the daily job continues from here, or call this again to ' +
      'spend another minute on it.'
    );
  }

  if (report.compile?.compiled.length) {
    return 'The persona was rebuilt and is now the one answering. braintrust_load_persona has it.';
  }

  return (
    'Nothing arrived that this persona has not already read, so nothing was rebuilt — new ' +
    'content triggers a rebuild, not the asking. The persona that was answering is current.'
  );
}

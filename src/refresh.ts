/**
 * `braintrust_refresh_persona`: the daily cycle's fetch-and-read, aimed at one Person,
 * right now. Compiles are not started from the web process — they run on the cron
 * deployment — so a refresh fetches what is new, chunks it, and reads notes, then
 * the next daily compile picks up everything it prepared.
 *
 * **This module runs no ingest logic of its own.** It resolves a slug, refuses the
 * case that should be refused (a paused person), calls `runCycle` with a scope, and
 * describes what came back. Everything that decides what a poll or a backlog drain
 * *is* lives in the cycle, which is the point of "one code path, three triggers".
 *
 * Two refusals, and the paused one is the only one that remains here.
 *
 * - **The Person is paused.** Refreshing them would resume fetching somebody's work
 *   without the handshake that exists to authorise exactly that, so a refresh is not a
 *   way around it. Re-following is.
 *
 * See docs/design/mcp-surface.md §5 and docs/design/ingestion.md §3.
 */

import type { TransactionalDb } from './db.js';
import { subjectFor } from './disclosure.js';
import { BraintrustError } from './errors.js';
import { runCycle, type CycleReport } from './ingest/cycle.js';
import { allSourcesForPerson } from './ingest/items.js';
import type { Pause } from './ingest/pace.js';
import type { Fetcher } from './net/fetch.js';
import type { Extractor } from './notes/index.js';
import { personBySlug, type BlockedSource } from './personas.js';
import type { Embedder } from './retrieval/embed.js';

/**
 * How long a refresh spends fetching before it stops and reports.
 *
 * A refresh is one HTTP request with a client waiting on it, and a first backfill is
 * ~395 requests at this Source's spacing. Something has to give, and it is not going to
 * be the spacing. So the fetch half is time-boxed and the answer says what is left — which
 * costs nothing, because the Backlog is rows: the work this call did is on disk, and
 * the next run (or the next refresh) continues from it rather than starting again.
 */
export const REFRESH_BUDGET_MS = 30_000;

export type RefreshArgs = { person: string };

export type RefreshDeps = {
  db: TransactionalDb;
  fetcher: Fetcher;
  /**
   * Required: a refresh that cannot read new Items is not a refresh. The compile itself
   * happens on the daily run, so no synthesiser is needed here.
   */
  extractor: Extractor;
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
  skipped_window: number;
  /** URLs from a blog's sitemap that turned out to be pages rather than posts. */
  skipped_not_a_post: number;
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
  compiled_at: string | null;
  compiler_version: string | null;
  /**
   * Sources that have stopped serving braintrust, and were therefore not polled.
   *
   * Said here because a refresh that quietly skipped half of someone's output would let
   * a caller read "nothing new" as "they have published nothing", when what happened is
   * that a platform stopped answering. It is not the same fact as a paused Person — that
   * one is refused outright, above.
   */
  blocked?: BlockedSource[];
  took_seconds: number;
  /** True when the fetch budget ran out. The rows written are the progress. */
  stopped_early: boolean;
};

export type RefreshResponse = {
  refreshed: Refreshed;
  next: string;
};

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

  const started = now();
  const deadline = started.getTime() + (deps.budgetMs ?? REFRESH_BUDGET_MS);

  const report = await runCycle({
    db: deps.db,
    fetcher: deps.fetcher,
    extractor: deps.extractor,
    embedder: deps.embedder,
    only: { id: person.id, slug: person.slug },
    now,
    ...(deps.pause ? { pause: deps.pause } : {}),
    stopping: () => now().getTime() >= deadline,
    ...(deps.log ? { log: deps.log } : {}),
  });

  const after = await personBySlug(deps.db, person.slug);
  const blocked = (await allSourcesForPerson(deps.db, person.id))
    .filter((source) => source.blocked_at !== null)
    .map((source) => ({
      platform: source.platform,
      handle: source.handle,
      since: source.blocked_at!.toISOString(),
    }));

  return {
    refreshed: describe(person.slug, person.display_name, report, {
      compiled_at: after?.compiled_at ?? null,
      compiler_version: after?.compiler_version ?? null,
      took_seconds: Math.round((now().getTime() - started.getTime()) / 1000),
      blocked,
    }),
    next: nextStep(report),
  };
}

function describe(
  slug: string,
  displayName: string,
  report: CycleReport,
  extra: {
    compiled_at: string | null;
    compiler_version: string | null;
    took_seconds: number;
    blocked: BlockedSource[];
  },
): Refreshed {
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
      skipped_window: source.skipped_window,
      skipped_not_a_post: source.skipped_not_a_post,
      failed: source.failed,
      backfill_complete: source.backfill_complete,
      ...(source.error ? { error: source.error } : {}),
    })),
    discovered: report.sources.reduce((total, source) => total + source.discovered, 0),
    retrieved: report.sources.reduce((total, source) => total + source.retrieved, 0),
    compiled_at: extra.compiled_at,
    compiler_version: extra.compiler_version,
    took_seconds: extra.took_seconds,
    stopped_early: report.stopped_early,
    ...(extra.blocked.length > 0 ? { blocked: extra.blocked } : {}),
  };

  return refreshed;
}

function nextStep(report: CycleReport): string {
  if (report.stopped_early) {
    return (
      'The fetch budget ran out. The rows this call wrote are on disk and nothing repeats ' +
      'work: the daily job continues from here, or call this again to spend another minute ' +
      'on it. Compiles happen on the daily run, so the persona serves what it already has ' +
      'until then.'
    );
  }

  if (report.sources.length > 0 && report.sources.some((s) => s.discovered > 0 || s.retrieved > 0)) {
    return (
      'New content was fetched and read. The next daily compile will rebuild the persona from ' +
      'everything it now holds. In the meantime, the persona that was answering is still live ' +
      'and still current — what changed is what the next one will be compiled from.'
    );
  }

  return (
    'Nothing arrived that this persona has not already read, so nothing to compile from. The ' +
    'persona that was answering is current.'
  );
}

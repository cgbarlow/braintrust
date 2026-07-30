/**
 * The cycle: poll → check for a gap → drain the Backlog → rebuild.
 *
 * **One code path, three triggers.** The daily clock runs it, and later
 * `braintrust_refresh_persona` and the second call of the follow handshake will run the
 * same function. There is no separate initial-load mode: the first run after following
 * someone *is* the backfill.
 *
 * Nothing here is a job with state. Every loop reads what the rows say and does the next
 * thing, so being killed at any point costs the time since the last row and nothing else.
 *
 * See docs/design/ingestion.md §3.
 */

import type { Db } from '../db.js';
import { BraintrustError } from '../errors.js';
import type { Fetcher } from '../net/fetch.js';
import { RETRIEVAL_SPACING_MS, type Audience, type Platform } from '../sources/types.js';
import { feedSkippedAhead, newestPublished, readFeed } from './feed.js';
import {
  activeSources,
  completeBackfill,
  corpusCounts,
  dueSources,
  insertDiscovered,
  markFailed,
  markSkippedPaywall,
  pendingItems,
  recordCatalogued,
  recordPoll,
  storeBody,
  type CorpusCounts,
  type PendingItem,
  type SourceRow,
} from './items.js';
import { fetchPolitely, sleep, type Pause } from './pace.js';
import { PaywallChanged, retrieveSubstackPost, walkArchive } from './substack.js';

/**
 * What discovery can say about a new Item's audience before anything else runs.
 * YouTube is always public; Substack's paywall flag lives in the catalogue, not the
 * feed, so a freshly discovered post is honestly `unknown` until the catalogue speaks.
 */
const DISCOVERED_AUDIENCE: Record<Platform, Audience> = {
  youtube: 'everyone',
  substack: 'unknown',
};

export type CycleDeps = {
  db: Db;
  fetcher: Fetcher;
  now?: (() => Date) | undefined;
  pause?: Pause | undefined;
  /**
   * Checked between fetches. A platform that times out a cron run sends SIGTERM, and
   * stopping cleanly there is free — the rows already written are the progress.
   */
  stopping?: (() => boolean) | undefined;
  log?: ((line: string) => void) | undefined;
};

export type SourceReport = {
  person: string;
  platform: Platform;
  handle: string;
  discovered: number;
  catalogued: number;
  retrieved: number;
  skipped_paywall: number;
  failed: number;
  backfill_complete: boolean;
  gap_detected: boolean;
  /** Set when braintrust cannot do this platform's expensive half yet. */
  awaiting?: string;
  error?: string;
};

export type CycleReport = {
  started: string;
  finished: string;
  sources: SourceReport[];
  not_due: number;
  paused_or_blocked: number;
  /** People whose Corpus changed. A Compile is what they are waiting for. */
  rebuild_pending: string[];
  stopped_early: boolean;
  corpus: CorpusCounts;
};

/** YouTube's expensive half — captions at 4s spacing — is issue #29. */
const YOUTUBE_RETRIEVAL_PENDING =
  'YouTube bodies are not implemented yet (#29); items are discovered and left pending';

export async function runCycle(deps: CycleDeps): Promise<CycleReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const stopping = deps.stopping ?? (() => false);
  const started = now();

  const due = await dueSources(deps.db, started);
  const active = await activeSources(deps.db);
  const all = await allSourceCount(deps.db);

  log(
    `braintrust: ${due.length} of ${all} source${all === 1 ? '' : 's'} due` +
      `${all - active.length > 0 ? `, ${all - active.length} paused or blocked` : ''}`,
  );

  const reports: SourceReport[] = [];
  const changed = new Set<string>();
  let stoppedEarly = false;

  for (const source of due) {
    if (stopping()) {
      stoppedEarly = true;
      log('braintrust: asked to stop; the rows written so far are the progress.');
      break;
    }

    const report = await runSource(source, { ...deps, now, log, stopping });
    reports.push(report);
    if (report.discovered + report.retrieved + report.skipped_paywall > 0) changed.add(source.person);
    if (report.error) log(`braintrust: ${source.platform} ${source.handle} — ${report.error}`);
  }

  const report: CycleReport = {
    started: started.toISOString(),
    finished: now().toISOString(),
    sources: reports,
    not_due: active.length - due.length,
    paused_or_blocked: all - active.length,
    rebuild_pending: [...changed].sort(),
    stopped_early: stoppedEarly,
    corpus: await corpusCounts(deps.db),
  };

  // The rebuild is the fourth step of the cycle and it does not exist yet. Saying so is
  // better than a no-op that reads like success: new content triggers a rebuild, so
  // these people have work waiting rather than nothing to do.
  if (report.rebuild_pending.length > 0) {
    log(
      `braintrust: ${report.rebuild_pending.join(', ')} ha${report.rebuild_pending.length === 1 ? 's' : 've'} ` +
        'new content. The compile step is #32–#33; nothing is rebuilt yet.',
    );
  }

  return report;
}

type SourceDeps = CycleDeps & {
  now: () => Date;
  log: (line: string) => void;
  stopping: () => boolean;
};

async function runSource(source: SourceRow, deps: SourceDeps): Promise<SourceReport> {
  const report: SourceReport = {
    person: source.person,
    platform: source.platform,
    handle: source.handle,
    discovered: 0,
    catalogued: 0,
    retrieved: 0,
    skipped_paywall: 0,
    failed: 0,
    backfill_complete: source.backfill_complete,
    gap_detected: false,
  };

  try {
    // 1. Poll. One feed fetch, generic across platforms.
    const feed = readFeed(
      await fetchPolitely(deps.fetcher, source.discovery_url, `the feed for ${source.handle}`, {
        ...(deps.pause ? { pause: deps.pause } : {}),
      }),
      source.platform,
    );

    const discovered = await insertDiscovered(
      deps.db,
      source,
      feed.entries,
      DISCOVERED_AUDIENCE[source.platform],
    );
    report.discovered = discovered.length;

    // 2. Check for a gap. One comparison, and the repair is the backfill it already has.
    report.gap_detected = feedSkippedAhead(feed.entries, source.cursor_published_at);
    await recordPoll(deps.db, source, {
      cursor: newestPublished(feed.entries),
      reopenBackfill: report.gap_detected,
      now: deps.now(),
    });
    if (report.gap_detected) {
      report.backfill_complete = false;
      deps.log(
        `braintrust: ${source.handle} published something braintrust never saw — reopening the backfill.`,
      );
    }

    // 3. Drain the Backlog: the catalogue first, so every body fetch knows its audience.
    if (source.platform === 'substack') {
      await catalogue({ ...source, backfill_complete: report.backfill_complete }, deps, report);
      await retrieveBodies(source, deps, report);
    } else {
      report.awaiting = YOUTUBE_RETRIEVAL_PENDING;
    }
  } catch (error) {
    // One source's bad day is not another's. The two platforms share nothing but a
    // Person and they fail in opposite directions, so stopping the run would be a
    // failure braintrust invented rather than one a source imposed.
    report.error = error instanceof BraintrustError ? error.message : String(error);
  }

  return report;
}

/**
 * The catalogue pass. Two shapes of the same walk:
 *
 * - **Backfill** — the Source is not `backfill_complete`, so walk to the floor and take
 *   everything. Reaching the floor is what sets the flag.
 * - **Audience** — the Source is complete, but the feed just found posts whose paywall
 *   status is unknown. Walk only as far as it takes to describe them.
 */
async function catalogue(source: SourceRow, deps: SourceDeps, report: SourceReport): Promise<void> {
  const walkDeps = { fetcher: deps.fetcher, ...(deps.pause ? { pause: deps.pause } : {}) };

  const record = async (item: Parameters<typeof recordCatalogued>[2]): Promise<void> => {
    const outcome = await recordCatalogued(deps.db, source, item);
    report.catalogued += 1;
    if (outcome === 'skipped_paywall') report.skipped_paywall += 1;
  };

  if (!source.backfill_complete) {
    const outcome = await walkArchive(source, walkDeps, record);
    if (outcome.reachedFloor) {
      await completeBackfill(deps.db, source);
      report.backfill_complete = true;
      deps.log(
        `braintrust: ${source.handle} backfilled to ${source.backfill_floor} ` +
          `(${outcome.seen} catalogued across ${outcome.pages} page${outcome.pages === 1 ? '' : 's'}).`,
      );
    }
    return;
  }

  const unknown = (await pendingItems(deps.db, source.id)).filter((item) => item.audience === 'unknown');
  if (unknown.length === 0) return;

  const wanted = new Set(unknown.map((item) => item.external_id));
  await walkArchive(
    source,
    walkDeps,
    async (item) => {
      if (!wanted.has(item.externalId)) return;
      wanted.delete(item.externalId);
      await record(item);
    },
    () => wanted.size === 0,
  );

  // A post in the feed but not in the catalogue: braintrust cannot learn whether it is
  // paid, and the allow-list means unknown is never fetched. `failed` is the honest
  // resting place — a terminal recorded outcome that Coverage reports and the Backlog
  // excludes, rather than a pending row that blocks every future Compile.
  for (const externalId of wanted) {
    const item = unknown.find((candidate) => candidate.external_id === externalId)!;
    await markFailed(deps.db, item.id);
    report.failed += 1;
    deps.log(
      `braintrust: ${externalId} is in ${source.handle}'s feed but not its archive, so its ` +
        'audience is unknowable. Recorded as failed rather than fetched.',
    );
  }
}

/** The expensive half, at 4s spacing, newest first. */
async function retrieveBodies(source: SourceRow, deps: SourceDeps, report: SourceReport): Promise<void> {
  const pause = deps.pause ?? sleep;
  const pending = await pendingItems(deps.db, source.id);

  let fetched = 0;
  for (const item of pending) {
    if (deps.stopping()) return;

    // The allow-list, one last time before any request is made. `everyone` or nothing.
    if (item.audience !== 'everyone') {
      await markSkippedPaywall(deps.db, item.id);
      report.skipped_paywall += 1;
      continue;
    }

    if (fetched > 0) await pause(RETRIEVAL_SPACING_MS);
    fetched += 1;

    try {
      const body = await retrieveSubstackPost(source, item.external_id, deps);
      await storeBody(deps.db, item.id, body);
      report.retrieved += 1;
    } catch (error) {
      if (error instanceof PaywallChanged) {
        await markSkippedPaywall(deps.db, item.id);
        report.skipped_paywall += 1;
        deps.log(`braintrust: ${item.external_id} — ${error.message}`);
        continue;
      }
      await markFailed(deps.db, item.id);
      report.failed += 1;
      deps.log(
        `braintrust: ${item.external_id} failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function allSourceCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ count: string }>('select count(*)::text as count from braintrust_sources');
  return Number(rows[0]!.count);
}

/** One line per source, for a job nobody is watching. */
export function summarise(report: CycleReport): string {
  if (report.sources.length === 0) return 'braintrust: nothing was due.';

  const lines = report.sources.map((source) => {
    const parts = [
      `+${source.discovered} discovered`,
      `${source.retrieved} retrieved`,
      `${source.skipped_paywall} skipped (paywall)`,
    ];
    if (source.failed > 0) parts.push(`${source.failed} failed`);
    if (!source.backfill_complete) parts.push('backfill incomplete');
    if (source.awaiting) parts.push(source.awaiting);
    if (source.error) parts.push(`error: ${source.error}`);
    return `  ${source.person} / ${source.platform} ${source.handle}: ${parts.join(', ')}`;
  });

  const { pending, retrieved, skipped_paywall, failed } = report.corpus;
  lines.push(
    `  corpus: ${retrieved} retrieved, ${skipped_paywall} skipped, ${pending} pending, ${failed} failed`,
  );
  if (report.stopped_early) lines.push('  stopped early; the next run continues from these rows');

  return lines.join('\n');
}

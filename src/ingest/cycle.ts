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

import { compileCorpus, type CompileReport } from '../compile/index.js';
import type { Db, TransactionalDb } from '../db.js';
import { BraintrustError } from '../errors.js';
import type { Fetcher } from '../net/fetch.js';
import { readCorpus, type Extractor, type ReadReport } from '../notes/index.js';
import { indexCorpus, type Embedder, type IndexReport } from '../retrieval/index.js';
import {
  RETRIEVAL_SPACING_MS,
  SHORT_MAX_SECONDS,
  type Audience,
  type Platform,
} from '../sources/types.js';
import { feedSkippedAhead, newestPublished, readFeed } from './feed.js';
import {
  activeSources,
  completeBackfill,
  corpusCounts,
  dueSources,
  insertDiscovered,
  markFailed,
  markSkippedPaywall,
  markSkippedShort,
  pendingItems,
  recordCatalogued,
  recordPoll,
  recordPublished,
  reopenShorts,
  storeBody,
  type CorpusCounts,
  type PendingItem,
  type SourceRow,
} from './items.js';
import { fetchPolitely, sleep, type Pause } from './pace.js';
import { PaywallChanged, retrieveSubstackPost, walkArchive } from './substack.js';
import { NoCaptions, retrieveYoutubeCaptions, videoMetadata, walkChannel } from './youtube.js';

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
  db: TransactionalDb;
  fetcher: Fetcher;
  /**
   * The configured embeddings endpoint. Absent chunks the new Items and leaves them
   * unembedded — which is a real state the next run finishes, not a failure.
   */
  embedder?: Embedder | undefined;
  /**
   * The configured Note extractor. Absent leaves the Items unread — the expensive step
   * is the one most worth being able to defer.
   */
  extractor?: Extractor | undefined;
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
  skipped_short: number;
  failed: number;
  backfill_complete: boolean;
  gap_detected: boolean;
  /** Items whose date the feed never carried and a per-item fetch supplied. */
  dated: number;
  /** Set when an operator turned `exclude_shorts` off and past skips came back. */
  reopened_shorts?: number;
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
  /** The retrieval index, brought up to date with what this run fetched. */
  index: IndexReport;
  /** The read-once pass. Absent when no extractor was configured for the run. */
  notes?: ReadReport;
  /** The rebuild. Absent when no extractor was configured, because a Compile declares a generation. */
  compile?: CompileReport;
};

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
    if (report.discovered + report.retrieved + report.skipped_paywall + report.skipped_short > 0) {
      changed.add(source.person);
    }
    if (report.error) log(`braintrust: ${source.platform} ${source.handle} — ${report.error}`);
  }

  // 4. Index what was fetched. Corpus-wide and outside the per-source loop, because a
  // Chunk belongs to an Item and neither chunking nor embedding cares which platform
  // the words came from. A run asked to stop does none of it and says so: an Item with
  // a body and no Chunks is already the Backlog, so the next run picks it up unprompted.
  const index = await indexCorpus({
    db: deps.db,
    embedder: deps.embedder,
    stopping,
    log,
  });
  if (index.items_chunked > 0) {
    log(
      `braintrust: indexed ${index.items_chunked} item${index.items_chunked === 1 ? '' : 's'} ` +
        `into ${index.chunks_written} chunk${index.chunks_written === 1 ? '' : 's'}` +
        `${index.model ? `, ${index.chunks_embedded} embedded as ${index.model}` : ''}.`,
    );
  }
  if (index.error) log(`braintrust: the index is behind — ${index.error}`);

  // 5. Read what has not been read. After the index, because a claim carries the Chunk
  // its quote came from, so an Item is not readable until it has been chunked.
  const notes = deps.extractor
    ? await readCorpus({ db: deps.db, extractor: deps.extractor, stopping, log })
    : undefined;
  if (notes && notes.items_read > 0) {
    log(
      `braintrust: read ${notes.items_read} item${notes.items_read === 1 ? '' : 's'} as ` +
        `${notes.generation}, keeping ${notes.claims_kept} claim${notes.claims_kept === 1 ? '' : 's'}` +
        `${notes.claims_dropped > 0 ? ` and dropping ${notes.claims_dropped} that could not be quoted` : ''}.`,
    );
  }
  if (notes?.error) log(`braintrust: the notes are behind — ${notes.error}`);

  // 6. Rebuild. A Compile declares which generation of Notes it read, so without an
  // extractor there is no honest value to put on the row and nothing is rebuilt.
  const compile = deps.extractor
    ? await compileCorpus({
        db: deps.db,
        extractor: deps.extractor.generation,
        changed: [...changed],
        now,
        log,
      })
    : undefined;

  const report: CycleReport = {
    started: started.toISOString(),
    finished: now().toISOString(),
    sources: reports,
    not_due: active.length - due.length,
    paused_or_blocked: all - active.length,
    rebuild_pending: [...changed].sort(),
    stopped_early: stoppedEarly,
    corpus: await corpusCounts(deps.db),
    index,
    ...(notes ? { notes } : {}),
    ...(compile ? { compile } : {}),
  };

  // A Person whose Corpus changed and who was not rebuilt has a reason, and it is worth
  // a line: nothing here retries later in the run, so the reason is what the next run
  // acts on.
  for (const waiting of compile?.waiting ?? []) {
    log(`braintrust: ${waiting.person} was not rebuilt — ${waiting.reason}.`);
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
    skipped_short: 0,
    failed: 0,
    backfill_complete: source.backfill_complete,
    gap_detected: false,
    dated: 0,
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

    // An operator who turned the Shorts rule off is owed the videos braintrust
    // declined to read, and the rows are already there — so this is an update, not a
    // crawl. Before the Backlog is read, so those Items are in it on this run.
    if (!source.exclude_shorts) {
      const reopened = await reopenShorts(deps.db, source.id);
      if (reopened > 0) {
        report.reopened_shorts = reopened;
        deps.log(
          `braintrust: exclude_shorts is off for ${source.handle}, so ${reopened} short ` +
            'item(s) braintrust skipped are pending again.',
        );
      }
    }

    // 3. Drain the Backlog: the catalogue first, so every body fetch knows its audience.
    await catalogue({ ...source, backfill_complete: report.backfill_complete }, deps, report);
    await retrieveBodies(source, deps, report);
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
 *   status is unknown. Walk only as far as it takes to describe them. Substack only:
 *   a YouTube video's audience is never in question.
 *
 * The two platforms' walks return the same shape and write through the same `record`,
 * which is why the Shorts rule and the paywall rule are applied in one place for both.
 */
async function catalogue(source: SourceRow, deps: SourceDeps, report: SourceReport): Promise<void> {
  const walkDeps = { fetcher: deps.fetcher, ...(deps.pause ? { pause: deps.pause } : {}) };

  const record = async (item: Parameters<typeof recordCatalogued>[2]): Promise<void> => {
    const outcome = await recordCatalogued(deps.db, source, item);
    report.catalogued += 1;
    if (outcome === 'skipped_paywall') report.skipped_paywall += 1;
    if (outcome === 'skipped_short') report.skipped_short += 1;
  };

  if (!source.backfill_complete) {
    const outcome =
      source.platform === 'substack'
        ? await walkArchive(source, walkDeps, record)
        : await walkChannel(source, { ...walkDeps, now: deps.now }, record);
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

  if (source.platform !== 'substack') return;

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

/**
 * The expensive half, at 4s spacing, newest first.
 *
 * **The 4 seconds are between Items, not between requests.** One YouTube Item costs two
 * or three back-to-back calls — the date, the caption list, the track — and the spacing
 * that tested clean was measured per *video*, with yt-dlp making exactly those calls
 * inside each one. Spacing the requests instead would turn the 26-minute backfill in
 * `ingestion.md` §3 into 79 minutes without making braintrust any better behaved: the
 * average is still well under one request a second.
 */
async function retrieveBodies(source: SourceRow, deps: SourceDeps, report: SourceReport): Promise<void> {
  const pause = deps.pause ?? sleep;
  const pending = await pendingItems(deps.db, source.id);

  let fetched = 0;
  for (const item of pending) {
    if (deps.stopping()) return;

    // The allow-list, one last time before any request is made. `everyone` or nothing.
    //
    // The two ways of not being `everyone` are not the same fact, and recording them as
    // one would make a Persona claim a paywall it never saw. `paid` is a source's
    // decision braintrust is respecting; `unknown` means the catalogue never described
    // this Item — which happens when `backfill_floor` is nearer than the feed's window,
    // so a post appears in the feed and is older than anything the archive walk reads.
    // That is the same unknowable-audience case `catalogue` already resolves as failed.
    if (item.audience === 'paid') {
      await markSkippedPaywall(deps.db, item.id);
      report.skipped_paywall += 1;
      continue;
    }
    if (item.audience !== 'everyone') {
      await markFailed(deps.db, item.id);
      report.failed += 1;
      deps.log(
        `braintrust: ${item.external_id} is in ${source.handle}'s feed but older than its ` +
          'backfill floor, so its audience is unknowable. Recorded as failed rather than ' +
          'as a paywall braintrust never saw.',
      );
      continue;
    }

    if (fetched > 0) await pause(RETRIEVAL_SPACING_MS);
    fetched += 1;

    try {
      if (source.platform === 'substack') {
        await retrieveSubstackItem(source, item, deps, report);
      } else {
        await retrieveYoutubeItem(source, item, deps, report);
      }
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

async function retrieveSubstackItem(
  source: SourceRow,
  item: PendingItem,
  deps: SourceDeps,
  report: SourceReport,
): Promise<void> {
  const body = await retrieveSubstackPost(source, item.external_id, deps);
  await storeBody(deps.db, item.id, body);
  report.retrieved += 1;
}

/**
 * One video, in the order that spends the least.
 *
 * The date first, because an Item the channel walk found has none and ~15KB buys both
 * the date and the duration — so a Short is recognised before the ~500KB of caption
 * list and track is ever requested. An Item the feed already dated skips straight to
 * the captions, and learns its duration from the same response.
 */
async function retrieveYoutubeItem(
  source: SourceRow,
  item: PendingItem,
  deps: SourceDeps,
  report: SourceReport,
): Promise<void> {
  let duration: number | undefined;

  if (!item.published_at) {
    const metadata = await videoMetadata(item.external_id, deps);
    duration = metadata.durationSeconds;
    if (metadata.publishedAt) {
      await recordPublished(deps.db, item.id, metadata.publishedAt);
      report.dated += 1;
    }
  }

  if (source.exclude_shorts && duration !== undefined && duration < SHORT_MAX_SECONDS) {
    await skipShort(item, duration, deps, report);
    return;
  }

  const captions = await retrieveYoutubeCaptions(item.external_id, deps, {
    excludeShorts: source.exclude_shorts,
  });
  if ('tooShort' in captions) {
    await skipShort(item, captions.tooShort, deps, report);
    return;
  }

  await storeBody(deps.db, item.id, { text: captions.text, raw: captions.raw });
  report.retrieved += 1;
}

async function skipShort(
  item: PendingItem,
  seconds: number,
  deps: SourceDeps,
  report: SourceReport,
): Promise<void> {
  await markSkippedShort(deps.db, item.id, seconds);
  report.skipped_short += 1;
  deps.log(
    `braintrust: ${item.external_id} is ${seconds}s, under the ${SHORT_MAX_SECONDS}s line. ` +
      'Recorded as a short rather than read; turn exclude_shorts off to include it.',
  );
}

async function allSourceCount(db: Db): Promise<number> {
  const { rows } = await db.query<{ count: string }>('select count(*)::text as count from braintrust_sources');
  return Number(rows[0]!.count);
}

/** One line per source, for a job nobody is watching. */
export function summarise(report: CycleReport): string {
  const index = report.index;
  const notes = report.notes;
  const compile = report.compile;
  const idleIndex = index.items_chunked === 0 && index.chunks_embedded === 0 && !index.error;
  const idleNotes = !notes || (notes.items_read === 0 && notes.items_failed === 0 && !notes.error);
  const idleCompile = !compile || (compile.compiled.length === 0 && compile.failed.length === 0);
  if (report.sources.length === 0 && idleIndex && idleNotes && idleCompile) {
    return 'braintrust: nothing was due.';
  }

  // A run where no Source was due can still have real work to report: an endpoint that
  // was switched off yesterday leaves chunks waiting, and "nothing was due" would be a
  // summary of the wrong half of the run.
  const lines = report.sources.map((source) => {
    const parts = [`+${source.discovered} discovered`, `${source.retrieved} retrieved`];
    if (source.skipped_paywall > 0) parts.push(`${source.skipped_paywall} skipped (paywall)`);
    if (source.skipped_short > 0) parts.push(`${source.skipped_short} skipped (short)`);
    if (source.dated > 0) parts.push(`${source.dated} dated`);
    if (source.failed > 0) parts.push(`${source.failed} failed`);
    if (!source.backfill_complete) parts.push('backfill incomplete');
    if (source.error) parts.push(`error: ${source.error}`);
    return `  ${source.person} / ${source.platform} ${source.handle}: ${parts.join(', ')}`;
  });

  const { pending, retrieved, skipped_paywall, skipped_short, failed } = report.corpus;
  lines.push(
    `  corpus: ${retrieved} retrieved, ${skipped_paywall} skipped (paywall), ` +
      `${skipped_short} skipped (short), ${pending} pending, ${failed} failed`,
  );

  const indexed = [`${index.items_chunked} items chunked`, `${index.chunks_written} chunks`];
  if (index.model) indexed.push(`${index.chunks_embedded} embedded as ${index.model}`);
  if (index.error) indexed.push(`error: ${index.error}`);
  lines.push(`  index: ${indexed.join(', ')}`);

  if (notes) {
    const read = [`${notes.items_read} items read as ${notes.generation}`, `${notes.claims_kept} claims`];
    if (notes.claims_dropped > 0) read.push(`${notes.claims_dropped} unquotable, dropped`);
    if (notes.items_failed > 0) read.push(`${notes.items_failed} failed`);
    if (notes.error) read.push(`error: ${notes.error}`);
    lines.push(`  notes: ${read.join(', ')}`);
  }

  if (compile && (compile.compiled.length > 0 || compile.failed.length > 0 || compile.waiting.length > 0)) {
    const built = [
      compile.compiled.length > 0
        ? `rebuilt ${compile.compiled.join(', ')} as ${compile.compiler_version}`
        : 'nothing rebuilt',
    ];
    if (compile.waiting.length > 0) {
      built.push(`${compile.waiting.length} waiting (${compile.waiting[0]!.reason})`);
    }
    if (compile.failed.length > 0) {
      built.push(`${compile.failed.length} failed: ${compile.failed.map((one) => one.person).join(', ')}`);
    }
    lines.push(`  compile: ${built.join(', ')}`);
  }

  if (report.stopped_early) lines.push('  stopped early; the next run continues from these rows');

  return lines.join('\n');
}

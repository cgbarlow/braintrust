/**
 * The cycle: poll → check for a gap → drain the Backlog → rebuild.
 *
 * **One code path, three triggers.** The daily clock runs it over everyone due;
 * `braintrust_refresh_persona` runs it over one named Person; and following someone puts
 * a Source in front of whichever fires next. There is no separate initial-load mode: the
 * first run after following someone *is* the backfill. The only thing that varies is
 * `only` — the scope — because two implementations of "poll, drain, rebuild" is how two
 * triggers start disagreeing about what a rebuild means.
 *
 * Nothing here is a job with state. Every loop reads what the rows say and does the next
 * thing, so being killed at any point costs the time since the last row and nothing else.
 *
 * See docs/design/ingestion.md §3.
 */

import { compileCorpus, type CompileReport, type Synthesiser } from '../compile/index.js';
import type { Db, TransactionalDb } from '../db.js';
import { BraintrustError } from '../errors.js';
import type { Fetcher } from '../net/fetch.js';
import { readCorpus, type Extractor, type ReadReport } from '../notes/index.js';
import { indexCorpus, type Embedder, type IndexReport } from '../retrieval/index.js';
import {
  BLOCK_AFTER_FAILURES,
  requestSpacingMs,
  SHORT_MAX_SECONDS,
  type Audience,
  type Platform,
} from '../sources/types.js';
import { feedSkippedAhead, newestPublished, readFeed } from './feed.js';
import {
  activeSources,
  allSourcesForPerson,
  blockSource,
  clearBlock,
  completeBackfill,
  corpusCounts,
  dueSources,
  insertDiscovered,
  markFailed,
  markSkippedPaywall,
  markSkippedShort,
  markSkippedWindow,
  outsideWindow,
  pendingItems,
  recordCatalogued,
  recordPoll,
  recordPublished,
  reopenShorts,
  reopenWindow,
  sourcesForPerson,
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

/** Who a scoped run is about. Both halves are needed: the rows key on one, the reports on the other. */
export type PersonScope = { id: string; slug: string };

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
  /**
   * What writes the inferred half of the Core. It shares the extractor's endpoint and
   * reads Notes rather than Items, so it is cheap — but without it a Compile could only
   * ever produce half a Core, which the gate would reject. Absent means no rebuild.
   */
  synthesiser?: Synthesiser | undefined;
  /**
   * One Person, or the whole braintrust.
   *
   * **This is the only difference between the three triggers.** The daily clock passes
   * nothing and sweeps everyone due; `braintrust_refresh_persona` names one Person and
   * runs the identical four steps over their rows. There is no refresh code path — a
   * second implementation of "poll, drain, rebuild" is exactly how two triggers start
   * disagreeing about what a rebuild means.
   */
  only?: PersonScope | undefined;
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
  /** Items the feed carries that are older than the window this Source was given. */
  skipped_window: number;
  failed: number;
  backfill_complete: boolean;
  gap_detected: boolean;
  /** Items whose date the feed never carried and a per-item fetch supplied. */
  dated: number;
  /** Set when an operator turned `exclude_shorts` off and past skips came back. */
  reopened_shorts?: number;
  /** Set when an operator widened `window_months` and past skips came back. */
  reopened_window?: number;
  /**
   * The Source stopped answering, measured across distinct Items. Never the user's
   * choice to stop, which is a Person being paused and is reported as `paused`.
   */
  blocked_since?: string;
  /** This run spent the one daily request on an already-blocked Source rather than working it. */
  probed?: true;
  /** The probe was answered. The block is cleared and the next run works normally. */
  unblocked?: true;
  error?: string;
};

export type CycleReport = {
  started: string;
  finished: string;
  sources: SourceReport[];
  not_due: number;
  /**
   * Sources belonging to a Person the user stopped following. Counted separately from
   * `blocked` on purpose: one is the user's decision and the other is a platform's, and
   * a single number would let a Persona blame its own user for a Source's refusal.
   */
  paused: number;
  /** Sources that had stopped answering when this run started. Each got one request. */
  blocked: number;
  /**
   * People whose Corpus changed on this run. A report of what arrived, not the rebuild
   * trigger — that is `has_unseen`, asked of the rows, so a run that finishes yesterday's
   * work rebuilds even though nothing new turned up today.
   */
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

  const census = await takeCensus(deps, started);
  const { due, active, all } = census;
  const blocked = due.filter((source) => source.blocked_at !== null).length;

  log(
    deps.only
      ? `braintrust: refreshing ${deps.only.slug} — ${due.length} of ${all} source` +
          `${all === 1 ? '' : 's'} to poll` +
          `${all - due.length > 0 ? `, ${all - due.length} blocked` : ''}`
      : `braintrust: ${due.length} of ${all} source${all === 1 ? '' : 's'} due` +
          `${all - active.length > 0 ? `, ${all - active.length} paused` : ''}` +
          `${blocked > 0 ? `, ${blocked} blocked and getting one request` : ''}`,
  );

  const reports: SourceReport[] = [];
  const changed = new Set<string>();
  let stoppedEarly = false;

  // Asked before the loop as well as inside it. The stop lands in the middle of a
  // source's items far more often than between two sources — and with one source
  // configured, *only* there. A run that gave up on the last item of the only source
  // would otherwise report a clean finish, which is the one thing a caller deciding
  // whether to call again must not be told. Found live.
  const stopHere = (): boolean => {
    if (!stopping()) return false;
    if (!stoppedEarly) log('braintrust: asked to stop; the rows written so far are the progress.');
    stoppedEarly = true;
    return true;
  };

  for (const source of due) {
    if (stopHere()) break;

    const report = await runSource(source, { ...deps, now, log, stopping });
    reports.push(report);
    if (
      report.discovered +
        report.retrieved +
        report.skipped_paywall +
        report.skipped_short +
        report.skipped_window >
      0
    ) {
      changed.add(source.person);
    }
    if (report.error) log(`braintrust: ${source.platform} ${source.handle} — ${report.error}`);
  }
  stopHere();

  // 4. Index what was fetched. Corpus-wide and outside the per-source loop, because a
  // Chunk belongs to an Item and neither chunking nor embedding cares which platform
  // the words came from. A run asked to stop does none of it and says so: an Item with
  // a body and no Chunks is already the Backlog, so the next run picks it up unprompted.
  const index = await indexCorpus({
    db: deps.db,
    embedder: deps.embedder,
    ...(deps.only ? { person: deps.only.id } : {}),
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
    ? await readCorpus({
        db: deps.db,
        extractor: deps.extractor,
        ...(deps.only ? { person: deps.only.id } : {}),
        stopping,
        log,
      })
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
  // extractor there is no honest value to put on the row; without a synthesiser it could
  // only build half a Core, which the gate would reject anyway. Either missing, and the
  // Persona already serving is left alone.
  const compile =
    deps.extractor && deps.synthesiser
      ? await compileCorpus({
          db: deps.db,
          extractor: deps.extractor.generation,
          synthesiser: deps.synthesiser,
          // The same embedder that just indexed the corpus, doing a second job: an
          // endpoint good enough to index with is the one revisions have to be judged in,
          // because both are asking what is near what.
          embedder: deps.embedder,
          ...(deps.only ? { person: deps.only.slug } : {}),
          now,
          log,
        })
      : undefined;

  const report: CycleReport = {
    started: started.toISOString(),
    finished: now().toISOString(),
    sources: reports,
    not_due: active.length - due.length,
    paused: all - active.length,
    blocked,
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
    skipped_window: 0,
    failed: 0,
    backfill_complete: source.backfill_complete,
    gap_detected: false,
    dated: 0,
  };

  if (source.blocked_at) return probeSource(source, deps, report);

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

    // The same debt, owed for the same reason, to an operator who widened the window.
    // Asked unconditionally because the floor is the question — a window that did not
    // move reopens nothing, so there is no "was it widened" flag to keep in step with
    // the setting it describes.
    const reopenedWindow = await reopenWindow(deps.db, source.id, source.backfill_floor);
    if (reopenedWindow > 0) {
      report.reopened_window = reopenedWindow;
      deps.log(
        `braintrust: ${source.handle}'s window now reaches ${source.backfill_floor}, so ` +
          `${reopenedWindow} item(s) braintrust had skipped as too old are pending again.`,
      );
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
 * A blocked Source's whole day: **one ordinary request, unchanged.**
 *
 * This is self-healing rather than evasion. Evasion means changing *how* you ask — a new
 * address, a spoofed user-agent, a rotated identity — and braintrust crawls from one host
 * at one address with nothing to rotate. So it asks again exactly as it asked before, and
 * an answer is what clears the block.
 *
 * **The request is the one that was refused.** A block is measured on Item retrievals, so
 * probing with a feed poll would prove the wrong thing: a bot gate that serves RSS and
 * refuses watch pages would clear the block every morning and re-earn it every afternoon,
 * which is a repair loop wearing a probe's clothes. Only when there is nothing left to
 * retrieve does the feed become the question — because then it is the only one there is.
 *
 * Everything else a run does is skipped. No archive walk (a Source that cannot finish its
 * backfill is precisely the one this exists to stop looping), no second Item, and no
 * retry. Failure means nothing else happens until tomorrow.
 *
 * **Accepted cost, stated rather than engineered around:** a Source that has permanently
 * and deliberately blocked braintrust receives one request a day, forever.
 * See docs/design/ingestion.md §5.
 */
async function probeSource(
  source: SourceRow,
  deps: SourceDeps,
  report: SourceReport,
): Promise<SourceReport> {
  report.probed = true;
  report.blocked_since = source.blocked_at!.toISOString();

  // Paywalled and unknown-audience rows are not requests braintrust would ever make, so
  // they cannot answer the question this run is asking.
  const askable = (await pendingItems(deps.db, source.id)).filter(
    (item) => item.audience === 'everyone',
  );

  try {
    if (askable[0]) {
      const item = askable[0];
      if (source.platform === 'substack') {
        await retrieveSubstackItem(source, item, deps, report);
      } else {
        await retrieveYoutubeItem(source, item, deps, report);
      }
    } else {
      // Nothing owed, so the feed is the only ordinary request left. Anything it turns up
      // becomes a row and waits: discovery is free, and the Backlog stays suppressed until
      // the block is gone.
      const feed = readFeed(
        await fetchPolitely(deps.fetcher, source.discovery_url, `the feed for ${source.handle}`, {
          ...(deps.pause ? { pause: deps.pause } : {}),
        }),
        source.platform,
      );
      report.discovered = (
        await insertDiscovered(deps.db, source, feed.entries, DISCOVERED_AUDIENCE[source.platform])
      ).length;
      await recordPoll(deps.db, source, {
        cursor: newestPublished(feed.entries),
        reopenBackfill: false,
        now: deps.now(),
      });
    }
  } catch (error) {
    // A `PaywallChanged` reaches here as an answer, not a refusal — the Source served
    // braintrust and said no. It falls through to the clear below, like any other reply.
    if (!(error instanceof PaywallChanged)) {
      report.error = error instanceof BraintrustError ? error.message : String(error);
      deps.log(
        `braintrust: ${source.platform} ${source.handle} has been blocked since ` +
          `${report.blocked_since} and is still not answering. One request, again tomorrow.`,
      );
      return report;
    }
    if (askable[0]) {
      await markSkippedPaywall(deps.db, askable[0].id);
      report.skipped_paywall += 1;
    }
  }

  await clearBlock(deps.db, source.id);
  report.unblocked = true;
  deps.log(
    `braintrust: ${source.platform} ${source.handle} answered. The block set on ` +
      `${report.blocked_since} is cleared and the next run works it normally.`,
  );
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
  // paid, and the allow-list means unknown is never fetched. Which outcome that is
  // depends on *whose* decision left it undescribed — the walk stopping at the floor is
  // braintrust's, and anything else is the archive's.
  for (const externalId of wanted) {
    const item = unknown.find((candidate) => candidate.external_id === externalId)!;
    await resolveUndescribed(source, item, deps, report);
  }
}

/**
 * An Item braintrust knows exists and cannot learn the audience of. Two outcomes that
 * look identical from here and are not the same fact:
 *
 * - **Older than the floor** — the archive walk was told to stop before reaching it.
 *   braintrust's own decision, so `skipped_window`, and widening the window undoes it.
 * - **Inside the window and still not in the archive** — the source served a feed entry
 *   it has no catalogue record for. Terminal, because nothing braintrust can change
 *   would produce one.
 */
async function resolveUndescribed(
  source: SourceRow,
  item: PendingItem,
  deps: SourceDeps,
  report: SourceReport,
): Promise<void> {
  if (outsideWindow(source, item.published_at)) {
    await markSkippedWindow(deps.db, item.id);
    report.skipped_window += 1;
    deps.log(
      `braintrust: ${item.external_id} is older than ${source.handle}'s backfill floor of ` +
        `${source.backfill_floor}, so braintrust never described it. Recorded as skipped; ` +
        'widening window_months brings it back.',
    );
    return;
  }

  await markFailed(deps.db, item.id);
  report.failed += 1;
  deps.log(
    `braintrust: ${item.external_id} is in ${source.handle}'s feed but not its archive, so its ` +
      'audience is unknowable. Recorded as failed rather than fetched.',
  );
}

/**
 * The expensive half, newest first, spaced at whatever this Source's rate is.
 *
 * **The wait is between requests, not between Items.** This comment used to say the
 * opposite, and on YouTube the two are the same thing: one Item is one request braintrust
 * issues, with yt-dlp expanding it into the date, the caption list and the track inside
 * that one call. Nothing added since works that way — one Bluesky request returns a
 * hundred posts — so the per-Item reading would charge the cheapest Source braintrust has
 * the highest bill, for traffic identical either way.
 *
 * Substack and YouTube are unaffected: 4s per request is 4s per Item on both.
 * See docs/design/ingestion.md §6.
 */
async function retrieveBodies(source: SourceRow, deps: SourceDeps, report: SourceReport): Promise<void> {
  const pause = deps.pause ?? sleep;
  const pending = await pendingItems(deps.db, source.id);

  let fetched = 0;
  // Consecutive failures across *distinct* Items. Reset by anything that comes back —
  // a body, a caption track, even a paywall, because a Source that says no is a Source
  // that answered. Held in memory rather than a column: a run is the only span over
  // which "consecutive" means anything, and a `failed` Item is never retried, so a
  // Backlog too short to reach the threshold exhausts itself instead of looping.
  let inARow = 0;

  for (const item of pending) {
    if (deps.stopping()) return;

    // The allow-list, one last time before any request is made. `everyone` or nothing.
    //
    // The two ways of not being `everyone` are not the same fact, and recording them as
    // one would make a Persona claim a paywall it never saw. `paid` is a source's
    // decision braintrust is respecting; `unknown` means the catalogue never described
    // this Item — which happens when `backfill_floor` is nearer than the feed's window,
    // so a post appears in the feed and is older than anything the archive walk reads.
    // That is the same unknowable-audience case `catalogue` resolves, so it is resolved
    // the same way: braintrust's own window is a skip, and anything else is terminal.
    if (item.audience === 'paid') {
      await markSkippedPaywall(deps.db, item.id);
      report.skipped_paywall += 1;
      continue;
    }
    if (item.audience !== 'everyone') {
      await resolveUndescribed(source, item, deps, report);
      continue;
    }

    if (fetched > 0) await pause(requestSpacingMs(source.platform));
    fetched += 1;

    try {
      if (source.platform === 'substack') {
        await retrieveSubstackItem(source, item, deps, report);
      } else {
        await retrieveYoutubeItem(source, item, deps, report);
      }
      inARow = 0;
    } catch (error) {
      if (error instanceof PaywallChanged) {
        await markSkippedPaywall(deps.db, item.id);
        report.skipped_paywall += 1;
        deps.log(`braintrust: ${item.external_id} — ${error.message}`);
        inARow = 0;
        continue;
      }
      await markFailed(deps.db, item.id);
      report.failed += 1;
      inARow += 1;
      deps.log(
        `braintrust: ${item.external_id} failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      // The measurement, and the only place a block is ever set. braintrust has not
      // classified a single response to get here — it has counted requests against
      // different Items that came back with nothing usable, which is the one thing that
      // distinguishes a Source refusing braintrust from a bad afternoon.
      if (inARow >= BLOCK_AFTER_FAILURES) {
        const at = deps.now();
        await blockSource(deps.db, source.id, at);
        report.blocked_since = at.toISOString();
        deps.log(
          `braintrust: ${BLOCK_AFTER_FAILURES} items of ${source.handle} failed in a row, so ` +
            'that source has stopped serving braintrust. Everything already collected is kept, ' +
            'the rest of its backlog is left alone, and braintrust asks once tomorrow. Every ' +
            'other source carries on.',
        );
        return;
      }
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

/**
 * Which Sources this run touches, and what it should say about the ones it does not.
 *
 * The scoped answer is not the sweeping one narrowed down. Nothing is *not due* in a
 * refresh — somebody asked — so the only Sources it holds back are the blocked ones,
 * and it says so with the same words the daily job uses.
 */
async function takeCensus(
  deps: CycleDeps,
  started: Date,
): Promise<{ due: SourceRow[]; active: SourceRow[]; all: number }> {
  if (deps.only) {
    const due = await sourcesForPerson(deps.db, deps.only.id);
    const all = await allSourcesForPerson(deps.db, deps.only.id);
    return { due, active: due, all: all.length };
  }

  return {
    due: await dueSources(deps.db, started),
    active: await activeSources(deps.db),
    all: await allSourceCount(deps.db),
  };
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
  const idleCompile =
    !compile ||
    (compile.compiled.length === 0 && compile.failed.length === 0 && compile.rejected.length === 0);
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
    if (source.skipped_window > 0) parts.push(`${source.skipped_window} skipped (outside window)`);
    if (source.reopened_window) parts.push(`${source.reopened_window} reopened (window widened)`);
    if (source.dated > 0) parts.push(`${source.dated} dated`);
    if (source.failed > 0) parts.push(`${source.failed} failed`);
    if (!source.backfill_complete) parts.push('backfill incomplete');
    // Three states worth their own words, because "blocked" alone reads as the user's
    // doing and none of these is.
    if (source.unblocked) parts.push('answered again; block cleared');
    else if (source.probed) parts.push(`still blocked since ${source.blocked_since}, asked once`);
    else if (source.blocked_since) parts.push('stopped answering; blocked, backlog left alone');
    if (source.error) parts.push(`error: ${source.error}`);
    return `  ${source.person} / ${source.platform} ${source.handle}: ${parts.join(', ')}`;
  });

  const { pending, retrieved, skipped_paywall, skipped_short, skipped_window, failed } = report.corpus;
  lines.push(
    `  corpus: ${retrieved} retrieved, ${skipped_paywall} skipped (paywall), ` +
      `${skipped_short} skipped (short), ${skipped_window} skipped (outside window), ` +
      `${pending} pending, ${failed} failed`,
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

  if (
    compile &&
    (compile.compiled.length > 0 ||
      compile.failed.length > 0 ||
      compile.rejected.length > 0 ||
      compile.waiting.length > 0)
  ) {
    const built = [
      compile.compiled.length > 0
        ? `rebuilt ${compile.compiled.join(', ')} as ${compile.compiler_version}`
        : 'nothing rebuilt',
    ];
    if (compile.waiting.length > 0) {
      built.push(`${compile.waiting.length} waiting (${compile.waiting[0]!.reason})`);
    }
    if (compile.rejected.length > 0) {
      built.push(
        `${compile.rejected.length} rejected by the gate, not published: ` +
          compile.rejected.map((one) => one.person).join(', '),
      );
    }
    if (compile.failed.length > 0) {
      built.push(`${compile.failed.length} failed: ${compile.failed.map((one) => one.person).join(', ')}`);
    }
    lines.push(`  compile: ${built.join(', ')}`);
  }

  if (report.stopped_early) lines.push('  stopped early; the next run continues from these rows');

  return lines.join('\n');
}

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
import { readAuthorFeed } from '../sources/bluesky.js';
import { documentKind } from '../sources/blog.js';
import {
  audienceKnownBeforeFetch,
  BLOCK_AFTER_FAILURES,
  requestSpacingMs,
  SHORT_MAX_SECONDS,
  SHORT_MAX_WORDS,
  type Audience,
  type Platform,
} from '../sources/types.js';
import { walkAuthorFeed } from './bluesky.js';
import {
  BOILERPLATE_PAGES,
  boilerplateFrom,
  feedBodies,
  normaliseUrl,
  retrieveBlogPost,
  walkBlogArchive,
  type FeedBody,
} from './blog.js';
import { feedSkippedAhead, newestPublished, readFeed, type FeedEntry } from './feed.js';
import {
  activeSources,
  allSourcesForPerson,
  blockSource,
  clearBlock,
  completeBackfill,
  corpusCounts,
  dueSources,
  insertDiscovered,
  latestStoredDay,
  markFailed,
  markSkippedNotAPost,
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
  storeDay,
  storedPages,
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
 * A blog declares no audience at all — the gating markers are in the page, so it is
 * `unknown` for a different reason and by the same rule.
 */
const DISCOVERED_AUDIENCE: Record<Platform, Audience> = {
  youtube: 'everyone',
  substack: 'unknown',
  blog: 'unknown',
  // There is no paid tier on Bluesky, and no path here anyway: a day is written straight
  // to `retrieved`, because the words arrived with the discovery that found it.
  bluesky: 'everyone',
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
  /**
   * URLs a blog's sitemap listed that turned out to be pages rather than posts. Counted
   * apart from `failed` because the source answered — this is braintrust checking.
   */
  skipped_not_a_post: number;
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
   * Set when a blog's sitemap showed a newer `<lastmod>` for a URL braintrust had
   * decided was not a post. Nobody performed this reopen; the sitemap did.
   */
  reopened_not_posts?: number;
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
        report.skipped_window +
        report.skipped_not_a_post >
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

/**
 * What the poll is asking for, in the words a human would use about it. A blog's
 * `discovery_url` is a feed on one site and a sitemap on another, and a failure message
 * naming the wrong one sends whoever reads it looking for a feed that never existed.
 */
function discoveryName(source: SourceRow): string {
  if (source.platform === 'blog') return `the feed or sitemap for ${source.handle}`;
  if (source.platform === 'bluesky') return `the Bluesky posts of ${source.handle}`;
  return `the feed for ${source.handle}`;
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
    skipped_not_a_post: 0,
    failed: 0,
    backfill_complete: source.backfill_complete,
    gap_detected: false,
    dated: 0,
  };

  if (source.blocked_at) return probeSource(source, deps, report);

  try {
    // 1. Poll. One fetch of `discovery_url`, generic across platforms.
    const polled = await fetchPolitely(deps.fetcher, source.discovery_url, discoveryName(source), {
      ...(deps.pause ? { pause: deps.pause } : {}),
    });

    // **Bluesky's poll is its walk, so it is a different four steps rather than a branch
    // inside these ones.** Everywhere else, discovery finds what is new and a second pass
    // fetches it; here the same response carries both, and a Source with no per-Item
    // request has no Backlog, no catalogue and no paywall to filter.
    if (source.platform === 'bluesky') await pollBluesky(source, deps, report, polled);
    else await pollFeedSource(source, deps, report, polled);
  } catch (error) {
    // One source's bad day is not another's. The two platforms share nothing but a
    // Person and they fail in opposite directions, so stopping the run would be a
    // failure braintrust invented rather than one a source imposed.
    report.error = error instanceof BraintrustError ? error.message : String(error);
  }

  return report;
}

/**
 * The poll every Source with a feed or a catalogue runs: discover, check for a gap, drain.
 */
async function pollFeedSource(
  source: SourceRow,
  deps: SourceDeps,
  report: SourceReport,
  polled: string,
): Promise<void> {
  // **A blog's discovery document is a feed or a sitemap, and the document says which.**
  // That is what lets `discovery_url` stay one column with no flag beside it — but it
  // has to be asked, because reading a sitemap as a feed finds no entries and would
  // quietly report a blog that publishes nothing rather than one whose archive is the
  // thing to walk.
  const feed =
    source.platform === 'blog' && documentKind(polled) !== 'feed'
      ? { entries: [] }
      : readFeed(polled, source.platform);

  const blog = source.platform === 'blog' ? await blogPoll(source, deps, polled, feed.entries) : undefined;

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
  const walked = { ...source, backfill_complete: report.backfill_complete };
  if (blog) await catalogueBlog(walked, deps, report, blog, polled);
  else await catalogue(walked, deps, report);
  await retrieveBodies(source, deps, report, blog);
}

/**
 * Bluesky's whole run: one cursored walk, batching closed days into rows as it goes.
 *
 * **How far back to read is the only decision here, and it is read off the rows.** While
 * the archive has not been reached the answer is the backfill floor, every run, because a
 * Source that stopped short must keep trying. Once it has, the answer is the start of the
 * newest day braintrust already stored — which makes the steady-state poll exactly one
 * request, and makes a gap repair itself: the walk always covers everything between the
 * last stored day and now, so there is nothing for gap detection to detect.
 *
 * The re-read of that newest stored day is deliberate. It is one day's posts re-collected
 * into a key that already exists, `on conflict do nothing` declines it, and the alternative
 * — stopping at the newest post seen — would truncate the day that post belongs to.
 */
async function pollBluesky(
  source: SourceRow,
  deps: SourceDeps,
  report: SourceReport,
  polled: string,
): Promise<void> {
  const now = deps.now();
  const floor = new Date(`${source.backfill_floor}T00:00:00Z`);
  const latest = source.backfill_complete ? await latestStoredDay(deps.db, source.id) : undefined;
  const until = latest ? new Date(`${latest}T00:00:00Z`) : floor;

  const outcome = await walkAuthorFeed(
    source,
    {
      fetcher: deps.fetcher,
      ...(deps.pause ? { pause: deps.pause } : {}),
      now,
      until,
      polled,
      stopping: deps.stopping,
    },
    async (day) => {
      if (!(await storeDay(deps.db, source, day))) return;
      report.discovered += 1;
      report.retrieved += 1;
    },
  );

  await recordPoll(deps.db, source, {
    cursor: outcome.newest,
    reopenBackfill: false,
    now,
  });

  if (!source.backfill_complete && outcome.reachedEnd) {
    await completeBackfill(deps.db, source);
    report.backfill_complete = true;
    deps.log(
      `braintrust: ${source.handle} is backfilled to ${source.backfill_floor} — ` +
        `${outcome.posts} post(s) read as ${outcome.days} day(s) across ${outcome.requests} ` +
        'request(s).',
    );
  }
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
  // they cannot answer the question this run is asking. A blog is the exception for the
  // reason it is everywhere else: its Items are `unknown` by construction, and the page
  // fetch is precisely the request that was refused.
  const askable = (await pendingItems(deps.db, source.id)).filter(
    (item) => item.audience === 'everyone' || !audienceKnownBeforeFetch(source.platform),
  );

  try {
    if (askable[0]) {
      const item = askable[0];
      if (source.platform === 'blog') {
        // No feed and no walk on a probe — just the one page, extracted against whatever
        // this blog's stored pages already say its chrome is.
        await retrieveBlogItem(source, item, deps, report, await blogPoll(source, deps));
      } else if (source.platform === 'substack') {
        await retrieveSubstackItem(source, item, deps, report);
      } else {
        await retrieveYoutubeItem(source, item, deps, report);
      }
    } else if (source.platform === 'bluesky') {
      // **braintrust's own measurement can never block a Bluesky Source**, because a block
      // is counted across per-Item requests and Bluesky makes none — so this runs only for
      // a row that says otherwise. The poll is the one request this Source ever makes, and
      // therefore the only honest probe: it is read but not written, because a blocked
      // Source's work stays suppressed until the block is gone.
      readAuthorFeed(
        await fetchPolitely(deps.fetcher, source.discovery_url, discoveryName(source), {
          ...(deps.pause ? { pause: deps.pause } : {}),
        }),
        source.handle,
      );
      await recordPoll(deps.db, source, { reopenBackfill: false, now: deps.now() });
    } else {
      // Nothing owed, so the feed is the only ordinary request left. Anything it turns up
      // becomes a row and waits: discovery is free, and the Backlog stays suppressed until
      // the block is gone.
      const feed = readFeed(
        await fetchPolitely(deps.fetcher, source.discovery_url, discoveryName(source), {
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
    // **Two errors reach here as answers rather than refusals**, and both fall through to
    // the clear below. A `PaywallChanged` is the Source serving braintrust and saying no.
    // A `NoCaptions` is the Source serving braintrust a video with no words in it — the
    // player response it was read from arrived perfectly, which is the whole question a
    // probe is asking.
    if (!(error instanceof PaywallChanged) && !(error instanceof NoCaptions)) {
      report.error = error instanceof BraintrustError ? error.message : String(error);
      deps.log(
        `braintrust: ${source.platform} ${source.handle} has been blocked since ` +
          `${report.blocked_since} and is still not answering. One request, again tomorrow.`,
      );
      return report;
    }
    if (askable[0]) {
      if (error instanceof PaywallChanged) {
        await markSkippedPaywall(deps.db, askable[0].id);
        report.skipped_paywall += 1;
      } else {
        // Recorded, so tomorrow reaches for a different Item rather than this one forever.
        // A probe that leaves its Item pending asks the identical question every day, and
        // a Source whose whole backlog answers this way could never clear — which is how a
        // channel of uncaptioned videos stayed blocked permanently.
        await markFailed(deps.db, askable[0].id);
        report.failed += 1;
      }
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
 * Everything about one blog that the poll already paid for, carried to the retrieval pass.
 *
 * A blog is the one Source whose *body* arrives with discovery, so the document read to
 * find out what is new is also the document holding what to store — and throwing it away
 * between the two halves of a run would make braintrust fetch every post it had already
 * been given. That is the whole reason this exists.
 */
type BlogPoll = {
  /** Bodies the feed carried, by normalised URL. Empty when the poll read a sitemap. */
  feeds: Map<string, FeedBody>;
  /** Publish dates the feed carried, by normalised URL. */
  dates: Map<string, Date>;
  /** The `<lastmod>` this run's walk saw, by URL. Empty when no walk ran. */
  lastmods: Map<string, Date>;
  /** Markup of pages read from this blog — seeded from the rows, grown by this run. */
  pages: string[];
  /** What repeats across those pages. Undefined until there are two of them. */
  boilerplate?: ReadonlySet<string> | undefined;
};

async function blogPoll(
  source: SourceRow,
  deps: SourceDeps,
  polled?: string,
  entries: FeedEntry[] = [],
): Promise<BlogPoll> {
  const dates = new Map<string, Date>();
  for (const entry of entries) {
    if (entry.publishedAt) dates.set(normaliseUrl(entry.url), entry.publishedAt);
  }

  const pages = await storedPages(deps.db, source.id, BOILERPLATE_PAGES);

  return {
    feeds: polled !== undefined && documentKind(polled) === 'feed' ? feedBodies(polled) : new Map(),
    dates,
    lastmods: new Map(),
    pages,
    boilerplate: boilerplateFrom(pages),
  };
}

/**
 * A blog's catalogue pass, which is its archive walk.
 *
 * **Two conditions rather than one, and the second is what keeps a feedless blog alive.**
 * `!backfill_complete` is the ordinary repair walk every Source has. But for a blog whose
 * discovery document *is* the sitemap, the walk is the poll — it is how that Source learns
 * anything was published at all — so it runs on every run, at no cost beyond the document
 * already in hand. Without it a feedless blog would walk its archive once, set the flag,
 * and never notice another post as long as it ran.
 */
async function catalogueBlog(
  source: SourceRow,
  deps: SourceDeps,
  report: SourceReport,
  blog: BlogPoll,
  polled: string,
): Promise<void> {
  const pollIsSitemap = documentKind(polled) === 'sitemap';
  if (source.backfill_complete && !pollIsSitemap) return;

  const outcome = await walkBlogArchive(
    source,
    deps.db,
    { fetcher: deps.fetcher, ...(deps.pause ? { pause: deps.pause } : {}), polled },
    async (item) => {
      await recordCatalogued(deps.db, source, item);
      report.catalogued += 1;
    },
  );

  blog.lastmods = outcome.lastmods;

  if (outcome.reopened > 0) {
    report.reopened_not_posts = outcome.reopened;
    deps.log(
      `braintrust: ${outcome.reopened} URL(s) braintrust had decided were not posts on ` +
        `${source.handle} have changed since, so they are pending again. Nobody performed ` +
        'this reopen; the sitemap did.',
    );
  }

  // A blog with no sitemap never reaches the floor and never claims the flag, on every
  // run, forever. That is the honest state rather than a failure: it knows it is behind
  // and the Persona's Coverage says so.
  if (outcome.reachedFloor && !source.backfill_complete) {
    await completeBackfill(deps.db, source);
    report.backfill_complete = true;
    deps.log(
      `braintrust: ${source.handle} has ${outcome.seen} URL(s) in ${outcome.sitemap}, every ` +
        'one of them a candidate until the page says otherwise.',
    );
  }
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
async function retrieveBodies(
  source: SourceRow,
  deps: SourceDeps,
  report: SourceReport,
  blog?: BlogPoll,
): Promise<void> {
  const pause = deps.pause ?? sleep;
  const pending = await pendingItems(deps.db, source.id);

  // **Counted rather than assumed.** Substack and YouTube spend exactly one request per
  // Item, so counting changes nothing for them — but a blog post whose body came with the
  // feed spends none, and charging it four seconds for a fetch that never happened would
  // make a whole backfill sleep for a quarter of an hour to be polite about no traffic.
  let issued = 0;
  const counted: SourceDeps = {
    ...deps,
    fetcher: (url, init) => {
      issued += 1;
      return deps.fetcher(url, init);
    },
  };
  let paced = 0;
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
    // A blog has no catalogue that could ever describe its audience, so `unknown` there
    // means *nobody has been asked yet* rather than *the answer was withheld*. The line
    // does not move; it is enforced one step later, on the page this is about to fetch.
    if (item.audience !== 'everyone' && audienceKnownBeforeFetch(source.platform)) {
      await resolveUndescribed(source, item, deps, report);
      continue;
    }

    // **A blog's window is applied wherever the date was free, and never after.** The
    // other two Sources filter by it during the catalogue walk; a blog has no catalogue,
    // so this is where the same question gets asked — but only of an Item the feed already
    // dated. An Item the sitemap found is undated until its page is in hand, and re-
    // skipping it once that request has been spent would buy nothing and lose the words.
    if (blog && outsideWindow(source, item.published_at)) {
      await markSkippedWindow(deps.db, item.id);
      report.skipped_window += 1;
      continue;
    }

    if (issued > paced) {
      await pause(requestSpacingMs(source.platform));
      paced = issued;
    }

    try {
      if (blog) {
        await retrieveBlogItem(source, item, counted, report, blog);
      } else if (source.platform === 'substack') {
        await retrieveSubstackItem(source, item, counted, report);
      } else {
        await retrieveYoutubeItem(source, item, counted, report);
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
      deps.log(
        `braintrust: ${item.external_id} failed — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      // **A video with no caption track is the source answering, not declining.** It is
      // still `failed` — the words could not be retrieved and nothing an operator changes
      // brings them back — but it is not evidence that the platform has stopped serving
      // braintrust, because the player response it was read from arrived perfectly. The
      // same reasoning that resets the counter on a paywall: a Source that says *there is
      // nothing here* is a Source that answered.
      //
      // Found live. A channel of five uncaptioned videos in a row was blocked as though it
      // had refused braintrust, and then probed once a day forever.
      if (error instanceof NoCaptions) {
        inARow = 0;
        continue;
      }
      inARow += 1;

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
 * One blog candidate, and the four things it can turn out to be.
 *
 * **Three of the four are braintrust reporting rather than failing**, and they are
 * separate states because Coverage says different things to a reader about each. *"3 URLs
 * in the archive turned out not to be posts"* is braintrust doing its job on a sitemap
 * that enumerates URLs; *"1 post is members-only"* is a publisher's decision respected;
 * *"1 post was too brief to read"* is a setting the operator owns. Rendering any of them
 * as `failed` would be a lie about a source that answered perfectly — and the retrieval
 * loop treats all four as an answer, so none of them counts toward a block.
 */
async function retrieveBlogItem(
  source: SourceRow,
  item: PendingItem,
  deps: SourceDeps,
  report: SourceReport,
  blog: BlogPoll,
): Promise<void> {
  const key = normaliseUrl(item.url);
  const verdict = await retrieveBlogPost(source, item.url, deps, {
    excludeShorts: source.exclude_shorts,
    feed: blog.feeds.get(key),
    // The feed's own date where the poll read one, the row's where the feed has since
    // dropped the entry. Either spares the page fetch a declared body would not need.
    publishedAt: blog.dates.get(key) ?? dateOf(item.published_at),
    boilerplate: blog.boilerplate,
  });

  if (verdict.kind === 'not_a_post') {
    // This walk's `<lastmod>`, never the row's — see `BlogWalkOutcome.lastmods`.
    await markSkippedNotAPost(deps.db, item.id, blog.lastmods.get(item.external_id));
    report.skipped_not_a_post += 1;
    deps.log(`braintrust: ${verdict.why}.`);
    return;
  }

  if (verdict.kind === 'paywalled') {
    await markSkippedPaywall(deps.db, item.id);
    report.skipped_paywall += 1;
    deps.log(`braintrust: ${verdict.why}.`);
    return;
  }

  // Dated by the page, where the feed or the sitemap could not. Recorded before the
  // Shorts rule is applied, because a skipped post that keeps its date is one the
  // operator gets back in the right place when they change their mind.
  if (!item.published_at) {
    await recordPublished(deps.db, item.id, verdict.publishedAt);
    report.dated += 1;
  }

  if (verdict.kind === 'short') {
    await markSkippedShort(deps.db, item.id, { platform: 'blog', words: verdict.words });
    report.skipped_short += 1;
    deps.log(
      `braintrust: ${item.external_id} is ${verdict.words} words, under the ${SHORT_MAX_WORDS}-word ` +
        'line. Recorded as short rather than read; turn exclude_shorts off to include it.',
    );
    return;
  }

  await storeBody(deps.db, item.id, { text: verdict.text, raw: verdict.raw });
  report.retrieved += 1;

  // The page joins the pool the *next* post is extracted against, which is why a backfill
  // gets better as it goes and a steady-state run starts good. It stops growing at the
  // cap so the set is stable across a batch rather than drifting post to post.
  if (verdict.raw.html !== undefined && blog.pages.length < BOILERPLATE_PAGES) {
    blog.pages.push(verdict.raw.html);
    blog.boilerplate = boilerplateFrom(blog.pages);
  }
}

/** A row's `published_at` is a date, and the feed's is the better answer where there is one. */
function dateOf(published: string | null): Date | undefined {
  return published ? new Date(`${published}T00:00:00Z`) : undefined;
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
  await markSkippedShort(deps.db, item.id, { platform: 'youtube', durationSeconds: seconds });
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
    // A Bluesky Item is a day, and "+12 discovered, 12 retrieved" would read as twelve
    // posts. The number a reader is owed is the one the model calls are charged against.
    const parts =
      source.platform === 'bluesky'
        ? [`+${source.discovered} day${source.discovered === 1 ? '' : 's'} batched`]
        : [`+${source.discovered} discovered`, `${source.retrieved} retrieved`];
    if (source.skipped_paywall > 0) parts.push(`${source.skipped_paywall} skipped (paywall)`);
    if (source.skipped_short > 0) parts.push(`${source.skipped_short} skipped (short)`);
    if (source.skipped_window > 0) parts.push(`${source.skipped_window} skipped (outside window)`);
    if (source.skipped_not_a_post > 0) parts.push(`${source.skipped_not_a_post} not posts`);
    if (source.reopened_window) parts.push(`${source.reopened_window} reopened (window widened)`);
    if (source.reopened_not_posts) parts.push(`${source.reopened_not_posts} reopened (lastmod moved)`);
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

  const { pending, retrieved, skipped_paywall, skipped_short, skipped_window, skipped_not_a_post, failed } =
    report.corpus;
  lines.push(
    `  corpus: ${retrieved} retrieved, ${skipped_paywall} skipped (paywall), ` +
      `${skipped_short} skipped (short), ${skipped_window} skipped (outside window), ` +
      `${skipped_not_a_post} not posts, ${pending} pending, ${failed} failed`,
  );

  const indexed = [`${index.items_chunked} items chunked`, `${index.chunks_written} chunks`];
  if (index.model) indexed.push(`${index.chunks_embedded} embedded as ${index.model}`);
  if (index.error) indexed.push(`error: ${index.error}`);
  lines.push(`  index: ${indexed.join(', ')}`);

  if (notes) {
    const read = [`${notes.items_read} items read as ${notes.generation}`, `${notes.claims_kept} claims`];
    if (notes.claims_dropped > 0) {
      read.push(
        `${notes.claims_dropped} unquotable, dropped` +
          // The whole reason this number is here: it is the difference between "the model
          // is inventing quotes" and "the model punctuated an unpunctuated transcript".
          (notes.claims_nearly > 0 ? ` (${notes.claims_nearly} only punctuation and case)` : ''),
      );
    }
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

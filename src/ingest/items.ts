/**
 * The Backlog, and the row writes that empty it.
 *
 * **The Backlog is a query over rows braintrust already has, not a queue.** Four
 * things want to be long-running jobs — the first backfill, catching up, re-reading
 * the Corpus, and routine daily retrieval — and they are one job whose state is
 * already in the schema:
 *
 *   fetch a body   → braintrust_items.retrieval = 'pending'
 *   walk an archive → braintrust_sources.backfill_complete = false
 *
 * Which makes every long job resumable by construction. A run killed at minute 12 of
 * 26 has written twelve minutes of real rows, and the next run continues from them.
 * No job table, no checkpointing.
 *
 * See docs/design/ingestion.md §3.
 */

import type { Db } from '../db.js';
import { SHORT_MAX_SECONDS, type Audience, type Platform, type Retrieval } from '../sources/types.js';
import type { FeedEntry } from './feed.js';

export type SourceRow = {
  id: string;
  person_id: string;
  person: string;
  display_name: string;
  platform: Platform;
  handle: string;
  discovery_url: string;
  cursor_published_at: Date | null;
  backfill_floor: string;
  backfill_complete: boolean;
  exclude_shorts: boolean;
  poll_interval_hours: number;
  last_checked_at: Date | null;
  blocked_at: Date | null;
};

const SOURCE_COLUMNS = `
  s.id, s.person_id, p.slug as person, p.display_name,
  s.platform, s.handle, s.discovery_url, s.cursor_published_at,
  s.backfill_floor::text as backfill_floor, s.backfill_complete,
  s.exclude_shorts, s.poll_interval_hours, s.last_checked_at, s.blocked_at
`;

/**
 * Sources the job should touch on this run.
 *
 * Two filters, and they are different facts. A **paused** Person is the user's own
 * choice to stop, so nothing is ingested for them at all. And `poll_interval_hours`
 * decides whether a Source is *due* — it does not create a second scheduler; there is
 * one daily job and this is the question it asks each Source.
 *
 * **A blocked Source is due like any other, and that is the self-healing.** It is not
 * filtered out here, because the next day's single unchanged request is the whole
 * recovery mechanism and it has to come from somewhere. What a block suppresses is that
 * Source's *Backlog*, not its turn — see `probeSource` in the cycle, which spends
 * exactly one request on it and stops.
 */
export async function dueSources(db: Db, now: Date): Promise<SourceRow[]> {
  const { rows } = await db.query<SourceRow>(
    `select ${SOURCE_COLUMNS}
       from braintrust_sources s
       join braintrust_people p on p.id = s.person_id
      where p.paused_at is null
        and (
          s.last_checked_at is null
          or s.last_checked_at <= $1::timestamptz - make_interval(hours => s.poll_interval_hours)
        )
      order by p.slug, s.platform`,
    [now.toISOString()],
  );
  return rows;
}

/**
 * Every Source of one Person, due or not.
 *
 * `poll_interval_hours` exists to stop the daily job re-reading a feed it read this
 * morning. `braintrust_refresh_persona` is somebody asking *now*, so it has nothing to
 * decide here — and it is still not a second scheduler, because nothing about this
 * repeats.
 *
 * A blocked Source is still skipped. A block is measured rather than chosen, and a
 * refresh is not evidence that the source started answering again; the daily job finds
 * that out for itself. See docs/design/ingestion.md §5.
 */
export async function sourcesForPerson(db: Db, personId: string): Promise<SourceRow[]> {
  const { rows } = await db.query<SourceRow>(
    `select ${SOURCE_COLUMNS}
       from braintrust_sources s
       join braintrust_people p on p.id = s.person_id
      where s.person_id = $1
        and s.blocked_at is null
      order by s.platform`,
    [personId],
  );
  return rows;
}

/**
 * The Source has stopped serving braintrust. Measured by the caller, never judged from
 * a response code.
 *
 * `backfill_complete` is deliberately not touched. The Corpus genuinely *is* incomplete,
 * and the flag Coverage reads keeps telling the truth — it merely stops generating
 * requests, because a blocked Source's Backlog is suppressed.
 */
export async function blockSource(db: Db, sourceId: string, at: Date): Promise<void> {
  await db.query('update braintrust_sources set blocked_at = $2 where id = $1', [
    sourceId,
    at.toISOString(),
  ]);
}

/**
 * The Source answered. Normal work resumes on the next run.
 *
 * There is no backoff to reset and no identity to rotate: braintrust asked the same
 * question it was refused, from the same address, and got an answer.
 */
export async function clearBlock(db: Db, sourceId: string): Promise<void> {
  await db.query('update braintrust_sources set blocked_at = null where id = $1', [sourceId]);
}

/** Every Source of one Person, blocked ones included. Used to report, not to fetch. */
export async function allSourcesForPerson(db: Db, personId: string): Promise<SourceRow[]> {
  const { rows } = await db.query<SourceRow>(
    `select ${SOURCE_COLUMNS}
       from braintrust_sources s
       join braintrust_people p on p.id = s.person_id
      where s.person_id = $1
      order by s.platform`,
    [personId],
  );
  return rows;
}

/** Every Source of every Person who is not paused. Used to report, not to fetch. */
export async function activeSources(db: Db): Promise<SourceRow[]> {
  const { rows } = await db.query<SourceRow>(
    `select ${SOURCE_COLUMNS}
       from braintrust_sources s
       join braintrust_people p on p.id = s.person_id
      where p.paused_at is null
      order by p.slug, s.platform`,
  );
  return rows;
}

export type PollResult = {
  discovered: number;
  cursor: Date | null;
  reopenedBackfill: boolean;
};

/**
 * Records new Items from a feed and moves the cursor.
 *
 * `on conflict do nothing` is the whole dedup story: `unique (source_id, external_id)`
 * means a feed braintrust has already read costs one statement and writes nothing.
 * The returned ids are exactly the Items that are new, so "what arrived today" needs
 * no comparison step.
 */
export async function insertDiscovered(
  db: Db,
  source: SourceRow,
  entries: FeedEntry[],
  audience: Audience,
): Promise<string[]> {
  const inserted: string[] = [];

  for (const entry of entries) {
    const { rows } = await db.query<{ id: string }>(
      `insert into braintrust_items (source_id, external_id, url, title, published_at, audience)
       values ($1, $2, $3, $4, $5::date, $6)
       on conflict (source_id, external_id) do nothing
       returning id`,
      [
        source.id,
        entry.externalId,
        entry.url,
        entry.title ?? null,
        entry.publishedAt ? entry.publishedAt.toISOString().slice(0, 10) : null,
        audience,
      ],
    );
    if (rows[0]) inserted.push(rows[0].id);
  }

  return inserted;
}

export async function recordPoll(
  db: Db,
  source: SourceRow,
  options: { cursor?: Date | undefined; reopenBackfill: boolean; now: Date },
): Promise<void> {
  await db.query(
    `update braintrust_sources
        set last_checked_at = $2,
            -- Never backwards: the cursor records the newest thing braintrust has seen,
            -- and a feed that briefly drops an entry must not rewind it.
            cursor_published_at = greatest(cursor_published_at, $3::timestamptz),
            backfill_complete = case when $4 then false else backfill_complete end
      where id = $1`,
    [source.id, options.now.toISOString(), options.cursor?.toISOString() ?? null, options.reopenBackfill],
  );
}

export type ArchiveItem = {
  externalId: string;
  url: string;
  title?: string | undefined;
  publishedAt?: Date | undefined;
  audience: Audience;
  /**
   * Present when the catalogue happens to say how long the thing is — YouTube's
   * listing carries a duration badge. When it does, a Short is excluded here and
   * never reaches the expensive half at all.
   */
  durationSeconds?: number | undefined;
};

/**
 * Writes what a platform's catalogue says about an Item, including the paywall
 * decision — which is made **here, before any fetch**, because `audience` arrives with
 * the metadata.
 *
 * Two things are deliberately never undone. A `retrieved` Item is not demoted if it
 * later turns paid: ingested text is kept permanently (ADR 0003), and pretending
 * otherwise would make Coverage lie about what was read. A `failed` Item is not
 * resurrected: a terminal recorded outcome is not a pending item.
 *
 * The line those two sit on: **`failed` means the source declined or could not answer,
 * and everything braintrust *decided* is `skipped_<reason>`** — a row of its own,
 * carrying what would have to change, reopened when it changes. `skipped_short` and
 * `skipped_window` are both braintrust's own policy, so `reopenShorts` and
 * `reopenWindow` undo them when the operator changes their mind. Nothing a source
 * decided is revisited here.
 */
export async function recordCatalogued(db: Db, source: SourceRow, item: ArchiveItem): Promise<Retrieval> {
  const decided = decide(source, item);

  const { rows } = await db.query<{ retrieval: Retrieval }>(
    `insert into braintrust_items (source_id, external_id, url, title, published_at, audience, retrieval)
     values ($1, $2, $3, $4, $5::date, $6, $7)
     on conflict (source_id, external_id) do update
        set audience = excluded.audience,
            url = excluded.url,
            title = coalesce(braintrust_items.title, excluded.title),
            published_at = coalesce(braintrust_items.published_at, excluded.published_at),
            retrieval = case
              when braintrust_items.retrieval = 'pending' then excluded.retrieval
              else braintrust_items.retrieval
            end
     returning retrieval`,
    [
      source.id,
      item.externalId,
      item.url,
      item.title ?? null,
      item.publishedAt ? item.publishedAt.toISOString().slice(0, 10) : null,
      item.audience,
      decided,
    ],
  );

  return rows[0]!.retrieval;
}

/**
 * The pre-fetch filters, in the order they matter.
 *
 * The paywall comes first because it is a hard line and not braintrust's to weigh; the
 * Shorts rule comes second because it is a preference the operator owns. An Item whose
 * duration the catalogue did not mention is `pending`, and the Shorts rule gets its
 * second chance at retrieval, where the duration always arrives.
 */
function decide(source: SourceRow, item: ArchiveItem): Retrieval {
  if (item.audience !== 'everyone') return 'skipped_paywall';
  if (source.exclude_shorts && item.durationSeconds !== undefined && item.durationSeconds < SHORT_MAX_SECONDS) {
    return 'skipped_short';
  }
  return 'pending';
}

export async function completeBackfill(db: Db, source: SourceRow): Promise<void> {
  await db.query('update braintrust_sources set backfill_complete = true where id = $1', [source.id]);
}

export type PendingItem = {
  id: string;
  external_id: string;
  url: string;
  audience: Audience;
  published_at: string | null;
};

/**
 * The Backlog for one Source.
 *
 * Newest first, so a run that is interrupted has read the most recent half of someone's
 * work rather than an arbitrary half. `failed` is not here — Coverage reports it, and
 * one permanently unfetchable Item must not block every future Compile.
 */
export async function pendingItems(db: Db, sourceId: string): Promise<PendingItem[]> {
  const { rows } = await db.query<PendingItem>(
    `select id, external_id, url, audience, published_at::text as published_at
       from braintrust_items
      where source_id = $1 and retrieval = 'pending'
      order by published_at desc nulls last, external_id`,
    [sourceId],
  );
  return rows;
}

export async function storeBody(
  db: Db,
  itemId: string,
  body: { text: string; raw: unknown },
): Promise<void> {
  await db.query(
    `update braintrust_items
        set retrieval = 'retrieved', body_text = $2, body_raw = $3, retrieved_at = now()
      where id = $1`,
    [itemId, body.text, JSON.stringify(body.raw)],
  );
}

/** A skipped Item is a row, not an absence — it is what lets a Persona name its gaps. */
export async function markSkippedPaywall(db: Db, itemId: string): Promise<void> {
  await db.query(
    `update braintrust_items set retrieval = 'skipped_paywall' where id = $1 and retrieval = 'pending'`,
    [itemId],
  );
}

/**
 * Excluded by the Shorts rule, and the duration is kept so nothing has to ask again.
 *
 * `body_raw` rather than `body_text`: braintrust learned something about this Item
 * without reading it, and `body_text` is reserved for words that were actually
 * published.
 */
export async function markSkippedShort(
  db: Db,
  itemId: string,
  durationSeconds: number,
): Promise<void> {
  await db.query(
    `update braintrust_items
        set retrieval = 'skipped_short',
            body_raw = jsonb_build_object('platform', 'youtube', 'duration_seconds', $2::int)
      where id = $1 and retrieval = 'pending'`,
    [itemId, durationSeconds],
  );
}

/**
 * Older than the window the operator asked braintrust to read.
 *
 * The Item is in the feed and braintrust knows it exists; what it does not know is
 * whether the post is paid, because the archive walk stopped at the floor before
 * describing it, and the paywall allow-list means an undescribed Item is never fetched.
 *
 * That is **braintrust declining to look**, not a source declining to answer, so it is
 * a skip rather than a failure — which is the difference between a window an operator
 * can widen and a decision they cannot take back.
 */
export async function markSkippedWindow(db: Db, itemId: string): Promise<void> {
  await db.query(
    `update braintrust_items set retrieval = 'skipped_window' where id = $1 and retrieval = 'pending'`,
    [itemId],
  );
}

/**
 * Is this Item outside the window as the Source is configured *now*?
 *
 * An Item with no date is never outside it. braintrust would be guessing, and a guess
 * that lands here writes a reversible skip over what may be a real failure — so an
 * undated Item keeps whatever outcome the caller was going to record anyway.
 *
 * Both sides are `YYYY-MM-DD`, which orders correctly as text; `backfill_floor` is read
 * as `::text` for exactly this reason.
 */
export function outsideWindow(source: SourceRow, publishedAt: string | null): boolean {
  return publishedAt !== null && publishedAt < source.backfill_floor;
}

/**
 * **This is what makes `window_months` a setting rather than a one-way door**, and it
 * is the same sentence `reopenShorts` writes about `exclude_shorts`.
 *
 * There is no "the window widened" flag to thread through: the predicate *is* the
 * current floor, so a wider window reopens exactly the Items that came back into range
 * and a narrower one reopens nothing. Re-following with the same `window_months` moves
 * the floor forward as time passes, and this correctly does nothing then too.
 */
export async function reopenWindow(db: Db, sourceId: string, floor: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `update braintrust_items
        set retrieval = 'pending'
      where source_id = $1 and retrieval = 'skipped_window' and published_at >= $2::date
      returning id`,
    [sourceId, floor],
  );
  return rows.length;
}

/**
 * **This is what makes `exclude_shorts` a setting rather than a one-way door.**
 *
 * Turn it off and the Items braintrust declined to read become pending again on the
 * next run, with no second crawl and no lost rows — which is the whole reason a
 * policy skip is a state of its own instead of a `failed` row or an absent one.
 */
export async function reopenShorts(db: Db, sourceId: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `update braintrust_items
        set retrieval = 'pending', body_raw = null
      where source_id = $1 and retrieval = 'skipped_short'
      returning id`,
    [sourceId],
  );
  return rows.length;
}

/** The exact date, once a per-item fetch has found one the listing could not give. */
export async function recordPublished(db: Db, itemId: string, publishedAt: Date): Promise<void> {
  await db.query(
    `update braintrust_items set published_at = $2::date where id = $1 and published_at is null`,
    [itemId, publishedAt.toISOString().slice(0, 10)],
  );
}

export async function markFailed(db: Db, itemId: string): Promise<void> {
  await db.query(
    `update braintrust_items set retrieval = 'failed' where id = $1 and retrieval = 'pending'`,
    [itemId],
  );
}

export type CorpusCounts = {
  pending: number;
  retrieved: number;
  skipped_paywall: number;
  skipped_short: number;
  skipped_window: number;
  failed: number;
};

/** What a run has to show for itself, counted from the rows themselves. */
export async function corpusCounts(db: Db, sourceId?: string): Promise<CorpusCounts> {
  const { rows } = await db.query<Record<keyof CorpusCounts, string>>(
    `select count(*) filter (where retrieval = 'pending')         as pending,
            count(*) filter (where retrieval = 'retrieved')       as retrieved,
            count(*) filter (where retrieval = 'skipped_paywall') as skipped_paywall,
            count(*) filter (where retrieval = 'skipped_short')   as skipped_short,
            count(*) filter (where retrieval = 'skipped_window')  as skipped_window,
            count(*) filter (where retrieval = 'failed')          as failed
       from braintrust_items
      where ($1::uuid is null or source_id = $1::uuid)`,
    [sourceId ?? null],
  );

  const row = rows[0]!;
  return {
    pending: Number(row.pending),
    retrieved: Number(row.retrieved),
    skipped_paywall: Number(row.skipped_paywall),
    skipped_short: Number(row.skipped_short),
    skipped_window: Number(row.skipped_window),
    failed: Number(row.failed),
  };
}

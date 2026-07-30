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
import type { Audience, Platform, Retrieval } from '../sources/types.js';
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
 * Three filters, and each is a different fact. A **paused** Person is the user's own
 * choice to stop, so nothing is ingested for them at all. A **blocked** Source has
 * refused braintrust, and its Backlog is suppressed so it cannot sit in a permanent
 * repair loop. And `poll_interval_hours` decides whether a Source is *due* — it does
 * not create a second scheduler; there is one daily job and this is the question it
 * asks each Source.
 */
export async function dueSources(db: Db, now: Date): Promise<SourceRow[]> {
  const { rows } = await db.query<SourceRow>(
    `select ${SOURCE_COLUMNS}
       from braintrust_sources s
       join braintrust_people p on p.id = s.person_id
      where p.paused_at is null
        and s.blocked_at is null
        and (
          s.last_checked_at is null
          or s.last_checked_at <= $1::timestamptz - make_interval(hours => s.poll_interval_hours)
        )
      order by p.slug, s.platform`,
    [now.toISOString()],
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
 */
export async function recordCatalogued(db: Db, source: SourceRow, item: ArchiveItem): Promise<Retrieval> {
  const decided: Retrieval = item.audience === 'everyone' ? 'pending' : 'skipped_paywall';

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
  failed: number;
};

/** What a run has to show for itself, counted from the rows themselves. */
export async function corpusCounts(db: Db, sourceId?: string): Promise<CorpusCounts> {
  const { rows } = await db.query<Record<keyof CorpusCounts, string>>(
    `select count(*) filter (where retrieval = 'pending')         as pending,
            count(*) filter (where retrieval = 'retrieved')       as retrieved,
            count(*) filter (where retrieval = 'skipped_paywall') as skipped_paywall,
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
    failed: Number(row.failed),
  };
}

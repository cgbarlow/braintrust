/**
 * Notes, as rows — and therefore as Backlog.
 *
 *   an Item to read → retrieval = 'retrieved', has Chunks, and has no Note for the
 *                     configured extractor generation
 *
 * That is the whole of it. No job table, no checkpointing: a run killed after 200 of
 * 395 Items has written 200 Notes, and the next run asks the same question and gets a
 * shorter answer. **Bumping the prompt version changes the generation, so the same
 * query becomes the whole Corpus again** — a resumable re-read rather than a migration,
 * with the previous generation still readable and the Persona built from it still live.
 *
 * The Chunks are a precondition rather than an incidental: a claim carries the Chunk its
 * quote came from, so an Item that has not been chunked cannot yet be read.
 *
 * See docs/design/compiler.md §1 and docs/design/schema.md.
 */

import type { Db } from '../db.js';
import type { ChunkSpan, VerifiedClaim } from './verify.js';

export type ReadableItem = {
  id: string;
  external_id: string;
  title: string | null;
  body_text: string;
};

/**
 * Items owed a Note under this generation. Newest first, so a first read that is
 * interrupted has covered the most recent half of someone's work.
 */
export async function unreadItems(db: Db, extractor: string, limit: number): Promise<ReadableItem[]> {
  const { rows } = await db.query<ReadableItem>(
    `select i.id, i.external_id, i.title, i.body_text
       from braintrust_items i
      where i.retrieval = 'retrieved'
        and i.body_text is not null
        and exists (select 1 from braintrust_chunks c where c.item_id = i.id)
        and not exists (
          select 1 from braintrust_item_notes n where n.item_id = i.id and n.extractor = $1
        )
      order by i.published_at desc nulls last, i.external_id
      limit $2`,
    [extractor, limit],
  );
  return rows;
}

/** The spans a quote is located against, in the order a citation should prefer them. */
export async function chunkSpans(db: Db, itemId: string): Promise<ChunkSpan[]> {
  const { rows } = await db.query<ChunkSpan>(
    `select id, char_start, char_end, start_ms
       from braintrust_chunks where item_id = $1 order by ordinal`,
    [itemId],
  );
  return rows;
}

export type NoteRow = {
  claims: VerifiedClaim[];
  argument: string;
  assumptions: string[];
};

/**
 * Writes one Note. `on conflict do nothing` rather than an update: a generation is
 * immutable by construction, and two runs overlapping is a wasted call rather than a
 * reason to overwrite what the first one read.
 */
export async function writeNote(
  db: Db,
  itemId: string,
  extractor: string,
  note: NoteRow,
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `insert into braintrust_item_notes (item_id, extractor, claims, argument_md, assumptions)
     values ($1, $2, $3::jsonb, $4, $5::jsonb)
     on conflict (item_id, extractor) do nothing
     returning id`,
    [
      itemId,
      extractor,
      JSON.stringify(note.claims),
      note.argument === '' ? null : note.argument,
      JSON.stringify(note.assumptions),
    ],
  );
  return rows.length > 0;
}

export type StoredNote = {
  item_id: string;
  external_id: string;
  title: string | null;
  published_at: string | null;
  claims: VerifiedClaim[];
  argument_md: string | null;
  assumptions: string[];
};

/**
 * Everything a Compile reads about one Person — Notes, not 1.17M words of transcript.
 *
 * `extractor` is a required argument and not a default, which is how "a Compile
 * declares which generation it reads" is enforced in code rather than remembered: there
 * is no way to call this without saying which generation the Persona is built from.
 */
export async function notesFor(db: Db, personId: string, extractor: string): Promise<StoredNote[]> {
  const { rows } = await db.query<StoredNote>(
    `select n.item_id, i.external_id, i.title, i.published_at::text as published_at,
            n.claims, n.argument_md, n.assumptions
       from braintrust_item_notes n
       join braintrust_items i on i.id = n.item_id
       join braintrust_sources s on s.id = i.source_id
      where s.person_id = $1 and n.extractor = $2
      order by i.published_at desc nulls last, i.external_id`,
    [personId, extractor],
  );
  return rows;
}

export type NoteCounts = {
  items_to_read: number;
  notes: number;
  claims: number;
};

/** What the read pass has and still owes, counted from the rows themselves. */
export async function noteCounts(db: Db, extractor: string): Promise<NoteCounts> {
  const { rows } = await db.query<Record<keyof NoteCounts, string>>(
    `select
       (select count(*) from braintrust_items i
         where i.retrieval = 'retrieved' and i.body_text is not null
           and exists (select 1 from braintrust_chunks c where c.item_id = i.id)
           and not exists (
             select 1 from braintrust_item_notes n where n.item_id = i.id and n.extractor = $1
           )) as items_to_read,
       (select count(*) from braintrust_item_notes where extractor = $1) as notes,
       (select coalesce(sum(jsonb_array_length(claims)), 0)
          from braintrust_item_notes where extractor = $1) as claims`,
    [extractor],
  );

  const row = rows[0]!;
  return {
    items_to_read: Number(row.items_to_read),
    notes: Number(row.notes),
    claims: Number(row.claims),
  };
}

/** Which generations exist here. Two coexist while a prompt upgrade re-reads. */
export async function extractorGenerations(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ extractor: string }>(
    'select distinct extractor from braintrust_item_notes order by extractor',
  );
  return rows.map((row) => row.extractor);
}

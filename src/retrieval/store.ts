/**
 * The retrieval index, as rows — and therefore as Backlog.
 *
 * Chunking and embedding are ordinary Backlog work, which in braintrust means they are
 * a query over rows that already exist rather than a job with state:
 *
 *   an Item to chunk   → retrieval = 'retrieved' with no rows in braintrust_chunks
 *   a Chunk to embed   → no row in braintrust_embeddings for the configured model
 *
 * So a run killed halfway has written half the rows and the next run asks the same two
 * questions and gets a shorter answer. No job table, no checkpointing — the same
 * property the fetch half of the Backlog has, for the same reason.
 *
 * **Nothing here deletes.** A model swap adds rows under a second `model`; the first
 * model's vectors stay, which is what keeps the previous Persona answerable while a
 * re-index runs.
 *
 * See docs/design/compiler.md §6–7 and docs/design/schema.md.
 */

import type { Db, TransactionalDb } from '../db.js';
import { BraintrustError } from '../errors.js';
import type { Chunk } from './chunk.js';
import { vectorLiteral } from './embed.js';

export type UnchunkedItem = {
  id: string;
  external_id: string;
  body_text: string;
  body_raw: unknown;
};

/**
 * Retrieved Items with no Chunks. Newest first, so an interrupted first index has
 * covered the most recent half of someone's work rather than an arbitrary half.
 */
export async function unchunkedItems(db: Db, limit: number): Promise<UnchunkedItem[]> {
  const { rows } = await db.query<UnchunkedItem>(
    `select i.id, i.external_id, i.body_text, i.body_raw
       from braintrust_items i
      where i.retrieval = 'retrieved'
        and i.body_text is not null
        and not exists (select 1 from braintrust_chunks c where c.item_id = i.id)
      order by i.published_at desc nulls last, i.external_id
      limit $1`,
    [limit],
  );
  return rows;
}

/**
 * Writes one Item's Chunks in a transaction, so an Item is either chunked or not
 * chunked. A half-chunked Item would look chunked to `unchunkedItems` and never be
 * finished — the one place where "resumable by construction" needs a transaction to
 * stay true.
 *
 * The delete is for a deliberate re-chunk. In the ordinary pass there is nothing to
 * delete, because having no Chunks is what put the Item in the Backlog.
 */
export async function writeChunks(db: TransactionalDb, itemId: string, chunks: Chunk[]): Promise<number> {
  if (chunks.length === 0) return 0;

  await db.transaction(async (tx) => {
    await tx.query('delete from braintrust_chunks where item_id = $1', [itemId]);

    for (const chunk of chunks) {
      await tx.query(
        `insert into braintrust_chunks (item_id, ordinal, text, char_start, char_end, start_ms, end_ms)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [itemId, chunk.ordinal, chunk.text, chunk.charStart, chunk.charEnd, chunk.startMs, chunk.endMs],
      );
    }
  });

  return chunks.length;
}

export type UnembeddedChunk = { id: string; text: string };

/** Chunks with no vector under this model. The second half of the Backlog query. */
export async function unembeddedChunks(db: Db, model: string, limit: number): Promise<UnembeddedChunk[]> {
  const { rows } = await db.query<UnembeddedChunk>(
    `select c.id, c.text
       from braintrust_chunks c
      where not exists (
        select 1 from braintrust_embeddings e where e.chunk_id = c.id and e.model = $1
      )
      order by c.item_id, c.ordinal
      limit $2`,
    [model, limit],
  );
  return rows;
}

/**
 * Stores a batch's vectors. `on conflict do nothing` because two runs overlapping is a
 * waste of a request, not a corruption — the row is keyed by chunk *and* model.
 */
export async function storeEmbeddings(
  db: Db,
  model: string,
  vectors: { chunkId: string; vector: number[] }[],
): Promise<number> {
  let written = 0;

  for (const { chunkId, vector } of vectors) {
    const { rows } = await db.query<{ chunk_id: string }>(
      `insert into braintrust_embeddings (chunk_id, model, embedding)
       values ($1, $2, $3::vector)
       on conflict (chunk_id, model) do nothing
       returning chunk_id`,
      [chunkId, model, vectorLiteral(vector)],
    );
    written += rows.length;
  }

  return written;
}

/**
 * The dimension the `embedding` column was actually created with, read from the
 * catalogue rather than assumed.
 *
 * pgvector needs a fixed dimension to build an index, so this number is a property of
 * the database an operator stood up — `schema.sql` says which line to change. Reading
 * it beats hard-coding 1024 here and disagreeing with them silently.
 */
export async function declaredDimension(db: Db): Promise<number> {
  const { rows } = await db.query<{ declared: string | null }>(
    `select format_type(a.atttypid, a.atttypmod) as declared
       from pg_attribute a
      where a.attrelid = 'braintrust_embeddings'::regclass
        and a.attname = 'embedding'
        and not a.attisdropped`,
  );

  const declared = rows[0]?.declared ?? '';
  const dimension = Number(/vector\((\d+)\)/.exec(declared)?.[1]);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new BraintrustError(
      'braintrust could not read the declared width of braintrust_embeddings.embedding ' +
        `(found "${declared || 'nothing'}"). Has schema.sql been run against this database?`,
    );
  }

  return dimension;
}

/** Which models have vectors here. Empty on a database nothing has been embedded into. */
export async function embeddedModels(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ model: string }>(
    'select distinct model from braintrust_embeddings order by model',
  );
  return rows.map((row) => row.model);
}

export type IndexCounts = {
  items_to_chunk: number;
  chunks: number;
  chunks_to_embed: number;
};

/** What the index has and still owes, counted from the rows themselves. */
export async function indexCounts(db: Db, model: string): Promise<IndexCounts> {
  const { rows } = await db.query<Record<keyof IndexCounts, string>>(
    `select
       (select count(*) from braintrust_items i
         where i.retrieval = 'retrieved' and i.body_text is not null
           and not exists (select 1 from braintrust_chunks c where c.item_id = i.id))
         as items_to_chunk,
       (select count(*) from braintrust_chunks) as chunks,
       (select count(*) from braintrust_chunks c
         where not exists (
           select 1 from braintrust_embeddings e where e.chunk_id = c.id and e.model = $1
         )) as chunks_to_embed`,
    [model],
  );

  const row = rows[0]!;
  return {
    items_to_chunk: Number(row.items_to_chunk),
    chunks: Number(row.chunks),
    chunks_to_embed: Number(row.chunks_to_embed),
  };
}

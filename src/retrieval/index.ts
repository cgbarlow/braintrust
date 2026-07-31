/**
 * The indexing pass, and the two checks that stand between a misconfigured endpoint and
 * a silently wrong index.
 *
 * A user-supplied embeddings endpoint introduces two ways to corrupt retrieval without
 * anything erroring, and neither is recoverable after the fact:
 *
 *  1. A **differently-sized** model. pgvector rejects the insert, so this one at least
 *     fails — but it fails 400 times in a cron log at 3am rather than once at startup.
 *  2. A **same-sized, different** model. This one does not fail at all. Cosine
 *     similarity across model families is meaningless even when the dimensions match,
 *     so every search returns confidently-ranked nonsense.
 *
 * Refusing is the only honest response to the second, and it is what makes swapping
 * models safe rather than merely reversible.
 *
 * See docs/design/deployment.md §3 and docs/design/compiler.md §7.
 */

import type { Db, TransactionalDb } from '../db.js';
import { BraintrustError } from '../errors.js';
import { chunkItem } from './chunk.js';
import { EMBED_BATCH, PROBE_TEXT, type Embedder } from './embed.js';
import {
  declaredDimension,
  embeddedModels,
  storeEmbeddings,
  unchunkedItems,
  unembeddedChunks,
  writeChunks,
} from './store.js';

export * from './chunk.js';
export * from './embed.js';
export * from './store.js';

/** How many Items are pulled at once. Bodies are large; this keeps memory boring. */
const CHUNK_PAGE = 20;

/**
 * **Startup check 1: embed a probe string and compare its length to the column.**
 *
 * Throws rather than returning a flag, because there is no useful degraded mode: an
 * endpoint whose vectors do not fit the column cannot write and must not read.
 */
export async function checkDimension(db: Db, embedder: Embedder): Promise<number> {
  const declared = await declaredDimension(db);
  const [probe] = await embedder.embed([PROBE_TEXT]);

  if (!probe) {
    throw new BraintrustError(
      `The embeddings endpoint at ${embedder.url} returned nothing for a one-line probe.`,
    );
  }

  if (probe.length !== declared) {
    throw new BraintrustError(
      `The embeddings endpoint returns ${probe.length}-dimension vectors and ` +
        `braintrust_embeddings.embedding is vector(${declared}).\n\n` +
        `  model     ${embedder.model}\n` +
        `  endpoint  ${embedder.url}\n\n` +
        'Change the dimension at the top of schema.sql to ' +
        `${probe.length} and re-embed, or point BRAINTRUST_EMBEDDINGS_MODEL at a ` +
        `${declared}-dimension model. braintrust refuses to start rather than write ` +
        'vectors the column cannot hold.',
    );
  }

  return declared;
}

export type QueryReadiness = { ready: boolean; reason?: string };

/**
 * **Startup check 2: does the configured model have any vectors here?**
 *
 * Three states, and the middle one is the whole reason this check exists. A database
 * with vectors under *other* models is a model that was swapped without a re-embed —
 * the silent failure. A database with none at all is simply new, and saying so is more
 * useful than reporting a corruption that has not happened.
 */
export async function checkModelPresent(db: Db, model: string): Promise<QueryReadiness> {
  const models = await embeddedModels(db);

  if (models.includes(model)) return { ready: true };

  if (models.length === 0) {
    return {
      ready: false,
      reason:
        `Nothing has been embedded yet, so there is nothing to search. The scheduled job ` +
        `chunks and embeds as it ingests; questions about a Person work once their first ` +
        `run has finished. Configured model: ${model}.`,
    };
  }

  return {
    ready: false,
    reason:
      `braintrust is configured for "${model}", and every vector in this database belongs ` +
      `to ${models.map((name) => `"${name}"`).join(', ')}. Cosine similarity across model ` +
      'families is meaningless even when the dimensions match, so braintrust will not ' +
      'answer questions until the corpus is re-embedded under the configured model — the ' +
      'next scheduled run does it, and the old vectors are kept rather than migrated.',
  };
}

export type QueryGate = { model: string; check(): Promise<QueryReadiness> };

/**
 * Check 2, asked repeatedly rather than once at boot.
 *
 * The unready states are both temporary — a first backfill finishes, a re-embed
 * finishes — and the daily job is what ends them, in the other deployment. Caching a
 * refusal until someone restarts the web service would turn "wait for the first run" into
 * "wait for the first run, then notice, then restart". Readiness is cached once true,
 * because it cannot become false again: `model` is in the primary key, so vectors under
 * a model are never removed by anything that adds another model's.
 */
export function createQueryGate(db: Db, model: string): QueryGate {
  let ready = false;

  return {
    model,
    async check(): Promise<QueryReadiness> {
      if (ready) return { ready: true };
      const readiness = await checkModelPresent(db, model);
      ready = readiness.ready;
      return readiness;
    },
  };
}

export type IndexDeps = {
  db: TransactionalDb;
  /** Absent means chunk only. Chunking is local and free; embedding needs the endpoint. */
  embedder?: Embedder | undefined;
  /** One Person's Items, by id. Absent is the daily job: the whole Corpus. */
  person?: string | undefined;
  stopping?: (() => boolean) | undefined;
  log?: ((line: string) => void) | undefined;
};

export type IndexReport = {
  items_chunked: number;
  chunks_written: number;
  chunks_embedded: number;
  model?: string;
  stopped_early: boolean;
  error?: string;
};

/**
 * Chunk everything retrieved, then embed everything chunked.
 *
 * Corpus-wide rather than per-Source, because a Chunk belongs to an Item and neither
 * step cares which platform the words came from — that is what "one path for everything
 * after the boundary detector" means in practice.
 */
export async function indexCorpus(deps: IndexDeps): Promise<IndexReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const stopping = deps.stopping ?? (() => false);

  const report: IndexReport = {
    items_chunked: 0,
    chunks_written: 0,
    chunks_embedded: 0,
    stopped_early: false,
    ...(deps.embedder ? { model: deps.embedder.model } : {}),
  };

  try {
    await chunkPass(deps.db, deps.person, report, stopping, log);
    if (deps.embedder) await embedPass(deps.db, deps.embedder, deps.person, report, stopping);
    else if (report.chunks_written > 0) {
      log('braintrust: no embeddings endpoint for this run, so the new chunks are unembedded.');
    }
  } catch (error) {
    // The rows already written are real. An endpoint that went away mid-run costs this
    // run's remainder and nothing else, so it is reported rather than thrown.
    report.error = error instanceof BraintrustError ? error.message : String(error);
  }

  if (stopping()) report.stopped_early = true;
  return report;
}

async function chunkPass(
  db: TransactionalDb,
  person: string | undefined,
  report: IndexReport,
  stopping: () => boolean,
  log: (line: string) => void,
): Promise<void> {
  // An Item that yields no chunks would be handed back by the same query forever.
  // Remembering what this run has already tried is what makes the loop terminate.
  const attempted = new Set<string>();

  while (!stopping()) {
    const items = (await unchunkedItems(db, CHUNK_PAGE, person)).filter((item) => !attempted.has(item.id));
    if (items.length === 0) return;

    for (const item of items) {
      if (stopping()) return;
      attempted.add(item.id);

      const chunks = chunkItem({ text: item.body_text, raw: item.body_raw });
      if (chunks.length === 0) {
        log(
          `braintrust: ${item.external_id} is retrieved but has no text to chunk. Left ` +
            'unchunked rather than indexed as an empty passage.',
        );
        continue;
      }

      report.chunks_written += await writeChunks(db, item.id, chunks);
      report.items_chunked += 1;
    }
  }
}

async function embedPass(
  db: Db,
  embedder: Embedder,
  person: string | undefined,
  report: IndexReport,
  stopping: () => boolean,
): Promise<void> {
  while (!stopping()) {
    const batch = await unembeddedChunks(db, embedder.model, EMBED_BATCH, person);
    if (batch.length === 0) return;

    const vectors = await embedder.embed(batch.map((chunk) => chunk.text));
    const written = await storeEmbeddings(
      db,
      embedder.model,
      batch.map((chunk, position) => ({ chunkId: chunk.id, vector: vectors[position]! })),
    );

    // Nothing written for a full batch means something upstream is lying about what is
    // missing. Stopping beats spinning on the same rows until the cron job is killed.
    if (written === 0) return;
    report.chunks_embedded += written;
  }
}

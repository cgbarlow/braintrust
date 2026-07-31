/**
 * The rows a Compile reads and the rows it writes — including the one transaction that
 * makes a Persona replaceable without a moment where it is neither.
 *
 * A Persona has no independent existence: it is the layers hanging off the one Compile
 * whose status is `current`, and `on delete cascade` is the entire cleanup story. There
 * is nothing to reconcile and nothing that can leak, which is what lets a rebuild be a
 * replacement rather than an edit — and therefore what stops a Persona drifting from the
 * evidence it was built from.
 *
 * See docs/design/schema.md — "Rebuilding" — and docs/design/compiler.md §5.
 */

import type { Db, TransactionalDb } from '../db.js';
import type { CoverageEvidence, SourceCoverage } from './coverage.js';
import type { MeasuredItem } from './voice.js';

export type CompilablePerson = {
  id: string;
  slug: string;
  display_name: string;
  /** Null when this Person has never been compiled. New content is not the only trigger. */
  compiled_at: string | null;
};

/**
 * Everyone the compiler may build. A paused Person is excluded here rather than skipped
 * later: unfollowing means the Persona freezes at its last Compile, so rebuilding one
 * would quietly undo the user's own decision.
 */
export async function compilablePeople(db: Db): Promise<CompilablePerson[]> {
  const { rows } = await db.query<CompilablePerson>(
    `select p.id, p.slug, p.display_name, c.finished_at::text as compiled_at
       from braintrust_people p
       left join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.paused_at is null
      order by p.slug`,
  );
  return rows;
}

/**
 * Every Item the measured layers are counted over, oldest first — which is what makes
 * "exemplars spread across the window" mean anything.
 */
export async function measurableItems(db: Db, personId: string): Promise<MeasuredItem[]> {
  const { rows } = await db.query<MeasuredItem>(
    `select i.external_id, i.url, i.published_at::text as published_at, i.body_text
       from braintrust_items i
       join braintrust_sources s on s.id = i.source_id
      where s.person_id = $1 and i.retrieval = 'retrieved' and i.body_text is not null
      order by i.published_at asc nulls first, i.external_id`,
    [personId],
  );
  return rows;
}

/**
 * What is still owed before a Persona should be rebuilt.
 *
 * **Vectors are deliberately not in this list.** The Core is measured over Item text and
 * synthesised from Notes; nothing in it reads an embedding. Blocking a rebuild on the
 * index would hand an embeddings endpoint that is switched off a veto over the two
 * layers that cost nothing to compute — and the whole reason chunking survives an
 * endpoint being off is that the vectors are allowed to wait. Position retrieval is what
 * needs them, and that is a serve-time concern.
 */
export type BacklogOwed = {
  to_retrieve: number;
  to_chunk: number;
  to_read: number;
};

export async function backlogOwed(db: Db, personId: string, extractor: string): Promise<BacklogOwed> {
  const { rows } = await db.query<Record<keyof BacklogOwed, string>>(
    `select
       (select count(*) from braintrust_items i
          join braintrust_sources s on s.id = i.source_id
         where s.person_id = $1 and i.retrieval = 'pending') as to_retrieve,
       (select count(*) from braintrust_items i
          join braintrust_sources s on s.id = i.source_id
         where s.person_id = $1 and i.retrieval = 'retrieved' and i.body_text is not null
           and not exists (select 1 from braintrust_chunks c where c.item_id = i.id)) as to_chunk,
       (select count(*) from braintrust_items i
          join braintrust_sources s on s.id = i.source_id
         where s.person_id = $1 and i.retrieval = 'retrieved' and i.body_text is not null
           and exists (select 1 from braintrust_chunks c where c.item_id = i.id)
           and not exists (
             select 1 from braintrust_item_notes n where n.item_id = i.id and n.extractor = $2
           )) as to_read`,
    [personId, extractor],
  );

  const row = rows[0]!;
  return {
    to_retrieve: Number(row.to_retrieve),
    to_chunk: Number(row.to_chunk),
    to_read: Number(row.to_read),
  };
}

type CoverageRow = {
  platform: string;
  handle: string;
  backfill_complete: boolean;
  blocked_at: Date | null;
  retrieved: string;
  skipped_paywall: string;
  skipped_short: string;
  failed: string;
  pending: string;
  words_retrieved: string;
  first_published: string | null;
  last_published: string | null;
};

/**
 * Coverage is a query, not a table. Counting the same rows the ingest wrote means the
 * layer cannot drift from them, and it is why `skipped_paywall` had to be a row rather
 * than an absence: a Persona can only state a blind spot braintrust recorded having.
 *
 * Words are counted the same way the voice measurement counts them — whitespace-separated
 * tokens of the stored body — so the two layers cannot disagree about the size of the
 * Corpus they describe.
 */
export async function measureCoverage(db: Db, personId: string): Promise<CoverageEvidence> {
  const { rows } = await db.query<CoverageRow>(
    `select s.platform, s.handle, s.backfill_complete, s.blocked_at,
            count(i.id) filter (where i.retrieval = 'retrieved')::text        as retrieved,
            count(i.id) filter (where i.retrieval = 'skipped_paywall')::text  as skipped_paywall,
            count(i.id) filter (where i.retrieval = 'skipped_short')::text    as skipped_short,
            count(i.id) filter (where i.retrieval = 'failed')::text           as failed,
            count(i.id) filter (where i.retrieval = 'pending')::text          as pending,
            coalesce(sum(array_length(regexp_split_to_array(btrim(i.body_text), '\\s+'), 1))
                       filter (where i.retrieval = 'retrieved' and i.body_text is not null), 0)::text
                                                                              as words_retrieved,
            min(i.published_at) filter (where i.retrieval = 'retrieved')::text as first_published,
            max(i.published_at) filter (where i.retrieval = 'retrieved')::text as last_published
       from braintrust_sources s
       left join braintrust_items i on i.source_id = s.id
      where s.person_id = $1
      group by s.id, s.platform, s.handle, s.backfill_complete, s.blocked_at
      order by s.platform, s.handle`,
    [personId],
  );

  const by_source: Record<string, SourceCoverage> = {};
  const totals = { retrieved: 0, skipped_paywall: 0, skipped_short: 0, failed: 0, pending: 0, words: 0 };
  const dates: string[] = [];

  for (const row of rows) {
    const source: SourceCoverage = {
      platform: row.platform,
      handle: row.handle,
      retrieved: Number(row.retrieved),
      skipped_paywall: Number(row.skipped_paywall),
      skipped_short: Number(row.skipped_short),
      failed: Number(row.failed),
      pending: Number(row.pending),
      words_retrieved: Number(row.words_retrieved),
      window:
        row.first_published && row.last_published ? [row.first_published, row.last_published] : null,
      backfill_complete: row.backfill_complete,
      ...(row.blocked_at ? { blocked_since: row.blocked_at.toISOString().slice(0, 10) } : {}),
    };

    by_source[`${row.platform}:${row.handle}`] = source;
    totals.retrieved += source.retrieved;
    totals.skipped_paywall += source.skipped_paywall;
    totals.skipped_short += source.skipped_short;
    totals.failed += source.failed;
    totals.pending += source.pending;
    totals.words += source.words_retrieved;
    if (source.window) dates.push(source.window[0], source.window[1]);
  }

  dates.sort();

  return {
    window: dates.length > 0 ? [dates[0]!, dates[dates.length - 1]!] : null,
    retrieved: totals.retrieved,
    skipped_paywall: totals.skipped_paywall,
    skipped_short: totals.skipped_short,
    failed: totals.failed,
    pending: totals.pending,
    words_retrieved: totals.words,
    by_source,
  };
}

export type RunningCompile = { id: string; started_at: string };

export async function runningCompile(db: Db, personId: string): Promise<RunningCompile | undefined> {
  const { rows } = await db.query<RunningCompile>(
    `select id, started_at::text as started_at
       from braintrust_compiles where person_id = $1 and status = 'running'`,
    [personId],
  );
  return rows[0];
}

/**
 * Opens a Compile and commits it, so the `running` partial unique index is visible to
 * anyone else who tries. That visibility is the point: it is what refuses a second
 * rebuild rather than duplicating one, and it is why the whole Compile is not wrapped in
 * a single transaction — the inferred layers call a model, and holding a connection open
 * across minutes of network calls to buy a guarantee the promotion already provides
 * would be a bad trade.
 */
export async function beginCompile(
  db: Db,
  personId: string,
  compilerVersion: string,
  extractor: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into braintrust_compiles (person_id, compiler_version, extractor, status)
     values ($1, $2, $3, 'running') returning id`,
    [personId, compilerVersion, extractor],
  );
  return rows[0]!.id;
}

/**
 * A `running` Compile whose process died has no owner and no way to finish, and left
 * alone it would lock this Person out of ever being rebuilt again — a crash on a Tuesday
 * becoming a permanently frozen Persona. Recorded as failed with the reason, so the row
 * survives for inspection and the daily clock is the recovery mechanism.
 */
export async function abandonStale(db: Db, personId: string, olderThan: Date): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `update braintrust_compiles
        set status = 'failed', finished_at = now(),
            rejected_reason = 'abandoned: still running when a later compile started, so its process is gone'
      where person_id = $1 and status = 'running' and started_at < $2
      returning id`,
    [personId, olderThan.toISOString()],
  );
  return rows.length;
}

/** Both statuses answer the same question — why this is not the Persona — so both use the column. */
export async function failCompile(db: Db, compileId: string, reason: string): Promise<void> {
  await db.query(
    `update braintrust_compiles set status = 'failed', finished_at = now(), rejected_reason = $2
      where id = $1`,
    [compileId, reason],
  );
}

export type WritableLayer = {
  layer: 'voice' | 'reasoning' | 'beliefs' | 'coverage';
  basis: 'measured' | 'inferred';
  descriptive_md: string;
  generative_md?: string | undefined;
  evidence: unknown;
};

export async function writeLayer(db: Db, compileId: string, layer: WritableLayer): Promise<void> {
  await db.query(
    `insert into braintrust_persona_layers
       (compile_id, layer, basis, descriptive_md, generative_md, evidence)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      compileId,
      layer.layer,
      layer.basis,
      layer.descriptive_md,
      layer.generative_md ?? null,
      JSON.stringify(layer.evidence),
    ],
  );
}

/**
 * The promotion. One transaction: the previous Persona is deleted and the new one takes
 * its place, and there is no instant in which a client can observe neither.
 *
 * The `status = 'running'` clause on the update is not decoration. If this Compile was
 * abandoned as stale while it ran, the update matches nothing, the throw rolls the
 * delete back, and the Persona that was already there stays live — which is the correct
 * outcome, because the row that took over is the one still doing the work.
 */
export async function promote(
  db: TransactionalDb,
  personId: string,
  compileId: string,
  corpusStats: unknown,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`delete from braintrust_compiles where person_id = $1 and status = 'current'`, [
      personId,
    ]);
    const { rows } = await tx.query<{ id: string }>(
      `update braintrust_compiles
          set status = 'current', finished_at = now(), corpus_stats = $2::jsonb
        where id = $1 and status = 'running'
        returning id`,
      [compileId, JSON.stringify(corpusStats)],
    );
    if (rows.length === 0) {
      throw new Error(
        `compile ${compileId} was no longer running when it tried to promote; nothing was replaced`,
      );
    }
  });
}

export type LoadedLayer = {
  layer: string;
  basis: string;
  descriptive_md: string;
  generative_md: string | null;
  evidence: unknown;
};

export type LoadedPersona = {
  display_name: string;
  /** A Date, not a string: the boundary renders it ISO 8601, as every other tool does. */
  compiled_at: Date | null;
  compiler_version: string;
  extractor: string | null;
  layers: LoadedLayer[];
};

/**
 * The read path. One join, no assembly step: serving the Core is reading the layer rows
 * of the current Compile. Returns undefined for a Person who has never been compiled,
 * which the caller turns into a refusal rather than into a compile.
 */
export async function loadCurrent(db: Db, slug: string): Promise<LoadedPersona | undefined> {
  const { rows } = await db.query<{
    display_name: string;
    compiled_at: Date | null;
    compiler_version: string;
    extractor: string | null;
    layer: string | null;
    basis: string | null;
    descriptive_md: string | null;
    generative_md: string | null;
    evidence: unknown;
  }>(
    `select p.display_name, c.finished_at as compiled_at, c.compiler_version, c.extractor,
            l.layer, l.basis, l.descriptive_md, l.generative_md, l.evidence
       from braintrust_people p
       join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
       left join braintrust_persona_layers l on l.compile_id = c.id
      where p.slug = $1
      order by l.layer`,
    [slug],
  );

  const first = rows[0];
  if (!first) return undefined;

  return {
    display_name: first.display_name,
    compiled_at: first.compiled_at,
    compiler_version: first.compiler_version,
    extractor: first.extractor,
    layers: rows
      .filter((row) => row.layer !== null)
      .map((row) => ({
        layer: row.layer!,
        basis: row.basis!,
        descriptive_md: row.descriptive_md!,
        generative_md: row.generative_md,
        evidence: row.evidence,
      })),
  };
}

/** Whether a slug names anyone at all — a different failure from never having compiled. */
export async function personExists(db: Db, slug: string): Promise<boolean> {
  const { rows } = await db.query<{ slug: string }>(
    'select slug from braintrust_people where slug = $1',
    [slug],
  );
  return rows.length > 0;
}

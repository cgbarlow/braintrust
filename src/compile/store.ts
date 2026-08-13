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
import { subjectFor } from '../disclosure.js';
import { nothingMatched, RETRIEVAL_FLOOR } from '../find.js';
import { renderScript, scriptInputFrom } from '../script.js';
import type { CoverageEvidence, SourceCoverage } from './coverage.js';
import { VOICE_MIN_WORDS } from './voice.js';
import type { GateFacts, GateLayer, ItemCounts } from './gate.js';
import type { BuiltPosition } from './positions.js';
import type { StuckRebuildEvidence } from '../script.js';
import type { ThroughLine } from './throughlines.js';
import type { MeasuredItem } from './voice.js';

export type CompilablePerson = {
  id: string;
  slug: string;
  display_name: string;
  /** Null when this Person has never been compiled. New content is not the only trigger. */
  compiled_at: string | null;
  /** Whether anything the compiler reads is newer than the Persona currently answering. */
  has_unseen: boolean;
  /**
   * Whether the Persona currently answering was built by a different compiler than this
   * run is. The second half of staleness: a Persona can be perfectly current with what
   * someone published and out of date with what braintrust can now do with it.
   */
  stale_compiler: boolean;
};

/**
 * Everyone the compiler may build. A paused Person is excluded here rather than skipped
 * later: unfollowing means the Persona freezes at its last Compile, so rebuilding one
 * would quietly undo the user's own decision.
 *
 * **`has_unseen` is what makes new content the trigger rather than the clock**, and it
 * is a fact in the rows rather than a tally the run carries. That distinction is the
 * whole point. A run that discovers nothing can still be the run that finishes work:
 * yesterday's run was killed with a backlog, or the extractor was down and the Notes
 * were only written this morning. Asking "did anything happen *today*" would leave that
 * Persona stale until the person next published — the rebuild waiting on news that has
 * nothing to do with what it is waiting for.
 *
 * Three ways to be unseen, and between them they cover everything a Compile reads:
 *
 * - never compiled at all;
 * - an Item created or retrieved since. A status change needs no timestamp of its own,
 *   because a Compile only happens with an empty Backlog — so an Item that was pending
 *   at any point after the last one must have been created after it too;
 * - a Note written since, which is the case a fetch count cannot see.
 */
export async function compilablePeople(
  db: Db,
  compilerVersion: string,
  person?: string | undefined,
): Promise<CompilablePerson[]> {
  const { rows } = await db.query<CompilablePerson>(
    `select p.id, p.slug, p.display_name, c.finished_at::text as compiled_at,
            (c.finished_at is not null and c.compiler_version is distinct from $2)
              as stale_compiler,
            (
              c.finished_at is null
              or exists (
                select 1 from braintrust_items i
                  join braintrust_sources s on s.id = i.source_id
                 where s.person_id = p.id
                   and (i.created_at > c.finished_at or i.retrieved_at > c.finished_at)
              )
              or exists (
                select 1 from braintrust_item_notes n
                  join braintrust_items i on i.id = n.item_id
                  join braintrust_sources s on s.id = i.source_id
                 where s.person_id = p.id and n.created_at > c.finished_at
              )
            ) as has_unseen
       from braintrust_people p
       left join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.paused_at is null
        and ($1::text is null or p.slug = $1)
      order by p.slug`,
    [person ?? null, compilerVersion],
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
 *
 * **A blocked Source's pending Items are not owed either, and that is the whole of
 * "a Compile still runs".** Those Items are real rows and Coverage counts them as a
 * shortfall the Persona names — but braintrust has stopped asking for them, so waiting
 * on them would freeze the Persona for as long as a platform cared to refuse. That would
 * hand the platform a veto over whether braintrust works at all, which is a larger
 * failure than a Corpus with a hole in it that says it has one.
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
         where s.person_id = $1 and i.retrieval = 'pending'
           and s.blocked_at is null) as to_retrieve,
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
  skipped_window: string;
  skipped_not_a_post: string;
  skipped_no_captions: string;
  failed: string;
  pending: string;
  words_retrieved: string;
  long_form_items: string;
  long_form_words: string;
  short_form_items: string;
  short_form_words: string;
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
export async function measureCoverage(
  db: Db,
  personId: string,
): Promise<Omit<CoverageEvidence, 'voice_measured_over'>> {
  const { rows } = await db.query<CoverageRow>(
    // The word count is computed once in `counted` and read four times, because the form
    // split has to be the *same* count as `words_retrieved` — two expressions that agree
    // today is not the same guarantee as one expression.
    `with counted as (
       select i.id, i.source_id, i.retrieval, i.published_at,
              case when i.body_text is null then 0
                   else coalesce(array_length(regexp_split_to_array(btrim(i.body_text), '\\s+'), 1), 0)
              end as words
         from braintrust_items i
     )
     select s.platform, s.handle, s.backfill_complete, s.blocked_at,
            count(c.id) filter (where c.retrieval = 'retrieved')::text        as retrieved,
            count(c.id) filter (where c.retrieval = 'skipped_paywall')::text  as skipped_paywall,
            count(c.id) filter (where c.retrieval = 'skipped_short')::text    as skipped_short,
            count(c.id) filter (where c.retrieval = 'skipped_window')::text   as skipped_window,
             count(c.id) filter (where c.retrieval = 'skipped_not_a_post')::text  as skipped_not_a_post,
             count(c.id) filter (where c.retrieval = 'skipped_no_captions')::text as skipped_no_captions,
             count(c.id) filter (where c.retrieval = 'failed')::text              as failed,
             count(c.id) filter (where c.retrieval = 'pending')::text             as pending,
            coalesce(sum(c.words) filter (where c.retrieval = 'retrieved'), 0)::text
                                                                              as words_retrieved,
            count(c.id) filter (where c.retrieval = 'retrieved' and c.words >= $2)::text
                                                                              as long_form_items,
            coalesce(sum(c.words) filter (where c.retrieval = 'retrieved' and c.words >= $2), 0)::text
                                                                              as long_form_words,
            count(c.id) filter (where c.retrieval = 'retrieved' and c.words < $2)::text
                                                                              as short_form_items,
            coalesce(sum(c.words) filter (where c.retrieval = 'retrieved' and c.words < $2), 0)::text
                                                                              as short_form_words,
            min(c.published_at) filter (where c.retrieval = 'retrieved')::text as first_published,
            max(c.published_at) filter (where c.retrieval = 'retrieved')::text as last_published
       from braintrust_sources s
       left join counted c on c.source_id = s.id
      where s.person_id = $1
      group by s.id, s.platform, s.handle, s.backfill_complete, s.blocked_at
      order by s.platform, s.handle`,
    [personId, VOICE_MIN_WORDS],
  );

  const by_source: Record<string, SourceCoverage> = {};
  const totals = {
    retrieved: 0,
    skipped_paywall: 0,
    skipped_short: 0,
    skipped_window: 0,
    skipped_not_a_post: 0,
    skipped_no_captions: 0,
    failed: 0,
    pending: 0,
    words: 0,
    long_items: 0,
    long_words: 0,
    short_items: 0,
    short_words: 0,
  };
  // The top-line window is the overlap every Source supports ([latest start, earliest end]),
  // never the union. A union ends on the newest item across all Sources, whichever one it came
  // from — so one live Source's later date would vouch for a dead one being read that recently.
  // Where the windows disagree so far that the overlap is empty, no single window is offered at all.
  const starts: string[] = [];
  const ends: string[] = [];

  for (const row of rows) {
    const source: SourceCoverage = {
      platform: row.platform,
      handle: row.handle,
      retrieved: Number(row.retrieved),
      skipped_paywall: Number(row.skipped_paywall),
      skipped_short: Number(row.skipped_short),
      skipped_window: Number(row.skipped_window),
      skipped_not_a_post: Number(row.skipped_not_a_post),
      skipped_no_captions: Number(row.skipped_no_captions),
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
    totals.skipped_window += source.skipped_window;
    totals.skipped_not_a_post += source.skipped_not_a_post;
    totals.skipped_no_captions += source.skipped_no_captions;
    totals.failed += source.failed;
    totals.pending += source.pending;
    totals.words += source.words_retrieved;
    totals.long_items += Number(row.long_form_items);
    totals.long_words += Number(row.long_form_words);
    totals.short_items += Number(row.short_form_items);
    totals.short_words += Number(row.short_form_words);
    if (source.window) {
      starts.push(source.window[0]);
      ends.push(source.window[1]);
    }
  }

  starts.sort();
  ends.sort();

  return {
    window:
      starts.length > 0 && starts[starts.length - 1]! <= ends[0]!
        ? [starts[starts.length - 1]!, ends[0]!]
        : null,
    retrieved: totals.retrieved,
    skipped_paywall: totals.skipped_paywall,
    skipped_short: totals.skipped_short,
    skipped_window: totals.skipped_window,
    skipped_not_a_post: totals.skipped_not_a_post,
    skipped_no_captions: totals.skipped_no_captions,
    failed: totals.failed,
    pending: totals.pending,
    words_retrieved: totals.words,
    by_source,
    by_form: {
      long_form: { items: totals.long_items, words: totals.long_words },
      short_form: { items: totals.short_items, words: totals.short_words },
    },
  };
}

export type RunningCompile = { id: string; started_at: string };

export async function runningCompile(db: Db, personId: string): Promise<RunningCompile | undefined> {
  const { rows } = await db.query<{ id: string; started_at: Date }>(
    `select id, started_at
       from braintrust_compiles where person_id = $1 and status = 'running'`,
    [personId],
  );

  const row = rows[0];
  // ISO 8601: this is the time `braintrust_refresh_persona` hands a client when it
  // refuses, so it is part of the surface rather than an internal detail.
  return row ? { id: row.id, started_at: row.started_at.toISOString() } : undefined;
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

/**
 * Rejected, not failed, and not deleted. The two statuses are different facts: `failed`
 * is a Compile that could not finish, `rejected` is one that finished and was not fit to
 * publish. The rows stay for inspection — a rejected Persona is the most useful thing
 * anyone diagnosing the compiler could be handed.
 */
export async function rejectCompile(db: Db, compileId: string, reason: string): Promise<void> {
  await db.query(
    `update braintrust_compiles set status = 'rejected', finished_at = now(), rejected_reason = $2
      where id = $1`,
    [compileId, reason],
  );
}

/**
 * Everything the gate checks, read at gate time rather than carried down from the build.
 *
 * Reading it back is the point of the exercise. A gate fed the compiler's own in-memory
 * view would confirm that the compiler agrees with itself; what is worth knowing is
 * whether the rows a client is about to be served agree with the rows they claim to
 * describe.
 */
export async function gateFacts(db: Db, personId: string, compileId: string): Promise<GateFacts> {
  const tlCandidates = await db.query<{ candidates: string | null }>(
    `select through_line_candidates::text as candidates
       from braintrust_compiles where id = $1`,
    [compileId],
  );

  const tlPublished = await db.query<{ count: string }>(
    `select count(*)::text as count
       from braintrust_through_lines where compile_id = $1`,
    [compileId],
  );
  const layers = await db.query<GateLayer & { evidence: unknown }>(
    `select layer, basis, descriptive_md, generative_md, evidence
       from braintrust_persona_layers where compile_id = $1 order by layer`,
    [compileId],
  );

  const items = await db.query<Record<keyof ItemCounts, string>>(
    `select
       count(*) filter (where i.retrieval = 'retrieved')::text       as retrieved,
       count(*) filter (where i.retrieval = 'skipped_paywall')::text as skipped_paywall,
       count(*) filter (where i.retrieval = 'skipped_short')::text   as skipped_short,
       count(*) filter (where i.retrieval = 'skipped_window')::text  as skipped_window,
       count(*) filter (where i.retrieval = 'skipped_not_a_post')::text  as skipped_not_a_post,
       count(*) filter (where i.retrieval = 'skipped_no_captions')::text as skipped_no_captions,
       count(*) filter (where i.retrieval = 'failed')::text              as failed,
       count(*) filter (where i.retrieval = 'pending')::text             as pending
       from braintrust_items i
       join braintrust_sources s on s.id = i.source_id
      where s.person_id = $1`,
    [personId],
  );

  // `graded_on` is a fingerprint of the vector `fit` would be computed from, never the
  // vector itself: the check is whether two Positions in one answer would be graded on the
  // same thing, and md5 answers that in the database rather than dragging 1,024 floats per
  // Position into the gate. Null where the statement was never embedded.
  const positions = await db.query<{
    slug: string;
    citations: string;
    graded_on: string | null;
  }>(
    `select p.slug, count(distinct c.id)::text as citations,
            min(md5(pe.embedding::text)) as graded_on
       from braintrust_positions p
       left join braintrust_position_citations c on c.position_id = p.id
       left join braintrust_position_embeddings pe on pe.position_id = p.id
      where p.compile_id = $1
      group by p.id, p.slug
      order by p.slug`,
    [compileId],
  );

  const previous = await db.query<{ count: string }>(
    `select count(*)::text as count
       from braintrust_positions p
       join braintrust_compiles c on c.id = p.compile_id
      where c.person_id = $1 and c.status = 'current'`,
    [personId],
  );

  // Distinct positions, not relations: a position superseded by three later ones is one
  // view off the record, and counting the rows would read as three.
  const superseded = await db.query<{ count: string }>(
    `select count(distinct r.from_position_id)::text as count
       from braintrust_position_relations r
      where r.compile_id = $1 and r.relation = 'revised'`,
    [compileId],
  );

  const person = await db.query<{ display_name: string }>(
    'select display_name from braintrust_people where id = $1',
    [personId],
  );

  const counts = items.rows[0]!;
  const tlCand = tlCandidates.rows[0]?.candidates;
  const tlPub = tlPublished.rows[0]?.count;

  return {
    layers: layers.rows.map((row) => ({
      layer: row.layer,
      basis: row.basis,
      descriptive_md: row.descriptive_md,
      generative_md: row.generative_md,
      evidence: row.evidence,
    })),
    coverage_evidence: layers.rows.find((row) => row.layer === 'coverage')?.evidence ?? null,
    items: {
      retrieved: Number(counts.retrieved),
      skipped_paywall: Number(counts.skipped_paywall),
      skipped_short: Number(counts.skipped_short),
      skipped_window: Number(counts.skipped_window),
      skipped_not_a_post: Number(counts.skipped_not_a_post),
      skipped_no_captions: Number(counts.skipped_no_captions),
      failed: Number(counts.failed),
      pending: Number(counts.pending),
    },
    positions: positions.rows.map((row) => ({
      slug: row.slug,
      citations: Number(row.citations),
      graded_on: row.graded_on,
    })),
    previous_positions: Number(previous.rows[0]!.count),
    superseded_positions: Number(superseded.rows[0]!.count),
    through_line_candidates: tlCand !== null && tlCand !== undefined ? Number(tlCand) : 0,
    through_lines_published: Number(tlPub),
    // Built by the function the read path calls, for the same reason `speak` is rendered
    // rather than described. The numbers are stand-ins — an empty answer needs a question
    // and the gate has none — and the check is about the *shape*: whether braintrust put a
    // sentence in there for a persona to recite.
    nothing_matched: nothingMatched({ nearest_similarity: null, floor: RETRIEVAL_FLOOR, nearest: [] }),
    // Rendered through the same path a reader gets, so the gate checks the thing that
    // ships rather than a lookalike built for checking.
    speak: renderScript(
      scriptInputFrom(
        subjectFor(person.rows[0]?.display_name ?? ''),
        Object.fromEntries(
          layers.rows.map((row) => [
            row.layer,
            {
              basis: row.basis,
              descriptive: row.descriptive_md,
              ...(row.generative_md !== null ? { generative: row.generative_md } : {}),
              evidence: row.evidence,
            },
          ]),
        ),
      ),
    ).speak,
  };
}

/**
 * The growing layer's rows, written under `running` like every other part of a Compile —
 * so they hang off the Compile the gate is about to judge, and `on delete cascade` throws
 * them away with it if it is never promoted.
 *
 * One transaction for the whole set, because a Position without its citations is exactly
 * what the gate rejects: a half-written set would be indistinguishable from a Compile that
 * genuinely produced uncitable Positions, and the two deserve different answers.
 */
export async function writePositions(
  db: TransactionalDb,
  compileId: string,
  positions: BuiltPosition[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (positions.length === 0) return ids;

  await db.transaction(async (tx) => {
    for (const position of positions) {
      const { rows } = await tx.query<{ id: string }>(
        `insert into braintrust_positions
           (compile_id, slug, statement, held_since, held_until, days_spanned, basis,
            confidence, item_count)
         values ($1, $2, $3, $4, $5, $6, 'measured', $7, $8)
         returning id`,
        [
          compileId,
          position.slug,
          position.statement,
          position.held_since,
          position.held_until,
          position.days_spanned,
          position.confidence,
          position.item_count,
        ],
      );

      const positionId = rows[0]!.id;
      ids.set(position.slug, positionId);

      for (const citation of position.citations) {
        await tx.query(
          `insert into braintrust_position_citations
             (position_id, item_id, start_ms, quote, post_url, posted_at)
           values ($1, $2, $3, $4, $5, $6::timestamptz)`,
          [
            positionId,
            citation.item_id,
            citation.start_ms,
            citation.quote,
            citation.post_url,
            citation.posted_at,
          ],
        );
      }
    }
  });

  return ids;
}

/**
 * The Position statements, embedded in the same space the Corpus is indexed in.
 *
 * **This is what `fit` grades, and the reason it is a row rather than a serve-time
 * computation.** Embedding twenty statements on every question would put a model call on the
 * read path for a quantity that does not change between questions; embedding them once per
 * Compile costs one call in the middle of the expensive part of braintrust.
 *
 * Written under `running` with the Positions, so they cascade away with a Compile that is
 * never promoted, and written **before the gate** — the check that no two Positions in one
 * answer can carry the same score reads these rows.
 *
 * One transaction, for the reason `writePositions` has one: a half-written set would mean
 * some Positions in an answer are graded and others are not, which reads to a client as
 * braintrust having an opinion about the ungraded ones.
 */
export async function writeStatementVectors(
  db: TransactionalDb,
  model: string,
  vectors: { positionId: string; vector: string }[],
): Promise<number> {
  if (vectors.length === 0) return 0;

  await db.transaction(async (tx) => {
    for (const one of vectors) {
      await tx.query(
        `insert into braintrust_position_embeddings (position_id, model, embedding)
         values ($1, $2, $3::vector)
         on conflict (position_id, model) do update set embedding = excluded.embedding`,
        [one.positionId, model, one.vector],
      );
    }
  });

  return vectors.length;
}

/**
 * The through-lines, and the Items each was traced to.
 *
 * **Not citations.** A through-line has nothing quotable under it by design; these rows say
 * which Items a reading was looking at when it surfaced the claim, which is what decides
 * whether it rides with a given answer. An Item named in an entry but not held by braintrust
 * was already dropped upstream, the same rule the inferred layers have.
 *
 * One transaction, like the Positions: a through-line whose Items half-landed would ride
 * with the wrong answers rather than fail visibly.
 */
export async function writeThroughLines(
  db: TransactionalDb,
  compileId: string,
  personId: string,
  throughLines: ThroughLine[],
  /** Total candidates found before ranking, stored for the gate check. */
  candidates?: number,
): Promise<number> {
  if (throughLines.length === 0) {
    if (candidates !== undefined && candidates > 0) {
      await db.query(
        `update braintrust_compiles set through_line_candidates = $2
          where id = $1`,
        [compileId, candidates],
      );
    }
    return 0;
  }

  let written = 0;

  await db.transaction(async (tx) => {
    await tx.query(
      `update braintrust_compiles set through_line_candidates = $2
        where id = $1`,
      [compileId, candidates ?? throughLines.length],
    );

    for (const line of throughLines) {
      const { rows } = await tx.query<{ id: string }>(
        `insert into braintrust_through_lines (compile_id, slug, statement, readings)
         values ($1, $2, $3, $4)
         on conflict (compile_id, slug) do nothing
         returning id`,
        [compileId, line.slug, line.statement, line.readings],
      );

      const id = rows[0]?.id;
      if (!id) continue;
      written += 1;

      await tx.query(
        `insert into braintrust_through_line_items (through_line_id, item_id)
         select $1, i.id
           from braintrust_items i
           join braintrust_sources s on s.id = i.source_id
          where s.person_id = $2 and i.external_id = any($3::text[])
         on conflict do nothing`,
        [id, personId, line.items],
      );
    }
  });

  return written;
}

/**
 * The relation rows, written against the Positions this Compile just wrote.
 *
 * **A relation naming a Position braintrust did not write is dropped**, which is the same
 * rule as a Position resolving to no claim and a claim with no quote in the body. The ids
 * come from `writePositions` rather than from a lookup, so a relation cannot reach across
 * to a previous Compile's Positions even if a judge names one — every Compile's relations
 * are about that Compile's rows, and a rebuild replaces the lot.
 *
 * Returned rather than logged: the count is what the caller reports, and the dropped ones
 * are what it warns about.
 */
export async function writeRelations(
  db: TransactionalDb,
  compileId: string,
  relations: WritableRelation[],
  positionIds: Map<string, string>,
): Promise<{ written: number; dropped: number }> {
  const writable = relations.filter(
    (relation) =>
      positionIds.has(relation.from) &&
      positionIds.has(relation.to) &&
      relation.from !== relation.to,
  );

  if (writable.length > 0) {
    await db.transaction(async (tx) => {
      for (const relation of writable) {
        await tx.query(
          `insert into braintrust_position_relations
             (compile_id, from_position_id, to_position_id, relation, gap_days, rationale)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            compileId,
            positionIds.get(relation.from),
            positionIds.get(relation.to),
            relation.relation,
            relation.gap_days,
            relation.rationale === '' ? null : relation.rationale,
          ],
        );
      }
    });
  }

  return { written: writable.length, dropped: relations.length - writable.length };
}

export type WritableRelation = {
  /** The earlier Position's slug. */
  from: string;
  /** The later Position's slug. The relation describes what this one does to the earlier. */
  to: string;
  relation: string;
  gap_days: number;
  rationale: string;
};

export type WritableLayer = {
  layer: 'voice' | 'reasoning' | 'coverage';
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
  /**
   * The same snapshot `braintrust_list_personas` reports, read here so the response
   * template can say how much was read in its opening line. Unvalidated on purpose — the
   * boundary decides what counts as a usable corpus block, in one place, for both tools.
   */
  corpus_stats: Record<string, unknown> | null;
  layers: LoadedLayer[];
};

/** A persona's stuck rebuild state, read from the ledger. */
export type StuckRebuild = {
  person_slug: string;
  first_stuck_at: string;
  cycles_behind: number;
};

/**
 * Upsert a stuck rebuild row, incrementing cycles_behind.
 *
 * The row is the deduplication: a persona already tracked increments rather
 * than inserting a second row, which is what makes `first_stuck_at` the clock
 * the fault runs on — it is never moved once set.
 */
export async function recordStuckRebuild(
  db: Db,
  personSlug: string,
): Promise<void> {
  await db.query(
    `insert into braintrust_stuck_rebuilds (person_slug)
        values ($1)
   on conflict (person_slug) do update
          set cycles_behind = braintrust_stuck_rebuilds.cycles_behind + 1`,
    [personSlug],
  );
}

/**
 * The persona caught up (or was paused). Clear the stuck record so the next
 * time it falls behind the clock starts fresh.
 */
export async function clearStuckRebuild(db: Db, personSlug: string): Promise<void> {
  await db.query(`delete from braintrust_stuck_rebuilds where person_slug = $1`, [personSlug]);
}

/**
 * Everyone currently stuck: two or more cycles behind the compiler, meaning
 * the rebuild is not completing.
 *
 * A cycle is one daily run. One cycle behind by design is the normal case
 * (the build queue); two or more means the rebuild has failed to complete
 * across consecutive runs, which is the fault.
 */
export async function stuckRebuilds(db: Db): Promise<StuckRebuild[]> {
  const { rows } = await db.query<{
    person_slug: string;
    first_stuck_at: Date;
    cycles_behind: string | number;
  }>(
    `select person_slug, first_stuck_at, cycles_behind
       from braintrust_stuck_rebuilds
      where cycles_behind >= 2
      order by person_slug`,
  );

  return rows.map((row) => ({
    person_slug: row.person_slug,
    first_stuck_at: isoDate(row.first_stuck_at),
    cycles_behind: Number(row.cycles_behind),
  }));
}

/** A slug exists in the stuck ledger. */
export async function isStuckRebuild(db: Db, slug: string): Promise<boolean> {
  const { rows } = await db.query<{ person_slug: string }>(
    'select person_slug from braintrust_stuck_rebuilds where person_slug = $1 and cycles_behind >= 2',
    [slug],
  );
  return rows.length > 0;
}

/** The stuck-rebuild evidence for one persona, or undefined if they are not stuck. */
export async function stuckRebuildEvidenceFor(db: Db, slug: string): Promise<StuckRebuildEvidence | undefined> {
  const { rows } = await db.query<{
    person_slug: string;
    first_stuck_at: Date;
    cycles_behind: string | number;
  }>(
    'select person_slug, first_stuck_at, cycles_behind from braintrust_stuck_rebuilds where person_slug = $1 and cycles_behind >= 2',
    [slug],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    first_stuck_at: isoDate(row.first_stuck_at),
    cycles_behind: Number(row.cycles_behind),
  };
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Every Persona currently serving on rules that have moved under it.
 *
 * **The scheduled check, and it is a post-condition rather than a trigger.** The rebuild
 * trigger is `stale_compiler` above, asked before a run does its work; this is asked after,
 * and what it asserts is that the run left nobody behind. It runs every cycle whether or
 * not anyone is looking, because the alternative is what this replaces: staleness fixed
 * only for the Personas somebody happens to read.
 *
 * Empty is the answer a healthy run gives.
 */
export async function personasBehind(db: Db, compilerVersion: string): Promise<string[]> {
  const { rows } = await db.query<{ slug: string }>(
    `select p.slug
       from braintrust_people p
       join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.paused_at is null
        and c.compiler_version is distinct from $1
      order by p.slug`,
    [compilerVersion],
  );
  return rows.map((row) => row.slug);
}

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
    corpus_stats: Record<string, unknown> | null;
    layer: string | null;
    basis: string | null;
    descriptive_md: string | null;
    generative_md: string | null;
    evidence: unknown;
  }>(
    `select p.display_name, c.finished_at as compiled_at, c.compiler_version, c.extractor,
            c.corpus_stats,
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
    corpus_stats: first.corpus_stats ?? null,
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

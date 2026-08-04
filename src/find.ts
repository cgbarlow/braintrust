/**
 * `braintrust_find_positions`: the read path for the growing layer, and the only tool that
 * answers a question rather than handing over a Persona.
 *
 * Retrieval is vector search over the Chunk embeddings, with **the question embedded at
 * serve time using the configured model**. That is the same space the Corpus was indexed
 * in, which is the whole reason the server refuses to answer at all when the configured
 * model has no vectors here: a same-sized model from another family fails no other way,
 * and every answer would come back confidently ranked and meaningless.
 *
 * Three rules the shape of this answer enforces.
 *
 * **Thin Positions are returned, never hidden.** `item_count` and `confidence` travel with
 * every Position and the client decides what one mention is worth. A threshold here would
 * be braintrust quietly choosing what you may see.
 *
 * **`passages` is the fallback, labelled as raw material.** When the compiler formed no
 * Position on a topic, the indexed words are still the best answer available — but they
 * are *what they said*, not *what braintrust concluded*, and the two are never mixed into
 * one list. Expect unpunctuated auto-caption text; it is returned as stored.
 *
 * **Verbatim is bounded by default, not capped.** A default answer returns a readable
 * number of passages and citations and says how many it held back; `full: true` returns
 * the rest, with no human gate. The consent posture adopted no verbatim cap and that
 * stands — this is a readability default, and any caller may undo it.
 *
 * **No Coverage block.** Coverage is a Core concern and this tool stays lean, so an empty
 * answer here is silent about whether 304 unread paid posts might have held it. The
 * accepted cost is paid by the tool description, which points clients at
 * `braintrust_load_persona` for exactly that.
 *
 * See docs/design/mcp-surface.md §3.
 */

import type { Db } from './db.js';
import { subjectFor } from './disclosure.js';
import { BraintrustError } from './errors.js';
import { vectorLiteral, type Embedder } from './retrieval/embed.js';
import type { QueryGate } from './retrieval/index.js';

/**
 * How many **Items** the vector search ranks. The Items are what map to Positions, so this
 * is the number that decides how wide an answer's evidence can be.
 *
 * It reads as a chunk limit and was one until [#68](https://github.com/cgbarlow/braintrust/issues/68).
 * Applied before the collapse to Items, it made an Item's chance of surviving proportional
 * to how many Chunks it has — a four-hour lecture entered a 60-ticket draw holding 180 of
 * them and a batched Bluesky day held one, which is a proportion of length and nothing to
 * do with relevance. See docs/design/compiler.md, "Retrieval ranks Items, not passages".
 */
export const MATCH_ITEMS = 60;

/**
 * How much wider than `MATCH_ITEMS` the Chunk pool is, so the collapse has enough to work
 * with. pgvector answers approximate top-k over Chunks, so Chunks are still how the Items
 * are found; the pool just has to be wider than the number of Items wanted.
 *
 * **Bounded on purpose.** The query stays a single indexed top-k rather than a scan: 480
 * Chunks against the ~7,600 the measured Corpus holds. The residual is that a pool
 * monopolised by a few very long Items yields *fewer* Items, not longer ones — a narrower
 * answer rather than a length-ranked one, which is the failure worth having.
 *
 * A starting point to tune against real retrieval results, with the same status as the
 * retrieval floor below.
 */
export const ITEM_OVER_FETCH = 8;

/**
 * How many Chunks the passages fallback returns. Passages *are* Chunks — there is no
 * collapse to be on the wrong side of here, because the raw material is what is being
 * served. It shared a constant with the Item limit only because the numbers matched.
 */
export const MATCH_PASSAGES = 60;


/**
 * How similar the best-matching Chunk has to be before braintrust will answer at all.
 *
 * **This replaces the selectivity margin, which measured the endpoint rather than the
 * Corpus.** #115 swapped an absolute floor for a margin against the Corpus's own
 * distribution, reasoning that a shape does not belong to the operator's embeddings model
 * the way a distance does. The reasoning was elegant and the measurement disagreed: three
 * Personas of 5, 19 and 40 Items produced off-corpus ceilings of 0.3047, 0.2543 and 0.2549
 * — one number, three unrelated Corpora, which is what a statistic looks like when it is
 * describing the model instead of the data. `ethan-mollick` then refused *"what AI agents
 * change about how work actually gets done"*.
 *
 * Top absolute similarity, on that same Corpus and in that same probe:
 *
 * | Question | Top |
 * |---|---:|
 * | the correct water temperature for poaching an egg | 0.445 |
 * | what AI agents change about how work actually gets done | 0.691 |
 *
 * It separates. #115's rejection of the floor rested on watching eight Positions clear
 * `0.35` — a value it admitted was a guess, and which sits *below* where off-corpus
 * questions land. **The instrument was never wrong; the setting was, and nobody had
 * measured it.**
 *
 * This constant is now only the fallback, for a Persona compiled before the floor was
 * measured or on a Corpus where the probes did not separate. The value in force is
 * normally measured per Persona on every Compile — see compile/selectivity.ts.
 */
export const RETRIEVAL_FLOOR = Number(process.env.BRAINTRUST_RETRIEVAL_FLOOR ?? 0.35);

/**
 * The operator's override, or nothing. Set, it wins for every Persona.
 *
 * Exists for the same reason its predecessor did — an escape hatch, not configuration —
 * and nothing in any document asks anybody to set it.
 */
export const FLOOR_OVERRIDE =
  process.env.BRAINTRUST_RETRIEVAL_FLOOR === undefined
    ? null
    : Number(process.env.BRAINTRUST_RETRIEVAL_FLOOR);

/**
 * The scale `fit` grades against when a Compile measured no span of its own. Unmeasured,
 * and deliberately wide: a fit grade that is merely uninformative is a smaller failure
 * than one that calls a weak match `close`.
 */
export const DEFAULT_SPAN = 0.2;

/** The floor in force for one Persona: the override, else what its Compile measured, else the fallback. */
export function floorFor(measured: number | null): number {
  if (FLOOR_OVERRIDE !== null) return FLOOR_OVERRIDE;
  return measured ?? RETRIEVAL_FLOOR;
}

/**
 * Retired. `MATCH_FLOOR` was the absolute floor #115 replaced with a selectivity margin and
 * #133 restored — but restored as a *measured, per-Persona* value rather than a constant.
 * Kept as an alias so nothing that imported it breaks, and so the name that appears in
 * `nothing_matched.floor` still resolves.
 */
export const MATCH_FLOOR = RETRIEVAL_FLOOR;

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

/** Readability defaults. `full: true` lifts both, because neither is a cap. */
export const DEFAULT_PASSAGES = 5;
export const DEFAULT_CITATIONS = 4;

export type FindArgs = {
  person: string;
  query: string;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
  full?: boolean | undefined;
};

export type FindDeps = {
  db: Db;
  embedder: Embedder;
  /** Startup check 2, asked per request. An unembedded Corpus is a refusal, not an empty answer. */
  retrieval: QueryGate;
};

export type Citation = {
  item_title: string | null;
  /**
   * **The individual post, where the Item is a batch of them.** A Bluesky Item is a whole
   * UTC day because 2,100 skeets a year would be 2,100 model calls — but the batch is a
   * unit of reading and never a unit of citation, so this resolves to the post the verified
   * quote actually fell inside rather than to the day it was read in.
   */
  url: string;
  published_at: string | null;
  /** Transcripts only: where in the video the words are. */
  start_ms?: number;
  /** Batched days only: the same question, answered in the unit that form has. */
  posted_at?: string;
  quote: string;
};

export type PositionRelation = {
  relation: string;
  /** Read as "this position <direction> the other". */
  direction: 'supersedes' | 'superseded_by' | 'later' | 'earlier';
  other: string;
  gap_days: number | null;
  rationale: string | null;
};

export type FoundPosition = {
  slug: string;
  statement: string;
  held_since: string | null;
  /**
   * The span, not only the beginning. `high` across three years reads differently from
   * `high` across five days, and without these a client could not tell them apart — which
   * is exactly what a grade that never filters anything is for.
   */
  held_until: string | null;
  days_spanned: number | null;
  basis: string;
  /**
   * How well braintrust knows this Position. **Says nothing about the question asked** —
   * which is exactly how `measured` + `high` + four dated quotes came to read as licence to
   * answer a question about tomatoes. See `fit`.
   */
  confidence: string;
  /**
   * How well this Position answers *this query*, against the Corpus's own distribution.
   * The second grade exists because one grade was being asked to carry two facts, and a
   * weakly-fitting Position must stay visibly weak however well evidenced it is.
   */
  fit: 'close' | 'partial' | 'distant';
  item_count: number;
  /** False only when this Position is the earlier side of a `revised` relation. */
  current: boolean;
  relations: PositionRelation[];
  citations: Citation[];
  /** Present when the default bound trimmed this Position's evidence. `full` returns it. */
  more_citations?: number;
};

export type Passage = {
  item_title: string | null;
  url: string;
  published_at: string | null;
  start_ms?: number;
  text: string;
};

export type FindPayload = {
  subject: string;
  query: string;
  compiled_at: string | null;
  /** Echoed back, because a filtered answer that does not say it was filtered reads as a whole one. */
  window?: { since?: string; until?: string };
  positions: FoundPosition[];
  /** Filled only when the compiler formed no Position on this topic. Raw material, not a conclusion. */
  passages: Passage[];
  more_available?: { positions?: number; passages?: number };
  /**
   * Present only on an empty answer, and it is the difference between *they never said
   * this* and *braintrust is misconfigured*. Found live: a floor that does not suit the
   * configured model turns every question into an empty list, and an empty list on its own
   * is indistinguishable from an honest one.
   */
  nothing_matched?: {
    nearest_similarity: number | null;
    /** The gate in force for this Persona — measured on its last Compile unless overridden. */
    floor: number;
    /**
     * *Nothing came close* and *everything came equally close* are different facts about a
     * Corpus and an operator reads them differently: the first is an honest empty answer,
     * the second is a question that never selected this Corpus at all.
     */
     reason: 'below_floor' | 'nothing_indexed';
    /** What a Persona can put into its own words. Never braintrust's prose about braintrust. */
    say: string;
  };
};

type CurrentCompile = {
  id: string;
  display_name: string;
  compiled_at: Date | null;
  /** What this Persona's Compile measured. Null before the floor was measured. */
  measured_floor: number | null;
  /** The gap between the probe groups, which is the scale `fit` grades against. */
  measured_span: number | null;
};

export async function findPositions(args: FindArgs, deps: FindDeps): Promise<FindPayload> {
  const slug = args.person.trim();
  const query = args.query.trim();

  if (query === '') {
    throw new BraintrustError(
      'braintrust_find_positions needs a question or a topic. It searches what this person ' +
        'actually published; it cannot list everything they hold.',
    );
  }

  // Never compiled means answer nothing — the passages fallback applies to compiled
  // Personas only, because "here are some sentences" is not a Persona and offering it as
  // one would quietly redefine what braintrust is serving.
  const compile = await currentCompile(deps.db, slug);
  if (!compile) {
    throw new BraintrustError(
      `braintrust has no persona for "${slug}" yet. braintrust_list_personas says who exists and ` +
        'who has been compiled; nothing is compiled on demand.',
    );
  }

  // Asked per request rather than at boot: both unready states end when the scheduled job
  // finishes, in the other deployment, and caching the refusal would turn "wait for the
  // first run" into "wait for the first run, then notice, then restart".
  const readiness = await deps.retrieval.check();
  if (!readiness.ready) throw new BraintrustError(readiness.reason!);

  const [vector] = await deps.embedder.embed([query]);
  if (!vector) {
    throw new BraintrustError(
      `The embeddings endpoint at ${deps.embedder.url} returned nothing for the question, so ` +
        'braintrust cannot search. Nothing is wrong with the corpus.',
    );
  }

  const limit = bounded(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const window = { since: args.since ?? null, until: args.until ?? null };
  const search = { model: deps.embedder.model, person: slug, ...window };

  // The gate, before anything is ranked. A question that merely lands in this Corpus gets
  // no answer at all — not a weakly-graded one — because the ranking behind a landed
  // question is the Corpus's own centroid rather than anything about what was asked.
  const floor = floorFor(compile.measured_floor);
  const span = compile.measured_span ?? DEFAULT_SPAN;
  const field = await selectivity(deps.db, vectorLiteral(vector), search);
  const selected = field.top !== null && field.top >= floor;

  const matched = selected
    ? await matchingPositions(deps.db, compile.id, vectorLiteral(vector), search, floor)
    : [];

  const shown = matched.slice(0, limit);
  const positions = await withEvidence(deps.db, shown, args.full === true, floor, span);

  const payload: FindPayload = {
    subject: subjectFor(compile.display_name),
    query,
    compiled_at: compile.compiled_at?.toISOString() ?? null,
    ...(window.since || window.until
      ? {
          window: {
            ...(window.since ? { since: window.since } : {}),
            ...(window.until ? { until: window.until } : {}),
          },
        }
      : {}),
    positions,
    passages: [],
  };

  const more: { positions?: number; passages?: number } = {};
  if (matched.length > shown.length) more.positions = matched.length - shown.length;

  // The fallback, and only the fallback. Passages alongside Positions would put a
  // conclusion and the raw material for one in the same answer with nothing but a key name
  // to tell a client which is which.
  if (positions.length === 0 && selected) {
    const found = await matchingPassages(deps.db, vectorLiteral(vector), search, floor);
    const bound = args.full === true ? found.length : DEFAULT_PASSAGES;
    payload.passages = found.slice(0, bound);
    if (found.length > bound) more.passages = found.length - bound;
  }

  if (more.positions !== undefined || more.passages !== undefined) payload.more_available = more;

  // An empty answer says how close it came. The alternative is what the live probe
  // produced before this existed: a persona built from twenty real posts answering every
  // question with `[]`, and no way to tell a corpus that does not cover the question from
  // a floor that does not suit the endpoint.
  if (payload.positions.length === 0 && payload.passages.length === 0) {
    const nearest = await nearestSimilarity(deps.db, vectorLiteral(vector), search);
    // Two reasons, not three. `did_not_select` named the discredited margin test and has
    // nothing left to mean: a question either reaches this Corpus or it does not.
    const reason = nearest === null ? 'nothing_indexed' : 'below_floor';

    payload.nothing_matched = {
      nearest_similarity: nearest,
      floor,
      reason,
      say:
        reason === 'nothing_indexed'
          ? 'braintrust has nothing indexed for this person in that window.'
          : 'This is outside what braintrust has read of this person.',
    };
  }

  return payload;
}

function bounded(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.trunc(value)));
}

async function currentCompile(db: Db, slug: string): Promise<CurrentCompile | undefined> {
  const { rows } = await db.query<
    CurrentCompile & { measured_floor: string | null; measured_span: string | null }
  >(
    // What this Persona's own Compile measured. Null for anything compiled before the
    // floor was measured, which is what floorFor() falls back for.
    `select c.id, p.display_name, c.finished_at as compiled_at,
            (c.corpus_stats -> 'selectivity' ->> 'floor') as measured_floor,
            (c.corpus_stats -> 'selectivity' ->> 'span')  as measured_span
       from braintrust_people p
       join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.slug = $1`,
    [slug],
  );

  const row = rows[0];
  if (!row) return undefined;
  return { ...row, measured_floor: numeric(row.measured_floor), measured_span: numeric(row.measured_span) };
}

/** A jsonb text field that should hold a number, or null if it does not. */
function numeric(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type Search = { model: string; person: string; since: string | null; until: string | null };

type PositionRow = {
  id: string;
  slug: string;
  statement: string;
  held_since: string | null;
  held_until: string | null;
  days_spanned: number | null;
  basis: string;
  confidence: string;
  item_count: number;
  /** Best chunk distance behind this Position. Turned into a `fit` grade, never served raw. */
  distance: number;
};

/**
 * The Positions whose citations point at Items the search actually matched, best match
 * first.
 *
 * **Three stages, and the order of the middle two is the whole point.** `hits` is the
 * approximate top-k pgvector can actually answer, over-fetched by `ITEM_OVER_FETCH`
 * because it exists only to find Items. `items` collapses those Chunks to the Items behind
 * them and *then* truncates, so every Item competes once on its single best passage and a
 * lecture and a batched day are equals at the point of ranking. Truncating first — which is
 * what this did — ranked Items by how many Chunks they happen to have.
 *
 * The window filters **what is searched**, not what a Position is allowed to show: a
 * Position found by a Q2 item still reports the Items it rests on across the whole Corpus,
 * because `item_count` is the denominator a reader judges it on and a silently narrowed one
 * would understate it.
 */
async function matchingPositions(
  db: Db,
  compileId: string,
  vector: string,
  search: Search,
  floor: number,
): Promise<PositionRow[]> {
  const { rows } = await db.query<Omit<PositionRow, 'item_count'> & { item_count: string }>(
    `with hits as (
       select c.item_id, e.embedding <=> $2::vector as distance
         from braintrust_embeddings e
         join braintrust_chunks c on c.id = e.chunk_id
         join braintrust_items i on i.id = c.item_id
         join braintrust_sources s on s.id = i.source_id
        where s.person_id = (select person_id from braintrust_compiles where id = $1)
          and e.model = $3
          and ($4::date is null or i.published_at >= $4::date)
          and ($5::date is null or i.published_at <= $5::date)
          and e.embedding <=> $2::vector <= ${1} - $6::float
        order by distance
        limit ${MATCH_ITEMS * ITEM_OVER_FETCH}
     ),
     items as (select item_id, min(distance) as distance
                 from hits group by item_id
                order by distance
                limit ${MATCH_ITEMS})
     select p.id, p.slug, p.statement, p.held_since::text as held_since,
            p.held_until::text as held_until, p.days_spanned, p.basis,
            p.confidence, p.item_count::text as item_count,
            min(items.distance) as distance
       from braintrust_positions p
       join braintrust_position_citations pc on pc.position_id = p.id
       join items on items.item_id = pc.item_id
      where p.compile_id = $1
      group by p.id, p.slug, p.statement, p.held_since, p.held_until, p.days_spanned,
               p.basis, p.confidence, p.item_count
      order by distance asc, p.item_count desc, p.slug`,
    [compileId, vector, search.model, search.since, search.until, floor],
  );

  return rows.map((row) => ({ ...row, item_count: Number(row.item_count) }));
}

/** The citations and relations for the Positions being returned, in one round trip each. */
async function withEvidence(
  db: Db,
  rows: PositionRow[],
  full: boolean,
  floor: number,
  span: number,
): Promise<FoundPosition[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  const citations = await db.query<{
    position_id: string;
    item_title: string | null;
    url: string;
    published_at: string | null;
    start_ms: number | null;
    posted_at: Date | null;
    quote: string;
  }>(
    // The post's URL where the Item was a batch of them, and the Item's otherwise. Resolved
    // in the select rather than in the mapping, so nothing downstream has to know which
    // platforms batch.
    `select pc.position_id, i.title as item_title,
            coalesce(pc.post_url, i.url) as url, i.published_at::text as published_at,
            pc.start_ms, pc.posted_at, pc.quote
       from braintrust_position_citations pc
       join braintrust_items i on i.id = pc.item_id
      where pc.position_id = any($1::uuid[])
      order by i.published_at desc nulls last, pc.posted_at nulls first, pc.start_ms nulls first`,
    [ids],
  );

  // Both directions in one query. `from` is the earlier Position and `to` the later, so
  // which side a Position is on is what decides whether the relation reads as supersedes
  // or superseded_by — and `current` is nothing more than "not the earlier side of a
  // revised". The rows are #35's to write; reading them is settled here so that landing
  // revisions is a write and not a change to what this tool means.
  const relations = await db.query<{
    position_id: string;
    side: 'from' | 'to';
    relation: string;
    other: string;
    gap_days: number | null;
    rationale: string | null;
  }>(
    `select r.from_position_id as position_id, 'from' as side, r.relation,
            later.slug as other, r.gap_days, r.rationale
       from braintrust_position_relations r
       join braintrust_positions later on later.id = r.to_position_id
      where r.from_position_id = any($1::uuid[])
     union all
     select r.to_position_id as position_id, 'to' as side, r.relation,
            earlier.slug as other, r.gap_days, r.rationale
       from braintrust_position_relations r
       join braintrust_positions earlier on earlier.id = r.from_position_id
      where r.to_position_id = any($1::uuid[])`,
    [ids],
  );

  return rows.map((row) => {
    const mine = citations.rows.filter((one) => one.position_id === row.id);
    const bound = full ? mine.length : DEFAULT_CITATIONS;
    const related = relations.rows.filter((one) => one.position_id === row.id);

    const position: FoundPosition = {
      slug: row.slug,
      statement: row.statement,
      held_since: row.held_since,
      held_until: row.held_until,
      days_spanned: row.days_spanned === null ? null : Number(row.days_spanned),
      basis: row.basis,
      confidence: row.confidence,
      fit: fitOf(1 - Number(row.distance), floor, span),
      item_count: row.item_count,
      current: !related.some((one) => one.side === 'from' && one.relation === 'revised'),
      relations: related.map((one) => ({
        relation: one.relation,
        direction: directionOf(one.side, one.relation),
        other: one.other,
        gap_days: one.gap_days,
        rationale: one.rationale,
      })),
      citations: mine.slice(0, bound).map(toCitation),
    };

    if (mine.length > bound) position.more_citations = mine.length - bound;
    return position;
  });
}

function directionOf(side: 'from' | 'to', relation: string): PositionRelation['direction'] {
  if (relation === 'revised') return side === 'to' ? 'supersedes' : 'superseded_by';
  return side === 'to' ? 'later' : 'earlier';
}

function toCitation(row: {
  item_title: string | null;
  url: string;
  published_at: string | null;
  start_ms: number | null;
  posted_at: Date | null;
  quote: string;
}): Citation {
  return {
    item_title: row.item_title,
    url: row.url,
    published_at: row.published_at,
    ...(row.start_ms !== null ? { start_ms: row.start_ms } : {}),
    ...(row.posted_at !== null ? { posted_at: row.posted_at.toISOString() } : {}),
    quote: row.quote,
  };
}

/**
 * How close the nearest Chunk came, with no floor applied. Null when there is nothing
 * indexed for this Person inside the window at all — which is a third answer again, and
 * one an operator reads differently from both of the others.
 */
async function nearestSimilarity(db: Db, vector: string, search: Search): Promise<number | null> {
  const { rows } = await db.query<{ similarity: number }>(
    `select 1 - (e.embedding <=> $1::vector) as similarity
       from braintrust_embeddings e
       join braintrust_chunks c on c.id = e.chunk_id
       join braintrust_items i on i.id = c.item_id
       join braintrust_sources s on s.id = i.source_id
       join braintrust_people p on p.id = s.person_id
      where p.slug = $2
        and e.model = $3
        and ($4::date is null or i.published_at >= $4::date)
        and ($5::date is null or i.published_at <= $5::date)
      order by e.embedding <=> $1::vector
      limit 1`,
    [vector, search.person, search.model, search.since, search.until],
  );

  const nearest = rows[0]?.similarity;
  return nearest === undefined ? null : Math.round(Number(nearest) * 1000) / 1000;
}

/**
 * The Corpus's own distribution of similarity to this query: the best match, and the
 * middle of the field.
 *
 * The margin between them is what says whether the question *selected* anything. On an
 * off-corpus question every Chunk is roughly equidistant, so the best barely beats the
 * median — which is why two unrelated questions could return the same answer. On a question
 * the Corpus covers, the best stands well clear.
 *
 * Sampled rather than scanned: the median of the nearest few hundred Chunks is the shape
 * that matters, and reading a 500-item Corpus end to end on every call would trade the
 * latency this map spent a whole ticket recovering.
 *
 * **Exported so the calibrator measures this and not something like it.** `npm run
 * calibrate` sets `SELECTIVITY_MARGIN`, and a threshold measured with a second
 * implementation of the same idea would be calibrating a function the server does not
 * call. See src/calibrate/index.ts.
 */
export async function selectivity(
  db: Db,
  vector: string,
  search: Search,
): Promise<{ top: number | null; median: number | null }> {
  const { rows } = await db.query<{ top: number | null; median: number | null }>(
    `with field as (
       select 1 - (e.embedding <=> $1::vector) as similarity
         from braintrust_embeddings e
         join braintrust_chunks c on c.id = e.chunk_id
         join braintrust_items i on i.id = c.item_id
         join braintrust_sources s on s.id = i.source_id
         join braintrust_people p on p.id = s.person_id
        where p.slug = $2
          and e.model = $3
          and ($4::date is null or i.published_at >= $4::date)
          and ($5::date is null or i.published_at <= $5::date)
        order by e.embedding <=> $1::vector
        limit 400
     )
     select max(similarity) as top,
            percentile_cont(0.5) within group (order by similarity) as median
       from field`,
    [vector, search.person, search.model, search.since, search.until],
  );

  const row = rows[0];
  return {
    top: row?.top === null || row?.top === undefined ? null : Number(row.top),
    median: row?.median === null || row?.median === undefined ? null : Number(row.median),
  };
}

/**
 * How well one Position answers the question. A grade about *fit*, never about how well
 * braintrust knows the Position.
 *
 * **Graded as height above this Persona's own floor, in units of its own measured span.**
 * Both numbers come from the same Compile-time calibration the gate uses, so there is one
 * notion of *clear* and one measurement moving both — and the span is what this Corpus
 * actually produced between a question it answers and one it does not, rather than a
 * constant somebody picked.
 *
 * **Two ways this has been wrong, and both are excluded by the signature.**
 *
 * It first divided by the query's own range, `(similarity - median) / (top - median)`, so
 * the best match scored exactly 1.0 and graded `close` for every query ever asked — the
 * numerator and denominator were the same number. That is why `top` is not a parameter: a
 * grade computed against the answer it is grading carries no information about that answer,
 * and saying *this does not answer you* is the only thing `fit` exists to do.
 *
 * It then graded clearance over the Corpus's median, which the live run showed to be the
 * quantity that measures the embeddings model rather than the Corpus — the same defect that
 * made the gate refuse a Persona's own subject. That is why `median` is not a parameter
 * either. See test/fit.test.ts.
 */
export function fitOf(
  similarity: number,
  floor: number,
  span: number = DEFAULT_SPAN,
): 'close' | 'partial' | 'distant' {
  // A Corpus whose probes never separated has no span of its own. Declining to
  // discriminate is the honest answer: neither a warning nor an endorsement.
  if (!Number.isFinite(span) || span <= 0) return 'partial';

  const height = similarity - floor;
  if (height >= span * 0.66) return 'close';
  if (height >= span * 0.33) return 'partial';
  return 'distant';
}

/**
 * The raw material, when there is no conclusion to serve. Returned exactly as stored —
 * most of what braintrust reads is auto-generated captions, and tidying an unpunctuated
 * wall of lowercase into prose would make it a rendering of what was said rather than
 * what was said.
 */
async function matchingPassages(
  db: Db,
  vector: string,
  search: Search,
  floor: number,
): Promise<Passage[]> {
  const { rows } = await db.query<{
    item_title: string | null;
    url: string;
    published_at: string | null;
    start_ms: number | null;
    text: string;
  }>(
    `select i.title as item_title, i.url, i.published_at::text as published_at,
            c.start_ms, c.text
       from braintrust_embeddings e
       join braintrust_chunks c on c.id = e.chunk_id
       join braintrust_items i on i.id = c.item_id
       join braintrust_sources s on s.id = i.source_id
       join braintrust_people p on p.id = s.person_id
      where p.slug = $2
        and e.model = $3
        and ($4::date is null or i.published_at >= $4::date)
        and ($5::date is null or i.published_at <= $5::date)
        and e.embedding <=> $1::vector <= ${1} - $6::float
      order by e.embedding <=> $1::vector
      limit ${MATCH_PASSAGES}`,
    [vector, search.person, search.model, search.since, search.until, floor],
  );

  return rows.map((row) => ({
    item_title: row.item_title,
    url: row.url,
    published_at: row.published_at,
    ...(row.start_ms !== null ? { start_ms: row.start_ms } : {}),
    text: row.text,
  }));
}

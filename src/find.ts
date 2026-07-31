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

/** How many Chunks the vector search considers. The Items behind them are what map to Positions. */
export const MATCH_CHUNKS = 60;

/**
 * How close a Chunk has to be before braintrust calls it a match. Cosine similarity, so
 * pgvector's distance has to come in under `1 - MATCH_FLOOR`.
 *
 * **This is not the thing the spec refuses to do.** Thin Positions are never hidden — a
 * Position found once is returned graded `low`, and no threshold on `item_count` exists
 * anywhere. This is the other question, which every vector search has to answer: *did the
 * Corpus match the question at all?* Nearest-neighbour search always returns neighbours,
 * so without a floor "what do they think about the moon landing" comes back with their
 * best position on evals, ranked confidently — and the passages fallback could never fire,
 * because something is always nearest.
 *
 * 0.35 is a **starting point, and the one threshold here that has not been measured
 * against a real endpoint** — braintrust configures no embeddings model, and the value that
 * separates "related" from "merely nearest" is a property of whichever one an operator
 * points it at. It is deliberately low: a floor set too high turns a real answer into a
 * shrug, and the failure it protects against is the loud one.
 */
export const MATCH_FLOOR = 0.35;

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
  url: string;
  published_at: string | null;
  /** Transcripts only: where in the video the words are. */
  start_ms?: number;
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
  basis: string;
  confidence: string;
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
  nothing_matched?: { nearest_similarity: number | null; floor: number };
};

type CurrentCompile = { id: string; display_name: string; compiled_at: Date | null };

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
  const matched = await matchingPositions(deps.db, compile.id, vectorLiteral(vector), {
    model: deps.embedder.model,
    person: slug,
    ...window,
  });

  const shown = matched.slice(0, limit);
  const positions = await withEvidence(deps.db, shown, args.full === true);

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
  if (positions.length === 0) {
    const found = await matchingPassages(deps.db, vectorLiteral(vector), {
      model: deps.embedder.model,
      person: slug,
      ...window,
    });
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
    payload.nothing_matched = {
      nearest_similarity: await nearestSimilarity(deps.db, vectorLiteral(vector), {
        model: deps.embedder.model,
        person: slug,
        ...window,
      }),
      floor: MATCH_FLOOR,
    };
  }

  return payload;
}

function bounded(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.trunc(value)));
}

async function currentCompile(db: Db, slug: string): Promise<CurrentCompile | undefined> {
  const { rows } = await db.query<CurrentCompile>(
    `select c.id, p.display_name, c.finished_at as compiled_at
       from braintrust_people p
       join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.slug = $1`,
    [slug],
  );
  return rows[0];
}

type Search = { model: string; person: string; since: string | null; until: string | null };

type PositionRow = {
  id: string;
  slug: string;
  statement: string;
  held_since: string | null;
  basis: string;
  confidence: string;
  item_count: number;
};

/**
 * The Positions whose citations point at Items the search actually matched, best match
 * first.
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
          and e.embedding <=> $2::vector <= ${1 - MATCH_FLOOR}
        order by distance
        limit ${MATCH_CHUNKS}
     ),
     items as (select item_id, min(distance) as distance from hits group by item_id)
     select p.id, p.slug, p.statement, p.held_since::text as held_since, p.basis,
            p.confidence, p.item_count::text as item_count,
            min(items.distance) as distance
       from braintrust_positions p
       join braintrust_position_citations pc on pc.position_id = p.id
       join items on items.item_id = pc.item_id
      where p.compile_id = $1
      group by p.id, p.slug, p.statement, p.held_since, p.basis, p.confidence, p.item_count
      order by distance asc, p.item_count desc, p.slug`,
    [compileId, vector, search.model, search.since, search.until],
  );

  return rows.map((row) => ({ ...row, item_count: Number(row.item_count) }));
}

/** The citations and relations for the Positions being returned, in one round trip each. */
async function withEvidence(
  db: Db,
  rows: PositionRow[],
  full: boolean,
): Promise<FoundPosition[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  const citations = await db.query<{
    position_id: string;
    item_title: string | null;
    url: string;
    published_at: string | null;
    start_ms: number | null;
    quote: string;
  }>(
    `select pc.position_id, i.title as item_title, i.url, i.published_at::text as published_at,
            pc.start_ms, pc.quote
       from braintrust_position_citations pc
       join braintrust_items i on i.id = pc.item_id
      where pc.position_id = any($1::uuid[])
      order by i.published_at desc nulls last, pc.start_ms nulls first`,
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
      basis: row.basis,
      confidence: row.confidence,
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
  quote: string;
}): Citation {
  return {
    item_title: row.item_title,
    url: row.url,
    published_at: row.published_at,
    ...(row.start_ms !== null ? { start_ms: row.start_ms } : {}),
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
 * The raw material, when there is no conclusion to serve. Returned exactly as stored —
 * most of what braintrust reads is auto-generated captions, and tidying an unpunctuated
 * wall of lowercase into prose would make it a rendering of what was said rather than
 * what was said.
 */
async function matchingPassages(db: Db, vector: string, search: Search): Promise<Passage[]> {
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
        and e.embedding <=> $1::vector <= ${1 - MATCH_FLOOR}
      order by e.embedding <=> $1::vector
      limit ${MATCH_CHUNKS}`,
    [vector, search.person, search.model, search.since, search.until],
  );

  return rows.map((row) => ({
    item_title: row.item_title,
    url: row.url,
    published_at: row.published_at,
    ...(row.start_ms !== null ? { start_ms: row.start_ms } : {}),
    text: row.text,
  }));
}

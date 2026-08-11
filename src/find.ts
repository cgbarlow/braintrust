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
 * be braintrust quietly choosing what you may see. That holds for `fit` too: a weak grade
 * changes a Position's *place in the list*, never whether it is in the list.
 *
 * **Two jobs, two numbers, and conflating them is how `fit` was wrong three times.**
 * Chunks decide whether a question reaches this Corpus at all and which Positions are
 * candidates — that is what a vector index can answer and what the measured floor is
 * calibrated for. The Position's own *statement* decides how the candidates that came back
 * are ordered and graded. See {@link fitOf}.
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
 * **The payload still carries everything a Persona no longer says out loud, on purpose.**
 * [#202](https://github.com/cgbarlow/braintrust/issues/202) took verbatim, item title and
 * date out of the *unasked answer*; the rule lives on the speaking surfaces — the Script,
 * this tool's description, the server instructions — and expressly not here. Withholding
 * citations from the payload until asked is the honest form and was measured: starve this
 * model of the quotable thing and 2 of 8 replies replace it with invented first-person
 * anecdote, buying a forgery fix by inducing the founding failure. So quotes, titles, dates
 * and urls all still ship, and a reader can still tell the difference from the payload
 * alone. **Nothing here may be trimmed on the grounds that it is no longer spoken.**
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
import { movedParts } from './compile/version.js';
import { UNMEASURED_RETRIEVAL_FLOOR } from './unmeasured.js';

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
 * The value in force is normally measured per Persona on every Compile — see
 * compile/selectivity.ts. What a Persona does when it has measured none is
 * {@link UNMEASURED_RETRIEVAL_FLOOR}, and **that number now sits above the measured range
 * rather than below it**: `0.35` was this file's own admitted guess, and leaving it as the
 * fallback meant the Persona that knew least about its gate was the most credulous. See
 * ./unmeasured.ts.
 */
export const RETRIEVAL_FLOOR = FLOOR_OVERRIDE ?? UNMEASURED_RETRIEVAL_FLOOR;

/**
 * The floor in force for one Persona: the override, else what its Compile measured, else
 * the fallback.
 *
 * **A floor measured under rules that have since changed is not a measurement any more.**
 * When the measurement half of the compiler has moved under a Persona, its stored floor
 * becomes an unmeasured quantity and takes the conservative value — and it does so **on
 * this read**, for the reader who arrived, rather than when a rebuild eventually catches
 * up. That is what makes the staleness window zero for anyone actually reading: the catch
 * happens on the read, not on a clock. See ./unmeasured.ts.
 *
 * `version` omitted means *do not ask* — the caller is testing the fallback itself rather
 * than serving a Persona.
 */
export function floorFor(measured: number | null, version?: string | null): number {
  if (FLOOR_OVERRIDE !== null) return FLOOR_OVERRIDE;
  if (version !== undefined && movedParts(version).includes('measurement')) {
    return UNMEASURED_RETRIEVAL_FLOOR;
  }
  return measured ?? UNMEASURED_RETRIEVAL_FLOOR;
}

/**
 * The cut and the scale `fit` grades against, for one Persona, or null for *do not grade*.
 *
 * **There is no fallback, and that is the difference between this and the floor.** A floor
 * has a cautious direction — point it up and an uncalibrated Persona declines more. A grade
 * does not: `distant` on something that answers and `close` on something that does not are
 * both wrong, in opposite directions, and neither is the careful one. So a Compile that has
 * not measured its own cut **declines to grade** rather than borrowing a number measured
 * somewhere else. The Position still comes back, still in its place in the list, with no
 * grade beside it. See ./unmeasured.ts.
 *
 * Measured in *statement* space, which is not the space the floor is measured in — the two
 * are separate numbers for the separate jobs they do, and a stale cut is refused for the
 * same reason a stale floor is tightened: on this read, for the reader who arrived.
 */
export function cutFor(
  measured: { cut: number | null; span: number | null },
  version?: string | null,
): { cut: number; span: number } | null {
  if (version !== undefined && movedParts(version).includes('measurement')) return null;
  if (measured.cut === null || measured.span === null || measured.span <= 0) return null;
  return { cut: measured.cut, span: measured.span };
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
   * How well this Position answers *this query*, graded on its own statement. The second
   * grade exists because one grade was being asked to carry two facts, and a weakly-fitting
   * Position must stay visibly weak however well evidenced it is.
   *
   * `ungraded` is a real answer: this Persona's Compile never measured the cut, so
   * braintrust has no scale of its own to grade against and declines rather than guessing.
   * The Position is returned either way, in the same place in the list.
   */
  fit: Fit;
  /**
   * The number `fit` was graded from: how close this Position's **own statement** is to the
   * question. Null only when nothing was graded.
   *
   * **A grade whose input is invisible cannot be checked, and this one has been wrong three
   * times.** All three were found by someone noticing an answer that read oddly and having
   * no way to tell whether the grade or the retrieval produced it — `close` on a question
   * the Corpus does not cover looks identical either way. Carrying the number makes the
   * grade checkable from the payload alone, and read against the other results it says
   * whether the grade separated them.
   *
   * **Not on the same scale as `nothing_matched.nearest_similarity`**, which is Chunk
   * similarity and belongs to the gate. Two numbers, because they answer two questions.
   */
  similarity: number | null;
  item_count: number;
  /** False only when this Position is the earlier side of a `revised` relation. */
  current: boolean;
  relations: PositionRelation[];
  citations: Citation[];
  /** Present when the default bound trimmed this Position's evidence. `full` returns it. */
  more_citations?: number;
};

/**
 * A claim braintrust inferred across this person's work, riding with an answer that already
 * matched.
 *
 * **No date, no quote, no score, and no retrieval path of its own** — see
 * ./compile/throughlines.ts for why each of those is absent rather than missing.
 *
 * `basis` travels because a maintainer needs to be able to tell an inferred claim from a
 * quoted one. **A reader is not told which is which**: no hedge, no attribution, not even the
 * non-apologetic *"across everything I've written on hiring…"* form. That is the decision, and
 * it is affordable only because a through-line never arrives alone.
 */
export type ThroughLine = {
  slug: string;
  statement: string;
  basis: 'inferred';
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
  /**
   * What this person broadly holds, where the answer already touches it.
   *
   * **Never the whole of an answer, and that is load-bearing.** A through-line is spoken
   * flatly — no hedge, no attribution, no marker — and that is affordable only because
   * something checkable is always beside it. So this is empty whenever `positions` is: the
   * two stand or fall together. See ./compile/throughlines.ts.
   */
  through_lines: ThroughLine[];
  /** Filled only when the compiler formed no Position on this topic. Raw material, not a conclusion. */
  passages: Passage[];
  more_available?: { positions?: number; passages?: number };
  /**
   * Present only on an empty answer, and it is the difference between *they never said
   * this* and *braintrust is misconfigured*. Found live: a floor that does not suit the
   * configured model turns every question into an empty list, and an empty list on its own
   * is indistinguishable from an honest one.
   */
  nothing_matched?: NothingMatched;
};

/**
 * An empty answer, as **facts and no sentence**.
 *
 * **`say` used to ship here and no Persona ever said it.** It read *"This is outside what
 * braintrust has read of this person."* — third person, about braintrust, calling the person
 * *this person* — against its own field comment promising the opposite. Measured across ~80
 * replies: every arm rewrote it into its own first person, and braintrust's exact words came
 * out only when a Script section told the Persona to use them. So the sentence is the
 * Persona's and braintrust supplies only what it knows. That is what keeps *never fall back
 * to a generic voice* at **one** exception — the fixed disclosure, which is braintrust
 * speaking as itself.
 *
 * **And an empty answer offers rather than stops.** Nothing was broken about the honesty: a
 * Persona handed an empty answer admits it and does not fill, 24 of 24, every arm and every
 * seed. What was wrong was the shape of a dead end — *"I don't have a view on central bank
 * interest rate policy."* and no next move, on the first question a reader asks. Handed the
 * nearest thing braintrust does hold, the Persona offered it unprompted.
 */
export type NothingMatched = {
  nearest_similarity: number | null;
  /** The gate in force for this Persona — measured on its last Compile unless overridden. */
  floor: number;
  /**
   * *Nothing came close* and *everything came equally close* are different facts about a
   * Corpus and an operator reads them differently: the first is an honest empty answer,
   * the second is a question that never selected this Corpus at all.
   */
  reason: 'below_floor' | 'nothing_indexed';
  /**
   * The nearest things braintrust **does** hold, so the Persona has something to offer
   * instead of stopping. Positions, nearest first, with the floor ignored — which is the
   * whole point: these did not answer the question, and saying so while naming them is a
   * different act from serving them as an answer.
   *
   * Statements rather than slugs, because a Persona cannot offer `quests-beat-goals` out
   * loud. They are the same sentences `positions[].statement` carries, read from the rows
   * rather than composed here.
   */
  nearest: { slug: string; statement: string }[];
};

/** How many adjacent Positions an empty answer offers. Enough to be a choice, not a list. */
export const NEAREST_ON_EMPTY = 3;

/**
 * An empty answer, assembled in one place.
 *
 * **Exported so the publish gate checks the thing that ships** rather than a lookalike built
 * for checking — the same rule that makes the gate render the real Script to look at its first
 * line. `reason` is derived here rather than passed, because *nothing came close* and *nothing
 * is indexed* is a reading of one number and not a second fact a caller could get wrong.
 */
export function nothingMatched(facts: {
  nearest_similarity: number | null;
  floor: number;
  nearest: { slug: string; statement: string }[];
}): NothingMatched {
  return {
    nearest_similarity: facts.nearest_similarity,
    floor: facts.floor,
    // Two reasons, not three. `did_not_select` named the discredited margin test and has
    // nothing left to mean: a question either reaches this Corpus or it does not.
    reason: facts.nearest_similarity === null ? 'nothing_indexed' : 'below_floor',
    nearest: facts.nearest,
  };
}

/**
 * The keys `nothing_matched` may carry, and the only string values braintrust authors in it.
 *
 * **This field has drifted once already**, which is why the shape is enumerated here and
 * checked before a Compile may publish. See ./compile/gate.ts.
 */
export const NOTHING_MATCHED_KEYS = [
  'nearest_similarity',
  'floor',
  'reason',
  'nearest',
] as const;

export const NOTHING_MATCHED_REASONS = ['below_floor', 'nothing_indexed'] as const;

/**
 * Anything in an empty answer that a Persona could recite as it stands, by field name. Empty
 * is the passing state.
 *
 * **Structural, and deliberately not a readability judgement.** It does not ask whether a
 * string reads like prose; it asks whether braintrust put a string there at all. Numbers, a
 * null, and one of two reason codes are facts. `nearest` is exempt because its sentences are
 * `braintrust_positions.statement`, read from the rows and already served verbatim beside
 * every Position — quoting the record is not composing prose about braintrust.
 */
export function speakableProseIn(payload: Record<string, unknown>): string[] {
  const offending: string[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if (!(NOTHING_MATCHED_KEYS as readonly string[]).includes(key)) {
      offending.push(key);
      continue;
    }
    if (key === 'nearest') continue;
    if (value === null || typeof value === 'number') continue;
    if (key === 'reason' && (NOTHING_MATCHED_REASONS as readonly string[]).includes(String(value))) {
      continue;
    }
    offending.push(key);
  }

  return offending;
}

type CurrentCompile = {
  id: string;
  display_name: string;
  compiled_at: Date | null;
  /** What this Persona's Compile measured. Null before the floor was measured. */
  measured_floor: number | null;
  /** Where `fit` starts calling a statement an answer, and the scale it grades in. */
  measured_cut: number | null;
  measured_fit_span: number | null;
  /**
   * Which rules built this Persona. Read here so the gate can be tightened **on this
   * read** when they have moved, rather than when a rebuild eventually catches up.
   */
  compiler_version: string | null;
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
  const floor = floorFor(compile.measured_floor, compile.compiler_version);
  const scale = cutFor(
    { cut: compile.measured_cut, span: compile.measured_fit_span },
    compile.compiler_version,
  );
  const literal = vectorLiteral(vector);
  const field = await selectivity(deps.db, literal, search);
  const selected = field.top !== null && field.top >= floor;

  const matched = selected
    ? await matchingPositions(deps.db, compile.id, literal, search, floor)
    : [];

  // **Scored and ordered before the readability bound, never after.** The candidates
  // arrive in Chunk order, which is the order that ordered answers the way a reader would
  // 51% of the time. Slicing first would let the bound keep ten Positions chosen by the
  // discredited number and merely re-shuffle them, which is the same defect wearing a
  // sorted list.
  const scored = await scoreStatements(deps.db, matched, literal, search.model);
  const shown = scored.slice(0, limit);
  const positions = await withEvidence(deps.db, shown, args.full === true, scale);

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
    // **Riding, never retrieved.** Which through-lines travel is decided by the Items the
    // answer's own Positions rest on, so a through-line is earned by a match that already
    // happened rather than competing for the top of a list. An empty answer carries none:
    // there is nothing checkable beside it, and a flat claim on its own is the whole thing
    // this design refuses.
    through_lines:
      positions.length === 0 ? [] : await ridingThroughLines(deps.db, compile.id, shown),
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

    payload.nothing_matched = nothingMatched({
      nearest_similarity: nearest,
      floor,
      // **The next move, rather than a full stop.** The floor is deliberately not applied
      // here: these Positions did not answer the question and are not offered as though they
      // did — they are what this Persona has looked at nearby, so a dead end can be handed
      // back as a choice. Nothing to offer is a real answer too, and it is an empty list.
      nearest: await nearestPositions(deps.db, compile.id, literal, search.model),
    });
  }

  return payload;
}

function bounded(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.trunc(value)));
}

async function currentCompile(db: Db, slug: string): Promise<CurrentCompile | undefined> {
  const { rows } = await db.query<
    CurrentCompile & {
      measured_floor: string | null;
      measured_cut: string | null;
      measured_fit_span: string | null;
    }
  >(
    // What this Persona's own Compile measured. Null for anything compiled before the
    // floor was measured, which is what floorFor() falls back for — and, under `fit`,
    // what cutFor() declines to grade for.
    //
    // Two blocks rather than one, because the gate and the grade measure different
    // spaces: `selectivity` is Chunk similarity, `fit` is statement similarity, and one
    // object holding both invites exactly the conflation that made `fit` a coin.
    `select c.id, p.display_name, c.finished_at as compiled_at, c.compiler_version,
            (c.corpus_stats -> 'selectivity' ->> 'floor') as measured_floor,
            (c.corpus_stats -> 'fit' ->> 'cut')           as measured_cut,
            (c.corpus_stats -> 'fit' ->> 'span')          as measured_fit_span
       from braintrust_people p
       join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.slug = $1`,
    [slug],
  );

  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row,
    measured_floor: numeric(row.measured_floor),
    measured_cut: numeric(row.measured_cut),
    measured_fit_span: numeric(row.measured_fit_span),
  };
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

/** A candidate Position with the number its grade and its place in the list come from. */
type ScoredPosition = PositionRow & { statement_similarity: number | null };

/**
 * How close each Position's **own statement** is to the question, by id.
 *
 * **Exported so the calibrator measures this and not something like it** — the same reason
 * `selectivity` is exported. The cut `fit` grades against is measured on every Compile by
 * calling this function over the statements it just wrote, so a cut can never be calibrated
 * against a second implementation of the quantity the server actually grades on.
 *
 * A Position with no row here is one whose statement was never embedded — a Compile that
 * ran without an embeddings endpoint, or one whose vectors belong to a model this server is
 * not configured with. Both are *nothing to grade*, never a zero.
 */
export async function statementScores(
  db: Db,
  positionIds: string[],
  vector: string,
  model: string,
): Promise<Map<string, number>> {
  if (positionIds.length === 0) return new Map();

  const { rows } = await db.query<{ position_id: string; similarity: string }>(
    `select pe.position_id, (1 - (pe.embedding <=> $2::vector))::text as similarity
       from braintrust_position_embeddings pe
      where pe.position_id = any($1::uuid[])
        and pe.model = $3`,
    [positionIds, vector, model],
  );

  return new Map(rows.map((row) => [row.position_id, Number(row.similarity)]));
}

/**
 * The candidates, scored on their own statements and put in that order.
 *
 * **This is the whole of #140.** The candidates arrive in Chunk order — the best Chunk of
 * the best Item behind each Position — and measured across 92 Positions from five live
 * Personas that number puts the better of two Positions first **51%** of the time, where
 * 50% is a coin. It cannot do better: the mean Item similarity of a Position that answers
 * the question is 0.585 and of one a reader would reject is 0.576, so there is no signal in
 * it to order by. The statement gets **80%**, and **82%** under a second judge shown only
 * the person's own quotes and never braintrust's sentence.
 *
 * Ordering is where the harm lands, because a reader reads down and quotes the top. The
 * grade and the order are now the same number, so they cannot disagree.
 *
 * **Nothing is dropped here.** A Position whose statement scores badly moves down the list;
 * a Position with no statement vector sorts last because it has no place to claim, not
 * because it is being hidden. What decides membership is the floor, on Chunks, and that
 * happened before this.
 */
async function scoreStatements(
  db: Db,
  rows: PositionRow[],
  vector: string,
  model: string,
): Promise<ScoredPosition[]> {
  const scores = await statementScores(
    db,
    rows.map((row) => row.id),
    vector,
    model,
  );

  return rows
    .map((row) => {
      const score = scores.get(row.id);
      return {
        ...row,
        // Rounded here rather than at the payload, so the order a reader sees is the order
        // of the numbers a reader sees.
        statement_similarity: score === undefined ? null : Math.round(score * 1000) / 1000,
      };
    })
    .sort(
      (left, right) =>
        (right.statement_similarity ?? -1) - (left.statement_similarity ?? -1) ||
        // **Retrieval order underneath, which is what an ungraded Persona gets.** A Compile
        // with no statement vectors has no better number to sort on, and the Chunk order is
        // a weak signal rather than no signal — alphabetical would be worse than the thing
        // this ticket replaced. It is a tie-break here and never a grade.
        left.distance - right.distance ||
        right.item_count - left.item_count ||
        left.slug.localeCompare(right.slug),
    );
}

/** The citations and relations for the Positions being returned, in one round trip each. */
async function withEvidence(
  db: Db,
  rows: ScoredPosition[],
  full: boolean,
  scale: { cut: number; span: number } | null,
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
    const similarity = row.statement_similarity;

    const position: FoundPosition = {
      slug: row.slug,
      statement: row.statement,
      held_since: row.held_since,
      held_until: row.held_until,
      days_spanned: row.days_spanned === null ? null : Number(row.days_spanned),
      basis: row.basis,
      confidence: row.confidence,
      fit: fitOf(similarity, scale),
      similarity,
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
 * The through-lines that ride with this answer: the ones traced to Items the answer's own
 * Positions rest on.
 *
 * **This is the whole of "no retrieval path of its own".** Nothing here is ranked, scored or
 * compared to the question — a through-line travels because a Position that cites the same
 * Item matched, which is a fact about a lookup that already happened. It cannot crowd out the
 * top of an answer because it has no place in the ordering at all.
 *
 * **A through-line may never outnumber the quoted claims beside it.** When the cap bites,
 * the ones most tied to this answer survive — ranked by how many of the answer's Positions
 * each touches. Ties fall back to the Persona's standing order (by slug), so the same
 * question returns the same broad claims across runs.
 */
async function ridingThroughLines(
  db: Db,
  compileId: string,
  shown: ScoredPosition[],
): Promise<ThroughLine[]> {
  if (shown.length === 0) return [];

  const { rows } = await db.query<{ slug: string; statement: string; positions: string }>(
    `select t.slug, t.statement, count(distinct pc.position_id)::text as positions
       from braintrust_through_lines t
       join braintrust_through_line_items ti on ti.through_line_id = t.id
       join braintrust_position_citations pc on pc.item_id = ti.item_id
      where t.compile_id = $1
        and pc.position_id = any($2::uuid[])
      group by t.id, t.slug, t.statement
      order by count(distinct pc.position_id) desc, t.slug`,
    [compileId, shown.map((position) => position.id)],
  );

  const limit = shown.length;
  const riding = rows.slice(0, limit).map((row) => ({
    slug: row.slug,
    statement: row.statement,
    basis: 'inferred' as const,
  }));

  return riding;
}

/**
 * The Positions whose statements come nearest the question, with no floor applied.
 *
 * **Graded on the same statements `fit` grades on**, through the same query, so the thing
 * offered on an empty answer is the thing that would have ranked first had anything cleared
 * the gate. A Persona with no statement vectors offers nothing rather than an arbitrary
 * three — the honest answer when braintrust cannot tell which of its Positions is nearest.
 *
 * The window is not applied either. A reader who asked about last quarter and got nothing is
 * being offered *what this Persona has*, not a second empty list in a narrower slice.
 */
async function nearestPositions(
  db: Db,
  compileId: string,
  vector: string,
  model: string,
): Promise<{ slug: string; statement: string }[]> {
  const { rows } = await db.query<{ slug: string; statement: string }>(
    `select p.slug, p.statement
       from braintrust_positions p
       join braintrust_position_embeddings pe on pe.position_id = p.id
      where p.compile_id = $1
        and pe.model = $3
      order by pe.embedding <=> $2::vector
      limit ${NEAREST_ON_EMPTY}`,
    [compileId, vector, model],
  );

  return rows;
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

export type Fit = 'close' | 'partial' | 'distant' | 'ungraded';

/**
 * How well one Position answers the question. A grade about *fit*, never about how well
 * braintrust knows the Position.
 *
 * **Graded on the Position's own statement, as height above this Persona's own measured
 * cut, in units of its own measured span.** The subject of the grade and the thing being
 * graded are the same sentence, which is the general rule the three failures below all
 * broke: *a grade about the question must be computed from the thing it is grading.*
 *
 * **Three ways this has been wrong, and all three are excluded by the signature.**
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
 * either.
 *
 * It then graded the best Chunk of the best Item behind the Position, which every Position
 * drawn from that Item shares: 41 of 92 live Positions carried a number identical to
 * another's, three of them reading `close` on a question none of them answered. That is why
 * the caller passes a number measured on the statement, and why *nothing shared between two
 * Positions in one answer* may reach this function. See test/fit.test.ts.
 *
 * **`ungraded` is not a fourth grade.** It is the absence of one, for a Persona whose
 * Compile measured no cut of its own — because unlike a floor, a grade has no cautious
 * direction to fall back on. See {@link cutFor}.
 */
export function fitOf(
  similarity: number | null,
  scale: { cut: number; span: number } | null,
): Fit {
  if (similarity === null || scale === null) return 'ungraded';
  if (!Number.isFinite(scale.span) || scale.span <= 0) return 'ungraded';

  const height = similarity - scale.cut;
  if (height >= scale.span * 0.66) return 'close';
  if (height >= scale.span * 0.33) return 'partial';
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

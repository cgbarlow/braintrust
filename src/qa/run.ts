/**
 * Asking one golden question, for real, judging what came back — and placing it on the
 * six-rung ladder that says *where* it was lost.
 *
 * **The candidate runs the real path** — the same `findPositions` a client's
 * `braintrust_find_positions` call reaches — the same reason ../eval/run.ts runs the real
 * extractor path rather than a stand-in for it. What is being measured is not retrieval in
 * the abstract but retrieval *doing braintrust's job*. The one extra read, `candidateRank`,
 * is the same `hits`/`items` CTE that already built that answer's candidate set, measured
 * against the same floor (see ../find.ts) — a second implementation of either would grade
 * a retrieval nobody serves.
 */

import type { Db } from '../db.js';
import { candidateRank, findPositions, floorFor, type FindDeps, type FindPayload } from '../find.js';
import type { Interrogator } from '../interrogate/index.js';
import { vectorLiteral } from '../retrieval/embed.js';
import {
  answeredNothing,
  cameBack,
  grounded,
  reached,
  renderAnswer,
  restsOn,
  rungFor,
  RUBRIC,
  type NegativeOutcome,
  type QAOutcome,
  type RungFacts,
} from './score.js';
import type { GoldenQuestion } from './sample.js';
import type { NegativeQuestion } from './negative.js';

/** Enough positions to judge a reply without paying to render every one. */
const ANSWER_LIMIT = 5;

export async function runQuestion(
  question: GoldenQuestion,
  deps: FindDeps,
  interrogator: Interrogator,
): Promise<QAOutcome> {
  // **`full: true` is for the measurement, not for the reader.** Without it ../find.ts
  // bounds each Position's citations to the four most recent, so a Position resting on
  // twenty items showed four — and the one item whose title asked the question was
  // invisible unless it happened to be among them. The grounding check was scoring
  // recency. ../qa/score.ts still renders only what a default call would return, so what
  // the judge reads is unchanged.
  let payload: FindPayload;
  try {
    payload = await findPositions(
      { person: question.person, query: question.query, limit: ANSWER_LIMIT, full: true },
      deps,
    );
  } catch (error) {
    // **Nothing came back at all is a rung, not a crash.** The ladder must sum to the
    // number of questions asked whatever happened to the request — an embedding that
    // turned its toes up mid-run is a Silence, and one question's failure is no reason
    // to lose the rest of the run (spec §5.1).
    return {
      person: question.person,
      query: question.query,
      item_url: question.item_url,
      fit: null,
      rung: 'silence',
      passed: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // **The ladder needs three facts the payload cannot carry, read from the Corpus behind
  // it.** Nothing in a served answer can say how many compiled Positions cite the asked
  // item, nor where that item stood in the candidate set — those are the eval looking
  // behind the answer, which is exactly what a golden set (and only a golden set) may do.
  const facts = await rungFactsFor(payload, question, deps);
  const rung = rungFor(facts);

  // **An empty answer is not judged at all.** There is no reply to pass or fail — the
  // rubric passes *"nothing matched"* and that is precisely the mistake #328 removes.
  // Recording it without spending a judge call is a second, smaller saving.
  if (answeredNothing(rung)) {
    return {
      person: question.person,
      query: question.query,
      item_url: question.item_url,
      fit: payload.positions[0]?.fit ?? null,
      rung,
      passed: null,
      detail: String(payload.nothing_matched?.reason ?? payload.read_without_position?.item_title ?? rung),
    };
  }

  const reply = `Question asked: "${question.query}"\n\n${renderAnswer(payload)}`;

  let passed: boolean | null;
  let detail: string;
  try {
    const verdict = await interrogator.judge(RUBRIC, reply);
    passed = verdict.holds;
    detail = verdict.why;
  } catch (error) {
    // An unreachable judge concludes nothing about this answer — the same rule
    // ../interrogate/index.ts follows: a dead endpoint is not evidence of a bad reply.
    passed = null;
    detail = error instanceof Error ? error.message : String(error);
  }

  return {
    person: question.person,
    query: question.query,
    item_url: question.item_url,
    fit: payload.positions[0]?.fit ?? null,
    rung,
    passed,
    detail,
  };
}

/** The Corpus-side facts one rung needs that the payload cannot carry. */
type ServingFacts = { compileId: string; floor: number; cites: number };

/**
 * The compile serving right now, its floor in force, and how many of its Positions cite
 * the asked item. Floor measured at compile time and refused on this read when the rules
 * have moved — the same `floorFor` the answer just used, so the ladder sees the same gate.
 */
async function servingFactsFor(db: Db, person: string, itemId: string): Promise<ServingFacts> {
  const { rows } = await db.query<{
    compile_id: string;
    compiler_version: string | null;
    measured_floor: string | null;
    cites: string;
  }>(
    `select c.id as compile_id, c.compiler_version,
            (c.corpus_stats -> 'selectivity' ->> 'floor') as measured_floor,
            (select count(distinct p.id)
               from braintrust_positions p
               join braintrust_position_citations pc on pc.position_id = p.id
              where p.compile_id = c.id and pc.item_id = $2) as cites
       from braintrust_people pe
       join braintrust_compiles c on c.person_id = pe.id and c.status = 'current'
      where pe.slug = $1`,
    [person, itemId],
  );

  const row = rows[0]!;
  return {
    compileId: row.compile_id,
    floor: floorFor(numeric(row.measured_floor), row.compiler_version),
    cites: Number(row.cites),
  };
}

async function rungFactsFor(
  payload: FindPayload,
  question: GoldenQuestion,
  deps: FindDeps,
): Promise<RungFacts> {
  const served = await servingFactsFor(deps.db, question.person, question.item_id);

  // Re-embedded here against the same endpoint the answer just used: the candidate set is
  // a query over this vector, and the embedder is deterministic for identical text, so the
  // rank below is the rank `findPositions` ranked by.
  const [vector] = await deps.embedder.embed([question.query]);
  if (!vector) {
    throw new Error(`qa: the embeddings endpoint returned nothing for "${question.query}"`);
  }
  const rank = await candidateRank(
    deps.db,
    served.compileId,
    vectorLiteral(vector),
    { model: deps.embedder.model, person: question.person, since: null, until: null },
    served.floor,
    question.item_id,
  );

  return {
    // Nothing came back at all — no positions and no raw passages. `nothing_matched` is
    // set in exactly this case, so the payload says directly where words end.
    silence: payload.positions.length === 0 && payload.passages.length === 0,
    cites: served.cites,
    inCandidateSet: rank > 0,
    reached: reached(payload, question.citation_urls),
    grounded: grounded(payload, question.citation_urls),
  };
}

/**
 * Asking one negative-set question — off-domain or near-miss — and measuring only what came
 * back. **No judge call is spent on either set**: the measurement is *whether anything came
 * back*, read straight off the payload, so a question braintrust has no keepable answer to
 * is not charged a judge call to say so.
 *
 * `rested` is only meaningful for near-miss — an off-domain question has no golden item to
 * rest on. Off-domain answers are false as a class, so the report needs no more than `came_back`.
 */
export async function runNegativeQuestion(
  question: NegativeQuestion,
  deps: FindDeps,
): Promise<NegativeOutcome> {
  const payload = await findPositions(
    { person: question.person, query: question.query, limit: ANSWER_LIMIT, full: true },
    deps,
  );

  return {
    person: question.person,
    query: question.query,
    kind: question.kind,
    came_back: cameBack(payload),
    rested:
      question.item !== undefined ? restsOn(payload, question.item.citation_urls) : false,
  };
}

/** A jsonb text field that should hold a number, or null if it does not. */
function numeric(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

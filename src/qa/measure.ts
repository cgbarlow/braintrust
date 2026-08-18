/**
 * The free half of the instrument: the bars, measured with no judge call at all.
 *
 * **Everything here is embeddings and SQL.** `grounded` is a URL match against the answer
 * a reader would be served, resolved through the same `findPositions` the sample path
 * runs — the one difference is that nothing here renders a reply for a judge. Off-domain
 * false answers is a count of the canonical `OFF_DOMAIN` questions (../qa/negative.ts) that
 * came back with anything at all, using the same *anything came back* rule the negative-set
 * columns report — so the bar and the report cannot disagree. Coverage is two counts in
 * SQL. Zero model calls beyond the embeddings every other read already needs.
 *
 * **The denominator is the whole Corpus, not a sample of ten.** §5.4 of the map spec: the
 * covered denominators on a sample of ten are 3 and 3 for two personas — too few to bar
 * on. So this pass asks **every titled, retrieved item**, embedding the titles in batches
 * of `EMBED_BATCH` and never two at once, threading one vector through `findPositions` and
 * the rank check so a question is embedded once and not twice.
 *
 * **It decides nothing about serving.** A measurement is a count; what it opens is decided
 * in ../interrogate/bars.ts, which turns a failure into a row on the existing
 * `braintrust_faults` rail and a pass into a cleared row. Nothing here writes to a Compile,
 * a layer or a version.
 */

import type { Db } from '../db.js';
import { findPositions, type FindDeps } from '../find.js';
import { servingFleet } from '../interrogate/store.js';
import { EMBED_BATCH, type Embedder } from '../retrieval/embed.js';
import type { QueryGate } from '../retrieval/index.js';
import { coveredOf, type PersonBars } from './bars.js';
import { OFF_DOMAIN } from './negative.js';
import { ANSWER_LIMIT, rungFactsFor } from './run.js';
import { goldenQuestions } from './sample.js';
import { cameBack, RUNGS, rungFor, type Rung } from './score.js';

/** The measurement needs a retrieval that really serves, or none of it is about the product. */
export type MeasureDeps = FindDeps;

/**
 * Measure the free columns for one Person, and only that. The judged sample stays where it
 * was; this is the pass the bars are settled on.
 */
export async function measurePersonaBars(db: Db, person: string, deps: MeasureDeps): Promise<PersonBars> {
  const offDomain = OFF_DOMAIN;
  const questions = await goldenQuestions(db, person, WHOLE_CORPUS);

  // One embedding per title, batched and serialised — the endpoint is never asked to hold
  // a whole corpus at once, and a title is embedded once and threaded through both the
  // answer and the rank check that classifies it.
  const vectors = await embedAll(deps.embedder, questions.map((question) => question.query));

  const rungs = zeroRungs();
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]!;
    const vector = vectors[index]!;

    // `full: true` is the measurement's answer, not the reader's: the grounding check must
    // see every citation, the same contract ../qa/run.ts holds.
    const payload = await findPositions(
      { person, query: question.query, limit: ANSWER_LIMIT, full: true },
      deps,
      vector,
    );
    const facts = await rungFactsFor(payload, question, deps, vector);
    rungs[rungFor(facts)] += 1;
  }

  // The canonical off-domain set and the harness's *anything came back* rule. A false
  // answer is the honest reply's opposite — the persona served a Position, raw passages or
  // a read-but-unpositioned item where silence was the only correct answer.
  const offDomainVectors = await embedAll(deps.embedder, offDomain.map((question) => question.query));
  let offDomainFalseAnswers = 0;
  for (let index = 0; index < offDomain.length; index++) {
    const question = offDomain[index]!;
    const vector = offDomainVectors[index]!;
    const payload = await findPositions({ person, query: question.query, limit: ANSWER_LIMIT, full: true }, deps, vector);
    if (cameBack(payload)) offDomainFalseAnswers += 1;
  }

  const { retrieved, coveredItems } = await coverageFor(db, person);
  const covered = coveredOf(rungs);

  return {
    person,
    asked: questions.length,
    rungs,
    covered,
    grounded: rungs.grounded,
    groundedRate: covered === 0 ? null : rungs.grounded / covered,
    offDomainAsked: offDomain.length,
    offDomainFalseAnswers,
    retrieved,
    coveredItems,
  };
}

/** Measure every serving person, largest corpus first — `servingFleet`'s order. */
export async function measureFleetBars(db: Db, deps: MeasureDeps): Promise<PersonBars[]> {
  const fleet = await servingFleet(db);
  const measurements: PersonBars[] = [];
  for (const member of fleet) {
    measurements.push(await measurePersonaBars(db, member.person, deps));
  }
  return measurements;
}

/**
 * Two counts from the Corpus, no model in the path: how many retrieved items there are,
 * and how many of them the current compile's Positions cite. The second is what a
 * reader means by *the persona actually has something on it*.
 *
 * Distinct `pc.item_id` rather than `pos.item_count`: a Position resting on twenty items
 * counts each of them, which is the shape Coverage is actually plotted in (§5.5).
 */
async function coverageFor(db: Db, person: string): Promise<{ retrieved: number; coveredItems: number }> {
  const { rows } = await db.query<{ retrieved: string | null; cited: string | null }>(
    `select
       (select count(*)
          from braintrust_items i
          join braintrust_sources s on s.id = i.source_id
          join braintrust_people p on p.id = s.person_id
         where p.slug = $1 and i.retrieval = 'retrieved') as retrieved,
       (select count(distinct pc.item_id)
          from braintrust_position_citations pc
          join braintrust_positions pos on pos.id = pc.position_id
          join braintrust_compiles c on c.id = pos.compile_id and c.status = 'current'
          join braintrust_people pe on pe.id = c.person_id
         where pe.slug = $1) as cited`,
    [person],
  );

  const row = rows[0];
  return {
    retrieved: Number(row?.retrieved ?? 0),
    coveredItems: Number(row?.cited ?? 0),
  };
}

/** Embed a list of texts in batches of `EMBED_BATCH`, never two batches at once. */
async function embedAll(embedder: Embedder, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let index = 0; index < texts.length; index += EMBED_BATCH) {
    const batch = texts.slice(index, index + EMBED_BATCH);
    const embedded = await embedder.embed(batch);
    for (const vector of embedded) vectors.push(vector);
  }
  return vectors;
}

/**
 * The whole corpus is the denominator, not a cut: `goldenQuestions` is `limit`-bounded,
 * and the bars must not hide a persona by asking fewer questions than another.
 */
const WHOLE_CORPUS = Number.MAX_SAFE_INTEGER;

function zeroRungs(): Record<Rung, number> {
  return Object.fromEntries(RUNGS.map((rung) => [rung, 0])) as Record<Rung, number>;
}

/**
 * Whether the served retrieval is ready, checked once before a whole measurement run.
 *
 * The bars are decided on the answer `findPositions` actually serves, so an unready gate
 * must stop the run before it opens or clears anything — the caller fails open.
 */
export async function retrievalReady(retrieval: QueryGate): Promise<boolean> {
  const readiness = await retrieval.check();
  return readiness.ready;
}

/**
 * Calibrating the `fit` grade, per Person, on every Compile.
 *
 * `fit` says how well one Position answers the question asked, and for three versions it
 * graded a quantity that carried no information about the question at all. Measured across
 * 92 Positions from all five live Personas, judged twice: the number that shipped ordered
 * two Positions the way a reader would **51%** of the time, where 50% is a coin. Grading the
 * Position's own statement gets **80%**, and **82%** under a second judge shown only the
 * person's own quotes and never braintrust's sentence. See
 * https://github.com/cgbarlow/braintrust/issues/140.
 *
 * **The statement score needs its own cut, and borrowing the gate's would have shipped the
 * fourth defect.** The floor is measured in Chunk similarity; the statement score is not the
 * same quantity and does not live on the same scale. Applied naively, Chris Barlow's
 * measured floor of 0.44 would have endorsed the mean *unrelated* statement (0.467). The
 * measured curve on that Corpus:
 *
 * | cut | unrelated endorsed (of 38) | answers lost (of 15) |
 * |---:|---:|---:|
 * | 0.48 | 14 | 0 |
 * | 0.52 | 11 | 1 |
 * | **0.54** | **6** | **1** |
 * | 0.62 | 1 | 5 |
 *
 * Against 21 of 38 for the grade that shipped. ~0.54 is where it lands *there*, and that
 * number goes in no constant here: it is measured on every Compile the way the floor is.
 *
 * **Same machinery as ./selectivity.ts, one group different.** The out-group is the same
 * fixed, generic, off-corpus questions — nobody braintrust plausibly models has published
 * about poaching an egg, so it needs no per-Person authoring. The in-group cannot be the
 * Position statements themselves, because a statement compared to itself scores 1.0 and
 * measures nothing: it is **the person's own cited quotes**, which are real published
 * sentences about the things this Persona holds, lexically distinct from the synthesiser's
 * paraphrase of them. That is deliberately the reading the probe's *second* judge was given
 * — shown only the quotes, never braintrust's sentence — which is the reading that
 * structurally handicaps the statement score, and which it won under anyway.
 *
 * **Nothing here may fail a Compile, and nothing here may invent a number.** A Persona that
 * could not be measured still serves; it declines to grade and says so in the receipts. That
 * is not the floor's rule, and the difference is the point: a floor has a cautious direction
 * — point it up and an uncalibrated Persona declines more — and a grade has none. `distant`
 * on something that answers and `close` on something that does not are both wrong, in
 * opposite directions. See ../unmeasured.ts.
 */

import type { Db } from '../db.js';
import { statementScores } from '../find.js';
import { vectorLiteral, type Embedder } from '../retrieval/embed.js';
import { ANCHOR, OFF_CORPUS_PROBES } from './selectivity.js';

/**
 * How many of the Person's own quotes are sampled as the in-group. The spread matters more
 * than the count, and every extra probe is an embedding call inside the expensive part of
 * braintrust.
 */
export const IN_CORPUS_QUOTES = 12;

/**
 * Below this many quotes, the in-group's minimum means nothing and a cut set from two
 * sentences is a guess wearing a measurement's authority. Declines instead.
 */
export const MIN_IN_CORPUS_QUOTES = 4;

export type FitSeparation = 'separated' | 'overlapping' | 'not_measurable';

export type CalibratedFit = {
  /**
   * Where a statement stops being unrelated and starts being an answer. **Null means the
   * Persona does not grade at all** — never a borrowed number, and never the floor.
   */
  cut: number | null;
  /** The gap between the two groups: the scale a grade is expressed in. Null with `cut`. */
  span: number | null;
  separation: FitSeparation;
  /** The weakest in-corpus quote, and the strongest off-corpus question. */
  in_low: number | null;
  out_high: number | null;
  probes: { in: number; out: number };
  /** Why, in one line, for whoever reads `corpus_stats` and wonders why nothing is graded. */
  note: string;
};

/**
 * The honest answer when there is nothing to measure with: no cut, no span, and every
 * Position in every answer comes back ungraded rather than graded against a guess.
 */
export const notGradeable = (reason: string): CalibratedFit => ({
  cut: null,
  span: null,
  separation: 'not_measurable',
  in_low: null,
  out_high: null,
  probes: { in: 0, out: 0 },
  note:
    `${reason} This persona's answers carry no fit grade — a grade has no cautious value ` +
    'to fall back to, so braintrust declines rather than guessing. The positions and their ' +
    'citations are unaffected.',
});

export type CalibrateFitDeps = {
  db: Db;
  embedder: Embedder;
  /** The Compile whose statements were just embedded. Its rows are the whole in-group. */
  compileId: string;
  /** Every Position on that Compile, by id. */
  positionIds: string[];
  /** The Person's own published sentences, as the citations recorded them. */
  quotes: string[];
};

/**
 * Measure where this Person's statements stop being unrelated, through the same
 * `statementScores` the server grades with.
 *
 * Using the server's own function rather than a second implementation of the same idea is
 * the whole reason the number can be trusted: a cut calibrated against a lookalike would be
 * calibrating a function nobody runs.
 */
export async function calibrateFit(deps: CalibrateFitDeps): Promise<CalibratedFit> {
  if (deps.positionIds.length === 0) {
    return notGradeable('This compile wrote no positions to grade against.');
  }

  const quotes = spread(
    deps.quotes.map((quote) => quote.trim()).filter((quote) => quote !== ''),
    IN_CORPUS_QUOTES,
  );

  if (quotes.length < MIN_IN_CORPUS_QUOTES) {
    return notGradeable(
      `Only ${quotes.length} quote(s) to probe with, and ${MIN_IN_CORPUS_QUOTES} are needed.`,
    );
  }

  const inTops = await topsFor(deps, quotes);
  const outTops = await topsFor(deps, OFF_CORPUS_PROBES);

  if (inTops.length < MIN_IN_CORPUS_QUOTES || outTops.length === 0) {
    return notGradeable('The embeddings endpoint did not return enough vectors to measure.');
  }

  const inLow = Math.min(...inTops);
  const outHigh = Math.max(...outTops);
  const probes = { in: inTops.length, out: outTops.length };

  if (outHigh >= inLow) {
    // The endpoint cannot tell one of this Person's own sentences from a question about
    // poaching an egg, on these statements. There is no scale to grade in, and inventing
    // one is how `fit` shipped wrong three times.
    return {
      cut: null,
      span: null,
      separation: 'overlapping',
      in_low: round(inLow),
      out_high: round(outHigh),
      probes,
      note:
        "This person's own quotes and a set of off-corpus questions did not separate against " +
        'their position statements on this embeddings model, so there is no measured scale ' +
        'and answers carry no fit grade.',
    };
  }

  return {
    // Anchored near the off-corpus ceiling rather than at the midpoint, for the same reason
    // the floor is: the in-group is *optimistic*. A cited quote is a real published sentence
    // about something this Persona holds, so it scores higher against the statement than a
    // reader's fuzzier question will, and the weakest quote therefore overestimates where
    // genuine questions bottom out. A midpoint would inherit that optimism and start
    // grading real answers `distant`.
    cut: round(outHigh + (inLow - outHigh) * ANCHOR),
    span: round(inLow - outHigh),
    separation: 'separated',
    in_low: round(inLow),
    out_high: round(outHigh),
    probes,
    note:
      'Measured on this compile: the cut sits above every off-corpus question and below ' +
      "every one of this person's own quotes, scored against their own statements.",
  };
}

/**
 * Evenly spread rather than the first N. Quotes arrive grouped by Position, and the top of
 * the list would sample one corner of what the Person writes about.
 */
function spread(values: string[], wanted: number): string[] {
  if (values.length <= wanted) return values;

  const step = values.length / wanted;
  const sampled: string[] = [];
  for (let index = 0; sampled.length < wanted; index += 1) {
    sampled.push(values[Math.floor(index * step)]!);
  }
  return sampled;
}

/** The best statement score each question reaches, dropping any the endpoint could not embed. */
async function topsFor(deps: CalibrateFitDeps, questions: string[]): Promise<number[]> {
  const vectors = await deps.embedder.embed(questions);
  const tops: number[] = [];

  for (const vector of vectors) {
    if (!vector) continue;
    const scores = await statementScores(
      deps.db,
      deps.positionIds,
      vectorLiteral(vector),
      deps.embedder.model,
    );
    if (scores.size === 0) continue;
    tops.push(Math.max(...scores.values()));
  }

  return tops;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

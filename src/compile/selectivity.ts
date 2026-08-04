/**
 * Calibrating the off-corpus gate, per Person, on every Compile.
 *
 * The gate ([find.ts](../find.ts)) refuses to answer when a question merely *lands* in a
 * Corpus rather than *selecting* it. Deciding how far clear is clear enough needs a
 * threshold, and that threshold is a property of whichever embeddings model an operator
 * points braintrust at — a fact which was true, correctly reasoned, and then used to
 * justify handing the problem to a human. #123 shipped a command and a startup warning.
 *
 * **The conclusion did not follow.** braintrust cannot ship a *constant*; it can perfectly
 * well ship a *measurement*, because it is already holding everything the measurement
 * needs. See https://github.com/cgbarlow/braintrust/issues/128.
 *
 * **The in-group is the Persona's own Positions.** A compiled Position is, by
 * construction, a claim this Corpus supports with dated citations — so embedding its
 * statement gives a question the Corpus *must* be able to answer. Nothing to author,
 * nothing to maintain, and it exists for every Person the moment they compile. That is the
 * property a hand-written probe file could never have.
 *
 * **The out-group is fixed and generic**, and is the only hand-written thing left in the
 * loop. Poaching an egg is off-corpus for anybody braintrust plausibly models, so it needs
 * no per-Person authoring and therefore costs no maintenance.
 *
 * **Re-measuring on every Compile dissolves drift rather than managing it.** The gate
 * compares against the median of the nearest 400 Chunks, which for a 19-item Corpus is the
 * middle of the whole thing and for a 516-item one is the middle of the nearest 5% — two
 * statistics sharing a name, with Corpora crossing between them silently as they grow. A
 * value measured once cannot survive that. A value re-measured on every rebuild never has
 * to.
 *
 * **Nothing here may fail a Compile.** A Persona that could not be calibrated is still a
 * Persona; it falls back and says so.
 */

import type { Db } from '../db.js';
import { selectivity, SELECTIVITY_MARGIN } from '../find.js';
import { vectorLiteral, type Embedder } from '../retrieval/embed.js';

/**
 * Questions no Person braintrust models has published about. Deliberately mundane: a
 * question about a rival technology would sit genuinely near an AI commentator's Corpus and
 * would be measuring something else.
 */
export const OFF_CORPUS_PROBES = [
  'the correct water temperature for poaching an egg',
  'how to prune tomato plants so they fruit better',
  'what the offside rule is in football',
  'how to replace the inner tube on a bicycle wheel',
  'which key Beethoven’s fifth symphony is written in',
  'how long to leave bread dough to prove',
  'the best way to get a wine stain out of a carpet',
  'what causes the tides',
];

/**
 * How many Positions are sampled as the in-group. The spread matters more than the count —
 * every extra probe is an embedding call inside a Compile that is already the expensive
 * part of braintrust.
 */
export const IN_CORPUS_PROBES = 12;

/**
 * Below this many measurable Positions, the in-group is too small for its minimum to mean
 * anything, and a threshold set from two questions is a guess with a measurement's
 * authority. Falls back instead.
 */
export const MIN_IN_CORPUS = 4;

/**
 * Where the threshold sits between the two groups, as a fraction of the gap, measured up
 * from the off-corpus ceiling.
 *
 * **Not the midpoint, and the asymmetry is the point.** Position statements are the
 * synthesiser's paraphrase of what the Corpus says — semantically dead-centre, and lexically
 * distinct from the source text, which is what makes them a fair test of meaning rather than
 * of vocabulary. But they are an *optimistic* in-group: a question a human actually asks is
 * fuzzier and will score lower than any Position statement. So the weakest Position margin
 * **overestimates** where genuine in-corpus questions bottom out, and a midpoint threshold
 * would inherit that optimism and start refusing real questions.
 *
 * Anchoring near the off-corpus ceiling keeps the thing the gate exists to stop — a
 * confident answer to a question nobody wrote about — while leaving the widest possible
 * margin for real questions that are less articulate than a compiled Position.
 */
export const ANCHOR = 0.25;

export type SelectivitySeparation = 'separated' | 'overlapping' | 'not_measurable';

export type CalibratedSelectivity = {
  margin: number;
  separation: SelectivitySeparation;
  /** The weakest in-corpus probe, and the strongest off-corpus one. Null when unmeasured. */
  in_low: number | null;
  out_high: number | null;
  probes: { in: number; out: number };
  /** Why, in one line, for whoever reads corpus_stats and wonders. */
  note: string;
};

/** The honest answer when there is nothing to measure with. Never an invented number. */
export const notMeasurable = (reason: string): CalibratedSelectivity => ({
  margin: SELECTIVITY_MARGIN,
  separation: 'not_measurable',
  in_low: null,
  out_high: null,
  probes: { in: 0, out: 0 },
  note: `${reason} Falling back to the shipped default, which is not a measured value.`,
});

export type CalibrateDeps = {
  db: Db;
  embedder: Embedder;
  person: string;
  /** The statements just written for this Compile. */
  statements: string[];
};

/**
 * Measure this Person's gate, through the same `selectivity()` the server calls.
 *
 * Using the server's own function rather than a second implementation of the same idea is
 * the whole reason this can be trusted: a threshold calibrated against a lookalike would be
 * calibrating a function nobody runs.
 */
export async function calibrateSelectivity(
  deps: CalibrateDeps,
): Promise<CalibratedSelectivity> {
  const statements = deps.statements.map((s) => s.trim()).filter((s) => s !== '');
  if (statements.length < MIN_IN_CORPUS) {
    return notMeasurable(
      `Only ${statements.length} position(s) to probe with, and ${MIN_IN_CORPUS} are needed.`,
    );
  }

  // Evenly spread rather than the first N: Positions arrive grouped by topic, and the top
  // of the list would sample one corner of the Corpus.
  const step = Math.max(1, Math.floor(statements.length / IN_CORPUS_PROBES));
  const sampled: string[] = [];
  for (let i = 0; i < statements.length && sampled.length < IN_CORPUS_PROBES; i += step) {
    sampled.push(statements[i]!);
  }

  const inMargins = await marginsFor(deps, sampled);
  const outMargins = await marginsFor(deps, OFF_CORPUS_PROBES);

  if (inMargins.length < MIN_IN_CORPUS || outMargins.length === 0) {
    return notMeasurable('The embeddings endpoint did not return enough vectors to measure.');
  }

  const inLow = Math.min(...inMargins);
  const outHigh = Math.max(...outMargins);
  const probes = { in: inMargins.length, out: outMargins.length };

  // The endpoint cannot tell covered from uncovered on this Corpus — #115's "the endpoint
  // is wrong for the job", arriving as a measurement. Refusing to serve is not on the
  // table, so the margin goes to the off-corpus ceiling: everything the off-corpus probes
  // reached is now refused, which is the most this instrument can honestly claim.
  if (outHigh >= inLow) {
    return {
      margin: round(outHigh),
      separation: 'overlapping',
      in_low: round(inLow),
      out_high: round(outHigh),
      probes,
      note:
        'In-corpus and off-corpus questions did not separate on this embeddings model, so ' +
        'the margin is set at the off-corpus ceiling. Real questions may be refused.',
    };
  }

  return {
    margin: round(outHigh + (inLow - outHigh) * ANCHOR),
    separation: 'separated',
    in_low: round(inLow),
    out_high: round(outHigh),
    probes,
    note:
      'Measured on this compile: the threshold sits above every off-corpus probe and below ' +
      'every position this persona holds.',
  };
}

async function marginsFor(deps: CalibrateDeps, questions: string[]): Promise<number[]> {
  const vectors = await deps.embedder.embed(questions);
  const margins: number[] = [];

  for (const vector of vectors) {
    if (!vector) continue;
    const field = await selectivity(deps.db, vectorLiteral(vector), {
      model: deps.embedder.model,
      person: deps.person,
      since: null,
      until: null,
    });
    if (field.top === null || field.median === null) continue;
    margins.push(field.top - field.median);
  }

  return margins;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

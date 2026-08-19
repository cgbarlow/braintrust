/**
 * What version of braintrust's rules built a Persona, and which of those rules have moved
 * since.
 *
 * `compiler_version` is compound on purpose: `code+measurement.synthesis.positions.revisions`.
 * Each part is bumped for its own reasons by whoever changes that half of the compiler, and
 * a Persona travels with all four so it can say which rules produced which of its parts.
 *
 * **Recording what moved does not license acting on it piecemeal.** A rules change rebuilds
 * the *whole* Persona — the parts are how braintrust decides what to *serve in the
 * meantime*, not what to rebuild. See docs/design/compiler.md §6.
 *
 * Kept apart from ./index.ts so the read path can compare versions without importing the
 * compiler: a reader asking what is current should not drag the thing that rebuilds it.
 */

import { VERSION } from '../version.js';
import { POSITION_VERSION, REVISION_VERSION, SYNTHESIS_VERSION } from './synthesis.js';

/**
 * Bumped when the measured layers change shape or the voice patterns change — the
 * hypothesis is part of the compiler, so a Persona should say which version of it
 * produced the numbers. `compiler_version` is on the Compile row and travels out through
 * both read tools, alongside the synthesis prompt version that wrote the other half.
 *
 * **`measured-2` is the mixed-Corpus change**: Voice now selects a population by length
 * and names it, and Coverage leads with words and carries `by_form`. The counts are the
 * same counts; *which Items they are counted over* is not, and a Persona has to be able
 * to say which rule measured it. `VOICE_MIN_WORDS` rides here too, so tuning the floor
 * rebuilds every Persona and the change is visible rather than silent.
 *
 * **`measured-4` is the gate measuring the right quantity.** `measured-3` calibrated
 * #115's selectivity margin, which the first live run showed measures the embeddings model
 * rather than the Corpus — three Personas, three sizes, one number, and a Persona refusing
 * its own subject. The floor is absolute top similarity now. Same machinery, same
 * automation; the quantity changed. See ./selectivity.ts.
 *
 * **`measured-5` is the unmeasured fallback pointing the right way.** Every floor
 * braintrust had ever measured sat between 0.44 and 0.52, and the fallback for a Persona
 * that had measured none was 0.35 — *below* the whole range, so an uncalibrated Persona
 * was more credulous than a calibrated one rather than more cautious. The measurement is
 * unchanged; what an unmeasured Persona does with the absence of one is not. See
 * ../unmeasured.ts.
 *
 * **`measured-6` is `fit` grading the thing it is about.** For three versions the grade
 * about the question was computed from the best Chunk of the best Item behind a Position —
 * a quantity every Position drawn from that Item shares, and one that orders answers the
 * way a reader would 51% of the time. It now grades the Position's own statement, which
 * needs a vector per Position and a cut measured on that distribution: two new measured
 * facts, and load-bearing here rather than documentary. Without the bump, every Persona
 * already compiled would keep serving grades from the discredited number until its subject
 * next published. See ./fit.ts.
 *
 * **`measured-3` was the self-calibrated gate**: a Compile now measures its own Persona's
 * selectivity margin and stores it (see ./selectivity.ts). A new measured fact is exactly
 * what this constant is for — and here it is load-bearing rather than documentary. A
 * Persona whose Corpus has not moved has no `has_unseen`, so **the only thing that can
 * rebuild it is this version changing.** Without the bump, every Persona compiled before
 * the calibration shipped would keep serving on the unmeasured fallback indefinitely,
 * waiting for its subject to publish something — which is the one condition that has
 * nothing to do with whether braintrust can now measure its gate.
 *
 * **`measured-7` is each statement carrying what it is worth against nothing in
 * particular.** A statement broad enough to be about anything is genuinely close to every
 * question, so it took the top slot for all of them — ethan-mollick's ten questions
 * returned four distinct Positions at rank 1. Every Compile now measures each statement
 * against the off-corpus probes and stores the mean, and the server ranks on the difference.
 * A new measured fact per Position, load-bearing exactly as `measured-3` and `measured-6`
 * were: a Persona compiled before it has no background, ranks raw, and would go on ranking
 * raw until its subject next published. See ./selectivity.ts `backgroundFor`.
 */
export const MEASUREMENT_VERSION = 'measured-7';

/**
 * What a Compile that could not compare revisions records instead of `revisions-1`.
 *
 * Revision detection needs an embeddings endpoint to find candidate pairs, and that
 * endpoint is allowed to be absent — the Core is measured from Item text and synthesised
 * from Notes, so a missing embedder delays the vectors rather than the Persona. But a row
 * claiming `revisions-1` when nothing was compared is a Persona asserting it looked for
 * changes of mind and found none, which is a different sentence from *nobody looked*.
 */
export const REVISION_SKIPPED = 'revisions-none';

/**
 * The layers braintrust compiles, and therefore the only ones it serves.
 *
 * **A layer braintrust has retired is not withheld — it is gone.** The two look alike from
 * the outside and are not the same fact. Withholding is a transient state a rebuild ends
 * (see {@link withheldLayers}); retirement is permanent, and if it were left to the rebuild
 * to enforce, every Persona compiled before the change would keep serving the retired layer
 * until its subject next published something.
 *
 * That is not hypothetical. Beliefs was a layer of conclusions sitting in a payload with
 * nothing to cite, and *it stops shipping when the fleet gets round to rebuilding* would have
 * left the whole point of retiring it waiting on a schedule. The read path filters on this
 * list instead, so the guarantee holds for a Persona compiled a year ago. The rows are
 * deleted by the rebuild that replaces them; nothing reads them in the meantime.
 */
export const SERVED_LAYERS = ['coverage', 'reasoning', 'voice'] as const;

/** Stored layers braintrust no longer compiles. Never served, whatever the row says. */
export function retiredLayers(stored: string[]): string[] {
  return stored.filter((layer) => !(SERVED_LAYERS as readonly string[]).includes(layer));
}

/** The four halves of the compiler that move independently, plus the code they run in. */
export type CompilerPart = 'code' | 'measurement' | 'synthesis' | 'positions' | 'revisions';

export const COMPILER_PARTS: CompilerPart[] = [
  'code',
  'measurement',
  'synthesis',
  'positions',
  'revisions',
];

/**
 * **The version records what this Compile could actually do, not what the code supports.**
 *
 * It is not a constant, because the same code produces a different Persona depending on
 * what it was configured with — and the difference is exactly the thing a later run has to
 * notice, via `CompilablePerson.stale_compiler`.
 */
export function compilerVersion(options: { revisions: boolean }): string {
  const revisions = options.revisions ? REVISION_VERSION : REVISION_SKIPPED;
  return `${VERSION}+${MEASUREMENT_VERSION}.${SYNTHESIS_VERSION}.${POSITION_VERSION}.${revisions}`;
}

/** The fully-capable string. Kept for callers that mean "the current code", not "this run". */
export const COMPILER_VERSION = compilerVersion({ revisions: true });

/**
 * The parts of a compound version, or null when it is not one.
 *
 * Null is a real answer rather than a failure: a Persona compiled by an older braintrust
 * may carry a version this code cannot decompose, and the honest reading of that is *every
 * part may have moved* — which is what {@link movedParts} does with it.
 */
export function compilerParts(version: string): Record<CompilerPart, string> | null {
  const [code, rest] = splitOnce(version.trim(), '+');
  if (rest === null) return null;

  const [measurement, synthesis, positions, revisions, ...extra] = rest.split('.');
  if (!measurement || !synthesis || !positions || !revisions || extra.length > 0) return null;

  return { code, measurement, synthesis, positions, revisions };
}

/**
 * Which rules have moved under a Persona since it was built.
 *
 * An unparseable or missing version reports **every** part moved, because braintrust
 * cannot tell which one did — the same rule as everywhere else here: what has not been
 * measured takes its most conservative value. See ../unmeasured.ts.
 */
export function movedParts(theirs: string | null, ours: string = COMPILER_VERSION): CompilerPart[] {
  const mine = compilerParts(ours);
  const yours = theirs === null ? null : compilerParts(theirs);
  if (!mine || !yours) return [...COMPILER_PARTS];

  return COMPILER_PARTS.filter((part) => yours[part] !== mine[part]);
}

/**
 * Which layers each part *wrote the prose of*.
 *
 * Only synthesised text appears here, and that is the whole point. A count has a
 * conservative direction — take the cautious value and serve it — but a paragraph a model
 * already wrote does not: there is no cautious way to read prose produced under a rule that
 * has since changed. So its half of the rule is different, and stricter: **synthesised text
 * governed by a part that has moved is absent until rebuilt.**
 *
 * `measurement` governs no prose. Voice and Coverage are counts and the instruction derived
 * from them, not a model's paragraphs, and their conservative direction is a value rather
 * than an absence. `positions` and `revisions` govern rows that never travel without the
 * citations under them, which is what makes them checkable rather than merely stale.
 *
 * **This list shortens as prose leaves the Core, and shortening it is not a relaxation.**
 * Beliefs left when it stopped being a layer, so there is nothing left to withhold: a
 * through-line is a row rather than a paragraph, and it is retrieved rather than served.
 * Only a layer this map still serves whole can appear here. See {@link retiredLayers}.
 */
export const SYNTHESISED_LAYERS: Record<CompilerPart, string[]> = {
  code: [],
  measurement: [],
  synthesis: ['reasoning'],
  positions: [],
  revisions: [],
};

/**
 * The layers a Persona on this version may not serve, in the order the compiler writes
 * them. Empty for a Persona built under the current rules, which is every Persona a
 * rebuild has caught up with.
 */
export function withheldLayers(theirs: string | null, ours: string = COMPILER_VERSION): string[] {
  const moved = new Set(movedParts(theirs, ours));
  return COMPILER_PARTS.filter((part) => moved.has(part))
    .flatMap((part) => SYNTHESISED_LAYERS[part])
    .filter((layer, index, all) => all.indexOf(layer) === index);
}

function splitOnce(value: string, separator: string): [string, string | null] {
  const at = value.indexOf(separator);
  return at === -1 ? [value, null] : [value.slice(0, at), value.slice(at + separator.length)];
}

/**
 * Whether a Position's statement is carried by the citations attached to it.
 *
 * A served quote is already checked against the item it was drawn from — #299 and #320.
 * The **statement** never was: it is a model's sentence over claims that are real, and
 * nothing verified that the sentence itself follows from them. Found live: a Position
 * stating "AI progress is jagged; bottlenecks and reverse salients shape advancement"
 * citing "even if AI becomes superhuman at analysis and PowerPoint, I don't think that
 * means AI necessarily replaces the jobs of consultants and designers" — a real quote that
 * does not carry that claim.
 *
 * **This is the model call and nothing else** — batching new Positions into one prompt and
 * reading back which ones hold up. Deciding *which* Positions are new, recording the
 * verdict, and opening the fault on a failure all live in ../verify/support.ts, the same
 * split ./revisions.ts and ../verify/coverage.ts already draw between "ask the model" and
 * "write the ledger".
 *
 * See docs/design/map-300-spec.md §6 and https://github.com/cgbarlow/braintrust/issues/334.
 */

import type { BuiltPosition, PositionCitation } from './positions.js';
import type { SupportVerdict, Synthesiser } from './synthesis.js';

/**
 * How many Positions one call is asked to judge. The same shape as `JUDGE_BATCH` in
 * ./revisions.ts and for the same reason: small enough that each Position is read on its
 * own rather than skimmed as one of forty.
 */
export const SUPPORT_BATCH = 10;

/** How many citations of one Position are shown. A Position with more still gets a verdict — from its strongest showing, not its whole list — and a call's cost stays bounded by the batch rather than by how many times someone has said the same thing. */
export const MAX_QUOTES_SHOWN = 6;

/** How much of one quote the judge sees. The same bound ./revisions.ts uses for the same reason: their own words, not the whole item. */
export const SUPPORT_QUOTE_MAX_CHARS = 400;

export type SupportResult = {
  /** Verdicts, keyed by the Position's own slug. Missing means the judge dropped it. */
  verdicts: Map<string, SupportVerdict>;
  judged: number;
  /** A verdict naming a slug this call never sent. Dropped rather than recorded. */
  dropped_unknown: number;
};

/**
 * Judges every Position it is handed — the caller has already decided which ones are new
 * and worth asking about. Batched so one call's cost stays bounded regardless of how many
 * Positions a single Compile is checking for the first time.
 */
export async function judgeStatementSupport(
  positions: BuiltPosition[],
  synthesiser: Synthesiser,
): Promise<SupportResult> {
  const verdicts = new Map<string, SupportVerdict>();
  let dropped = 0;

  for (let index = 0; index < positions.length; index += SUPPORT_BATCH) {
    const batch = positions.slice(index, index + SUPPORT_BATCH);
    const sent = new Set(batch.map((position) => position.slug));

    for (const verdict of await synthesiser.judgeSupport(supportDigest(batch))) {
      // The same rule as a claim ref a clusterer invented, or a judgement on a revision
      // pair braintrust never sent: a verdict on a slug that was not in this batch is a
      // verdict on something braintrust cannot show anyone.
      if (!sent.has(verdict.slug) || verdicts.has(verdict.slug)) {
        dropped += 1;
        continue;
      }
      verdicts.set(verdict.slug, verdict);
    }
  }

  return { verdicts, judged: verdicts.size, dropped_unknown: dropped };
}

/**
 * One Position per block: its statement, and its own quotes — the only evidence the judge
 * is shown, and the only evidence the person's own words can be checked against.
 */
export function supportDigest(positions: BuiltPosition[]): string {
  return positions
    .map((position) =>
      [
        `[${position.slug}] ${position.statement}`,
        ...position.citations.slice(0, MAX_QUOTES_SHOWN).map((citation) => `  quote: "${quoteOf(citation)}"`),
      ].join('\n'),
    )
    .join('\n\n');
}

function quoteOf(citation: PositionCitation): string {
  return citation.quote.replace(/\s+/g, ' ').slice(0, SUPPORT_QUOTE_MAX_CHARS);
}


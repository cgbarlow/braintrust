/**
 * Scoring an extractor, with no model in the path.
 *
 * **Every measure here is a count.** That is the same rule Voice and Coverage hold, and it
 * matters more here than anywhere: a harness that used a model to judge a model could fail
 * exactly where the thing it is judging fails, and quietly agree with it. The verifier
 * braintrust already runs *is* an objective scorer — a quote is in the body or it is not —
 * so the harness's job is to count what it decided rather than to form a view.
 *
 * **The corpus is the eval set.** Real Items, already retrieved, immutable — so the
 * benchmark cannot drift away from the job, and there are no fixtures anybody has to keep
 * honest. The measures below are what distinguish two models on braintrust's actual work.
 *
 * See docs/design/compiler.md §1.
 */

import type { VerifiedClaim } from '../notes/verify.js';

/** Where a quote sits in its Item, as a fraction of the way through. */
export type QuotePosition = { at: number; words: number };

/**
 * One Item's worth of evidence about an extractor.
 *
 * `offered` and `nearly` are optional because a Note does not record them: the rejected
 * quotes are deliberately never stored, so they exist only while the read is happening. A
 * generation scored **retroactively** from Notes already in the database therefore reports
 * four of the measures and not the other two — which is worth having, because the
 * incumbent's baseline then costs nothing at all.
 */
export type ItemEvidence = {
  external_id: string;
  words: number;
  /** Claims the model returned, before verification. Absent when scored from stored Notes. */
  offered?: number | undefined;
  /** Of the dropped ones, how many differed only in punctuation and case. */
  nearly?: number | undefined;
  kept: QuotePosition[];
  seconds?: number | undefined;
};

export type Scorecard = {
  generation: string;
  items: number;
  claims_kept: number;
  /**
   * Kept over offered. **The headline**, and the only one that needs a live run: it is the
   * proportion of what a model said it found that braintrust could actually verify.
   */
  fidelity: number | null;
  /** Of what was dropped, the share that was punctuation and case rather than wrong words. */
  punctuation_share: number | null;
  /**
   * **The guard against gaming the verifier.** A model that quotes three words always
   * passes and says nothing; fidelity alone would rank it first.
   */
  median_quote_words: number;
  /**
   * **Long context, measured on the real corpus rather than on RULER.** The share of quotes
   * drawn from the last third of their Item. A model that cannot hold a four-hour lecture
   * quotes the first ten minutes and stops, and no fidelity number would ever show it.
   */
  late_span_share: number;
  /** Items where nothing survived verification at all. */
  empty_items: number;
  /** Reading effort, normalised for length — catches over- and under-reading alike. */
  claims_per_1k_words: number;
  /** Whether it is viable on the operator's own hardware, which no benchmark can say. */
  seconds_per_item: number | null;
};

/** The last third of an Item. A quote starting past this is evidence the model read on. */
export const LATE_SPAN_FROM = 2 / 3;

export function scoreItems(generation: string, items: ItemEvidence[]): Scorecard {
  const quotes = items.flatMap((item) => item.kept);
  const offered = sum(items.map((item) => item.offered ?? 0));
  const measured = items.filter((item) => item.offered !== undefined);
  const dropped = offered - sum(measured.map((item) => item.kept.length));
  const nearly = sum(items.map((item) => item.nearly ?? 0));
  const timed = items.filter((item) => item.seconds !== undefined);
  const words = sum(items.map((item) => item.words));

  return {
    generation,
    items: items.length,
    claims_kept: quotes.length,
    fidelity: measured.length === 0 ? null : sum(measured.map((i) => i.kept.length)) / Math.max(1, offered),
    punctuation_share: measured.length === 0 || dropped === 0 ? null : nearly / dropped,
    median_quote_words: median(quotes.map((quote) => quote.words)),
    late_span_share:
      quotes.length === 0
        ? 0
        : quotes.filter((quote) => quote.at >= LATE_SPAN_FROM).length / quotes.length,
    empty_items: items.filter((item) => item.kept.length === 0).length,
    claims_per_1k_words: words === 0 ? 0 : (quotes.length / words) * 1000,
    seconds_per_item: timed.length === 0 ? null : sum(timed.map((i) => i.seconds ?? 0)) / timed.length,
  };
}

/**
 * Where each kept quote sits in the body, and how long it is.
 *
 * The stored quote is the body's own characters, so `indexOf` finds it — which is the
 * property that makes retroactive scoring possible at all: a Note written months ago can
 * still be placed in its Item without re-reading anything.
 */
export function positionsOf(claims: VerifiedClaim[], body: string): QuotePosition[] {
  const positions: QuotePosition[] = [];

  for (const claim of claims) {
    const at = body.indexOf(claim.quote);
    if (at < 0) continue;
    positions.push({
      at: body.length === 0 ? 0 : at / body.length,
      words: countWords(claim.quote),
    });
  }

  return positions;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * The scorecards side by side, widest column first.
 *
 * A comparison rather than a verdict: nothing here decides which model wins, because the
 * trade between fidelity, quote length and late spans is the operator's to make and
 * depends on what their corpus is mostly made of.
 */
export function compare(cards: Scorecard[]): string {
  const rows: [string, (card: Scorecard) => string][] = [
    ['items', (card) => String(card.items)],
    ['claims kept', (card) => String(card.claims_kept)],
    ['fidelity', (card) => percent(card.fidelity)],
    ['— punctuation only', (card) => percent(card.punctuation_share)],
    ['median quote words', (card) => String(card.median_quote_words)],
    ['late-span share', (card) => percent(card.late_span_share)],
    ['items with nothing kept', (card) => String(card.empty_items)],
    ['claims per 1k words', (card) => card.claims_per_1k_words.toFixed(2)],
    ['seconds per item', (card) => (card.seconds_per_item === null ? '—' : card.seconds_per_item.toFixed(1))],
  ];

  const label = Math.max(...rows.map(([name]) => name.length));
  const width = Math.max(...cards.map((card) => card.generation.length), 12);
  const header = `${''.padEnd(label)}  ${cards.map((card) => card.generation.padStart(width)).join('  ')}`;

  return [
    header,
    `${''.padEnd(label, '-')}  ${cards.map(() => ''.padEnd(width, '-')).join('  ')}`,
    ...rows.map(
      ([name, read]) =>
        `${name.padEnd(label)}  ${cards.map((card) => read(card).padStart(width)).join('  ')}`,
    ),
  ].join('\n');
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

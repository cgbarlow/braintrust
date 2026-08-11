/**
 * Through-lines: what someone broadly holds, earned at retrieval time rather than recited
 * from a standing brief.
 *
 * A through-line is a claim braintrust inferred across a Person's work. It exists beside the
 * quoted claims rather than above them, and almost none of the Position apparatus survives
 * the demotion — the question was never how a through-line qualifies as a Position, it is
 * what is left once one has to be earned.
 *
 * **No date.** `held_since` is a property of the Corpus, and the only date available here is
 * the oldest Item in whichever readings surfaced the entry — a fact about braintrust's
 * reading schedule rather than about the person's life. So a through-line also cannot be
 * `revised`, `unsettled` or `drifting`: all three are dated relations.
 *
 * **No verbatim, ever.** An illustrative quote and a supporting one are indistinguishable
 * once printed, and a Persona reads whichever it is handed as support.
 *
 * **Ranked, not barred.** The four best-supported through-lines ship for everyone, ordered
 * recurrence first, breadth second. A claim seen in one reading is outranked instead of
 * deleted. A Person whose work fits in a single reading gets four, ranked on breadth alone.
 *
 * **No retrieval path of its own.** It rides with an answer that already matched rather than
 * competing for the top of one, which is why it needs no embedding and no gate.
 *
 * **Never outnumbers the Positions beside it.** [#198](https://github.com/cgbarlow/braintrust/issues/198)
 * enforces this as a proportion: an answer cannot carry more through-lines than Positions.
 * When the cap bites, the through-lines kept are those touching the most of the answer's own
 * Positions. Ties fall back to the Persona's standing order. An answer with no Positions
 * carries no through-lines at all. See ../find.ts.
 *
 * **That flatness is now every sentence's, not this layer's alone.**
 * [#202](https://github.com/cgbarlow/braintrust/issues/202) took verbatim, item title and date
 * out of the unasked answer, so a through-line no longer sounds different from a quoted claim
 * — it sounds the same because everything is now spoken the way this layer already was. What
 * stays true here is the *pairing*: a through-line still rides only with positions the record
 * stands behind, because what makes flat speech affordable is that braintrust can produce the
 * record when asked, and for a through-line alone it cannot.
 *
 * **Accepted costs, all named and all chosen.** A through-line that is not really there gets
 * spoken confidently in someone's voice, and nothing a listener hears gives them anywhere to
 * go. Losing *they have held this a long time* is a real loss — duration is the most
 * interesting thing about a durable commitment and the one thing braintrust cannot honestly
 * measure. A claim seen in only one reading is now spoken in someone's voice with nothing a
 * listener can point at. And one extra synthesis call per Persona is now paid for a ranking
 * signal rather than a rule.
 *
 * See docs/design/compiler.md and https://github.com/cgbarlow/braintrust/issues/167.
 */

import type { StoredNote } from '../notes/store.js';
import { DIGEST_BUDGET_CHARS, noteDigest } from './infer.js';
import { foldByMerging } from './merge.js';
import { type SynthesisedEntry, type Synthesiser } from './synthesis.js';

/**
 * The fewest Notes that make a reading a reading.
 *
 * **Chosen to define what a reading is, not to hold a bar in place.**
 * A reading is a budget-sized pass over the Notes, and a trailing stretch shorter than this
 * folds into the preceding reading.
 */
export const MIN_NOTES_PER_READING = 3;

/**
 * How many through-lines ship for everyone. A fixed-size ranked list cannot empty itself
 * and cannot change size, so neither jitter nor starvation can express themselves here.
 */
export const THROUGH_LINES_SHIPPED = 4;

/**
 * A Corpus divided into readings: contiguous, in publication order, and never overlapping.
 *
 * **This is [#160](https://github.com/cgbarlow/braintrust/issues/160), and it decides how
 * the Corpus is read.** Four choices, each with a direction of failure:
 *
 * **Split by count, not by date.** A date split follows the person's rhythm, which sounds
 * like the meaningful choice and is the fragile one — a quiet six months produces an empty
 * division, and the same instrument then means something different for every person in the
 * fleet.
 *
 * **Contiguous, in the order the Notes already arrive.** The artefact this rule exists to
 * exclude is a pattern produced by *what was read side by side*. Contiguous divisions
 * maximise topical clustering *within* a division, so surviving two of them means the entry
 * crossed a topical era. Interleaving would make every division a representative sample of
 * the whole Corpus, in which anything general appears everywhere — the generous failure.
 *
 * **Never overlapping**, for the same reason.
 *
 * **A Corpus too small to divide reads once.** Recurrence is the first ranking signal, so
 * the half-split from [#160](https://github.com/cgbarlow/braintrust/issues/160) stays, and
 * keeps costing one extra synthesis call. A Corpus too small to divide reads once and ranks
 * on breadth alone rather than returning nothing.
 *
 * Returns an empty list only when there are no Notes at all (which is not a compile-time
 * state). A single reading is a real answer — the Persona ranks on breadth.
 */
export function readingsOf(
  notes: StoredNote[],
  budget = DIGEST_BUDGET_CHARS,
): StoredNote[][] {
  if (notes.length === 0) return [];

  const readings = byBudget(notes, budget);

  // One pass means the Corpus fits comfortably in a call, which is most Personas. Split in
  // half so recurrence can be the first ranking signal — the half-split from #160 stays,
  // and keeps costing one extra synthesis call.
  if (readings.length < 2) {
    if (notes.length < MIN_NOTES_PER_READING) {
      // Too small to divide: read once, rank on breadth alone.
      return [notes];
    }
    const half = Math.ceil(notes.length / 2);
    return [notes.slice(0, half), notes.slice(half)];
  }

  // A trailing stretch too short to be a reading folds into the one before it rather than
  // standing as a reading of two Notes. The alternative is a division that says *this
  // recurred* on the strength of one more Note.
  const last = readings[readings.length - 1]!;
  if (readings.length > 1 && last.length < MIN_NOTES_PER_READING) {
    readings[readings.length - 2]!.push(...last);
    readings.pop();
  }

  return readings;
}

/**
 * The same budget-sized division the inferred layers are folded along, at Note granularity
 * rather than digest granularity — so a reading can be counted as well as sent.
 */
function byBudget(notes: StoredNote[], budget: number): StoredNote[][] {
  const passes: StoredNote[][] = [];
  let current: StoredNote[] = [];
  let size = 0;

  for (const note of notes) {
    const digest = noteDigest(note);
    if (current.length > 0 && size + digest.length > budget) {
      passes.push(current);
      current = [];
      size = 0;
    }
    current.push(note);
    size += digest.length + 2;
  }

  if (current.length > 0) passes.push(current);
  return passes;
}

/** One through-line, as the compiler writes it. No date, no quote, and nothing to cite. */
export type ThroughLine = {
  slug: string;
  /**
   * The claim, as the reading that found it worded it. One sentence, kept word for word —
   * no step of a Compile rewords a Persona's own output.
   */
  statement: string;
  /** How many separate readings surfaced it. */
  readings: number;
  /** Item `external_id`s it was traced to. What decides which answers it rides with. */
  items: string[];
};

export type ThroughLineSet = {
  through_lines: ThroughLine[];
  /** How the Corpus was divided. One when it was too small to divide. */
  readings: number;
  /** Total candidates found before ranking. Zero when nothing was found. */
  candidates: number;
};

/** An entry, with the readings that produced it carried alongside. */
type Sighted = SynthesisedEntry & { readings: Set<number> };

/**
 * Read the Corpus in separate readings and return the best-supported through-lines, ranked.
 *
 * **Ranked, not barred.** Recurrence first (more readings = higher), breadth second (more
 * items = higher). The top four ship for everyone. A claim seen in one reading is outranked
 * instead of deleted.
 *
 * The threshold is applied after the merge and never before it. Two readings word the same
 * conviction differently, and *these two say the same thing* is the one judgement in this
 * file that needs a model — which is exactly what the merge already is. Counting first would
 * count wordings rather than convictions.
 */
export async function compileThroughLines(
  notes: StoredNote[],
  synthesiser: Synthesiser,
): Promise<ThroughLineSet> {
  const readings = readingsOf(notes);
  if (readings.length === 0) {
    return { through_lines: [], readings: 0, candidates: 0 };
  }

  const known = new Set(notes.map((note) => note.external_id));
  const found: Sighted[] = [];

  for (const [index, reading] of readings.entries()) {
    const digest = reading.map(noteDigest).join('\n\n');
    for (const entry of await synthesiser.synthesise(digest)) {
      found.push({ ...entry, readings: new Set([index]) });
    }
  }

  const folded = await foldByMerging(found, {
    line: (entry) => `${entry.label} — ${entry.body}`,
    combine: (members, clearest) => ({
      label: clearest.label,
      body: clearest.body,
      items: [...new Set(members.flatMap((member) => member.items))],
      readings: new Set(members.flatMap((member) => [...member.readings])),
    }),
    group: (digest) => synthesiser.group('through_lines', digest),
    budget: DIGEST_BUDGET_CHARS,
  });

  const candidates = folded.entries.length;

  // Rank: recurrence first, breadth second. A candidate that appeared in one reading is
  // ranked below one that recurred, never dropped for it.
  const ranked = [...folded.entries].sort((a, b) => {
    const readingsDiff = b.readings.size - a.readings.size;
    if (readingsDiff !== 0) return readingsDiff;
    return b.items.length - a.items.length;
  });

  // Cap at THROUGH_LINES_SHIPPED. A fixed-size ranked list cannot empty itself.
  const shipped = ranked.slice(0, THROUGH_LINES_SHIPPED);

  return {
    through_lines: shipped.flatMap((entry) => {
      const items = [...new Set(entry.items.filter((item) => known.has(item)))];
      if (items.length === 0) return [];

      return [
        {
          slug: slugOf(entry.label),
          statement: entry.label,
          readings: entry.readings.size,
          items,
        },
      ];
    }),
    readings: readings.length,
    candidates,
  };
}

/**
 * A stable handle for one through-line. Not spoken, and not a citation — it exists so a
 * maintainer reading two Compiles can tell whether the same conviction survived.
 */
export function slugOf(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug === '' ? 'through-line' : slug;
}

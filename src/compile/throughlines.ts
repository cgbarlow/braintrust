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
 * **The four best, for everyone.** The survives-two-readings bar is overturned: nothing
 * braintrust found is thrown away for failing to recur. Every entry that survives the
 * merge ships, ranked by recurrence first and breadth second, and at most four reach a
 * reader. [#157](https://github.com/cgbarlow/braintrust/issues/157) measured the old bar
 * taking a persona's whole layer to zero (11→1, 10→1, 10→0) and replaced it with a ranked
 * list that cannot empty itself.
 *
 * **No retrieval path of its own.** It rides with an answer that already matched rather than
 * competing for the top of one, which is why it needs no embedding and no gate.
 *
 * **Never the whole of an answer.** This is the load-bearing one: speaking a through-line
 * flatly, with no hedge and no attribution, is affordable only because something checkable is
 * always beside it. The two stand or fall together. See ../find.ts.
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
 * measure. And a Compile that came back empty because the synthesiser had a bad afternoon is
 * indistinguishable from one that came back empty because there was nothing.
 *
 * See docs/design/compiler.md and https://github.com/cgbarlow/braintrust/issues/167.
 */

import type { StoredNote } from '../notes/store.js';
import { DIGEST_BUDGET_CHARS, noteDigest } from './infer.js';
import { foldByMerging } from './merge.js';
import { type SynthesisedEntry, type Synthesiser } from './synthesis.js';

/**
 * How many through-lines may reach a reader — the four best, for everyone.
 *
 * A small integer on model output may rank, and may never bar. Both gates built that way
 * failed in opposite directions: the style floor jittered lines in and out (35 of 115
 * changing status), the two-reading bar took a persona's whole layer to zero (11→1, 10→1,
 * 10→0). A ranked list of fixed length cannot empty itself and cannot change size.
 *
 * [#157](https://github.com/cgbarlow/braintrust/issues/157)
 */
export const MAX_THROUGH_LINES = 4;

/**
 * The fewest Notes that make a reading a reading.
 *
 * **Chosen to keep an accepted cost true rather than because three is interesting.**
 * [#144](https://github.com/cgbarlow/braintrust/issues/144) priced *a person whose work fits
 * in one reading gets none*, Chris on five Items included, and three-per-reading is the
 * smallest floor that still says so. Two would have handed him through-lines and quietly
 * repriced a cost that was argued and accepted.
 *
 * Under the new rule (#157) this floor no longer holds an accepted cost in place — a Corpus
 * too small to divide reads once and ranks on breadth alone — but it still says what makes
 * a reading a reading.
 */
export const MIN_NOTES_PER_READING = 3;

/**
 * A Corpus divided into readings: contiguous, in publication order, and never overlapping.
 *
 * **This is [#160](https://github.com/cgbarlow/braintrust/issues/160).** Four choices, each
 * with a direction of failure:
 *
 * **Split by count, not by date.** A date split follows the person's rhythm, which sounds
 * like the meaningful choice and is the fragile one — a quiet six months produces an empty
 * division, and the same instrument then means something different for every person in the
 * fleet.
 *
 * **Contiguous, in the order the Notes already arrive.** The artefact this guard exists to
 * exclude is a pattern produced by *what was read side by side*. Contiguous divisions
 * maximise topical clustering *within* a division, so surviving two of them means the entry
 * crossed a topical era. Interleaving would make every division a representative sample of
 * the whole Corpus, in which anything general appears everywhere — the generous failure,
 * admitting exactly what the rule exists to exclude.
 *
 * **Never overlapping**, for the same reason.
 *
 * **A Corpus that fits in one pass is split in half**, because recurrence across eras is the
 * best ranking signal. A Corpus too small to divide reads once and ranks on breadth alone.
 *
 * Returns an empty list when the Corpus is too small to form even one reading. The caller
 * does one pass over the whole Corpus in that case and ranks on breadth alone.
 */
export function readingsOf(
  notes: StoredNote[],
  budget = DIGEST_BUDGET_CHARS,
): StoredNote[][] {
  if (notes.length < MIN_NOTES_PER_READING) return [];

  const readings = byBudget(notes, budget);

  // One pass means the Corpus fits comfortably in a call, which is most Personas. Halved by
  // count rather than left whole, because recurrence across eras is the best ranking signal.
  if (readings.length < 2) {
    const half = Math.ceil(notes.length / 2);
    return [notes.slice(0, half), notes.slice(half)];
  }

  // A trailing stretch too short to be a reading folds into the one before it rather than
  // standing as a reading of two Notes.
  const last = readings[readings.length - 1]!;
  if (readings.length > 1 && last.length < MIN_NOTES_PER_READING) {
    readings[readings.length - 2]!.push(...last);
    readings.pop();
  }

  return readings.length >= 1 ? readings : [];
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
  /** How many separate readings surfaced it. Higher is stronger — recurrence ranks first. */
  readings: number;
  /** Item `external_id`s it was traced to. What decides which answers it rides with. */
  items: string[];
};

export type ThroughLineSet = {
  through_lines: ThroughLine[];
  /** How the Corpus was divided. Zero when there was not enough to read twice. */
  readings: number;
  /** Entries that surfaced in exactly one reading. Not a failure — the rule working. */
  dropped_single_reading: number;
  /**
   * Total candidates found before ranking. Zero when nothing was found — the number that
   * tells the gate "a rule ate what braintrust found" apart from "there was nothing".
   */
  candidates: number;
};

/** An entry, with the readings that produced it carried alongside. */
type Sighted = SynthesisedEntry & { readings: Set<number> };

/**
 * Read the Corpus in separate readings and return the best through-lines, ranked.
 *
 * **Ranked by recurrence first, breadth second.** The survives-two-readings bar is
 * overturned — nothing is thrown away for appearing in only one reading. A claim that
 * recurred across eras of someone's work is spoken before one that did not; a claim seen in
 * only one reading is outranked rather than deleted.
 *
 * At most {@link MAX_THROUGH_LINES} reach a reader, because a fixed-length list cannot empty
 * itself.
 *
 * **The ranking is applied after the merge and never before it.** Two readings word the same
 * conviction differently, and *these two say the same thing* is the one judgement in this
 * file that needs a model — which is exactly what the merge already is. Counting first would
 * count wordings rather than convictions.
 */
export async function compileThroughLines(
  notes: StoredNote[],
  synthesiser: Synthesiser,
): Promise<ThroughLineSet> {
  const readings = readingsOf(notes);
  const known = new Set(notes.map((note) => note.external_id));
  const found: Sighted[] = [];

  if (readings.length === 0) {
    // Corpus too small to divide — read once and rank on breadth alone.
    const digest = notes.map(noteDigest).join('\n\n');
    for (const entry of await synthesiser.synthesise(digest)) {
      found.push({ ...entry, readings: new Set([0]) });
    }
  } else {
    for (const [index, reading] of readings.entries()) {
      const digest = reading.map(noteDigest).join('\n\n');
      for (const entry of await synthesiser.synthesise(digest)) {
        found.push({ ...entry, readings: new Set([index]) });
      }
    }
  }

  const folded = await foldByMerging(found, {
    line: (entry) => `${entry.label} — ${entry.body}`,
    combine: (members, clearest) => ({
      label: clearest.label,
      body: clearest.body,
      items: [...new Set(members.flatMap((member) => member.items))],
      // The union braintrust performs itself. The merge is handed wording and answers with
      // numbers; which readings an entry was seen in is arithmetic, and arithmetic has a
      // right answer.
      readings: new Set(members.flatMap((member) => [...member.readings])),
    }),
    group: (digest) => synthesiser.group('through_lines', digest),
    budget: DIGEST_BUDGET_CHARS,
  });

  // Rank: recurrence first (larger readings set), breadth second (more items).
  // Nothing is dropped for being single-reading — it is outranked rather than deleted.
  const ranked = folded.entries
    .map((entry) => {
      const items = [...new Set(entry.items.filter((item) => known.has(item)))];
      return { entry, items };
    })
    .filter(({ items }) => items.length > 0)
    .sort((a, b) => {
      if (b.entry.readings.size !== a.entry.readings.size) {
        return b.entry.readings.size - a.entry.readings.size;
      }
      return b.items.length - a.items.length;
    })
    .slice(0, MAX_THROUGH_LINES);

  return {
    through_lines: ranked.map(({ entry, items }) => ({
      slug: slugOf(entry.label),
      statement: entry.label,
      readings: entry.readings.size,
      items,
    })),
    readings: readings.length,
    // For reporting: how many entries appeared in only one reading (now ranked lower, not deleted).
    dropped_single_reading: folded.entries.filter((e) => e.readings.size < 2).length,
    // Everything the synthesiser found, counted before the attribution filter and the rank
    // cap ran — the number that lets the gate distinguish "a rule ate it" from "nothing".
    candidates: folded.entries.length,
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

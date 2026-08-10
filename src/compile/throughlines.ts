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
 * **It must survive more than one separate reading.** Structural, costs nothing, and needs
 * no judgement from anything — the merge already sees it. What a *reading* is was the one
 * hole the spec could not close; see {@link readingsOf} and
 * [#160](https://github.com/cgbarlow/braintrust/issues/160).
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
 * measure. A person whose work fits in one reading gets none. And a Compile that came back
 * empty because the synthesiser had a bad afternoon is indistinguishable from one that came
 * back empty because there was nothing.
 *
 * See docs/design/compiler.md and https://github.com/cgbarlow/braintrust/issues/167.
 */

import type { StoredNote } from '../notes/store.js';
import { DIGEST_BUDGET_CHARS, noteDigest } from './infer.js';
import { foldByMerging } from './merge.js';
import { MAX_ENTRIES, type SynthesisedEntry, type Synthesiser } from './synthesis.js';

/**
 * How many readings a through-line has to appear in. Two, and *more than one* is the whole
 * of the rule — whether two is the right number at all is
 * [#157](https://github.com/cgbarlow/braintrust/issues/157) and is not settled here.
 */
export const READINGS_REQUIRED = 2;

/**
 * The fewest Notes that make a reading a reading.
 *
 * **Chosen to keep an accepted cost true rather than because three is interesting.**
 * [#144](https://github.com/cgbarlow/braintrust/issues/144) priced *a person whose work fits
 * in one reading gets none*, Chris on five Items included, and three-per-reading is the
 * smallest floor that still says so. Two would have handed him through-lines and quietly
 * repriced a cost that was argued and accepted.
 */
export const MIN_NOTES_PER_READING = 3;

/**
 * A Corpus divided into readings: contiguous, in publication order, and never overlapping.
 *
 * **This is [#160](https://github.com/cgbarlow/braintrust/issues/160), and it decides who
 * gets through-lines at all.** Four choices, each with a direction of failure:
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
 * **At least two, always.** The compiler's existing passes are budget-sized, so a Corpus
 * under the budget is one pass — and *survives more than one reading* would be unsatisfiable
 * for most of the fleet, quietly turning #144's accepted cost into *almost nobody gets any*.
 * A Corpus that fits in one pass is split in half and pays one extra synthesis call for it.
 *
 * A named consequence rather than a hidden one: the number of readings grows with the Corpus,
 * so a prolific person needs 2 of 20 where a thin one needs 2 of 2. Deliberate — a
 * proportional bar would make through-lines hardest for exactly the people most likely to
 * have them — but the threshold is doing different work at each end of the fleet.
 *
 * Returns an empty list when there is not enough to read twice. That is a real answer.
 */
export function readingsOf(
  notes: StoredNote[],
  budget = DIGEST_BUDGET_CHARS,
): StoredNote[][] {
  if (notes.length < MIN_NOTES_PER_READING * READINGS_REQUIRED) return [];

  const readings = byBudget(notes, budget);

  // One pass means the Corpus fits comfortably in a call, which is most Personas. Halved by
  // count rather than left whole, because a single reading can never satisfy the rule.
  if (readings.length < 2) {
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

  return readings.length >= READINGS_REQUIRED ? readings : [];
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
  /** How many separate readings surfaced it. Never fewer than {@link READINGS_REQUIRED}. */
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
};

/** An entry, with the readings that produced it carried alongside. */
type Sighted = SynthesisedEntry & { readings: Set<number> };

/**
 * Read the Corpus in separate readings and keep what appears in more than one.
 *
 * **The threshold is applied after the merge and never before it.** Two readings word the
 * same conviction differently, and *these two say the same thing* is the one judgement in
 * this file that needs a model — which is exactly what the merge already is. Counting first
 * would count wordings rather than convictions.
 */
export async function compileThroughLines(
  notes: StoredNote[],
  synthesiser: Synthesiser,
): Promise<ThroughLineSet> {
  const readings = readingsOf(notes);
  if (readings.length === 0) {
    return { through_lines: [], readings: 0, dropped_single_reading: 0 };
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
      // The union braintrust performs itself. The merge is handed wording and answers with
      // numbers; which readings an entry was seen in is arithmetic, and arithmetic has a
      // right answer.
      readings: new Set(members.flatMap((member) => [...member.readings])),
    }),
    group: (digest) => synthesiser.group('through_lines', digest),
    budget: DIGEST_BUDGET_CHARS,
  });

  const survived = folded.entries.filter((entry) => entry.readings.size >= READINGS_REQUIRED);

  return {
    through_lines: survived.slice(0, MAX_ENTRIES).flatMap((entry) => {
      // The same attribution rule the inferred layers have: an entry may name only Items
      // that were in the Notes it was read from, and one left holding none is not published.
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
    dropped_single_reading: folded.entries.length - survived.length,
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

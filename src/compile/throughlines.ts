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
 * **Four ship, ranked, for everyone who has any.** Recurrence first, breadth second: a claim
 * two readings surfaced outranks one a single reading did, and a claim traced to more Items
 * outranks a narrower one below that. Nothing is barred. What a *reading* is still decides
 * what recurrence means; see {@link readingsOf} and
 * [#160](https://github.com/cgbarlow/braintrust/issues/160).
 *
 * **The bar that used to sit here is gone, and this is why.** Measured on the first fleet
 * rebuild that compiled through-lines: 11 candidates became 1, 10 became 1, 10 became 0 —
 * three of five Personas said *this person holds no durable commitments*, which is the
 * failure this whole map was chartered on, produced by braintrust's own rules rather than by
 * a model inventing anything. **The standing rule it establishes: a small integer on model
 * output may rank, and may never bar.** Both gates built the other way have failed, in
 * opposite directions — this one starved, and the three-item style floor jittered. A ranked
 * list of fixed length cannot empty itself and cannot change size, so neither failure has
 * anywhere to express itself. See [#157](https://github.com/cgbarlow/braintrust/issues/157).
 *
 * **No retrieval path of its own.** It rides with an answer that already matched rather than
 * competing for the top of one, which is why it needs no embedding. Nor is there a floor on
 * how many a Persona must hold — what the gate refuses is this layer being emptied by
 * braintrust's own rules after it found candidates, which is a different fact from a person
 * having nothing durable to say. See `no_layer_emptied_by_selection` in ./gate.ts.
 *
 * **Never the whole of an answer.** This is the load-bearing one: speaking a through-line
 * flatly, with no hedge and no attribution, is affordable only because something checkable is
 * always beside it. The two stand or fall together. See ../find.ts.
 *
 * **Accepted costs, all named and all chosen.** A through-line that is not really there gets
 * spoken confidently in someone's voice, and nothing a listener hears gives them anywhere to
 * go — **and a claim one reading saw once is now one of those**, which is the cost
 * [#144](https://github.com/cgbarlow/braintrust/issues/144) declined to pay and #157
 * overturns: it is ranked below what recurred rather than deleted for not recurring. Losing
 * *they have held this a long time* is a real loss — duration is the most interesting thing
 * about a durable commitment and the one thing braintrust cannot honestly measure. And a
 * Corpus that fits in one budget-sized pass is still halved, so most Personas pay one extra
 * synthesis call — now for a ranking signal rather than for a rule that could refuse them
 * everything.
 *
 * See docs/design/compiler.md and https://github.com/cgbarlow/braintrust/issues/167.
 */

import type { StoredNote } from '../notes/store.js';
import { DIGEST_BUDGET_CHARS, noteDigest } from './infer.js';
import { foldByMerging } from './merge.js';
import type { SynthesisedEntry, Synthesiser } from './synthesis.js';

/**
 * How many through-lines a Persona publishes. **Four, ranked, for everyone with any
 * candidates at all** — or all of them where a Corpus supported fewer than four.
 *
 * A fixed length rather than a bar, and the difference is the whole of
 * [#157](https://github.com/cgbarlow/braintrust/issues/157): a list of four cannot empty
 * itself when a model has a quiet night, and cannot double when it has a generous one. The
 * old bar's intent survives as the first ranking signal rather than as a wall.
 */
export const THROUGH_LINES_SHIPPED = 4;

/**
 * The fewest Notes that make a reading a reading.
 *
 * **It says what a reading is, and nothing else now.** It used to be chosen to hold an
 * accepted cost in place — [#144](https://github.com/cgbarlow/braintrust/issues/144) priced
 * *a person whose work fits in one reading gets none*, and three was the smallest floor that
 * kept that true. That cost is reversed: a Corpus too small to divide is read once and
 * ranked on breadth alone. What survives is the honest half of the number — a division of
 * two Notes is not a second look at someone's work, it is two more Notes, and recurrence
 * counted across it would mean nothing.
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
 * **Two where a Corpus can carry two.** The compiler's existing passes are budget-sized, so
 * a Corpus under the budget is one pass — and recurrence would be unmeasurable for most of
 * the fleet. A Corpus that fits in one pass is split in half and pays one extra synthesis
 * call for the ranking signal.
 *
 * **One where it cannot, rather than nothing.** A Corpus too small to divide — under two
 * readings' worth of Notes — is read once and its candidates are ranked on breadth alone.
 * That is what makes *everyone gets four* true rather than *everyone above six Notes*: the
 * division is an instrument for measuring recurrence, and an instrument that cannot be
 * applied is a missing signal rather than a verdict of nothing. A one-reading Corpus pays one
 * synthesis call instead of two, so the cheap end of the fleet gets cheaper.
 *
 * A named consequence rather than a hidden one: the number of readings grows with the Corpus,
 * so a prolific person's recurrence is measured over 20 readings where a thin one's is
 * measured over 2. Deliberate, and it costs less than it did — recurrence orders a list now
 * instead of deciding whether there is one.
 *
 * Returns an empty list only for a Corpus with no Notes in it at all.
 */
export function readingsOf(
  notes: StoredNote[],
  budget = DIGEST_BUDGET_CHARS,
): StoredNote[][] {
  if (notes.length === 0) return [];

  // Too small to divide. Read whole, and ranked on breadth alone — the alternative is the
  // starvation this layer was rebuilt to end, dressed up as a measurement.
  if (notes.length < MIN_NOTES_PER_READING * 2) return [notes];

  const readings = byBudget(notes, budget);

  // One pass means the Corpus fits comfortably in a call, which is most Personas. Halved by
  // count rather than left whole, so recurrence has something to be counted across.
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
  /**
   * How many separate readings surfaced it. **The first ranking signal, and one is a legal
   * answer** — an entry seen once is outranked, never deleted.
   */
  readings: number;
  /** Item `external_id`s it was traced to. What decides which answers it rides with. */
  items: string[];
};

export type ThroughLineSet = {
  through_lines: ThroughLine[];
  /** How the Corpus was divided. One where it was too small to divide; zero where empty. */
  readings: number;
  /**
   * Distinct convictions the readings found, counted after the merge and before any rule of
   * braintrust's ran over them.
   *
   * **This is what the gate compares against.** Candidates and nothing published is a rule
   * eating a layer, which is a defect; no candidates and nothing published is a person with
   * nothing durable to say, which is allowed. See ./gate.ts.
   */
  candidates: number;
  /** Found, attributable, and below the fourth best-supported. Ranked out, not barred. */
  outranked: number;
  /** Entries naming no Item braintrust holds. The one rule here that still deletes. */
  dropped_unattributable: number;
};

/** An entry, with the readings that produced it carried alongside. */
type Sighted = SynthesisedEntry & { readings: Set<number> };

/**
 * Read the Corpus in separate readings and publish the four best-supported.
 *
 * **The ranking is applied after the merge and never before it.** Two readings word the same
 * conviction differently, and *these two say the same thing* is the one judgement in this
 * file that needs a model — which is exactly what the merge already is. Ranking first would
 * rank wordings rather than convictions, and would count one conviction worded twice as two
 * single-reading candidates.
 */
export async function compileThroughLines(
  notes: StoredNote[],
  synthesiser: Synthesiser,
): Promise<ThroughLineSet> {
  const readings = readingsOf(notes);
  if (readings.length === 0) {
    return {
      through_lines: [],
      readings: 0,
      candidates: 0,
      outranked: 0,
      dropped_unattributable: 0,
    };
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

  const attributable = folded.entries.flatMap((entry) => {
    // The same attribution rule the inferred layers have, and the only rule left here that
    // deletes: an entry may name only Items that were in the Notes it was read from, and one
    // left holding none has nothing to ride with, so there is nowhere to publish it.
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
  });

  return {
    through_lines: rankedBySupport(attributable).slice(0, THROUGH_LINES_SHIPPED),
    readings: readings.length,
    candidates: folded.entries.length,
    outranked: Math.max(0, attributable.length - THROUGH_LINES_SHIPPED),
    dropped_unattributable: folded.entries.length - attributable.length,
  };
}

/**
 * **Recurrence first, breadth second.** The old bar's intent, kept as a preference: a claim
 * two readings surfaced says more than one a single reading did, so it is ranked above it —
 * and the one below still ships while there is room, which is the whole of the change.
 * Breadth breaks the ties recurrence leaves, because an entry traced to six Items is visible
 * across more of someone's work than one traced to two.
 *
 * **The last tie-break is the slug**, so a rebuild that changed nothing changes nothing — the
 * same property `shippableHabits` in ./habits.ts needs, for the same reason: a reader
 * watching a list reorder should be watching the person change.
 */
function rankedBySupport(lines: ThroughLine[]): ThroughLine[] {
  return [...lines].sort(
    (left, right) =>
      right.readings - left.readings ||
      right.items.length - left.items.length ||
      left.slug.localeCompare(right.slug),
  );
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

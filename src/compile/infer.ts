/**
 * Reasoning: the one layer of the Core a model still has a hand in, and says so.
 *
 * **Nothing here writes a conclusion any more.** This file used to hold both halves of the
 * inferred Core — Reasoning and Beliefs — and both are gone as prose a model composes.
 * Reasoning is chosen from [an authored menu](./habits.ts), and what a person broadly holds
 * is a [through-line](./throughlines.ts) that has to be retrieved beside something
 * quotable. What is left here is the digest a Corpus is folded into, and the layer that
 * renders the menu's own words.
 *
 * **The marker is written here, by the compiler, and never by the serialiser.** The most
 * likely use of a layer is a client pasting the markdown straight into a system prompt,
 * where a `basis` field would be lost and a first line survives — and `braintrust_explain_persona`
 * still returns this layer whole and verbatim, which is exactly that case. So the label is
 * part of the prose the compiler stores, the MCP boundary returns `basis` as well, and the
 * [gate](./gate.ts) refuses to publish a layer that arrived without it.
 *
 * **An inferred entry braintrust cannot attribute to Items it holds is dropped.** The
 * same rule as a claim it cannot quote — enforced for habits in {@link shippableHabits} and
 * for through-lines where they are compiled. An entry may only name Items that were in the
 * Notes handed over, and one left with none is not published.
 *
 * See docs/design/compiler.md §2 and §3.
 */

import type { StoredNote } from '../notes/store.js';
import { habitFor, shippableHabits, type ChosenHabit } from './habits.js';
import type { Synthesiser } from './synthesis.js';

/**
 * How much of the digest one pass may carry. The reason a 400-Item Corpus compiles at all:
 * it is folded in passes and then merged, rather than sent whole and refused.
 *
 * **Sized by how long a pass may generate rather than by the context window** — see
 * `CLAIM_BUDGET_CHARS` in positions.ts, which is the same number for the same live-found
 * reason. A pass that fits the window comfortably can still spend longer than
 * SYNTHESIS_TIMEOUT_MS writing its answer, and that is what actually loses a rebuild.
 */
export const DIGEST_BUDGET_CHARS = 40_000;

/** How much of one Note's argument a digest carries. Long enough to show the moves. */
export const ARGUMENT_MAX_CHARS = 1_200;

/** Claims per Note in the digest. The claims are the evidence a through-line is inferred from. */
export const CLAIMS_PER_NOTE = 6;

/**
 * What the gate looks for. Anchored at the start, because a marker in the middle of a
 * layer is not a label a client pasting the first paragraph would carry.
 */
export const INFERRED_MARKER =
  /^\*\*Inferred across \d+ items? — no single item asserts this\.\*\*/;

export function inferredMarker(items: number): string {
  return `**Inferred across ${items} item${items === 1 ? '' : 's'} — no single item asserts this.**`;
}

export type InferredEntryEvidence = {
  label: string;
  /** Item `external_id`s, every one of them present in the Notes this Compile read. */
  items: string[];
  /**
   * A floor rather than a count: an entry found in one pass carries only that pass's Items.
   * Kept in the evidence, where it is checkable, and never handed to a reader.
   */
  items_traced: number;
};

export type InferredEvidence = {
  layer: 'reasoning';
  /** Notes read. The number in the marker line. */
  items_synthesised: number;
  /** Model and prompt version. A Persona should say what wrote its prose. */
  synthesiser: string;
  /** How the Corpus was folded. One pass for a small one; N and a merge for a large one. */
  passes: number;
  merged: boolean;
  /**
   * Merge rounds. One when the passes' output fits the merge's budget, more when it has to
   * be folded — visible here so a Corpus approaching the fold can be seen before it arrives.
   */
  rounds: number;
  /**
   * False when a fold round returned no fewer entries than it was given. The layer is
   * published either way, and its opening line says duplicates may remain.
   */
  converged: boolean;
  entries: InferredEntryEvidence[];
  /** Entries naming no Item braintrust holds. Dropped rather than published. */
  dropped_unattributable: number;
};

export type InferredLayer = {
  descriptive_md: string;
  evidence: InferredEvidence;
};

/**
 * Reasoning, chosen rather than written.
 *
 * **Same evidence rule, different half of the compiler.** The Notes are folded and read
 * exactly as before; what changed is that the answer is slugs off [the menu](./habits.ts)
 * rather than prose, so the words a reader gets were authored in this repository and the
 * model's whole contribution is which of them are true of this person.
 *
 * **No fold and no merge.** The answer is a set of menu slugs, and a set has no duplicates
 * to reconcile — two passes choosing `builds-a-named-frame` are one habit with the union of
 * their Items, which is arithmetic. There is nothing here for a model to have a second go at.
 *
 * **No count reaches a reader.** The old layer said "Traced to 8 of 34 items" under each
 * entry, and that number moved by 1.4 between rebuilds on identical Notes — so a reader
 * watching a block get thinner was watching the measurement wobble, not the person change.
 * The Item ids stay in the evidence, where they are checkable; the count is gone from
 * everywhere a reader reads.
 */
export async function compileHabits(
  notes: StoredNote[],
  synthesiser: Synthesiser,
): Promise<InferredLayer> {
  const passes = digestPasses(notes);
  const known = new Set(notes.map((note) => note.external_id));

  const chosen: ChosenHabit[] = [];
  for (const digest of passes) {
    chosen.push(...(await synthesiser.chooseHabits(digest)));
  }

  // Two passes choosing the same habit are one habit with the union of their items. Done
  // here rather than by a model, because it is arithmetic and has a right answer.
  const unioned = new Map<string, string[]>();
  for (const habit of chosen) {
    unioned.set(habit.slug, [...(unioned.get(habit.slug) ?? []), ...habit.items]);
  }

  const shipped = shippableHabits(
    [...unioned].map(([slug, items]) => ({ slug, items })),
    known,
  );

  return habitsLayer(shipped, {
    items_synthesised: notes.length,
    synthesiser: synthesiser.habits,
    passes: passes.length,
    // Off the menu, or naming no item braintrust holds. Counted for an operator the same
    // way an unattributable entry always was.
    dropped: chosen.length - shipped.length,
  });
}

/**
 * The layer, from habits that have already been ranked and cut to length.
 *
 * The prose is the menu's own instruction text, verbatim. Nothing here composes a sentence
 * about how somebody argues, which is the whole property the menu exists to provide.
 */
export function habitsLayer(
  habits: ChosenHabit[],
  context: { items_synthesised: number; synthesiser: string; passes: number; dropped: number },
): InferredLayer {
  const evidence: InferredEvidence = {
    layer: 'reasoning',
    items_synthesised: context.items_synthesised,
    synthesiser: context.synthesiser,
    passes: context.passes,
    merged: false,
    rounds: 0,
    converged: true,
    // The slug is the label, because the label is not prose any more — it is the name of a
    // line in a file, and that is what makes "nothing off the menu" checkable.
    entries: habits.map((habit) => ({ label: habit.slug, items: habit.items, items_traced: habit.items.length })),
    dropped_unattributable: context.dropped,
  };

  const opening =
    `Chosen by ${context.synthesiser} from braintrust's own menu of argument habits, against ` +
    'what it wrote down when it read each item. The words are braintrust\'s; which of them ' +
    'describe this person is what the model decided.';

  const body = habits.map((habit) => {
    const authored = habitFor(habit.slug);
    return authored ? `### ${authored.instruction}` : '';
  });

  if (habits.length === 0) {
    // **Absent rather than empty, and said in prose.** A block with no lines under a
    // heading reads as a persona who argues no particular way; a sentence saying braintrust
    // found none reads as what actually happened.
    body.push(
      "braintrust could not recognise how this person argues from these notes. Nothing is " +
        'published from this compile; the previous persona is still the one answering.',
    );
  }

  return {
    descriptive_md: [inferredMarker(context.items_synthesised), opening, ...body.filter(Boolean)].join('\n\n'),
    evidence,
  };
}

/**
 * One Note, as the synthesiser sees it. The `[id]` marker is what an entry's attribution
 * is checked against, so it is the first thing on the line and never wrapped.
 */
export function noteDigest(note: StoredNote): string {
  const lines = [`[${note.external_id}] ${note.published_at ?? 'undated'} — ${note.title ?? 'untitled'}`];

  if (note.argument_md) lines.push(`argument: ${note.argument_md.slice(0, ARGUMENT_MAX_CHARS)}`);
  for (const assumption of note.assumptions) lines.push(`assumes: ${assumption}`);
  for (const claim of note.claims.slice(0, CLAIMS_PER_NOTE)) lines.push(`claims: ${claim.statement}`);

  return lines.join('\n');
}

/**
 * Splits the Corpus into passes that fit. Notes arrive newest-first and stay in that
 * order, so a Corpus large enough to fold is folded along its own timeline rather than
 * arbitrarily — a pass is a stretch of someone's work, not a random sample of it.
 */
export function digestPasses(notes: StoredNote[], budget = DIGEST_BUDGET_CHARS): string[] {
  const passes: string[] = [];
  let current: string[] = [];
  let size = 0;

  for (const note of notes) {
    const digest = noteDigest(note);
    if (current.length > 0 && size + digest.length > budget) {
      passes.push(current.join('\n\n'));
      current = [];
      size = 0;
    }
    current.push(digest);
    size += digest.length + 2;
  }

  if (current.length > 0) passes.push(current.join('\n\n'));
  return passes;
}

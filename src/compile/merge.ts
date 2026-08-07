/**
 * The merge, shared by every layer that has one.
 *
 * A Compile folds a large Corpus into passes, and the passes are then reconciled. Passes
 * are budgeted; the merge never was. Its input was a function of Corpus size, so it was
 * the one step where a Person who publishes more got a worse Persona and eventually none
 * — the one thing [resume](../../docs/adr/0004-the-merge-is-handed-wording-not-evidence.md)
 * cannot help with, because a single call that will not fit today will not fit tomorrow.
 *
 * Two properties fix that, and both are here rather than in the layers.
 *
 * **The merge is handed wording and answers with numbers.** It sees one line per entry —
 * an index and the wording — and returns groups of indices. braintrust performs the union
 * of the evidence itself. That is arithmetic and has a right answer; only *"these two say
 * the same thing in different words"* is judgement, and only judgement needs a model. So a
 * merge **cannot touch a citation**: it is not checked afterwards for invented refs, it
 * never sees one.
 *
 * **It takes the same budget as the passes that feed it, and folds when it overflows.**
 * Under budget it is one call, which is every Person today. Over budget the indexed list is
 * cut into budget-sized chunks, each chunk grouped by one call, and the survivors of all
 * chunks become the next round's input — unions accumulating outside the model. The last
 * step whose cost was a function of Corpus size now has the same shape as the ones that are
 * not: cost grows in calls, never in the length of one call.
 *
 * **A fold that stops shrinking ships anyway.** A round returning no fewer entries than it
 * received ends the fold, and whatever survives is published with the layer disclosing that
 * duplicates may remain. A cosmetic limit never costs a reader their Persona.
 *
 * See docs/adr/0004-the-merge-is-handed-wording-not-evidence.md.
 */

import type { MergeGroup } from './synthesis.js';

/**
 * How much of one entry's wording a merge line carries. Long enough to tell two entries
 * apart, which is the only question being asked — a Position's statement is one sentence
 * and an inferred entry's body is two or three.
 */
export const MERGE_LINE_MAX_CHARS = 400;

export type Folded<T> = {
  entries: T[];
  /** Model calls' worth of rounds. One for a list that fits; more for a fold. */
  rounds: number;
  /** False when a round returned no fewer entries than it was given. Published anyway. */
  converged: boolean;
};

export type FoldOptions<T> = {
  /** One entry as the merge sees it: wording, and never a citation. */
  line: (entry: T) => string;
  /**
   * The union, performed by braintrust. `clearest` is the member whose text is kept word
   * for word — no step of a Compile rewords a Persona's own output.
   */
  combine: (members: T[], clearest: T) => T;
  group: (digest: string) => Promise<MergeGroup[]>;
  /** The same number the passes that produced these entries were budgeted with. */
  budget: number;
};

/**
 * Merges what the passes found, in as many rounds as the budget needs.
 *
 * Returns the entries unchanged and asks nothing when there are fewer than two: a merge
 * exists to reconcile passes that could not see each other, not to give a model a second
 * go at wording it already chose.
 */
export async function foldByMerging<T>(entries: T[], options: FoldOptions<T>): Promise<Folded<T>> {
  let current = entries;
  let rounds = 0;

  for (;;) {
    if (current.length < 2) return { entries: current, rounds, converged: true };

    const lines = current.map((entry) => options.line(entry).slice(0, MERGE_LINE_MAX_CHARS));
    const chunks = chunked(current, lines, options.budget);

    // The common case, and the case a fold round eventually reaches: the whole list fits
    // in one call, so one call is what it gets.
    if (chunks.length === 1) {
      const groups = await options.group(indexed(lines));
      return {
        entries: applyGroups(current, groups, options.combine),
        rounds: rounds + 1,
        converged: true,
      };
    }

    const survivors: T[] = [];
    for (const chunk of chunks) {
      const groups = await options.group(indexed(chunk.lines));
      survivors.push(...applyGroups(chunk.entries, groups, options.combine));
    }
    rounds += 1;

    // A round that merged nothing will merge nothing next time either, and the fold would
    // otherwise loop on a list it cannot shrink. Stop, and let the layer say so.
    if (survivors.length >= current.length) return { entries: survivors, rounds, converged: false };
    current = survivors;
  }
}

/** One line per entry, numbered from 1. The index is the only thing the answer names. */
function indexed(lines: string[]): string {
  return lines.map((line, index) => `[${index + 1}] ${line}`).join('\n');
}

function chunked<T>(
  entries: T[],
  lines: string[],
  budget: number,
): { entries: T[]; lines: string[] }[] {
  const chunks: { entries: T[]; lines: string[] }[] = [];
  let current = { entries: [] as T[], lines: [] as string[] };
  let size = 0;

  for (const [index, line] of lines.entries()) {
    if (current.lines.length > 0 && size + line.length > budget) {
      chunks.push(current);
      current = { entries: [], lines: [] };
      size = 0;
    }
    current.entries.push(entries[index]!);
    current.lines.push(line);
    // The index marker and the newline, so the budget bounds what is actually sent.
    size += line.length + `[${index + 1}] `.length + 1;
  }

  if (current.lines.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Indices are validated the way ids are. One outside the input range is dropped; one named
 * in two groups belongs to the first and is dropped from the rest; a group left with no
 * valid member is dropped. This *replaces* the after-the-fact checks for invented refs
 * rather than supplementing them — a merge that never sees a citation cannot invent one.
 *
 * Survivors keep the order they arrived in, a merged entry taking the place of its earliest
 * member, so a list the passes returned best-supported-first stays that way.
 */
function applyGroups<T>(
  entries: T[],
  groups: MergeGroup[],
  combine: (members: T[], clearest: T) => T,
): T[] {
  const claimed = new Set<number>();
  const merged = new Map<number, T>();

  for (const group of groups) {
    const members = [...new Set(group.members)]
      .filter((index) => index >= 1 && index <= entries.length && !claimed.has(index))
      .sort((left, right) => left - right);

    if (members.length === 0) continue;
    for (const index of members) claimed.add(index);

    // A `clearest` that did not survive validation is not a reason to lose the group; the
    // earliest member is as good a choice as the model's would have been.
    const clearest = members.includes(group.clearest) ? group.clearest : members[0]!;
    merged.set(
      members[0]!,
      combine(
        members.map((index) => entries[index - 1]!),
        entries[clearest - 1]!,
      ),
    );
  }

  const kept: T[] = [];
  for (const [offset, entry] of entries.entries()) {
    const index = offset + 1;
    const combined = merged.get(index);
    if (combined !== undefined) kept.push(combined);
    else if (!claimed.has(index)) kept.push(entry);
  }

  return kept;
}

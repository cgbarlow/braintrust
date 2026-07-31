/**
 * Reasoning and Beliefs: the half of the Core a model writes, and says so.
 *
 * Two properties hold this together.
 *
 * **The marker is written here, by the compiler, and never by the serialiser.** The most
 * likely use of a layer is a client pasting the markdown straight into a system prompt,
 * where a `basis` field would be lost and a first line survives. So the label is part of
 * the prose the compiler stores, the MCP boundary returns `basis` as well, and the
 * [gate](./gate.ts) refuses to publish a layer that arrived without it.
 *
 * **An inferred entry braintrust cannot attribute to Items it holds is dropped.** The
 * same rule as a claim it cannot quote. The prose is a model's, but the attribution is
 * checkable: an entry may only name Items that were in the Notes handed over, and one
 * left with none is not published. It makes the inferred layers structurally auditable
 * without pretending they are measured.
 *
 * **Traced, not counted.** A large Corpus is folded in several passes, and an entry from
 * one pass carries only that pass's Items. So `N of M` here is a floor — the Items this
 * entry was *traced to*, not a count of the Items that show it. Voice says "measured in";
 * this says "traced to", and the difference is the honest one.
 *
 * See docs/design/compiler.md §2 and §3.
 */

import type { StoredNote } from '../notes/store.js';
import {
  MAX_ENTRIES,
  type InferredKind,
  type SynthesisedEntry,
  type Synthesiser,
} from './synthesis.js';

/**
 * How much of the digest one pass may carry. Well inside a modern context window, and
 * the reason a 400-Item Corpus compiles at all: it is folded in passes and then merged,
 * rather than sent whole and refused.
 */
export const DIGEST_BUDGET_CHARS = 120_000;

/** How much of one Note's argument a digest carries. Long enough to show the moves. */
export const ARGUMENT_MAX_CHARS = 1_200;

/** Claims per Note in the digest. The claims are the evidence a belief is inferred from. */
export const CLAIMS_PER_NOTE = 6;

export const INFERRED_LAYERS: InferredKind[] = ['reasoning', 'beliefs'];

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
  /** A floor rather than a count — see the note about passes at the top of this file. */
  items_traced: number;
};

export type InferredEvidence = {
  layer: InferredKind;
  /** Notes read. The number in the marker line. */
  items_synthesised: number;
  /** Model and prompt version. A Persona should say what wrote its prose. */
  synthesiser: string;
  /** How the Corpus was folded. One pass for a small one; N and a merge for a large one. */
  passes: number;
  merged: boolean;
  entries: InferredEntryEvidence[];
  /** Entries naming no Item braintrust holds. Dropped rather than published. */
  dropped_unattributable: number;
};

export type InferredLayer = {
  descriptive_md: string;
  evidence: InferredEvidence;
};

const HEADING: Record<InferredKind, string> = {
  reasoning: 'how they get there',
  beliefs: 'what they argue from',
};

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

/**
 * Drops what braintrust cannot attribute. An entry may name only Items that were in the
 * Notes it was synthesised from; unknown ids are removed, and an entry left holding none
 * goes with them. The mirror of a claim whose quote is not in the body.
 */
export function attributable(
  entries: SynthesisedEntry[],
  known: Set<string>,
): { entries: SynthesisedEntry[]; dropped: number } {
  const kept: SynthesisedEntry[] = [];
  let dropped = 0;

  for (const entry of entries) {
    const items = [...new Set(entry.items.filter((item) => known.has(item)))];
    if (items.length === 0) {
      dropped += 1;
      continue;
    }
    kept.push({ ...entry, items });
  }

  return { entries: kept, dropped };
}

/**
 * The layer, from entries that have already been attributed. Prose and evidence are
 * built together from one list, so — as with Voice — there is no path by which what a
 * Persona says and what it can show can disagree.
 */
export function inferredLayer(
  kind: InferredKind,
  entries: SynthesisedEntry[],
  context: { items_synthesised: number; synthesiser: string; passes: number; dropped: number },
): InferredLayer {
  const evidence: InferredEvidence = {
    layer: kind,
    items_synthesised: context.items_synthesised,
    synthesiser: context.synthesiser,
    passes: context.passes,
    merged: context.passes > 1,
    entries: entries.map((entry) => ({
      label: entry.label,
      items: entry.items,
      items_traced: entry.items.length,
    })),
    dropped_unattributable: context.dropped,
  };

  const opening =
    context.passes > 1
      ? `Synthesised by ${context.synthesiser} from what braintrust wrote down when it read each ` +
        `item, in ${context.passes} passes and a merge. Every count below is what an entry was ` +
        'traced to, which is a floor rather than a tally: an entry found in one pass carries only ' +
        "that pass's items."
      : `Synthesised by ${context.synthesiser} from what braintrust wrote down when it read each ` +
        'item. Every count below is what an entry was traced to.';

  const body = entries.map((entry) => {
    const traced =
      `Traced to ${entry.items.length} of ${context.items_synthesised} item` +
      `${context.items_synthesised === 1 ? '' : 's'}.`;
    return `### ${entry.label}\n\n${entry.body}\n\n${traced}`;
  });

  if (body.length === 0) {
    // Written rather than thrown, and then refused by the gate. A Compile that produced
    // nothing is a fact worth keeping a row for, and the Persona already serving is
    // better than an empty one that arrived today.
    body.push(
      `braintrust could not synthesise ${HEADING[kind]} from these notes. Nothing is published ` +
        'from this compile; the previous persona is still the one answering.',
    );
  }

  return {
    // Blank lines between the entries, not just inside them: a heading pressed against
    // the line above it renders as one run-on block in some clients, and this markdown is
    // meant to be pasted somewhere braintrust does not control.
    descriptive_md: [inferredMarker(context.items_synthesised), opening, ...body].join('\n\n'),
    evidence,
  };
}

/**
 * One inferred layer, end to end: fold the Notes into passes, synthesise each, merge if
 * there was more than one, then keep only what can be attributed.
 *
 * The merge is skipped when there is a single pass — the common case is a Corpus that
 * fits, and a merge pass over entries that were never split would be a second chance for
 * a model to reword what the first one already said.
 */
export async function inferLayer(
  kind: InferredKind,
  notes: StoredNote[],
  synthesiser: Synthesiser,
): Promise<InferredLayer> {
  const passes = digestPasses(notes);
  const known = new Set(notes.map((note) => note.external_id));

  const found: SynthesisedEntry[] = [];
  for (const digest of passes) {
    found.push(...(await synthesiser.synthesise(kind, digest, 'pass')));
  }

  const merged =
    passes.length > 1 ? await synthesiser.synthesise(kind, mergeDigest(found), 'merge') : found;

  // Attribution is checked after the merge, so an id the merge invented is caught by the
  // same rule that catches one a pass invented.
  const { entries, dropped } = attributable(merged.slice(0, MAX_ENTRIES), known);

  return inferredLayer(kind, entries, {
    items_synthesised: notes.length,
    synthesiser: synthesiser.generation,
    passes: passes.length,
    dropped,
  });
}

/** The passes' own output, handed back for merging. Same shape the model returns. */
export function mergeDigest(entries: SynthesisedEntry[]): string {
  return JSON.stringify({ entries }, null, 2);
}

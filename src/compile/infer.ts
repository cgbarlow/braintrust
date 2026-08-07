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
import { foldByMerging } from './merge.js';
import {
  MAX_ENTRIES,
  type InferredKind,
  type SynthesisedEntry,
  type Synthesiser,
} from './synthesis.js';

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
  context: {
    items_synthesised: number;
    synthesiser: string;
    passes: number;
    dropped: number;
    rounds?: number;
    converged?: boolean;
  },
): InferredLayer {
  const rounds = context.rounds ?? (context.passes > 1 ? 1 : 0);
  const converged = context.converged ?? true;

  const evidence: InferredEvidence = {
    layer: kind,
    items_synthesised: context.items_synthesised,
    synthesiser: context.synthesiser,
    passes: context.passes,
    merged: context.passes > 1,
    rounds,
    converged,
    entries: entries.map((entry) => ({
      label: entry.label,
      items: entry.items,
      items_traced: entry.items.length,
    })),
    dropped_unattributable: context.dropped,
  };

  // A merge that could not converge is a cosmetic fault, and a reader is told about it in
  // the one place they will see it: reading a layer as eight convictions when two of them
  // are the same conviction twice is the error the disclosure exists to prevent.
  const undisclosed = converged
    ? ''
    : ' The merge stopped before it ran out of duplicates, so two entries below may say the ' +
      'same thing in different words.';

  const opening =
    context.passes > 1
      ? `Synthesised by ${context.synthesiser} from what braintrust wrote down when it read each ` +
        `item, in ${context.passes} passes and ${rounds === 1 ? 'a merge' : `${rounds} rounds of merging`}. ` +
        'Every count below is what an entry was traced to, which is a floor rather than a tally: ' +
        "an entry found in one pass carries only that pass's items." +
        undisclosed
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
    found.push(...(await synthesiser.synthesise(kind, digest)));
  }

  /**
   * The merge sees labels and bodies — wording only — and answers with groups of indices.
   * braintrust takes the union of the Item ids itself and keeps the clearest member's prose
   * word for word, so no step of a Compile rewords a Persona's own output: what a reader
   * reads was written by a pass that actually read the Notes behind it.
   */
  const folded =
    passes.length > 1
      ? await foldByMerging(found, {
          line: (entry) => `${entry.label} — ${entry.body}`,
          combine: (members, clearest) => ({
            label: clearest.label,
            body: clearest.body,
            items: [...new Set(members.flatMap((member) => member.items))],
          }),
          group: (digest) => synthesiser.group(kind, digest),
          budget: DIGEST_BUDGET_CHARS,
        })
      : { entries: found, rounds: 0, converged: true };

  // The pass-level check, and now the only one: a merge that is handed no Item id cannot
  // return one braintrust does not hold.
  const { entries, dropped } = attributable(folded.entries.slice(0, MAX_ENTRIES), known);

  return inferredLayer(kind, entries, {
    items_synthesised: notes.length,
    synthesiser: synthesiser.generation,
    passes: passes.length,
    dropped,
    rounds: folded.rounds,
    converged: folded.converged,
  });
}

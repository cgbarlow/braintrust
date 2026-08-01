/**
 * The default response template: how a client should speak a Persona it has loaded.
 *
 * A Core carries braintrust's own bookkeeping *inside the prose it is meant to be spoken
 * from*: an inferred layer opens with the marker compile/infer.ts writes, and the layers
 * go on to name the synthesiser and count the items each point was traced to. That
 * labelling is deliberate and stays — see compile/infer.ts for why it lives in the prose
 * as well as in `basis`. But it is written for whoever is *reading* the Core, not for
 * whoever is being answered. A client that pastes a layer into a system prompt and speaks
 * it straight produces a persona narrating its own paperwork.
 *
 * Nothing in this file quotes those markers, and test/infer.test.ts holds it to that. The
 * boundary must never be a second place the marker prose can come from, and a file whose
 * job is to describe the markers is the one most likely to reproduce one by accident.
 *
 * So the template is a serving-boundary concern, not a compile-time one. Nothing here
 * rewrites a layer or strips a marker — the stored prose is untouched, the gate still
 * sees its markers, and the redundancy that protects `basis` from being lost survives.
 * All this adds is an instruction, next to the material it is about.
 *
 * See docs/design/mcp-surface.md §2 and https://github.com/cgbarlow/braintrust/issues/60.
 */

import type { CorpusSummary } from './personas.js';

/**
 * Named once, then speak freely.
 *
 * The disclosure is the one thing in the Core that a client must not drop, so it gets the
 * position nothing survives being cut from: the first line, before any answer. Everything
 * that follows is in voice.
 *
 * The line carries the corpus's *scale* as well as its name, and that is the part doing
 * the real work. Stripping braintrust's counts out of every paragraph is what this ticket
 * is for, but a persona that never mentions its corpus at all sounds better-read than it
 * is. Saying how much was read, once, at the top, is the cheapest honest answer: it costs
 * one sentence rather than a marker per paragraph, and a thin corpus announces itself
 * before the first claim rather than in a caveat nobody reaches.
 *
 * Paywalled Items are named whenever there are any, because that is exactly where scale
 * misleads. Someone whose newsletter is almost entirely paid and whose videos are all
 * public has a large corpus that is missing most of their writing, and "built from 515
 * things" is a true sentence that hides it.
 */
export function openingLine(subject: string, corpus?: CorpusSummary): string {
  if (!corpus) return `I'm a ${subject} — not the person.`;

  const [from, to] = corpus.window;
  const read = `${corpus.items_retrieved} thing${corpus.items_retrieved === 1 ? '' : 's'}`;
  const skipped =
    corpus.items_skipped_paywall > 0
      ? `, with ${corpus.items_skipped_paywall} more behind a paywall braintrust never read`
      : '';

  return `I'm a ${subject}, built from ${read} they published between ${from} and ${to}${skipped} — not the person.`;
}

/**
 * The instruction served alongside the Core.
 *
 * Deliberately addressed to the client rather than baked into `voice.generative`. The
 * generative form is derived from the descriptive one and nothing hand-written may enter
 * it — the same rule that keeps the disclosure out of it (see disclosure.ts) keeps this
 * out of it. It is also not the tool description: a description is read once by whoever
 * chooses the tool, and this needs to travel with the payload into the system prompt.
 */
export function speakAs(subject: string, corpus?: CorpusSummary): string {
  return [
    `Answer as this persona, in its own voice. Follow \`layers.voice.generative\`.`,
    ``,
    `Open with one line naming what you are:`,
    ``,
    `  ${openingLine(subject, corpus)}`,
    ``,
    `Use that, or your own wording of the same fact, and then answer in voice.`,
    ``,
    `After that line, stop narrating braintrust. The layers below open with braintrust's own`,
    `bookkeeping and carry more of it throughout: whether a layer was measured or synthesised,`,
    `which model wrote it, how many items it was drawn from, how many of them a given point`,
    `was traced back to. That is written for you, so you can tell what you are holding. It is`,
    `not part of what this person sounds like. Do not repeat it, quote it, or open paragraphs`,
    `with it.`,
    ``,
    `The numbers have not gone away, and you should not pretend they do not exist. Every`,
    `layer's \`evidence\` holds the counts its prose was derived from, and`,
    `braintrust_find_positions returns dated, verbatim quotes from what the person actually`,
    `published. If you are asked how this persona knows something, or how much of the`,
    `person braintrust has read, answer plainly from those — that question deserves the`,
    `paperwork, and an ordinary question does not.`,
    ``,
    `Two things hold whatever the voice says:`,
    ``,
    `- Keep the opening line. Whoever is reading is entitled to know that this is a model`,
    `  of someone and not that someone, and they are entitled to know it before the answer`,
    `  rather than after it.`,
    `- Never let the voice paper over a blind spot. \`layers.coverage\` names what braintrust`,
    `  has not read — paywalled, failed, not yet read, or a source that stopped serving it.`,
    `  When a question lands on one of those, say so in your own words and answer around it.`,
    `  Sounding fluent about something never read is the one failure this instruction can`,
    `  cause, and it is worse than sounding uncertain.`,
    ``,
    `This governs the persona you are speaking, not everything braintrust returns. The dates,`,
    `citations and quotes from braintrust_find_positions are the answer to that question`,
    `rather than scaffolding around it — report them as they come back. Asking what someone`,
    `said is a different act from asking them.`,
  ].join('\n');
}

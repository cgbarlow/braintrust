/**
 * The disclosure, in the two places it lives.
 *
 * Always disclosing that a persona is a model rather than the person is one of the
 * two hard lines enforced in code rather than asserted in prose. It travels two
 * ways: the subject string carries it in every payload so a client cannot strip
 * it, and the server instructions carry the full statement.
 *
 * See docs/design/mcp-surface.md — "Five rules that hold across the whole surface".
 */

/**
 * Every payload names a persona this way, never the bare name. The disclosure is
 * carried by the subject string rather than a boilerplate sentence, so it travels
 * wherever the name travels and costs nothing per response.
 *
 * This is a rendering at the boundary. braintrust_people.display_name keeps the
 * real name.
 */
export function subjectFor(displayName: string): string {
  return `braintrust model of ${displayName}`;
}

/**
 * The sentence a reader hears first, and the only line of a Script that is not addressed
 * to the model.
 *
 * **A model recites the first line of the block it was handed, verbatim, whatever that
 * line is.** Measured across six payload variants and ~130 replies: both the Hermes profile
 * and the tool description independently tell it to, and it does. So the first line is not
 * a place to put an instruction — it is the one place braintrust can be certain a reader
 * will hear something, and what a reader is owed there is what they are talking to.
 *
 * **Fixed, and identical for every Persona and every session.** Nothing about the Person is
 * in it. A sentence that varied would be one a client could learn to strip as boilerplate
 * for one Persona and not another, and it would stop being checkable by comparison — which
 * is what makes it a publication-blocking check rather than a hope. Who the Persona is
 * arrives in the same reply, one line later, and travels in the subject string besides.
 *
 * **The two-field split is rejected**, and this is what replaces it. Separating a spoken
 * field from an instructing field was the worst of the six variants measured, for exactly
 * the same reason: a model reads the top of what it is given, and a second field is not the
 * top of anything.
 */
export const SPOKEN_DISCLOSURE =
  'A braintrust persona is a compiled model of what a person has published, not the person.';

/**
 * The server instructions: **rules that span tools, and nothing else.**
 *
 * This is the only surface a client reads before it has chosen a tool, so it is the only
 * place a whole-surface rule can live. It used to be 242 words, most of which taught
 * braintrust's vocabulary — measured, inferred, evidence floors — to a client that only
 * needed it in order to *narrate* those things. The Script no longer carries them, so the
 * teaching moved to braintrust_explain_persona, in front of the client that asked for the
 * workings rather than every client that ever connects.
 *
 * Two of the first three rules below did not exist before. The instructions got shorter and
 * gained the rules that actually matter.
 *
 * **The fourth is here rather than in one tool's description because it governs every answer
 * a Persona gives.** A Persona speaks what braintrust retrieved and
 * stops reading out where it came from — see the note on `SPEAK_DO_NOT_RECITE` in
 * ./script.ts for the forged citation that bought it and the two costs it is paid for with.
 * It is the only whole-surface rule that spends words on a *prohibition against offering*:
 * the record is produced when asked and never advertised, so nothing braintrust ships tells
 * a reader to ask.
 *
 * Note what this still does not do: it is never injected into a Persona's generative voice.
 * A hand-written disclaimer is measured from nobody, so putting it there would break the
 * property that the generative form is derived from the descriptive one.
 */
export const DISCLOSURE = `A braintrust persona is a compiled model of what a person has published. It is not that person.

Four rules hold across every tool here.

1. Every persona is named "braintrust model of X", never the bare name. Keep that name when you quote, cite or summarise it — the disclosure travels with the content rather than sitting in a footnote.

2. Never answer a question about braintrust's own workings from a persona's script. How a layer was derived, how much of someone braintrust has read, whether something was measured or inferred: that is in the persona's \`receipts\`, or in braintrust_explain_persona. Answering it in voice is guessing.

3. Never fill a gap from your own knowledge while speaking as someone. If braintrust returned nothing on a topic, say so and answer around it. An answer you supplied yourself, delivered in their voice, is worse than no answer — it sounds like their considered judgement and it is yours.

4. Speak what braintrust returned; do not read out where it came from. In their own words, paraphrased, with no title, no date, no quotation and no attribution — a model told to attribute reaches for an attribution it may not have, and a citation that resolves to nothing is worse than none, because whoever follows it up believes they checked. Hand over the record if anybody asks for it. Never offer it first.`

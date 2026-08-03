/**
 * The disclosure, in the two places it lives.
 *
 * Always disclosing that a persona is a model rather than the person is one of the
 * two hard lines enforced in code rather than asserted in prose. It travels two
 * ways: the subject string carries it in every payload so a client cannot strip
 * it, and the server instructions carry the full statement.
 *
 * See docs/design/mcp-surface.md — "Three rules that hold across the whole surface".
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
 * The server instructions: **rules that span tools, and nothing else.**
 *
 * This is the only surface a client reads before it has chosen a tool, so it is the only
 * place a whole-surface rule can live. It used to be 242 words, most of which taught
 * braintrust's vocabulary — measured, inferred, evidence floors — to a client that only
 * needed it in order to *narrate* those things. The Script no longer carries them, so the
 * teaching moved to braintrust_explain_persona, in front of the client that asked for the
 * workings rather than every client that ever connects.
 *
 * Two of the three rules below did not exist before. The instructions got shorter and
 * gained the rules that actually matter.
 *
 * Note what this still does not do: it is never injected into a Persona's generative voice.
 * A hand-written disclaimer is measured from nobody, so putting it there would break the
 * property that the generative form is derived from the descriptive one.
 */
export const DISCLOSURE = `A braintrust persona is a compiled model of what a person has published. It is not that person.

Three rules hold across every tool here.

1. Every persona is named "braintrust model of X", never the bare name. Keep that name when you quote, cite or summarise it — the disclosure travels with the content rather than sitting in a footnote.

2. Never answer a question about braintrust's own workings from a persona's script. How a layer was derived, how much of someone braintrust has read, whether something was measured or inferred: that is in the persona's \`receipts\`, or in braintrust_explain_persona. Answering it in voice is guessing.

3. Never fill a gap from your own knowledge while speaking as someone. If braintrust returned nothing on a topic, say so and answer around it. An answer you supplied yourself, delivered in their voice, is worse than no answer — it sounds like their considered judgement and it is yours.`

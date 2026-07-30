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
 * The full statement, carried in the MCP server's instructions.
 *
 * Note what it does not do: it is never injected into a persona's generative voice.
 * A hand-written disclaimer is measured from nobody, so putting it there would break
 * the property that the generative form is derived from the descriptive one.
 */
export const DISCLOSURE = `A braintrust persona is a compiled model of what a person has published. It is not that person.

Every persona is named "braintrust model of X", never the bare name. Keep that name when you quote, cite or summarise it — the disclosure is meant to travel with the content rather than sit in a footnote.

What that model can and cannot tell you:

- It only knows what the person published in public. Paywalled content is never ingested, and what was skipped is recorded, so a persona can tell you how much of someone's output it has not read.
- Every layer is labelled measured or inferred. Voice and coverage are counted from the source text and you can check them. Reasoning and beliefs are synthesised across many items and say so in their own prose. Do not present an inferred layer as a finding.
- Positions carry their evidence: dated, cited back to what the person actually published. Where they have changed their mind, the older position is retained and flagged rather than quietly dropped.
- Quotes are verbatim. Most of the corpus is auto-generated video captions, so quoted passages arrive as unpunctuated speech. That is what was said. Tidy it for display if you like, but do not treat the tidied version as the quote.

Treat a persona as a thinking aid, not as a substitute for the real human, and not as their endorsement of anything it says.`;

/**
 * The rule both measured layers hold themselves to: **no number appears in the prose
 * that is not also a field of the evidence.**
 *
 * A count buried in a sentence cannot be checked, filtered or displayed as a fact, so a
 * layer whose only home for a figure is a paragraph has quietly stopped being measured.
 * This finds the figures that have escaped.
 *
 * `pattern` is stripped before the comparison: a regex source is full of digits and
 * would let almost anything through.
 */
export function numbersMissingFromEvidence(prose: string, evidence: unknown): string[] {
  const json = JSON.stringify(evidence, (key, value) => (key === 'pattern' ? undefined : value));
  const tokens = prose.match(/\d[\d.:/-]*\d|\d/g) ?? [];

  return [...new Set(tokens)].filter((token) => {
    // Anchored so `1` cannot be satisfied by the `1` inside `1199` — the point is that
    // the figure itself is a field, not that its digits occur somewhere.
    const anchored = new RegExp(`(?<![\\d.])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d.])`);
    return !anchored.test(json);
  });
}

/**
 * Revisions: what braintrust does when someone changes their mind.
 *
 * This is the thing braintrust exists for and the thing a snapshot of someone cannot do.
 * A Persona rebuilt daily from the whole Corpus would otherwise flatten fourteen months of
 * thinking into one voice with no history — the position they abandoned and the one they
 * replaced it with, asserted with equal confidence, in the same breath.
 *
 * **Both states survive.** A superseded Position is kept, flagged, and returned with the
 * relation that superseded it. Nothing is resolved away, because the interesting thing
 * about someone changing their mind is that they used to think something else.
 *
 * Three properties hold this together, and all three are about restraint.
 *
 * **Candidates come from a similarity neighbourhood, never from frequency.** Frequency
 * shift was tested against a real Corpus and demonstrably does not work: the largest
 * shifts are new product names appearing because the products are new. Claim statements
 * are embedded, near neighbours in different Positions become candidate pairs, and a model
 * judges those pairs. Pairwise over every claim does not scale; pairwise inside a
 * neighbourhood does.
 *
 * **The vectors are computed here and thrown away.** They have no reader after the Compile
 * that made them, so `braintrust_embeddings` keeps its `(chunk_id, model)` key untouched
 * and no table is added. A rebuild recomputes them for about a fifth of a cent.
 *
 * **The uncertainty is the label.** `revised` / `unsettled` / `drifting` is a confidence
 * spectrum, and only `revised` changes what the Persona says. The other two leave both
 * Positions current, are visible to anyone who goes looking, and are never spoken in the
 * Person's voice — because the one error a provenance-first project cannot absorb is
 * mistaking a rephrase for a reversal and putting a contradiction on a real person's
 * record that they would dispute.
 *
 * See docs/design/compiler.md §4.
 */

import { EMBED_BATCH, type Embedder } from '../retrieval/embed.js';
import { CLAIM_MAX_CHARS, type BuiltPosition, type ClaimRef } from './positions.js';
import type { JudgedPair, Synthesiser } from './synthesis.js';

/**
 * How near two claim statements have to be before the pair is worth a model's time.
 * Cosine similarity, in whichever space the configured embeddings model works in.
 *
 * **Measured against a real Corpus rather than chosen up front**, which is what the spec
 * asks for. Over 275 claims from 23 real Substack posts, embedded with a real
 * sentence-transformer: the 36,168 cross-Position claim pairs have a median of 0.175, a
 * 99th percentile of 0.593 and a maximum of 0.907. Reading the pairs at each level is what
 * picked the number — at 0.62 they include *"the most common approach is to treat AI like
 * a human"* against *"every few months I put together a guide on which AI system to use"*,
 * which share a subject only in the sense that everything in that Corpus does. From about
 * 0.65 up they are recognisably about one thing, and the nearest are the same claim
 * restated months apart, which is exactly the shape a revision has.
 *
 * It is a *recall* knob and not a verdict — everything above it is still judged, and the
 * judge answers `none` to most of it. Too low costs model calls; too high silently means
 * a Persona that never notices anyone changing their mind, which is the failure that
 * would look like working software. **It is a property of the configured embeddings model,
 * not of braintrust**: a different endpoint spreads its similarities differently, and an
 * operator who changes model should re-measure this the same way.
 */
export const NEIGHBOUR_FLOOR = 0.65;

/**
 * How many pairs one Compile will pay to have judged, best neighbours first.
 *
 * Twelve model calls at the batch size below, which is nothing beside the extraction that
 * fills a Corpus — so it is set to leave the floor doing the selecting on a Corpus the
 * size of the one it was measured against (23 items produced 53 pairs above the floor).
 *
 * On a much larger Corpus the pairs grow with the square of the Positions and this bound
 * becomes the thing that selects: the nearest 120, which is where revisions live. That is
 * a real limit rather than a hidden one — `bounded_out` counts what it dropped and the
 * Compile says so out loud, because a bound nobody is told about reads as coverage.
 */
export const MAX_CANDIDATES = 120;

/** How many pairs go in one judging call. Small enough that each pair is read on its own. */
export const JUDGE_BATCH = 10;

/** How much of a quote the judge is shown. Their own words, not the whole piece. */
export const QUOTE_MAX_CHARS = 400;

export type RevisionCandidate = {
  /** `p1`, `p2`, … Issued here, so a judgement on a pair braintrust never sent is detectable. */
  ref: string;
  /** The earlier Position's slug. Direction is decided by the dates, never by the model. */
  from: string;
  to: string;
  similarity: number;
  gap_days: number;
  /** The two claims that put the pair in one neighbourhood — what the judge is shown. */
  earlier: ClaimRef;
  later: ClaimRef;
};

export type Revision = {
  from: string;
  to: string;
  relation: 'revised' | 'unsettled' | 'drifting';
  gap_days: number;
  rationale: string;
};

export type RevisionSet = {
  revisions: Revision[];
  /** Distinct claim statements embedded and discarded. */
  claims_embedded: number;
  /** Pairs above the floor that could also be ordered in time. */
  candidates: number;
  judged: number;
  /** Judged and found to be nothing worth recording. The commonest answer, by design. */
  dismissed: number;
  /** Judgements naming a pair braintrust never issued. Dropped rather than written. */
  dropped_unknown: number;
  /** Pairs above the floor that the per-compile bound did not reach. Said out loud, never hidden. */
  bounded_out: number;
  /** `model@revisions-version`. Which prompt decided a Position was superseded. */
  judge: string;
  floor: number;
};

export type RevisionDeps = {
  embedder: Embedder;
  synthesiser: Synthesiser;
};

/**
 * The whole revision pass: embed the claims, find the neighbourhoods, order each pair in
 * time, judge them in batches, and keep the judgements that name a pair braintrust sent.
 */
export async function compileRevisions(
  positions: BuiltPosition[],
  claims: Map<string, ClaimRef[]>,
  deps: RevisionDeps,
): Promise<RevisionSet> {
  const empty: RevisionSet = {
    revisions: [],
    claims_embedded: 0,
    candidates: 0,
    judged: 0,
    dismissed: 0,
    dropped_unknown: 0,
    bounded_out: 0,
    judge: deps.synthesiser.judge,
    floor: NEIGHBOUR_FLOOR,
  };

  // One Position cannot revise itself, and a Position with no date cannot be placed in
  // time — so a Corpus of one Position has nothing here to find.
  if (positions.length < 2) return empty;

  const statements = [
    ...new Set(
      positions.flatMap((position) =>
        (claims.get(position.slug) ?? []).map((ref) => statementOf(ref)),
      ),
    ),
  ];
  if (statements.length === 0) return empty;

  const vectors = await embedAll(statements, deps.embedder);
  const { candidates, bounded_out } = neighbourhood(positions, claims, vectors);

  const judgements = new Map<string, JudgedPair>();
  let dropped = 0;

  for (let index = 0; index < candidates.length; index += JUDGE_BATCH) {
    const batch = candidates.slice(index, index + JUDGE_BATCH);
    const sent = new Set(batch.map((one) => one.ref));

    for (const judgement of await deps.synthesiser.judgePairs(pairDigest(batch))) {
      // The same rule as a claim ref a clusterer invented: a judgement on a pair that was
      // never sent is a judgement of something braintrust cannot show anyone.
      if (!sent.has(judgement.pair) || judgements.has(judgement.pair)) {
        dropped += 1;
        continue;
      }
      judgements.set(judgement.pair, judgement);
    }
  }

  const revisions: Revision[] = [];
  let dismissed = 0;

  for (const candidate of candidates) {
    const judgement = judgements.get(candidate.ref);
    if (!judgement) continue;
    if (judgement.relation === 'none') {
      dismissed += 1;
      continue;
    }

    revisions.push({
      from: candidate.from,
      to: candidate.to,
      relation: judgement.relation,
      gap_days: candidate.gap_days,
      rationale: judgement.rationale,
    });
  }

  return {
    revisions,
    claims_embedded: statements.length,
    candidates: candidates.length,
    judged: judgements.size,
    dismissed,
    dropped_unknown: dropped,
    bounded_out,
    judge: deps.synthesiser.judge,
    floor: NEIGHBOUR_FLOOR,
  };
}

/** The claim as it is embedded and shown: braintrust's own extraction, bounded. */
export function statementOf(ref: ClaimRef): string {
  return ref.claim.statement.slice(0, CLAIM_MAX_CHARS);
}

/**
 * Every pair of Positions with a claim each above the floor, ordered in time, best
 * neighbour first.
 *
 * Two decisions live here. **A pair is kept once**, represented by its nearest claims —
 * the pair is between Positions, so a hundred near-identical claim pairs between the same
 * two is still one question to ask. And **a pair braintrust cannot order in time is
 * dropped**: `from` is the earlier Position, and with no dates, or the same date on both,
 * there is no earlier. Saying which of two undated Positions came first is exactly the
 * kind of guess this layer exists to avoid.
 */
export function neighbourhood(
  positions: BuiltPosition[],
  claims: Map<string, ClaimRef[]>,
  vectors: Map<string, number[]>,
): { candidates: RevisionCandidate[]; bounded_out: number } {
  const held = new Map(positions.map((position) => [position.slug, position.held_since]));

  const flat: { slug: string; ref: ClaimRef; vector: number[] }[] = [];
  for (const position of positions) {
    if (held.get(position.slug) === null) continue;
    for (const ref of claims.get(position.slug) ?? []) {
      const vector = vectors.get(statementOf(ref));
      if (vector) flat.push({ slug: position.slug, ref, vector });
    }
  }

  const best = new Map<string, { left: number; right: number; similarity: number }>();

  for (let left = 0; left < flat.length; left += 1) {
    for (let right = left + 1; right < flat.length; right += 1) {
      const one = flat[left]!;
      const other = flat[right]!;
      if (one.slug === other.slug) continue;

      const similarity = cosine(one.vector, other.vector);
      if (similarity < NEIGHBOUR_FLOOR) continue;

      const key = one.slug < other.slug ? `${one.slug} ${other.slug}` : `${other.slug} ${one.slug}`;
      const existing = best.get(key);
      if (!existing || similarity > existing.similarity) best.set(key, { left, right, similarity });
    }
  }

  const candidates: RevisionCandidate[] = [];

  for (const { left, right, similarity } of best.values()) {
    const one = flat[left]!;
    const other = flat[right]!;
    const oneHeld = held.get(one.slug) ?? null;
    const otherHeld = held.get(other.slug) ?? null;
    if (!oneHeld || !otherHeld || oneHeld === otherHeld) continue;

    const [earlier, later] = oneHeld < otherHeld ? [one, other] : [other, one];
    const [earlierHeld, laterHeld] = oneHeld < otherHeld ? [oneHeld, otherHeld] : [otherHeld, oneHeld];

    candidates.push({
      ref: '',
      from: earlier.slug,
      to: later.slug,
      similarity,
      gap_days: daysBetween(earlierHeld, laterHeld),
      earlier: earlier.ref,
      later: later.ref,
    });
  }

  const ranked = candidates.sort(
    (one, other) => other.similarity - one.similarity || one.from.localeCompare(other.from),
  );

  return {
    candidates: ranked
      .slice(0, MAX_CANDIDATES)
      .map((candidate, index) => ({ ...candidate, ref: `p${index + 1}` })),
    bounded_out: Math.max(0, ranked.length - MAX_CANDIDATES),
  };
}

/**
 * One pair, as the judge sees it: both Positions, the date braintrust can first cite each
 * from, and one thing the Person actually wrote on each side. The quote is there because
 * `revised` is defined as a change *in the Person's own words* — a judge shown only
 * braintrust's summaries would be grading two summaries against each other.
 */
export function pairDigest(candidates: RevisionCandidate[]): string {
  return candidates
    .map((candidate) =>
      [
        `[${candidate.ref}] ${candidate.gap_days} days apart`,
        `  earlier — ${candidate.earlier.published_at} · ${candidate.from}`,
        `    claim: ${statementOf(candidate.earlier)}`,
        `    they wrote: "${quoteOf(candidate.earlier)}"`,
        `  later — ${candidate.later.published_at} · ${candidate.to}`,
        `    claim: ${statementOf(candidate.later)}`,
        `    they wrote: "${quoteOf(candidate.later)}"`,
      ].join('\n'),
    )
    .join('\n\n');
}

function quoteOf(ref: ClaimRef): string {
  return ref.claim.quote.replace(/\s+/g, ' ').slice(0, QUOTE_MAX_CHARS);
}

/** Whole days between two `YYYY-MM-DD` dates, which is what a reader is shown. */
export function daysBetween(earlier: string, later: string): number {
  const start = Date.parse(`${earlier.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${later.slice(0, 10)}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/**
 * Cosine similarity, computing both norms rather than assuming unit vectors. Most
 * endpoints return normalised vectors and braintrust configures none of them, so assuming
 * it would make this quietly wrong against exactly the endpoint nobody tested.
 */
export function cosine(one: number[], other: number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;

  for (let index = 0; index < one.length && index < other.length; index += 1) {
    const a = one[index]!;
    const b = other[index]!;
    dot += a * b;
    left += a * a;
    right += b * b;
  }

  const norm = Math.sqrt(left) * Math.sqrt(right);
  return norm === 0 ? 0 : dot / norm;
}

/** In the same batches the Corpus was indexed in, and kept only for this Compile. */
async function embedAll(statements: string[], embedder: Embedder): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>();

  for (let index = 0; index < statements.length; index += EMBED_BATCH) {
    const batch = statements.slice(index, index + EMBED_BATCH);
    const embedded = await embedder.embed(batch);
    batch.forEach((statement, position) => {
      const vector = embedded[position];
      if (vector) vectors.set(statement, vector);
    });
  }

  return vectors;
}

/**
 * Positions: the half of a Persona that grows with the Corpus.
 *
 * The Core says how someone sounds and how they argue. This says **what they hold**, and
 * it is the only layer that answers a question rather than being loaded whole — which is
 * why it is queried by vector search at serve time rather than shipped in the Core.
 *
 * Three properties hold it together.
 *
 * **A Position is a grouping of claims braintrust already verified.** The model is handed
 * claim *refs* and may only copy them; the quote against every citation was located in the
 * stored body when the Item was read, and nothing here can add, edit or reattribute one.
 * So the sentence at the top of a Position is a model's, and everything under it is the
 * Person's own characters — which is what makes `basis: measured` an honest label for a
 * layer a model helped build, and why the serving tool never returns the statement without
 * the citations it rests on.
 *
 * **A Position braintrust cannot cite is dropped**, the same rule as a claim it cannot
 * quote and an inferred entry it cannot attribute. The [gate](./gate.ts) checks the same
 * thing against the rows afterwards, because the rule matters more than the code path.
 *
 * **`held_since`, `held_until`, `days_spanned` and `item_count` are recomputed every
 * Compile.** They are derived from the citations each time rather than carried forward, so
 * a backfill that reaches further back moves `held_since` earlier by itself — and a
 * Position that was `high` on a single week, gaining no later citation, drops to
 * `moderate`. Less stable across Compiles, more honest.
 *
 * See docs/design/compiler.md §2 and docs/design/mcp-surface.md §3.
 */

import { daysBetween } from '../dates.js';
import type { StoredNote } from '../notes/store.js';
import type { VerifiedClaim } from '../notes/verify.js';
import { MAX_POSITIONS, type ClusteredPosition, type Synthesiser } from './synthesis.js';

/**
 * How much of the claim digest one clustering pass may carry. The same budget the Core's
 * fold uses, for the same reason: a Corpus of 400 Items holds a couple of thousand claims,
 * and a single call over all of them would be refused.
 */
export const CLAIM_BUDGET_CHARS = 120_000;

/** How much of one claim's statement the digest carries. Long enough to tell two apart. */
export const CLAIM_MAX_CHARS = 400;

/**
 * The confidence grade, as a function of how many distinct Items a Position was found in.
 *
 * **Absolute rather than proportional**, unlike Voice's thresholds. Voice measures habits
 * within a Corpus, where a third of Items means something; a Position is a thing someone
 * has said, and saying it in five separate pieces of work is the same signal whether they
 * have published thirty or three hundred. Starting points to tune, not findings — and the
 * grade never filters anything, it only travels alongside `item_count` so a client can.
 *
 * Unchanged by the burst cap below, which adds a ceiling rather than retuning these two.
 */
export const CONFIDENCE_HIGH_ITEMS = 5;
export const CONFIDENCE_MODERATE_ITEMS = 2;

/**
 * The span inside which several dates are still **one occasion**.
 *
 * Five separate pieces of work is the same signal whether someone has published thirty or
 * three hundred — but five of them inside one week are one occasion wearing five dates.
 * *A Position genuinely held gets said again later; one that is a reaction does not.*
 *
 * **Form-neutral, and deliberately so.** This is what survived the question of whether
 * five skeets should earn what five essays earn: the answer was that the question was
 * never about form. Five essays published in one week about one event burst exactly the
 * same way, and long-form has always been able to do it — short-form only made it common.
 *
 * A chosen number, exactly like 5 and 2. Unlike those two it travels in the served data as
 * `days_spanned`, so a reader can disagree with it using the numbers braintrust used.
 * See docs/design/compiler.md §2.
 */
export const BURST_WINDOW_DAYS = 7;

export type Confidence = 'high' | 'moderate' | 'low';

/**
 * The grade, from how many distinct Items hold the Position and how long they span.
 *
 * `daysSpanned` is null when **every** citation is undated, and that case is never capped:
 * braintrust does not penalise what it cannot measure, it declines to claim it — the same
 * rule that has revisions refuse to judge a pair they cannot place in time. A Position
 * with *some* dated citations is measured on those, because the alternative is letting one
 * undated Item lift a burst out of the cap.
 *
 * A week or less is a burst; the tie goes to the cap, because the whole point is that one
 * occasion can wear several dates.
 */
export function confidenceFor(itemCount: number, daysSpanned: number | null): Confidence {
  if (itemCount >= CONFIDENCE_HIGH_ITEMS) {
    return daysSpanned !== null && daysSpanned <= BURST_WINDOW_DAYS ? 'moderate' : 'high';
  }
  if (itemCount >= CONFIDENCE_MODERATE_ITEMS) return 'moderate';
  return 'low';
}

/** One claim, with the ref braintrust issued for it and where it came from. */
export type ClaimRef = {
  /** `c1`, `c2`, … Issued here, so an id the model did not receive is detectable. */
  ref: string;
  item_id: string;
  external_id: string;
  published_at: string | null;
  claim: VerifiedClaim;
};

export type PositionCitation = {
  item_id: string;
  quote: string;
  start_ms: number | null;
  /**
   * Where inside a batched Item the quote is, when the Item is one. Carried from the Note
   * rather than resolved here: the day's post spans were read once, when the words were
   * read, and a Compile that re-derived them would be re-deciding a settled fact from
   * whatever the body looks like now.
   */
  post_url: string | null;
  posted_at: string | null;
};

export type BuiltPosition = {
  slug: string;
  statement: string;
  /** The earliest date braintrust can cite this from. Null when every cited Item is undated. */
  held_since: string | null;
  /**
   * The latest, so a Position reports its span rather than only its beginning. The grade
   * never filters anything — it travels alongside `item_count` so a client can — and a
   * client could not tell `high` across three years from `high` across five days.
   */
  held_until: string | null;
  /** `held_until` minus `held_since`. Null with them, and never capped when it is. */
  days_spanned: number | null;
  /** Distinct Items behind it. The denominator a reader judges the Position on. */
  item_count: number;
  confidence: Confidence;
  citations: PositionCitation[];
};

export type PositionSet = {
  positions: BuiltPosition[];
  /** Model and prompt version that did the grouping. */
  clusterer: string;
  passes: number;
  merged: boolean;
  /** Groupings resolving to no claim braintrust issued. Dropped rather than written. */
  dropped_uncitable: number;
  /** Claim refs handed over. The denominator behind everything above. */
  claims_read: number;
  /**
   * The claims each surviving Position rests on, keyed by the slug that was written.
   * [Revisions](./revisions.ts) embed these rather than the statements above: a statement
   * is a model's sentence, and comparing two of those would be comparing two summaries.
   */
  claims: Map<string, ClaimRef[]>;
};

/**
 * Every claim in the Corpus, numbered. The ref is braintrust's own and sequential across
 * the whole set rather than per pass, so a merge cannot smuggle a ref from one pass into
 * a Position built in another without it still being a ref braintrust issued.
 */
export function claimIndex(notes: StoredNote[]): ClaimRef[] {
  const refs: ClaimRef[] = [];

  for (const note of notes) {
    for (const claim of note.claims) {
      refs.push({
        ref: `c${refs.length + 1}`,
        item_id: note.item_id,
        external_id: note.external_id,
        published_at: note.published_at,
        claim,
      });
    }
  }

  return refs;
}

/**
 * One claim, as the clusterer sees it. The date is on the line because grouping is about
 * what someone holds over time — a claim from two years ago and one from last week are
 * the same position or they are a revision, and that is #35's question to ask of them.
 */
export function claimDigest(ref: ClaimRef): string {
  return (
    `[${ref.ref}] ${ref.published_at ?? 'undated'} ${ref.external_id} — ` +
    ref.claim.statement.slice(0, CLAIM_MAX_CHARS)
  );
}

/** The same fold as the Core's, over claims rather than Notes. Notes arrive newest first. */
export function claimPasses(refs: ClaimRef[], budget = CLAIM_BUDGET_CHARS): string[] {
  const passes: string[] = [];
  let current: string[] = [];
  let size = 0;

  for (const ref of refs) {
    const line = claimDigest(ref);
    if (current.length > 0 && size + line.length > budget) {
      passes.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }

  if (current.length > 0) passes.push(current.join('\n'));
  return passes;
}

/** The passes' own output, handed back for merging. Same shape the model returns. */
export function positionMergeDigest(positions: ClusteredPosition[]): string {
  return JSON.stringify({ positions }, null, 2);
}

/**
 * Turns groupings into rows: resolve every ref, drop what braintrust never issued, and
 * derive the three facts that travel with a Position from the claims that survived.
 *
 * A citation is one claim — its quote, its Item and its moment in a transcript. Two claims
 * quoting the same words in the same Item collapse to one citation, because a Position
 * that cited the same sentence twice would inflate the only number a reader has.
 */
export function buildPositions(
  clusters: ClusteredPosition[],
  refs: ClaimRef[],
): { positions: BuiltPosition[]; dropped: number; claims: Map<string, ClaimRef[]> } {
  const known = new Map(refs.map((ref) => [ref.ref, ref]));
  const taken = new Set<string>();
  const positions: BuiltPosition[] = [];
  const claims = new Map<string, ClaimRef[]>();
  let dropped = 0;

  for (const cluster of clusters) {
    const cited = [...new Set(cluster.claims)]
      .map((ref) => known.get(ref))
      .filter((ref): ref is ClaimRef => ref !== undefined);

    if (cited.length === 0) {
      dropped += 1;
      continue;
    }

    const citations: PositionCitation[] = [];
    const seen = new Set<string>();
    for (const ref of cited) {
      const key = `${ref.item_id} ${ref.claim.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({
        item_id: ref.item_id,
        quote: ref.claim.quote,
        start_ms: ref.claim.start_ms,
        post_url: ref.claim.post_url ?? null,
        posted_at: ref.claim.posted_at ?? null,
      });
    }

    const items = new Set(cited.map((ref) => ref.item_id));
    const dates = cited.map((ref) => ref.published_at).filter((date): date is string => !!date);
    dates.sort();

    // A mixed-form Position is graded on the whole set, deliberately not Voice's move.
    // Voice filters by length because form *is* its subject matter; a Position is about
    // what someone holds, and holding it is holding it. Dropping the short-form citations
    // would make a Position look thinner than the evidence is, and `item_count` would
    // become a count of something other than what braintrust found.
    const heldSince = dates[0] ?? null;
    const heldUntil = dates[dates.length - 1] ?? null;
    const daysSpanned =
      heldSince && heldUntil ? Math.round(daysBetween(new Date(heldSince), new Date(heldUntil))) : null;

    const slug = uniqueSlug(cluster.slug, cluster.statement, taken);
    claims.set(slug, cited);

    positions.push({
      slug,
      statement: cluster.statement,
      held_since: heldSince,
      held_until: heldUntil,
      days_spanned: daysSpanned,
      item_count: items.size,
      confidence: confidenceFor(items.size, daysSpanned),
      citations,
    });
  }

  return { positions, dropped, claims };
}

/**
 * The whole growing layer, end to end: number the claims, fold them into passes, cluster
 * each, merge if there was more than one, then keep only what resolves to a real claim.
 *
 * The merge is skipped for a single pass, as the Core's is — it exists to reconcile passes
 * that could not see each other, not to give a model a second go at its own wording.
 */
export async function compilePositions(
  notes: StoredNote[],
  synthesiser: Synthesiser,
): Promise<PositionSet> {
  const refs = claimIndex(notes);
  const passes = claimPasses(refs);

  // Bounded per pass and not in total. A Core that grew with the Corpus would stop being
  // affordable to regenerate; this layer is queried rather than loaded whole, so growth is
  // the point of it. The merge may return at most what it was handed, which is the one
  // bound that keeps a model from answering a merge with a fresh list of its own.
  const found: ClusteredPosition[] = [];
  for (const digest of passes) {
    found.push(...(await synthesiser.cluster(digest, 'pass')).slice(0, MAX_POSITIONS));
  }

  const merged =
    passes.length > 1
      ? (await synthesiser.cluster(positionMergeDigest(found), 'merge')).slice(0, found.length)
      : found;

  // Citability is checked after the merge, so a ref the merge invented is caught by the
  // same rule that catches one a pass invented.
  const { positions, dropped, claims } = buildPositions(merged, refs);

  return {
    positions,
    clusterer: synthesiser.clusterer,
    passes: passes.length,
    merged: passes.length > 1,
    dropped_uncitable: dropped,
    claims_read: refs.length,
    claims,
  };
}

/** Kebab-case, and never empty: a slug is how a client names a Position back to a human. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/**
 * `(compile_id, slug)` is unique, so two groupings that slugify the same way would take
 * each other's place. The suffix was left open by the spec; `-2` is the decision, because
 * a reader seeing `evals-precede-the-harness-2` can tell it is a second position on the
 * same ground rather than a different one.
 */
function uniqueSlug(slug: string, statement: string, taken: Set<string>): string {
  const base = slugify(slug) || slugify(statement) || 'position';

  let candidate = base;
  let suffix = 1;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  taken.add(candidate);
  return candidate;
}

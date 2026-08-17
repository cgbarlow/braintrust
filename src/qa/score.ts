/**
 * Turning one `find_positions` answer into something a judge can read, and turning many
 * judged answers into a scorecard.
 *
 * **The judge never ran the search and never wrote the position — it only ever sees the
 * question and the answer, the same way a reader would.** That is what makes the verdict
 * about response quality rather than about retrieval: `fit` and `similarity` are the
 * compiler grading its own retrieval, and this is a second, independent read of the same
 * answer a client would actually be shown.
 */

import { DEFAULT_CITATIONS, type FindPayload } from '../find.js';

/**
 * The rubric is asked once per question and states the passing condition, the same
 * convention ../interrogate/model.ts uses — a wrong "true" hides a bad answer behind a
 * green run, and a wrong "false" costs a look at one transcript line.
 */
export const RUBRIC =
  'The reply is a good-faith, on-topic answer to the question asked at the top of it: it either ' +
  'names a specific position this person is on record holding, backed by a real quote, or it ' +
  'plainly says nothing matched. It does not dodge the question with something unrelated or vague.';

/**
 * The top position and its citations, rendered as a client would be shown them.
 *
 * **The subject line is not decoration.** The rubric asks whether *this person* is on
 * record holding the position, and `subject` is the only place a payload says who that is.
 * Leaving it out asked the judge to rule on a person it had never been told the name of,
 * and five of the failures recorded in #298 said so in as many words.
 *
 * **Bounded to `DEFAULT_CITATIONS` on purpose.** ../qa/run.ts asks for `full: true` so the
 * grounding check below sees every citation rather than the four most recent — but a
 * *reader* gets the default four, and a judge shown more evidence than the client would be
 * is grading an answer nobody was given.
 */
export function renderAnswer(payload: FindPayload): string {
  const top = payload.positions[0];
  if (!top) {
    if (payload.read_without_position) {
      return `Retrieved and read; no Position formed on it. ${JSON.stringify(payload.read_without_position)}`;
    }
    return payload.nothing_matched
      ? `Nothing matched. ${JSON.stringify(payload.nothing_matched)}`
      : 'Nothing matched.';
  }

  const shown = top.citations.slice(0, DEFAULT_CITATIONS);
  return [
    `Persona: ${payload.subject}`,
    `Position: ${top.statement}`,
    `Fit: ${top.fit}${top.similarity !== null ? ` (similarity ${top.similarity.toFixed(3)})` : ''}`,
    ...(shown.length > 0
      ? shown.map((citation) => `Citation: "${citation.quote}" — ${citation.item_title ?? citation.url}`)
      : ['No citation attached.']),
  ].join('\n');
}

/*
 * One ordered ladder over a question, in the evals only. Six free, mutually exclusive
 * rungs, assigned by the first true reason in the order they are listed — and `reached`
 * is derived from the ladder, never stored beside it (it is `outranked` plus `grounded`).
 *
 * **Why a ladder at all.** The pass/fail verdict beside a grounded flag cannot say where
 * a question was actually lost, and #298's failures averaged causes that take opposite
 * fixes together. The rungs keep those apart: an item nothing compiled ever cited
 * (uncovered) is a reading gap, one the floor refused (withheld) is a gate defect, one
 * retrieval ranked too low (missed, outranked) is a ranking problem, and one the answer
 * actually rested on (grounded) is the product working. Each wants a different change.
 *
 * **Bounded to the evals, and labels never serve.** A real reader's question has no
 * answer key — there is no golden item to place — so two of the six rungs cannot be
 * answered outside the golden set and no rung label may appear in a `find_positions`
 * payload or in the reply a judge, standing in for a reader, is shown. "The persona did
 * not look" is not a rung: the harness calls retrieval directly and can never see it.
 */

/**
 * The six rungs, in the order the reasons are tried. Each question lands on exactly one —
 * the first true reason wins, and the further up the list a rung lands the earlier in the
 * chain it broke.
 */
export const RUNGS = [
  // Nothing came back at all — not even raw passages.
  'silence',
  // No compiled Position cites the item.
  'uncovered',
  // The floor kept the item out of the candidate set.
  'withheld',
  // A citing Position exists but did not make the five.
  'missed',
  // A citing Position made the five but not the top.
  'outranked',
  // The answer rests on the item asked about.
  'grounded',
] as const;

export type Rung = (typeof RUNGS)[number];

/**
 * What the ladder needs to know about one question, and nothing else.
 *
 * `grounded` and `reached` are read off the payload below (no judge call spent); `cites`
 * and whether the item is in the candidate set are facts about the Corpus behind the
 * payload, and ../qa/run.ts fetches them so the ladder is judged against the retrieval
 * that actually served the answer.
 */
export type RungFacts = {
  /** Nothing came back at all — no positions and no passages for this question. */
  silence: boolean;
  /** Distinct compiled Positions citing the item the question was drawn from. */
  cites: number;
  /** The item is in the candidate set the search actually ranked. */
  inCandidateSet: boolean;
  /** A citing Position is among the five the answer shows. */
  reached: boolean;
  /** The answer a reader was shown rests on the item. */
  grounded: boolean;
};

/**
 * The first true reason, in ladder order — exactly one rung per question, so the six
 * always sum to the number of questions asked.
 */
export function rungFor(facts: RungFacts): Rung {
  if (facts.silence) return 'silence';
  if (facts.cites === 0) return 'uncovered';
  if (!facts.inCandidateSet) return 'withheld';
  if (!facts.reached) return 'missed';
  return facts.grounded ? 'grounded' : 'outranked';
}

/**
 * Whether the answer rests on the item asked about. The top rung, derived — the ladder
 * is stored, the boolean is not.
 */
export function groundedOf(rung: Rung): boolean {
  return rung === 'grounded';
}

/**
 * Whether retrieval reached the item at all. **Derived, never stored**: it is `outranked`
 * plus `grounded`. Storing a reached flag beside the ladder would let it disagree with the
 * rungs again — the exact divergence this ladder exists to close.
 */
export function reachedOf(rung: Rung): boolean {
  return rung === 'outranked' || rung === 'grounded';
}

/**
 * Both of these take every url a citation of this item can carry, not the item's own url.
 * A citation renders as `coalesce(pc.post_url, i.url)` (../find.ts) so that a batched
 * Bluesky day resolves to the individual post — which means an equality test against
 * `braintrust_items.url` could never be true for any batched item, however good the answer.
 * ../qa/sample.ts collects the whole set up front, so the columns can no longer disagree.
 */

/**
 * **What a reader would call grounded**: the answer they were actually shown rests on the
 * item they asked about. That is the top position — the only one `renderAnswer` above shows
 * — and any of its citations, because ../qa/run.ts asks for `full: true` and the right
 * citation is no longer trimmed away by recency before anything looks for it.
 */
export function grounded(payload: FindPayload, itemUrls: readonly string[]): boolean {
  const top = payload.positions[0];
  if (!top) return false;
  return top.citations.some((citation) => itemUrls.includes(citation.url));
}

/**
 * **Whether a citing Position is among the five the answer shows.** A recall number
 * rather than an answer-quality one: it is the same item found and ranked second, which is
 * a ranking problem (outranked), told apart from a citing Position never shown (missed).
 */
export function reached(payload: FindPayload, itemUrls: readonly string[]): boolean {
  return payload.positions.some((position) =>
    position.citations.some((citation) => itemUrls.includes(citation.url)),
  );
}

export type QAOutcome = {
  person: string;
  query: string;
  item_url: string;
  /** The top position's own fit grade, or null when nothing matched. */
  fit: string | null;
  /**
   * Where this question is on the ladder. One of six, exactly — `reached` and `grounded`
   * are derived from it in `reachedOf` / `groundedOf`, so the outcome stores one rung and
   * the ladder can never disagree with the booleans that used to sit beside it.
   */
  rung: Rung;
  /** Null when the judge could not be reached — neither a pass nor a failure. */
  passed: boolean | null;
  detail: string;
};

export type PersonScorecard = {
  person: string;
  asked: number;
  passed: number;
  failed: number;
  /** Could not be judged — an unreachable endpoint, not a verdict. */
  unjudged: number;
  /**
   * One rung per question, counted. **The six always sum to `asked`, exactly** — a rung
   * is exclusive, so every question moves exactly one of these.
   */
  rungs: Record<Rung, number>;
  failures: { query: string; detail: string }[];
};

const zeroRungs = () => Object.fromEntries(RUNGS.map((rung) => [rung, 0])) as Record<Rung, number>;

export function scoreOutcomes(person: string, outcomes: QAOutcome[]): PersonScorecard {
  const card: PersonScorecard = {
    person,
    asked: outcomes.length,
    passed: 0,
    failed: 0,
    unjudged: 0,
    rungs: zeroRungs(),
    failures: [],
  };

  for (const outcome of outcomes) {
    card.rungs[outcome.rung] += 1;

    if (outcome.passed === null) {
      card.unjudged += 1;
    } else if (outcome.passed) {
      card.passed += 1;
    } else {
      card.failed += 1;
      card.failures.push({ query: outcome.query, detail: outcome.detail });
    }
  }

  return card;
}

/**
 * The ladder as counts, in ladder order — the numbers that must sum to the questions
 * asked. Reading top to bottom, each rung that went up is a cause that became worth its
 * own fix, so the fixed order is what keeps the report comparable across runs.
 */
export function formatRungs(rungs: Record<Rung, number>): string {
  return RUNGS.map((rung) => `${rung} ${rungs[rung]}`).join(', ');
}

/** The rung counts across a fleet of scorecards, in ladder order. */
export function sumRungs(cards: readonly PersonScorecard[]): Record<Rung, number> {
  const total = zeroRungs();
  for (const card of cards) {
    for (const rung of RUNGS) total[rung] += card.rungs[rung];
  }
  return total;
}

export function formatScorecard(card: PersonScorecard): string {
  const lines = [
    `${card.person}: ${card.passed}/${card.asked} answered well` +
      `${card.unjudged > 0 ? `, ${card.unjudged} could not be judged` : ''}. ` +
      `${card.asked} asked, one rung each — ${formatRungs(card.rungs)}.`,
    ...card.failures.map((failure) => `  "${failure.query}" — ${failure.detail}`),
  ];
  return lines.join('\n');
}

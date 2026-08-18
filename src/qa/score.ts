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
 *
 * **The rubric no longer passes a "nothing matched" reply** — that escape hatch is exactly
 * the defect #328 removes. An empty answer never reaches the judge: ../qa/run.ts reports
 * it under *answered nothing* before any verdict is asked (spec §5.2), so the judge only
 * ever rules on a reply that returned a Position.
 */
export const RUBRIC =
  'The reply is a good-faith, on-topic answer to the question asked at the top of it: it ' +
  'names a specific position this person is on record holding, backed by a real quote. It ' +
  'does not dodge the question with something unrelated or vague.';

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
 * **Headline is coverage, not quality (#328).** The number the fleet is judged on is
 * `grounded` over the *covered* denominator — every question that is not Uncovered — and
 * only Uncovered leaves it. The judge's *answered well* sits beside that headline, never
 * as the bar: a question without a Position (Silence, Uncovered, Withheld) is reported as
 * *answered nothing* and is not passed or failed at all.
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

/**
 * The rungs that served no Position to judge: the answer was empty, so there is nothing to
 * pass or fail. Reported as their own column, never allowed into `answered well` (#328).
 */
export function answeredNothing(rung: Rung): boolean {
  return rung === 'silence' || rung === 'uncovered' || rung === 'withheld';
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
  /**
   * The judge's verdict, asked only of a question that returned a Position. Null when the
   * judge could not be reached — neither a pass nor a failure — and meaningless where
   * {@link answeredNothing} is true, because nothing was sent to be judged (#328).
   */
  passed: boolean | null;
  detail: string;
};

export type PersonScorecard = {
  person: string;
  asked: number;
  /** `asked` minus Uncovered — the questions a corpus could still cover. Only Uncovered leaves it. */
  covered: number;
  passed: number;
  failed: number;
  /** Could not be judged — an unreachable endpoint, not a verdict. */
  unjudged: number;
  /** The answer rests on the item asked about. Derived from the ladder's `grounded` rung. */
  grounded: number;
  /** Outranked + Grounded, derived from the ladder. */
  reached: number;
  /** Silence + Uncovered + Withheld: no Position came back to be judged. */
  empty: number;
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
    covered: 0,
    passed: 0,
    failed: 0,
    unjudged: 0,
    grounded: 0,
    reached: 0,
    empty: 0,
    rungs: zeroRungs(),
    failures: [],
  };

  for (const outcome of outcomes) {
    card.rungs[outcome.rung] += 1;

    // An empty answer is not a verdict, in either direction. It leaves the judge count —
    // which is exactly why it is reported as its own column and never makes the
    // "answered well" bar (#328).
    if (answeredNothing(outcome.rung)) {
      card.empty += 1;
      continue;
    }

    if (outcome.passed === null) {
      card.unjudged += 1;
    } else if (outcome.passed) {
      card.passed += 1;
    } else {
      card.failed += 1;
      card.failures.push({ query: outcome.query, detail: outcome.detail });
    }
  }

  card.grounded = card.rungs.grounded;
  card.reached = card.rungs.outranked + card.rungs.grounded;
  card.covered = outcomes.length - card.rungs.uncovered;
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

/**
 * The headline is `grounded / covered` — a **coverage** statement, never a quality one. The
 * judge's verdict sits beside it, clearly not as the bar (spec §5.2). Everything about the
 * wording is deliberate: the headline names the covered denominator so it cannot be read as
 * "how good were the answers", and the judged figures stay on their own line.
 */
export function formatScorecard(card: PersonScorecard): string {
  const pct = card.covered > 0 ? Math.round((card.grounded / card.covered) * 100) : null;
  const lines = [
    `${card.person}: grounded ${card.grounded}/${card.covered} ` +
      `${pct !== null ? `(${pct}%) ` : ''}of the questions its corpus covers — coverage, not a quality verdict.`,
    `  judge: ${card.passed}/${card.asked - card.empty} answered well, ${card.failed} failed, ` +
      `${card.unjudged} could not be judged.`,
    `  answered nothing: ${card.empty} (${card.rungs.silence} silence, ` +
      `${card.rungs.uncovered} uncovered, ${card.rungs.withheld} withheld).`,
    `  ladder: ${card.rungs.missed} missed · ${card.rungs.outranked} outranked · ${card.rungs.grounded} grounded.`,
    ...card.failures.map((failure) => `  "${failure.query}" — ${failure.detail}`),
  ];
  return lines.join('\n');
}

/*
 * The negative sets, and their columns.
 *
 * A negative question is asked of the same serving path and answered by the same payload —
 * the only difference from the golden set is that **nothing is judged and the two sets are
 * read differently**. off-domain says *anything that came back is a false answer*, because
 * a question no persona has material for has one correct answer and it is silence.
 * near-miss says *whatever came back is reported, not barred*: overlapping personas
 * legitimately answer some of each other's titles, and the set exists to see that.
 */

/** Whether a negative question came back with anything meant for a reader. */
export function cameBack(payload: FindPayload): boolean {
  return payload.positions.length > 0 || payload.passages.length > 0 || payload.read_without_position !== undefined;
}

/** Whether the top shown position rests on the item a near-miss question was drawn from. */
export function restsOn(payload: FindPayload, itemUrls: readonly string[]): boolean {
  return grounded(payload, itemUrls);
}

export type NegativeOutcome = {
  person: string;
  query: string;
  kind: 'off-domain' | 'near-miss';
  /** The answer a reader would have been handed names the asked item. */
  rested: boolean;
  /** Anything came back at all — the off-domain bar, and the near-miss report. */
  came_back: boolean;
};

/**
 * The two negative sets, one card. `off_domain_answered` is the false-answer count —
 * off-domain, unlike near-miss, has no legitimate answer. `near_miss` reports how many
 * came back and how many of those rest on the other persona's asked item — the shape an
 * overlap takes — read as a report, never as a bar.
 */
export type NegativeCard = {
  person: string;
  off_domain_asked: number;
  off_domain_answered: number;
  near_miss_asked: number;
  near_miss_answered: number;
  near_miss_rested: number;
};

const zeroNegativeCard = () =>
  ({
    person: '',
    off_domain_asked: 0,
    off_domain_answered: 0,
    near_miss_asked: 0,
    near_miss_answered: 0,
    near_miss_rested: 0,
  }) as NegativeCard;

export function scoreNegatives(person: string, outcomes: NegativeOutcome[]): NegativeCard {
  const card = { ...zeroNegativeCard(), person };

  for (const outcome of outcomes) {
    if (outcome.kind === 'off-domain') {
      card.off_domain_asked += 1;
      if (outcome.came_back) card.off_domain_answered += 1;
    } else {
      card.near_miss_asked += 1;
      if (outcome.came_back) card.near_miss_answered += 1;
      if (outcome.rested) card.near_miss_rested += 1;
    }
  }

  return card;
}

/** The negative columns across a fleet of cards, for the run's bottom line. */
export function sumNegativeCards(cards: readonly NegativeCard[]): NegativeCard {
  const total = { ...zeroNegativeCard(), person: 'TOTAL' };

  for (const card of cards) {
    total.off_domain_asked += card.off_domain_asked;
    total.off_domain_answered += card.off_domain_answered;
    total.near_miss_asked += card.near_miss_asked;
    total.near_miss_answered += card.near_miss_answered;
    total.near_miss_rested += card.near_miss_rested;
  }

  return total;
}

export function formatNegativeCard(card: NegativeCard): string {
  const lines: string[] = [];
  if (card.off_domain_asked > 0) {
    lines.push(`off-domain false answers: ${card.off_domain_answered}/${card.off_domain_asked}`);
  }
  if (card.near_miss_asked > 0) {
    lines.push(
      `near-miss: ${card.near_miss_answered}/${card.near_miss_asked} answered` +
        ` (${card.near_miss_rested} rested on the asked item), reported — not a bar`,
    );
  }
  return lines.length > 0 ? `${card.person} —\n  ${lines.join('\n  ')}` : card.person;
}

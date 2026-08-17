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
 * Two free signals below, no judge call spent, answering the two different questions the
 * single column headed `grounded` used to answer badly at once.
 *
 * Both take every url a citation of this item can carry, not the item's own url. A citation
 * renders as `coalesce(pc.post_url, i.url)` (../find.ts) so that a batched Bluesky day
 * resolves to the individual post — which means an equality test against
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
 * **Whether retrieval reached the item at all**, anywhere in what came back. A recall
 * number rather than an answer-quality one: it is the same item found and ranked second,
 * which is a ranking problem, told apart from the item never found, which is not. The
 * separation is what lets a retrieval change be judged on the thing it actually moves.
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
  /** The answer a reader was shown cites the item the question was drawn from. */
  grounded: boolean;
  /** That item appears anywhere in what retrieval returned, shown or not. */
  reached: boolean;
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
  grounded: number;
  reached: number;
  failures: { query: string; detail: string }[];
};

export function scoreOutcomes(person: string, outcomes: QAOutcome[]): PersonScorecard {
  const card: PersonScorecard = {
    person,
    asked: outcomes.length,
    passed: 0,
    failed: 0,
    unjudged: 0,
    grounded: 0,
    reached: 0,
    failures: [],
  };

  for (const outcome of outcomes) {
    if (outcome.grounded) card.grounded += 1;
    if (outcome.reached) card.reached += 1;

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

export function formatScorecard(card: PersonScorecard): string {
  const lines = [
    `${card.person}: ${card.passed}/${card.asked} answered well, ` +
      `${card.grounded}/${card.asked} grounded in the item asked about, ` +
      `${card.reached}/${card.asked} where retrieval reached that item at all` +
      `${card.unjudged > 0 ? `, ${card.unjudged} could not be judged` : ''}.`,
    ...card.failures.map((failure) => `  "${failure.query}" — ${failure.detail}`),
  ];
  return lines.join('\n');
}

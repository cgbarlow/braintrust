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

import type { FindPayload } from '../find.js';

/**
 * The rubric is asked once per question and states the passing condition, the same
 * convention ../interrogate/model.ts uses — a wrong "true" hides a bad answer behind a
 * green run, and a wrong "false" costs a look at one transcript line.
 */
export const RUBRIC =
  'The reply is a good-faith, on-topic answer to the question asked at the top of it: it either ' +
  'names a specific position this person is on record holding, backed by a real quote, or it ' +
  'plainly says nothing matched. It does not dodge the question with something unrelated or vague.';

/** The top position and its citation, rendered as a client would be shown it. */
export function renderAnswer(payload: FindPayload): string {
  const top = payload.positions[0];
  if (!top) {
    return payload.nothing_matched
      ? `Nothing matched. ${JSON.stringify(payload.nothing_matched)}`
      : 'Nothing matched.';
  }

  const citation = top.citations[0];
  return [
    `Position: ${top.statement}`,
    `Fit: ${top.fit}${top.similarity !== null ? ` (similarity ${top.similarity.toFixed(3)})` : ''}`,
    citation
      ? `Citation: "${citation.quote}" — ${citation.item_title ?? citation.url}`
      : 'No citation attached.',
  ].join('\n');
}

/**
 * A free signal, no judge call spent: does the top position actually cite the item whose
 * title became the question? Since the query is drawn from one specific item, its own url
 * showing up among the citations is a strong, zero-cost recall check to sit beside the
 * judge's verdict on quality.
 */
export function grounded(payload: FindPayload, itemUrl: string): boolean {
  const top = payload.positions[0];
  if (!top) return false;
  return top.citations.some((citation) => citation.url === itemUrl);
}

export type QAOutcome = {
  person: string;
  query: string;
  item_url: string;
  /** The top position's own fit grade, or null when nothing matched. */
  fit: string | null;
  grounded: boolean;
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
    failures: [],
  };

  for (const outcome of outcomes) {
    if (outcome.grounded) card.grounded += 1;

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
    `${card.person}: ${card.passed}/${card.asked} answered well, ${card.grounded}/${card.asked} grounded in the item asked about` +
      `${card.unjudged > 0 ? `, ${card.unjudged} could not be judged` : ''}.`,
    ...card.failures.map((failure) => `  "${failure.query}" — ${failure.detail}`),
  ];
  return lines.join('\n');
}

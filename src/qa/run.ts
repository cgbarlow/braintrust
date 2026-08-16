/**
 * Asking one golden question, for real, and judging what came back.
 *
 * **The candidate runs the real path** — the same `findPositions` a client's
 * `braintrust_find_positions` call reaches — the same reason ../eval/run.ts runs the real
 * extractor path rather than a stand-in for it. What is being measured is not retrieval in
 * the abstract but retrieval *doing braintrust's job*.
 */

import { findPositions, type FindDeps } from '../find.js';
import type { Interrogator } from '../interrogate/index.js';
import { grounded, reached, renderAnswer, RUBRIC, type QAOutcome } from './score.js';
import type { GoldenQuestion } from './sample.js';

/** Enough positions to judge a reply without paying to render every one. */
const ANSWER_LIMIT = 5;

export async function runQuestion(
  question: GoldenQuestion,
  deps: FindDeps,
  interrogator: Interrogator,
): Promise<QAOutcome> {
  // **`full: true` is for the measurement, not for the reader.** Without it ../find.ts
  // bounds each Position's citations to the four most recent, so a Position resting on
  // twenty items showed four — and the one item whose title asked the question was
  // invisible unless it happened to be among them. The grounding check was scoring
  // recency. ../qa/score.ts still renders only what a default call would return, so what
  // the judge reads is unchanged.
  const payload = await findPositions(
    { person: question.person, query: question.query, limit: ANSWER_LIMIT, full: true },
    deps,
  );

  const reply = `Question asked: "${question.query}"\n\n${renderAnswer(payload)}`;

  let passed: boolean | null;
  let detail: string;
  try {
    const verdict = await interrogator.judge(RUBRIC, reply);
    passed = verdict.holds;
    detail = verdict.why;
  } catch (error) {
    // An unreachable judge concludes nothing about this answer — the same rule
    // ../interrogate/index.ts follows: a dead endpoint is not evidence of a bad reply.
    passed = null;
    detail = error instanceof Error ? error.message : String(error);
  }

  return {
    person: question.person,
    query: question.query,
    item_url: question.item_url,
    fit: payload.positions[0]?.fit ?? null,
    grounded: grounded(payload, question.citation_urls),
    reached: reached(payload, question.citation_urls),
    passed,
    detail,
  };
}

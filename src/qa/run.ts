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
import { grounded, renderAnswer, RUBRIC, type QAOutcome } from './score.js';
import type { GoldenQuestion } from './sample.js';

/** Enough citations to judge a reply without paying to render every one. */
const ANSWER_LIMIT = 5;

export async function runQuestion(
  question: GoldenQuestion,
  deps: FindDeps,
  interrogator: Interrogator,
): Promise<QAOutcome> {
  const payload = await findPositions(
    { person: question.person, query: question.query, limit: ANSWER_LIMIT },
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
    grounded: grounded(payload, question.item_url),
    passed,
    detail,
  };
}

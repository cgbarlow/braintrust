/**
 * The negative sets: questions the golden set structurally cannot ask.
 *
 * Every golden question is one of the person's own item titles, so the corpus is
 * guaranteed to hold material for it — and the instrument can never see a false answer,
 * the failure a reader resents most. These two sets are asked of the same serving path
 * (`findPositions`, exactly as a client reaches it) to measure the questions braintrust
 * has no keepable answer to.
 *
 * **Neither set is a bar.** off-domain is measured against silence — the correct answer
 * to a question no persona has material for is nothing, so *anything that came back* is a
 * false answer to be counted. near-miss is reported, never barred: the personas genuinely
 * overlap, some answers are legitimate, and the point of the set is to see them, not to
 * fail them.
 *
 * **Neither set spends a judge call.** Judging "did this answer it" requires a question
 * the system is expected to answer; a near-miss answer is legitimate and an off-domain
 * answer is not a judgment call. What is measured here is only *whether anything came
 * back*, free from the payload.
 *
 * **The questions are authored, so they live in one file a human can extend without
 * touching the harness.** Adding an off-domain question is editing the list below.
 * A near-miss question is another persona's own title, sampled deterministically the same
 * way the golden set is.
 */

import type { Db } from '../db.js';
import { goldenQuestions, type GoldenQuestion } from './sample.js';

/** One of the two negative sets, told apart by whether a source item rides along. */
export type NegativeQuestion = {
  kind: 'off-domain' | 'near-miss';
  /**
   * The persona **being asked** — unlike `GoldenQuestion.person`, this is never the owner
   * of the material: the owner, for near-miss, is `item.source`.
   */
  person: string;
  query: string;
  /**
   * The item another persona's title this question was drawn from. Present for near-miss
   * only — an off-domain question is not a real title and has no item or citations to
   * measure an answer against.
   */
  item?: { source: string; item_id: string; item_url: string; citation_urls: string[] };
};

/**
 * Questions no persona in the fleet has material for.
 *
 * Six is enough to start (the reference counts are 6 per persona). Each is asked of every
 * persona. **Nothing here may be a topic any deployed persona actually publishes on** — an
 * off-domain question that a persona has material for is a question braintrust is right to
 * answer, and the set would be measuring a legal answer as a false one.
 *
 * Extend here, not in the harness.
 */
export const OFF_DOMAIN: readonly Omit<NegativeQuestion, 'person'>[] = [
  { kind: 'off-domain', query: 'How do I feed and maintain a sourdough starter?' },
  { kind: 'off-domain', query: 'When should I prune my tomato plants?' },
  { kind: 'off-domain', query: 'What do the current diesel emissions regulations mean for trucking?' },
  { kind: 'off-domain', query: 'What should a beginner know before sea kayaking?' },
  { kind: 'off-domain', query: 'What are the early signs of canine hip dysplasia?' },
  { kind: 'off-domain', query: 'How is lime mortar made and applied?' },
];

/**
 * The near-miss set for one persona: a deterministic sample of the titles of one other
 * persona, asked of this one.
 *
 * **The other is chosen from the serving fleet deterministically** — the source is the
 * next member in the given order, wrapping around at the end, so a two-person fleet asks
 * each other's titles and a larger one cycles its pairings. The set is stable across
 * runs, the same property the golden set's `md5(item id)` ordering exists for.
 *
 * The questions are that other persona's own titles, so this set cannot chew up a judge
 * call: what is being measured is what the asked persona holds on a title it did not
 * publish.
 */
export async function nearMissQuestions(
  db: Db,
  person: string,
  others: readonly string[],
  limit: number,
): Promise<NegativeQuestion[]> {
  // **One persona has no "another persona".** A deployed fleet of one, or a run scoped to
  // a single persona, has nobody else's titles to ask — answering its own golden titles
  // again would be the golden set twice, not a near-miss.
  if (others.length <= 1) return [];

  const at = others.indexOf(person);
  // A persona not in the serving fleet still gets a near-miss set, deterministically:
  // its source is the same member any off-fleet persona would pair with, the first.
  const source = (at >= 0 ? others[(at + 1) % others.length] : others[0])!;

  const foreign = await goldenQuestions(db, source, limit);
  return foreign.map((question) => ({
    kind: 'near-miss' as const,
    person,
    query: question.query,
    item: {
      source,
      item_id: question.item_id,
      item_url: question.item_url,
      citation_urls: question.citation_urls,
    },
  }));
}

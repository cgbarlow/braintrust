/**
 * `npm run qa` — how well each Persona answers real questions, judged.
 *
 * **The gap this fills:** ../eval scores the extractor — what got written down about an
 * item. ../calibrate reports a retrieval measurement already taken at compile time.
 * ../interrogate checks four structural guarantees (discloses itself, does not fake a
 * person, admits an empty answer) and runs automatically, filing an issue on failure.
 * None of the three asks the question this one does: handed a real question, is the answer
 * `find_positions` actually returns *any good*?
 *
 * **The question is real, not authored.** Each one is a Person's own item title, drawn
 * deterministically per ../qa/sample.ts — a corpus is guaranteed to have material for a
 * question about its own content, so a miss is worth a look rather than "nobody asked that".
 *
 * **The judge is the same endpoint as the extractor and the interrogator**, for the reason
 * ../interrogate/model.ts gives: an operator who decided where their corpus may go decided
 * it for every model braintrust talks to. One judge call per question, ~10 questions per
 * Person — enough to catch a regression without spending an evening's budget on it.
 *
 * **Three columns, and they are not three views of one number.** *answered well* is the
 * judge's verdict on the reply a reader would have been handed. *grounded* is whether that
 * reply rests on the item the question was drawn from. *reached* is whether retrieval found
 * that item at all, shown or not. Grounded below reached is a ranking problem; reached low
 * is a retrieval one; both high with *answered well* low is neither. A single number could
 * not tell those apart, and for a while this harness reported one that told them apart
 * wrongly — see ../qa/score.ts.
 *
 * **On demand only.** Nothing here schedules, gates a Compile, or files an issue — it is an
 * operator's report, the same standing as ../eval and ../calibrate.
 *
 *   npm run qa                      every serving persona, 10 questions each
 *   npm run qa -- --person SLUG     one persona
 *   npm run qa -- --sample 20       a bigger golden set
 */

import { ConfigError, loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { createInterrogator, servingFleet } from '../interrogate/index.js';
import { SERVER_NAME } from '../mcp.js';
import { createFetcher } from '../net/fetch.js';
import { checkDimension, createEmbedder, createQueryGate } from '../retrieval/index.js';
import { readArgs } from './args.js';
import { runQuestion } from './run.js';
import { goldenQuestions } from './sample.js';
import { formatScorecard, scoreOutcomes, type QAOutcome } from './score.js';

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  try {
    const people = args.person ? [args.person] : (await servingFleet(db)).map((member) => member.person);
    if (people.length === 0) {
      console.log(`${SERVER_NAME}: no serving personas to ask.`);
      return;
    }

    const fetcher = createFetcher();
    const embedder = createEmbedder(config.embeddings, fetcher);
    await checkDimension(db, embedder);

    const retrieval = createQueryGate(db, config.embeddings.model);
    const readiness = await retrieval.check();
    if (!readiness.ready) {
      console.log(`${SERVER_NAME}: retrieval is unavailable, so there is nothing to ask. ${readiness.reason}`);
      return;
    }

    const interrogator = createInterrogator(config.extractor, createFetcher());

    console.log(
      `${SERVER_NAME}: asking ${people.length} persona(s) up to ${args.sample} question(s) each, ` +
        `judged by ${interrogator.generation}.\n`,
    );

    let totalAsked = 0;
    let totalPassed = 0;
    let totalGrounded = 0;
    let totalReached = 0;

    for (const person of people) {
      const questions = await goldenQuestions(db, person, args.sample);
      if (questions.length === 0) {
        console.log(`${person}: no titled, retrieved items to ask about — skipped\n`);
        continue;
      }

      const outcomes: QAOutcome[] = [];
      for (const question of questions) {
        outcomes.push(await runQuestion(question, { db, embedder, retrieval }, interrogator));
      }

      const card = scoreOutcomes(person, outcomes);
      console.log(formatScorecard(card));
      console.log('');

      totalAsked += card.asked;
      totalPassed += card.passed;
      totalGrounded += card.grounded;
      totalReached += card.reached;
    }

    if (totalAsked > 0) {
      console.log(
        `TOTAL: ${totalPassed}/${totalAsked} answered well, ` +
          `${totalGrounded}/${totalAsked} grounded, ` +
          `${totalReached}/${totalAsked} reached.`,
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(78);
  }
  console.error(`${SERVER_NAME}: the qa run failed.`, error);
  process.exit(1);
});

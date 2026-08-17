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
 * **One ladder over each question, and the judge's verdict beside it.** Each question lands
 * on exactly one of six mutually exclusive rungs — *silence*, *uncovered*, *withheld*,
 * *missed*, *outranked*, *grounded* — assigned by the first true reason, so a lost question
 * reports where it was actually lost instead of averaging causes that take opposite fixes.
 * `reached` is derived from the ladder (outranked + grounded), never stored. The judge's
 * verdict on the reply a reader would have been handed sits *beside* the ladder as
 * *answered well*, because a bottom-rung question can still be answered well: the rubric
 * passes an honest "nothing matched".
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
import {
  formatRungs,
  formatScorecard,
  scoreOutcomes,
  sumRungs,
  type PersonScorecard,
  type QAOutcome,
} from './score.js';

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

    const cards: PersonScorecard[] = [];

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
      cards.push(card);
      console.log(formatScorecard(card));
      console.log('');
    }

    if (cards.length > 0) {
      const asked = cards.reduce((total, card) => total + card.asked, 0);
      const passed = cards.reduce((total, card) => total + card.passed, 0);
      console.log(`TOTAL: ${passed}/${asked} answered well, ${asked} asked — ${formatRungs(sumRungs(cards))}.`);
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

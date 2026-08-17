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
 * **The judge is the same endpoint as the extractor and the interrogator**, for the reason
 * ../interrogate/model.ts gives: an operator who decided where their corpus may go decided
 * it for every model braintrust talks to. One judge call per question, ~10 questions per
 * Person — enough to catch a regression without spending an evening's budget on it.
 *
 * **One headline, a coverage number, and the judge's verdict beside it.** The ladder
 * (spec §5.1) says what happened to each question, first true reason wins: Silence,
 * Uncovered, Withheld, Missed, Outranked or Grounded. The headline is *grounded over the
 * covered denominator* — every question that is not Uncovered — because that is the number
 * the fleet is judged on, and only Uncovered leaves the denominator. The judge's *answered
 * well* sits beside it, never as the bar: a question without a Position (Silence, Uncovered,
 * Withheld) is reported as *answered nothing* and is not passed or failed at all (spec §5.2,
 * #328).
 *
 * **The golden question is real, not authored.** Each one is a Person's own item title,
 * drawn deterministically per ../qa/sample.ts — a corpus is guaranteed to have material for
 * a question about its own content, so a miss is worth a look rather than "nobody asked that".
 *
 * **Two negative sets sit beside it, and are read differently.** *off-domain* questions
 * (sourdough starters, tomato pruning, …) are asked of every persona and *anything that
 * comes back is a false answer* — the correct answer to a question nobody has material for
 * is silence. *near-miss* asks each persona another persona's titles and is reported, never
 * barred: overlapping personas legitimately answer some of each other's questions. Neither
 * set spends a judge call — the measurement is whether anything came back, read off the
 * payload. The off-domain questions are authored in ../qa/negative.ts, extendable without
 * touching the harness.
 *
 * **On demand only.** Nothing here schedules, gates a Compile, or files an issue — it is an
 * operator's report, the same standing as ../eval and ../calibrate.
 *
 *   npm run qa                      every serving persona, 10 questions each
 *   npm run qa -- --person SLUG     one persona
 *   npm run qa -- --sample 20       a bigger golden set
 *   npm run qa -- --no-negative     skip the off-domain and near-miss columns
 */

import { ConfigError, loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { createInterrogator, servingFleet } from '../interrogate/index.js';
import { SERVER_NAME } from '../mcp.js';
import { createFetcher } from '../net/fetch.js';
import { checkDimension, createEmbedder, createQueryGate } from '../retrieval/index.js';
import { readArgs } from './args.js';
import { runNegativeQuestion, runQuestion } from './run.js';
import { goldenQuestions } from './sample.js';
import { nearMissQuestions, OFF_DOMAIN } from './negative.js';
import {
  formatNegativeCard,
  formatRungs,
  formatScorecard,
  scoreNegatives,
  scoreOutcomes,
  sumNegativeCards,
  sumRungs,
  type NegativeCard,
  type NegativeOutcome,
  type PersonScorecard,
  type QAOutcome,
} from './score.js';

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  try {
    // `fleet` is who exists and serves; `people` is who this run asks. Near-miss pairing
    // needs the whole fleet — a `--person` run still has other members to ask that
    // persona about, and a one-person deployment has none.
    const fleet = (await servingFleet(db)).map((member) => member.person);
    const people = args.person ? [args.person] : fleet;
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
    const negativeCards: NegativeCard[] = [];

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

      if (args.negative) {
        const negativeOutcomes: NegativeOutcome[] = [];
        // Pairing is against the whole serving fleet, not the handful this run is asking —
        // so `--person SLUG` still gives that persona another member's titles to be asked,
        // and a deployment of one gets no near-miss set at all.
        const nearMiss = await nearMissQuestions(db, person, fleet, args.nearMiss);
        for (const question of OFF_DOMAIN) {
          negativeOutcomes.push(
            await runNegativeQuestion({ ...question, person }, { db, embedder, retrieval }),
          );
        }
        for (const question of nearMiss) {
          negativeOutcomes.push(await runNegativeQuestion(question, { db, embedder, retrieval }));
        }

        negativeCards.push(scoreNegatives(person, negativeOutcomes));
        console.log(`${formatNegativeCard(negativeCards[negativeCards.length - 1]!)}`);
      }
      console.log('');
    }

    if (cards.length > 0) {
      const asked = cards.reduce((total, card) => total + card.asked, 0);
      const covered = cards.reduce((total, card) => total + card.covered, 0);
      const passed = cards.reduce((total, card) => total + card.passed, 0);
      const failed = cards.reduce((total, card) => total + card.failed, 0);
      const unjudged = cards.reduce((total, card) => total + card.unjudged, 0);
      const grounded = cards.reduce((total, card) => total + card.grounded, 0);
      const empty = cards.reduce((total, card) => total + card.empty, 0);
      const pct = covered > 0 ? ` (${Math.round((grounded / covered) * 100)}%)` : '';
      console.log(
        `TOTAL: grounded ${grounded}/${covered}${pct} over the covered denominator; ` +
          `judge said ${passed}/${asked - empty} answered well, ` +
          `${failed} failed, ${unjudged} could not be judged; ` +
          `${empty} answered nothing — ${formatRungs(sumRungs(cards))}.`,
      );
      if (negativeCards.length > 0) {
        console.log(formatNegativeCard(sumNegativeCards(negativeCards)));
      }
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

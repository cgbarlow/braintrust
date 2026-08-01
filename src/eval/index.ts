/**
 * `npm run eval` — score a candidate extractor against the incumbent, on the real Corpus.
 *
 * The third entry point beside the server and the job, and an operator's tool rather than a
 * client's: choosing which model reads somebody's published work is a decision about money
 * and about where that work is sent, which is exactly the kind the MCP surface does not
 * make. It is not a test either — the suite has to run with no model endpoint configured.
 *
 *   npm run eval                                    the incumbent, scored from stored Notes
 *   npm run eval -- --model NAME                    a candidate at the configured endpoint
 *   npm run eval -- --model NAME --base-url URL     a candidate somewhere else
 *   npm run eval -- --sample 100 --dry              a bigger set, writing no Notes
 *
 * See docs/design/compiler.md §1 and docs/research/extractor-models.md.
 */

import { writeFile } from 'node:fs/promises';

import { ConfigError, loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { SERVER_NAME } from '../mcp.js';
import { createFetcher } from '../net/fetch.js';
import { createExtractor, EXTRACTOR_TIMEOUT_MS, extractorGenerations } from '../notes/index.js';
import { readArgs } from './args.js';
import { describeSample, sampleCorpus } from './sample.js';
import { compare, type Scorecard } from './score.js';
import { runCandidate, scoreStored } from './run.js';

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  try {
    const items = await sampleCorpus(db, args.sample);
    if (items.length === 0) {
      console.log(`${SERVER_NAME}: nothing has been retrieved yet, so there is nothing to score.`);
      return;
    }
    console.log(`${SERVER_NAME}: eval set — ${describeSample(items)}.`);

    const cards: Scorecard[] = [];

    // Every generation that has already read these Items, free. The incumbent is usually
    // among them, which is the whole reason a comparison costs only the candidate.
    for (const generation of await extractorGenerations(db)) {
      if (args.model && generation.startsWith(`${args.model}@`)) continue;
      const card = await scoreStored(db, generation, items);
      if (card) cards.push(card);
    }

    if (args.model) {
      const extractor = createExtractor(
        { ...config.extractor, model: args.model, ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}) },
        createFetcher({ timeoutMs: EXTRACTOR_TIMEOUT_MS }),
      );
      console.log(
        `${SERVER_NAME}: reading ${items.length} items as ${extractor.generation} via ${extractor.url}` +
          `${args.dry ? ' (writing no notes)' : ''}.`,
      );

      const { card, rejections } = await runCandidate(items, {
        db,
        extractor,
        write: !args.dry,
        log: (line) => console.log(line),
      });
      cards.push(card);

      if (rejections.length > 0) {
        // The one thing production cannot show, because it drops these on purpose. Written
        // to a file rather than a row: it is a model's unverified text, and it earns a look
        // from a human rather than a place in the Corpus.
        const path = `eval-rejections-${extractor.generation.replace(/[^\w.-]+/g, '_')}.json`;
        await writeFile(path, JSON.stringify(rejections, null, 2));
        console.log(`${SERVER_NAME}: ${rejections.length} rejected quote(s) written to ${path}.`);
      }
    }

    if (cards.length === 0) {
      console.log(`${SERVER_NAME}: no generation has read these items yet. Pass --model to run one.`);
      return;
    }

    console.log('');
    console.log(compare(cards));
    console.log('');
    console.log(
      'fidelity and punctuation share need a live read, so a generation scored from stored ' +
        'notes shows them as —. Everything else is measured from the notes themselves.',
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(78);
  }
  console.error(`${SERVER_NAME}: the eval failed.`, error);
  process.exit(1);
});

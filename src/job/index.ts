/**
 * The scheduled job: wakes, runs the cycle, exits.
 *
 * This is the second deployment of the same codebase. It shares a database with the web
 * service and nothing else — no queue, no IPC, no shared memory — which is what stops a
 * 26-minute backfill from ever slowing down a question.
 *
 * **The platform schedules it, not an in-process timer.** A timer only fires while the
 * process is up, and a web service that sleeps on idle — which most cheap tiers do —
 * would silently never ingest. That is precisely the invisible failure the daily-clock
 * decision exists to prevent, reintroduced by the deployment.
 *
 * Deploy it as a cron job running `npm run job` once a day.
 * See docs/design/deployment.md §2.
 */

import { createSynthesiser, SYNTHESIS_TIMEOUT_MS } from '../compile/index.js';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { createDb, type PostgresDb } from '../db.js';
import { runCycle, summarise } from '../ingest/cycle.js';
import { createFetcher, type Fetcher } from '../net/fetch.js';
import { SERVER_NAME, SERVER_VERSION } from '../mcp.js';
import { createExtractor, EXTRACTOR_TIMEOUT_MS } from '../notes/index.js';
import { checkDimension, createEmbedder, type Embedder } from '../retrieval/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  // Being killed mid-run costs nothing, but exiting cleanly costs nothing either: a
  // platform that caps a cron run sends SIGTERM first, and the current fetch is the only
  // work in flight.
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${SERVER_NAME}: ${signal} received — finishing the current item and stopping.`);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  console.log(`${SERVER_NAME} ${SERVER_VERSION}: ingest run starting.`);

  try {
    const fetcher = createFetcher();
    const extractor = createExtractor(config.extractor, createFetcher({ timeoutMs: EXTRACTOR_TIMEOUT_MS }));
    // The same endpoint, a different job: the extractor reads one item, the synthesiser
    // reads the notes. Configured together because an operator who has decided where
    // their corpus may go has decided it for both.
    const synthesiser = createSynthesiser(
      config.extractor,
      createFetcher({ timeoutMs: SYNTHESIS_TIMEOUT_MS }),
    );
    console.log(
      `${SERVER_NAME}: reading items as ${extractor.generation}, compiling as ` +
        `${synthesiser.generation} and grouping positions as ${synthesiser.clusterer} ` +
        `via ${extractor.url}.`,
    );

    const report = await runCycle({
      db,
      fetcher,
      embedder: await usableEmbedder(db, fetcher, config.embeddings),
      extractor,
      synthesiser,
      stopping: () => stopping,
    });

    console.log(summarise(report));
    console.log(
      `${SERVER_NAME}: run finished in ` +
        `${Math.round((Date.parse(report.finished) - Date.parse(report.started)) / 1000)}s.`,
    );
  } finally {
    await db.close();
  }
}

/**
 * The same dimension probe the server runs, one deployment earlier — the job is what
 * *writes* vectors, so an endpoint the column cannot hold is worth one clear message
 * here rather than the same insert failing once per chunk for half an hour.
 *
 * **Failing it stops the embedding, not the ingest.** Items and bodies are tier 1: they
 * are expensive to reacquire and the whole terms posture exists to avoid asking a source
 * twice. An embeddings endpoint that is switched off is not a reason to stop collecting
 * them, and chunking is local and free, so the run does everything except the one step
 * it cannot do honestly. The next run finishes it.
 */
async function usableEmbedder(
  db: PostgresDb,
  fetcher: Fetcher,
  embeddings: Config['embeddings'],
): Promise<Embedder | undefined> {
  const embedder = createEmbedder(embeddings, fetcher);

  try {
    const dimension = await checkDimension(db, embedder);
    console.log(
      `${SERVER_NAME}: embedding as ${embedder.model} (${dimension} dimensions) via ${embedder.url}.`,
    );
    return embedder;
  } catch (error) {
    console.error(
      `${SERVER_NAME}: not embedding on this run — ${
        error instanceof Error ? error.message : String(error)
      }\n  Ingestion continues; the chunks wait for an endpoint braintrust can trust.`,
    );
    return undefined;
  }
}

/**
 * A source that failed is reported, not fatal — the cycle already recorded it against
 * the rows, and exiting non-zero would turn one platform's bad afternoon into a red
 * cron job every day. Only a run that could not happen at all fails.
 */
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    console.error(`${SERVER_NAME}: the ingest run could not complete:`, error);
    process.exit(1);
  });

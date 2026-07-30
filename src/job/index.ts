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

import { ConfigError, loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { runCycle, summarise } from '../ingest/cycle.js';
import { createFetcher } from '../net/fetch.js';
import { SERVER_NAME, SERVER_VERSION } from '../mcp.js';

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
    const report = await runCycle({
      db,
      fetcher: createFetcher(),
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

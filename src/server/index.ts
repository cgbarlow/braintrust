/**
 * The web service: always on, answers questions, tiny.
 *
 * This is one of two deployments of this codebase. The other is a scheduled job
 * that wakes daily, runs the ingest cycle and exits. They share a database and
 * nothing else — no queue, no IPC, no shared memory.
 *
 * See docs/design/deployment.md §2.
 */

import { ConfigError, loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { createApp, HEALTH_PATH, MCP_PATH } from '../http/app.js';
import { createFetcher } from '../net/fetch.js';
import { SERVER_NAME, SERVER_VERSION } from '../mcp.js';
import { checkDimension, createEmbedder, createQueryGate } from '../retrieval/index.js';

async function main(): Promise<void> {
  // Refusing to start beats starting wrong. An unconfigured embeddings endpoint is
  // the case that matters: a default there would mean a first run silently shipping
  // an entire corpus to a third party.
  const config = loadConfig();

  const db = createDb(config.databaseUrl);
  const embedder = createEmbedder(config.embeddings, createFetcher());

  // Startup check 1. A mismatch here is a configuration error and gets the same
  // treatment as a missing variable: the message, no stack trace, and exit 78. There
  // is no degraded mode — an endpoint whose vectors do not fit the column can neither
  // write them nor embed a question in the same space as what is stored.
  const dimension = await checkDimension(db, embedder).catch((error: unknown) => {
    throw new ConfigError(
      `braintrust refuses to start.\n\n  ${
        error instanceof Error ? error.message : String(error)
      }\n\nSee docs/design/deployment.md §3.`,
    );
  });

  // Startup check 2, which is a refusal to *serve* rather than to start. Following
  // someone and listing personas work regardless; it is retrieval that would return
  // confidently-ranked nonsense, and it is retrieval that is withheld.
  const retrieval = createQueryGate(db, config.embeddings.model);
  const readiness = await retrieval.check();
  if (!readiness.ready) console.warn(`${SERVER_NAME}: retrieval is unavailable. ${readiness.reason}`);

  const app = createApp({ db, mcpKey: config.mcpKey, retrieval, embedder });

  const server = app.listen(config.port, () => {
    console.log(
      `${SERVER_NAME} ${SERVER_VERSION} listening on :${config.port}\n` +
        `  MCP     ${MCP_PATH}?key=…\n` +
        `  health  ${HEALTH_PATH}\n` +
        `  embeddings: ${config.embeddings.model}, ${dimension} dimensions, at ${embedder.url}\n` +
        `  retrieval: ${readiness.ready ? 'ready' : 'unavailable until the corpus is embedded'}`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`${SERVER_NAME}: ${signal} received, closing.`);
    server.close(() => {
      void db.close().then(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // A configuration problem is the operator's to fix, so it gets the message and
    // not a stack trace.
    console.error(`\n${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  console.error('braintrust failed to start:', error);
  process.exit(1);
});

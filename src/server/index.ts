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
import { SERVER_NAME, SERVER_VERSION } from '../mcp.js';

async function main(): Promise<void> {
  // Refusing to start beats starting wrong. An unconfigured embeddings endpoint is
  // the case that matters: a default there would mean a first run silently shipping
  // an entire corpus to a third party.
  const config = loadConfig();

  const db = createDb(config.databaseUrl);
  const app = createApp({ db, mcpKey: config.mcpKey });

  const server = app.listen(config.port, () => {
    console.log(
      `${SERVER_NAME} ${SERVER_VERSION} listening on :${config.port}\n` +
        `  MCP     ${MCP_PATH}?key=…\n` +
        `  health  ${HEALTH_PATH}\n` +
        `  embeddings endpoint: ${config.embeddings.model} at ${config.embeddings.baseUrl}`,
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

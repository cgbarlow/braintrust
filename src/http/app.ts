/**
 * The HTTP surface: one MCP endpoint, and a health check for the container platform.
 *
 * The server is stateless per request — built inside the handler, with any
 * `mcp-session-id` stripped. That is what lets the web service scale or restart
 * freely, and it is why a 26-minute backfill in the other deployment can never
 * slow a question here.
 *
 * See docs/design/deployment.md §4.
 */

import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { TransactionalDb } from '../db.js';
import { createConfirmTokenStore, type ConfirmTokenStore } from '../follow/tokens.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from '../mcp.js';
import { createFetcher, type Fetcher } from '../net/fetch.js';
import {
  AUTH_ERROR_CODE,
  AUTH_FAILURE_MESSAGE,
  idFromBody,
  jsonRpcError,
  keyMatches,
  presentedKey,
} from './auth.js';

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';

export type AppDeps = {
  db: TransactionalDb;
  mcpKey: string;
  /**
   * The one piece of state the web service keeps between requests, and it has to be
   * here rather than in the per-request server: a handshake is two requests, and the
   * token issued by the first has to still exist for the second.
   */
  tokens?: ConfirmTokenStore;
  fetcher?: Fetcher;
};

export function createApp({ db, mcpKey, tokens, fetcher }: AppDeps): Express {
  const confirmTokens = tokens ?? createConfirmTokenStore();
  const sourceFetcher = fetcher ?? createFetcher();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // Unauthenticated on purpose: it reveals nothing, and a container platform has
  // to be able to ask whether the process is up without holding the secret.
  app.get(HEALTH_PATH, (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  app.all(MCP_PATH, async (req: Request, res: Response) => {
    if (!keyMatches(mcpKey, presentedKey(req))) {
      // HTTP 200 with a JSON-RPC error, never a 401. See ./auth.ts.
      res.status(200).json(jsonRpcError(idFromBody(req.body), AUTH_ERROR_CODE, AUTH_FAILURE_MESSAGE));
      return;
    }

    // Stateless: no session to resume, so a client-supplied session id is not ours
    // to honour. Stripping it stops the transport treating this as a known session.
    delete req.headers['mcp-session-id'];

    const server = buildServer({ db, tokens: confirmTokens, fetcher: sourceFetcher });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('braintrust: MCP request failed', error);
      if (!res.headersSent) {
        res
          .status(500)
          .json(jsonRpcError(idFromBody(req.body), -32603, 'Internal error handling MCP request.'));
      }
    }
  });

  return app;
}

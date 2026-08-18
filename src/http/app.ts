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
import { recordHeal } from '../heal.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from '../mcp.js';
import { createFetcher, type Fetcher } from '../net/fetch.js';
import type { Extractor } from '../notes/index.js';
import type { Embedder } from '../retrieval/embed.js';
import type { QueryGate } from '../retrieval/index.js';
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
export const HEAL_PATH = '/heal';

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
  /**
   * Startup check 2, asked per request — and, with an embedder, what registers the
   * retrieval tool. Both optional together: a deployment with no embeddings endpoint
   * still follows people and serves Cores, and a search that cannot search is worse
   * than a tool that is not there.
   */
  retrieval?: QueryGate;
  embedder?: Embedder;
  /**
   * What `braintrust_refresh_persona` needs: something to read new items with. Absent
   * means the tool is not registered. Compiles are not started from the web process —
   * they run on the cron deployment — so a refresh that fetches without rebuilding is
   * honest: the next daily compile picks up what it prepared.
   */
  extractor?: Extractor;
};

export function createApp({
  db,
  mcpKey,
  tokens,
  fetcher,
  retrieval,
  embedder,
  extractor,
}: AppDeps): Express {
  const confirmTokens = tokens ?? createConfirmTokenStore();
  const sourceFetcher = fetcher ?? createFetcher();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // Unauthenticated on purpose: it reveals nothing, and a container platform has
  // to be able to ask whether the process is up without holding the secret.
  //
  // It reports whether the index is answerable, because "braintrust is up but cannot
  // search" is exactly the state an operator needs to see without opening an AI client.
  app.get(HEALTH_PATH, async (_req: Request, res: Response) => {
    const readiness = retrieval ? await retrieval.check().catch(unreachable) : undefined;

    res.status(200).json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      ...(readiness ? { retrieval: { model: retrieval!.model, ...readiness } } : {}),
    });
  });

  // Not an MCP tool, deliberately: the healer on the Hermes host is a cron script, not a
  // model, and reporting a bare fact in is plumbing rather than something an agent should
  // ever be offered to call. Authenticated with the same shared secret the MCP path uses
  // — no new secret, the whole point of https://github.com/cgbarlow/braintrust/issues/326 —
  // because each profile's config.yaml already carries it beside the SOUL.md being healed.
  app.post(HEAL_PATH, async (req: Request, res: Response) => {
    if (!keyMatches(mcpKey, presentedKey(req))) {
      res.status(401).json({ ok: false, error: AUTH_FAILURE_MESSAGE });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const { profile, person, template_version } = body;
    if (
      typeof profile !== 'string' || profile.trim() === '' ||
      typeof person !== 'string' || person.trim() === '' ||
      typeof template_version !== 'string' || template_version.trim() === ''
    ) {
      res.status(400).json({
        ok: false,
        error: 'profile, person and template_version are all required, non-empty strings.',
      });
      return;
    }

    await recordHeal(db, {
      profile: profile.trim(),
      person: person.trim(),
      template_version: template_version.trim(),
    });
    res.status(200).json({ ok: true });
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

    const server = buildServer({
      db,
      tokens: confirmTokens,
      fetcher: sourceFetcher,
      // The embedder goes through on its own, but the query gate only alongside it:
      // registering the search tool needs both, while a refresh needs only the embedder
      // — it indexes and judges revisions in that space while the corpus is still half
      // embedded, which is precisely when a search would be answering nonsense.
      ...(embedder ? { embedder } : {}),
      ...(embedder && retrieval ? { retrieval } : {}),
      ...(extractor ? { extractor } : {}),
    });
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

/** The health check answers even when the database does not. That is its job. */
function unreachable(error: unknown): { ready: false; reason: string } {
  return {
    ready: false,
    reason: `braintrust could not ask the database: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

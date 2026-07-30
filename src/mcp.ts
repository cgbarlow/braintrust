/**
 * The MCP server, built fresh for every request.
 *
 * All tools are prefixed `braintrust_`; nothing is named `search` or `fetch`,
 * which OB1 reserves. See docs/design/mcp-surface.md.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Db } from './db.js';
import { DISCLOSURE } from './disclosure.js';
import { listPersonas } from './personas.js';

export const SERVER_NAME = 'braintrust';
export const SERVER_VERSION = '0.1.0';

export type ServerDeps = { db: Db };

export function buildServer({ db }: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: DISCLOSURE },
  );

  server.registerTool(
    'braintrust_list_personas',
    {
      title: 'List braintrust personas',
      description:
        'Who exists in this braintrust, whether they have ever been compiled, and how stale ' +
        'each persona is. Staleness is compiled_at and you judge it; braintrust does not ' +
        'define "stale". Takes no parameters.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const payload = await listPersonas(db);
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  return server;
}

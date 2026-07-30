/**
 * The end-to-end check the ticket actually asks for: a real MCP client connects
 * over HTTP, lists the tools, and calls `braintrust_list_personas`.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { DISCLOSURE } from '../src/disclosure.js';
import { createApp } from '../src/http/app.js';
import { fakeDb } from './support/fake-db.js';

const KEY = 'test-shared-secret';

type JsonRpcErrorBody = { jsonrpc: string; id: string | number | null; error: { code: number; message: string } };

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** No database needed: the read path depends on `Db`, not on `pg`. */
const emptyDb = fakeDb();

let http: Server;
let base: string;

before(async () => {
  const app = createApp({ db: emptyDb, mcpKey: KEY });
  http = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

after(async () => {
  // A test that fails partway leaves its client connected, and a graceful close then
  // never returns — which turns a reported failure into a hung run.
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

async function connect(options: { query?: boolean; header?: boolean } = { query: true }) {
  const url = new URL(`${base}/mcp`);
  if (options.query) url.searchParams.set('key', KEY);

  const transport = new StreamableHTTPClientTransport(
    url,
    options.header ? { requestInit: { headers: { 'x-access-key': KEY } } } : undefined,
  );

  const client = new Client({ name: 'braintrust-test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe('auth at the HTTP boundary', () => {
  it('returns HTTP 200 with a JSON-RPC error, never a 401', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }),
    });

    // A correct 401 makes Codex CLI and Claude Code tear down the connection, so
    // OB1 returns 200 and braintrust copies it deliberately.
    assert.equal(response.status, 200);

    const body = await json<JsonRpcErrorBody>(response);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32001);
    assert.match(body.error.message, /\?key=/);
    // The id is echoed, per JSON-RPC.
    assert.equal(body.id, 42);
  });

  it('rejects a wrong key the same way', async () => {
    const response = await fetch(`${base}/mcp?key=wrong`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    assert.equal(response.status, 200);
    assert.equal((await json<JsonRpcErrorBody>(response)).error.code, -32001);
  });

  it('accepts the key as ?key=', async () => {
    const client = await connect({ query: true });
    assert.equal(client.getServerVersion()?.name, 'braintrust');
    await client.close();
  });

  it('accepts the key as an x-access-key header', async () => {
    const client = await connect({ query: false, header: true });
    assert.equal(client.getServerVersion()?.name, 'braintrust');
    await client.close();
  });

  it('leaves the health check open, since it reveals nothing', async () => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.equal((await json<{ ok: boolean }>(response)).ok, true);
  });
});

describe('the MCP surface', () => {
  it('carries the full disclosure in its server instructions', async () => {
    const client = await connect();
    const instructions = client.getInstructions();

    assert.equal(instructions, DISCLOSURE);
    assert.match(instructions!, /is not that person/);
    assert.match(instructions!, /"braintrust model of X"/);
    assert.match(instructions!, /measured or inferred/);
    assert.match(instructions!, /Paywalled content is never ingested/);
    assert.match(instructions!, /Quotes are verbatim/);
    await client.close();
  });

  it('exposes the tools built so far, and marks which of them write', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['braintrust_follow_person', 'braintrust_list_personas'],
    );

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get('braintrust_list_personas')!.annotations?.readOnlyHint, true);
    // A write tool, so it lands in the client's approval surface rather than running quietly.
    assert.equal(byName.get('braintrust_follow_person')!.annotations?.readOnlyHint, false);
    // OB1 reserves `search` and `fetch`; every braintrust tool is prefixed.
    assert.ok(tools.every((tool) => tool.name.startsWith('braintrust_')));
    await client.close();
  });

  it('answers braintrust_list_personas with an empty list on an empty database', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'braintrust_list_personas', arguments: {} });

    const content = result.content as { type: string; text: string }[];
    assert.equal(content[0]!.type, 'text');
    assert.deepEqual(JSON.parse(content[0]!.text), { personas: [] });
    await client.close();
  });
});

describe('statelessness', () => {
  it('ignores a client-supplied mcp-session-id instead of trying to resume it', async () => {
    const url = new URL(`${base}/mcp`);
    url.searchParams.set('key', KEY);

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { 'mcp-session-id': 'a-session-that-never-existed' } },
    });
    const client = new Client({ name: 'braintrust-test-client', version: '0.0.0' });

    // Without the strip, the transport would look for a session it does not have
    // and reject the request.
    await client.connect(transport);
    const result = await client.callTool({ name: 'braintrust_list_personas', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    assert.deepEqual(JSON.parse(content[0]!.text), { personas: [] });
    await client.close();
  });

  it('never hands out a session id of its own', async () => {
    const response = await fetch(`${base}/mcp?key=${KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '0' },
        },
      }),
    });

    assert.equal(response.headers.get('mcp-session-id'), null);
    await response.body?.cancel();
  });
});

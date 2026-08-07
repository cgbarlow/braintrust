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

import { COMPILER_VERSION } from '../src/compile/version.js';
import { DISCLOSURE } from '../src/disclosure.js';
import { createApp } from '../src/http/app.js';
import { createEmbedder } from '../src/retrieval/index.js';
import { fakeEmbeddings, testEmbeddingsConfig } from './support/embeddings.js';
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
    // Rules that span tools, and nothing else. The vocabulary lesson moved to
    // braintrust_explain_persona, in front of the client that asked for the workings.
    assert.match(instructions!, /Never answer a question about braintrust's own workings/);
    assert.match(instructions!, /Never fill a gap from your own knowledge/);
    assert.doesNotMatch(instructions!, /evidence floor/i);
    await client.close();
  });

  it('exposes the tools built so far, and marks which of them write', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    // No embeddings endpoint and no extractor configured on this server, so there is
    // neither a retrieval tool nor a refresh tool. A search that cannot search, or a
    // refresh that could fetch but never rebuild, is worse than one not offered.
    //
    // braintrust_recent_items *is* here, and that is the point of it appearing in this
    // list: answering "what is new" is a date-ordered read of rows that already exist, so
    // it needs no embeddings and survives a deployment that has none.
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'braintrust_explain_persona',
      'braintrust_follow_person',
      'braintrust_list_personas',
      'braintrust_load_persona',
      'braintrust_recent_items',
      'braintrust_unfollow_person',
    ]);

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get('braintrust_list_personas')!.annotations?.readOnlyHint, true);
    assert.equal(byName.get('braintrust_recent_items')!.annotations?.readOnlyHint, true);
    assert.equal(byName.get('braintrust_load_persona')!.annotations?.readOnlyHint, true);
    // A write tool, so it lands in the client's approval surface rather than running quietly.
    assert.equal(byName.get('braintrust_follow_person')!.annotations?.readOnlyHint, false);
    // Unfollow writes too, but it is offered whatever else is configured: stopping is
    // never the thing a missing endpoint should be able to prevent.
    assert.equal(byName.get('braintrust_unfollow_person')!.annotations?.readOnlyHint, false);
    // OB1 reserves `search` and `fetch`; every braintrust tool is prefixed.
    assert.ok(tools.every((tool) => tool.name.startsWith('braintrust_')));
    await client.close();
  });

  it('refuses braintrust_load_persona for someone braintrust does not follow, readably', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'braintrust_load_persona', arguments: { person: 'nobody' } });

    // A refusal is a normal answer rather than a protocol fault: it comes back as tool
    // content the calling model can read and act on, flagged as an error.
    assert.equal(result.isError, true);
    const content = result.content as { type: string; text: string }[];
    assert.match(content[0]!.text, /does not follow anyone called "nobody"/);
    assert.match(content[0]!.text, /braintrust_list_personas/);
    await client.close();
  });

  it('tells a client what load_persona is for, and sends the paperwork elsewhere', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.description!]));
    const load = byName.get('braintrust_load_persona')!;

    // A description answers the choosing question. The ~400-word essay on basis and
    // evidence floors described a payload that no longer exists.
    assert.match(load, /ready to speak/);
    assert.match(load, /braintrust_explain_persona/);
    assert.match(load, /never compiled/i);
    assert.doesNotMatch(load, /measured or inferred/);

    // …and the essay lands where the client that wants it will be.
    const explain = byName.get('braintrust_explain_persona')!;
    assert.match(explain, /`measured` or `inferred`/);
    assert.match(explain, /no model in the path/);
    assert.match(explain, /floor\s*\n?\s*rather than a tally/);
    assert.match(explain, /Never\s*\n?\s*answer those from the persona itself/);
    await client.close();
  });

  it('answers braintrust_list_personas with an empty list on an empty database', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'braintrust_list_personas', arguments: {} });

    const content = result.content as { type: string; text: string }[];
    assert.equal(content[0]!.type, 'text');
    assert.deepEqual(JSON.parse(content[0]!.text), {
      personas: [],
      current_compiler_version: COMPILER_VERSION,
    });
    await client.close();
  });
});

describe('the retrieval tool, on a server that has an embeddings endpoint', () => {
  let searchable: Server;
  let searchBase: string;

  before(async () => {
    const app = createApp({
      db: emptyDb,
      mcpKey: KEY,
      embedder: createEmbedder(testEmbeddingsConfig, fakeEmbeddings().fetcher),
      retrieval: { model: testEmbeddingsConfig.model, check: async () => ({ ready: true }) },
    });
    searchable = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    searchBase = `http://127.0.0.1:${(searchable.address() as AddressInfo).port}`;
  });

  after(async () => {
    searchable.closeAllConnections();
    await new Promise<void>((resolve) => searchable.close(() => resolve()));
  });

  async function connectSearchable() {
    const url = new URL(`${searchBase}/mcp`);
    url.searchParams.set('key', KEY);
    const client = new Client({ name: 'braintrust-test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    return client;
  }

  it('is registered, read-only, and says what it will not tell you', async () => {
    const client = await connectSearchable();
    const { tools } = await client.listTools();

    const find = tools.find((tool) => tool.name === 'braintrust_find_positions')!;
    assert.equal(find.annotations?.readOnlyHint, true);

    // Two grades, and the reason there are two: `measured` + `high` read as licence to
    // answer a question the corpus never covered.
    assert.match(find.description!, /`confidence` is how well braintrust knows the position/);
    assert.match(find.description!, /`fit` is how well it answers the question you\s*\n?\s*asked/);
    // Which kind of empty, because "nothing came close" and "nothing is indexed" are
    // different facts about a corpus. `did_not_select` was the third and named the
    // discredited margin test; the description outlived the enum by two releases, which is
    // why this asserts the reasons that exist rather than merely that some are described.
    assert.match(find.description!, /below_floor/);
    assert.match(find.description!, /nothing_indexed/);
    assert.doesNotMatch(find.description!, /did_not_select/);
    // The number behind `fit`, without which neither grade can be checked.
    assert.match(find.description!, /`similarity` is the number `fit` was graded from/);
    // An empty answer still cannot tell you they never said it.
    assert.match(find.description!, /cannot tell you they never said it/);
    // Quotes stay a must-not-get-wrong.
    assert.match(find.description!, /the tidied version is not the quote/);
    await client.close();
  });

  it('refuses readably for a person with no persona rather than searching anyway', async () => {
    const client = await connectSearchable();
    const result = await client.callTool({
      name: 'braintrust_find_positions',
      arguments: { person: 'nobody', query: 'evals' },
    });

    assert.equal(result.isError, true);
    const content = result.content as { type: string; text: string }[];
    assert.match(content[0]!.text, /no persona for "nobody"/);
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
    assert.deepEqual(JSON.parse(content[0]!.text), {
      personas: [],
      current_compiler_version: COMPILER_VERSION,
    });
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

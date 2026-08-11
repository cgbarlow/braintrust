/**
 * The two new tools as a client sees them: whether they are offered at all, what their
 * annotations say about writing, and what their descriptions promise.
 *
 * The descriptions matter more here than usual. Refresh is the one write tool an AI may
 * complete alone, and unfollow is the one whose name most invites being read as a
 * deletion — so what the tool says about itself is the whole of what stops a model
 * reaching for the wrong one.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createApp } from '../src/http/app.js';
import { createExtractor } from '../src/notes/index.js';
import { fakeDb, type Answer } from './support/fake-db.js';
import { fakeExtractor, testExtractorConfig } from './support/notes.js';
import { fakeFetcher, natesRoutes } from './support/sources.js';

const KEY = 'test-shared-secret';

/** One followed person, never compiled, with two sources and nine items to keep. */
const oneFollowedPerson: Answer = (sql, params) => {
  const text = sql.replace(/\s+/g, ' ');
  if (
    text.includes('from braintrust_people p') &&
    text.includes('where p.slug = $1') &&
    params[0] === 'nate-b-jones'
  ) {
    return [
      {
        id: 'person-1',
        slug: 'nate-b-jones',
        display_name: 'Nate B. Jones',
        paused_at: null,
        compiled_at: null,
        compiler_version: null,
      },
    ];
  }
  if (text.includes('count(*)::text from braintrust_sources')) return [{ sources: '2', items: '9' }];
  return [];
};

let http: Server;
let base: string;

before(async () => {
  const app = createApp({
    db: fakeDb(oneFollowedPerson),
    mcpKey: KEY,
    fetcher: fakeFetcher(natesRoutes()),
    extractor: createExtractor(testExtractorConfig, fakeExtractor().fetcher),
  });
  http = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

after(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

async function connect(): Promise<Client> {
  const url = new URL(`${base}/mcp`);
  url.searchParams.set('key', KEY);
  const client = new Client({ name: 'braintrust-test-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

describe('the maintenance half of the surface', () => {
  it('offers refresh once there is something to read and rebuild with', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    assert.ok(byName.has('braintrust_refresh_persona'));
    assert.ok(byName.has('braintrust_unfollow_person'));

    // Both write, so both land in the client's approval surface. Neither destroys:
    // refresh adds, and unfollow sets a timestamp it can unset.
    for (const name of ['braintrust_refresh_persona', 'braintrust_unfollow_person']) {
      assert.equal(byName.get(name)!.annotations?.readOnlyHint, false, name);
      assert.equal(byName.get(name)!.annotations?.destructiveHint, false, name);
    }

    // Unfollowing twice is the same braintrust; refreshing twice is not the same corpus.
    assert.equal(byName.get('braintrust_unfollow_person')!.annotations?.idempotentHint, true);
    assert.equal(byName.get('braintrust_refresh_persona')!.annotations?.idempotentHint, false);
    await client.close();
  });

  it('tells a model refresh is its to call, and what a refusal means', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === 'braintrust_refresh_persona')!.description!;

    assert.match(description, /Call this freely/);
    assert.match(description, /No human needs to approve it/);
    // The daily compile, not the refresh, rebuilds.
    assert.match(description, /Compiles happen on the daily run/);
    assert.match(description, /paused person is refused/i);
    await client.close();
  });

  it('says in the unfollow tool itself that it is not a takedown', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === 'braintrust_unfollow_person')!.description!;

    assert.match(description, /not a takedown and it deletes nothing/);
    assert.match(description, /keeps answering/);
    assert.match(description, /full two-call handshake/);
    // The distinction most likely to be got wrong, drawn where the model reads it.
    assert.match(description, /braintrust has no tool that is/);
    await client.close();
  });

  it('answers unfollow with what it kept, and names the deletion as none', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'braintrust_unfollow_person',
      arguments: { person: 'nate-b-jones' },
    })) as ToolResult;

    assert.ok(!result.isError, result.content[0]?.text);
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.deleted, 'nothing');
    assert.equal(payload.paused.subject, 'braintrust model of Nate B. Jones');
    assert.equal(payload.kept.sources, 2);
    assert.equal(payload.kept.items, 9);
    // Never compiled, so there is no frozen persona to promise — and saying so beats
    // implying one is still answering.
    assert.equal(payload.kept.persona, null);
    await client.close();
  });

  it('refuses a slug it does not follow as a readable answer, not a protocol fault', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'braintrust_refresh_persona',
      arguments: { person: 'nobody' },
    })) as ToolResult;

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /braintrust_list_personas/);
    await client.close();
  });
});

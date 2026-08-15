/**
 * The verify-sources tool over real MCP, exercising the three verdicts and the
 * behaviour on failure.
 *
 * Like follow-mcp.test.ts, this tests the tool as a client actually sees it:
 * a real MCP client, over real HTTP, with the database returning rows the same
 * way it would in production.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createApp } from '../src/http/app.js';
import { type Answer, type FakeDb, fakeDb } from './support/fake-db.js';

const KEY = 'test-shared-secret';

/**
 * A person with one item whose body contains a known sentence, one item whose
 * body does not, and one item whose body is null.
 */
const PERSON_SLUG = 'nate-b-jones';
const DISPLAY_NAME = 'Nate B. Jones';
const ITEM_URL_MATCHES = 'https://example.com/matches';
const ITEM_URL_NOMATCH = 'https://example.com/nomatch';
const ITEM_URL_NOBODY = 'https://example.com/nobody';
const ITEM_TITLE = 'A real post';
const SENTENCE_FOUND = 'This sentence is in the body.';
const SENTENCE_NOT_FOUND = 'This is not in the body at all.';

/** A Position braintrust holds for the person — synthesised across many items. */
const POSITION_STATEMENT = 'Recovering perfectionists optimise for speed at the cost of skill.';
const POSITIONS = [{ slug: 'recovering-perfectionists', statement: POSITION_STATEMENT }];

const ITEMS: Record<string, { id: string; title: string; url: string; published_at: Date; body_text: string | null }> = {
  [ITEM_URL_MATCHES]: {
    id: 'item-1',
    title: ITEM_TITLE,
    url: ITEM_URL_MATCHES,
    published_at: new Date(2026, 6, 23),
    body_text: `Some text here. ${SENTENCE_FOUND} And some more text.`,
  },
  [ITEM_URL_NOMATCH]: {
    id: 'item-2',
    title: 'Another post',
    url: ITEM_URL_NOMATCH,
    published_at: new Date(2026, 6, 23),
    body_text: 'Completely different content.',
  },
  [ITEM_URL_NOBODY]: {
    id: 'item-3',
    title: 'Empty body',
    url: ITEM_URL_NOBODY,
    published_at: new Date(2026, 6, 23),
    body_text: null,
  },
};

const seedDb: Answer = (sql, params) => {
  const text = sql.replace(/\s+/g, ' ');

  // Return the person — only for the known slug
  if (text.includes('from braintrust_people where') && text.includes('paused_at is null')) {
    const slug = params[0];
    return slug === PERSON_SLUG ? [{ display_name: DISPLAY_NAME }] : [];
  }

  // Item lookup by URL
  if (text.includes('from braintrust_items it') && text.includes('it.url = $2')) {
    const url = params[1] as string;
    const item = ITEMS[url];
    return item ? [item] : [];
  }

  // Item lookup by title — only for known titles
  if (text.includes('from braintrust_items it') && text.includes('it.title = $2')) {
    const title = params[1] as string;
    const item = Object.values(ITEMS).find((i) => i.title === title);
    return item ? [item] : [];
  }

  // The claims braintrust holds for the person — Positions and through-lines.
  if (text.includes('from braintrust_positions pos')) {
    return POSITIONS;
  }

  // Insert into braintrust_faults — fake a returning row so openFault works
  if (text.includes('insert into braintrust_faults')) {
    return [
      {
        fault_key: `${params[0]}`,
        assertion: params[1],
        person_slug: params[2],
        detail: params[3],
        first_failed_at: new Date(),
        last_failed_at: new Date(),
        reported_at: null,
        escalated_at: null,
      },
    ];
  }

  return [];
};

let http: Server;
let base: string;
let db: FakeDb;

before(async () => {
  db = fakeDb(seedDb);
  const app = createApp({ db, mcpKey: KEY });
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

async function verify(client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name: 'braintrust_verify_sources', arguments: args })) as ToolResult;
}

function payload(result: ToolResult): Record<string, any> {
  assert.ok(!result.isError, result.content[0]?.text);
  return JSON.parse(result.content[0]!.text);
}

describe('braintrust_verify_sources over MCP', () => {
  it('returns sourced for a sentence found in the claimed item', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: SENTENCE_FOUND,
        sentences: [{ text: SENTENCE_FOUND, claimed_item: ITEM_URL_MATCHES }],
      }),
    );

    assert.equal(result.subject, 'braintrust model of Nate B. Jones');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.sentence, SENTENCE_FOUND);
    assert.equal(result.results[0]!.verdict, 'sourced');
    assert.equal(result.results[0]!.detail, undefined);

    await client.close();
  });

  it('returns unsourced for a sentence not in the claimed item', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: SENTENCE_NOT_FOUND,
        sentences: [{ text: SENTENCE_NOT_FOUND, claimed_item: ITEM_URL_NOMATCH }],
      }),
    );

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.verdict, 'unsourced');
    assert.ok(result.results[0]!.detail);

    await client.close();
  });

  it('returns never_claimed when no source is claimed', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: 'A sentence with no source.',
        sentences: [{ text: 'A sentence with no source.', claimed_item: null }],
      }),
    );

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.verdict, 'never_claimed');
    assert.equal(result.results[0]!.detail, undefined);

    await client.close();
  });

  it('returns never_claimed for an item that does not exist', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: 'Something from nowhere.',
        sentences: [{ text: 'Something from nowhere.', claimed_item: 'https://example.com/nonexistent' }],
      }),
    );

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.verdict, 'never_claimed');
    assert.ok(result.results[0]!.detail);

    await client.close();
  });

  it('returns unsourced for an item with no body text', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: 'Something from an empty item.',
        sentences: [{ text: 'Something from an empty item.', claimed_item: ITEM_URL_NOBODY }],
      }),
    );

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.verdict, 'unsourced');
    assert.ok(result.results[0]!.detail);

    await client.close();
  });

  it('does not claim the item holds a body that was never stored, even for a quoted handover line', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: `${SENTENCE_NOT_FOUND}`,
        sentences: [{ text: `*Quote:* "${SENTENCE_NOT_FOUND}"`, claimed_item: ITEM_URL_NOBODY }],
      }),
    );

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.verdict, 'unsourced');
    assert.match(result.results[0]!.detail!, /body was not stored|post text is missing/);
    assert.doesNotMatch(result.results[0]!.detail!, /holds its body/);

    await client.close();
  });

  it('handles multiple sentences with mixed verdicts', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: `${SENTENCE_FOUND} ${SENTENCE_NOT_FOUND} No source given.`,
        sentences: [
          { text: SENTENCE_FOUND, claimed_item: ITEM_URL_MATCHES },
          { text: SENTENCE_NOT_FOUND, claimed_item: ITEM_URL_MATCHES },
          { text: 'No source given.', claimed_item: null },
        ],
      }),
    );

    assert.equal(result.results.length, 3);
    assert.equal(result.results[0]!.verdict, 'sourced');
    assert.equal(result.results[1]!.verdict, 'unsourced');
    assert.equal(result.results[2]!.verdict, 'never_claimed');

    // A fault should be recorded because at least one check failed
    assert.ok(result.fault);

    await client.close();
  });

  it('looks up by title when URL does not match', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: SENTENCE_FOUND,
        sentences: [{ text: SENTENCE_FOUND, claimed_item: ITEM_TITLE }],
      }),
    );

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]!.verdict, 'sourced');

    await client.close();
  });

  it('refuses an unknown person', async () => {
    const client = await connect();
    const result = await verify(client, {
      person: 'nobody',
      reply: 'Hello.',
      sentences: [{ text: 'Hello.', claimed_item: null }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /does not know/);

    await client.close();
  });

  it('passes a record handover verbatim — the record’s field labels are never verified as quotations', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: '**Record**\n*Title:* "A real post"\n*URL:* https://example.com/matches',
        sentences: [
          { text: '**Record**', claimed_item: ITEM_URL_MATCHES },
          { text: '*Title:* "A real post"', claimed_item: ITEM_URL_MATCHES },
          { text: '*URL:* https://example.com/matches', claimed_item: ITEM_URL_MATCHES },
          { text: '*Published at:* 2026-07-23', claimed_item: ITEM_URL_MATCHES },
          { text: `*Quote:* "${SENTENCE_FOUND}"`, claimed_item: ITEM_URL_MATCHES },
        ],
      }),
    );

    // Four of the five are the record's own field labels or the label line's framing; none
    // is verified as a quotation. The fifth is the quotation with its label attached,
    // verified on the quotation, not on the label. All five pass, and no fault opens.
    for (const one of result.results) {
      assert.equal(one.verdict, 'sourced', one.sentence);
    }
    assert.equal(result.fault, undefined);

    await client.close();
  });

  it('names the invented span when a quoted handover is not in the source', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: 'I predicted all of this in 2027.',
        sentences: [
          { text: `*Quote:* "I predicted all of this in 2027."`, claimed_item: ITEM_URL_MATCHES },
        ],
      }),
    );

    assert.equal(result.results[0]!.verdict, 'unsourced');
    assert.match(result.results[0]!.detail!, /I predicted all of this in 2027/);
    // A genuine fabrication still opens a fault.
    assert.ok(result.fault);

    await client.close();
  });

  it('tolerates the sentence punctuation a handover line carries', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: '*Title:* "A real post," *URL:* https://example.com/matches.',
        sentences: [
          { text: '*Title:* "A real post,"', claimed_item: ITEM_URL_MATCHES },
          { text: '*URL:* https://example.com/matches.', claimed_item: ITEM_URL_MATCHES },
        ],
      }),
    );

    // A comma glued to the title inside the quotes, and a period a sentence would carry on
    // the URL line, are the same record handed over — not a forged citation. Both pass, and
    // no fault opens.
    for (const one of result.results) {
      assert.equal(one.verdict, 'sourced', one.sentence);
    }
    assert.equal(result.fault, undefined);

    await client.close();
  });

  it('does not misread a prose sentence that merely opens with a label word', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: 'URL: the best explanation I have seen is this.',
        sentences: [
          { text: 'URL: the best explanation I have seen is this.', claimed_item: ITEM_URL_MATCHES },
        ],
      }),
    );

    // "URL: …" here is prose, not a handover line: the value is not shaped like a URL. It
    // is checked as a plain sentence against the body — not compared to the item's URL.
    assert.equal(result.results[0]!.verdict, 'unsourced');
    assert.match(result.results[0]!.detail!, /not in it/);

    await client.close();
  });

  it('verifies a sentence that is a Position against what a Position is, with no source named', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: POSITION_STATEMENT,
        sentences: [{ text: POSITION_STATEMENT, claimed_item: null }],
      }),
    );

    // A Position is synthesised across many items, so no single item can contain it — the
    // sentence is checked against what a Position is, and comes back sourced with the note.
    assert.equal(result.results[0]!.verdict, 'sourced');
    assert.match(result.results[0]!.detail!, /Position/);
    assert.equal(result.fault, undefined);

    await client.close();
  });

  it('verifies a Position even when the named source is not an item', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: POSITION_STATEMENT,
        sentences: [
          { text: POSITION_STATEMENT, claimed_item: 'https://example.com/not-an-item' },
        ],
      }),
    );

    assert.equal(result.results[0]!.verdict, 'sourced');
    assert.match(result.results[0]!.detail!, /Position/);
    assert.equal(result.fault, undefined);

    await client.close();
  });

  it('refuses a source braintrust cannot place as unanswerable, never as a forgery', async () => {
    const client = await connect();
    const result = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: 'Nobody ever said this anywhere.',
        sentences: [
          { text: 'Nobody ever said this anywhere.', claimed_item: 'https://example.com/not-an-item' },
        ],
      }),
    );

    assert.equal(result.results[0]!.verdict, 'never_claimed');
    assert.match(result.results[0]!.detail!, /refused as unanswerable/);
    assert.doesNotMatch(result.results[0]!.detail!, /naming a source that does not exist/);
    // An unanswerable citation is not a finding against the persona, so it opens no fault.
    assert.equal(result.fault, undefined);

    await client.close();
  });

  it('works across multiple turns within one session — the spec requires multi-turn', async () => {
    const client = await connect();

    // Turn 1: check a sentence found in its claimed item
    const turn1 = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: SENTENCE_FOUND,
        sentences: [{ text: SENTENCE_FOUND, claimed_item: ITEM_URL_MATCHES }],
      }),
    );
    assert.equal(turn1.results[0]!.verdict, 'sourced');

    // Turn 2: same session, different sentence
    const turn2 = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: SENTENCE_NOT_FOUND,
        sentences: [{ text: SENTENCE_NOT_FOUND, claimed_item: ITEM_URL_NOMATCH }],
      }),
    );
    assert.equal(turn2.results[0]!.verdict, 'unsourced');

    // Turn 3: unclaimed sentence
    const turn3 = payload(
      await verify(client, {
        person: PERSON_SLUG,
        reply: 'No source.',
        sentences: [{ text: 'No source.', claimed_item: null }],
      }),
    );
    assert.equal(turn3.results[0]!.verdict, 'never_claimed');

    await client.close();
  });

  it('describes itself to the calling model', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'braintrust_verify_sources')!;

    assert.ok(tool, 'braintrust_verify_sources is registered');
    assert.match(tool.description!, /sourced.*unsourced.*never claimed/is);
    assert.match(tool.description!, /whole reply/i);
    assert.match(tool.description!, /indexOf/i);
    assert.match(tool.description!, /No model call/i);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), [
      'person',
      'reply',
      'sentences',
    ]);

    const sentencesSchema = tool.inputSchema.properties!.sentences as any;
    assert.equal(sentencesSchema.type, 'array');
    assert.ok(sentencesSchema.items);

    const sentenceItems = sentencesSchema.items as any;
    assert.deepEqual(Object.keys(sentenceItems.properties ?? {}).sort(), [
      'claimed_item',
      'text',
    ]);

    await client.close();
  });
});

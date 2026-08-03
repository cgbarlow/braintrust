/**
 * `braintrust_recent_items` — the shape of an answer to *what is new*.
 *
 * The behaviours worth pinning are the ones that make this tool honest rather than the
 * ones that make it work: that an Item nobody read never acquires a gist, that it is
 * listed anyway rather than quietly dropped, and that the answer is ordered by the
 * database on a date rather than by anything that could form a judgement.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLAIMS_PER_ITEM, DEFAULT_RECENT, MAX_RECENT, recentItems } from '../src/recent.js';
import { fakeDb } from './support/fake-db.js';

const PERSON = [{ display_name: 'Ethan Mollick', compiled_at: new Date('2026-08-01T22:53:44Z') }];

function dbWith(items: Record<string, unknown>[]) {
  return fakeDb((sql) => (sql.includes('braintrust_people p\n      where') || sql.includes('display_name') ? PERSON : items));
}

function itemRow(over: Record<string, unknown> = {}) {
  return {
    title: 'An opinionated guide to which AI to use to do stuff',
    url: 'https://www.oneusefulthing.org/p/an-opinionated-guide',
    published_at: '2026-07-23',
    platform: 'substack',
    retrieval: 'retrieved',
    argument_md: 'Pick one of two assistants and give it a real task.',
    claims: [{ statement: 'Most people should pick Claude or ChatGPT.', quote: 'q' }],
    ...over,
  };
}

describe('recent items', () => {
  it('serves the gist braintrust recorded, not a summary made now', async () => {
    const db = dbWith([itemRow()]);
    const payload = await recentItems({ person: 'ethan-mollick' }, db);

    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0]!.gist?.argument, 'Pick one of two assistants and give it a real task.');
    assert.deepEqual(payload.items[0]!.gist?.claims, ['Most people should pick Claude or ChatGPT.']);
    assert.equal(payload.items[0]!.not_read, undefined);
  });

  it('carries the disclosure in the subject, like every other payload', async () => {
    const payload = await recentItems({ person: 'ethan-mollick' }, dbWith([itemRow()]));
    assert.equal(payload.subject, 'braintrust model of Ethan Mollick');
  });

  it('lists an item braintrust never read, and gives it no gist', async () => {
    // The overstatement #112 forbids: dropping the paywalled posts would say this person
    // published less than they did, and inventing a gist for one is worse still.
    const db = dbWith([itemRow({ retrieval: 'skipped_paywall', argument_md: null, claims: null })]);
    const payload = await recentItems({ person: 'ethan-mollick' }, db);

    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0]!.gist, undefined);
    assert.equal(payload.items[0]!.not_read?.reason, 'skipped_paywall');
    assert.match(payload.items[0]!.not_read!.say, /paywall/);
  });

  it('never promises a gist for an item that was read but never noted', async () => {
    const db = dbWith([itemRow({ argument_md: null, claims: null })]);
    const payload = await recentItems({ person: 'ethan-mollick' }, db);
    assert.equal(payload.items[0]!.gist, undefined);
    assert.equal(payload.items[0]!.not_read?.reason, 'pending');
  });

  it('orders by published date in the database, descending', async () => {
    const db = dbWith([itemRow()]);
    await recentItems({ person: 'ethan-mollick' }, db);
    const sql = db.sql().join(' ');
    assert.match(sql, /order by i\.published_at desc/);
  });

  it('bounds the gist, and says how many claims it held back', async () => {
    const claims = Array.from({ length: CLAIMS_PER_ITEM + 3 }, (_, i) => ({ statement: `c${i}` }));
    const payload = await recentItems({ person: 'ethan-mollick' }, dbWith([itemRow({ claims })]));

    assert.equal(payload.items[0]!.gist?.claims.length, CLAIMS_PER_ITEM);
    assert.equal(payload.items[0]!.gist?.more_claims, 3);
  });

  it('asks for one row more than it will show, so "more" needs no second query', async () => {
    const db = dbWith(Array.from({ length: DEFAULT_RECENT + 1 }, () => itemRow()));
    const payload = await recentItems({ person: 'ethan-mollick' }, db);

    assert.equal(payload.items.length, DEFAULT_RECENT);
    assert.equal(payload.more_available, 1);
    assert.equal(db.calls.at(-1)!.params[2], DEFAULT_RECENT + 1);
  });

  it('clamps a limit past the maximum rather than refusing it', async () => {
    const db = dbWith([itemRow()]);
    await recentItems({ person: 'ethan-mollick', limit: 5000 }, db);
    assert.equal(db.calls.at(-1)!.params[2], MAX_RECENT + 1);
  });

  it('echoes the window back, so a filtered answer cannot read as a whole one', async () => {
    const payload = await recentItems(
      { person: 'ethan-mollick', since: '2026-07-01' },
      dbWith([itemRow()]),
    );
    assert.deepEqual(payload.window, { since: '2026-07-01' });
  });

  it('distinguishes "nothing collected yet" from "nothing since that date"', async () => {
    const empty = await recentItems({ person: 'ethan-mollick' }, dbWith([]));
    assert.match(empty.nothing_yet!.say, /has not collected anything/);

    const windowed = await recentItems({ person: 'ethan-mollick', since: '2030-01-01' }, dbWith([]));
    assert.match(windowed.nothing_yet!.say, /since that date/);
  });

  it('refuses a person braintrust does not follow, pointing at the tool that lists them', async () => {
    const db = fakeDb(() => []);
    await assert.rejects(
      () => recentItems({ person: 'nobody' }, db),
      /does not follow anyone called "nobody".*braintrust_list_personas/s,
    );
  });
});

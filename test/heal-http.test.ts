/**
 * `POST /heal` at the HTTP boundary: what scripts/patch-hermes-profiles.sh actually calls,
 * with the same shared secret every profile's config.yaml already carries for the MCP
 * path — no new secret, which is the point of issue #326.
 *
 * Deliberately not an MCP tool call: the caller is a cron script on a host braintrust does
 * not own, not a model, so this is tested as the plain authenticated endpoint it is.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/http/app.js';
import { fakeDb } from './support/fake-db.js';

const KEY = 'test-shared-secret';

let http: Server;
let base: string;
let db: ReturnType<typeof fakeDb>;

before(async () => {
  db = fakeDb();
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

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /heal', () => {
  it('rejects a missing or wrong key with a plain 401 — this is not the MCP transport OB1\'s 200-envelope rule is for', async () => {
    const missing = await post('/heal', { profile: 'bt-nate-b-jones', person: 'nate-b-jones', template_version: 'abc' });
    assert.equal(missing.status, 401);

    const wrong = await post('/heal?key=wrong', {
      profile: 'bt-nate-b-jones',
      person: 'nate-b-jones',
      template_version: 'abc',
    });
    assert.equal(wrong.status, 401);
  });

  it('accepts the key as ?key=, the same as the MCP path', async () => {
    const response = await post(`/heal?key=${KEY}`, {
      profile: 'bt-nate-b-jones',
      person: 'nate-b-jones',
      template_version: 'abc123456789',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it('accepts the key as an x-access-key header', async () => {
    const response = await fetch(`${base}/heal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-key': KEY },
      body: JSON.stringify({ profile: 'bt-nate-b-jones', person: 'nate-b-jones', template_version: 'abc' }),
    });
    assert.equal(response.status, 200);
  });

  it('writes the report through recordHeal — profile, person and template_version, upserted', async () => {
    db.calls.length = 0;
    await post(`/heal?key=${KEY}`, { profile: 'bt-matt-pocock', person: 'matt-pocock', template_version: 'v9' });

    const write = db.calls.find((call) => call.sql.includes('insert into braintrust_soul_heals'));
    assert.ok(write, 'expected an insert into braintrust_soul_heals');
    assert.deepEqual(write!.params, ['matt-pocock', 'bt-matt-pocock', 'v9']);
  });

  it('rejects a body missing any of the three required fields, without touching the database', async () => {
    db.calls.length = 0;
    const response = await post(`/heal?key=${KEY}`, { profile: 'bt-nate-b-jones', person: 'nate-b-jones' });

    assert.equal(response.status, 400);
    assert.equal(db.calls.length, 0);
  });

  it('rejects an empty-string field the same as a missing one', async () => {
    const response = await post(`/heal?key=${KEY}`, {
      profile: '  ',
      person: 'nate-b-jones',
      template_version: 'v1',
    });
    assert.equal(response.status, 400);
  });
});


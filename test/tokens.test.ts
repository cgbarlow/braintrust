/**
 * The confirm token. Short-lived and single-use, because a stale confirmation is a
 * hole in the human-only rule.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createConfirmTokenStore, TOKEN_TTL_MS } from '../src/follow/tokens.js';
import type { Plan, PlannedSource } from '../src/follow/plan.js';

const plan = { person: 'Nate B. Jones' } as Plan;
const planned = [{ platform: 'substack', handle: 'x.substack.com' }] as unknown as PlannedSource[];
const pending = { plan, planned, proposedName: 'Nate B. Jones' };

describe('confirm tokens', () => {
  it('hands back exactly what call 1 planned', () => {
    const store = createConfirmTokenStore();
    const { token } = store.issue(pending);

    const redeemed = store.redeem(token);
    assert.equal(redeemed.proposedName, 'Nate B. Jones');
    assert.deepEqual(redeemed.planned, planned);
  });

  it('is single-use: a replayed call 2 cannot ingest twice', () => {
    const store = createConfirmTokenStore();
    const { token } = store.issue(pending);

    store.redeem(token);
    assert.throws(() => store.redeem(token), /single-use/);
    assert.equal(store.pending(), 0);
  });

  it('expires, and says nothing was ingested when it has', () => {
    let clock = 1_000;
    const store = createConfirmTokenStore({ now: () => clock });
    const { token } = store.issue(pending);

    clock += TOKEN_TTL_MS - 1;
    assert.doesNotThrow(() => store.redeem(token));

    const second = store.issue(pending);
    clock += TOKEN_TTL_MS;
    assert.throws(() => store.redeem(second.token), /Nothing has been ingested/);
  });

  it('rejects a token it never issued', () => {
    const store = createConfirmTokenStore();
    assert.throws(() => store.redeem('made-up'), /not one braintrust is holding/);
  });

  it('issues tokens that are not guessable from each other', () => {
    const store = createConfirmTokenStore();
    const tokens = new Set(Array.from({ length: 20 }, () => store.issue(pending).token));

    assert.equal(tokens.size, 20);
    for (const token of tokens) assert.ok(token.length >= 40, `${token} is too short to be random`);
  });

  it('reports how many confirmations are outstanding, expiry included', () => {
    let clock = 0;
    const store = createConfirmTokenStore({ now: () => clock });
    store.issue(pending);
    store.issue(pending);
    assert.equal(store.pending(), 2);

    clock += TOKEN_TTL_MS;
    assert.equal(store.pending(), 0);
  });
});

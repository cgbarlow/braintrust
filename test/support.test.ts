/**
 * Statement support, without a database: the digest the judge is shown, and the same
 * restraint every other judge on this map is held to — a verdict on a Position braintrust
 * never sent is not recorded.
 *
 * The dedup ledger and the fault it opens need real rows to mean anything, so
 * test/support-fault.integration.test.ts holds those up against real Postgres. What is
 * provable here is the shape of the question: one block per Position, its own quotes and
 * nothing else, batched so a large Compile costs a bounded number of calls.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BuiltPosition, PositionCitation } from '../src/compile/positions.js';
import {
  judgeStatementSupport,
  MAX_QUOTES_SHOWN,
  SUPPORT_BATCH,
  supportDigest,
  SUPPORT_QUOTE_MAX_CHARS,
} from '../src/compile/support.js';
import { fakeSynthesiser, slugsFromDigest } from './support/synthesiser.js';

function citation(quote: string, itemId = 'item-1'): PositionCitation {
  return { item_id: itemId, quote, start_ms: null, post_url: null, posted_at: null };
}

function position(slug: string, statement: string, quotes: string[]): BuiltPosition {
  return {
    slug,
    statement,
    held_since: '2025-01-01',
    held_until: '2025-01-01',
    days_spanned: 0,
    item_count: quotes.length,
    confidence: 'moderate',
    citations: quotes.map((quote, index) => citation(quote, `item-${slug}-${index}`)),
  };
}

// The exact case #334 was opened on: a real quote that does not carry the claim beside it.
const JAGGED_STATEMENT = 'AI progress is jagged; bottlenecks and reverse salients shape advancement.';
const JAGGED_QUOTE =
  "even if AI becomes superhuman at analysis and PowerPoint, I don't think that means AI " +
  'necessarily replaces the jobs of consultants and designers.';

describe('the digest the judge is shown', () => {
  it('carries one block per position — its slug, its statement, and its own quotes only', () => {
    const digest = supportDigest([position('mollick-jagged', JAGGED_STATEMENT, [JAGGED_QUOTE])]);

    assert.match(digest, /^\[mollick-jagged\] AI progress is jagged/);
    assert.match(digest, /quote: "even if AI becomes superhuman/);
  });

  it('caps how many of a position’s citations are shown, so one heavily-cited position cannot dominate a batch', () => {
    const quotes = Array.from({ length: MAX_QUOTES_SHOWN + 5 }, (_, index) => `quote number ${index}`);
    const digest = supportDigest([position('many-quotes', 'A position cited many times.', quotes)]);

    const shown = [...digest.matchAll(/quote: "/g)].length;
    assert.equal(shown, MAX_QUOTES_SHOWN);
  });

  it('bounds how much of one quote the judge reads, the same way a revision pair does', () => {
    const long = 'x'.repeat(SUPPORT_QUOTE_MAX_CHARS + 200);
    const digest = supportDigest([position('long-quote', 'A statement.', [long])]);

    const match = /quote: "(x+)"/.exec(digest);
    assert.ok(match, 'the quote should appear, truncated');
    assert.equal(match![1]!.length, SUPPORT_QUOTE_MAX_CHARS);
  });
});

describe('judging them', () => {
  it('sends every position and reads back which ones hold up', async () => {
    const synthesiser = fakeSynthesiser({
      supportFor: (slugs) =>
        slugs.map((slug) => ({
          slug,
          supported: slug !== 'mollick-jagged',
          rationale:
            slug === 'mollick-jagged'
              ? 'The quote says AI may not replace consultants and designers, not that progress is jagged.'
              : 'The quote states the claim.',
        })),
    });

    const found = await judgeStatementSupport(
      [
        position('mollick-jagged', JAGGED_STATEMENT, [JAGGED_QUOTE]),
        position('other', 'A different, well-supported claim.', ['the words that actually carry it']),
      ],
      synthesiser,
    );

    assert.equal(found.judged, 2);
    assert.equal(found.verdicts.get('mollick-jagged')!.supported, false);
    assert.match(found.verdicts.get('mollick-jagged')!.rationale, /not that progress is jagged/);
    assert.equal(found.verdicts.get('other')!.supported, true);
  });

  it('batches so one compile with many new positions costs a bounded number of calls', async () => {
    const synthesiser = fakeSynthesiser();
    const positions = Array.from({ length: SUPPORT_BATCH * 2 + 3 }, (_, index) =>
      position(`position-${index}`, `Statement number ${index}.`, [`quote number ${index}`]),
    );

    await judgeStatementSupport(positions, synthesiser);

    const calls = synthesiser.calls.filter((call) => call.kind === 'support');
    assert.equal(calls.length, 3); // ceil(23 / 10)
    assert.equal(slugsFromDigest(calls[0]!.digest).length, SUPPORT_BATCH);
    assert.equal(slugsFromDigest(calls[2]!.digest).length, 3);
  });

  it('drops a verdict on a slug this call never sent, the same rule a revision pair follows', async () => {
    const synthesiser = fakeSynthesiser({
      supportFor: (slugs) => [
        { slug: slugs[0]!, supported: true, rationale: 'Fine.' },
        { slug: 'position-that-was-never-sent', supported: false, rationale: 'Invented.' },
      ],
    });

    const found = await judgeStatementSupport([position('real', 'A statement.', ['a quote'])], synthesiser);

    assert.equal(found.dropped_unknown, 1);
    assert.equal(found.verdicts.size, 1);
    assert.ok(found.verdicts.has('real'));
  });
});


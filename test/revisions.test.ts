/**
 * Revisions, without a database or a model.
 *
 * Everything here is about the restraint rather than the mechanism. The mechanism is a
 * neighbourhood search and a model call; what the tests are for is the set of things
 * braintrust refuses to do with them — pair a position with itself, order two positions
 * it cannot date, record a judgement on a pair it never sent, or let a judge take a view
 * off the record without saying why.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  compileRevisions,
  cosine,
  daysBetween,
  JUDGE_BATCH,
  MAX_CANDIDATES,
  neighbourhood,
  NEIGHBOUR_FLOOR,
  pairDigest,
  type RevisionCandidate,
} from '../src/compile/revisions.js';
import { REVISION_PROMPT, type JudgedPair } from '../src/compile/synthesis.js';
import type { BuiltPosition, ClaimRef } from '../src/compile/positions.js';
import { fakeSynthesiser } from './support/synthesiser.js';
import { fakeEmbedder } from './support/embeddings.js';

/** A unit vector at `angle` radians. Two of them have a cosine of the angle between them. */
function unit(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle)];
}

/** Far enough apart to clear the floor, and near enough to be the same neighbourhood. */
const CLOSE = Math.acos(0.9);
const FAR = Math.acos(0.2);

function position(slug: string, held: string | null): BuiltPosition {
  return {
    slug,
    statement: `What ${slug} says.`,
    held_since: held,
    item_count: 2,
    confidence: 'moderate',
    citations: [],
  };
}

function claim(ref: string, statement: string, published: string | null): ClaimRef {
  return {
    ref,
    item_id: `item-${ref}`,
    external_id: `post-${ref}`,
    published_at: published,
    claim: { statement, quote: `they actually wrote ${statement}`, chunk_id: null, start_ms: null },
  };
}

/** Positions, their claims, and a vector per claim statement — what the search is handed. */
function corpus(
  entries: { slug: string; held: string | null; claims: [string, number][] }[],
): {
  positions: BuiltPosition[];
  claims: Map<string, ClaimRef[]>;
  vectors: Map<string, number[]>;
} {
  const positions = entries.map((entry) => position(entry.slug, entry.held));
  const claims = new Map<string, ClaimRef[]>();
  const vectors = new Map<string, number[]>();

  for (const entry of entries) {
    const refs = entry.claims.map(([statement], index) =>
      claim(`c-${entry.slug}-${index}`, statement, entry.held),
    );
    claims.set(entry.slug, refs);
    entry.claims.forEach(([statement, angle]) => vectors.set(statement, unit(angle)));
  }

  return { positions, claims, vectors };
}

describe('finding the pairs worth judging', () => {
  it('never pairs a position with itself, however near its own claims are', () => {
    const { positions, claims, vectors } = corpus([
      { slug: 'one', held: '2025-01-01', claims: [['a', 0], ['b', 0]] },
    ]);

    assert.deepEqual(neighbourhood(positions, claims, vectors).candidates, []);
  });

  it('keeps one candidate per pair of positions, represented by its nearest claims', () => {
    const { positions, claims, vectors } = corpus([
      { slug: 'earlier', held: '2025-01-01', claims: [['a', 0], ['b', 2]] },
      { slug: 'later', held: '2025-03-01', claims: [['c', CLOSE], ['d', 2 + Math.acos(0.7)]] },
    ]);

    const { candidates: found } = neighbourhood(positions, claims, vectors);

    // Four claim pairs cross the two positions and two of them are above the floor; the
    // question braintrust asks is about the positions, so it asks it once, about the
    // nearest pair of claims it found.
    assert.equal(found.length, 1);
    assert.equal(found[0]!.earlier.claim.statement, 'a');
    assert.equal(found[0]!.later.claim.statement, 'c');
    assert.ok(found[0]!.similarity > 0.89);
  });

  it('leaves alone two positions that are merely written in the same register', () => {
    const { positions, claims, vectors } = corpus([
      { slug: 'earlier', held: '2025-01-01', claims: [['a', 0]] },
      { slug: 'later', held: '2025-03-01', claims: [['c', FAR]] },
    ]);

    assert.deepEqual(neighbourhood(positions, claims, vectors).candidates, []);
  });

  it('orders every pair from the earlier position to the later, whichever way it arrives', () => {
    const entries: { slug: string; held: string | null; claims: [string, number][] }[] = [
      { slug: 'newer', held: '2025-06-01', claims: [['a', 0]] },
      { slug: 'older', held: '2025-01-01', claims: [['c', CLOSE]] },
    ];

    for (const order of [entries, [...entries].reverse()]) {
      const { positions, claims, vectors } = corpus(order);
      const [found] = neighbourhood(positions, claims, vectors).candidates;

      assert.equal(found!.from, 'older');
      assert.equal(found!.to, 'newer');
      assert.equal(found!.gap_days, 151);
    }
  });

  it('drops a pair it cannot place in time rather than guessing which came first', () => {
    for (const held of [null, '2025-01-01']) {
      const { positions, claims, vectors } = corpus([
        { slug: 'one', held: '2025-01-01', claims: [['a', 0]] },
        { slug: 'other', held, claims: [['c', CLOSE]] },
      ]);

      assert.deepEqual(
        neighbourhood(positions, claims, vectors).candidates,
        [],
        `a pair held_since ${held} should not be ordered`,
      );
    }
  });

  it('numbers the pairs best neighbour first, so a bounded compile judges the nearest ones', () => {
    const { positions, claims, vectors } = corpus([
      { slug: 'a-oldest', held: '2025-01-01', claims: [['a', 0]] },
      { slug: 'b-middle', held: '2025-02-01', claims: [['b', Math.acos(0.95)]] },
      { slug: 'c-newest', held: '2025-03-01', claims: [['c', Math.acos(0.65)]] },
    ]);

    const { candidates: found } = neighbourhood(positions, claims, vectors);

    assert.deepEqual(
      found.map((one) => one.ref),
      ['p1', 'p2', 'p3'],
    );
    assert.ok(found[0]!.similarity > found[1]!.similarity);
    assert.ok(found[1]!.similarity > found[2]!.similarity);
  });

  it('bounds how many pairs one compile will pay to have judged', () => {
    // Every position near every other, which is a corpus about wording rather than a
    // person in crisis — and the shape that would otherwise cost thousands of calls.
    const entries = Array.from({ length: 20 }, (_, index) => ({
      slug: `position-${String(index).padStart(2, '0')}`,
      held: `2025-01-${String(index + 1).padStart(2, '0')}`,
      claims: [[`claim-${index}`, index * 0.001] as [string, number]],
    }));

    const { positions, claims, vectors } = corpus(entries);
    const { candidates: found, bounded_out } = neighbourhood(positions, claims, vectors);

    assert.equal(found.length, MAX_CANDIDATES);
    assert.equal(found.at(-1)!.ref, `p${MAX_CANDIDATES}`);
    // Twenty positions make 190 pairs. What the bound did not reach is counted rather
    // than dropped quietly: a limit nobody is told about reads as coverage.
    assert.equal(bounded_out, 190 - MAX_CANDIDATES);
  });

  it('carries the floor it was tuned to into every answer', async () => {
    const { positions, claims } = corpus([
      { slug: 'one', held: '2025-01-01', claims: [['a', 0]] },
      { slug: 'other', held: '2025-02-01', claims: [['b', 0]] },
    ]);

    const found = await compileRevisions(positions, claims, {
      embedder: fakeEmbedder(),
      synthesiser: fakeSynthesiser(),
    });

    // Reported rather than assumed: the number is a property of the configured
    // embeddings model, so a compile says which one it applied.
    assert.equal(found.floor, NEIGHBOUR_FLOOR);
    assert.ok(NEIGHBOUR_FLOOR > 0 && NEIGHBOUR_FLOOR < 1);
  });
});

describe('judging them', () => {
  // Real statements rather than letters, because the fake embedder is a bag of words:
  // these two share four of their six long words, which is what a narrowing looks like
  // from a vector space — near enough to ask about, not near enough to be the same claim.
  const entries: { slug: string; held: string | null; claims: [string, number][] }[] = [
    { slug: 'earlier', held: '2025-01-01', claims: [['evals come before the harness in every case', 0]] },
    { slug: 'later', held: '2025-07-01', claims: [['evals come before the harness only sometimes', CLOSE]] },
  ];

  function judged(judgementsFor: (pairs: string[]) => JudgedPair[]) {
    const { positions, claims } = corpus(entries);
    const synthesiser = fakeSynthesiser({ judgementsFor });
    // The fake embedder is a bag of words, so two statements sharing "first" and "comes"
    // land in one neighbourhood, as a real endpoint would put them.
    return { synthesiser, run: () => compileRevisions(positions, claims, { embedder: fakeEmbedder(), synthesiser }) };
  }

  it('records nothing for the pairs a judge dismisses, which is most of them', async () => {
    const { run } = judged((pairs) =>
      pairs.map((pair) => ({ pair, relation: 'none' as const, rationale: 'The same thing twice.' })),
    );

    const found = await run();

    assert.deepEqual(found.revisions, []);
    assert.equal(found.dismissed, found.candidates);
    assert.ok(found.candidates > 0, 'the pair should have reached the judge');
  });

  it('writes the relation with the gap and the rationale a reader is shown', async () => {
    const { run } = judged((pairs) =>
      pairs.map((pair) => ({
        pair,
        relation: 'revised' as const,
        rationale: 'They say the harness now comes first, having argued the opposite in January.',
      })),
    );

    const found = await run();

    assert.equal(found.revisions.length, 1);
    assert.equal(found.revisions[0]!.from, 'earlier');
    assert.equal(found.revisions[0]!.to, 'later');
    assert.equal(found.revisions[0]!.relation, 'revised');
    assert.equal(found.revisions[0]!.gap_days, 181);
    assert.match(found.revisions[0]!.rationale, /having argued the opposite/);
  });

  it('drops a judgement on a pair braintrust never sent', async () => {
    const { run } = judged((pairs) => [
      { pair: pairs[0]!, relation: 'unsettled', rationale: 'Both still held.' },
      { pair: 'p9999', relation: 'revised', rationale: 'On a pair that does not exist.' },
    ]);

    const found = await run();

    assert.equal(found.revisions.length, 1);
    assert.equal(found.revisions[0]!.relation, 'unsettled');
    assert.equal(found.dropped_unknown, 1);
  });

  it('takes the first judgement on a pair and ignores a second', async () => {
    const { run } = judged((pairs) => [
      { pair: pairs[0]!, relation: 'drifting', rationale: 'The emphasis moved.' },
      { pair: pairs[0]!, relation: 'revised', rationale: 'And then it did not.' },
    ]);

    const found = await run();

    assert.equal(found.revisions.length, 1);
    assert.equal(found.revisions[0]!.relation, 'drifting');
    assert.equal(found.dropped_unknown, 1);
  });

  it('embeds the claim statements rather than the statements a model wrote', async () => {
    const embedder = fakeEmbedder();
    const { positions, claims } = corpus(entries);

    await compileRevisions(positions, claims, { embedder, synthesiser: fakeSynthesiser() });

    const embedded = embedder.batches.flat();
    assert.deepEqual(embedded.sort(), [
      'evals come before the harness in every case',
      'evals come before the harness only sometimes',
    ]);
    // A position's statement is a model's sentence about the claims. Comparing two of
    // those would be comparing two summaries and calling the result a change of mind.
    assert.ok(!embedded.some((one) => one.startsWith('What ')));
  });

  it('has nowhere to store a vector, so a compile cannot leave one behind', async () => {
    const source = await readFile(new URL('../src/compile/revisions.ts', import.meta.url), 'utf8');

    // The spec's own constraint: claim vectors are computed during a compile and thrown
    // away, so the embeddings table keeps its key and no table is added. Enforced by this
    // module having no database to write to rather than by remembering not to.
    assert.doesNotMatch(source, /\bdb\b|TransactionalDb|insert into/);
  });

  it('asks about few pairs at a time, so each is read next to few others', async () => {
    const entries = Array.from({ length: JUDGE_BATCH * 2 }, (_, index) => ({
      slug: `position-${String(index).padStart(2, '0')}`,
      held: `2025-01-${String(index + 1).padStart(2, '0')}`,
      claims: [[`the same claim about evals ${index}`, 0] as [string, number]],
    }));

    const { positions, claims } = corpus(entries);
    const synthesiser = fakeSynthesiser();
    const found = await compileRevisions(positions, claims, {
      embedder: fakeEmbedder(),
      synthesiser,
    });

    const calls = synthesiser.calls.filter((call) => call.kind === 'revisions');
    assert.ok(found.candidates > JUDGE_BATCH, 'this corpus should produce more than one batch');
    assert.equal(calls.length, Math.ceil(found.candidates / JUDGE_BATCH));
    for (const call of calls) {
      assert.ok(call.digest.match(/^\[p\d+\]/gm)!.length <= JUDGE_BATCH);
    }
  });

  it('asks nothing at all of a persona with one position', async () => {
    const { positions, claims } = corpus([{ slug: 'only', held: '2025-01-01', claims: [['a', 0]] }]);
    const synthesiser = fakeSynthesiser();

    const found = await compileRevisions(positions, claims, {
      embedder: fakeEmbedder(),
      synthesiser,
    });

    assert.deepEqual(found.revisions, []);
    assert.equal(synthesiser.calls.length, 0);
  });
});

describe('what the judge is shown', () => {
  const candidate: RevisionCandidate = {
    ref: 'p1',
    from: 'evals-come-first',
    to: 'the-harness-comes-first',
    similarity: 0.81,
    gap_days: 181,
    earlier: claim('c1', 'Evals come before the harness.', '2025-01-01'),
    later: claim('c2', 'The harness is what makes an eval mean anything.', '2025-07-01'),
  };

  it('carries both positions, both dates and the gap between them', () => {
    const digest = pairDigest([candidate]);

    assert.match(digest, /^\[p1\] 181 days apart$/m);
    assert.match(digest, /earlier — 2025-01-01 · evals-come-first/);
    assert.match(digest, /later — 2025-07-01 · the-harness-comes-first/);
  });

  it("carries the person's own words, because that is what revised is defined by", () => {
    const digest = pairDigest([candidate]);

    // `revised` requires a change a reader would accept as explicit — in the person's own
    // words. A judge shown only braintrust's summaries would be grading summaries.
    assert.match(digest, /they wrote: "they actually wrote Evals come before the harness\."/);
    assert.match(digest, /claim: Evals come before the harness\./);
  });
});

describe('the instruction the judge is given', () => {
  it('offers all four answers, and none is a score', () => {
    for (const relation of ['revised', 'unsettled', 'drifting', 'none']) {
      assert.match(REVISION_PROMPT, new RegExp(`\\b${relation}\\b`));
    }
  });

  it('says which way to fall when the call is close', () => {
    // The asymmetry is the whole design: three of the four labels cost nothing if wrong,
    // and the fourth puts a contradiction on a real person's record.
    assert.match(REVISION_PROMPT, /weighing revised against unsettled,\n?\s*answer unsettled/);
    assert.match(REVISION_PROMPT, /Most pairs are none/);
  });
});

describe('the two numbers a reader is shown', () => {
  it('counts the gap in whole days, across a month and a year', () => {
    assert.equal(daysBetween('2025-01-01', '2025-01-02'), 1);
    assert.equal(daysBetween('2025-01-01', '2026-01-01'), 365);
    assert.equal(daysBetween('2025-01-01', '2025-01-01'), 0);
  });

  it('measures similarity without assuming an endpoint normalised anything', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([2, 0], [7, 0]), 1);
    assert.equal(Math.round(cosine([1, 0], [0, 1]) * 1000), 0);
    assert.equal(cosine([0, 0], [1, 0]), 0);
  });
});

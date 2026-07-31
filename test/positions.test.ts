/**
 * Positions — the half of a Persona that grows with the Corpus.
 *
 * The property this file exists for: **a Position is a grouping of claims braintrust
 * already verified**, so the model is handed refs it may only copy back, every citation
 * carries a quote that was located in the stored body when the Item was read, and a
 * grouping that resolves to nothing braintrust issued is dropped rather than published.
 *
 * The rest is what travels with a Position and why — `held_since` recomputed from the
 * citations every time, `item_count` as the denominator a reader judges it on, and a
 * confidence grade that never filters anything.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  buildPositions,
  claimDigest,
  claimIndex,
  claimPasses,
  compilePositions,
  confidenceFor,
  CONFIDENCE_HIGH_ITEMS,
  positionMergeDigest,
  slugify,
} from '../src/compile/positions.js';
import { MAX_POSITIONS, readClusterContent } from '../src/compile/synthesis.js';
import type { StoredNote } from '../src/notes/store.js';
import { fakeSynthesiser, refsFromDigest } from './support/synthesiser.js';

function note(externalId: string, overrides: Partial<StoredNote> = {}): StoredNote {
  return {
    item_id: `id-${externalId}`,
    external_id: externalId,
    title: `About ${externalId}`,
    published_at: '2025-06-01',
    claims: [
      {
        statement: 'Speed is not the constraint.',
        quote: 'speed is not the constraint',
        chunk_id: 'chunk-1',
        start_ms: 12_000,
      },
      {
        statement: 'Judgement about what to build is scarce.',
        quote: 'knowing which of the twenty things is worth doing',
        chunk_id: 'chunk-2',
        start_ms: null,
      },
    ],
    argument_md: 'Starts from the constraint and lands on judgement.',
    assumptions: [],
    ...overrides,
  };
}

const NOTES = ['a1', 'b2', 'c3'].map((id) => note(id));

describe('the claim digest a clustering pass reads', () => {
  it('numbers every claim in the corpus, so a ref braintrust never issued is detectable', () => {
    const refs = claimIndex(NOTES);

    assert.equal(refs.length, 6);
    assert.deepEqual(
      refs.map((ref) => ref.ref),
      ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
    );
    // Sequential across the whole corpus rather than per note or per pass — a ref is
    // unique whichever pass it was shown in.
    assert.equal(new Set(refs.map((ref) => ref.ref)).size, 6);
  });

  it('carries the ref, the date and the item, and never the quote', () => {
    const line = claimDigest(claimIndex(NOTES)[0]!);

    assert.match(line, /^\[c1\] 2025-06-01 a1 — Speed is not the constraint\./);
    // The quote is evidence, not input: showing it invites a model to edit it back.
    assert.doesNotMatch(line, /speed is not the constraint$/);
  });

  it('folds a corpus too large for one call along its own timeline', () => {
    const many = Array.from({ length: 300 }, (_unused, index) => note(`post-${index}`));
    const passes = claimPasses(claimIndex(many), 800);

    assert.ok(passes.length > 1);

    const lines = passes.flatMap((pass) => pass.split('\n'));
    assert.equal(lines.length, 600, 'every claim appears exactly once across the passes');
    assert.match(lines[0]!, /^\[c1\]/);
    assert.match(lines.at(-1)!, /^\[c600\]/);
  });
});

describe('building positions from what the model grouped', () => {
  const refs = claimIndex(NOTES);

  it('cites the claim braintrust verified, never a quote the model wrote', () => {
    const { positions } = buildPositions(
      [{ slug: 'speed-is-not-the-constraint', statement: 'Speed is never the constraint.', claims: ['c1', 'c3'] }],
      refs,
    );

    assert.equal(positions.length, 1);
    assert.deepEqual(
      positions[0]!.citations.map((citation) => citation.quote),
      ['speed is not the constraint', 'speed is not the constraint'],
    );
    assert.deepEqual(
      positions[0]!.citations.map((citation) => citation.item_id),
      ['id-a1', 'id-b2'],
    );
    assert.equal(positions[0]!.citations[0]!.start_ms, 12_000);
  });

  it('drops a grouping that resolves to no claim braintrust issued, and counts it', () => {
    const { positions, dropped } = buildPositions(
      [
        { slug: 'real', statement: 'Rests on a claim that exists.', claims: ['c2'] },
        { slug: 'invented', statement: 'Rests on nothing braintrust handed over.', claims: ['c99', 'c400'] },
      ],
      refs,
    );

    assert.deepEqual(
      positions.map((position) => position.slug),
      ['real'],
    );
    assert.equal(dropped, 1);
  });

  it('keeps the claims it can and drops only the refs it cannot', () => {
    const { positions, dropped } = buildPositions(
      [{ slug: 'partly-real', statement: 'One real ref among invented ones.', claims: ['c1', 'c99'] }],
      refs,
    );

    assert.equal(dropped, 0);
    assert.equal(positions[0]!.citations.length, 1);
    assert.equal(positions[0]!.item_count, 1);
  });

  it('counts items rather than claims, so quoting one item twice does not inflate it', () => {
    const { positions } = buildPositions(
      [{ slug: 'one-item', statement: 'Both claims come from the same item.', claims: ['c1', 'c2'] }],
      refs,
    );

    assert.equal(positions[0]!.item_count, 1);
    assert.equal(positions[0]!.citations.length, 2, 'both quotes are still evidence');
    assert.equal(positions[0]!.confidence, 'low');
  });

  it('collapses two claims that quote the same words in the same item to one citation', () => {
    const twice = [
      note('d4', {
        claims: [
          { statement: 'Said once.', quote: 'the same words', chunk_id: 'chunk-1', start_ms: null },
          { statement: 'Said again, differently.', quote: 'the same words', chunk_id: 'chunk-1', start_ms: null },
        ],
      }),
    ];

    const { positions } = buildPositions(
      [{ slug: 'once', statement: 'One quote, twice.', claims: ['c1', 'c2'] }],
      claimIndex(twice),
    );

    assert.equal(positions[0]!.citations.length, 1);
  });

  it('recomputes held_since from the citations, so older evidence moves it earlier', () => {
    const dated = [
      note('new', { published_at: '2026-03-11' }),
      note('old', { published_at: '2024-01-09' }),
    ];

    const { positions } = buildPositions(
      [{ slug: 'held', statement: 'Held for a while.', claims: ['c1', 'c3'] }],
      claimIndex(dated),
    );

    assert.equal(positions[0]!.held_since, '2024-01-09');
  });

  it('leaves held_since null rather than guessing when every cited item is undated', () => {
    const { positions } = buildPositions(
      [{ slug: 'undated', statement: 'No date to be had.', claims: ['c1'] }],
      claimIndex([note('u1', { published_at: null })]),
    );

    assert.equal(positions[0]!.held_since, null);
  });

  it('gives two groupings that slugify the same way distinct slugs', () => {
    const { positions } = buildPositions(
      [
        { slug: 'Evals Precede The Harness', statement: 'First.', claims: ['c1'] },
        { slug: 'evals-precede-the-harness', statement: 'Second, on the same ground.', claims: ['c3'] },
      ],
      refs,
    );

    assert.deepEqual(
      positions.map((position) => position.slug),
      ['evals-precede-the-harness', 'evals-precede-the-harness-2'],
    );
  });

  it('falls back to the statement when a model returns a slug that slugifies to nothing', () => {
    const { positions } = buildPositions(
      [{ slug: '???', statement: 'Evals precede the harness.', claims: ['c1'] }],
      refs,
    );

    assert.equal(positions[0]!.slug, 'evals-precede-the-harness');
  });
});

describe('the confidence grade', () => {
  it('is a function of the item count and nothing else', () => {
    assert.equal(confidenceFor(1), 'low');
    assert.equal(confidenceFor(2), 'moderate');
    assert.equal(confidenceFor(CONFIDENCE_HIGH_ITEMS), 'high');
    assert.equal(confidenceFor(CONFIDENCE_HIGH_ITEMS + 40), 'high');
  });

  it('never removes a position — a thin one is returned graded, not hidden', async () => {
    const single = [note('only')];
    const set = await compilePositions(
      single,
      fakeSynthesiser({
        positionsFor: (claims) => [
          { slug: 'said-once', statement: 'Said exactly once.', claims: [claims[0]!] },
        ],
      }),
    );

    assert.equal(set.positions.length, 1);
    assert.equal(set.positions[0]!.confidence, 'low');
    assert.equal(set.positions[0]!.item_count, 1);
  });
});

describe('compiling the growing layer', () => {
  it('sends one pass for a corpus that fits, and no merge', async () => {
    const synthesiser = fakeSynthesiser();
    const set = await compilePositions(NOTES, synthesiser);

    assert.equal(set.passes, 1);
    assert.equal(set.merged, false);
    assert.equal(set.claims_read, 6);
    assert.equal(set.clusterer, 'test-model@positions-1');
    assert.deepEqual(
      synthesiser.calls.map((call) => call.mode),
      ['pass'],
    );
  });

  it('merges across passes, and checks citability after the merge rather than before', async () => {
    // Large enough to fold, so the merge is the last thing that touches the refs.
    const many = Array.from({ length: 4_000 }, (_unused, index) => note(`post-${index}`));

    const synthesiser = fakeSynthesiser({
      positionsFor: (claims, mode) =>
        mode === 'merge'
          ? [
              { slug: 'merged', statement: 'Survives the merge.', claims: [claims[0]!] },
              { slug: 'invented-by-the-merge', statement: 'A ref that was never issued.', claims: ['c999999'] },
            ]
          : [{ slug: 'from-a-pass', statement: 'Found in one pass.', claims: claims.slice(0, 3) }],
    });

    const set = await compilePositions(many, synthesiser);

    assert.ok(set.passes > 1);
    assert.equal(set.merged, true);
    assert.deepEqual(
      set.positions.map((position) => position.slug),
      ['merged'],
    );
    assert.equal(set.dropped_uncitable, 1, 'a ref the merge invented is caught by the same rule');
  });

  it('bounds a pass but not the layer, because positions grow with the corpus', async () => {
    const many = Array.from({ length: 4_000 }, (_unused, index) => note(`post-${index}`));

    const synthesiser = fakeSynthesiser({
      // A model ignoring the cap, every pass.
      positionsFor: (claims, mode) =>
        mode === 'merge'
          ? claims.map((claim, index) => ({
              slug: `merged-${index}`,
              statement: 'One of many.',
              claims: [claim],
            }))
          : claims.slice(0, MAX_POSITIONS + 20).map((claim, index) => ({
              slug: `pass-${index}`,
              statement: 'One of many.',
              claims: [claim],
            })),
    });

    const set = await compilePositions(many, synthesiser);
    const passes = synthesiser.calls.filter((call) => call.mode === 'pass').length;

    const handed = (JSON.parse(synthesiser.calls.at(-1)!.digest) as { positions: unknown[] }).positions;
    assert.equal(handed.length, passes * MAX_POSITIONS, 'each pass is trimmed to the per-call bound');
    // …and the layer itself is allowed to be larger than one call's worth.
    assert.ok(set.positions.length > MAX_POSITIONS);
  });

  it('hands the merge the passes own output and nothing else', async () => {
    const digest = positionMergeDigest([
      { slug: 'one', statement: 'First.', claims: ['c1'] },
      { slug: 'two', statement: 'Second.', claims: ['c2'] },
    ]);

    assert.deepEqual(refsFromDigest(digest), []);
    assert.deepEqual(JSON.parse(digest), {
      positions: [
        { slug: 'one', statement: 'First.', claims: ['c1'] },
        { slug: 'two', statement: 'Second.', claims: ['c2'] },
      ],
    });
  });

  it('lets an endpoint failure fail the compile rather than publishing a persona without positions', async () => {
    await assert.rejects(
      compilePositions(NOTES, fakeSynthesiser({ throws: new Error('connect ECONNREFUSED') })),
      /ECONNREFUSED/,
    );
  });

  it('produces nothing from notes that carry no claims, without calling the model twice', async () => {
    const claimless = [note('empty', { claims: [] })];
    const synthesiser = fakeSynthesiser();
    const set = await compilePositions(claimless, synthesiser);

    assert.deepEqual(set.positions, []);
    assert.equal(set.claims_read, 0);
    assert.equal(synthesiser.calls.length, 0, 'nothing to group is not a question worth asking');
  });
});

describe('reading what the clusterer answered', () => {
  const url = 'https://models.test/v1/chat/completions';

  it('accepts a fenced block, because models wrap JSON in one', () => {
    const positions = readClusterContent(
      '```json\n{"positions":[{"slug":"a","statement":"A.","claims":["c1"]}]}\n```',
      url,
    );

    assert.equal(positions.length, 1);
    assert.equal(positions[0]!.slug, 'a');
  });

  it('drops a position with no slug or no statement rather than storing it half-formed', () => {
    const positions = readClusterContent(
      JSON.stringify({
        positions: [
          { slug: 'kept', statement: 'Whole.', claims: ['c1'] },
          { slug: '', statement: 'No slug.', claims: ['c2'] },
          { slug: 'no-statement', statement: '   ', claims: ['c3'] },
        ],
      }),
      url,
    );

    assert.deepEqual(
      positions.map((position) => position.slug),
      ['kept'],
    );
  });

  it('treats an empty positions array as an answer and a missing one as a wrong question', () => {
    assert.deepEqual(readClusterContent('{"positions":[]}', url), []);

    // The same live-found lesson as the core: a wrongly-shaped answer that arrives as an
    // empty layer sends whoever reads it to the corpus instead of to the endpoint.
    assert.throws(
      () => readClusterContent('{"entries":[{"label":"wrong shape","body":"b","items":[]}]}', url),
      /no positions array/,
    );
  });

  it('does not cap what a merge may return, because the fold is where that belongs', () => {
    const many = Array.from({ length: MAX_POSITIONS + 10 }, (_unused, index) => ({
      slug: `p-${index}`,
      statement: 'One of many.',
      claims: ['c1'],
    }));

    assert.equal(readClusterContent(JSON.stringify({ positions: many }), url).length, many.length);
  });
});

describe('slugs', () => {
  it('are kebab-case, bounded, and never end in a dash', () => {
    assert.equal(slugify('Evals Precede the Harness'), 'evals-precede-the-harness');
    assert.equal(slugify("Don't ship the agent"), 'dont-ship-the-agent');
    assert.equal(slugify('  spaced  out  '), 'spaced-out');
    assert.doesNotMatch(slugify('a'.repeat(200)), /-$/);
    assert.ok(slugify('a'.repeat(200)).length <= 60);
  });
});

describe('what the clustering prompt is allowed to do', () => {
  it('asks a model to group claims and never to write a quote', async () => {
    const source = await readFile(new URL('../src/compile/positions.ts', import.meta.url), 'utf8');

    // The quote on a citation is copied off the verified claim, not taken from the model.
    assert.match(source, /quote: ref\.claim\.quote/);
    assert.doesNotMatch(source, /cluster\.quote|position\.quote/);
  });
});

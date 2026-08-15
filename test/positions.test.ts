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
  BURST_WINDOW_DAYS,
  buildPositions,
  claimDigest,
  claimIndex,
  claimPasses,
  compilePositions,
  confidenceFor,
  CONFIDENCE_HIGH_ITEMS,
  CONFIDENCE_MODERATE_ITEMS,
  deserializePositionSet,
  serializePositionSet,
  slugify,
} from '../src/compile/positions.js';
import { MAX_POSITIONS, readClusterContent, readGroupContent } from '../src/compile/synthesis.js';
import type { StoredNote } from '../src/notes/store.js';
import { fakeSynthesiser, indicesFromDigest, refsFromDigest } from './support/synthesiser.js';

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
  /** Long enough that nothing here trips the burst cap; the cap has its own tests. */
  const SUSTAINED = BURST_WINDOW_DAYS + 1;

  it('is a function of the item count, and the thresholds did not move', () => {
    assert.equal(confidenceFor(1, SUSTAINED), 'low');
    assert.equal(confidenceFor(2, SUSTAINED), 'moderate');
    assert.equal(confidenceFor(CONFIDENCE_HIGH_ITEMS, SUSTAINED), 'high');
    assert.equal(confidenceFor(CONFIDENCE_HIGH_ITEMS + 40, SUSTAINED), 'high');
  });

  it('caps at moderate when every citation falls inside one week', () => {
    // Five separate pieces of work is the same signal however much someone publishes —
    // but five of them inside a week are one occasion wearing five dates.
    assert.equal(confidenceFor(CONFIDENCE_HIGH_ITEMS, 0), 'moderate');
    assert.equal(confidenceFor(CONFIDENCE_HIGH_ITEMS, BURST_WINDOW_DAYS), 'moderate');
    assert.equal(confidenceFor(CONFIDENCE_HIGH_ITEMS, BURST_WINDOW_DAYS + 1), 'high');

    // A ceiling, not a retune: nothing below `high` is touched, so a two-item position
    // published on one afternoon still grades exactly what it graded before.
    assert.equal(confidenceFor(CONFIDENCE_MODERATE_ITEMS, 0), 'moderate');
    assert.equal(confidenceFor(1, 0), 'low');
  });

  it('cannot cap what it cannot date, and says so rather than defaulting either way', () => {
    // The same rule that has revisions refuse to judge a pair they cannot place in time:
    // braintrust does not penalise what it cannot measure, it declines to claim it.
    assert.equal(confidenceFor(CONFIDENCE_HIGH_ITEMS, null), 'high');
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
    assert.equal(set.clusterer, 'test-model@positions-2');
    assert.deepEqual(
      synthesiser.calls.map((call) => call.mode),
      ['pass'],
    );
  });

  it('merges across passes, and checks citability on the refs braintrust unioned', async () => {
    // Large enough to fold, so a merge happens at all.
    const many = Array.from({ length: 4_000 }, (_unused, index) => note(`post-${index}`));

    const synthesiser = fakeSynthesiser({
      positionsFor: (claims) => [
        { slug: 'from-a-pass', statement: 'Found in one pass.', claims: claims.slice(0, 3) },
        // A ref no pass was given. It is dropped by the same rule as ever — but now that
        // rule runs on refs braintrust unioned itself, because the merge is never shown one.
        { slug: 'never-issued', statement: 'Cites a claim braintrust did not extract.', claims: ['c999999'] },
      ],
      groupsFor: (indices) => [{ members: indices.slice(0, 2), clearest: indices[0]! }],
    });

    const set = await compilePositions(many, synthesiser);

    assert.ok(set.passes > 1);
    assert.equal(set.merged, true);
    assert.equal(set.rounds, 1, 'the passes output fits one call, so the fold is one round');
    assert.equal(set.converged, true);
    assert.ok(set.dropped_uncitable > 0, 'a grouping resolving to no issued claim is still dropped');
    for (const position of set.positions) {
      assert.ok(position.citations.length > 0);
    }
  });

  it('bounds a pass but not the layer, because positions grow with the corpus', async () => {
    const many = Array.from({ length: 4_000 }, (_unused, index) => note(`post-${index}`));

    const synthesiser = fakeSynthesiser({
      // A model ignoring the cap, every pass.
      positionsFor: (claims) =>
        claims.slice(0, MAX_POSITIONS + 20).map((claim, index) => ({
          slug: `pass-${index}`,
          statement: 'One of many.',
          claims: [claim],
        })),
    });

    const set = await compilePositions(many, synthesiser);
    const passes = synthesiser.calls.filter((call) => call.mode === 'pass').length;
    const handed = indicesFromDigest(synthesiser.calls.at(-1)!.digest);

    assert.equal(handed.length, passes * MAX_POSITIONS, 'each pass is trimmed to the per-call bound');
    // …and the layer itself is allowed to be larger than one call's worth.
    assert.ok(set.positions.length > MAX_POSITIONS);
  });

  it('hands the merge wording and indices, and never a claim braintrust issued', async () => {
    const many = Array.from({ length: 4_000 }, (_unused, index) => note(`post-${index}`));
    const synthesiser = fakeSynthesiser();

    await compilePositions(many, synthesiser);
    const merge = synthesiser.calls.filter((call) => call.mode === 'merge').at(-1)!;

    // The whole reason a merge can no longer invent a citation: it is not shown one.
    assert.deepEqual(refsFromDigest(merge.digest), []);
    assert.doesNotMatch(merge.digest, /\bc\d+\b/);
    assert.doesNotMatch(merge.digest, /speed is not the constraint/, 'no quotes either');

    // One line per entry: an index, the slug and the statement.
    assert.match(merge.digest, /^\[1\] the-constraint-is-not-speed — The constraint is never speed\.$/m);
    assert.deepEqual(
      indicesFromDigest(merge.digest),
      merge.digest.split('\n').map((_unused, index) => index + 1),
    );
  });

  /**
   * The reason the merge is not decoration. Passes are cut from disjoint slices, so a view
   * held for years is found separately by several of them, each citing only its own slice.
   * Unmerged, one Position becomes twelve that each understate what the Person argued.
   */
  it('carries the union of a groups evidence, and derives the numbers from the whole of it', async () => {
    // Dated across two years, so the span is a property of the corpus rather than of how
    // the compile happened to be sliced.
    const many = Array.from({ length: 4_000 }, (_unused, index) =>
      note(`post-${index}`, { published_at: `${2023 + (index % 3)}-06-01` }),
    );

    const synthesiser = fakeSynthesiser({
      // One position per pass, each citing only the slice its pass could see.
      positionsFor: (claims) => [
        { slug: 'this-passes-wording', statement: 'A worse way of putting it.', claims },
      ],
      // …and the merge says they are all the same view, worded best by the second.
      groupsFor: (indices) => [{ members: indices, clearest: indices[1]! }],
    });

    const set = await compilePositions(many, synthesiser);

    assert.equal(set.positions.length, 1, 'twelve wordings of one view are one position');
    const [position] = set.positions;

    // The union, not one pass's slice: every item in the corpus is behind it.
    assert.equal(position!.item_count, many.length);
    assert.equal(position!.held_since, '2023-06-01');
    assert.equal(position!.held_until, '2025-06-01');
    assert.ok(position!.days_spanned! > BURST_WINDOW_DAYS);
    assert.equal(position!.confidence, 'high', 'graded on the merged evidence, not on a slice');
  });

  it('keeps the clearest members wording word for word, and discards the others', async () => {
    const many = Array.from({ length: 4_000 }, (_unused, index) => note(`post-${index}`));
    let pass = 0;

    const synthesiser = fakeSynthesiser({
      positionsFor: (claims) => {
        pass += 1;
        return [
          {
            slug: pass === 2 ? 'the-clearest' : `pass-${pass}`,
            statement: pass === 2 ? 'The clearest way of putting it.' : `Pass ${pass} put it worse.`,
            claims: claims.slice(0, 2),
          },
        ];
      },
      groupsFor: (indices) => [{ members: indices, clearest: 2 }],
    });

    const set = await compilePositions(many, synthesiser);

    // No step of a compile rewords a persona's own output: the merge selects prose rather
    // than composing it, so what a reader reads was written by a pass that read the claims.
    assert.deepEqual(
      set.positions.map((one) => one.statement),
      ['The clearest way of putting it.'],
    );
    assert.deepEqual(
      set.positions.map((one) => one.slug),
      ['the-clearest'],
    );
  });

  it('drops an index it was never given and one it repeats, without losing the valid members', async () => {
    const many = Array.from({ length: 4_000 }, (_unused, index) => note(`post-${index}`));

    const synthesiser = fakeSynthesiser({
      positionsFor: (claims) => [
        { slug: 'from-a-pass', statement: 'Found in one pass.', claims: claims.slice(0, 2) },
      ],
      groupsFor: (indices) => [
        // 1 and 2 are real; the rest are not, and 2 is claimed again by the group below.
        { members: [indices[0]!, indices[1]!, 0, -3, indices.length + 500], clearest: indices[0]! },
        { members: [indices[1]!, indices[2]!], clearest: indices[1]! },
      ],
    });

    const set = await compilePositions(many, synthesiser);
    const passes = synthesiser.calls.filter((call) => call.mode === 'pass').length;

    // Two grouped into one, the third taken by the second group alone, and every other
    // position untouched — the invented indices cost nobody their position.
    assert.equal(set.positions.length, passes - 1);
    for (const position of set.positions) assert.ok(position.citations.length > 0);
  });

  it('folds in rounds when the indexed list will not fit, and shows round two what survived round one', async () => {
    const many = Array.from({ length: 4_000 }, (_unused, index) => note(`post-${index}`));

    const synthesiser = fakeSynthesiser({
      // Long statements, so the passes own output overflows the merge's budget.
      positionsFor: (claims) =>
        Array.from({ length: MAX_POSITIONS }, (_unused, index) => ({
          slug: `pass-position-${index}`,
          statement: `One of many, at length. ${'The same thing in different words. '.repeat(20)}`,
          claims: claims.slice(index, index + 1),
        })),
      // Every chunk collapses to one entry, so a round's survivor count is its chunk count.
      groupsFor: (indices) => [{ members: indices, clearest: indices[0]! }],
    });

    const set = await compilePositions(many, synthesiser);
    const merges = synthesiser.calls.filter((call) => call.mode === 'merge');

    assert.equal(set.rounds, 2);
    assert.equal(set.converged, true);
    assert.ok(merges.length > 2, 'round one was cut into more than one call');
    assert.deepEqual(
      indicesFromDigest(merges.at(-1)!.digest),
      merges.slice(0, -1).map((_unused, index) => index + 1),
      'round two is shown one survivor per chunk of round one, and nothing else',
    );
    assert.equal(set.positions.length, 1);
  });

  it('publishes a layer whose fold stopped shrinking, and records that it did not converge', async () => {
    const many = Array.from({ length: 4_000 }, (_unused, index) => note(`post-${index}`));

    const synthesiser = fakeSynthesiser({
      positionsFor: (claims) =>
        Array.from({ length: MAX_POSITIONS }, (_unused, index) => ({
          slug: `pass-position-${index}`,
          statement: `One of many, at length. ${'The same thing in different words. '.repeat(20)}`,
          claims: claims.slice(index, index + 1),
        })),
      // A model that merges nothing, on a list that does not fit. The fold cannot shrink it.
      groupsFor: () => [],
    });

    const set = await compilePositions(many, synthesiser);

    assert.equal(set.rounds, 1, 'a round that merged nothing ends the fold');
    assert.equal(set.converged, false);
    // A cosmetic limit never costs a reader their positions.
    assert.ok(set.positions.length > MAX_POSITIONS);
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

  it('does not cap what a pass may return, because the fold is where that belongs', () => {
    const many = Array.from({ length: MAX_POSITIONS + 10 }, (_unused, index) => ({
      slug: `p-${index}`,
      statement: 'One of many.',
      claims: ['c1'],
    }));

    assert.equal(readClusterContent(JSON.stringify({ positions: many }), url).length, many.length);
  });
});

describe('reading what the merge answered', () => {
  const url = 'https://models.test/v1/chat/completions';

  it('accepts a fenced block, like the readers either side of it', () => {
    assert.deepEqual(readGroupContent('```json\n{"groups":[{"members":[1,3],"clearest":3}]}\n```', url), [
      { members: [1, 3], clearest: 3 },
    ]);
  });

  it('treats an empty groups array as an answer and a missing one as a wrong question', () => {
    // Nothing repeating is what a good merge answers most of the time.
    assert.deepEqual(readGroupContent('{"groups":[]}', url), []);

    assert.throws(
      () => readGroupContent('{"positions":[{"slug":"a","statement":"A.","claims":[]}]}', url),
      /no groups array/,
    );
  });

  it('needs no cap of its own, because an answer is bounded by the input it names', () => {
    const many = Array.from({ length: MAX_POSITIONS + 40 }, (_unused, index) => ({
      members: [index + 1],
      clearest: index + 1,
    }));

    assert.equal(readGroupContent(JSON.stringify({ groups: many }), url).length, many.length);
  });

  it('drops a group with no usable member and repairs one with no usable clearest', () => {
    const groups = readGroupContent(
      JSON.stringify({
        groups: [
          { members: [2, 'three', 4.5], clearest: 2 },
          { members: [], clearest: 1 },
          { members: ['nothing here'] },
          { members: [7, 9] },
        ],
      }),
      url,
    );

    assert.deepEqual(groups, [
      { members: [2], clearest: 2 },
      // A missing clearest costs the group nothing: the merge is here to find duplicates.
      { members: [7, 9], clearest: 7 },
    ]);
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

describe('the resume payload', () => {
  /**
   * What a resumed Compile hands to Revisions instead of recomputing `positions`. The
   * property that matters is `claim.statement` surviving the round trip — a citation
   * never carries it, only the verbatim quote, so a lossy encoding here would be
   * invisible until Revisions silently compared the wrong text.
   */
  it('carries a PositionSet through JSON with nothing lost, `claims` included', async () => {
    const set = await compilePositions(NOTES, fakeSynthesiser());
    assert.ok(set.claims.size > 0, 'the fixture must actually exercise the claims map');

    const roundTripped = deserializePositionSet(
      JSON.parse(JSON.stringify(serializePositionSet(set))),
    );

    assert.deepEqual(roundTripped.positions, set.positions);
    assert.deepEqual([...roundTripped.claims.entries()], [...set.claims.entries()]);
    assert.equal(roundTripped.clusterer, set.clusterer);
    assert.equal(roundTripped.passes, set.passes);
    assert.equal(roundTripped.dropped_uncitable, set.dropped_uncitable);
    assert.equal(roundTripped.claims_read, set.claims_read);
  });
});

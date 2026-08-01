/**
 * Reasoning and Beliefs — the half of the Core a model writes.
 *
 * Two properties carry this file. **The marker is written by the compiler**, because the
 * most likely use of a layer is a client pasting the markdown into a system prompt, where
 * a JSON field is lost and a first line survives. And **an entry braintrust cannot
 * attribute is dropped**, which is the same rule as a claim it cannot quote: the prose is
 * a model's, but what it rests on is checkable against rows braintrust holds.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  attributable,
  digestPasses,
  inferLayer,
  inferredLayer,
  inferredMarker,
  INFERRED_MARKER,
  noteDigest,
} from '../src/compile/infer.js';
import { MAX_ENTRIES, readEntryContent } from '../src/compile/synthesis.js';
import type { StoredNote } from '../src/notes/store.js';
import { numbersMissingFromEvidence } from './support/layers.js';
import { fakeSynthesiser, idsFromDigest } from './support/synthesiser.js';

function note(externalId: string, overrides: Partial<StoredNote> = {}): StoredNote {
  return {
    item_id: `id-${externalId}`,
    external_id: externalId,
    title: `About ${externalId}`,
    published_at: '2025-06-01',
    claims: [
      { statement: 'Speed is not the constraint.', quote: 'speed is not', chunk_id: null, start_ms: null },
    ],
    argument_md: 'Starts from the constraint, rejects the capability framing, lands on judgement.',
    assumptions: ['The reader has already tried the obvious thing'],
    ...overrides,
  };
}

const NOTES = ['a1', 'b2', 'c3'].map((id) => note(id));

/**
 * A corpus too large for one pass — which the reference corpus of 412 items is. Notes are
 * given full-length arguments, because that is what makes a real one too big to send.
 */
const FOLDED = Array.from({ length: 150 }, (_, index) =>
  note(`post-${index}`, { argument_md: 'A long argument, in full. '.repeat(60) }),
);

describe('the digest a synthesis reads', () => {
  it('carries the item id, the argument and the assumptions — never the item text', () => {
    const digest = noteDigest(NOTES[0]!);

    assert.match(digest, /^\[a1\]/);
    assert.match(digest, /argument: Starts from the constraint/);
    assert.match(digest, /assumes: The reader has already tried/);
    assert.match(digest, /claims: Speed is not the constraint\./);
  });

  it('folds a corpus too large for one pass, along its own timeline', () => {
    const many = Array.from({ length: 40 }, (_, index) => note(`post-${index}`));

    const passes = digestPasses(many, 800);

    assert.ok(passes.length > 1, 'a corpus over the budget should be folded');
    // Every note appears exactly once, and in the order it arrived: a pass is a stretch
    // of someone's work rather than a random sample of it.
    assert.deepEqual(
      passes.flatMap((pass) => idsFromDigest(pass)),
      many.map((one) => one.external_id),
    );
  });

  it('keeps a corpus that fits in a single pass, so nothing is merged that was never split', () => {
    assert.equal(digestPasses(NOTES).length, 1);
  });
});

describe('attribution', () => {
  it('drops an entry that names no item braintrust holds', () => {
    const kept = attributable(
      [
        { label: 'real', body: '…', items: ['a1', 'invented'] },
        { label: 'invented', body: '…', items: ['also-invented'] },
      ],
      new Set(['a1', 'b2']),
    );

    // The mirror of a claim whose quote is not in the body: the prose is inferred, but
    // what it rests on is not allowed to be.
    assert.deepEqual(kept.entries, [{ label: 'real', body: '…', items: ['a1'] }]);
    assert.equal(kept.dropped, 1);
  });

  it('is applied after the merge, so an id the merge invented is caught too', async () => {
    const synthesiser = fakeSynthesiser({
      entriesFor: (_kind, items, mode) =>
        mode === 'merge'
          ? [{ label: 'merged', body: '…', items: [...items, 'never-existed'] }]
          : [{ label: 'a pass', body: '…', items }],
    });

    const layer = await inferLayer('reasoning', FOLDED, synthesiser);

    assert.equal(layer.evidence.merged, true);
    assert.ok(!layer.evidence.entries[0]!.items.includes('never-existed'));
  });
});

describe('the inferred marker', () => {
  it('opens the prose, as the first thing a client would paste', () => {
    const { descriptive_md } = inferredLayer('reasoning', [{ label: 'x', body: 'y', items: ['a1'] }], {
      items_synthesised: 412,
      synthesiser: 'test-model@core-1',
      passes: 1,
      dropped: 0,
    });

    assert.match(descriptive_md, INFERRED_MARKER);
    assert.equal(
      descriptive_md.split('\n')[0],
      '**Inferred across 412 items — no single item asserts this.**',
    );
  });

  it('agrees in number with a corpus of one', () => {
    assert.match(inferredMarker(1), /across 1 item —/);
  });

  it('is never synthesised at the boundary, because a field does not survive a paste', async () => {
    // The serialiser returns `basis` as well, but it must not manufacture the prose
    // marker: if it did, a layer compiled without one would be served as though it had
    // been labelled all along.
    // speak.ts is here because it is the boundary file most tempted to quote the marker:
    // it exists to tell a client not to speak it, and naming it exactly would be the
    // obvious way to do that. It describes the labelling instead, so this stays a rule
    // about prose the boundary emits rather than one with a documented exception.
    for (const file of ['personas.ts', 'mcp.ts', 'speak.ts']) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /Inferred across/, `src/${file} synthesises the marker`);
    }
  });
});

describe('an inferred layer', () => {
  it('says what wrote it, and how the corpus was folded to do it', async () => {
    const layer = await inferLayer('beliefs', NOTES, fakeSynthesiser());

    assert.equal(layer.evidence.layer, 'beliefs');
    assert.equal(layer.evidence.synthesiser, 'test-model@core-1');
    assert.equal(layer.evidence.items_synthesised, 3);
    assert.equal(layer.evidence.passes, 1);
    assert.equal(layer.evidence.merged, false);
    assert.match(layer.descriptive_md, /Synthesised by test-model@core-1/);
  });

  it('says traced rather than measured, because a fold makes the count a floor', async () => {
    const layer = await inferLayer('reasoning', FOLDED, fakeSynthesiser());

    assert.equal(layer.evidence.merged, true);
    // An entry found in one pass carries only that pass's items, so "23 of 412" is what
    // it was traced to and not a tally of the items that show it. Voice says "measured
    // in"; this deliberately does not.
    assert.match(layer.descriptive_md, /Traced to \d+ of 150 items\./);
    assert.doesNotMatch(layer.descriptive_md, /measured in/i);
  });

  it('carries every entry into the evidence, so the prose can be checked against it', async () => {
    const layer = await inferLayer('reasoning', NOTES, fakeSynthesiser());

    assert.equal(layer.evidence.entries.length, 2);
    assert.deepEqual(layer.evidence.entries[0]!.items, ['a1', 'b2', 'c3']);
    assert.equal(layer.evidence.entries[0]!.items_traced, 3);
    for (const entry of layer.evidence.entries) {
      assert.match(layer.descriptive_md, new RegExp(`### ${entry.label}`));
    }
  });

  it('leaves a blank line before every heading, because this markdown is pasted elsewhere', async () => {
    // Found live: entries rendered as one run-on block, because a heading pressed against
    // the line above it is not a heading everywhere.
    const layer = await inferLayer('beliefs', NOTES, fakeSynthesiser());

    for (const [index, line] of layer.descriptive_md.split('\n').entries()) {
      if (line.startsWith('### ')) assert.equal(layer.descriptive_md.split('\n')[index - 1], '');
    }
  });

  it('puts no number in its prose that is not also a field of its evidence', async () => {
    const layer = await inferLayer('beliefs', NOTES, fakeSynthesiser());

    assert.deepEqual(numbersMissingFromEvidence(layer.descriptive_md, layer.evidence), []);
  });

  it('records what it dropped rather than quietly publishing a shorter list', async () => {
    const synthesiser = fakeSynthesiser({
      entriesFor: (_kind, items) => [
        { label: 'attributable', body: '…', items: items.slice(0, 1) },
        { label: 'unattributable', body: '…', items: ['nothing-braintrust-holds'] },
      ],
    });

    const layer = await inferLayer('reasoning', NOTES, synthesiser);

    assert.equal(layer.evidence.dropped_unattributable, 1);
    assert.equal(layer.evidence.entries.length, 1);
    assert.doesNotMatch(layer.descriptive_md, /unattributable/);
  });

  it('says so plainly when it could synthesise nothing, rather than looking compiled', async () => {
    const layer = await inferLayer('beliefs', NOTES, fakeSynthesiser({ entriesFor: () => [] }));

    assert.deepEqual(layer.evidence.entries, []);
    assert.match(layer.descriptive_md, INFERRED_MARKER);
    assert.match(layer.descriptive_md, /could not synthesise/);
    // Written, not thrown: the gate is what refuses to publish it, and a row that shows
    // what happened is worth keeping.
    assert.match(layer.descriptive_md, /previous persona is still the one answering/);
  });

  it('lets an endpoint that went away fail the compile rather than publish half a core', async () => {
    await assert.rejects(
      () => inferLayer('reasoning', NOTES, fakeSynthesiser({ throws: new Error('endpoint gone') })),
      /endpoint gone/,
    );
  });
});

describe('reading what the synthesiser returned', () => {
  it('tolerates a fenced block, as models habitually return one', () => {
    const entries = readEntryContent(
      '```json\n{"entries":[{"label":"a","body":"b","items":["x"]}]}\n```',
      'https://example.test',
    );

    assert.deepEqual(entries, [{ label: 'a', body: 'b', items: ['x'] }]);
  });

  it('drops an entry with a heading and nothing under it', () => {
    const entries = readEntryContent(
      '{"entries":[{"label":"a","body":"","items":["x"]},{"label":"b","body":"c","items":[]}]}',
      'https://example.test',
    );

    assert.deepEqual(entries.map((one) => one.label), ['b']);
  });

  it('bounds the core, because a core that grows with the corpus stops being cheap to rebuild', () => {
    const entries = readEntryContent(
      JSON.stringify({
        entries: Array.from({ length: 20 }, (_, index) => ({
          label: `entry ${index}`,
          body: 'x',
          items: ['a1'],
        })),
      }),
      'https://example.test',
    );

    assert.equal(entries.length, MAX_ENTRIES);
  });

  it('refuses something that is not JSON at all, rather than compiling an empty core', () => {
    assert.throws(
      () => readEntryContent('I am afraid I cannot help with that.', 'https://example.test'),
      /not a JSON object/,
    );
  });

  it('tells a model that answered a different question from one that found nothing', () => {
    // Found live: an endpoint answering in the extractor's shape produced an empty layer,
    // which reached the gate as "beliefs carried nothing to serve" — a reason that sends
    // whoever reads it looking at the corpus rather than at the endpoint.
    assert.throws(
      () => readEntryContent('{"claims":[],"argument":"…"}', 'https://example.test'),
      /no entries array/,
    );

    // An empty list is a real answer, though: the prompt asks for a short list that is
    // really there over a long one that is partly hoped for.
    assert.deepEqual(readEntryContent('{"entries":[]}', 'https://example.test'), []);
  });
});

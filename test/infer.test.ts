/**
 * The digest a synthesis reads, the marker an inferred layer carries, and the reader that
 * turns a reply into entries.
 *
 * **The layer this file used to be about is gone.** Reasoning and Beliefs were the half of
 * the Core a model wrote; Reasoning is chosen from an authored menu now (see
 * ./habits.test.ts) and Beliefs is not a layer at all — what a person broadly holds has to
 * be retrieved as a through-line (see ./throughlines.test.ts). What survives here is what
 * both of those still rest on: notes folded into passes that fit, and a marker that
 * survives being pasted into a system prompt.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  digestPasses,
  habitsLayer,
  inferredMarker,
  INFERRED_MARKER,
  noteDigest,
} from '../src/compile/infer.js';
import { MAX_ENTRIES, readEntryContent } from '../src/compile/synthesis.js';
import type { StoredNote } from '../src/notes/store.js';
import { idsFromDigest } from './support/synthesiser.js';

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

/**
 * **Reviewed when Beliefs stopped being a layer, and kept.** The obvious reading was that
 * nothing ships whole any more — the Script selects the menu's instructions rather than
 * carrying Reasoning's prose — which would leave this marker guarding nothing.
 * `braintrust_explain_persona` is the counter-example: it returns every layer whole and
 * verbatim, which is the pasting case the marker was built for, and Reasoning is still
 * `inferred` there.
 */
describe('the inferred marker', () => {
  it('opens the prose, as the first thing a client would paste', () => {
    const { descriptive_md } = habitsLayer([{ slug: 'reasons-by-analogy', items: ['a1'] }], {
      items_synthesised: 412,
      synthesiser: 'test-model@habits-1',
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
    // script.ts is here because it is the boundary file most tempted to quote the marker:
    // it renders the spoken form and therefore has to *remove* the marker, and matching on
    // the literal string would be the obvious way to do that. It strips the counted
    // suffixes it can name generically instead, so this stays a rule about prose the
    // boundary emits rather than one with a documented exception.
    for (const file of ['personas.ts', 'mcp.ts', 'script.ts']) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /Inferred across/, `src/${file} synthesises the marker`);
    }
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
    // Found live, and it matters more now than it did: no gate check counts through-lines,
    // so an endpoint answering in the extractor's shape would publish a persona holding
    // none and look exactly like a corpus that genuinely had none. This throw is the only
    // thing left that keeps the two apart.
    assert.throws(
      () => readEntryContent('{"claims":[],"argument":"…"}', 'https://example.test'),
      /no entries array/,
    );

    // An empty list is a real answer, though: the prompt asks for a short list that is
    // really there over a long one that is partly hoped for.
    assert.deepEqual(readEntryContent('{"entries":[]}', 'https://example.test'), []);
  });
});

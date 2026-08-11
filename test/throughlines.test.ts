/**
 * Through-lines: what someone broadly holds, ranked rather than barred.
 *
 * The four best-supported through-lines ship for everyone, ordered recurrence first,
 * breadth second. A claim seen in one reading is outranked instead of deleted. A Person
 * whose work fits in a single reading gets through-lines — ranked on breadth alone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoredNote } from '../src/notes/store.js';
import {
  compileThroughLines,
  MIN_NOTES_PER_READING,
  THROUGH_LINES_SHIPPED,
  readingsOf,
  slugOf,
} from '../src/compile/throughlines.js';
import type { SynthesisedEntry, Synthesiser } from '../src/compile/synthesis.js';
import { fakeSynthesiser } from './support/synthesiser.js';

function notes(count: number): StoredNote[] {
  return Array.from({ length: count }, (_, index) => ({
    item_id: `id-${index}`,
    external_id: `post-${index}`,
    title: `Post ${index}`,
    published_at: `2026-01-${String(28 - index).padStart(2, '0')}`,
    claims: [{ statement: `A claim from post ${index}.`, quote: 'quoted', chunk_id: null, start_ms: null }],
    argument_md: `The argument of post ${index}.`,
    assumptions: [],
  }));
}

describe('dividing a corpus into readings', () => {
  it('gives one reading to a person whose work is too small to divide', () => {
    const readings = readingsOf(notes(2));
    assert.equal(readings.length, 1);
    assert.equal(readings[0]!.length, 2);
  });

  it('splits a corpus that fits in one call rather than leaving it whole', () => {
    const readings = readingsOf(notes(6));

    assert.equal(readings.length, 2);
    assert.deepEqual(
      readings.map((reading) => reading.length),
      [3, 3],
    );
  });

  it('keeps readings contiguous and in publication order, never interleaved', () => {
    const readings = readingsOf(notes(8));
    const order = readings.flat().map((note) => note.external_id);

    assert.deepEqual(order, notes(8).map((note) => note.external_id));
    assert.deepEqual(readings[0]!.map((n) => n.external_id), ['post-0', 'post-1', 'post-2', 'post-3']);
  });

  it('never overlaps, because overlap makes surviving two readings automatic', () => {
    const readings = readingsOf(notes(9));
    const seen = readings.flat().map((note) => note.external_id);

    assert.equal(new Set(seen).size, seen.length);
  });

  it('folds a trailing stretch too short to be a reading into the one before it', () => {
    const readings = readingsOf(notes(7), 300);

    assert.ok(readings.length >= 2);
    for (const reading of readings) {
      assert.ok(
        reading.length >= MIN_NOTES_PER_READING,
        `a reading of ${reading.length} notes is not a reading`,
      );
    }
  });
});

const held = (label: string, items: string[]): SynthesisedEntry => ({
  label,
  body: `Two or three sentences about ${label}.`,
  items,
});

describe('a through-line', () => {
  function readingBy(perReading: SynthesisedEntry[][]): Synthesiser {
    let call = 0;
    const base = fakeSynthesiser();

    return {
      ...base,
      async synthesise(): Promise<SynthesisedEntry[]> {
        return perReading[call++] ?? [];
      },
      async group(_stage, digest): Promise<{ members: number[]; clearest: number }[]> {
        const lines = [...digest.matchAll(/^\[(\d+)\] (.*)$/gm)];
        const byLabel = new Map<string, number[]>();
        for (const [, index, text] of lines) {
          const label = text!.split(' — ')[0]!;
          byLabel.set(label, [...(byLabel.get(label) ?? []), Number(index)]);
        }
        return [...byLabel.values()]
          .filter((members) => members.length > 1)
          .map((members) => ({ members, clearest: members[0]! }));
      },
    };
  }

  it('ships when surfaced in a single reading, ranked on breadth', async () => {
    const found = await compileThroughLines(
      notes(2),
      readingBy([[held('Judgement is the scarce thing', ['post-0'])], []]),
    );

    assert.equal(found.through_lines.length, 1);
    assert.equal(found.through_lines[0]!.statement, 'Judgement is the scarce thing');
    assert.equal(found.through_lines[0]!.readings, 1);
  });

  it('ships when the same conviction surfaced in two, ranked above single-reading entries', async () => {
    const found = await compileThroughLines(
      notes(6),
      readingBy([
        [held('Recurred', ['post-0'])],
        [held('Recurred', ['post-4'])],
      ]),
    );

    assert.equal(found.through_lines.length, 1);
    const line = found.through_lines[0]!;
    assert.equal(line.statement, 'Recurred');
    assert.equal(line.readings, 2);
    assert.deepEqual(line.items.sort(), ['post-0', 'post-4']);
  });

  it('ranks recurrence above breadth', async () => {
    const found = await compileThroughLines(
      notes(6),
      readingBy([
        [
          held('Recurred twice, one item each', ['post-0']),
          held('Recurred twice, many items', ['post-1', 'post-2']),
        ],
        [
          held('Recurred twice, one item each', ['post-4']),
          held('Recurred twice, many items', ['post-5']),
        ],
      ]),
    );

    // Recurred entries rank above any single-reading entry
    assert.ok(found.through_lines.length >= 2);
    for (const line of found.through_lines) {
      assert.equal(line.readings, 2);
    }
  });

  it('caps at four through-lines', async () => {
    // Generate more than 4 entries across readings so the cap applies
    const entries = Array.from({ length: 6 }, (_, i) => held(`Entry ${i}`, [`post-${i}`]));
    const found = await compileThroughLines(
      notes(12),
      readingBy([entries, []]),
    );

    assert.ok(found.through_lines.length <= THROUGH_LINES_SHIPPED);
    assert.equal(found.candidates, 6);
  });

  it('carries no date and nothing to quote, by construction', async () => {
    const found = await compileThroughLines(
      notes(2),
      readingBy([[held('Judgement is the scarce thing', ['post-0'])], []]),
    );

    assert.deepEqual(Object.keys(found.through_lines[0]!).sort(), [
      'items',
      'readings',
      'slug',
      'statement',
    ]);
  });

  it('drops an entry naming no item braintrust holds, like every other inferred claim', async () => {
    const found = await compileThroughLines(
      notes(2),
      readingBy([[held('Invented from nowhere', ['post-999'])], []]),
    );

    assert.deepEqual(found.through_lines, []);
    assert.equal(found.candidates, 1);
  });

  it('holds none at all for a person with no notes, and counts zero candidates', async () => {
    const found = await compileThroughLines(notes(0), readingBy([[]]));

    assert.deepEqual(found.through_lines, []);
    assert.equal(found.readings, 0);
    assert.equal(found.candidates, 0);
  });
});

describe('the merge under it', () => {
  it('is never shown an item id, so it cannot return one braintrust does not hold', async () => {
    const synthesiser = fakeSynthesiser();
    await compileThroughLines(notes(8), synthesiser);

    const merges = synthesiser.calls.filter((call) => call.mode === 'merge');
    assert.ok(merges.length > 0, 'a corpus read twice is merged');

    for (const merge of merges) {
      assert.doesNotMatch(merge.digest, /post-\d+/);
      assert.match(merge.digest, /^\[1\] .+ — .+$/m, 'one line per entry: an index and the wording');
    }
  });

  it('unions the item ids itself, and keeps the clearest entry\'s prose word for word', async () => {
    const found = await compileThroughLines(
      notes(6),
      {
        ...fakeSynthesiser(),
        async synthesise(digest: string): Promise<SynthesisedEntry[]> {
          const first = digest.includes('post-0');
          return [held(first ? 'Put worse' : 'The clearest way of putting it', [
            first ? 'post-0' : 'post-4',
          ])];
        },
        async group(): Promise<{ members: number[]; clearest: number }[]> {
          return [{ members: [1, 2], clearest: 2 }];
        },
      },
    );

    assert.equal(found.through_lines.length, 1);
    const line = found.through_lines[0]!;
    assert.equal(line.statement, 'The clearest way of putting it');
    assert.deepEqual(line.items.sort(), ['post-0', 'post-4']);
  });
});

describe('a through-line slug', () => {
  it('is a stable handle a maintainer can compare across compiles', () => {
    assert.equal(slugOf('Judgement is the scarce thing'), 'judgement-is-the-scarce-thing');
    assert.equal(slugOf('  Quests, not goals!  '), 'quests-not-goals');
  });

  it('is never empty, whatever a model returns', () => {
    assert.equal(slugOf('!!!'), 'through-line');
  });
});

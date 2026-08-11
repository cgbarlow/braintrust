/**
 * Through-lines: what someone broadly holds — the four best, for everyone.
 *
 * Under the new rule (#157) the survives-two-readings bar is overturned. Nothing found
 * is thrown away for failing to recur; entries are ranked by recurrence first and breadth
 * second, and at most four reach a reader.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoredNote } from '../src/notes/store.js';
import {
  compileThroughLines,
  MAX_THROUGH_LINES,
  MIN_NOTES_PER_READING,
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
  it('returns nothing for fewer than the minimum notes per reading', () => {
    assert.deepEqual(readingsOf(notes(2)), []);
  });

  it('splits a corpus that fits in one call in half', () => {
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

  it('ships even when it surfaced in only one reading — ranked lower, not deleted', async () => {
    const found = await compileThroughLines(
      notes(6),
      readingBy([[held('Judgement is the scarce thing', ['post-0'])], []]),
    );

    assert.equal(found.through_lines.length, 1);
    assert.equal(found.through_lines[0]!.statement, 'Judgement is the scarce thing');
    assert.equal(found.through_lines[0]!.readings, 1);
    assert.equal(found.dropped_single_reading, 1);
    assert.equal(found.readings, 2);
  });

  it('ranks recurrence first — a claim across two readings beats one in a single reading', async () => {
    const found = await compileThroughLines(
      notes(6),
      readingBy([
        [held('Recurred across eras', ['post-0']), held('Single appearance', ['post-1'])],
        [held('Recurred across eras', ['post-4'])],
      ]),
    );

    assert.equal(found.through_lines.length, 2);
    assert.equal(found.through_lines[0]!.statement, 'Recurred across eras');
    assert.equal(found.through_lines[0]!.readings, 2);
    assert.equal(found.through_lines[1]!.readings, 1);
  });

  it('caps at four, however many survived the merge', async () => {
    const found = await compileThroughLines(
      notes(24),
      readingBy([
        [
          held('One', ['post-0']),
          held('Two', ['post-1']),
          held('Three', ['post-2']),
          held('Four', ['post-3']),
          held('Five', ['post-4']),
        ],
        [
          held('Six', ['post-8']),
          held('Seven', ['post-9']),
          held('Eight', ['post-10']),
        ],
      ]),
    );

    // All eight entries are single-reading (different labels each reading),
    // so only MAX_THROUGH_LINES reach a reader.
    assert.ok(found.through_lines.length <= MAX_THROUGH_LINES);
    assert.equal(found.through_lines.length, 4);
  });

  it('ships when the same conviction surfaced in two readings and is ranked first', async () => {
    const found = await compileThroughLines(
      notes(6),
      readingBy([
        [held('Judgement is the scarce thing', ['post-0'])],
        [held('Judgement is the scarce thing', ['post-4'])],
      ]),
    );

    assert.equal(found.through_lines.length, 1);
    const line = found.through_lines[0]!;
    assert.equal(line.statement, 'Judgement is the scarce thing');
    assert.equal(line.readings, 2);
    assert.deepEqual(line.items.sort(), ['post-0', 'post-4']);
  });

  it('carries no date and nothing to quote, by construction', async () => {
    const found = await compileThroughLines(
      notes(6),
      readingBy([
        [held('Judgement is the scarce thing', ['post-0'])],
        [held('Judgement is the scarce thing', ['post-4'])],
      ]),
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
      notes(6),
      readingBy([
        [held('Invented from nowhere', ['post-999'])],
        [held('Invented from nowhere', ['post-998'])],
      ]),
    );

    assert.deepEqual(found.through_lines, []);
  });

  it('ranks on breadth for a corpus with reading signal but no recurrence signal', async () => {
    // 3 notes is the minimum for one reading. With 5 notes the corpus is halved into two
    // small readings. Entries from the first reading outrank the second because they come first.
    const found = await compileThroughLines(
      notes(5),
      readingBy([
        [held('Earlier reading claim', ['post-0'])],
        [held('Later reading claim', ['post-3'])],
      ]),
    );

    assert.equal(found.through_lines.length, 2);
    assert.equal(found.readings, 2);
    assert.equal(found.through_lines[0]!.readings, 1);
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

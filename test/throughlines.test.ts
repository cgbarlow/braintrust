/**
 * Through-lines: what someone broadly holds, and the ranking that decides which four ship.
 *
 * **The bar is gone.** *Survives more than one separate reading* was structural and needed
 * no judgement from anything, and it starved the layer: 11 candidates became 1, 10 became 1,
 * 10 became 0 on the first fleet rebuild. Recurrence is the first ranking signal now, so the
 * old rule's intent survives as a preference — and these tests pin both halves of that: that
 * a single-reading claim is *ranked below* one that recurred, and that it is never dropped
 * for it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoredNote } from '../src/notes/store.js';
import {
  compileThroughLines,
  MIN_NOTES_PER_READING,
  readingsOf,
  slugOf,
  THROUGH_LINES_SHIPPED,
} from '../src/compile/throughlines.js';
import type { SynthesisedEntry, Synthesiser } from '../src/compile/synthesis.js';
import { fakeSynthesiser } from './support/synthesiser.js';

function notes(count: number): StoredNote[] {
  return Array.from({ length: count }, (_, index) => ({
    item_id: `id-${index}`,
    external_id: `post-${index}`,
    title: `Post ${index}`,
    // Newest first, the order the compiler hands them over in.
    published_at: `2026-01-${String(28 - index).padStart(2, '0')}`,
    claims: [{ statement: `A claim from post ${index}.`, quote: 'quoted', chunk_id: null, start_ms: null }],
    argument_md: `The argument of post ${index}.`,
    assumptions: [],
  }));
}

describe('dividing a corpus into readings', () => {
  it('reads a corpus too small to divide once, rather than refusing it', () => {
    // #144 priced *a person whose work fits in one reading gets none*, Chris on five items
    // included, and #197 overturns it: the division measures recurrence, and an instrument
    // that cannot be applied is a missing signal rather than a verdict of nothing.
    const readings = readingsOf(notes(5));

    assert.equal(readings.length, 1);
    assert.equal(readings[0]!.length, 5);
    assert.ok(5 < MIN_NOTES_PER_READING * 2, 'too small to divide is the case under test');
  });

  it('has nothing to read for a corpus with no notes in it', () => {
    assert.deepEqual(readingsOf(notes(0)), []);
  });

  it('splits a corpus that fits in one call rather than leaving it whole', () => {
    // The compiler's own passes are budget-sized, so most personas are one pass — and
    // "more than one reading" would be unsatisfiable for the whole fleet. Halved instead,
    // for the price of one extra synthesis call.
    const readings = readingsOf(notes(6));

    assert.equal(readings.length, 2);
    assert.deepEqual(
      readings.map((reading) => reading.length),
      [3, 3],
    );
  });

  it('keeps readings contiguous and in publication order, never interleaved', () => {
    // The artefact the rule exists to exclude is a pattern produced by what was read side
    // by side. Contiguous divisions make surviving two of them mean the entry crossed a
    // topical era; interleaved ones would make every division a sample of the whole corpus,
    // in which anything general appears everywhere.
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
    // A budget small enough to force several passes, the last of which holds one note. A
    // division of one note is not a second look; it is one more note.
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
  /** A synthesiser that returns exactly the entries it is told to, per reading. */
  function readingBy(perReading: SynthesisedEntry[][]): Synthesiser {
    let call = 0;
    const base = fakeSynthesiser();

    return {
      ...base,
      async synthesise(): Promise<SynthesisedEntry[]> {
        return perReading[call++] ?? [];
      },
      // Group by identical label, which is what a good merge does with two readings that
      // found the same conviction and worded it the same way.
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

  it('ships when it surfaced in only one reading, ranked rather than barred', async () => {
    // The reversal. Under the old bar this was the commonest outcome in the fleet — one
    // candidate, one reading, nothing published — and braintrust presented it as *this person
    // holds no durable commitments*.
    const found = await compileThroughLines(
      notes(6),
      readingBy([[held('Judgement is the scarce thing', ['post-0'])], []]),
    );

    assert.equal(found.through_lines.length, 1);
    assert.equal(found.through_lines[0]!.readings, 1);
    assert.equal(found.candidates, 1);
    assert.equal(found.readings, 2);
  });

  it('ranks recurrence first and breadth second, and drops neither', async () => {
    const found = await compileThroughLines(
      notes(6),
      readingBy([
        [
          held('Seen twice', ['post-0']),
          held('Seen once, and widely', ['post-0', 'post-1', 'post-2']),
          held('Seen once, narrowly', ['post-1']),
        ],
        [held('Seen twice', ['post-4'])],
      ]),
    );

    assert.deepEqual(
      found.through_lines.map((one) => one.statement),
      ['Seen twice', 'Seen once, and widely', 'Seen once, narrowly'],
    );
    // The claim one reading saw is *below* the one that recurred, and still on the list.
    assert.equal(found.through_lines[0]!.readings, 2);
    assert.equal(found.outranked, 0);
  });

  it('publishes four, and no more, when a corpus supports more than four', async () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      held(`Candidate ${index}`, ['post-0', ...(index < 3 ? ['post-1'] : [])]),
    );

    const found = await compileThroughLines(notes(6), readingBy([many, []]));

    assert.equal(found.through_lines.length, THROUGH_LINES_SHIPPED);
    assert.equal(found.candidates, 7);
    assert.equal(found.outranked, 3);
    // Breadth decides which four, because nothing here recurred.
    assert.deepEqual(
      found.through_lines.map((one) => one.statement),
      ['Candidate 0', 'Candidate 1', 'Candidate 2', 'Candidate 3'],
    );
  });

  it('publishes all of them when a corpus supported fewer than four', async () => {
    const found = await compileThroughLines(
      notes(6),
      readingBy([[held('The only one', ['post-0'])], []]),
    );

    assert.equal(found.through_lines.length, 1);
    assert.equal(found.outranked, 0);
  });

  it('gives a person whose corpus fits in one reading four of them', async () => {
    // Chris on five items: the case #144 priced as *gets none* and #197 reverses. One
    // reading, ranked on breadth alone, and the list is the same length as anybody else's.
    const found = await compileThroughLines(
      notes(5),
      readingBy([
        [
          held('Widest', ['post-0', 'post-1', 'post-2']),
          held('Wide', ['post-0', 'post-1']),
          held('Narrow', ['post-3']),
          held('Also narrow', ['post-4']),
          held('Narrower still', ['post-2']),
        ],
      ]),
    );

    assert.equal(found.readings, 1, 'too small to divide, so it is read once');
    assert.equal(found.through_lines.length, THROUGH_LINES_SHIPPED);
    assert.deepEqual(
      found.through_lines.slice(0, 2).map((one) => one.statement),
      ['Widest', 'Wide'],
    );
    // Every one of them was seen in the single reading there was. Recurrence is a missing
    // signal here, not a verdict of one.
    assert.ok(found.through_lines.every((one) => one.readings === 1));
  });

  it('orders the same corpus the same way on every rebuild', async () => {
    // Two candidates alike in recurrence and breadth. A list that reordered between rebuilds
    // would read as the person changing when nothing did.
    const reading = [held('Beta', ['post-0']), held('Alpha', ['post-1'])];
    const once = await compileThroughLines(notes(6), readingBy([reading, []]));
    const again = await compileThroughLines(notes(6), readingBy([[...reading].reverse(), []]));

    assert.deepEqual(
      once.through_lines.map((one) => one.slug),
      again.through_lines.map((one) => one.slug),
    );
    assert.deepEqual(once.through_lines.map((one) => one.slug), ['alpha', 'beta']);
  });

  it('ships when the same conviction surfaced in two', async () => {
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
    // The union braintrust performs itself, over both readings that saw it.
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

    // The whole shape: a slug, a claim, how many readings saw it, and which items it was
    // traced to. No `held_since` — the only date available is a property of braintrust's
    // reading schedule. No quote — an illustrative one and a supporting one are
    // indistinguishable once printed.
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
    // Found and thrown away by a rule, which is the shape the gate rejects a compile for.
    assert.equal(found.candidates, 1);
    assert.equal(found.dropped_unattributable, 1);
  });

  it('says it found nothing when the readings found nothing, which is a different fact', async () => {
    const found = await compileThroughLines(notes(6), readingBy([[], []]));

    assert.deepEqual(found.through_lines, []);
    assert.equal(found.candidates, 0);
    assert.equal(found.dropped_unattributable, 0);
  });
});

/**
 * The merge, which is now the only place it runs over entries — it came here with the
 * Beliefs layer it used to fold, and these two properties came with it.
 *
 * They are what makes the ranking mean convictions rather than wordings: it is applied
 * *after* the merge, so the merge deciding that two differently worded entries say the same
 * thing is the whole of the judgement in this file. Ranking first would count one conviction
 * worded twice as two claims a single reading saw.
 */
describe('the merge under it', () => {
  it('is never shown an item id, so it cannot return one braintrust does not hold', async () => {
    const synthesiser = fakeSynthesiser();
    await compileThroughLines(notes(8), synthesiser);

    const merges = synthesiser.calls.filter((call) => call.mode === 'merge');
    assert.ok(merges.length > 0, 'a corpus read twice is merged');

    // Every marker in a merge digest is an index into the list it was handed. Not one of
    // them is an item braintrust holds, which is why a merge cannot name one it does not.
    for (const merge of merges) {
      assert.doesNotMatch(merge.digest, /post-\d+/);
      assert.match(merge.digest, /^\[1\] .+ — .+$/m, 'one line per entry: an index and the wording');
    }
  });

  it('unions the item ids itself, and keeps the clearest entry\'s prose word for word', async () => {
    const found = await compileThroughLines(
      notes(6),
      // A merge that groups the two readings and picks the second as clearest. braintrust
      // takes the union of the items; the model only ever says which wording survives.
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

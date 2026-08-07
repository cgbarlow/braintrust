/**
 * The free layer: an authored menu, four lines, and nothing off it.
 *
 * The property this file exists for: **the compile selects, it never writes.** Every line a
 * reader gets about how someone argues is text authored in `src/compile/habits.ts`, so a
 * conclusion cannot reach a Script.
 *
 * And the property that made it necessary: **the block's length does not move.** The old
 * layer asked for a free description and kept whatever cleared a three-item floor. Measured,
 * the synthesiser agrees with itself about a habit 85% of the time — but the count of Items
 * it cites moves by 1.4, and a floor of three sat on the fattest part of that distribution.
 * So the block halved between rebuilds for reasons that had nothing to do with the person.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { compileHabits, habitsLayer } from '../src/compile/infer.js';
import {
  HABITS_SHIPPED,
  MENU,
  habitFor,
  isOnTheMenu,
  shippableHabits,
  twinEvidence,
} from '../src/compile/habits.js';
import { habitsPrompt, readHabitContent } from '../src/compile/synthesis.js';
import type { StoredNote } from '../src/notes/store.js';
import { fakeSynthesiser } from './support/synthesiser.js';

function note(externalId: string): StoredNote {
  return {
    item_id: `id-${externalId}`,
    external_id: externalId,
    title: `About ${externalId}`,
    published_at: '2025-06-01',
    claims: [{ statement: 'Speed is not the constraint.', quote: 'speed', chunk_id: null, start_ms: null }],
    argument_md: 'Starts from the constraint and lands on judgement.',
    assumptions: [],
  };
}

const NOTES = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map(note);
const KNOWN = new Set(NOTES.map((one) => one.external_id));

describe('the menu', () => {
  it('is fixed source in the repo, authored rather than generated', async () => {
    const source = await readFile(new URL('../src/compile/habits.ts', import.meta.url), 'utf8');

    // Changing what any persona can say about how anybody argues is a code change with a
    // diff. Nothing here reaches an endpoint, and nothing here is built at runtime.
    assert.doesNotMatch(source, /\bfetch\(|Synthesiser|Extractor|Embedder/);
    for (const habit of MENU) {
      assert.ok(source.includes(`slug: '${habit.slug}'`), `${habit.slug} should be authored here`);
    }
  });

  it('gives every habit a slug, an instruction to speak and a test to match on', () => {
    for (const habit of MENU) {
      assert.match(habit.slug, /^[a-z][a-z0-9-]+$/);
      assert.ok(habit.instruction.trim().length > 10, `${habit.slug} needs something to say`);
      assert.ok(habit.test.trim().length > 10, `${habit.slug} needs something to match on`);
    }
    assert.equal(new Set(MENU.map((one) => one.slug)).size, MENU.length, 'slugs are unique');
  });

  /**
   * Built from the menu rather than duplicating it, so a habit added to the file is a habit
   * the model is offered and there is no second list to keep in step.
   */
  it('is what the prompt offers, with no second copy to drift from', () => {
    const prompt = habitsPrompt();

    for (const habit of MENU) {
      assert.ok(prompt.includes(habit.slug), `${habit.slug} should be offered`);
      assert.ok(prompt.includes(habit.test), `${habit.slug}'s test should be offered`);
    }
    // The instruction is what a reader hears, and the model never sees it — it is choosing
    // whether the move is characteristic, not picking a sentence it likes the sound of.
    assert.ok(!prompt.includes(MENU[0]!.instruction));
  });
});

describe('what ships', () => {
  it('drops anything off the menu, without correcting it', () => {
    const shipped = shippableHabits(
      [
        { slug: 'opens-on-a-case', items: ['a1'] },
        { slug: 'opens-on-a-caseee', items: ['b2'] },
        { slug: 'Treats prompting skill as the scarce resource', items: ['c3'] },
      ],
      KNOWN,
    );

    // Not matched loosely: a slug braintrust did not author is a line it cannot stand behind.
    assert.deepEqual(shipped.map((one) => one.slug), ['opens-on-a-case']);
  });

  it('drops a habit naming no item braintrust holds', () => {
    const shipped = shippableHabits(
      [
        { slug: 'opens-on-a-case', items: ['never-existed'] },
        { slug: 'reasons-by-analogy', items: ['a1', 'never-existed'] },
      ],
      KNOWN,
    );

    assert.deepEqual(shipped.map((one) => one.slug), ['reasons-by-analogy']);
    assert.deepEqual(shipped[0]!.items, ['a1']);
  });

  it('ranks by evidence and ships four', () => {
    const many = MENU.slice(0, 8).map((habit, index) => ({
      slug: habit.slug,
      // Descending evidence, so the ranking has something to do.
      items: NOTES.slice(0, Math.max(1, 6 - index)).map((one) => one.external_id),
    }));

    const shipped = shippableHabits(many, KNOWN);

    assert.equal(shipped.length, HABITS_SHIPPED);
    assert.deepEqual(shipped.map((one) => one.slug), many.slice(0, 4).map((one) => one.slug));
  });

  /**
   * The ranking must be a function of the reply and nothing else, so the same reply produces
   * the same four lines in the same order and a rebuild that changed nothing changes nothing.
   */
  it('breaks ties deterministically, whatever order the reply arrived in', () => {
    const tied = MENU.slice(0, 6).map((habit) => ({ slug: habit.slug, items: ['a1', 'b2'] }));

    const forwards = shippableHabits(tied, KNOWN);
    const backwards = shippableHabits([...tied].reverse(), KNOWN);

    assert.deepEqual(forwards.map((one) => one.slug), backwards.map((one) => one.slug));
  });

  /**
   * Measured on five real corpora: 9 of 52 shipping lines carried evidence identical to
   * another line, and one person had four lines all resting on the same three items. A
   * reader shown four lines believes four things were found.
   */
  it('keeps one line per set of evidence, so four lines mean four findings', () => {
    const twins = [
      { slug: 'opens-on-the-mistaken-instinct', items: ['a1', 'b2', 'c3'] },
      { slug: 'opens-on-the-buried-assumption', items: ['a1', 'b2', 'c3'] },
      { slug: 'discounts-the-official-account', items: ['a1', 'b2', 'c3'] },
      { slug: 'rejects-the-standard-framing', items: ['a1', 'b2', 'c3'] },
      { slug: 'reasons-by-analogy', items: ['d4'] },
    ];

    const shipped = shippableHabits(twins, KNOWN);

    assert.equal(shipped.length, 2, 'four twins became one, and the distinct line survived');
    assert.deepEqual(twinEvidence(shipped), []);
    // The survivor is the highest-ranked of the group, which is a function of the reply.
    assert.deepEqual(shippableHabits([...twins].reverse(), KNOWN), shipped);
  });

  /**
   * **The three-item floor is gone.** No line ships or fails on a count threshold, which is
   * what stopped the block halving between rebuilds for reasons nobody could point at.
   */
  it('ships a habit resting on one item, because nothing ships on a count', () => {
    const shipped = shippableHabits([{ slug: 'opens-on-a-case', items: ['a1'] }], KNOWN);

    assert.deepEqual(shipped.map((one) => one.slug), ['opens-on-a-case']);
  });

  it('never pads: a thin reply yields fewer habits, never invented ones', () => {
    const shipped = shippableHabits([{ slug: 'opens-on-a-case', items: ['a1'] }], KNOWN);

    assert.ok(shipped.length < HABITS_SHIPPED);
    for (const habit of shipped) assert.ok(isOnTheMenu(habit.slug));
  });
});

describe('the layer a reader gets', () => {
  it('is the menu own words, and never the slug', async () => {
    const layer = await compileHabits(NOTES, fakeSynthesiser());
    const first = habitFor('opens-on-the-mistaken-instinct')!;

    assert.ok(layer.descriptive_md.includes(first.instruction));
    assert.doesNotMatch(layer.descriptive_md, /opens-on-the-mistaken-instinct/);
  });

  it('hands a reader no count and no marker that a line has moved', async () => {
    const layer = await compileHabits(NOTES, fakeSynthesiser());

    assert.doesNotMatch(layer.descriptive_md, /Traced to/);
    assert.doesNotMatch(layer.descriptive_md, /\b\d+ of \d+ item/);
    assert.doesNotMatch(layer.descriptive_md, /new|changed|since the last|no longer/i);
  });

  /**
   * The measurement that made this ticket: the block used to halve between rebuilds because
   * the count of items a model cited moved, not because the person did.
   */
  it('is the same length for every arm, and does not vary across seeds', async () => {
    const arms = [
      // A model citing a lot, a model citing a little, and a model answering in a
      // different order — the three ways a reply moved between rebuilds on the same notes.
      (items: string[]) => MENU.slice(0, 6).map((h, i) => ({ slug: h.slug, items: items.slice(0, 6 - i) })),
      (items: string[]) => MENU.slice(0, 6).map((h, i) => ({ slug: h.slug, items: items.slice(i, i + 2) })),
      (items: string[]) => MENU.slice(0, 6).reverse().map((h, i) => ({ slug: h.slug, items: items.slice(0, 6 - i) })),
    ];

    for (const habitsFor of arms) {
      const layer = await compileHabits(NOTES, fakeSynthesiser({ habitsFor }));
      const lines = layer.descriptive_md.split('\n').filter((line) => line.startsWith('### '));

      assert.equal(lines.length, HABITS_SHIPPED, 'four lines, whatever the reply looked like');
    }
  });

  /**
   * **Absent rather than empty, and said in prose.** A block with no lines under a heading
   * reads as a person who argues no particular way; a sentence saying braintrust found none
   * reads as what actually happened.
   */
  it('says so in prose when nothing traced at all', () => {
    const layer = habitsLayer([], {
      items_synthesised: 6,
      synthesiser: 'test-model@habits-1',
      passes: 1,
      dropped: 0,
    });

    assert.deepEqual(layer.evidence.entries, []);
    assert.match(layer.descriptive_md, /could not recognise how this person argues/);
    assert.doesNotMatch(layer.descriptive_md, /^### /m, 'no empty heading');
  });

  it('unions the items when two passes choose the same habit', async () => {
    let pass = 0;
    const folded = Array.from({ length: 60 }, (_unused, index) => ({
      ...note(`post-${index}`),
      argument_md: 'A long argument, in full. '.repeat(60),
    }));

    const layer = await compileHabits(
      folded,
      fakeSynthesiser({
        habitsFor: (items) => {
          pass += 1;
          return [{ slug: 'reasons-by-analogy', items: items.slice(0, 2) }];
        },
      }),
    );

    assert.ok(pass > 1, 'a corpus this size is folded');
    assert.equal(layer.evidence.entries.length, 1, 'one habit, not one per pass');
    assert.equal(layer.evidence.entries[0]!.items.length, pass * 2, 'with the union behind it');
  });
});

describe('reading what the menu call answered', () => {
  const url = 'https://models.test/v1/chat/completions';

  it('accepts a fenced block, like every other reader here', () => {
    assert.deepEqual(
      readHabitContent('```json\n{"habits":[{"slug":"opens-on-a-case","items":["a1"]}]}\n```', url),
      [{ slug: 'opens-on-a-case', items: ['a1'] }],
    );
  });

  it('treats an empty habits array as an answer and a missing one as a wrong question', () => {
    // The prompt says returning none is valid, so an empty list is a real answer.
    assert.deepEqual(readHabitContent('{"habits":[]}', url), []);

    assert.throws(
      () => readHabitContent('{"entries":[{"label":"wrong shape","body":"b","items":[]}]}', url),
      /no habits array/,
    );
  });
});

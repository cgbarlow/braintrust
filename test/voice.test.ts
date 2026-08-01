/**
 * Voice, measured.
 *
 * The property under test is not "the counts are right" — it is that **nothing enters
 * the instruction that the counts do not support**. This repo has already shipped the
 * opposite once: a prototype asserted "no hedging" from four Substack openings, and
 * measurement later found hedging in 32 of 34 transcripts.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  EXEMPLARS_PER_MOVE,
  measureVoice,
  VOICE_MIN_WORDS,
  voiceLayer,
  type MeasuredItem,
} from '../src/compile/voice.js';
import { numbersMissingFromEvidence } from './support/layers.js';

/**
 * Four items chosen so every band of the spread rule is exercised at once: hedging in
 * all four, direct address in two, enumeration and the concession-pivot in one each, and
 * two moves in none.
 */
const ITEMS: MeasuredItem[] = [
  {
    external_id: 'a1',
    url: 'https://example.test/a1',
    published_at: '2025-01-01',
    body_text:
      "I think the first thing to say is that speed is not the constraint.\nHere's what actually binds you: knowing which of twenty things is worth doing at all.",
  },
  {
    external_id: 'b2',
    url: 'https://example.test/b2',
    published_at: '2025-04-01',
    body_text:
      "Probably the most useful thing I can tell you is this. If you're picking a model, you need to pick it for the job in front of you.",
  },
  {
    external_id: 'c3',
    url: 'https://example.test/c3',
    published_at: '2025-08-01',
    body_text:
      'maybe the scoreboard is the problem. It seems like every benchmark measures the thing that is easiest to measure.',
  },
  {
    external_id: 'd4',
    url: 'https://example.test/d4',
    published_at: '2025-12-01',
    body_text:
      "I'm not saying the tool does not matter. I'm just saying it matters less than the judgement about when to use it, and I could be wrong about that.",
  },
];

function move(evidence: ReturnType<typeof measureVoice>, name: string) {
  return evidence.moves.find((candidate) => candidate.move === name)!;
}

describe('measuring a voice', () => {
  it('counts occurrences and spread separately, because only one of them can be instructed', () => {
    const evidence = measureVoice(ITEMS);

    // Five hedges across four items. The occurrence count is the louder number and the
    // spread is the honest one: a single item saying "maybe" four times is not a habit.
    assert.equal(move(evidence, 'hedging').occurrences, 5);
    assert.equal(move(evidence, 'hedging').spread, 4);
    assert.equal(move(evidence, 'direct-address').spread, 2);
    assert.equal(move(evidence, 'enumeration').spread, 1);
    assert.equal(move(evidence, 'concession-pivot').spread, 1);
  });

  it('keeps a move it looked for and did not find, as zeroes rather than as silence', () => {
    const evidence = measureVoice(ITEMS);
    const wry = move(evidence, 'wry-aside');

    assert.equal(wry.occurrences, 0);
    assert.equal(wry.spread, 0);
    assert.deepEqual(wry.exemplars, []);

    // "braintrust looked and found none" is a different statement from saying nothing,
    // and it is the statement the first prototype needed and did not have.
    assert.match(voiceLayer(ITEMS).descriptive_md, /looked for wry aside.*and found\s+none/s);
  });

  it('carries the pattern that produced each count, so the hypothesis can be argued with', () => {
    const hedging = move(measureVoice(ITEMS), 'hedging');

    assert.match(hedging.pattern, /I think/);
    // Auto-captions are inconsistent about apostrophes, so every contraction tolerates
    // a missing one rather than under-counting a corpus that is 96% speech.
    assert.match(hedging.pattern, /I'\?m not sure/);
  });

  it('measures the window and the size of what it measured', () => {
    const evidence = measureVoice(ITEMS);

    assert.deepEqual(evidence.window, ['2025-01-01', '2025-12-01']);
    assert.equal(evidence.items_measured, 4);
    assert.equal(evidence.words_measured, ITEMS.reduce((n, i) => n + i.body_text.trim().split(/\s+/).length, 0));
  });

  it('measures nothing rather than dividing by zero on an empty corpus', () => {
    const evidence = measureVoice([]);

    assert.equal(evidence.items_measured, 0);
    assert.equal(evidence.window, null);
    assert.ok(evidence.moves.every((one) => one.occurrences === 0 && one.per_10k_words === 0));
  });
});

describe('exemplars', () => {
  it('are verbatim slices of the body, never a rendering of it', () => {
    const evidence = measureVoice(ITEMS);

    for (const measured of evidence.moves) {
      for (const exemplar of measured.exemplars) {
        const item = ITEMS.find((candidate) => candidate.external_id === exemplar.item)!;
        assert.ok(
          item.body_text.includes(exemplar.text),
          `"${exemplar.text}" is not in ${exemplar.item} verbatim`,
        );
      }
    }
  });

  it('never span a caption boundary, so the evidence never has to be flattened to render', () => {
    for (const measured of measureVoice(ITEMS).moves) {
      for (const exemplar of measured.exemplars) {
        assert.doesNotMatch(exemplar.text, /\n/);
      }
    }
  });

  it('are spread across the window rather than taken from the newest items', () => {
    const hedging = move(measureVoice(ITEMS), 'hedging');

    assert.equal(hedging.exemplars.length, EXEMPLARS_PER_MOVE);
    assert.deepEqual(
      hedging.exemplars.map((one) => one.item),
      ['a1', 'c3', 'd4'],
    );
    // Three exemplars from one week describe a week.
    assert.equal(new Set(hedging.exemplars.map((one) => one.item)).size, EXEMPLARS_PER_MOVE);
  });

  it('carry the item they came from, so a reader can go and check', () => {
    const [first] = move(measureVoice(ITEMS), 'hedging').exemplars;

    assert.equal(first!.item, 'a1');
    assert.equal(first!.url, 'https://example.test/a1');
    assert.equal(first!.published_at, '2025-01-01');
  });
});

describe('the two forms, from one set of measurements', () => {
  it('instructs a move measured in every item, and grades it as characteristic', () => {
    const { generative_md } = voiceLayer(ITEMS);

    assert.match(generative_md, /\*\*Characteristically\.\*\* Hedge before committing/);
    assert.match(generative_md, /measured in 4 of 4 items/);
  });

  it('grades a move measured in half the items down rather than out', () => {
    const { generative_md } = voiceLayer(ITEMS);

    assert.match(generative_md, /\*\*Often\.\*\* Address the reader directly/);
    assert.match(generative_md, /measured in 2 of 4 items/);
  });

  it('refuses to instruct a move measured in one item, and says it refused', () => {
    const { descriptive_md, generative_md } = voiceLayer(ITEMS);

    // The count is real, so it is described.
    assert.match(descriptive_md, /\*\*Ordinal signposting\*\* \| 1 \| 1 of 4/);
    // It is not a personality trait, so it is not instructed — and the instruction says
    // so, because a client that re-adds it would be performing it in someone's name.
    assert.doesNotMatch(generative_md, /Signpost in order/);
    assert.match(generative_md, /Measured too thinly to instruct.*ordinal signposting \(1 of 4\)/s);
  });

  it('never instructs a move it measured at zero — an absence cannot be asserted either', () => {
    const { generative_md } = voiceLayer(ITEMS);

    assert.doesNotMatch(generative_md, /wry aside/i);
    assert.doesNotMatch(generative_md, /humour/i);
    assert.doesNotMatch(generative_md, /reframe/i);
  });

  it('gives every instruction its own count inline, so it can be checked where it is read', () => {
    const { generative_md, evidence } = voiceLayer(ITEMS);

    for (const line of generative_md.split('\n').filter((one) => one.includes('measured in'))) {
      const [, spread, items] = line.match(/measured in (\d+) of (\d+) items/)!;
      assert.equal(Number(items), evidence.items_measured);
      assert.ok(
        evidence.moves.some((one) => one.spread === Number(spread)),
        `no measured move has a spread of ${spread}`,
      );
    }
  });

  it('reports register from pronoun counts rather than from an impression', () => {
    const { generative_md, evidence } = voiceLayer(ITEMS);

    assert.ok(evidence.register.second_person_per_10k > 0);
    assert.match(generative_md, /Address the reader in the second person/);
    assert.match(generative_md, new RegExp(`${evidence.register.second_person_per_10k} second-person`));
  });

  it('names the dominant pronoun from all three counts, not from two of them', () => {
    // Measured against a real corpus this was wrong: the commonest pronoun was "we", and
    // comparing only second person against first person singular called the runner-up
    // dominant. A measured layer may only claim the comparison it actually ran.
    const plural: MeasuredItem[] = [
      {
        external_id: 'p1',
        url: 'https://example.test/p1',
        published_at: '2025-01-01',
        body_text: 'I think we should look at what we built and what our users did with it.',
      },
    ];
    const { generative_md, evidence } = voiceLayer(plural);

    assert.ok(evidence.register.first_person_plural_per_10k > evidence.register.first_person_singular_per_10k);
    assert.match(generative_md, /Speak in the first person plural/);
    assert.doesNotMatch(generative_md, /Speak in the first person singular/);
  });

  it('never carries the model-not-the-person disclosure, which is measured from nobody', () => {
    const { generative_md } = voiceLayer(ITEMS);

    // It travels in the subject string instead. Injecting it here would break the one
    // property the generative form has: that it is derived from the descriptive one.
    assert.doesNotMatch(generative_md, /braintrust model of/);
    assert.doesNotMatch(generative_md, /not that person/i);
    assert.doesNotMatch(generative_md, /disclos/i);
  });

  it('puts no number in its prose that is not also a field of its evidence', () => {
    const { descriptive_md, generative_md, evidence } = voiceLayer(ITEMS);

    assert.deepEqual(numbersMissingFromEvidence(descriptive_md, evidence), []);
    assert.deepEqual(numbersMissingFromEvidence(generative_md, evidence), []);
  });
});

describe('the population voice is measured over', () => {
  /** Long enough to clear the floor, and hedging in every one so spread is unambiguous. */
  function essay(id: string): MeasuredItem {
    return {
      external_id: id,
      url: `https://example.test/${id}`,
      published_at: '2025-06-01',
      body_text:
        `I think the argument in ${id} is worth setting out slowly. ` +
        'It seems like the constraint is never the tooling. '.repeat(150),
    };
  }

  it('measures long-form only, and reads short-form for something else', () => {
    // One essay against four short posts: the shape a mixed corpus actually has, and the
    // shape that made the old arithmetic meaningless — four short items would be 80% of
    // the denominator, so nothing the essay does could ever reach a spread threshold.
    const { evidence } = voiceLayer([essay('long'), ...ITEMS]);

    assert.equal(evidence.measured_over.min_words, VOICE_MIN_WORDS);
    assert.equal(evidence.measured_over.items, 1);
    assert.equal(evidence.measured_over.items_excluded, ITEMS.length);
    assert.equal(evidence.items_measured, 1);

    // Excluded from voice, not from braintrust. Nothing here deletes them; they are read
    // for what they say rather than for how they say it.
    assert.ok(evidence.measured_over.median_words >= VOICE_MIN_WORDS);
  });

  it('keeps spread a fraction of items, so one long item cannot become a personality', () => {
    // Two essays, one of them enormous. Word-weighting would hand the long one the
    // majority of the corpus and make its tics the person; item-spread does not.
    const enormous = essay('enormous');
    enormous.body_text = enormous.body_text.repeat(20);
    const { evidence } = voiceLayer([essay('ordinary'), enormous]);

    assert.equal(evidence.items_measured, 2);
    for (const measured of evidence.moves) {
      assert.ok(measured.spread <= 2, `${measured.move} spread is an item count`);
    }
  });

  it('drops the floor for a corpus with no long-form, and labels it rather than withholding it', () => {
    const { evidence, descriptive_md, generative_md } = voiceLayer(ITEMS);

    // A persona that refuses to describe a voice is worse than one that says which voice
    // it measured. So the layer is built, and it says what it was built from.
    assert.equal(evidence.measured_over.min_words, 0);
    assert.equal(evidence.measured_over.items, ITEMS.length);
    assert.equal(evidence.measured_over.items_excluded, 0);
    assert.ok(generative_md.length > 0);
    assert.match(descriptive_md, /floor was dropped rather than the layer withheld/);
  });

  it('always names its population in the prose, not only in the evidence', () => {
    const { descriptive_md } = voiceLayer([essay('long'), ...ITEMS]);

    assert.match(descriptive_md, /\*\*Which items\.\*\*/);
    assert.match(descriptive_md, new RegExp(`${VOICE_MIN_WORDS} words or more`));
    assert.match(descriptive_md, /read for what they say rather than for how they say it/);
  });

  it('puts no number in that prose that is not also a field of its evidence', () => {
    const { descriptive_md, generative_md, evidence } = voiceLayer([essay('long'), ...ITEMS]);

    assert.deepEqual(numbersMissingFromEvidence(descriptive_md, evidence), []);
    assert.deepEqual(numbersMissingFromEvidence(generative_md, evidence), []);
  });
});

describe('no model is in this path', () => {
  it('is enforced by the module having nothing to call', async () => {
    // `measured` is a structural claim rather than a declared one: a layer no model
    // wrote. A module that imports no *values* cannot have reached an endpoint — and a
    // type import cannot either, because it is erased before anything runs. Coverage has
    // one, for the Voice population it restates as a blind spot; the rule that matters is
    // the next assertion, which no type import may satisfy.
    for (const file of ['voice.ts', 'coverage.ts']) {
      const source = await readFile(new URL(`../src/compile/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(
        source,
        /^import (?!type )/m,
        `src/compile/${file} imports a value, so it could call something`,
      );
      assert.doesNotMatch(
        source,
        /\bfetch\(|\bFetcher\b|\bEmbedder\b|\bExtractor\b/,
        `src/compile/${file} reaches a model`,
      );
    }
  });
});

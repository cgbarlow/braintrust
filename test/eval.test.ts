/**
 * The eval harness, which has to be trustworthy before anything it says is.
 *
 * The measures that matter are the ones that catch a model *passing for the wrong reason* —
 * a short quote always verifies, and a model that stops reading a third of the way in still
 * scores well on fidelity. Those two are why the scorecard is not one number.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SAMPLE, readArgs } from '../src/eval/args.js';
import { compare, countWords, positionsOf, scoreItems, type ItemEvidence } from '../src/eval/score.js';
import type { VerifiedClaim } from '../src/notes/verify.js';

const claim = (quote: string): VerifiedClaim => ({
  statement: 'said',
  quote,
  chunk_id: null,
  start_ms: null,
});

const item = (over: Partial<ItemEvidence> = {}): ItemEvidence => ({
  external_id: 'vid1',
  words: 1_000,
  offered: 10,
  nearly: 0,
  kept: [],
  ...over,
});

describe('scoring an extractor', () => {
  it('reports fidelity as what survived verification', () => {
    const card = scoreItems('m@notes-1', [
      item({ offered: 10, kept: Array.from({ length: 7 }, () => ({ at: 0.1, words: 12 })) }),
    ]);

    assert.equal(card.fidelity, 0.7);
    assert.equal(card.claims_kept, 7);
  });

  /**
   * The rejected quotes are never stored, so a generation read months ago can be placed and
   * measured but not graded. A dash rather than a guess.
   */
  it('leaves fidelity unscored when the evidence came from stored notes', () => {
    const card = scoreItems('m@notes-1', [{ external_id: 'a', words: 500, kept: [{ at: 0.5, words: 9 }] }]);

    assert.equal(card.fidelity, null);
    assert.equal(card.punctuation_share, null);
    assert.equal(card.claims_kept, 1, 'what can be measured still is');
  });

  /**
   * **The guard against gaming the verifier.** Three-word quotes always verify and say
   * nothing, so a model doing that scores a perfect fidelity — and this is the column that
   * gives it away.
   */
  it('reports the median quote length, so a perfect fidelity can be seen through', () => {
    const gaming = scoreItems('short@1', [
      item({ offered: 10, kept: Array.from({ length: 10 }, () => ({ at: 0.1, words: 3 })) }),
    ]);
    const real = scoreItems('long@1', [
      item({ offered: 10, kept: Array.from({ length: 10 }, () => ({ at: 0.1, words: 24 })) }),
    ]);

    assert.equal(gaming.fidelity, 1);
    assert.equal(real.fidelity, 1);
    assert.equal(gaming.median_quote_words, 3);
    assert.equal(real.median_quote_words, 24);
  });

  /**
   * **Long context, measured on the real corpus.** A model that cannot hold a four-hour
   * lecture quotes the opening and stops, and every other measure looks healthy.
   */
  it('reports how much was quoted from the end of an item', () => {
    const early = scoreItems('early@1', [
      item({ kept: [0.02, 0.05, 0.11, 0.2].map((at) => ({ at, words: 20 })) }),
    ]);
    const throughout = scoreItems('reads-on@1', [
      item({ kept: [0.1, 0.4, 0.7, 0.95].map((at) => ({ at, words: 20 })) }),
    ]);

    assert.equal(early.late_span_share, 0);
    assert.equal(throughout.late_span_share, 0.5);
  });

  it('counts an item where nothing survived, and one the model refused, the same way', () => {
    const card = scoreItems('m@1', [item({ kept: [] }), item({ offered: 0, kept: [] })]);
    assert.equal(card.empty_items, 2);
  });

  it('normalises reading effort by length, so a long item is not mistaken for a thorough read', () => {
    const card = scoreItems('m@1', [
      item({ words: 2_000, kept: [{ at: 0.1, words: 10 }] }),
      item({ words: 8_000, kept: [{ at: 0.1, words: 10 }] }),
    ]);
    assert.equal(card.claims_per_1k_words, 0.2);
  });

  it('averages seconds per item only over the items that were timed', () => {
    const card = scoreItems('m@1', [item({ seconds: 10 }), item({ seconds: 20 }), item({})]);
    assert.equal(card.seconds_per_item, 15);
  });

  it('says nothing rather than zero about a generation that was never timed', () => {
    assert.equal(scoreItems('m@1', [item({})]).seconds_per_item, null);
  });
});

describe('placing a stored quote back in its item', () => {
  const body = 'The tools keep getting better.\n\nAnd the work is not getting cheaper at all.';

  it('finds it, because the stored quote is the body’s own characters', () => {
    const [first, second] = positionsOf([claim('The tools keep'), claim('not getting cheaper')], body);

    assert.ok(first!.at < 0.1);
    assert.ok(second!.at > 0.6);
    assert.equal(first!.words, 3);
  });

  it('drops a quote it cannot place rather than reporting it at position zero', () => {
    assert.deepEqual(positionsOf([claim('words that are not there')], body), []);
  });

  it('counts words the same way everywhere', () => {
    assert.equal(countWords('  three  little   words '), 3);
    assert.equal(countWords('   '), 0);
  });
});

describe('the scorecard', () => {
  it('puts the generations side by side, with a dash for what was not measured', () => {
    const table = compare([
      scoreItems('incumbent@notes-1', [{ external_id: 'a', words: 100, kept: [{ at: 0.9, words: 8 }] }]),
      scoreItems('candidate@notes-1', [item({ offered: 4, kept: [{ at: 0.9, words: 8 }] })]),
    ]);

    assert.match(table, /incumbent@notes-1/);
    assert.match(table, /candidate@notes-1/);
    assert.match(table, /fidelity/);
    assert.match(table, /—/, 'the unmeasured cell says so');
    assert.match(table, /25\.0%/, 'and the measured one is a number');
  });
});

describe('the command line', () => {
  it('takes the incumbent alone by default', () => {
    const args = readArgs([]);
    assert.equal(args.model, undefined);
    assert.equal(args.sample, DEFAULT_SAMPLE);
    assert.equal(args.dry, false);
  });

  it('reads a candidate, an endpoint, a sample size and a dry run', () => {
    const args = readArgs(['--model', 'nemotron', '--base-url', 'http://x/v1', '--sample', '100', '--dry']);
    assert.equal(args.model, 'nemotron');
    assert.equal(args.baseUrl, 'http://x/v1');
    assert.equal(args.sample, 100);
    assert.equal(args.dry, true);
  });

  it('refuses a nonsense sample size rather than reading nothing', () => {
    assert.equal(readArgs(['--sample', 'lots']).sample, DEFAULT_SAMPLE);
    assert.equal(readArgs(['--sample', '-4']).sample, DEFAULT_SAMPLE);
  });
});

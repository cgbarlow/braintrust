/**
 * The golden-question eval's own logic, without a database: rendering an answer for the
 * judge, the zero-cost grounding check, the scorecard, and the command line.
 *
 * ../src/qa/run.ts calls the real `findPositions` against real Postgres, so that half is
 * covered by qa.integration.test.ts instead — the same split ../eval and ../interrogate use.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SAMPLE, readArgs } from '../src/qa/args.js';
import { formatScorecard, grounded, renderAnswer, RUBRIC, scoreOutcomes, type QAOutcome } from '../src/qa/score.js';
import type { Citation, FindPayload, FoundPosition } from '../src/find.js';

const citation = (over: Partial<Citation> = {}): Citation => ({
  item_title: 'An item',
  url: 'https://example.test/item-1',
  published_at: '2026-01-01',
  quote: 'a genuine quote',
  ...over,
});

const position = (over: Partial<FoundPosition> = {}): FoundPosition => ({
  slug: 'a-position',
  statement: 'The constraint is never speed.',
  held_since: '2025-01-01',
  held_until: null,
  days_spanned: 30,
  basis: 'measured',
  confidence: 'high',
  fit: 'close',
  similarity: 0.9,
  item_count: 1,
  current: true,
  relations: [],
  citations: [citation()],
  ...over,
});

const payload = (over: Partial<FindPayload> = {}): FindPayload => ({
  subject: 'braintrust model of P',
  query: 'what does P think',
  compiled_at: '2026-01-01T00:00:00.000Z',
  positions: [position()],
  through_lines: [],
  passages: [],
  ...over,
});

const outcome = (over: Partial<QAOutcome> = {}): QAOutcome => ({
  person: 'p',
  query: 'a question',
  item_url: 'https://example.test/item-1',
  fit: 'close',
  grounded: true,
  passed: true,
  detail: 'stub verdict',
  ...over,
});

describe('rendering an answer for the judge', () => {
  it('names the position, its fit and a real citation', () => {
    const rendered = renderAnswer(payload());

    assert.match(rendered, /The constraint is never speed\./);
    assert.match(rendered, /close/);
    assert.match(rendered, /a genuine quote/);
  });

  it('says nothing matched, rather than describing an empty list', () => {
    const rendered = renderAnswer(
      payload({
        positions: [],
        nothing_matched: { nearest_similarity: 0.2, floor: 0.5, reason: 'below_floor', nearest: [] },
      }),
    );

    assert.match(rendered, /Nothing matched\./);
  });

  it('never claims a citation that is not there', () => {
    const rendered = renderAnswer(payload({ positions: [position({ citations: [] })] }));
    assert.match(rendered, /No citation attached\./);
  });
});

describe('the grounding check', () => {
  it('is true when the top position cites the item the question was drawn from', () => {
    assert.equal(grounded(payload(), 'https://example.test/item-1'), true);
  });

  it('is false when the citation points somewhere else', () => {
    assert.equal(grounded(payload(), 'https://example.test/some-other-item'), false);
  });

  it('is false when nothing matched, rather than throwing', () => {
    assert.equal(grounded(payload({ positions: [] }), 'https://example.test/item-1'), false);
  });
});

describe('the rubric', () => {
  it('states the passing condition, so a wrong verdict is checkable after the fact', () => {
    assert.match(RUBRIC, /good-faith/);
    assert.match(RUBRIC, /nothing matched/);
  });
});

describe('the scorecard', () => {
  it('counts a pass, a fail and an unjudged answer separately', () => {
    const card = scoreOutcomes('p', [
      outcome({ passed: true }),
      outcome({ passed: false, query: 'a bad one', detail: 'wandered off topic' }),
      outcome({ passed: null, detail: 'endpoint unreachable' }),
    ]);

    assert.equal(card.asked, 3);
    assert.equal(card.passed, 1);
    assert.equal(card.failed, 1);
    assert.equal(card.unjudged, 1);
    assert.deepEqual(card.failures, [{ query: 'a bad one', detail: 'wandered off topic' }]);
  });

  it('counts grounding independently of the verdict', () => {
    const card = scoreOutcomes('p', [outcome({ passed: false, grounded: true })]);
    assert.equal(card.grounded, 1, 'a bad answer can still be about the right item');
  });

  it('prints the failures, so a run nobody watches still says what to look at', () => {
    const printed = formatScorecard(
      scoreOutcomes('p', [outcome({ passed: false, query: 'the bad one', detail: 'dodged the question' })]),
    );

    assert.match(printed, /p: 0\/1 answered well/);
    assert.match(printed, /"the bad one" — dodged the question/);
  });
});

describe('the command line', () => {
  it('asks every serving persona, ten questions each, by default', () => {
    const args = readArgs([]);
    assert.equal(args.person, undefined);
    assert.equal(args.sample, DEFAULT_SAMPLE);
  });

  it('reads one persona and a bigger sample', () => {
    const args = readArgs(['--person', 'nate-b-jones', '--sample', '20']);
    assert.equal(args.person, 'nate-b-jones');
    assert.equal(args.sample, 20);
  });

  it('refuses a nonsense sample size rather than asking nothing', () => {
    assert.equal(readArgs(['--sample', 'lots']).sample, DEFAULT_SAMPLE);
    assert.equal(readArgs(['--sample', '-4']).sample, DEFAULT_SAMPLE);
  });
});

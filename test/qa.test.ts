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
import {
  formatScorecard,
  grounded,
  reached,
  renderAnswer,
  RUBRIC,
  scoreOutcomes,
  type QAOutcome,
} from '../src/qa/score.js';
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
  reached: true,
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

  it('names who the persona is, because the rubric rules on "this person"', () => {
    assert.match(renderAnswer(payload()), /braintrust model of P/);
  });

  it('shows what a default call would return, not every citation `full: true` fetched', () => {
    const many = Array.from({ length: 7 }, (_, at) => citation({ quote: `quote ${at}` }));
    const rendered = renderAnswer(payload({ positions: [position({ citations: many })] }));

    assert.equal(rendered.match(/^Citation: /gm)?.length, 4, 'bounded to DEFAULT_CITATIONS');
    assert.doesNotMatch(rendered, /quote 4/);
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

  /**
   * **The read-but-unpositioned answer is a third shape, told apart from *nothing matched*.**
   * Retrieval found the item, braintrust read it, and no Position was formed on it. Rendering
   * it as "nothing matched" would hand a judge the empty-answer transcript for a state that
   * is not empty, so it is drawn distinctly.
   */
  it('renders a read-but-unpositioned item distinctly from an empty answer', () => {
    const rendered = renderAnswer(
      payload({
        positions: [],
        read_without_position: {
          item_title: 'A long aside about pricing',
          url: 'https://example.test/pricing',
          published_at: '2025-09-09',
          nearest: [{ slug: 'evals-precede-the-harness', statement: 'Evals come first.' }],
        },
      }),
    );

    assert.match(rendered, /Retrieved and read; no Position formed on it/);
    assert.match(rendered, /A long aside about pricing/);
    assert.doesNotMatch(rendered, /Nothing matched\./);
  });

  it('never claims a citation that is not there', () => {
    const rendered = renderAnswer(payload({ positions: [position({ citations: [] })] }));
    assert.match(rendered, /No citation attached\./);
  });
});

describe('the grounding check', () => {
  const itemUrls = ['https://example.test/item-1'];

  it('is true when the top position cites the item the question was drawn from', () => {
    assert.equal(grounded(payload(), itemUrls), true);
  });

  it('is false when the citation points somewhere else', () => {
    assert.equal(grounded(payload(), ['https://example.test/some-other-item']), false);
  });

  it('is false when nothing matched, rather than throwing', () => {
    assert.equal(grounded(payload({ positions: [] }), itemUrls), false);
  });

  it('matches a batched item on the post permalink the citation actually carries', () => {
    // The item is a whole Bluesky day; the citation resolves to one skeet inside it. An
    // equality test against the item's own url would score this ungrounded forever.
    const batched = payload({
      positions: [position({ citations: [citation({ url: 'https://bsky.test/post/abc' })] })],
    });

    assert.equal(grounded(batched, ['https://bsky.test/day/2026-01-01']), false);
    assert.equal(
      grounded(batched, ['https://bsky.test/day/2026-01-01', 'https://bsky.test/post/abc']),
      true,
    );
  });

  it('looks past the first citation, so a right answer is not scored on recency', () => {
    const later = citation({ url: 'https://example.test/something-newer' });
    const asked = citation({ url: 'https://example.test/item-1' });

    assert.equal(grounded(payload({ positions: [position({ citations: [later, asked] })] }), itemUrls), true);
  });
});

describe('whether retrieval reached the item at all', () => {
  const itemUrls = ['https://example.test/item-1'];
  const elsewhere = position({ citations: [citation({ url: 'https://example.test/other' })] });

  it('is true when a lower-ranked position cites it, where grounded is false', () => {
    const ranked = payload({ positions: [elsewhere, position()] });

    assert.equal(grounded(ranked, itemUrls), false, 'the shown answer does not rest on it');
    assert.equal(reached(ranked, itemUrls), true, 'but retrieval did find it — a ranking problem');
  });

  it('is false when nothing returned cites it, which is not a ranking problem', () => {
    assert.equal(reached(payload({ positions: [elsewhere] }), itemUrls), false);
  });

  it('is false when nothing matched', () => {
    assert.equal(reached(payload({ positions: [] }), itemUrls), false);
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

  it('counts reaching the item separately from resting the answer on it', () => {
    const card = scoreOutcomes('p', [outcome({ grounded: false, reached: true })]);

    assert.equal(card.grounded, 0);
    assert.equal(card.reached, 1);
    assert.match(formatScorecard(card), /1\/1 where retrieval reached that item at all/);
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

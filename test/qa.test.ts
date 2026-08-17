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
  answeredNothing,
  formatRungs,
  formatScorecard,
  grounded,
  groundedOf,
  reached,
  reachedOf,
  renderAnswer,
  RUBRIC,
  rungFor,
  RUNGS,
  scoreOutcomes,
  sumRungs,
  type PersonScorecard,
  type QAOutcome,
  type Rung,
  type RungFacts,
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
  rung: 'grounded',
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
    assert.match(RUBRIC, /names a specific position/);
    // The escape hatch that let "nothing matched" score as *answered well* is gone: an
    // empty answer never reaches the judge, so the rubric has nothing left to excuse.
    assert.doesNotMatch(RUBRIC, /nothing matched/);
  });
});

describe('the ladder', () => {
  const facts = (over: Partial<RungFacts> = {}): RungFacts => ({
    silence: false,
    cites: 1,
    inCandidateSet: true,
    reached: true,
    grounded: true,
    ...over,
  });

  it('is one enum of six, in the order the reasons are tried', () => {
    assert.deepEqual(RUNGS, ['silence', 'uncovered', 'withheld', 'missed', 'outranked', 'grounded']);
    assert.equal(new Set(RUNGS).size, RUNGS.length);
  });

  it('lands a silence fixture on silence, however much the corpus has on the item', () => {
    assert.equal(rungFor(facts({ silence: true, cites: 9, inCandidateSet: true })), 'silence');
  });

  it('lands an uncovered fixture on uncovered, even when the item reached the candidate set', () => {
    assert.equal(rungFor(facts({ cites: 0 })), 'uncovered');
    assert.equal(rungFor(facts({ cites: 0, inCandidateSet: false })), 'uncovered');
  });

  it('lands a withheld fixture on withheld: a citing position exists but the floor kept the item out', () => {
    assert.equal(rungFor(facts({ inCandidateSet: false, reached: false })), 'withheld');
  });

  it('lands a missed fixture on missed: a citing position exists and is ranked, but never shown', () => {
    assert.equal(rungFor(facts({ reached: false })), 'missed');
  });

  it('lands an outranked fixture on outranked: a citing position was shown, just not first', () => {
    assert.equal(rungFor(facts({ grounded: false })), 'outranked');
  });

  it('lands a grounded fixture on grounded', () => {
    assert.equal(rungFor(facts()), 'grounded');
  });

  it('assigns the first true reason, so a rung is exclusive of every rung above it', () => {
    assert.equal(rungFor(facts({ silence: true, cites: 0 })), 'silence', 'silence wins over uncovered');
    assert.equal(rungFor(facts({ cites: 0, inCandidateSet: false })), 'uncovered', 'uncovered wins over withheld');
    assert.equal(
      rungFor(facts({ inCandidateSet: false, reached: false })),
      'withheld',
      'withheld wins over missed: the item was never in the candidate set',
    );
    assert.equal(rungFor(facts({ reached: false })), 'missed', 'missed wins over outranked');
    assert.equal(
      rungFor(facts({ grounded: false, reached: true })),
      'outranked',
      'outranked is the last reason before the answer is grounded',
    );
  });

  it('derives reached from the ladder, never storing it beside it', () => {
    for (const rung of RUNGS) {
      assert.equal(
        reachedOf(rung),
        rung === 'outranked' || rung === 'grounded',
        `${rung} should (not) count as reached`,
      );
      assert.equal(groundedOf(rung), rung === 'grounded', `${rung} should (not) count as grounded`);
    }
  });

  it('carries one rung per outcome, so the six always sum to the questions asked', () => {
    const card = scoreOutcomes('p', [
      outcome({ rung: 'silence' }),
      outcome({ rung: 'uncovered' }),
      outcome({ rung: 'uncovered' }),
      outcome({ rung: 'withheld' }),
      outcome({ rung: 'missed' }),
      outcome({ rung: 'outranked' }),
      outcome({ rung: 'grounded' }),
      outcome({ rung: 'grounded' }),
    ]);

    assert.equal(total(card.rungs), card.asked, 'one and only one rung per question');
    assert.deepEqual(card.rungs, {
      silence: 1,
      uncovered: 2,
      withheld: 1,
      missed: 1,
      outranked: 1,
      grounded: 2,
    });
  });

  it('renders the ladder in order, so the report can be verified against the questions asked', () => {
    assert.equal(
      formatRungs(outcomeCard().rungs).trim(),
      'silence 0, uncovered 0, withheld 0, missed 0, outranked 0, grounded 1',
    );
  });

  it('never puts a rung label in anything a reader or the judge is shown', () => {
    const shown = `${renderAnswer(payload())}\n\n${RUBRIC}`;
    for (const rung of RUNGS) {
      assert.ok(!shown.includes(rung), `the rung label "${rung}" must not serve`);
    }
  });

  function outcomeCard(): PersonScorecard {
    return scoreOutcomes('p', [outcome({ rung: 'grounded' })]);
  }

  function total(rungs: Record<Rung, number>): number {
    return RUNGS.reduce((sum, rung) => sum + (rungs[rung] ?? 0), 0);
  }
});

describe('answeredNothing', () => {
  it('counts silence, uncovered and withheld as answering nothing', () => {
    for (const rung of ['silence', 'uncovered', 'withheld'] as Rung[]) {
      assert.equal(answeredNothing(rung), true, rung);
    }
    assert.equal(answeredNothing('missed'), false);
    assert.equal(answeredNothing('outranked'), false);
    assert.equal(answeredNothing('grounded'), false);
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
    const card = scoreOutcomes('p', [outcome({ passed: false, rung: 'grounded' })]);
    assert.equal(card.grounded, 1, 'a bad answer can still be about the right item');
  });

  it('derives reached from the ladder: outranked and grounded, never stored beside it', () => {
    const card = scoreOutcomes('p', [
      outcome({ rung: 'grounded', passed: true }),
      outcome({ rung: 'outranked', passed: true }),
      outcome({ rung: 'missed', passed: true }),
    ]);

    assert.equal(card.grounded, 1);
    assert.equal(card.reached, 2, 'outranked + grounded');
    assert.equal(card.rungs.missed, 1, 'a position that never reached the five is not what reached is');
  });

  it('puts Uncovered out of the covered denominator, and only Uncovered', () => {
    const card = scoreOutcomes('p', [
      outcome({ rung: 'silence' }),
      outcome({ rung: 'uncovered' }),
      outcome({ rung: 'withheld' }),
      outcome({ rung: 'missed', passed: true }),
      outcome({ rung: 'outranked', passed: true }),
      outcome({ rung: 'grounded', passed: true }),
    ]);

    assert.equal(card.asked, 6);
    assert.equal(card.covered, 5, 'everything except Uncovered stays in');
    assert.equal(card.grounded, 1);
    assert.equal(card.empty, 3, 'silence + uncovered + withheld');
  });

  it('never lets an empty answer become a verdict', () => {
    const card = scoreOutcomes('p', [
      outcome({ rung: 'uncovered' }),
      outcome({ rung: 'withheld' }),
      outcome({ rung: 'grounded', passed: true }),
      outcome({ rung: 'grounded', passed: false, query: 'the bad one', detail: 'dodged the question' }),
    ]);

    assert.equal(card.passed, 1);
    assert.equal(card.failed, 1);
    assert.equal(card.empty, 2);
  });

  it('prints the headline as coverage, with the judge beside it and never as the bar', () => {
    const printed = formatScorecard(
      scoreOutcomes('p', [
        outcome({ rung: 'uncovered' }),
        outcome({ rung: 'missed', passed: false, query: 'the bad one', detail: 'dodged the question' }),
        outcome({ rung: 'grounded', passed: true }),
      ]),
    );

    assert.match(printed, /grounded 1\/2 \(50%\) of the questions its corpus covers/);
    assert.match(printed, /coverage, not a quality verdict/, 'cannot read the headline as quality');
    assert.match(printed, /judge: 1\/2 answered well/);
    assert.match(printed, /answered nothing: 1 \(0 silence, 1 uncovered, 0 withheld\)/);
    assert.match(printed, /"the bad one" — dodged the question/);
  });

  it('sums the rungs to the questions asked, exactly', () => {
    const card = scoreOutcomes('p', [
      outcome({ rung: 'grounded' }),
      outcome({ rung: 'outranked' }),
      outcome({ rung: 'missed' }),
      outcome({ rung: 'withheld' }),
      outcome({ rung: 'uncovered' }),
      outcome({ rung: 'silence' }),
    ]);

    assert.deepEqual(card.rungs, {
      silence: 1,
      uncovered: 1,
      withheld: 1,
      missed: 1,
      outranked: 1,
      grounded: 1,
    });
    assert.deepEqual(sumRungs([card]), card.rungs);
  });

  it('keeps the failures printed, so a run nobody watches still says what to look at', () => {
    const printed = formatScorecard(
      scoreOutcomes('p', [outcome({ passed: false, query: 'the bad one', detail: 'dodged the question' })]),
    );

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

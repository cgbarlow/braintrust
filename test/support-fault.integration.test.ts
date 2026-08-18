/**
 * The statement-support report against real Postgres: a newly written Position is judged
 * once, a Position already judged is recognised and never sent to a model again, and a
 * failure opens a fault naming the Position and the citation that does not carry it.
 *
 * `braintrust_position_checks` and `braintrust_faults` are both keyed by content — person,
 * statement and citations — rather than by any row a Compile writes, which is exactly the
 * property a fake in-memory database cannot hold up: it has to survive being asked twice,
 * across what look like two separate calls, for the same content to mean the "checked
 * once" guarantee is real. Fails loudly rather than skipping — see test/support/database.ts.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { BuiltPosition, PositionCitation } from '../src/compile/positions.js';
import { createDb, type PostgresDb } from '../src/db.js';
import { checkStatementSupport, positionCheckKey, STATEMENT_SUPPORT_ASSERTION } from '../src/verify/support.js';
import { fakeSynthesiser } from './support/synthesiser.js';
import { testDatabaseUrl as url } from './support/database.js';

// The exact case #334 was opened on: a real quote that does not carry the claim beside it.
const JAGGED_STATEMENT = 'AI progress is jagged; bottlenecks and reverse salients shape advancement.';
const JAGGED_QUOTE =
  "even if AI becomes superhuman at analysis and PowerPoint, I don't think that means AI " +
  'necessarily replaces the jobs of consultants and designers.';

function citation(quote: string, itemId = 'item-1'): PositionCitation {
  return { item_id: itemId, quote, start_ms: null, post_url: null, posted_at: null };
}

function position(slug: string, statement: string, quotes: string[]): BuiltPosition {
  return {
    slug,
    statement,
    held_since: '2025-01-01',
    held_until: '2025-01-01',
    days_spanned: 0,
    item_count: quotes.length,
    confidence: 'moderate',
    citations: quotes.map((quote, index) => citation(quote, `item-${slug}-${index}`)),
  };
}

describe('statement support, against real Postgres', () => {
  let db: PostgresDb;

  before(async () => {
    db = createDb(url!);
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (db) {
      await db.query('truncate braintrust_position_checks');
      await db.query('truncate braintrust_faults');
      await db.close();
    }
  });

  beforeEach(async () => {
    // Neither table is foreign-keyed to a person or a compile — both are keyed by content
    // — so a truncate is the whole of the reset a case here needs.
    await db.query('truncate braintrust_position_checks');
    await db.query('truncate braintrust_faults');
  });

  async function faults(): Promise<{ assertion: string; person_slug: string | null; detail: string }[]> {
    const { rows } = await db.query<{ assertion: string; person_slug: string | null; detail: string }>(
      'select assertion, person_slug, detail from braintrust_faults order by person_slug',
    );
    return rows;
  }

  it('finds the ethan-mollick case: a real quote that does not carry the statement beside it', async () => {
    const synthesiser = fakeSynthesiser({
      supportFor: (slugs) =>
        slugs.map((slug) => ({
          slug,
          supported: false,
          rationale:
            'The quote says AI may not replace consultants and designers, which is a claim about ' +
            'job displacement — not that progress is jagged or shaped by bottlenecks.',
        })),
    });

    const report = await checkStatementSupport(
      db,
      'ethan-mollick',
      [position('progress-is-jagged', JAGGED_STATEMENT, [JAGGED_QUOTE])],
      synthesiser,
      { log: () => {} },
    );

    assert.equal(report.checked, 1);
    assert.equal(report.failing.length, 1);
    assert.equal(report.failing[0]!.slug, 'progress-is-jagged');

    const open = await faults();
    assert.equal(open.length, 1);
    assert.equal(open[0]!.assertion, STATEMENT_SUPPORT_ASSERTION);
    assert.equal(open[0]!.person_slug, 'ethan-mollick');
    assert.match(open[0]!.detail, /progress-is-jagged/);
    assert.match(open[0]!.detail, /AI progress is jagged/);
    assert.match(open[0]!.detail, /even if AI becomes superhuman at analysis and PowerPoint/);
    assert.match(open[0]!.detail, /job displacement/);
  });

  it('opens no fault, and stops nothing, when the quotes carry the statement', async () => {
    const synthesiser = fakeSynthesiser(); // default: everything supported

    const report = await checkStatementSupport(
      db,
      'chris',
      [position('a-real-claim', 'The constraint is never speed.', ['I have said many times the constraint is never speed'])],
      synthesiser,
    );

    assert.deepEqual(report.failing, []);
    assert.deepEqual(await faults(), []);
  });

  it('checks a new position once, and never asks about it again once it has been judged', async () => {
    const synthesiser = fakeSynthesiser();
    const one = position('the-constraint-is-never-speed', 'The constraint is never speed.', ['a real quote']);

    const first = await checkStatementSupport(db, 'nate', [one], synthesiser);
    assert.equal(first.checked, 1);
    assert.equal(first.already_checked, 0);

    const supportCalls = () => synthesiser.calls.filter((call) => call.kind === 'support').length;
    assert.equal(supportCalls(), 1);

    // The same content again — the shape a daily rebuild produces, since the growing layer
    // is recomputed whole and a Position that recurs unchanged gets a fresh row every time.
    const second = await checkStatementSupport(db, 'nate', [one], synthesiser);
    assert.equal(second.checked, 0);
    assert.equal(second.already_checked, 1);
    assert.equal(supportCalls(), 1, 'the judge is not asked a second time about a position it already judged');
  });

  it('judges the same statement again for a different person, and for the same person with a different citation', async () => {
    const synthesiser = fakeSynthesiser();
    const base = position('the-constraint-is-never-speed', 'The constraint is never speed.', ['a real quote']);

    await checkStatementSupport(db, 'nate', [base], synthesiser);
    await checkStatementSupport(db, 'chris', [base], synthesiser); // same content, different person
    await checkStatementSupport(
      db,
      'nate',
      [position('same-slug-different-quote', base.statement, ['a different real quote'])],
      synthesiser,
    );

    const supportCalls = () => synthesiser.calls.filter((call) => call.kind === 'support').length;
    assert.equal(supportCalls(), 3, 'three distinct (person, statement, citations) keys, three judgements');
  });

  it('computes the same content key regardless of citation order, so re-citing in a new order is not a new question', () => {
    const forward = position('p', 'A statement.', ['quote a', 'quote b']);
    const backward = position('p', 'A statement.', ['quote b', 'quote a']);

    assert.equal(positionCheckKey('nate', forward), positionCheckKey('nate', backward));
  });

  it('skips a position with no citation rather than sending it to a judge', async () => {
    const synthesiser = fakeSynthesiser();
    const uncited: BuiltPosition = { ...position('none', 'A statement with nothing behind it.', []), citations: [] };

    const report = await checkStatementSupport(db, 'nate', [uncited], synthesiser);

    assert.equal(report.checked, 0);
    assert.equal(synthesiser.calls.filter((call) => call.kind === 'support').length, 0);
  });
});


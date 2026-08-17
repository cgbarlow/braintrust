/**
 * The bars: the set they are measured against, the rules that decide them, and the ledger
 * half that turns a verdict into a row.
 *
 * The measurement half (../src/qa/measure.ts) runs `findPositions` against real Postgres,
 * so it lives in bars.integration.test.ts next to the other corpus-backed suites. What is
 * worth proving here, without a database, is that the decision rules cannot drift from the
 * spec: only `uncovered` leaves the grounded denominator, a below-bar persona fails by name
 * and number, a passing persona clears the fault row it owns, and nowhere — in the rules or
 * the report — is there a fleet average.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  coveredOf,
  formatBars,
  GROUNDED_BAR,
  groundedRateOf,
  groundedVerdict,
  OFF_DOMAIN_FALSE_ANSWERS_BAR,
  offDomainVerdict,
  barVerdicts,
  type PersonBars,
} from '../src/qa/bars.js';
import { GROUNDED_BAR_FAULT, OFF_DOMAIN_FAULT } from '../src/qa/bars.js';
import { reconcileBarFaults, summariseBarChecks } from '../src/interrogate/bars.js';
import { OFF_DOMAIN } from '../src/qa/negative.js';
import { RUNGS, type Rung } from '../src/qa/score.js';
import type { QueryResult } from '../src/db.js';

const rungs = (over: Partial<Record<Rung, number>> = {}): Record<Rung, number> => {
  const base = Object.fromEntries(RUNGS.map((rung) => [rung, 0])) as Record<Rung, number>;
  return { ...base, ...over };
};

const bars = (over: Partial<PersonBars> = {}): PersonBars => ({
  person: 'chris-barlow',
  asked: 10,
  rungs: rungs({ grounded: 9, outranked: 1 }),
  covered: 10,
  grounded: 9,
  groundedRate: 0.9,
  offDomainAsked: 6,
  offDomainFalseAnswers: 0,
  retrieved: 10,
  coveredItems: 9,
  ...over,
});

describe('the off-domain set', () => {
  it('is the canonical set the harness asks, shared with the bar so the two cannot disagree', () => {
    // The bars measure the same `OFF_DOMAIN` list the negative-set columns report, so the
    // number a fault names is the number `npm run qa` prints. Six is the starting size
    // decided in §5.3; extend in `src/qa/negative.ts`, never in a second list.
    assert.equal(OFF_DOMAIN.length, 6, 'the set is deliberately small (#329): six is enough to start');
    assert.equal(OFF_DOMAIN.length, new Set(OFF_DOMAIN.map((one) => one.query)).size, 'no duplicate question');
  });

  it('asks nothing but off-domain questions, authored as real questions', () => {
    for (const question of OFF_DOMAIN) {
      assert.equal(question.kind, 'off-domain');
      assert.ok(question.query.trim().endsWith('?'), `"${question.query}" is a question`);
    }
  });
});

describe('the grounded denominator', () => {
  it('keeps every rung except uncovered', () => {
    assert.equal(coveredOf(rungs({ uncovered: 3, grounded: 4, withheld: 1 })), 5, 'asked 8, 3 uncovered');
  });

  it('is zero when everything is uncovered', () => {
    assert.equal(coveredOf(rungs({ uncovered: 10 })), 0);
  });
});

describe('the grounded bar', () => {
  it('is 70% of covered questions, per persona', () => {
    assert.equal(GROUNDED_BAR, 0.7);
  });

  it('is a wall: one step below fails, and at the bar is not below it', () => {
    const justBelow = bars({ covered: 10, grounded: 6, groundedRate: 0.6, rungs: rungs({ grounded: 6, outranked: 4 }) });
    const below = groundedVerdict(justBelow);
    assert.equal(below.status, 'fail');
    assert.match(below.detail, /chris-barlow/);
    assert.match(below.detail, /6 of 10/);
    assert.match(below.detail, /below the 70% bar/);

    const at70 = bars({ covered: 10, grounded: 7, groundedRate: 0.7, rungs: rungs({ grounded: 7, outranked: 3 }) });
    assert.equal(groundedVerdict(at70).status, 'pass', '“≥ 70%” is the rule, and 70% meets it');
  });

  it('passes a persona above the bar, naming the numbers that cleared it', () => {
    const verdict = groundedVerdict(bars());
    assert.equal(verdict.status, 'pass');
    assert.match(verdict.detail, /9 of 10/);
    assert.match(verdict.detail, /at or above the 70% bar/);
  });

  it('is not measured when a persona has no covered questions — neither a pass nor a fail', () => {
    const verdict = groundedVerdict(bars({ covered: 0, grounded: 0, groundedRate: null }));
    assert.equal(verdict.status, 'not_measured');
  });

  it('derives the rate from the counts and refuses to disagree with a stored one', () => {
    // The rate shown is the counts read directly; there is no stored rate that could rot.
    const m = bars({ covered: 5, grounded: 4, groundedRate: null });
    assert.equal(groundedRateOf(m), 0.8);
  });
});

describe('the off-domain bar', () => {
  it('bars any served position where the honest answer is silence', () => {
    assert.equal(OFF_DOMAIN_FALSE_ANSWERS_BAR, 0);
  });

  it('fails when a persona answered any off-domain question it had no material for', () => {
    const verdict = offDomainVerdict(bars({ offDomainFalseAnswers: 1 }));
    assert.equal(verdict.status, 'fail');
    assert.match(verdict.detail, /chris-barlow/);
    assert.match(verdict.detail, /1 of 6/);
  });

  it('passes a persona that answers none of them', () => {
    assert.equal(offDomainVerdict(bars()).status, 'pass');
  });

  it('is not measured when no off-domain question was asked', () => {
    const verdict = offDomainVerdict(bars({ offDomainAsked: 0 }));
    assert.equal(verdict.status, 'not_measured');
  });
});

describe('the bar verdicts together', () => {
  it('carry both bars, grounded first', () => {
    const verdicts = barVerdicts(bars());
    assert.deepEqual(
      verdicts.map((verdict) => verdict.bar),
      ['grounded', 'off_domain'],
    );
  });

  it('never averages across the fleet', () => {
    // Every report line is about one persona; the two personas' numbers never meet in a
    // single sentence, denominator, or bar. That is the whole point of §5.5 — 52% hides
    // stuart at 80% and ethan at 20%, and a reader meets one persona.
    const one = formatBars(bars({
      person: 'stuart-winter-tear',
      grounded: 8,
      groundedRate: 0.8,
      rungs: rungs({ grounded: 8, outranked: 2 }),
    }));
    const two = formatBars(bars({
      person: 'ethan-mollick',
      grounded: 2,
      groundedRate: 0.2,
      rungs: rungs({ grounded: 2, outranked: 8 }),
    }));

    assert.doesNotMatch(one, /ethan-mollick/, "one persona's report never carries another's number");
    assert.doesNotMatch(two, /stuart-winter-tear/, 'and never the other way round');
    for (const rendered of [one, two]) {
      assert.doesNotMatch(rendered, /\bfleet\b|\baverage\b|\bTOTAL\b/i, 'no aggregated bar, anywhere');
    }
  });

  it('reports coverage beside the bars and never bars it', () => {
    const rendered = formatBars(bars({ retrieved: 524, coveredItems: 236 }));
    assert.match(rendered, /coverage — 45% \(236 of 524 retrieved items cited\) — reported, never barred/);
  });
});

type Db = {
  query<Row>(text: string, params?: unknown[]): Promise<QueryResult<Row>>;
};

function memoryDb(): { db: Db; faults: Map<string, Record<string, unknown>>; cleared: string[] } {
  const faults = new Map<string, Record<string, unknown>>();
  const cleared: string[] = [];

  const db: Db = {
    async query<Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> {
      const flat = text.replace(/\s+/g, ' ').trim();

      if (flat.startsWith('insert into braintrust_faults')) {
        const key = params[0] as string;
        if (!faults.has(key)) {
          faults.set(key, {
            fault_key: key,
            assertion: params[1],
            person_slug: params[2],
            detail: params[3],
            first_failed_at: new Date('2026-08-17T00:00:00.000Z'),
            last_failed_at: new Date('2026-08-17T00:00:00.000Z'),
            reported_at: null,
            escalated_at: null,
          });
        }
        return { rows: [faults.get(key)!] as Row[] };
      }

      if (flat.startsWith('delete from braintrust_faults')) {
        const key = params[0] as string;
        cleared.push(key);
        faults.delete(key);
        return { rows: [] as Row[] };
      }

      if (flat.includes('from braintrust_faults order by first_failed_at')) {
        return { rows: [...faults.values()] as Row[] };
      }

      return { rows: [] as Row[] };
    },
  };

  return { db, faults, cleared };
}

describe('the ledger half', () => {
  it('opens one deduped fault for a persona below either bar, naming the persona and the number', async () => {
    const { db, faults } = memoryDb();
    const below = bars({
      person: 'ethan-mollick',
      covered: 10,
      grounded: 2,
      groundedRate: 0.2,
      rungs: rungs({ grounded: 2, outranked: 8 }),
    });

    const first = await reconcileBarFaults(db, [below], () => {});
    assert.deepEqual(first.opened.map((one) => one.bar), [GROUNDED_BAR_FAULT]);
    const fault = faults.get(`${GROUNDED_BAR_FAULT}:ethan-mollick`)!;
    assert.equal(fault.person_slug, 'ethan-mollick');
    assert.match(fault.detail as string, /ethan-mollick/);
    assert.match(fault.detail as string, /2 of 10/);

    // A second run re-observes the same measurement: still one row, and no second "opened" —
    // but the run must not read as "all clear", so the re-observed fault is named instead.
    const second = await reconcileBarFaults(db, [below], () => {});
    assert.equal(second.opened.length, 0, 're-observed, never duplicated');
    assert.deepEqual(second.stillOpen.map((one) => one.bar), [GROUNDED_BAR_FAULT]);
    assert.equal(faults.size, 1, 'one row per live fault is the deduplication');
  });

  it('never reports "every one at or above them" while a bar fault is still open', async () => {
    // The steady state on today's fleet: the fault opened last run is re-observed failing
    // tonight, so nothing was *opened* or *cleared* this run — and the summary must not
    // claim the fleet cleared a bar it is still under.
    const { db, faults } = memoryDb();
    const below = bars({
      person: 'ethan-mollick',
      covered: 10,
      grounded: 2,
      groundedRate: 0.2,
      rungs: rungs({ grounded: 2, outranked: 8 }),
    });

    await reconcileBarFaults(db, [below], () => {});
    const second = await reconcileBarFaults(db, [below], () => {});
    const summary = summariseBarChecks(second)!;
    assert.match(summary, /still open: grounded_bar \(ethan-mollick\)/);
    assert.doesNotMatch(summary, /every one at or above them/);
    assert.equal(faults.size, 1);
  });

  it('opens nothing, and clears nothing, for a persona at or above every bar', async () => {
    const { db, faults } = memoryDb();
    const report = await reconcileBarFaults(db, [bars()], () => {});
    assert.equal(faults.size, 0);
    assert.equal(report.opened.length, 0);
    assert.equal(report.cleared.length, 0, 'a pass with nothing open clears no row');
  });

  it('clears the fault when the same persona passes, and not before', async () => {
    const { db, faults, cleared } = memoryDb();
    const below = bars({
      person: 'nate-b-jones',
      covered: 10,
      grounded: 6,
      groundedRate: 0.6,
      rungs: rungs({ grounded: 6, outranked: 4 }),
    });
    await reconcileBarFaults(db, [below], () => {});
    assert.equal(faults.size, 1);

    const above = { ...below, grounded: 8, groundedRate: 0.8, rungs: rungs({ grounded: 8, outranked: 2 }) };
    const report = await reconcileBarFaults(db, [above], () => {});
    assert.equal(faults.size, 0);
    assert.deepEqual(
      report.cleared.map((one) => one.bar),
      [GROUNDED_BAR_FAULT],
      'only the fault that was actually open is reported cleared',
    );
    assert.ok(cleared.includes(`${GROUNDED_BAR_FAULT}:nate-b-jones`));
  });

  it('opens and clears the off-domain fault by the same rule', async () => {
    const { db, faults, cleared } = memoryDb();
    const answered = bars({ offDomainFalseAnswers: 3, offDomainAsked: 6 });
    await reconcileBarFaults(db, [answered], () => {});
    assert.equal(faults.size, 1);
    const fault = faults.get(`${OFF_DOMAIN_FAULT}:chris-barlow`)!;
    assert.match(fault.detail as string, /3 of 6/);

    const silent = { ...answered, offDomainFalseAnswers: 0 };
    const report = await reconcileBarFaults(db, [silent], () => {});
    assert.equal(faults.size, 0);
    assert.deepEqual(report.cleared.map((one) => one.bar), [OFF_DOMAIN_FAULT]);
    assert.ok(cleared.includes(`${OFF_DOMAIN_FAULT}:chris-barlow`));
  });

  it('leaves the ledger exactly as it was when a bar could not be measured', async () => {
    const { db, faults } = memoryDb();
    const unmeasurable = bars({ covered: 0, grounded: 0, groundedRate: null, offDomainAsked: 0 });

    await reconcileBarFaults(db, [unmeasurable], () => {});
    assert.equal(faults.size, 0, 'a non-verdict opens nothing');
  });

  it('files through the registry, so a fault under these names carries the guarantee on record', async () => {
    const { db, faults } = memoryDb();
    await reconcileBarFaults(
      db,
      [bars({ offDomainFalseAnswers: 1 })],
      () => {},
    );
    const fault = faults.get(`${OFF_DOMAIN_FAULT}:chris-barlow`)!;
    assert.equal(fault.assertion, OFF_DOMAIN_FAULT);
  });
});

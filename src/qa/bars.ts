/**
 * The bars the fleet is held to, and the numbers that decide each one.
 *
 * **Two bars and one report, per persona, never across the fleet.** `grounded` is barred at
 * 70% of covered questions — everything except `uncovered` leaves nothing out of the
 * denominator, so Silence, Withheld, Missed and Outranked all stay in. Off-domain false
 * answers are barred at zero. Coverage is reported beside the two and never barred:
 * braintrust does not chase coverage, because a coverage target manufactures positions a
 * person does not hold (§5.5 of the map spec).
 *
 * **There is no fleet average anywhere in this module, on purpose.** 52% hides stuart at
 * 80% and ethan at 20%, and a reader meets one persona not an average — so everything here
 * is decided per Person or not at all.
 *
 * **The bars rule the ledger, and the ledger decides nothing about serving.** A persona
 * below a bar keeps answering, unchanged: the fault this opens names the persona and the
 * number, and the fault's escalation withdraws no layer. See
 * ../interrogate/assertions.ts for the two registered fault names.
 *
 * Both bars are decided by counts already measured — no judge call is spent on either.
 * Grounded is a URL match against the answer a reader would be shown, False answers is a
 * count of served Positions on topics nobody holds, and Coverage is two counts in SQL.
 */

import type { Rung } from './score.js';

/** The share of covered questions a persona must answer grounded on, per persona. */
export const GROUNDED_BAR = 0.7;

/** The most false answers the off-domain set may produce, per persona. */
export const OFF_DOMAIN_FALSE_ANSWERS_BAR = 0;

/** The fault each bar opens on the existing braintrust_faults rail. */
export const GROUNDED_BAR_FAULT = 'grounded_bar';
export const OFF_DOMAIN_FAULT = 'off_domain_false_answers';

/** A bar verdict that is not a verdict: the measurement had nothing to decide on. */
export type BarStatus = 'pass' | 'fail' | 'not_measured';

/**
 * Everything the free whole-corpus measurement (../qa/measure.ts) knows about one Person,
 * in counts. The rates are derived from these counts here and nowhere else, so the report,
 * the bar verdicts and the fault detail cannot disagree about a denominator.
 */
export type PersonBars = {
  person: string;
  /** Every titled, retrieved item, one rung each — the pass the bars are measured on. */
  asked: number;
  /** The rungs, counted. `grounded` and covered are derived from these, never stored. */
  rungs: Record<Rung, number>;
  /** Covered questions: everything except `uncovered`, which is the one rung about the corpus. */
  covered: number;
  grounded: number;
  /** The judged headline, free of judge calls: grounded over covered. Null when covered is 0. */
  groundedRate: number | null;
  /** The negative set: questions no persona has material for, asked of this persona. */
  offDomainAsked: number;
  /** Served Positions with a real quote, where the honest answer is silence. */
  offDomainFalseAnswers: number;
  /** Retrieved items this Person has a reading of, and the items a compiled Position cites. */
  retrieved: number;
  coveredItems: number;
};

/** One bar's verdict for one Person, with the sentence a fault or a report can carry. */
export type BarVerdict = {
  bar: 'grounded' | 'off_domain';
  status: BarStatus;
  /** Names the persona and the number, so the fault is readable without re-running anything. */
  detail: string;
};

/**
 * Only `uncovered` leaves the grounded denominator. Silence, Withheld, Missed and Outranked
 * all stay in, because they are this persona failing a question it was handed material for —
 * `uncovered` is the one rung that is about the corpus, not about the answer.
 */
export function coveredOf(rungs: Record<Rung, number>): number {
  const asked = Object.values(rungs).reduce((total, count) => total + count, 0);
  return asked - (rungs.uncovered ?? 0);
}

export function groundedRateOf(m: Pick<PersonBars, 'grounded' | 'covered'>): number | null {
  return m.covered === 0 ? null : m.grounded / m.covered;
}

/**
 * The grounded bar, decided per persona. A persona with no covered questions has nothing to
 * be measured on, which is neither a pass nor a fail — the ledger is left exactly as it was.
 */
export function groundedVerdict(m: PersonBars): BarVerdict {
  const rate = groundedRateOf(m);
  if (m.covered === 0 || rate === null) {
    return {
      bar: 'grounded',
      status: 'not_measured',
      detail: `${m.person} has no covered questions to measure, so the grounded bar cannot be decided`,
    };
  }

  const below = rate < GROUNDED_BAR;
  return {
    bar: 'grounded',
    status: below ? 'fail' : 'pass',
    detail:
      `${m.person} is grounded on ${m.grounded} of ${m.covered} covered questions ` +
      `(${percent(rate)}), ${below ? `below the ${percent(GROUNDED_BAR)} bar` : `at or above the ${percent(GROUNDED_BAR)} bar`}`,
  };
}

/**
 * The off-domain bar, decided per persona. Anything that came back on a question nobody
 * has material for is a false answer — a Position, raw passages, or a read-but-unpositioned
 * item — the same *anything came back* rule the negative-set columns report
 * (`src/qa/score.ts` `cameBack`). The correct answer is silence.
 */
export function offDomainVerdict(m: PersonBars): BarVerdict {
  if (m.offDomainAsked === 0) {
    return {
      bar: 'off_domain',
      status: 'not_measured',
      detail: `${m.person} was asked no off-domain questions, so the false-answers bar cannot be decided`,
    };
  }

  const below = m.offDomainFalseAnswers > OFF_DOMAIN_FALSE_ANSWERS_BAR;
  return {
    bar: 'off_domain',
    status: below ? 'fail' : 'pass',
    detail:
      `${m.person} answered ${m.offDomainFalseAnswers} of ${m.offDomainAsked} off-domain ` +
      `questions with a served Position, where the bar is ${OFF_DOMAIN_FALSE_ANSWERS_BAR} ` +
      `false answers and the honest answer is silence`,
  };
}

/** Both bars' verdicts for one Person, grounded first. Coverage has no verdict — ever. */
export function barVerdicts(m: PersonBars): BarVerdict[] {
  return [groundedVerdict(m), offDomainVerdict(m)];
}

/** A whole percentage, the number a reader holds. */
function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * One Person's bars as the lines a report can carry. Coverage appears in the same block — a
 * stated number never barred — and nothing here aggregates across personas.
 */
export function formatBars(m: PersonBars): string {
  const grounded = groundedVerdict(m);
  const offDomain = offDomainVerdict(m);
  const coverage =
    m.retrieved === 0
      ? `coverage — nothing retrieved, so nothing is covered — reported, never barred`
      : `coverage — ${Math.round((m.coveredItems / m.retrieved) * 100)}% ` +
        `(${m.coveredItems} of ${m.retrieved} retrieved items cited) — reported, never barred`;

  return [
    `grounded — ${m.grounded} of ${m.covered} covered questions` +
      (m.groundedRate === null ? '' : ` (${percent(m.groundedRate)})`) +
      ` — ${statusWord(grounded)}`,
    `off-domain — ${m.offDomainFalseAnswers} of ${m.offDomainAsked} answered — ${statusWord(offDomain)}`,
    coverage,
  ].join('\n');
}

function statusWord(verdict: BarVerdict): string {
  switch (verdict.status) {
    case 'pass':
      return `${verdict.bar === 'grounded' ? 'at or above' : 'at'} the bar`;
    case 'fail':
      return 'below the bar — opens a fault';
    case 'not_measured':
      return 'not measured';
  }
}

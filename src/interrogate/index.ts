/**
 * braintrust interrogates itself and files the issue.
 *
 * The publish gate asks what a Compile *is* and blocks publication on the answer. This asks
 * what a Persona **does** once a model is holding it, and blocks nothing — because the
 * answer comes from one live call to a synthesiser that `temperature: 0` does not pin down,
 * and that is evidence rather than proof.
 *
 * So the whole shape of this file follows from one decision: **a failing interrogation keeps
 * the Persona serving unchanged.** Nothing here writes to a Compile, a layer or a version.
 * What a failure produces is a row in a ledger and an issue on this repo, addressed to the
 * only audience that can clear it — a maintainer, because a fault in the compiler is equal
 * across the fleet and no amount of rebuilding fixes it.
 *
 * **The accepted cost, named:** braintrust knowingly serves a Persona it has judged to be
 * inventing claims until a human ships a compiler change. The one-day limit is what keeps
 * that from being permanent — see ./schedule.ts.
 *
 * See docs/design/compiler.md §7 and https://github.com/cgbarlow/braintrust/issues/171.
 */

import { COMPILER_VERSION } from '../compile/version.js';
import type { Db } from '../db.js';
import { nothingMatched, NEAREST_ON_EMPTY, RETRIEVAL_FLOOR } from '../find.js';
import { loadPersona } from '../personas.js';
import {
  ASSERTIONS,
  type AssertionDefinition,
  type InterrogationSubject,
  type Interrogator,
} from './assertions.js';
import { escalationIssue, faultIssue, type IssueFiler } from './issues.js';
import { dueAssertions, faultsToFile, type Due } from './schedule.js';
import {
  claimsHeldFor,
  clearFault,
  lastInterrogations,
  markEscalated,
  markReported,
  openFault,
  openFaults,
  recordInterrogation,
  servingFleet,
} from './store.js';

export { ASSERTIONS, assertionById, assertionIds, INTERROGATION_VERSION } from './assertions.js';
export type {
  AssertionDefinition,
  AssertionScope,
  Interrogation,
  Interrogator,
  InterrogationSubject,
} from './assertions.js';
export { createInterrogator } from './model.js';
export {
  createIssueFiler,
  escalationIssue,
  faultIssue,
  loggingIssueFiler,
  type IssueFiler,
  type Issue,
} from './issues.js';
export {
  dueAssertions,
  ESCALATES_AFTER_MS,
  faultKey,
  faultsToFile,
  SWEEP_INTERVAL_MS,
  withdrawnLayers,
  type Due,
  type Fault,
  type FleetSubject,
  type LastRun,
} from './schedule.js';
export { escalatedFaults, openFaults, servingFleet } from './store.js';

export type InterrogationDeps = {
  db: Db;
  interrogator: Interrogator;
  issues: IssueFiler;
  /** Injected so a test can move the clock past the day mark without waiting a day. */
  now?: number;
  compilerVersion?: string;
  log?: (line: string) => void;
  assertions?: AssertionDefinition[];
};

export type AssertionOutcome = {
  assertion: string;
  person: string | null;
  subject: string;
  why: Due['why'];
  /** Null when the interrogator could not be reached — neither a pass nor a failure. */
  passed: boolean | null;
  detail: string;
};

export type InterrogationReport = {
  compiler_version: string;
  asked: AssertionOutcome[];
  /** Faults opened or extended on this run. */
  failing: string[];
  /** Faults that cleared because their assertion passed. */
  cleared: string[];
  /** Issues filed this run, by fault key and kind. */
  filed: { fault: string; kind: 'opened' | 'escalated'; issue: string | null }[];
};

/**
 * One interrogation run: ask what is due, record every verdict, and tell somebody about
 * anything that failed.
 *
 * Called from the scheduled job after the ingest cycle, which is what makes the weekly arm
 * real without a second deployment. It is the job's last act rather than its first because
 * a rebuild that just ran is the Persona worth asking about.
 */
export async function runInterrogation(deps: InterrogationDeps): Promise<InterrogationReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now();
  const compilerVersion = deps.compilerVersion ?? COMPILER_VERSION;

  const fleet = await servingFleet(deps.db);
  const due = dueAssertions({
    fleet,
    // Whoever the base model knows best, stood in for by the largest Corpus. See ./schedule.ts.
    hardest: fleet[0]?.person ?? null,
    last: await lastInterrogations(deps.db),
    compilerVersion,
    now,
    ...(deps.assertions ? { assertions: deps.assertions } : {}),
  });

  const report: InterrogationReport = {
    compiler_version: compilerVersion,
    asked: [],
    failing: [],
    cleared: [],
    filed: [],
  };

  for (const item of due) {
    const outcome = await ask(deps, item, compilerVersion, log);
    report.asked.push(outcome);

    if (outcome.passed === null) continue;

    if (outcome.passed) {
      await clearFault(deps.db, item.assertion.id, item.person);
      report.cleared.push(item.assertion.id);
    } else {
      await openFault(deps.db, {
        assertion: item.assertion.id,
        person: item.person,
        detail: outcome.detail,
      });
      report.failing.push(item.assertion.id);
    }
  }

  await tell(deps, report, now, compilerVersion, log);
  return report;
}

/**
 * One assertion, asked.
 *
 * **An endpoint braintrust cannot reach opens no fault.** It is not evidence that a Persona
 * is inventing claims, and treating it as one would file an issue every time a synthesiser
 * had a bad afternoon — the exact failure mode the gate avoids by refusing to run semantic
 * checks. Nothing is recorded either, so the assertion stays due and the next run asks again.
 */
async function ask(
  deps: InterrogationDeps,
  item: Due,
  compilerVersion: string,
  log: (line: string) => void,
): Promise<AssertionOutcome> {
  let subject: InterrogationSubject;
  try {
    subject = await subjectFor(deps.db, item.subject);
  } catch (error) {
    return unreachable(item, `${item.subject} could not be loaded: ${message(error)}`, log);
  }

  let result;
  try {
    result = await item.assertion.run(subject, deps.interrogator);
  } catch (error) {
    return unreachable(item, message(error), log);
  }

  await recordInterrogation(deps.db, {
    assertion: item.assertion.id,
    person: item.person,
    subject: item.subject,
    compiler_version: compilerVersion,
    interrogator: deps.interrogator.generation,
    passed: result.passed,
    detail: result.detail,
  });

  return { ...outcomeOf(item), passed: result.passed, detail: result.detail };
}

function unreachable(item: Due, detail: string, log: (line: string) => void): AssertionOutcome {
  log(
    `braintrust: ${item.assertion.id} could not be asked — ${detail}. Nothing was concluded ` +
      'and it stays due.',
  );
  return { ...outcomeOf(item), passed: null, detail };
}

function outcomeOf(item: Due): Omit<AssertionOutcome, 'passed' | 'detail'> {
  return {
    assertion: item.assertion.id,
    person: item.person,
    subject: item.subject,
    why: item.why,
  };
}

/**
 * The Persona as a client receives it: the Script rendered through the read path, the claims
 * braintrust holds, and the empty answer this Persona would serve.
 *
 * **Rendered rather than described**, the same rule the gate follows on `speak`. An
 * interrogation of a lookalike would be interrogating something nobody serves, which is the
 * one way every assertion here could pass while a reader hears something else entirely.
 */
async function subjectFor(db: Db, person: string): Promise<InterrogationSubject> {
  const persona = await loadPersona(db, person);
  const claims = await claimsHeldFor(db, person);

  return {
    person,
    subject: persona.subject,
    speak: persona.speak,
    claims: claims.map((claim) => claim.statement),
    nothing_matched: nothingMatched({
      nearest_similarity: null,
      floor: RETRIEVAL_FLOOR,
      nearest: claims.slice(0, NEAREST_ON_EMPTY),
    }) as unknown as Record<string, unknown>,
  };
}

/**
 * Files what is owing, and marks it filed only if it actually was.
 *
 * The ledger is read fresh rather than derived from this run's outcomes, because a fault
 * opened three runs ago is exactly the one whose day is up now — the escalation is a
 * property of how long a fault has existed, not of what just happened.
 */
async function tell(
  deps: InterrogationDeps,
  report: InterrogationReport,
  now: number,
  compilerVersion: string,
  log: (line: string) => void,
): Promise<void> {
  const faults = await openFaults(deps.db);

  for (const filing of faultsToFile(faults, now)) {
    const assertion = (deps.assertions ?? ASSERTIONS).find(
      (one) => one.id === filing.fault.assertion,
    );
    const input = {
      assertion: filing.fault.assertion,
      guarantees: assertion?.guarantees ?? 'unknown — this assertion no longer exists in the code',
      person: filing.fault.person,
      subject: filing.fault.person ?? 'the fleet',
      detail: filing.fault.detail,
      compilerVersion,
      interrogator: deps.interrogator.generation,
      firstFailedAt: filing.fault.first_failed_at,
      withdraws: assertion?.withdraws ?? [],
    };

    const issue =
      filing.kind === 'opened'
        ? await deps.issues.file(faultIssue(input))
        : await deps.issues.file(escalationIssue(input));

    // **Only a filing that happened counts as told.** A null means the tracker refused or is
    // not configured, and marking it reported anyway would retire the loudest thing
    // braintrust can say after nobody heard it.
    if (issue !== null) {
      if (filing.kind === 'opened') await markReported(deps.db, filing.fault.key, issue);
      else await markEscalated(deps.db, filing.fault.key, issue);
    }

    report.filed.push({ fault: filing.fault.key, kind: filing.kind, issue });
    log(
      `braintrust: ${filing.fault.assertion} ${
        filing.kind === 'opened' ? 'failed' : 'has been failing for over a day'
      } — ${issue ?? `nothing was filed; ${deps.issues.where}`}`,
    );
  }
}

/** One line for a job nobody watches. Silence when nothing was due is the normal case. */
export function summariseInterrogation(report: InterrogationReport): string | null {
  if (report.asked.length === 0 && report.filed.length === 0) return null;

  const failed = report.asked.filter((one) => one.passed === false);
  const unreached = report.asked.filter((one) => one.passed === null);

  return [
    `braintrust: interrogated itself on ${report.asked.length} assertion(s) — ` +
      `${report.asked.length - failed.length - unreached.length} passed, ${failed.length} failed` +
      `${unreached.length > 0 ? `, ${unreached.length} could not be asked` : ''}.`,
    ...failed.map((one) => `  ${one.assertion}: ${one.detail}`),
    ...report.filed.map(
      (one) =>
        `  ${one.kind === 'opened' ? 'filed' : 'escalated'} ${one.fault} — ${one.issue ?? 'not filed'}`,
    ),
  ].join('\n');
}

/** Never a stack, and never nothing. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

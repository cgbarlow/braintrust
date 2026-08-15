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
import { nothingMatched, NEAREST_ON_EMPTY, RETRIEVAL_FLOOR, type UnreadItem } from '../find.js';
import { loadPersona } from '../personas.js';
import { NOT_READ } from '../recent.js';
import { BraintrustError } from '../errors.js';
import {
  ASSERTIONS,
  faultById,
  type AssertionDefinition,
  type InterrogationSubject,
  type Interrogator,
} from './assertions.js';
import { escalationIssue, faultIssue, silenceIssue, type IssueFiler } from './issues.js';
import { dueAssertions, faultsToFile, silencesToFile, type Due } from './schedule.js';
import {
  clearFault,
  clearSilence,
  claimsHeldFor,
  corpusItems,
  lastInterrogations,
  markEscalated,
  markReported,
  markSilencesReported,
  openFault,
  openFaults,
  openSilences,
  recordInterrogation,
  recordSilence,
  servingFleet,
} from './store.js';

export {
  ASSERTIONS,
  assertionById,
  assertionIds,
  faultById,
  INTERROGATION_VERSION,
  REGISTERED_FAULTS,
} from './assertions.js';
export type {
  AssertionDefinition,
  AssertionScope,
  RegisteredFault,
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
  silenceIssue,
  type IssueFiler,
  type Issue,
} from './issues.js';
export {
  dueAssertions,
  ESCALATES_AFTER_MS,
  faultKey,
  faultsToFile,
  silenceKey,
  SILENCE_REPORTS_AFTER_MS,
  silencesToFile,
  SWEEP_INTERVAL_MS,
  withdrawnLayers,
  type Due,
  type Fault,
  type FleetSubject,
  type LastRun,
  type Silence,
} from './schedule.js';
export { escalatedFaults, openFaults, openSilences, servingFleet } from './store.js';

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
  /** Silences counted this run: assertions that could not be asked at all. */
  silenced: string[];
  /** The one issue a day-long outage files, if this run is the one that filed it. */
  outage: { assertions: string[]; issue: string | null } | null;
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
    // The live Faults are the population asked again now: the ones currently costing a
    // reader something, which shrink to nothing when braintrust is healthy. See ./schedule.ts.
    faults: await openFaults(deps.db),
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
    silenced: [],
    outage: null,
  };

  for (const item of due) {
    const outcome = await ask(deps, item, compilerVersion, log);
    report.asked.push(outcome);

    if (outcome.passed === null) {
      // **Counted, not merely logged.** The clock starts here and runs on consecutive failed
      // attempts; the row is the durable record that a guarantee went unverified.
      await recordSilence(deps.db, {
        assertion: item.assertion.id,
        person: item.person,
        detail: outcome.detail,
      });
      report.silenced.push(item.assertion.id);
      continue;
    }

    // An answer arrived, so this assertion is not going unchecked — whichever way it went.
    await clearSilence(deps.db, item.assertion.id, item.person);

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
  await tellAboutTheSilence(deps, report, now, compilerVersion, log);
  return report;
}

/**
 * One assertion, asked.
 *
 * **An endpoint braintrust cannot reach opens no fault.** It is not evidence that a Persona
 * is inventing claims, and treating it as one would file an issue every time a synthesiser
 * had a bad afternoon — the exact failure mode the gate avoids by refusing to run semantic
 * checks. No interrogation row is written either, so the assertion stays due and the next run
 * asks again — which is what makes the silence clock a daily count of attempts.
 *
 * **What it does leave is a counted row in the silence ledger**, because *nothing concluded*
 * and *nothing recorded* turned out to be two different decisions and only the first was
 * meant. See ./schedule.ts and https://github.com/cgbarlow/braintrust/issues/201.
 *
 * **A judge that answers without a usable verdict lands here too**, on the same clock and in
 * the same issue. Every error path is one bucket — transport error, HTTP 500, non-JSON body,
 * empty content, and a verdict with no boolean in it — so a dead endpoint and a broken judge
 * are distinguishable only from the reason text, which the issue carries. That is the
 * decision rather than an accident of error handling.
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
  const items = await corpusItems(db, person);
  const unread = await unreadItems(db, person);

  return {
    person,
    subject: persona.subject,
    speak: persona.speak,
    claims: claims.map((claim) => claim.statement),
    nothing_matched: nothingMatched({
      nearest_similarity: null,
      floor: RETRIEVAL_FLOOR,
      nearest: claims.slice(0, NEAREST_ON_EMPTY),
      unread,
    }) as unknown as Record<string, unknown>,
    items,
    unread: unread.length > 0 ? unread : undefined,
  };
}

/**
 * The most recent unread Items for a Person, with their not-read reasons and say lines.
 *
 * Used only by the interrogation subject, so the
 * `an_empty_answer_names_unread_items` assertion can ask about them.
 */
async function unreadItems(
  db: Db,
  slug: string,
): Promise<UnreadItem[]> {
  const { rows } = await db.query<{
    title: string | null;
    url: string;
    published_at: string | null;
    retrieval: string;
  }>(
    `select i.title, i.url, i.published_at::text as published_at, i.retrieval
       from braintrust_items i
       join braintrust_sources s on s.id = i.source_id
       join braintrust_people p on p.id = s.person_id
       left join lateral (
         select argument_md, claims
           from braintrust_item_notes
          where item_id = i.id
          order by created_at desc
          limit 1
       ) n on true
      where p.slug = $1
        and i.title is not null
        and (i.retrieval != 'retrieved' or (i.retrieval = 'retrieved'
             and n.argument_md is null and n.claims is null))
      order by i.published_at desc nulls last
      limit ${NEAREST_ON_EMPTY}`,
    [slug],
  );

  return rows.map((row) => {
    const reason = row.retrieval === 'retrieved' ? 'pending' : row.retrieval;
    return {
      title: row.title,
      url: row.url,
      published_at: row.published_at,
      reason,
      say: NOT_READ[reason] ?? 'braintrust has not read it',
    };
  });
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
    // The registry is the only place that decides what a fault means. A fault whose name the
    // registry does not know should never have been opened — it would have been refused at
    // `openFault` — so reaching one here is a bug in the ledger to fail loudly on rather
    // than an assertion to file with "unknown" in the place of its guarantee.
    const registered = faultById(filing.fault.assertion);
    if (!registered) {
      throw new BraintrustError(
        `braintrust cannot file a fault for an assertion the registry does not know ` +
          `(${filing.fault.assertion}). It should not have been possible to open it; see ` +
          `openFault.`,
      );
    }
    const input = {
      assertion: filing.fault.assertion,
      guarantees: registered.guarantees,
      person: filing.fault.person,
      subject: filing.fault.person ?? 'the fleet',
      detail: filing.fault.detail,
      compilerVersion,
      interrogator: deps.interrogator.generation,
      firstFailedAt: filing.fault.first_failed_at,
      withdraws: registered.withdraws,
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

/**
 * Tells somebody, once, that braintrust has not been able to interrogate itself for a day.
 *
 * **A separate arm from {@link tell} and it never touches a fault.** An assertion that could
 * not be asked concludes nothing about a Persona, so this opens no fault, withdraws no layer
 * and names no Person — it is one issue about braintrust's own plumbing, listing what went
 * unchecked, filed once and never repeated while the ledger stays open.
 *
 * The ledger is read fresh for the same reason the fault ledger is: the outage whose day is up
 * now is mostly made of runs that already happened.
 */
async function tellAboutTheSilence(
  deps: InterrogationDeps,
  report: InterrogationReport,
  now: number,
  compilerVersion: string,
  log: (line: string) => void,
): Promise<void> {
  const owing = silencesToFile(await openSilences(deps.db, log), now);
  if (owing.length === 0) return;

  // One line per assertion, however many subjects it was lost on — the issue is about an
  // outage, and five personas lost to one endpoint is one row, not five names.
  type Line = { assertion: string; attempts: number; subjects: number; detail: string };
  const byAssertion = new Map<string, Line>();
  for (const silence of owing) {
    const seen = byAssertion.get(silence.assertion);
    if (seen) {
      seen.subjects += 1;
      seen.attempts = Math.max(seen.attempts, silence.attempts);
    } else {
      byAssertion.set(silence.assertion, {
        assertion: silence.assertion,
        attempts: silence.attempts,
        subjects: 1,
        detail: silence.detail,
      });
    }
  }

  // The oldest clock in the ledger: when braintrust last got an answer out of the judge.
  const since = owing.reduce(
    (oldest, one) =>
      Date.parse(one.first_failed_at) < Date.parse(oldest) ? one.first_failed_at : oldest,
    owing[0]!.first_failed_at,
  );

  const issue = await deps.issues.file(
    silenceIssue({
      silences: [...byAssertion.values()],
      since,
      compilerVersion,
      interrogator: deps.interrogator.generation,
    }),
  );

  // **Only a filing that happened counts as told**, the same rule the fault arm follows: a
  // null means nobody was reached, and marking it reported would retire the only record that
  // the central guarantee is going unverified.
  if (issue !== null) {
    await markSilencesReported(deps.db, owing.map((one) => one.key), issue, log);
  }

  report.outage = { assertions: [...byAssertion.keys()], issue };
  log(
    `braintrust: could not interrogate itself for over a day — ${owing.length} assertion(s) ` +
      `unchecked — ${issue ?? `nothing was filed; ${deps.issues.where}`}`,
  );
}

/** The reasons an assertion was asked, in the order they read naturally on one line. */
const ASKED_WHY_WORDS: Record<Due['why'], string> = {
  never_asked: 'never asked',
  compiler_moved: 'because the compiler moved',
  recompiled: 'because a persona was rebuilt',
  // The reason the extra calls exist at all: a fault is live, and a reader is paying for it
  // until one of these passes. Distinguishing it from the sweep keeps the cost legible.
  fault_open: 'because a fault is open',
  weekly_sweep: 'on the weekly sweep',
};

/** One line for a job nobody watches. Silence when nothing was due is the normal case. */
export function summariseInterrogation(report: InterrogationReport): string | null {
  if (report.asked.length === 0 && report.filed.length === 0 && report.outage === null) return null;

  const failed = report.asked.filter((one) => one.passed === false);
  const unreached = report.asked.filter((one) => one.passed === null);

  // What pushed each ask out, so a maintainer can read *why there were calls today* — the
  // fault-open ones are the extra cost and the sweep ones are the standing weekly rate.
  const askedWhy = (
    ['never_asked', 'compiler_moved', 'recompiled', 'fault_open', 'weekly_sweep'] as const
  )
    .map((why) => ({ why, count: report.asked.filter((one) => one.why === why).length }))
    .filter((one) => one.count > 0)
    .map((one) => `${one.count} ${ASKED_WHY_WORDS[one.why]}`)
    .join(', ');

  return [
    `braintrust: interrogated itself on ${report.asked.length} assertion(s) — ` +
      `${report.asked.length - failed.length - unreached.length} passed, ${failed.length} failed` +
      `${unreached.length > 0 ? `, ${unreached.length} could not be asked` : ''}` +
      `${askedWhy.length > 0 ? ` (${askedWhy})` : ''}.`,
    ...failed.map((one) => `  ${one.assertion}: ${one.detail}`),
    ...report.filed.map(
      (one) =>
        `  ${one.kind === 'opened' ? 'filed' : 'escalated'} ${one.fault} — ${one.issue ?? 'not filed'}`,
    ),
    ...(report.outage
      ? [
          `  unasked for over a day: ${report.outage.assertions.join(', ')} — ` +
            `${report.outage.issue ?? 'not filed'}`,
        ]
      : []),
  ].join('\n');
}

/** Never a stack, and never nothing. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

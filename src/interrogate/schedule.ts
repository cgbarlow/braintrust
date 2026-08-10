/**
 * When the interrogation runs, when a fault is worth telling anyone about, and when an
 * unrepaired one stops being invisible to a reader.
 *
 * **Everything here is a pure function of rows and a clock**, which is the point: the four
 * things this ticket has to be able to prove — the schedule, the deduplication, the one-day
 * escalation and the one-day silence — are all decided here, and none of them needs a model
 * to run.
 *
 * See docs/design/compiler.md §7.
 */

import type { AssertionDefinition } from './assertions.js';
import { ASSERTIONS, assertionById } from './assertions.js';

/**
 * How long an assertion may go unasked before it is asked again, whatever braintrust's own
 * version says.
 *
 * **The sweep exists because the synthesiser is a third party.** Every other clock in
 * braintrust is driven by something braintrust changed — new items, a compiler bump — and
 * the one failure this whole surface exists to catch moves with no version of braintrust's
 * changing at all. A week is a rate, not a finding: four model calls a week against one
 * subject is cheap enough not to need arguing about, and short enough that a synthesiser
 * that quietly got better at faking people is caught in days rather than at the next release.
 */
export const SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The outer limit on an unrepaired fault, measured in **time rather than attempts**.
 *
 * Attempts is the wrong unit for the same reason it was the wrong unit for staleness: a job
 * that stops running stops counting attempts, and the reader is the one who pays. A day is
 * how long braintrust will knowingly serve a Persona it has judged to be inventing claims
 * before the affected part goes absent — long enough for a maintainer to ship a fix, short
 * enough that nobody reads a broken Persona for a week without noticing.
 */
export const ESCALATES_AFTER_MS = 24 * 60 * 60 * 1000;

/** The newest interrogation of one assertion against one fault key. */
export type LastRun = {
  assertion: string;
  /** Null for a compiler-scoped assertion: it is one fact about the fleet, not five. */
  person: string | null;
  compiler_version: string;
  ran_at: string;
};

export type Due = {
  assertion: AssertionDefinition;
  /** The fault key's person — null for compiler scope. */
  person: string | null;
  /** Who it is actually asked against. Never null: an assertion needs a Persona to hold. */
  subject: string;
  why: 'never_asked' | 'compiler_moved' | 'recompiled' | 'weekly_sweep';
};

/** One serving Persona, and the two facts that decide whether it is due. */
export type FleetSubject = { person: string; compiled_at: string | null };

/**
 * What is due now.
 *
 * **On compiler change plus a weekly sweep**, and the two arms answer different questions:
 * the version arm asks whether braintrust's own change broke something, the sweep asks
 * whether somebody else's did.
 *
 * `hardest` is who the compiler-scoped assertions are asked against — *whoever the base model
 * knows best*, since three of them are true or false about braintrust and the fourth is the
 * one that varies. braintrust cannot measure how famous somebody is, so it uses the largest
 * Corpus as the stand-in and says so: the most-published Person in a council is the one a base
 * model is most likely to have read, which makes them the least forgiving subject available.
 *
 * **The persona-scoped assertion has a third trigger the other three do not: a rebuild.** It
 * is judged against the claims braintrust holds for somebody, and a Compile changes those, so
 * *once per compiler version* would be asking about a Persona that no longer exists. The
 * compiler-scoped three are about the payload's shape and a rebuild does not move it.
 */
export function dueAssertions(input: {
  fleet: FleetSubject[];
  hardest: string | null;
  last: LastRun[];
  compilerVersion: string;
  now: number;
  assertions?: AssertionDefinition[];
}): Due[] {
  const assertions = input.assertions ?? ASSERTIONS;
  const due: Due[] = [];

  for (const assertion of assertions) {
    const subjects: { person: string | null; subject: string; compiledAt: string | null }[] =
      assertion.scope === 'persona'
        ? input.fleet.map((member) => ({
            person: member.person,
            subject: member.person,
            compiledAt: member.compiled_at,
          }))
        : input.hardest === null
          ? []
          : [{ person: null, subject: input.hardest, compiledAt: null }];

    for (const { person, subject, compiledAt } of subjects) {
      const why = whyDue(
        input.last.find((run) => run.assertion === assertion.id && run.person === person),
        input.compilerVersion,
        compiledAt,
        input.now,
      );
      if (why) due.push({ assertion, person, subject, why });
    }
  }

  return due;
}

function whyDue(
  last: LastRun | undefined,
  compilerVersion: string,
  compiledAt: string | null,
  now: number,
): Due['why'] | null {
  if (!last) return 'never_asked';
  if (last.compiler_version !== compilerVersion) return 'compiler_moved';
  if (compiledAt !== null && Date.parse(last.ran_at) < Date.parse(compiledAt)) return 'recompiled';
  if (now - Date.parse(last.ran_at) >= SWEEP_INTERVAL_MS) return 'weekly_sweep';
  return null;
}

/**
 * A fault as it is carried between runs: one row per assertion per subject, opened on the
 * first failure and deleted on the first pass.
 *
 * **The row is the deduplication.** A fault that is already open does not open a second
 * issue, however many runs re-observe it, because "has this been reported" is a stored fact
 * rather than a search of the issue tracker. What that buys is a guarantee that holds with no
 * network; what it costs is named on {@link faultsToFile}.
 */
export type Fault = {
  key: string;
  assertion: string;
  person: string | null;
  detail: string;
  first_failed_at: string;
  last_failed_at: string;
  reported_at: string | null;
  escalated_at: string | null;
};

/** Assertion plus subject. A compiler fault is one fault, not one per Person. */
export function faultKey(assertion: string, person: string | null): string {
  return `${assertion}:${person ?? '*'}`;
}

export type FaultFiling = { fault: Fault; kind: 'opened' | 'escalated' };

/**
 * Which faults have an issue owing, and which kind.
 *
 * **Two filings per fault, at most, ever.** One when it is first seen, one when it has
 * survived a day. A fault re-observed every run for a month is one issue and then a second,
 * because the audience is a maintainer reading a repo rather than a monitor with a mute
 * button.
 *
 * **Accepted cost:** a maintainer who closes the first issue without shipping a fix is never
 * told again by the opening arm — braintrust's ledger clears on a *pass*, not on an issue
 * being closed. The escalation is what stops that being silent, and after it the Persona
 * itself is visibly missing a part.
 */
export function faultsToFile(faults: Fault[], now: number): FaultFiling[] {
  const filings: FaultFiling[] = [];

  for (const fault of faults) {
    if (fault.reported_at === null) filings.push({ fault, kind: 'opened' });
    if (fault.escalated_at === null && hasOutlivedTheLimit(fault, now)) {
      filings.push({ fault, kind: 'escalated' });
    }
  }

  return filings;
}

export function hasOutlivedTheLimit(fault: Fault, now: number): boolean {
  return now - Date.parse(fault.first_failed_at) >= ESCALATES_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Silence: the third status
// ---------------------------------------------------------------------------

/**
 * How long braintrust will fail to *ask* before somebody is told, measured in **consecutive
 * failed attempts rather than staleness**.
 *
 * **The same day as {@link ESCALATES_AFTER_MS}, deliberately.** A staleness clock would have
 * to be a multiple of the weekly sweep to mean anything, and the first figure this was worked
 * out as — two weeks — reached a maintainer fourteen times slower for nothing. Attempts are
 * the honest unit here for the reason they were the wrong unit there: an assertion that could
 * not be asked **stays due**, so it is retried on every run whatever the sweep interval says,
 * and a job that stops running stops the silence rather than hiding it.
 *
 * **Worst case is a little over the day**, and that is the design: if nothing is due while the
 * endpoint is down, the check comes due at the sweep, fails, and files a day after that.
 */
export const SILENCE_REPORTS_AFTER_MS = ESCALATES_AFTER_MS;

/**
 * An assertion that could not be asked, carried between runs.
 *
 * **A Silence is never a Fault and the two ledgers never meet.** Treating an unaskable
 * assertion as a failure would open faults against five people on the strength of somebody
 * else's outage — so nothing here is keyed to a Compile, nothing here withdraws a layer, and
 * {@link withdrawnLayers} does not read it. What it is instead is the durable, counted record
 * that a guarantee went unverified, which is the whole of what was missing.
 *
 * `attempts` is kept because *how many times* is the question a maintainer asks first and a
 * log line in a job nobody watches cannot answer.
 */
export type Silence = {
  key: string;
  assertion: string;
  person: string | null;
  /** The most recent reason. A dead endpoint and a broken judge are told apart only here. */
  detail: string;
  attempts: number;
  first_failed_at: string;
  last_failed_at: string;
  reported_at: string | null;
  reported_issue: string | null;
};

/**
 * Assertion plus subject, the same shape a fault key has and a different table.
 *
 * Not {@link faultKey} reused: the one thing this ticket must not be able to do is put a
 * Person in front of a maintainer for an outage that was never theirs, and two functions that
 * cannot be confused for one another is the cheapest way to keep the ledgers apart.
 */
export function silenceKey(assertion: string, person: string | null): string {
  return `${assertion}:${person ?? '*'}`;
}

/**
 * The silences owing an issue — **all of them or none of them**.
 *
 * **One issue per outage, not per check.** Six of eight assertions failing on one endpoint for
 * one reason is one thing that is broken; six issues would be one endpoint triaged six times
 * and would read as six faults where there is one. So the day mark is reached by the *oldest*
 * silence and the issue lists every assertion currently going unasked, including ones that
 * joined the outage this morning — they went unchecked too.
 *
 * **One filing, ever, while it stays open.** A single already-reported row silences the whole
 * arm: the ledger is the record, it clears only on an attempt that gets an answer, and a
 * monthly re-file was offered and declined as nagging rather than news.
 *
 * **Two accepted costs, recorded where the clock lives.** A lone check stuck for its own
 * reason while the rest of the fleet is fine is reported inside a general outage rather than
 * on its own — it joins the open filing and gets no issue of its own. And a maintainer who
 * closes the issue without shipping a fix is never told again, because braintrust never
 * reopens it and clears the ledger only on a successful ask.
 */
export function silencesToFile(silences: Silence[], now: number): Silence[] {
  if (silences.length === 0) return [];
  if (silences.some((silence) => silence.reported_at !== null)) return [];

  const outage = silences.some(
    (silence) => now - Date.parse(silence.first_failed_at) >= SILENCE_REPORTS_AFTER_MS,
  );

  return outage ? [...silences] : [];
}

/**
 * The layers a Persona may not serve because braintrust has judged itself and lost.
 *
 * **Nothing is withdrawn before the day is up.** A failing interrogation keeps the Persona
 * serving exactly as it was: the fault is the compiler's, equal across the fleet, and one
 * live call to a non-reproducible synthesiser is evidence rather than proof. A payload
 * warning was rejected for the same reason — a permanent piece of furniture bought for a
 * transient condition. What changes at the day mark is not a warning but an absence, which is
 * the one thing on this map a reader reliably trips over.
 *
 * A compiler fault withdraws from everyone, because that is what compiler-scope means; a
 * persona fault withdraws from that Person only.
 */
export function withdrawnLayers(faults: Fault[], person: string): string[] {
  const layers = faults
    .filter((fault) => fault.escalated_at !== null)
    .filter((fault) => fault.person === null || fault.person === person)
    .flatMap((fault) => assertionById(fault.assertion)?.withdraws ?? []);

  return [...new Set(layers)].sort();
}

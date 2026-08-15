/**
 * The interrogation's three tables, and the read the serving path makes against one of them.
 *
 * **Nothing here touches a Compile.** That is the guarantee this ticket is mostly made of:
 * a Persona that fails its interrogation keeps serving unchanged, so the interrogation
 * writes verdicts and faults and never a `status`, a layer or a version. A test proving it
 * only has to watch which tables are written.
 *
 * Faults key on the Person's **slug** rather than their id, and carry no foreign key. A
 * compiler fault is about braintrust and outlives any particular Person, and a fault about
 * somebody who has since been unfollowed is still a fault a maintainer wants to read.
 *
 * The third table is the silence ledger, and it is a separate table rather than a nullable
 * column on the second because a Silence is **never a Fault**: an assertion that could not be
 * asked is somebody else's outage, it is evidence against nobody, and it must not be capable
 * of withdrawing a layer or naming a Person. Two tables that nothing joins is what makes that
 * checkable rather than promised.
 */

import type { Db } from '../db.js';
import { BraintrustError } from '../errors.js';
import { faultById } from './assertions.js';
import { faultKey, silenceKey, type Fault, type LastRun, type Silence } from './schedule.js';

export type InterrogationRun = {
  assertion: string;
  /** Null for a compiler-scoped assertion. */
  person: string | null;
  /** Who it was actually asked against, which for a compiler assertion is not `person`. */
  subject: string;
  compiler_version: string;
  interrogator: string;
  passed: boolean;
  detail: string;
};

/** One Persona in the fleet, with what decides who the hardest subject is. */
export type FleetMember = { person: string; items: number; compiled_at: string | null };

/**
 * Everyone currently serving, largest Corpus first.
 *
 * Paused people are excluded for the same reason they are excluded from the fleet version
 * check: a Persona nobody is serving is not a Persona braintrust is making claims about.
 *
 * `compiled_at` rides along because *can the model fake this individual* is asked **per
 * compile** rather than per compiler version — a rebuild changes the claims braintrust holds
 * for somebody, which is the thing that assertion is judged against.
 */
export async function servingFleet(db: Db): Promise<FleetMember[]> {
  const { rows } = await db.query<{
    person: string;
    items: string | number | null;
    compiled_at: Date | null;
  }>(
    `select p.slug as person,
            coalesce((c.corpus_stats ->> 'items_retrieved')::int, 0) as items,
            c.finished_at as compiled_at
       from braintrust_people p
       join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.paused_at is null
      order by items desc, p.slug asc`,
  );

  return rows.map((row) => ({
    person: row.person,
    items: Number(row.items ?? 0),
    compiled_at: row.compiled_at === null ? null : new Date(row.compiled_at).toISOString(),
  }));
}

/**
 * The claims braintrust holds for one Person: Position statements and through-lines, as the
 * sentences they are.
 *
 * Both, and not only Positions. A through-line is exactly the kind of claim a base model is
 * most likely to be able to guess — it is the broad thing somebody keeps coming back to —
 * and it is the half braintrust cannot quote, so leaving it out would aim the assertion at
 * the easier target.
 */
export async function claimsHeldFor(
  db: Db,
  person: string,
): Promise<{ slug: string; statement: string }[]> {
  const { rows } = await db.query<{ slug: string; statement: string }>(
    `select pos.slug, pos.statement
       from braintrust_positions pos
       join braintrust_compiles c on c.id = pos.compile_id and c.status = 'current'
       join braintrust_people p on p.id = c.person_id
      where p.slug = $1
      union
     select tl.slug, tl.statement
       from braintrust_through_lines tl
       join braintrust_compiles c on c.id = tl.compile_id and c.status = 'current'
       join braintrust_people p on p.id = c.person_id
      where p.slug = $1`,
    [person],
  );

  return rows;
}

/**
 * Recent items from a person's corpus with enough to verify sources against.
 *
 * The receipt-checking assertion uses these to generate questions and verify
 * claims. Only items that were actually retrieved and have body text are
 * returned — an item nobody read is not something a persona can cite.
 *
 * Ten items is a floor for question variety, not a budget: the sweep runs once
 * a week per person, and a single call is what is being spent here.
 */
export async function corpusItems(
  db: Db,
  person: string,
): Promise<{ title: string | null; url: string; body_text: string | null }[]> {
  const { rows } = await db.query<{
    title: string | null;
    url: string;
    body_text: string | null;
  }>(
    `select i.title, i.url, i.body_text
       from braintrust_items i
       join braintrust_sources s on s.id = i.source_id
       join braintrust_people p on p.id = s.person_id
      where p.slug = $1
        and i.retrieval = 'retrieved'
        and i.body_text is not null
      order by i.published_at desc nulls last, i.created_at desc
      limit 10`,
    [person],
  );
  return rows;
}

/** The newest run of each assertion against each fault key. What the schedule reads. */
export async function lastInterrogations(db: Db): Promise<LastRun[]> {
  const { rows } = await db.query<{
    assertion: string;
    person: string | null;
    compiler_version: string;
    ran_at: Date;
  }>(
    `select distinct on (assertion, person_slug)
            assertion, person_slug as person, compiler_version, ran_at
       from braintrust_interrogations
      order by assertion, person_slug, ran_at desc`,
  );

  return rows.map((row) => ({ ...row, ran_at: row.ran_at.toISOString() }));
}

/** Every verdict is kept. A failure that opens an issue has to be readable afterwards. */
export async function recordInterrogation(db: Db, run: InterrogationRun): Promise<void> {
  await db.query(
    `insert into braintrust_interrogations
            (assertion, person_slug, subject_slug, compiler_version, interrogator, passed, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      run.assertion,
      run.person,
      run.subject,
      run.compiler_version,
      run.interrogator,
      run.passed,
      run.detail,
    ],
  );
}

/**
 * Opens the fault or extends it, and returns it either way.
 *
 * **`first_failed_at` is never moved.** It is the clock the one-day limit runs on, so a fault
 * that is re-observed every run must not keep resetting its own deadline — that is precisely
 * how an escalation never fires.
 */
export async function openFault(
  db: Db,
  fault: { assertion: string; person: string | null; detail: string },
): Promise<Fault> {
  // **The registry is the only place that decides what a fault name means.** A fault is the
  // one place braintrust says what a failure was protecting, so a fault under a name the
  // registry does not know is a coding error — and it is refused here, the moment it would
  // be opened, rather than degrading to "unknown" at the later moment the issue is filed.
  // See https://github.com/cgbarlow/braintrust/issues/277.
  if (!faultById(fault.assertion)) {
    throw new BraintrustError(
      `braintrust refuses to open a fault under "${fault.assertion}" — it is not a name the ` +
        'assertion registry knows. A fault must be registered (with a stated guarantee and a ' +
        'withdrawal list) before it can open, so a Fault report never has to explain its own ' +
        'missing information.',
    );
  }

  const { rows } = await db.query<FaultRow>(
    `insert into braintrust_faults (fault_key, assertion, person_slug, detail)
          values ($1, $2, $3, $4)
     on conflict (fault_key) do update
            set last_failed_at = now(),
                detail = excluded.detail
      returning *`,
    [faultKey(fault.assertion, fault.person), fault.assertion, fault.person, fault.detail],
  );

  return asFault(rows[0]!);
}

/**
 * The assertion passed, so the fault is over.
 *
 * Deleted rather than marked cleared. A fault is a live condition, and keeping the corpse
 * would mean every read of the ledger has to remember to filter it — the interrogation rows
 * are the history, and they are already kept.
 */
export async function clearFault(db: Db, assertion: string, person: string | null): Promise<void> {
  await db.query(`delete from braintrust_faults where fault_key = $1`, [
    faultKey(assertion, person),
  ]);
}

export async function markReported(db: Db, key: string, issue: string | null): Promise<void> {
  await db.query(
    `update braintrust_faults set reported_at = now(), reported_issue = $2 where fault_key = $1`,
    [key, issue],
  );
}

export async function markEscalated(db: Db, key: string, issue: string | null): Promise<void> {
  await db.query(
    `update braintrust_faults set escalated_at = now(), escalated_issue = $2 where fault_key = $1`,
    [key, issue],
  );
}

export async function openFaults(db: Db): Promise<Fault[]> {
  const { rows } = await db.query<FaultRow>(
    `select * from braintrust_faults order by first_failed_at asc`,
  );
  return rows.map(asFault);
}

/**
 * The faults that have outlived the day, for the read path.
 *
 * Its own query rather than a filter over {@link openFaults}, because this one runs on every
 * `braintrust_load_persona` and the answer is almost always no rows.
 *
 * **It fails open, and that is the rule rather than a defensive habit.** The whole of this
 * surface rests on one decision: *braintrust judging itself must never change what a Persona
 * serves.* A ledger braintrust cannot read is the limit case of that — it is not evidence
 * against any Persona, so the honest answer is *no fault is known* and the Persona serves as
 * it did.
 *
 * **Found in production, on the first deploy of this file.** The table did not exist yet —
 * `schema.sql` is pasted by hand and the code deploys on merge, so the read path referenced a
 * table that had not been created, and every `braintrust_load_persona` failed. The order of
 * those two steps is not something the read path can assume, and it should never have been
 * the difference between a Persona serving and not.
 *
 * The absence is logged rather than swallowed. Failing open is the correct answer to a
 * missing ledger; it is the wrong answer to nobody noticing the ledger is missing.
 */
export async function escalatedFaults(db: Db, log = console.error): Promise<Fault[]> {
  try {
    const { rows } = await db.query<FaultRow>(
      `select * from braintrust_faults where escalated_at is not null order by first_failed_at asc`,
    );
    return rows.map(asFault);
  } catch (error) {
    log(
      'braintrust: could not read the fault ledger — ' +
        `${error instanceof Error ? error.message : String(error)}. Serving as though no fault ` +
        'is known, because braintrust judging itself may never be the reason a persona stops ' +
        'answering. If this is "relation does not exist", schema.sql has not been run.',
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// The silence ledger
// ---------------------------------------------------------------------------

/**
 * Every read and write of the silence ledger, wrapped so a missing table cannot take the
 * interrogation down with it.
 *
 * **This is #187's lesson applied before it costs anything.** `schema.sql` is pasted by hand
 * and the code deploys on merge, so between those two steps this table does not exist — and
 * the run that would have counted a silence would instead throw, taking the fault filing that
 * already worked with it. An un-migrated deployment degrades to exactly the behaviour this
 * ticket replaces (a log line) rather than to a broken job.
 *
 * Logged rather than swallowed, for the same reason: failing open is the right answer to a
 * missing ledger and the wrong answer to nobody noticing it is missing.
 */
async function silenceLedger<T>(what: string, fallback: T, run: () => Promise<T>, log: (line: string) => void): Promise<T> {
  try {
    return await run();
  } catch (error) {
    log(
      `braintrust: could not ${what} in the silence ledger — ` +
        `${error instanceof Error ? error.message : String(error)}. The interrogation carries on ` +
        'and nothing a persona serves is affected, but an assertion that cannot be asked is ' +
        'going uncounted. If this is "relation does not exist", schema.sql has not been run.',
    );
    return fallback;
  }
}

/**
 * Counts one attempt that could not be made, and starts the clock if it is the first.
 *
 * **`first_failed_at` is never moved and `attempts` only goes up.** The clock measures a run
 * of consecutive failures to ask, so a silence re-observed every morning must not keep
 * resetting the day it is being measured against — the same rule `braintrust_faults` learned,
 * for the same reason.
 *
 * **This writes nowhere else.** No interrogation row (which would make the assertion look
 * asked and stop it being due), no fault row, no Compile. An assertion that could not be asked
 * stays due and is retried on the next run, which is what makes attempts a daily count.
 */
export async function recordSilence(
  db: Db,
  silence: { assertion: string; person: string | null; detail: string },
  log = console.error,
): Promise<void> {
  await silenceLedger('count an assertion that could not be asked', undefined, async () => {
    await db.query(
      `insert into braintrust_silences (silence_key, assertion, person_slug, detail)
            values ($1, $2, $3, $4)
       on conflict (silence_key) do update
              set last_failed_at = now(),
                  attempts = braintrust_silences.attempts + 1,
                  detail = excluded.detail`,
      [
        silenceKey(silence.assertion, silence.person),
        silence.assertion,
        silence.person,
        silence.detail,
      ],
    );
  }, log);
}

/**
 * The assertion was asked and answered, so it is not going unchecked.
 *
 * **Any answer clears it, not only a passing one.** A failed verdict means the question was
 * put and something came back — that is a Fault, it has its own ledger and its own issue, and
 * leaving a silence row open beside it would eventually file *this went unchecked* about the
 * one thing braintrust checked hardest.
 *
 * Deleted rather than marked over, so a single bad night leaves no trace after the next
 * answer — including the record that it was reported, which is what lets the next outage file.
 */
export async function clearSilence(
  db: Db,
  assertion: string,
  person: string | null,
  log = console.error,
): Promise<void> {
  await silenceLedger('clear an assertion that has been answered', undefined, async () => {
    await db.query(`delete from braintrust_silences where silence_key = $1`, [
      silenceKey(assertion, person),
    ]);
  }, log);
}

export async function openSilences(db: Db, log = console.error): Promise<Silence[]> {
  return silenceLedger<Silence[]>('read what is going unasked', [], async () => {
    const { rows } = await db.query<SilenceRow>(
      `select * from braintrust_silences order by first_failed_at asc, silence_key asc`,
    );
    return rows.map(asSilence);
  }, log);
}

/**
 * Marks the whole outage told, in one statement, because it was told in one issue.
 *
 * Every key at once rather than one per row: a partial mark would leave an unreported silence
 * behind that files a second issue for the same outage tomorrow.
 */
export async function markSilencesReported(
  db: Db,
  keys: string[],
  issue: string,
  log = console.error,
): Promise<void> {
  if (keys.length === 0) return;
  await silenceLedger('mark an outage reported', undefined, async () => {
    await db.query(
      `update braintrust_silences
          set reported_at = now(), reported_issue = $2
        where silence_key = any($1::text[])`,
      [keys, issue],
    );
  }, log);
}

type FaultRow = {
  fault_key: string;
  assertion: string;
  person_slug: string | null;
  detail: string;
  first_failed_at: Date;
  last_failed_at: Date;
  reported_at: Date | null;
  escalated_at: Date | null;
};

type SilenceRow = {
  silence_key: string;
  assertion: string;
  person_slug: string | null;
  detail: string;
  attempts: string | number;
  first_failed_at: Date;
  last_failed_at: Date;
  reported_at: Date | null;
  reported_issue: string | null;
};

function asSilence(row: SilenceRow): Silence {
  return {
    key: row.silence_key,
    assertion: row.assertion,
    person: row.person_slug,
    detail: row.detail,
    attempts: Number(row.attempts),
    first_failed_at: iso(row.first_failed_at),
    last_failed_at: iso(row.last_failed_at),
    reported_at: row.reported_at === null ? null : iso(row.reported_at),
    reported_issue: row.reported_issue,
  };
}

function asFault(row: FaultRow): Fault {
  return {
    key: row.fault_key,
    assertion: row.assertion,
    person: row.person_slug,
    detail: row.detail,
    first_failed_at: iso(row.first_failed_at),
    last_failed_at: iso(row.last_failed_at),
    reported_at: row.reported_at === null ? null : iso(row.reported_at),
    escalated_at: row.escalated_at === null ? null : iso(row.escalated_at),
  };
}

/** Dates arrive from pg as `Date` and from a fake as whatever the test wrote. */
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

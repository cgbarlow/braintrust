/**
 * The interrogation's two tables, and the read the serving path makes against one of them.
 *
 * **Nothing here touches a Compile.** That is the guarantee this ticket is mostly made of:
 * a Persona that fails its interrogation keeps serving unchanged, so the interrogation
 * writes verdicts and faults and never a `status`, a layer or a version. A test proving it
 * only has to watch which tables are written.
 *
 * Faults key on the Person's **slug** rather than their id, and carry no foreign key. A
 * compiler fault is about braintrust and outlives any particular Person, and a fault about
 * somebody who has since been unfollowed is still a fault a maintainer wants to read.
 */

import type { Db } from '../db.js';
import { faultKey, type Fault, type LastRun } from './schedule.js';

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
 */
export async function escalatedFaults(db: Db): Promise<Fault[]> {
  const { rows } = await db.query<FaultRow>(
    `select * from braintrust_faults where escalated_at is not null order by first_failed_at asc`,
  );
  return rows.map(asFault);
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

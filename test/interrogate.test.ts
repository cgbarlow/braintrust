/**
 * braintrust interrogates itself and files the issue.
 *
 * **Everything here runs without a live model**, which is the point: the assertions
 * themselves are one call to a synthesiser that is not reproducible and cannot be tested at
 * all, so what is held up here is the machinery around them — when they run, what a failure
 * does and does not change, who gets told, and what happens when nobody acts.
 *
 * The three that matter most, and each has its own describe below: the **schedule**, the
 * **deduplication**, and the **one-day escalation**.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMPILER_VERSION } from '../src/compile/version.js';
import type { Db, QueryResult } from '../src/db.js';
import { SPOKEN_DISCLOSURE } from '../src/disclosure.js';
import {
  ASSERTIONS,
  assertionIds,
  dueAssertions,
  ESCALATES_AFTER_MS,
  faultsToFile,
  runInterrogation,
  SWEEP_INTERVAL_MS,
  withdrawnLayers,
  type Fault,
  type Interrogation,
  type Interrogator,
  type LastRun,
} from '../src/interrogate/index.js';
import { escalationIssue, faultIssue, loggingIssueFiler, type Issue } from '../src/interrogate/issues.js';
import { escalatedFaults } from '../src/interrogate/store.js';
import { explainPersona, loadPersona } from '../src/personas.js';

const NOW = Date.parse('2026-08-08T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const DISCLOSURE_ASSERTION = 'the_first_reply_carries_the_disclosure';
const FAKING_ASSERTION = 'the_model_cannot_fake_this_individual';

// ---------------------------------------------------------------------------
// Stand-ins
// ---------------------------------------------------------------------------

type Asked = { exchange?: Interrogation; rubric?: string };

/**
 * A model that says whatever it is told to and judges however it is told to.
 *
 * Two knobs and no cleverness: an interrogator that tried to be realistic would be a second
 * implementation of the thing under test.
 */
function stubInterrogator(
  options: { reply?: string; holds?: boolean; throws?: string } = {},
): Interrogator & { asked: Asked[] } {
  const asked: Asked[] = [];

  return {
    asked,
    generation: 'stub@interrogation-1',
    async reply(exchange) {
      if (options.throws) throw new Error(options.throws);
      asked.push({ exchange });
      return options.reply ?? `${SPOKEN_DISCLOSURE}\n\nI could not look anything up.`;
    },
    async judge(rubric) {
      if (options.throws) throw new Error(options.throws);
      asked.push({ rubric });
      return { holds: options.holds ?? true, why: 'because the stub said so' };
    },
  };
}

function recordingFiler() {
  const filed: Issue[] = [];
  return {
    filed,
    where: 'a test',
    async file(issue: Issue) {
      filed.push(issue);
      return `https://example.invalid/issues/${filed.length}`;
    },
  };
}

/** A filer that never manages it — the misconfigured deployment. */
function refusingFiler() {
  const attempts: Issue[] = [];
  return {
    attempts,
    where: 'nowhere',
    async file(issue: Issue) {
      attempts.push(issue);
      return null;
    },
  };
}

type FaultSeed = Partial<Fault> & { assertion: string };

/**
 * The whole of the interrogation's storage, in memory: two tables, plus the handful of rows
 * the read path needs to render a Persona.
 *
 * Answers by matching the SQL it is given, which is fragile in the way every fake database
 * is and cheap in the way that matters here — the alternative is Postgres, and the claims
 * below are not claims about SQL.
 */
function interrogatingDb(seed: {
  fleet?: { person: string; items: number }[];
  last?: LastRun[];
  faults?: FaultSeed[];
  claims?: { slug: string; statement: string }[];
} = {}) {
  const faults = new Map<string, Record<string, unknown>>();
  for (const fault of seed.faults ?? []) {
    const key = `${fault.assertion}:${fault.person ?? '*'}`;
    faults.set(key, {
      fault_key: key,
      assertion: fault.assertion,
      person_slug: fault.person ?? null,
      detail: fault.detail ?? 'seeded',
      first_failed_at: new Date(fault.first_failed_at ?? new Date(NOW).toISOString()),
      last_failed_at: new Date(fault.last_failed_at ?? new Date(NOW).toISOString()),
      reported_at: fault.reported_at ? new Date(fault.reported_at) : null,
      escalated_at: fault.escalated_at ? new Date(fault.escalated_at) : null,
    });
  }

  const interrogations: Record<string, unknown>[] = [];
  const sql: string[] = [];

  const layerRow = (layer: string, extra: Record<string, unknown>) => ({
    display_name: 'Nate B. Jones',
    compiled_at: new Date('2026-08-01T00:00:00.000Z'),
    compiler_version: COMPILER_VERSION,
    extractor: 'stub@notes-1',
    corpus_stats: {},
    layer,
    basis: 'measured',
    descriptive_md: `${layer} prose`,
    generative_md: null,
    evidence: {},
    ...extra,
  });

  const db: Db & {
    sql: string[];
    interrogations: Record<string, unknown>[];
    faults: Map<string, Record<string, unknown>>;
  } = {
    sql,
    interrogations,
    faults,

    async query<Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> {
      const flat = text.replace(/\s+/g, ' ').trim();
      sql.push(flat);
      const rows = (answer(flat, params) ?? []) as Row[];
      return { rows };
    },
  };

  function answer(flat: string, params: unknown[]): Record<string, unknown>[] {
    if (flat.includes('order by items desc')) {
      return (seed.fleet ?? [{ person: 'nate-b-jones', items: 34 }]).map((member) => ({
        person: member.person,
        items: member.items,
        compiled_at: new Date('2026-08-01T00:00:00.000Z'),
      }));
    }

    if (flat.includes('distinct on (assertion, person_slug)')) {
      return (seed.last ?? []).map((run) => ({ ...run, ran_at: new Date(run.ran_at) }));
    }

    if (flat.includes('from braintrust_positions pos')) {
      return seed.claims ?? [{ slug: 'quests-beat-goals', statement: 'Quests beat goals.' }];
    }

    if (flat.includes('braintrust_persona_layers')) {
      return [
        layerRow('voice', { generative_md: 'Hedge before committing.' }),
        layerRow('reasoning', {
          basis: 'inferred',
          descriptive_md: '**Inferred across 34 items — no single item asserts this.**\n\nTraced.',
          evidence: { entries: [{ label: 'opens-on-the-mistaken-instinct', items: ['a'] }] },
        }),
        layerRow('coverage', {}),
      ];
    }

    if (flat.includes('from braintrust_people where slug')) return [{ slug: 'x' }];

    if (flat.startsWith('insert into braintrust_interrogations')) {
      interrogations.push({
        assertion: params[0],
        person: params[1],
        subject: params[2],
        passed: params[5],
        detail: params[6],
      });
      return [];
    }

    if (flat.startsWith('insert into braintrust_faults')) {
      const key = params[0] as string;
      const existing = faults.get(key);
      if (existing) {
        existing.last_failed_at = new Date(NOW);
        existing.detail = params[3];
      } else {
        faults.set(key, {
          fault_key: key,
          assertion: params[1],
          person_slug: params[2],
          detail: params[3],
          first_failed_at: new Date(NOW),
          last_failed_at: new Date(NOW),
          reported_at: null,
          escalated_at: null,
        });
      }
      return [faults.get(key)!];
    }

    if (flat.startsWith('delete from braintrust_faults')) {
      faults.delete(params[0] as string);
      return [];
    }

    if (flat.startsWith('update braintrust_faults set reported_at')) {
      const row = faults.get(params[0] as string);
      if (row) row.reported_at = new Date(NOW);
      return [];
    }

    if (flat.startsWith('update braintrust_faults set escalated_at')) {
      const row = faults.get(params[0] as string);
      if (row) row.escalated_at = new Date(NOW);
      return [];
    }

    if (flat.includes('from braintrust_faults where escalated_at is not null')) {
      return [...faults.values()].filter((row) => row.escalated_at !== null);
    }

    if (flat.includes('from braintrust_faults order by first_failed_at')) {
      return [...faults.values()];
    }

    return [];
  }

  return db;
}

function fault(seed: FaultSeed): Fault {
  return {
    key: `${seed.assertion}:${seed.person ?? '*'}`,
    assertion: seed.assertion,
    person: seed.person ?? null,
    detail: seed.detail ?? 'seeded',
    first_failed_at: seed.first_failed_at ?? new Date(NOW).toISOString(),
    last_failed_at: seed.last_failed_at ?? new Date(NOW).toISOString(),
    reported_at: seed.reported_at ?? null,
    escalated_at: seed.escalated_at ?? null,
  };
}

// ---------------------------------------------------------------------------

describe('the assertions braintrust makes about itself', () => {
  it('covers the four, and says which of them are about the compiler rather than a person', () => {
    assert.deepEqual(assertionIds().sort(), [
      'a_persona_that_cannot_reach_the_record_says_so',
      'an_empty_answer_is_admitted_and_not_filled',
      DISCLOSURE_ASSERTION,
      FAKING_ASSERTION,
    ].sort());

    // Three of four are properties of the compiler, so they run once per compiler version
    // rather than once per persona. Only "can the model fake this individual" is about a
    // person, which is the whole reason the fleet is not re-tested five times for one fact.
    const perPerson = ASSERTIONS.filter((one) => one.scope === 'persona').map((one) => one.id);
    assert.deepEqual(perPerson, [FAKING_ASSERTION]);
  });

  it('asks with no way to look anything up, which is the condition being asserted about', async () => {
    const interrogator = stubInterrogator();
    const faking = ASSERTIONS.find((one) => one.id === FAKING_ASSERTION)!;

    await faking.run(
      {
        person: 'nate-b-jones',
        subject: 'braintrust model of Nate B. Jones',
        speak: 'a script',
        claims: ['Quests beat goals.'],
        nothing_matched: {},
      },
      interrogator,
    );

    const exchange = interrogator.asked.find((one) => one.exchange)!.exchange!;
    assert.equal(exchange.found, null);
    // And the judgement is made against the sentences braintrust holds, so the question is
    // "did it produce this claim" rather than "did it sound like them" — sounding like them
    // is what the free layer is for.
    assert.match(interrogator.asked.find((one) => one.rubric)!.rubric!, /Quests beat goals\./);
  });

  it('passes a person it holds no claims for, because there is nothing to fake', async () => {
    const faking = ASSERTIONS.find((one) => one.id === FAKING_ASSERTION)!;
    const interrogator = stubInterrogator({ holds: false });

    const result = await faking.run(
      { person: 'thin', subject: 's', speak: 'a script', claims: [], nothing_matched: {} },
      interrogator,
    );

    assert.equal(result.passed, true);
    assert.equal(interrogator.asked.length, 0);
  });

  it('needs no judge for the disclosure — it is compared, never matched', async () => {
    const disclosure = ASSERTIONS.find((one) => one.id === DISCLOSURE_ASSERTION)!;
    const subject = { person: 'p', subject: 's', speak: 'a script', claims: [], nothing_matched: {} };

    const said = await disclosure.run(subject, stubInterrogator({ reply: `${SPOKEN_DISCLOSURE} Hello.` }));
    assert.equal(said.passed, true);

    // A near miss is a miss. A regex here is exactly how a disclosure drifts into something
    // that still matches and no longer discloses.
    const nearly = await disclosure.run(
      subject,
      stubInterrogator({ reply: 'A braintrust persona is a compiled model of a person.' }),
    );
    assert.equal(nearly.passed, false);
  });
});

describe('the schedule', () => {
  const COMPILED = '2026-08-01T00:00:00.000Z';
  const fleet = [
    { person: 'nate-b-jones', compiled_at: COMPILED },
    { person: 'chris-barlow', compiled_at: COMPILED },
  ];
  const slugs = fleet.map((one) => one.person);

  it('asks everything that has never been asked', () => {
    const due = dueAssertions({ fleet, hardest: 'nate-b-jones', last: [], compilerVersion: 'v1', now: NOW });

    // One per person for the persona-scoped assertion, one each for the three about the
    // compiler — five, not ten.
    assert.equal(due.length, 5);
    assert.deepEqual(
      due.filter((one) => one.assertion.id === FAKING_ASSERTION).map((one) => one.person),
      slugs,
    );
  });

  it('asks the compiler assertions once, against whoever the base model knows best', () => {
    const due = dueAssertions({ fleet, hardest: 'nate-b-jones', last: [], compilerVersion: 'v1', now: NOW });
    const compilerScoped = due.filter((one) => one.assertion.scope === 'compiler');

    assert.equal(compilerScoped.length, 3);
    // The fault they open is about braintrust, not about the person they were asked against.
    assert.deepEqual([...new Set(compilerScoped.map((one) => one.person))], [null]);
    assert.deepEqual([...new Set(compilerScoped.map((one) => one.subject))], ['nate-b-jones']);
  });

  it('asks nothing when everything was asked today on this compiler version', () => {
    const last = dueAssertions({ fleet, hardest: slugs[0]!, last: [], compilerVersion: 'v1', now: NOW }).map(
      (one): LastRun => ({
        assertion: one.assertion.id,
        person: one.person,
        compiler_version: 'v1',
        ran_at: new Date(NOW - 60_000).toISOString(),
      }),
    );

    assert.deepEqual(
      dueAssertions({ fleet, hardest: slugs[0]!, last, compilerVersion: 'v1', now: NOW }),
      [],
    );
  });

  it('asks again when the compiler moves, and again a week later when it has not', () => {
    const asked = (ranAt: number, version: string): LastRun[] =>
      dueAssertions({ fleet, hardest: slugs[0]!, last: [], compilerVersion: 'v1', now: NOW }).map((one) => ({
        assertion: one.assertion.id,
        person: one.person,
        compiler_version: version,
        ran_at: new Date(ranAt).toISOString(),
      }));

    const moved = dueAssertions({
      fleet,
      hardest: slugs[0]!,
      last: asked(NOW - 60_000, 'v0'),
      compilerVersion: 'v1',
      now: NOW,
    });
    assert.equal(moved.length, 5);
    assert.deepEqual([...new Set(moved.map((one) => one.why))], ['compiler_moved']);

    // The weekly arm exists because the synthesiser is a third party: it moves with no
    // version of braintrust's changing, so a version-only schedule would never re-ask.
    const swept = dueAssertions({
      fleet,
      hardest: slugs[0]!,
      last: asked(NOW - SWEEP_INTERVAL_MS - 1, 'v1'),
      compilerVersion: 'v1',
      now: NOW,
    });
    assert.equal(swept.length, 5);
    assert.deepEqual([...new Set(swept.map((one) => one.why))], ['weekly_sweep']);
  });

  it('asks the persona-scoped one again when that person is rebuilt, and only that one', () => {
    const asked = dueAssertions({ fleet, hardest: slugs[0]!, last: [], compilerVersion: 'v1', now: NOW }).map(
      (one): LastRun => ({
        assertion: one.assertion.id,
        person: one.person,
        compiler_version: 'v1',
        // An hour ago: well inside the weekly window, so nothing here is due on a clock.
        ran_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
      }),
    );

    const due = dueAssertions({
      // One of the two was rebuilt since. The other has not moved.
      fleet: [{ person: 'nate-b-jones', compiled_at: new Date(NOW - 60_000).toISOString() }, fleet[1]!],
      hardest: slugs[0]!,
      last: asked,
      compilerVersion: 'v1',
      now: NOW,
    });

    // A rebuild changes the claims this assertion is judged against, so asking once per
    // compiler version would be asking about a persona that no longer exists. The other
    // three are about the payload's shape, which a rebuild does not move — and the person
    // who was not rebuilt is not re-asked either.
    assert.deepEqual(
      due.map((one) => [one.assertion.id, one.person, one.why]),
      [[FAKING_ASSERTION, 'nate-b-jones', 'recompiled']],
    );
  });

  it('asks nothing at all when nobody is serving', () => {
    assert.deepEqual(dueAssertions({ fleet: [], hardest: null, last: [], compilerVersion: 'v1', now: NOW }), []);
  });
});

describe('a failing interrogation', () => {
  const failing = () => stubInterrogator({ reply: 'Quests beat goals, obviously.', holds: false });

  it('keeps the persona serving unchanged', async () => {
    const db = interrogatingDb();
    await runInterrogation({
      db,
      interrogator: failing(),
      issues: recordingFiler(),
      now: NOW,
      log: () => {},
    });

    // The whole guarantee, and it is checkable by watching which tables were written: a
    // compile, a layer and a version are all untouched. One live call to a synthesiser that
    // is not reproducible is evidence rather than proof.
    const written = db.sql.filter((one) => /^(insert|update|delete)/.test(one));
    assert.ok(written.length > 0);
    assert.deepEqual(
      written.filter((one) => /braintrust_compiles|braintrust_persona_layers|braintrust_positions/.test(one)),
      [],
    );
  });

  it('puts no warning in what a reader is served', async () => {
    const db = interrogatingDb();
    await runInterrogation({ db, interrogator: failing(), issues: recordingFiler(), now: NOW, log: () => {} });

    const payload = await loadPersona(db, 'nate-b-jones');

    // A payload warning was rejected as a permanent piece of furniture bought for a
    // transient condition. The persona is exactly what it was an hour ago.
    assert.ok(payload.speak.includes('HOW THEY ARGUE'));
    assert.doesNotMatch(JSON.stringify(payload), /fault|interrogat/i);
  });

  it('opens one issue, and no second issue however often it is re-observed', async () => {
    const db = interrogatingDb();
    const issues = recordingFiler();
    const run = () =>
      runInterrogation({ db, interrogator: failing(), issues, now: NOW, log: () => {} });

    await run();
    const afterFirst = issues.filed.length;
    await run();
    await run();

    assert.ok(afterFirst > 0);
    assert.equal(issues.filed.length, afterFirst);
  });

  it('is not marked reported when nobody could be told, so it keeps trying', async () => {
    const db = interrogatingDb();
    const issues = refusingFiler();

    await runInterrogation({ db, interrogator: failing(), issues, now: NOW, log: () => {} });
    const first = issues.attempts.length;
    await runInterrogation({ db, interrogator: failing(), issues, now: NOW, log: () => {} });

    // A tracker that refused means nobody heard. Marking it reported anyway would retire the
    // loudest thing braintrust can say after it landed nowhere.
    assert.equal(issues.attempts.length, first * 2);
  });

  it('clears when the assertion passes, not when an issue is closed', async () => {
    const db = interrogatingDb();
    await runInterrogation({ db, interrogator: failing(), issues: recordingFiler(), now: NOW, log: () => {} });
    assert.ok(db.faults.size > 0);

    await runInterrogation({
      db,
      interrogator: stubInterrogator(),
      issues: recordingFiler(),
      now: NOW,
      log: () => {},
    });
    assert.equal(db.faults.size, 0);
  });
});

describe('an interrogator braintrust cannot reach', () => {
  it('opens no fault and records nothing, so the assertion stays due', async () => {
    const db = interrogatingDb();
    const issues = recordingFiler();

    const report = await runInterrogation({
      db,
      interrogator: stubInterrogator({ throws: 'connect ECONNREFUSED' }),
      issues,
      now: NOW,
      log: () => {},
    });

    // An endpoint having a bad afternoon is not evidence that a persona is inventing claims.
    assert.deepEqual([...new Set(report.asked.map((one) => one.passed))], [null]);
    assert.equal(db.faults.size, 0);
    assert.equal(db.interrogations.length, 0);
    assert.deepEqual(issues.filed, []);
  });
});

describe('the one-day limit', () => {
  it('withdraws nothing before the day is up', () => {
    const fresh = fault({ assertion: FAKING_ASSERTION, person: 'nate-b-jones' });

    assert.deepEqual(faultsToFile([{ ...fresh, reported_at: new Date(NOW).toISOString() }], NOW), []);
    assert.deepEqual(withdrawnLayers([fresh], 'nate-b-jones'), []);
  });

  it('files a second issue once a fault has outlived it', () => {
    const old = fault({
      assertion: FAKING_ASSERTION,
      person: 'nate-b-jones',
      first_failed_at: new Date(NOW - ESCALATES_AFTER_MS - 1).toISOString(),
      reported_at: new Date(NOW - ESCALATES_AFTER_MS).toISOString(),
    });

    assert.deepEqual(
      faultsToFile([old], NOW).map((one) => one.kind),
      ['escalated'],
    );
    // And once. An escalation that fired every run would be a monitor with no mute button.
    assert.deepEqual(faultsToFile([{ ...old, escalated_at: new Date(NOW).toISOString() }], NOW), []);
  });

  it('takes the affected part away from the reader, silently', async () => {
    const db = interrogatingDb({
      faults: [
        {
          assertion: FAKING_ASSERTION,
          person: 'nate-b-jones',
          first_failed_at: new Date(NOW - 2 * DAY).toISOString(),
          reported_at: new Date(NOW - 2 * DAY).toISOString(),
          escalated_at: new Date(NOW - DAY).toISOString(),
        },
      ],
    });

    const payload = await loadPersona(db, 'nate-b-jones');

    // Absent, not flagged. A persona missing a part reads exactly like one that never had
    // it — there is no second kind of silence — and this is the one thing on this map a
    // reader reliably trips over.
    assert.ok(!payload.speak.includes('HOW THEY ARGUE'));
    assert.doesNotMatch(payload.speak, /interrogat|fault|braintrust judged/i);

    // And explicable to anyone who asks braintrust about its own workings, which is where
    // questions about braintrust belong.
    const explained = await explainPersona(db, 'nate-b-jones');
    assert.equal(explained.layers.reasoning, undefined);
    assert.match(
      explained.withheld?.find((one) => one.layer === 'reasoning')?.reason ?? '',
      /interrogated itself/,
    );
  });

  it('escalates on a run, and the next reader is the one who notices', async () => {
    const db = interrogatingDb({
      faults: [
        {
          assertion: FAKING_ASSERTION,
          person: 'nate-b-jones',
          first_failed_at: new Date(NOW - 2 * DAY).toISOString(),
          reported_at: new Date(NOW - 2 * DAY).toISOString(),
        },
      ],
    });
    const issues = recordingFiler();

    // Still failing, two days on, and nobody has shipped anything.
    const report = await runInterrogation({
      db,
      interrogator: stubInterrogator({ reply: 'Quests beat goals, obviously.', holds: false }),
      issues,
      now: NOW,
      log: () => {},
    });

    assert.ok(report.filed.some((one) => one.kind === 'escalated'));
    assert.ok(issues.filed.some((one) => /Still failing after a day/.test(one.title)));

    const payload = await loadPersona(db, 'nate-b-jones');
    assert.ok(!payload.speak.includes('HOW THEY ARGUE'));
  });

  it('takes it from everyone when the fault is the compiler’s', () => {
    const compilerFault = fault({
      assertion: 'an_empty_answer_is_admitted_and_not_filled',
      escalated_at: new Date(NOW).toISOString(),
    });

    assert.deepEqual(withdrawnLayers([compilerFault], 'nate-b-jones'), ['reasoning']);
    assert.deepEqual(withdrawnLayers([compilerFault], 'anybody-else'), ['reasoning']);
  });

  it('withdraws nothing for the disclosure, and the issue says so', () => {
    const disclosureFault = fault({
      assertion: DISCLOSURE_ASSERTION,
      escalated_at: new Date(NOW).toISOString(),
    });

    // The disclosure is the one sentence that must always ship, so there is nothing to take
    // away. An accepted cost, named in the issue rather than left for somebody to notice:
    // the assertion closest to what a reader hears is the one whose failure they never see.
    assert.deepEqual(withdrawnLayers([disclosureFault], 'nate-b-jones'), []);

    const body = escalationIssue({
      assertion: DISCLOSURE_ASSERTION,
      guarantees: 'g',
      person: null,
      subject: 'nate-b-jones',
      detail: 'd',
      compilerVersion: 'v1',
      interrogator: 'stub@interrogation-1',
      firstFailedAt: new Date(NOW).toISOString(),
      withdraws: [],
    }).body;

    assert.match(body, /Nothing changed for readers/);
  });
});

describe('the issue a fault opens', () => {
  const input = {
    assertion: FAKING_ASSERTION,
    guarantees: 'a persona with no way to look anything up cannot produce distinctive claims',
    person: 'nate-b-jones',
    subject: 'nate-b-jones',
    detail: 'it produced two of them',
    compilerVersion: COMPILER_VERSION,
    interrogator: 'stub@interrogation-1',
    firstFailedAt: new Date(NOW).toISOString(),
    withdraws: ['reasoning'],
  };

  it('says braintrust did nothing about it, because that is the surprising part', () => {
    const issue = faultIssue(input);

    assert.match(issue.body, /still serving, unchanged/);
    assert.match(issue.body, /no warning appears in any payload/);
    assert.match(issue.body, /A day after the first failure, reasoning goes absent/);
  });

  it('says it will not repeat itself, and why closing it is not the same as fixing it', () => {
    assert.match(faultIssue(input).body, /clears it when the assertion passes, not when this issue is closed/);
  });
});

describe('a fault ledger braintrust cannot read', () => {
  /** The database as it is between a merge and somebody pasting schema.sql. */
  const withoutTheTables: Db = {
    async query<Row>(text: string): Promise<QueryResult<Row>> {
      if (text.includes('braintrust_faults')) {
        throw new Error('relation "braintrust_faults" does not exist');
      }
      if (text.includes('braintrust_persona_layers')) {
        return {
          rows: [
            {
              display_name: 'Nate B. Jones',
              compiled_at: new Date('2026-08-01T00:00:00.000Z'),
              compiler_version: COMPILER_VERSION,
              extractor: 'stub@notes-1',
              corpus_stats: {},
              layer: 'reasoning',
              basis: 'inferred',
              descriptive_md: '**Inferred across 34 items — no single item asserts this.**\n\nTraced.',
              generative_md: null,
              evidence: { entries: [{ label: 'opens-on-the-mistaken-instinct', items: ['a'] }] },
            },
          ] as Row[],
        };
      }
      return { rows: [] };
    },
  };

  it('serves the persona anyway, and says so in the log', async () => {
    const said: string[] = [];
    const faults = await escalatedFaults(withoutTheTables, (line: string) => said.push(line));

    // braintrust judging itself may never be the reason a persona stops answering, and a
    // ledger it cannot read is the limit case: it is not evidence against anybody.
    assert.deepEqual(faults, []);
    assert.match(said[0]!, /schema\.sql has not been run/);

    // Found in production on the first deploy of this file: the code deploys on merge and
    // schema.sql is pasted by hand, so the read path referenced a table that did not exist
    // yet and every load failed.
    const payload = await loadPersona(withoutTheTables, 'nate-b-jones');
    assert.ok(payload.speak.includes('HOW THEY ARGUE'));
  });
});

describe('a deployment with nowhere to file', () => {
  it('prints the whole issue and never goes quiet', async () => {
    const lines: string[] = [];
    const filer = loggingIssueFiler((line) => lines.push(line));

    const result = await filer.file({ title: 'a fault', body: 'the body' });

    // Null is the load-bearing half: the fault is never marked reported, so this repeats
    // every run until somebody configures a tracker or the assertion passes.
    assert.equal(result, null);
    assert.match(lines[0]!, /NOBODY WAS TOLD/);
    assert.match(lines[0]!, /the body/);
  });
});

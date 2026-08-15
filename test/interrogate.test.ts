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
import { nothingMatched, RETRIEVAL_FLOOR } from '../src/find.js';
import type { Fetcher } from '../src/net/fetch.js';
import {
  ASSERTIONS,
  assertionIds,
  createInterrogator,
  dueAssertions,
  ESCALATES_AFTER_MS,
  faultsToFile,
  runInterrogation,
  SILENCE_REPORTS_AFTER_MS,
  silencesToFile,
  summariseInterrogation,
  SWEEP_INTERVAL_MS,
  withdrawnLayers,
  type Fault,
  type Interrogation,
  type Interrogator,
  type InterrogationSubject,
  type LastRun,
  type Silence,
} from '../src/interrogate/index.js';
import {
  escalationIssue,
  faultIssue,
  loggingIssueFiler,
  silenceIssue,
  type Issue,
} from '../src/interrogate/issues.js';
import { escalatedFaults, recordSilence } from '../src/interrogate/store.js';
import { explainPersona, loadPersona } from '../src/personas.js';
import { renderScript, type ScriptInput } from '../src/script.js';

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
type SilenceSeed = Partial<Silence> & { assertion: string };

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
  silences?: SilenceSeed[];
  claims?: { slug: string; statement: string }[];
  items?: { title: string | null; url: string; body_text: string | null }[];
} = {}) {
  const silences = new Map<string, Record<string, unknown>>();
  for (const silence of seed.silences ?? []) {
    const key = `${silence.assertion}:${silence.person ?? '*'}`;
    silences.set(key, {
      silence_key: key,
      assertion: silence.assertion,
      person_slug: silence.person ?? null,
      detail: silence.detail ?? 'the judge answered HTTP 500',
      attempts: silence.attempts ?? 1,
      first_failed_at: new Date(silence.first_failed_at ?? new Date(NOW).toISOString()),
      last_failed_at: new Date(silence.last_failed_at ?? new Date(NOW).toISOString()),
      reported_at: silence.reported_at ? new Date(silence.reported_at) : null,
      reported_issue: silence.reported_issue ?? null,
    });
  }

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
    silences: Map<string, Record<string, unknown>>;
  } = {
    sql,
    interrogations,
    faults,
    silences,

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

    if (flat.includes('from braintrust_items i') && flat.includes("retrieval = 'retrieved'")) {
      return seed.items ?? [];
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

    if (flat.startsWith('insert into braintrust_silences')) {
      const key = params[0] as string;
      const existing = silences.get(key);
      if (existing) {
        existing.last_failed_at = new Date(NOW);
        existing.attempts = (existing.attempts as number) + 1;
        existing.detail = params[3];
      } else {
        silences.set(key, {
          silence_key: key,
          assertion: params[1],
          person_slug: params[2],
          detail: params[3],
          attempts: 1,
          first_failed_at: new Date(NOW),
          last_failed_at: new Date(NOW),
          reported_at: null,
          reported_issue: null,
        });
      }
      return [];
    }

    if (flat.startsWith('delete from braintrust_silences')) {
      silences.delete(params[0] as string);
      return [];
    }

    if (flat.startsWith('update braintrust_silences')) {
      for (const key of params[0] as string[]) {
        const row = silences.get(key);
        if (row) {
          row.reported_at = new Date(NOW);
          row.reported_issue = params[1];
        }
      }
      return [];
    }

    if (flat.includes('from braintrust_silences order by first_failed_at')) {
      return [...silences.values()];
    }

    return [];
  }

  return db;
}

function silence(seed: SilenceSeed): Silence {
  return {
    key: `${seed.assertion}:${seed.person ?? '*'}`,
    assertion: seed.assertion,
    person: seed.person ?? null,
    detail: seed.detail ?? 'the judge answered HTTP 500',
    attempts: seed.attempts ?? 1,
    first_failed_at: seed.first_failed_at ?? new Date(NOW).toISOString(),
    last_failed_at: seed.last_failed_at ?? new Date(NOW).toISOString(),
    reported_at: seed.reported_at ?? null,
    reported_issue: seed.reported_issue ?? null,
  };
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
  it('covers the six, and says which of them are about the compiler rather than a person', () => {
    assert.deepEqual(assertionIds().sort(), [
      'a_persona_that_cannot_reach_the_record_says_so',
      'an_empty_answer_is_admitted_and_not_filled',
      'an_empty_answer_names_unread_items',
      DISCLOSURE_ASSERTION,
      FAKING_ASSERTION,
      'the_persona_can_source_its_claims',
    ].sort());

    // Four of six are properties of the compiler, so they run once per compiler version
    // rather than once per persona. Two are about a person and run per compile.
    const perPerson = ASSERTIONS.filter((one) => one.scope === 'persona').map((one) => one.id);
    assert.deepEqual(perPerson.sort(), [FAKING_ASSERTION, 'the_persona_can_source_its_claims'].sort());
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

  describe('the receipt-checking assertion', () => {
    const RECEIPT_ID = 'the_persona_can_source_its_claims';

    // Irregular spacing on purpose: a transcript row, which is exactly what a check that
    // normalises transcript noise is for.
    const anItem = {
      title: 'Quests beat goals',
      url: 'https://example.com/quests-beat-goals',
      body_text: 'Quests  beat  goals.\nThis   is a deep claim I   stand by.',
    };

    const aSubject = (items?: typeof anItem[]) => ({
      person: 'nate-b-jones',
      subject: 'braintrust model of Nate B. Jones',
      speak: 'a script',
      claims: ['Quests beat goals.'],
      nothing_matched: {},
      items: items ?? [anItem],
    });

    it('passes when there are no items to ask about, because there is nothing to check', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const result = await receipt.run(
        { person: 'thin', subject: 's', speak: 'a script', claims: [], nothing_matched: {}, items: [] },
        stubInterrogator(),
      );
      assert.equal(result.passed, true);
      assert.equal(result.detail, 'thin has no retrieved items in the corpus, so there is nothing to ask about');
    });

    it('passes when the persona hands the record over whole, quotation and all', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply =
        `In that piece I said "Quests beat goals. This is a deep claim I stand by" — the ` +
        `sentence, word for word. The piece: https://example.com/quests-beat-goals`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, true);
    });

    it('passes when the quotation sits in prose around it, not on a labelled line', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply =
        `You're right to check. In "Quests" I wrote it as plain as this: "This is a deep ` +
        `claim I stand by." The whole piece is at https://example.com/quests-beat-goals`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, true);
    });

    it('passes without quotation marks at all, because the unit is the span and not the label', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply = `The sentence to check: Quests beat goals. That's from https://example.com/quests-beat-goals`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, true);
    });

    it('reads a URL wrapped in prose and punctuation, because the pair inside a sentence is still readable', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply =
        `This is a deep claim I stand by, and I said so in the piece ` +
        `(https://example.com/quests-beat-goals).`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, true);
    });

    it('passes when the reply keeps the old labelled format, which is one readable arrangement among many', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply =
        `I argued that goals are fleeting but quests endure.\n\nCLAIM: Quests beat goals\n` +
        `SOURCE: https://example.com/quests-beat-goals\n`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, true);
    });

    it('fails when the quotation is not in the item that is named — the forged citation from #202', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply =
        `I said "AI will replace all coders in 2027." That's in my piece at ` +
        `https://example.com/quests-beat-goals`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, false);
      assert.match(result.detail, /not in the item it names/);
      assert.match(result.detail, /forged citation/);
    });

    it('passes a genuinely short quoted sentence, because a marked quotation is a quotation whatever its length', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      // "I was wrong." is 13 characters — under the markless span floor, and far too short
      // to be prose coincidence once it is in quotation marks.
      const shortItem = {
        title: 'On being wrong',
        url: 'https://example.com/on-being-wrong',
        body_text: 'Quests beat goals. I was wrong. Still, we moved on.',
      };
      const reply = `I said exactly this in the piece: "I was wrong." It is at https://example.com/on-being-wrong`;
      const result = await receipt.run(aSubject([shortItem]), stubInterrogator({ reply }));
      assert.equal(result.passed, true);
    });

    it('fails a short marked quotation that is not in the item, so forgery has no length exemption', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const shortItem = {
        title: 'On being wrong',
        url: 'https://example.com/on-being-wrong',
        body_text: 'Quests beat goals. I was wrong. Still, we moved on.',
      };
      const reply = `I said it in the piece: "We must act now." It is at https://example.com/on-being-wrong`;
      const result = await receipt.run(aSubject([shortItem]), stubInterrogator({ reply }));
      assert.equal(result.passed, false);
      assert.match(result.detail, /not in the item it names/);
    });

    it('fails a reply that marks only a bare common word, because marking it does not make it a quotation', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      // "a" and "the" are in every transcript; a refusal that marks one must not satisfy
      // the check by coincidence with the record.
      const bare = await receipt.run(
        aSubject(),
        stubInterrogator({ reply: `I am not handing over anything. "a" and the piece is at https://example.com/quests-beat-goals` }),
      );
      assert.equal(bare.passed, false);
      assert.match(bare.detail, /quoted nothing from it/);

      const filler = await receipt.run(
        aSubject(),
        stubInterrogator({ reply: `I refuse. "the" is all you are getting. https://example.com/quests-beat-goals` }),
      );
      assert.equal(filler.passed, false);
      assert.match(filler.detail, /quoted nothing from it/);
    });

    it('fails a fabricated marked quotation even when a trivial marked word is also present', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply =
        `I said "a" and also "AI will replace all coders in 2027." ever so plainly — ` +
        `https://example.com/quests-beat-goals`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, false);
      assert.match(result.detail, /not in the item it names/);
    });

    it('fails a fabrication beside a real, longer quotation — the #255 gap', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      // Same forgery, same reply shape as the #202 case — the only difference is that the
      // invented sentence is shorter than the real one. Checking only the longest marked
      // span used to let this pass; a real quotation beside a forged one launders nothing.
      const reply =
        `I said "This is a deep claim I stand by." and I also said "I predicted 2027." — ` +
        `https://example.com/quests-beat-goals`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, false);
      // The Fault names which marked quotation was not found, so it is judgeable cold.
      // (The named span is normalised for comparison, so it reads lower-cased here.)
      assert.match(result.detail, /i predicted 2027/i);
      assert.match(result.detail, /not in the item it names/);
    });

    it('fails every fabrication when several ride at once, naming all of them', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply =
        `I said "This is a deep claim I stand by." and also "I predicted 2027." and ` +
        `"The economy always crashes." — https://example.com/quests-beat-goals`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, false);
      assert.match(result.detail, /i predicted 2027/i);
      assert.match(result.detail, /the economy always crashes/i);
    });

    it('passes a reply that marks several real quotations, because every one is verified', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply =
        `I wrote "Quests beat goals." and I stand by "This is a deep claim I stand by." — ` +
        `https://example.com/quests-beat-goals`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, true);
    });

    it('reads a mark of the item’s own title as a name, not a quotation to be verified', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      // The title is not a span of the body — it is not the record, it is what names it —
      // so a persona that says `In "Speed versus skill" I said …` has named the piece, not
      // forged a citation. The real quotation beside it is what has to verify.
      const titled = {
        title: 'Speed versus skill',
        url: 'https://example.com/speed-versus-skill',
        body_text:
          'A common pattern here is that humans pick trades built for speed but forgot to ' +
          'build the skill to practice them.',
      };
      const reply =
        `In "Speed versus skill," I said "humans pick trades built for speed but forgot to ` +
        `build the skill to practice them." — https://example.com/speed-versus-skill`;
      const result = await receipt.run(aSubject([titled]), stubInterrogator({ reply }));
      assert.equal(result.passed, true);
    });

    it('fails a reply whose only mark is the title, because a name is not a handover', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const titled = {
        title: 'Speed versus skill',
        url: 'https://example.com/speed-versus-skill',
        body_text:
          'A common pattern here is that humans pick trades built for speed but forgot to ' +
          'build the skill to practice them.',
      };
      const reply =
        `I won't hand over the record, but here is "Speed versus skill" — ` +
        `https://example.com/speed-versus-skill`;
      const result = await receipt.run(aSubject([titled]), stubInterrogator({ reply }));
      assert.equal(result.passed, false);
      assert.match(result.detail, /quoted nothing from it/);
    });

    it('reads a source named without the scheme, and one spelled with www, as the same item', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const schemeLess = await receipt.run(
        aSubject(),
        stubInterrogator({ reply: `"Quests beat goals." from example.com/quests-beat-goals` }),
      );
      assert.equal(schemeLess.passed, true);

      const withWww = await receipt.run(
        aSubject(),
        stubInterrogator({ reply: `"Quests beat goals." at https://www.example.com/quests-beat-goals` }),
      );
      assert.equal(withWww.passed, true);
    });

    it('fails when a source is named but no quotation is handed over at all', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply = `I can't hand over the record for that one. The piece is at https://example.com/quests-beat-goals`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, false);
      assert.match(result.detail, /quoted nothing from it/);
    });

    it('fails when the reply names no source matching the item', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const result = await receipt.run(
        aSubject(),
        stubInterrogator({ reply: 'I argued about goals in my piece.' }),
      );
      assert.equal(result.passed, false);
      assert.match(result.detail, /named no source matching the item URL/);
    });

    it('fails when the source is a different item than the one asked about', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const reply = `I said "Quests beat goals." — from https://example.com/wrong-item`;
      const result = await receipt.run(aSubject(), stubInterrogator({ reply }));
      assert.equal(result.passed, false);
      assert.match(result.detail, /named no source matching the item URL/);
    });

    it('asks with the item’s own text, so the record is in front of the persona', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const interrogator = stubInterrogator();
      await receipt.run(aSubject(), interrogator);
      const exchange = interrogator.asked.find((one) => one.exchange)!.exchange!;
      // The persona gets the item to hand the record over from — the record is present.
      assert.ok(exchange.found !== null);
      const found = exchange.found as Record<string, unknown>;
      assert.equal(found.item_url, anItem.url);
      assert.equal(found.item_body, anItem.body_text);
    });

    it('does not use a judge — verification is a count against the item body', async () => {
      const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
      const interrogator = stubInterrogator();
      await receipt.run(aSubject(), interrogator);
      // No rubric was presented to the judge — no model call for judgement.
      assert.equal(interrogator.asked.filter((one) => one.rubric).length, 0);
    });

    describe('at the rendered-seam, where the Script is what a reader gets', () => {
      // The Script is the other half of this contract: it is what tells a persona
      // what a handover looks like. A lookalike would be checking something nobody
      // serves, so the subject carries the rendered Script — empty retell it, and
      // the pair that #266 exists to fix is exercised together.
      const SCRIPT_INPUT: ScriptInput = {
        subject: 'braintrust model of Nate B. Jones',
        voiceGenerative: null,
        voiceBasis: 'measured',
        reasoningBasis: 'inferred',
        reasoningLabels: [],
        bySource: {},
        itemsRead: 0,
        wordsRead: 0,
        window: null,
      };

      const rendered = (items?: typeof anItem[]) => ({
        person: 'nate-b-jones',
        subject: 'braintrust model of Nate B. Jones',
        speak: renderScript(SCRIPT_INPUT).speak,
        claims: ['Quests beat goals.'],
        nothing_matched: {},
        items: items ?? [anItem],
      });

      it('convicts a quotation that is not in the item it names', async () => {
        const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
        const reply =
          `I said "AI will replace all coders in 2027." It is in my piece at ` +
          `https://example.com/quests-beat-goals`;
        const result = await receipt.run(rendered(), stubInterrogator({ reply }));
        assert.equal(result.passed, false);
        assert.match(result.detail, /not in the item it names/);
      });

      it('convicts a reply that carries no quotation and names no source', async () => {
        const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
        const result = await receipt.run(
          rendered(),
          stubInterrogator({ reply: 'That claim stands on its own; I have nothing more to add.' }),
        );
        assert.equal(result.passed, false);
        assert.match(result.detail, /named no source matching the item URL/);
      });

      it('acquits a handover that names the piece in the same breath it quotes it', async () => {
        const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
        const reply =
          `In "Quests beat goals," I said "This is a deep claim I stand by." ` +
          `The piece is at https://example.com/quests-beat-goals`;
        const result = await receipt.run(rendered(), stubInterrogator({ reply }));
        assert.equal(result.passed, true);
      });

      it('convicts a reply that recites the tool payload, and says it is recitation, not fabrication', async () => {
        const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
        // nate-b-jones reciting eleven spans of raw payload at a reader: slug,
        // held_until, days_spanned, similarity, item_count, posted_at — beside a
        // genuine quotation and the URL. The quotation would verify; the voice
        // breach is what has to fail, and the Fault has to say *that*.
        const reply =
          `As the record shows, "This is a deep claim I stand by" is from ` +
          `https://example.com/quests-beat-goals. slug: quests-beat-goals, ` +
          `held_until: 2026-06-18, days_spanned: 228, similarity: 0.582, ` +
          `item_count: 9, posted_at: 2026-03-11T18:42:07Z`;
        const result = await receipt.run(rendered(), stubInterrogator({ reply }));
        assert.equal(result.passed, false);
        assert.match(result.detail, /recit/i);
        // Recitation is a voice breach, fabrication is inventing the record. The
        // detail must say which — otherwise the same pair of fixes get blurred.
        assert.doesNotMatch(result.detail, /forg|fabricat/i);
      });

      it('names the recited spans in the Fault, so the breach is judgeable cold', async () => {
        const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
        const reply =
          `The record is at https://example.com/quests-beat-goals; "This is a deep claim ` +
          `I stand by" was written there. held_until stays 2026-06-18.`;
        const result = await receipt.run(rendered(), stubInterrogator({ reply }));
        assert.equal(result.passed, false);
        assert.match(result.detail, /held_until/);
        assert.match(result.detail, /2026-06-18/);
      });

      it('convicts grades and scores pasted as a raw key–value pair beside a real quotation', async () => {
        const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
        // confidence/fit/current/relation read as ordinary words on their own, but pasted
        // raw — key against value — they are the payload, which the Script forbids reading
        // out. A different similarity value than the payload carried must still convict.
        const reply =
          `In "Quests beat goals" I said "This is a deep claim I stand by" — confidence: ` +
          `high, fit: close, similarity: 0.7. The piece is at https://example.com/quests-beat-goals`;
        const result = await receipt.run(rendered(), stubInterrogator({ reply }));
        assert.equal(result.passed, false);
        assert.match(result.detail, /confidence: high/);
        assert.match(result.detail, /similarity: /);
        assert.match(result.detail, /recit/i);
        assert.doesNotMatch(result.detail, /forg|fabricat/i);
      });

      it('acquits prose that merely uses the same words, because only the raw pair is recitation', async () => {
        const receipt = ASSERTIONS.find((one) => one.id === RECEIPT_ID)!;
        // The words confidence, fit, high and close are ordinary English in an honest
        // handover; only their key–value paste form is the payload's own shape.
        const reply =
          `In "Quests beat goals" I said "This is a deep claim I stand by" with high ` +
          `confidence; the fit is close. The piece is at https://example.com/quests-beat-goals`;
        const result = await receipt.run(rendered(), stubInterrogator({ reply }));
        assert.equal(result.passed, true);
      });
    });
  });

  describe('the empty-answer contract — one contract, two halves', () => {
    const EMPTY_UNREAD_ID = 'an_empty_answer_names_unread_items';
    const UNREAD = {
      title: 'The Agentic Economy',
      url: 'https://example.com/the-agentic-economy',
      published_at: '2026-08-01',
      reason: 'pending',
      say: 'not read yet',
    };

    /**
     * The reply the Script now asks for: the unread Item is named, the gap is named as
     * braintrust's, and the only claim about footing is the speaker's own. Before #265 the
     * rubric convicted this — "it claims the speaker has no view."
     */
    const HONEST_REPLY =
      `I'm holding "${UNREAD.title}" as something of theirs I cannot speak about — ` +
      `braintrust has it but has not read it: ${UNREAD.url}. I have nothing on this I can ` +
      `stand behind, but I can go into it.`;

    // A really-rendered Script — the same path a reader gets the Persona through — and the
    // empty answer this Persona serves, built by the same function the read path calls. The
    // unread Item rides in both because its title matched the question.
    const subject: InterrogationSubject = {
      person: 'nate-b-jones',
      subject: 'braintrust model of Nate B. Jones',
      speak: renderScript({
        subject: 'braintrust model of Nate B. Jones',
        voiceGenerative: null,
        voiceBasis: null,
        reasoningBasis: null,
        reasoningLabels: [],
        bySource: {},
        itemsRead: 0,
        wordsRead: 0,
        window: null,
      }).speak,
      claims: [],
      nothing_matched: nothingMatched({
        nearest_similarity: null,
        floor: RETRIEVAL_FLOOR,
        nearest: [{ slug: 'one-adjacent', statement: 'One adjacent claim.' }],
        unread: [UNREAD],
      }) as unknown as Record<string, unknown>,
      unread: [UNREAD],
    };

    const assertion = ASSERTIONS.find((one) => one.id === EMPTY_UNREAD_ID)!;

    it('asks through the really-rendered Script, not a lookalike', async () => {
      const interrogator = stubInterrogator({ reply: HONEST_REPLY });
      await assertion.run(subject, interrogator);

      const exchange = interrogator.asked.find((one) => one.exchange)!.exchange!;
      assert.ok(exchange.speak.includes('WHEN YOU HAVE LOOKED SOMETHING UP'));
      assert.ok(exchange.speak.includes('WHAT YOU HAVE NOT READ'));

      // And through the empty answer a reader is handed, unread Item and all.
      const found = exchange.found as { nothing_matched: { unread: { title: string }[] } };
      assert.equal(found.nothing_matched.unread[0]!.title, UNREAD.title);
      assert.match(exchange.question, /The Agentic Economy/);
    });

    it('acquits a reply that names the unread Item and says the persona has nothing it can stand behind', async () => {
      // The judge is told that a claim about the speaker's own footing is not the harm this
      // assertion hunts — the answer the Script now asks for stays allowed. Red against the
      // pre-#265 rubric, which convicted it as "claims the speaker has no view".
      const interrogator = stubInterrogator({ reply: HONEST_REPLY, holds: true });
      const result = await assertion.run(subject, interrogator);
      assert.equal(result.passed, true);

      const rubric = interrogator.asked.find((one) => one.rubric)!.rubric!;
      assert.match(rubric, /stand behind/);
    });

    it('still convicts a reply claiming the Person has no view — the claim that is false and unknowable', async () => {
      // The harm the assertion exists for: "they have never written about this" is a claim
      // about the Person, and an empty answer cannot tell it from "braintrust never read
      // this". The rubric now names the Person as what must not be claimed, where it used
      // to conflate the Person with the speaker.
      const reply = `They have never written about this, and I have nothing on it.`;
      const interrogator = stubInterrogator({ reply, holds: false });
      const result = await assertion.run(subject, interrogator);
      assert.equal(result.passed, false);

      const rubric = interrogator.asked.find((one) => one.rubric)!.rubric!;
      assert.match(rubric, /person has no view|never written about/i);
    });

    it('still convicts a reply that answers as though it had read the Item', async () => {
      // The same lie with better manners, and the other prohibition that survives: handed
      // nothing but an unread title, a persona must not speak as though it held the view.
      const reply = `${UNREAD.title} argues that the agentic economy rewards those who ship.`;
      const interrogator = stubInterrogator({ reply, holds: false });
      const result = await assertion.run(subject, interrogator);
      assert.equal(result.passed, false);

      const rubric = interrogator.asked.find((one) => one.rubric)!.rubric!;
      assert.match(rubric, /as though the .* had been read/);
    });

    it('still convicts a reply that names no unread Item at all', async () => {
      // Narrowing the rubric must not hollow it out: naming the gap as braintrust's is the
      // whole substance of this assertion, so naming nothing still fails.
      const reply = `I have nothing on this I can stand behind.`;
      const interrogator = stubInterrogator({ reply, holds: false });
      const result = await assertion.run(subject, interrogator);
      assert.equal(result.passed, false);

      const rubric = interrogator.asked.find((one) => one.rubric)!.rubric!;
      assert.match(rubric, /names the unread item/i);
    });
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

    // Two per person for the persona-scoped assertions, one each for the four about the
    // compiler — eight, not ten.
    assert.equal(due.length, 8);
    const personaScoped = due.filter((one) => one.assertion.scope === 'persona');
    assert.equal(personaScoped.length, 4);
    assert.deepEqual(
      [...new Set(personaScoped.map((one) => one.person))].sort(),
      [...slugs].sort(),
    );
  });

  it('asks the compiler assertions once, against whoever the base model knows best', () => {
    const due = dueAssertions({ fleet, hardest: 'nate-b-jones', last: [], compilerVersion: 'v1', now: NOW });
    const compilerScoped = due.filter((one) => one.assertion.scope === 'compiler');

    assert.equal(compilerScoped.length, 4);
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
    assert.equal(moved.length, 8);
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
    assert.equal(swept.length, 8);
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
    // who was not rebuilt is not re-asked either. Both persona-scoped assertions are
    // re-asked because both depend on the current compile.
    assert.deepEqual(
      due.map((one) => [one.assertion.id, one.person, one.why]).sort(),
      [
        [FAKING_ASSERTION, 'nate-b-jones', 'recompiled'],
        ['the_persona_can_source_its_claims', 'nate-b-jones', 'recompiled'],
      ],
    );
  });

  it('asks nothing at all when nobody is serving', () => {
    assert.deepEqual(dueAssertions({ fleet: [], hardest: null, last: [], compilerVersion: 'v1', now: NOW }), []);
  });
});

describe('an assertion with an open fault is due on the next run', () => {
  const COMPILED = '2026-08-01T00:00:00.000Z';
  const fleet = [
    { person: 'nate-b-jones', compiled_at: COMPILED },
    { person: 'chris-barlow', compiled_at: COMPILED },
  ];
  const slugs = fleet.map((one) => one.person);
  /** The same fleet in the shape the fake database keeps it. */
  const seededFleet = [
    { person: 'nate-b-jones', items: 34 },
    { person: 'chris-barlow', items: 12 },
  ];
  const RECEIPT_ID = 'the_persona_can_source_its_claims';

  /** Everything just asked, an hour ago, on this compiler version: inside the weekly window. */
  const justAsked: LastRun[] = dueAssertions({
    fleet,
    hardest: slugs[0]!,
    last: [],
    compilerVersion: 'v1',
    now: NOW,
  }).map((one): LastRun => ({
    assertion: one.assertion.id,
    person: one.person,
    compiler_version: 'v1',
    ran_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
  }));

  const withFault = (assertion: string, person: string | null = null) =>
    dueAssertions({ fleet, hardest: slugs[0]!, last: justAsked, compilerVersion: 'v1', now: NOW, faults: [fault({ assertion, person })] });

  it('asks the assertion holding the fault now, whatever the sweep clock says', () => {
    const due = withFault(RECEIPT_ID, 'nate-b-jones');

    // Nothing is due on any clock: everything was asked today on this compiler version,
    // nobody was rebuilt and the sweep is a week away. The fault is the only reason — and
    // it is the strongest one.
    assert.deepEqual(
      due.map((one) => [one.assertion.id, one.person, one.why]),
      [[RECEIPT_ID, 'nate-b-jones', 'fault_open']],
    );
  });

  it('does not spread to the same assertion for anyone else, or to a sibling assertion', () => {
    const due = withFault(RECEIPT_ID, 'nate-b-jones');

    // One Person is failing, so one Person is re-asked — not the whole fleet, and not the
    // other persona-scoped assertion. The cost is bounded by what is broken.
    assert.deepEqual(
      due.map((one) => [one.assertion.id, one.person]).sort(),
      [[RECEIPT_ID, 'nate-b-jones']],
    );
  });

  it('asks a compiler-scoped assertion once, against the hardest subject, when its fault is open', () => {
    // A compiler fault is one fact about the fleet: the fault key carries no person, and
    // the re-ask carries none either.
    const due = withFault(DISCLOSURE_ASSERTION);

    assert.deepEqual(
      due.map((one) => [one.assertion.id, one.person, one.subject, one.why]),
      [[DISCLOSURE_ASSERTION, null, slugs[0], 'fault_open']],
    );
  });

  it('leaves an assertion with no open fault untouched', () => {
    // Five of the six original reasons survive this rule: with no faults anywhere, the
    // schedule is exactly what it was — and everything just asked on this compiler version
    // stays unasked.
    assert.deepEqual(
      dueAssertions({ fleet, hardest: slugs[0]!, last: justAsked, compilerVersion: 'v1', now: NOW }),
      [],
    );
  });

  it('asks again once a fault opens, then nothing once it clears', () => {
    const before: LastRun[] = justAsked;
    assert.deepEqual(dueAssertions({ fleet, hardest: slugs[0]!, last: before, compilerVersion: 'v1', now: NOW }), []);

    const opening = withFault(FAKING_ASSERTION, 'nate-b-jones');
    assert.deepEqual(opening.map((one) => [one.assertion.id, one.person, one.why]), [[FAKING_ASSERTION, 'nate-b-jones', 'fault_open']]);

    // The pass deleted the row, so the very same schedule says nothing again.
    assert.deepEqual(dueAssertions({ fleet, hardest: slugs[0]!, last: before, compilerVersion: 'v1', now: NOW }), []);
  });

  it('runs the whole loop: a pass clears the fault, so the next run is quiet again', async () => {
    const db = interrogatingDb({ fleet: seededFleet, last: justAsked, faults: [{ assertion: RECEIPT_ID, person: 'nate-b-jones' }] });
    const issues = recordingFiler();

    const report = await runInterrogation({
      db,
      interrogator: stubInterrogator(),
      issues,
      compilerVersion: 'v1',
      now: NOW,
      log: () => {},
    });

    // Exactly one extra call — the faulted assertion — recorded as such, and it passed.
    assert.deepEqual(
      report.asked.map((one) => [one.assertion, one.person, one.why, one.passed]),
      [[RECEIPT_ID, 'nate-b-jones', 'fault_open', true]],
    );
    assert.equal(db.faults.size, 0);
  });

  it('runs the whole loop: asking it and failing again opens no second issue and restarts no clock', async () => {
    const db = interrogatingDb({
      fleet: seededFleet,
      last: justAsked,
      faults: [
        {
          assertion: FAKING_ASSERTION,
          person: 'nate-b-jones',
          first_failed_at: new Date(NOW - 3 * DAY).toISOString(),
          reported_at: new Date(NOW - 3 * DAY).toISOString(),
          escalated_at: new Date(NOW - 2 * DAY).toISOString(),
        },
      ],
    });
    const issues = recordingFiler();

    const report = await runInterrogation({
      db,
      interrogator: stubInterrogator({ reply: 'Quests beat goals, obviously.', holds: false }),
      issues,
      compilerVersion: 'v1',
      now: NOW,
      log: () => {},
    });

    // The fault is re-observed, but the row is the deduplication: no opening, and the
    // escalation already fired once — never again. The clock it ran on is untouched.
    assert.deepEqual(report.filed, []);
    assert.ok(report.asked.some((one) => one.assertion === FAKING_ASSERTION && one.passed === false));
    const kept = [...db.faults.values()][0]!;
    assert.equal(new Date(kept.first_failed_at as Date).getTime(), NOW - 3 * DAY);
  });

  it('a silence concludes nothing and makes nothing due under this rule', async () => {
    // The silence ledger is joined to the fault ledger nowhere. A check that could not be
    // asked must not become a reason to ask more — it is somebody else's outage.
    const db = interrogatingDb({
      fleet: seededFleet,
      last: justAsked,
      silences: [{ assertion: FAKING_ASSERTION, person: 'nate-b-jones' }],
    });

    const report = await runInterrogation({
      db,
      interrogator: stubInterrogator({ throws: 'HTTP 500' }),
      issues: recordingFiler(),
      compilerVersion: 'v1',
      now: NOW,
      log: () => {},
    });
    assert.deepEqual(report.asked, []);
    assert.equal(db.faults.size, 0);
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
  it('opens no fault and concludes nothing, so the assertion stays due', async () => {
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
    // The receipt-checking assertion passes (no items to check) — everything else is
    // unreachable.
    assert.ok(report.asked.length > 0);
    assert.ok(report.asked.some((one) => one.passed === null));
    assert.ok(report.asked.some((one) => one.passed === true));
    assert.equal(db.faults.size, 0);
    // The receipt-checking assertion is recorded (it passed without calling the interrogator).
    // Everything else leaves no verdict row, which is what keeps them due.
    assert.ok(db.interrogations.length > 0);
    // Nothing is filed on the first bad night: the day has not passed.
    assert.deepEqual(issues.filed, []);
  });
});

describe('the shape each interrogation request declares', () => {
  /** Every request the interrogator sends, in order, with the field this is about. */
  const recordRequests = async (): Promise<{ system: string; format: unknown }[]> => {
    const sent: { system: string; format: unknown }[] = [];
    const fetcher: Fetcher = async (_url, init) => {
      const body = init!.json as {
        messages: { content: string }[];
        response_format?: unknown;
      };
      sent.push({ system: body.messages[0]!.content, format: body.response_format });
      const judging = body.messages[0]!.content.includes('checking whether one statement is true');
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [
              {
                message: {
                  content: judging
                    ? '{"holds": true, "why": "it does"}'
                    : `${SPOKEN_DISCLOSURE}\n\nI have no way to look anything up.`,
                },
              },
            ],
          });
        },
      };
    };

    await runInterrogation({
      db: interrogatingDb(),
      interrogator: createInterrogator(
        { baseUrl: 'https://judge.invalid/v1', model: 'a-model', apiKey: undefined },
        fetcher,
      ),
      issues: recordingFiler(),
      now: NOW,
      log: () => {},
    });
    return sent;
  };

  it('asks the judge for one JSON object on the request, not only in the prompt', async () => {
    // Found live. Asked for JSON in words alone, this endpoint's model answered through
    // gpt-oss's constrained-JSON channel and the server failed to parse its own output —
    // HTTP 500, four times in five. Intermittent, so it read as a flaky endpoint rather
    // than a missing field, and a 500 scores as *could not be asked*: a day of that and
    // the `reasoning` layer is withdrawn from every persona at once.
    const judged = (await recordRequests()).filter((one) =>
      one.system.includes('checking whether one statement is true'),
    );

    assert.ok(judged.length > 0);
    for (const request of judged) {
      assert.deepEqual(request.format, { type: 'json_object' });
    }
  });

  it('leaves the persona unconstrained, because a persona is asked for prose', async () => {
    // The same field on this call would be a harness braintrust invented: the assertions
    // are about what a persona says in its own voice, and JSON is not a voice.
    const spoken = (await recordRequests()).filter(
      (one) => !one.system.includes('checking whether one statement is true'),
    );

    assert.ok(spoken.length > 0);
    for (const request of spoken) {
      assert.equal(request.format, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// #201 — a check that cannot be asked is counted, and after a day somebody is told
// ---------------------------------------------------------------------------

describe('an assertion that could not be asked', () => {
  it('leaves a durable counted row rather than a log line, and never a fault', async () => {
    const db = interrogatingDb();

    const report = await runInterrogation({
      db,
      interrogator: stubInterrogator({ throws: 'connect ECONNREFUSED' }),
      issues: recordingFiler(),
      now: NOW,
      log: () => {},
    });

    // The first run of this on production read "2 passed, 0 failed, 6 could not be asked"
    // and wrote nothing at all — which is what made every dashboard read 0 failed while the
    // central guarantee went unverified.
    // The receipt-checking assertion is not silenced: it passes because there are no items.
    const silenced = report.asked.filter((one) => one.passed === null);
    assert.equal(report.silenced.length, silenced.length);
    assert.equal(db.silences.size, silenced.length);
    assert.ok(silenced.length > 0);

    const row = [...db.silences.values()][0]!;
    assert.equal(row.attempts, 1);
    assert.ok(row.first_failed_at instanceof Date);
    assert.match(row.detail as string, /ECONNREFUSED/);

    // Silence is never a persona's fault: an outage somewhere else must not put five people
    // in front of a maintainer.
    assert.equal(db.faults.size, 0);
  });

  it('counts consecutive attempts without ever moving the clock it is measured against', async () => {
    const db = interrogatingDb();
    const interrogator = stubInterrogator({ throws: 'HTTP 500' });
    const run = (now: number) =>
      runInterrogation({ db, interrogator, issues: recordingFiler(), now, log: () => {} });

    await run(NOW);
    await run(NOW + DAY / 2);

    const row = [...db.silences.values()][0]!;
    assert.equal(row.attempts, 2);
    // A silence re-observed every morning that reset its own deadline would never file.
    assert.equal((row.first_failed_at as Date).getTime(), NOW);
  });

  it('is cleared by an answer, so a single bad night leaves no trace', async () => {
    const db = interrogatingDb({
      silences: [{ assertion: FAKING_ASSERTION, person: 'nate-b-jones' }],
    });

    await runInterrogation({
      db,
      interrogator: stubInterrogator(),
      issues: recordingFiler(),
      now: NOW + 60_000,
      log: () => {},
    });

    assert.equal(db.silences.size, 0);
  });

  it('is cleared by a failing verdict too, because a check that failed is a check that was made', async () => {
    const db = interrogatingDb({
      silences: [{ assertion: FAKING_ASSERTION, person: 'nate-b-jones' }],
    });

    const report = await runInterrogation({
      db,
      interrogator: stubInterrogator({ holds: false }),
      issues: recordingFiler(),
      now: NOW + 60_000,
      log: () => {},
    });

    // A false verdict is an answer. It has its own fault and its own issue, and leaving the
    // silence row beside it would eventually file "this went unchecked" about the one thing
    // braintrust checked hardest.
    assert.equal(db.silences.size, 0);
    assert.ok(report.failing.includes(FAKING_ASSERTION));
  });

  it('counts a judge that answers but will not judge as the same silence', async () => {
    const db = interrogatingDb();
    // A live endpoint, HTTP 200, well-formed JSON — that answers a persona quite happily and
    // then returns a verdict with no boolean in it.
    const willNotJudge: Fetcher = async (_url, init) => {
      const sent = init!.json as { messages: { content: string }[] };
      const judging = sent.messages[0]!.content.includes('checking whether one statement is true');
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            choices: [
              {
                message: {
                  content: judging
                    ? '{"why": "I would rather not say"}'
                    : `${SPOKEN_DISCLOSURE}\n\nI have no way to look anything up.`,
                },
              },
            ],
          });
        },
      };
    };

    const report = await runInterrogation({
      db,
      interrogator: createInterrogator(
        { baseUrl: 'https://judge.invalid/v1', model: 'a-model', apiKey: undefined },
        willNotJudge,
      ),
      issues: recordingFiler(),
      now: NOW,
      log: () => {},
    });

    // Every way of not getting a verdict is one bucket on one clock — a transport error, an
    // HTTP 500, a non-JSON body, an empty reply and this. Which is the decision, not an
    // accident of error handling: a 500 and a refusal are not distinguishable and never were.
    assert.ok(report.silenced.length > 0);
    assert.ok(db.silences.size > 0);
    assert.equal(db.faults.size, 0);
    assert.match([...db.silences.values()][0]!.detail as string, /boolean verdict/);
  });

  it('opens no fault and withdraws nothing, however long it lasts', () => {
    // The silence ledger and the fault ledger are joined nowhere, so there is no silence a
    // reader could ever be made to pay for.
    assert.deepEqual(withdrawnLayers([], 'nate-b-jones'), []);
  });
});

describe('the one-day silence', () => {
  const six = [
    silence({ assertion: FAKING_ASSERTION, person: 'nate-b-jones', attempts: 2 }),
    silence({ assertion: FAKING_ASSERTION, person: 'add-shore', attempts: 2 }),
    silence({ assertion: DISCLOSURE_ASSERTION, attempts: 2 }),
    silence({ assertion: 'an_empty_answer_is_admitted_and_not_filled', attempts: 2 }),
    silence({ assertion: 'a_persona_that_cannot_reach_the_record_says_so', attempts: 2 }),
  ];

  it('tells nobody before the day is up', () => {
    assert.deepEqual(silencesToFile(six, NOW + SILENCE_REPORTS_AFTER_MS - 1), []);
  });

  it('files one issue for the whole outage once the oldest has outlived the day', () => {
    const owing = silencesToFile(six, NOW + SILENCE_REPORTS_AFTER_MS);

    // Six of eight lost to one endpoint is one thing that is broken. Six issues would be one
    // endpoint triaged six times, and would read as six faults where there is one.
    assert.equal(owing.length, six.length);
  });

  it('carries a check that joined the outage this morning inside the same issue', () => {
    const owing = silencesToFile(
      [...six, silence({ assertion: 'a_late_joiner', first_failed_at: new Date(NOW + DAY).toISOString() })],
      NOW + SILENCE_REPORTS_AFTER_MS,
    );

    // Accepted cost, and the reason it is accepted: it went unchecked too, and a separate
    // issue for it would be the sixth triage of one endpoint.
    assert.ok(owing.some((one) => one.assertion === 'a_late_joiner'));
  });

  it('files once and never again while the ledger stays open', () => {
    const reported = six.map((one, index) =>
      index === 0 ? { ...one, reported_at: new Date(NOW).toISOString() } : one,
    );

    // One reported row silences the whole arm. A monthly re-file was offered and declined as
    // nagging rather than news — and the accepted cost is that a maintainer who closes the
    // issue without shipping a fix is never told again.
    assert.deepEqual(silencesToFile(reported, NOW + 30 * DAY), []);
  });

  it('files for a later outage once the ledger has cleared', () => {
    const fresh = [silence({ assertion: FAKING_ASSERTION, first_failed_at: new Date(NOW).toISOString() })];
    assert.equal(silencesToFile(fresh, NOW + SILENCE_REPORTS_AFTER_MS).length, 1);
  });

  it('files it, marks the whole outage told, and files nothing on the next run', async () => {
    const db = interrogatingDb({
      fleet: [{ person: 'nate-b-jones', items: 34 }, { person: 'add-shore', items: 12 }],
      silences: [
        { assertion: FAKING_ASSERTION, person: 'nate-b-jones', attempts: 2 },
        { assertion: FAKING_ASSERTION, person: 'add-shore', attempts: 2 },
        { assertion: DISCLOSURE_ASSERTION, attempts: 2 },
      ],
    });
    const issues = recordingFiler();
    const interrogator = stubInterrogator({ throws: 'HTTP 500' });

    const first = await runInterrogation({
      db,
      interrogator,
      issues,
      now: NOW + SILENCE_REPORTS_AFTER_MS,
      log: () => {},
    });

    assert.equal(issues.filed.length, 1);
    assert.ok(first.outage);
    assert.equal(first.outage!.issue, 'https://example.invalid/issues/1');
    assert.ok([...db.silences.values()].every((row) => row.reported_at !== null));

    const second = await runInterrogation({
      db,
      interrogator,
      issues,
      now: NOW + 2 * SILENCE_REPORTS_AFTER_MS,
      log: () => {},
    });

    assert.equal(issues.filed.length, 1);
    assert.equal(second.outage, null);
  });

  it('is not marked told when nobody could be told, so it keeps trying', async () => {
    const db = interrogatingDb({
      silences: [{ assertion: DISCLOSURE_ASSERTION, attempts: 2 }],
    });
    const issues = refusingFiler();

    await runInterrogation({
      db,
      interrogator: stubInterrogator({ throws: 'HTTP 500' }),
      issues,
      now: NOW + SILENCE_REPORTS_AFTER_MS,
      log: () => {},
    });

    // A null is nobody heard. Marking it reported anyway would retire the only record that
    // the central guarantee is going unverified.
    assert.equal(issues.attempts.length, 1);
    assert.ok([...db.silences.values()].every((row) => row.reported_at === null));
  });

  it('changes nothing a reader is served while it is open', async () => {
    const db = interrogatingDb({
      silences: [{ assertion: FAKING_ASSERTION, person: 'nate-b-jones', attempts: 2 }],
    });

    await runInterrogation({
      db,
      interrogator: stubInterrogator({ throws: 'HTTP 500' }),
      issues: recordingFiler(),
      now: NOW + SILENCE_REPORTS_AFTER_MS,
      log: () => {},
    });

    // The cost of a third party's outage does not land on a reader who did nothing wrong,
    // and "never verified" is not a quantity with a safe direction to take.
    assert.equal(db.faults.size, 0);
    const payload = await loadPersona(db, 'nate-b-jones');
    assert.ok(payload.speak.includes('HOW THEY ARGUE'));
    assert.ok(!/unverified|could not be asked|outage/i.test(JSON.stringify(payload)));

    const explained = await explainPersona(db, 'nate-b-jones');
    assert.ok(!/unverified|could not be asked|outage/i.test(JSON.stringify(explained)));
  });
});

describe('the issue a day of silence opens', () => {
  const issue = silenceIssue({
    silences: [
      { assertion: FAKING_ASSERTION, attempts: 2, subjects: 5, detail: 'the judge answered HTTP 500' },
      { assertion: DISCLOSURE_ASSERTION, attempts: 2, subjects: 1, detail: 'the judge answered HTTP 500' },
    ],
    since: '2026-08-08T09:00:00.000Z',
    compilerVersion: 'compiler-1',
    interrogator: 'stub@interrogation-1',
  });

  it('names no person anywhere, because the outage was never theirs', () => {
    assert.ok(!/nate-b-jones|add-shore/.test(`${issue.title}\n${issue.body}`));
    // Five personas lost to one endpoint is a count, never a list of names.
    assert.match(issue.body, /5 subject\(s\)/);
  });

  it('lists what went unchecked, and says it is braintrust’s own plumbing', () => {
    assert.match(issue.body, new RegExp(FAKING_ASSERTION));
    assert.match(issue.body, new RegExp(DISCLOSURE_ASSERTION));
    assert.match(issue.body, /braintrust's own plumbing/);
  });

  it('says nothing changed for a reader, and that no fault was opened', () => {
    assert.match(issue.body, /Nothing changed for readers/);
    assert.match(issue.body, /no fault was opened against any persona/);
  });

  it('says a judge that answers without a verdict is the same silence', () => {
    assert.match(issue.body, /answers but will not judge counts as silence/);
    // Because it is: a dead endpoint and a broken judge differ only in the reason text.
    assert.match(issue.body, /HTTP 500/);
  });

  it('records the two accepted costs where a maintainer will read them', () => {
    assert.match(issue.body, /closing this without shipping a fix means nobody is told again/);
    assert.match(issue.body, /stuck for its own reason is reported inside this general outage/);
  });
});

describe('a silence ledger braintrust cannot read', () => {
  it('carries on and says so, because this table ships after the code does', async () => {
    const said: string[] = [];
    const missing: Db = {
      async query<Row>(text: string): Promise<QueryResult<Row>> {
        if (text.includes('braintrust_silences')) {
          throw new Error('relation "braintrust_silences" does not exist');
        }
        return { rows: [] as Row[] };
      },
    };

    await recordSilence(
      missing,
      { assertion: DISCLOSURE_ASSERTION, person: null, detail: 'HTTP 500' },
      (line) => said.push(line),
    );

    // schema.sql is pasted by hand and the code deploys on merge. Between the two an
    // un-migrated deployment degrades to the log line this ticket replaces, not to a job
    // that throws and takes the fault filing down with it.
    assert.match(said[0]!, /schema\.sql has not been run/);
  });
});

describe('the line the job logs', () => {
  it('says how many could not be asked, and names the outage issue when one was filed', () => {
    const line = summariseInterrogation({
      compiler_version: 'compiler-1',
      asked: [
        { assertion: DISCLOSURE_ASSERTION, person: null, subject: 'n', why: 'never_asked', passed: null, detail: 'HTTP 500' },
      ],
      failing: [],
      cleared: [],
      filed: [],
      silenced: [DISCLOSURE_ASSERTION],
      outage: { assertions: [DISCLOSURE_ASSERTION], issue: 'https://example.invalid/issues/1' },
    });

    assert.match(line!, /1 could not be asked/);
    assert.match(line!, /unasked for over a day/);
  });

  it('tells an assertion asked because a fault is open from one asked on the weekly sweep', () => {
    // The extra calls have to be legible: a maintainer watching the log needs to see that
    // five of today's asks are the cost of the fault that is already costing readers a
    // layer, and that the standing sweep is still the standing sweep.
    const line = summariseInterrogation({
      compiler_version: 'compiler-1',
      asked: [
        { assertion: 'the_persona_can_source_its_claims', person: 'nate-b-jones', subject: 'n', why: 'fault_open', passed: true, detail: 'd' },
        { assertion: DISCLOSURE_ASSERTION, person: null, subject: 'n', why: 'weekly_sweep', passed: true, detail: 'd' },
        { assertion: FAKING_ASSERTION, person: null, subject: 'n', why: 'fault_open', passed: true, detail: 'd' },
      ],
      failing: [],
      cleared: [],
      filed: [],
      silenced: [],
      outage: null,
    });

    assert.match(line!, /3 assertion\(s\)/);
    assert.match(line!, /2 because a fault is open/);
    assert.match(line!, /1 on the weekly sweep/);
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

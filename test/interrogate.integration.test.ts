/**
 * The receipt-checking interrogation against a real Postgres.
 *
 * The unit suite holds up the machinery around an assertion — schedule, dedup, escalation —
 * with an in-memory database. What it cannot hold up is the corpus end: the item-selection
 * query and the verification of a quotation against a real retrieved item's body, where rows
 * are actually rows. That is the part that "touches the corpus", and the spec (#253) asks for
 * it to run in CI on every pull request. This file is that part.
 *
 * Fails loudly rather than skipping, like every database-backed suite — a suite that cannot
 * reach its database used to report as passing at skipped 0, which is how a database-only
 * regression merged twice. See test/support/database.ts for how to stand a database up.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { SPOKEN_DISCLOSURE } from '../src/disclosure.js';
import { createDb, type PostgresDb } from '../src/db.js';
import type { Issue, IssueFiler } from '../src/interrogate/issues.js';
import { runInterrogation, type Interrogator } from '../src/interrogate/index.js';

import { testDatabaseUrl as url } from './support/database.js';

const RECEIPT_ID = 'the_persona_can_source_its_claims';

/** Irregular spacing on purpose: a transcript's body, which the comparison must normalise. */
const BODY =
  'A common  pattern here is that\n   humans pick  trades built for\n speed but  forgot  to ' +
  'build the  skill to practice them.';

const ITEM_URL = 'https://natesnewsletter.substack.com/p/speed-versus-skill';
const ITEM_TITLE = 'Speed versus skill';

describe('the receipt-checking interrogation, against real Postgres', () => {
  let db: PostgresDb;

  before(async () => {
    db = createDb(url!);
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (db) {
      await db.query('truncate braintrust_people cascade');
      await db.query('truncate braintrust_faults');
      await db.query('truncate braintrust_interrogations');
      await db.query('truncate braintrust_silences');
      await db.close();
    }
  });

  beforeEach(async () => {
    await db.query('truncate braintrust_people cascade');
    // The ledgers are not foreign-keyed to `braintrust_people`, so truncate cascade leaves
    // them holding the previous test's rows — and this file's whole point is that *one*
    // fault means exactly that.
    await db.query('truncate braintrust_faults');
    await db.query('truncate braintrust_interrogations');
    await db.query('truncate braintrust_silences');
  });

  async function seedOnePersonaItem(bodyText: string | null): Promise<string> {
    const { rows: person } = await db.query<{ id: string }>(
      `insert into braintrust_people (slug, display_name) values ($1, $2) returning id`,
      ['nate-b-jones', 'Nate B. Jones'],
    );
    const { rows: source } = await db.query<{ id: string }>(
      `insert into braintrust_sources
         (person_id, platform, handle, discovery_url, backfill_floor)
       values ($1, 'substack', 'natesnewsletter', 'https://natesnewsletter.substack.com/feed',
               '2025-08-01')
       returning id`,
      [person[0]!.id],
    );
    await db.query(
      `insert into braintrust_items
         (source_id, external_id, url, title, published_at, audience, retrieval, body_text)
       values ($1, 'speed-versus-skill', $2, $3, '2026-08-01', 'everyone', 'retrieved', $4)`,
      [source[0]!.id, ITEM_URL, ITEM_TITLE, bodyText],
    );

    const { rows: compile } = await db.query<{ id: string }>(
      `insert into braintrust_compiles
         (person_id, compiler_version, status, corpus_stats, finished_at)
       values ($1, $2, 'current', $3::jsonb, '2026-08-01')
       returning id`,
      [
        person[0]!.id,
        '1.0.0',
        JSON.stringify({ items_retrieved: 1, window: ['2025-08-01', '2026-08-01'] }),
      ],
    );

    for (const layer of [
      { layer: 'voice', basis: 'measured', descriptive_md: 'voice prose', generative_md: 'Hedge before committing.' },
      { layer: 'reasoning', basis: 'inferred', descriptive_md: '**Inferred — no single item asserts this.**\n\nTraced.', generative_md: null },
      { layer: 'coverage', basis: 'measured', descriptive_md: 'coverage prose', generative_md: null },
    ]) {
      await db.query(
        `insert into braintrust_persona_layers
           (compile_id, layer, basis, descriptive_md, generative_md, evidence)
         values ($1, $2, $3, $4, $5, '{}'::jsonb)`,
        [compile[0]!.id, layer.layer, layer.basis, layer.descriptive_md, layer.generative_md],
      );
    }

    return person[0]!.id;
  }

  /**
   * A model that answers whatever it is told to and judges however it is told to.
   *
   * The receipt check is identified by the payload it hands over — it is the only assertion
   * whose `found` carries the item's own text — and given the named reply; everything else
   * gets a default answer the judge accepts.
   */
  function interrogator(sayWhenAskedForTheRecord: string): Interrogator {
    return {
      generation: 'stub@interrogation-5',
      async reply(exchange) {
        const found = exchange.found as Record<string, unknown> | null;
        if (found && typeof found.item_body === 'string') return sayWhenAskedForTheRecord;
        return `${SPOKEN_DISCLOSURE}\n\nI could not look anything up.`;
      },
      async judge() {
        return { holds: true, why: 'the stub said so' };
      },
    };
  }

  /** A persona that hangs a checkable-looking quotation nobody wrote on the real item's URL. */
  function forger(itemUrl: string): Interrogator {
    return {
      generation: 'stub@interrogation-5',
      async reply(exchange) {
        const found = exchange.found as Record<string, unknown> | null;
        if (found && typeof found.item_body === 'string') {
          return `I said "AI will replace all coders in 2027." It is in the piece at ${itemUrl}`;
        }
        return `${SPOKEN_DISCLOSURE}\n\nI could not look anything up.`;
      },
      async judge() {
        return { holds: true, why: 'the stub said so' };
      },
    };
  }

  const issues: IssueFiler = {
    where: 'a test',
    async file(issue: Issue) {
      return `https://example.invalid/issues/${issue.title.length}`;
    },
  };

  async function run(): Promise<Awaited<ReturnType<typeof runInterrogation>>> {
    return runInterrogation({
      db,
      interrogator: interrogator(
        `In that piece I said it exactly like this: "humans pick trades built for speed but ` +
          `forgot to build the skill to practice them." The piece is at ${ITEM_URL}`,
      ),
      issues,
      now: Date.parse('2026-08-08T09:00:00.000Z'),
      log: () => {},
    });
  }

  it('passes a persona that hands the record over whole, with the quotation and the URL', async () => {
    await seedOnePersonaItem(BODY);

    const report = await run();

    const receipt = report.asked.find((one) => one.assertion === RECEIPT_ID)!;
    assert.equal(receipt.passed, true);

    // The verdict landed in the interrogation ledger.
    const { rows } = await db.query<{ assertion: string; passed: boolean }>(
      'select assertion, passed from braintrust_interrogations where assertion = $1',
      [RECEIPT_ID],
    );
    assert.deepEqual(rows, [{ assertion: RECEIPT_ID, passed: true }]);

    // And an honest handover opens no fault.
    const { rows: faults } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults',
    );
    assert.deepEqual(faults, []);
  });

  it('fails a quotation that is not in the named item, and opens one deduped fault', async () => {
    await seedOnePersonaItem(BODY);

    const forger: Interrogator = {
      generation: 'stub@interrogation-5',
      async reply(exchange) {
        const found = exchange.found as Record<string, unknown> | null;
        if (found && typeof found.item_body === 'string') {
          // The forged citation from #202: a checkable-looking quotation nobody wrote.
          return `I said "AI will replace all coders in 2027." It is in the piece at ${ITEM_URL}`;
        }
        return `${SPOKEN_DISCLOSURE}\n\nI could not look anything up.`;
      },
      async judge() {
        return { holds: true, why: 'the stub said so' };
      },
    };

    const first = await runInterrogation({
      db,
      interrogator: forger,
      issues,
      now: Date.parse('2026-08-08T09:00:00.000Z'),
      log: () => {},
    });
    assert.equal(first.asked.find((one) => one.assertion === RECEIPT_ID)!.passed, false);

    const { rows: once } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults',
    );
    assert.deepEqual(once, [{ assertion: RECEIPT_ID }]);

    // And it stays one fault however often it is re-observed — the row is the deduplication.
    await runInterrogation({
      db,
      interrogator: forger,
      issues,
      now: Date.parse('2026-08-08T09:00:00.000Z'),
      log: () => {},
    });
    const { rows: still } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults',
    );
    assert.deepEqual(still, [{ assertion: RECEIPT_ID }]);
  });

  it('fails a forged quotation riding beside a real, longer one, and opens the one deduped fault', async () => {
    await seedOnePersonaItem(BODY);

    // The #255 gap: the real quotation is the longer of the two, so the old verifier
    // checked it and passed — a Persona could hand over one real span and hang a shorter
    // invention on it. The length of the fabrication has to buy it nothing.
    const sneakyForger: Interrogator = {
      generation: 'stub@interrogation-5',
      async reply(exchange) {
        const found = exchange.found as Record<string, unknown> | null;
        if (found && typeof found.item_body === 'string') {
          return (
            `I said "humans pick trades built for speed but forgot to build the skill to ` +
            `practice them." and also "I predicted this in 2027." Both quotes are in the ` +
            `piece at ${ITEM_URL}`
          );
        }
        return `${SPOKEN_DISCLOSURE}\n\nI could not look anything up.`;
      },
      async judge() {
        return { holds: true, why: 'the stub said so' };
      },
    };

    const report = await runInterrogation({
      db,
      interrogator: sneakyForger,
      issues,
      now: Date.parse('2026-08-08T09:00:00.000Z'),
      log: () => {},
    });
    assert.equal(report.asked.find((one) => one.assertion === RECEIPT_ID)!.passed, false);

    const { rows: once } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults',
    );
    assert.deepEqual(once, [{ assertion: RECEIPT_ID }]);
  });

  it('fails a reply that recites the tool payload, names it recitation, and opens the one deduped fault', async () => {
    await seedOnePersonaItem(BODY);

    // nate-b-jones reciting raw payload at a reader: slug, held_until, a similarity
    // score, citation bookkeeping — beside a genuine quotation and the URL, so the
    // quotation alone would verify. The voice breach is the failure, and the Fault
    // has to say it is recitation rather than fabrication.
    const reciter: Interrogator = {
      generation: 'stub@interrogation-5',
      async reply(exchange) {
        const found = exchange.found as Record<string, unknown> | null;
        if (found && typeof found.item_body === 'string') {
          return (
            `The record shows: "humans pick trades built for speed but forgot to build the ` +
            `skill to practice them." at ${ITEM_URL}. slug: speed-versus-skill, ` +
            `held_until: 2026-06-18, similarity: 0.582, item_count: 9, ` +
            `posted_at: 2026-03-11T18:42:07Z, other: agents-are-prompt-chains`
          );
        }
        return `${SPOKEN_DISCLOSURE}\n\nI could not look anything up.`;
      },
      async judge() {
        return { holds: true, why: 'the stub said so' };
      },
    };

    const report = await runInterrogation({
      db,
      interrogator: reciter,
      issues,
      now: Date.parse('2026-08-08T09:00:00.000Z'),
      log: () => {},
    });

    const receipt = report.asked.find((one) => one.assertion === RECEIPT_ID)!;
    assert.equal(receipt.passed, false);
    assert.match(receipt.detail, /recit/i);
    assert.doesNotMatch(receipt.detail, /forg|fabricat/i);

    // One fault, not a recitation fault and a fabrication fault riding together.
    const { rows: once } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults',
    );
    assert.deepEqual(once, [{ assertion: RECEIPT_ID }]);

    // And it stays one however often it is re-observed — the row is the deduplication.
    await runInterrogation({
      db,
      interrogator: reciter,
      issues,
      now: Date.parse('2026-08-08T09:00:00.000Z'),
      log: () => {},
    });
    const { rows: still } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults',
    );
    assert.deepEqual(still, [{ assertion: RECEIPT_ID }]);
  });

  it('passes a handover that names the piece in marks — the title is a name, not a forged citation', async () => {
    // ITEM_TITLE ("Speed versus skill") is not a span of BODY, so verifying every marked
    // span against the body alone would misread naming the piece as a forged citation. A
    // mark of the item's own title is a name: it neither satisfies the check nor convicts it.
    await seedOnePersonaItem(BODY);

    const namedAndQuoted: Interrogator = {
      generation: 'stub@interrogation-5',
      async reply(exchange) {
        const found = exchange.found as Record<string, unknown> | null;
        if (found && typeof found.item_body === 'string') {
          return (
            `In "${ITEM_TITLE}," I said "humans pick trades built for speed but forgot to ` +
            `build the skill to practice them." The piece is at ${ITEM_URL}`
          );
        }
        return `${SPOKEN_DISCLOSURE}\n\nI could not look anything up.`;
      },
      async judge() {
        return { holds: true, why: 'the stub said so' };
      },
    };

    const report = await runInterrogation({
      db,
      interrogator: namedAndQuoted,
      issues,
      now: Date.parse('2026-08-08T09:00:00.000Z'),
      log: () => {},
    });
    assert.equal(report.asked.find((one) => one.assertion === RECEIPT_ID)!.passed, true);

    const { rows: faults } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults',
    );
    assert.deepEqual(faults, []);
  });

  it('passes a corpus with no usable item honestly — there is nothing to ask about', async () => {
    // A retrieved item whose body was never stored: not something a persona can quote.
    await seedOnePersonaItem(null);

    const report = await run();

    const receipt = report.asked.find((one) => one.assertion === RECEIPT_ID)!;
    assert.equal(receipt.passed, true);

    const { rows: faults } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults',
    );
    assert.deepEqual(faults, []);
  });

  it('asks an assertion whose fault is open on the very next run, and a pass clears the fault', async () => {
    await seedOnePersonaItem(BODY);

    const AT = Date.parse('2026-08-08T09:00:00.000Z');
    const honest = interrogator(
      `In that piece I said it exactly like this: "humans pick trades built for speed but ` +
        `forgot to build the skill to practice them." The piece is at ${ITEM_URL}`,
    );

    // The first run asks everything for the first time, and the receipt check fails, opening
    // the fault — actively extended by next run's re-observe being exactly what #276 is about.
    const first = await runInterrogation({
      db,
      interrogator: forger(ITEM_URL),
      issues,
      compilerVersion: '1.0.0',
      now: AT,
      log: () => {},
    });
    assert.equal(first.asked.find((one) => one.assertion === RECEIPT_ID)!.passed, false);

    // The very next run, at the same instant: same compiler version, nothing rebuilt, a week
    // of sweep left. None of the four clock triggers can explain a re-ask — the open fault
    // is the only reason it is asked at all, and it is the only thing asked.
    const second = await runInterrogation({
      db,
      interrogator: honest,
      issues,
      compilerVersion: '1.0.0',
      now: AT,
      log: () => {},
    });
    assert.equal(second.asked.length, 1);
    assert.deepEqual(second.asked.map((one) => [one.assertion, one.why, one.passed]), [
      [RECEIPT_ID, 'fault_open', true],
    ]);

    // A pass clears the fault, so the layer returns and the next run is quiet again — the
    // answer about whether the fix worked, a day after the fix, not a week later.
    const { rows: faults } = await db.query<{ assertion: string }>(
      'select assertion from braintrust_faults',
    );
    assert.deepEqual(faults, []);
  });
});

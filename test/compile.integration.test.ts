/**
 * The compiler against real Postgres.
 *
 * The claims only a database can settle. A Persona has no independent existence — it is
 * the layers hanging off the one Compile whose status is `current` — and everything
 * below is about that being true rather than nearly true: that a rebuild replaces its
 * predecessor in one step, that a Compile which dies partway changes nothing, that two
 * currents are impossible by construction rather than by the compiler remembering, and
 * that deleting the old row is the whole of the cleanup.
 *
 * Skipped unless BRAINTRUST_TEST_DATABASE_URL is set. To run it locally:
 *
 *   docker run -d --name bt-pg -e POSTGRES_PASSWORD=bt -e POSTGRES_DB=braintrust \
 *     -p 55432:5432 pgvector/pgvector:pg16
 *   BRAINTRUST_TEST_DATABASE_URL=postgresql://postgres:bt@127.0.0.1:55432/braintrust \
 *     npm test
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { compileCorpus, COMPILER_VERSION, STALE_COMPILE_MS } from '../src/compile/index.js';
import { createDb, type Db, type PostgresDb, type TransactionalDb } from '../src/db.js';
import { listPersonas, loadPersona } from '../src/personas.js';
import { chunkItem } from '../src/retrieval/index.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const GENERATION = 'test-reader@notes-1';
const ITEMS = 4;

/** Written so hedging lands in every item and direct address in half of them. */
function body(index: number): string {
  const lines = [
    `I think the ${index}th thing everyone gets wrong is that speed is the constraint.`,
    'It is not. The constraint is knowing which of the twenty things in front of you is worth doing at all.',
  ];
  if (index % 2 === 0) lines.push("Here's what that means for the next thing you build.");
  return lines.join('\n\n');
}

describe('compiling the measured core, against real Postgres', { skip }, () => {
  let db: PostgresDb;
  let personId: string;
  let sourceId: string;

  before(async () => {
    db = createDb(url!);
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (db) {
      await db.query('truncate braintrust_people cascade');
      await db.close();
    }
  });

  beforeEach(async () => {
    await db.query('truncate braintrust_people cascade');
    await seed();
  });

  async function seed(): Promise<void> {
    const person = await db.query<{ id: string }>(
      `insert into braintrust_people (slug, display_name) values ('nate', 'Nate B. Jones') returning id`,
    );
    personId = person.rows[0]!.id;

    const source = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor,
                                       backfill_complete)
       values ($1, 'substack', 'nate.substack.com', 'https://example.test/feed', current_date - 365, true)
       returning id`,
      [personId],
    );
    sourceId = source.rows[0]!.id;

    for (let index = 0; index < ITEMS; index += 1) {
      await addItem(`post-${index}`, body(index), `2025-0${index + 1}-01`);
    }

    // The two skips a persona has to be able to name, and they are not the same fact.
    await db.query(
      `insert into braintrust_items (source_id, external_id, url, audience, retrieval, published_at)
       values ($1, 'paid', 'https://example.test/paid', 'paid', 'skipped_paywall', '2025-03-01'),
              ($1, 'short', 'https://example.test/short', 'everyone', 'skipped_short', '2025-03-02')`,
      [sourceId],
    );
  }

  /** Retrieved, chunked and read — an item with nothing left owed on it. */
  async function addItem(externalId: string, text: string, published: string): Promise<string> {
    const item = await db.query<{ id: string }>(
      `insert into braintrust_items (source_id, external_id, url, audience, retrieval, body_text,
                                     published_at)
       values ($1, $2, $3, 'everyone', 'retrieved', $4, $5) returning id`,
      [sourceId, externalId, `https://example.test/${externalId}`, text, published],
    );
    const itemId = item.rows[0]!.id;

    for (const chunk of chunkItem({ text, raw: null })) {
      await db.query(
        `insert into braintrust_chunks (item_id, ordinal, text, char_start, char_end, start_ms, end_ms)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [itemId, chunk.ordinal, chunk.text, chunk.charStart, chunk.charEnd, chunk.startMs, chunk.endMs],
      );
    }
    await db.query(
      `insert into braintrust_item_notes (item_id, extractor, claims, argument_md, assumptions)
       values ($1, $2, '[]'::jsonb, 'an argument', '[]'::jsonb)`,
      [itemId, GENERATION],
    );
    return itemId;
  }

  function compile(overrides: Partial<Parameters<typeof compileCorpus>[0]> = {}) {
    return compileCorpus({ db, extractor: GENERATION, changed: ['nate'], log: () => {}, ...overrides });
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  async function currentCompileId(): Promise<string | undefined> {
    const { rows } = await db.query<{ id: string }>(
      `select id from braintrust_compiles where person_id = $1 and status = 'current'`,
      [personId],
    );
    return rows[0]?.id;
  }

  it('builds the two measured layers and promotes them', async () => {
    const report = await compile();

    assert.deepEqual(report.compiled, ['nate']);
    assert.equal(report.compiler_version, COMPILER_VERSION);

    const persona = await loadPersona(db, 'nate');
    assert.equal(persona.subject, 'braintrust model of Nate B. Jones');
    assert.deepEqual(Object.keys(persona.layers).sort(), ['coverage', 'voice']);
    assert.equal(persona.layers.voice!.basis, 'measured');
    assert.equal(persona.layers.coverage!.basis, 'measured');
    // The compile declares the generation it read, on the row.
    assert.equal(persona.extractor, GENERATION);
  });

  it('measures the voice over the real item text', async () => {
    await compile();
    const evidence = (await loadPersona(db, 'nate')).layers.voice!.evidence as {
      items_measured: number;
      moves: { move: string; spread: number }[];
    };

    assert.equal(evidence.items_measured, ITEMS);
    assert.equal(evidence.moves.find((one) => one.move === 'hedging')!.spread, ITEMS);
    assert.equal(evidence.moves.find((one) => one.move === 'direct-address')!.spread, ITEMS / 2);
  });

  it('reconciles coverage against the item rows it was counted from', async () => {
    await compile();
    const evidence = (await loadPersona(db, 'nate')).layers.coverage!.evidence as {
      retrieved: number;
      skipped_paywall: number;
      skipped_short: number;
      by_source: Record<string, { retrieved: number }>;
    };

    assert.equal(evidence.retrieved, await count(
      `select count(*) from braintrust_items i join braintrust_sources s on s.id = i.source_id
        where s.person_id = $1 and i.retrieval = 'retrieved'`,
      [personId],
    ));
    assert.equal(evidence.skipped_paywall, 1);
    assert.equal(evidence.skipped_short, 1);
    assert.equal(evidence.by_source['substack:nate.substack.com']!.retrieved, ITEMS);
  });

  it('replaces the previous persona whole, rather than editing it', async () => {
    await compile();
    const first = await currentCompileId();

    await addItem('post-new', body(9), '2025-09-01');
    await compile();
    const second = await currentCompileId();

    assert.notEqual(first, second);
    // The old compile is gone, not archived — a persona cannot drift from its evidence
    // because it has no independent existence.
    assert.equal(await count('select count(*) from braintrust_compiles where id = $1', [first!]), 0);
    assert.equal(
      await count(`select count(*) from braintrust_compiles where person_id = $1 and status = 'current'`, [
        personId,
      ]),
      1,
    );
    const evidence = (await loadPersona(db, 'nate')).layers.voice!.evidence as { items_measured: number };
    assert.equal(evidence.items_measured, ITEMS + 1);
  });

  it('lets on delete cascade do all the cleanup, with no reconciliation step', async () => {
    await compile();
    const compileId = await currentCompileId();
    assert.equal(await count('select count(*) from braintrust_persona_layers where compile_id = $1', [compileId!]), 2);

    await db.query('delete from braintrust_compiles where id = $1', [compileId!]);

    assert.equal(await count('select count(*) from braintrust_persona_layers where compile_id = $1', [compileId!]), 0);
    assert.equal(await count('select count(*) from braintrust_persona_layers'), 0);
  });

  it('refuses a second current compile in the database rather than in the compiler', async () => {
    await compile();

    await assert.rejects(
      () =>
        db.query(
          `insert into braintrust_compiles (person_id, compiler_version, status) values ($1, 'x', 'current')`,
          [personId],
        ),
      /braintrust_compiles_one_current_idx/,
    );
  });

  it('waits while a rebuild is already running, and says when that one started', async () => {
    await db.query(
      `insert into braintrust_compiles (person_id, compiler_version, status) values ($1, 'x', 'running')`,
      [personId],
    );

    const report = await compile();

    assert.deepEqual(report.compiled, []);
    assert.match(report.waiting[0]!.reason, /is still running/);
    assert.equal(await currentCompileId(), undefined);
  });

  it('takes over a running compile whose process is gone, rather than freezing the persona forever', async () => {
    const stale = await db.query<{ id: string }>(
      `insert into braintrust_compiles (person_id, compiler_version, status, started_at)
       values ($1, 'x', 'running', now() - interval '1 millisecond' * $2) returning id`,
      [personId, STALE_COMPILE_MS + 60_000],
    );

    const report = await compile();

    assert.deepEqual(report.compiled, ['nate']);
    // Recorded rather than deleted: the row survives for inspection, with the reason.
    const { rows } = await db.query<{ status: string; rejected_reason: string }>(
      'select status, rejected_reason from braintrust_compiles where id = $1',
      [stale.rows[0]!.id],
    );
    assert.equal(rows[0]!.status, 'failed');
    assert.match(rows[0]!.rejected_reason, /abandoned/);
  });

  it('waits for an empty backlog rather than measuring half a corpus', async () => {
    await compile();
    const before = await currentCompileId();

    await db.query(
      `insert into braintrust_items (source_id, external_id, url, audience, retrieval, published_at)
       values ($1, 'waiting', 'https://example.test/waiting', 'everyone', 'pending', '2025-09-01')`,
      [sourceId],
    );

    const report = await compile();

    assert.deepEqual(report.compiled, []);
    assert.match(report.waiting[0]!.reason, /1 to retrieve/);
    // The previous persona stays live for the duration.
    assert.equal(await currentCompileId(), before);
  });

  it('waits on an item that has been read under a different generation', async () => {
    await compile();
    await addItem('post-unread', body(7), '2025-09-01');
    await db.query(`update braintrust_item_notes set extractor = 'other@notes-1'
                     where item_id = (select id from braintrust_items where external_id = 'post-unread')`);

    const report = await compile();

    assert.deepEqual(report.compiled, []);
    assert.match(report.waiting[0]!.reason, /1 to read/);
  });

  it('does not wait on vectors, which nothing in the core reads', async () => {
    // Chunking survives an endpoint being switched off and the vectors wait. Blocking a
    // rebuild on them would hand a switched-off endpoint a veto over the two layers that
    // cost nothing to compute.
    assert.equal(await count('select count(*) from braintrust_embeddings'), 0);

    const report = await compile();

    assert.deepEqual(report.compiled, ['nate']);
  });

  it('rebuilds a person who has never been compiled, even with nothing new', async () => {
    const report = await compile({ changed: [] });

    assert.deepEqual(report.compiled, ['nate']);
  });

  it('leaves a compiled person alone when nothing arrived', async () => {
    await compile();
    const before = await currentCompileId();

    const report = await compile({ changed: [] });

    assert.deepEqual(report.compiled, []);
    assert.deepEqual(report.waiting, []);
    assert.equal(await currentCompileId(), before);
  });

  it('never rebuilds a paused person, because a pause is the user freezing the persona', async () => {
    await db.query('update braintrust_people set paused_at = now() where id = $1', [personId]);

    const report = await compile();

    assert.deepEqual(report.compiled, []);
    assert.equal(await currentCompileId(), undefined);
  });

  it('changes nothing when a compile fails partway through', async () => {
    await compile();
    const before = await currentCompileId();
    const evidenceBefore = (await loadPersona(db, 'nate')).layers.voice!.evidence;

    await addItem('post-new', body(9), '2025-09-01');
    const report = await compileCorpus({
      db: failingOn(db, 'braintrust_persona_layers'),
      extractor: GENERATION,
      changed: ['nate'],
      log: () => {},
    });

    assert.deepEqual(report.compiled, []);
    assert.equal(report.failed[0]!.person, 'nate');

    // The persona that was already there is untouched, because the delete and the
    // promotion are the same transaction and neither ever ran.
    assert.equal(await currentCompileId(), before);
    assert.deepEqual((await loadPersona(db, 'nate')).layers.voice!.evidence, evidenceBefore);
    assert.equal(
      await count(`select count(*) from braintrust_compiles where person_id = $1 and status = 'failed'`, [
        personId,
      ]),
      1,
    );
  });

  it('writes the corpus stats braintrust_list_personas reports', async () => {
    await compile();

    const { personas } = await listPersonas(db);

    assert.equal(personas[0]!.compiled, true);
    assert.equal(personas[0]!.compiler_version, COMPILER_VERSION);
    assert.equal(personas[0]!.corpus!.items_retrieved, ITEMS);
    assert.equal(personas[0]!.corpus!.items_skipped_paywall, 1);
    assert.deepEqual(personas[0]!.corpus!.window, ['2025-01-01', '2025-04-01']);
  });
});

/**
 * A real database that throws on the first statement touching `marker`. The point is to
 * kill a Compile after it has written rows and before it has promoted, which is the only
 * moment where "a failed compile changes nothing" could be false.
 */
function failingOn(db: PostgresDb, marker: string): TransactionalDb {
  const guard = async <Row>(sql: string, params?: unknown[]) => {
    if (sql.includes(marker)) throw new Error('the database went away mid-compile');
    return db.query<Row>(sql, params);
  };

  return {
    query: guard,
    transaction: <T>(fn: (tx: Db) => Promise<T>) => db.transaction((tx) => fn({ ...tx, query: guard })),
  };
}

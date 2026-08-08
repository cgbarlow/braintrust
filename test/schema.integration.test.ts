/**
 * Runs schema.sql against a real Postgres with pgvector, then checks the two
 * properties the design leans on hardest: the partial unique indexes that make
 * regeneration safe, and that they hold without the compiler remembering to.
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
import { after, before, describe, it } from 'node:test';

import { COMPILER_VERSION } from '../src/compile/version.js';
import { createDb, type PostgresDb } from '../src/db.js';
import { listPersonas } from '../src/personas.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const TABLES = [
  'braintrust_through_line_items',
  'braintrust_through_lines',
  'braintrust_position_relations',
  'braintrust_position_embeddings',
  'braintrust_position_citations',
  'braintrust_positions',
  'braintrust_persona_layers',
  'braintrust_compiles',
  'braintrust_item_notes',
  'braintrust_embeddings',
  'braintrust_chunks',
  'braintrust_items',
  'braintrust_sources',
  'braintrust_people',
];

describe('schema.sql against real Postgres', { skip }, () => {
  let db: PostgresDb;

  before(async () => {
    db = createDb(url!);
    const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    // Applying it twice in a row is the idempotence check: OB1 has no migration
    // framework, so the user re-pastes this file whenever it changes.
    await db.query(sql);
    await db.query(sql);
  });

  after(async () => {
    if (db) {
      await db.query(`truncate ${TABLES.join(', ')} cascade`);
      await db.close();
    }
  });

  async function reset() {
    await db.query(`truncate ${TABLES.join(', ')} cascade`);
  }

  async function insertPerson(slug: string, name: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      'insert into braintrust_people (slug, display_name) values ($1, $2) returning id',
      [slug, name],
    );
    return rows[0]!.id;
  }

  /**
   * **Idempotent means idempotent against a database that already exists**, which is the
   * only kind anybody re-pastes this file into. Applying it twice to a fresh database — the
   * check above — proves nothing about the case that matters: `create table if not exists`
   * leaves an old table alone, so every column and every constraint value added since must
   * arrive by `alter`, and a `comment on` a column that has not arrived yet is a hard error
   * rather than a skipped notice.
   *
   * Found by a real paste into a real database, which failed on two counts at once: a
   * comment ordered before its own alter, and two Position columns that had no alter at all
   * and therefore never reached a deployed database.
   *
   * The old shape is reconstructed rather than read from git, so the test says what it
   * depends on instead of depending on history staying reachable.
   */
  it('upgrades a database that predates every column added since', async () => {
    const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');

    const added: [string, string][] = [
      ['braintrust_items', 'lastmod'],
      ['braintrust_positions', 'held_until'],
      ['braintrust_positions', 'days_spanned'],
      ['braintrust_position_citations', 'post_url'],
      ['braintrust_position_citations', 'posted_at'],
      ['braintrust_compiles', 'extractor'],
    ];

    // Wind the database back to before any of it existed, constraints included.
    for (const [table, column] of added) {
      await db.query(`alter table ${table} drop column if exists ${column}`);
    }
    await db.query(
      `alter table braintrust_sources drop constraint if exists braintrust_sources_platform_check;
       alter table braintrust_sources add constraint braintrust_sources_platform_check
         check (platform in ('substack', 'youtube'));
       alter table braintrust_items drop constraint if exists braintrust_items_retrieval_check;
       alter table braintrust_items add constraint braintrust_items_retrieval_check
         check (retrieval in ('pending', 'retrieved', 'skipped_paywall', 'failed'));`,
    );

    // The paste, exactly as a user makes it.
    await db.query(sql);

    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and (table_name, column_name) in (${added
          .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
          .join(', ')})`,
      added.flat(),
    );
    assert.equal(rows.length, added.length, 'every column added since has to reach an old database');

    // And the constraints let the newer values through, which is the other half of it.
    const { rows: platforms } = await db.query<{ check: string }>(
      `select pg_get_constraintdef(oid) as check from pg_constraint
        where conname = 'braintrust_sources_platform_check'`,
    );
    assert.match(platforms[0]!.check, /bluesky/);
    assert.match(platforms[0]!.check, /blog/);

    const { rows: retrievals } = await db.query<{ check: string }>(
      `select pg_get_constraintdef(oid) as check from pg_constraint
        where conname = 'braintrust_items_retrieval_check'`,
    );
    assert.match(retrievals[0]!.check, /skipped_not_a_post/);
  });

  it('creates every table the design specifies, with RLS enabled on each', async () => {
    const { rows } = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables
        where schemaname = 'public' and tablename like 'braintrust\\_%' order by tablename`,
    );

    assert.deepEqual(rows.map((r) => r.tablename).sort(), [...TABLES].sort());
    assert.ok(
      rows.every((r) => r.rowsecurity),
      'every braintrust table should have RLS enabled',
    );
  });

  it('allows at most one current compile per person', async () => {
    await reset();
    const person = await insertPerson('one-current', 'One Current');

    await db.query(
      `insert into braintrust_compiles (person_id, compiler_version, status)
       values ($1, '0.1.0', 'current')`,
      [person],
    );

    await assert.rejects(
      db.query(
        `insert into braintrust_compiles (person_id, compiler_version, status)
         values ($1, '0.1.0', 'current')`,
        [person],
      ),
      /braintrust_compiles_one_current_idx/,
    );
  });

  it('allows at most one running compile per person, which is what makes ungated refresh safe', async () => {
    await reset();
    const person = await insertPerson('one-running', 'One Running');

    await db.query(
      `insert into braintrust_compiles (person_id, compiler_version, status)
       values ($1, '0.1.0', 'running')`,
      [person],
    );

    // Two clients calling refresh seconds apart must not produce two rebuilds.
    await assert.rejects(
      db.query(
        `insert into braintrust_compiles (person_id, compiler_version, status)
         values ($1, '0.1.0', 'running')`,
        [person],
      ),
      /braintrust_compiles_one_running_idx/,
    );
  });

  it('lets a running compile coexist with the current one it will replace', async () => {
    await reset();
    const person = await insertPerson('coexist', 'Coexist');

    await db.query(
      `insert into braintrust_compiles (person_id, compiler_version, status)
       values ($1, '0.1.0', 'current'), ($1, '0.2.0', 'running')`,
      [person],
    );

    const { rows } = await db.query<{ count: string }>(
      'select count(*) as count from braintrust_compiles where person_id = $1',
      [person],
    );
    assert.equal(rows[0]!.count, '2');
  });

  it('rolls a failed promotion back, leaving the previous persona live', async () => {
    await reset();
    const person = await insertPerson('rollback', 'Rollback');

    const { rows: existing } = await db.query<{ id: string }>(
      `insert into braintrust_compiles (person_id, compiler_version, status)
       values ($1, '0.1.0', 'current') returning id`,
      [person],
    );

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query('delete from braintrust_compiles where person_id = $1 and status = $2', [
          person,
          'current',
        ]);
        throw new Error('gate rejected this compile');
      }),
      /gate rejected/,
    );

    // A failed compile changes nothing.
    const { rows } = await db.query<{ id: string; status: string }>(
      'select id, status from braintrust_compiles where person_id = $1',
      [person],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, existing[0]!.id);
    assert.equal(rows[0]!.status, 'current');
  });

  it('enforces the audience and retrieval vocabularies', async () => {
    await reset();
    const person = await insertPerson('vocab', 'Vocab');
    const { rows: source } = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor)
       values ($1, 'substack', 'example', 'https://example.com/feed', '2025-08-01') returning id`,
      [person],
    );

    // 'only_paid' is a live Substack value, and it is deliberately not in the
    // column's vocabulary — the mapping to 'paid' is an allow-list in code.
    await assert.rejects(
      db.query(
        `insert into braintrust_items (source_id, external_id, url, audience)
         values ($1, '1', 'https://example.com/p/1', 'only_paid')`,
        [source[0]!.id],
      ),
      /audience/,
    );

    await assert.rejects(
      db.query(
        `insert into braintrust_items (source_id, external_id, url, retrieval)
         values ($1, '2', 'https://example.com/p/2', 'skipped')`,
        [source[0]!.id],
      ),
      /retrieval/,
    );

    // Every skip braintrust decides for itself. `create table if not exists` leaves an
    // existing table alone, so the re-stated constraint below the DDL is the only thing
    // that lets an already-deployed database accept a state added later — and this is
    // where that idempotent restatement is proved rather than assumed.
    for (const [index, skip] of ['skipped_paywall', 'skipped_short', 'skipped_window'].entries()) {
      await db.query(
        `insert into braintrust_items (source_id, external_id, url, retrieval)
         values ($1, $2, 'https://example.com/p/skip', $3)`,
        [source[0]!.id, `skip-${index}`, skip],
      );
    }
  });

  it('serves list_personas from real rows', async () => {
    await reset();
    // The listing says which rules are current even when it lists nobody — that is how a
    // client tells "no personas" from "a braintrust that cannot say what it is running".
    assert.deepEqual(await listPersonas(db), {
      personas: [],
      current_compiler_version: COMPILER_VERSION,
    });

    const person = await insertPerson('nate-b-jones', 'Nate B. Jones');
    await insertPerson('someone-else', 'Aaron Someone');

    const beforeCompile = await listPersonas(db);
    // Ordered by display name, and neither has been compiled yet.
    assert.deepEqual(
      beforeCompile.personas.map((p) => [p.subject, p.compiled]),
      [
        ['braintrust model of Aaron Someone', false],
        ['braintrust model of Nate B. Jones', false],
      ],
    );

    await db.query(
      `insert into braintrust_compiles
         (person_id, compiler_version, status, finished_at, corpus_stats)
       values ($1, '0.3.1', 'current', '2026-07-28T09:14:22Z', $2::jsonb)`,
      [
        person,
        JSON.stringify({
          items_retrieved: 412,
          items_skipped_paywall: 304,
          window: ['2025-08-01', '2026-07-29'],
        }),
      ],
    );

    const after = await listPersonas(db);
    const nate = after.personas.find((p) => p.person === 'nate-b-jones')!;
    assert.equal(nate.compiled, true);
    assert.equal(nate.compiled_at, '2026-07-28T09:14:22.000Z');
    assert.equal(nate.compiler_version, '0.3.1');
    assert.deepEqual(nate.corpus?.window, ['2025-08-01', '2026-07-29']);
  });

  it('shows a pause without deleting anything', async () => {
    await reset();
    const person = await insertPerson('paused-person', 'Paused Person');
    await db.query(
      `insert into braintrust_compiles (person_id, compiler_version, status, finished_at)
       values ($1, '0.3.1', 'current', now())`,
      [person],
    );
    await db.query('update braintrust_people set paused_at = now() where id = $1', [person]);

    const { personas } = await listPersonas(db);
    // Still listed, still compiled, and the pause is visible.
    assert.equal(personas.length, 1);
    assert.equal(personas[0]!.compiled, true);
    assert.ok(personas[0]!.paused?.since);
  });

  it('accepts a 1024-dimension vector and rejects a differently-sized one', async () => {
    await reset();
    const person = await insertPerson('vectors', 'Vectors');
    const { rows: source } = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor)
       values ($1, 'youtube', 'UC123', 'https://example.com/feed.xml', '2025-08-01') returning id`,
      [person],
    );
    const { rows: item } = await db.query<{ id: string }>(
      `insert into braintrust_items (source_id, external_id, url) values ($1, 'v1', 'https://x/1')
       returning id`,
      [source[0]!.id],
    );
    const { rows: chunk } = await db.query<{ id: string }>(
      `insert into braintrust_chunks (item_id, ordinal, text, char_start, char_end)
       values ($1, 0, 'so the thing about evals is', 0, 26) returning id`,
      [item[0]!.id],
    );

    const ok = `[${Array.from({ length: 1024 }, () => 0.01).join(',')}]`;
    await db.query(
      'insert into braintrust_embeddings (chunk_id, model, embedding) values ($1, $2, $3)',
      [chunk[0]!.id, 'qwen3-embedding:0.6b', ok],
    );

    // A differently-sized model fails loudly on insert. The dangerous case — a
    // same-sized, different model — is silent here and is closed by a startup check.
    const wrong = `[${Array.from({ length: 768 }, () => 0.01).join(',')}]`;
    await assert.rejects(
      db.query('insert into braintrust_embeddings (chunk_id, model, embedding) values ($1, $2, $3)', [
        chunk[0]!.id,
        'nomic-embed-text',
        wrong,
      ]),
      /expected 1024 dimensions/,
    );
  });
});

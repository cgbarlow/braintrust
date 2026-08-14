/**
 * The database URL every integration suite needs, demanded rather than skipped, and
 * scoped so two suites running at once cannot corrupt each other.
 *
 * The demand exists for the failure it replaces: node's test runner reports a suite
 * skipped with `{ skip }` as `skipped 0, tests 0` — indistinguishable from a green
 * run. That shaped run is how a PR that breaks a database-backed test merged while
 * the suite reported 775 green, so a suite that cannot reach its database now says
 * so and exits non-zero rather than quietly counting as passing.
 *
 * Run the unit tests alone with `npm run test:unit`, or point this variable at a
 * Postgres with pgvector to run everything:
 *
 *   docker run -d --name bt-pg -e POSTGRES_PASSWORD=bt -e POSTGRES_DB=braintrust \
 *     -p 55432:5432 pgvector/pgvector:pg16
 *   BRAINTRUST_TEST_DATABASE_URL=postgresql://postgres:bt@127.0.0.1:55432/braintrust \
 *     npm test
 *
 * Throwing at module load is deliberate: a test file that cannot load is a failure a
 * PR has to answer, where a describe that skips is a success nobody sees.
 *
 * **Every checkout gets its own database, because every suite opens by truncating.**
 * Two runs against one database is not a slow run, it is a wrong one: each `truncate
 * braintrust_people cascade` deletes the other's rows mid-test. CI never sees this —
 * it gives each job its own Postgres service container — so the isolation exists
 * there by accident of the platform and nowhere else. Locally there are as many
 * concurrent runs as there are agents building tickets, plus whoever is typing.
 *
 * Found by running the suite while two agents built in their own worktrees: 101
 * integration failures on a green commit, `deadlock detected`, and the same tests
 * green the moment they had a database to themselves. **The deadlock is the lucky
 * outcome** — it is loud, and it fails. Two suites that interleave `truncate` and
 * `insert` without deadlocking hand somebody a red they cannot reproduce, or a green
 * another run's rows paid for.
 *
 * A git worktree isolates files and stops there; nothing carried that isolation as
 * far as Postgres. This does, at the one seam every suite already comes through, so
 * no suite changes and none of them can forget.
 *
 * **A database rather than a schema, and `schema.sql` is the reason.** Scoping by
 * `search_path` looks lighter and fails: the RLS block at the end of `schema.sql`
 * writes `alter table public.%I`, so the tables land in the run's schema and the
 * grants go looking for them in `public`. That file is pasted into production by
 * hand, so it sets the terms here rather than bending to the tests — and a database
 * per checkout gives each run a `public` of its own, which is what the file already
 * expects. Caught by CI on a fresh database after passing locally, where `public`
 * still held tables from earlier shared runs: the leftover state this module exists
 * to eliminate, hiding the bug in the fix for it.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { Client } from 'pg';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;

if (!url) {
  throw new Error(
    'BRAINTRUST_TEST_DATABASE_URL is not set, so the database-backed tests cannot run. ' +
      "A suite that cannot reach its database used to count as passing (silently, at skipped 0), " +
      'and that is how a regression reached a production corpus twice. Run `npm run test:unit` ' +
      'for the unit tests alone, or set the variable to a Postgres with pgvector and run `npm test`:\n' +
      '\n' +
      '  docker run -d --name bt-pg -e POSTGRES_PASSWORD=bt -e POSTGRES_DB=braintrust \\\n' +
      '    -p 55432:5432 pgvector/pgvector:pg16\n' +
      '  BRAINTRUST_TEST_DATABASE_URL=postgresql://postgres:bt@127.0.0.1:55432/braintrust npm test',
  );
}

/**
 * One database per checkout, named from its path.
 *
 * Derived rather than random so a worktree reuses its own database run after run: a
 * random name per run would be correct and would leave a dead database behind every
 * time, which is a slow leak in a container people keep for weeks. Hashed rather
 * than spelled out because an identifier is 63 bytes and a worktree path is not.
 */
const checkout = process.cwd();
const database = `bt_test_${createHash('sha256').update(checkout).digest('hex').slice(0, 12)}`;
const quotedPath = `'${checkout.replace(/'/g, "''")}'`;

const admin = new Client({ connectionString: url });
await admin.connect();
try {
  try {
    await admin.query(`create database ${database}`);
  } catch (error) {
    // 42P04 is "already exists", which is the steady state after the first run and
    // also what two runs of one checkout race into. Anything else is real.
    if ((error as { code?: string }).code !== '42P04') throw error;
  }
  // The path is the database's own record of which checkout owns it — the only
  // thing that makes the sweep below possible, since Postgres does not date one.
  // `comment on` is a utility statement and takes no parameters, so the literal is
  // quoted here rather than bound.
  await admin.query(`comment on database ${database} is ${quotedPath}`);

  // **A worktree outlives its database by default, so sweep the dead ones.** The
  // harness deletes a worktree when a ticket lands and Postgres never hears about
  // it. A database whose checkout is gone can hold nothing anybody wants, and
  // leaving it is how a shared container silently fills with the residue of merged
  // work.
  const { rows } = await admin.query<{ datname: string; owner: string | null }>(
    `select d.datname, shobj_description(d.oid, 'pg_database') as owner
       from pg_database d
      where d.datname like 'bt\\_test\\_%'
        and d.datname <> current_database()`,
  );
  for (const row of rows) {
    if (row.datname === database) continue;
    // No comment means a database from before this shipped, or one somebody made by
    // hand: leave it alone rather than guess. Dropping something whose owner cannot
    // be established is not a sweep.
    if (!row.owner || existsSync(row.owner)) continue;
    // `force` because a run killed mid-suite leaves its connections behind, and a
    // sweep that any stale backend can veto is a sweep that never happens.
    await admin.query(`drop database if exists ${row.datname} with (force)`);
  }
} finally {
  await admin.end();
}

const scoped = new URL(url);
scoped.pathname = `/${database}`;

export const testDatabaseUrl = scoped.toString();

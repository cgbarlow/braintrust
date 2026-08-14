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
 * **Every suite gets its own schema, because every suite opens by truncating.** Two
 * runs against one database is not a slow run, it is a wrong one: each `truncate
 * braintrust_people cascade` deletes the other's rows mid-test. CI never sees this —
 * it gives each job its own Postgres service container — so the isolation exists
 * there by accident of the platform and nowhere else. Locally there are as many
 * concurrent runs as there are agents building tickets, plus whoever is typing.
 *
 * Found by running the suite while two agents built in their own worktrees: 101
 * integration failures on a green commit, `deadlock detected`, and the same tests
 * 93 of 93 green the moment they had a database to themselves. **The deadlock is the
 * lucky outcome** — it is loud, and it fails. Two suites that interleave `truncate`
 * and `insert` without deadlocking hand somebody a red they cannot reproduce, or a
 * green another run's rows paid for.
 *
 * A git worktree isolates files and stops there; nothing carried that isolation as
 * far as Postgres. This does, at the one seam every suite already comes through, so
 * no suite changes and none of them can forget.
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
 * One schema per checkout, named from its path.
 *
 * Derived rather than random so a worktree reuses its own schema run after run: a
 * random name per run would be correct and would leave a dead schema behind every
 * time, which is a slow leak in a container people keep for weeks. Hashed rather
 * than spelled out because a schema name is 63 bytes and a worktree path is not.
 */
const checkout = process.cwd();
const schema = `bt_test_${createHash('sha256').update(checkout).digest('hex').slice(0, 12)}`;

const admin = new Client({ connectionString: url });
await admin.connect();
try {
  await admin.query(`create schema if not exists ${schema}`);
  // The path is the schema's own record of which checkout owns it — the only thing
  // that makes the sweep below possible, since Postgres does not date a schema.
  // `comment on` is a utility statement and takes no parameters, so the literal is
  // quoted here rather than bound.
  await admin.query(`comment on schema ${schema} is '${checkout.replace(/'/g, "''")}'`);

  // **A worktree outlives its schema by default, so sweep the dead ones.** The
  // harness deletes a worktree when a ticket lands and Postgres never hears about
  // it. A schema whose checkout is gone can hold nothing anybody wants, and leaving
  // it is how a shared container silently fills with the residue of merged work.
  const { rows } = await admin.query<{ nspname: string; owner: string | null }>(
    `select n.nspname, obj_description(n.oid, 'pg_namespace') as owner
       from pg_namespace n
      where n.nspname like 'bt\\_test\\_%'`,
  );
  for (const row of rows) {
    if (row.nspname === schema) continue;
    // No comment means a schema from before this shipped: leave it alone rather than
    // guess. Deleting something whose owner cannot be established is not a sweep.
    if (!row.owner || existsSync(row.owner)) continue;
    await admin.query(`drop schema if exists ${row.nspname} cascade`);
  }
} finally {
  await admin.end();
}

/**
 * `public` stays on the path behind the run's own schema, so the `vector` type
 * installed once per database still resolves for every run that needs it. Ordering
 * matters and this is the order: unqualified `create table` lands in the run's
 * schema, and unqualified `truncate` reaches only the run's rows.
 *
 * Carried on the URL rather than set per connection because the pool opens
 * connections whenever it likes, and a `set search_path` on one of them is a
 * property the next one does not have.
 */
const scoped = new URL(url);
scoped.searchParams.set('options', `-c search_path=${schema},public`);

export const testDatabaseUrl = scoped.toString();

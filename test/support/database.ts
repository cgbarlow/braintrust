/**
 * The database URL every integration suite needs, demanded rather than skipped.
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
 */
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

export { url as testDatabaseUrl };

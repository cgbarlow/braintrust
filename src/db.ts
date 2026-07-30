/**
 * The database seam.
 *
 * braintrust connects to Postgres directly over Supabase's session pooler rather
 * than through PostgREST with the service-role key, because promoting a compile
 * is a multi-statement transaction and PostgREST has none.
 * See docs/design/deployment.md §5.
 *
 * Everything above this module depends on `Db`, not on `pg`. That is the whole
 * point of the interface: the read path can be tested without a database, and
 * the compiler's promoting transaction has one place to reach for.
 */

import { Pool, type PoolClient } from 'pg';

export type QueryResult<Row> = { rows: Row[] };

export interface Db {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

export interface TransactionalDb extends Db {
  /**
   * Runs `fn` inside one transaction, committing on return and rolling back on
   * throw. Compile promotion depends on this existing; nothing in this ticket
   * uses it yet.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export type PostgresDb = TransactionalDb & { close(): Promise<void> };

export function createDb(databaseUrl: string): PostgresDb {
  const pool = new Pool({ connectionString: databaseUrl });

  const queryVia = (runner: Pool | PoolClient): Db['query'] =>
    async function query<Row>(sql: string, params?: unknown[]) {
      const result = await runner.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as Row[] };
    };

  return {
    query: queryVia(pool),

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn({ query: queryVia(client) });
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => {
          // The original error is the one worth reporting.
        });
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

/**
 * Fake databases. `Db` is an interface for exactly this reason.
 *
 * `refusingDb` is the important one: call 1 of the follow handshake is supposed to
 * ingest nothing, and a database that throws on contact turns that from a claim into
 * a test that fails if anyone ever adds a write.
 */

import type { Db, QueryResult, TransactionalDb } from '../../src/db.js';

export type Recorded = { sql: string; params: unknown[] };

export type Answer = (sql: string, params: unknown[]) => QueryResult<never> | Record<string, unknown>[];

export type FakeDb = TransactionalDb & {
  calls: Recorded[];
  /** Normalised to single spaces, so assertions do not depend on SQL indentation. */
  sql(): string[];
  transactions: number;
};

export function fakeDb(answer: Answer = () => []): FakeDb {
  const calls: Recorded[] = [];
  let transactions = 0;

  const query = async <Row>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> => {
    calls.push({ sql, params });
    const result = answer(sql, params);
    return (Array.isArray(result) ? { rows: result as Row[] } : result) as QueryResult<Row>;
  };

  const db: FakeDb = {
    calls,
    get transactions() {
      return transactions;
    },
    sql: () => calls.map((call) => call.sql.replace(/\s+/g, ' ').trim()),
    query,
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      transactions += 1;
      return fn({ query });
    },
  };

  return db;
}

/** Any contact at all is a failure. Used to prove call 1 writes nothing. */
export const refusingDb: TransactionalDb = {
  async query() {
    throw new Error('the database was touched, and this code path must not touch it');
  },
  async transaction() {
    throw new Error('a transaction was opened, and this code path must not open one');
  },
};

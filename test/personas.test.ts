import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Db, QueryResult } from '../src/db.js';
import { listPersonas } from '../src/personas.js';

/**
 * The listing asks two questions — who exists, and which sources have stopped
 * answering — so the fake answers by which one it was asked. A fake that returned the
 * people rows to both would be testing a query braintrust does not make.
 */
function fakeDb(rows: Record<string, unknown>[], blocked: Record<string, unknown>[] = []): Db {
  return {
    async query<Row>(sql: string): Promise<QueryResult<Row>> {
      return { rows: (sql.includes('blocked_at is not null') ? blocked : rows) as Row[] };
    },
  };
}

describe('listPersonas', () => {
  it('returns an empty list against an empty database', async () => {
    assert.deepEqual(await listPersonas(fakeDb([])), { personas: [] });
  });

  it('names a persona as a model, never with the bare name', async () => {
    const { personas } = await listPersonas(
      fakeDb([
        {
          person: 'nate-b-jones',
          display_name: 'Nate B. Jones',
          paused_at: null,
          compiled_at: null,
          compiler_version: null,
          corpus_stats: null,
        },
      ]),
    );

    assert.equal(personas[0]!.subject, 'braintrust model of Nate B. Jones');
    assert.ok(!Object.values(personas[0]!).includes('Nate B. Jones'));
  });

  it('expresses never-compiled as compiled: false rather than an error', async () => {
    const { personas } = await listPersonas(
      fakeDb([
        {
          person: 'nate-b-jones',
          display_name: 'Nate B. Jones',
          paused_at: null,
          compiled_at: null,
          compiler_version: null,
          corpus_stats: {},
        },
      ]),
    );

    assert.equal(personas[0]!.compiled, false);
    assert.equal(personas[0]!.compiled_at, undefined);
    assert.equal(personas[0]!.corpus, undefined);
  });

  it('reports a compiled persona with its corpus and no computed staleness', async () => {
    const compiledAt = new Date('2026-07-28T09:14:22Z');
    const { personas } = await listPersonas(
      fakeDb([
        {
          person: 'nate-b-jones',
          display_name: 'Nate B. Jones',
          paused_at: null,
          compiled_at: compiledAt,
          compiler_version: '0.3.1',
          corpus_stats: {
            items_retrieved: 412,
            items_skipped_paywall: 304,
            window: ['2025-08-01', '2026-07-29'],
          },
        },
      ]),
    );

    const persona = personas[0]!;
    assert.equal(persona.compiled, true);
    assert.equal(persona.compiled_at, '2026-07-28T09:14:22.000Z');
    assert.equal(persona.compiler_version, '0.3.1');
    assert.deepEqual(persona.corpus, {
      items_retrieved: 412,
      items_skipped_paywall: 304,
      window: ['2025-08-01', '2026-07-29'],
    });
    // Staleness is compiled_at and the client judges it.
    assert.ok(!('stale' in persona) && !('age_days' in persona));
  });

  it('omits the corpus block rather than reporting zeroes it did not measure', async () => {
    const { personas } = await listPersonas(
      fakeDb([
        {
          person: 'nate-b-jones',
          display_name: 'Nate B. Jones',
          paused_at: null,
          compiled_at: new Date('2026-07-28T09:14:22Z'),
          compiler_version: '0.3.1',
          corpus_stats: { items_retrieved: 412 }, // partial: the compiler is not built yet
        },
      ]),
    );

    assert.equal(personas[0]!.compiled, true);
    assert.equal(personas[0]!.corpus, undefined);
  });

  it('makes a pause visible, and does not dress it up as anything else', async () => {
    const { personas } = await listPersonas(
      fakeDb([
        {
          person: 'nate-b-jones',
          display_name: 'Nate B. Jones',
          paused_at: new Date('2026-07-20T00:00:00Z'),
          compiled_at: new Date('2026-07-19T09:00:00Z'),
          compiler_version: '0.3.1',
          corpus_stats: null,
        },
      ]),
    );

    // A paused person is still listed, and still answerable.
    assert.equal(personas[0]!.compiled, true);
    assert.deepEqual(personas[0]!.paused, { since: '2026-07-20T00:00:00.000Z' });
  });

  it('has no pause key at all for a person still being followed', async () => {
    const { personas } = await listPersonas(
      fakeDb([
        {
          person: 'nate-b-jones',
          display_name: 'Nate B. Jones',
          paused_at: null,
          compiled_at: null,
          compiler_version: null,
          corpus_stats: null,
        },
      ]),
    );

    assert.ok(!('paused' in personas[0]!));
  });
});

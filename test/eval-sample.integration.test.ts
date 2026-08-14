/**
 * The eval set, against real Postgres.
 *
 * **The property that matters is that it does not move.** Two models scored on two
 * different samples produce two numbers nobody can put beside each other — and re-sampling
 * until a favoured model wins is exactly what a benchmark exists to prevent. Only a real
 * database can show that the order does not depend on insertion order, on how far a
 * backfill reached, or on anything else that changes between runs.
 *
 * Fails loudly rather than skipping: a suite that cannot reach its database used to
 * report as passing (skipped 0), which is how a database-only regression merged twice.
 * See cycle.integration.test.ts for how to stand a database up.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createDb, type PostgresDb } from '../src/db.js';
import { BANDS, describeSample, sampleCorpus } from '../src/eval/sample.js';
import { testDatabaseUrl as url } from './support/database.js';

describe('the eval set, against real Postgres', () => {
  let db: PostgresDb;

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
  });

  /** Items of a given length, so the bands have something to sort into. */
  async function corpus(counts: { short: number; medium: number; long: number }): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      "insert into braintrust_people (slug, display_name) values ('p', 'P') returning id",
    );
    const { rows: sources } = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor)
       values ($1, 'youtube', 'UC1', 'https://x/feed', '2020-01-01') returning id`,
      [rows[0]!.id],
    );

    const write = async (prefix: string, words: number, howMany: number) => {
      for (let index = 0; index < howMany; index += 1) {
        await db.query(
          `insert into braintrust_items (source_id, external_id, url, retrieval, body_text)
           values ($1, $2, $3, 'retrieved', $4)`,
          [sources[0]!.id, `${prefix}-${index}`, `https://x/${prefix}-${index}`, 'word '.repeat(words).trim()],
        );
      }
    };

    await write('short', 200, counts.short);
    await write('medium', 3_000, counts.medium);
    await write('long', 9_000, counts.long);
  }

  it('returns the same items every time it is asked', async () => {
    await corpus({ short: 20, medium: 20, long: 20 });

    const first = await sampleCorpus(db, 12);
    const second = await sampleCorpus(db, 12);

    assert.equal(first.length, 12);
    assert.deepEqual(
      first.map((item) => item.external_id),
      second.map((item) => item.external_id),
      'a sample that moves between runs cannot compare two models',
    );
  });

  /**
   * Without this, an unstratified sample of a corpus that is mostly one form would decide
   * the long-context question on whichever two or three long items happened to be drawn.
   */
  it('spreads across the length bands rather than taking whatever is commonest', async () => {
    await corpus({ short: 60, medium: 6, long: 6 });

    const items = await sampleCorpus(db, 12);
    for (const band of BANDS) {
      assert.equal(
        items.filter((item) => item.band === band.name).length,
        4,
        `${band.name} should have its share even though short items outnumber it ten to one`,
      );
    }
  });

  it('fills the sample from the other bands when one is short of items', async () => {
    await corpus({ short: 30, medium: 1, long: 0 });

    const items = await sampleCorpus(db, 12);
    assert.equal(items.length, 12, 'a thin band returns a full sample, not a short one');
    assert.equal(items.filter((item) => item.band === 'medium').length, 1);
  });

  it('takes only what the read pass would ever be handed', async () => {
    await corpus({ short: 4, medium: 0, long: 0 });
    await db.query(
      `update braintrust_items set retrieval = 'skipped_short', body_text = null
        where external_id = 'short-0'`,
    );

    const items = await sampleCorpus(db, 12);
    assert.equal(items.length, 3);
    assert.ok(!items.some((item) => item.external_id === 'short-0'));
  });

  it('describes what the set is made of, for the line above a scorecard', async () => {
    await corpus({ short: 4, medium: 4, long: 4 });
    const described = describeSample(await sampleCorpus(db, 6));

    assert.match(described, /^6 items \(2 short, 2 medium, 2 long\)/);
    assert.match(described, /words$/);
  });
});

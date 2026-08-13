/**
 * The blog archive walk against real Postgres.
 *
 * The claims here are the ones only a real database can settle. `skipped_not_a_post` is a
 * value a check constraint has to accept, and `create table if not exists` will not add it
 * to a table that already exists — so this is also the test that the drop-and-restate in
 * `schema.sql` actually ran. The `lastmod` freeze is the other one: it is expressed as a
 * `case` inside an `on conflict do update`, and whether that really leaves a decided row
 * alone is a question about Postgres rather than about TypeScript.
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

import { measureCoverage } from '../src/compile/store.js';
import { createDb, type PostgresDb } from '../src/db.js';
import { walkBlogArchive } from '../src/ingest/blog.js';
import {
  corpusCounts,
  markSkippedNotAPost,
  recordCatalogued,
  skippedNotPosts,
  type SourceRow,
} from '../src/ingest/items.js';
import { fakeFetcher } from './support/sources.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const HOST = 'notes.example.com';
const HOMEPAGE = `https://${HOST}/`;
const POST = `https://${HOST}/post-0/`;

function sitemap(entries: { loc: string; lastmod: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${entries
    .map((entry) => `<url><loc>${entry.loc}</loc><lastmod>${entry.lastmod}</lastmod></url>`)
    .join('\n  ')}
</urlset>`;
}

describe('walking a blog archive, against real Postgres', { skip }, () => {
  let db: PostgresDb;
  let source: SourceRow;

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

    const person = await db.query<{ id: string }>(
      `insert into braintrust_people (slug, display_name) values ('ada', 'Ada Whitfield') returning id`,
    );
    const row = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor)
       values ($1, 'blog', $2, $3, current_date - 365) returning id`,
      [person.rows[0]!.id, HOST, `https://${HOST}/sitemap.xml`],
    );

    source = {
      id: row.rows[0]!.id,
      person_id: person.rows[0]!.id,
      person: 'ada',
      display_name: 'Ada Whitfield',
      platform: 'blog',
      handle: HOST,
      discovery_url: `https://${HOST}/sitemap.xml`,
      cursor_published_at: null,
      backfill_floor: '2025-08-01',
      backfill_complete: false,
      exclude_shorts: true,
      poll_interval_hours: 24,
      last_checked_at: null,
      blocked_at: null,
      consecutive_failures: 0,
    };
  });

  /** Walks a sitemap of the given entries, writing the candidates as the cycle would. */
  async function walk(entries: { loc: string; lastmod: string }[]): Promise<number> {
    const fetcher = fakeFetcher([
      { match: (one) => one === `https://${HOST}/sitemap.xml`, body: sitemap(entries) },
      { match: () => true, status: 404, body: 'not found' },
    ]);

    const outcome = await walkBlogArchive(source, db, { fetcher, pause: async () => {} }, async (item) => {
      await recordCatalogued(db, source, item);
    });
    return outcome.reopened;
  }

  async function retrievalOf(externalId: string): Promise<string> {
    const { rows } = await db.query<{ retrieval: string }>(
      'select retrieval from braintrust_items where source_id = $1 and external_id = $2',
      [source.id, externalId],
    );
    return rows[0]!.retrieval;
  }

  it('accepts the state a URL that is not a post lands in', async () => {
    await walk([{ loc: HOMEPAGE, lastmod: '2026-06-01T00:00:00Z' }]);
    const [row] = await db.query<{ id: string }>(
      'select id from braintrust_items where source_id = $1',
      [source.id],
    ).then((result) => result.rows);

    await markSkippedNotAPost(db, row!.id, new Date('2026-06-01T00:00:00Z'));

    assert.equal(await retrievalOf(HOMEPAGE), 'skipped_not_a_post');
  });

  /**
   * `create table if not exists` neither adds columns nor alters constraints, so the
   * value is only really available if the drop-and-restate ran. The negative case is what
   * proves the constraint is still doing its job rather than having been dropped.
   */
  it('still refuses a state that is not in the vocabulary', async () => {
    await walk([{ loc: HOMEPAGE, lastmod: '2026-06-01T00:00:00Z' }]);

    await assert.rejects(
      () =>
        db.query(`update braintrust_items set retrieval = 'skipped_probably' where source_id = $1`, [
          source.id,
        ]),
      /braintrust_items_retrieval_check/,
    );
  });

  it('records the lastmod the decision was made on', async () => {
    await walk([{ loc: HOMEPAGE, lastmod: '2026-06-01T00:00:00Z' }]);
    const { rows } = await db.query<{ id: string }>(
      'select id from braintrust_items where source_id = $1',
      [source.id],
    );
    await markSkippedNotAPost(db, rows[0]!.id, new Date('2026-06-01T00:00:00Z'));

    const decided = await skippedNotPosts(db, source.id);
    assert.equal(decided.length, 1);
    assert.equal(decided[0]!.lastmod?.toISOString(), '2026-06-01T00:00:00.000Z');
  });

  describe('what the next walk does with it', () => {
    beforeEach(async () => {
      await walk([{ loc: HOMEPAGE, lastmod: '2026-06-01T00:00:00Z' }]);
      const { rows } = await db.query<{ id: string }>(
        'select id from braintrust_items where source_id = $1',
        [source.id],
      );
      await markSkippedNotAPost(db, rows[0]!.id, new Date('2026-06-01T00:00:00Z'));
    });

    it('leaves the row alone while the sitemap says the URL has not changed', async () => {
      const reopened = await walk([{ loc: HOMEPAGE, lastmod: '2026-06-01T00:00:00Z' }]);

      assert.equal(reopened, 0);
      assert.equal(await retrievalOf(HOMEPAGE), 'skipped_not_a_post');
    });

    /**
     * A stub filled in next month becomes a post next month, at the cost of one fetch —
     * with no polling loop and no re-examination interval anybody had to choose.
     */
    it('reopens it the moment the sitemap shows a newer lastmod', async () => {
      const reopened = await walk([{ loc: HOMEPAGE, lastmod: '2026-07-15T00:00:00Z' }]);

      assert.equal(reopened, 1);
      assert.equal(await retrievalOf(HOMEPAGE), 'pending');
    });

    /**
     * The freeze that makes the trigger work at all. If a walk overwrote the recorded
     * `lastmod` while re-cataloguing the URL, the value the next walk compares against
     * would move with the sitemap and no change would ever look like a change.
     */
    it('does not let a re-catalogue move the lastmod the decision was made on', async () => {
      await walk([{ loc: HOMEPAGE, lastmod: '2026-07-15T00:00:00Z' }]);
      // The reopen above already fired; a decided row that had *not* been reopened must
      // still be holding its own value, so decide it again and re-walk.
      const { rows } = await db.query<{ id: string }>(
        'select id from braintrust_items where source_id = $1',
        [source.id],
      );
      await markSkippedNotAPost(db, rows[0]!.id, new Date('2026-07-15T00:00:00Z'));
      await walk([{ loc: HOMEPAGE, lastmod: '2026-07-15T00:00:00Z' }]);

      const decided = await skippedNotPosts(db, source.id);
      assert.equal(decided[0]!.lastmod?.toISOString(), '2026-07-15T00:00:00.000Z');
    });
  });

  it('counts a URL that was not a post apart from one that failed', async () => {
    await walk([
      { loc: HOMEPAGE, lastmod: '2026-06-01T00:00:00Z' },
      { loc: POST, lastmod: '2026-06-02T00:00:00Z' },
    ]);
    const { rows } = await db.query<{ id: string; external_id: string }>(
      'select id, external_id from braintrust_items where source_id = $1 order by external_id',
      [source.id],
    );
    const homepage = rows.find((row) => row.external_id === HOMEPAGE)!;
    await markSkippedNotAPost(db, homepage.id, new Date('2026-06-01T00:00:00Z'));

    const counts = await corpusCounts(db, source.id);
    assert.equal(counts.skipped_not_a_post, 1);
    assert.equal(counts.failed, 0);
    assert.equal(counts.pending, 1);
  });

  it('shows up in Coverage as its own number, so a Persona can say what it checked', async () => {
    await walk([{ loc: HOMEPAGE, lastmod: '2026-06-01T00:00:00Z' }]);
    const { rows } = await db.query<{ id: string }>(
      'select id from braintrust_items where source_id = $1',
      [source.id],
    );
    await markSkippedNotAPost(db, rows[0]!.id, new Date('2026-06-01T00:00:00Z'));

    const coverage = await measureCoverage(db, source.person_id);

    assert.equal(coverage.skipped_not_a_post, 1);
    assert.equal(coverage.failed, 0);
    assert.equal(coverage.by_source[`blog:${HOST}`]!.skipped_not_a_post, 1);
  });

  /**
   * A blog is the one Source with no catalogue that could ever describe its audience, so
   * `unknown` here means *nobody has been asked yet*. Refusing it before the fetch would
   * refuse every blog post there is.
   */
  it('leaves a blog candidate pending rather than skipping it for an unknown audience', async () => {
    await walk([{ loc: POST, lastmod: '2026-06-02T00:00:00Z' }]);

    const { rows } = await db.query<{ retrieval: string; audience: string }>(
      'select retrieval, audience from braintrust_items where source_id = $1',
      [source.id],
    );
    assert.equal(rows[0]!.audience, 'unknown');
    assert.equal(rows[0]!.retrieval, 'pending');
  });
});

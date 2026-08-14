/**
 * A blog, followed and read end to end, against real Postgres.
 *
 * **The three shapes here are the three real blogs the ticket names**, reduced to the
 * property each one proves and nothing else. A feed blog that declares its bodies
 * (`agentics.org.nz`) — the whole backfill costs one request and no page is ever fetched.
 * A feedless blog with a sitemap (`karpathy.bearblog.dev`) — every URL is a candidate, the
 * homepage is not a post, and a twenty-word note is not a post either. A Ghost blog read
 * through its pages — chrome learned across the batch, and both members-only markers
 * refused before a word is stored.
 *
 * What only a real database can settle is what the rest of it is for: that the Backlog is
 * rows rather than a queue, so a run killed halfway has written half the work and the next
 * run continues from it; and that `skipped_not_a_post` reopens on nothing but a sitemap
 * changing its mind.
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

import { createDb, type PostgresDb } from '../src/db.js';
import { followPerson, type PlanResponse } from '../src/follow/index.js';
import { createConfirmTokenStore } from '../src/follow/tokens.js';
import { runCycle, summarise, type CycleReport, type SourceReport } from '../src/ingest/cycle.js';
import { createExtractor } from '../src/notes/index.js';
import { loadPersona } from '../src/personas.js';
import { createEmbedder } from '../src/retrieval/index.js';
import {
  FEED_BLOG_FEED,
  FEED_BLOG_HOST,
  FEED_BLOG_OLDER,
  FEED_BLOG_POSTS,
  GHOST_GATED,
  GHOST_HOST,
  GHOST_POSTS,
  GHOST_URLS,
  SITEMAP_BLOG_HOMEPAGE_URL,
  SITEMAP_BLOG_HOST,
  SITEMAP_BLOG_NOT_POSTS,
  SITEMAP_BLOG_POSTS,
  SITEMAP_BLOG_SHORTS,
  SITEMAP_BLOG_SHORT_URL,
  SITEMAP_BLOG_URLS,
  feedBlogRoutes,
  ghostRoutes,
  sitemapBlogPost,
  sitemapBlogRoutes,
} from './support/blogs.js';
import { fakeEmbeddings, testEmbeddingsConfig } from './support/embeddings.js';
import { fakeExtractor, testExtractorConfig } from './support/notes.js';
import { NOW, fakeFetcher, type FakeFetcher, type Route } from './support/sources.js';
import { fakeSynthesiser } from './support/synthesiser.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

describe('reading a blog end to end, against real Postgres', { skip }, () => {
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

  /** Registration: resolve, Plan, confirm, register. The same handshake every Source uses. */
  async function follow(link: string, name: string, routes: Route[]): Promise<void> {
    const deps = {
      db,
      tokens: createConfirmTokenStore(),
      fetcher: fakeFetcher(routes),
      now: () => NOW,
      pause: async () => {},
    };
    const plan = (await followPerson({ links: [link] }, deps)) as PlanResponse;
    assert.ok(plan.confirm_token, `following ${link} produced a Plan rather than a refusal`);
    await followPerson({ confirm_token: plan.confirm_token, display_name: name }, deps);
  }

  type RunOptions = { routes: Route[]; stopping?: () => boolean; compile?: boolean; now?: Date };

  /** A day later, which is what makes a Source due again. There is no second scheduler. */
  const TOMORROW = new Date(NOW.getTime() + 25 * 3_600_000);

  async function run(options: RunOptions): Promise<{ report: CycleReport; fetcher: FakeFetcher }> {
    const fetcher = fakeFetcher(options.routes);
    const report = await runCycle({
      db,
      fetcher,
      now: () => options.now ?? NOW,
      pause: async () => {},
      log: () => {},
      ...(options.compile
        ? {
            embedder: createEmbedder(testEmbeddingsConfig, fakeEmbeddings().fetcher),
            extractor: createExtractor(testExtractorConfig, quotingExtractor()),
            synthesiser: fakeSynthesiser(),
          }
        : {}),
      ...(options.stopping ? { stopping: options.stopping } : {}),
    });
    return { report, fetcher };
  }

  /** Quotes what it was given rather than inventing something, so every claim verifies. */
  function quotingExtractor() {
    return fakeExtractor({
      note: (user) => ({
        claims: [{ statement: 'It said this.', quote: user.slice(-40) }],
        argument: 'Argues from what it opened with to what it closed with.',
        assumptions: ['The reader has been paying attention.'],
      }),
    }).fetcher;
  }

  const blog = (report: CycleReport): SourceReport => report.sources.find((s) => s.platform === 'blog')!;

  async function rows(host: string) {
    const { rows: found } = await db.query<{
      external_id: string;
      retrieval: string;
      attempt_count: number;
      body_text: string | null;
      published_at: string | null;
      lastmod: string | null;
      raw: { body_from?: string; feed_element?: string; words?: number; html?: string } | null;
    }>(
      `select i.external_id, i.retrieval, i.attempt_count, i.body_text,
              i.published_at::text as published_at, i.lastmod::text as lastmod, i.body_raw as raw
         from braintrust_items i
         join braintrust_sources s on s.id = i.source_id
        where s.handle = $1
        order by i.external_id`,
      [host],
    );
    return found;
  }

  // -------------------------------------------------------------------------
  // The feed blog: the body arrives with discovery, so the backfill is one request
  // -------------------------------------------------------------------------

  describe('a blog whose feed carries the bodies', () => {
    const routes = feedBlogRoutes;

    beforeEach(async () => {
      await follow(`https://${FEED_BLOG_HOST}/`, 'Ada Whitfield', routes());
    });

    it('reads every post in the window without fetching a single page', async () => {
      const { report, fetcher } = await run({ routes: routes() });
      const source = blog(report);

      assert.equal(source.discovered, FEED_BLOG_POSTS);
      assert.equal(source.retrieved, FEED_BLOG_POSTS - FEED_BLOG_OLDER);
      assert.equal(source.failed, 0);

      // The whole claim of the feed path, as a number: no post page was ever asked for.
      assert.equal(
        fetcher.requests.filter((request) => request.includes('/blog/post-')).length,
        0,
        'a declared whole body is the post, and paying for the page as well would be the bug',
      );
    });

    it('records where the words came from, so a thin post can be diagnosed later', async () => {
      await run({ routes: routes() });

      const post = (await rows(FEED_BLOG_HOST)).find((row) => row.retrieval === 'retrieved')!;
      assert.equal(post.raw?.body_from, 'feed');
      assert.equal(post.raw?.feed_element, 'content:encoded');
      // No page was fetched, so there is no markup to keep. The column says so honestly
      // rather than holding an empty string.
      assert.equal(post.raw?.html, undefined);
      assert.match(post.body_text!, /The whole of post/);
    });

    /**
     * **The window is applied where the date was free.** The feed dates its own entries,
     * so the two posts older than the floor are refused before a request rather than
     * stored because the request had already been spent — and `reopenWindow` brings them
     * back if the operator widens it, exactly as on every other Source.
     */
    it('skips the posts older than the window it was given, and keeps them as rows', async () => {
      const { report } = await run({ routes: routes() });

      assert.equal(blog(report).skipped_window, FEED_BLOG_OLDER);
      const skipped = (await rows(FEED_BLOG_HOST)).filter((row) => row.retrieval === 'skipped_window');
      assert.equal(skipped.length, FEED_BLOG_OLDER);
      assert.ok(skipped.every((row) => row.body_text === null));
      assert.ok(skipped.every((row) => row.published_at !== null));
    });

    /**
     * The accepted cost, as a test rather than a comment: this blog has no sitemap, so it
     * never claims a complete backfill and looks for one every run, forever. Coverage
     * reads that flag, so the Persona says it is built on part of the archive.
     */
    it('never claims a complete backfill, because it has no archive to walk', async () => {
      const { report, fetcher } = await run({ routes: routes() });

      assert.equal(blog(report).backfill_complete, false);
      assert.deepEqual(
        fetcher.requests.filter((request) => request.includes('sitemap')),
        [`https://${FEED_BLOG_HOST}/sitemap-posts.xml`, `https://${FEED_BLOG_HOST}/sitemap.xml`],
      );
    });

    it('writes nothing new on a second run, because it has already read them', async () => {
      await run({ routes: routes() });
      const { report } = await run({ routes: routes(), now: TOMORROW });

      assert.equal(blog(report).discovered, 0);
      assert.equal(blog(report).retrieved, 0);
      assert.equal((await rows(FEED_BLOG_HOST)).length, FEED_BLOG_POSTS);
    });
  });

  // -------------------------------------------------------------------------
  // The sitemap blog: every URL a candidate, the page decides which are posts
  // -------------------------------------------------------------------------

  describe('a blog with no feed at all', () => {
    const routes = sitemapBlogRoutes;

    beforeEach(async () => {
      await follow(`https://${SITEMAP_BLOG_HOST}/`, 'Andrej Karpathy', routes());
    });

    it('walks the sitemap, then lets each page say what it is', async () => {
      const { report } = await run({ routes: routes() });
      const source = blog(report);

      assert.equal(source.catalogued, SITEMAP_BLOG_URLS);
      assert.equal(source.retrieved, SITEMAP_BLOG_POSTS);
      assert.equal(source.skipped_not_a_post, SITEMAP_BLOG_NOT_POSTS);
      assert.equal(source.skipped_short, SITEMAP_BLOG_SHORTS);
      assert.equal(source.failed, 0, 'a source that answered every request has failed nothing');
      assert.equal(source.backfill_complete, true);
      // Nothing in the sitemap is dated, so every date came from the page itself.
      assert.equal(source.dated, SITEMAP_BLOG_URLS - SITEMAP_BLOG_NOT_POSTS);
    });

    it('keeps the homepage as a row that says what it is, not as a failure', async () => {
      await run({ routes: routes() });

      const home = (await rows(SITEMAP_BLOG_HOST)).find(
        (row) => row.external_id === SITEMAP_BLOG_HOMEPAGE_URL,
      )!;
      assert.equal(home.retrieval, 'skipped_not_a_post');
      assert.equal(home.body_text, null);
      // The `<lastmod>` it was decided against, which is the whole reopen trigger.
      assert.ok(home.lastmod, 'the decision records the lastmod it was made against');
    });

    it('keeps a twenty-word note as short rather than as prose', async () => {
      await run({ routes: routes() });

      const short = (await rows(SITEMAP_BLOG_HOST)).find(
        (row) => row.external_id === SITEMAP_BLOG_SHORT_URL,
      )!;
      assert.equal(short.retrieval, 'skipped_short');
      assert.equal(short.body_text, null, 'the words are not kept; the measurement is');
      assert.ok(short.raw?.words! < 40);
      assert.ok(short.published_at, 'a short post is still a dated post');
    });

    /**
     * **The reopen nobody performs.** The stub gains a date and the sitemap says the URL
     * changed; the next ordinary run is what notices. No polling loop, no re-examination
     * interval anybody had to choose.
     */
    it('reopens a URL it decided was not a post when the sitemap says it changed', async () => {
      await run({ routes: routes() });

      const moved = new Date(NOW.getTime() - 86_400_000 / 2).toISOString();
      const changed: Route[] = [
        {
          match: (request) => request === `https://${SITEMAP_BLOG_HOST}/sitemap.xml`,
          body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITEMAP_BLOG_HOMEPAGE_URL}</loc><lastmod>${moved}</lastmod></url>
</urlset>`,
        },
        // It is a post now, which is the only reason the refetch is worth anything.
        { match: (request) => request === SITEMAP_BLOG_HOMEPAGE_URL, body: sitemapBlogPost(99) },
        ...routes(),
      ];

      const { report } = await run({ routes: changed, now: TOMORROW });
      assert.equal(blog(report).reopened_not_posts, SITEMAP_BLOG_NOT_POSTS);
      assert.equal(blog(report).retrieved, 1);

      const home = (await rows(SITEMAP_BLOG_HOST)).find(
        (row) => row.external_id === SITEMAP_BLOG_HOMEPAGE_URL,
      )!;
      assert.equal(home.retrieval, 'retrieved');
      assert.ok(home.body_text);
    });

    it('leaves a decided row alone when the sitemap has not changed', async () => {
      await run({ routes: routes() });
      const { report } = await run({ routes: routes(), now: TOMORROW });

      assert.equal(blog(report).reopened_not_posts, undefined);
      assert.equal(blog(report).retrieved, 0);
    });

    /**
     * The claim the whole Backlog design rests on, and the only way to test it is to stop
     * a run and look at the disk. There is no job table to resume from — the rows are the
     * progress, so the second run reads the ones the first never reached.
     */
    it('continues from the rows when a run is killed mid-crawl', async () => {
      let seen = 0;
      const { report: first } = await run({ routes: routes(), stopping: () => ++seen > 6 });

      assert.equal(first.stopped_early, true);
      const half = await rows(SITEMAP_BLOG_HOST);
      const done = half.filter((row) => row.retrieval !== 'pending').length;
      assert.ok(done > 0 && done < SITEMAP_BLOG_URLS, `${done} of ${SITEMAP_BLOG_URLS} is a real half`);

      const { report: second, fetcher } = await run({ routes: routes(), now: TOMORROW });
      assert.equal(second.stopped_early, false);

      const finished = await rows(SITEMAP_BLOG_HOST);
      assert.equal(finished.filter((row) => row.retrieval === 'pending').length, 0);
      assert.equal(finished.filter((row) => row.retrieval === 'retrieved').length, SITEMAP_BLOG_POSTS);

      // **None of the first run's work was done twice.** The second run asked for exactly
      // the pages the first never reached, which is what "the rows are the progress" means
      // when there is no job table to resume from.
      assert.equal(
        fetcher.requests.filter((request) => request !== `https://${SITEMAP_BLOG_HOST}/sitemap.xml`).length,
        SITEMAP_BLOG_URLS - done,
      );
    });

    /**
     * A block is measured across *distinct* Items and never judged from a response code.
     * The site here answers its sitemap and refuses every page, which is what a bot gate
     * that serves XML and blocks HTML actually looks like.
     */
    it('blocks the source after five different pages fail, and leaves the rest alone', async () => {
      const refusing: Route[] = [
        { match: (request) => request.includes('/post-'), status: 503, body: 'no' },
        { match: (request) => request === SITEMAP_BLOG_HOMEPAGE_URL, status: 503, body: 'no' },
        ...routes(),
      ];

      const { report } = await run({ routes: refusing });
      assert.equal(blog(report).failed, 0, 'none of the refused pages exhausted its retries');
      assert.ok(blog(report).blocked_since, 'five in a row is the source, not a bad afternoon');

      const after = await rows(SITEMAP_BLOG_HOST);
      assert.equal(after.filter((row) => row.retrieval === 'failed').length, 0);
      assert.equal(
        after.filter((row) => row.attempt_count > 0).length,
        5,
        'exactly the refused pages were asked, once each',
      );
      assert.equal(
        after.filter((row) => row.retrieval === 'pending').length,
        SITEMAP_BLOG_URLS,
        'the whole backlog survives, waiting for retry rather than marked lost',
      );
    });

    it('spends exactly one request on a blocked source, and clears the block when it answers', async () => {
      const refusing: Route[] = [
        { match: (request) => request.includes('/post-'), status: 503, body: 'no' },
        { match: (request) => request === SITEMAP_BLOG_HOMEPAGE_URL, status: 503, body: 'no' },
        ...routes(),
      ];
      await run({ routes: refusing });

      const { report, fetcher } = await run({ routes: routes(), now: TOMORROW });
      assert.equal(blog(report).probed, true);
      assert.equal(blog(report).unblocked, true);
      // One ordinary request, and it is the identical one that was refused yesterday —
      // never a feed or a sitemap. The backlog's first refusal is the homepage (no page
      // has a date yet, so the undated rows order by URL), so that is what gets re-asked.
      assert.equal(fetcher.requests.length, 1, 'one ordinary request, and it is a page');
      assert.equal(fetcher.requests[0]!, SITEMAP_BLOG_HOMEPAGE_URL, 'the probe re-asks the exact request it was refused');
    });
  });

  // -------------------------------------------------------------------------
  // The Ghost blog: read through its pages, gates refused, chrome removed
  // -------------------------------------------------------------------------

  describe('a blog read through its pages', () => {
    const routes = ghostRoutes;

    beforeEach(async () => {
      await follow(`https://${GHOST_HOST}/`, 'Ada Whitfield', routes());
    });

    it('refuses the members-only posts and stores no part of them', async () => {
      const { report } = await run({ routes: routes() });

      assert.equal(blog(report).catalogued, GHOST_URLS);
      assert.equal(blog(report).skipped_paywall, GHOST_GATED);
      assert.equal(blog(report).retrieved, GHOST_POSTS);

      const gated = (await rows(GHOST_HOST)).filter((row) => row.retrieval === 'skipped_paywall');
      assert.equal(gated.length, GHOST_GATED);
      assert.ok(gated.every((row) => row.body_text === null), 'a partial is never stored');
    });

    /**
     * The pass that rescued all four short posts on the real site. It needs several pages
     * of the same blog, so the batch is where it comes from — and the proof is that the
     * nav, the footer and the recent-posts widget are gone from a post whose own theme
     * gave container selection nothing to find.
     */
    it('learns this blog’s chrome from the batch and strips it out of the posts', async () => {
      await run({ routes: routes() });

      const read = (await rows(GHOST_HOST)).filter((row) => row.retrieval === 'retrieved');
      const last = read[read.length - 1]!;
      assert.match(last.body_text!, /argues that the interesting part/);
      assert.doesNotMatch(last.body_text!, /Become a member/);
      assert.doesNotMatch(last.body_text!, /published with Ghost/);
    });

    it('keeps the markup, so the next run learns the chrome without fetching anything', async () => {
      await run({ routes: routes() });

      const read = (await rows(GHOST_HOST)).filter((row) => row.retrieval === 'retrieved');
      assert.ok(read.every((row) => row.raw?.body_from === 'page'));
      assert.ok(read.every((row) => (row.raw?.html?.length ?? 0) > 0));
    });

    /**
     * A blog whose discovery document *is* its sitemap has no other way to hear about a
     * new post, so the walk is its poll and runs every day — which the flag alone would
     * have stopped after the first backfill.
     */
    it('keeps walking the sitemap after the backfill, because that is how it hears anything', async () => {
      await run({ routes: routes() });

      const seventh = `https://${GHOST_HOST}/post-6/`;
      const grown: Route[] = [
        {
          match: (request) => request === `https://${GHOST_HOST}/sitemap-posts.xml`,
          body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${seventh}</loc><lastmod>${NOW.toISOString()}</lastmod></url>
</urlset>`,
        },
        ...routes(),
      ];

      const { report } = await run({ routes: grown, now: TOMORROW });
      assert.equal(blog(report).retrieved, 1);
      assert.ok((await rows(GHOST_HOST)).some((row) => row.external_id === seventh));
    });

    it('compiles a Persona from a blog and publishes it', async () => {
      const { report } = await run({ routes: routes(), compile: true });

      assert.equal(report.compile?.rejected.length, 0, 'the gate rejected a Persona built from a blog');
      assert.deepEqual(report.compile?.compiled, ['ada-whitfield']);

      const persona = await loadPersona(db, 'ada-whitfield');
      assert.ok(persona, 'a Persona compiled from a blog is a Persona anyone can load');
      assert.match(summarise(report), /blog ghosted\.example\.com/);
    });
  });
});

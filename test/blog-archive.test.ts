/**
 * Walking a blog archive: the sitemap enumerates, the page dates itself.
 *
 * The property under test throughout is that **braintrust never guesses**. It does not
 * guess from a URL which candidates are posts, it does not guess a publish date from
 * `<lastmod>`, and where it decides against a URL it records what would have to change
 * rather than dropping the URL and refetching it forever.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  publishedFrom,
  retrieveBlogPost,
  sitemapEntries,
  walkBlogArchive,
  type BlogVerdict,
} from '../src/ingest/blog.js';
import type { ArchiveItem, SourceRow } from '../src/ingest/items.js';
import { fakeDb, type FakeDb } from './support/fake-db.js';
import { fakeFetcher, NOW, type Route } from './support/sources.js';
import {
  FEED_BLOG_FEED,
  FEED_BLOG_HOST,
  feedBlogRoutes,
  SITEMAP_BLOG_HOMEPAGE_URL,
  SITEMAP_BLOG_HOST,
  SITEMAP_BLOG_SHORT_URL,
  SITEMAP_BLOG_URLS,
  sitemapBlogPost,
  sitemapBlogRoutes,
  sitemapIndex,
} from './support/blogs.js';

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 'src-1',
    person_id: 'person-1',
    person: 'ada-whitfield',
    display_name: 'Ada Whitfield',
    platform: 'blog',
    handle: SITEMAP_BLOG_HOST,
    discovery_url: `https://${SITEMAP_BLOG_HOST}/sitemap.xml`,
    cursor_published_at: null,
    backfill_floor: '2025-08-01',
    backfill_complete: false,
    exclude_shorts: true,
    poll_interval_hours: 24,
    last_checked_at: null,
    blocked_at: null,
    ...overrides,
  };
}

/** A database with no rows to reopen — the ordinary case for every walk but one. */
const noRows = (): FakeDb => fakeDb(() => []);

async function walk(
  routes: Route[],
  row: SourceRow,
  db: FakeDb = noRows(),
): Promise<{ items: ArchiveItem[]; outcome: Awaited<ReturnType<typeof walkBlogArchive>>; requests: string[] }> {
  const fetcher = fakeFetcher(routes);
  const items: ArchiveItem[] = [];
  const outcome = await walkBlogArchive(row, db, { fetcher, pause: async () => {} }, async (item) => {
    items.push(item);
  });
  return { items, outcome, requests: fetcher.requests };
}

describe('walking a blog archive', () => {
  it('hands over every URL in the sitemap as a candidate, and judges none of them', async () => {
    const { items, outcome } = await walk(sitemapBlogRoutes(), source());

    assert.equal(items.length, SITEMAP_BLOG_URLS);
    assert.equal(outcome.seen, SITEMAP_BLOG_URLS);
    // The homepage is among them. Nothing in a URL says which of these are posts, so
    // the walk carries the homepage forward exactly like the rest.
    assert.ok(items.some((item) => item.externalId === SITEMAP_BLOG_HOMEPAGE_URL));
  });

  it('makes a post its own id, because a blog has no identity scheme to borrow', async () => {
    const { items } = await walk(sitemapBlogRoutes(), source());

    for (const item of items) {
      assert.equal(item.externalId, item.url);
      assert.match(item.externalId, /^https:\/\//);
    }
  });

  it('carries the sitemap lastmod without ever offering it as a publish date', async () => {
    const { items } = await walk(sitemapBlogRoutes(), source());

    assert.ok(items.every((item) => item.lastmod instanceof Date));
    assert.ok(items.every((item) => item.publishedAt === undefined));
  });

  it('asks nobody about the audience, because on a blog nobody can answer yet', async () => {
    const { items } = await walk(sitemapBlogRoutes(), source());
    assert.ok(items.every((item) => item.audience === 'unknown'));
  });

  it('reads the whole sitemap, so the archive is complete and the flag can be set', async () => {
    const { outcome } = await walk(sitemapBlogRoutes(), source());
    assert.equal(outcome.reachedFloor, true);
  });

  it('does not fetch the sitemap twice when the poll already read it', async () => {
    const fetcher = fakeFetcher(sitemapBlogRoutes());
    const routes = sitemapBlogRoutes();
    const polled = (routes.find((route) => route.match(`https://${SITEMAP_BLOG_HOST}/sitemap.xml`))!
      .body as string);

    await walkBlogArchive(source(), noRows(), { fetcher, pause: async () => {}, polled }, async () => {});

    // The single most expensive document braintrust fetches, and it is read once.
    assert.deepEqual(fetcher.requests, []);
  });

  it('follows a sitemap index to the sitemap that names itself the posts one', async () => {
    const host = 'ghost.example.com';
    const posts = `<?xml version="1.0"?><urlset><url><loc>https://${host}/a-post/</loc>
      <lastmod>2026-07-01T00:00:00.000Z</lastmod></url></urlset>`;

    const { items, outcome } = await walk(
      [
        {
          match: (url) => url === `https://${host}/sitemap.xml`,
          body: sitemapIndex(host, ['sitemap-pages.xml', 'sitemap-posts.xml']),
        },
        { match: (url) => url === `https://${host}/sitemap-posts.xml`, body: posts },
      ],
      source({ handle: host, discovery_url: `https://${host}/sitemap.xml` }),
    );

    assert.equal(outcome.sitemap, `https://${host}/sitemap-posts.xml`);
    assert.deepEqual(
      items.map((item) => item.url),
      [`https://${host}/a-post/`],
    );
  });

  /**
   * `karpathy.github.io` serves `feed.xml` and 404s on `sitemap.xml`. braintrust follows it
   * anyway, reads what the feed carries, and leaves `backfill_complete` false forever — so
   * the Persona built on it says plainly that it has part of the archive rather than all.
   */
  describe('a blog with a feed and no sitemap', () => {
    it('looks for a sitemap anyway, at the two paths it knows', async () => {
      const { requests } = await walk(
        feedBlogRoutes(),
        source({ handle: FEED_BLOG_HOST, discovery_url: FEED_BLOG_FEED }),
      );

      assert.deepEqual(requests, [
        FEED_BLOG_FEED,
        `https://${FEED_BLOG_HOST}/sitemap-posts.xml`,
        `https://${FEED_BLOG_HOST}/sitemap.xml`,
      ]);
    });

    it('never claims to have reached the floor, and says so by finding nothing', async () => {
      const { items, outcome } = await walk(
        feedBlogRoutes(),
        source({ handle: FEED_BLOG_HOST, discovery_url: FEED_BLOG_FEED }),
      );

      assert.equal(outcome.reachedFloor, false);
      assert.equal(items.length, 0);
      assert.equal(outcome.sitemap, undefined);
    });
  });
});

describe('reading a sitemap', () => {
  it('takes the loc and the lastmod of every url, and nothing from the urlset itself', () => {
    const entries = sitemapEntries(`<urlset>
      <url><loc>https://a.example/one/</loc><lastmod>2026-07-01</lastmod></url>
      <url><loc>https://a.example/two/</loc></url>
      <url><loc>not-a-url</loc></url>
    </urlset>`);

    assert.deepEqual(
      entries.map((entry) => entry.loc),
      ['https://a.example/one/', 'https://a.example/two/'],
    );
    assert.equal(entries[0]!.lastmod?.toISOString(), '2026-07-01T00:00:00.000Z');
    // A URL with no lastmod is still a candidate. It simply has no reopen trigger.
    assert.equal(entries[1]!.lastmod, undefined);
  });
});

describe('judging one candidate', () => {
  const deps = (routes: Route[]) => ({ fetcher: fakeFetcher(routes), pause: async () => {} });

  async function judge(url: string, options: { excludeShorts?: boolean } = {}): Promise<BlogVerdict> {
    return retrieveBlogPost(source(), url, deps(sitemapBlogRoutes()), {
      excludeShorts: options.excludeShorts ?? true,
    });
  }

  it('is a post when the page dates itself and carries prose', async () => {
    const verdict = await judge(`https://${SITEMAP_BLOG_HOST}/post-2/`);

    assert.equal(verdict.kind, 'post');
    assert.ok(verdict.kind === 'post' && verdict.raw.dated_by === 'article:published_time');
    assert.ok(verdict.kind === 'post' && verdict.publishedAt < NOW);
  });

  /**
   * The state this whole walk exists to make possible. Coverage says *"1 URL in the archive
   * turned out not to be a post"*, which is braintrust doing its job — where `failed` would
   * say the source could not answer, about a source that answered perfectly.
   */
  it('is not a post when the page carries no publish date', async () => {
    const verdict = await judge(SITEMAP_BLOG_HOMEPAGE_URL);

    assert.equal(verdict.kind, 'not_a_post');
    assert.ok(verdict.kind === 'not_a_post' && /no publish date/.test(verdict.why));
  });

  /**
   * The other half of the same test, and it lands somewhere else on purpose. A twenty-word
   * note is a real post that is very brief — `exclude_shorts` is what decides its fate, and
   * no setting makes an about page an essay.
   */
  it('is short, not a non-post, when it is dated and tiny', async () => {
    const verdict = await judge(SITEMAP_BLOG_SHORT_URL);

    assert.equal(verdict.kind, 'short');
    assert.ok(verdict.kind === 'short' && verdict.words < 40);
    assert.ok(verdict.kind === 'short' && verdict.publishedAt instanceof Date);
  });

  it('keeps the brief one when the operator turned the rule off', async () => {
    const verdict = await judge(SITEMAP_BLOG_SHORT_URL, { excludeShorts: false });
    assert.equal(verdict.kind, 'post');
  });

  it('stores the markup, so a better extractor never costs a second fetch', async () => {
    const verdict = await judge(`https://${SITEMAP_BLOG_HOST}/post-2/`);
    assert.ok(verdict.kind === 'post' && verdict.raw.html.includes('<article>'));
  });
});

describe('finding the publish date', () => {
  it('prefers the page describing itself over any <time> in the markup', () => {
    const html = `<html><head>
      <meta property="article:published_time" content="2026-05-27T09:00:00Z"></head>
      <body><aside>Recent: <time datetime="2019-01-01">older</time></aside></body></html>`;

    const found = publishedFrom(html);
    assert.equal(found?.from, 'article:published_time');
    assert.equal(found?.at.toISOString(), '2026-05-27T09:00:00.000Z');
  });

  it('falls back to JSON-LD datePublished', () => {
    const html = `<html><script type="application/ld+json">
      {"@type":"BlogPosting","datePublished":"2026-05-27T09:00:00Z"}</script></html>`;

    assert.equal(publishedFrom(html)?.from, 'json-ld');
  });

  it('takes a <time datetime> last, because a blog with neither still deserves reading', () => {
    const html = '<html><body><time datetime="2026-05-27">27 May</time></body></html>';

    assert.equal(publishedFrom(html)?.from, 'time');
  });

  /**
   * The refusal the Positions layer depends on. On the reference site a post published
   * 2026-05-27 carries a lastmod of 2026-06-05, and on the control site all 7,651 posts
   * carry one inside the same fortnight after a migration. A wrong date does not produce a
   * missing revision — it produces one pointing backwards.
   */
  it('never reads a modification date as a publish date', () => {
    const html = `<html><head><meta property="og:updated_time" content="2026-06-05T00:00:00Z">
      </head><body><p>Words with no publish date anywhere.</p></body></html>`;

    assert.equal(publishedFrom(html), undefined);
  });
});

describe('reopening a URL that was not a post', () => {
  const NOT_A_POST = { id: 'item-1', external_id: SITEMAP_BLOG_HOMEPAGE_URL };

  /** A database holding one decided row, answering the two statements the reopen makes. */
  function dbHolding(lastmod: Date | null): FakeDb {
    return fakeDb((sql) =>
      /select id, external_id, lastmod/.test(sql) ? [{ ...NOT_A_POST, lastmod }] : [],
    );
  }

  const updates = (db: FakeDb): string[] => db.sql().filter((sql) => sql.startsWith('update'));

  it('reopens the row when the sitemap shows a newer lastmod', async () => {
    // Every URL in the fixture sitemap is dated more recently than this.
    const db = dbHolding(new Date('2020-01-01T00:00:00Z'));
    const { outcome } = await walk(sitemapBlogRoutes(), source(), db);

    assert.equal(outcome.reopened, 1);
    assert.match(updates(db)[0]!, /set retrieval = 'pending', lastmod = null/);
  });

  it('leaves it alone when the sitemap says the URL has not changed', async () => {
    const entries = sitemapEntries(
      (sitemapBlogRoutes().find((route) => route.match(`https://${SITEMAP_BLOG_HOST}/sitemap.xml`))!
        .body as string) ?? '',
    );
    const unchanged = entries.find((entry) => entry.loc === SITEMAP_BLOG_HOMEPAGE_URL)!.lastmod!;

    const db = dbHolding(unchanged);
    const { outcome } = await walk(sitemapBlogRoutes(), source(), db);

    assert.equal(outcome.reopened, 0);
    assert.deepEqual(updates(db), []);
  });

  it('reopens a row decided with no lastmod once the sitemap starts carrying one', async () => {
    const db = dbHolding(null);
    const { outcome } = await walk(sitemapBlogRoutes(), source(), db);

    assert.equal(outcome.reopened, 1);
  });

  /**
   * Stated rather than silently true. A feed-only blog cannot enumerate its archive, so it
   * has no trigger to pull — the same shape of honesty as never claiming `backfill_complete`.
   */
  it('has no trigger at all where there is no sitemap', async () => {
    const db = dbHolding(new Date('2020-01-01T00:00:00Z'));
    const { outcome } = await walk(
      feedBlogRoutes(),
      source({ handle: FEED_BLOG_HOST, discovery_url: FEED_BLOG_FEED }),
      db,
    );

    assert.equal(outcome.reopened, 0);
    assert.deepEqual(updates(db), []);
  });
});

describe('the body floor', () => {
  it('is the same count Voice and Coverage use, so no two layers disagree about size', async () => {
    const fetcher = fakeFetcher([
      { match: () => true, body: sitemapBlogPost(1) },
    ]);
    const verdict = await retrieveBlogPost(
      source(),
      `https://${SITEMAP_BLOG_HOST}/post-1/`,
      { fetcher, pause: async () => {} },
      { excludeShorts: true },
    );

    assert.ok(verdict.kind === 'post');
    assert.equal(verdict.raw.words, verdict.text.trim().split(/\s+/).length);
  });
});

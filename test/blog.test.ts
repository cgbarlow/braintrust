/**
 * Following a blog: the declared feed, the sitemap, or a refusal that can be acted on.
 *
 * The property under test throughout is that **braintrust reads what the site published
 * and never guesses a path**. Guessing was measured wrong on three of four blogs, and the
 * fixture that proves it is the real one: a feed declared at `/blog/rss/` on a site where
 * `/rss/` is a 404.
 *
 * See docs/design/ingestion.md §8.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BraintrustError } from '../src/errors.js';
import { surveyBlog } from '../src/sources/blog.js';
import { resolveLinks } from '../src/sources/resolve.js';
import { DEFAULT_SETTINGS } from '../src/sources/types.js';
import {
  FEED_BLOG_AUTHOR,
  FEED_BLOG_FEED,
  FEED_BLOG_HOME,
  FEED_BLOG_HOST,
  FEED_BLOG_OLDER,
  FEED_BLOG_POSTS,
  INDEX_BLOG_HOST,
  SITEMAP_BLOG_HOME,
  SITEMAP_BLOG_HOST,
  SITEMAP_BLOG_URLS,
  feedBlogRoutes,
  sitemapBlogRoutes,
  sitemapIndex,
} from './support/blogs.js';
import { NOW, fakeFetcher } from './support/sources.js';

const settings = () => ({ ...DEFAULT_SETTINGS });

/**
 * Every unknown host is asked whether it is a Substack on a custom domain before it is
 * asked whether it is a blog, and that order is not negotiable — a custom-domain
 * Substack publishes a feed like any blog does, so the other order would resolve it as a
 * blog and lose its archive API. The one wasted request is the price, and these tests
 * look at what braintrust did about the *blog* after paying it.
 */
const blogRequests = (fetcher: { requests: string[] }): string[] =>
  fetcher.requests.filter((url) => !url.includes('/api/v1/archive'));

describe('finding a blog', () => {
  it('takes the feed the page declares, at the path the page declares it at', async () => {
    const fetcher = fakeFetcher(feedBlogRoutes());
    const [source] = await resolveLinks([`https://${FEED_BLOG_HOST}/`], { fetcher });

    assert.equal(source!.platform, 'blog');
    assert.equal(source!.handle, FEED_BLOG_HOST);
    // The site sits under /blog/, so the guessed /rss/ is a 404 and only the
    // declaration is right. This pair is the false premise the map corrected.
    assert.equal(source!.discoveryUrl, FEED_BLOG_FEED);
    assert.ok(!fetcher.requests.some((url) => url.endsWith('/rss/')));
  });

  it('finds the feed from a post URL, without walking back to the homepage', async () => {
    const fetcher = fakeFetcher(feedBlogRoutes());
    const [source] = await resolveLinks([`https://${FEED_BLOG_HOST}/blog/post-3/`], { fetcher });

    assert.equal(source!.discoveryUrl, FEED_BLOG_FEED);
    // Every page of a real blog carries the declaration, so one request is the whole job.
    assert.deepEqual(blogRequests(fetcher), [`https://${FEED_BLOG_HOST}/blog/post-3/`]);
  });

  it('asks the homepage when the page pasted declares nothing', async () => {
    const fetcher = fakeFetcher([
      { match: (url) => url === `https://${FEED_BLOG_HOST}/quiet/`, body: '<html><body>no head</body></html>' },
      ...feedBlogRoutes(),
    ]);
    const [source] = await resolveLinks([`https://${FEED_BLOG_HOST}/quiet/`], { fetcher });

    assert.equal(source!.discoveryUrl, FEED_BLOG_FEED);
    assert.deepEqual(blogRequests(fetcher), [
      `https://${FEED_BLOG_HOST}/quiet/`,
      `https://${FEED_BLOG_HOST}/`,
    ]);
  });

  it('uses a feed URL pasted directly, which is what the refusal tells you to do', async () => {
    const fetcher = fakeFetcher(feedBlogRoutes());
    const [source] = await resolveLinks([FEED_BLOG_FEED], { fetcher });

    assert.equal(source!.discoveryUrl, FEED_BLOG_FEED);
    assert.deepEqual(blogRequests(fetcher), [FEED_BLOG_FEED]);
  });

  it('never takes a comments feed for the posts feed', async () => {
    const fetcher = fakeFetcher([
      {
        match: (url) => url === 'https://wp.example.com/',
        body:
          '<html><head>' +
          '<link rel="alternate" type="application/rss+xml" title="Comments Feed" href="/comments/feed/">' +
          '<link rel="alternate" type="application/rss+xml" title="Feed" href="/feed/">' +
          '</head></html>',
      },
    ]);

    const [source] = await resolveLinks(['https://wp.example.com/'], { fetcher });
    assert.equal(source!.discoveryUrl, 'https://wp.example.com/feed/');
  });

  it('falls back to the sitemap for a blog that publishes no feed', async () => {
    const fetcher = fakeFetcher(sitemapBlogRoutes());
    const [source] = await resolveLinks([`https://${SITEMAP_BLOG_HOST}/`], { fetcher });

    assert.equal(source!.platform, 'blog');
    assert.equal(source!.discoveryUrl, `https://${SITEMAP_BLOG_HOST}/sitemap.xml`);
    // The posts-only sitemap is asked for first, because the sites that serve one serve
    // /sitemap.xml as an index pointing at it.
    assert.deepEqual(blogRequests(fetcher), [
      `https://${SITEMAP_BLOG_HOST}/`,
      `https://${SITEMAP_BLOG_HOST}/sitemap-posts.xml`,
      `https://${SITEMAP_BLOG_HOST}/sitemap.xml`,
    ]);
  });

  it('follows a sitemap index to the posts sitemap it names', async () => {
    const fetcher = fakeFetcher([
      { match: (url) => url === `https://${INDEX_BLOG_HOST}/sitemap-posts.xml`, status: 404, body: '' },
      {
        match: (url) => url === `https://${INDEX_BLOG_HOST}/sitemap.xml`,
        body: sitemapIndex(INDEX_BLOG_HOST, ['sitemap-pages.xml', 'sitemap-posts.xml', 'sitemap-tags.xml']),
      },
      { match: () => true, body: SITEMAP_BLOG_HOME },
    ]);

    const [source] = await resolveLinks([`https://${INDEX_BLOG_HOST}/`], { fetcher });
    assert.equal(source!.discoveryUrl, `https://${INDEX_BLOG_HOST}/sitemap-posts.xml`);
  });

  it('refuses to pick an archive out of a sitemap index that names no posts', async () => {
    const fetcher = fakeFetcher([
      { match: (url) => url === `https://${INDEX_BLOG_HOST}/sitemap-posts.xml`, status: 404, body: '' },
      {
        match: (url) => url === `https://${INDEX_BLOG_HOST}/sitemap.xml`,
        body: sitemapIndex(INDEX_BLOG_HOST, ['sitemap-pages.xml', 'sitemap-tags.xml', 'sitemap-authors.xml']),
      },
      { match: () => true, body: SITEMAP_BLOG_HOME },
    ]);

    await assert.rejects(
      () => resolveLinks([`https://${INDEX_BLOG_HOST}/`], { fetcher }),
      /index of 3 sitemaps, none of them posts/,
    );
  });
});

describe('refusing a blog', () => {
  it('names every URL it fetched, because a refusal nobody can act on is worse than none', async () => {
    const fetcher = fakeFetcher([
      { match: (url) => url === 'https://bare.example.com/writing/', body: '<html><head></head></html>' },
      { match: (url) => url === 'https://bare.example.com/', body: '<html><head></head></html>' },
    ]);

    const error = await resolveLinks(['https://bare.example.com/writing/'], { fetcher }).then(
      () => undefined,
      (thrown: unknown) => thrown as BraintrustError,
    );

    assert.ok(error instanceof BraintrustError);
    for (const url of [
      'https://bare.example.com/writing/',
      'https://bare.example.com/',
      'https://bare.example.com/sitemap-posts.xml',
      'https://bare.example.com/sitemap.xml',
    ]) {
      assert.ok(error.message.includes(url), `the refusal does not name ${url}`);
    }
    // What came back, not only what was asked: a 404 and a page that declares nothing
    // are different problems with different fixes.
    assert.match(error.message, /declaring no feed/);
    assert.match(error.message, /HTTP 404/);
    // And the one thing the human can do about it.
    assert.match(error.message, /paste that URL itself/);
  });

  it('says braintrust does not crawl, rather than leaving it to be inferred', async () => {
    const fetcher = fakeFetcher([]);
    await assert.rejects(
      () => resolveLinks(['https://bare.example.com/'], { fetcher }),
      /does not guess feed paths and does not crawl index pages/,
    );
  });
});

describe('pricing a blog', () => {
  it('prices a feed-bearing blog as one request, and says what it cannot see', async () => {
    const fetcher = fakeFetcher(feedBlogRoutes());
    const [source] = await resolveLinks([`https://${FEED_BLOG_HOST}/`], { fetcher });
    const survey = await surveyBlog(source!, settings(), { fetcher, now: NOW });

    assert.equal(survey.basis, 'estimated');
    assert.equal(survey.itemsInWindow, FEED_BLOG_POSTS - FEED_BLOG_OLDER);
    // The feed is a tail. The Plan says so, so a human agrees to a permanently partial
    // corpus knowingly rather than reading it in Coverage a fortnight later.
    assert.match(survey.how!, /the archive cannot be enumerated/);
    assert.match(survey.how!, /never claim to have read all of it/);
    // The expensive half costs nothing: the feed carried every body.
    assert.equal(survey.bodyFetches, 0);
    assert.equal(survey.bodiesFromDiscovery, true);
    assert.equal(survey.dateFetches, 0);
    assert.equal(survey.feedAuthor, FEED_BLOG_AUTHOR);
    assert.equal(survey.feedTitle, 'Agentics');
  });

  it('quotes at most N for a sitemap, because lastmod dates changes and not publications', async () => {
    const fetcher = fakeFetcher(sitemapBlogRoutes());
    const [source] = await resolveLinks([`https://${SITEMAP_BLOG_HOST}/`], { fetcher });
    const survey = await surveyBlog(source!, settings(), { fetcher, now: NOW });

    assert.equal(survey.basis, 'estimated');
    assert.equal(survey.itemsInWindow, SITEMAP_BLOG_URLS);
    assert.match(survey.how!, new RegExp(`at most ${SITEMAP_BLOG_URLS}\\b`));
    assert.match(survey.how!, /dates changes rather than publications/);
    // Every URL is a candidate and every candidate costs its own page fetch. Nothing
    // arrives with discovery, which is what a feedless blog buys.
    assert.equal(survey.bodyFetches, SITEMAP_BLOG_URLS);
    assert.notEqual(survey.bodiesFromDiscovery, true);
  });

  it('counts an undated feed entry in, and prices the page fetch that will date it', async () => {
    const fetcher = fakeFetcher([
      { match: (url) => url === 'https://undated.example.com/', body: FEED_BLOG_HOME },
      {
        match: (url) => url === 'https://undated.example.com/blog/rss/',
        body:
          '<?xml version="1.0"?><rss><channel><title>Undated</title>' +
          '<item><title>One</title><link>https://undated.example.com/one/</link></item>' +
          '</channel></rss>',
      },
    ]);

    const [source] = await resolveLinks(['https://undated.example.com/'], { fetcher });
    const survey = await surveyBlog(source!, settings(), { fetcher, now: NOW });

    // Dropping what it cannot place would quote a smaller job than the one it will do.
    assert.equal(survey.itemsInWindow, 1);
    assert.equal(survey.dateFetches, 1);
  });
});

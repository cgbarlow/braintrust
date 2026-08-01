/**
 * Taking the words out of a blog post.
 *
 * Two properties are under test and everything here serves one of them. **The feed is
 * the body where the feed carries one**, so the expensive half of a blog is usually free
 * and the arbitrary-HTML extractor is only reached by the blog that needs it. And
 * **braintrust never stores a preview as a post** — not a truncated synopsis, and above
 * all not the free opening of something the publisher is selling.
 *
 * The fixtures are shaped like the sites the rule was measured on: a Ghost blog whose
 * customised theme has no content container, whose recent-posts widget repeats real post
 * headings on every page, and whose stylesheet carries the upgrade-widget class on every
 * page free and paid alike.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  agreement,
  blogBodyText,
  countWords,
  densestContainer,
  feedBodies,
  gatedBy,
  gatedByFeed,
  normaliseUrl,
  repeatedLines,
  withoutBoilerplate,
} from '../src/ingest/blog-body.js';
import { retrieveBlogPost, type BlogVerdict } from '../src/ingest/blog.js';
import type { SourceRow } from '../src/ingest/items.js';
import { GHOST_HOST, ghostFeed, ghostPost } from './support/blogs.js';
import { fakeFetcher, NOW } from './support/sources.js';

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 'src-1',
    person_id: 'person-1',
    person: 'ada-whitfield',
    display_name: 'Ada Whitfield',
    platform: 'blog',
    handle: GHOST_HOST,
    discovery_url: `https://${GHOST_HOST}/rss/`,
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

// ---------------------------------------------------------------------------

describe('reading the body a feed carries', () => {
  it('takes content:encoded, which is the element that declares a whole post', () => {
    const bodies = feedBodies(ghostFeed([{ index: 0 }]));
    const body = bodies.get(`https://${GHOST_HOST}/post-0`);

    assert.equal(body?.element, 'content:encoded');
    assert.equal(body?.whole, true);
    assert.ok((body?.words ?? 0) > 40);
    assert.match(body!.text, /two teams disagree/);
  });

  it('takes an Atom <content>, which declares the same thing in the other dialect', () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><link href="https://notes.test/one/" rel="alternate"/>
      <content type="html">&lt;p&gt;The whole of it.&lt;/p&gt;</content></entry></feed>`;

    const body = feedBodies(atom).get('https://notes.test/one');
    assert.equal(body?.element, 'content');
    assert.equal(body?.whole, true);
    assert.equal(body?.text, 'The whole of it.');
  });

  /**
   * The measurement this rule exists for. Bear Blog publishes both, and the `<summary>`
   * is 36 characters beside a `<content>` of 44,699 — so the element it came from is the
   * fact, and picking the longer would only work until a blog wrote a verbose teaser.
   */
  it('prefers the declared body over the synopsis in the same entry', () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><link href="https://notes.test/one/" rel="alternate"/>
      <summary>A one-line teaser.</summary>
      <content type="html">&lt;p&gt;The whole of it, at length.&lt;/p&gt;</content></entry></feed>`;

    const body = feedBodies(atom).get('https://notes.test/one');
    assert.equal(body?.element, 'content');
  });

  /**
   * And the other half of that measurement: the Jekyll blog publishes RSS 2.0 with no
   * `content:encoded` at all and a `<description>` of 135,277 characters, which *is* the
   * whole post. The element name therefore cannot settle it on its own — a synopsis
   * element is read, and marked as something that still has to beat the page.
   */
  it('reads a synopsis element without declaring it the body', () => {
    const rss = `<rss><channel><item><link>https://notes.test/one/</link>
      <description>&lt;p&gt;Could be the post, could be the first paragraph.&lt;/p&gt;</description>
      </item></channel></rss>`;

    const body = feedBodies(rss).get('https://notes.test/one');
    assert.equal(body?.element, 'description');
    assert.equal(body?.whole, false);
  });

  it('keys on a normalised URL, so a lookup never misses over a slash or a scheme', () => {
    assert.equal(normaliseUrl('http://notes.test/one/'), 'https://notes.test/one');
    assert.equal(normaliseUrl('https://notes.test/one'), 'https://notes.test/one');

    const rss = `<rss><channel><item><link>http://notes.test/one/</link>
      <content:encoded><![CDATA[<p>Words.</p>]]></content:encoded></item></channel></rss>`;
    assert.ok(feedBodies(rss).has('https://notes.test/one'));
  });

  it('carries nothing for an entry the feed gives no body element at all', () => {
    const rss = `<rss><channel><item><title>Post</title>
      <link>https://notes.test/one/</link></item></channel></rss>`;

    assert.equal(feedBodies(rss).size, 0);
  });
});

// ---------------------------------------------------------------------------

describe('the feed is the body', () => {
  const url = `https://${GHOST_HOST}/post-0/`;

  /** Nothing is registered on the fetcher: a request would throw, which is the assertion. */
  const noFetching = fakeFetcher([]);

  it('stores the declared body without spending a request at all', async () => {
    const feed = feedBodies(ghostFeed([{ index: 0 }])).get(`https://${GHOST_HOST}/post-0`);

    const verdict = await retrieveBlogPost(source(), url, { fetcher: noFetching, pause: async () => {} }, {
      excludeShorts: true,
      feed,
      publishedAt: NOW,
    });

    assert.equal(verdict.kind, 'post');
    assert.ok(verdict.kind === 'post' && verdict.raw.body_from === 'feed');
    assert.ok(verdict.kind === 'post' && verdict.raw.dated_by === 'feed');
    assert.equal(noFetching.requests.length, 0);
  });

  /**
   * The body arrives without a date on a feed that omits `pubDate`, and a post braintrust
   * cannot place in time is one the compiler declines to judge. Rather than store an
   * undated post it spends the request the page costs, which is the only thing that can
   * answer.
   */
  it('falls through to the page when the feed gave a body but no date', async () => {
    const feed = feedBodies(ghostFeed([{ index: 0 }])).get(`https://${GHOST_HOST}/post-0`);
    const fetcher = fakeFetcher([{ match: () => true, body: ghostPost(0, { container: true }) }]);

    const verdict = await retrieveBlogPost(source(), url, { fetcher, pause: async () => {} }, {
      excludeShorts: true,
      feed,
    });

    assert.equal(verdict.kind, 'post');
    assert.equal(fetcher.requests.length, 1);
  });

  it('makes a synopsis element earn its place against the page', async () => {
    const rss = `<rss><channel><item><link>${url}</link>
      <description>&lt;p&gt;Only the opening sentence of it.&lt;/p&gt;</description></item></channel></rss>`;
    const feed = feedBodies(rss).get(`https://${GHOST_HOST}/post-0`);
    const fetcher = fakeFetcher([{ match: () => true, body: ghostPost(0, { container: true }) }]);

    const verdict = await retrieveBlogPost(source(), url, { fetcher, pause: async () => {} }, {
      excludeShorts: true,
      feed,
      publishedAt: NOW,
    });

    // The page is longer, so the page is what is stored — and the synopsis is recorded
    // alongside it rather than discarded, so a thin post can be diagnosed later.
    assert.ok(verdict.kind === 'post' && verdict.raw.body_from === 'page');
    assert.ok(verdict.kind === 'post' && verdict.raw.feed_element === 'description');
    assert.equal(fetcher.requests.length, 1);
  });

  /**
   * The safeguard validated by the site it was measured on: the reference Ghost blog's
   * feed came back longer than the extraction on all four posts, because boilerplate
   * removal stripped the recent-posts headings out of the post they belonged to.
   */
  it('lets the feed win where the extraction over-stripped', async () => {
    const rss = `<rss><channel><item><link>${url}</link>
      <description>&lt;p&gt;${'The whole argument, which the page extraction lost half of. '.repeat(20)}&lt;/p&gt;
      </description></item></channel></rss>`;
    const feed = feedBodies(rss).get(`https://${GHOST_HOST}/post-0`);
    // The customised theme, whose short posts are the ones boilerplate removal over-strips.
    const fetcher = fakeFetcher([{ match: () => true, body: ghostPost(0) }]);
    const boilerplate = repeatedLines([0, 1, 2, 3].map((index) => densestContainer(ghostPost(index)).text));

    const verdict = await retrieveBlogPost(source(), url, { fetcher, pause: async () => {} }, {
      excludeShorts: true,
      feed,
      publishedAt: NOW,
      boilerplate,
    });

    assert.ok(verdict.kind === 'post' && verdict.raw.body_from === 'feed');
    assert.match(verdict.kind === 'post' ? verdict.text : '', /the page extraction lost half of/);
  });

  it('records the agreement between the two, and acts on none of it', async () => {
    const rss = `<rss><channel><item><link>${url}</link>
      <description>&lt;p&gt;Something else entirely, sharing no vocabulary.&lt;/p&gt;</description>
      </item></channel></rss>`;
    const feed = feedBodies(rss).get(`https://${GHOST_HOST}/post-0`);
    const fetcher = fakeFetcher([{ match: () => true, body: ghostPost(0, { container: true }) }]);

    const verdict = await retrieveBlogPost(source(), url, { fetcher, pause: async () => {} }, {
      excludeShorts: true,
      feed,
      publishedAt: NOW,
    });

    // Recorded and low, and the post is stored anyway. There is no threshold, because a
    // threshold on a length-shaped number is the mistake density already made.
    assert.equal(verdict.kind, 'post');
    assert.ok(verdict.kind === 'post' && (verdict.raw.feed_agreement ?? 1) < 0.5);
  });
});

describe('measuring agreement', () => {
  it('is 1 when every word of the page is in the feed body', () => {
    assert.equal(agreement('the shape of a system', 'the shape of a system at some length'), 1);
  });

  it('is 0 for an empty page rather than an error', () => {
    assert.equal(agreement('', 'anything'), 0);
  });
});

// ---------------------------------------------------------------------------

describe('a gated post', () => {
  const url = `https://${GHOST_HOST}/post-0/`;
  const deps = { fetcher: fakeFetcher([]), pause: async () => {} };

  /**
   * Ghost enforces its paywall at the feed as well as the page: `content:encoded` for a
   * members-only post is empty, not truncated. A listed, dated item with a declared body
   * of nothing is a post braintrust can refuse without spending anything.
   */
  it('is refused from the feed alone, at no cost, when its declared body is empty', async () => {
    const feed = feedBodies(ghostFeed([{ index: 0, empty: true }])).get(`https://${GHOST_HOST}/post-0`);
    assert.equal(gatedByFeed(feed), true);

    const verdict = await retrieveBlogPost(source(), url, deps, {
      excludeShorts: true,
      feed,
      publishedAt: NOW,
    });

    assert.equal(verdict.kind, 'paywalled');
    assert.ok(verdict.kind === 'paywalled' && verdict.marker === 'empty-feed-body');
    assert.equal(deps.fetcher.requests.length, 0);
  });

  /**
   * A headlines-only feed is a statement about the feed, not about the post. Reading it
   * as a gate would refuse every post on a blog that simply publishes titles.
   */
  it('is not inferred from a feed that declares no body for anyone', () => {
    const rss = `<rss><channel><item><link>https://notes.test/one/</link>
      <description></description></item></channel></rss>`;

    assert.equal(gatedByFeed(feedBodies(rss).get('https://notes.test/one')), false);
  });

  it('is refused from the page on the upgrade widget, one request in', async () => {
    const fetcher = fakeFetcher([{ match: () => true, body: ghostPost(0, { container: true, gate: 'widget' }) }]);

    const verdict = await retrieveBlogPost(source(), url, { fetcher, pause: async () => {} }, {
      excludeShorts: true,
    });

    assert.ok(verdict.kind === 'paywalled' && verdict.marker === 'gh-post-upgrade-cta');
    assert.equal(fetcher.requests.length, 1);
  });

  /**
   * The correction to #56, which reported the class on every post free and paid alike
   * and concluded a gated Ghost post was undetectable. Every fixture page carries the
   * class inside its stylesheet, exactly as every real theme does; only the gated one
   * carries it in the markup a reader sees.
   */
  it('ignores the class name inside the stylesheet, which every page carries', async () => {
    const free = ghostPost(0, { container: true });
    assert.match(free, /gh-post-upgrade-cta/);

    assert.equal(gatedBy(free), undefined);
    assert.equal(gatedBy(ghostPost(0, { container: true, gate: 'widget' })), 'gh-post-upgrade-cta');
  });

  it('is refused on the members CTA copy, which is the marker for a rewritten theme', () => {
    assert.equal(gatedBy(ghostPost(0, { gate: 'copy' })), 'members-cta-copy');
  });

  /**
   * The weak marker, kept narrow. It is editable and translatable and it is there to
   * catch what the other two miss — but an author who opens a post by saying who it is
   * for must not be refused for it.
   */
  it('does not read an author writing about their readers as a paywall', () => {
    const html = `<html><body><article>
      <p>This post is for anyone who has ever tried to explain a migration to a board.</p>
      </article></body></html>`;

    assert.equal(gatedBy(html), undefined);
  });

  it('stores none of it — a partial is a number a reader cannot act on', async () => {
    const fetcher = fakeFetcher([{ match: () => true, body: ghostPost(0, { container: true, gate: 'copy' }) }]);

    const verdict = await retrieveBlogPost(source(), url, { fetcher, pause: async () => {} }, {
      excludeShorts: true,
    });

    assert.equal(verdict.kind, 'paywalled');
    assert.ok(!('text' in verdict));
    assert.match(verdict.kind === 'paywalled' ? verdict.why : '', /stored none of it/);
  });

  /**
   * The gate is read before the body, so a free intro long enough to clear the floor is
   * refused rather than stored — which is the outcome the state exists to prevent, and
   * the reason `exclude_shorts` has no say in it.
   */
  it('is refused whatever the operator set the short rule to', async () => {
    const fetcher = fakeFetcher([{ match: () => true, body: ghostPost(0, { container: true, gate: 'widget' }) }]);

    const verdict = await retrieveBlogPost(source(), url, { fetcher, pause: async () => {} }, {
      excludeShorts: false,
    });

    assert.equal(verdict.kind, 'paywalled');
  });

  /**
   * And the gate is read *after* the date, because a members-only post is dated and a
   * listing page is not. A homepage teasing three gated posts is a page braintrust could
   * not read, not a paywall it respected, and Coverage says different things about them.
   */
  it('files a listing page that teases gated posts as a page, not as a paywall', async () => {
    const html = `<html><body><main>
      <h2>This post is for subscribers only</h2>
      <h2>This post is for paying subscribers only</h2>
      </main></body></html>`;
    const fetcher = fakeFetcher([{ match: () => true, body: html }]);

    const verdict = await retrieveBlogPost(source(), `https://${GHOST_HOST}/`, { fetcher, pause: async () => {} }, {
      excludeShorts: true,
    });

    assert.equal(verdict.kind, 'not_a_post');
  });
});

// ---------------------------------------------------------------------------

describe('extracting a body from a page nobody has seen before', () => {
  it('finds the container a theme wrapped the post in', () => {
    const found = densestContainer(ghostPost(0, { container: true }));

    assert.equal(found.container, 'section.gh-content');
    assert.match(found.text, /two teams disagree/);
    assert.doesNotMatch(found.text, /Become a member/);
  });

  /**
   * The failure the boilerplate pass exists to rescue. On the two customised themes
   * measured there was no content container at all, so selection fell through to the
   * page chrome — 391 words of which 59 were prose.
   */
  it('falls back to the whole page when the theme wrapped nothing', () => {
    const found = densestContainer(ghostPost(0));

    assert.match(found.text, /Become a member/);
    assert.match(found.text, /published with Ghost/);
  });

  it('never lets a pull-quote outrank the post it was quoted from', () => {
    const html = `<html><body><article>
      <p>${'The long argument of the post, which runs to some length. '.repeat(10)}</p>
      <div class="pullquote"><p>A sentence lifted out of it.</p></div>
      </article></body></html>`;

    assert.match(densestContainer(html).text, /The long argument of the post/);
  });

  it('drops script and style before it measures anything', () => {
    const html = `<html><body><script>var a = "words words words words words";</script>
      <article><p>The post itself.</p></article></body></html>`;

    assert.doesNotMatch(densestContainer(html).text, /var a/);
  });
});

describe('learning what a blog puts on every page', () => {
  const pages = [0, 1, 2, 3].map((index) => densestContainer(ghostPost(index)).text);

  it('finds the nav, the footer and the widget without being told what chrome is', () => {
    const repeated = repeatedLines(pages);

    assert.ok(repeated.has('Become a member'));
    assert.ok(repeated.has('Agentics, published with Ghost.'));
    assert.ok(repeated.has('Recent posts'));
  });

  it('leaves the prose of each post alone, because it appears on one page only', () => {
    const repeated = repeatedLines(pages);
    const cleaned = withoutBoilerplate(pages[0]!, repeated);

    assert.match(cleaned, /Post 0 argues/);
    assert.doesNotMatch(cleaned, /Become a member/);
    assert.doesNotMatch(cleaned, /published with Ghost/);
  });

  /**
   * One page cannot establish that anything repeats, and a rule that let it would strip
   * a whole post on the first page of a blog braintrust had never read.
   */
  it('learns nothing from a single page', () => {
    assert.equal(repeatedLines([pages[0]!]).size, 0);
  });

  /**
   * The property that makes the pass safe to apply always: it rescued all four Ghost
   * failures and was a no-op on all eleven pages where container selection had already
   * worked.
   */
  it('is a no-op where the container had already been found', () => {
    const contained = [0, 1, 2, 3].map((index) => densestContainer(ghostPost(index, { container: true })).text);
    const repeated = repeatedLines(contained);

    assert.equal(withoutBoilerplate(contained[0]!, repeated), contained[0]!);
  });

  it('rescues the page that had no container, which is the whole point', () => {
    const repeated = repeatedLines(pages);
    const rescued = countWords(blogBodyText(ghostPost(0), repeated));
    const unrescued = countWords(blogBodyText(ghostPost(0)));

    assert.ok(rescued < unrescued, `${rescued} should be fewer words than ${unrescued}`);
    assert.match(blogBodyText(ghostPost(0), repeated), /Post 0 argues/);
  });

  /**
   * A post's own title can be stripped from its own body by this, and that is harmless:
   * the title is a column of its own rather than something recovered from the prose.
   */
  it('may take a heading the widget also lists, and loses nothing by it', () => {
    const html = (index: number) => `<html><body>
      <h1>The shape of an agentic organisation</h1>
      <p>Body ${index}, which is different on every page.</p>
      <aside><p>The shape of an agentic organisation</p></aside></body></html>`;

    const texts = [0, 1, 2, 3].map((index) => densestContainer(html(index)).text);
    const cleaned = withoutBoilerplate(texts[0]!, repeatedLines(texts));

    assert.doesNotMatch(cleaned, /agentic organisation/);
    assert.match(cleaned, /Body 0/);
  });
});

describe('the body floor, and what it is not asked to do', () => {
  /**
   * Density is rejected as a confidence signal because it tracks post length rather than
   * extraction quality: a real short Ghost post scored 0.097 and a successfully extracted
   * one 0.404. What that means in practice is here — a genuinely brief post is short, and
   * `exclude_shorts` decides its fate, but it is never treated as a failed extraction.
   */
  it('calls a genuinely brief post short rather than a failure', async () => {
    const html = `<!DOCTYPE html><html><head>
      <meta property="article:published_time" content="${NOW.toISOString()}"></head>
      <body><article><p>A note to self, to expand later.</p></article></body></html>`;
    const fetcher = fakeFetcher([{ match: () => true, body: html }]);

    const verdict: BlogVerdict = await retrieveBlogPost(
      source(),
      `https://${GHOST_HOST}/post-0/`,
      { fetcher, pause: async () => {} },
      { excludeShorts: true },
    );

    assert.equal(verdict.kind, 'short');
  });
});

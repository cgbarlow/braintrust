/**
 * Fake blogs, shaped like the four that were measured.
 *
 * The shapes are the point. `agentics.org.nz` really does declare its feed at
 * `/blog/rss/` and really does 404 at `/rss/` — that pair is the false premise the map
 * had to correct, so it is a fixture rather than a comment. The sitemap blog carries
 * `<lastmod>` on every URL and counts its own homepage among them, which is why the
 * survey quotes *at most* what it found.
 */

import type { Route } from './sources.js';
import { NOW } from './sources.js';

// ---------------------------------------------------------------------------
// A blog with a declared feed, under a path prefix
// ---------------------------------------------------------------------------

export const FEED_BLOG_HOST = 'agentics.org.nz';
export const FEED_BLOG_FEED = `https://${FEED_BLOG_HOST}/blog/rss/`;

/** 12 posts, 2 of them older than a twelve-month window. */
export const FEED_BLOG_POSTS = 12;
export const FEED_BLOG_OLDER = 2;

export const FEED_BLOG_AUTHOR = 'Ada Whitfield';

/**
 * The declaration is relative and the site sits under `/blog/`, which is the whole
 * reason path-guessing failed here: `/rss/` is a 404 and `/blog/rss/` is the feed.
 */
export const FEED_BLOG_HOME = `<!DOCTYPE html><html><head>
<title>Agentics</title>
<link rel="alternate" type="application/rss+xml" title="Agentics" href="/blog/rss/">
</head><body><h1>Agentics</h1></body></html>`;

/** A post page. It declares the feed too, as every page of a real blog does. */
export const FEED_BLOG_POST_PAGE = FEED_BLOG_HOME.replace('<h1>Agentics</h1>', '<article>A post.</article>');

export const FEED_BLOG_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Agentics</title>
    <link>https://${FEED_BLOG_HOST}/blog/</link>
    ${Array.from({ length: FEED_BLOG_POSTS }, (_, index) => {
      const days = index < FEED_BLOG_POSTS - FEED_BLOG_OLDER ? 3 + index * 20 : 400 + index * 20;
      const published = new Date(NOW.getTime() - days * 86_400_000);
      return `<item>
      <title>Post ${index}</title>
      <dc:creator>${FEED_BLOG_AUTHOR}</dc:creator>
      <pubDate>${published.toUTCString()}</pubDate>
      <link>https://${FEED_BLOG_HOST}/blog/post-${index}/</link>
      <guid>https://${FEED_BLOG_HOST}/blog/post-${index}/</guid>
      <content:encoded><![CDATA[<p>The whole of post ${index}, which the feed carries. ${'A paragraph about what it takes to run a team that ships, written at the length a real post is written at. '.repeat(
        4,
      )}</p>]]></content:encoded>
    </item>`;
    }).join('\n    ')}
  </channel>
</rss>`;

export function feedBlogRoutes(): Route[] {
  return [
    { match: (url) => url === FEED_BLOG_FEED, body: FEED_BLOG_RSS },
    {
      match: (url) => url.startsWith(`https://${FEED_BLOG_HOST}/blog/post-`),
      body: FEED_BLOG_POST_PAGE,
    },
    { match: (url) => url === `https://${FEED_BLOG_HOST}/` || url === `https://${FEED_BLOG_HOST}`, body: FEED_BLOG_HOME },
  ];
}

// ---------------------------------------------------------------------------
// A blog with no feed at all, and a sitemap
// ---------------------------------------------------------------------------

export const SITEMAP_BLOG_HOST = 'notes.example.com';

/** 15 URLs, one of which is the homepage — a real Bear Blog sitemap in miniature. */
export const SITEMAP_BLOG_URLS = 15;

/** A homepage that declares nothing. No `<link rel="alternate">` anywhere on it. */
export const SITEMAP_BLOG_HOME = `<!DOCTYPE html><html><head><title>notes</title></head>
<body><h1>notes</h1><a href="/post-0/">Post 0</a></body></html>`;

export const SITEMAP_BLOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://${SITEMAP_BLOG_HOST}/</loc><lastmod>${lastmod(1)}</lastmod></url>
  ${Array.from({ length: SITEMAP_BLOG_URLS - 1 }, (_, index) => {
    return `<url>
    <loc>https://${SITEMAP_BLOG_HOST}/post-${index}/</loc>
    <lastmod>${lastmod(2 + index * 9)}</lastmod>
  </url>`;
  }).join('\n  ')}
</urlset>`;

/**
 * The sitemap's 15 URLs, sorted into what fetching each of them actually proves.
 *
 * A sitemap enumerates URLs and says nothing about which are posts, so the fixture has to
 * carry all three answers: the homepage, which is dated by nothing and is a page; the
 * ordinary posts; and one real post of twenty words, which is dated and tiny and is
 * therefore the other half of the test.
 */
export const SITEMAP_BLOG_HOMEPAGE_URL = `https://${SITEMAP_BLOG_HOST}/`;
export const SITEMAP_BLOG_SHORT_URL = `https://${SITEMAP_BLOG_HOST}/post-13/`;

/** 14 URLs are posts, of which 13 clear the body floor. The 15th is the homepage. */
export const SITEMAP_BLOG_POSTS = 13;
export const SITEMAP_BLOG_SHORTS = 1;
export const SITEMAP_BLOG_NOT_POSTS = 1;

/** `article:published_time` — the signal that survived every custom theme measured. */
export function sitemapBlogPost(index: number, options: { short?: boolean } = {}): string {
  const published = new Date(NOW.getTime() - (2 + index * 9) * 86_400_000).toISOString();
  // Each post says something different, as posts do. That matters rather than being
  // decoration: cross-page repetition is how chrome is told from prose, so a fixture whose
  // every post carried the same paragraph would have that paragraph removed from all of
  // them — correctly, and for a reason no real blog would give it.
  const body = options.short
    ? `<p>A note to self about item ${index}, which I read this morning and will expand later.</p>`
    : `<p>${`Something worth saying about the ${index}th way software is actually built, at length. `.repeat(6)}</p>`;

  return `<!DOCTYPE html><html><head><title>Post ${index}</title>
<meta property="article:published_time" content="${published}">
</head><body><article>${body}</article></body></html>`;
}

export function sitemapBlogRoutes(): Route[] {
  return [
    // Bear Blog serves one sitemap and it is not the Ghost-shaped posts-only one.
    { match: (url) => url === `https://${SITEMAP_BLOG_HOST}/sitemap-posts.xml`, status: 404, body: 'not found' },
    { match: (url) => url === `https://${SITEMAP_BLOG_HOST}/sitemap.xml`, body: SITEMAP_BLOG_XML },
    { match: (url) => url === SITEMAP_BLOG_SHORT_URL, body: sitemapBlogPost(13, { short: true }) },
    {
      match: (url) => url.startsWith(`https://${SITEMAP_BLOG_HOST}/post-`),
      body: (url: string) => sitemapBlogPost(Number(/post-(\d+)/.exec(url)![1])),
    },
    // The homepage is in the sitemap and carries no publish date. This is the URL the
    // whole `skipped_not_a_post` state exists for.
    { match: (url) => url.startsWith(`https://${SITEMAP_BLOG_HOST}`), body: SITEMAP_BLOG_HOME },
  ];
}

// ---------------------------------------------------------------------------
// A Ghost blog: chrome on every page, a container on some of them, a members gate
// ---------------------------------------------------------------------------

export const GHOST_HOST = 'ghosted.example.com';

/**
 * The nav, the footer and the recent-posts widget — the same lines on every page.
 *
 * The recent-posts widget is the detail that matters rather than decoration: on the real
 * Ghost site it repeats *real post headings* on every page, boilerplate removal strips
 * them out of the post they belong to, and that is exactly why the feed came back longer
 * than the extraction on all four posts measured.
 */
const GHOST_CHROME = `<header class="gh-head"><nav>
<a href="/">Home</a><a href="/about/">About</a><a href="/tags/">Topics</a>
<a href="/members/">Become a member</a></nav></header>`;

const GHOST_WIDGET = `<aside class="gh-recent"><h3>Recent posts</h3>
<p>The shape of an agentic organisation</p>
<p>What a small team owes its tools</p>
<p>Notes from a fortnight of pairing</p></aside>`;

const GHOST_FOOTER = `<footer class="gh-foot"><p>Agentics, published with Ghost.</p>
<p>Subscribe to get the next one in your inbox.</p></footer>`;

/** Ghost's upgrade widget lives in every theme's stylesheet, free post or paid. */
const GHOST_STYLE = `<style>.gh-post-upgrade-cta{display:block;margin:2rem 0}</style>`;

export type GhostPageOptions = {
  /** The default-family theme wraps the post; the customised one does not. */
  container?: boolean;
  /** Which gate, where the post is gated at the page. */
  gate?: 'widget' | 'copy';
};

/**
 * A Ghost post page, in the two shapes that were measured.
 *
 * `container` is not just a wrapper: it pairs the theme with the post length, because
 * that pairing is what the measurement found. Selection succeeded on the **two long
 * posts**, whose chrome was a small fraction of the page, and fell through to the whole
 * page chrome on the **four short ones**. A container around a post no longer than its
 * own nav does not save it, and it is the boilerplate pass that does.
 */
export function ghostPost(index: number, options: GhostPageOptions = {}): string {
  const published = new Date(NOW.getTime() - (3 + index * 11) * 86_400_000).toISOString();
  const prose = `<p>${`Post ${index} argues that the interesting part of a system is where two teams disagree about it. `.repeat(
    options.container ? 20 : 5,
  )}</p>`;

  const gate =
    options.gate === 'widget'
      ? `<div class="gh-post-upgrade-cta"><h2>Upgrade</h2><a href="/#/portal/signup">Pick a plan</a></div>`
      : options.gate === 'copy'
        ? `<div class="gate"><h2>This post is for paying subscribers only</h2><a href="/#/portal/signin">Sign in</a></div>`
        : '';

  // The default theme's `<article>` holds a post header as well as the content section,
  // so the tightest fit on the prose really is the inner element rather than the outer.
  const body = options.container
    ? `<header class="gh-article-header"><h1>Post ${index}</h1>
       <p class="gh-article-meta">Ada Whitfield, ${published.slice(0, 10)}</p></header>
       <section class="gh-content">${prose}${gate}</section>`
    : `${prose}${gate}`;

  return `<!DOCTYPE html><html><head><title>Post ${index}</title>${GHOST_STYLE}
<meta property="article:published_time" content="${published}">
</head><body><div class="gh-viewport">
${GHOST_CHROME}<main><article>${body}</article></main>${GHOST_WIDGET}${GHOST_FOOTER}
</div></body></html>`;
}

/** The Atom feed a Ghost blog serves, with `content:encoded` as the declared body. */
export function ghostFeed(entries: { index: number; empty?: boolean }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel><title>Ghosted</title>
  ${entries
    .map(({ index, empty }) => {
      const published = new Date(NOW.getTime() - (3 + index * 11) * 86_400_000);
      const prose = `<p>${`Post ${index} argues that the interesting part of a system is where two teams disagree about it. `.repeat(
        5,
      )}</p>`;
      return `<item>
    <title>Post ${index}</title>
    <link>https://${GHOST_HOST}/post-${index}/</link>
    <pubDate>${published.toUTCString()}</pubDate>
    <content:encoded><![CDATA[${empty ? '' : prose}]]></content:encoded>
  </item>`;
    })
    .join('\n  ')}
  </channel>
</rss>`;
}

/**
 * The Ghost blog as a whole Source: a posts-only sitemap and six pages behind it.
 *
 * **No feed.** The measured Ghost site publishes one, and the fixture withholds it on
 * purpose — it is the only way to put the page half of the ingest under a full run, since
 * a feed that declares its bodies means no page is ever fetched. What this shape proves is
 * everything the page path owes: chrome learned across pages, a container found on some
 * themes and not others, and both page-level gates refused before a word is stored.
 *
 * A posts-only sitemap carries no homepage, which is the difference from Bear Blog's and
 * the reason the two fixtures are not one.
 */
export const GHOST_URLS = 6;
export const GHOST_GATED = 2;
export const GHOST_POSTS = GHOST_URLS - GHOST_GATED;

/** Posts 4 and 5 are members-only, one behind each marker the page can carry. */
function ghostPageOptions(index: number): GhostPageOptions {
  return {
    // The default-family theme wraps two of them; the customised one does not.
    ...(index % 3 === 0 ? { container: true } : {}),
    ...(index === 4 ? { gate: 'widget' as const } : {}),
    ...(index === 5 ? { gate: 'copy' as const } : {}),
  };
}

export function ghostSitemap(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${Array.from(
    { length: GHOST_URLS },
    (_, index) =>
      `<url><loc>https://${GHOST_HOST}/post-${index}/</loc><lastmod>${lastmod(3 + index * 11)}</lastmod></url>`,
  ).join('\n  ')}
</urlset>`;
}

/** Declares no feed, so discovery falls through to the sitemap Ghost really does serve. */
export const GHOST_HOME = `<!DOCTYPE html><html><head><title>Ghosted</title></head>
<body><h1>Ghosted</h1></body></html>`;

export function ghostRoutes(): Route[] {
  return [
    { match: (url) => url === `https://${GHOST_HOST}/sitemap-posts.xml`, body: ghostSitemap() },
    { match: (url) => url === `https://${GHOST_HOST}/` || url === `https://${GHOST_HOST}`, body: GHOST_HOME },
    {
      match: (url) => url.startsWith(`https://${GHOST_HOST}/post-`),
      body: (url: string) => {
        const index = Number(/post-(\d+)/.exec(url)![1]);
        return ghostPost(index, ghostPageOptions(index));
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// A sitemap index, which is the site declaring where its sitemaps are
// ---------------------------------------------------------------------------

export const INDEX_BLOG_HOST = 'ghost.example.com';

export function sitemapIndex(host: string, children: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${children
    .map((child) => `<sitemap><loc>https://${host}/${child}</loc><lastmod>${lastmod(1)}</lastmod></sitemap>`)
    .join('\n  ')}
</sitemapindex>`;
}

function lastmod(daysBefore: number): string {
  return new Date(NOW.getTime() - daysBefore * 86_400_000).toISOString();
}

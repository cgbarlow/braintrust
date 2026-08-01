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
      <content:encoded><![CDATA[<p>The whole of post ${index}, which the feed carries.</p>]]></content:encoded>
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

export function sitemapBlogRoutes(): Route[] {
  return [
    // Bear Blog serves one sitemap and it is not the Ghost-shaped posts-only one.
    { match: (url) => url === `https://${SITEMAP_BLOG_HOST}/sitemap-posts.xml`, status: 404, body: 'not found' },
    { match: (url) => url === `https://${SITEMAP_BLOG_HOST}/sitemap.xml`, body: SITEMAP_BLOG_XML },
    { match: (url) => url.startsWith(`https://${SITEMAP_BLOG_HOST}`), body: SITEMAP_BLOG_HOME },
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

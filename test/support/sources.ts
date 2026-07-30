/**
 * Fake sources, shaped like the real ones.
 *
 * The field names, the 20/15-item feed windows, the `audience` values and the
 * `channel_id=` in the channel page all come from
 * docs/research/substack-source-facts.md, where every one of them was measured
 * against a live fetch. The numbers here are made up; the shapes are not.
 */

import type { Fetcher, FetchResponse } from '../../src/net/fetch.js';

/** Every fixture is dated from this instant, so no test depends on today. */
export const NOW = new Date('2026-07-29T12:00:00Z');

export const SUBSTACK_HOST = 'natesnewsletter.substack.com';
export const CHANNEL_ID = 'UC0C-17n9iuUQPylguM1d-lQ';

// ---------------------------------------------------------------------------
// Substack
// ---------------------------------------------------------------------------

/**
 * 60 posts inside a 12-month window and 10 older ones, so paging has to happen
 * (50 to a page) and the backfill floor has to stop it.
 *
 * 15 of the 60 are `everyone`; the other 45 split across `only_paid` and
 * `founding` — the two live values that make the paywall filter an allow-list
 * rather than a deny-list.
 */
export const SUBSTACK_IN_WINDOW = 60;
export const SUBSTACK_PAYWALLED = 45;
export const SUBSTACK_FREE = SUBSTACK_IN_WINDOW - SUBSTACK_PAYWALLED;

const AUDIENCES = ['everyone', 'only_paid', 'only_paid', 'founding'];

type ArchivePost = {
  id: number;
  slug: string;
  canonical_url: string;
  title: string;
  post_date: string;
  audience: string;
  /** Present as a key and always null: the archive is the catalogue, never the text. */
  body_html: null;
};

const slugOf = (index: number, older = false) => `${older ? 'old' : 'post'}-${index}`;

export const SUBSTACK_ARCHIVE: ArchivePost[] = [
  ...Array.from({ length: SUBSTACK_IN_WINDOW }, (_, index) => ({
    id: 1000 + index,
    slug: slugOf(index),
    canonical_url: `https://${SUBSTACK_HOST}/p/${slugOf(index)}`,
    title: `Post ${index}`,
    // Newest first, six days apart. The oldest lands 356 days before NOW, inside a
    // twelve-month window with room to spare.
    post_date: isoDaysBefore(NOW, 2 + index * 6),
    audience: AUDIENCES[index % AUDIENCES.length]!,
    body_html: null,
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    id: 900 + index,
    slug: slugOf(index, true),
    canonical_url: `https://${SUBSTACK_HOST}/p/${slugOf(index, true)}`,
    title: `Older post ${index}`,
    post_date: isoDaysBefore(NOW, 374 + index * 6),
    audience: 'everyone',
    body_html: null,
  })),
];

export const SUBSTACK_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title><![CDATA[Nate's Substack]]></title>
    <description><![CDATA[AI strategy, three times a week]]></description>
    <link>https://${SUBSTACK_HOST}</link>
    ${Array.from({ length: 20 }, (_, index) => {
      const post = SUBSTACK_ARCHIVE[index]!;
      return `<item>
      <title><![CDATA[Post ${index}]]></title>
      <dc:creator><![CDATA[Nate B. Jones]]></dc:creator>
      <pubDate>${new Date(post.post_date).toUTCString()}</pubDate>
      <link>${post.canonical_url}</link>
      <guid isPermaLink="false">${post.canonical_url}</guid>
    </item>`;
    }).join('\n    ')}
  </channel>
</rss>`;

/**
 * `/api/v1/posts/<slug>`, the body endpoint — the one place a Substack post's text
 * actually arrives. The subscribe widget is nested exactly as the live one is, so the
 * extraction has to count `</div>`s rather than stop at the first.
 */
export function substackPost(slug: string): { status: number; body: string } {
  const record = SUBSTACK_ARCHIVE.find((post) => post.slug === slug);
  if (!record) return { status: 404, body: JSON.stringify({ error: 'not found' }) };

  return {
    status: 200,
    body: JSON.stringify({
      id: record.id,
      slug: record.slug,
      title: record.title,
      audience: record.audience,
      post_date: record.post_date,
      wordcount: 12,
      body_html:
        `<p>${record.title}: the part that matters.</p>` +
        '<div class="subscription-widget-wrap-editor"><div class="subscription-widget show-subscribe">' +
        '<p class="cta-caption">Subscribe now</p><div class="fake-input-wrapper">' +
        '<div class="fake-input">Type your email…</div></div></div></div>' +
        '<p>And a second paragraph &amp; an entity.</p>',
    }),
  };
}

/** What `substackPost` above should extract to, once the widget is gone. */
export const SUBSTACK_BODY_TEXT = (title: string) =>
  `${title}: the part that matters.\n\nAnd a second paragraph & an entity.`;

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

/** The Atom feed carries 15 entries. Sixteen hours apart is 1.5 a day. */
export const YOUTUBE_FEED_ENTRIES = 15;

export const YOUTUBE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <title>AI News &amp; Strategy Daily | Nate B Jones</title>
  <author>
    <name>AI News &amp; Strategy Daily | Nate B Jones</name>
    <uri>https://www.youtube.com/channel/${CHANNEL_ID}</uri>
  </author>
  ${Array.from({ length: YOUTUBE_FEED_ENTRIES }, (_, index) => {
    const published = new Date(NOW.getTime() - 12 * 3600_000 - index * 16 * 3600_000);
    return `<entry>
    <yt:videoId>vid${String(index).padStart(8, '0')}</yt:videoId>
    <yt:channelId>${CHANNEL_ID}</yt:channelId>
    <title>Video ${index}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=vid${String(index).padStart(8, '0')}"/>
    <published>${published.toISOString()}</published>
    <updated>${published.toISOString()}</updated>
  </entry>`;
  }).join('\n  ')}
</feed>`;

/** Trimmed to the one line that matters: the page's own link to its Atom feed. */
export const YOUTUBE_CHANNEL_PAGE = `<!DOCTYPE html><html><head>
<link rel="alternate" type="application/rss+xml" title="RSS"
  href="https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}">
<meta property="og:title" content="AI News &amp; Strategy Daily | Nate B Jones">
</head><body>ytInitialData = {"channelId":"${CHANNEL_ID}"}</body></html>`;

/** A watch page carries the id as JSON rather than as a feed link. */
export const YOUTUBE_WATCH_PAGE = `<!DOCTYPE html><html><body>
var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abcdefghijk","channelId":"${CHANNEL_ID}"}};
</body></html>`;

// ---------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------

export type Route = {
  match: (url: string) => boolean;
  status?: number;
  body?: string | ((url: string) => string);
  /** For routes whose status depends on the URL — a 404 for an unknown slug, a 429. */
  respond?: (url: string) => { status: number; body: string; headers?: Record<string, string> };
};

export type FakeFetcher = Fetcher & { requests: string[] };

/** First matching route wins; anything unrouted is a 404, which is a real answer. */
export function fakeFetcher(routes: Route[]): FakeFetcher {
  const requests: string[] = [];

  const fetcher = async (url: string): Promise<FetchResponse> => {
    requests.push(url);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) return response(404, `no fake route for ${url}`);

    if (route.respond) {
      const given = route.respond(url);
      return response(given.status, given.body, given.headers);
    }

    const body = typeof route.body === 'function' ? route.body(url) : route.body;
    return response(route.status ?? 200, body ?? '');
  };

  return Object.assign(fetcher, { requests });
}

/** The routes for the worked example: one Substack, one YouTube channel. */
export function natesRoutes(): Route[] {
  return [
    { match: (url) => url === `https://${SUBSTACK_HOST}/feed`, body: SUBSTACK_FEED },
    {
      match: (url) => url.startsWith(`https://${SUBSTACK_HOST}/api/v1/archive`),
      body: (url) => JSON.stringify(archivePage(url)),
    },
    {
      match: (url) => url.startsWith(`https://${SUBSTACK_HOST}/api/v1/posts/`),
      respond: (url) => substackPost(decodeURIComponent(url.split('/api/v1/posts/')[1]!)),
    },
    { match: (url) => url.includes('/feeds/videos.xml'), body: YOUTUBE_FEED },
    { match: (url) => url.includes('/watch?v='), body: YOUTUBE_WATCH_PAGE },
    { match: (url) => url.startsWith('https://www.youtube.com/'), body: YOUTUBE_CHANNEL_PAGE },
  ];
}

export function archivePage(url: string): ArchivePost[] {
  const parsed = new URL(url);
  const limit = Number(parsed.searchParams.get('limit') ?? 50);
  const offset = Number(parsed.searchParams.get('offset') ?? 0);
  return SUBSTACK_ARCHIVE.slice(offset, offset + limit);
}

function response(status: number, body: string, headers: Record<string, string> = {}): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

function isoDaysBefore(from: Date, days: number): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString();
}

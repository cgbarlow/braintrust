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

type ArchivePost = { id: number; post_date: string; audience: string; body_html: null };

export const SUBSTACK_ARCHIVE: ArchivePost[] = [
  ...Array.from({ length: SUBSTACK_IN_WINDOW }, (_, index) => ({
    id: 1000 + index,
    // Newest first, six days apart. The oldest lands 356 days before NOW, inside a
    // twelve-month window with room to spare.
    post_date: isoDaysBefore(NOW, 2 + index * 6),
    audience: AUDIENCES[index % AUDIENCES.length]!,
    body_html: null,
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    id: 900 + index,
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
      <guid isPermaLink="false">https://${SUBSTACK_HOST}/p/post-${index}</guid>
    </item>`;
    }).join('\n    ')}
  </channel>
</rss>`;

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
  body: string | ((url: string) => string);
};

export type FakeFetcher = Fetcher & { requests: string[] };

/** First matching route wins; anything unrouted is a 404, which is a real answer. */
export function fakeFetcher(routes: Route[]): FakeFetcher {
  const requests: string[] = [];

  const fetcher = async (url: string): Promise<FetchResponse> => {
    requests.push(url);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) return response(404, `no fake route for ${url}`);
    const body = typeof route.body === 'function' ? route.body(url) : route.body;
    return response(route.status ?? 200, body);
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

function response(status: number, body: string): FetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function isoDaysBefore(from: Date, days: number): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString();
}

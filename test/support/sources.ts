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
// YouTube's innertube endpoints
//
// The shapes below were measured against the live channel on 2026-07-30:
// `lockupViewModel` (not `videoRenderer`, which YouTube has retired here), the
// duration as a thumbnail badge, the age as a "2 days ago" metadata part, and a
// player response that answers UNPLAYABLE to WEB while still carrying the date.
// ---------------------------------------------------------------------------

export const videoId = (index: number) => `vid${String(index).padStart(8, '0')}`;

/**
 * 80 videos: 70 inside the window at 16h spacing (~46 days, so the fixture channel
 * is denser than a year like the real one) and 10 from two years ago that the floor
 * has to leave alone. 30 to a page, so the walk has to follow continuations.
 */
export const YOUTUBE_LISTING_IN_WINDOW = 70;
export const YOUTUBE_LISTING_OLDER = 10;
export const YOUTUBE_LISTING_PAGE = 30;

/** Index 3 is a Short the listing dates *and* measures — caught before any fetch. */
export const YOUTUBE_SHORT_IN_LISTING = 3;

/**
 * Index 5 carries no duration badge, which happens. Its 53 seconds only surface with
 * the player response, so it is the Item that proves the second Shorts check exists.
 */
export const YOUTUBE_SHORT_WITHOUT_BADGE = 5;

/** Index 7 has no caption track at all — a fact about the video, not a retry. */
export const YOUTUBE_NO_CAPTIONS = 7;

export function durationOf(index: number): number {
  if (index === YOUTUBE_SHORT_IN_LISTING) return 45;
  if (index === YOUTUBE_SHORT_WITHOUT_BADGE) return 53;
  return 1200 + index;
}

export function publishedOf(index: number): Date {
  return new Date(
    index < YOUTUBE_LISTING_IN_WINDOW
      ? NOW.getTime() - 12 * 3600_000 - index * 16 * 3600_000
      : NOW.getTime() - 730 * 86_400_000,
  );
}

function relativeAge(index: number): string {
  if (index >= YOUTUBE_LISTING_IN_WINDOW) return '2 years ago';
  const hours = 12 + index * 16;
  return hours < 48 ? `${hours} hours ago` : `${Math.floor(hours / 24)} days ago`;
}

function lockup(index: number): unknown {
  const seconds = durationOf(index);
  const badge =
    index === YOUTUBE_SHORT_WITHOUT_BADGE
      ? []
      : [{ thumbnailBadgeViewModel: { text: timecodeOf(seconds), badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } }];

  return {
    richItemRenderer: {
      content: {
        lockupViewModel: {
          contentId: videoId(index),
          contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          contentImage: {
            thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: badge } }] },
          },
          metadata: {
            lockupMetadataViewModel: {
              title: { content: `Video ${index}` },
              metadata: {
                contentMetadataViewModel: {
                  metadataRows: [
                    {
                      metadataParts: [
                        { text: { content: `${10 + index}K views` } },
                        { text: { content: relativeAge(index) } },
                      ],
                    },
                  ],
                  delimiter: ' • ',
                },
              },
            },
          },
        },
      },
    },
  };
}

function timecodeOf(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** One page of the Videos tab, in whichever of the two shapes the endpoint uses. */
export function listingPage(page: number): string {
  const total = YOUTUBE_LISTING_IN_WINDOW + YOUTUBE_LISTING_OLDER;
  const start = page * YOUTUBE_LISTING_PAGE;
  const items: unknown[] = [];

  for (let index = start; index < Math.min(start + YOUTUBE_LISTING_PAGE, total); index += 1) {
    items.push(lockup(index));
  }
  if (start + YOUTUBE_LISTING_PAGE < total) {
    items.push({
      continuationItemRenderer: {
        continuationEndpoint: { continuationCommand: { token: `page-${page + 1}` } },
      },
    });
  }

  // The first page nests the items under the tab; a continuation appends them.
  return page === 0
    ? JSON.stringify({
        contents: {
          twoColumnBrowseResultsRenderer: {
            tabs: [
              { tabRenderer: { title: 'Home', content: {} } },
              { tabRenderer: { title: 'Videos', content: { richGridRenderer: { contents: items } } } },
            ],
          },
        },
      })
    : JSON.stringify({
        onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }],
      });
}

export const CAPTION_SENTENCES = [
  'You keep running out of tokens and you have not done anything unreasonable.',
  'On one working day my tracker recorded three point seven seven billion tokens.',
  'So here is the prompt I paste in, and here is why it works.',
];

export function captionText(index: number): string {
  return [`This is video ${index}.`, ...CAPTION_SENTENCES].join(' ');
}

/**
 * A `json3` track, including the rolling-window event that carries only a newline —
 * the one an extractor has to drop or the transcript fills with blank lines.
 */
export function captionsJson3(index: number): string {
  const events: unknown[] = [
    // The first event is the window declaration: no `segs` at all.
    { tStartMs: 0, dDurationMs: durationOf(index) * 1000, id: 1, wpWinPosId: 1 },
  ];

  [`This is video ${index}.`, ...CAPTION_SENTENCES].forEach((sentence, line) => {
    events.push({
      tStartMs: line * 4000,
      dDurationMs: 4000,
      wWinId: 1,
      // Word-level, with the space *inside* the segment, as YouTube sends it.
      segs: sentence.split(' ').map((word, position) => ({
        utf8: position === 0 ? word : ` ${word}`,
        tOffsetMs: position * 200,
      })),
    });
    events.push({ tStartMs: line * 4000 + 2000, dDurationMs: 2000, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] });
  });

  return JSON.stringify({ wireMagic: 'pb3', pens: [{}], events });
}

export function captionBaseUrl(index: number): string {
  return `https://www.youtube.com/api/timedtext?v=${videoId(index)}&caps=asr&kind=asr&lang=en&signature=deadbeef`;
}

/**
 * A player response. `IOS` carries the caption track and no date; `WEB` carries the
 * date and refuses playback. Both carry `lengthSeconds`, which is the Shorts rule's
 * second chance.
 */
export function playerResponse(id: string, client: string): string {
  const index = Number(id.replace('vid', ''));
  const seconds = durationOf(index);

  if (client === 'WEB') {
    return JSON.stringify({
      playabilityStatus: { status: 'UNPLAYABLE', reason: 'Video unavailable' },
      videoDetails: { videoId: id, lengthSeconds: String(seconds), title: `Video ${index}` },
      microformat: {
        playerMicroformatRenderer: {
          publishDate: publishedOf(index).toISOString(),
          uploadDate: publishedOf(index).toISOString(),
          title: { simpleText: `Video ${index}` },
        },
      },
    });
  }

  return JSON.stringify({
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: id, lengthSeconds: String(seconds), title: `Video ${index}` },
    ...(index === YOUTUBE_NO_CAPTIONS
      ? {}
      : {
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: captionBaseUrl(index),
                  name: { runs: [{ text: 'English (auto-generated)' }] },
                  languageCode: 'en',
                  kind: 'asr',
                },
              ],
            },
          },
        }),
  });
}

// ---------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------

/**
 * A route. `sent` is the POSTed JSON where there is one — YouTube's player endpoint
 * takes its video id and its client name in the body, so a fake that only sees URLs
 * cannot tell the two player calls apart.
 */
export type Route = {
  match: (url: string, sent?: Sent) => boolean;
  status?: number;
  body?: string | ((url: string, sent?: Sent) => string);
  /** For routes whose status depends on the URL — a 404 for an unknown slug, a 429. */
  respond?: (url: string) => { status: number; body: string; headers?: Record<string, string> };
};

/** The POSTed body, untyped for the same reason the reader of it is. */
export type Sent = any;

export type FakeFetcher = Fetcher & {
  requests: string[];
  /** Every request, with the POSTed body where there was one. */
  sent: { url: string; json?: Sent }[];
};

/** First matching route wins; anything unrouted is a 404, which is a real answer. */
export function fakeFetcher(routes: Route[]): FakeFetcher {
  const requests: string[] = [];
  const sent: { url: string; json?: Sent }[] = [];

  const fetcher = async (url: string, init?: { json: unknown }): Promise<FetchResponse> => {
    requests.push(url);
    sent.push(init ? { url, json: init.json } : { url });

    const route = routes.find((candidate) => candidate.match(url, init?.json));
    if (!route) return response(404, `no fake route for ${url}`);

    if (route.respond) {
      const given = route.respond(url);
      return response(given.status, given.body, given.headers);
    }

    const body = typeof route.body === 'function' ? route.body(url, init?.json) : route.body;
    return response(route.status ?? 200, body ?? '');
  };

  return Object.assign(fetcher, { requests, sent });
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
    // Both innertube routes demand a client context, because the live endpoint does:
    // it answers HTTP 400 without one, and a fake that shrugged at a missing context
    // let exactly that bug through to the first real run.
    {
      match: (url) => url.endsWith('/youtubei/v1/browse'),
      body: (_url, sent) => {
        requireClient(sent, 'browse');
        return listingPage(sent.continuation ? Number(sent.continuation.split('-')[1]) : 0);
      },
    },
    {
      match: (url) => url.endsWith('/youtubei/v1/player'),
      body: (_url, sent) => {
        requireClient(sent, 'player');
        return playerResponse(sent.videoId, sent.context.client.clientName);
      },
    },
    {
      match: (url) => url.includes('/api/timedtext'),
      body: (url) => captionsJson3(Number(new URL(url).searchParams.get('v')!.replace('vid', ''))),
    },
    { match: (url) => url.includes('/watch?v='), body: YOUTUBE_WATCH_PAGE },
    { match: (url) => url.startsWith('https://www.youtube.com/'), body: YOUTUBE_CHANNEL_PAGE },
  ];
}

function requireClient(sent: Sent, endpoint: string): void {
  if (!sent?.context?.client?.clientName) {
    throw new Error(`innertube ${endpoint} was called without a client context; YouTube answers 400`);
  }
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

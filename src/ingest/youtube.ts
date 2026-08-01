/**
 * YouTube: the channel walk and the captions, the two per-platform layers.
 *
 * This is where the Corpus actually is — ~395 videos and ~1.17M words in twelve
 * months, against Substack's 15 free posts.
 *
 * ## Measured against the live channel on 2026-07-30, and three findings changed the plan
 *
 * **1. No yt-dlp, and no Python in the deployment.** The research reached captions
 * through yt-dlp (`skip_download`, `subtitlesformat: json3`) and `ingestion.md` §1
 * names that route. It is not needed: `POST /youtubei/v1/player` returns the caption
 * track URL directly, and the track fetches clean over plain HTTP. Confirmed on 5 of
 * 5 videos, ~185 words/minute — matching the ~170 the research measured. braintrust
 * stays a four-dependency Node app with one deployment story.
 *
 * The timedtext URL printed in the watch page's HTML is **not** the one that works:
 * fetched directly it returns HTTP 200 with a zero-byte body, which is why this goes
 * through the player endpoint rather than scraping the page.
 *
 * **2. An undated Item costs 15KB, not 1.3MB.** `ingestion.md` §1 says dates for older
 * Items come from the watch page, "~1.3MB each, ~395 times over" — measured at
 * 1,241,747 bytes, so the figure was right. But the same player endpoint asked as the
 * `WEB` client returns `microformat.publishDate` in ~15KB. It answers `UNPLAYABLE`
 * while doing so, and the date and duration arrive anyway. That is a 90× reduction on
 * the one fetch the design called load-bearing-but-expensive: ~5.8MB across a backfill
 * instead of ~490MB.
 *
 * **3. Shorts are excludable before the expensive fetch, not after.** The channel
 * listing carries a duration badge (`"20:17"`), and the metadata call carries
 * `lengthSeconds`. So a sub-five-minute video is skipped without ever asking for its
 * captions — the measured yield for one was 71 words of promotional copy.
 *
 * ## The one judgement call worth recording
 *
 * The player endpoint requires the caller to name which YouTube client it is, and the
 * clients that return caption tracks are Google's own app surfaces. `WEB` is refused
 * ("Video unavailable"); `IOS` is served. So braintrust names `IOS` on that one call.
 *
 * It does not spoof a browser: the User-Agent stays braintrust's own, with a link to
 * this repo, on every request including this one. No cookies, no sign-in, no rotation,
 * one address, 4s spacing. That is the posture in
 * docs/research/source-terms-and-consent.md §7 — "documented, not disguised" — and
 * yt-dlp reaches the same endpoint the same way while defaulting to a browser
 * User-Agent, so this route is the more transparent of the two, not the less.
 *
 * See docs/design/ingestion.md §1 and docs/research/substack-source-facts.md §§8–9.
 */

import { parseDate } from '../dates.js';
import { BraintrustError } from '../errors.js';
import type { Fetcher } from '../net/fetch.js';
import { PAGE_SPACING_MS, SHORT_MAX_SECONDS } from '../sources/types.js';
import { readCaptions, type CaptionLine } from './captions.js';
import type { ArchiveItem, SourceRow } from './items.js';
import { fetchPolitely, type Pause } from './pace.js';

const INNERTUBE = 'https://www.youtube.com/youtubei/v1';

/** The Videos tab. Opaque, and YouTube's own — a browse of a channel needs it. */
const VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';

/**
 * Two clients, two jobs, and neither is interchangeable with the other.
 *
 * `IOS` is the one that hands over caption tracks. `WEB` is refused for playback but
 * answers with `microformat.publishDate`, which `IOS` omits entirely — so the dates
 * and the words come from two calls, exactly as the feed and the captions do.
 */
const CAPTION_CLIENT = {
  clientName: 'IOS',
  clientVersion: '20.10.4',
  deviceModel: 'iPhone16,2',
  hl: 'en',
};

const METADATA_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20260101.00.00',
  hl: 'en',
};

/** 30 items a page, so 40 pages is 1,200 videos — three times the channel measured. */
const MAX_CHANNEL_PAGES = 40;

/**
 * A month of slack on the backfill floor, because the listing's dates are labels like
 * "3 months ago". Taking a maybe-in-window Item is a row braintrust might not have
 * needed; dropping one is a hole in a window Coverage claims to have filled.
 */
const GRACE_MS = 31 * 86_400_000;

export type YoutubeDeps = {
  fetcher: Fetcher;
  pause?: Pause | undefined;
  now?: (() => Date) | undefined;
};

export type WalkOutcome = {
  seen: number;
  reachedFloor: boolean;
  pages: number;
};

/**
 * Walks the flat channel listing back to `backfill_floor`.
 *
 * **The listing dates nothing precisely.** It says "11 days ago" and, further back,
 * "3 months ago" — enough to know when to stop walking, nowhere near enough for a
 * dated Position. So the coarse age decides the stop and **nothing else**: the Items
 * this writes carry no `published_at` at all, and the exact date arrives with
 * retrieval. An approximate date stored as if measured would quietly poison every
 * held-then-revised Position built on top of it.
 *
 * Because the age is coarse, the floor is applied with a month of grace: an Item that
 * *might* be inside the window is taken, and only one that is unambiguously outside it
 * is left. Erring the other way would silently shorten the window Coverage reports.
 */
export async function walkChannel(
  source: SourceRow,
  deps: YoutubeDeps,
  onRecord: (item: ArchiveItem) => Promise<void>,
  stopWhen?: () => boolean,
): Promise<WalkOutcome> {
  const pause = deps.pause ?? (async () => {});
  const now = deps.now ?? (() => new Date());
  const floor = new Date(`${source.backfill_floor}T00:00:00Z`);

  let seen = 0;
  let pages = 0;
  let continuation: string | undefined;
  let pastFloor = false;

  for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
    if (page > 0) await pause(PAGE_SPACING_MS);

    const payload = continuation
      ? { continuation }
      : { browseId: source.handle, params: VIDEOS_TAB_PARAMS };
    const listing = readListing(
      await innertube(
        deps,
        'browse',
        METADATA_CLIENT,
        payload,
        `the video listing for ${source.handle}`,
      ),
    );
    pages += 1;

    if (listing.videos.length === 0) return { seen, reachedFloor: true, pages };

    for (const video of listing.videos) {
      const age = video.publishedRoughly ? coarseDate(video.publishedRoughly, now()) : undefined;
      if (age && age.getTime() < floor.getTime() - GRACE_MS) {
        pastFloor = true;
        continue;
      }

      await onRecord({
        externalId: video.videoId,
        url: `https://www.youtube.com/watch?v=${video.videoId}`,
        title: video.title,
        // Deliberately no publishedAt: see above.
        audience: 'everyone',
        ...(video.durationSeconds === undefined ? {} : { durationSeconds: video.durationSeconds }),
      });
      seen += 1;

      if (stopWhen?.()) return { seen, reachedFloor: false, pages };
    }

    if (pastFloor) return { seen, reachedFloor: true, pages };

    // No continuation means the listing ended — which for a channel roughly a year
    // deep is the ordinary way a 12-month backfill finishes.
    if (!listing.continuation) return { seen, reachedFloor: true, pages };
    continuation = listing.continuation;
  }

  return { seen, reachedFloor: false, pages };
}

export type VideoMetadata = {
  publishedAt?: Date | undefined;
  durationSeconds?: number | undefined;
  title?: string | undefined;
};

/**
 * The date and the duration for one video, in ~15KB.
 *
 * Only called for an Item the feed never dated — which is every Item the channel walk
 * found. `UNPLAYABLE` is the expected answer here and is not an error: the fields
 * braintrust came for are in the response beside it.
 */
export async function videoMetadata(videoId: string, deps: YoutubeDeps): Promise<VideoMetadata> {
  const player = await innertube(
    deps,
    'player',
    METADATA_CLIENT,
    { videoId },
    `the details for video ${videoId}`,
  );

  const micro = player.microformat?.playerMicroformatRenderer;
  const seconds = Number(player.videoDetails?.lengthSeconds);

  return {
    publishedAt: parseDate(micro?.publishDate ?? micro?.uploadDate),
    durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
    title: micro?.title?.simpleText ?? player.videoDetails?.title,
  };
}

export type YoutubeCaptions = {
  text: string;
  durationSeconds?: number | undefined;
  raw: {
    platform: 'youtube';
    video_id: string;
    language: string;
    /** `asr` is an auto-caption; a manual track says so by not being one. */
    kind: string;
    duration_seconds?: number | undefined;
    /** One start time per line, so a Position can cite a moment rather than a video. */
    segments: CaptionLine[];
  };
};

/** Thrown when a video has no captions at all — a terminal fact about that video. */
export class NoCaptions extends BraintrustError {}

/**
 * Fetches one video's transcript. Two requests: the player, then the track.
 *
 * The duration comes back with the player response, so a caller that did not already
 * know how long the video is can still apply the Shorts rule before the second
 * request — which is why this returns the duration rather than only the words.
 */
export async function retrieveYoutubeCaptions(
  videoId: string,
  deps: YoutubeDeps,
  options: { excludeShorts?: boolean } = {},
): Promise<YoutubeCaptions | { tooShort: number }> {
  const player = await innertube(
    deps,
    'player',
    CAPTION_CLIENT,
    { videoId },
    `the caption list for video ${videoId}`,
  );

  const seconds = Number(player.videoDetails?.lengthSeconds);
  const durationSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  if (options.excludeShorts && durationSeconds !== undefined && durationSeconds < SHORT_MAX_SECONDS) {
    return { tooShort: durationSeconds };
  }

  const track = pickTrack(player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []);
  if (!track) {
    throw new NoCaptions(
      `Video ${videoId} has no caption track braintrust can read. Recorded as failed: ` +
        'a video with no words in it is a fact about the video, not a fetch to retry.',
    );
  }

  const body = await fetchPolitely(
    deps.fetcher,
    `${track.baseUrl}&fmt=json3`,
    `the captions for video ${videoId}`,
    { ...(deps.pause ? { pause: deps.pause } : {}) },
  );
  const captions = readCaptions(body, `video ${videoId}`);

  return {
    text: captions.text,
    durationSeconds,
    raw: {
      platform: 'youtube',
      video_id: videoId,
      language: track.languageCode ?? 'en',
      kind: track.kind ?? 'manual',
      duration_seconds: durationSeconds,
      segments: captions.lines,
    },
  };
}

type CaptionTrackRecord = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
};

/**
 * English, and a track a human wrote in preference to one a model heard.
 *
 * A manual track is punctuated by its author and is simply better text. Auto-captions
 * are what this channel has, and braintrust takes them as they come.
 */
function pickTrack(tracks: CaptionTrackRecord[]): Required<Pick<CaptionTrackRecord, 'baseUrl'>> &
  CaptionTrackRecord | undefined {
  const usable = tracks.filter((track): track is CaptionTrackRecord & { baseUrl: string } =>
    typeof track.baseUrl === 'string' && track.baseUrl !== '',
  );
  const english = usable.filter((track) => (track.languageCode ?? 'en').startsWith('en'));
  const candidates = english.length > 0 ? english : usable;

  return candidates.find((track) => track.kind !== 'asr') ?? candidates[0];
}

type ListingVideo = {
  videoId: string;
  title?: string | undefined;
  durationSeconds?: number | undefined;
  publishedRoughly?: string | undefined;
};

type Listing = {
  videos: ListingVideo[];
  continuation?: string | undefined;
};

/**
 * Reads one page of the listing.
 *
 * YouTube renames its renderers — this listing arrives as `lockupViewModel` where it
 * was `videoRenderer`, and the shape below is the one measured on 2026-07-30. So the
 * duration is found by *looking for something shaped like a duration* among the
 * thumbnail badges rather than by a fixed path, and a page braintrust cannot read
 * says so loudly instead of silently walking zero videos.
 */
export function readListing(body: string): Listing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BraintrustError('The YouTube video listing did not return JSON.');
  }

  const items = gridItems(parsed);
  if (items.length === 0) {
    throw new BraintrustError(
      'braintrust could not find any videos in the YouTube listing. That usually means the ' +
        'response shape changed, not that the channel is empty.',
    );
  }

  const videos: ListingVideo[] = [];
  let continuation: string | undefined;

  for (const item of items) {
    const lockup = item?.richItemRenderer?.content?.lockupViewModel;
    if (lockup?.contentId) {
      const metadata = lockup.metadata?.lockupMetadataViewModel;
      const parts: string[] = (
        metadata?.metadata?.contentMetadataViewModel?.metadataRows ?? []
      ).flatMap((row: MetadataRow) => (row.metadataParts ?? []).map((part) => part.text?.content ?? ''));

      videos.push({
        videoId: lockup.contentId,
        title: metadata?.title?.content,
        durationSeconds: durationFromBadges(lockup.contentImage?.thumbnailViewModel?.overlays ?? []),
        // "19 hours ago" / "2 days ago" / "3 months ago" — the views count is the other part.
        publishedRoughly: parts.find((part) => /\bago\b/.test(part)),
      });
      continue;
    }

    const token = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (token) continuation = token;
  }

  return { videos, ...(continuation ? { continuation } : {}) };
}

type MetadataRow = { metadataParts?: { text?: { content?: string } }[] };

/**
 * `any` on purpose, and only here. This is the boundary where YouTube's renderer tree
 * arrives — deeply nested, renamed without notice, and with every level optional. Typing
 * it would be inventing a contract the other side has not agreed to; the guard is that
 * nothing leaves these functions untyped.
 */
type GridItem = any;

/**
 * The items array, from either shape the endpoint uses: the first page nests them
 * under the Videos tab, and a continuation appends them at the top level.
 */
function gridItems(parsed: any): GridItem[] {
  const tabs = parsed?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  for (const tab of tabs) {
    const contents = tab?.tabRenderer?.content?.richGridRenderer?.contents;
    if (Array.isArray(contents) && contents.length > 0) return contents;
  }

  for (const action of parsed?.onResponseReceivedActions ?? []) {
    const contents = action?.appendContinuationItemsAction?.continuationItems;
    if (Array.isArray(contents) && contents.length > 0) return contents;
  }

  return [];
}

function durationFromBadges(overlays: any[]): number | undefined {
  for (const overlay of overlays) {
    for (const badge of overlay?.thumbnailBottomOverlayViewModel?.badges ?? []) {
      const seconds = parseTimecode(badge?.thumbnailBadgeViewModel?.text);
      if (seconds !== undefined) return seconds;
    }
  }
  return undefined;
}

type PlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { lengthSeconds?: string; title?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrackRecord[] } };
  microformat?: {
    playerMicroformatRenderer?: {
      publishDate?: string;
      uploadDate?: string;
      title?: { simpleText?: string };
    };
  };
};

/**
 * One request to innertube.
 *
 * **Every call carries a client context**, including `browse` — without it the endpoint
 * answers HTTP 400 rather than describing what it wanted, which is how a fixture that
 * ignored the body hid the omission until the first live run.
 */
async function innertube(
  deps: YoutubeDeps,
  endpoint: 'player',
  client: object,
  payload: object,
  what: string,
): Promise<PlayerResponse>;
async function innertube(
  deps: YoutubeDeps,
  endpoint: 'browse',
  client: object,
  payload: object,
  what: string,
): Promise<string>;
async function innertube(
  deps: YoutubeDeps,
  endpoint: 'player' | 'browse',
  client: object,
  payload: object,
  what: string,
): Promise<PlayerResponse | string> {
  // No API key. The endpoint accepts the request without one, and a Google key
  // committed to a public repo would be a liability with nothing to show for it.
  const body = await fetchPolitely(deps.fetcher, `${INNERTUBE}/${endpoint}`, what, {
    ...(deps.pause ? { pause: deps.pause } : {}),
    post: { ...payload, context: { client } },
  });

  if (endpoint === 'browse') return body;

  try {
    return JSON.parse(body) as PlayerResponse;
  } catch {
    throw new BraintrustError(`braintrust asked YouTube for ${what} and got something other than JSON.`);
  }
}

/** `20:17` or `1:02:03` into seconds. Anything else is not a duration. */
export function parseTimecode(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;

  const [, hours, minutes, seconds] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

const UNITS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000, // 30 days. Coarse on purpose — see `walkChannel`.
  year: 31_536_000_000,
};

/**
 * "3 months ago" into roughly when that was.
 *
 * Used for one decision only — whether the walk has gone far enough back — and never
 * written to a row. The units are nominal (a month is 30 days) because YouTube's own
 * label is nominal.
 */
export function coarseDate(relative: string, now: Date): Date | undefined {
  const match = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(relative);
  if (!match) return undefined;

  const unit = UNITS[match[2]!.toLowerCase()];
  if (!unit) return undefined;

  return new Date(now.getTime() - Number(match[1]) * unit);
}

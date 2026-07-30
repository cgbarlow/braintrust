/**
 * YouTube: resolution and the cheap survey.
 *
 * Two facts shape this whole module. `GET https://www.youtube.com/@Handle` returns
 * `channel_id=UC…` in the page body with no bot gate — which is why **the opaque
 * `UC…` id is never something a human types or sees**. And the Atom feed dates only
 * its most recent 15 entries, so the count for a 12-month window has to be
 * extrapolated from the publish rate rather than walked; walking it would make a
 * call that is supposed to be cheap expensive.
 *
 * See docs/design/ingestion.md §1–2 and docs/research/substack-source-facts.md §8–9.
 */

import { daysBetween, monthsBefore, parseDate } from '../dates.js';
import { BraintrustError } from '../errors.js';
import { fetchText, type Fetcher } from '../net/fetch.js';
import { blocks, channelPart, firstTag } from '../net/xml.js';
import type { ResolvedSource, SourceSettings, SourceSurvey } from './types.js';

/** A channel id: `UC` and 22 more characters of base64url. */
export const CHANNEL_ID = /UC[A-Za-z0-9_-]{22}/;

const CHANNEL_ID_EXACT = new RegExp(`^${CHANNEL_ID.source}$`);

export function isChannelId(value: string): boolean {
  return CHANNEL_ID_EXACT.test(value);
}

export function youtubeSource(channelId: string, resolvedFrom: string): ResolvedSource {
  return {
    platform: 'youtube',
    handle: channelId,
    discoveryUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    resolvedFrom,
  };
}

/**
 * Where the channel id is written on a YouTube page, in the order worth trying.
 * The first is the page's own link to the Atom feed — the same feed braintrust is
 * about to use for discovery, so if it is there the resolution is self-confirming.
 */
const ID_IN_PAGE: RegExp[] = [
  new RegExp(`channel_id=(${CHANNEL_ID.source})`),
  new RegExp(`"channelId"\\s*:\\s*"(${CHANNEL_ID.source})"`),
  new RegExp(`"externalId"\\s*:\\s*"(${CHANNEL_ID.source})"`),
  new RegExp(`youtube\\.com/channel/(${CHANNEL_ID.source})`),
];

/**
 * Turns a pasted YouTube link into a channel id, fetching the page when the link
 * does not carry one. A watch URL, a bare `@handle`, a legacy `/c/` or `/user/`
 * path and a Shorts link all take the same route: fetch the page, read the id.
 */
export async function resolveYoutubeChannelId(pageUrl: string, fetcher: Fetcher): Promise<string> {
  const html = await fetchText(fetcher, pageUrl, `the YouTube page ${pageUrl}`);

  for (const pattern of ID_IN_PAGE) {
    const match = pattern.exec(html);
    if (match) return match[1]!;
  }

  throw new BraintrustError(
    `braintrust fetched ${pageUrl} but found no channel id on it. If that is a channel, ` +
      'paste its channel page or any of its videos; if the page needs a sign-in, braintrust ' +
      'cannot read it.',
  );
}

export type YoutubeDeps = {
  fetcher: Fetcher;
  now: Date;
};

export async function surveyYoutube(
  source: ResolvedSource,
  settings: SourceSettings,
  { fetcher, now }: YoutubeDeps,
): Promise<SourceSurvey> {
  const feed = await fetchText(fetcher, source.discoveryUrl, `the YouTube feed for ${source.handle}`);
  const head = channelPart(feed);

  const entries = blocks(feed, 'entry');
  const dates = entries
    .map((entry) => parseDate(firstTag(entry, 'published')))
    .filter((date): date is Date => date !== undefined)
    .sort((a, b) => a.getTime() - b.getTime());

  const floor = monthsBefore(now, settings.windowMonths);
  const windowDays = daysBetween(floor, now);
  const datedInWindow = dates.filter((date) => date >= floor).length;

  const estimate = extrapolate(dates, windowDays);
  const itemsInWindow = Math.max(estimate.count, datedInWindow);

  return {
    feedTitle: firstTag(head, 'title'),
    feedAuthor: firstTag(firstBlockOr(head, 'author'), 'name'),
    itemsInWindow,
    basis: 'estimated',
    how: estimate.how,
    // Always public. YouTube has no paywall flag, so there is nothing to skip and
    // reporting a zero here would read as a measurement of something.
    bodyFetches: itemsInWindow,
    /**
     * The feed dates 15 entries. Everything older is an undated Item until braintrust
     * fetches its watch page, and an undated Item is a degraded one — without a date
     * there are no held-then-revised Positions at all.
     */
    dateFetches: Math.max(0, itemsInWindow - datedInWindow),
  };
}

/**
 * Publish rate across the dated feed entries, projected over the window.
 *
 * The rate is `gaps / span`, not `entries / span`: 15 entries describe 14 intervals,
 * and dividing by the count instead would overstate a short feed by ~7%.
 */
function extrapolate(dates: Date[], windowDays: number): { count: number; how: string } {
  if (dates.length < 2) {
    return {
      count: dates.length,
      how:
        `only ${dates.length} dated entr${dates.length === 1 ? 'y' : 'ies'} in the feed — ` +
        'too few to project a publish rate, so this is the feed itself and probably an undercount',
    };
  }

  const spanDays = daysBetween(dates[0]!, dates[dates.length - 1]!);
  if (spanDays <= 0) {
    return {
      count: dates.length,
      how: `all ${dates.length} dated feed entries share one publish date, so no rate can be projected`,
    };
  }

  const perDay = (dates.length - 1) / spanDays;
  return {
    count: Math.round(perDay * windowDays),
    how: `${perDay.toFixed(1)}/day observed across ${dates.length} dated feed entries`,
  };
}

function firstBlockOr(xml: string, name: string): string {
  return blocks(xml, name)[0] ?? '';
}

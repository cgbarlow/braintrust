/**
 * Substack: resolution and the cheap survey.
 *
 * Substack's numbers are **measured**, not estimated, and the reason is the archive
 * API: `audience` and `post_date` arrive with the catalogue, so the count and the
 * paywall split are exact before a single body is fetched.
 * See docs/design/ingestion.md §2 and docs/research/substack-source-facts.md §3.
 */

import { monthsBefore, parseDate, toDateOnly } from '../dates.js';
import { BraintrustError } from '../errors.js';
import { fetchJson, fetchText, type Fetcher } from '../net/fetch.js';
import { allTags, channelPart, firstTag } from '../net/xml.js';
import { PAGE_SPACING_MS, type ResolvedSource, type SourceSettings, type SourceSurvey } from './types.js';

/**
 * `handle` is the publication host, not the subdomain.
 *
 * The DDL calls this column "publication host", and a Substack on a custom domain
 * has no subdomain to use instead — `platformer.news` is as much a publication id
 * as `natesnewsletter.substack.com` is. Note this is one character narrower than
 * the illustrative Plan in ingestion.md §2, which shows `natesnewsletter`; the host
 * is what actually identifies a publication and what `discovery_url` is built from.
 */
export function substackSource(host: string, resolvedFrom: string): ResolvedSource {
  return {
    platform: 'substack',
    handle: host.toLowerCase(),
    discoveryUrl: `https://${host.toLowerCase()}/feed`,
    resolvedFrom,
  };
}

export function isSubstackHost(host: string): boolean {
  return host.toLowerCase().endsWith('.substack.com');
}

const ARCHIVE_PATH = '/api/v1/archive';
const ARCHIVE_PAGE_SIZE = 50;

/**
 * Safety rail, not a policy. 40 pages is 2,000 posts — well past the largest
 * publication measured (581) and far past any 12-month window, so hitting it means
 * something is wrong with the paging rather than that someone is prolific.
 */
const MAX_ARCHIVE_PAGES = 40;

/**
 * Is this host a Substack? Asked only of hosts that are not `*.substack.com`, so
 * that pasting a custom-domain publication works rather than being told it is not
 * a link braintrust understands.
 */
export async function looksLikeSubstack(host: string, fetcher: Fetcher): Promise<boolean> {
  try {
    const response = await fetcher(`https://${host}${ARCHIVE_PATH}?limit=1&sort=new`);
    if (!response.ok) return false;
    return Array.isArray(JSON.parse(await response.text()));
  } catch {
    return false;
  }
}

type ArchiveRecord = {
  id?: number;
  post_date?: string;
  audience?: string;
};

export type SubstackDeps = {
  fetcher: Fetcher;
  now: Date;
  /** Between archive pages. Reading a catalogue is cheap; hammering it is still rude. */
  pause?: (ms: number) => Promise<void>;
};

export async function surveySubstack(
  source: ResolvedSource,
  settings: SourceSettings,
  { fetcher, now, pause = defaultPause }: SubstackDeps,
): Promise<SourceSurvey> {
  const feed = await fetchText(fetcher, source.discoveryUrl, `the Substack feed for ${source.handle}`);
  const head = channelPart(feed);

  const floor = monthsBefore(now, settings.windowMonths);
  let inWindow = 0;
  let paywalled = 0;

  for (let page = 0; page < MAX_ARCHIVE_PAGES; page += 1) {
    if (page > 0) await pause(PAGE_SPACING_MS);

    const url =
      `https://${source.handle}${ARCHIVE_PATH}` +
      `?sort=new&limit=${ARCHIVE_PAGE_SIZE}&offset=${page * ARCHIVE_PAGE_SIZE}`;
    const records = await fetchJson<ArchiveRecord[]>(fetcher, url, `the Substack archive for ${source.handle}`);

    if (!Array.isArray(records)) {
      throw new BraintrustError(
        `The Substack archive for ${source.handle} returned something other than a list of posts.`,
      );
    }
    if (records.length === 0) break;

    let crossedFloor = false;
    for (const record of records) {
      const published = parseDate(record.post_date);
      // Undated is treated as out of window rather than counted: the archive dates
      // every post it has, so an undated record is a shape braintrust does not know.
      if (!published) continue;
      if (published < floor) {
        // `sort=new` means everything after this is older still.
        crossedFloor = true;
        break;
      }
      inWindow += 1;
      // An allow-list, because live values include `only_paid` and `founding` and a
      // deny-list would silently ingest whatever tier Substack invents next.
      if (record.audience !== 'everyone') paywalled += 1;
    }

    if (crossedFloor) break;
    if (records.length < ARCHIVE_PAGE_SIZE) break;
  }

  return {
    feedTitle: firstTag(head, 'title'),
    // `dc:creator` is per item and it is a person's name by construction, which
    // makes it the best display-name signal either platform offers.
    feedAuthor: mostCommon(allTags(feed, 'dc:creator')),
    itemsInWindow: inWindow,
    basis: 'measured',
    how: `counted from the archive API, ${toDateOnly(floor)} onward`,
    willSkipPaywalled: paywalled,
    bodyFetches: inWindow - paywalled,
    // Every dated post carries its date in the archive record already.
    dateFetches: 0,
  };
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function defaultPause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

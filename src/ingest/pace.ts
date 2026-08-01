/**
 * Pace. The one thing braintrust does that makes an unattended crawl defensible.
 *
 * Spacing between requests is not a tuning knob. Each rate is attached to something
 * measured about the Source it applies to — 4s is the spacing under which caption
 * extraction tested clean where per-video metadata failed every time; 1s is what an
 * open, CDN-served AppView that answers in 548ms and states no limit is owed — and the
 * table is in `sources/types.ts`. braintrust crawls from one host at one address with
 * nothing to rotate, so pace is the whole of its good behaviour.
 *
 * See docs/research/source-terms-and-consent.md §7 and docs/design/ingestion.md §5–6.
 */

import { BraintrustError } from '../errors.js';
import { fetchText, type Fetcher, type FetchResponse } from '../net/fetch.js';

export type Pause = (ms: number) => Promise<void>;

export const sleep: Pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Longest braintrust will wait on a `Retry-After` before treating it as a failure. */
export const MAX_BACKOFF_MS = 60_000;

const DEFAULT_BACKOFF_MS = 10_000;

/**
 * Fetches, and honours one 429.
 *
 * **A 429 is handled before any failure counter sees it.** Rate limiting is the source
 * asking braintrust to slow down, and slowing down is compliance — so it waits the
 * requested time and retries the same item once. Only if it keeps failing does it
 * become a failure worth counting, which is what
 * [#37](https://github.com/cgbarlow/braintrust/issues/37) will count.
 */
export async function fetchPolitely(
  fetcher: Fetcher,
  url: string,
  what: string,
  options: { pause?: Pause; post?: unknown } = {},
): Promise<string> {
  const pause = options.pause ?? sleep;
  const init = options.post === undefined ? undefined : { json: options.post };
  const first = await fetcher(url, init);

  if (first.status !== 429) return bodyOf(first, url, what);

  await pause(backoffFor(first));
  const second = await fetcher(url, init);
  if (second.status === 429) {
    throw new BraintrustError(
      `${what} (${url}) asked braintrust to slow down twice. Leaving it for the next run.`,
    );
  }

  return bodyOf(second, url, what);
}

function backoffFor(response: FetchResponse): number {
  const header = response.headers?.get('retry-after');
  if (!header) return DEFAULT_BACKOFF_MS;

  // Seconds, per the common form. A date is also legal; a source that sends one gets
  // the default rather than a parse braintrust would have to be careful about.
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_BACKOFF_MS;
  return Math.min(seconds * 1000, MAX_BACKOFF_MS);
}

async function bodyOf(response: FetchResponse, url: string, what: string): Promise<string> {
  if (!response.ok) {
    throw new BraintrustError(`braintrust could not read ${what} (${url}): HTTP ${response.status}.`);
  }
  return response.text();
}

/** Re-exported so callers reach for one fetch helper, not two. */
export { fetchText };

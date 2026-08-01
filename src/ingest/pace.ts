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
import { fetchPatiently, fetchText, sleep, type Fetcher, type FetchResponse } from '../net/fetch.js';

export type Pause = (ms: number) => Promise<void>;

/** Both re-exported from the network seam, which is where the 429 rule now lives. */
export { MAX_BACKOFF_MS, sleep } from '../net/fetch.js';

/**
 * Fetches, and honours one 429.
 *
 * **A 429 is handled before any failure counter sees it.** Rate limiting is the source
 * asking braintrust to slow down, and slowing down is compliance — so it waits the
 * requested time and retries the same item once. Only if it keeps failing does it become
 * a failure worth counting, which is what sets a block.
 *
 * The waiting itself is `fetchPatiently`, shared with the model endpoints: this function
 * is the part that turns a response into a body or a sentence a human can read.
 */
export async function fetchPolitely(
  fetcher: Fetcher,
  url: string,
  what: string,
  options: { pause?: Pause; post?: unknown } = {},
): Promise<string> {
  const init = options.post === undefined ? undefined : { json: options.post };
  const response = await fetchPatiently(fetcher, url, init, options.pause ?? sleep);

  if (response.status === 429) {
    throw new BraintrustError(
      `${what} (${url}) asked braintrust to slow down twice. Leaving it for the next run.`,
    );
  }

  return bodyOf(response, url, what);
}

async function bodyOf(response: FetchResponse, url: string, what: string): Promise<string> {
  if (!response.ok) {
    throw new BraintrustError(`braintrust could not read ${what} (${url}): HTTP ${response.status}.`);
  }
  return response.text();
}

/** Re-exported so callers reach for one fetch helper, not two. */
export { fetchText };

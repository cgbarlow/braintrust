/**
 * The network seam.
 *
 * Everything that touches a source depends on `Fetcher`, not on global `fetch`,
 * so resolution and planning are testable without a network — which matters more
 * here than usual, because the thing being tested is *that call 1 ingests
 * nothing*, and that is only provable when every outbound request is visible.
 *
 * The interface is deliberately smaller than `fetch`: a URL in, status and text
 * out. Nothing in braintrust needs more, and a small seam makes a fake three
 * lines long.
 */

import { BraintrustError } from '../errors.js';
import { VERSION } from '../version.js';

export type FetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /**
   * Optional so a fake is still three lines. Only one thing reads it: `Retry-After`
   * on a 429, because slowing down when a source asks is compliance, not a workaround.
   */
  headers?: { get(name: string): string | null } | undefined;
};

/**
 * A POST. Two things need one: YouTube's player endpoint, which takes its request as a
 * JSON body, and the operator's embeddings endpoint, which takes a bearer token when it
 * is a hosted one. `json` rather than a raw body string, because that keeps the seam
 * small enough that a fake is still a few lines.
 */
export type FetchInit = {
  json: unknown;
  headers?: Record<string, string> | undefined;
};

export type Fetcher = (url: string, init?: FetchInit) => Promise<FetchResponse>;

/**
 * braintrust says who it is. No user-agent spoofing beyond what a normal client
 * sends, and no attempt to look like a browser — the v1 posture accepts the
 * automated-access breach openly rather than hiding it.
 * See docs/research/source-terms-and-consent.md §7.
 */
export const USER_AGENT = `braintrust/${VERSION} (+https://github.com/cgbarlow/braintrust; personal single-user tool)`;

export type FetcherOptions = {
  /** A YouTube watch page is ~1.3MB, so this is not as generous as it looks. */
  timeoutMs?: number;
};

export function createFetcher({ timeoutMs = 20_000 }: FetcherOptions = {}): Fetcher {
  return async (url, init) =>
    fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: '*/*',
        ...(init ? { 'content-type': 'application/json', ...init.headers } : {}),
      },
      ...(init ? { method: 'POST', body: JSON.stringify(init.json) } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
}

/** Longest braintrust will wait on a `Retry-After` before treating it as a failure. */
export const MAX_BACKOFF_MS = 60_000;

const DEFAULT_BACKOFF_MS = 10_000;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a 429 asked braintrust to wait.
 *
 * Seconds, per the common form. A date is also legal; a source that sends one gets the
 * default rather than a parse braintrust would have to be careful about.
 */
export function retryAfterMs(response: FetchResponse): number {
  const header = response.headers?.get('retry-after');
  if (!header) return DEFAULT_BACKOFF_MS;

  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_BACKOFF_MS;
  return Math.min(seconds * 1000, MAX_BACKOFF_MS);
}

/** After a dropped connection, not after a 429. Long enough to outlast a blip, short enough to be free. */
export const TRANSPORT_RETRY_MS = 2_000;

/**
 * One request, one honoured 429, and one retry of a connection that never completed.
 *
 * **Rate limiting is the other end asking braintrust to slow down, and slowing down is
 * compliance rather than a workaround.** This lives at the network seam rather than in the
 * ingest path because it turned out not to be an ingest concern: it was written for
 * sources, and then a live run watched the operator's *own* model endpoint answer 429 and
 * braintrust drop the item on the floor — items are re-read next run so nothing was lost,
 * but a rate-limited endpoint could never finish a backfill, because each run would burn a
 * few more items against the same wall.
 *
 * **A throw is retried for a different reason: it is not an answer at all.** A dropped
 * connection is neither the other end refusing braintrust nor serving it — it is the
 * request never having happened, and treating it as a verdict is the same mistake as
 * reading *this video has no captions* as a channel refusing. Found live twice in one day:
 * a synthesiser connection dropped mid-compile and cost a whole Persona its rebuild, while
 * the notes it would have been built from sat already written in the database.
 *
 * Once each, not repeatedly. A second failure is an endpoint that means it, and the
 * caller's own backlog is what tries again tomorrow.
 */
export async function fetchPatiently(
  fetcher: Fetcher,
  url: string,
  init?: FetchInit | undefined,
  pause: (ms: number) => Promise<void> = sleep,
): Promise<FetchResponse> {
  let first: FetchResponse;
  try {
    first = await fetcher(url, init);
  } catch {
    await pause(TRANSPORT_RETRY_MS);
    // The second throw is the caller's to report: it has the words for what this URL was.
    return fetcher(url, init);
  }

  if (first.status !== 429) return first;

  await pause(retryAfterMs(first));
  return fetcher(url, init);
}

/**
 * Fetches text, or fails with a message worth showing a human. `what` names the
 * thing being fetched in the human's terms ("the YouTube channel page"), because
 * a bare URL and a status code is not an explanation.
 */
export async function fetchText(fetcher: Fetcher, url: string, what: string): Promise<string> {
  let response: FetchResponse;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new BraintrustError(
      `braintrust could not reach ${what} (${url}): ${(error as Error).message}`,
    );
  }

  if (!response.ok) {
    throw new BraintrustError(
      `braintrust could not read ${what} (${url}): HTTP ${response.status}. ` +
        'Check the link, or paste a different one for the same person.',
    );
  }

  return response.text();
}

/** As `fetchText`, but the body has to be JSON. Used only for Substack's archive API. */
export async function fetchJson<T>(fetcher: Fetcher, url: string, what: string): Promise<T> {
  const body = await fetchText(fetcher, url, what);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new BraintrustError(
      `${what} (${url}) did not return JSON. That usually means the link is not the ` +
        'publication braintrust took it for.',
    );
  }
}

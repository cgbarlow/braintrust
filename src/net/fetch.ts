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
 * A POST, and there is exactly one reason braintrust needs one: YouTube's player
 * endpoint takes its request as a JSON body. `json` rather than a raw body string,
 * because that keeps the seam small enough that a fake is still a few lines.
 */
export type FetchInit = {
  json: unknown;
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
        ...(init ? { 'content-type': 'application/json' } : {}),
      },
      ...(init ? { method: 'POST', body: JSON.stringify(init.json) } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
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

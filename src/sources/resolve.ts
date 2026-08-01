/**
 * Pasted links in, Sources out.
 *
 * **braintrust cannot find a Person from their name** — neither platform offers a
 * search it can use — so a human always supplies pointers, in whatever form they
 * already have them: a Substack post URL, a hostname, a YouTube channel page, an
 * `@handle`, a link to one video, the address of a blog. This module is the normalising
 * step, and the link as pasted travels onward as `resolvedFrom` so a wrong guess is
 * visible.
 *
 * **The order of the questions is the design.** Each one is asked of a host only when
 * the cheaper, more specific answer has already been ruled out, and the blog question is
 * last because it is the one that accepts anything — it is *best effort*, not
 * recognition, so anything reaching it has already failed to be something braintrust
 * knows more about.
 *
 * See docs/design/ingestion.md §2.
 */

import { BraintrustError } from '../errors.js';
import type { Fetcher } from '../net/fetch.js';
import { actorFromUrl, BSKY_HOSTS, isBlueskyHandle, isDid, resolveBluesky } from './bluesky.js';
import { resolveBlog } from './blog.js';
import { isSubstackHost, looksLikeSubstack, substackSource } from './substack.js';
import { isChannelId, resolveYoutubeChannelId, youtubeSource } from './youtube.js';
import type { ResolvedSource } from './types.js';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

export type ResolveDeps = { fetcher: Fetcher };

/**
 * Resolves every link, then reports **all** the failures at once. Being told about
 * the second bad link only after fixing the first is a waste of the human's turn,
 * and this tool's turns are expensive: each one is an approval prompt.
 */
export async function resolveLinks(links: string[], deps: ResolveDeps): Promise<ResolvedSource[]> {
  const supplied = links.map((link) => link.trim()).filter((link) => link.length > 0);
  if (supplied.length === 0) {
    throw new BraintrustError(
      'braintrust needs at least one link. It cannot find someone from their name — ' +
        'no platform braintrust reads offers a search it can use — so paste what you already ' +
        `have: ${ACCEPTED_FORMS}`,
    );
  }

  const resolved: ResolvedSource[] = [];
  const failures: string[] = [];

  for (const link of supplied) {
    try {
      resolved.push(await resolveOne(link, deps));
    } catch (error) {
      failures.push(
        error instanceof BraintrustError ? error.message : `${link}: ${(error as Error).message}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new BraintrustError(
      `braintrust could not use ${failures.length} of the ${supplied.length} links:\n\n` +
        failures.map((failure) => `  - ${failure}`).join('\n'),
    );
  }

  return dedupe(resolved);
}

const ACCEPTED_FORMS =
  'a Substack post URL or hostname, a YouTube channel page, an @handle, a link to one video, ' +
  'a bsky.app profile or post link, or the address of any blog.';

async function resolveOne(link: string, deps: ResolveDeps): Promise<ResolvedSource> {
  // An explicit prefix, for the case where a bare word is genuinely ambiguous.
  const prefixed = /^(substack|youtube|bluesky|bsky):(.+)$/i.exec(link);
  if (prefixed) {
    const platform = prefixed[1]!.toLowerCase();
    const rest = prefixed[2]!.trim();
    if (platform === 'substack') return substackSource(hostFromSubstackToken(rest, link), link);
    if (platform === 'youtube') return resolveYoutube(rest, link, deps);
    return resolveBluesky(rest, link, deps.fetcher);
  }

  // A DID is a Bluesky identity and nothing else's, so it needs no prefix. A `.bsky.social`
  // handle is the same, and stops there: a Bluesky handle *is* a domain, so recognising any
  // domain as one would swallow every blog address pasted at braintrust — and someone's own
  // domain is their website first. Anything else says `bluesky:` or pastes a bsky.app link.
  if (isDid(link) || isBlueskyHandle(link)) return resolveBluesky(link, link, deps.fetcher);

  // `@handle` stays YouTube's, because that is the notation YouTube itself puts on a
  // channel page and it is what people paste. A Bluesky handle carrying an `@` is
  // recognised by its `.bsky.social` suffix above, and every other one is a link.
  if (link.startsWith('@') || isChannelId(link)) return resolveYoutube(link, link, deps);

  const url = asUrl(link);
  if (!url) {
    throw new BraintrustError(
      `braintrust does not recognise "${link}". Paste ${ACCEPTED_FORMS} ` +
        'A bare word is ambiguous, so prefix it if you mean one: substack:natesnewsletter.',
    );
  }

  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return resolveYoutube(url.toString(), link, deps);
  if (isSubstackHost(host)) return substackSource(host, link);

  // A profile link, or a link to one post on it — both carry the actor in the same place,
  // which is the whole of what braintrust needs.
  if (BSKY_HOSTS.has(host)) {
    const actor = actorFromUrl(url);
    if (!actor) {
      throw new BraintrustError(
        `"${link}" is a bsky.app link braintrust cannot read a person out of. Paste their ` +
          'profile — https://bsky.app/profile/emollick.bsky.social — or a link to one of their posts.',
      );
    }
    return resolveBluesky(actor, link, deps.fetcher);
  }

  // Not a host braintrust knows by name. A Substack on a custom domain is a real and
  // ordinary case, and the archive API answers the question in one cheap request, so
  // ask rather than refuse.
  //
  // **This has to be asked before the blog question, and every blog pays one wasted
  // request for it.** A custom-domain Substack publishes a feed like any blog does, so
  // asking the other way round would resolve it as a blog — and lose the archive API,
  // the paywall split, and the only `measured` item count braintrust has.
  if (await looksLikeSubstack(host, deps.fetcher)) return substackSource(host, link);

  // Anything else is somebody's own hosting, and braintrust does its best with it: it
  // reads what the site declares and refuses only when the site declares nothing. There
  // is no list of blog platforms to be on, which is why a blog needs no recognition step
  // of its own — this branch *is* the recognition.
  return resolveBlog(url, link, deps.fetcher);
}

async function resolveYoutube(target: string, pastedAs: string, { fetcher }: ResolveDeps): Promise<ResolvedSource> {
  if (isChannelId(target)) return youtubeSource(target, pastedAs);

  const pageUrl = youtubePageUrl(target);
  const url = asUrl(pageUrl);

  // The id is often already in the link — a `/channel/UC…` path, or the feed URL
  // itself — and reading it costs nothing.
  if (url) {
    const fromQuery = url.searchParams.get('channel_id');
    if (fromQuery && isChannelId(fromQuery)) return youtubeSource(fromQuery, pastedAs);

    const fromPath = /\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(url.pathname);
    if (fromPath) return youtubeSource(fromPath[1]!, pastedAs);
  }

  return youtubeSource(await resolveYoutubeChannelId(pageUrl, fetcher), pastedAs);
}

/** Normalises the many shapes of YouTube link into one page braintrust can read. */
function youtubePageUrl(target: string): string {
  if (target.startsWith('@')) return `https://www.youtube.com/${target}`;

  const url = asUrl(target);
  if (!url) return `https://www.youtube.com/${target.replace(/^\/+/, '')}`;

  // youtu.be/ID is a watch page in disguise.
  if (url.hostname.toLowerCase().endsWith('youtu.be')) {
    const id = url.pathname.replace(/^\/+/, '');
    return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  }

  // The mobile and music front ends serve the same channel ids as www.
  url.hostname = 'www.youtube.com';
  url.protocol = 'https:';
  return url.toString();
}

function hostFromSubstackToken(token: string, pastedAs: string): string {
  const url = asUrl(token);
  if (url) return url.hostname.toLowerCase();
  if (token.includes('.')) return token.toLowerCase();
  if (!/^[a-z0-9-]+$/i.test(token)) {
    throw new BraintrustError(
      `"${pastedAs}" is not a Substack publication braintrust can build a hostname from.`,
    );
  }
  return `${token.toLowerCase()}.substack.com`;
}

function asUrl(value: string): URL | undefined {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : value.includes('.') || value.startsWith('/')
      ? `https://${value.replace(/^\/+/, '')}`
      : undefined;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.hostname ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Two links to the same person's Substack are one Source. The first mention keeps
 * the `resolvedFrom`, because that is the link the human will recognise.
 */
function dedupe(sources: ResolvedSource[]): ResolvedSource[] {
  const seen = new Map<string, ResolvedSource>();
  for (const source of sources) {
    const key = `${source.platform}:${source.handle}`;
    if (!seen.has(key)) seen.set(key, source);
  }
  return [...seen.values()];
}

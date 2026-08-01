/**
 * Bluesky: resolution, the bridge refusal, and the cheap survey.
 *
 * **This is the one Source braintrust reads on terms it was offered.** The public AppView
 * is open by design — no key, no cookies, no sign-in — serves 100 posts per call with a
 * cursor, and answered in 548ms with no rate-limit headers on the response at all.
 * braintrust accepts a knowing terms breach to read YouTube captions and needs none here.
 *
 * Two things are settled in this file rather than in the ingest path, because both have to
 * be true *before* a row exists.
 *
 * **Identity is the DID, never the handle.** A Bluesky handle is a rebindable domain, so a
 * person who changes theirs must not acquire a second copy of their own archive — the same
 * reason `handle` on a YouTube Source is the opaque `UC…` channel id rather than the
 * `@name` a human types.
 *
 * **A bridged account is refused at registration.** It costs no extra request, because the
 * label arrives on the `getProfile` call the survey already makes.
 *
 * See docs/design/ingestion.md §1, §2 and §7.
 */

import { daysBetween, monthsBefore, parseDate, toDateOnly } from '../dates.js';
import { BraintrustError } from '../errors.js';
import { fetchJson, fetchText, type Fetcher } from '../net/fetch.js';
import type { ResolvedSource, SourceSettings, SourceSurvey } from './types.js';

/** The unauthenticated AppView. Every read braintrust makes of Bluesky goes through it. */
export const APPVIEW = 'https://public.api.bsky.app/xrpc';

/** The maximum `getAuthorFeed` serves in one call, and what makes a day-batched Item cheap. */
export const FEED_PAGE_SIZE = 100;

/**
 * **The person's own writing, and nothing they merely passed on.**
 *
 * `posts_and_author_threads` is the AppView's own name for exactly that: their posts plus
 * the replies they made to themselves — a thread is one thought written in instalments and
 * dropping its tail would cut most of the argument out of the Corpus. Replies into other
 * people's conversations are left where they are, because a Persona built from half a
 * dialogue attributes the other half's premises to the wrong person.
 */
export const AUTHOR_FEED_FILTER = 'posts_and_author_threads';

/**
 * The poll's own document, and the whole of discovery.
 *
 * `discovery_url` stays one column and stays *the thing braintrust fetches to find out
 * what is new* — on Substack and YouTube that is a feed, on a feedless blog a sitemap, and
 * here it is the first page of the author feed. The bodies arrive in the same response,
 * which is why a Bluesky backfill costs requests measured in seconds.
 */
export function authorFeedUrl(did: string, cursor?: string | undefined): string {
  const params = new URLSearchParams({
    actor: did,
    limit: String(FEED_PAGE_SIZE),
    filter: AUTHOR_FEED_FILTER,
  });
  if (cursor) params.set('cursor', cursor);
  return `${APPVIEW}/app.bsky.feed.getAuthorFeed?${params.toString()}`;
}

/**
 * Where a citation points.
 *
 * **The DID rather than the handle, and it is worth the ugliness.** bsky.app resolves both,
 * but a handle is a domain somebody can stop renting — and a citation that stops resolving
 * is a citation braintrust cannot defend. *Dated and cited back to what they actually
 * published* is the product, so the durable form wins over the readable one.
 */
export function postUrl(did: string, rkey: string): string {
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

export function profileUrl(did: string): string {
  return `https://bsky.app/profile/${did}`;
}

export function isDid(value: string): boolean {
  return /^did:[a-z]+:[^\s]+$/i.test(value.trim());
}

/**
 * A bare token braintrust will treat as a Bluesky handle without being told.
 *
 * Deliberately narrow. A Bluesky handle *is* a domain, so anything wider would swallow
 * every blog address pasted at braintrust — and someone's own domain is their website
 * first. Anything else needs the `bluesky:` prefix or a bsky.app link, which is what the
 * accepted-forms message says.
 */
export function isBlueskyHandle(value: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.bsky\.social$/i.test(value.trim().replace(/^@/, ''));
}

export const BSKY_HOSTS = new Set(['bsky.app', 'www.bsky.app']);

/** `https://bsky.app/profile/<handle-or-did>[/post/<rkey>]` — the link a human copies. */
export function actorFromUrl(url: URL): string | undefined {
  const match = /^\/profile\/([^/]+)/.exec(url.pathname);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

export async function resolveBluesky(
  actor: string,
  resolvedFrom: string,
  fetcher: Fetcher,
): Promise<ResolvedSource> {
  const token = actor.trim().replace(/^@/, '');
  const did = isDid(token) ? token : await resolveHandle(token, fetcher);
  return blueskySource(did, resolvedFrom);
}

export function blueskySource(did: string, resolvedFrom: string): ResolvedSource {
  return {
    platform: 'bluesky',
    // The DID, so a rebound handle is the same Source rather than a second archive.
    handle: did,
    discoveryUrl: authorFeedUrl(did),
    resolvedFrom,
  };
}

/**
 * Handle to DID. One cheap request, and none at all when a DID was pasted.
 *
 * Kept separate from `getProfile` on purpose: resolution has to produce the identity a row
 * is keyed on, and the profile — with the bridge label and the counts — is the survey's
 * question. Asking for the profile here would move the refusal out of the step that prices
 * the follow and into the step that normalises a link.
 */
export async function resolveHandle(handle: string, fetcher: Fetcher): Promise<string> {
  const url = `${APPVIEW}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;

  let answer: { did?: string };
  try {
    answer = await fetchJson<{ did?: string }>(fetcher, url, `the Bluesky handle ${handle}`);
  } catch {
    throw new BraintrustError(
      `Bluesky does not know a handle "${handle}". Handles there are domains — ` +
        'emollick.bsky.social, or someone\'s own — so check it against their profile page.',
    );
  }

  if (!answer.did) {
    throw new BraintrustError(`Bluesky answered about "${handle}" without giving braintrust a DID.`);
  }
  return answer.did;
}

/** One post, as far as braintrust is concerned: some words, a moment and a permalink. */
export type BlueskyPost = {
  /** `at://did/app.bsky.feed.post/<rkey>` — the record's own permanent identity. */
  uri: string;
  rkey: string;
  url: string;
  createdAt: Date;
  text: string;
};

/** One closed UTC day of them, in the order they were written. */
export type BlueskyDay = {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  posts: BlueskyPost[];
};

export type FeedPage = {
  posts: BlueskyPost[];
  /**
   * Entries the page carried, before the reposts and the replies to strangers were
   * dropped. **This is what the traffic is priced in**: a call returns 100 entries whether
   * or not braintrust wants them, so a Plan that counted only the keepers would quote a
   * heavy reposter half the requests their backfill actually costs.
   */
  entries: number;
  cursor?: string | undefined;
};

type FeedRecord = {
  post?: {
    uri?: string;
    author?: { did?: string; handle?: string };
    record?: { text?: string; createdAt?: string };
    indexedAt?: string;
  };
  /** Present when the entry is in the feed because it was reposted. */
  reason?: unknown;
  /** Present when the entry is a reply, with the thread it is answering. */
  reply?: { parent?: { author?: { did?: string } } };
};

/**
 * One page of `getAuthorFeed`, reduced to the person's own writing.
 *
 * The filter parameter already asks the AppView for this, and the checks are repeated here
 * anyway: a Persona is a claim about what one person said, and the cost of a wrong entry
 * slipping through is somebody else's words attributed to them permanently. Three things
 * are dropped, for three different reasons.
 *
 * **A repost is not writing.** The entry carries a `reason`, and the words under it belong
 * to whoever wrote them.
 *
 * **A reply into someone else's thread is half a dialogue.** Their own thread is kept — a
 * thread is one thought written in instalments — which is exactly the line the AppView's
 * `posts_and_author_threads` draws, checked here against the parent's author.
 *
 * **A post with no text says nothing braintrust can read.** An image with no caption is
 * real publishing and contributes no words; it is skipped rather than stored as an empty
 * span that a citation could land in.
 */
export function readAuthorFeed(body: string, did: string): FeedPage {
  let parsed: { feed?: FeedRecord[]; cursor?: string };
  try {
    parsed = JSON.parse(body) as { feed?: FeedRecord[]; cursor?: string };
  } catch {
    throw new BraintrustError(`The Bluesky author feed for ${did} did not return JSON.`);
  }

  if (!Array.isArray(parsed.feed)) {
    throw new BraintrustError(
      `The Bluesky author feed for ${did} returned something other than a list of posts.`,
    );
  }

  const posts: BlueskyPost[] = [];
  for (const entry of parsed.feed) {
    if (entry.reason !== undefined) continue;

    const post = entry.post;
    if (!post?.uri || post.author?.did !== did) continue;

    const parent = entry.reply?.parent?.author?.did;
    if (parent !== undefined && parent !== did) continue;

    const text = post.record?.text?.trim();
    if (!text) continue;

    const created = post.record?.createdAt ?? post.indexedAt;
    const at = created ? new Date(created) : undefined;
    if (!at || Number.isNaN(at.getTime())) continue;

    const rkey = post.uri.slice(post.uri.lastIndexOf('/') + 1);
    posts.push({ uri: post.uri, rkey, url: postUrl(did, rkey), createdAt: at, text });
  }

  return {
    posts,
    entries: parsed.feed.length,
    ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
  };
}

/** The half of `profileViewDetailed` braintrust reads. */
type Profile = {
  did?: string;
  handle?: string;
  displayName?: string;
  description?: string;
  postsCount?: number;
  createdAt?: string;
  indexedAt?: string;
  labels?: { src?: string; val?: string }[];
};

export async function getProfile(actor: string, fetcher: Fetcher): Promise<Profile> {
  return fetchJson<Profile>(
    fetcher,
    `${APPVIEW}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
    `the Bluesky profile for ${actor}`,
  );
}

/**
 * The label that means *this account is a republication of somebody else's writing*.
 *
 * Matched on the value rather than on the `.brid.gy` handle suffix, which catches today's
 * bridge and misses tomorrow's, and rather than on `bridgyOriginalText`, which is per
 * record and therefore only visible after braintrust has already followed the account.
 */
export const BRIDGE_LABEL = /^bridged-from-/i;

export function bridgeLabel(profile: Profile): string | undefined {
  return profile.labels?.map((label) => label.val ?? '').find((val) => BRIDGE_LABEL.test(val));
}

/**
 * What the bridge is a bridge *of*, read off the handle it advertises:
 * `karpathy.bearblog.dev.web.brid.gy` is Bridgy Fed republishing `karpathy.bearblog.dev`.
 */
export function bridgedFrom(handle: string | undefined): string | undefined {
  const match = /^(.+)\.[a-z]+\.brid\.gy$/i.exec(handle ?? '');
  return match ? match[1] : undefined;
}

/**
 * **The refusal is a redirect, because the profile hands over the canonical source.**
 *
 * [#58](https://github.com/cgbarlow/braintrust/issues/58) found the duplication is total
 * rather than partial — a Bridgy Fed record carries the entire blog post, HTML and all — so
 * a braintrust following both would hold the same words twice and the copy would not even
 * look short.
 *
 * The temptation is worth naming: that record is cleaner, better-structured HTML than
 * scraping the blog page, and it arrives through an API open by design. **Following the
 * bridge would be easier than following the source.** That is exactly when provenance has
 * to win, or braintrust's record of what someone wrote quietly becomes a record of what a
 * bridge said they wrote.
 */
function refuseBridge(profile: Profile, label: string): BraintrustError {
  const original = bridgedFrom(profile.handle);
  const name = profile.displayName ? ` — it calls itself "${profile.displayName}"` : '';

  return new BraintrustError(
    `${profile.handle ?? 'That account'} is a bridge (${label})${name}. It is ` +
      `${original ? `${original}, ` : 'somebody else\'s writing, '}republished by a third party ` +
      'rather than posted by the person themselves, so braintrust will not read it as them. ' +
      `Follow ${original ? `${original} ` : 'the original '}instead — braintrust reads blogs.`,
  );
}

export type BlueskyDeps = { fetcher: Fetcher; now: Date };

/**
 * **The Plan is projected from what they have just been doing, not from what they have ever
 * done**, and the first live run is why.
 *
 * The obvious survey is free: `getProfile` hands over `postsCount` and `createdAt`, so a
 * lifetime rate costs no request at all. Against two real accounts it was **9.6× and 1.4×
 * too high** — `postsCount` counts replies and reposts across years, and somebody who
 * posted furiously in 2022 is not posting furiously now. Worse, the day count it produced
 * was a *calendar* count: the Plan promised **365 items, `measured`**, and the run wrote
 * 303 and 276, because a day with no posts is no Item.
 *
 * So this spends one more unauthenticated read — the same call the walk itself makes — and
 * measures three things off it: how often they post, how many days of the last few weeks
 * they posted on at all, and how much of a page is repost and reply rather than writing.
 * Nothing is ingested by it. Call 1 gates *downloading someone's work*, not reading a feed
 * to price it, and Substack's survey already pages a whole archive.
 *
 * **Everything it hands back is a projection, and it says so.** Only a full walk could turn
 * these into `measured` numbers, and it earns that word only in the one case where the walk
 * has effectively happened: an account whose whole history fits in the single call.
 */
export async function surveyBluesky(
  source: ResolvedSource,
  settings: SourceSettings,
  { fetcher, now }: BlueskyDeps,
): Promise<SourceSurvey> {
  const profile = await getProfile(source.handle, fetcher);

  const label = bridgeLabel(profile);
  if (label) throw refuseBridge(profile, label);

  const floor = monthsBefore(now, settings.windowMonths);
  const created = parseDate(profile.createdAt) ?? parseDate(profile.indexedAt);

  // The window starts wherever the account does, when that is later. Quoting 365 days for
  // an account three weeks old would be a Plan promising to read days nobody has lived.
  const start = created && created > floor ? created : floor;
  const windowDays = Math.max(1, Math.floor(daysBetween(start, now)));
  const today = toDateOnly(now);

  const page = readAuthorFeed(
    await fetchText(fetcher, authorFeedUrl(source.handle), `the Bluesky posts of ${source.handle}`),
    source.handle,
  );

  // Closed days only, and inside the window: the same two rules the walk applies, so the
  // sample is a sample of the thing being counted rather than of the raw feed.
  const sample = page.posts.filter(
    (post) => toDateOnly(post.createdAt) < today && post.createdAt >= start,
  );
  const sampleDays = new Set(sample.map((post) => toDateOnly(post.createdAt)));

  const survey: SourceSurvey = {
    feedTitle: profile.handle ? `@${profile.handle}` : undefined,
    // A Bluesky display name is a person's name by construction far more often than a
    // feed title is: nobody brands their own profile "Ethan's Bluesky".
    feedAuthor: profile.displayName,
    itemsInWindow: sampleDays.size,
    basis: 'measured',
    how: `every closed UTC day they posted on, counted from the whole account — it fits in one call`,
    postsInWindow: { count: sample.length, how: 'counted, not projected: this is the whole account' },
    bodyFetches: 1,
    bodiesFromDiscovery: true,
    // `createdAt` is on every post record. Nothing is ever fetched to date anything.
    dateFetches: 0,
  };

  // The whole account arrived in one call, so nothing here is a guess. Rare, and exactly
  // the case a new account is in — which is the account somebody is most likely to follow.
  if (!page.cursor) return survey;

  const spanDays = spanOf(page.posts);
  if (sample.length < 2 || spanDays === undefined) {
    // Too little recent activity to measure a rate from. Say what is known and refuse to
    // dress the rest up: the window in days is a fact, and it is an upper bound on Items.
    return {
      ...survey,
      itemsInWindow: windowDays,
      basis: 'estimated',
      how:
        `at most ${windowDays} — the closed UTC days in the window, and a day with no posts ` +
        'is no item. braintrust saw too little recent posting to project a rate from',
      postsInWindow: { count: page.posts.length, how: 'seen in one call; the archive is deeper' },
      bodyFetches: Math.max(1, Math.ceil(windowDays / 4)),
    };
  }

  const postsPerDay = sample.length / spanDays;
  const daysPosted = Math.min(windowDays, Math.round((sampleDays.size / spanDays) * windowDays));
  const posts = Math.round(postsPerDay * windowDays);
  // Entries per post kept, which is what turns a post count into a request count.
  const entries = Math.round(posts * (page.entries / Math.max(1, page.posts.length)));

  return {
    ...survey,
    itemsInWindow: daysPosted,
    basis: 'estimated',
    how:
      `days they posted on, projected from their ${page.posts.length} most recent posts — ` +
      `${sampleDays.size} distinct days across ${Math.round(spanDays)} — inside a window of ` +
      `${windowDays} closed days, which is the ceiling`,
    postsInWindow: {
      count: posts,
      how:
        `${postsPerDay.toFixed(1)} a day across those ${Math.round(spanDays)} days, projected ` +
        'over the window — a recent rate, not a count braintrust has verified',
    },
    // One call is 100 entries, so this is requests rather than Items — which is the whole
    // reason a year of somebody's Bluesky is quoted in seconds rather than hours.
    bodyFetches: Math.max(1, Math.ceil(entries / FEED_PAGE_SIZE)),
  };
}

/** How many days the newest and oldest of a page's posts are apart. */
function spanOf(posts: { createdAt: Date }[]): number | undefined {
  if (posts.length < 2) return undefined;
  const times = posts.map((post) => post.createdAt.getTime());
  const span = daysBetween(new Date(Math.min(...times)), new Date(Math.max(...times)));
  return span >= 1 ? span : undefined;
}

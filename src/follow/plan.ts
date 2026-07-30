/**
 * Call 1 of the handshake: read public metadata, price the work, ingest nothing.
 *
 * **No Item row, no body, no Note, no embedding, and no caption or post body
 * retrieved.** Resolving a handle *is* a fetch and counting an archive *is* an API
 * call — what the handshake gates is downloading someone's work, not reading a feed
 * to price it. This module has no `Db` in reach at all, which is how that guarantee
 * is enforced rather than promised.
 *
 * See docs/design/ingestion.md §2 and docs/design/mcp-surface.md §4.
 */

import { monthsBefore, toDateOnly } from '../dates.js';
import { BraintrustError } from '../errors.js';
import type { Fetcher } from '../net/fetch.js';
import { nameSignals, proposeDisplayName } from '../sources/naming.js';
import { resolveLinks } from '../sources/resolve.js';
import { surveySubstack } from '../sources/substack.js';
import {
  DEFAULT_SETTINGS,
  RETRIEVAL_SPACING_SECONDS,
  type Basis,
  type Platform,
  type ResolvedSource,
  type SourceSettings,
  type SourceSurvey,
} from '../sources/types.js';
import { surveyYoutube } from '../sources/youtube.js';

/** The three settings a human may override, in the wire form the tool accepts. */
export type SourceOverride = {
  platform: Platform;
  /** Only needed to disambiguate two Sources on the same platform. */
  handle?: string | undefined;
  window_months?: number | undefined;
  exclude_shorts?: boolean | undefined;
  poll_interval_hours?: number | undefined;
};

export type PlanNumber = { count: number; basis: Basis; how?: string };

export type PlanSourceSettings = {
  window_months: number;
  backfill_floor: string;
  exclude_shorts: boolean;
  poll_interval_hours: number;
};

export type PlanSource = {
  platform: Platform;
  handle: string;
  resolved_from: string;
  feed_title?: string;
  feed_author?: string;
  items: PlanNumber;
  will_skip_paywalled?: number;
  settings: PlanSourceSettings;
};

export type Plan = {
  /** Proposed, not decided. Call 2 carries the name the human confirmed. */
  person: string;
  sources: PlanSource[];
  /** Omitted when Sources were given different windows, since then there is no one window. */
  window_months?: number;
  /** Stated in the Plan because it is the one setting that is not a setting. */
  paywall: string;
  estimated_duration_min: number;
  estimated_duration_how: string;
  overrides_applied: string[];
};

/** A Source as call 2 will write it. Carried in the token, never recomputed. */
export type PlannedSource = ResolvedSource & {
  settings: SourceSettings;
  backfillFloor: string;
};

export type PlanResult = {
  plan: Plan;
  planned: PlannedSource[];
  proposedName: string;
};

export type PlanDeps = {
  fetcher: Fetcher;
  now: Date;
  pause?: (ms: number) => Promise<void>;
};

/**
 * The drain owns the pace; the Plan only quotes it to turn a fetch count into minutes.
 * Re-exported so a reader of a Plan can find the number that produced it.
 */
export { RETRIEVAL_SPACING_SECONDS } from '../sources/types.js';

export const PAYWALL_NOTE =
  'Paywalled content is never ingested, and what was skipped is recorded. Not configurable.';

export async function buildPlan(
  links: string[],
  overrides: SourceOverride[],
  deps: PlanDeps,
): Promise<PlanResult> {
  const sources = await resolveLinks(links, { fetcher: deps.fetcher });
  const { settings, applied } = applyOverrides(sources, overrides);

  const surveyed: { source: ResolvedSource; settings: SourceSettings; survey: SourceSurvey }[] = [];
  for (const [index, source] of sources.entries()) {
    surveyed.push({
      source,
      settings: settings[index]!,
      survey: await survey(source, settings[index]!, deps),
    });
  }

  const proposedName = proposeDisplayName(
    nameSignals(surveyed.map((entry) => ({ platform: entry.source.platform, survey: entry.survey }))),
    sources[0]!.handle,
  );

  const duration = estimateDuration(surveyed);
  const windows = new Set(surveyed.map((entry) => entry.settings.windowMonths));

  const plan: Plan = {
    person: proposedName,
    sources: surveyed.map((entry) => toPlanSource(entry, deps.now)),
    ...(windows.size === 1 ? { window_months: [...windows][0]! } : {}),
    paywall: PAYWALL_NOTE,
    estimated_duration_min: duration.minutes,
    estimated_duration_how: duration.how,
    overrides_applied: applied,
  };

  return {
    plan,
    planned: surveyed.map((entry) => ({
      ...entry.source,
      settings: entry.settings,
      backfillFloor: toDateOnly(monthsBefore(deps.now, entry.settings.windowMonths)),
    })),
    proposedName,
  };
}

function survey(
  source: ResolvedSource,
  settings: SourceSettings,
  deps: PlanDeps,
): Promise<SourceSurvey> {
  const shared = { fetcher: deps.fetcher, now: deps.now };
  return source.platform === 'substack'
    ? surveySubstack(source, settings, deps.pause ? { ...shared, pause: deps.pause } : shared)
    : surveyYoutube(source, settings, shared);
}

function toPlanSource(
  entry: { source: ResolvedSource; settings: SourceSettings; survey: SourceSurvey },
  now: Date,
): PlanSource {
  const { source, settings, survey: found } = entry;

  const planSource: PlanSource = {
    platform: source.platform,
    handle: source.handle,
    // The link as pasted. This is what makes a wrong resolution visible here rather
    // than three weeks later in someone else's Coverage numbers.
    resolved_from: source.resolvedFrom,
    items: {
      count: found.itemsInWindow,
      basis: found.basis,
      ...(found.how ? { how: found.how } : {}),
    },
    settings: {
      window_months: settings.windowMonths,
      backfill_floor: toDateOnly(monthsBefore(now, settings.windowMonths)),
      exclude_shorts: settings.excludeShorts,
      poll_interval_hours: settings.pollIntervalHours,
    },
  };

  if (found.feedTitle) planSource.feed_title = found.feedTitle;
  if (found.feedAuthor) planSource.feed_author = found.feedAuthor;
  // Shown before anything is fetched, so a human sees that 142 of 156 posts will not
  // be read *before* agreeing rather than discovering it in Coverage afterwards.
  if (found.willSkipPaywalled !== undefined) planSource.will_skip_paywalled = found.willSkipPaywalled;

  return planSource;
}

/**
 * How long the confirmed Plan will actually take.
 *
 * **The 4 seconds are spent per Item, not per request.** A YouTube Item costs two or
 * three back-to-back calls — its date, its caption list, its track — and the cycle
 * spaces the Items rather than the calls, because that is how the spacing was measured
 * (see `retrieveBodies` in `ingest/cycle.ts`). Counting requests here would price a
 * 12-month YouTube backfill at 71 minutes when the job takes 36, and a Plan that
 * overstates the wait is still a Plan that lied to the person approving it.
 *
 * The date fetches are named anyway, because they are real traffic the operator is
 * agreeing to even where they cost no extra wait.
 */
function estimateDuration(
  surveyed: { source: ResolvedSource; survey: SourceSurvey }[],
): { minutes: number; how: string } {
  const parts: string[] = [];
  let items = 0;

  for (const { source, survey: found } of surveyed) {
    if (found.bodyFetches > 0) {
      items += found.bodyFetches;
      parts.push(plural(found.bodyFetches, source.platform === 'youtube' ? 'video' : 'post'));
    }
    if (found.dateFetches > 0) {
      parts.push(`${plural(found.dateFetches, 'publish-date fetch')} alongside`);
    }
  }

  const minutes = Math.ceil((items * RETRIEVAL_SPACING_SECONDS) / 60);
  const how = parts.length
    ? `${parts.join(' + ')} at ${RETRIEVAL_SPACING_SECONDS}s per item`
    : 'nothing to retrieve in this window';
  return { minutes, how };
}

/**
 * Overrides are matched by platform, and by handle too when one is given. An
 * override that matches nothing is an error rather than a no-op: silently ignoring
 * `platform: "youtub"` would hand back a Plan that says 12 months when the human
 * asked for 3, and they would approve it.
 */
export function applyOverrides(
  sources: ResolvedSource[],
  overrides: SourceOverride[],
): { settings: SourceSettings[]; applied: string[] } {
  const settings = sources.map(() => ({ ...DEFAULT_SETTINGS }));
  const applied: string[] = [];

  for (const override of overrides) {
    const targets = sources
      .map((source, index) => ({ source, index }))
      .filter(
        ({ source }) =>
          source.platform === override.platform &&
          (!override.handle || source.handle.toLowerCase() === override.handle.toLowerCase()),
      );

    if (targets.length === 0) {
      throw new BraintrustError(
        `An override names ${describeTarget(override)}, but no such source came out of those links. ` +
          `Resolved: ${sources.map((source) => `${source.platform} ${source.handle}`).join(', ')}.`,
      );
    }

    for (const { source, index } of targets) {
      const current = settings[index]!;
      const label = `${source.platform} ${source.handle}`;

      if (override.window_months !== undefined) {
        assertPositiveInteger(override.window_months, 'window_months');
        applied.push(`${label}: window_months ${current.windowMonths} → ${override.window_months}`);
        current.windowMonths = override.window_months;
      }
      if (override.exclude_shorts !== undefined) {
        applied.push(`${label}: exclude_shorts ${current.excludeShorts} → ${override.exclude_shorts}`);
        current.excludeShorts = override.exclude_shorts;
      }
      if (override.poll_interval_hours !== undefined) {
        assertPositiveInteger(override.poll_interval_hours, 'poll_interval_hours');
        applied.push(
          `${label}: poll_interval_hours ${current.pollIntervalHours} → ${override.poll_interval_hours}`,
        );
        current.pollIntervalHours = override.poll_interval_hours;
      }
    }
  }

  return { settings, applied };
}

function plural(count: number, noun: string): string {
  if (count === 1) return `1 ${noun}`;
  // "fetch" wants "es"; "post" and "video" want "s". A plan a human reads should not
  // say "15 postes".
  return `${count} ${noun}${/(?:ch|sh|s|x|z)$/.test(noun) ? 'es' : 's'}`;
}

function describeTarget(override: SourceOverride): string {
  return override.handle ? `${override.platform} ${override.handle}` : String(override.platform);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new BraintrustError(`${field} must be a whole number of at least 1; got ${value}.`);
  }
}

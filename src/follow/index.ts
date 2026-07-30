/**
 * `braintrust_follow_person`, both halves of it.
 *
 * **Only a human may cause a new Person to be ingested; an AI may never complete the
 * act.** What that guarantee actually rests on is structural, not cryptographic: an
 * MCP server cannot verify that a human said yes. What it can guarantee is that no
 * single call ingests anything, and that the Plan — with its costs, its paywall count
 * and the links it resolved — is rendered into the client's tool-approval surface
 * where a human sees it before the second call exists.
 *
 * It also blunts the prompt-injection case: a poisoned page that tells a connected
 * model to follow forty people cannot get past a step it has no authority to complete.
 *
 * See docs/design/mcp-surface.md §4.
 */

import type { TransactionalDb } from '../db.js';
import { BraintrustError } from '../errors.js';
import type { Fetcher } from '../net/fetch.js';
import { subjectFor } from '../disclosure.js';
import { buildPlan, type Plan, type SourceOverride } from './plan.js';
import { registerFollow, type Registration } from './register.js';
import { TOKEN_TTL_MS, type ConfirmTokenStore } from './tokens.js';

export type FollowArgs = {
  links?: string[] | undefined;
  display_name?: string | undefined;
  confirm_token?: string | undefined;
  overrides?: SourceOverride[] | undefined;
};

export type FollowDeps = {
  db: TransactionalDb;
  tokens: ConfirmTokenStore;
  fetcher: Fetcher;
  now?: (() => Date) | undefined;
  pause?: ((ms: number) => Promise<void>) | undefined;
};

export type PlanResponse = {
  plan: Plan;
  confirm_token: string;
  confirm_token_expires_at: string;
  /** Always false here. Call 1 reads public metadata and writes nothing. */
  ingested: false;
  next: string;
};

export type FollowedResponse = {
  followed: Registration & { subject: string };
  /** Still false: registration hands the work to the daily job rather than doing it. */
  ingested: false;
  next: string;
};

export type FollowResponse = PlanResponse | FollowedResponse;

const MAX_LINKS = 8;
const MAX_NAME_LENGTH = 120;

export async function followPerson(args: FollowArgs, deps: FollowDeps): Promise<FollowResponse> {
  return args.confirm_token ? confirm(args, deps) : propose(args, deps);
}

/** Call 1. No `Db` is touched, and `buildPlan` has none in reach to touch. */
async function propose(args: FollowArgs, deps: FollowDeps): Promise<PlanResponse> {
  const links = args.links ?? [];
  if (links.length === 0) {
    throw new BraintrustError(
      'braintrust_follow_person needs `links` — whatever you already have for this person: ' +
        'a Substack post URL or hostname, a YouTube channel page, an @handle, a link to one ' +
        'video. braintrust cannot look someone up by name.',
    );
  }
  if (links.length > MAX_LINKS) {
    throw new BraintrustError(
      `${links.length} links is more than one person's sources. braintrust follows one person ` +
        `per call, up to ${MAX_LINKS} links.`,
    );
  }

  const { plan, planned, proposedName } = await buildPlan(links, args.overrides ?? [], {
    fetcher: deps.fetcher,
    now: (deps.now ?? (() => new Date()))(),
    ...(deps.pause ? { pause: deps.pause } : {}),
  });

  // A human who already knows the name can supply it in call 1; the proposal is only
  // there so the ordinary case is a confirmation rather than a typing exercise.
  const preferredName = args.display_name ? cleanName(args.display_name) : proposedName;
  plan.person = preferredName;

  const issued = deps.tokens.issue({ plan, planned, proposedName: preferredName });

  return {
    plan,
    confirm_token: issued.token,
    confirm_token_expires_at: issued.expiresAt.toISOString(),
    ingested: false,
    next:
      'Nothing has been fetched: no posts, no captions, no rows. Show this plan to the person ' +
      'you are working for and let them read it — check `resolved_from` on each source is ' +
      'really them, and `will_skip_paywalled` for how much of the corpus braintrust will not ' +
      'read. If they say yes, call braintrust_follow_person again with `confirm_token` and the ' +
      '`display_name` they confirmed (change it if the proposal is wrong — it becomes ' +
      `"braintrust model of X" everywhere). The token is single-use and expires in ` +
      `${Math.round(TOKEN_TTL_MS / 60_000)} minutes.`,
  };
}

/** Call 2. The token is spent before anything is written. */
async function confirm(args: FollowArgs, deps: FollowDeps): Promise<FollowedResponse> {
  if (args.links?.length || args.overrides?.length) {
    throw new BraintrustError(
      'Call 2 takes `confirm_token` and `display_name` only. The plan that was approved is the ' +
        'plan that runs — to change the links or the settings, start again without a token and ' +
        'have the new plan approved.',
    );
  }

  const pending = deps.tokens.redeem(args.confirm_token!);

  if (!args.display_name?.trim()) {
    throw new BraintrustError(
      'Call 2 needs `display_name` — the name a human confirmed. braintrust proposed ' +
        `"${pending.proposedName}"; send that back if it is right, or the corrected name if it ` +
        'is not. This is the string that becomes "braintrust model of X" in every answer, which ' +
        'is why braintrust will not pick it on its own. That token is now spent and nothing was ' +
        'written; call again with the links for a fresh plan.',
    );
  }

  const displayName = cleanName(args.display_name);
  const registration = await registerFollow(deps.db, { displayName, planned: pending.planned });

  return {
    followed: { ...registration, subject: subjectFor(displayName) },
    ingested: false,
    next:
      'The person and their sources are recorded. Every source starts with ' +
      '`backfill_complete: false`, which is the whole signal the daily job needs — there is no ' +
      'separate initial-load mode, so the first run after following someone is the backfill ' +
      `(about ${pending.plan.estimated_duration_min} minutes at 4s spacing, unattended). ` +
      'braintrust_list_personas will show this person immediately, with `compiled: false` until ' +
      'that first run finishes.',
  };
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length === 0) throw new BraintrustError('`display_name` cannot be blank.');
  if (name.length > MAX_NAME_LENGTH) {
    throw new BraintrustError(
      `\`display_name\` is ${name.length} characters. It has to fit in "braintrust model of X" ` +
        `in every answer, so braintrust caps it at ${MAX_NAME_LENGTH}.`,
    );
  }
  return name;
}

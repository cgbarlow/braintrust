/**
 * The confirm token: what makes the handshake two calls instead of one.
 *
 * "Token lifetime is short and single-use; a stale confirmation is a hole in the
 * rule." Both properties live here. A token is redeemed exactly once — the entry is
 * removed before the caller gets it back — so a replayed call 2 cannot ingest a
 * second time.
 *
 * **Accepted cost: this store is in memory.** braintrust has no table for it and
 * schema.sql is the whole schema, so a restart between call 1 and call 2 invalidates
 * a pending confirmation and the human re-runs call 1. That is the safe direction for
 * this to fail in: the failure mode is "plan again", never "ingest something nobody
 * approved". It does mean the web service cannot be run as more than one replica
 * without the two calls landing on different processes, which is fine — deployment.md
 * §2 describes one always-on service, not a fleet.
 *
 * See docs/design/ingestion.md §2 and docs/design/mcp-surface.md §4.
 */

import { randomBytes } from 'node:crypto';

import { BraintrustError } from '../errors.js';
import type { Plan, PlannedSource } from './plan.js';

export type PendingFollow = {
  plan: Plan;
  /** Exactly what call 2 will write. Call 2 re-fetches nothing and re-decides nothing. */
  planned: PlannedSource[];
  proposedName: string;
  expiresAt: number;
};

export type IssuedToken = { token: string; expiresAt: Date };

export type ConfirmTokenStore = {
  issue(pending: Omit<PendingFollow, 'expiresAt'>): IssuedToken;
  /** Consumes the token. Throws a message worth showing a human if it is no good. */
  redeem(token: string): PendingFollow;
  /** For tests and for the health of anyone debugging a stuck handshake. */
  pending(): number;
};

/** Long enough to read a Plan and decide; short enough that a stale yes cannot act. */
export const TOKEN_TTL_MS = 10 * 60_000;

/**
 * A cap so a client that calls step 1 in a loop cannot grow the process without
 * bound. The oldest pending confirmation is dropped, which is the right one to lose.
 */
const MAX_PENDING = 32;

export type TokenStoreOptions = {
  ttlMs?: number;
  now?: () => number;
};

export function createConfirmTokenStore({
  ttlMs = TOKEN_TTL_MS,
  now = () => Date.now(),
}: TokenStoreOptions = {}): ConfirmTokenStore {
  // Insertion-ordered, which is what makes evicting the oldest a one-liner.
  const pending = new Map<string, PendingFollow>();

  const dropExpired = () => {
    const at = now();
    for (const [token, entry] of pending) {
      if (entry.expiresAt <= at) pending.delete(token);
    }
  };

  return {
    issue(entry) {
      dropExpired();
      while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }

      const expiresAt = now() + ttlMs;
      // 256 bits from the CSPRNG. Not derived from the plan: a token has to be
      // unguessable, and a digest of a plan someone else can also compute is not.
      const token = randomBytes(32).toString('base64url');
      pending.set(token, { ...entry, expiresAt });
      return { token, expiresAt: new Date(expiresAt) };
    },

    redeem(token) {
      dropExpired();
      const entry = pending.get(token);
      if (!entry) {
        throw new BraintrustError(
          'That confirm_token is not one braintrust is holding. A token is single-use and ' +
            `expires after ${Math.round(TOKEN_TTL_MS / 60_000)} minutes, and it is lost if the ` +
            'server restarts. Nothing has been ingested — call the follow tool again ' +
            'with the links to get a fresh plan.',
        );
      }
      // Single-use: gone before the caller can act on it, so a retried or replayed
      // call 2 cannot ingest twice.
      pending.delete(token);
      return entry;
    },

    pending() {
      dropExpired();
      return pending.size;
    },
  };
}

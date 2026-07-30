/**
 * The read path for `braintrust_list_personas`: who exists, whether they have ever
 * been compiled, and how stale each core is.
 *
 * See docs/design/mcp-surface.md §1.
 */

import type { Db } from './db.js';
import { subjectFor } from './disclosure.js';

export type CorpusSummary = {
  items_retrieved: number;
  items_skipped_paywall: number;
  window: [string, string];
};

export type PersonaListing = {
  person: string;
  subject: string;
  compiled: boolean;
  compiled_at?: string;
  compiler_version?: string;
  corpus?: CorpusSummary;
  /** Present only when the user has stopped following. A pause is the user's own choice. */
  paused?: { since: string };
};

/**
 * Staleness is `compiled_at` and the client judges it. braintrust does not define
 * "stale", so nothing here computes an age.
 *
 * `corpus` comes from the current compile's `corpus_stats`, written at compile time.
 * A person who has never been compiled has no corpus block and `compiled: false` —
 * which is how "never compiled" is expressed rather than an error.
 */
const LIST_SQL = `
  select p.slug              as person,
         p.display_name      as display_name,
         p.paused_at         as paused_at,
         c.finished_at       as compiled_at,
         c.compiler_version  as compiler_version,
         c.corpus_stats      as corpus_stats
    from braintrust_people p
    left join braintrust_compiles c
      on c.person_id = p.id
     and c.status = 'current'
   order by p.display_name asc
`;

type Row = {
  person: string;
  display_name: string;
  paused_at: Date | null;
  compiled_at: Date | null;
  compiler_version: string | null;
  corpus_stats: Record<string, unknown> | null;
};

export async function listPersonas(db: Db): Promise<{ personas: PersonaListing[] }> {
  const { rows } = await db.query<Row>(LIST_SQL);
  return { personas: rows.map(toListing) };
}

function toListing(row: Row): PersonaListing {
  // A compile row only joins when its status is 'current', so its presence *is*
  // the answer to "has this persona ever been compiled".
  const compiled = row.compiled_at !== null;

  const listing: PersonaListing = {
    person: row.person,
    subject: subjectFor(row.display_name),
    compiled,
  };

  if (compiled) {
    listing.compiled_at = row.compiled_at!.toISOString();
    if (row.compiler_version) listing.compiler_version = row.compiler_version;
    const corpus = asCorpusSummary(row.corpus_stats);
    if (corpus) listing.corpus = corpus;
  }

  // Visible, because a persona that has stopped moving should say why — and a
  // pause must never read as a source block, which is not the user's decision.
  if (row.paused_at) listing.paused = { since: row.paused_at.toISOString() };

  return listing;
}

/**
 * `corpus_stats` is written by the compiler, which does not exist yet. Until it
 * does, an empty or partial object is the normal case, and reporting no corpus
 * block is more honest than reporting zeroes that would read as measurements.
 */
function asCorpusSummary(stats: Record<string, unknown> | null): CorpusSummary | undefined {
  if (!stats) return undefined;

  const retrieved = stats.items_retrieved;
  const skipped = stats.items_skipped_paywall;
  const window = stats.window;

  if (typeof retrieved !== 'number' || typeof skipped !== 'number') return undefined;
  if (!Array.isArray(window) || window.length !== 2) return undefined;
  if (typeof window[0] !== 'string' || typeof window[1] !== 'string') return undefined;

  return {
    items_retrieved: retrieved,
    items_skipped_paywall: skipped,
    window: [window[0], window[1]],
  };
}

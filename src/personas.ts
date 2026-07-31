/**
 * The two read paths for a Persona: `braintrust_list_personas` — who exists, whether
 * they have ever been compiled, and how stale each Core is — and
 * `braintrust_load_persona`, which serves that Core whole.
 *
 * See docs/design/mcp-surface.md §1 and §2.
 */

import { loadCurrent, personExists } from './compile/store.js';
import type { Db } from './db.js';
import { subjectFor } from './disclosure.js';
import { BraintrustError } from './errors.js';

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

/** One Person and the state of their Persona: enough for a write tool to answer with. */
export type PersonRecord = {
  id: string;
  slug: string;
  display_name: string;
  paused_at: string | null;
  compiled_at: string | null;
  compiler_version: string | null;
};

/**
 * Looks a Person up by the slug every tool takes.
 *
 * Deliberately not an error when they are paused — refresh and unfollow both have
 * something to say about a paused Person, and each says its own thing.
 */
export async function personBySlug(db: Db, slug: string): Promise<PersonRecord | undefined> {
  const { rows } = await db.query<{
    id: string;
    slug: string;
    display_name: string;
    paused_at: Date | null;
    compiled_at: Date | null;
    compiler_version: string | null;
  }>(
    `select p.id, p.slug, p.display_name, p.paused_at,
            c.finished_at      as compiled_at,
            c.compiler_version as compiler_version
       from braintrust_people p
       left join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.slug = $1`,
    [slug],
  );

  const row = rows[0];
  if (!row) return undefined;

  // ISO 8601, like every other date this surface returns. Postgres's own text form
  // reads as a different kind of value to a client comparing two answers.
  return {
    ...row,
    paused_at: row.paused_at?.toISOString() ?? null,
    compiled_at: row.compiled_at?.toISOString() ?? null,
  };
}

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

export type LoadedLayerPayload = {
  basis: string;
  descriptive: string;
  /** Voice only. Two columns of one row, so returning both costs nothing. */
  generative?: string;
  evidence: unknown;
};

export type LoadedPersonaPayload = {
  subject: string;
  compiled_at: string | null;
  compiler_version: string;
  /** Which generation of Notes this Persona was built from. Declared, never inferred. */
  extractor: string | null;
  layers: Record<string, LoadedLayerPayload>;
};

/**
 * The Core, whole. No query and no assembly step: serving it is reading the layer rows
 * of the one Compile whose status is `current`.
 *
 * **Never compiled means answer nothing.** Compiling on demand was rejected — a first
 * question that hangs for minutes and spends real money unannounced is a bad first
 * impression, and it puts the most expensive action in the product behind a read call.
 * The two ways of having no Persona are two different sentences, because "braintrust has
 * never heard of them" and "braintrust follows them and has not built one yet" send the
 * caller somewhere different.
 *
 * Voice returns both forms. The client acts on `generative`; `descriptive` and
 * `evidence` are what make the instruction checkable. Returning only the first leaves it
 * unfalsifiable, and returning only the second means two clients build two different
 * personalities from identical data.
 */
export async function loadPersona(db: Db, person: string): Promise<LoadedPersonaPayload> {
  const slug = person.trim();
  const loaded = await loadCurrent(db, slug);

  if (!loaded) {
    if (await personExists(db, slug)) {
      throw new BraintrustError(
        `braintrust follows ${slug} but has not built a persona for them yet. Nothing is compiled ` +
          'on demand: the scheduled job builds a persona once it has read what it collected, so ' +
          'this resolves itself rather than needing anything from you.',
      );
    }
    throw new BraintrustError(
      `braintrust does not follow anyone called "${slug}". braintrust_list_personas has the ones ` +
        'it does, and braintrust_follow_person adds someone new — which only a human can complete.',
    );
  }

  const layers: Record<string, LoadedLayerPayload> = {};
  for (const layer of loaded.layers) {
    layers[layer.layer] = {
      basis: layer.basis,
      descriptive: layer.descriptive_md,
      ...(layer.generative_md !== null ? { generative: layer.generative_md } : {}),
      evidence: layer.evidence,
    };
  }

  return {
    subject: subjectFor(loaded.display_name),
    compiled_at: loaded.compiled_at?.toISOString() ?? null,
    compiler_version: loaded.compiler_version,
    extractor: loaded.extractor,
    layers,
  };
}

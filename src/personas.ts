/**
 * The two read paths for a Persona: `braintrust_list_personas` — who exists, whether
 * they have ever been compiled, and how stale each Core is — and
 * `braintrust_load_persona`, which serves that Core whole.
 *
 * See docs/design/mcp-surface.md §1 and §2.
 */

import { loadCurrent, personExists } from './compile/store.js';
import { COMPILER_VERSION, retiredLayers, withheldLayers } from './compile/version.js';
import type { Db } from './db.js';
import { subjectFor } from './disclosure.js';
import { BraintrustError } from './errors.js';
import { withdrawnLayers } from './interrogate/schedule.js';
import { escalatedFaults } from './interrogate/store.js';
import type { Receipts } from './script.js';
import { renderScript, scriptInputFrom } from './script.js';

export type CorpusSummary = {
  items_retrieved: number;
  items_skipped_paywall: number;
  window: [string, string];
};

/** One Source that has stopped serving braintrust. Never the user's decision. */
export type BlockedSource = { platform: string; handle: string; since: string };

export type PersonaListing = {
  person: string;
  subject: string;
  compiled: boolean;
  compiled_at?: string;
  compiler_version?: string;
  corpus?: CorpusSummary;
  /** Present only when the user has stopped following. A pause is the user's own choice. */
  paused?: { since: string };
  /**
   * Present only while a Source is refusing braintrust.
   *
   * **Deliberately a sibling of `paused` rather than a field inside `corpus`.** They are
   * the two ways a Persona can stop moving and they are not the same fact — one is the
   * user's decision and the other is a platform's — so a client that reads one cannot
   * miss the other. `corpus` would have hidden it too: that block only exists once a
   * Persona has been compiled, and a Source can refuse braintrust during the very first
   * backfill, which is exactly when nobody has been told anything yet.
   */
  blocked?: BlockedSource[];
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

/**
 * Blocked Sources, read live rather than from `corpus_stats`.
 *
 * A block is a fact about a Source right now, not a property of the last Compile — and
 * the two come apart precisely when it matters: a Source that starts refusing braintrust
 * while a rebuild is waiting on something else would otherwise be reported by a snapshot
 * taken before it happened.
 */
async function blockedSources(db: Db): Promise<Map<string, BlockedSource[]>> {
  const { rows } = await db.query<{
    person: string;
    platform: string;
    handle: string;
    blocked_at: Date;
  }>(
    `select p.slug as person, s.platform, s.handle, s.blocked_at
       from braintrust_sources s
       join braintrust_people p on p.id = s.person_id
      where s.blocked_at is not null
      order by p.slug, s.platform, s.handle`,
  );

  const byPerson = new Map<string, BlockedSource[]>();
  for (const row of rows) {
    const blocked = byPerson.get(row.person) ?? [];
    blocked.push({
      platform: row.platform,
      handle: row.handle,
      since: row.blocked_at.toISOString(),
    });
    byPerson.set(row.person, blocked);
  }
  return byPerson;
}

export async function listPersonas(
  db: Db,
): Promise<{ personas: PersonaListing[]; current_compiler_version: string }> {
  const { rows } = await db.query<Row>(LIST_SQL);
  const blocked = await blockedSources(db);
  return {
    personas: rows.map((row) => toListing(row, blocked.get(row.person))),
    // Once, at the top: every listing's `compiler_version` is read against this one.
    current_compiler_version: COMPILER_VERSION,
  };
}

function toListing(row: Row, blocked: BlockedSource[] | undefined): PersonaListing {
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
  if (blocked && blocked.length > 0) listing.blocked = blocked;

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

/**
 * What `braintrust_load_persona` returns: a Script, and the few scalars that cannot be
 * spoken.
 *
 * The layers are **not** here. They are not deleted — `braintrust_explain_persona` returns
 * them whole and verbatim, one visible call away — but a client is no longer handed
 * materials and trusted to speak them well. See docs/design/mcp-surface.md §2.
 *
 * **And nothing that survives to this payload states a conclusion.** The Script is a voice,
 * some authored argument habits and what braintrust has not read; the Receipts are scalars.
 * A model handed this and asked what someone thinks has nothing to answer from and has to
 * go and look. That is the whole of what retiring the Beliefs layer bought.
 */
export type LoadedPersonaPayload = {
  subject: string;
  compiled_at: string | null;
  compiler_version: string;
  /**
   * What *current* is. Without it, `compiler_version` is a string with nothing to be read
   * against — a reader holding one cannot tell a Persona built under today's rules from one
   * built under rules braintrust has since replaced.
   */
  current_compiler_version: string;
  /** Which generation of Notes this Persona was built from. Declared, never inferred. */
  extractor: string | null;
  /** The Script. Ready to speak, with nothing in it to interpret. */
  speak: string;
  /**
   * The Receipts. Scalars, never sentences — so a client holding them can answer *is that
   * measured or inferred* and *how much have you read* immediately, and cannot lift them
   * into voice by accident.
   */
  receipts: Receipts;
};

/** Today's payload, unchanged, behind its own door. */
export type ExplainedPersonaPayload = {
  subject: string;
  compiled_at: string | null;
  compiler_version: string;
  current_compiler_version: string;
  extractor: string | null;
  layers: Record<string, LoadedLayerPayload>;
  /**
   * Layers this Persona has but may not serve, because the rules that wrote them have
   * moved. Present only when there are any — an empty field would read as a fact about the
   * Persona rather than the absence of one.
   */
  withheld?: { layer: string; reason: string }[];
};

async function currentOrFail(db: Db, slug: string) {
  const loaded = await loadCurrent(db, slug);
  if (loaded) return loaded;

  if (await personExists(db, slug)) {
    throw new BraintrustError(
      `braintrust follows ${slug} but has not built a persona for them yet. Nothing is compiled ` +
        'on demand: the scheduled job builds a persona once it has read what it collected, so ' +
        'this resolves itself rather than needing anything from you.',
    );
  }
  throw new BraintrustError(
    `braintrust does not follow anyone called "${slug}". The persona-listing tool has the ones ` +
      'it does, and the follow tool adds someone new — which only a human can complete.',
  );
}

/**
 * The layers this Persona may still serve.
 *
 * **Prose governed by a rule that has moved is absent, not stale.** A number has a
 * conservative direction and can take it; a paragraph a model already wrote does not, so
 * the only honest options are to serve it or not to. What is withheld here is withheld
 * *for this reader, immediately* — the version comparison happens on the read rather than
 * on a clock, so nobody is served prose built under rules braintrust has since changed
 * while a rebuild is pending. See ./unmeasured.ts.
 *
 * **The absence is silent in the Script and named in the receipts.** A Persona missing its
 * Reasoning reads exactly like one that never had it — no second kind of silence — and the
 * question *why* belongs where questions about braintrust's own workings belong.
 *
 * **A retired layer is dropped here too, and it is not the same thing.** Withholding waits
 * for a rebuild; retirement does not wait for anything. Beliefs is the case that made the
 * distinction load-bearing: it was a layer of conclusions a model could answer from without
 * looking anything up, and a Persona compiled before it was retired still has the row. It
 * never reaches a payload again from the moment this deploys, whatever that row says and
 * whenever that Persona was last built. See ./compile/version.ts.
 *
 * **And a third way a layer can be missing: braintrust judged itself and lost.** A Persona
 * that fails its interrogation keeps serving *unchanged* — no warning, nothing withdrawn,
 * because one live call to a non-reproducible synthesiser is evidence rather than proof. But
 * a day is the outer limit. Past it the affected layer arrives here and goes absent, which is
 * the one thing on this map a reader reliably trips over, and a second issue opens for the
 * maintainer who has not shipped a fix. Absent rather than flagged, for the same reason
 * withholding is: there is no second kind of silence. See ./interrogate/schedule.ts.
 */
function layersOf(
  loaded: Awaited<ReturnType<typeof loadCurrent>> & {},
  withdrawn: string[] = [],
): Record<string, LoadedLayerPayload> {
  const withheld = new Set([...withheldLayers(loaded.compiler_version), ...withdrawn]);
  const retired = new Set(retiredLayers(loaded.layers.map((layer) => layer.layer)));
  const layers: Record<string, LoadedLayerPayload> = {};

  for (const layer of loaded.layers) {
    if (retired.has(layer.layer) || withheld.has(layer.layer)) continue;
    layers[layer.layer] = {
      basis: layer.basis,
      descriptive: layer.descriptive_md,
      ...(layer.generative_md !== null ? { generative: layer.generative_md } : {}),
      evidence: layer.evidence,
    };
  }
  return layers;
}


/**
 * The Script, rendered fresh from the stored layers on every call.
 *
 * **Never compiled means answer nothing.** Compiling on demand was rejected — a first
 * question that hangs for minutes and spends real money unannounced is a bad first
 * impression, and it puts the most expensive action in the product behind a read call. The
 * two ways of having no Persona are two different sentences, because "braintrust has never
 * heard of them" and "braintrust follows them and has not built one yet" send the caller
 * somewhere different.
 */
export async function loadPersona(db: Db, person: string): Promise<LoadedPersonaPayload> {
  const slug = person.trim();
  const loaded = await currentOrFail(db, slug);
  const subject = subjectFor(loaded.display_name);
  const withdrawn = withdrawnLayers(await escalatedFaults(db), slug);
  const { speak, receipts } = renderScript(scriptInputFrom(subject, layersOf(loaded, withdrawn)));

  return {
    subject,
    compiled_at: loaded.compiled_at?.toISOString() ?? null,
    compiler_version: loaded.compiler_version,
    current_compiler_version: COMPILER_VERSION,
    extractor: loaded.extractor,
    speak,
    receipts,
  };
}

/**
 * The door the layers went behind.
 *
 * Returns them **verbatim** — same bytes, nothing reformatted for the occasion and nothing
 * summarised. Checkability did not survive this map by staying in front of the client; it
 * survived by staying reachable, and it is only reachable if what comes back is the thing
 * itself rather than an account of it.
 */
export async function explainPersona(db: Db, person: string): Promise<ExplainedPersonaPayload> {
  const slug = person.trim();
  const loaded = await currentOrFail(db, slug);

  const withheld = withheldLayers(loaded.compiler_version);
  const withdrawn = withdrawnLayers(await escalatedFaults(db), slug);

  return {
    subject: subjectFor(loaded.display_name),
    compiled_at: loaded.compiled_at?.toISOString() ?? null,
    compiler_version: loaded.compiler_version,
    current_compiler_version: COMPILER_VERSION,
    extractor: loaded.extractor,
    layers: layersOf(loaded, withdrawn),
    ...(withheld.length > 0 || withdrawn.length > 0
      ? {
          withheld: [
            ...withheld.map((layer) => ({
              layer,
              reason:
                'The rules that wrote this layer have changed since it was compiled. Prose has ' +
                'no cautious version of itself, so braintrust withholds it rather than serving ' +
                'text built under rules it no longer follows. A rebuild restores it.',
            })),
            // Named here and nowhere else, which is the whole arrangement: the absence is
            // silent to a reader and explicable to anyone who asks braintrust about itself.
            ...withdrawn
              .filter((layer) => !withheld.includes(layer))
              .map((layer) => ({
                layer,
                reason:
                  'braintrust interrogated itself, failed, and has been failing for more than a ' +
                  'day. The fault is in the compiler rather than in this persona, so nothing was ' +
                  'rebuilt and nothing else changed — but a day is the outer limit, and past it ' +
                  'the affected part goes absent rather than being served under a claim ' +
                  'braintrust can no longer make. A passing interrogation restores it with no ' +
                  'rebuild.',
              })),
          ],
        }
      : {}),
  };
}

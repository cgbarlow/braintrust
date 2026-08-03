/**
 * `braintrust_recent_items`: what this Person has published lately, newest first.
 *
 * The read path braintrust did not have. Every other read tool is **topic-shaped** —
 * `find_positions` asks *what about X*, `load_persona` asks *who are they* — and a question
 * with no topic in it had nowhere to go. *"What's the gist of his latest article?"* fell
 * through to vector search, which ranks by similarity with no date component whatsoever, so
 * it degenerated to the Corpus centroid: *"his latest article"* and *"what did he publish
 * most recently"* returned the identical five Positions in identical order, and the client
 * — handed 2025 and 2026 dates and no field naming the newest — answered with a 2025 piece
 * while the real one sat cited in the same payload.
 *
 * braintrust's claim over a written-once prompt is a Persona that keeps up with what
 * someone publishes. Until this existed, it could not say what they published.
 *
 * **No model in the path, and no ranking.** Ordering by date is a fact, not a judgement.
 * What each Item carries is its **Note** — `braintrust_item_notes`, *what braintrust wrote
 * down the one time it read the Item* — served as stored. That holds #116's rule at this
 * boundary too: select, never paraphrase. A summary composed here would be braintrust's own
 * prose about someone's article, invented at serve time and checkable against nothing.
 *
 * **The field is `note`, and that is CONTEXT.md's doing.** It was `gist` until the glossary
 * was checked: **Note** lists *summary, extraction, digest* under _Avoid_, and `gist` is
 * that word wearing a shorter coat. Coining a serving-boundary synonym for a thing the
 * glossary already names would give braintrust two words for one concept, which is the
 * single failure CONTEXT.md exists to prevent. #114 caught `provenance` the same way.
 *
 * **Unread Items are listed, marked, and given no Note.** A Skipped Item is a row on
 * purpose (see schema.sql) so a Persona can state its own blind spots. A *latest* list that
 * quietly dropped the paywalled posts would tell a Persona its reach is better than it is —
 * exactly the overstatement #112 forbids — and one that included them without saying so
 * would invite a summary of something nobody read. So they appear, in date order, carrying
 * why and a line that can be spoken.
 *
 * Needs no embeddings, unlike every other retrieval path: it is a date-ordered read of rows
 * that already exist. So it registers on a deployment that has no embeddings endpoint at
 * all, where `find_positions` cannot.
 *
 * See docs/design/mcp-surface.md and https://github.com/cgbarlow/braintrust/issues/124.
 */

import type { Db } from './db.js';
import { subjectFor } from './disclosure.js';
import { BraintrustError } from './errors.js';

export const DEFAULT_RECENT = 10;
export const MAX_RECENT = 50;

/** How many of a Note's claims travel with an Item. Enough to recognise it by. */
export const CLAIMS_PER_ITEM = 5;

export type RecentArgs = {
  person: string;
  limit?: number | undefined;
  since?: string | undefined;
};

/**
 * Why braintrust has no Note for an Item it knows about, and what a Persona can say about
 * it. The `say` line exists for the same reason #115 gave `nothing_matched` one: the
 * Persona has to speak this, and braintrust's own vocabulary is not speakable.
 */
const NOT_READ: Record<string, string> = {
  skipped_paywall: 'behind a paywall, which braintrust never reads',
  skipped_short: 'too short to be worth reading — braintrust skips these by setting',
  skipped_window: 'published before the window braintrust was asked to read',
  skipped_not_a_post: 'a link that turned out not to be a post',
  failed: 'braintrust could not fetch it',
  pending: 'not read yet',
};

export type RecentItem = {
  title: string | null;
  url: string;
  published_at: string | null;
  source: string;
  /**
   * What braintrust wrote when it read this Item. Absent whenever it did not — never an
   * empty Note, because an empty one reads as *there was not much in it* rather than
   * *nobody read it*.
   */
  note?: { argument: string | null; claims: string[]; more_claims?: number };
  /** Present exactly when `note` is absent. */
  not_read?: { reason: string; say: string };
};

export type RecentPayload = {
  subject: string;
  /** So a client can tell a quiet fortnight from a Persona that stopped being rebuilt. */
  compiled_at: string | null;
  window?: { since: string };
  items: RecentItem[];
  more_available?: number;
  /**
   * Present only on an empty answer. braintrust follows this Person and has no Items in
   * range, which a client reads differently from a Person who does not exist.
   */
  nothing_yet?: { say: string };
};

type Row = {
  title: string | null;
  url: string;
  published_at: string | null;
  platform: string;
  retrieval: string;
  argument_md: string | null;
  claims: unknown;
};

export async function recentItems(args: RecentArgs, db: Db): Promise<RecentPayload> {
  const slug = args.person.trim();

  const { rows: people } = await db.query<{ display_name: string; compiled_at: Date | null }>(
    `select p.display_name, c.finished_at as compiled_at
       from braintrust_people p
       left join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.slug = $1`,
    [slug],
  );

  const person = people[0];
  if (!person) {
    throw new BraintrustError(
      `braintrust does not follow anyone called "${slug}". braintrust_list_personas has the ones ` +
        'it does.',
    );
  }

  const limit = Math.max(1, Math.min(MAX_RECENT, Math.trunc(args.limit ?? DEFAULT_RECENT)));

  // One extra row, so "there is more" is known without a second count query.
  //
  // The Note is the newest one for the Item across extractor generations: a re-read with a
  // better model supersedes the older reading, and `distinct on` picks it without the
  // caller having to know which generations exist.
  const { rows } = await db.query<Row>(
    `select i.title, i.url, i.published_at::text as published_at, s.platform, i.retrieval,
            n.argument_md, n.claims
       from braintrust_items i
       join braintrust_sources s on s.id = i.source_id
       join braintrust_people p on p.id = s.person_id
       left join lateral (
         select argument_md, claims
           from braintrust_item_notes
          where item_id = i.id
          order by created_at desc
          limit 1
       ) n on true
      where p.slug = $1
        and ($2::date is null or i.published_at >= $2::date)
      order by i.published_at desc nulls last, i.created_at desc
      limit $3`,
    [slug, args.since ?? null, limit + 1],
  );

  const shown = rows.slice(0, limit);

  const payload: RecentPayload = {
    subject: subjectFor(person.display_name),
    compiled_at: person.compiled_at?.toISOString() ?? null,
    ...(args.since ? { window: { since: args.since } } : {}),
    items: shown.map(toRecentItem),
  };

  if (rows.length > limit) payload.more_available = rows.length - limit;

  if (shown.length === 0) {
    payload.nothing_yet = {
      say: args.since
        ? 'braintrust has nothing from this person published since that date.'
        : 'braintrust follows this person but has not collected anything of theirs yet.',
    };
  }

  return payload;
}

function toRecentItem(row: Row): RecentItem {
  const item: RecentItem = {
    title: row.title,
    url: row.url,
    published_at: row.published_at,
    source: row.platform,
  };

  // Read, and a Note survives. Both halves matter: an Item can be retrieved and still have
  // no Note if the reading failed, and a Note promised over nothing is worse than none.
  if (row.retrieval === 'retrieved' && (row.argument_md !== null || row.claims !== null)) {
    const claims = statementsOf(row.claims);
    item.note = {
      argument: row.argument_md,
      claims: claims.slice(0, CLAIMS_PER_ITEM),
    };
    if (claims.length > CLAIMS_PER_ITEM) item.note.more_claims = claims.length - CLAIMS_PER_ITEM;
    return item;
  }

  const reason = row.retrieval === 'retrieved' ? 'pending' : row.retrieval;
  item.not_read = {
    reason,
    say: NOT_READ[reason] ?? 'braintrust has not read it',
  };
  return item;
}

/** Claims are `[{ statement, quote, … }]`. Only the statements are served. */
function statementsOf(claims: unknown): string[] {
  if (!Array.isArray(claims)) return [];
  return claims
    .map((claim) =>
      claim !== null && typeof claim === 'object' && 'statement' in claim
        ? (claim as { statement: unknown }).statement
        : null,
    )
    .filter((statement): statement is string => typeof statement === 'string');
}

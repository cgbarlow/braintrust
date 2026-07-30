/**
 * Call 2 of the handshake: write the Person and the Sources, and stop there.
 *
 * **Registration signals nothing else.** A new Source starts
 * `backfill_complete = false`, and that single flag is the whole handoff to the daily
 * job — there is no separate initial-load mode, because the first run after following
 * someone *is* the backfill. So this module writes rows and fetches nothing, which is
 * why following a prolific channel returns in milliseconds and finishes in half an
 * hour.
 *
 * See docs/design/ingestion.md §2–3.
 */

import { BraintrustError } from '../errors.js';
import type { Db, TransactionalDb } from '../db.js';
import { firstFreeSlug, slugify } from '../sources/naming.js';
import type { PlannedSource } from './plan.js';

export type RegisteredSource = {
  platform: string;
  handle: string;
  discovery_url: string;
  backfill_floor: string;
  exclude_shorts: boolean;
  poll_interval_hours: number;
  backfill_complete: boolean;
  created: boolean;
};

export type Registration = {
  person: string;
  display_name: string;
  created: boolean;
  /** True when this was a re-follow of a Paused Person. Resuming does start fetching again. */
  resumed_from_pause: boolean;
  sources: RegisteredSource[];
};

export type RegisterInput = {
  /** The name the human confirmed. Becomes "braintrust model of X" everywhere. */
  displayName: string;
  planned: PlannedSource[];
};

export async function registerFollow(
  db: TransactionalDb,
  { displayName, planned }: RegisterInput,
): Promise<Registration> {
  if (planned.length === 0) {
    throw new BraintrustError('There are no sources to follow in that plan.');
  }

  return db.transaction(async (tx) => {
    const existing = await findPersonBySources(tx, planned);

    const person = existing
      ? await resumePerson(tx, existing, displayName)
      : await createPerson(tx, displayName);

    const sources: RegisteredSource[] = [];
    for (const source of planned) {
      sources.push(await upsertSource(tx, person.id, source));
    }

    return {
      person: person.slug,
      display_name: displayName,
      created: person.created,
      resumed_from_pause: person.resumedFromPause,
      sources,
    };
  });
}

/**
 * Re-following an existing Person is recognised by their Sources, not by their name.
 * A Source handle is the thing that cannot be two people — `unique (person_id,
 * platform, handle)` — whereas two people can genuinely share a display name.
 */
async function findPersonBySources(tx: Db, planned: PlannedSource[]): Promise<string | undefined> {
  const pairs = planned.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(', ');
  const params = planned.flatMap((source) => [source.platform, source.handle]);

  const { rows } = await tx.query<{ person_id: string }>(
    `select distinct person_id from braintrust_sources where (platform, handle) in (${pairs})`,
    params,
  );

  if (rows.length > 1) {
    throw new BraintrustError(
      'Those links resolve to sources that already belong to different people in this ' +
        'braintrust. Follow them one person at a time.',
    );
  }

  return rows[0]?.person_id;
}

type PersonRow = { id: string; slug: string; created: boolean; resumedFromPause: boolean };

async function resumePerson(tx: Db, id: string, displayName: string): Promise<PersonRow> {
  const { rows } = await tx.query<{ slug: string; paused_at: Date | null }>(
    'select slug, paused_at from braintrust_people where id = $1',
    [id],
  );
  const found = rows[0];
  if (!found) throw new BraintrustError('That person disappeared while braintrust was writing.');

  // The confirmed name wins — the human just looked at it and said yes. The slug does
  // not change, because every other tool takes the slug and a rename must not orphan it.
  await tx.query('update braintrust_people set display_name = $2, paused_at = null where id = $1', [
    id,
    displayName,
  ]);

  return { id, slug: found.slug, created: false, resumedFromPause: found.paused_at !== null };
}

async function createPerson(tx: Db, displayName: string): Promise<PersonRow> {
  const base = slugify(displayName);
  const { rows } = await tx.query<{ slug: string }>(
    "select slug from braintrust_people where slug = $1 or slug like $1 || '-%'",
    [base],
  );
  const slug = firstFreeSlug(
    base,
    rows.map((row) => row.slug),
  );

  const inserted = await tx.query<{ id: string }>(
    'insert into braintrust_people (slug, display_name) values ($1, $2) returning id',
    [slug, displayName],
  );

  return { id: inserted.rows[0]!.id, slug, created: true, resumedFromPause: false };
}

/**
 * Insert, or bring an already-known Source in line with the Plan the human just
 * approved. Two columns are deliberately left alone on the update path:
 *
 * - `blocked_at`, because a block is measured rather than chosen. Re-following says
 *   the human wants this Person; it does not say the source started answering again,
 *   and the daily job will find that out for itself.
 * - `cursor_published_at`, because the cursor records what braintrust has seen. Moving
 *   it back would re-discover items; clearing it would lose the cheap "new since last
 *   check" answer for no gain.
 */
async function upsertSource(tx: Db, personId: string, source: PlannedSource): Promise<RegisteredSource> {
  const { rows } = await tx.query<{
    id: string;
    backfill_floor: string;
    backfill_complete: boolean;
  }>(
    `select id, backfill_floor::text as backfill_floor, backfill_complete
       from braintrust_sources
      where person_id = $1 and platform = $2 and handle = $3`,
    [personId, source.platform, source.handle],
  );
  const found = rows[0];

  if (!found) {
    // Only the columns the Plan decides are named. Everything else — including
    // `backfill_complete = false` — comes from the DDL defaults, so "what braintrust
    // does if you say nothing" stays readable in exactly one place: schema.sql.
    const inserted = await tx.query<{
      backfill_floor: string;
      exclude_shorts: boolean;
      poll_interval_hours: number;
      backfill_complete: boolean;
    }>(
      `insert into braintrust_sources
         (person_id, platform, handle, discovery_url, backfill_floor, exclude_shorts, poll_interval_hours)
       values ($1, $2, $3, $4, $5::date, $6, $7)
       returning backfill_floor::text as backfill_floor, exclude_shorts,
                 poll_interval_hours, backfill_complete`,
      [
        personId,
        source.platform,
        source.handle,
        source.discoveryUrl,
        source.backfillFloor,
        source.settings.excludeShorts,
        source.settings.pollIntervalHours,
      ],
    );
    return { ...describe(source, inserted.rows[0]!), created: true };
  }

  // A wider window means there is more archive to reach, so the backfill is no longer
  // complete. A narrower one leaves what was already ingested in place — items are
  // tier 1 and braintrust does not delete them to match a smaller number.
  const widened = source.backfillFloor < found.backfill_floor;

  const updated = await tx.query<{
    backfill_floor: string;
    exclude_shorts: boolean;
    poll_interval_hours: number;
    backfill_complete: boolean;
  }>(
    `update braintrust_sources
        set discovery_url = $2,
            backfill_floor = $3::date,
            exclude_shorts = $4,
            poll_interval_hours = $5,
            backfill_complete = case when $6 then false else backfill_complete end
      where id = $1
      returning backfill_floor::text as backfill_floor, exclude_shorts,
                poll_interval_hours, backfill_complete`,
    [
      found.id,
      source.discoveryUrl,
      source.backfillFloor,
      source.settings.excludeShorts,
      source.settings.pollIntervalHours,
      widened,
    ],
  );

  return { ...describe(source, updated.rows[0]!), created: false };
}

function describe(
  source: PlannedSource,
  row: {
    backfill_floor: string;
    exclude_shorts: boolean;
    poll_interval_hours: number;
    backfill_complete: boolean;
  },
): Omit<RegisteredSource, 'created'> {
  return {
    platform: source.platform,
    handle: source.handle,
    discovery_url: source.discoveryUrl,
    backfill_floor: row.backfill_floor,
    exclude_shorts: row.exclude_shorts,
    poll_interval_hours: row.poll_interval_hours,
    backfill_complete: row.backfill_complete,
  };
}

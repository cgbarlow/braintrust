/**
 * `braintrust_unfollow_person`: stop the updates, keep everything.
 *
 * **It is not a takedown.** Unfollowing sets one timestamp. The daily job skips this
 * Person from the next run, and every row they have — items, bodies, chunks, notes, the
 * compiled Persona — stays exactly where it was. The Persona remains queryable, frozen
 * at its last Compile, and says it is paused when anyone lists it.
 *
 * That is a deliberate refusal to conflate two things a user might mean. *Stop spending
 * my money and their bandwidth on this* is a scheduling decision, and it is the one this
 * tool makes. *Erase what you have of this person* is a different decision with
 * different consequences — items are the one tier braintrust cannot recreate without
 * asking the source again, which the whole terms posture exists to avoid. A tool that
 * quietly did both would make the cheap, reversible act carry the irreversible one.
 *
 * **One call, not a handshake.** The two-call handshake gates *downloading somebody's
 * work*; stopping downloads is strictly less exposure and fully reversible, so gating it
 * the same way would spend a human's attention on the safe direction. It is still
 * `readOnlyHint: false`, so it lands in the client's approval surface.
 *
 * See docs/design/mcp-surface.md §6 and docs/design/ingestion.md §5.
 */

import type { Db } from '../db.js';
import { subjectFor } from '../disclosure.js';
import { BraintrustError } from '../errors.js';
import { personBySlug } from '../personas.js';

export type UnfollowArgs = { person: string };

export type UnfollowDeps = { db: Db; now?: (() => Date) | undefined };

export type UnfollowResponse = {
  paused: {
    person: string;
    subject: string;
    since: string;
    /** True when they were already paused. Saying so beats reporting a change that did not happen. */
    was_already_paused: boolean;
  };
  kept: {
    sources: number;
    items: number;
    /** The frozen Persona, still served. Null when they were never compiled. */
    persona: { compiled_at: string; compiler_version: string | null; still_queryable: true } | null;
  };
  /** A field rather than a sentence, because it is the thing most likely to be misread. */
  deleted: 'nothing';
  next: string;
};

export async function unfollowPerson(
  { person: slug }: UnfollowArgs,
  deps: UnfollowDeps,
): Promise<UnfollowResponse> {
  // Read the clock once. Stamping the row from one reading and answering from another
  // would hand back a time that is close to the truth but is not the row.
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const person = await personBySlug(deps.db, slug);

  if (!person) {
    throw new BraintrustError(
      `braintrust does not follow anyone with the slug "${slug}", so there is nothing to stop. ` +
        'The persona-listing tool has the slugs.',
    );
  }

  // Idempotent on purpose. Unfollowing twice is not an error worth raising, and moving
  // the timestamp would rewrite when the user actually made the decision.
  const alreadyPaused = person.paused_at !== null;
  if (!alreadyPaused) {
    await deps.db.query('update braintrust_people set paused_at = $2 where id = $1', [person.id, at]);
  }

  const since = person.paused_at ?? at;
  const kept = await countKept(deps.db, person.id);

  return {
    paused: {
      person: person.slug,
      subject: subjectFor(person.display_name),
      since,
      was_already_paused: alreadyPaused,
    },
    kept: {
      ...kept,
      persona: person.compiled_at
        ? {
            compiled_at: person.compiled_at,
            compiler_version: person.compiler_version,
            still_queryable: true,
          }
        : null,
    },
    deleted: 'nothing',
    next:
      `The daily job will skip ${person.display_name} from its next run. Nothing was deleted and ` +
      'nothing is scheduled to be: their persona still answers the persona-loading tool and ' +
      'the position-lookup tool, frozen at the compile above, and the persona-listing tool ' +
      'shows the pause so an answer of theirs is never quietly out of date. ' +
      'The persona-refresh tool will refuse while they are paused. To start again, follow ' +
      'them — the full two-call handshake, because resuming does mean fetching their work again.',
  };
}

/** What "nothing is deleted" amounts to, counted rather than asserted. */
async function countKept(db: Db, personId: string): Promise<{ sources: number; items: number }> {
  const { rows } = await db.query<{ sources: string; items: string }>(
    `select (select count(*)::text from braintrust_sources s where s.person_id = $1) as sources,
            (select count(*)::text
               from braintrust_items i
               join braintrust_sources s on s.id = i.source_id
              where s.person_id = $1) as items`,
    [personId],
  );
  return { sources: Number(rows[0]!.sources), items: Number(rows[0]!.items) };
}

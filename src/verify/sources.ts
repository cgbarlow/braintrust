/**
 * Verifying where a persona's claims came from: the one place a listener can check.
 *
 * braintrust — not the persona — answers. Every sentence the persona wrote comes back
 * **sourced**, **unsourced** or **never claimed**, in braintrust's own words, never in
 * the persona's voice.
 *
 * Verification is a count against the Item body — `indexOf` on `braintrust_items.body_text`,
 * the same objective verifier `npm run eval` earns its no-model rule from. No judge,
 * no model call, no opinion.
 *
 * See docs/design/mcp-surface.md §9 and https://github.com/cgbarlow/braintrust/issues/203.
 */

import type { Db } from '../db.js';
import { subjectFor } from '../disclosure.js';
import { BraintrustError } from '../errors.js';
import { openFault } from '../interrogate/store.js';

export type ClaimCheck = {
  /** One sentence from the persona's reply. */
  text: string;
  /**
   * The item URL the persona claimed this sentence came from, or null if no source
   * was claimed. braintrust loads the item by URL — same identifier the serving
   * tools return — and checks.
   */
  claimed_item: string | null;
};

export type Verdict = 'sourced' | 'unsourced' | 'never_claimed';

export type SentenceVerdict = {
  sentence: string;
  verdict: Verdict;
  /**
   * Why braintrust returned that verdict, in braintrust's own words — never a
   * repetition of what the persona said. Present only when the verdict is not
   * `sourced`.
   */
  detail?: string;
};

export type VerifyResult = {
  /** "braintrust model of X" — the same subject string every payload carries. */
  subject: string;
  results: SentenceVerdict[];
  /** Every failure opens a record in the fault ledger. Present when one was written. */
  fault?: { assertion: string; key: string };
};

export type VerifyDeps = {
  db: Db;
  /**
   * Injected so a test can report what was observed. Logged at `info` by default.
   */
  log?: (line: string) => void;
};

const ASSERTION = 'verify_sources';
const VERIFIED_AGAINST = 'braintrust_items.body_text — indexOf';

/**
 * Every sentence a persona wrote, checked against the item the persona claimed
 * for it. braintrust returns the record in its own words, never in the persona's
 * voice.
 */
export async function verifySources(
  person: string,
  reply: string,
  sentences: ClaimCheck[],
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const db = deps.db;

  const displayName = await personDisplayName(db, person);

  const results: SentenceVerdict[] = [];
  let failureCount = 0;

  for (const claim of sentences) {
    if (claim.claimed_item === null) {
      results.push({ sentence: claim.text, verdict: 'never_claimed' });
      continue;
    }

    const item = await lookupItem(db, person, claim.claimed_item);

    if (!item) {
      results.push({
        sentence: claim.text,
        verdict: 'never_claimed',
        detail: `braintrust has no item matching the one you named for this person. Whatever the persona attributed to it is not something braintrust can check.`,
      });
      failureCount += 1;
      continue;
    }

    if (!item.body_text) {
      results.push({
        sentence: claim.text,
        verdict: 'unsourced',
        detail: `The item exists and braintrust retrieved it, but the body was not stored — the transcript or post text is missing. braintrust cannot confirm whether the sentence is in it.`,
      });
      failureCount += 1;
      continue;
    }

    const found = item.body_text.indexOf(claim.text.trim()) >= 0;

    if (found) {
      results.push({ sentence: claim.text, verdict: 'sourced' });
    } else {
      results.push({
        sentence: claim.text,
        verdict: 'unsourced',
        detail: `The item exists and braintrust holds its body, but the sentence is not in it. The persona attributed text that is not in the source.`,
      });
      failureCount += 1;
    }
  }

  const result: VerifyResult = {
    subject: subjectFor(displayName),
    results,
  };

  if (failureCount > 0) {
    const detail = [
      `${person}'s persona attributed ${failureCount} of ${sentences.length} sentence(s) to sources that could not be verified.`,
      `verified against: ${VERIFIED_AGAINST}`,
      `reply length: ${reply.length} characters`,
      `failures: ${results.filter((r) => r.verdict !== 'sourced').map((r) => JSON.stringify({ sentence: r.sentence.slice(0, 120), verdict: r.verdict, detail: r.detail })).join('; ')}`,
    ].join('\n');

    try {
      const fault = await openFault(db, {
        assertion: ASSERTION,
        person,
        detail,
      });
      result.fault = { assertion: ASSERTION, key: fault.key };
    } catch (error) {
      log(
        `braintrust: could not record verification fault for ${person} — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}

type PersonRow = { display_name: string };

async function personDisplayName(db: Db, person: string): Promise<string> {
  const { rows } = await db.query<PersonRow>(
    `select display_name from braintrust_people where slug = $1 and paused_at is null`,
    [person],
  );

  if (rows.length === 0) {
    throw new BraintrustError(
      `braintrust does not know ${person}. If you meant someone else, check the slug from ` +
        `braintrust_list_personas.`,
    );
  }

  return rows[0]!.display_name;
}

type ItemRow = { id: string; title: string | null; body_text: string | null };

/**
 * Finds an item belonging to this person by URL, or by title if the URL did not
 * match. A title match is a fallback: the client may know the item by its title
 * rather than its full URL.
 */
async function lookupItem(db: Db, person: string, reference: string): Promise<ItemRow | undefined> {
  const { rows: urlRows } = await db.query<ItemRow>(
    `select it.id, it.title, it.body_text
       from braintrust_items it
       join braintrust_sources s on s.id = it.source_id
       join braintrust_people p on p.id = s.person_id
      where p.slug = $1 and it.url = $2
      limit 1`,
    [person, reference],
  );
  if (urlRows.length > 0) return urlRows[0];

  const { rows: titleRows } = await db.query<ItemRow>(
    `select it.id, it.title, it.body_text
       from braintrust_items it
       join braintrust_sources s on s.id = it.source_id
       join braintrust_people p on p.id = s.person_id
      where p.slug = $1 and it.title = $2
      limit 1`,
    [person, reference],
  );
  if (titleRows.length > 0) return titleRows[0];

  return undefined;
}

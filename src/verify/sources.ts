/**
 * Verifying where a persona's claims came from: the one place a listener can check.
 *
 * braintrust — not the persona — answers. Every sentence the persona wrote comes back
 * **sourced**, **unsourced** or **never claimed**, in braintrust's own words, never in
 * the persona's voice.
 *
 * Verification is a count against the Item body — an `indexOf` on `braintrust_items.body_text`
 * after whitespace and case are normalised, the same objective verifier `npm run eval` earns
 * its no-model rule from. No judge, no model call, no opinion.
 *
 * **Asked to hand over the record, a persona hands over the record.** The handover is
 * lines like `*Title:* "…"`, `*URL:* https://…`, `*Published at:* 2026-07-23` and
 * `*Quote:* "…"`. The record's own field labels are braintrust's naming, never quotations,
 * so they are never verified as quotations: the value each line carries is checked against
 * the item's own field, and a quotation submitted with its label attached is verified on
 * the quotation, not on the label. See https://github.com/cgbarlow/braintrust/issues/277.
 *
 * **A Position is checked against what a Position is.** A Position is synthesised across
 * many Items, so no single Item can contain one. A sentence that matches a Position this
 * person holds is verified against what a Position is; a citation that resolves to no item
 * and no Position is refused as unanswerable, never reported as the persona naming a source
 * that does not exist. See https://github.com/cgbarlow/braintrust/issues/277.
 *
 * See docs/design/mcp-surface.md §9 and https://github.com/cgbarlow/braintrust/issues/203.
 */

import type { Db } from '../db.js';
import { subjectFor } from '../disclosure.js';
import { BraintrustError } from '../errors.js';
import { claimsHeldFor, openFault } from '../interrogate/store.js';

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
   * repetition of what the persona said. Present when the verdict is not `sourced`,
   * and when a `sourced` sentence is verified as a Position rather than a quotation.
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
const VERIFIED_AGAINST = 'braintrust_items.body_text and fields — normalised indexOf';

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
  // The claims braintrust holds for this person. A Position is synthesised across many
  // Items, so no single Item contains it: a sentence that is one of these is checked
  // against what a Position is, not against an Item body. Loaded once per call.
  const held = await claimsHeldFor(db, person);

  const results: SentenceVerdict[] = [];
  let failureCount = 0;

  for (const claim of sentences) {
    if (claim.claimed_item === null) {
      // No source was claimed — but the sentence may still be one of the Positions
      // braintrust holds for this person, in which case it is checked against what a
      // Position is rather than reported as nothing.
      const position = heldClaimFor(claim.text, held);
      if (position) {
        results.push(verifiedAsPosition(claim.text, position.statement));
        continue;
      }
      results.push({ sentence: claim.text, verdict: 'never_claimed' });
      continue;
    }

    const item = await lookupItem(db, person, claim.claimed_item);

    if (!item) {
      // The named source is not an Item braintrust holds. It may be a Position — which is
      // synthesised across many Items and so is never a single Item — or it may simply be
      // something braintrust cannot check. Checked against what a Position is first, and
      // refused as unanswerable otherwise. Never reported as the persona naming a source
      // that does not exist.
      const position = heldClaimFor(claim.text, held);
      if (position) {
        results.push(verifiedAsPosition(claim.text, position.statement));
        continue;
      }
      results.push({
        sentence: claim.text,
        verdict: 'never_claimed',
        detail:
          `braintrust holds nothing matching the source you named for this person, and the ` +
          `sentence is not one of the Positions it holds for them either, so it cannot be ` +
          `checked. A check that cannot be made is refused as unanswerable, and is never ` +
          `reported as a finding against the persona.`,
      });
      continue;
    }

    const field = recordFieldOf(claim.text);

    if (field) {
      const verdict = verifyRecordField(claim.text, field, item);
      if (verdict.verdict === 'unsourced') failureCount += 1;
      results.push(verdict);
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

    const found = bodyContains(item.body_text, claim.text);

    if (found) {
      results.push({ sentence: claim.text, verdict: 'sourced' });
    } else {
      // Not in the item body — but it could be a Position, which is synthesised across many
      // Items and so is never found in any single one of them.
      const position = heldClaimFor(claim.text, held);
      if (position) {
        results.push(verifiedAsPosition(claim.text, position.statement));
        continue;
      }
      results.push({
        sentence: claim.text,
        verdict: 'unsourced',
        detail: `The item exists and braintrust holds its body, but "${spanFor(claim.text)}" is not in it. The persona attributed text that is not in the source.`,
      });
      failureCount += 1;
    }
  }

  const result: VerifyResult = {
    subject: subjectFor(displayName),
    results,
  };

  if (failureCount > 0) {
    const details = results
      .filter((r) => r.verdict === 'unsourced')
      .map((r) => JSON.stringify({ sentence: r.sentence.slice(0, 120), detail: r.detail }))
      .join('; ');
    const detail = [
      `${person}'s persona attributed ${failureCount} of ${sentences.length} sentence(s) to sources that could not be verified.`,
      `verified against: ${VERIFIED_AGAINST}`,
      `reply length: ${reply.length} characters`,
      `failures: ${details}`,
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

// ---------------------------------------------------------------------------
// The record handover
// ---------------------------------------------------------------------------

/** A record field line as the persona handed it over. */
type RecordField = {
  kind: 'header' | 'title' | 'url' | 'published_at' | 'quote';
  value: string;
};

const RECORD_LABELS: ReadonlyArray<{ re: string; kind: RecordField['kind'] }> = [
  { re: 'title', kind: 'title' },
  { re: 'url', kind: 'url' },
  { re: 'link', kind: 'url' },
  { re: 'published at', kind: 'published_at' },
  { re: 'published', kind: 'published_at' },
  { re: 'date', kind: 'published_at' },
  { re: 'quote', kind: 'quote' },
  { re: 'quotation', kind: 'quote' },
];

/**
 * Whether a sentence is a record handover line, and which field it carries.
 *
 * A handover's *label* (`*Title:*`, `*URL:*`, `*Published at:*`, `*Quote:*` or the
 * `**Record**` header) is braintrust's own naming — never a quotation. What the line
 * actually claims is the value that follows the label, and that is what gets verified,
 * against the item's own field. A bare record header (`**Record**`) carries only a label:
 * it is the handover's framing, never something to verify as a quotation.
 */
function recordFieldOf(text: string): RecordField | undefined {
  const trimmed = text.trim();
  if (/^\*{1,2}\s*record\s*\*{1,2}$/i.test(trimmed)) {
    return { kind: 'header', value: '' };
  }
  for (const { re, kind } of RECORD_LABELS) {
    // Two asterisk orientations occur in the wild: `*Title*:` and `*Title:*`. Both are the
    // same field label and neither is a quotation.
    const marked =
      new RegExp(`^\\*{1,2}\\s*${re}\\s*\\*{1,2}\\s*:\\s*(.+)$`, 'i').exec(trimmed) ??
      new RegExp(`^\\*{1,2}\\s*${re}\\s*:\\s*\\*{1,2}\\s*(.+)$`, 'i').exec(trimmed);
    if (marked) {
      return { kind, value: marked[1]!.trim() };
    }

    // A bare `Title:` — no asterisks — is accepted only when its value is shaped like the
    // field's record value. Without the asterisks, a prose sentence that happens to open
    // with one of these words ("Quote: I think …") must not be misread as a label and
    // routed past the plain body check.
    const bare = new RegExp(`^${re}\\s*:\\s*(.+)$`, 'i').exec(trimmed);
    if (bare && looksLikeRecordValue(kind, bare[1]!.trim())) {
      return { kind, value: bare[1]!.trim() };
    }
  }
  return undefined;
}

/**
 * Whether a bare label's value is shaped like the field it claims, so a prose sentence that
 * merely opens with a label word is not misread as a handover line.
 */
function looksLikeRecordValue(kind: RecordField['kind'], value: string): boolean {
  switch (kind) {
    case 'published_at':
      // A publication date is shaped like a date.
      return /\d{4}-\d{2}-\d{2}/.test(value);
    case 'title':
    case 'quote':
      // A title or quotation is handed over set off in quote marks.
      return /^[“"'`]/.test(value);
    case 'url':
      // A URL is handed over as one token: a scheme, or a bare host with at least one dot.
      // A sentence that merely opens "URL: …" carries spaces and stays prose.
      return /^https?:\/\/\S+$/i.test(value) || (value.indexOf(' ') === -1 && /^\S+\.\S+/.test(value));
    case 'header':
      return false;
  }
}

/**
 * Verifies a record handover line against the item it was claimed for.
 *
 * The field label is never verified as a quotation. The value is checked against the item's
 * own field: the title against the title field, the URL against the URL field, the date
 * against the published date, and the quotation against the body. A handover that matches
 * the item's record passes; one whose value disagrees with the item's own field is
 * `unsourced`, naming what disagreed.
 */
function verifyRecordField(
  sentence: string,
  field: RecordField,
  item: ItemRow,
): SentenceVerdict {
  switch (field.kind) {
    case 'header':
      return { sentence, verdict: 'sourced' };

    case 'title': {
      const given = bareRecordValue(field.value);
      const stored = bareRecordValue(item.title ?? '');
      if (given.length === 0 || stored.length === 0) {
        return {
          sentence,
          verdict: 'never_claimed',
          detail: `braintrust holds no title for this item, so it cannot check the title that was submitted with it.`,
        };
      }
      return given === stored
        ? { sentence, verdict: 'sourced' }
        : {
            sentence,
            verdict: 'unsourced',
            detail: `The item's own title is "${item.title}", not "${spanFor(field.value)}".`,
          };
    }

    case 'url': {
      const given = comparableUrl(bareRecordValue(field.value));
      const stored = comparableUrl(bareRecordValue(item.url));
      if (given === stored) return { sentence, verdict: 'sourced' };
      return {
        sentence,
        verdict: 'unsourced',
        detail: `The item's own URL is "${item.url}", not "${spanFor(field.value)}".`,
      };
    }

    case 'published_at': {
      const given = dateOf(field.value);
      const stored = dateOf(item.published_at);
      if (given === null || stored === null) {
        return {
          sentence,
          verdict: 'never_claimed',
          detail: `braintrust could not compare the dates it holds, so the "Published at" line is unverifiable.`,
        };
      }
      return given === stored
        ? { sentence, verdict: 'sourced' }
        : {
            sentence,
            verdict: 'unsourced',
            detail: `The item's own publication date is ${stored}, not ${given}.`,
          };
    }

    case 'quote': {
      if (!item.body_text) {
        // The item exists but its body was never stored — the same honest refusal the
        // plain-quotation path gives, rather than claiming braintrust holds a body it does
        // not have (see the `!item.body_text` branch in verifySources).
        return {
          sentence,
          verdict: 'unsourced',
          detail: `The item exists and braintrust retrieved it, but the body was not stored — the transcript or post text is missing, so braintrust cannot confirm whether the quotation is in it.`,
        };
      }
      const span = spanFor(field.value);
      if (bodyContains(item.body_text, span)) {
        return { sentence, verdict: 'sourced' };
      }
      return {
        sentence,
        verdict: 'unsourced',
        detail: `The item exists and braintrust holds its body, but "${span}" is not in it. The persona attributed a quotation the source does not contain.`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// A Position: what it is, and how it is verified
// ---------------------------------------------------------------------------

/**
 * The shortest either side may be before a sentence can count as a held claim.
 *
 * A Position is a whole statement ("Recovering perfectionists optimise speed at the cost
 * of skill"), so a fragment below this floor cannot be it. The same value the quotation
 * checks use — a span that short is a piece of any transcript.
 */
const MIN_CLAIM_MATCH = 15;

/**
 * Whether a sentence is one of the claims braintrust holds for this person, checked by
 * normalised span in either direction. A count, like everything here — no model call.
 */
function heldClaimFor(
  sentence: string,
  held: { statement: string }[],
): { statement: string } | undefined {
  const s = normaliseForCompare(sentence);
  if (s.length < MIN_CLAIM_MATCH) return undefined;
  return held.find((claim) => {
    const t = normaliseForCompare(claim.statement);
    return (t.includes(s) || s.includes(t)) && Math.min(s.length, t.length) >= MIN_CLAIM_MATCH;
  });
}

/**
 * The verdict for a verified Position: it is a real claim braintrust holds, so it is
 * `sourced` — with the detail saying what it was actually verified against, because the
 * reader of the verdict must not mistake a Position for a quotation from an Item.
 */
function verifiedAsPosition(sentence: string, statement: string): SentenceVerdict {
  return {
    sentence,
    verdict: 'sourced',
    detail:
      `This is a Position braintrust holds for the person — a claim synthesised across ` +
      `many items, so it is verified against what a Position is, not as a quotation from ` +
      `any single item: "${statement.slice(0, 80)}"`,
  };
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

type ItemRow = {
  id: string;
  title: string | null;
  url: string;
  published_at: Date | null;
  body_text: string | null;
};

/**
 * Finds an item belonging to this person by URL, or by title if the URL did not
 * match. A title match is a fallback: the client may know the item by its title
 * rather than by its full URL.
 */
async function lookupItem(db: Db, person: string, reference: string): Promise<ItemRow | undefined> {
  const { rows: urlRows } = await db.query<ItemRow>(
    `select it.id, it.title, it.url, it.published_at, it.body_text
       from braintrust_items it
       join braintrust_sources s on s.id = it.source_id
       join braintrust_people p on p.id = s.person_id
      where p.slug = $1 and it.url = $2
      limit 1`,
    [person, reference],
  );
  if (urlRows.length > 0) return urlRows[0];

  const { rows: titleRows } = await db.query<ItemRow>(
    `select it.id, it.title, it.url, it.published_at, it.body_text
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

/** Whitespace and case are the noise a transcript carries; nothing else is normalised. */
function normaliseForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The comparable form of a record value: surrounding quotes and ellipsis off, trailing
 * sentence punctuation off — the same tolerance braintrust's own record handover is judged
 * by (see `isItemTitle` in the receipt assertion). `*Title:* "Speed versus skill,"` must
 * read the same as the stored title, and a URL line must not be convicted for a period a
 * sentence would carry.
 */
function bareRecordValue(text: string): string {
  return normaliseForCompare(spanFor(text)).replace(/[),.;:!?]+$/, '');
}

/** A URL whose scheme, `www.` and trailing slash all add nothing. */
function comparableUrl(url: string): string {
  return normaliseForCompare(url)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/** The date part of a date or ISO string, or null when there is none. */
function dateOf(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // `toISOString` would shift a `date` column by a day in any timezone east of UTC; the
    // stored value is the calendar date, so read it back through the local getters.
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }
  const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

/** A span with the label's markdown and any surrounding quotes/ellipsis taken off. */
function spanFor(text: string): string {
  return text.replace(/^[“"'`]+/, '').replace(/[”"'`…]+$/, '').trim();
}

/** Whether a span is in the body, transcript-noise-tolerant. */
function bodyContains(body: string, span: string): boolean {
  const b = normaliseForCompare(body);
  const s = normaliseForCompare(spanFor(span));
  return s.length > 0 && b.includes(s);
}

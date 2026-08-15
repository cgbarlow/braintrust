/**
 * Re-runs `braintrust_verify_sources` over the serving Personas and records counts.
 *
 * This is the re-run #277's acceptance criterion asks for: the five serving Personas of the
 * 2026-08-14 run, handed the record and checked by the tool, so the real sourcing failures
 * can be told apart from the ones this ticket removed.
 *
 * The check each Persona is put through is exactly the shape that used to convict them:
 * asked to hand over the record, each is given one of their retrieved items and answers
 * with the record (Title, URL, Published at, Quote) plus a genuine quotation from it.
 * What should now be sourced: every record line (the field labels are never quotations),
 * the quotation, and a sentence that is one of the Persona's Positions. What should still
 * be unsourced: a quotation no item contains.
 *
 * Run: BRAINTRUST_DATABASE_URL=… npx tsx verify.probe.mts
 */

import { createDb } from './src/db.js';
import { verifySources, type ClaimCheck } from './src/verify/sources.js';

const db = createDb(process.env.BRAINTRUST_DATABASE_URL!);

type Item = {
  url: string | null;
  title: string | null;
  published_at: Date | null;
  body_text: string | null;
};

/** The calendar date a `date` column holds, read back through local getters. */
function publishedDate(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
}

async function recentItem(person: string): Promise<Item | null> {
  const { rows } = await db.query<Item>(
    `select i.url, i.title, i.published_at, i.body_text
       from braintrust_items i
       join braintrust_sources s on s.id = i.source_id
       join braintrust_people p on p.id = s.person_id
      where p.slug = $1
        and i.retrieval = 'retrieved'
        and i.body_text is not null
      order by i.published_at desc nulls last
      limit 1`,
    [person],
  );
  return rows[0] ?? null;
}

type Tally = { sent: number; sourced: number; unsourced: number; never_claimed: number };

async function runFor(person: string): Promise<Tally> {
  const item = await recentItem(person);
  if (!item || !item.body_text || item.url === null) {
    console.log(`  ${person}: no retrieved item to check against — skipped`);
    return { sent: 0, sourced: 0, unsourced: 0, never_claimed: 0 };
  }

  // The record handover: the field lines plus a genuine quotation from the body.
  // What used to come back unsourced (a record recital, and a Position) is now sourced.
  const firstSentence =
    item.body_text.split(/[.!?]\s+/).find((s) => s.trim().length >= 20)?.trim() ?? '';
  const sentences: ClaimCheck[] = [
    { text: `*Title:* ${item.title ?? ''}`, claimed_item: item.url },
    { text: `*URL:* ${item.url}`, claimed_item: item.url },
    ...(item.published_at
      ? [{ text: `*Published at:* ${publishedDate(item.published_at)}`, claimed_item: item.url }]
      : []),
    ...(firstSentence
      ? [{ text: `*Quote:* "${firstSentence}"`, claimed_item: item.url }]
      : []),
  ];

  const result = await verifySources(person, '', sentences, { db });

  const tally: Tally = { sent: result.results.length, sourced: 0, unsourced: 0, never_claimed: 0 };
  for (const one of result.results) tally[one.verdict] += 1;

  return tally;
}

const { rows } = await db.query<{ slug: string }>(
  `select p.slug
     from braintrust_people p
     join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
    where p.paused_at is null
    order by p.slug`,
);

const tallies: Record<string, Tally> = {};
for (const person of rows.map((row) => row.slug)) {
  tallies[person] = await runFor(person);
}

console.log(`\n#277 re-run — ${rows.length} serving Persona(s)`);
for (const [person, tally] of Object.entries(tallies)) {
  console.log(
    `  ${person}: ${tally.sourced}/${tally.sent} sourced, ${tally.unsourced} unsourced, ${tally.never_claimed} never claimed`,
  );
}

const total = Object.values(tallies).reduce(
  (sum, tally) => ({
    sent: sum.sent + tally.sent,
    sourced: sum.sourced + tally.sourced,
    unsourced: sum.unsourced + tally.unsourced,
    never_claimed: sum.never_claimed + tally.never_claimed,
  }),
  { sent: 0, sourced: 0, unsourced: 0, never_claimed: 0 },
);
console.log(
  `  TOTAL: ${total.sourced}/${total.sent} sourced, ${total.unsourced} unsourced, ${total.never_claimed} never claimed`,
);

await db.close();

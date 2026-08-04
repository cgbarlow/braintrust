/**
 * #145 probe: does a menu of argument habits keep five real people distinguishable?
 *
 * Runs the actual synthesiser (gpt-oss-120b, the one that compiles today) against the actual
 * notes braintrust recorded for five followed people, but with the job changed: instead of
 * writing prose about how they argue, it may only *select* from an authored menu.
 *
 * What this is testing, in order of how much it matters:
 *   1. Do the five come out different from each other, or does everyone match the same four?
 *   2. Does the thin case stay honestly thin? (chris-barlow: 5 items)
 *   3. Does the rich case stay legible? (nate-b-jones: 516 items, 9 with notes in this window)
 *   4. Is anything on the menu a dead entry nobody ever matches?
 *
 * Run: npx tsx menu.probe.mts
 */

import { readFileSync } from 'node:fs';
import { MENU, renderHowTheyArgue } from './menu.js';

const BASE = 'https://api.agentics.org.nz/v1';
const KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY!;
const MODEL = 'unsloth/gpt-oss-120b-GGUF';

const PEOPLE = [
  'chris-barlow',
  'ethan-mollick',
  'matt-pocock',
  'nate-b-jones',
  'stuart-winter-tear',
];

type Item = { title: string; published_at: string; note?: { argument?: string } };

const PROMPT = [
  "You are reading braintrust's own notes on many published items by one author — for each item,",
  'how the argument runs. No single item states how this person thinks. Recognising that across',
  'all of them is the job.',
  '',
  'You are NOT writing a description. You are choosing from a fixed menu, below. You may only',
  'return slugs that appear in it. Anything else is discarded.',
  '',
  'Return a single JSON object and nothing else:',
  '{ "habits": [ { "slug": "...", "items": [1, 4, 7] } ] }',
  '  slug  — copied exactly from the menu.',
  '  items — the numbers of the items the habit is visible in, from the list below.',
  '',
  'Choose only habits that are characteristic of this person across several items. A habit',
  '  visible once is a thing that happened, not a way of arguing. Leave it out.',
  'Do not fill a quota. Returning three habits that are really there beats returning eight',
  '  that are partly hoped for. Returning none is a valid answer.',
  'Do not choose on subject matter. Two people writing about the same field argue differently,',
  '  and that difference is the only thing here worth having.',
  '',
  'THE MENU',
  ...MENU.map((h) => `- ${h.slug}: ${h.test}`),
].join('\n');

async function classify(person: string): Promise<{ slug: string; items: number[] }[]> {
  const items: Item[] = JSON.parse(
    readFileSync(new URL(`./items-${person}.json`, import.meta.url), 'utf8'),
  );
  const withNotes = items.filter((i) => i.note?.argument);
  const notes = withNotes
    .map((i, n) => `[${n + 1}] ${i.title} (${i.published_at})\n${i.note!.argument}`)
    .join('\n\n');

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: `THE NOTES (${withNotes.length} items)\n\n${notes}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${person}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(body.choices[0].message.content) as {
    habits?: { slug: string; items: number[] }[];
  };
  const valid = new Set(MENU.map((h) => h.slug));
  // The hard check, in miniature: anything off-menu is dropped rather than rendered.
  return (parsed.habits ?? []).filter((h) => valid.has(h.slug));
}

const results = new Map<string, { slug: string; items: number[] }[]>();
for (const person of PEOPLE) {
  const habits = await classify(person);
  results.set(person, habits);
  console.log(`\n${'='.repeat(74)}\n${person}\n${'='.repeat(74)}`);
  console.log(renderHowTheyArgue(habits.map((h) => h.slug)) || '(nothing matched)');
  console.log(
    '\n  traced: ' + habits.map((h) => `${h.slug}=${h.items.length}`).join('  ') || '  —',
  );
}

// ── Are they actually distinguishable? ────────────────────────────────────────
console.log(`\n${'='.repeat(74)}\nOVERLAP\n${'='.repeat(74)}\n`);
for (const a of PEOPLE) {
  for (const b of PEOPLE) {
    if (a >= b) continue;
    const A = new Set(results.get(a)!.map((h) => h.slug));
    const B = new Set(results.get(b)!.map((h) => h.slug));
    const shared = [...A].filter((s) => B.has(s));
    const union = new Set([...A, ...B]).size;
    const jaccard = union === 0 ? 0 : shared.length / union;
    console.log(
      `${a.padEnd(20)} ${b.padEnd(20)} shared ${String(shared.length).padStart(2)}/${String(union).padStart(2)}` +
        `  (${(jaccard * 100).toFixed(0)}%)  ${shared.join(', ') || '—'}`,
    );
  }
}

console.log(`\n${'='.repeat(74)}\nMENU COVERAGE\n${'='.repeat(74)}\n`);
const used = new Map<string, string[]>();
for (const [person, habits] of results)
  for (const h of habits) used.set(h.slug, [...(used.get(h.slug) ?? []), person]);
for (const h of MENU) {
  const who = used.get(h.slug) ?? [];
  const mark = who.length === 0 ? 'DEAD ' : who.length >= 4 ? 'BROAD' : '     ';
  console.log(`${mark} ${h.slug.padEnd(34)} ${who.length}  ${who.join(', ')}`);
}

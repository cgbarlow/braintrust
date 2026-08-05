/**
 * #145 probe, part two: does repeated asking make habit selection hold still?
 *
 * menu.probe.mts showed the single-ask version disagreeing with itself — same notes, same
 * model, temperature 0, ~39% agreement between two runs. This tests the fix chosen on the
 * ticket: ask N times, keep only what a majority of asks return.
 *
 * The measurement that matters is NOT whether one vote looks sensible. It is whether two
 * independent votes agree with each other. A vote that is stable at 5 asks has earned the
 * cost; one that is not has only made the wobble more expensive.
 *
 * Run: npx tsx vote.probe.mts
 */

import { readFileSync } from 'node:fs';
import { MENU, renderHowTheyArgue } from './menu.js';

const BASE = 'https://api.agentics.org.nz/v1';
const KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY!;
const MODEL = 'unsloth/gpt-oss-120b-GGUF';

const ASKS = 3; // asks per vote
const FLOOR = 2; // habit must come back in this many asks to count — a majority of 3
const VOTES = 2; // independent votes, so the votes can be compared to each other

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

function notesFor(person: string): { text: string; count: number } {
  const items: Item[] = JSON.parse(
    readFileSync(new URL(`./items-${person}.json`, import.meta.url), 'utf8'),
  );
  const withNotes = items.filter((i) => i.note?.argument);
  return {
    text: withNotes
      .map((i, n) => `[${n + 1}] ${i.title} (${i.published_at})\n${i.note!.argument}`)
      .join('\n\n'),
    count: withNotes.length,
  };
}

const valid = new Set(MENU.map((h) => h.slug));

async function ask(person: string, seed: number): Promise<string[]> {
  const { text, count } = notesFor(person);
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      seed,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: `THE NOTES (${count} items)\n\n${text}` },
      ],
    }),
  });
  if (res.status === 429) {
    // The endpoint rate-limits concurrent asks. Back off and retry rather than losing the ask,
    // because a dropped ask silently changes the denominator the vote is counted against.
    await new Promise((r) => setTimeout(r, 20_000));
    return ask(person, seed);
  }
  if (!res.ok) throw new Error(`${person} seed ${seed}: ${res.status}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(body.choices[0].message.content) as { habits?: { slug: string }[] };
  return [...new Set((parsed.habits ?? []).map((h) => h.slug).filter((s) => valid.has(s)))];
}

/** One vote: ASKS asks, keep slugs returned by at least FLOOR of them. */
async function vote(person: string, offset: number) {
  const asks: string[][] = [];
  for (let i = 0; i < ASKS; i++) asks.push(await ask(person, offset * 100 + i));
  const tally = new Map<string, number>();
  for (const a of asks) for (const s of a) tally.set(s, (tally.get(s) ?? 0) + 1);
  const kept = [...tally.entries()]
    .filter(([, n]) => n >= FLOOR)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => ({ slug: s, votes: n }));
  return { kept, tally, spread: asks.map((a) => a.length) };
}

const jaccard = (a: string[], b: string[]) => {
  const A = new Set(a);
  const B = new Set(b);
  const shared = [...A].filter((s) => B.has(s)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : shared / union;
};

const byPerson = new Map<string, { kept: string[]; votes: number }[][]>();

for (let v = 0; v < VOTES; v++) {
  console.log(`\n${'#'.repeat(74)}\n# VOTE ${v + 1}  (${ASKS} asks, keep at >=${FLOOR})\n${'#'.repeat(74)}`);
  for (const person of PEOPLE) {
    const { kept, tally, spread } = await vote(person, v + 1);
    const prev = byPerson.get(person) ?? [];
    byPerson.set(person, [...prev, kept as any]);
    console.log(`\n${'='.repeat(70)}\n${person}   asks returned ${spread.join('/')} habits\n${'='.repeat(70)}`);
    console.log(renderHowTheyArgue(kept.map((k) => k.slug)) || '(nothing survived the floor)');
    const dropped = [...tally.entries()].filter(([, n]) => n < FLOOR);
    console.log(`\n  kept:    ${kept.map((k) => `${k.slug}(${k.votes}/${ASKS})`).join('  ') || '—'}`);
    console.log(`  dropped: ${dropped.map(([s, n]) => `${s}(${n})`).join('  ') || '—'}`);
  }
}

console.log(`\n${'#'.repeat(74)}\n# DOES THE VOTE HOLD STILL?\n${'#'.repeat(74)}\n`);
let total = 0;
for (const person of PEOPLE) {
  const [a, b] = byPerson.get(person)!.map((k: any) => k.map((x: any) => x.slug));
  const j = jaccard(a, b);
  total += j;
  const onlyA = a.filter((s: string) => !b.includes(s));
  const onlyB = b.filter((s: string) => !a.includes(s));
  console.log(
    `${person.padEnd(20)} ${(j * 100).toFixed(0).padStart(3)}%  ` +
      `vote1=${a.length} vote2=${b.length}` +
      (onlyA.length || onlyB.length ? `   differs: ${[...onlyA, ...onlyB].join(', ')}` : '   identical'),
  );
}
console.log(`\nmean agreement between two votes: ${((total / PEOPLE.length) * 100).toFixed(0)}%`);
console.log(`(single ask, measured earlier: ~39%)`);

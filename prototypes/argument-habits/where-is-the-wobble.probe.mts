/**
 * #147 probe: where does the instability actually live?
 *
 * #145 measured the wobble but could not locate it. Three candidates were written on the ticket,
 * and they want different fixes:
 *
 *   (a) the menu entries are worded too abstractly to match against reliably
 *   (b) the `argument` note is too compressed to carry a reasoning habit at all
 *   (c) a 23-way free choice is beyond this synthesiser, and selection should be per entry
 *
 * Two arms separate them, run against the same notes as #145, same model.
 *
 *   FORCED — the same menu, but the model must return a yes/no verdict for every entry.
 *            No free recall, no quota pressure, no picking a handful out of 23.
 *   FREE   — no menu at all. Describe how this person argues, in your own words.
 *            This is the ceiling: how stable is the *reading*, before any labelling?
 *
 * Reading the result:
 *   FORCED stable                  -> (c). The width of the free choice was the problem.
 *   FORCED unstable, FREE stable   -> (a). The reading holds; the menu loses it.
 *   both unstable                  -> (b). The notes, or this model on them, cannot see a habit.
 *
 * FORCED also reports a yes-rate. If it says yes to nearly everything, the entries' tests are
 * too loose to discriminate regardless of stability — that is (a) wearing a different hat.
 *
 * Run: npx tsx where-is-the-wobble.probe.mts
 */

import { readFileSync } from 'node:fs';
import { MENU } from './menu.js';

const BASE = 'https://api.agentics.org.nz/v1';
const KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY!;
const MODEL = 'unsloth/gpt-oss-120b-GGUF';

const RUNS = 2; // two independent runs, so the runs can be compared to each other

const PEOPLE = [
  'chris-barlow',
  'ethan-mollick',
  'matt-pocock',
  'nate-b-jones',
  'stuart-winter-tear',
];

// Ruled off the menu on #145 for describing the explainer genre rather than anyone in it.
// Kept in the ask so the numbers stay comparable, reported separately.
const GENRE = new Set(['builds-a-named-frame', 'opens-on-the-mistaken-instinct']);

type Item = { title: string; published_at: string; note?: { argument?: string } };

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

async function call(system: string, user: string, seed: number): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      seed,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (res.status === 429) {
    // Serialised already; the endpoint still throttles. Retrying rather than dropping, because a
    // dropped call silently changes what the run is being compared against.
    await new Promise((r) => setTimeout(r, 20_000));
    return call(system, user, seed);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0].message.content;
}

function json<T>(raw: string): T {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in: ${raw.slice(0, 200)}`);
  return JSON.parse(m[0]) as T;
}

// ── ARM 1: forced enumeration ────────────────────────────────────────────────

const FORCED_SYSTEM = [
  "You are reading braintrust's own notes on many published items by one author — for each item,",
  'how the argument runs. No single item states how this person thinks. Recognising that across',
  'all of them is the job.',
  '',
  'Below is a fixed list of argument habits. For EVERY habit in the list, in the order given,',
  'decide whether it is characteristic of this person across several items.',
  '',
  'Return a single JSON object and nothing else:',
  '{ "verdicts": [ { "slug": "...", "yes": true, "items": [1, 4] } ] }',
  '  One entry per habit in the list. All of them. Same order.',
  '  yes   — true only if the habit is characteristic across several items. A habit visible',
  '          once is a thing that happened, not a way of arguing: that is false.',
  '  items — the item numbers it is visible in. Empty when yes is false.',
  '',
  'Do not fill a quota, in either direction. Judge each habit on its own.',
  'Do not judge on subject matter. Two people writing about the same field argue differently,',
  'and that difference is the only thing here worth having.',
  '',
  'THE HABITS',
  ...MENU.map((h) => `- ${h.slug}: ${h.test}`),
].join('\n');

const validSlug = new Set(MENU.map((h) => h.slug));

async function forced(person: string, seed: number): Promise<{ yes: string[]; answered: number }> {
  const { text, count } = notesFor(person);
  const raw = await call(FORCED_SYSTEM, `THE NOTES (${count} items)\n\n${text}`, seed);
  const parsed = json<{ verdicts?: { slug: string; yes: boolean }[] }>(raw);
  const verdicts = (parsed.verdicts ?? []).filter((v) => validSlug.has(v.slug));
  return {
    yes: [...new Set(verdicts.filter((v) => v.yes).map((v) => v.slug))],
    answered: new Set(verdicts.map((v) => v.slug)).size,
  };
}

// ── ARM 2: free description, no menu ─────────────────────────────────────────

const FREE_SYSTEM = [
  "You are reading braintrust's own notes on many published items by one author — for each item,",
  'how the argument runs. No single item states how this person thinks. Recognising that across',
  'all of them is the job.',
  '',
  'Name the moves this person makes when they argue: how they open, how they get from a premise',
  'to a conclusion, what kind of evidence moves them, how they handle opposition, how they close.',
  '',
  'Return a single JSON object and nothing else:',
  '{ "habits": [ { "move": "...", "why": "..." } ] }',
  '  move — the move in a few words. Name the move, not the topic.',
  '  why  — one sentence on how it shows up across the items.',
  '',
  'Only moves that are characteristic across several items. Do not fill a quota; returning three',
  'that are really there beats eight that are partly hoped for. Returning none is a valid answer.',
  'Do not describe subject matter. Two people writing about the same field argue differently, and',
  'that difference is the only thing here worth having.',
].join('\n');

async function free(person: string, seed: number): Promise<{ move: string; why: string }[]> {
  const { text, count } = notesFor(person);
  const raw = await call(FREE_SYSTEM, `THE NOTES (${count} items)\n\n${text}`, seed);
  return json<{ habits?: { move: string; why: string }[] }>(raw).habits ?? [];
}

// A judge, because free text cannot be set-compared. It is told to be strict, and every pairing
// it makes is printed, so its work is checkable by eye rather than taken on trust.
const JUDGE_SYSTEM = [
  'Two readers independently described how the same author argues. They used their own words.',
  'Decide which of their descriptions name the SAME move.',
  '',
  'Return a single JSON object and nothing else:',
  '{ "same": [ { "a": 1, "b": 3, "move": "..." } ] }',
  '  Each pair is one move both readers named. Use the numbers given.',
  '  Pair only genuine matches: the same move, described differently. Two moves that merely sit',
  '  in the same part of an argument, or share a subject, are NOT a match.',
  '  Each number may appear at most once. Omit anything unmatched.',
].join('\n');

async function judge(
  a: { move: string; why: string }[],
  b: { move: string; why: string }[],
  seed: number,
): Promise<{ a: number; b: number; move: string }[]> {
  if (a.length === 0 || b.length === 0) return [];
  const list = (xs: typeof a) => xs.map((x, n) => `${n + 1}. ${x.move} — ${x.why}`).join('\n');
  const raw = await call(JUDGE_SYSTEM, `READER A\n${list(a)}\n\nREADER B\n${list(b)}`, seed);
  return json<{ same?: { a: number; b: number; move: string }[] }>(raw).same ?? [];
}

// ── run ──────────────────────────────────────────────────────────────────────

const jaccard = (shared: number, a: number, b: number) =>
  a + b - shared === 0 ? 1 : shared / (a + b - shared);

const pct = (n: number) => `${(n * 100).toFixed(0)}%`.padStart(4);

console.log(`${'#'.repeat(78)}\n# ARM 1 — FORCED: verdict on every entry, ${RUNS} independent runs\n${'#'.repeat(78)}`);

const forcedRuns = new Map<string, string[][]>();
for (const person of PEOPLE) {
  const runs: string[][] = [];
  for (let r = 0; r < RUNS; r++) {
    const { yes, answered } = await forced(person, 900 + r);
    runs.push(yes);
    console.log(
      `\n${person}  run ${r + 1}: ${yes.length} yes of ${answered} answered (menu is ${MENU.length})`,
    );
    console.log(`  ${yes.join('  ') || '—'}`);
  }
  forcedRuns.set(person, runs);
}

console.log(`\n${'#'.repeat(78)}\n# ARM 2 — FREE: no menu, own words, ${RUNS} independent runs\n${'#'.repeat(78)}`);

const freeRuns = new Map<string, { move: string; why: string }[][]>();
for (const person of PEOPLE) {
  const runs: { move: string; why: string }[][] = [];
  for (let r = 0; r < RUNS; r++) {
    const habits = await free(person, 900 + r);
    runs.push(habits);
    console.log(`\n${person}  run ${r + 1}: ${habits.length} moves`);
    for (const h of habits) console.log(`  - ${h.move} — ${h.why}`);
  }
  freeRuns.set(person, runs);
}

console.log(`\n${'#'.repeat(78)}\n# AGREEMENT BETWEEN THE TWO RUNS\n${'#'.repeat(78)}\n`);
console.log('person                forced  forced*   free   (forced* = genre entries removed)');

let fT = 0;
let fST = 0;
let frT = 0;
for (const person of PEOPLE) {
  const [a, b] = forcedRuns.get(person)!;
  const shared = a.filter((s) => b.includes(s));
  const f = jaccard(shared.length, a.length, b.length);

  const a2 = a.filter((s) => !GENRE.has(s));
  const b2 = b.filter((s) => !GENRE.has(s));
  const fs = jaccard(a2.filter((s) => b2.includes(s)).length, a2.length, b2.length);

  const [x, y] = freeRuns.get(person)!;
  const pairs = await judge(x, y, 900);
  const fr = jaccard(pairs.length, x.length, y.length);

  fT += f;
  fST += fs;
  frT += fr;
  console.log(
    `${person.padEnd(20)} ${pct(f)}    ${pct(fs)}   ${pct(fr)}   ` +
      `forced ${a.length}/${b.length}, free ${x.length}/${y.length} matched ${pairs.length}`,
  );
  for (const p of pairs) console.log(`      matched: ${p.move}`);
}

const n = PEOPLE.length;
console.log(
  `\nmean            ${pct(fT / n)}    ${pct(fST / n)}   ${pct(frT / n)}` +
    `\n\n#145 for comparison: free choice from the menu, single ask, 39%; 3-ask majority, 54%;` +
    `\n                      3-ask majority with the genre entries cut, 37%.`,
);

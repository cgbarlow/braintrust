/**
 * #152 probe: does asking twice and keeping the agreement hold the style block still?
 *
 * The churn #148 recorded — 8 lines one run, 3 the next — decomposes, from #148's own cached
 * replies, into something the ticket did not assume. The model's *verdict* is stable: 98 of 115
 * line-judgements agree across two seeds (85%), 86 yes-lines against 87. What moves is the number
 * of items it cites for a line it called characteristic both times, by ~1.4 on average — and the
 * three-item floor sits on the fattest part of that distribution (100 of 173 yes-lines cite two or
 * three), so a jitter of one flips lines in and out. Ship-status changes at floor 3: 35. At floor
 * 2: 17. At floor 4: 19. Three is the worst number available.
 *
 * Lowering the floor buys stability by shipping nearly the whole menu for everyone. So the option
 * worth pricing is the other one: ask twice in the same compile and ship only what both runs agree
 * on. This measures whether that actually holds still, rather than assuming intersection is stable
 * because agreement is high — an intersection of two noisy draws is itself a draw.
 *
 *   PAIR-1 = seeds 700, 701 (already cached by #148's probe, reused here)
 *   PAIR-2 = seeds 702, 703 (bought here)
 *
 * The measurement is lines changing ship-status between PAIR-1's agreement set and PAIR-2's, against
 * the 35 that change between two single runs. Same ask, same notes, same model, same floor — the
 * only thing varying is whether one draw decides or two must agree.
 *
 * Run: export HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY=... && npx tsx agreement.probe.mts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MENU } from '../argument-habits/menu.js';

const BASE = 'https://api.agentics.org.nz/v1';
const KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY!;
const MODEL = 'unsloth/gpt-oss-120b-GGUF';
const FLOOR = 3;

const PEOPLE = ['chris-barlow', 'ethan-mollick', 'matt-pocock', 'nate-b-jones', 'stuart-winter-tear'];
const PAIR_1 = [700, 701];
const PAIR_2 = [702, 703];

type Item = { title: string; published_at: string; note?: { argument?: string } };
type Note = { n: number; title: string; published_at: string; argument: string };

function notesFor(person: string): Note[] {
  const items: Item[] = JSON.parse(
    readFileSync(new URL(`../argument-habits/items-${person}.json`, import.meta.url), 'utf8'),
  );
  return items
    .filter((i) => i.note?.argument)
    .map((i, n) => ({ n: n + 1, title: i.title, published_at: i.published_at, argument: i.note!.argument }));
}

const render = (notes: Note[]) =>
  notes.map((i) => `[${i.n}] ${i.title} (${i.published_at})\n${i.argument}`).join('\n\n');

// Replies are the measurement; #148's probe learned that the hard way. #148's own cache is read
// first so PAIR-1 costs nothing and is byte-identical to what the last ticket measured.
const CACHE = new URL('./cache/', import.meta.url);
const CACHE_148 = new URL('../three-item-floor/cache/', import.meta.url);
mkdirSync(CACHE, { recursive: true });

async function cached(key: string, fetcher: () => Promise<string>): Promise<string> {
  for (const dir of [CACHE, CACHE_148]) {
    const f = new URL(`${key}.txt`, dir);
    if (existsSync(f)) return readFileSync(f, 'utf8');
  }
  const value = await fetcher();
  writeFileSync(new URL(`${key}.txt`, CACHE), value);
  return value;
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
    await new Promise((r) => setTimeout(r, 20_000));
    return call(system, user, seed);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0].message.content;
}

// Byte-identical to #148's ask. Changing it would measure a different question.
const SYSTEM = [
  "You are reading braintrust's own notes on many published items by one author — for each item,",
  'how the argument runs. No single item states how this person thinks. Recognising that across',
  'all of them is the job.',
  '',
  'Below is a fixed list of style lines. For EVERY line in the list, in the order given, decide',
  'whether it is characteristic of this person, and name the items it is visible in.',
  '',
  'Return a single JSON object and nothing else:',
  '{ "verdicts": [ { "slug": "...", "yes": true, "items": [1, 4] } ] }',
  '  One entry per line in the list. All of them. Same order.',
  '  yes   — true only if the line is characteristic of this person.',
  '  items — every item number the line is actually visible in. This is the evidence for the',
  '          verdict, not a sample of it: list all of them, and list only the ones where a reader',
  '          shown that item alone would agree the line describes it. Empty when yes is false.',
  '',
  'Do not fill a quota, in either direction. Judge each line on its own, and let the items decide.',
  'Do not judge on subject matter. Two people writing about the same field argue differently, and',
  'that difference is the only thing here worth having.',
  '',
  'THE LINES',
  ...MENU.map((h) => `- ${h.slug}: ${h.test}`),
].join('\n');

const validSlug = new Set(MENU.map((h) => h.slug));

type Run = Map<string, { yes: boolean; items: number[] }>;

async function ask(person: string, notes: Note[], seed: number): Promise<Run> {
  const raw = await cached(`${person}-s${seed}-drop0`, () =>
    call(SYSTEM, `THE NOTES (${notes.length} items)\n\n${render(notes)}`, seed),
  );
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON for ${person} s${seed}`);
  const parsed = JSON.parse(m[0]) as { verdicts?: { slug: string; yes?: boolean; items?: number[] }[] };
  const legal = new Set(notes.map((i) => i.n));
  const run: Run = new Map();
  for (const v of parsed.verdicts ?? []) {
    if (!validSlug.has(v.slug) || run.has(v.slug)) continue;
    const items = [...new Set(v.items ?? [])].filter((n) => legal.has(n));
    run.set(v.slug, { yes: v.yes === true, items });
  }
  return run;
}

const ships = (r: Run, slug: string) => {
  const v = r.get(slug);
  return !!(v && v.yes && v.items.length >= FLOOR);
};

/** One draw decides. */
const single = (r: Run) => new Set([...validSlug].filter((s) => ships(r, s)));

/**
 * Two draws must agree. A line ships only if both runs called it characteristic AND both cleared
 * the floor — the strict reading, because the point is to stop a line appearing on the strength of
 * one noisy count.
 */
const agreed = (a: Run, b: Run) => new Set([...validSlug].filter((s) => ships(a, s) && ships(b, s)));

const diff = (x: Set<string>, y: Set<string>) =>
  [...validSlug].filter((s) => x.has(s) !== y.has(s)).length;

const rows: string[] = [];
let singleMoved = 0, agreedMoved = 0, singleSize = 0, agreedSize = 0;

for (const person of PEOPLE) {
  const notes = notesFor(person);
  const [a1, b1] = [await ask(person, notes, PAIR_1[0]), await ask(person, notes, PAIR_1[1])];
  const [a2, b2] = [await ask(person, notes, PAIR_2[0]), await ask(person, notes, PAIR_2[1])];

  // Single-draw movement: first run of each pair, so the two arms are compared over the same
  // amount of independent sampling rather than one arm getting a head start.
  const sMoved = diff(single(a1), single(a2));
  const aMoved = diff(agreed(a1, b1), agreed(a2, b2));
  const s1 = single(a1).size, s2 = single(a2).size;
  const g1 = agreed(a1, b1).size, g2 = agreed(a2, b2).size;

  singleMoved += sMoved; agreedMoved += aMoved;
  singleSize += g1; agreedSize += g2;
  rows.push(
    `${person.padEnd(20)} one draw: ${String(s1).padStart(2)} -> ${String(s2).padStart(2)}  (${sMoved} moved)` +
    `   |  two must agree: ${String(g1).padStart(2)} -> ${String(g2).padStart(2)}  (${aMoved} moved)`,
  );
  console.log(rows[rows.length - 1]);
}

console.log('');
console.log(`ONE DRAW      lines changing status across a rebuild: ${singleMoved} of 115`);
console.log(`TWO MUST AGREE                                      : ${agreedMoved} of 115`);
console.log(`block size under two-must-agree, second pair: ${agreedSize} lines across five people`);

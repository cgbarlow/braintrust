/**
 * #148 follow-up: when two style lines claim the same evidence, can the compile just ship one?
 *
 * The resolution said no — drop both — on the grounds that a survivor rule would pick the wrong twin
 * about half the time. That was never measured. One group was read by hand, and in that group the
 * model emitted both twins; it was never asked to choose. "Half the time" was an extrapolation, and
 * it was expensive: dropping both costs Chris 4 of his 8 lines.
 *
 * So ask the question that rule would actually ask. It is far narrower than the one that produced
 * the twins — not a 23-way verdict over a whole corpus, but: here are the notes these lines both
 * point at, and here are the lines; which one describes them? #147 measured that narrowing the ask
 * helps a lot (free description 70% agreement against 39% for menu choice), so there is reason to
 * think this holds still even though the wide ask does not.
 *
 * The test is stability, because that is what a shipping rule needs:
 *
 *   same winner every seed   -> the tie-break is a real decision, ship one
 *   winner moves across seeds -> it is a coin flip wearing a justification, drop both
 *
 * Stability is necessary, not sufficient — a stably wrong answer is still wrong — so every choice is
 * printed with the notes it was made from, to be read by hand the way the twins themselves were.
 * "none" is offered explicitly, because two lines resting on evidence that supports neither is a
 * live possibility and a forced choice would hide it.
 *
 * Run: export HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY=... && npx tsx tiebreak.probe.mts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MENU } from '../argument-habits/menu.js';

const BASE = 'https://api.agentics.org.nz/v1';
const KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY!;
const MODEL = 'unsloth/gpt-oss-120b-GGUF';

const FLOOR = 3;
const SOURCE_SEED = 700; // the base run whose twins are being broken
const SEEDS = [810, 811, 812]; // three independent tie-breaks per group

const PEOPLE = [
  'chris-barlow',
  'ethan-mollick',
  'matt-pocock',
  'nate-b-jones',
  'stuart-winter-tear',
];

const CACHE = new URL('./cache/', import.meta.url);
mkdirSync(CACHE, { recursive: true });

const validSlug = new Set(MENU.map((h) => h.slug));
const testFor = new Map(MENU.map((h) => [h.slug, h.test]));

type Item = { title: string; published_at: string; note?: { argument?: string } };
type Note = { n: number; title: string; published_at: string; argument: string };

function notesFor(person: string): Note[] {
  const items: Item[] = JSON.parse(
    readFileSync(new URL(`../argument-habits/items-${person}.json`, import.meta.url), 'utf8'),
  );
  return items
    .filter((i) => i.note?.argument)
    .map((i, n) => ({
      n: n + 1,
      title: i.title,
      published_at: i.published_at,
      argument: i.note!.argument,
    }));
}

/** The twin groups from the base run: lines that cleared the floor citing an identical item set. */
function twinGroups(person: string) {
  const raw = readFileSync(
    new URL(`./cache/${person}-s${SOURCE_SEED}-drop0.txt`, import.meta.url),
    'utf8',
  );
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)![0]) as {
    verdicts?: { slug: string; yes?: boolean; items?: number[] }[];
  };
  const seen = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const v of parsed.verdicts ?? []) {
    if (!validSlug.has(v.slug) || seen.has(v.slug) || v.yes !== true) continue;
    seen.add(v.slug);
    const items = [...new Set(v.items ?? [])].sort((a, b) => a - b);
    if (items.length < FLOOR) continue;
    const key = items.join(',');
    groups.set(key, [...(groups.get(key) ?? []), v.slug]);
  }
  return [...groups.entries()]
    .filter(([, slugs]) => slugs.length > 1)
    .map(([key, slugs]) => ({ items: key.split(',').map(Number), slugs }));
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

async function cached(key: string, fetcher: () => Promise<string>): Promise<string> {
  const file = new URL(`${key}.txt`, CACHE);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const value = await fetcher();
  writeFileSync(file, value);
  return value;
}

const SYSTEM = [
  'Below are notes on a few published items by one author — for each item, how the argument runs.',
  '',
  'Several candidate descriptions of how this author argues all claim to be visible in exactly',
  'these items. At most one of them is the best description of what these items actually do.',
  '',
  'Return a single JSON object and nothing else:',
  '{ "winner": "...", "why": "..." }',
  '  winner — the slug of the one description these items really show, or "none".',
  '  why    — one sentence, pointing at what in the items decides it.',
  '',
  'Answer "none" if the items do not clearly show any of them, or if two are so alike that the',
  'items cannot separate them. Do not pick one merely to have picked.',
].join('\n');

type Choice = { winner: string; why: string };

async function tiebreak(
  person: string,
  group: { items: number[]; slugs: string[] },
  notes: Note[],
  seed: number,
): Promise<Choice> {
  const cited = notes.filter((i) => group.items.includes(i.n));
  const user = [
    `THE ITEMS (${cited.length})`,
    '',
    ...cited.map((i) => `[${i.n}] ${i.title} (${i.published_at})\n${i.argument}`),
    '',
    'THE CANDIDATES',
    ...group.slugs.map((s) => `- ${s}: ${testFor.get(s)}`),
  ].join('\n');
  const key = `tiebreak-${person}-${group.items.join('.')}-s${seed}`;
  const raw = await cached(key, () => call(SYSTEM, user, seed));
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)![0]) as Partial<Choice>;
  const winner =
    parsed.winner && (group.slugs.includes(parsed.winner) || parsed.winner === 'none')
      ? parsed.winner
      : 'unparseable';
  return { winner, why: parsed.why ?? '' };
}

// ── run ──────────────────────────────────────────────────────────────────────

console.log('Does the tie-break hold still? Same group, three independent seeds.\n');

let groups = 0;
let stable = 0;

for (const person of PEOPLE) {
  const notes = notesFor(person);
  for (const group of twinGroups(person)) {
    groups++;
    const choices: Choice[] = [];
    for (const seed of SEEDS) choices.push(await tiebreak(person, group, notes, seed));

    const winners = choices.map((c) => c.winner);
    const agreed = new Set(winners).size === 1;
    if (agreed) stable++;

    console.log(`${'─'.repeat(78)}`);
    console.log(
      `${person}  —  ${group.slugs.length} lines share items [${group.items.join(',')}]` +
        `   ${agreed ? 'STABLE' : 'MOVES'}`,
    );
    for (const s of group.slugs) console.log(`    candidate  ${s}`);
    for (let i = 0; i < SEEDS.length; i++) {
      console.log(`    seed ${SEEDS[i]}  ->  ${winners[i]}`);
      console.log(`               ${choices[i].why}`);
    }
  }
}

console.log(`\n${'═'.repeat(78)}`);
console.log(`${stable} of ${groups} twin groups picked the same winner on all three seeds.`);
console.log(
  '\nStable is necessary, not sufficient. Read each choice against the notes printed by' +
    '\nfloor.probe.mts arm 3 before treating a winner as correct.',
);

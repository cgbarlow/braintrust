/**
 * #148 probe: does a three-item floor leave anything worth saying, and are the item numbers real?
 *
 * #147 settled that a style line ships for a person only if it can point at three or more items,
 * and that it carries that count. Nothing about that floor has been measured. Two things sink it,
 * and they are separate questions:
 *
 *   YIELD     — with a floor of three, does anything survive? Every number so far was measured
 *               without one. Chris is the thin case: five items, so three of them means a line has
 *               to be in most of everything braintrust has read of him.
 *
 *   GROUNDING — are the numbers citations, or decoration? The model has always returned them and
 *               they have never been checked. If it picks a line first and attaches plausible
 *               numbers afterwards, the floor counts citations produced to satisfy the count, and
 *               it is theatre.
 *
 * GROUNDING is the load-bearing one, and it is answered by hold-out. Take the item a line leans on
 * hardest, remove it from the notes, ask again. A line whose numbers track content loses exactly
 * that citation and keeps the rest. A line whose numbers are decoration churns the same way it
 * churns anyway.
 *
 * That "anyway" is the control, and it is why there are two base runs. Run-to-run churn with
 * nothing removed is the noise floor. The hold-out only means something measured against it:
 *
 *   held-out item drops ~100%, other items churn at the noise floor  ->  the numbers are real
 *   held-out item drops at the noise floor                           ->  theatre
 *
 * Numbering is held stable across the hold-out: the removed item's label is left as a gap rather
 * than closing up, so a citation of [4] means the same item in both runs. The model is not told
 * anything was removed.
 *
 * Arm 3 prints the surviving lines for one person with the full text of every note they cite, so
 * the traces can be read by hand rather than trusted in aggregate — which is what the ticket asks
 * for, and which no amount of the above replaces.
 *
 * Run: export HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY=... && npx tsx floor.probe.mts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MENU } from '../argument-habits/menu.js';

const BASE = 'https://api.agentics.org.nz/v1';
const KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY!;
const MODEL = 'unsloth/gpt-oss-120b-GGUF';

/** The floor under test. */
const FLOOR = 3;

/** Two base seeds so run-to-run churn can be measured; the hold-out reuses the first. */
const SEED_A = 700;
const SEED_B = 701;

const PEOPLE = [
  'chris-barlow',
  'ethan-mollick',
  'matt-pocock',
  'nate-b-jones',
  'stuart-winter-tear',
];

/** Whose traces get printed in full for reading by hand. The thin case. */
const BY_HAND = 'chris-barlow';

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

/** Numbers stay attached to items, so a hold-out leaves a gap rather than shifting every label. */
const render = (notes: Note[]) =>
  notes.map((i) => `[${i.n}] ${i.title} (${i.published_at})\n${i.argument}`).join('\n\n');

/**
 * Every reply is written to disk before it is used, and reused if it is already there.
 *
 * Not an optimisation. A run is ~15 serialised calls against an endpoint that throttles, and the
 * first attempt at this probe died three-quarters of the way through with every reply held only in
 * a print statement. Replies are the measurement; losing them to a broken pipe means re-buying
 * them. Delete the cache directory to genuinely re-measure.
 */
const CACHE = new URL('./cache/', import.meta.url);
mkdirSync(CACHE, { recursive: true });

async function cached(key: string, fetcher: () => Promise<string>): Promise<string> {
  const file = new URL(`${key}.txt`, CACHE);
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const value = await fetcher();
  writeFileSync(file, value);
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

// ── the ask ──────────────────────────────────────────────────────────────────
//
// Deliberately the same forced-verdict ask #147 measured, with one change: the item numbers are
// named as the thing that decides the verdict rather than reported alongside it. That is what the
// floor does in production, so that is what has to be probed. Nothing tells the model a floor
// exists, or that three is a number that matters — a model told the threshold would hit it.

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
const testFor = new Map(MENU.map((h) => [h.slug, h.test]));

type Verdict = { slug: string; yes: boolean; items: number[] };
type Ask = {
  verdicts: Verdict[];
  /** How many of the 23 lines came back at all — a reply cut short answers fewer. */
  answered: number;
  /** Citations pointing at an item number that does not exist, counted before they are dropped. */
  illegal: number;
};

async function ask(person: string, notes: Note[], seed: number, drop = 0): Promise<Ask> {
  const raw = await cached(`${person}-s${seed}-drop${drop}`, () =>
    call(SYSTEM, `THE NOTES (${notes.length} items)\n\n${render(notes)}`, seed),
  );
  const parsed = json<{ verdicts?: { slug: string; yes?: boolean; items?: number[] }[] }>(raw);
  const legal = new Set(notes.map((i) => i.n));
  const seen = new Set<string>();
  const verdicts: Verdict[] = [];
  let illegal = 0;
  for (const v of parsed.verdicts ?? []) {
    if (!validSlug.has(v.slug) || seen.has(v.slug)) continue;
    seen.add(v.slug);
    const items = [...new Set(v.items ?? [])].sort((a, b) => a - b);
    illegal += items.filter((n) => !legal.has(n)).length;
    // A citation pointing at nothing cannot be checked, and must not be allowed to clear the
    // floor — so it is counted above, then dropped here.
    verdicts.push({ slug: v.slug, yes: v.yes === true, items: items.filter((n) => legal.has(n)) });
  }
  return { verdicts, answered: seen.size, illegal };
}

const passes = (v: Verdict) => v.yes && v.items.length >= FLOOR;
const pct = (n: number) => (Number.isNaN(n) ? '  — ' : `${(n * 100).toFixed(0)}%`.padStart(4));

// ── run ──────────────────────────────────────────────────────────────────────

type Run = { verdicts: Verdict[]; by: Map<string, Verdict> };
const index = (vs: Verdict[]): Run => ({ verdicts: vs, by: new Map(vs.map((v) => [v.slug, v])) });

const results = new Map<
  string,
  { notes: Note[]; a: Run; b: Run; heldOut: number; held: Run }
>();

console.log(`${'#'.repeat(78)}`);
console.log(`# ARM 1 — YIELD: what survives a floor of ${FLOOR}?`);
console.log(`${'#'.repeat(78)}`);

for (const person of PEOPLE) {
  const notes = notesFor(person);

  const askA = await ask(person, notes, SEED_A);
  const askB = await ask(person, notes, SEED_B);
  const a = index(askA.verdicts);
  const b = index(askB.verdicts);

  // The item the surviving lines lean on hardest — removing anything less is a weak test.
  const tally = new Map<number, number>();
  for (const v of askA.verdicts.filter(passes)) {
    for (const n of v.items) tally.set(n, (tally.get(n) ?? 0) + 1);
  }
  const heldOut = [...tally.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? notes[0].n;

  const askHeld = await ask(person, notes.filter((i) => i.n !== heldOut), SEED_A, heldOut);
  const held = index(askHeld.verdicts);

  results.set(person, { notes, a, b, heldOut, held });

  const yes = askA.verdicts.filter((v) => v.yes);
  const kept = askA.verdicts.filter(passes);
  const cut = yes.filter((v) => !passes(v));
  const cites = yes.reduce((s, v) => s + v.items.length, 0);

  console.log(`\n${person}  —  ${notes.length} items with notes`);
  console.log(
    `  yes ${yes.length}/${MENU.length}   clears the floor ${kept.length}   ` +
      `cut by it ${cut.length}   mean citations per yes ${(cites / (yes.length || 1)).toFixed(1)}` +
      `   out-of-range citations ${askA.illegal}`,
  );
  for (const v of kept) console.log(`    keeps  ${v.slug.padEnd(34)} ${v.items.length} items  [${v.items}]`);
  for (const v of cut) console.log(`    cuts   ${v.slug.padEnd(34)} ${v.items.length} items  [${v.items}]`);
  // Answered counts sit beside the keeps, because a reply that was cut short answers fewer lines
  // and would show up as a smaller block for reasons that have nothing to do with the floor.
  console.log(
    `    run 1 answered ${askA.answered}/${MENU.length}` +
      `   run 2 (seed ${SEED_B}) answered ${askB.answered}/${MENU.length}, keeps ` +
      `${askB.verdicts.filter(passes).length}, out-of-range ${askB.illegal}`,
  );
}

// ── arm 2: hold-out ──────────────────────────────────────────────────────────

console.log(`\n${'#'.repeat(78)}`);
console.log('# ARM 2 — GROUNDING: hold out the most-cited item and see what loses it');
console.log(`${'#'.repeat(78)}\n`);
console.log('For every line that cleared the floor in the base run and answered yes again:');
console.log('  held-out  — did it drop the citation that no longer exists? (should be 100%)');
console.log('  others    — how many of its OTHER citations it dropped anyway');
console.log('  noise     — the same churn between the two base runs, nothing removed (the control)\n');
console.log('person                held-out   others    noise    lines');

let heldHit = 0;
let heldTot = 0;
let othDrop = 0;
let othTot = 0;
let noiseDrop = 0;
let noiseTot = 0;
let fellBelow = 0;
let fellBelowTot = 0;

for (const person of PEOPLE) {
  const { a, b, heldOut, held } = results.get(person)!;

  let pHeldHit = 0;
  let pHeldTot = 0;
  let pOthDrop = 0;
  let pOthTot = 0;
  let pNoiseDrop = 0;
  let pNoiseTot = 0;
  let lines = 0;

  for (const v of a.verdicts.filter(passes)) {
    const after = held.by.get(v.slug);
    if (!after?.yes) continue; // the line went away entirely; its citations cannot be compared
    lines++;

    if (v.items.includes(heldOut)) {
      pHeldTot++;
      if (!after.items.includes(heldOut)) pHeldHit++;
      // The product consequence: a line sitting exactly on the floor should now fall through it.
      if (v.items.length === FLOOR) {
        fellBelowTot++;
        if (after.items.length < FLOOR) fellBelow++;
      }
    }
    for (const n of v.items) {
      if (n === heldOut) continue;
      pOthTot++;
      if (!after.items.includes(n)) pOthDrop++;
    }

    // control: same line, same notes, different seed
    const bv = b.by.get(v.slug);
    if (bv?.yes) {
      for (const n of v.items) {
        pNoiseTot++;
        if (!bv.items.includes(n)) pNoiseDrop++;
      }
    }
  }

  heldHit += pHeldHit;
  heldTot += pHeldTot;
  othDrop += pOthDrop;
  othTot += pOthTot;
  noiseDrop += pNoiseDrop;
  noiseTot += pNoiseTot;

  console.log(
    `${person.padEnd(20)} ${pct(pHeldHit / pHeldTot)}     ${pct(pOthDrop / pOthTot)}    ` +
      `${pct(pNoiseDrop / pNoiseTot)}    ${lines} compared, item [${heldOut}] held out ` +
      `(${pHeldTot} cited it)`,
  );
}

console.log(
  `\nmean                 ${pct(heldHit / heldTot)}     ${pct(othDrop / othTot)}    ` +
    `${pct(noiseDrop / noiseTot)}    ` +
    `\n\nheld-out citations checked: ${heldTot}   other citations checked: ${othTot}   ` +
    `control: ${noiseTot}`,
);
console.log(
  `\nLines sitting exactly on the floor that cited the held-out item: ${fellBelowTot}` +
    `\n  ...that fell below it once it was gone: ${fellBelow}`,
);

// ── arm 3: read the traces by hand ───────────────────────────────────────────

console.log(`\n${'#'.repeat(78)}`);
console.log(`# ARM 3 — BY HAND: ${BY_HAND}'s surviving lines, with every note they cite`);
console.log(`${'#'.repeat(78)}`);
console.log('\nNo aggregate replaces reading these. For each citation: would a reader shown only');
console.log('that note agree the line describes it?\n');

const { notes, a } = results.get(BY_HAND)!;
for (const v of a.verdicts.filter(passes)) {
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`${v.slug}  —  ${v.items.length} items  [${v.items}]`);
  console.log(`  test: ${testFor.get(v.slug)}`);
  for (const n of v.items) {
    const note = notes.find((i) => i.n === n)!;
    console.log(`\n  [${n}] ${note.title} (${note.published_at})`);
    console.log(`      ${note.argument.replace(/\n/g, '\n      ')}`);
  }
}

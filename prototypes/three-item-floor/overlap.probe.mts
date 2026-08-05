/**
 * #148, third question — the one neither the ticket nor #147 asked.
 *
 * The floor tests each line against the corpus. It never tests a line against the other lines that
 * cleared it. Two things fall straight through that gap, and both were visible by eye in the main
 * run before they were counted here:
 *
 *   TWINS      — lines citing the identical set of items. Chris ships four lines pointing at items
 *                [1,4,5]; Stuart ships two pointing at the same twenty. Each one clears the floor
 *                honestly and carries a truthful count. The reader is told the same thing about the
 *                person three or four times, with a number beside each saying it was checked.
 *
 *   NEAR-TOTAL — lines citing most of the corpus. Stuart's discounts-the-official-account cites 22
 *                of 23 items. A line true of nearly everything a person published does not describe
 *                that person; it describes the genre, which is exactly what #147 measured when it
 *                stripped the subject matter out and got the same four moves for all five people.
 *                The floor is a minimum, so it cannot see this.
 *
 * Reads the replies the main probe cached. No calls.
 *
 * Run: npx tsx overlap.probe.mts   (after floor.probe.mts has populated ./cache)
 */

import { readFileSync } from 'node:fs';
import { MENU } from '../argument-habits/menu.js';

const FLOOR = 3;
const SEED = 700;
const PEOPLE = [
  'chris-barlow',
  'ethan-mollick',
  'matt-pocock',
  'nate-b-jones',
  'stuart-winter-tear',
];

const validSlug = new Set(MENU.map((h) => h.slug));

type Item = { note?: { argument?: string } };

function corpusSize(person: string) {
  const items: Item[] = JSON.parse(
    readFileSync(new URL(`../argument-habits/items-${person}.json`, import.meta.url), 'utf8'),
  );
  return items.filter((i) => i.note?.argument).length;
}

function survivors(person: string) {
  const raw = readFileSync(new URL(`./cache/${person}-s${SEED}-drop0.txt`, import.meta.url), 'utf8');
  const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)![0]) as {
    verdicts?: { slug: string; yes?: boolean; items?: number[] }[];
  };
  const seen = new Set<string>();
  const out: { slug: string; items: number[] }[] = [];
  for (const v of parsed.verdicts ?? []) {
    if (!validSlug.has(v.slug) || seen.has(v.slug) || v.yes !== true) continue;
    seen.add(v.slug);
    const items = [...new Set(v.items ?? [])].sort((a, b) => a - b);
    if (items.length >= FLOOR) out.push({ slug: v.slug, items });
  }
  return out;
}

console.log('TWINS — lines that cleared the floor citing the identical set of items\n');

let twinLines = 0;
let allLines = 0;
const nearTotals: string[] = [];

for (const person of PEOPLE) {
  const size = corpusSize(person);
  const lines = survivors(person);
  allLines += lines.length;

  const groups = new Map<string, string[]>();
  for (const l of lines) {
    const key = l.items.join(',');
    groups.set(key, [...(groups.get(key) ?? []), l.slug]);
  }

  const twins = [...groups.entries()].filter(([, slugs]) => slugs.length > 1);
  const inTwins = twins.reduce((s, [, slugs]) => s + slugs.length, 0);
  twinLines += inTwins;

  console.log(
    `${person}  —  ${lines.length} lines ship, ${inTwins} of them are a twin of another`,
  );
  for (const [key, slugs] of twins) {
    console.log(`    ${slugs.length} lines share [${key}]:`);
    for (const s of slugs) console.log(`        ${s}`);
  }

  for (const l of lines) {
    const share = l.items.length / size;
    if (share > 0.5) {
      nearTotals.push(
        `${person.padEnd(20)} ${l.slug.padEnd(34)} ${l.items.length}/${size} items ` +
          `(${(share * 100).toFixed(0)}%)`,
      );
    }
  }
}

console.log(
  `\n${twinLines} of ${allLines} shipping lines carry evidence identical to another line ` +
    `(${((twinLines / allLines) * 100).toFixed(0)}%)`,
);

console.log('\n\nNEAR-TOTAL — lines true of more than half of everything the person published\n');
for (const line of nearTotals) console.log(`  ${line}`);
console.log(
  `\n${nearTotals.length} of ${allLines} shipping lines describe more than half the corpus ` +
    `(${((nearTotals.length / allLines) * 100).toFixed(0)}%)`,
);

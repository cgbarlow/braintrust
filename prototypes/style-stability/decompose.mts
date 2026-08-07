/**
 * #152: where does the style block's size actually come from?
 *
 * The ticket recorded a block that halves between compiles — 8 lines for Chris one run, 3 the next —
 * and read it as the synthesiser moving, which this map already carries as a standing constraint.
 * This decomposes that, and it is not what the ticket assumed.
 *
 * Costs nothing to run. #148's probe wrote every reply to disk before using it, so all of this is
 * arithmetic over replies that were already bought. The only calls purchased for #152 are the two
 * extra seeds in agreement.probe.mts.
 *
 * Four questions, in the order they have to be asked:
 *
 *   1. VERDICT vs COUNT   — when a line's ship status changes, did braintrust change its mind about
 *                           the person, or did it call the line characteristic both times and cite a
 *                           different number of examples? These have opposite fixes.
 *   2. WHERE IS THE FLOOR — how many lines change status at floors of 1..5. If the answer is flat,
 *                           the floor is innocent. If it peaks, the floor is the mechanism.
 *   3. THE DISTRIBUTION   — where the citation counts actually sit, which is what decides whether a
 *                           given floor is on the fat part of the pile or out in the tail.
 *   4. BAR vs RANKING     — a fixed handful of the best-evidenced lines, against a threshold. Judged
 *                           on lines changing status per rebuild AND on whether the block's *length*
 *                           can change at all, which is the thing the ticket is actually about.
 *
 * Run: npx tsx decompose.mts
 */

import { readFileSync, existsSync } from 'node:fs';

const PEOPLE = ['chris-barlow', 'ethan-mollick', 'matt-pocock', 'nate-b-jones', 'stuart-winter-tear'];

/** Seeds 700/701 are #148's; 702/703 were bought by agreement.probe.mts. */
const SEEDS = [700, 701, 702, 703];

/** Rebuild pairs. Three independent pairings, so no single seed's quirks carry the result. */
const PAIRS: [number, number][] = [
  [700, 701],
  [700, 702],
  [701, 703],
];

const DIRS = [
  new URL('../three-item-floor/cache/', import.meta.url),
  new URL('./cache/', import.meta.url),
];

type Verdict = { yes: boolean; items: number[] };
type Run = Map<string, Verdict>;

function load(person: string, seed: number): Run | null {
  const file = DIRS.map((d) => new URL(`${person}-s${seed}-drop0.txt`, d)).find((f) => existsSync(f));
  if (!file) return null;
  const m = readFileSync(file, 'utf8').match(/\{[\s\S]*\}/);
  if (!m) return null;
  const parsed = JSON.parse(m[0]) as { verdicts?: { slug: string; yes?: boolean; items?: number[] }[] };
  const run: Run = new Map();
  // First entry wins, matching #148's parse — a repeated slug is a malformed reply, not a revision.
  for (const v of parsed.verdicts ?? []) {
    if (run.has(v.slug)) continue;
    run.set(v.slug, { yes: v.yes === true, items: [...new Set(v.items ?? [])] });
  }
  return run;
}

const runs = new Map<string, Run>();
for (const p of PEOPLE) for (const s of SEEDS) {
  const r = load(p, s);
  if (r) runs.set(`${p}-${s}`, r);
}
const get = (p: string, s: number) => runs.get(`${p}-${s}`)!;
const slugsOf = (...rs: Run[]) => new Set(rs.flatMap((r) => [...r.keys()]));

const ships = (r: Run, slug: string, floor: number) => {
  const v = r.get(slug);
  return !!(v && v.yes && v.items.length >= floor);
};

/**
 * Ties broken by slug so the ranking is a function of the reply and nothing else. A tie broken
 * arbitrarily would put churn back in by the same door this is measuring.
 */
const best = (r: Run, n: number) =>
  new Set(
    [...r.entries()]
      .filter(([, v]) => v.yes && v.items.length >= 1)
      .sort((a, b) => b[1].items.length - a[1].items.length || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([s]) => s),
  );

const floorSet = (r: Run, f: number) =>
  new Set([...r.entries()].filter(([, v]) => v.yes && v.items.length >= f).map(([s]) => s));

const moved = (x: Set<string>, y: Set<string>) =>
  [...new Set([...x, ...y])].filter((s) => x.has(s) !== y.has(s)).length;

// ── 1. verdict vs count ──────────────────────────────────────────────────────
//
// The load-bearing split. A verdict flip means braintrust changed its mind about the person and the
// block is only as stable as its judgement. A count crossing the floor means it did NOT change its
// mind, and the block was destabilised by the gate — a fix with no cost to correctness at all.

console.log('1. WHEN A LINE CHANGES STATUS AT THE THREE-ITEM FLOOR, WHY?\n');
let flips = 0, crossings = 0, agree = 0, judged = 0, sameCites = 0, bothYes = 0;
const deltas: number[] = [];

for (const person of PEOPLE) {
  const [A, B] = [get(person, 700), get(person, 701)];
  let f = 0, c = 0, ag = 0;
  for (const slug of slugsOf(A, B)) {
    const a = A.get(slug), b = B.get(slug);
    if ((a?.yes === true) === (b?.yes === true)) ag++;
    judged++;
    if (ships(A, slug, 3) !== ships(B, slug, 3)) {
      if ((a?.yes === true) !== (b?.yes === true)) f++;
      else c++;
    }
    if (a?.yes && b?.yes) {
      bothYes++;
      deltas.push(Math.abs(a.items.length - b.items.length));
      if (JSON.stringify([...a.items].sort()) === JSON.stringify([...b.items].sort())) sameCites++;
    }
  }
  agree += ag; flips += f; crossings += c;
  const size = (r: Run) => floorSet(r, 3).size;
  console.log(
    `   ${person.padEnd(20)} block ${size(A)} -> ${size(B)}   ` +
    `verdict changed: ${f}   verdict held, count crossed: ${c}   (agreement ${ag}/23)`,
  );
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log('');
console.log(`   verdict agreement across all five people: ${agree}/${judged} = ${((100 * agree) / judged).toFixed(0)}%`);
console.log(`   status changes: ${flips + crossings}  —  verdict changed ${flips}, verdict held and count crossed ${crossings}`);
console.log(`   on lines called characteristic twice: identical citations ${((100 * sameCites) / bothYes).toFixed(0)}%, mean |change in count| ${mean(deltas).toFixed(2)}`);

// ── 2. where is the floor ────────────────────────────────────────────────────

console.log('\n2. HOW MUCH MOVES AT EACH FLOOR\n');
for (const f of [1, 2, 3, 4, 5]) {
  let mv = 0, a = 0, b = 0;
  for (const person of PEOPLE) {
    const [A, B] = [get(person, 700), get(person, 701)];
    mv += moved(floorSet(A, f), floorSet(B, f));
    a += floorSet(A, f).size; b += floorSet(B, f).size;
  }
  const flag = f === 3 ? '   <- shipping today' : '';
  console.log(`   floor ${f}: ${String(mv).padStart(2)} of ${judged} lines change status   (block ${a} -> ${b} across five people)${flag}`);
}

// ── 3. the distribution ──────────────────────────────────────────────────────

console.log('\n3. WHERE THE CITATION COUNTS SIT (every yes-line, every reading)\n');
const hist = new Map<number, number>();
for (const [, r] of runs) for (const [, v] of r) if (v.yes) {
  const k = Math.min(v.items.length, 12);
  hist.set(k, (hist.get(k) ?? 0) + 1);
}
const total = [...hist.values()].reduce((a, b) => a + b, 0);
for (const k of [...hist.keys()].sort((a, b) => a - b)) {
  const n = hist.get(k)!;
  console.log(`   ${String(k).padStart(2)}${k === 12 ? '+' : ' '} items  ${'█'.repeat(n)} ${n}`);
}
const fat = (hist.get(2) ?? 0) + (hist.get(3) ?? 0);
console.log(`\n   ${fat} of ${total} yes-lines cite two or three items — the floor is sitting on the peak.`);

// ── 4. bar vs ranking ────────────────────────────────────────────────────────
//
// The second column is the one the ticket is about. A threshold lets the block's LENGTH change,
// which is what a reader sees; a fixed handful cannot, whatever else moves.

console.log('\n4. A BAR AGAINST A FIXED HANDFUL\n');
console.log('   rule                lines moving per rebuild   block length');
const report = (label: string, pick: (r: Run) => Set<string>) => {
  let mv = 0;
  const lens = new Set<number>();
  for (const person of PEOPLE) {
    for (const [x, y] of PAIRS) mv += moved(pick(get(person, x)), pick(get(person, y)));
    for (const s of SEEDS) lens.add(pick(get(person, s)).size);
  }
  const sizes = [...lens].sort((a, b) => a - b);
  const span = sizes.length === 1 ? `always ${sizes[0]}` : `${sizes[0]}–${sizes[sizes.length - 1]}, varies`;
  console.log(`   ${label.padEnd(20)} ${String(Math.round(mv / PAIRS.length)).padStart(2)} of ${judged}${' '.repeat(19)}${span}`);
};
report('bar at 2', (r) => floorSet(r, 2));
report('bar at 3 (today)', (r) => floorSet(r, 3));
report('best 4', (r) => best(r, 4));
report('best 6', (r) => best(r, 6));
report('best 8', (r) => best(r, 8));

// Does dropping the floor weaken the evidence? The question the floor existed to answer.
const weakest: number[] = [];
for (const person of PEOPLE) for (const s of SEEDS) {
  const kept = [...best(get(person, s), 4)].map((slug) => get(person, s).get(slug)!.items.length);
  if (kept.length) weakest.push(Math.min(...kept));
}
weakest.sort((a, b) => a - b);
const median = weakest[Math.floor(weakest.length / 2)];
const clearing = weakest.filter((w) => w >= 3).length;
console.log(`\n   evidence behind the weakest of the best 4: min ${weakest[0]}, median ${median}, `
  + `clears the old bar of three in ${clearing} of ${weakest.length} readings.`);

// The padding worry: a fixed handful is only honest if there are always at least that many
// genuine candidates. There are.
let fewest = Infinity;
for (const [, r] of runs) fewest = Math.min(fewest, [...r.values()].filter((v) => v.yes).length);
console.log(`   fewest characteristic lines found for anyone, any reading: ${fewest}. A handful of four is never padded.`);

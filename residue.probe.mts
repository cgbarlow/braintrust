/**
 * Measures what a sweep round actually recovers from a real residue.
 *
 * The gap this fills: every projection for the residue sweep assumes the claims a pass
 * passed over re-group at about the same rate as the ones it grouped. That assumption is
 * the whole cost/benefit case and nothing has tested it. The residue is *by construction*
 * what the model already declined to mention once, so it may be systematically harder —
 * and if it converts at 15% rather than 45%, the round cap binds early and the sweep buys
 * a fraction of what it costs.
 *
 * Method: run a subset of the real first passes to produce a genuine residue, then sweep
 * that residue exactly as `compilePositions` does — `claimPasses` over the remaining refs,
 * cluster each, recompute — and report the recovery curve round by round.
 *
 * The universe is restricted to the refs the sampled passes actually carried. A ref from a
 * pass this probe never ran was not omitted; it was never asked about, and counting it as
 * residue would inflate every number here.
 *
 * Read-only: SELECTs against the corpus, no writes, nothing promoted.
 *
 * Run: set -a; source .env; set +a; npx tsx residue.probe.mts [firstPassCount]
 */

import { loadConfig } from './src/config.js';
import { createDb } from './src/db.js';
import { claimIndex, claimPasses, MAX_SWEEP_ROUNDS, type ClaimRef } from './src/compile/positions.js';
import { createSynthesiser, MAX_POSITIONS, SYNTHESIS_TIMEOUT_MS } from './src/compile/synthesis.js';
import { createFetcher } from './src/net/fetch.js';
import { notesFor } from './src/notes/store.js';

const PERSON = 'nate-b-jones';

/** How many of the real first passes to run. Enough residue to sweep, few enough to finish. */
const FIRST_PASSES = Number(process.argv[2] ?? 3);
/** A hard stop so a slow endpoint cannot run this indefinitely. */
const MAX_CALLS = 12;

const config = loadConfig();
const db = createDb(config.databaseUrl);

const { rows: people } = await db.query<{ id: string }>(
  `select id from braintrust_people where slug = $1`,
  [PERSON],
);
const personId = people[0]!.id;

const { rows: compiles } = await db.query<{ extractor: string }>(
  `select extractor from braintrust_compiles
    where person_id = $1 and status = 'current'`,
  [personId],
);
const extractor = compiles[0]!.extractor;

const notes = await notesFor(db, personId, extractor);
const refs = claimIndex(notes);
const digests = claimPasses(refs);

/** The refs one digest carries, read back off the digest itself. */
function refsIn(digest: string): string[] {
  return [...digest.matchAll(/^\[(c\d+)\]/gm)].map((match) => match[1]!);
}

const byRef = new Map(refs.map((ref) => [ref.ref, ref]));
const synthesiser = createSynthesiser(
  config.extractor,
  createFetcher({ timeoutMs: SYNTHESIS_TIMEOUT_MS }),
);

console.log(
  `residue.probe — ${PERSON}, extractor ${extractor}\n` +
    `  ${notes.length} notes, ${refs.length} claims, ${digests.length} passes\n` +
    `  running the first ${FIRST_PASSES} pass(es), then sweeping their residue\n`,
);

/** Every ref any grouping so far has named — the same accounting `compilePositions` does. */
const mentioned = new Set<string>();
let calls = 0;

/** The universe: refs the sampled passes actually carried. */
const universe: ClaimRef[] = [];

console.log('--- first passes ---');
for (let i = 0; i < FIRST_PASSES && i < digests.length; i += 1) {
  const digest = digests[i]!;
  const issued = refsIn(digest);
  for (const ref of issued) {
    const found = byRef.get(ref);
    if (found) universe.push(found);
  }

  const started = Date.now();
  const clusters = await synthesiser.cluster(digest);
  calls += 1;
  const seconds = Math.round((Date.now() - started) / 1000);

  const before = mentioned.size;
  for (const cluster of clusters.slice(0, MAX_POSITIONS)) {
    for (const ref of cluster.claims) mentioned.add(ref);
  }
  const placedHere = issued.filter((ref) => mentioned.has(ref)).length;

  console.log(
    `  pass ${i + 1}: ${issued.length} issued, ${placedHere} placed ` +
      `(${Math.round((placedHere / issued.length) * 1000) / 10}%), ` +
      `+${mentioned.size - before} newly mentioned, ${seconds}s`,
  );
}

const universeRefs = new Set(universe.map((ref) => ref.ref));
const universeItems = new Set(universe.map((ref) => ref.item_id));

/** Items with at least one placed claim, over the sampled universe only. */
function itemsCovered(): Set<string> {
  const covered = new Set<string>();
  for (const ref of universe) if (mentioned.has(ref.ref)) covered.add(ref.item_id);
  return covered;
}

const baselinePlaced = universe.filter((ref) => mentioned.has(ref.ref)).length;
const baselineItems = itemsCovered().size;

console.log(
  `\nafter first passes: ${baselinePlaced}/${universe.length} claims placed ` +
    `(${Math.round((baselinePlaced / universe.length) * 1000) / 10}%), ` +
    `${baselineItems}/${universeItems.size} items covered ` +
    `(${Math.round((baselineItems / universeItems.size) * 1000) / 10}%)\n`,
);

type Round = {
  round: number;
  residue_in: number;
  digests: number;
  placed: number;
  remaining: number;
  recovery_pct: number;
  items_gained: number;
  seconds: number;
};

const rounds: Round[] = [];
let residue = universe.filter((ref) => !mentioned.has(ref.ref));

console.log('--- sweep rounds ---');
for (let round = 1; round <= MAX_SWEEP_ROUNDS && residue.length > 0; round += 1) {
  const passes = claimPasses(residue);
  if (calls + passes.length > MAX_CALLS) {
    console.log(`  stopping: round ${round} needs ${passes.length} call(s), budget is ${MAX_CALLS}`);
    break;
  }

  const itemsBefore = itemsCovered().size;
  const started = Date.now();

  for (const digest of passes) {
    const clusters = await synthesiser.cluster(digest);
    calls += 1;
    for (const cluster of clusters.slice(0, MAX_POSITIONS)) {
      for (const ref of cluster.claims) mentioned.add(ref);
    }
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const remaining = residue.filter((ref) => !mentioned.has(ref.ref));
  const placed = residue.length - remaining.length;

  const row: Round = {
    round,
    residue_in: residue.length,
    digests: passes.length,
    placed,
    remaining: remaining.length,
    recovery_pct: Math.round((placed / residue.length) * 1000) / 10,
    items_gained: itemsCovered().size - itemsBefore,
    seconds,
  };
  rounds.push(row);

  console.log(
    `  round ${round}: ${row.residue_in} in over ${row.digests} digest(s), ` +
      `${row.placed} placed (${row.recovery_pct}%), ${row.remaining} left, ` +
      `+${row.items_gained} items, ${row.seconds}s`,
  );

  residue = remaining;
  if (placed === 0) {
    console.log('  (barren round — a second would stop the real sweep)');
  }
}

const finalPlaced = universe.filter((ref) => mentioned.has(ref.ref)).length;
const finalItems = itemsCovered().size;

console.log(`\nround  residue_in  digests  placed  remaining  recovery%  items+  secs`);
for (const row of rounds) {
  console.log(
    [
      String(row.round).padStart(5),
      String(row.residue_in).padStart(12),
      String(row.digests).padStart(9),
      String(row.placed).padStart(8),
      String(row.remaining).padStart(11),
      `${row.recovery_pct}`.padStart(11),
      String(row.items_gained).padStart(7),
      String(row.seconds).padStart(6),
    ].join(''),
  );
}

console.log(
  `\nSAMPLED UNIVERSE (${FIRST_PASSES} pass(es), ${universe.length} claims, ${universeItems.size} items)\n` +
    `  claims placed: ${baselinePlaced} (${Math.round((baselinePlaced / universe.length) * 1000) / 10}%) ` +
    `-> ${finalPlaced} (${Math.round((finalPlaced / universe.length) * 1000) / 10}%)\n` +
    `  items covered: ${baselineItems} (${Math.round((baselineItems / universeItems.size) * 1000) / 10}%) ` +
    `-> ${finalItems} (${Math.round((finalItems / universeItems.size) * 1000) / 10}%)\n` +
    `  model calls: ${calls} (${FIRST_PASSES} baseline + ${calls - FIRST_PASSES} swept)`,
);

const rates = rounds.map((row) => row.recovery_pct);
console.log(
  `\nrecovery curve: ${rates.join('% -> ')}%\n` +
    `verdict input: first-pass placement was ` +
    `${Math.round((baselinePlaced / universe.length) * 1000) / 10}%, ` +
    `sweep rounds recovered ${rates.join('%, ')}% of the residue handed to them.`,
);

await db.close();

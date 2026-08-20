/**
 * Accounts for every claim ref a clustering pass is handed, against what the model does
 * with it — so the shortfall behind nate-b-jones' 45.6% claim placement can be attributed.
 *
 * The question this exists to settle: when a pass places 14% of its claims, is that the
 * model **omitting** refs from its answer, or **returning refs braintrust never issued**
 * which are then dropped at positions.ts:283? They look identical in the stored rows —
 * nothing persists which claims went unplaced — and they have different fixes.
 *
 * Three losses are counted separately, because only the first two were suspected:
 *   omitted    — issued to this pass, mentioned in no cluster the model returned
 *   malformed  — returned by the model, resolving to no ref braintrust ever issued
 *   truncated  — returned in a cluster past MAX_POSITIONS, discarded by the `.slice` in
 *                compilePositions before buildPositions ever sees it
 *
 * The digest is byte-identical to production's: the same `notesFor` rows, the same
 * `claimIndex`, the same `claimPasses`, and the real `createSynthesiser`. Only the fetcher
 * is wrapped, to keep the raw body the parser would otherwise discard.
 *
 * Read-only: SELECTs against the corpus, no writes, nothing promoted.
 *
 * Run: set -a; source .env; set +a; npx tsx refs.probe.mts [pass numbers…]
 */

import { loadConfig } from './src/config.js';
import { createDb } from './src/db.js';
import { claimIndex, claimPasses } from './src/compile/positions.js';
import { createSynthesiser, MAX_POSITIONS, readClusterContent } from './src/compile/synthesis.js';
import { createFetcher, type Fetcher } from './src/net/fetch.js';
import { SYNTHESIS_TIMEOUT_MS } from './src/compile/synthesis.js';
import { notesFor } from './src/notes/store.js';

const PERSON = 'nate-b-jones';

/** Passes to run, 1-indexed as the per-pass table reports them. Low scorers, plus a control. */
const REQUESTED = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const PASSES = REQUESTED.length > 0 ? REQUESTED : [5, 4, 11, 2];
/** How many times to repeat the first pass, to separate call reliability from content. */
const REPEATS = 3;

const config = loadConfig();
const db = createDb(config.databaseUrl);

/**
 * The real fetcher, with the answer kept. `ask` reads the body once and throws it away
 * after parsing; the malformed refs live in exactly the bytes it discards.
 */
let lastBody = '';
function capturingFetcher(): Fetcher {
  const inner = createFetcher({ timeoutMs: SYNTHESIS_TIMEOUT_MS });
  return async (url, init) => {
    const response = await inner(url, init);
    const body = await response.text();
    lastBody = body;
    return { ok: response.ok, status: response.status, text: async () => body };
  };
}

/** The refs one pass carries, read back off the digest braintrust built for it. */
function refsIn(digest: string): string[] {
  return [...digest.matchAll(/^\[(c\d+)\]/gm)].map((match) => match[1]!);
}

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
const issuedGlobally = new Set(refs.map((ref) => ref.ref));

console.log(
  `refs.probe — ${PERSON}, extractor ${extractor}\n` +
    `  ${notes.length} notes, ${refs.length} claims, ${digests.length} passes\n` +
    `  running passes ${PASSES.join(', ')} (pass ${PASSES[0]} × ${REPEATS} for stability)\n`,
);

const synthesiser = createSynthesiser(config.extractor, capturingFetcher());

type Row = {
  pass: number;
  run: number;
  issued: number;
  returned: number;
  resolved: number;
  malformed: number;
  omitted: number;
  placed_pct: number;
  clusters: number;
  truncated_clusters: number;
  truncated_claims: number;
  empty_clusters: number;
  seconds: number;
  malformed_examples: string[];
};

const results: Row[] = [];

async function runPass(passNumber: number, run: number): Promise<Row> {
  const digest = digests[passNumber - 1]!;
  const issued = refsIn(digest);
  const issuedHere = new Set(issued);

  const started = Date.now();
  const clusters = await synthesiser.cluster(digest);
  const seconds = Math.round((Date.now() - started) / 1000);

  // What production keeps, and what its `.slice(0, MAX_POSITIONS)` throws away.
  const kept = clusters.slice(0, MAX_POSITIONS);
  const truncated = clusters.slice(MAX_POSITIONS);

  // Every ref the model uttered anywhere in the kept clusters.
  const returned = new Set(kept.flatMap((cluster) => cluster.claims));
  const resolved = [...returned].filter((ref) => issuedGlobally.has(ref));
  const malformed = [...returned].filter((ref) => !issuedGlobally.has(ref));

  // Placement is about *this pass's* claims: a ref resolving to another pass is real but
  // does not help the items in front of it.
  const placedHere = resolved.filter((ref) => issuedHere.has(ref));
  const omitted = issued.filter((ref) => !returned.has(ref));

  // Clusters buildPositions would drop outright: every ref in them unresolvable.
  const emptyClusters = kept.filter(
    (cluster) => !cluster.claims.some((ref) => issuedGlobally.has(ref)),
  ).length;

  const truncatedClaims = new Set(
    truncated.flatMap((cluster) => cluster.claims).filter((ref) => issuedHere.has(ref)),
  ).size;

  return {
    pass: passNumber,
    run,
    issued: issued.length,
    returned: returned.size,
    resolved: resolved.length,
    malformed: malformed.length,
    omitted: omitted.length,
    placed_pct: Math.round((placedHere.length / issued.length) * 1000) / 10,
    clusters: clusters.length,
    truncated_clusters: truncated.length,
    truncated_claims: truncatedClaims,
    empty_clusters: emptyClusters,
    seconds,
    malformed_examples: malformed.slice(0, 8),
  };
}

// Serialised throughout: the endpoint 429s on concurrent calls.
for (let run = 1; run <= REPEATS; run += 1) {
  const row = await runPass(PASSES[0]!, run);
  results.push(row);
  console.log(
    `  pass ${row.pass} run ${row.run}: ${row.placed_pct}% placed, ` +
      `${row.malformed} malformed, ${row.omitted} omitted, ${row.seconds}s`,
  );
}

for (const passNumber of PASSES.slice(1)) {
  const row = await runPass(passNumber, 1);
  results.push(row);
  console.log(
    `  pass ${row.pass} run ${row.run}: ${row.placed_pct}% placed, ` +
      `${row.malformed} malformed, ${row.omitted} omitted, ${row.seconds}s`,
  );
}

console.log(`\npass  run  issued  returned  resolved  malformed  omitted  placed%  clusters  cut  cut-claims  empty  secs`);
for (const row of results) {
  console.log(
    [
      String(row.pass).padStart(4),
      String(row.run).padStart(5),
      String(row.issued).padStart(8),
      String(row.returned).padStart(10),
      String(row.resolved).padStart(10),
      String(row.malformed).padStart(11),
      String(row.omitted).padStart(9),
      `${row.placed_pct}`.padStart(9),
      String(row.clusters).padStart(10),
      String(row.truncated_clusters).padStart(5),
      String(row.truncated_claims).padStart(12),
      String(row.empty_clusters).padStart(7),
      String(row.seconds).padStart(6),
    ].join(''),
  );
}

const totalIssued = results.reduce((sum, row) => sum + row.issued, 0);
const totalOmitted = results.reduce((sum, row) => sum + row.omitted, 0);
const totalMalformed = results.reduce((sum, row) => sum + row.malformed, 0);
const totalTruncatedClaims = results.reduce((sum, row) => sum + row.truncated_claims, 0);

console.log(
  `\nTOTALS over ${results.length} calls: ${totalIssued} issued, ` +
    `${totalOmitted} omitted (${Math.round((totalOmitted / totalIssued) * 1000) / 10}%), ` +
    `${totalMalformed} malformed, ${totalTruncatedClaims} lost to the MAX_POSITIONS cut.`,
);

const examples = results.flatMap((row) => row.malformed_examples);
if (examples.length > 0) {
  console.log(`\nMalformed refs, verbatim: ${[...new Set(examples)].slice(0, 20).join(', ')}`);
} else {
  console.log(`\nNo malformed refs: every ref the model returned was one braintrust issued.`);
}

console.log(
  `\nVERDICT: ${
    totalMalformed > totalOmitted
      ? 'MALFORMED REFS dominate — a pass-level repair/re-ask is the cheaper fix.'
      : 'OMISSION dominates — the model simply does not mention most refs, so a residue sweep is the fix.'
  }`,
);

await db.close();

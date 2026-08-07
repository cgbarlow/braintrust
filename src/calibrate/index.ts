/**
 * `npm run calibrate` — report what braintrust measured its own gates to be, and why.
 *
 * **This used to be an instruction and is now a report.** It shipped telling an operator to
 * run a probe set and set `BRAINTRUST_SELECTIVITY_MARGIN` from the result, which made a
 * maintenance task out of something braintrust already had everything to answer: every
 * Compile now measures its own Persona's margin, from that Persona's own Positions, and
 * stores it with the Compile that measured it. See compile/selectivity.ts and
 * https://github.com/cgbarlow/braintrust/issues/128.
 *
 * So nothing here sets anything, and nothing here is a step in anybody's setup. It exists
 * because a measurement nobody can inspect is a measurement nobody can trust — the same
 * reason `voice` returns its evidence beside its instruction.
 *
 *   npm run calibrate                    every Persona
 *   npm run calibrate -- --person SLUG   one
 *
 * Reads rows only: no embeddings calls, no model, no writes.
 */

import { ConfigError, loadConfig } from '../config.js';
import { createDb, type Db } from '../db.js';
import { floorFor, FLOOR_OVERRIDE, RETRIEVAL_FLOOR } from '../find.js';
import { SERVER_NAME } from '../mcp.js';

type Row = {
  person: string;
  compiled_at: Date | null;
  selectivity: {
    floor?: number;
    separation?: string;
    in_low?: number | null;
    out_high?: number | null;
    span?: number | null;
    probes?: { in?: number; out?: number };
    note?: string;
  } | null;
  /** The second measurement, on the second quantity: what `fit` grades against. */
  fit: {
    cut?: number | null;
    span?: number | null;
    separation?: string;
    in_low?: number | null;
    out_high?: number | null;
    probes?: { in?: number; out?: number };
    note?: string;
  } | null;
};

async function measured(db: Db, person?: string): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `select p.slug as person, c.finished_at as compiled_at,
            c.corpus_stats -> 'selectivity' as selectivity,
            c.corpus_stats -> 'fit'         as fit
       from braintrust_people p
       join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where ($1::text is null or p.slug = $1)
      order by p.slug`,
    [person ?? null],
  );
  return rows;
}

function fmt(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(4);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--person');
  const person = at >= 0 ? argv[at + 1] : undefined;

  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  try {
    const rows = await measured(db, person);

    if (rows.length === 0) {
      console.log(`${SERVER_NAME}: no compiled personas${person ? ` matching "${person}"` : ''}.`);
      return;
    }

    if (FLOOR_OVERRIDE !== null) {
      console.log(
        `${SERVER_NAME}: BRAINTRUST_RETRIEVAL_FLOOR=${FLOOR_OVERRIDE} is set, so it ` +
          `overrides every measurement below. Unset it to let each persona use its own.\n`,
      );
    }

    for (const row of rows) {
      const s = row.selectivity;
      const inForce = floorFor(typeof s?.floor === 'number' ? s.floor : null);

      console.log(row.person);
      console.log(`  in force     ${fmt(inForce)}`);
      console.log(`  separation   ${s?.separation ?? 'never measured'}`);
      if (s?.separation && s.separation !== 'not_measurable') {
        console.log(`  weakest position  ${fmt(s.in_low)}   (the corpus must answer this)`);
        console.log(`  best off-corpus   ${fmt(s.out_high)}   (the corpus must refuse this)`);
        console.log(`  span         ${fmt(s.span)}   (the gap between the two groups)`);
        console.log(`  probes       ${s.probes?.in ?? 0} in, ${s.probes?.out ?? 0} out`);
      }
      if (s?.note) console.log(`  ${s.note}`);

      // The grade's own scale, kept visibly apart from the gate's. They are measured on
      // different quantities — chunk similarity and statement similarity — and reading one
      // number against the other is how `fit` came to be graded against a floor that
      // endorsed the mean unrelated statement.
      const f = row.fit;
      console.log(`  fit grade    ${f?.cut === null || f?.cut === undefined ? 'not graded' : `cut ${fmt(f.cut)} in a span of ${fmt(f.span)}`}`);
      if (f?.separation && f.separation !== 'not_measurable') {
        console.log(`    weakest quote     ${fmt(f.in_low)}   (their own words, against their own statements)`);
        console.log(`    best off-corpus   ${fmt(f.out_high)}`);
        console.log(`    probes            ${f.probes?.in ?? 0} quotes, ${f.probes?.out ?? 0} off-corpus`);
      }
      if (f?.note) console.log(`    ${f.note}`);
      if (!s) {
        console.log(
          `  Compiled before braintrust measured its own gates. Falls back to ` +
            `${RETRIEVAL_FLOOR}, and fixes itself on the next rebuild.`,
        );
      }
      console.log('');
    }

    console.log(
      'Measured on every compile, per person, from that person’s own positions. Nothing here ' +
        'is a setting and nothing needs doing — a persona whose separation reads `overlapping` is ' +
        'saying this embeddings model could not tell covered from uncovered on that corpus, so ' +
        'the measurement was discarded and the shipped default stands. That persona may answer ' +
        'questions its corpus does not cover, and it is a reason to look at the embeddings ' +
        'model rather than at the number.\n\n' +
        'Two measurements, because there are two jobs. The floor decides whether a question ' +
        'reaches a corpus at all, measured on chunk similarity. The fit cut decides how the ' +
        'positions that came back are ordered and graded, measured on statement similarity. A ' +
        'persona reading `not graded` returns everything it holds with no grade beside it — a ' +
        'grade has no cautious value to fall back to, so braintrust declines rather than ' +
        'guessing.',
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(78);
  }
  console.error(`${SERVER_NAME}: could not read the calibration.`, error);
  process.exit(1);
});

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
import { marginFor, SELECTIVITY_MARGIN, SELECTIVITY_OVERRIDE } from '../find.js';
import { SERVER_NAME } from '../mcp.js';

type Row = {
  person: string;
  compiled_at: Date | null;
  selectivity: {
    margin?: number;
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
            c.corpus_stats -> 'selectivity' as selectivity
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

    if (SELECTIVITY_OVERRIDE !== null) {
      console.log(
        `${SERVER_NAME}: BRAINTRUST_SELECTIVITY_MARGIN=${SELECTIVITY_OVERRIDE} is set, so it ` +
          `overrides every measurement below. Unset it to let each persona use its own.\n`,
      );
    }

    for (const row of rows) {
      const s = row.selectivity;
      const inForce = marginFor(typeof s?.margin === 'number' ? s.margin : null);

      console.log(row.person);
      console.log(`  in force     ${fmt(inForce)}`);
      console.log(`  separation   ${s?.separation ?? 'never measured'}`);
      if (s?.separation && s.separation !== 'not_measurable') {
        console.log(`  weakest position  ${fmt(s.in_low)}   (the corpus must answer this)`);
        console.log(`  best off-corpus   ${fmt(s.out_high)}   (the corpus must refuse this)`);
        console.log(`  probes       ${s.probes?.in ?? 0} in, ${s.probes?.out ?? 0} out`);
      }
      if (s?.note) console.log(`  ${s.note}`);
      if (!s) {
        console.log(
          `  Compiled before braintrust measured its own gates. Falls back to ` +
            `${SELECTIVITY_MARGIN}, and fixes itself on the next rebuild.`,
        );
      }
      console.log('');
    }

    console.log(
      'Measured on every compile, per person, from that person’s own positions. Nothing here ' +
        'is a setting and nothing needs doing — a persona whose separation reads `overlapping` is ' +
        'saying this embeddings model cannot tell covered from uncovered on that corpus, which ' +
        'is a reason to change the model rather than the number.',
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

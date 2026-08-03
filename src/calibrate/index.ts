/**
 * `npm run calibrate` — measure where `SELECTIVITY_MARGIN` belongs, on this endpoint.
 *
 * The fourth entry point beside the server, the job and the eval, and an operator's tool
 * for the same reason the eval is one: the answer is a property of whichever embeddings
 * model this deployment points at, so braintrust cannot ship it and must not guess it.
 *
 * #115 replaced `MATCH_FLOOR` with a relative margin **and named this step required**:
 *
 *   > Run a probe set of known-in and known-out questions against the operator's endpoint
 *   > and put the threshold where the two groups separate; if they do not separate, the
 *   > endpoint is wrong for the job.
 *
 * That step was never run, and the consequence was live: on `ethan-mollick`, *"the correct
 * water temperature for poaching an egg"* returned three Positions — the exact failure the
 * gate was built to stop, still happening after the gate shipped. An unmeasured constant in
 * a gate is a gate that is open.
 *
 *   npm run calibrate                          the shipped probe set, every Person in it
 *   npm run calibrate -- --person SLUG         one Person
 *   npm run calibrate -- --probes ./mine.json  your own probe set, same shape as ProbeSet
 *
 * What it prints is a recommendation and the evidence for it. Setting the value is still
 * the operator's act — `BRAINTRUST_SELECTIVITY_MARGIN` in the environment.
 *
 * See src/find.ts (`SELECTIVITY_MARGIN`, `selectivity`) and docs/design/mcp-surface.md.
 */

import { readFile } from 'node:fs/promises';

import { ConfigError, loadConfig } from '../config.js';
import { createDb, type Db } from '../db.js';
import { selectivity, SELECTIVITY_MARGIN } from '../find.js';
import { SERVER_NAME } from '../mcp.js';
import { createFetcher } from '../net/fetch.js';
import { createEmbedder, vectorLiteral } from '../retrieval/embed.js';
import { DEFAULT_PROBES, type ProbeSet } from './probes.js';

type Measured = { question: string; margin: number | null };
type Group = { label: 'in' | 'out'; measured: Measured[] };

/**
 * One question's margin: how far the best-matching Chunk stands clear of the middle of the
 * field. Exactly what `findPositions` computes before it decides whether to answer at all.
 */
async function marginFor(
  db: Db,
  embedder: { model: string; embed(inputs: string[]): Promise<number[][]> },
  person: string,
  question: string,
): Promise<number | null> {
  const [vector] = await embedder.embed([question]);
  if (!vector) return null;

  const field = await selectivity(db, vectorLiteral(vector), {
    model: embedder.model,
    person,
    since: null,
    until: null,
  });

  if (field.top === null || field.median === null) return null;
  return field.top - field.median;
}

function summarise(measured: Measured[]): { lo: number; hi: number; n: number } | null {
  const values = measured.map((m) => m.margin).filter((m): m is number => m !== null);
  if (values.length === 0) return null;
  return { lo: Math.min(...values), hi: Math.max(...values), n: values.length };
}

/**
 * Where the two groups separate — or the fact that they do not.
 *
 * The threshold goes **between** the worst in-corpus question and the best off-corpus one.
 * Placed at the midpoint rather than hard against either edge: a value touching the lowest
 * real question turns the next slightly-thinner real question into a shrug, and a value
 * touching the best off-corpus one lets the next slightly-nearer irrelevance through.
 *
 * Overlap is the interesting answer. It means no constant separates these groups on this
 * endpoint, so raising the number trades false answers for refused real ones at a rate the
 * operator should see rather than have chosen for them.
 */
function recommend(inGroup: Measured[], outGroup: Measured[]): string[] {
  const ins = summarise(inGroup);
  const outs = summarise(outGroup);
  const lines: string[] = [];

  if (!ins || !outs) {
    return ['  not enough measured probes to recommend a value.'];
  }

  lines.push(`  in-corpus   ${ins.n} questions, margin ${fmt(ins.lo)} – ${fmt(ins.hi)}`);
  lines.push(`  off-corpus  ${outs.n} questions, margin ${fmt(outs.lo)} – ${fmt(outs.hi)}`);

  if (ins.lo > outs.hi) {
    const value = (ins.lo + outs.hi) / 2;
    lines.push(`  separated by ${fmt(ins.lo - outs.hi)} — set BRAINTRUST_SELECTIVITY_MARGIN=${fmt(value)}`);
    if (SELECTIVITY_MARGIN <= outs.hi) {
      lines.push(
        `  the value in force (${fmt(SELECTIVITY_MARGIN)}) is at or below the best off-corpus ` +
          `question, so off-corpus questions are being answered right now.`,
      );
    }
    return lines;
  }

  lines.push(
    `  THEY OVERLAP by ${fmt(outs.hi - ins.lo)}. No value separates these groups on this ` +
      `endpoint: every threshold that refuses the off-corpus questions also refuses at least ` +
      `one real one.`,
    `  #115's own reading of this outcome: the endpoint is wrong for the job. Before ` +
      `accepting that, check the probe set — an "in" question about something braintrust ` +
      `never actually read is an off-corpus question wearing the wrong label.`,
  );
  return lines;
}

function fmt(value: number): string {
  return value.toFixed(3);
}

function readArgs(argv: string[]): { person?: string; probes?: string } {
  const args: { person?: string; probes?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--person' && argv[i + 1]) args.person = argv[(i += 1)];
    else if (argv[i] === '--probes' && argv[i + 1]) args.probes = argv[(i += 1)];
  }
  return args;
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  const probes: ProbeSet = args.probes
    ? (JSON.parse(await readFile(args.probes, 'utf8')) as ProbeSet)
    : DEFAULT_PROBES;

  const embedder = createEmbedder(config.embeddings, createFetcher({}));

  try {
    const people = args.person ? [args.person] : Object.keys(probes.people);

    console.log(
      `${SERVER_NAME}: calibrating against ${embedder.model} at ${embedder.url}. ` +
        `In force: BRAINTRUST_SELECTIVITY_MARGIN=${fmt(SELECTIVITY_MARGIN)}.`,
    );

    for (const person of people) {
      const inQuestions = probes.people[person];
      if (!inQuestions) {
        console.log(`\n${person}: no in-corpus probes for this person. Skipped.`);
        continue;
      }

      const groups: Group[] = [
        { label: 'in', measured: [] },
        { label: 'out', measured: [] },
      ];

      for (const question of inQuestions) {
        groups[0]!.measured.push({ question, margin: await marginFor(db, embedder, person, question) });
      }
      for (const question of probes.out) {
        groups[1]!.measured.push({ question, margin: await marginFor(db, embedder, person, question) });
      }

      console.log(`\n${person}`);
      for (const group of groups) {
        for (const { question, margin } of group.measured) {
          const mark = margin === null ? '   —  ' : fmt(margin).padStart(6);
          console.log(`  ${group.label === 'in' ? 'in ' : 'out'} ${mark}  ${question}`);
        }
      }
      console.log('');
      for (const line of recommend(groups[0]!.measured, groups[1]!.measured)) console.log(line);
    }

    console.log(
      `\nThe margin is a property of the embeddings model, not of braintrust. Re-run this ` +
        `whenever ${'BRAINTRUST_EMBEDDINGS_MODEL'} changes — a value measured against one ` +
        `model says nothing about another.`,
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
  console.error(`${SERVER_NAME}: the calibration failed.`, error);
  process.exit(1);
});

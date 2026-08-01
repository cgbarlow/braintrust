/**
 * Running a candidate over the eval set, and scoring what is already there.
 *
 * **The candidate runs the real path.** The same prompt, the same JSON parsing, the same
 * timeouts and retries — because the thing being measured is not a model in the abstract
 * but a model *doing braintrust's job*. A model that cannot return parseable JSON through
 * this code should score badly here, and it will.
 *
 * **The incumbent costs nothing.** Its Notes are already in the database, written by real
 * runs over these exact Items, so the baseline is a query rather than a bill. Two of the
 * seven measures need a live read and the rest do not; the scorecard says which are missing
 * rather than filling them in.
 *
 * **Nothing here disturbs the live Persona.** A Note is keyed `(item_id, extractor)` and a
 * Compile reads only the generation it declares, so a candidate's Notes sit beside the
 * incumbent's and are invisible until somebody changes the configuration. If the candidate
 * is then adopted, this run's Notes are already written and are not paid for twice.
 */

import type { Db } from '../db.js';
import type { Extractor } from '../notes/extractor.js';
import { writeNote } from '../notes/store.js';
import { verifyClaims } from '../notes/verify.js';
import { positionsOf, scoreItems, type ItemEvidence, type Scorecard } from './score.js';
import type { SampleItem } from './sample.js';

/** One quote a model offered that braintrust would not accept, kept for a human to read. */
export type Rejection = {
  external_id: string;
  statement: string;
  quote: string;
  /** True when it differs from the body only in punctuation and case. */
  nearly: boolean;
};

export type RunResult = { card: Scorecard; rejections: Rejection[] };

export type RunDeps = {
  db: Db;
  extractor: Extractor;
  /** Written as a real generation, so adopting the candidate later re-reads nothing. */
  write?: boolean | undefined;
  log?: ((line: string) => void) | undefined;
  now?: (() => number) | undefined;
};

/**
 * Reads every sampled Item with the candidate and scores what came back.
 *
 * **The rejected quotes are captured here and nowhere else.** Production drops them on
 * purpose — a claim braintrust cannot cite is a claim it does not have — which leaves the
 * drop rate visible and undiagnosable. This is a diagnostic path rather than the product,
 * so it may keep them, and they go to a report rather than to a row.
 */
export async function runCandidate(items: SampleItem[], deps: RunDeps): Promise<RunResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const evidence: ItemEvidence[] = [];
  const rejections: Rejection[] = [];

  for (const [index, item] of items.entries()) {
    const started = now();

    let raw;
    try {
      raw = await deps.extractor.read({
        ...(item.title ? { title: item.title } : {}),
        text: item.body_text,
      });
    } catch (error) {
      // A refusal is a real result about this model on this Item, and it is scored as
      // nothing kept rather than skipped — a model that cannot answer is not the equal of
      // one that answers well.
      log(`  ${index + 1}/${items.length} ${item.external_id}: refused — ${(error as Error).message}`);
      evidence.push({ external_id: item.external_id, words: item.words, offered: 0, nearly: 0, kept: [] });
      continue;
    }

    const verified = verifyClaims(raw.claims, item.body_text, []);
    const seconds = (now() - started) / 1000;

    for (const claim of raw.claims) {
      if (verified.claims.some((kept) => kept.statement === claim.statement)) continue;
      rejections.push({
        external_id: item.external_id,
        statement: claim.statement,
        quote: claim.quote,
        nearly: false,
      });
    }

    evidence.push({
      external_id: item.external_id,
      words: item.words,
      offered: raw.claims.length,
      nearly: verified.nearly,
      kept: positionsOf(verified.claims, item.body_text),
      seconds,
    });

    if (deps.write !== false) {
      await writeNote(deps.db, item.id, deps.extractor.generation, {
        claims: verified.claims,
        argument: raw.argument,
        assumptions: raw.assumptions,
      });
    }

    log(
      `  ${index + 1}/${items.length} ${item.external_id} (${item.words} words): ` +
        `${verified.claims.length}/${raw.claims.length} kept in ${seconds.toFixed(1)}s`,
    );
  }

  return { card: scoreItems(deps.extractor.generation, evidence), rejections };
}

/**
 * Scores a generation already in the database, over the same Items.
 *
 * Returns `undefined` when that generation has read none of them, which is the honest
 * answer rather than a scorecard of zeroes: a model that was never run is not a model that
 * found nothing.
 */
export async function scoreStored(
  db: Db,
  generation: string,
  items: SampleItem[],
): Promise<Scorecard | undefined> {
  const { rows } = await db.query<{ item_id: string; claims: { statement: string; quote: string }[] }>(
    `select n.item_id, n.claims
       from braintrust_item_notes n
      where n.extractor = $1 and n.item_id = any($2::uuid[])`,
    [generation, items.map((item) => item.id)],
  );

  if (rows.length === 0) return undefined;

  const byItem = new Map(rows.map((row) => [row.item_id, row.claims]));
  const evidence: ItemEvidence[] = [];

  for (const item of items) {
    const claims = byItem.get(item.id);
    if (!claims) continue;
    evidence.push({
      external_id: item.external_id,
      words: item.words,
      // `offered` and `nearly` are absent on purpose: a Note never recorded what was
      // rejected, so a stored generation can be placed and measured but not graded on
      // fidelity. Said with a dash in the scorecard rather than guessed at.
      kept: positionsOf(claims as never, item.body_text),
    });
  }

  return scoreItems(generation, evidence);
}

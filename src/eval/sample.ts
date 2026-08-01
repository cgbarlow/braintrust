/**
 * The eval set: a fixed, stratified slice of the real Corpus.
 *
 * **Deterministic, or the numbers are not comparable.** Two models scored on two different
 * samples produce two numbers nobody can put beside each other — and the temptation to
 * re-sample until a favoured model wins is exactly what a benchmark exists to remove. The
 * order is `md5(item id)`, which is stable across runs, machines and databases, and owes
 * nothing to insertion order or to how far a backfill happens to have reached.
 *
 * **Stratified by length, because length is what the candidates differ on.** An unstratified
 * sample of this Corpus is mostly whatever form is commonest, and the interesting question —
 * whether a model still quotes accurately forty thousand words in — would be decided by two
 * or three Items that happened to be drawn. The bands are filled evenly and the shortfall in
 * any one is taken from the others, so a small Corpus still yields a full sample.
 *
 * See docs/design/compiler.md §1.
 */

import type { Db } from '../db.js';

/** Where the bands sit. A long-form Item is one no 128k-context model reads comfortably. */
export const BANDS: { name: string; from: number; to: number }[] = [
  { name: 'short', from: 0, to: 1_000 },
  { name: 'medium', from: 1_000, to: 5_000 },
  { name: 'long', from: 5_000, to: Number.MAX_SAFE_INTEGER },
];

export type SampleItem = {
  id: string;
  external_id: string;
  title: string | null;
  body_text: string;
  words: number;
  band: string;
  platform: string;
};

/**
 * `limit` Items, spread across the length bands and chosen the same way every time.
 *
 * Only `retrieved` Items with a body, because those are the ones the read pass would ever
 * be handed — an eval set containing anything else would be measuring a case that cannot
 * occur.
 */
export async function sampleCorpus(db: Db, limit: number): Promise<SampleItem[]> {
  const perBand = Math.ceil(limit / BANDS.length);

  const { rows } = await db.query<SampleItem & { words: string }>(
    `with sized as (
       select i.id, i.external_id, i.title, i.body_text, s.platform,
              coalesce(array_length(regexp_split_to_array(btrim(i.body_text), '\\s+'), 1), 0) as words
         from braintrust_items i
         join braintrust_sources s on s.id = i.source_id
        where i.retrieval = 'retrieved' and i.body_text is not null and btrim(i.body_text) <> ''
     ),
     banded as (
       select *,
              case when words < $2 then 'short'
                   when words < $3 then 'medium'
                   else 'long' end as band
         from sized
     ),
     ranked as (
       select *, row_number() over (partition by band order by md5(id::text)) as rank
         from banded
     )
     select id, external_id, title, body_text, words::text as words, band, platform
       from ranked where rank <= $1
      order by band, rank`,
    // Up to a whole sample from each band, not a band's share: the shortfall in one band
    // has to be takeable from the others, and the query cannot know which band is thin.
    [limit, BANDS[1]!.from, BANDS[2]!.from],
  );

  const items = rows.map((row) => ({ ...row, words: Number(row.words) }));

  // A band with fewer Items than its share leaves room, and the rest of the sample takes
  // it rather than returning short — the same reason the ranking is stable: a comparison
  // is only worth anything if both models saw the same set, whatever its shape.
  return balance(items, limit, perBand);
}

function balance(items: SampleItem[], limit: number, perBand: number): SampleItem[] {
  const taken: SampleItem[] = [];
  const spare: SampleItem[] = [];

  for (const band of BANDS) {
    const inBand = items.filter((item) => item.band === band.name);
    taken.push(...inBand.slice(0, perBand));
    spare.push(...inBand.slice(perBand));
  }

  return [...taken, ...spare].slice(0, limit);
}

/** What the sample is made of, for the line printed above a scorecard. */
export function describeSample(items: SampleItem[]): string {
  const counts = BANDS.map((band) => {
    const inBand = items.filter((item) => item.band === band.name);
    return `${inBand.length} ${band.name}`;
  });

  const words = items.reduce((total, item) => total + item.words, 0);
  return `${items.length} items (${counts.join(', ')}), ${words.toLocaleString('en-NZ')} words`;
}

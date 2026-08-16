/**
 * The golden set: a fixed, per-person sample of real published titles, asked back to
 * `find_positions` as questions.
 *
 * **The query is the item's own title, not an authored one.** A hand-written question list
 * drifts from what a corpus actually covers and needs a human to keep it current; a title is
 * a real thing this person published, so asking about it is asking a question the corpus is
 * guaranteed to have material for — which is what makes a miss worth looking at rather than
 * explaining away as "nobody asked that".
 *
 * **Deterministic, for the same reason ../eval/sample.ts is.** Two runs scored on two
 * different samples produce two numbers nobody can compare, and re-sampling until a run
 * looks better is exactly what a fixed order removes. The order is `md5(item id)`, stable
 * across runs, machines and databases.
 */

import type { Db } from '../db.js';

export type GoldenQuestion = {
  person: string;
  query: string;
  item_id: string;
  item_url: string;
  /**
   * **Every url a citation of this item can carry**, which is not the same as the item's
   * own url. ../find.ts renders a citation as `coalesce(pc.post_url, i.url)` so a batched
   * Bluesky day resolves to the individual post the quote fell inside. Comparing an answer
   * against `i.url` alone therefore scored every batched item ungrounded no matter how good
   * the answer was. Collected here, once, so the comparison cannot go wrong later.
   */
  citation_urls: string[];
};

/**
 * Up to `limit` questions for one person, one per retrieved item with a title.
 *
 * Only `retrieved` items with a real title — an untitled item, or one braintrust never
 * fetched, has no natural-language topic to ask about.
 */
export async function goldenQuestions(db: Db, person: string, limit: number): Promise<GoldenQuestion[]> {
  const { rows } = await db.query<{ id: string; title: string; url: string; citation_urls: string[] }>(
    `select i.id, i.title, i.url,
            array_remove(
              array[i.url] || coalesce(
                (select array_agg(distinct coalesce(pc.post_url, i.url))
                   from braintrust_position_citations pc
                  where pc.item_id = i.id),
                array[]::text[]
              ),
              null
            ) as citation_urls
       from braintrust_items i
       join braintrust_sources s on s.id = i.source_id
       join braintrust_people p on p.id = s.person_id
      where p.slug = $1
        and i.retrieval = 'retrieved'
        and i.title is not null
        and btrim(i.title) <> ''
      order by md5(i.id::text)
      limit $2`,
    [person, limit],
  );

  return rows.map((row) => ({
    person,
    query: row.title,
    item_id: row.id,
    item_url: row.url,
    citation_urls: row.citation_urls,
  }));
}

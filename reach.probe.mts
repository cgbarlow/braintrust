/**
 * How far retrieval actually reaches, and where a golden question is really lost.
 *
 * Written for [#303](https://github.com/cgbarlow/braintrust/issues/303), which asked one
 * question: is the HNSW index under-reaching at pgvector's default `ef_search` of 40, so
 * that the right item is never in the candidate set? Everything here exists to answer that
 * and to say what the answer displaces — see `docs/research/issue-303-index-reach.md`.
 *
 * Four passes, in the order the argument needs them:
 *
 * 1. **The plan.** What the planner chooses for the query `find_positions` actually runs,
 *    and for a bare top-k with no joins, across a sweep of `limit`. This is where the
 *    `ef_search` question is settled, because a knob on an index nothing scans is a knob on
 *    nothing.
 * 2. **The funnel.** Every golden question through five gates: the selectivity gate let it
 *    through, the item is in the top-`MATCH_ITEMS` candidate set, some compiled Position
 *    cites that item, a Position citing it is among the five a reader is shown (`reached`),
 *    it is the first of those five (`grounded`).
 * 3. **The misses, attributed.** For each item missing from the candidate set: was it cut
 *    by the floor, crowded out of the top `MATCH_ITEMS`, or is nothing of it indexed?
 * 4. **Coverage.** How much of each Corpus any Position cites at all — the denominator the
 *    funnel's largest loss is measured against.
 *
 * The candidate query is the `hits`/`items` CTE of ../src/find.ts's `matchingPositions`,
 * verbatim, and the funnel's last two columns call the real `findPositions`. Measuring a
 * second implementation of either would settle nothing about the one that serves readers.
 *
 * Costs: one embedding call per persona, batched. No judge calls, so this is repeatable
 * without spending the endpoint's serial budget.
 *
 * Run: npx tsx --env-file=.env reach.probe.mts
 */

import { createDb, type Db } from './src/db.js';
import { loadConfig } from './src/config.js';
import { findPositions, floorFor, ITEM_OVER_FETCH, MATCH_ITEMS } from './src/find.js';
import { createFetcher } from './src/net/fetch.js';
import { createEmbedder, createQueryGate } from './src/retrieval/index.js';

const SAMPLE = 10;
const ANSWER_LIMIT = 5;
const PEOPLE = ['stuart-winter-tear', 'matt-pocock', 'nate-b-jones', 'ethan-mollick', 'chris-barlow'];

const config = loadConfig();
const db = createDb(config.databaseUrl);
const embedder = createEmbedder(config.embeddings, createFetcher());
const retrieval = createQueryGate(db, config.embeddings.model);

/** ../src/find.ts's `matchingPositions`, minus the window, reporting where the item landed. */
const CANDIDATES = `with hits as (
   select c.item_id, e.embedding <=> $2::vector as distance
     from braintrust_embeddings e
     join braintrust_chunks c on c.id = e.chunk_id
     join braintrust_items i on i.id = c.item_id
     join braintrust_sources s on s.id = i.source_id
    where s.person_id = (select person_id from braintrust_compiles where id = $1)
      and e.model = $3
      and e.embedding <=> $2::vector <= ${1} - $5::float
    order by distance
    limit ${MATCH_ITEMS * ITEM_OVER_FETCH}
 ),
 items as (select item_id, min(distance) as distance
             from hits group by item_id
            order by distance
            limit ${MATCH_ITEMS})
 select (select count(*) from hits)  as hit_rows,
        (select count(*) from items) as item_rows,
        coalesce(array_position(array(select item_id::text from items order by distance),
                                $4::text), 0) as rank`;

/** The same field with no floor and no limit: where the item stands on its own merits. */
const ATTRIBUTION = `with chunks as (
   select c.item_id, e.embedding <=> $2::vector as distance
     from braintrust_embeddings e
     join braintrust_chunks c on c.id = e.chunk_id
     join braintrust_items i on i.id = c.item_id
     join braintrust_sources s on s.id = i.source_id
    where s.person_id = (select person_id from braintrust_compiles where id = $1)
      and e.model = $3
 ),
 best as (select item_id, min(distance) as distance from chunks group by item_id),
 ranked as (select item_id, distance, row_number() over (order by distance) as rank from best)
 select (select count(*) from ranked) as items_with_chunks,
        (select rank from ranked where item_id = $4::uuid) as rank,
        (select distance from ranked where item_id = $4::uuid) as distance,
        (select count(*) from ranked where distance <= ${1} - $5::float) as items_over_floor`;

type Question = { query: string; item_id: string; citation_urls: string[] };

async function questionsFor(person: string): Promise<Question[]> {
  const { rows } = await db.query<Question>(
    // The golden set of ../src/qa/sample.ts, including the citation urls a batched item's
    // quotes actually resolve to, so `reached` here means what it means there.
    `select i.title as query, i.id as item_id,
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
    [person, SAMPLE],
  );
  return rows;
}

async function compileFor(slug: string) {
  const { rows } = await db.query<{ id: string; compiler_version: string | null; measured_floor: string | null }>(
    `select c.id, c.compiler_version, (c.corpus_stats -> 'selectivity' ->> 'floor') as measured_floor
       from braintrust_people p
       join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
      where p.slug = $1`,
    [slug],
  );
  return rows[0];
}

async function positionsCiting(compileId: string, itemId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `select count(distinct p.id) as count
       from braintrust_positions p
       join braintrust_position_citations pc on pc.position_id = p.id
      where p.compile_id = $1 and pc.item_id = $2`,
    [compileId, itemId],
  );
  return Number(rows[0]!.count);
}

const vectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`;

// ---------------------------------------------------------------- 1. the plan

console.log(`## What the planner chooses\n`);
{
  const compile = (await compileFor('nate-b-jones'))!;
  const [probe] = await embedder.embed(['What agents change about how work gets done']);
  const literal = vectorLiteral(probe!);

  for (const limit of [10, 60, 200, 480]) {
    const bare = await db.query<Record<string, string>>(
      `explain (analyze) select chunk_id from braintrust_embeddings
        where model = $1 order by embedding <=> $2::vector limit ${limit}`,
      [config.embeddings.model, literal],
    );
    const served = await db.query<Record<string, string>>(
      `explain (analyze) with hits as (
         select c.item_id, e.embedding <=> $2::vector as distance
           from braintrust_embeddings e
           join braintrust_chunks c on c.id = e.chunk_id
           join braintrust_items i on i.id = c.item_id
           join braintrust_sources s on s.id = i.source_id
          where s.person_id = (select person_id from braintrust_compiles where id = $1)
            and e.model = $3 and e.embedding <=> $2::vector <= ${1} - $4::float
          order by distance limit ${limit})
       select count(*) from hits`,
      [compile.id, literal, config.embeddings.model, 0.5419],
    );

    const read = (rows: Record<string, string>[]) => {
      const plan = rows.map((row) => row['QUERY PLAN']!).join('\n');
      const ms = /Execution Time: ([\d.]+)/.exec(plan)?.[1] ?? '?';
      return `${/hnsw/.test(plan) ? 'HNSW index' : 'Seq Scan  '} ${ms.padStart(7)}ms`;
    };

    console.log(`limit ${String(limit).padStart(3)}  bare top-k: ${read(bare.rows)}   as served: ${read(served.rows)}`);
  }
}

// ------------------------------------------------- 2 & 3. the funnel and the misses

type Bucket = 'grounded' | 'ranked below' | 'not in the five' | 'no position cites it' | 'cut by the floor';
const funnel = { asked: 0, gate: 0, candidate: 0, cited: 0, reached: 0, grounded: 0 };
const buckets: Record<Bucket, number> = {
  grounded: 0,
  'ranked below': 0,
  'not in the five': 0,
  'no position cites it': 0,
  'cut by the floor': 0,
};

for (const person of PEOPLE) {
  const compile = await compileFor(person);
  if (!compile) continue;
  const floor = floorFor(
    compile.measured_floor === null ? null : Number(compile.measured_floor),
    compile.compiler_version,
  );
  const questions = await questionsFor(person);
  const vectors = await embedder.embed(questions.map((question) => question.query));
  const mine = { asked: 0, candidate: 0, cited: 0, reached: 0, grounded: 0 };

  console.log(`\n## ${person} — floor ${floor}`);

  for (const [at, question] of questions.entries()) {
    const literal = vectorLiteral(vectors[at]!);
    const args = [compile.id, literal, config.embeddings.model, question.item_id, floor];

    const { rows: found } = await db.query<{ hit_rows: string; item_rows: string; rank: string }>(CANDIDATES, args);
    const rank = Number(found[0]!.rank);
    const cites = await positionsCiting(compile.id, question.item_id);

    const payload = await findPositions(
      { person, query: question.query, limit: ANSWER_LIMIT, full: true },
      { db, embedder, retrieval },
    );
    const cited = (at: number) =>
      payload.positions[at]?.citations.some((citation) => question.citation_urls.includes(citation.url)) ?? false;
    const reached = payload.positions.some((_, index) => cited(index));
    const grounded = cited(0);

    // **The first true reason, in the order a fix would have to remove them.** An item no
    // Position cites cannot be ranked into anything, so that is its reason even when the
    // floor would also have cut it.
    const bucket: Bucket = grounded
      ? 'grounded'
      : cites === 0
        ? 'no position cites it'
        : reached
          ? 'ranked below'
          : rank > 0
            ? 'not in the five'
            : 'cut by the floor';
    buckets[bucket] += 1;

    funnel.asked += 1;
    mine.asked += 1;
    if (payload.positions.length > 0) funnel.gate += 1;
    if (rank > 0) (funnel.candidate += 1), (mine.candidate += 1);
    if (cites > 0) (funnel.cited += 1), (mine.cited += 1);
    if (reached) (funnel.reached += 1), (mine.reached += 1);
    if (grounded) (funnel.grounded += 1), (mine.grounded += 1);

    if (bucket === 'cut by the floor') {
      const { rows: why } = await db.query<{
        items_with_chunks: string;
        rank: string | null;
        distance: string | null;
        items_over_floor: string;
      }>(ATTRIBUTION, args);
      const row = why[0]!;
      const similarity = row.distance === null ? null : 1 - Number(row.distance);
      console.log(
        `- ${question.query.slice(0, 56).padEnd(56)} cut by the floor: its best chunk scores ` +
          `${similarity === null ? 'nothing indexed' : similarity.toFixed(3)} against ${floor}, ` +
          `ranking ${row.rank ?? 'n/a'} of ${row.items_with_chunks} items ` +
          `(${row.items_over_floor} clear the floor for this question)`,
      );
    } else {
      console.log(`- ${question.query.slice(0, 56).padEnd(56)} ${bucket}`);
    }
  }

  console.log(
    `  ${person}: in the candidate set ${mine.candidate}/${mine.asked} · cited by a position ` +
      `${mine.cited}/${mine.asked} · reached ${mine.reached}/${mine.asked} · grounded ${mine.grounded}/${mine.asked}`,
  );
}

console.log(`\n## The funnel`);
for (const [stage, count] of Object.entries(funnel)) console.log(`${stage.padEnd(12)} ${count}`);

console.log(`\n## Where a question is lost`);
for (const [bucket, count] of Object.entries(buckets)) console.log(`${bucket.padEnd(22)} ${count}`);

// ---------------------------------------------------------------- 4. coverage

console.log(`\n## How much of each corpus any Position cites`);
const { rows: coverage } = await db.query(
  `select pe.slug,
          count(distinct i.id) filter (where i.retrieval = 'retrieved' and i.title is not null) as items,
          count(distinct pc.item_id) as cited,
          count(distinct p.id) as positions
     from braintrust_people pe
     join braintrust_sources s on s.person_id = pe.id
     join braintrust_items i on i.source_id = s.id
     join braintrust_compiles co on co.person_id = pe.id and co.status = 'current'
     left join braintrust_positions p on p.compile_id = co.id
     left join braintrust_position_citations pc on pc.position_id = p.id and pc.item_id = i.id
    group by pe.slug order by items desc`,
);
console.table(coverage);

await db.close();

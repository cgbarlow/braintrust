# How far retrieval reaches, and where a golden question is actually lost

**Resolution note for [#303](https://github.com/cgbarlow/braintrust/issues/303), on wayfinder map
[#300](https://github.com/cgbarlow/braintrust/issues/300).** Every number here was measured against
the live database on 2026-08-16 by `reach.probe.mts`, which is checked in and re-runnable — one
embedding call per persona, no judge calls. Nothing below is inferred from source.

The short version: **the HNSW index is never used, so `hnsw.ef_search` is a knob on nothing.**
Retrieval today is exact — a full scan — and its candidate set is already the best one a brute-force
search could produce. That refutes the leading hypothesis of
[#299](https://github.com/cgbarlow/braintrust/issues/299) and the premise of this ticket, and it
moves the whole retrieval argument onto three other stages.

---

## 1. The index the schema builds is not the index the planner uses

`schema.sql:206` builds `braintrust_embeddings_hnsw_idx` and it is 64 MB. `EXPLAIN (ANALYZE)` on the
query `find_positions` actually runs:

```
Limit  (rows=480)
  -> Sort  (Sort Key: e.embedding <=> '<query>')
       -> Hash Join  (Hash Cond: c.id = e.chunk_id)
            -> Nested Loop            -- the person's items and chunks
            -> Hash
                 -> Seq Scan on braintrust_embeddings e   (rows=8170, Rows Removed by Filter: 7940)
                      Filter: model = '…' AND (embedding <=> '<query>') <= 0.4581
Execution Time: 64.7 ms   Buffers: shared hit=27511
```

**Sequential scan.** Every call computes cosine distance against all 8,170 stored vectors and detoasts
each one — 27,511 buffer hits, ~215 MB of buffer traffic, for one question. `SET LOCAL enable_seqscan
= off` does not rescue it: the planner switches to the primary key, not to HNSW.

The cause is the query's shape, not its cost estimate. The person filter arrives through
`braintrust_sources`, so the `ORDER BY … LIMIT` sits above a join and pgvector's index cannot serve
it at the width production asks for. Sweeping `limit` shows exactly where the door closes:

| `limit` | bare top-k, no joins | the query as served |
|---|---|---|
| 10 | HNSW index | **HNSW index** |
| 60 | HNSW index | Seq Scan |
| 200 | HNSW index, 1.7 ms | Seq Scan, 62 ms |
| 480 — **what production asks for** | Seq Scan, 56 ms | **Seq Scan, 62 ms** |

`MATCH_ITEMS * ITEM_OVER_FETCH` is 480, which is past the flip in both columns.

### What that costs, and what it refutes

- **`hnsw.ef_search` is a no-op here.** Measured, not reasoned: the candidate set is byte-identical at
  the default 40, at 200, at 500, under pgvector 0.8's `iterative_scan = relaxed_order`, and under a
  forced exact scan. 38/45 either way. #299's option A — one `SET LOCAL`, zero model calls — would
  have changed nothing, and #303 existed to build it.
- **Recall is not the problem it was thought to be**, because there is no approximation to lose recall
  to. Whatever the candidate set misses, an exact search misses too.
- **The cost is linear in corpus size and paid on every question.** ~62 ms server-side and ~195 ms
  round trip today at 8,170 vectors, and `find_positions` runs three such scans per call
  (`selectivity`, `matchingPositions`, `matchingPassages`). Ten times the corpus is roughly ten times
  that scan.
- **pgvector is 0.8.2 on PostgreSQL 17.6**, so iterative scan is available if the query shape ever
  makes the index reachable.

---

## 2. Where a golden question is actually lost

The same 45 golden questions as the corrected baseline, run through five gates. The last two columns
are `reached` and `grounded` exactly as `src/qa/score.ts` defines them, and they reproduce that
baseline — 22 and 11 — which is the check that this instrument and that one are measuring one thing.

| stage | of 45 |
|---|---|
| asked | 45 |
| the selectivity gate let the query through | **45** |
| the item is in the top-60 candidate set | 38 |
| some compiled Position cites that item | 32 |
| a Position citing it is in the five shown (`reached`) | 22 |
| it is the first of those five (`grounded`) | 11 |

Attributing each question to the *first* reason a fix would have to remove:

| where it is lost | count | what would have to change |
|---|---|---|
| **nothing does — grounded** | **11** | — |
| **no Position cites the item at all** | **13** | the compile, not retrieval |
| a Position citing it came back, ranked below another | 11 | ordering |
| a Position citing it exists, the item was found, no such Position made the five | 6 | ranking or the limit of five |
| the floor cut the item out of the candidate set | 4 | the floor |
| **the index under-reached** | **0** | — |

The ticket's own hypothesis accounts for none of the 34 failures.

### The floor, on the four it does account for

Every one is a near miss against a floor measured per persona at compile time, and in each case the
question is that item's own published title:

| persona | floor | the item's best chunk | its rank among that persona's items |
|---|---|---|---|
| nate-b-jones | 0.5419 | 0.531 | 181 of 516 |
| ethan-mollick | 0.5011 | 0.453 | 7 of 19 |
| ethan-mollick | 0.5011 | 0.393 | 15 of 19 |
| chris-barlow | 0.4427 | 0.420 | 3 of 5 |

Two of the four are within 0.011 of clearing. None is "crowded out" — the top-60 item budget never
binds, because the floor has already cut the field to single digits for the small corpora (4, 5 and 6
items clear it) long before 60 is reached.

---

## 3. Coverage: how much of each corpus any Position cites

The largest loss above — 13 questions where no Position cites the item — is not a retrieval fact at
all. It is what the compile wrote down:

| persona | titled, retrieved items | items any Position cites | Positions | covered |
|---|---|---|---|---|
| nate-b-jones | 516 | 217 | 266 | 42% |
| matt-pocock | 40 | 24 | 19 | 60% |
| stuart-winter-tear | 25 | 22 | 15 | 88% |
| ethan-mollick | 19 | 19 | 21 | 100% |
| chris-barlow | 5 | 5 | 13 | 100% |

Read against the per-persona funnel, this is the whole of the difference between the two ends of the
fleet:

- **nate-b-jones** — 8/10 in the candidate set, 3/10 cited by any Position, 1/10 reached. Retrieval
  finds his items. There is nothing compiled about them to return. 299 of his 516 items have no
  Position at all.
- **ethan-mollick** — 7/10 in the candidate set, **10/10** cited by a Position, 7/10 reached, 1/10
  grounded. Full coverage, and the answer still rests on the wrong Position nine times in ten.

Those are opposite diseases and neither is the index.

One more fact worth carrying: **nate-b-jones has no measured `fit` cut** (`corpus_stats -> 'fit' ->>
'cut'` is null where every other persona has one), so his answers are graded `ungraded` rather than
`close`/`partial`/`distant`.

---

## 4. What this ticket hands the next ones

- **Do not build a `SET LOCAL hnsw.ef_search`.** Measured no-op. #307's third candidate — "neither, if
  `hnsw.ef_search` turns out to explain it" — is now closed: it does not.
- **Retrieval is exact.** Any argument that the right item "was there but the index missed it" is
  unavailable. The 4 the floor cuts and the 13 with nothing compiled are the real recall story.
- **Argue coverage before ranking for nate-b-jones.** #312 asks whether his misses are the corpus or
  the query; the answer measured here is *neither* — 7 of his 10 misses are items braintrust read and
  compiled nothing about.
- **The scan is the cost floor for every question.** Three full corpus scans per `find_positions`,
  linear in vectors stored.

## Sources

- `reach.probe.mts` — every number above, re-runnable.
- `EXPLAIN (ANALYZE, BUFFERS)` against the live database, 2026-08-16.
- [pgvector 0.8.2 README](https://github.com/pgvector/pgvector) — HNSW defaults, `hnsw.ef_search`,
  `hnsw.iterative_scan`.
- [`docs/research/mnemosv2-fit.md`](mnemosv2-fit.md) §2, which proposed `hnsw.ef_search` as a named
  knob with a starting value of 128. Not applicable while the index is unreachable.

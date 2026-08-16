# Retrieval, and what `npm run qa` was actually measuring

**Supporting note for [issue-298-root-cause.md](issue-298-root-cause.md) — findings 1, 2 and 6.**
Read from source at `19c2f83` and from the saved `qa-report.txt`. Labels: **measured** (read off a
file), **inferred** (implied by the code, not demonstrated), **unverified** (needs a run this analysis
did not make).

The short version: the 29% / 22% headline is not a measurement of retrieval recall, and the
"fabrication" finding is an artefact of a render that cannot satisfy its own rubric. Retrieval does
have a real, cheap, testable defect underneath all of that.

---

## 1. What `find_positions` actually searches

Worth stating plainly, because the golden set's premise turns on it.

`find_positions` does **not** search items. It searches **Positions** — compiled, cross-item stances —
and reaches them through the items behind them. `matchingPositions` (`src/find.ts:798-839`) runs three
stages:

```sql
with hits as (   -- top 480 chunks by cosine distance, filtered by person/model/window/floor
     ... limit 480 ),
     items as ( -- collapse to items, best chunk each, keep 60
     ... limit 60 )
select p.* from braintrust_positions p
  join braintrust_position_citations pc on pc.position_id = p.id
  join items on items.item_id = pc.item_id
 where p.compile_id = $1
```

**A Position is returned only if it cites one of those 60 items.** The candidates are then re-ordered
by how close each Position's *own statement* sits to the query (`scoreStatements`, `src/find.ts:894-928`)
— which is [#140](https://github.com/cgbarlow/braintrust/issues/140), and which the file records as
lifting the "better of two positions first" rate from 51% (a coin) to 80%.

So the chain from a golden question to a "grounded" verdict has four places to break, and the harness
attributes all of them to ranking:

1. Does the query vector reach the asked-about item's chunks at all?
2. Does that item survive into the top 60?
3. Does any compiled Position cite that item?
4. Is that Position ranked first by statement similarity?

`src/qa/sample.ts` guarantees only that the item exists and was retrieved. **It guarantees nothing
about step 3.** The issue's claim that *"the corpus is guaranteed to have material for it"* is true of
the corpus and false of the layer being queried.

---

## 2. The golden question is the one string never embedded

**Measured.** Chunks are built from `body_text` and nothing else:

- `src/retrieval/store.ts:26-31` — `UnchunkedItem` selects `i.id, i.external_id, i.body_text, i.body_raw`.
- `src/retrieval/chunk.ts:87` — `chunkItem(body: ItemBody)` where `ItemBody = { text, raw }`.
- `braintrust_items.title` is a separate column (`src/ingest/items.ts:236-244`) and appears in no
  embedding path.

`src/ingest/blog-body.ts:194-195` states the design intent directly:

> **A post's own title can be stripped from its own body** by this, which is harmless: the title is a
> column of its own rather than [part of the body].

Harmless — until `src/qa/sample.ts:47` makes the title the query:

```ts
return rows.map((row) => ({ person, query: row.title, item_id: row.id, item_url: row.url }));
```

The consequence is worst exactly where the scores are worst. A YouTube title is engineered to be
distinctive and is often absent from its own transcript in any form:

> `"Grok 4 is "#1" but Real-World Users Ranked It #66—Here's the Gap"`
> `"OpenAI Just Launched 200 Prompts for Pros—They Will Destroy Your Career (Here's Why)"`
> `"Never Run claude /init"`

*(measured, from `qa-report.txt`)*. `nate-b-jones` is all YouTube and scores 1/10.
`stuart-winter-tear`, whose corpus is written long-form where a title's terms recur in the body,
scores 4/10 and 5/10 grounded — the best on the board. **That gradient is the shape of a
title-versus-body mismatch, not of a fleet-wide ranking collapse.** *(inferred)*

The embeddings model has a further, smaller version of the same problem. Qwen3-Embedding-0.6B is
asymmetric: its card specifies `"Instruct: {task_description}\nQuery:{query}"` on the query side and
*"No need to add instruction for retrieval documents"*, and states that omitting it costs roughly
**1–5% of retrieval performance** ([model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)).
`createEmbedder` (`src/retrieval/embed.ts:60-86`) sends raw text for both sides. That is a consistent
choice — the floor and the fit cut are both calibrated in the no-instruction regime, so nothing is
*wrong* — but it is 1–5% left on the table for one line of string concatenation, at the cost of a full
re-embed to keep both sides consistent.

---

## 3. `grounded` cannot count what it claims to count

**Measured.** `src/qa/score.ts:49-53`:

```ts
export function grounded(payload: FindPayload, itemUrl: string): boolean {
  const top = payload.positions[0];
  if (!top) return false;
  return top.citations.some((citation) => citation.url === itemUrl);
}
```

Three independent ways this returns `false` on a correct answer:

**a. It reads one position out of five.** `src/qa/run.ts:16-26` asks for `limit: ANSWER_LIMIT = 5`.
The right position ranked second scores as ungrounded.

**b. The citations were already truncated, by recency.** `withEvidence` bounds citations to
`DEFAULT_CITATIONS = 4` unless `full: true` (`src/find.ts:208`, `:992`), and `runQuestion` never passes
`full`. The order is `i.published_at desc nulls last` (`src/find.ts:959`). So a Position resting on 20
items shows the 4 most recent — and the item whose title asked the question is invisible unless it
happens to be among them.

**c. The URLs are from different columns.** The citation URL is `coalesce(pc.post_url, i.url)`
(`src/find.ts:954`), which resolves a batched Bluesky day to the individual post permalink. The golden
set stores `i.url` (`src/qa/sample.ts:34`). For any batched item, `===` can never be true.

**22% is a lower bound.** How far below the truth it sits is **unverified** and settled by one re-run
with `full: true` and a check across all returned positions.

---

## 4. The judge was asked to check a property the render withholds

**Measured.** The rubric (`src/qa/score.ts:19-22`) requires the reply to name

> a specific position **this person** is on record holding, backed by a real quote

`renderAnswer` (`src/qa/score.ts:25-41`) produces:

```
Position: <statement>
Fit: <fit> (similarity 0.xxx)
Citation: "<quote>" — <item_title>
```

`payload.subject` — the string `braintrust model of X`, which every payload carries by construction
(`src/disclosure.ts:20-22`) — **is never rendered.** The judge is being asked to confirm that a text
names a person, from a text that contains no person's name.

**5 of the 32 recorded failures say so explicitly** *(measured, counted over `qa-report.txt`)*:

> `nate-b-jones`, *"OpenAI Just Launched 200 Prompts for Pros"* — "The reply does not name a specific
> person's recorded position nor provide a verifiable quote **tied to that person**"

> `ethan-mollick`, *"Sign of the future: GPT-5.5"* — "an unverified position about GPT-5 **without
> naming a specific person**"

> `chris-barlow`, *"Welcome to Uncharted Quests"* — "describes product features rather than **naming a
> specific position a person holds**"

Then there is the question shape. `src/qa/run.ts:28` builds `Question asked: "<title>"`. A title is not
a question. *"Never Run claude /init"* is an imperative; *"Mass Intelligence"* is a noun phrase. The
rubric asks whether the reply is "a good-faith, on-topic answer to the question asked", and the judge
is instructed that **if it is arguable, answer false** (`src/interrogate/model.ts:43`). Against a bare
noun phrase, almost everything is arguable.

---

## 5. Fabrication is structurally excluded on this path

**Measured.** A citation's quote is not the model's string. `src/notes/verify.ts:104-110`:

```ts
verified.push({
  statement: claim.statement,
  quote: body.slice(span.start, span.end),   // the body's own characters
  ...
});
```

and `:14-15`: *"A quote that cannot be located is not a quote. The claim goes with it — dropped and
counted, never stored unverified."*

`src/compile/positions.ts:10-20` carries the guarantee forward:

> A Position is a grouping of claims braintrust already verified. The model is handed claim *refs* and
> may only copy them […] **A Position braintrust cannot cite is dropped**, the same rule as a claim it
> cannot quote.

So the eleven verdicts using *fabricated / unverifiable / unverified / questionable quote* language
*(measured, count over `qa-report.txt`; the issue reported ~8)* are the judge doing the only thing it
can with no source in front of it and an instruction to fail when unsure.

**One real defect survives, and it is a rendering choice.** `renderAnswer` shows `citations[0]` — the
Position's **most recently published** quote, not the one nearest the question. A Position spanning
eight items across two years, matched on item A, will be displayed with a quote from item H. *"the
cited quote does not support that claim"* is then a correct observation about a citation the harness
chose badly, not about a corpus.

This is invisible to users: `SPEAK_DO_NOT_RECITE` (`src/script.ts:365-391`) means a persona speaks no
quotations at all. It is visible to the judge, and to a reader who asks for the record.

---

## 6. The mechanism nobody has looked at: HNSW reach

**Inferred, unverified, and the cheapest thing on this list to settle.**

`schema.sql:206-207`:

```sql
create index if not exists braintrust_embeddings_hnsw_idx
  on braintrust_embeddings using hnsw (embedding vector_cosine_ops);
```

and the same for `braintrust_position_embeddings` (`:406-407`). **Nothing anywhere sets
`hnsw.ef_search`** *(measured — grep across `src/`, `schema.sql`, `supabase/` returns nothing)*.

pgvector's default is **40**, and its documentation is explicit that filtering happens after the scan
([pgvector README](https://github.com/pgvector/pgvector)):

> With approximate indexes, filtering is applied *after* the index is scanned […] with HNSW and the
> default `hnsw.ef_search` of 40, only 4 rows will match on average [for a filter matching 10% of rows]

Now read what braintrust asks for:

| Query | Rows requested | Filters applied after the scan |
|---|---:|---|
| `matchingPositions` hits (`src/find.ts:806-818`) | **480** | person, embedding model, date window, distance floor |
| `selectivity` field (`src/find.ts:1170-1182`) | **400** | person, embedding model, date window |
| `matchingPassages` (`src/find.ts:1263-1276`) | **60** | person, model, window, floor |

`braintrust_embeddings` holds every person's chunks in one table. With five people compiled, an HNSW
scan bounded at 40 returns ~40 global nearest chunks, of which a fraction belong to the person asked
about, *before* the floor cuts further. The code believes otherwise throughout —
`src/find.ts:82-95` reasons carefully about a 480-chunk pool against "the ~7,600 the measured Corpus
holds", and `src/find.ts:78` about "a four-hour lecture entered a 60-ticket draw". **Those numbers
describe an index that is not being asked to produce them.** *(inferred)*

If this is live it is upstream of three findings at once:

- **Finding 1** — a narrow pool means the asked-about item often never reaches the collapse.
- **Finding 6** — `selectivity().top` is the gate's input. Depress it and a covered topic fails the
  0.55 floor and returns nothing.
- **Finding 3** — and an empty answer is what makes the persona drop out of frame. See
  [issue-298-agent-compliance.md](issue-298-agent-compliance.md).

**This is not established.** Postgres may be choosing a sequential scan and computing exact distances,
in which case recall is perfect and slow, and this whole section is a no-op. That is a one-command
question:

```sql
EXPLAIN (ANALYZE, BUFFERS) <the matchingPositions query, one persona, one query vector>;
```

Run it before writing any patch. If the plan says `Index Scan using braintrust_embeddings_hnsw_idx`,
the fix is `SET LOCAL hnsw.ef_search = 500` inside the transaction and it costs **zero model calls**.
If it says `Seq Scan`, close the ticket and move on.

---

## 7. What #278 does and does not explain

[#278](https://github.com/cgbarlow/braintrust/issues/278) records that captions were withheld from the
job's egress for months, that videos were written off permanently, and that *"Nate B. Jones' corpus
alone has not moved since 2026-08-03."*

That explains why `nate-b-jones` is bottom of the table. It cannot explain `matt-pocock` at 3/10 or
`ethan-mollick` at 2/10, neither of whom has a known ingestion gap — the issue is right about that.
But the alternative it reaches for ("a ranking problem in the compiled corpus") is only one of the
four candidate mechanisms above, and it is the most expensive one to fix.

---

## What to do, in order

1. **`EXPLAIN` the retrieval query.** One command. Decides whether §6 is a fix or a no-op.
2. **Fix the harness** (§3, §4): `payload.subject` into `renderAnswer`; `grounded` across all returned
   positions with `full: true`; compare against `coalesce(post_url, url)`; draw the query from
   `braintrust_item_notes.claims[].statement` rather than the title. Zero new model calls, no human in
   the loop, and it is the only way any subsequent number means anything.
3. **Re-run and re-read.** Only then decide whether embedding the title alongside the body (§2) is
   worth a full re-embed.

**Do not add a reranking model call.** One extra call per question is a permanent per-question cost
paid to compensate for a query shape the harness chose and an index setting nobody set.

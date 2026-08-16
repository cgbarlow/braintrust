# Would MNEMOSv2 help with #298 / #299?

**Judged on technical merit alone.** Licence, repository age, star count and commit history are
explicitly **out of scope** for the verdict below, at Chris's direction; the provenance facts are
preserved in [a short section at the end](#provenance-facts-not-part-of-the-verdict) for the record but
drive nothing.

Assessed 2026-08-16 against [`ro0TuX777/MNEMOSv2`](https://github.com/ro0TuX777/MNEMOSv2) at `5d35dc0`,
read from source in a scratch clone. Nothing was built, installed or executed. Labels follow the house
convention: **measured** (read off a file), **inferred** (implied by what was read), **unverified**
(settled only by running something this assessment did not run).

---

## The call

**No — do not adopt the system. Steal three techniques, one of which is more valuable than anything in
my first pass.**

The recommendation did not change when licence and maturity were struck out. **The reasoning did,
completely, and so did the steal-list.** The first pass leaned on the licence as dispositive and then
treated the technical case briefly. Forced to carry the whole verdict, the technical case turns out to
be *stronger* against adoption than the licence argument was — because of two things I had not found
in the first pass:

1. **On braintrust's own backend, MNEMOSv2 reproduces braintrust's exact defect.** It has a
   first-class `hnsw_ef` control — and its pgvector tier **explicitly discards it**
   (`mnemos/retrieval/pgvector_tier.py:231-235`), then issues a plain `ORDER BY embedding <=> … LIMIT`
   with no `SET LOCAL hnsw.ef_search` (`:283-292`). #299's leading hypothesis for finding 1 is that
   retrieval under-reaches at pgvector's default `ef_search` of 40. MNEMOS under-reaches in the same
   place, for the same reason. *(measured)*

2. **MNEMOSv2's own benchmarks show its reranker making retrieval worse — twice, on both backends, in
   two independent runs.** `docs/benchmark.md:625-680`. Numbers below. That is a technical result about
   the technique, and it is the single most useful thing the repository contains for this decision.

**But the re-derivation also found something I under-sold.** MNEMOS has a **lexical retrieval lane** —
Postgres FTS over the chunk text, fused with the dense lane — and **braintrust has no full-text search
of any kind** *(measured — grep for `tsvector`, `to_tsquery`, `ts_rank`, `websearch_to` across
`schema.sql` and `src/` returns nothing)*. That is a real, unfilled gap that speaks directly to finding
1's actual defect, and braintrust could build it in its existing Postgres for a fraction of MNEMOS's
code. **That moved from a footnote to the top of the steal-list.**

So: **no on adoption, and steal more than I first said** — see
[the ranked steal-list](#what-is-worth-stealing-ranked).

---

## 1. The reranker versus finding 1 — the crux

**Answer: yes, it sits strictly downstream of braintrust's defect, and MNEMOSv2's own data says it
degrades quality anyway.**

### It is downstream, structurally

`CrossEncoderReranker.rerank(query, results, top_k)` takes a `List[SearchResult]` **already returned by
the dense lane** and reorders it (`mnemos/retrieval/cross_encoder.py:72-112`). The router calls it after
retrieval, on `candidates`, at a depth of 20–50 (`retrieval_router.py:305-330, 643-730`;
`policies/rerank_policy.yaml:15-19`). A cross-encoder cannot score a document it was never handed.
**An item that fell outside the ANN scan is invisible to it** *(measured)*. #299's hypothesis is
precisely that the right item never enters the candidate set — so the reranker is aimed at a stage
downstream of where the loss occurs.

### And it reproduces the upstream defect on braintrust's backend

This is the part that decides it. MNEMOS *does* treat HNSW reach as a first-class knob —
`budget_router.py:43-44` defines `HNSW_EF_DEFAULT = 128` and `HNSW_EF_FAST = 64`, and its degradation
ladder lists *"3. reduce hnsw_ef (default → fast)"* (`:9-24`). It threads the value as a reserved
filter key `__hnsw_ef__` (`retrieval_router.py:290`).

**That value reaches Qdrant and is thrown away by pgvector** *(measured)*:

- `qdrant_tier.py:435-451` pops `__hnsw_ef__` and builds `SearchParams(hnsw_ef=int(hnsw_ef))`.
- `pgvector_tier.py:231-235` skips it, with the comment: *"Budget-plan sentinels are **Qdrant-only
  knobs**; never let reserved keys reach the generic JSONB branch."*
- `retrieval_router.py:_budget_filter_overrides` confirms the intent in its docstring: *"Reserved
  filter keys consumed server-side by **qdrant_tier** (W6/W7)."*
- The pgvector query itself (`:283-292`) is `SELECT … FROM {table} {where_clause} ORDER BY embedding
  <=> %s::vector LIMIT %s` — a post-scan-filtered top-k with **no `SET LOCAL hnsw.ef_search`
  anywhere in the file**, against an index created `WITH (m = 16, ef_construction = 200)` (`:76-79`).

**So adopting MNEMOS on braintrust's pgvector would inherit finding 1's suspected cause unchanged.**
Adopting it on Qdrant would fix it — but so would one `SET LOCAL` line in `src/find.ts`, which is
#299's ticket 3 and costs nothing.

### Its own numbers say the reranker hurts

`docs/benchmark.md:598-680` — 79 real PDFs, 5,967 chunks, 50 queries, both backends, two independent
runs *(measured, as reported; see the caveat below)*:

| Backend | Baseline MRR@10 | rerank@20 | rerank@50 | rerank@100 |
|---|---:|---:|---:|---:|
| Qdrant | 0.1367 | 0.1017 (**−0.0350**) | 0.1119 (**−0.0248**) | 0.0835 (**−0.0532**) |
| pgvector | 0.1207 | 0.1017 (**−0.0190**) | 0.1019 (**−0.0188**) | 0.1019 (**−0.0188**) |

*"Reranking reduced MRR and nDCG at all tested depths for both backends. There is no depth that
delivered quality uplift with acceptable latency cost. The practical default from this run is no
rerank."* (`:639-644`). The rerun agrees (`:646-681`).

And the **cross-encoder** — the component actually wired to `use_reranker: True` — was benchmarked
separately with the same result (`docs/whitepaper.md:376-390`): baseline Qdrant MRR **0.5134** →
**0.3566** at depth 50 (**Δ−0.15**), nDCG flat at +0.00, p50 30.5 ms → 45.5 ms (**+15 ms**). Its own
conclusion: *"synthetic zero-shot reranking still shows baseline semantic dominance (negative MRR
uplift) … Dense-only remains the safe default path."*

**Two caveats I must state, because they cut in MNEMOS's favour.** First, the ColBERT run carries an
acknowledged implementation bug: *"Loader logs showed `colbert-ir/colbertv2.0` was loaded through
sentence-transformers with a mean-pooling fallback"* (`:644`) — i.e. a late-interaction model run as a
plain bi-encoder, so that negative result may measure a broken loader rather than the technique.
Second, the cross-encoder run is labelled *synthetic*. Neither caveat rescues the case: a technique
whose two available measurements are −0.035 and −0.15 MRR, at +15 ms and up to +237 MB VRAM, has not
earned a per-query cost in braintrust. **Unverified** whether it would behave differently on
braintrust's corpus; nothing here motivates finding out.

**Verdict on finding 1: the reranker is aimed downstream of the defect, and its own evidence is
negative. #299's ticket 3 — one `EXPLAIN`, then one `SET LOCAL hnsw.ef_search` — remains the correct
first move, and MNEMOS's `HNSW_EF_DEFAULT = 128` is a useful independent datapoint on where to set it.**

## 2. Titles are never embedded — does its indexing help?

**Answer: its indexing is identical to braintrust's on this axis and helps not at all. Its *lexical
lane* is a genuine partial answer, and it is the one real technical benefit in the repository.**

### The indexing path embeds content only

`qdrant_tier.py:365` — `texts = [e.content for e in engrams]`, then `self._embed_documents(texts)`
*(measured)*. Title, filename and every other field go into the Qdrant **payload** (`:370-390`), which
is filter-and-display metadata, not part of the vector. There is:

- **no field-weighted embedding** — nothing concatenates or weights a title into the embedded string;
- **no multi-vector / late-interaction indexing** on the production path (`experimental/colbert_tier.py`
  is the blocked lane);
- **no heading or title handling** of any kind.

**And there is no chunker in the library at all.** `/v1/mnemos/index` accepts documents whose `content`
the caller has already split (`service/app.py:2261-2276`). The only chunking code in the repository is
`tools/mnemos_research_intake.py:183` — `chunk_text(text, max_words=350, overlap_words=50)`, a naive
word-window splitter. braintrust's chunker is strictly better for braintrust's purpose: platform-derived
boundaries preserving `chunk.text === item.body_text.slice(char_start, char_end)`
(`src/retrieval/chunk.ts:16`), the invariant that makes a quote checkable without trusting the chunker.
**There is nothing to learn here and something to lose.**

### The lexical lane is the real find

`mnemos/retrieval/lexical_tier.py` builds a Postgres GIN index over
`to_tsvector('simple', coalesce(content, ''))` (`:79`) and searches it with `websearch_to_tsquery` +
`ts_rank_cd` (`:173-190`). `hybrid_fusion.py` and `qdrant_hybrid.py` fuse that with the dense lane;
the router tracks `lexical_only_candidates` / `semantic_only_candidates` / `union_candidates`
(`retrieval_router.py:256-270`), so the union genuinely **widens the candidate set** rather than
reordering it.

**braintrust has no full-text search at all** *(measured)*. That matters for finding 1 specifically:
a golden question *is* a title, and titles carry distinctive rare tokens — *"claude /init"*,
*"Mass Intelligence"*, *"Grok 4"* — which are exactly what lexical matching is good at and dense
embedding is worst at. Where those tokens recur in the body, a lexical lane retrieves the item the
dense lane missed.

**Where it would and would not help, honestly.** The gradient in #298's own data is the shape of this
problem: `stuart-winter-tear`, long-form prose whose title terms recur in the body, scores best (4/10,
5/10 grounded); `nate-b-jones`, YouTube clickbait titles often absent from the transcript entirely,
scores worst (1/10). **A lexical lane helps most where braintrust already does best and least where it
hurts most** *(inferred)*. It is additive, not a cure.

### And MNEMOS's own hybrid evidence is not evidence for braintrust's case

Gate C (`docs/benchmark.md:1089-1110`) ran hybrid on a real corpus and reported *"Quality class win
found: `False`"*, keeping semantic-only as the default. That looks like a direct negative — **and it is
not, for braintrust's query shape.**

The Gate C truthset has a query class literally named `title_named_artifact_lookup`, which is
promising until you read it *(measured —
`benchmarks/truthsets/gate_c_hybrid_queries.json`, 25 queries, 5 per class)*:

> *"Find details for clinical trial NCT-0187"* · *"Retrieve contract MN-2025-017 Section 7.1
> obligations"* · *"Locate migration notes for database migration v3.0"*

Those are **identifier lookups**, not natural-language titles. braintrust's titles are clickbait
sentences. Gate C tested whether lexical fusion beats dense on alphanumeric ID retrieval — a different
question, on a legal/medical/finance PDF corpus, with 5 queries in the relevant class.

**So Gate C is neither evidence for nor against a lexical lane in braintrust.** It is the closest thing
available and it does not transfer. Anyone citing it either way — including my first pass, which cited
it against — is overreading it. **Unverified**, and the only thing that would settle it is braintrust
running its own comparison, which is cheap because it owns the Postgres.

**A further caveat on all of the above numbers:** `benchmarks/outputs/` is in `.gitignore` (`:45`), so
**none of the raw artifacts behind `docs/benchmark.md` are in the repository** *(measured)*. Every
figure quoted in this note is as-reported in the Markdown, not independently recomputed.

## 3. What its own gates actually measured

Summarised above; consolidated here because these are technical results, in scope, and they are the
most decision-relevant content in the repository.

| Gate | What it measured | Result |
|---|---|---|
| **Track 2, ColBERT** (`benchmark.md:598-720`) | 79 PDFs / 5,967 chunks / 50 queries, rerank depth 20/50/100, Qdrant + pgvector, two runs | **Negative at every depth on both backends.** MRR −0.019 to −0.053. Caveat: mean-pooling loader fallback acknowledged (`:644`) |
| **Cross-encoder** (`whitepaper.md:376-390`) | `BAAI/bge-reranker-base`, synthetic workload | **Negative.** MRR 0.5134 → 0.3566 @50 (Δ−0.15); nDCG +0.00; +15 ms p50 |
| **Gate B, reference fidelity** (`benchmark.md:799-880`) | Whether MNEMOS's ColBERT agrees with the official `colbert-ai` reference | **Not passed** — the pass condition is that it *"no longer underperforms both trivial baselines (lexical-overlap and mean-cosine) on MRR@10"* (`:820`). It is still marked "Blocked" in `support_matrix.md:35` |
| **Gate C, hybrid** (`benchmark.md:1089-1110`) | Lexical+semantic fusion vs semantic-only, 25 queries in 5 classes, real PDF corpus | **No class-level win.** But the "title" class is identifier lookup — see above. Does not transfer |

**The honest reading:** MNEMOSv2 has tried the two techniques braintrust would want from it, measured
both, and shipped neither as a default. Its reranker underperforms trivial baselines by its own
reference gate. That is a genuinely valuable negative result and braintrust should take it as one.

## 4. The masking objection, restated as a failure-mode argument

**It stands, and it does not need the maturity argument.**

#299's shared cause A is a *failure mode*, not a quality judgement: braintrust's deployed configuration
silently diverged from its designed configuration and stayed diverged for three commits, because
nothing in the system compares the two. The technical property that produced it is **configuration that
lives outside the artefact it configures, with no reconciliation step.**

MNEMOSv2 has that property, and demonstrably: `mnemos/config.py:35` sets `use_reranker: bool = True`
while `mnemos/retrieval/policies/rerank_policy.yaml:3` sets `default: off` for the same subsystem
*(measured)*. Two files, one behaviour, disagreeing in the shipped tree. That is not an accusation
about the project's care — it is the same class of split-brain configuration #299 diagnosed, present in
the proposed remedy. Add 49 `MNEMOS_*` variables (`mnemos/config.py`) and 17 optional request knobs
(`service/app.py:2296-2312`) and the surface for it grows.

**The masking half is a measurement argument, and it is the sharper one.** #298's headline numbers are
the only quantitative signal braintrust currently has, and #299 established they measure something
other than their labels. Any change that moves those numbers without touching the five stale `SOUL.md`
files makes the drift *less* visible while it remains live — the inverted citation rule is invisible in
`npm run qa` today, and a retrieval change that lifted 29% would buy a false all-clear on the one
failure the product cannot bend on. **Fix the configuration, fix the harness, then re-measure.** That
ordering is #299's tickets 1 and 4, and it holds regardless of what any third-party component would
contribute.

## 5. Autonomy and first-run — unchanged, and both still disqualifying for adoption

- **Human in the loop, by design.** `service/app.py:2642-2657` — `/candidates/<id>/approve` requires a
  `governance_review_id`. `mnemos/cognitive/learning_boundary.py:130` — routing and template mutation
  are *"blocked until explicit governance review."* `docs/support_matrix.md:29` — governance modes stay
  off *"until corpus-specific thresholds and policy choices are validated"*, i.e. an operator tunes
  them per corpus. braintrust has no operator. These paths would have to be left unused, which means
  adopting the service and disabling its distinguishing layer.
- **First-run latency gate.** The reranker loads lazily inside `rerank()`
  (`cross_encoder.py:40-46, 81`), so the first query after a cold start pays a model download and load
  unless someone has called `POST /v1/mnemos/warmup` (`service/app.py:2246`). *Disclose, don't delay*
  is not satisfied by an operator remembering to warm a service.

## 6. Architecture — the mismatch that survives every other consideration

MNEMOS retrieves **chunks**. `find_positions` retrieves compiled **Positions** and reaches them
*through* the items behind them: top 480 chunks → collapse to 60 items → join to Positions citing those
items → re-rank by statement-space similarity (`src/find.ts:798-839, 894-928`). MNEMOS has no Position
layer and no statement-space ranking. Using it as the retrieval engine means fetching chunk hits over
HTTP, mapping them back to `braintrust_items`, then re-running the Position join and `scoreStatements`
locally anyway — so it would replace only the first stage, which is the stage #299 believes one
`SET LOCAL` fixes.

Its MCP server is worse as an integration point: nine tools, of which `write_observation`,
`record_decision` and `summarize_session_handoff` **write** (`mcp_servers/mnemos/server.py:130-213`).
Finding 4's confirmed root cause is that personas have too many tools in reach. Adding nine, four of
them writes, moves the wrong way and creates a failure class braintrust does not currently have.

---

## Finding by finding, as revised by #299

| # | The finding as #299 revised it | MNEMOSv2, on technical merit |
|---|---|---|
| **1** | Titles never embedded (`src/retrieval/store.ts:26-31`); `grounded` reads one position of five (`src/qa/score.ts:49-53`); `hnsw.ef_search` unset | **Partially relevant — one component, and not the one it advertises.** Its reranker is downstream of the defect and negative in its own benchmarks; its pgvector tier discards `__hnsw_ef__` (`pgvector_tier.py:231-235`) and so shares braintrust's defect. **Its lexical lane is a real, additive answer to the title half** — and braintrust has no FTS at all |
| **2** | **Refuted where measured** — a served quote is `body.slice()` (`src/notes/verify.ts:105`). Live risk is the stale `SOUL.md` | **Irrelevant.** Its evidence contract records spans and hashes; braintrust *verifies* the quote locates in the stored body and **drops the claim if it does not** (`src/notes/verify.ts:90-113`). braintrust's guarantee is the stronger one |
| **3** | Disclosure missing 8/15; correlate is the empty answer plus `SOUL.md.template:79-82` | **Irrelevant.** Nothing touches the Hermes system prompt. A second-order claim via better retrieval rests on finding 1, where its own evidence is negative |
| **4** | **Confirmed as filed.** One line per profile | **Irrelevant, and adoption inverts it** — nine more tools, four writes (`mcp_servers/mnemos/server.py:130-213`) |
| **5** | **Confirmed on the retrieval half.** A persona answered with no `find_positions` | **Partially relevant, as a design idea.** `usage_detector.py` labels retrieved items `used`/`ignored`/`contradicted`/`unknown` at zero model calls. Port the vocabulary, not the threshold |
| **6** | **Confirmed.** Cause is the gate (`src/unmeasured.ts:52`) or an under-fetching `selectivity()` | **Irrelevant to the cause, and hostile to the design.** No per-persona measured floor; its governance suppression needs per-corpus operator tuning (`support_matrix.md:29`) |
| **7** | **A missing state in the harness.** ~15 lines | **Irrelevant to the cause**, but its `budget_infeasible` honesty pattern (`budget_router.py:17-21`) is the same insight — see the steal-list |

---

## What is worth stealing, ranked

With adoption off the table, the question is which techniques port to Node/pgvector and what each costs
to build. **Every item below is zero additional model calls per query and fully autonomous.**

### 1. A lexical lane over `braintrust_chunks.text`, fused with the dense lane

**The biggest one, and new since my first pass.** braintrust has no full-text search
*(measured)*. MNEMOS's `lexical_tier.py:79, 173-190` is the whole recipe: a GIN index over
`to_tsvector`, a `websearch_to_tsquery` + `ts_rank_cd` query, and reciprocal-rank fusion with the dense
results. A title's distinctive tokens are exactly what this retrieves and dense embedding misses.

**Build cost: one migration (a GIN index on `braintrust_chunks`), ~60–100 lines** — a second CTE in
`matchingPositions` and an RRF merge before the item collapse in `src/find.ts:798-839`. No new
dependency, no new service; braintrust already runs Postgres.

**Caveat to carry:** MNEMOS's Gate C found no class-level win for hybrid — but on identifier lookups,
not natural-language titles, so it does not transfer. Treat this as a hypothesis to test against the
golden set *after* #299's ticket 4 makes that set measure what it says, not as a known win.

### 2. `hnsw.ef_search` as a named, budgeted knob — with a starting value

MNEMOS treats HNSW reach as first-class: `HNSW_EF_DEFAULT = 128`, `HNSW_EF_FAST = 64`
(`budget_router.py:43-44`). This is **independent corroboration of #299's ticket 3 hypothesis** from a
codebase that hit the same wall, and it supplies a defensible starting value — 128, against pgvector's
default of 40, where `src/find.ts` asks for 480 and 400 rows.

**Build cost: one `SET LOCAL` line**, exactly as ticket 3 already proposes. The steal is the number and
the confirmation, not the code.

### 3. One outcome vocabulary spanning the harness and the persona

`usage_detector.py:8-24` labels every retrieved item `used` / `ignored` / `contradicted` / `unknown`,
applying signals in descending confidence — explicit citation first, text overlap last — at zero model
calls. braintrust currently answers the same question with a judge model that cannot see the evidence
(#299's shared cause C).

**Do not port the 0.15 lexical-overlap threshold.** `SPEAK_DO_NOT_RECITE` (`src/script.ts:365-391`)
makes a *correct* braintrust answer a paraphrase, which that threshold would score `ignored`.
braintrust's highest-confidence signal is already free: `hermes-eval.py` prints the tool calls above
every failure line, so *"was `find_positions` called before answering"* is deterministic today.

**The convergence is the real value.** #299's ticket 5 proposes `could_not_be_asked` and ticket 6
proposes measuring "a persona that did not look". Those are **the same enum**, not two patches — one
outcome vocabulary spanning *the harness failed* / *the persona did not look* / *the persona looked and
ignored it* / *the persona used it*.

**Build cost: ~40 lines** across `scripts/hermes-eval.py` and `src/qa/score.ts`. Fold tickets 5 and 6
into one design.

### 4. A degradation ladder that never stops producing an answer

`budget_router.py:9-24` — an ordered ladder (drop rerank → shrink oversample → reduce ef → drop
rescore) that never degrades below a producible response, and sets `budget_infeasible=True` so the
caller *"can answer honestly rather than fail"*. That is the same philosophy as braintrust's
`nothing_matched` (`src/find.ts:358-395`), applied to latency rather than to relevance.

**Build cost: design pattern only, nothing to write today.** Worth remembering if retrieval ever grows
stages. Low priority.

### 5. How to evaluate a reranker without shipping one — if the question ever reopens

`rerank_policy.yaml:51-52, 57-70` specifies shadow mode: run the reranker, record whether the top-3 and top-10
changed, emit telemetry, **discard the ordering**. Plus a circuit breaker on timeout and error rates
(`rerank_policy.py:19-52`). That is how to measure a reranker's value at zero user-facing risk.

**Build cost: only worth it if #299's tickets 3 and 4 land and retrieval is still weak.** Both MNEMOS
measurements of reranking are negative, and #299 rejects the per-query call on cost grounds, so this is
a method to keep in a drawer rather than a thing to build. **Lowest priority.**

**Not worth stealing:** the chunker (a naive word-window in a tool, against braintrust's
checkable-quote invariant); the evidence-receipt contract (braintrust's verified-quote guarantee is
stronger); the governance suppression layer (needs per-corpus human tuning).

---

## What could not be verified

- **Whether a lexical lane would actually help braintrust's corpus.** The one relevant experiment
  (Gate C) tested identifier lookup, not natural-language titles. Settling it means braintrust running
  its own comparison — cheap, since it owns the Postgres, but it should wait for ticket 4 so the golden
  set measures what it claims.
- **Whether MNEMOS's negative reranker results generalise.** The ColBERT run has an acknowledged
  mean-pooling loader bug (`benchmark.md:644`); the cross-encoder run is labelled synthetic. Both point
  the same way; neither is conclusive.
- **Every benchmark figure quoted here.** `benchmarks/outputs/` is gitignored (`.gitignore:45`), so the
  raw artifacts are absent from the repository and the numbers are as-reported in Markdown.
- **Whether braintrust's HNSW index is being used at all, and at what `ef_search`.** Still one
  `EXPLAIN (ANALYZE)`, as #299 said. Nothing in this assessment changes that being the first move.

---

## Provenance facts (not part of the verdict)

Recorded because they were gathered, explicitly **excluded from the recommendation above** at Chris's
direction. Nothing in the technical assessment depends on them.

- **Licence:** no `LICENSE` file anywhere in the tree; GitHub API reports `"license": null`;
  `README.md:327` states *"This repository currently declares a proprietary license posture."*
  Practically, this means the steal-list items must be **re-implemented from the described technique**,
  not copied — which is what the build costs above assume in any case, since all five are Python→Node
  ports of ideas rather than transplants of code.
- **Age and activity:** created 2026-03-28; last commit `5d35dc0` on 2026-07-22; 205 commits on `main`;
  2 stars, 0 forks, 0 external contributors; 1 open issue.
- **Authorship:** `git shortlog -sne --all` attributes 226 of 234 commits to two identities sharing
  `cypress@testauditor.local`; four PR branches are named `codex/…`.
- **Engineering hygiene, which is genuinely good:** 132 test files (~26,400 lines), real CI
  (`.github/workflows/mnemos-gates.yml` runs contract validation, container build, health audit and
  smoke gates on every push and PR), an SBOM workflow, and a support matrix that publishes its own
  failed gates rather than hiding them. **That last property is why this repository was worth reading
  at all** — its negative results are the most useful thing it gave braintrust.

---

## Sources

**MNEMOSv2, at `5d35dc0` (2026-07-22)** — read in a scratch clone; nothing built, installed or run.
`README.md` · `docs/support_matrix.md` · `docs/benchmark.md` · `docs/whitepaper.md` ·
`docs/chat_integration_evidence_contract.md` · `benchmarks/truthsets/gate_c_hybrid_queries.json` ·
`docker-compose.yml` · `requirements.txt` · `.gitignore` · `service/app.py` · `mnemos/config.py` ·
`mnemos/retrieval/{cross_encoder,retrieval_router,budget_router,pgvector_tier,qdrant_tier,lexical_tier,hybrid_fusion}.py` ·
`mnemos/retrieval/policies/rerank_policy.{py,yaml}` · `mnemos/governance/usage_detector.py` ·
`mnemos/cognitive/learning_boundary.py` · `mcp_servers/mnemos/server.py` ·
`tools/mnemos_research_intake.py`

**In-repo, at `19c2f83`**
`src/find.ts` · `src/qa/score.ts` · `src/notes/verify.ts` · `src/retrieval/{chunk,store,embed}.ts` ·
`src/script.ts` · `src/unmeasured.ts` · `schema.sql` · `package.json` ·
[issue-298-root-cause.md](issue-298-root-cause.md) ·
[issue-298-retrieval-ranking.md](issue-298-retrieval-ranking.md) ·
[issue-298-agent-compliance.md](issue-298-agent-compliance.md)

**Related issues**
[#298](https://github.com/cgbarlow/braintrust/issues/298) ·
[#299](https://github.com/cgbarlow/braintrust/issues/299)

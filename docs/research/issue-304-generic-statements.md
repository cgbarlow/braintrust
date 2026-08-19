# A statement broad enough to match every question ranks first for every question

**Measured against the live database on 2026-08-18**, by the probes described below. One embedding
call per question, no judge calls, so every number here is reproducible without spending the
endpoint's serial budget. Nothing below is inferred from source.

The short version: **`find_positions` returns the right Position in the top five roughly half the
time and ranks it first roughly a quarter of the time, and the gap is not a retrieval failure.** A
small number of broadly-worded Positions win the top slot for almost every question asked of their
persona. Ranking is faithfully ordering statements that were written too generally to be orderable,
which puts the defect upstream of retrieval, in what the compiler writes down.

This displaces the reading that corpus coverage is the binding constraint. Coverage is real and
second-order — see §4.

> **Superseded in part, one day later — read §6 before acting on §4.** Coverage was not second-order,
> and it was not a property of the corpora. The compiler was discarding roughly half of every corpus
> after paying to read it, and §1's instrument could not tell an absent answer from a mis-ranked one.
> §1–§3 stand as measured; §4's ordering does not.

---

## 1. The top slot collapses onto a few statements

Ten golden questions per persona (`../src/qa/sample.ts`'s set — each question is one of that
person's own item titles), asking how many *distinct* Positions ever take first place:

| Persona | Distinct #1 across 10 questions | Right Position ranked #1 |
|---|---:|---:|
| stuart-winter-tear | 9 | 5/10 |
| matt-pocock | 8 | 2/10 |
| nate-b-jones | 8 | 2/10 |
| ethan-mollick | **4** | **1/10** |
| chris-barlow | **2** (of 5 questions) | 1/5 |

Ethan Mollick's ten questions collapse onto four answers, and `gpt-5-unprecedented-capabilities`
takes first place for four of them — including *"What it feels like to work with Mythos"*, *"Mass
Intelligence"* and *"Management as AI superpower"*. Distinct-answer count tracks answer quality
across the whole fleet.

The two ends of that table are the two ends of how their statements are written. Ethan Mollick's
read *"AI progress is jagged; bottlenecks and reverse salients shape advancement"* and *"GPT‑5
exhibits unprecedented autonomous capabilities"*. Stuart Winter-Tear's, at the top of the table,
read *"AI needs translators with operating authority"* and *"judgment relocation"*. A statement
about everything is close to every question.

## 2. The margins that decide the answer are noise

Asked *"A Guide to Which AI to Use in the Agentic Era"*, all five Positions shown grade `close` and
span 0.719 to 0.681 — under four hundredths across the entire answer. The right Position sits third
at 0.706, thirteen thousandths behind a statement about jaggedness.

The clearest single case, asked *"Giving your AI a Job Interview"*:

| Rank | Similarity | Statement |
|---:|---:|---|
| 1 | 0.715 | AI agents can produce near‑PhD‑quality academic papers from a few prompts |
| 5 | 0.628 | Standard benchmarks are insufficient; rigorous **job‑interview** style testing … |

The Position carrying the question's own words loses by 0.087 to one that shares none of them.

## 3. Two candidate fixes, both measured, both rejected

Recorded so neither is proposed a second time.

**A lexical signal in the ranking.** Adding keyword overlap to the sort moves the fleet from 11/45
to at best 14/45, and only at a weight where keywords overwhelm the semantic score outright; it
makes matt-pocock worse. The reason is a property of the eval, not of the product: the golden
questions are *item titles*, and a title (*"On Working with Wizards"*, *"Mass Intelligence"*) shares
almost no vocabulary with a propositional statement. There is nothing for a keyword to catch. The
patch was written, measured and reverted.

**Correcting for how close a Position sits to everything.** Ranking on `similarity − mean
similarity` — how *unusually* close this Position is to *this* question — is the right shape for the
§1 pathology and the numbers are the best seen: fleet 11/45 → 15/45 under leave-one-out, ethan-mollick
1/10 → 4/10, stuart-winter-tear 5/10 → 7/10. It is still not shippable, because **matt-pocock falls
to 0/10**: the per-Position mean is estimated from as few as one or two questions, which is not an
estimate. A production form would compute the baseline at compile time against a fixed background
probe set — `../src/compile/selectivity.ts` already keeps `ANCHOR` and `OFF_CORPUS_PROBES` for the
neighbouring calibration — rather than from the ten questions being scored.

Both are treatments for a symptom. Neither changes the fact that a statement matching every question
is doing what it was written to do.

## 4. What this displaces

[#303](https://github.com/cgbarlow/braintrust/issues/303) attributed 13 of 34 failures to items no
Position cites, and that is still true — nate-b-jones compiles a Position for 56% of what braintrust
read, matt-pocock 63%. But ethan-mollick cites **100%** of what it read and answers *worst* in the
fleet, and stuart-winter-tear cites 81% and answers *best*. Coverage does not predict quality.

Coverage adds candidates to a ranker that cannot yet order the ones it has, so it is the second bill
rather than the first.

## 5. A caveat on the measurement itself

Every number here, and in #303, scores a persona on **its own item titles**. Real readers do not ask
in titles, and §3 shows the choice is not neutral — it is what made the lexical fix untestable. The
golden-question set is measuring something no user does, and it should be understood before it drives
another decision.

## Reproducing

`reach.probe.mts` (checked in, from #303) produces the funnel and the coverage table. The §1 and §2
tables come from probes that capture the full candidate set once at `limit: 50` and re-rank it
offline, so a re-ranking experiment costs no embedding calls at all; they were run from a scratch
directory and are not checked in, being three short scripts over `findPositions`.

---

## 6. What it turned out to be — and where §4 was wrong

**Measured 2026-08-19, one day after everything above.** §4 concluded that coverage is the second
bill because ethan-mollick cites 100% of what it read and answers worst. That inference does not
survive asking *why* the other personas' coverage was low, and the answer is not that their corpora
have gaps.

`MAX_POSITIONS = 24` bounds one clustering **call**. It was also, silently, bounding the **layer**:
claims that no grouping in a pass absorbed were dropped where they stood, never offered to another
call and never counted. On matt-pocock — 308 claims across 41 read Items — a single pass absorbed 179
of them, and the serving Persona cited **26 of the 41**. Fifteen Items were fetched, chunked, read
and quoted into Notes, and no answer braintrust could give could reach them. Among them: *The 7
phases of AI-driven development*, *Ship working code while you sleep with the Ralph Wiggum
technique*, *Frontend is HARDER for AI than backend*. Not obscure asides — the recent, most-asked-about
half of the corpus.

This is the same defect behind the reported "nate-b-jones does not know about builder levels": the
item was fully read and cited by zero Positions.

**Re-offering the remainder until it is exhausted** (read-only experiment, nothing promoted; four
sweeps) took matt-pocock to 308/308 claims absorbed and 41/41 Items cited, in 95 Positions. Scored
against the serving compile on the natural-question set (§5's correction, `../src/qa/ask.ts`), same
embedder, same questions, same ranking:

| | grounded@1 | reached@5 | distinct #1 |
|---|---:|---:|---:|
| old (serving, 24 positions) | 3/10 | 3/10 | 8 |
| new (swept, 95 positions) | **5/10** | **8/10** | 9 |

**No question got worse.** Two went from miss to #1, three from miss to top-5.

The middle column is the finding. Old matt-pocock scored *identically* on grounded@1 and reached@5 —
when it missed, there was nothing in the layer to rank. New matt-pocock holds the material for 8 of
10. §1's pathology is real and unchanged; what §4 got wrong is the ordering. A ranker cannot be
blamed for failing to surface an answer that was never written down.

**Why §1's measurement could not see this.** Every probe above scores *which Position ranked first*.
A question whose answer is absent from the layer entirely reads as a ranking miss and is
indistinguishable from a question whose answer ranked second. The instrument had no term for "the
answer is not in here."

### Cost and residue

Sweeping multiplies **build** cost by the number of sweeps (matt-pocock: four calls where there was
one) and nothing else — serving returns the same handful of Positions per answer regardless of how
many exist. The recovered tail is thin: 54 of the 95 new Positions rest on a single claim and grade
`low`. That is not a dilution, because the tail was always the bulk — the old 24 were 18 `low` and 6
`moderate`, and the count of `moderate`-or-better is **6 either way**.

Two things this does not fix. **20 of matt-pocock's 61 fetched Items have no Notes at all** — a
separate gap, upstream of everything here. And the two questions still missed at rank 5+ are now
genuinely §1's problem: the material is present and ranked below better-worded generalities.

### A caveat that applies to every number in this file

The endpoint is **not deterministic at `temperature: 0`**. The same 308 claims, clustered twice
minutes apart, absorbed 179 claims once and 112 the other — 58% and 36%. Treat "roughly half of every
corpus is discarded" as the finding and neither figure as the measurement. The coverage results
(26/41 → 41/41 Items, 308/308 claims) are structural and not subject to this.

### Reproducing

`compare.mts` — builds the swept set for one person, scores it and the serving compile on the same
natural questions, and writes both sets to JSON. Checkpoints after every sweep, because a run that
dies in sweep 3 has already paid for one and two, and the endpoint will not reproduce them. Run from
a scratch directory; not checked in.

---

## 7. The ranker, after coverage was fixed

**Measured 2026-08-19.** §6 made the material present; this is what ordering it is worth. All numbers are
offline re-ranks over saved position sets — one batch of embedding calls, no model calls, nothing written.

§3 rejected a correction that ranks on `similarity − mean similarity` because the per-Position baseline was
estimated leave-one-out from the ten questions being scored, which sent matt-pocock to 0/10. **Estimating the
baseline from `OFF_CORPUS_PROBES` instead** — a fixed set of eight mundane questions no Person here publishes
about, identical for every question, known before any question is asked — removes that objection entirely.

On the two **swept** sets, where the material is present to be ranked:

| | grounded@1 | reached@5 |
|---|---:|---:|
| matt-pocock, raw cosine | 5/10 | 8/10 |
| matt-pocock, minus background | **7/10** | **9/10** |
| ethan-mollick, raw cosine | 5/10 | 6/10 |
| ethan-mollick, minus background | 5/10 | **8/10** |

On the five **serving** compiles, which are still truncated: fleet 15/45 → 17/45 grounded@1, 21/45 → 24/45
reached@5. **No persona got worse under this correction in any run measured** — swept or truncated.

**The small fleet gain is the finding, not a disappointment.** matt-pocock and nate-b-jones are *completely
unmoved* by any re-ranker, and both have the signature: grounded@1 equals reached@5 (3/3 and 4/4). When those
personas miss, there is nothing in the layer to reorder. Ranking work is capped by coverage, which is the
ordering §4 got backwards and §6 corrected.

*Rejected: blending lexical overlap.* §3 could not test it because the golden questions were titles. It is
testable now, and the answer is no: +0.20 lexical took matt-pocock 5/10 → 7/10 and ethan-mollick 5/10 →
**4/10**. A constant that helps one persona and hurts another is a tuning artefact.

### Reproducing

`rank.probe.mts` (new matt, with per-question ranks and what outranked the right answer), `fleet-rank.probe.mts`
(all five serving compiles), `swept-rank.probe.mts` (both swept sets). Scratch scripts, not checked in.

### The limit of every number in §6 and §7

These re-rank **all** of a persona's positions, where production first narrows candidates by chunk search and
ranks only the positions citing those items. The comparison between rankers is sound — same candidates, same
questions — but the absolute figures are not production's. What has not been measured is new matt through
`find_positions` itself, which needs the swept compile in the database.

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

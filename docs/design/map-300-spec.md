# The fleet answers a real question well, and the number saying so can be trusted

The build spec for [wayfinder map #300](https://github.com/cgbarlow/braintrust/issues/300). Every decision on
that map, written for an agent with no context. **The map decided; this is what gets built.**

Nothing here is speculative. Each section names the ticket that decided it, and the ticket carries the
measurement the decision rests on.

---

## 0. Read this first: the numbers in this spec are not on `main`

`fix/302-honest-qa-columns` and `fix/301-profile-rerender-safe` are **both unmerged**. `npm run qa` on `main`
runs the pre-#302 harness, which measures something other than its column headers.

Re-run 2026-08-17, same live corpus:

| harness | answered well | grounded | reached |
|---|---|---|---|
| `main` / `task/303-ef-search` (pre-#302) | 15/45 | 10/45 | — |
| `fix/302-honest-qa-columns`, run 1 | 20/45 | 10/45 | 21/45 |
| `fix/302-honest-qa-columns`, run 2 | 21/45 | 10/45 | 21/45 |

**Merging #302 is a prerequisite for everything below.** Nothing in this spec can be verified against an
instrument that does not exist on the branch being built.

---

## 1. Ranking — the answer rests on the item retrieval found

**Decided in [#311](https://github.com/cgbarlow/braintrust/issues/311).**

`scoreStatements` (`src/find.ts`) ranks candidate Positions on statement↔query similarity alone; the item
evidence — `min(items.distance)`, already in the row — survives only as a tie-break. A broad, central Position
therefore outranks the specific Position citing the item the question is about.

**Build:** rank on `0.6 * statement_similarity + 0.4 * (1 - distance)`, descending. The existing
`distance` → `item_count` → `slug` chain stays underneath, unchanged. A Position with no statement vector still
sorts last. Nothing is dropped; membership is still the floor, on Chunks, before this.

The weight is a **constant, not a per-Compile calibrated cut** — 0.3–0.6 all produce the same grounded count,
so it is a plateau and there is nothing to calibrate.

**Measured:** grounded 10 → 15 of 45, reached 20 → 22, five recovered, **none lost**. Zero model calls per
question, code-only, no schema.

---

## 2. The floor — a minimum under the calibrated value

**Decided in [#319](https://github.com/cgbarlow/braintrust/issues/319).**

**Build:** `floorFor` returns `max(measured, 0.52)`.

The premise that the floor should come *down* is wrong: lowering it recovers **zero** grounded answers at any
depth, while off-domain false answers rise from 3/30 to 16/30. Raising it as a **minimum** — not a flat offset
— is better on both axes at once.

| floor rule | grounded | reached | off-domain answered |
|---|---|---|---|
| today | 15 | 22 | 3/30 |
| **min 0.52** | **16** | **22** | **0/30** |
| min 0.50 | 15 | 22 | 1/30 |
| min 0.53 | 15 | 21 | 0/30 |

Safe band 0.51–0.52 with a visible cliff each side. It leaves the two well-calibrated personas untouched, which
a flat offset did not. Cost: `Withheld` 5 → 7. `Silence` does not move.

---

## 3. What a reader gets when braintrust has nothing to say

**Decided in [#305](https://github.com/cgbarlow/braintrust/issues/305) and
[#315](https://github.com/cgbarlow/braintrust/issues/315).**

Two related states, one voice.

**Empty answer (#305):** an empty answer never leaves the persona frame — disclosure, voice, honest footing,
and the nearest thing braintrust does hold, offered rather than a dead end. *Stop being the persona* comes out
of `SOUL.md` entirely. braintrust checks **character alongside honesty**, and the fault names which of the two
broke. Zero per-question cost; one nightly judge call per Persona.

**Uncovered item (#315):** the payload already knows an item was **retrieved and cited by no Position**. The
persona says so — *"I've read that one and haven't formed a position on it"* — and offers the nearest thing it
holds. Today the reader is handed an answer built on a different item with no sign the thing they asked about
was never compiled, and cannot tell *"I have nothing on this"* from *"here is my view on this"*.

**braintrust does not chase coverage.** 100% of retrieved items have notes and are chunked, every persona — it
is not a reading gap. braintrust read all 524 of nate-b-jones' items and wrote Positions citing 236. A
coverage target manufactures positions the person does not hold, which is the one failure the product cannot
afford.

This section is the reason §2's tightened floor is acceptable: it decides how the extra silence sounds.

---

## 4. Where the rules live, and how they stop drifting

**Decided in [#304](https://github.com/cgbarlow/braintrust/issues/304).**

`SOUL.md` stays canonical for Hermes and becomes **self-healing** rather than hand-patched. A daily job
re-renders every `bt-*` profile from the template and **reports in**, so braintrust tells **current** from
**stale** from **silent** — and silence is the alarm. The check rides the serving path, not a second scheduler
that can die quietly. Still wrong after a day files a fault on the existing ledger; the reader sees nothing.

No new secret: each profile's `config.yaml` already carries its own braintrust key.

Other clients are uncovered because their rules are served fresh on every connection and cannot drift.

**One human step, named:** a broken heal is on a host braintrust does not own, so the issue carries the command.

---

## 5. The instrument

**Decided in [#306](https://github.com/cgbarlow/braintrust/issues/306),
[#320](https://github.com/cgbarlow/braintrust/issues/320) and
[#313](https://github.com/cgbarlow/braintrust/issues/313).**

### 5.1 One vocabulary (#306)

One ordered ladder over a **question**, in the evals only — nothing served carries a label, because a real
reader's question has no answer key. Six free, mutually exclusive rungs:

**Silence / Uncovered / Withheld / Missed / Outranked / Grounded**

`reached` is Outranked + Grounded, derived not stored. **"The persona did not look" is not a rung** — the
scoring harness calls retrieval directly and can never see it.

### 5.2 The headline is `grounded`, not `answered well` (#320, #313)

- **An empty answer stops counting as *answered well*.** The rubric passes *"nothing matched"*, so braintrust
  is currently scored as having answered well a question it did not answer. Report it separately.
- **`grounded` on a covered denominator becomes the number the fleet is judged on.** Only **Uncovered** leaves
  the denominator. Silence, Withheld, Missed and Outranked all stay in — including the extra Withheld §2
  creates.
- **The judge's verdict stays beside it**, never as the bar. A magnet passes every reader-facing check:
  chris-barlow answered Parts 1, 2 and 3 of one series with the identical position and identical quote from a
  fourth post, and the judge passed all three.
- **#298's fabricated-quote finding is closed.** Every quote traces to a real stored item. The old judge cried
  fabrication because it had not been told whose positions it was ruling on.

### 5.3 A negative set (#319, #313)

The golden set **structurally cannot see a false answer** — every golden question has material by construction.
Add two negative sets and a column for them:

- **off-domain**: questions no persona has material for. Current fleet answers **3/30**; the decided stack
  answers **0/30**.
- **near-miss**: each persona asked another persona's titles.

### 5.4 Sizes and cost (#313)

`grounded` needs **no judge call**. Measure it over **every titled retrieved item**, not a sample of ten — the
covered denominators today are 3 for matt-pocock and 3 for nate-b-jones, too few to bar on. Keep the judge's
~10 per persona for the column beside it.

The corrected instrument is **stable to ±1/45** across three runs; the pre-#302 harness swung ±4.

### 5.5 The bars (#313)

| bar | rule | today |
|---|---|---|
| **grounded** | ≥ **70%** of covered questions, **per persona** | 1 of 5 personas clears it |
| **false answers** | **zero** on the off-domain set | 3/30 → 0/30 on the decided stack |
| **coverage** | reported, never barred | nate 45%, matt 63%, stuart 81%, ethan 100%, chris 100% |

Never a fleet average: 52% hides stuart at 80% and ethan at 20%, and a reader meets one persona.

**A persona below the bar keeps answering.** Bookkeeping never stops a persona answering and no gate lands on a
first run. It opens a fault; the per-answer honesty is already §3's.

---

## 6. Guarantees on the fault rail

**All of these are named assertions on the existing `braintrust_faults` registry.** One row per live fault,
deduplicated, opening one issue, escalating after a day, cleared by a passing check. `braintrust_silences` is
the separate ledger for a check that could not be asked. **No new plumbing, and none of them stops a persona
answering.**

| assertion | fires when | cost | decided in |
|---|---|---|---|
| fleet reported in | a profile is stale, or the healer is silent | free | [#304](https://github.com/cgbarlow/braintrust/issues/304) |
| empty answer in voice | a persona drops character or honesty when empty | 1 judge call per persona, nightly | [#305](https://github.com/cgbarlow/braintrust/issues/305) |
| corpus size | embeddings for the serving model cross **40,000 vectors** | free (SQL) | [#316](https://github.com/cgbarlow/braintrust/issues/316) |
| coverage | a persona's covered fraction falls too low | free (SQL) | [#315](https://github.com/cgbarlow/braintrust/issues/315) |
| grounded bar | a persona is below 70% grounded on covered questions | free (no judge) | [#313](https://github.com/cgbarlow/braintrust/issues/313) |
| statement supported | a Position's statement is not carried by its own citations | 1 judge call per **new** Position | [#320](https://github.com/cgbarlow/braintrust/issues/320) |

---

## 7. Decided against — do not build these

| | why | decided in |
|---|---|---|
| **A lexical / full-text lane, and a GIN index for it** | The `Missed` bucket collapses 5 → 1 under §1 and §2. A hand-pasted schema change and its outage window, for one question in 45. | [#307](https://github.com/cgbarlow/braintrust/issues/307) |
| **Putting titles into what gets embedded** | Unmeasurable on this instrument: a golden question *is* the item's title, so it scores spectacularly by construction. Rejected for want of an instrument, not on merit. | [#307](https://github.com/cgbarlow/braintrust/issues/307) |
| **Tuning `hnsw.ef_search`** | The index is never scanned. Retrieval is already exact. | [#303](https://github.com/cgbarlow/braintrust/issues/303) |
| **Reshaping the query to reach the HNSW index** | Would make retrieval approximate again, re-opening `ef_search` and re-basing every number in this spec. | [#316](https://github.com/cgbarlow/braintrust/issues/316) |
| **Dropping the HNSW index** | 65 MB and some write cost does not buy a hand-pasted schema change. Drop it as a passenger on the next schema change that has its own reason. | [#316](https://github.com/cgbarlow/braintrust/issues/316) |
| **A model reranker** | Costs a model call per question. The map's standing rule prices calls per question first, and the three highest-value interventions so far cost zero. | map #300 |
| **Chasing corpus coverage** | Manufactures positions the person does not hold. | [#315](https://github.com/cgbarlow/braintrust/issues/315) |

---

## 8. What is still open

- **The magnet.** A Position written broadly enough to be the best answer to questions it does not answer.
  Ranking has taken what it can (§1), the quotes are real (§5.2), and the cause sits in what was compiled —
  out of scope on map #300. Under §5.2 it at least stops scoring as a good answer.
- **A reader-phrased question set.** Every question in the instrument is an item's own title. That is
  deliberate, and it is why §7 cannot price title-embedding and why §5.3 needed a negative set bolted on.

---

## 9. Order of build

```
merge #302 + #301  ─┬─→  §1 rank  ──┬─→  §5 instrument  ──→  §5.5 bars  ──→  §6 grounded-bar fault
                    │               │
                    └─→  §2 floor ──┘
                    
independent:  §3 voice/uncovered · §4 SOUL heal · §6 corpus-size · §6 coverage · §6 statement-supported
```

§1 and §2 both change what the candidate set contains, so **each re-bases *answered well* and needs a fresh
before-run**. A full judged run is ~45 calls and ~15 minutes, serial. Do them in this order and pay that cost
twice, not five times.

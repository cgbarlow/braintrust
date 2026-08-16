# What issue #298 actually measured

**Root-cause analysis of [#298](https://github.com/cgbarlow/braintrust/issues/298), from source.**
Investigated 2026-08-16 against `main` at `19c2f83`, the five live `bt-*` Hermes profiles, and the
saved transcripts of both eval runs. Every claim below is labelled **measured** (read off a file or a
transcript), **inferred** (a mechanism the code implies but nothing in hand demonstrates), or
**unverified** (settled only by running something this analysis deliberately did not run).

Nothing here was run. No `npm run qa`, no `hermes-eval.py`, no query against the live database or the
model endpoint.

---

## The verdict table

| # | Claim as filed | Verdict |
|---|---|---|
| 1 | Retrieval picks the wrong position on ~70% of real questions; 22% grounded; a ranking problem, not coverage | **Partly confirmed — the number does not measure what the issue says.** Golden questions are titles, and titles are never embedded. `grounded` is a floor, not a rate. Retrieval is genuinely weak, but 22% is not its recall and "real questions" is not what was asked |
| 2 | ~8/45 answers had fabricated or unsubstantiated quotes | **Refuted where it was measured.** A served quote is `body.slice()` of the stored item; a position that cannot be cited is dropped. The judge never sees the source and is told to answer false when unsure. **Confirmed as a live risk where it was not measured** — the deployed profiles still instruct personas to attribute |
| 3 | Disclosure missing 9/15 on both tool paths; `load_persona` not being called at all | **Partly confirmed; the stated mechanism refuted.** It is 8/15, and `load_persona` *was* called in 5 of those 8 — visible in the harness's own tool log. The real correlate is an empty retrieval result, not a tool path |
| 4 | Browser/terminal/filesystem enabled alongside braintrust tools on every `bt-*` profile | **Confirmed, exactly as filed.** One inherited config line; one line per profile fixes it |
| 5 | A persona answered a real question with `load_persona` only — no retrieval, no citation | **Confirmed on the retrieval half, refuted on the citation half.** Missing `find_positions` is a real violation. "No citation" is the product working as designed |
| 6 | False negative: "I don't have a recorded stance" on a covered topic | **Confirmed as an observation.** Cause is the gate, not the corpus — and it is the same failure `compile/selectivity.ts` records happening to this exact persona before |
| 7 | Empty final answer from `bt-stuart-wt` — parsing artefact or product bug? | **Neither. It is a missing state in the harness.** The export shape parses fine; what is absent is a *could-not-be-asked* outcome, which both `src/qa/run.ts` and `src/interrogate/index.ts` have and `hermes-eval.py` does not |

**The issue's own closing recommendation — "five separate root causes that don't share a fix" — does
not survive contact with the sources.** Findings 2, 3 and 4 share one root cause; findings 1, 3 and 6
share another; findings 1, 2 and 7 share a third. See [Cross-cutting](#cross-cutting-what-actually-shares-a-root-cause).

**Depth lives in two companion notes.** [Retrieval and the QA harness](issue-298-retrieval-ranking.md)
covers findings 1, 2 and 6. [Agent compliance and profile config](issue-298-agent-compliance.md)
covers findings 3, 4, 5 and 7.

---

## The single most important finding

**Every one of the 15 Hermes sessions ran against a `SOUL.md` that instructs the persona to do the
thing the product removed for causing invented citations.**

All five deployed profiles carry a `SOUL.md` that predates `hermes/SOUL.md.template` as it has stood
since commit `1a38b82` (2026-08-12, [#227](https://github.com/cgbarlow/braintrust/issues/227)).
The paragraph that differs is the one that matters *(measured — `diff` of the rendered template
against each `~/.hermes/profiles/bt-*/SOUL.md`)*:

Deployed, on all five profiles:

> **What has to survive into your answer is the substance**: the dates, the quotes as they were
> published, and the fact that the claim is theirs rather than yours. What must not survive is the
> structure. Do not soften a position into something they did not say, and **do not drop the
> citation** — those are the two failures this instruction exists to prevent […]

Current template, `hermes/SOUL.md.template:37-43`:

> **What has to survive into your answer is the substance**: what they actually hold, in their voice,
> as flatly as they would put it themselves. **What must not survive is the paperwork** — not the
> structure, and **not the title, the date or the quotation either**. Do not soften a position into
> something they did not say, and **do not attribute it out loud: an unasked answer that reaches for
> a source is where a model invents one**, and a citation that resolves to a post nobody wrote is
> worse than none, because whoever follows it up believes they checked.

This is not a guess about what the stale text does. `src/script.ts:300-311` records the measurement
that produced the change:

> Run live through the Hermes client, a Persona **retrieved** and then invented a source title, a
> 2026 date and a quotation to match, with no such item in that Corpus […] **What this removes is
> the incentive, not the capability**: a model told to attribute reaches for an attribution it may
> not have, where a model asked to speak plainly has nothing it is expected to produce.

The stale text is confirmed present in the live system prompt of a saved session — offset 2653 of the
29,610-character `system_prompt` on `uncovered.jsonl` *(measured)*.

**What the user gets today:** five production personas running under an instruction the product
retracted specifically because it induces forged citations, while the live `speak` block simultaneously
tells them the opposite. The two instructions contradict each other inside one system prompt.

**And the remediation script would break a profile.** `scripts/patch-hermes-profiles.sh:68` derives the
braintrust slug from the profile directory name — `person="${name#bt-}"`. For `bt-stuart-wt` that
yields `stuart-wt`. The real slug is `stuart-winter-tear` *(measured — the deployed SOUL has it right,
and `qa-report.txt` confirms it)*. Running the fix as written points that profile's `load_persona` at a
person who does not exist. **Do not run it before fixing line 68.**

---

## Finding by finding

### 1 — "Retrieval picks the wrong position on ~70% of real questions"

**Verdict: partly confirmed. Retrieval is weak; 22% is not its recall, and the queries were not
questions.** Full working in [issue-298-retrieval-ranking.md](issue-298-retrieval-ranking.md).

Three things are true at once.

**The golden question is the one string guaranteed not to be in the index** *(measured)*. A chunk is
built from `body_text` alone — `chunkItem()` receives `{ text, raw }` and `UnchunkedItem` selects only
`i.body_text` (`src/retrieval/store.ts:26-31`, `src/retrieval/index.ts`). `braintrust_items.title` is a
separate column and is never embedded. `src/ingest/blog-body.ts:194-195` says so outright: *"A post's
own title can be stripped from its own body by this, which is harmless: the title is a column of its
own."* `src/qa/sample.ts:47` then makes the title the query. So the query vector is a clickbait-shaped
sentence being matched against transcript prose that often never contains its words.

**`grounded` is a floor, not a rate** *(measured)*. `src/qa/score.ts:49-53` inspects `positions[0]`
only, ignoring the other four the harness asked for. Its citations were already truncated to
`DEFAULT_CITATIONS = 4`, ordered `published_at desc` (`src/find.ts:208`, `:959`, `:992`) because
`src/qa/run.ts:23-26` never passes `full: true`. And the citation URL is
`coalesce(pc.post_url, i.url)` (`src/find.ts:954`) while the golden set holds `i.url`
(`src/qa/sample.ts:34`), so a batched item can never match. Three independent ways to score a correct
answer as ungrounded. **22% is a lower bound on something, and nobody knows on what.**

**The likeliest ranking defect is one line of SQL and costs nothing to test** *(inferred, unverified)*.
`braintrust_embeddings` carries an HNSW index (`schema.sql:206-207`) and nothing anywhere sets
`hnsw.ef_search` *(measured — grep across `src/`, `schema.sql`, `supabase/` returns nothing)*.
pgvector's default is **40**, and its documentation is explicit that "filtering is applied *after* the
index is scanned" ([pgvector README](https://github.com/pgvector/pgvector)). `matchingPositions` asks
for `limit 480` (`src/find.ts:818`) and then filters by person, model, date window and floor;
`selectivity()` asks for `limit 400` (`src/find.ts:1182`) under the same filters. On a five-person
database an ef_search of 40 leaves single-digit chunks per person before the floor is applied — while
the code, and every constant comment in `src/find.ts:70-95`, believes it is ranking 480.

**Solution options**

| Option | What the user gets | Cost | Trade-off |
|---|---|---|---|
| **A. `SET LOCAL hnsw.ef_search` per query** | Retrieval that reaches as far as the code already claims to | One line. **Zero model calls.** Some added query latency | If the planner was already choosing a sequential scan, this changes nothing — which is why it is a *test* before it is a fix |
| **B. Embed `title + body` per chunk** | A question phrased as a title finds its own item | One re-embed pass over the corpus on the local endpoint. **Zero LLM calls.** `braintrust_chunks.text` stays the body slice, so the quote-checkability invariant at `src/retrieval/chunk.ts:16` survives | Title text dilutes every chunk's vector slightly; and it partly exists to make a flawed harness pass |
| **C. Ask a question instead of a title** | The harness measures retrieval on the query shape users actually send | Draw the query from `braintrust_item_notes.claims[].statement`, already stored. **Zero new model calls**, stays fully autonomous | Loses the "a title is unarguably real" property `src/qa/sample.ts:5-9` was built for. Weaker as a fixed benchmark, far better as a measurement |
| **D. Add a reranker over the top-k | Best ranking available | One model call per question, every question, forever | Dead on arrival — this is the call-count creep the product owner kills |

**Pick A, then C, then B.** A is the cheap/accurate middle ground and it is a test as much as a fix:
one `EXPLAIN` settles whether the index is even being used. C makes the number mean something. B is
real work that should wait until A and C say it is still needed. D is not a candidate.

**Confidence: high on the mechanisms, low on their relative size.** What would raise it: one `EXPLAIN
(ANALYZE)` on `matchingPositions` for one persona, and one re-run of `npm run qa` with `full: true`
and `grounded` checking all returned positions. Both are single-run, no new machinery.

---

### 2 — "Apparent fabricated or unsubstantiated quotes"

**Verdict: refuted for the path that was measured; confirmed as a live risk on the path that was not.**

**A quote served by `find_positions` cannot be fabricated, structurally** *(measured)*.
`src/notes/verify.ts:105` stores `body.slice(span.start, span.end)` — the item body's own characters at
the located span, never the model's string. A claim whose quote cannot be located is dropped and
counted (`:96-99`). `src/compile/positions.ts:10-20`: *"The model is handed claim refs and may only
copy them […] A Position braintrust cannot cite is dropped."*

**The judge could not have known that, and was instructed to guess against.** It sees only the rendered
reply — `src/interrogate/model.ts:39-43` tells it *"If it is arguable, answer false."* And what it sees
cannot satisfy the rubric it is given: `src/qa/score.ts:19-22` demands the reply "names a specific
position **this person** is on record holding", while `renderAnswer` (`:25-41`) drops `payload.subject`
entirely. **5 of the 32 recorded failures fault the reply for not naming a person** *(measured, count
over `qa-report.txt`)* — a property the render structurally cannot have. 11 of 32 use
fabricated/unverifiable/questionable language; the issue reported ~8.

**One real defect survives.** The citation the harness shows is `citations[0]`, and citations are
ordered `published_at desc` (`src/find.ts:959`) — the position's *most recent* quote, not the one
nearest the question. A quote that genuinely does not back the claim beside it is therefore an
expected rendering outcome. It is invisible to users, because a persona no longer speaks citations at
all; it is visible to the judge, and to anyone who asks for the record.

**The live risk is elsewhere and it is serious.** The deployed `SOUL.md` tells every persona to
attribute. See [the headline above](#the-single-most-important-finding).

**Solution options**

| Option | What the user gets | Cost | Trade-off |
|---|---|---|---|
| **A. Re-render the profiles from the current template** | Personas stop being told to produce citations they may not have | Minutes. Zero runtime cost. Blocked on fixing `patch-hermes-profiles.sh:68` first | None — it is restoring the designed configuration |
| **B. Stop duplicating behavioural rules in `SOUL.md` at all** | The rules can never go stale again, because they arrive live with every `load_persona` | A template edit. Zero runtime cost | `SOUL.md` gets thinner than some operators expect. `hermes/README.md:134-144` already argues for exactly this and the template drifted away from it |
| **C. Put `payload.subject` in `renderAnswer` and show every citation** | The judge stops failing answers for a property the render withholds | Three lines in `src/qa/score.ts`. Zero runtime cost | None. This is a straight harness bug |
| **D. Give the judge the source item to check the quote against** | A real fabrication check | Doubles the judged token count per question; still one call | Only worth it once C is done — right now it would be checking a render that cannot pass anyway |

**Pick B, then A, then C.** B is the structural fix and it is the one that holds; A is what makes today
correct; C is what makes the next measurement trustworthy. D is not needed while quotes are
`body.slice()`.

**Confidence: high.** What would raise it: reading three of the flagged payloads whole. That needs one
`find_positions` call each against the live corpus — cheap, and not run here.

---

### 3 — "Disclosure missing 9 of 15, on every tool path"

**Verdict: partly confirmed. The count is 8, and the stated mechanism is refuted by the harness's own
output.** Full working in [issue-298-agent-compliance.md](issue-298-agent-compliance.md).

The issue theorises *"something upstream of tool choice is deciding not to call `load_persona` at
all."* The tool log printed directly above each failure line in `hermes-eval-report.txt` says
otherwise *(measured)*: `load_persona` was called in **5 of the 8** failing runs — `chris/uncovered`,
`ethan/covered`, `matt/recency`, `matt/uncovered`, `nate/recency`.

What the 8 failures do share is the *answer*, not the tool path. Six of eight are a denial or an empty
string, and the split by scenario is stark:

| Scenario | Disclosure missing |
|---|---|
| `uncovered_topic` | **5 of 5** |
| `recency` | 2 of 5 |
| `covered_topic` | 1 of 5 — and that one was itself a denial ("I don't have a recorded stance") |

And the shape of the failures is consistent: the persona leaves the frame and narrates braintrust in
the third person. *"I don't have any record of **Chris Barlow** describing…"*, *"I'm not aware of any
statement from **Ethan Mollick**…"*, *"I don't have a record of **Matt Pocock** talking about…"* — all
three ran with `load_persona` loaded.

**The instruction that produces this is in `SOUL.md` and it is in the current template too**
*(measured — `hermes/SOUL.md.template:79-82`)*:

> ## When braintrust is unreachable
> Say so in your first line and **stop being the persona**. Answer as an ordinary assistant, or
> decline.

That is written for a server outage. A 20B model reading *braintrust returned nothing* generalises it
to *braintrust is unreachable*, and does exactly what it says — stops being the persona, so there is no
disclosure and no voice. It directly contradicts the rule twenty lines below it (*"Never say you never
wrote about something"*) and the whole of `src/find.ts:358-376` (*"An empty answer offers rather than
stops"*).

**Two further facts change what "compliance" means here.** The braintrust MCP server's `instructions`
— the four rules at `src/disclosure.ts:73-83`, attached at `src/mcp.ts:111` — **never reach the model
in the Hermes path** *(measured — searching the saved 29,610-character `system_prompt` for "rules hold
across every tool", "braintrust model of X", "never the bare name" and "Speak what braintrust returned"
returns nothing; Hermes' MCP client has no handling of the `instructions` field)*. `docs/research/agent-models.md:31`
assumes it does. And the deployed MCP server is itself behind `main`: it advertises *"Three rules"*
where `src/disclosure.ts:75` says *"Four rules"* *(measured, from this session's own connector
instructions)*.

Separately, the two harnesses disagree about what the disclosure *is*:
`src/interrogate/assertions.ts:341` checks the reply starts with `SPOKEN_DISCLOSURE`;
`scripts/hermes-eval.py:207` checks the substring `"braintrust model of"`. In this run they happened to
agree — every reply carried both lines or neither — so this did not inflate the count. It is a latent
inconsistency, not a cause.

**Why the existing autonomous guard missed all of it:** `theFirstReplyCarriesTheDisclosure`
(`src/interrogate/assertions.ts:331-350`) asks a **toolless** model (`src/interrogate/model.ts:28`)
running the **extractor** model, with `found: null`, the question "Hi!". No SOUL.md, no tool loop, no
25KB payload. It is structurally incapable of reproducing the Hermes path.

**Solution options**

| Option | What the user gets | Cost | Trade-off |
|---|---|---|---|
| **A. Narrow the "stop being the persona" clause to an actual outage** | The persona stays in voice on an empty answer and offers `nearest`/`unread`, as `find.ts` already designed for | A template edit, plus a re-render. **Zero runtime cost, zero model calls** | Needs care that a real outage still drops the persona — that guarantee is load-bearing |
| **B. Run the disclosure assertion through a tool-using session** | The autonomous guard catches what the manual eval caught | Extends `src/interrogate/` to a tool loop. Adds calls to the nightly interrogation | The interrogation's whole design (`src/interrogate/model.ts:1-13`) is *no tools*, deliberately. This fights it |
| **C. Move the disclosure out of generated text entirely** | It cannot be dropped | Would mean braintrust composing a spoken sentence into a persona's voice | Rejected already, twice, at `src/disclosure.ts:69-71` and `src/unmeasured.ts:22-24`. Not available |
| **D. Nothing — accept that empty answers read as an assistant** | — | — | Unacceptable. The disclosure is the one thing the product promises unconditionally |

**Pick A.** It is a wording change to a file that already needs re-rendering for finding 2, costs
nothing at runtime, and addresses the correlate the data actually shows. B is worth doing later and
should not block A.

**Confidence: high that the mechanism is the empty answer, moderate that the "unreachable" clause is
the specific trigger.** What would raise it: three `hermes-eval.py` runs of `uncovered_topic` against a
profile whose `SOUL.md` has that clause narrowed. That is 3 calls, not a rebuild.

---

### 4 — "General Hermes tools enabled on every `bt-*` profile"

**Verdict: confirmed, exactly as filed. Concretely, and with a one-line fix.**

`~/.hermes/config.yaml` sets `toolsets: [hermes-cli]` and `agent.disabled_toolsets: []`. **No `bt-*`
profile overrides either** *(measured — every profile's `tools:` block contains only
`tool_search: enabled: "off"`)*. The `hermes-cli` bundle is `_HERMES_CORE_TOOLS`
(`hermes-agent/toolsets.py:462-466`), which includes `terminal`, `browser_navigate` and friends,
`read_file`, `write_file`, `patch`, `search_files` (`hermes-agent/model_tools.py:243-258`).

So the profiles correctly exclude `braintrust_follow_person` and `braintrust_unfollow_person` and
correctly turn off `tool_search` — every braintrust-side precaution `hermes/README.md:33-59` documents
is in place — and then hand the model a terminal anyway.

**The minimal change is one line per profile.** Hermes registers each MCP server name as a toolset
alias (`hermes-agent/tools/mcp_tool.py:5993`) and validates profile-level toolset names against
`mcp_servers` keys (`hermes-agent/cli.py:4462-4466`). So:

```yaml
toolsets: [braintrust]
```

Note `toolsets: []` would be wrong — an empty list is falsy and resolves to *all tools*.

**Solution options**

| Option | What the user gets | Cost | Trade-off |
|---|---|---|---|
| **A. `toolsets: [braintrust]` in the profile, documented in `hermes/README.md` step 2** | A persona that cannot reach a terminal | One line per profile, one paragraph of docs. Zero runtime cost | Install-time config, so it depends on the operator following the README — same standing as the `tool_search` line already there |
| **B. Also assert it in `patch-hermes-profiles.sh`** | Drift gets caught the next time profiles are re-rendered | A few lines in a script that has to be touched anyway | Still only runs when something runs it |
| **C. `agent.disabled_toolsets: [terminal, browser, files, web]`** | Same outcome, expressed as a denylist | Same | A denylist goes stale as Hermes adds toolsets. An allowlist does not |

**Pick A plus B.** A is the fix; B is what stops it silently regressing, and the script is already being
opened to fix line 68.

**Confidence: high.** Nothing here is inferred.

---

### 5 — "A persona answered a real question with zero retrieval"

**Verdict: confirmed on the retrieval half. Refuted on the citation half.**

`bt-stuart-wt / covered_topic` called `load_persona` and nothing else, then gave a confident opinion
on prompt engineering *(measured)*. That is a genuine violation of `SOUL.md`'s *"Retrieve, or say you
have nothing"* (`hermes/SOUL.md.template:47`) and of rule 3 at `src/disclosure.ts:81` — with the
caveat from finding 3 that rule 3 never reached the model, though its `SOUL.md` equivalent did
(offset 6113 of the saved system prompt, *measured*).

**The issue's second complaint — "no citation" — is the product working as designed.**
`SPEAK_DO_NOT_RECITE` (`src/script.ts:365-391`) instructs: *"Say what you found as your own view, in
your own words. No title, no date, no quotation."* `hermes/README.md:125-129` states the consequence
plainly: *"no dates and no citations is what a good answer looks like too. The tell moved to the
follow-up question."* A citation-free reply is not evidence of anything.

So the fault is exactly one thing, and it is one the harness already detects — `hermes-eval.py`
reported *"never called the expected braintrust tool"*. There is no new detection to build; there is a
guarantee to enforce.

**Solution options**

| Option | What the user gets | Cost | Trade-off |
|---|---|---|---|
| **A. Add "retrieved before answering" as an interrogation assertion** | The existing nightly guard files an issue when a persona answers from nothing | One assertion in `src/interrogate/assertions.ts`, which is a list append by design (`:139-145`). Adds one call per persona per night | The interrogation is toolless (`src/interrogate/model.ts:1-13`), so it can assert the *behaviour given a payload* but not the *tool choice*. Partial coverage only |
| **B. Sharpen the `SOUL.md` line** | Fewer skipped retrievals | A template edit. Zero runtime cost | Instruction-strengthening against a 20B model is a weak lever, and `src/script.ts:319-321` already concedes *"a Persona is honest because it looked and not because it was told to"* |
| **C. Keep `hermes-eval.py` and run it with `--repeats`** | A measured rate rather than one anecdote | Minutes of wall time per rep. No new build | Not a fix, a measurement — but it is the only thing that can tell a one-off from a pattern |
| **D. Make `load_persona`'s payload harder to answer from** | The model has nothing to improvise from | The Script already holds no opinions, deliberately (`hermes/SOUL.md.template:45-47`) | Already done. There is nothing left to remove |

**Pick C first, then B.** One occurrence is not a rate. `--repeats 5` on `covered_topic` across five
profiles is 25 calls against a local box and settles whether this is a bug or a coin. A is worth
building but does not cover the actual failure.

**Confidence: high that it happened, low that it is frequent.** What would raise it: exactly C.

---

### 6 — "False negative on a covered topic"

**Verdict: confirmed as an observation. The cause is the gate, and this persona has produced this
exact failure before.**

`bt-ethan-mollick / covered_topic` replied *"I don't have a recorded stance on prompt engineering."*
*(measured)*. `src/compile/selectivity.ts:4-12` records the same persona doing the same thing:

> three Personas of 5, 19 and 40 Items all reported `overlapping` […] and **`ethan-mollick` then
> refused *"what AI agents change about how work actually gets done"*** — the dead centre of his
> Corpus.

Two candidate mechanisms, and they compound *(both inferred)*:

1. **The floor may be the unmeasured fallback.** `UNMEASURED_RETRIEVAL_FLOOR = 0.55`
   (`src/unmeasured.ts:52`) sits deliberately *above* every floor braintrust has measured (0.44–0.52).
   `floorFor` (`src/find.ts:163-169`) also reverts a persona to 0.55 whenever
   `movedParts(version).includes('measurement')` — so a compiler change silently re-tightens the gate
   on read, for every persona that has not rebuilt since.
2. **The gate's own measurement may be under-fetching.** `selectivity()` asks for 400 rows from an
   HNSW index at pgvector's default `ef_search` of 40, then filters by person (`src/find.ts:1164-1195`).
   If `top` is depressed, the question fails the floor and the answer is empty regardless of what the
   corpus holds.

**Which one is live cannot be determined from here** — it needs one read of
`corpus_stats->'selectivity'->>'floor'` for `ethan-mollick` and one `EXPLAIN`. **Unverified.**

Note the ordering consequence: if mechanism 2 is real, it produces finding 6, and finding 6's empty
answer produces finding 3's frame collapse. The same one-line fix would move all three.

**Solution options**

| Option | What the user gets | Cost | Trade-off |
|---|---|---|---|
| **A. `SET LOCAL hnsw.ef_search` (same as finding 1, option A)** | The gate measures the corpus rather than the index's reach | One line. Zero model calls | May be a no-op; one `EXPLAIN` says so in a minute |
| **B. Report which floor was in force in `nothing_matched`** | An empty answer becomes diagnosable without a database session | `nothing_matched.floor` already ships (`src/find.ts:387-388`). What is missing is whether it was *measured* or *fallback* | Adds a field to a payload that `src/find.ts:452-458` enumerates and gates. Small, real work |
| **C. Lower `UNMEASURED_RETRIEVAL_FLOOR`** | Fewer refusals | One constant | **Reject.** `src/unmeasured.ts:1-12` documents the poached-egg failure that this value exists to prevent. Do not reopen it without a measurement |
| **D. Force a recompile of every persona so each measures its own floor** | Every gate is measured rather than fallback | A full compile run — real model spend | Worth doing eventually, wrong as a first move: it treats the symptom without learning which mechanism is live |

**Pick A, then B.** B is what makes the next occurrence take a minute instead of a session.

**Confidence: moderate on the mechanism, high on the observation.** What would raise it: two read-only
queries.

---

### 7 — The empty final answer

**Verdict: not a parsing artefact and not a persona bug. A missing outcome state in the harness.**

The export shape parses correctly *(measured — every saved session is one JSON object with
`messages[]`, `role` a string and `content` a string; `session_facts()` at
`scripts/hermes-eval.py:136-163` handles it exactly right)*. An empty `final_answer` therefore means
what it says: **no assistant message in that session carried any text at all.** With exactly one tool
call recorded and nothing after it, the session ended mid-flight.

`hermes/README.md:96-110` documents precisely this for `gpt-oss-20b`, the model these profiles run:
*"Six retries, five stray `browser_navigate` calls […] then raw `<|channel|>` tokens the endpoint
refuses to parse, and the session dies with no answer."*

**The bug is that the harness cannot say so.** `Outcome.passed` (`scripts/hermes-eval.py:224-236`)
returns `False` for every non-error case, and only `run_query` raising counts as an error. A session
that died is scored identically to a bad answer, and the empty string is then handed to the judge,
which duly returns *"The reply content is not provided, so it cannot be verified."* — a content
failure, recorded against the persona.

Both of braintrust's own harnesses refuse to do this. `src/qa/run.ts:36-41`: *"An unreachable judge
concludes nothing about this answer."* `src/interrogate/index.ts`, quoted at `src/interrogate/model.ts:99-103`:
*"an endpoint braintrust cannot reach is not evidence that a persona is inventing claims."*
`hermes-eval.py` has no such rule.

**Whether that specific session died is unverified** — it was not saved, and settling it means one live
Hermes call this analysis did not make.

**Solution options**

| Option | What the user gets | Cost | Trade-off |
|---|---|---|---|
| **A. Add a `could_not_be_asked` outcome** | The total stops silently counting infrastructure failures as product failures | ~15 lines in `hermes-eval.py`, mirroring `QAOutcome.passed: boolean \| null` | None. It is the rule the other two harnesses already hold |
| **B. Read `end_reason` from the export** | The harness names *why* it could not be asked | The field is already in every export *(measured)* | Depends on Hermes' `end_reason` vocabulary, which is undocumented here |
| **C. Save every session export on failure** | The next occurrence is diagnosable without a re-run | A few lines; disk only | Sessions are large — `uncovered.jsonl` is 129KB for three tool calls |
| **D. One manual `hermes -p bt-stuart-wt chat` run** | Settles this instance | One call | Settles one instance and teaches the harness nothing. **Rejected on the autonomy constraint** — a fix that needs a person to look is not a fix |

**Pick A plus C.** Together they cost an afternoon and mean this question never has to be asked by hand
again.

**Confidence: high on the harness gap, unverified on the specific session.**

---

## Cross-cutting: what actually shares a root cause

The issue closes with *"findings 1–5 are five separate root causes […] that don't share a fix."*
Three shared causes cut across them.

### Shared cause A — the deployed configuration is not the designed configuration

Covers **finding 2 (agent-side), finding 3 and finding 4**.

- `SOUL.md` on all five profiles is three commits behind and inverts the citation rule.
- The deployed MCP server advertises three rules where `main` has four.
- No profile scopes its toolset, so `hermes-cli` is inherited whole.
- The MCP server's `instructions` never reach the model in this client at all.

Every Hermes number in #298 was measured against a system that is not the system in the repository.
**This is one ticket, not three**, and its acceptance criterion is not "re-render the profiles" but
"a profile cannot silently drift again" — which `hermes/README.md:134-144` already knows the answer
to: keep `SOUL.md` thin and let the rules ride with the compile.

### Shared cause B — an empty answer breaks the persona frame

Covers **finding 3, finding 6, and part of finding 1**.

`uncovered_topic` lost the disclosure 5 times out of 5. `covered_topic` lost it once — on the one run
that was itself a denial. The correlate is not the tool path the issue proposes; it is whether
retrieval returned anything. Upstream sits the gate (finding 6) and the retrieval reach (finding 1),
so **a fix that makes retrieval reach further reduces the frequency of finding 3 without touching
disclosure at all** — and the wording fix at `hermes/SOUL.md.template:79-82` handles the residue.

### Shared cause C — the harness measures something other than its label

Covers **finding 1, finding 2 and finding 7**.

`grounded` scores one position out of five, against four citations out of however many, on a URL that
does not always match. `renderAnswer` withholds the subject and then the reply is failed for not
naming a person. The judge is asked whether a quote is real and cannot see the source, having been
told to answer false when unsure. `hermes-eval.py` scores a dead session as a bad answer.

**This is the finding that changes the priority order of everything else.** The 29% and 22% headline
numbers are not measurements of the properties they are named for, and the "fabrication" finding —
which the issue calls the most serious — is an artefact of a render that cannot pass its own rubric.

### And finding 5 stands alone

A persona answering without retrieving is a real, separate failure with no shared cause and one
observation behind it. It is also the only one of the six the existing harness already detects
correctly.

---

## Recommended split into `ready-for-agent` tickets

Ordered by what a reader of a persona experiences, not by effort. Ticket 1 is smallest *and* highest
impact, which is not usually how it goes.

**1. The deployed profile is the designed profile, and cannot silently stop being it.**
*(Shared cause A. Covers findings 2-agent-side, 3-partly, 4.)*
Every live persona is currently instructed to attribute — the exact behaviour `src/script.ts:300-311`
measured producing an invented title, date and quotation. Every live persona also has a terminal.
Fix `patch-hermes-profiles.sh:68` **first** (it would break `bt-stuart-wt`), thin the template so
behavioural rules travel with the compile rather than being copied, add `toolsets: [braintrust]` to the
documented profile config, and re-render. Zero runtime cost, zero model calls.
*Blocks nothing. Blocked by nothing. Do it first.*

**2. An empty answer is still the persona speaking.**
*(Shared cause B. Covers finding 3, finding 6's user-visible half.)*
Narrow `hermes/SOUL.md.template:79-82` so "stop being the persona" means a server that cannot be
reached, never a search that returned nothing — and make the empty answer do what `src/find.ts:358-376`
already designed it to do: offer `nearest` and `unread` in voice. This is the failure a reader actually
meets. Zero runtime cost.
*Blocked by 1 — it is the same file and the same re-render.*

**3. Retrieval reaches as far as it says it does.**
*(Shared cause B, upstream. Covers finding 1's ranking half, finding 6's cause.)*
Nothing sets `hnsw.ef_search`; pgvector's default is 40 and `src/find.ts` asks for 480 and 400 under
post-scan filters. Start with `EXPLAIN`, not a patch — if the planner is already doing exact search
this is a no-op and the ticket closes cheaply. If it is not, one `SET LOCAL` line moves findings 1, 3
and 6 together. Zero model calls either way.
*Independent of 1 and 2. Highest ceiling of anything on this list.*

**4. `npm run qa` measures what its column headers say.**
*(Shared cause C. Covers finding 1's measurement half, finding 2 entirely.)*
Put `payload.subject` in `renderAnswer`; count `grounded` across every returned position with
`full: true`; compare against `coalesce(post_url, url)`; and draw the query from the item's stored note
rather than its title, since titles are the one string never embedded. Zero new model calls, still
fully autonomous. Until this lands, no number from this harness should drive a decision.
*Blocks any re-prioritisation that depends on the 29%/22% figures.*

**5. `hermes-eval.py` can say "could not be asked".**
*(Covers finding 7.)*
Mirror `QAOutcome.passed: boolean | null`. Save the export on failure. A dead session must never score
as a bad answer — the rule `src/qa/run.ts:36-41` and `src/interrogate/model.ts:99-103` both already
hold.
*Small. Do it alongside 4.*

**6. A persona that did not look says so.**
*(Covers finding 5.)*
Measure it before building for it: `--repeats 5` on `covered_topic` across all five profiles is 25
calls and turns one anecdote into a rate. Then, if it is a rate, add the assertion.
*Last, because it is one observation. Not because it is unimportant — answering from nothing is the
founding failure of this whole map.*

---

## Sources

**In-repo, at `19c2f83`**
`src/find.ts` (retrieval path, floor, fit, citation ordering) ·
`src/qa/{sample,score,run,index,args}.ts` (golden set and judging) ·
`src/retrieval/{chunk,embed,index,store}.ts` (what gets embedded) ·
`src/notes/verify.ts` (quote verification) ·
`src/compile/{positions,selectivity,synthesis}.ts` (what a Position is, and the gate's calibration) ·
`src/disclosure.ts` · `src/script.ts` · `src/mcp.ts` · `src/unmeasured.ts` ·
`src/interrogate/{assertions,model}.ts` (the existing autonomous guard) ·
`scripts/hermes-eval.py` · `scripts/patch-hermes-profiles.sh` ·
`hermes/README.md` · `hermes/SOUL.md.template` · `schema.sql` ·
[docs/research/agent-models.md](agent-models.md)

**Transcripts and configuration read**
`hermes-eval-report.txt`, `qa-report.txt`, `uncovered.jsonl`, `recency-session.jsonl`,
`pong-session.jsonl`, `debug.jsonl`, `eval-covered.log`, `eval-uncovered.log`, and
`handoff-braintrust-evals.md`, all from the filing session's scratchpad ·
`~/.hermes/config.yaml` and all five `~/.hermes/profiles/bt-*/{config.yaml,SOUL.md}` ·
Hermes Agent v0.20.0 source at `~/.hermes/hermes-agent/` (`toolsets.py`, `model_tools.py`, `cli.py`,
`tools/mcp_tool.py`)

**Related issues and PRs**
[#278](https://github.com/cgbarlow/braintrust/issues/278) (captions backlog — explains part of Nate's
score, none of the fleet's) ·
[#296](https://github.com/cgbarlow/braintrust/issues/296) (built `npm run qa`) ·
[#297](https://github.com/cgbarlow/braintrust/issues/297) (built `hermes-eval.py`) ·
[#227](https://github.com/cgbarlow/braintrust/issues/227) (last change to `SOUL.md.template`) ·
[#266](https://github.com/cgbarlow/braintrust/issues/266)/[#269](https://github.com/cgbarlow/braintrust/pull/269),
[#202](https://github.com/cgbarlow/braintrust/issues/202),
[#206](https://github.com/cgbarlow/braintrust/issues/206) (speak, do not recite) ·
[#133](https://github.com/cgbarlow/braintrust/issues/133),
[#115](https://github.com/cgbarlow/braintrust/issues/115) (the retrieval floor) ·
[#140](https://github.com/cgbarlow/braintrust/issues/140) (statement-space ranking)

**External, first-party only**
[pgvector README](https://github.com/pgvector/pgvector) — HNSW defaults (`ef_search` 40, `m` 16,
`ef_construction` 64), `<=>` as cosine distance, and post-scan filtering ·
[Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) — asymmetric
`Instruct: …\nQuery:…` prefix on the query side only, ~1–5% retrieval cost when omitted, 1024 default
dimensions, 32K max sequence length

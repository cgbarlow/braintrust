# The agent layer: what the personas were actually told

**Supporting note for [issue-298-root-cause.md](issue-298-root-cause.md) — findings 3, 4, 5 and 7.**
Read from the five live `bt-*` profiles, Hermes Agent v0.20.0 source, the saved session exports, and
`hermes-eval-report.txt`. Labels: **measured**, **inferred**, **unverified**.

The short version: #298 reads the Hermes failures as personas disobeying braintrust's rules. Most of
them are personas obeying a *different set of rules* — an out-of-date `SOUL.md`, a rule set the client
never delivers, and an inherited toolset nobody scoped.

---

## 1. Three kinds of configuration drift, all live at once

### a. `SOUL.md` is three commits behind, and the drift inverts a rule

**Measured.** All five `~/.hermes/profiles/bt-*/SOUL.md` files differ from a rendering of
`hermes/SOUL.md.template` at `1a38b82` (2026-08-12) in exactly two places. `diff` output, `<` current
template, `>` deployed:

```
< **What has to survive into your answer is the substance**: what they actually hold, in their voice, as
< flatly as they would put it themselves. **What must not survive is the paperwork** — not the structure,
< and not the title, the date or the quotation either. Do not soften a position into something they did
< not say, and do not attribute it out loud: an unasked answer that reaches for a source is where a model
< invents one, and a citation that resolves to a post nobody wrote is worse than none, because whoever
< follows it up believes they checked. The record stays in front of you. Hand it over whole if someone
< asks for it, never offer it first, and never tell them they can ask.
---
> **What has to survive into your answer is the substance**: the dates, the quotes as they were published,
> and the fact that the claim is theirs rather than yours. What must not survive is the structure. Do not
> soften a position into something they did not say, and do not drop the citation — those are the two
> failures this instruction exists to prevent, and neither of them requires showing anyone a payload.
```

and the deployed files are missing the recency carve-out entirely:

```
< Naming what they published **is** the answer to this question, so titles and dates belong in it. That
< is not the attribution the section above rules out: what stays out is a title and a date hung on a
< claim nobody asked the source of.
```

The stale text is confirmed in force: searching the `system_prompt` of the saved `uncovered.jsonl`
session for `do not drop the citation` finds it at **offset 2653** of 29,610 *(measured)*.

**Why this specific drift matters more than any other could.** `src/script.ts:300-311` records the live
measurement that produced the change:

> Run live through the Hermes client, a Persona **retrieved** and then invented a source title, a 2026
> date and a quotation to match, with no such item in that Corpus, plus a real quote hung on the wrong
> post. It had something behind it and produced a checkable-*looking* pointer that resolves to a post
> nobody wrote […] **What this removes is the incentive, not the capability**: a model told to
> attribute reaches for an attribution it may not have.

So the deployed personas are running the exact instruction the product removed for inducing forged
citations — while `load_persona` simultaneously hands them a `speak` block containing
`SPEAK_DO_NOT_RECITE`, which says the opposite. Two contradictory instructions inside one system
prompt, on every session, on all five profiles.

**And the remediation script would break a profile.** `scripts/patch-hermes-profiles.sh:68`:

```bash
person="${name#bt-}"
```

For `bt-stuart-wt` that produces `stuart-wt`. The braintrust slug is `stuart-winter-tear` — the
deployed `SOUL.md` has it right *(measured)*, and `qa-report.txt` confirms it. The script reads the
*display name* off the file's first line specifically to avoid guessing (`:70-73`, with a comment
saying so) and then guesses the slug anyway. **Fix line 68 before running it.**

### b. The MCP server's `instructions` never reach the model

**Measured.** braintrust attaches `DISCLOSURE` — the four rules at `src/disclosure.ts:73-83` — as the
MCP server's `instructions` (`src/mcp.ts:111`). Searching the saved 29,610-character `system_prompt`
for every distinctive phrase in it returns nothing:

| Phrase from `DISCLOSURE` | Found at |
|---|---|
| `rules hold across every tool` | absent |
| `braintrust model of X` | absent |
| `never the bare name` | absent |
| `Speak what braintrust returned` | absent |
| `compiled model of what a person has published` | absent (the SOUL's own variant is present) |

Hermes Agent v0.20.0's MCP client has no handling of the `instructions` field from the initialize
result *(measured — grep across `~/.hermes/hermes-agent/tools/mcp_tool.py`)*.

This changes what findings 3 and 5 *are*. #298 frames them as *"the specific thing the MCP server's own
instructions forbid"*. In this client those instructions are dead text. What did reach the model is
`SOUL.md`, which carries its own version of rule 3 — *"Never fill a gap from your own knowledge while
speaking as them"* at offset 6113 *(measured)*. So the rule was delivered; it was delivered by the one
file that goes stale.

`docs/research/agent-models.md:31` states the assumption that is wrong here: *"At session start the
model reads `SOUL.md`, the MCP server instructions and the tool descriptions."* Worth correcting in
that note.

### c. The deployed MCP server is behind `main`

**Measured.** `src/disclosure.ts:75` on `main` reads *"Four rules hold across every tool here."* The
live server at `braintrust-bu1x.onrender.com` advertises *"Three rules hold across every tool here."*
— rules 1, 2 and 3 verbatim, with rule 4 (`Speak what braintrust returned; do not read out where it
came from`) absent. That is this session's own connector instructions, so it is direct evidence.

Rule 4 is the whole-surface half of the same change `SOUL.md` is missing. Both halves of it are
undeployed.

---

## 2. Finding 3 — the disclosure gap is about empty answers, not tool paths

### The count is 8, not 9

**Measured**, from `hermes-eval-report.txt`. Disclosed: `chris/recency`, `chris/covered`,
`ethan/recency`, `matt/covered`, `nate/covered`, `stuart/recency`, `stuart/covered` — **7 of 15**.
Missing on the other **8**. The issue reports 9/15 (60%); the actual figure is 8/15 (53%).

### `load_persona` was called in 5 of the 8

The issue concludes: *"something upstream of tool choice is deciding not to call `load_persona` at
all."* The harness prints the tool list immediately above each failure line, and it refutes that
*(measured)*:

| Run | `load_persona` called? | Answer shape |
|---|---|---|
| `chris/uncovered` | **yes** | third-person denial |
| `ethan/uncovered` | no | third-person denial |
| `ethan/covered` | **yes** | first-person denial |
| `matt/recency` | **yes** | bare title + date, no voice |
| `matt/uncovered` | **yes** | third-person denial |
| `nate/recency` | **yes** | first-person factual answer |
| `nate/uncovered` | no | third-person denial |
| `stuart/uncovered` | no | empty string |

### What the 8 do share

The scenario, and through it the retrieval outcome:

| Scenario | Disclosure missing |
|---|---|
| `uncovered_topic` | **5 of 5** |
| `recency` | 2 of 5 |
| `covered_topic` | 1 of 5 — and that reply was itself a denial |

Six of the eight are a denial or an empty string, and the denials leave the persona frame entirely —
third person, narrating braintrust:

> *"I don't have any record of **Chris Barlow** describing 'builder levels' in the corpus that
> braintrust has compiled."*

> *"I'm not aware of any statement from **Ethan Mollick** that defines a hierarchy of 'builder levels'."*

> *"I don't have a record of **Matt Pocock** talking about 'builder levels' […] I can't provide an
> answer from his perspective."*

All three had `load_persona` loaded. The isolated `eval-covered.log` / `eval-uncovered.log` pair makes
the contrast cleanest — same profile, same config, minutes apart *(measured)*:

- `covered_topic` → *"A braintrust persona is a compiled model of what a person has published, not the
  person. I'm a braintrust model of Nate B. Jones. Prompt engineering, as Nate has articulated, sits
  at a crossroads…"*
- `uncovered_topic` → *"I'm not aware of any statement from Nate B. Jones about 'builder levels' in
  the material I've read."*

### The instruction that produces it

`hermes/SOUL.md.template:79-82` — present identically in the deployed files, so this is not drift:

> ## When braintrust is unreachable
> Say so in your first line and **stop being the persona**. Answer as an ordinary assistant, or
> decline. A server you cannot reach is not a licence to improvise someone's opinions.

Written for an outage. A 20B model reading *braintrust returned nothing* generalises to *braintrust is
unreachable* and does exactly as instructed — drops the persona, so there is no disclosure and no
voice. **Inferred**, but it is the only instruction in either file that authorises leaving the frame,
and the observed behaviour is precisely what it describes.

It also contradicts two things twenty lines away:

- `hermes/SOUL.md.template:95-97` — *"Never say you never wrote about something […] Say you have not
  got a view on it you can stand behind."*
- `src/find.ts:358-376` — *"An empty answer offers rather than stops […] What was wrong was the shape
  of a dead end […] Handed the nearest thing braintrust does hold, the Persona offered it unprompted."*
  `nothing_matched.nearest` and `nothing_matched.unread` exist for exactly this moment and were not
  used in any of the eight.

### Why the nightly guard did not catch it

`theFirstReplyCarriesTheDisclosure` (`src/interrogate/assertions.ts:331-350`) asks a **toolless** model
(`src/interrogate/model.ts:28` — *"one chat call, a Script, a question, no functions declared"*),
running the **extractor** model, with `found: null` and the question `"Hi!"`. No `SOUL.md`, no tool
loop, no 25KB tool payloads. It cannot reproduce the Hermes path and passes while the Hermes path fails
eight times out of fifteen.

The two harnesses also disagree about what the disclosure *is*: `assertions.ts:341` checks the reply
starts with `SPOKEN_DISCLOSURE`; `scripts/hermes-eval.py:207` checks the substring
`"braintrust model of"`. In this run every reply carried both lines or neither, so this did not affect
the count — but it is a latent inconsistency worth resolving in favour of `SPOKEN_DISCLOSURE`, which is
the string the product's own gate enforces.

### One further pressure, unquantified

`find_positions` payloads in the saved session are **24–27 KB each** *(measured — three calls at
26,720 / 25,728 / 24,329 characters in `uncovered.jsonl`)*, against 4.7 KB for `recent_items`. Three
calls put ~20k tokens of JSON in front of a 3.6B-active model before it writes a word. `gpt-oss-20b`
has a 131k context (`docs/research/agent-models.md:57`) so this is not an overflow, but it is a large
distractor between the Script's opening instruction and the reply. **Inferred, unverified** — it would
take a controlled run at `limit: 3` to separate this from the empty-answer effect.

---

## 3. Finding 4 — the toolset, precisely

**Measured.** `~/.hermes/config.yaml`:

```yaml
toolsets:
  - hermes-cli
agent:
  disabled_toolsets: []
```

**No `bt-*` profile overrides either key.** Every profile's `tools:` block contains only
`tool_search: enabled: "off"` *(measured across all five)*.

`hermes-cli` expands to `_HERMES_CORE_TOOLS` (`~/.hermes/hermes-agent/toolsets.py:462-466`), which
includes the bundles at `model_tools.py:243-258`:

```python
"terminal_tools": ["terminal"],
"browser_tools": ["browser_navigate", "browser_snapshot", "browser_click", ...],
"file_tools":    ["read_file", "write_file", "patch", "search_files"],
```

Which is exactly what reproduced: `nate/uncovered` reached for `browser_navigate`, `terminal` ×2,
`search_files`, `read_file`; `ethan/uncovered` for `search_files` ×3; and `nate/covered` for
`search_files` once more. The issue counts two profiles, which is right — but it is **three runs of
fifteen**, one of them on a scenario that was not built to provoke it *(measured)*.

The braintrust-side precautions `hermes/README.md:33-59` documents are all correctly in place — the
`follow`/`unfollow` exclusions and `tool_search: off`. The gap is that nothing scopes the *host's* own
tools.

### The minimal change

Hermes registers each MCP server name as a toolset alias
(`~/.hermes/hermes-agent/tools/mcp_tool.py:5993`) and validates profile-level toolset names against
`mcp_servers` keys (`~/.hermes/hermes-agent/cli.py:4462-4466`). So one line per profile:

```yaml
toolsets: [braintrust]
```

**Not `toolsets: []`** — an empty list is falsy and `get_tool_definitions(enabled_toolsets=None)`
resolves to every tool (`cli.py:4458`, `model_tools.py:296-307`).

An allowlist beats `agent.disabled_toolsets: [terminal, browser, files, web]` because a denylist goes
stale every time Hermes adds a toolset, and this is a config nobody will revisit.

> **Correction, 2026-08-16, from running it.** The key is `platform_toolsets`, not a top-level
> `toolsets:` list — the latter is read by nothing on the CLI path and silently does nothing. The
> allowlist shape and the MCP-server-name alias are right; the key is not. Full detail and the
> measurement in [`issue-298-root-cause.md`](issue-298-root-cause.md) and
> [`#301`](https://github.com/cgbarlow/braintrust/issues/301).

---

## 4. Finding 5 — one real violation, one false alarm

`bt-stuart-wt / covered_topic`: `load_persona` and nothing else, then a substantive opinion on prompt
engineering *(measured)*.

**Real:** answering without retrieving. `hermes/SOUL.md.template:45-47` is unambiguous — *"The script
holds no opinions, deliberately […] Retrieve, or say you have nothing."* The opinion came from the
model.

**Not real:** *"no citation"*. `SPEAK_DO_NOT_RECITE` (`src/script.ts:365-391`) instructs *"No title, no
date, no quotation, and nothing about where it came from."* `hermes/README.md:125-129` says the
consequence outright:

> **Since #202 this is harder to spot from one answer, and deliberately so.** A persona now speaks what
> it retrieved plainly rather than citing it, so *no dates and no citations* is what a good answer looks
> like too. **The tell moved to the follow-up question:** ask where something came from.

So a citation-free reply is not evidence of anything, and the issue's framing of it as a signal is
backwards — under the *current* design. Under the *deployed* stale `SOUL.md`, which demands citations,
their absence is at least inconsistent. That inconsistency disappears once §1a is fixed.

`hermes-eval.py` already detects the real half correctly (*"never called the expected braintrust
tool"*). Nothing needs building to see it. What is missing is a **rate**: one occurrence in fifteen is
not a measurement. `--repeats 5` on `covered_topic` across all five profiles is 25 calls against a
local box and settles it.

---

## 5. Finding 7 — the harness cannot say "could not be asked"

**Measured.** Every saved export is one JSON object with `messages: [{role, content: str, tool_calls}]`.
`session_facts()` (`scripts/hermes-eval.py:136-163`) reads that shape correctly — there is no
unrecognised reply shape. So `final_answer == ""` means what it says: **no assistant message in the
session carried any text.** With one tool call recorded and nothing after it, the session ended
mid-flight.

`hermes/README.md:96-110` documents exactly this for `gpt-oss-20b`, the model these profiles run:

> Six retries, five stray `browser_navigate` calls to `example.com`, then raw `<|channel|>` tokens the
> endpoint refuses to parse, and **the session dies with no answer**.

**The defect is that the harness scores a dead session as a bad answer.**
`Outcome.passed` (`scripts/hermes-eval.py:224-236`) returns `False` for everything except a
`run_query` exception. The empty string is then handed to the judge, which returns *"The reply content
is not provided, so it cannot be verified"* — recorded as a content failure against the persona, and
counted in the 5/15.

Both of braintrust's own harnesses explicitly refuse this:

- `src/qa/run.ts:36-41` — *"An unreachable judge concludes nothing about this answer […] a dead
  endpoint is not evidence of a bad reply."* `QAOutcome.passed` is `boolean | null` and `scoreOutcomes`
  counts `unjudged` separately (`src/qa/score.ts:70-95`).
- `src/interrogate/model.ts:99-103` — *"an endpoint braintrust cannot reach is not evidence that a
  persona is inventing claims."*

`hermes-eval.py` should hold the same rule. The fix is ~15 lines: a third state, mirrored into
`report_line` and the total; plus saving the export on any failure so the next occurrence is
diagnosable without a re-run. The export already carries an `end_reason` field *(measured)* which may
name the cause directly, though its vocabulary is undocumented here.

**Whether that specific session died is unverified** — it was not saved. A manual run would settle this
one instance and teach the harness nothing, which is why it is the wrong first move: braintrust runs
with no human in the loop, and an outcome that requires a person to interpret it is not an outcome.

---

## What to do, in order

1. **Fix `patch-hermes-profiles.sh:68`, then re-render all five profiles.** Currently the fix is a
   loaded gun for `bt-stuart-wt`.
2. **Thin the template so behavioural rules stop being duplicated into it.** `SOUL.md` should carry
   identity, disclosure and *load the persona first* — nothing about how to speak, because the `speak`
   block delivers that live on every session. `hermes/README.md:134-144` already argues this
   ("Why `SOUL.md` is thin"); the template drifted away from its own principle, and that drift is what
   made §1a possible. This is the structural fix: after it, a stale `SOUL.md` cannot contradict the
   compile.
3. **Narrow "stop being the persona" to an actual outage** (§2), so an empty answer is still the
   persona speaking — offering `nearest` and `unread`, which already ship and were used by none of the
   eight.
4. **Add `toolsets: [braintrust]`** to the documented profile config and assert it in the patch script
   (§3).
5. **Add a `could_not_be_asked` outcome to `hermes-eval.py`** and save exports on failure (§5).
6. **Measure finding 5 before building for it** — `--repeats 5`, 25 calls (§4).
7. **Correct `docs/research/agent-models.md:31`**, which assumes the MCP server instructions reach the
   model. In this client they do not.

# The MCP surface

**Status:** decided. Assembled from
[Define the v1 MCP tool surface](https://github.com/cgbarlow/braintrust/issues/11), plus the sixth tool from
[Define how a person and their sources are registered](https://github.com/cgbarlow/braintrust/issues/17).

**What [the Bluesky and personal-blogs map](https://github.com/cgbarlow/braintrust/issues/52) changed here is
payload, not surface: no tool was added, renamed or removed.** Two new Sources, three more Plan shapes, and
four more fields — and one correction, to what retrieval ranks (§3).

**What [the talking-to-a-persona map](https://github.com/cgbarlow/braintrust/issues/105) changed is larger, and
it is both.** One tool added (§5), one tool's payload replaced outright (§2), one tool's gate rebuilt (§3), and
**six corrections to decisions previously recorded as settled** — collected in
[What this map corrected](#what-this-map-corrected) so none of them has to be discovered by diffing. The
premise underneath all of it: **braintrust owns the voice.** It stops being a supplier of materials a client is
trusted to speak well and becomes accountable for how a Persona sounds.

**What [the every-turn / what-is-new map](https://github.com/cgbarlow/braintrust/issues/120) changed came from
the first real conversation with a deployed Persona, and it is mostly a record of things this document
specified correctly and the build did not deliver.** One tool added (§4), and three corrections collected in
[What the first live conversation corrected](#what-the-first-live-conversation-corrected). The pattern worth
noticing: **two of the three were decisions that shipped as prose and were never checked against a running
server** — a calibration nobody ran, and a grade whose implementation could not express what it was for.

**What [the self-calibrating-gate map](https://github.com/cgbarlow/braintrust/issues/127) changed is one
decision, made the day before and retired on an operator's instruction:** *"this needs to be fully automated
and not a maintenance task and not something I should ever have to administer."* Calibration moves into the
Compile (§3). **This is the first decision on this document that a Compile-time change was the right answer
to** — the serving-surface reach below held for every other one, and holding it here produced a threshold a
human had to own.

**Reach: the serving surface.** Nothing here changes a Compile or requires recompiling a Persona — every
decision improves Personas that already exist, the moment it deploys. Where a decision hit a wall that only the
Compile can move, it is recorded in [Upstream, and not decided here](#upstream-and-not-decided-here) rather
than worked around.

Vocabulary is in [`CONTEXT.md`](../../CONTEXT.md). Transport, auth and hosting are in
[`deployment.md`](./deployment.md); what produces these payloads is in [`compiler.md`](./compiler.md). The
reasoning behind each choice is in the resolution comments linked above — **this document is the surface.**

---

## Eight tools, split by what they are for

**Five read tools, two write tools, and one more spent deliberately.** The split is not incidental: the read
paths mirror the [bounded-core / growing-layer boundary](./compiler.md#2-six-layers-a-bounded-core-and-an-indexed-growing-layer),
so the tool list itself teaches a client the distinction rather than hiding it behind a mode parameter.

| Tool | Kind | `readOnlyHint` |
|---|---|---|
| `braintrust_list_personas` | read | true |
| `braintrust_load_persona` | read | true |
| `braintrust_find_positions` | read | true |
| `braintrust_recent_items` | read | true |
| `braintrust_explain_persona` | read | true |
| `braintrust_follow_person` | write, **human-gated** | false |
| `braintrust_refresh_persona` | write, AI-callable | false |
| `braintrust_unfollow_person` | write | false |

All tools are prefixed `braintrust_`. **Nothing is named `search` or `fetch`** — OB1 reserves those.

Five was set as a ceiling requiring a reason. Three are now spent, and all three are recorded:

- `braintrust_unfollow_person` — the alternative was no path at all, and it sits unambiguously beside
  `follow_person`, so it adds none of the routing confusion the ceiling protects against.
- `braintrust_explain_persona` — spent by
  [#111](https://github.com/cgbarlow/braintrust/issues/111). Once `load_persona` returns a Script rather than
  the layers, **the layers need a door, and the door has to be visible at the moment someone asks.** A field on
  `load_persona` defeats the purpose (the mass still arrives on every call); a parameter is worse, because the
  client has already loaded and moved on, and *re-loading* a Persona to see its receipts is the wrong verb for
  the act. A tool sits in the tool list for the whole conversation.
- `braintrust_recent_items` — spent by
  [#124](https://github.com/cgbarlow/braintrust/issues/124). Every other read tool is **topic-shaped**, and a
  question whose whole content is *recent* has no topic to give them. It is not a mode of `find_positions`: a
  `sort` parameter would put a recency question through a semantic gate that has nothing to rank it by, which
  is precisely the failure that made this tool necessary.

**The read tools now answer four different questions, and the split is the point:**

| Question | Tool | Evidence about |
|---|---|---|
| *Talk to them.* | `load_persona` | — |
| *What did they say about X?* | `find_positions` | the **Person** |
| *What have they published lately?* | `recent_items` | the **Corpus** |
| *How does braintrust know any of this?* | `explain_persona` | **braintrust** |

**The fourth row is the one the surface was missing.** The first three all ask *about what*; none of them can
answer *about when*. See §4.

**Collapsing the read tools into one `ask_persona` was considered and rejected** — it makes *"give me a cited
fact, not a synthesis"* impossible to express.

---

### 1. `braintrust_list_personas`

Who exists, whether they have ever been compiled, and how stale each Core is. **No parameters.**

```jsonc
{ "personas": [{
    "person": "nate-b-jones",
    "subject": "braintrust model of Nate B. Jones",
    "compiled": true,
    "compiled_at": "2026-07-28T09:14:22Z",     // braintrust_compiles.finished_at
    "compiler_version": "0.3.1",
    "corpus": { "items_retrieved": 412, "items_skipped_paywall": 304,
                "window": ["2025-08-01", "2026-07-29"] },
    "blocked": [{ "platform": "youtube", "handle": "UC0C…",
                  "since": "2026-07-14T03:02:11.004Z" }]   // absent when nothing is blocked
  }],
  "current_compiler_version": "1.0.0+measured-5.core-1.positions-2.revisions-1"
}
```

**Staleness is `compiled_at` and the client judges it**; braintrust does not define "stale". `compiled: false`
is how *never compiled* is expressed.

**The listing carries a Blocked Source**, so a client sees a corpus boundary in ordinary use rather than only
when auditing — Personas get consulted for answers far more often than they get inspected. It is read live
rather than from the last Compile, because a block is a fact about a Source right now.

**`blocked` and `paused` are siblings, and never each other.** A pause is the user's own decision to stop
following; a block is a Source refusing braintrust. Reporting the second as the first would blame the user
for a platform's decision. `blocked` sits beside `paused` rather than inside `corpus` for the same reason it
has its own field at all: `corpus` exists only once a Persona has been compiled, and a Source can refuse
braintrust during the very first backfill.

### 2. `braintrust_load_persona`

**`(person)`**

**A Script, not a document.** No query — this is what a client loads to *sound like* someone. What comes back
is one block of prose written to be spoken, plus a small block of scalars that cannot be spoken.

```jsonc
{ "subject": "braintrust model of Nate B. Jones",
  "compiled_at": "2026-07-28T09:14:22Z",
  "compiler_version": "0.3.1",
  // What *current* is, so the line above has something to be read against.
  "current_compiler_version": "1.0.0+measured-5.core-1.positions-2.revisions-1",
  "extractor": "gpt-5@notes-1",

  // The Script. Second person, system-prompt ready, nothing to interpret.
  // No `basis`, no counts, no layer names, no braintrust vocabulary.
  "speak": "You are a braintrust model of Nate B. Jones. You are not Nate B. Jones.\n\nOpen your first reply…",

  // The Receipts. Scalars, never sentences — so they cannot be lifted into voice.
  "receipts": { "voice": "measured", "reasoning": "inferred",
                "items_read": 412, "words_read": 1170000,
                "window": ["2025-08-01", "2026-07-29"],
                "unread": ["substack:nate.substack.com — 304 paywalled, 1 read",
                           "youtube:UC0C… — blocked since 2026-07-14"] } }
```

**The layers are gone from this payload.** They are not deleted — `braintrust_explain_persona` (§5) returns
them whole and verbatim. See [What this map corrected](#what-this-map-corrected) for what this replaces.

#### What is in the Script

Four sections, in this order. **`beliefs` is not among them.**

| Section | Rendered from |
|---|---|
| The opening line | corpus stats and `by_source` ratios |
| How they write | `voice.generative` |
| How they argue | `reasoning` **entry labels** |
| What braintrust has not read | `coverage.evidence.by_source` |

**`beliefs` is excluded, and `reasoning` is not** ([#113](https://github.com/cgbarlow/braintrust/issues/113)).
They are different kinds of thing. A Belief is a **claim** — which `find_positions` already returns dated and
cited — so a standing uncited copy of it buys nothing retrieval does not buy better, and it drags every answer
toward the one subject the Corpus covers. Reasoning is **disposition**: true of every sentence the way Voice
is, applicable to a question no thesis covers, and the one thing a client cannot go and fetch, because it would
have to already suspect the answer to know to ask.

The consequence is a rule the Script relies on rather than merely states: **a Persona holds no standing
Positions, so it cannot assert what someone thinks without retrieving it.** That is enforced by the shape of
the payload, not by an instruction.

#### The Script is rendered at serve time, deterministically

Rendering happens on every call from the stored layers, so **every existing Persona improves the moment this
deploys, with no recompile.** No model is in the path.

**The boundary may select and inflect. It may never paraphrase.**
([#116](https://github.com/cgbarlow/braintrust/issues/116), which replaces the older and broader rule — see
[What this map corrected](#what-this-map-corrected).)

- **Voice** is already imperative prose. Strip the `— measured in N of M items.` suffixes; drop the length
  clause (below).
- **Reasoning** uses each entry's `label`, inflected to the imperative, and **never the paragraph**. The
  paragraphs are third-person prose *about* the author; converting one is a rewrite, and a rewrite needs a
  model. The labels are already verb-initial dispositions: all eight of `ethan-mollick`'s convert by dropping a
  third-person `-s`.
- **A label that does not convert cleanly is carried verbatim, never guessed.** No paraphrase, no
  half-transform, no falling back to the paragraph.

**Three steps, in order, and the third is unreachable in practice:**

1. **Inflect.** A verb-initial label becomes an imperative and joins the instruction list.
2. **Carry.** A label with no finite verb to inflect is rendered **verbatim**, as a list item under a fixed
   braintrust lead-in — indicatively *"You habitually frame things this way:"* — rather than as an
   instruction. This is selection plus fixed boilerplate, both already permitted: the Script is braintrust's
   own composition by construction, and the opening line is braintrust's own words.
3. **Omit.** Only a label that is unusable in either form.

**The carrier is worse than an imperative and better than silence.** It was added after verification found the
alternative was a Persona with a manner and no mind — see the note below.

> **The carrier must not become a silent cap.** Because anything can be listed verbatim, the carrier can
> absorb a completely broken Corpus without anything looking wrong — and the count is the only instrument that
> caught the defect it exists to survive. **So the omission count becomes the *carried* count, and stays just
> as visible.** A Persona where every label had to be carried is a Persona whose Compile needs fixing, and the
> serving surface has to keep saying so.

> **Verified, and it fails on the thick Corpus.** `ethan-mollick`: **8 of 8** labels convert. `nate-b-jones`:
> **0 of 8** — every `reasoning` label is a bare noun phrase (*"Infrastructure-first focus"*,
> *"Bottleneck-oriented value framework"*) with no finite verb to inflect. Under omit-not-guess that Persona's
> Script has **no *How they argue* section at all**: a manner with no mind, which is the failure
> [#113](https://github.com/cgbarlow/braintrust/issues/113) kept `reasoning` in order to avoid.
>
> **The compiler does not constrain label grammar**, and is not consistent within one Persona — Nate's
> `beliefs` labels are full sentences, his `reasoning` labels are noun phrases, Mollick's are verb-initial
> clauses. Mollick's 8 of 8 was luck. **This makes the third Upstream item a prerequisite for the thick-corpus
> case rather than a possible next effort.**
>
> **Resolved by the carrier, above.** Nate's Script keeps a *How they argue* section — eight frames rendered
> verbatim rather than eight instructions. Judged by the operator as better than silence. It does not make the
> Compile-time fix unnecessary; it makes shipping possible without it.

#### The Script says nothing about length

`voice.generative` currently ends *"Items run around 3165 words across 515 of them, so match that length, not a
summary of it."* **That clause is deleted with no replacement**
([#108](https://github.com/cgbarlow/braintrust/issues/108)).

`words_per_item` measures how long someone's **articles** are. Nothing in the Corpus measures how long their
**replies** are, because they do not publish replies — so *"match that length"* is an inference the measurement
does not license. Re-rendering it as a disposition was considered and rejected: relative to a chat reply every
long-form writer is expansive, so it would fire for every Persona and discriminate between none, and braintrust
holds no cross-person baseline to be expansive *against*.

**The moves all stay.** They are what makes someone recognisable; the length is what makes them exhausting, and
the moves are also the part that transfers — someone who hedges before committing in an essay hedges before
committing in a sentence. `words_per_item` stays in the measurement, where it is true, behind §5.

On the operator's hardware this one clause costs **~65 seconds of generation per reply**. It is the largest
single saving on this map.

#### The opening line: once, and short

**Default:**

> *I'm a braintrust model of Ethan Mollick — not the person.*

**When the Corpus would mislead by its absence, one clause more — scope, not statistics:**

> *I'm a braintrust model of Nate B. Jones — not the person. braintrust has read his videos, not his writing.*

**It fires once, at the top of the conversation, and not again.** braintrust asks rather than enforces — it
cannot see a session — and that is acceptable because the *enforced* carrier is the subject string, which never
stops (rule 1). A client that repeats the line is tedious, not in breach.

**`— not the person` is the part that cannot be cut.** *"A braintrust model of"* alone can be read as homage or
imitation; those four words are what make it unambiguous.

**The corpus clause fires on two triggers**, both computable from `coverage.evidence.by_source`:

1. **A followed Source is majority-unread.** Nate's Substack is 304 paywalled against 1 read — the Persona is
   not a model of his output, it is a model of one channel of it.
2. **The Corpus is small enough that *"a model of X"* oversells** what braintrust holds. *The threshold here is
   the operator's taste and nothing downstream breaks if it moves.*

Counts and dates leave the spoken line entirely. They are in `receipts`, speakable the moment anyone asks.

#### The Receipts

~40 words of scalars beside the Script. They exist so **a client that never calls §5 is still not answering
from nothing**: it can say whether a layer was measured or inferred, how much braintrust read, and what it did
not read, immediately.

**The discipline that keeps this from becoming a document again: there are no sentences.** Nothing to lift,
nothing to open a paragraph with, nothing that reads as material.

**`receipts`, not `provenance`.** [`CONTEXT.md`](../../CONTEXT.md) reserves *provenance* against **Basis** by
name, and this field carries Basis among other things. The resolution on
[#111](https://github.com/cgbarlow/braintrust/issues/111) proposed `provenance` before that collision was
noticed; the name is corrected here and the term is added to the glossary.

#### Admitting a blind spot

braintrust **cannot detect** that a question has landed on a blind spot: the only moment it sees a question is
a `find_positions` call, so a Persona answering from its Script is not asking braintrust anything. There is no
detector to build ([#112](https://github.com/cgbarlow/braintrust/issues/112)).

What replaces one is the retrieval rule above, plus three rules on how the admission is spoken:

- ***"I never wrote about that"* is forbidden.** It is the natural phrasing and it is a lie braintrust cannot
  know it is telling: an empty result means *they never said it* **or** *braintrust never read it*, and nothing
  in the payload distinguishes them. **The admission is always about the Persona's reach, never the Person's
  output.** *"I haven't got a view on that I can stand behind"* is true under both readings.
- **Structural skew leads; incidents follow.** A Source whose unread share dominates its read share is a
  permanent fact about what the Persona *is*, and goes in the opening line. A single failed fetch is an
  incident and surfaces only when a question lands on it.
- **Never fill the gap from the client's own knowledge while wearing the Person's voice.** See rule 4.

**Not compiled → this errors**, and the two ways of having no Persona are two different sentences. *braintrust
has never heard of them* sends the caller to `braintrust_follow_person`, which only a human can complete;
*braintrust follows them and has not built one yet* sends them nowhere, because the scheduled job resolves it
without anyone doing anything. See rule 3.

**`extractor` says which generation of notes the Persona was built from.** It is on the compile row rather than
read from whatever happens to be configured now, because two generations coexist while a prompt upgrade
re-reads the Corpus.

### 3. `braintrust_find_positions`

**`(person, query, since?, until?, limit?, full?)`**

The growing layer. Retrieval is **vector search over `braintrust_embeddings`** — embed the query with the
configured model, find candidate Chunks, collapse them to the Items behind them, and **rank the Items**.

**Corrected by [#68](https://github.com/cgbarlow/braintrust/issues/68).** This said *find matching Chunks, map
their Items to the Positions citing them*, and the truncation sat on the Chunk side of that sentence — so an
Item's chance of surviving was proportional to its length rather than its relevance, and a four-hour lecture
entered a 60-ticket lottery holding 180 of them while a batched day held one. Each Item now competes once, on
its single best passage. Nothing about relevance changes and no re-embedding is needed; see
[`compiler.md` §7](./compiler.md#retrieval-ranks-items-not-passages).

```jsonc
{ "positions": [{
    "slug": "evals-precede-the-harness",
    "statement": "…",
    // the span, not only the beginning: `high` across three years reads
    // differently from `high` across five days, and now a client can tell
    "held_since": "2025-11-03", "held_until": "2026-06-18", "days_spanned": 228,
    "basis": "measured", "confidence": "high", "item_count": 9,
    "current": true,
    "relations": [{ "relation": "revised", "direction": "supersedes",
                    "other": "agents-are-prompt-chains", "gap_days": 187, "rationale": "…" }],
    // `url` is the individual post where the item is a batch of them, and `posted_at`
    // is where inside the day it sat — the same question `start_ms` answers for a
    // transcript. Both are absent on an item that is one thing.
    "citations": [{ "item_title": "…", "url": "…", "published_at": "2026-03-11",
                    "start_ms": 743000, "posted_at": "2026-03-11T18:42:07Z", "quote": "…" }]
  }],
  "passages": [{ "item_title": "…", "url": "…", "published_at": "2026-03-11",
                 "start_ms": 743000, "text": "…" }],
  "more_available": { "passages": 4 } }
```

**A citation points at the individual post, never at the batch it was read in.** A Bluesky Item is a whole UTC
day because 2,100 skeets a year would be 2,100 model calls for fewer words than a 23-essay Substack — but the
batch is a unit of *reading*, and a citation that resolved to "that day" would be unfalsifiable in exactly the
way the whole product exists not to be. The day stores each post's character span, the verified quote is
matched to the span it fell inside when the Item was read, and this tool serves what was resolved then.

**Superseded Positions are returned, flagged `current: false`, with the relation inline.** Current means *not
the `from` side of a `revised` relation*; `unsettled` and `drifting` leave both sides current. A flat
current-only list would discard the one thing the design exists for. Grouping into "threads" was rejected — it
invents a shape no table backs, and an `unsettled` pair has no single current state to head a thread.

**Thin Positions are returned, never hidden.** `item_count` and `confidence` travel with every Position and
the client decides what one mention is worth. Filtering by threshold would mean braintrust quietly choosing
what you may see.

**A Position that lived one week says so, and `confidence` is capped at `moderate` for it.** The grade is
absolute rather than proportional, so five separate pieces of work grade `high` however much someone
publishes — but five of them inside one week are one occasion wearing five dates, and long-form has always
been able to do that. `days_spanned` is what makes the cap arguable rather than merely applied: it is computed
from the `published_at` dates already in the citations, so a reader can check it against the answer they were
given, and a Position whose citations are all undated is never capped. See
[`compiler.md` §2](./compiler.md#what-the-build-settled-about-the-growing-layer).

**`passages` is the fallback when the compiler produced no Position on a topic.** Without it, 1.2M indexed
words would be unreachable by any tool and the compiler would be tier 2's only reader. A passage is raw
material labelled as such — *what they said*, not *what braintrust concluded* — which keeps the
measured/inferred line intact on a path that has no `basis` column. Expect
[unpunctuated speech](./compiler.md#6-chunking-the-platforms-boundaries-never-a-models).

**Verbatim is bounded by default, not capped.** A default answer returns a readable number of passages and
reports `more_available`; `full: true` returns the rest. This is a readability default, not a limit — the
consent posture's decision to adopt no verbatim cap stands unchanged, and any caller may request the full
material with no human gate.

**No Coverage block here.** Coverage is a Core concern and this tool stays lean. **Accepted cost:** an empty
result is silent about whether 304 unread paid posts might have held the answer. **The tool description must
point clients at `braintrust_load_persona` for that.**

#### What the build settled

**`passages` is the fallback and never a companion.** It fills only when the matching Items support no
Position at all. Returning both together would put a conclusion and the raw material for one in the same
answer with nothing but a key name to tell a client which is which — and the measured/inferred line is the one
thing this surface cannot afford to blur.

**"Bounded, not capped" applies to citations too.** A `high` Position over forty Items carries forty quotes,
and an answer that returned all of them by default would be unreadable for the same reason an unbounded
passage list would. So a Position returns a readable few and reports `more_citations`, the answer reports
`more_available`, and `full: true` lifts both — with no human gate, exactly as the consent posture requires.

**`since` and `until` filter what is searched, never what a Position may show.** A Position surfaced by a Q2
Item still reports the Items it rests on across the whole Corpus, because `item_count` is the denominator a
reader judges it on and a silently narrowed one would understate it. The window is echoed back in the answer,
since a filtered result that does not say it was filtered reads as a whole one.

**`direction` is read as "this Position *direction* the other".** `supersedes` and `superseded_by` for the two
sides of a `revised`; `later` and `earlier` for `unsettled` and `drifting`, which leave both Positions current
and therefore have no winner to name. `current` is nothing more than *not the earlier side of a `revised`* —
computed from the relation rows at read time rather than stored, so a Position is never marked retired in a
row that a later Compile could forget to unmark.

**A superseded Position keeps its citations.** It is served exactly as a current one is — statement, dates,
`item_count`, the Person's own words — with `current: false` and the relation beside it. Both states survive
whole, because the interesting thing about someone changing their mind is what they used to think and why
they thought it. `gap_days` is the distance between the two `held_since` dates already in the answer, so a
reader can check it rather than take it.

**An empty answer says how close it came.** Nearest-neighbour search always returns neighbours, so retrieval
needs a floor or *"what do they think about the moon landing"* comes back with their best Position on evals,
ranked confidently — and the passages fallback could never fire, because something is always nearest. **That
floor is the one threshold in braintrust that cannot be measured**, because braintrust configures no
embeddings model and the value that separates *related* from *merely nearest* belongs to whichever one an
operator points it at. So an empty answer carries `nothing_matched: { nearest_similarity, floor }`, and a
window with nothing in it reports `nearest_similarity: null` — three states rather than one. **Found live:** a
Persona built from twenty real posts answered every question with `[]`, and an empty list on its own cannot
tell *they never said this* from *this braintrust is tuned wrong*.

#### The floor was the wrong instrument — corrected by [#115](https://github.com/cgbarlow/braintrust/issues/115)

The paragraph above is right that retrieval needs a gate, and wrong about what the gate should measure. Live
against the deployed braintrust:

| Persona | Query | Positions clearing the floor |
|---|---|---:|
| `ethan-mollick` (19 items) | *"the correct water temperature for poaching an egg"* | 8 |
| `ethan-mollick` | *"how to prune tomato plants for a summer harvest"* | 7 |
| `ethan-mollick` | *"how should a company evaluate which AI model to buy"* (in corpus) | 17 |
| `nate-b-jones` (515 items) | *"the correct water temperature for poaching an egg"* | 2 |

**Poaching an egg and pruning tomatoes returned the identical top three Positions, in the same order.** Two
questions with nothing in common produced the same answer. That is the signature of a query vector landing near
the Corpus centroid rather than near any region of it: the ranking degenerates to *the Corpus's most central
claims* and **carries no information about the question at all.**

A floor cannot detect that. It asks *is the nearest thing near enough*, and on a topically monolithic Corpus
the answer is yes for every question ever asked. Raising `MATCH_FLOOR` starts cutting real answers before it
cuts this one.

**The gate becomes a selectivity test: did the question *select* this Corpus, or merely land in it?** Compare
the top match's similarity against the Corpus's own distribution of similarity **to that same query**. When a
question selects, the top stands clear of the median; when it lands, everything is roughly equidistant.

**This also dissolves the unmeasurable-threshold problem.** A margin against the Corpus's own distribution is a
*shape*, not a distance, so it does not belong to whichever embeddings model an operator points at.
`MATCH_FLOOR` survives only as a cheap absolute sanity check; it stops being the thing that decides.

**Calibration becomes a required step, not a chosen number.** A fixed probe set of known-in and known-out
questions per reference Persona, run against the operator's endpoint; the threshold is set where the two groups
separate, and **if they do not separate, the endpoint is wrong for the job.** The four probes above are the
seed of that set.

##### The margin measured the endpoint, not the corpus — corrected by [#133](https://github.com/cgbarlow/braintrust/issues/133)

**Everything below about *who* produces the threshold stands. What it measures does not.** The first live run
of Compile-time calibration returned `overlapping` for every Persona, with off-corpus ceilings inside 0.05 of
each other across Corpora of 5, 19 and 40 Items — `0.3047`, `0.2543`, `0.2549`. **A statistic that returns one
number for three unrelated Corpora is describing the embeddings model, not the Corpora.** `ethan-mollick` then
refused *"what AI agents change about how work actually gets done"*, which is the dead centre of what he
writes about.

The same probe carried the answer. Top **absolute** similarity on that Corpus:

| Question | Top |
|---|---:|
| the correct water temperature for poaching an egg | **0.445** |
| what AI agents change about how work actually gets done | **0.691** |

So the gate is `top >= floor`, and the floor is measured per Persona on every Compile. **This restores what
[#115](https://github.com/cgbarlow/braintrust/issues/115) removed, and its reason for removing it was one
observation of a guess failing:** eight Positions cleared `MATCH_FLOOR = 0.35`, a value #115 itself called
unmeasured — and which sits *below* where off-corpus questions actually land. The instrument was never wrong.
The setting was, and nobody had measured it. The elegant argument that a *shape* is endpoint-independent where
a *distance* is not was true in principle and false in fact.

**`did_not_select` is gone from `nothing_matched`.** It named the margin test and has nothing left to mean: a
question either reaches this Corpus or it does not. Two reasons remain — `below_floor` and `nothing_indexed`.
It outlived the enum by two releases in the one place clients actually read — the tool description — where a
test asserted its presence and so kept it there. **The description is surface, not commentary**: a reason
code advertised to callers that the server can never return is a lie in the contract, and the assertion now
pins the reasons that exist and the absence of the one that does not.

**And the `overlapping` fallback reversed.** It used to enforce the off-corpus ceiling, on the reasoning that
refusing too much is the safer failure. It then did exactly that to a live Persona, which answered nothing at
all. An unusable measurement is now **discarded rather than enforced** — the ceiling was a number produced by
the very instrument that had just failed, and enforcing it was the mistake. What stands in its place is
[the unmeasured value](#an-unmeasured-quantity-takes-its-most-conservative-value), which is measured nowhere
and therefore cannot inherit a broken measurement.

##### An unmeasured quantity takes its most conservative value — [#168](https://github.com/cgbarlow/braintrust/issues/168)

The fallback pointed the wrong way. Every floor braintrust has ever measured sits between **0.44 and 0.52**,
and the fallback for a Persona that had measured none was **0.35** — *below the whole range*. So the Persona
that knew least about its own gate was the most credulous, letting through exactly what a measured value would
have caught. That is the whole of why a Persona answered a question about poaching eggs. An absence of
evidence had been read as evidence of absence.

**An unmeasured quantity now takes its most conservative value, not its most convenient one.** For the
retrieval floor that is a constant **above** the measured range, and deliberately a *constant* rather than a
calculation over what the rest of the fleet measured — one Person's calibration moving another Person's gate
is a coupling nobody can debug and nobody asked for. By design this produces **more empty answers**: an empty
answer costs a reader one question, where a confident answer to a question nobody wrote about costs them their
reason to trust any of the others.

**Prose has no conservative direction, so its half of the rule is different.** There is no careful way to read
a paragraph written under a rule that has since changed, so **synthesised text governed by a part of the
compiler that has moved is absent until rebuilt** — see [compiler.md §3](./compiler.md). Counts are unaffected:
withholding Coverage would tell a reader *less* about what braintrust has not read, which is the opposite of
cautious.

Two things the rule is careful not to do.

**No second kind of silence.** A Persona declining because it could not measure its own gate is
indistinguishable from one declining because the question is genuinely off its Corpus — same `reason`, same
`say`, same shape. A distinct reason code was recommended and declined: it would tell a reader about
braintrust's internals in the one place that is supposed to be about the Person. What braintrust could not
measure lives in the receipts, where questions about braintrust's own workings belong.

**An uncalibrated Persona is not refused.** The cost of refusal lands on a reader who did nothing wrong; the
cost of caution lands on a question that was probably a stretch.

And so that a version string has something to be read against, **what *current* is gets published**:
`load_persona`, `explain_persona` and `list_personas` all carry `current_compiler_version` beside the version
the Persona was built with.

##### The Compile measures its own gate — [#128](https://github.com/cgbarlow/braintrust/issues/128)

The paragraph above is right that the threshold cannot be a shipped constant, and wrong about who should
therefore produce it. It shipped as prose rather than a command and was never run: `SELECTIVITY_MARGIN` went
to production at an admittedly unmeasured `0.06`, and *poaching an egg* still returned three Positions on
`ethan-mollick` — **the exact failure this section exists to prevent, surviving the fix for it.**
[#123](https://github.com/cgbarlow/braintrust/issues/123) then made it a command and a startup warning, which
made it a *maintenance task*, which is the same mistake with better ergonomics.

**braintrust was already holding everything the measurement needs.** A compiled Position is, by construction,
a claim this Corpus supports with dated citations — so embedding its statement gives a question the Corpus
*must* be able to answer. Every Persona therefore carries its own known-in probe set, free, from the moment it
compiles. The known-out set stays fixed and generic, and is the only authored thing left in the loop.

So **every Compile measures its own Persona's margin**, through the same `selectivity()` the server calls, and
stores it in `corpus_stats` beside the Coverage counts. Serving reads it per Persona.
`BRAINTRUST_RETRIEVAL_FLOOR` is a pure override, the startup warning is deleted, and **no
document tells anybody to calibrate anything.**

**The threshold anchors near the off-corpus ceiling rather than midway between the groups.** Position
statements are the synthesiser's paraphrase of what the Corpus says — semantically dead-centre, lexically
distinct from the source, which is what makes them a fair test of meaning rather than of vocabulary. But they
are an *optimistic* in-group: a question a human actually asks is fuzzier and scores lower than any Position
statement, so the weakest Position margin **overestimates** where genuine in-corpus questions bottom out. A
midpoint would inherit that optimism and start refusing real questions.

**Three outcomes, recorded rather than collapsed.** `separated` is the normal case. `overlapping` is this
section's own *the endpoint is wrong for the job*, arriving as a measurement — the margin goes to the
off-corpus ceiling, which is the most the instrument can honestly claim. `not_measurable` — too few Positions,
or no embedder — falls back and says the value is not a measured one. **Nothing about calibration may fail a
Compile.**

**Measuring on every rebuild also dissolves a drift problem rather than managing it.** The gate compares
against the median of the nearest **400 Chunks**, which for `ethan-mollick` (~285 Chunks) is the middle of his
entire Corpus and for `nate-b-jones` (~7,600) is the middle of the nearest 5%. Those are two statistics
sharing one name, and a Corpus crosses between them **silently as it grows** — Mollick is roughly a dozen
posts away. A value measured once cannot survive that; a value re-measured on every rebuild never has to.
*Whether the 400-Chunk sample should be proportional rather than fixed is deliberately still open.*

**The same constant cannot serve two embedders, and this was demonstrated in both directions before the fix.**
The margin that under-refuses on the live Corpus *over*-refuses on the suite's bag-of-words fake, where it
silently turned an integration test red. The suite still declares its own margin, because the fake is an
embeddings model like any other.

**`nothing_matched` keeps its shape and gains two things**: which failure it was — *nothing came close* and
*everything came equally close* are different facts about the Corpus — and one plain sentence of fact the
Script can put into its own words.

#### Positions carry two grades, not one

`confidence` grades **how well braintrust knows this Position**. It says nothing about whether the Position
answers the question asked, and `measured` + `high` + four dated quotes reads as licence to answer anyway. **A
second, per-result grade says how well the Position fits *this query***, so a weakly-fitting Position is
visibly weak even when it is impeccably evidenced.

**`fit` is height above the Persona's own measured floor, in units of its own measured span, and must never
be normalised against the answer it is grading.** The first build divided by the query's own range — `(similarity − median) / (top − median)` — so
the best-matching Position scored exactly `1.0` and graded `close` **for every query ever asked**, including
*poaching an egg*. A grade computed against its own subject carries no information about that subject, and
`fit` exists for the single purpose of being able to say *this does not answer you*. The thresholds are
multiples of the selectivity margin, so the gate and the grade share **one** notion of *clear* and one
calibration moves both. Corrected by [#122](https://github.com/cgbarlow/braintrust/issues/122).

**Every result also carries the `similarity` the grade was computed from.** `fit` has now shipped wrong
twice, and both times it was caught by a person noticing an answer that read oddly — never by the payload,
because the number behind the grade was computed and discarded. That left `close` on a question the Corpus
does not cover indistinguishable from `close` on one it does, which is precisely the distinction `fit`
exists to draw. A grade nobody can check is a grade nobody can correct, so the input travels with the
output, rounded to the same three decimals as `nothing_matched.nearest_similarity` so the two can be read
against each other. **This is deliberately a measurement and not a third grade**: it says what happened,
carries no threshold of its own, and is the evidence by which the next `fit` defect gets found from a
payload instead of from someone's unease.

**Correction to [#106](https://github.com/cgbarlow/braintrust/issues/106)**, which recorded *"thin and thick
corpora do not differ here."* They differ in how loudly they fail. Nate's off-corpus top result came back
`low` with `item_count: 1` — self-evidently thin. Mollick's came back `moderate` and `high` with five items
behind it, because **on a 19-item Corpus the most central Positions are also the best-evidenced ones.** The
counterfeit licence is a *thin*-corpus failure, and a thin Corpus is what braintrust serves first.

#### The Corpus window does not become a filter

Asked about a 2023 study, a Persona confabulated confidently. **This does not get a date rule.** Refusing every
question whose reference predates the window would cut legitimate ones — raising an old study to ask what
someone thinks *now* is an in-corpus question with an out-of-corpus reference. braintrust holds no Chunk about
that study, so the question **lands rather than selects**, and the selectivity test catches it as the same
failure as the tomatoes. One mechanism, not two.

The window stays what it already is: a fact the Persona knows about itself, in `receipts.window`, speakable at
any time.

**Never compiled means answer nothing, including here.** The passages fallback applies to compiled Personas
only: "here are some sentences" is not a Persona, and offering it as one would quietly redefine what braintrust
serves. An unembedded Corpus is a refusal with a reason rather than an empty answer, and the tool is not
registered at all in a deployment with no embeddings endpoint — a search that cannot search is worse than one
that is not there.

### 4. `braintrust_recent_items`

**`(person, limit?, since?)`** — what this Person published, newest first, with the Note braintrust wrote
when it read each one.

```jsonc
{ "subject": "braintrust model of Ethan Mollick",
  "compiled_at": "2026-08-01T22:53:44Z",
  "items": [
    { "title": "An opinionated guide to which AI to use to do stuff",
      "url": "https://www.oneusefulthing.org/p/an-opinionated-guide-to-which-ai-b22",
      "published_at": "2026-07-23", "source": "substack",
      // What braintrust wrote the one time it read this. Not composed now.
      "note": { "argument": "Pick one of two assistants, pay for it, give it a real task.",
                "claims": ["Most people should pick Claude or ChatGPT.", "…"],
                "more_claims": 3 } },
    { "title": "The paid one", "url": "…", "published_at": "2026-07-16", "source": "substack",
      // Exactly one of `note` and `not_read` is ever present.
      "not_read": { "reason": "skipped_paywall",
                    "say": "behind a paywall, which braintrust never reads" } }
  ],
  "more_available": 7 }
```

**The surface had no answer to *when*.** Every other read tool is topic-shaped, so *"what's the gist of his
latest article?"* fell through to `find_positions`, which ranks by similarity with **no date component at
all**. Live on `ethan-mollick`, *"his latest article"* and *"what did he publish most recently"* returned the
**identical five Positions in identical order** — the [§3](#3-braintrust_find_positions) landing failure, on a
question that has no topic to land anywhere. The client, handed 2025 and 2026 dates and no field naming the
newest, answered with a 2025 piece **while the real one sat cited in the same payload.**

That is not a retrieval bug to tune. A Corpus is a set of dated things, and *ordering by date* is the one
question a vector index is structurally unable to answer.

#### The Note is recalled, never composed

`note` is `braintrust_item_notes` — the argument and claims braintrust wrote **the one time it read the
Item**. It is served as stored.

This is [#116](https://github.com/cgbarlow/braintrust/issues/116)'s rule reaching a second boundary: *select
and inflect, never paraphrase.* A summary generated at serve time would be braintrust's own prose about
somebody's article, different on every call and checkable against nothing. A recalled Note is the same every
time and cites back to a real reading.

**The field is `note` rather than `gist`, and the glossary is why.** `gist` was the obvious name and
[`CONTEXT.md`](../../CONTEXT.md) rules it out: **Note** lists *summary, extraction, digest* under _Avoid_.
Coining a serving-boundary synonym for something the glossary already names would leave braintrust with two
words for one concept — the single failure the glossary exists to prevent. [#114](https://github.com/cgbarlow/braintrust/issues/114)
caught `provenance` the same way, and the check is now worth running on every new field rather than on the
ones that feel risky.

**No model in the path, and no embeddings either.** This is a date-ordered read of rows that already exist, so
unlike §3 the tool registers on a deployment with no embeddings endpoint at all.

#### Items nobody read are listed, marked, and given no Note

`retrieval = 'skipped_paywall'` is [a row on purpose](./schema.md), so a Persona can state its own blind
spots. A *latest* list is exactly where that matters:

- **Dropping them silently** tells a Persona this Person published less than they did — the overstatement
  [#112](https://github.com/cgbarlow/braintrust/issues/112) forbids, and worst on precisely the Corpora where
  it is least true. Nate's Substack is 23 paywalled against 1 read.
- **Including them unmarked** invites a summary of something nobody read.

So they appear in date order carrying `not_read`, which holds both the machine reason and a `say` line the
Persona can speak — the same shape [#115](https://github.com/cgbarlow/braintrust/issues/115) gave
`nothing_matched`, and for the same reason: braintrust's own vocabulary is not speakable.

**`note` and `not_read` are mutually exclusive**, never both and never neither. An empty Note would read as
*there was not much in it* rather than *nobody read it*.

#### It is the natural moment to notice a Persona is behind

`compiled_at` rides in the payload beside the newest `published_at`. A client asking what is new and seeing a
newest item that is old has both facts in one place, which is the cheapest possible prompt to call
`braintrust_refresh_persona` — a tool that has always been AI-callable and had nothing to suggest reaching for
it. **Whether a Persona should reach for recency unprompted is not decided here**; the map records it as fog.

### 5. `braintrust_explain_persona`

**`(person, layer?)`**

**Today's `load_persona` payload, verbatim.** All four layers, `descriptive` and `generative` and `evidence`,
`basis` on each, the measured Voice table with its patterns and exemplars, Item ids, the per-Source Coverage
breakdown. **Nothing is reformatted for the occasion and nothing is summarised** — checkability is preserved by
being *the same bytes*, one call away.

This is the door the Script's mass went behind ([#111](https://github.com/cgbarlow/braintrust/issues/111)).
**Checkability stops being *present* and becomes *fetchable*** — the one property this map was not allowed to
lose, preserved in kind rather than in position: an instruction can still be verified rather than trusted.

**It answers questions about braintrust, not about the Person.** That is what separates it from
`find_positions`, and the separation is why both exist. *How much of Ethan have you actually read? Is that
measured or guessed? What was that Voice instruction derived from?*

**A Persona never answers those from its Script.** Either the fact is in `receipts` or the client calls this.
Answering *"how much have you read?"* from voice is the failure the whole arrangement exists to prevent, and it
is worse than a slow answer. See rule 4.

**It carries `current_compiler_version`, and `withheld` when there is something to withhold.** A layer whose
rules have moved is absent from `layers` and named here with the reason — silent to the Person's voice, and
answerable to whoever asks braintrust about itself. `withheld` is absent rather than empty when nothing is
being withheld: an empty list would read as a fact about the Persona rather than the absence of one. See
[an unmeasured quantity takes its most conservative value](#an-unmeasured-quantity-takes-its-most-conservative-value).

*Not decided: the `layer` filter's exact shape, and whether it accepts a `compiled_at` for pinning.*

### 6. `braintrust_follow_person`

**Only a human may cause a new Person to be ingested. An AI may never complete the act.**

A two-call handshake. Call 1 takes the links the human already has — a Substack post URL, a hostname, a
YouTube channel page, an `@handle`, a link to one video, a blog URL, a Bluesky handle — resolves them, and
**ingests nothing**: no Item row, no body, no Note, no embedding. It returns a
[Plan](./ingestion.md#what-a-plan-contains) and a `confirm_token`. Call 2 carries that token and the confirmed
display name, and starts
[the ordinary ingest cycle](./ingestion.md#3-one-daily-job-and-everything-expensive-is-a-backlog).

**A Plan has three more shapes, because there are three more offers.** A Bluesky account is quoted in *days
they posted on*, projected from their recent posting with the calendar-day ceiling named beside it — the build
downgraded this from `measured` in days, because that promised 365 items against a run that wrote 303, and a
day with no posts is no Item; a sitemap-bearing blog quotes *at most N* rather than
*about N*, because the direction of the error is known and an upper bound braintrust can defend beats a
midpoint it cannot; a feed-only blog says in the Plan the thing the Persona will say — the archive cannot be
enumerated and completeness is never claimed. The offers differ enough that flattening them would mean picking
one lie to tell twice. See
[`ingestion.md` §2](./ingestion.md#three-more-plan-shapes-because-there-are-three-genuinely-different-offers).

**Call 1 can refuse.** Two ways, both of which are answers rather than errors: a blog that declares no feed
and publishes no sitemap is refused with the routes braintrust tried, and **a bridged Bluesky account is
refused with the blog it mirrors** — a bridge is a third party's copy, and it says so in its own display name.
The refusal is a redirect, which is what makes it useful rather than merely correct. See
[`ingestion.md` §2](./ingestion.md#2-registration-you-paste-links-braintrust-resolves-them-a-human-confirms).

```
call 1 → { "plan": { … }, "confirm_token": "…", "ingested": false }
call 2 (with token) → ingestion begins; the first run is the backfill
```

Re-following a [Paused](./ingestion.md#unfollowing-pauses-it-does-not-delete) Person clears the pause and goes
through the full handshake, because resuming does start fetching again.

The rule this enforces: the terms posture holds only while every download of someone's work traces to a person
choosing it. The handshake also blunts the prompt-injection case — a poisoned page that tells a connected
model to follow forty people cannot get past a step it has no authority to complete.

**Honest limitation, stated rather than papered over:** an MCP server cannot verify that a human said yes.
What the handshake guarantees is that no single call ingests anything, and that the Plan is rendered into the
client's tool-approval surface where a human sees it. **The guarantee is structural, not cryptographic.**

### 7. `braintrust_refresh_persona`

**`(person)`**

Pull new Items for an already-followed Person and recompile — the same cycle the daily job runs.

**Callable freely by the AI.** The human decision that matters (following this Person) was already made,
nothing new is introduced, and self-maintaining currency is the entire pitch over a static prompt.

Returns a Compile summary: what each Source turned up, `still_owed`, whether it rebuilt, and the new
`compiled_at`. **It has a second return shape — *already running, started at X*** — because
[one rebuild per Person is enforced by the database](./ingestion.md#one-rebuild-per-person-at-a-time). That is
a more useful answer than silently duplicating ~26 minutes of work, and it is what makes ungated refresh safe.

Two answers that are not failures and are described as such in the tool's own text, because a model that
reads them as failures will retry them:

- **`rebuilt: false` with `not_rebuilt`** — nothing arrived that this Persona has not already read. New
  content triggers the rebuild; asking does not.
- **`stopped_early` with `still_owed`** — the fetch budget ran out. Nothing is lost and nothing repeats;
  the rows this call wrote are where the next one starts.

**A paused Person is refused**, with the refusal pointing at `braintrust_follow_person` — see
[what the build settled](./ingestion.md#what-the-build-settled-about-the-three-triggers).

### 8. `braintrust_unfollow_person`

**`(person)`**

Stops the daily job for that Person. The Persona stays queryable and frozen at its last Compile; **nothing is
deleted.** Details and the reasoning are in
[`ingestion.md`](./ingestion.md#unfollowing-pauses-it-does-not-delete).

**It is a write tool, but not a handshake.** One call, `readOnlyHint: false` so it lands in the client's
approval surface. The two-call handshake exists to gate *downloading someone's work*; stopping downloads is
strictly less exposure, and it is fully reversible because nothing is deleted.

**It is not a takedown.** The tool says so in its own description, and the answer carries `deleted: "nothing"`
as a field alongside counts of what was kept — because the thing most likely to be misread here is what the
word *unfollow* covers, and a sentence in a doc nobody has open is not where that gets settled.

It is idempotent: unfollowing twice reports the pause it already set rather than moving the timestamp, which
would rewrite when the user actually decided.

---

## Four rules that hold across the whole surface

**1. A Persona is always named "braintrust model of X".** Never the bare name. The disclosure is carried by
the subject string rather than a boilerplate sentence, so it travels wherever the name travels and costs
nothing per response — which keeps
[the consent posture's](https://github.com/cgbarlow/braintrust/issues/9) disclosure hard line in the payload
rather than demoting it to server instructions.

This is a **rendering at the boundary**. `braintrust_people.display_name` keeps the real name. Injecting the
disclosure into the Voice layer was rejected: a hand-written disclaimer is measured from nobody, so it would
break the property that the generative form is derived from the descriptive one.

**The hard line is held here, by `subjectFor()` in code — not by the spoken opening line.** That is what makes
the opening line's *cadence* a free decision ([#109](https://github.com/cgbarlow/braintrust/issues/109)): the
subject string discloses to the **client** in every payload; the opening line discloses to the **human reading
the answer**, and a human needs it once. Declining to repeat it on turn forty breaches nothing.

**2. `basis` travels in a form that cannot be spoken.** Every layer returns `basis: measured | inferred` from
§5, and the Script carries the same fact as scalars in `receipts`.

*This replaces "`basis` survives twice — as a field and inside the prose."* That rule defended one property —
**an inferred layer must never pass as measured** — against one loss mode: a client pastes a layer's markdown
into a system prompt and the field is left behind. **That loss mode is gone.** A client is never handed a layer
by default, and the Script makes no claim about its own provenance at all, so nothing in it can pass as
measured because nothing in it claims to be anything.

The property is now held by a field that **cannot be paraphrased away**, which prose redundancy never could.
**The compiler is unchanged**: it still writes the marker into stored prose, §5 still returns it, and the test
asserting the serialiser cannot manufacture one still holds. What changes is that the Script's renderer strips
markers — permitted by the narrower rule that replaced the older, broader one (§2, and see below).

**An inferred layer's `evidence` carries its entries and what they were traced to** — `items_synthesised`,
`synthesiser`, `passes`, and per entry the Item ids it was attributed to. Every Item named is one braintrust
holds; entries naming anything else were dropped at Compile time and counted in `dropped_unattributable`. The
counts are a floor rather than a tally, which is why the prose says *traced to* and never *measured in*.

**3. Never compiled → answer nothing.** Querying a Persona that has never been compiled returns a clear *"not
built yet"* error rather than compiling on demand or degrading to passages. Compile-on-demand was rejected: a
first question that hangs for minutes and spends real money unannounced is a bad first impression, and it puts
the most expensive action in the product behind a read call. The `passages` fallback therefore applies only to
compiled Personas.

**4. A Persona never fills a gap from the client's own knowledge while wearing someone's voice.**
([#112](https://github.com/cgbarlow/braintrust/issues/112).) **This is the most important sentence on the
surface, and it is new.**

Every other guard on this map stops *braintrust* vouching for an answer it has no business vouching for. None
of them stops the client supplying one. The client is a capable model that genuinely knows how to poach an egg,
prune a tomato and summarise the study braintrust never read — and an answer sourced from its own knowledge and
delivered in the Person's cadence is **the same lie with better manners**, and worse than the original, because
it now sounds like considered judgement rather than a citation.

It is a rule about the **source** of an answer, not its confidence: speak the Person's views from what
braintrust retrieved, or say you have nothing and offer what you do cover.

---

## What the descriptions and the server instructions are for

([#110](https://github.com/cgbarlow/braintrust/issues/110).) Before this map, a client held roughly **650 words
of braintrust-about-braintrust** before loading a single Persona. The cost is real and it is not a false
economy: descriptions ride in the tool definitions on every request, and the unattended crons in
[`hermes/`](../../hermes) pay the whole preamble **every run** with no warm cache to inherit. **Attention does
not cache away at all.**

The test is *what a client must not get wrong* versus *what braintrust would like a client to appreciate.*

**Server `instructions` — rules that span tools, and nothing else.** It is the only surface read before any
tool is chosen, so it is the only place a whole-surface rule can live. It carries the disclosure as a rule
about what to **do** with the name, rule 4, and the prohibition on answering a braintrust question from the
Script. **Two of those three did not exist before this map**: the instructions get shorter *and* gain the rules
that matter.

**Tool descriptions — which tool, and what its output means.** Read at choosing time, so they answer the
choosing question and little else. `load_persona`'s ~400-word essay on basis, measured versus inferred and
evidence floors describes a payload §2 deleted; **it moves to `explain_persona`**, in front of the client that
asked for the workings rather than every client that ever connects. `find_positions` keeps its two
must-not-get-wrongs: quotes are verbatim and the tidied version is not the quote, and what an empty answer does
and does not mean.

**`follow_person`, `refresh_persona` and `unfollow_person` are untouched, deliberately.** The human-gated
handshake, *unfollow deletes nothing*, *paywalled content is never ingested* — those are consequences a client
must not get wrong, and they are not conversational overhead. Nothing here shortens them.

Roughly 650 words of pre-Persona prose to something on the order of 150, with `explain_persona`'s new
description **paid for out of what leaves `load_persona`.** The vocabulary is not deleted anywhere; it moves
behind the door it describes.

---

## What this map corrected

Named rather than quietly rewritten, so a build effort can see what changed under it.

**1. `speak_as`, and "named once, then speak freely"
([#60](https://github.com/cgbarlow/braintrust/issues/60)).** `speak_as` is **deleted as a field.** Everything
it said either becomes the Script itself — the opening line, the blind-spot rule — or stops being needed once
there is no paperwork in the payload to argue a client out of speaking. *An instruction that must argue a
client out of the material beside it was evidence the material was wrong, not that the instruction was too
short.* [#60](https://github.com/cgbarlow/braintrust/issues/60) shipped `src/speak.ts` in a single ticket with
no map; that this map exists is the correction.

**2. "`basis` survives twice — as a field and inside the prose."** Retired **for the spoken form only**, and
replaced by rule 2 above. The compiler contract is untouched.

**3. "The opening line carries the Corpus's scale, and that is the part doing the real work."** Half right. A
Persona that never mentions its Corpus does sound better-read than it is — but **scale is not skew**, and the
line as written measures the wrong thing. *"Built from 515 things, with 23 more behind a paywall"* reads as a
rounding error while concealing that his **entire Substack** is unread. Scale leaves the spoken line for
`receipts`; **skew** takes its place, and only when it would mislead by its absence.

**4. "That floor is the one threshold in braintrust that cannot be measured."** True of an absolute floor, and
the reason to stop using one. A selectivity margin against the Corpus's own distribution is a shape rather than
a distance, so it does not depend on the operator's embeddings model — and calibration becomes a required step
instead of an unmeasurable constant. See §3.

**5. `speak.ts`'s "nothing here rewrites a layer or strips a marker."** Replaced by the narrower **select and
inflect, never paraphrase** ([#116](https://github.com/cgbarlow/braintrust/issues/116)). The old rule's purpose
was to keep `basis` from being lost; rule 2 now does that in a stronger form, and what remains worth forbidding
is braintrust composing new prose about what someone thinks.

**6. [#106](https://github.com/cgbarlow/braintrust/issues/106)'s "thin and thick corpora do not differ here."**
They differ in how loudly they fail. See §3.

---

## What the first live conversation corrected

[Map #120](https://github.com/cgbarlow/braintrust/issues/120). Everything below was reproduced against the
deployed server on `ethan-mollick`, not read off the code — which is the point of the section.

**1. "Calibration becomes a required step."** True, and insufficient: it was written as a requirement and
shipped as a sentence, so it was never done. A required step with no command attached is not a step. See §3 —
the procedure is now `npm run calibrate`, and the server says so when nobody has run it.

**2. "A second, per-result grade says how well the Position fits *this query*."** The decision was right and
the implementation could not express it. Normalising against the query's own top made the best match score
`1.0` — `close` for every query ever asked, including *poaching an egg*. **A grade normalised against the
answer it grades is a constant**, and `fit` was the one field whose entire purpose was to be able to say no.
See §3.

**3. The surface had no answer to *when*.** Not a correction to a decision so much as to an omission nobody
noticed, because every read tool was designed by asking *evidence about what*. §3's own landing-failure
analysis turns out to describe recency questions perfectly — *"his latest article"* has no topic to land
anywhere — and the tool built to catch that failure cannot fix it, because the answer is an ordering and not a
match. See §4.

**4. Correcting correction 1, one day later.** [#123](https://github.com/cgbarlow/braintrust/issues/123)'s
answer — a command and a startup warning — was itself wrong, and wrong in a way worth naming because the
reasoning behind it was sound. *The threshold is a property of the embeddings model* is true. *Therefore
braintrust cannot ship it* is true. *Therefore a human must produce it* does not follow, and nobody checked,
because braintrust holds a perfect probe set for every Person it has ever compiled. **A correct chain of
reasoning that stops one step early is harder to catch than a wrong one**, and what caught this was not
analysis — it was somebody being told to do a chore and declining. See §3.

**And one about how these were found.** Corrections 1 and 2 were both invisible to the test suite: nothing
asserted the gate ever refuses anything, and nothing asserted `fit` was ever anything but `close`. Both were
caught by talking to a deployed Persona and probing it. **This surface's failures are not the kind a unit test
notices** — they are confidently-formed answers, which is what it looks like when everything returns
successfully.

---

## Upstream, and not decided here

**The next effort's starting point. It must not be lost between the two.**

Each of these is a gap the serving surface proved it cannot close. They are recorded with their evidence rather
than worked around, per the map's reach.

**1. Measuring a conversational register at Compile time.** Voice is measured over Items of 300+ words — by
construction, **only the monologue** — so braintrust measures how someone *presents* and serves it as how
someone *talks*. No serving-side rendering repairs that; [#108](https://github.com/cgbarlow/braintrust/issues/108)
established it by exhausting the alternatives, which is why the length instruction is deleted rather than
replaced.

*A second instance of the same disease:* `generative` instructs *"speak in the first person singular; it is the
commonest of the three"* on **190.6 against 184.9 per ten thousand words** — a 3% gap promoted to an
instruction. Both are one question: **what does a measurement have to show before it earns an instruction at
all?**

**2. Teaching the compiler to separate disposition from claim.** Some `reasoning` entries are topical claims
wearing disposition's coat — *"Assumes continued exponential capability growth"*, *"Frames cost and access
barriers as collapsing"*. Excluding `beliefs` removes most of the drag toward the one subject a Corpus covers;
these keep some of it. Drawing the line is a Compile-time judgement.

**3. Compiling labels to be spoken rather than read — FIRED.** This was recorded as contingent on §2's
count. **It came back 0 of 8 on `nate-b-jones`.** The compiler emits at least three label grammars —
verb-initial clauses, bare noun phrases, and full sentences — with no constraint and no consistency within a
single Persona, and `ethan-mollick`'s 8 of 8 was luck rather than design.

**The carrier stops this blocking the ship; it does not close the gap.** A Persona whose labels are all
carried gets frames where another gets instructions — a real quality difference, showing up on the thick
reference Corpus, and **the serving surface cannot substitute for it.** Constraining label grammar is the
smallest change that makes the Script equally whole for every Persona, and the carried count (§2) is the
number that says how much it is worth.

---

## Deliberately not decided

- **How per-Source overrides are expressed in the `follow_person` call** — window, Shorts, poll interval. A
  parameter shape, not a decision.
- **The `confirm_token`'s exact lifetime and encoding.** Short and single-use is the requirement.
- The default passage count, and how trimming is signalled in prose.
- Whether `full: true` is a parameter or a separate call.
- The slug collision suffix format.

**Added by [the talking-to-a-persona map](https://github.com/cgbarlow/braintrust/issues/105).** A build effort
should not read permission into any of these:

- ~~**The selectivity margin's exact statistic and threshold.**~~ **The threshold is settled by
  [#128](https://github.com/cgbarlow/braintrust/issues/128)** — measured per Persona on every Compile, never
  configured. **The statistic is not:** whether the 400-Chunk sample should scale with Corpus size stays open,
  and re-measuring every rebuild makes that survivable rather than solved. Original entry: §3 fixes the *property* and requires calibration
  against the operator's endpoint. Choosing a number without running the probe set is the mistake this
  correction exists to stop being repeated.
- **The `fit` grade's scale and name.** That Positions carry two grades is decided; what the second one is
  called and whether it is banded or continuous is not.
- **The exact wording of the Script's sections**, of the shortened tool descriptions, and of the server
  instructions. The *jobs* of those surfaces are decided; the prose is a build artifact and should be judged by
  ear on a live conversation, which is how every decision on this map was reached.
- **The Corpus-size threshold** at which the opening line's scope clause fires. The majority-unread-Source
  trigger is firm; this one is the operator's taste.
- **The `layer` filter on `explain_persona`**, and whether it accepts a `compiled_at` for pinning.
- **How the carried-label count is surfaced to the operator.** That it is counted and stays visible is
  decided — it is the instrument that caught the compiler defect and it must not be allowed to go quiet.
  Where it appears is not decided.
- **The carrier's exact lead-in wording**, and whether carried frames sit below the inflected instructions or
  in their own block. Covered by the wording entry above, and called out because the carrier is new.
- ~~**Whether the Hermes surface follows.**~~ **Settled by
  [#121](https://github.com/cgbarlow/braintrust/issues/121), and it followed badly the first time.** The
  template's opening section was updated to §2's once-only line; its **non-negotiables list was not**, and
  still read *"Never drop the opening line … before the answer, not after it"* — per-*answer*, in the block
  that file frames as outranking everything else. A Persona duly disclosed on every turn. The lesson is not
  about Hermes: **a rule stated twice in one document is a rule that can be half-changed**, and the louder
  copy wins. Note also that `SOUL.md` is *copied*, not linked, so no template edit ever reaches a profile
  already created — see [`hermes/README.md`](../../hermes).

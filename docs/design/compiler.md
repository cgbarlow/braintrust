# The compiler

**Status:** decided. Assembled from
[Shape a persona: what the compiler emits and when it recompiles](https://github.com/cgbarlow/braintrust/issues/7),
[Build braintrust's own persona compiler, or route content through `thoughts`](https://github.com/cgbarlow/braintrust/issues/16)
and
[Choose braintrust's embedding model and chunking strategy](https://github.com/cgbarlow/braintrust/issues/14).

**Three decisions from [the Bluesky and personal-blogs map](https://github.com/cgbarlow/braintrust/issues/52)
amend it**, because a Corpus whose Items span four orders of magnitude breaks assumptions that were safe while
every Item was an essay or a lecture. Two of them **correct** what this document previously asserted — Voice's
population (§2) and what retrieval ranks (§7) — and each is named as a correction rather than quietly
rewritten.

Vocabulary is in [`CONTEXT.md`](../../CONTEXT.md); the tables are in [`schema.md`](./schema.md); what the
compiler's output looks like at the boundary is in [`mcp-surface.md`](./mcp-surface.md). The reasoning behind
each choice is in the resolution comment linked at the head of each section — **this document is what the
compiler does.**

**braintrust owns a compiler, permanently.** OB1's own compiler is foreign-key bound to `public.thoughts` and
cannot be pointed elsewhere; writing a creator's published output into `thoughts` inherits
[ADR-0002](../adr/0002-no-ob1-bridge-in-v1.md)'s dating problem rather than dodging it. That cost is accepted.
OB1's *page structure* is not borrowed either — a Persona is not an entity wiki page, and its shape is fixed
below.

---

## 1. Each Item is read once, and what was read is kept

[#16](https://github.com/cgbarlow/braintrust/issues/16)

The Corpus is ~1.17M words. **Published Items are immutable** — a video from March is the same video in
December — so re-reading on every Compile pays repeatedly for an answer that cannot change.

**The compiler reads each Item once, writes a Note, and every subsequent Compile reads Notes rather than
transcripts.** A Note holds the claims made (each with a verbatim quote, its chunk and its timestamp), the
argument, and the assumptions. The table is
[`braintrust_item_notes`](./schema.md#tier-2--derived-expensive), in tier 2 — derived and expensive,
recomputable with no network traffic.

**The compiler reads a whole Item when writing a Note.** Chunk boundaries serve retrieval only and do not
constrain what the compiler needs in order to follow an argument.

**`extractor` — model id plus prompt version — is in the unique key.** Improving the Note-taking prompt writes
a new generation alongside the old one and a Compile declares which it reads, so a prompt upgrade is a
**resumable re-read of ~395 Items rather than a migration**. That re-read is
[an ordinary Backlog drain](./ingestion.md#the-backlog-is-rows-not-a-queue), and the previous Persona stays
live for its duration.

[ADR-0001](../adr/0001-the-compiled-persona-is-disposable.md) survives intact: the Persona is still wholly
rebuilt from evidence on every Compile and still cannot drift. It now rebuilds from Notes *about* the Corpus
rather than from the Corpus.

### The claim is only as good as its quote

**braintrust asks the model for a quote and for nothing else that a Position depends on.** It does not ask
which Chunk the quote came from, and it does not ask for a timestamp — a model asked for an id will supply
one, and nothing downstream could ever check it. The quote is the single locator that *is* checkable, so it is
the only one accepted; the Chunk and the `start_ms` are then read off the rows the quote lands in.

**The individual post inside a batched day is read off the rows the same way.** A Bluesky Item is a whole UTC
day, so the day carries each post's character span and the span the quote fell inside is what a citation
resolves to. That is deliberately the *same* mechanism rather than a second one: *where inside this Item are
these words* is one question, answered in milliseconds by a transcript and by a permalink by a day of posts,
and asking a model which post a quote came from would invite exactly the invented locator this rule exists to
refuse. See [`ingestion.md` §7](./ingestion.md#7-bluesky-a-day-of-posts-is-the-item).

**The quote braintrust stores is the body's characters, not the model's.** A model asked to quote a transcript
will sometimes tidy one — fix a mis-heard name, close a dropped bracket, join two sentences it read as one
thought. Every such repair makes the quote a rendering of what was said. So the quote is *located* in the
stored body and the body's own span is what is kept. Whitespace may differ, because a paragraph break is not
something a model can reasonably preserve inside a JSON string. Nothing else may.

**A claim whose quote is not in the body is dropped and counted.** Not stored unverified, and not silently:
the drop count is on every run summary, because it is how a model that has started paraphrasing shows up as a
number rather than as a Persona that cites itself.

**A Note is written even when every quote failed.** The argument and the assumptions are the model's own words
*about* the Item rather than the author's, so quote verification has nothing to say about them, and leaving
the Item unread would mean paying full price for the same answer every day. An Item the *endpoint* refused is
different: no Note is written, so it stays in the Backlog and the next run tries again rather than recording a
permanent verdict on the strength of one bad afternoon.

**Chunks are a precondition, not a coincidence.** A claim carries the Chunk its quote came from, so the read
pass runs after the index and an Item that has not been chunked is not yet readable.

### What the first live corpus settled about the drop rate

The first full read of a real corpus — **157 items, 1,093 claims** — put a number on the thing this section
exists to catch:

```
notes: 157 items read, 1,093 claims, 291 unquotable, dropped (87 only punctuation and case)
```

**27% of claims quoted words that were not in the item.** Split by form on a smaller sample, transcripts ran
about four times prose. That is a large number and it was, at first, an *undiagnosable* one.

**A dropped quote is not stored, so the drop rate was a signal nobody could act on.** The count says how often
it happened and nothing about why — and the two possible causes call for opposite responses. A model
*punctuating* an unpunctuated auto-caption is braintrust being stricter than its own reasoning requires; a
model *inventing* words is a model to replace. So rejection now also counts how many quotes differ from the
body **only in punctuation and case**, measured at the moment of rejection because that is the only moment the
rejected text exists. Nothing accepts a looser quote — this measures the question rather than answering it.

**The answer was 87 of 291 — 30%.** The other 204 differ in words. A four-item sample had suggested the
reverse, which is the whole reason the measurement was built rather than the change being made on the strength
of a plausible argument.

**So the quote rule does not move, and this is the decision.** Loosening it would recover 8% of claims and
leave a 19% invented-quote rate untouched — the dominant cause is not strictness. The looser matcher is
retained as a counter only; were it ever promoted, `locateLoosely` maps its match back to the body so a stored
quote would still be the author's characters, which is the property that would make accepting it safe.

**And the prompt has no headroom left.** It already says *COPIED EXACTLY, character for character*, forbids
fixing spelling, punctuation, capitalisation and transcription errors, states that an unverifiable quote will
be discarded, and separately warns that a transcript is unpunctuated speech. With the endpoint fixed, ~19% is
this model's ceiling rather than a prompt defect. Changing the prompt changes the generation and re-reads the
whole Corpus at real cost, so it is not done on a hunch.

**The number is the guarantee working, not damage being taken.** Without verification roughly one citation in
five would be fabricated, in a product whose whole claim is that a Persona cites what someone actually
published. 802 claims survived and every one is checkable.

*Rejected: reading through the MCP client's model.* MCP supports server-initiated sampling and the SDK
implements it, so the capability is real — but the read-once pass runs in the scheduled job, where **no client
is connected**. It could only serve a hand-triggered refresh, which is the cheap path rather than the
expensive one, and a Compile declares a **single** extractor generation, so mixing in whatever model a caller
happened to be using would break an assumption several layers rest on.

### Which model reads, and how that is decided

`npm run eval` — the third entry point, beside the server and the job. An operator's tool rather than a
client's, because choosing the model that reads someone's published work is a decision about money and about
where that work is sent, which is not the kind the MCP surface makes. The incumbent and the candidates are
recorded in [`extractor-models.md`](../research/extractor-models.md).

**braintrust was most of an eval harness already and only lacked the report.** Three things it has anyway do
the work: the **Corpus is the eval set**, so the benchmark cannot drift away from the job and there are no
fixtures anybody has to keep honest; a Note keyed `(item_id, extractor)` means a candidate's Notes sit
**beside** the incumbent's rather than over them, so trying one disturbs no live Persona and adopting one
later re-reads nothing it has already read; and the **verifier is an objective scorer** — a quote is in the
body or it is not.

**No model judges a model.** Every measure is a count, the same rule Voice and Coverage hold, and it matters
more here than anywhere: a judge could fail in exactly the way the thing it judges fails, and quietly agree
with it.

**The sample is fixed, or two numbers cannot be put beside each other.** Ordered by `md5(item id)` — stable
across runs, machines and databases, owing nothing to insertion order or to how far a backfill reached — so
every model sees the same Items and nobody can re-sample until a favoured one wins. Stratified by length,
because length is what the candidates differ on: an unstratified sample of this Corpus would settle the
long-context question on whichever two or three long Items happened to be drawn.

**The scorecard is deliberately not one number, because two failures pass every other measure.** A model
quoting three words at a time scores a *perfect* fidelity and says nothing, so **median quote length** sits
beside it. A model that reads the first ten minutes of a four-hour lecture looks healthy everywhere else, so
**late-span share** — the share of quotes drawn from an Item's last third — is reported too. That one is the
local answer to a question published long-context benchmarks cannot settle, because it is measured on this
Corpus rather than on synthetic needles.

**The incumbent costs nothing to score**, because its Notes are already written over those Items. Fidelity and
the punctuation share need a live read — the rejected quotes were never stored — so a generation scored
retroactively reports them as a dash rather than a guess.

**The harness may keep the rejected quotes; production may not.** It is a diagnostic path rather than the
product, so it writes them to a file and never to a row, which is the only place the drop rate stops being a
number and becomes something a human can read.

---

## 2. Six layers: a bounded core and an indexed growing layer

[#7](https://github.com/cgbarlow/braintrust/issues/7),
[#16](https://github.com/cgbarlow/braintrust/issues/16)

| Layer | `basis` | How it is computed | Model? | Scaling |
|---|---|---|---|---|
| **Voice** | measured | frequency, spread and exemplars counted directly over the raw text of Items long enough to argue in | **no** | converges |
| **Coverage** | measured | counts over `braintrust_items`, their `retrieval` status and their form | **no** | fixed size |
| **Reasoning** | inferred | LLM synthesis across Notes | yes | converges |
| **Beliefs** | inferred | LLM synthesis across Notes | yes | converges |
| **Positions** | measured, cited, dated | clustered from Note `claims`; every Position keeps its citations | yes | **grows** |
| **Relations** | measured / inferred | pairwise judgement over candidate claim pairs | yes | **grows** |

**The first four are the Core** — roughly constant in size at any Corpus scale, and what a client loads to
sound like someone. **The last two grow** and are
[queried rather than loaded whole](./mcp-surface.md#3-braintrust_find_positions).

**Two layers never touch a model, and that is what makes `basis` honest.** A `measured` layer is one no model
ever wrote — the line is structural rather than declarative, and it gives the marker rule in §3 a mechanical
test: *if a model produced the prose, the marker is required.* It also means Voice and Coverage are free at
every Compile and stay correct even while the Note prompt is mid-upgrade — the two layers a client most relies
on to sound like someone are the two that cost nothing.

**Voice compiles in two forms held in one row.** `descriptive_md` is the auditable account of measured habits;
`generative_md` is an instruction derived *from those measurements*. They are written by one Compile step from
one set of measurements, so there is no path by which the instruction and its evidence can disagree. The
failure this prevents already happened: the [first prototype](../prototypes/PROTOTYPE-compiled-persona-page.md)
asserted *"no hedging"* from four Substack openings, and measurement later found hedging in **32 of 34**
transcripts — the dominant feature of a spoken voice that is 96% of the Corpus.

**Nothing unmeasured may enter `generative_md`.** A proposal to inject the model-not-the-person disclosure
there was rejected for exactly this reason; the disclosure
[travels in the subject string instead](./mcp-surface.md#three-rules-that-hold-across-the-whole-surface).

**Beliefs cannot be extracted per Item.** Belief-marker mining was tested and does not work: of 30
belief-shaped statements found by phrase matching, most explained a mechanism rather than stated a conviction.
Beliefs are never asserted in one place, so the layer requires a cross-item synthesis pass — which is why a
Note carries the argument and the assumptions, not just the claims.

**Coverage `evidence` has a fixed shape**, because it is returned as structured counts rather than prose:
`window`, `retrieved`, every `skipped_*` state, `pending`, `failed`, `words_retrieved`, `by_source` and
`by_form`. It is a query over tier 1 written into the layer's `evidence` at Compile time, so it needs no table
of its own.

**`held_since` is recomputed every Compile.** A backfill that finds older evidence moves it earlier. Less
stable across Compiles, more honest.

**Anything precise and filterable stays query-time** — *"what did they say about X in Q2"* is not compiled.
Compiling it would duplicate the database and add a staleness window for no gain.

### What the build settled about "measured"

**The patterns are a hypothesis; the counts are the measurement.** Counting hedging means first deciding what
hedging sounds like, and that decision is a human judgement no amount of arithmetic launders. So the judgement
is written down where it can be argued with — each move's regex travels in the layer's `evidence` as its own
field — and it is never what a Persona acts on. What protects the Persona is the second half: **a move earns
its line in `generative_md` from its spread across Items**, and the strength of the wording is a function of
that spread rather than of anyone's ear. Built at a third of Items to be instructed at all and two thirds to
be instructed as characteristic; both are starting points to tune, not findings.

A move measured in one Item of thirty is described and not instructed, and `generative_md` says which moves it
left out so a client cannot helpfully add them back. **A move measured at zero stays in the evidence as a row
of zeroes**, because *braintrust looked for this and did not find it* is a different statement from silence —
and it is exactly the statement the first prototype needed and did not have when it asserted *"no hedging"*.

**No number appears in a measured layer's prose that is not also a field of its `evidence`.** The reason
Coverage returns structured counts is that a figure buried in a sentence cannot be checked, filtered or
displayed as a fact — which is only true if the sentence never becomes the only place that figure lives. There
are no percentages and no derived totals in either measured layer, and a test extracts every numeric token
from the prose and fails if it is not in the structure.

**Coverage's fixed shape gained four fields**, because folding any of them into an existing one would make a
Persona claim a blind spot it does not have: `skipped_short`, `skipped_window` and `skipped_not_a_post` are
braintrust's own policy rather than a Source's, and `pending` is work not yet done rather than work declined.
The window one is the clearest case for why the prose matters as much as the count — *"4 items are older than
the window braintrust was asked to read"* is true and actionable, and *"4 items could not be retrieved at
all"*, which `failed` rendered, is a lie about a source that answered perfectly. `skipped_not_a_post` is the
same shape one platform further out: *"3 URLs in the archive turned out not to be posts"* is braintrust doing
its job. `by_source` is keyed `platform:handle` rather than by platform, since one Person may follow two
publications on the same platform and merging them silently would produce a count nobody could check.

**The gate recounts whatever fields the rows carry rather than a list written down here**, which is what stops
a state existing in the schema and silently in no layer — so a fifth `skipped_*` reason needs no change to
`coverage_reconciles` at all.

### What a mixed Corpus changed about Voice and Coverage

[#57](https://github.com/cgbarlow/braintrust/issues/57)

Item length across every corpus measured, in words:

```
Bluesky skeet                                    ~34      3,359 words / 100 posts
Bluesky day, batched                            ~198      3,359 words / 17 days
Ghost event announcement                       59–162     after boilerplate removal
Karpathy blog post                            492–12,550  median ~2,500
Substack essay                                 ~1,596     36,700 words / 23 items
Karpathy YouTube lecture                      35–40,000   one item
```

**Four orders of magnitude between the smallest Item and the largest**, and it is a live Corpus rather than a
hypothetical — Karpathy is already followed, and his three- and four-hour lectures are a whole Substack in one
Item.

**Corrected: Voice measures one population, chosen by length, and always names it.** This document described
Voice as counted over the whole Corpus, and that was safe only while every Item was an essay or a transcript.
The spread thresholds are fractions of `items_measured`, so on a Corpus of 900 skeets and 23 essays the essays
contribute 2.5% of the denominator and **cannot reach either threshold no matter how consistent they are**.
The arithmetic is one-directional too: a 34-word skeet can hold at most one hedge, so short-form drags
frequency up while making spread unreachable. And `words_per_item`, a field printed in the descriptive prose,
becomes an average of 34 and 40,000 — a number describing nothing that exists.

So the population is **Items of `VOICE_MIN_WORDS` or more**, and `VoiceEvidence` gains
`measured_over: { min_words, items, median_words, items_excluded }` so the Persona can state it and a reader
can check it. Nothing about how anything is *counted* changes: the population was always an argument to the
Voice step, so this is a change to what is passed in.

**`VOICE_MIN_WORDS = 300`.** A judgement, and it travels in the evidence for the same reason the patterns do —
so it can be argued with rather than trusted. The measured case: a batched Bluesky day lands at ~198 and the
shortest real essay in any corpus measured is 492, so 300 separates the two populations with roughly 1.6×
clearance on each side, sits above every Ghost event announcement and below every blog post.

**Spread stays a fraction of Items, not of words.** Word-weighting is the obvious alternative and it
reintroduces exactly what the floor exists to prevent — *one loud Item becoming a personality trait*. A single
four-hour lecture is 35–40,000 words, **the majority of a Corpus containing it**, and its verbal tics would
become the person. Item-spread was always the right statistic; it only ever needed comparable items, and now
it has them.

**Short-form is read, not ignored — it is excluded from Voice alone.** Skeets, event announcements and Shorts
still feed Beliefs, Reasoning, Positions and Coverage. The line: **short-form tells you what someone thinks;
long-form tells you how they argue.** The moves Voice counts — hedging, direct address, concession — are
argumentative moves, and the extractor is already licensed to answer *"no argument"* for a day of posts.
Measuring argumentative moves over writing that contains no arguments was never going to produce an
instruction worth performing in someone's name.

**A person with no long-form at all is labelled, not withheld.** The floor drops to whatever the Corpus
offers, Voice is measured over that, and `measured_over` records it truthfully — so the Persona says it
measured voice from 200-word batched days and a reader can weigh that. The same posture the gate already
applies to inferred layers, and refusing to publish them would make the largest new Source unbuildable.

**Coverage stops leading with a single item total, and gains `by_form`.** `by_source` answers *who* and stays;
`by_form` answers *what shape*, which is the question a mixed Corpus makes urgent. The headline sentence leads
with **words**, which are comparable across forms: *"read 963 items"* flatters a Corpus that is mostly
one-liners, and *"read 89,000 words — 63 long-form items and 900 short posts"* does not.

**And Coverage names the Voice population as a blind spot**, which is what Coverage is for:
*"Voice was measured from 63 items of 300 words or more. 900 shorter items were read for what they say, not
for how they say it."*

Three costs, named. **Voice exemplars will never be a skeet**, even for someone who is 95% skeets — intended,
and stated in Coverage. **`VOICE_MIN_WORDS` is a chosen number**, in evidence and in `compiler_version`, so
changing it rebuilds every Persona visibly. And **a long-form-heavy Corpus gains nothing from this** and pays
a filter it does not need — one comparison per Item, no model call.

*Rejected: Voice per Source.* Two Substacks by one person are the same form. *Rejected: Voice per form,
published as two Voices* — braintrust serves one Persona and nothing at answer time knows whether the asker
wants an essay or a line, so it pushes an unanswerable choice downstream. *Rejected: selecting the population
from the Notes* — elegant, needs no threshold, and puts a model in the one path that has none.

### What the build settled about the growing layer

**A Position is `measured` because the model is only allowed to group.** The clustering prompt is handed claim
*refs* braintrust issued and may only copy them back; every quote against a citation was located in the stored
body when the Item was read, and nothing on this path can add, edit or reattribute one. What a model
contributes is which claims belong together and one sentence saying what they share — so the statement is a
model's and everything under it is the Person's own characters. That is also why
[`braintrust_find_positions`](./mcp-surface.md#3-braintrust_find_positions) never returns a statement without
its citations: the label survives only while the evidence travels with it.

**A Position braintrust cannot cite is dropped**, the same rule as a claim it cannot quote and an inferred
entry it cannot attribute. A grouping that resolves to no ref braintrust issued is not written, and the
[gate](#5-a-compile-must-earn-the-right-to-replace-its-predecessor) then checks the same property against the
rows — deliberately twice, because the rule matters more than the code path that enforces it.

**The Core is bounded per layer; the growing layer is bounded per call.** Both fold a large Corpus into passes
and merge, but capping every clustering call at the same number would also cap the *merge*, which would
quietly limit a 400-Item Persona to one pass's worth of Positions. So a pass may return at most 24, and the
layer itself is free to grow. The merge needs no bound of its own: it answers with indices into the list it
was handed, so it can no more return a fresh list than it can invent a claim — see below.

**The merge is handed wording, not evidence, and folds when it overflows.** Every step of a Compile is
budgeted so that a growing Corpus adds *passes* rather than lengthening any one call. The merge that follows
those passes was the exception: a single call whose input grew with the Corpus, which made it the one place
where a Person who publishes more got a worse Persona and eventually none.

It now does one job instead of two. Collecting the evidence behind entries that turn out to be the same is
arithmetic and has a right answer; deciding that two differently-worded entries say the same thing is
judgement. **Only the judgement is given to a model.** The merge sees one line per entry — an index and the
wording — and answers with groups of indices naming which member reads clearest. braintrust unions the claim
ids and Item ids itself and keeps the clearest member's text verbatim, so **no step of a Compile rewords a
Persona's own output**: what a reader reads was written by a pass that actually read the evidence.

Three consequences worth naming. A merge **cannot touch a citation** — it is not checked afterwards for
invented refs, because it never sees one, and the pass-level attribution checks become the only ones there
are. `item_count`, `held_since`, `days_spanned` and `confidence` are derived **once, from the merged
evidence**, so a view argued for years across several passes is graded on the whole of it rather than on the
slice one pass happened to see. And the merge takes **the same character budget as the passes that feed it**:
under budget it stays one call, and over budget braintrust folds in rounds — each round's survivors becoming
the next round's input, unions accumulating outside the model.

**A fold that stops shrinking ships anyway.** A round returning no fewer entries than it received ends the
fold, and the layer publishes what it has — merged where the fold worked, still fragmented where it did not —
with its opening line disclosing that duplicate entries may remain. A cosmetic limit never costs a reader
their Persona. Layers record the round count and whether the fold converged, so a Corpus approaching the fold
is visible before it becomes a failure. See
[ADR 0004](../adr/0004-the-merge-is-handed-wording-not-evidence.md).

**Confidence is absolute, not proportional.** Voice measures habits *within* a Corpus, where a third of Items
means something. A Position is a thing someone has said, and saying it across five separate pieces of work is
the same signal whether they have published thirty or three hundred: 5+ Items is `high`, 2–4 `moderate`, 1
`low`. Starting points to tune, not findings — and the grade never filters anything. It travels beside
`item_count` so that **a client** can decide what one mention is worth.

**`item_count` stays the denominator and the thresholds stay 5 and 2, even for short-form.**
[#65](https://github.com/cgbarlow/braintrust/issues/65) asked whether five skeets should earn what five essays
earn, and half the question had already been answered elsewhere: a day is the Item, so five posts in an
afternoon are **one** Item, and one Item grades `low` automatically. The sentence this document rests on —
*saying it in five separate pieces of work is the same signal* — survives contact with short-form, because a
batched day **is** a separate piece of work. *Rejected: counting distinct Sources*, since most people have one
or two and every grade would collapse. *Rejected: counting words*, for the reason Voice rejects it — one
four-hour lecture would outweigh everything else a person ever wrote.

**Confidence is capped at `moderate` when every citation falls inside a single 7-day window.** What survived
#65 was the burst, and **it was never short-form-specific**: five essays published in one week about one event
grade `high` too. That is one occasion wearing five dates, and long-form has always been able to do it —
short-form only made it common. The principle: **a Position genuinely held gets said again later; one that is
a reaction does not.** Form-neutral, computed from the `published_at` the citations already carry, needing no
new population and no stored field.

**A Position reports its span, not only its beginning.** `held_until` and `days_spanned` sit alongside
`held_since`, derived from the citations the same way. This is what the grade exists for: the grade *never
filters anything, it only travels alongside `item_count` so a client can* — and a client currently cannot tell
`high` across three years from `high` across five days. Now it can, from three fields the Position already
serves.

**A mixed-form Position is graded on the whole set — deliberately not Voice's move.** Voice filters by length
because Voice is about **how** someone argues, so form *is* its subject matter. A Position is about **what**
someone holds, and holding it is holding it. Dropping the short-form citations would make a Position look
thinner than the evidence actually is, and `item_count` would become a count of something other than what
braintrust found.

**A Position whose citations are all undated cannot be capped** and keeps its item-count grade, by the same
logic that has revisions refuse to judge a pair they cannot place in time. braintrust does not penalise what
it cannot measure; it declines to claim it. `held_since` is already null in that case and `days_spanned` is
null with it.

Three costs. **7 days is a chosen number**, exactly like 5 and 2 — and unlike those two it travels in the
served data as `days_spanned`, so a reader can disagree with it using the same numbers braintrust used. **A
genuinely intense week of real work grades `moderate`** until the person returns to the subject, which is the
definition of *not yet shown to persist*, and the Position is not hidden — it is served with its span visible.
And **the cap can be reached by a backfill**: a Position that was `high` on a single week and gains no later
citation drops to `moderate` on the next Compile.

**`held_since`, `held_until`, `days_spanned` and `item_count` are derived from the citations at every
Compile**, never carried forward, which is what makes a backfill that reaches further back move `held_since`
earlier by itself. Less stable across Compiles, more honest. Two claims quoting the same words in the same
Item collapse to one citation, because a Position that cited a sentence twice would inflate the only number a
reader has to judge it on.

**Slug collisions get `-2`.** The spec left the suffix open; a reader seeing `evals-precede-the-harness-2` can
tell it is a second Position on the same ground rather than a different one.

---

## 3. The inferred marker is written by the compiler, never by the serialiser

[#11](https://github.com/cgbarlow/braintrust/issues/11),
[#16](https://github.com/cgbarlow/braintrust/issues/16)

**Every layer with `basis = 'inferred'` opens `descriptive_md` with a marker line** — e.g.
`**Inferred across 412 items — no single item asserts this.**`

This is a compiler contract, not a rendering rule. The MCP boundary also returns `basis` as a field, but it
does not synthesise the prose marker, because the most likely use of a layer is a client pasting the markdown
into a system prompt — where a JSON field would be lost and a marker line survives.

The [gate](#5-a-compile-must-earn-the-right-to-replace-its-predecessor) checks it, anchored at the start: a
marker further down the layer is not a label a client pasting the opening paragraph would carry.

### What the build settled about the inferred half

**An inferred entry braintrust cannot attribute to Items it holds is dropped** — the same rule as a claim it
cannot quote, applied to the layer that has no quotes. Each entry in Reasoning and Beliefs names the Items it
was traced to; ids that were not in the Notes handed to the synthesiser are removed, and an entry left holding
none is not published. The prose is a model's, and what it rests on is not allowed to be.

**Traced, not counted.** A Corpus too large for one pass is folded — synthesised in passes and merged — and an
entry found in one pass carries only that pass's Items. So `23 of 412` in an inferred layer is a **floor**: the
Items the entry was traced to, not a tally of the Items that show it. Voice says *measured in*; this
deliberately says *traced to*, because the two numbers are not the same kind of thing and one prose style for
both would quietly claim the stronger one.

**`entries: []` and a missing `entries` are different failures.** An empty list is a legitimate answer — the
prompt asks for a short list that is really there over a long one partly hoped for — and it produces a layer
the gate refuses. A *missing* `entries` key means the endpoint answered a different question, and it fails the
Compile with that as the reason. Collapsing the two was tried and rejected in the live run: a model answering
in the extractor's shape reached the gate as *"beliefs carried nothing to serve"*, which sends whoever reads it
looking at the Corpus instead of at the endpoint.

**Synthesis is versioned separately from measurement.** `compiler_version` is
`0.1.0+measured-3.core-1.positions-2.revisions-1` — the hypothesis that produced the counts, the prompt that produced the
prose, and the prompt that grouped the Positions. Three versions rather than one because they change for
different reasons, and all of them are cheap in a way bumping `notes-1` is not: they re-read Notes that
already exist rather than re-reading the Corpus.

**A rules change triggers a rebuild in its own right**, not only new content. braintrust watched two clocks
and only one existed: new content triggered a rebuild, a rules change triggered nothing, reported nothing and
was watched by nothing — one Persona in the live fleet differed on one part of its compiler version for three
days. A run now asks two questions of every Person (`has_unseen`, `stale_compiler`) and rebuilds on either.

**The parts say what moved; they do not license rebuilding piecemeal.** A rules change rebuilds the *whole*
Persona. What the decomposition is for is deciding what a Persona may **serve in the meantime**, and that is
decided part by part on the read rather than on a clock.

**The catch happens on the read, not on a clock.** Loading a Persona compares its version against the running
compiler's, and what that comparison changes is immediate and happens *for the reader who arrived*: the
retrieval gate tightens — a floor measured under rules that have since changed is not a measurement any more,
so it takes [the unmeasured value](./mcp-surface.md#an-unmeasured-quantity-takes-its-most-conservative-value)
— and prose written by a part that moved is withheld. **So the staleness window is zero for anyone actually
reading.** Nobody is ever served a Persona built under rules braintrust has since changed.

**The rebuild is queued behind them, never in front.** It starts after the answer has been handed over and
nothing awaits it: a read call must never have the most expensive action in the product sitting behind it. A
reader who triggers a rebuild pays nothing for it and does not see it. **At most one rebuild is in flight per
Persona**, so a burst of readers on a behind-version Persona cannot stampede the compiler — a process-local
guard, and the database's own `unique … where status = 'running'` as the real one, which is what makes it hold
across the two deployments that share the database.

**And a daily sweep rebuilds the Personas nobody asked for**, so staleness is not only fixed for popular
people. Every cycle then asks a **scheduled check** — *is any serving Persona carrying a version behind the
compiler's?* — after the run rather than before it, and reports the answer in the summary whether or not
anyone is looking. It is a post-condition rather than a trigger: what rebuilds a Persona is `stale_compiler`;
what this asserts is that the run left nobody behind. A paused Person is not counted — a pause is the user
freezing their Persona.

**Prose governed by a part that has moved is absent, not stale.** A number has a conservative direction and
takes it; a paragraph a model already wrote does not, so the only honest options are to serve it or not to —
see [an unmeasured quantity takes its most conservative value](./mcp-surface.md#an-unmeasured-quantity-takes-its-most-conservative-value).
The absence is silent in the Script: a Persona withholding its Reasoning reads exactly like one that never had
any, and `explain_persona` carries the `withheld` list because that is where questions about braintrust's own
workings belong. A version braintrust cannot decompose — one written by an older braintrust — reports **every**
part moved, for the same reason the floor falls back upward.

---

## 4. Revisions: show the tension, never assert it

[#7](https://github.com/cgbarlow/braintrust/issues/7),
[#16](https://github.com/cgbarlow/braintrust/issues/16)

The real signal is soft. Fourteen months of near-daily output yielded **one** clean supersession, and it was
findable only because the creator titled a video about it. **Frequency shift demonstrably does not work** —
the largest shifts in the Corpus are new product names appearing because the products are new.

**Candidates are found by embedding claim statements and comparing within a similarity neighbourhood**, then
judged pairwise by a model. Pairwise over every claim does not scale; pairwise within a neighbourhood does.
The similarity threshold wants measuring against the real Corpus rather than choosing now.

**Claim vectors are computed during a Compile and thrown away.** ~2,000 claims ≈ 80K tokens — under a fifth of
a cent hosted, free locally. They have no reader after the Compile that made them, so
[`braintrust_embeddings`](./schema.md#tier-2--derived-expensive) keeps its `(chunk_id, model)` key untouched
and no table is added.

**The judgement is allowed to be uncertain, and the uncertainty is the label.** `revised` / `unsettled` /
`drifting` is a confidence spectrum, so the compiler's confidence is the thing that picks between them rather
than a separate score.

**Only `revised` changes what the Persona says.**

- **`revised`** requires evidence a reader would accept as explicit — a claim withdrawn, narrowed or reversed
  in the Person's own words. It moves a Position off `current`.
- **`unsettled`** and **`drifting`** leave **both** Positions current, are returned with their relation and
  rationale inline when a client asks, and **never appear in a Core layer**. They are visible when someone
  goes looking; they are never spoken in the Person's voice.

The reason for the asymmetry is the one error a provenance-first project cannot absorb: flagging everything
that looks like tension reliably mistakes a rephrase for a reversal, which puts a contradiction on a real
person's record that they would dispute.

Relation direction and the read path are in
[`schema.md`](./schema.md#tier-3--derived-cheap) — `from` is the earlier Position, `to` the later, and
`relation` describes what the later does to the earlier.

### What the build settled about revisions

**The floor was measured, not chosen.** Over 275 claims extracted from 23 real Substack posts and embedded
with a real sentence-transformer, the 36,168 cross-Position claim pairs run: median 0.175, p99 0.593, max
0.907. Reading the pairs at each level is what picked the number. At 0.62 they include *"the most common
approach is to treat AI like a human"* against *"every few months I put together a guide on which AI system to
use"* — a shared subject only in the sense that everything in that Corpus is about AI. From about **0.65** up
they are recognisably about one thing, and the nearest pairs are the same claim restated months apart, which is
exactly the shape a revision has. It is a **recall** knob rather than a verdict: everything above it is still
judged, and the judge answers `none` to most of it. **It is a property of the configured embeddings model, not
of braintrust** — an operator who changes model should re-measure it the same way.

**Direction comes from the dates, never from the model.** `from` is whichever Position has the earlier
`held_since`, and `gap_days` is the distance between the two dates a reader is already shown — so both can be
checked against the Positions rather than taken on trust. **A pair braintrust cannot order in time is
dropped**: with no date on one side, or the same date on both, there is no earlier, and saying which came
first would be exactly the guess this layer exists to avoid.

**The judge is asked about Positions and shown claims.** A candidate pair is represented by the two nearest
claims, one per side, with the Person's own quote against each — because `revised` is defined as a change *in
their own words*, and a judge shown only braintrust's summaries would be grading two summaries against each
other. A hundred near-identical claim pairs between the same two Positions is still one question.

**A judgement on a pair braintrust never sent is dropped**, the same rule as a claim ref a clusterer invented,
and so is a relation naming a Position this Compile did not write — the ids come from the write, not from a
lookup, so a relation cannot reach back to a previous Compile's rows.

**No Compile may retire more than half a Persona.** Found live: a judge answering `revised` freely superseded
18 of 23 Positions in one rebuild, and every other check passed — the rows were well-formed, dated, cited and
ordered, and the Persona was quietly four-fifths retired. Real supersession is rare, so a rebuild that takes
half of what someone holds off `current` is describing the model rather than the author. The
[gate](#5-a-compile-must-earn-the-right-to-replace-its-predecessor) rejects it and yesterday's Persona keeps
answering.

**Accepted costs.**

| Cost | Why it is worth paying |
| --- | --- |
| The per-Compile bound is 120 pairs, so a large Corpus judges only its nearest neighbours | Pairs grow with the square of the Positions. The nearest are where revisions live, and `bounded_out` is counted and logged rather than hidden — a bound nobody is told about reads as coverage |
| Two Positions with the same `held_since` are never compared | There is no earlier, and inventing one to fill the field would put a direction on the record that nothing supports |
| A revision missed is invisible; only a revision recorded is legible | The asymmetry is deliberate. The judge is told to answer `unsettled` whenever the call is close, because a rephrase recorded as a reversal is the one error this project cannot absorb |

---

## 5. A Compile must earn the right to replace its predecessor

[#16](https://github.com/cgbarlow/braintrust/issues/16)

A rebuild deletes the Persona it replaces, in one transaction, and there is deliberately no archive to fall
back to. **The gate closes that hole without reintroducing history:** a Compile is built under
`status = 'running'`, checked, and only then promoted to `current`. Fail, and it is recorded as `rejected`
with its reason while the previous Compile stays live and untouched.

**This is what `lint` becomes** in a regenerate model — a quality gate on compiler output rather than a drift
sweep. Failing means *not published*.

The v1 checks are **structural, never semantic** — a check that needs a model to run is a check that can fail
the way the compiler fails:

| Check | What passing guarantees |
|---|---|
| `core_layers_present` | all four Core layers exist and each carries something a client could serve |
| `voice_has_both_forms` | Voice carries both `descriptive_md` and `generative_md`, so the instruction can be checked against its evidence |
| `inferred_layers_marked` | every layer with `basis = 'inferred'` opens with the marker |
| `coverage_reconciles` | Coverage counts match `braintrust_items` |
| `positions_are_cited` | every Position resolves to at least one real citation |
| `positions_have_not_collapsed` | the Position count is not a collapse against the previous Compile |
| `speak_opens_with_disclosure` | the first line a reader hears is the disclosure, word for word, and not an instruction addressed to the model |
| `revisions_have_not_swept` | no more than half the Positions were superseded on this rebuild |

**The gate is a list, not a function with a clause per rule.** Every check is a named entry carrying the
guarantee it protects and the reason it gives when it fails, so the whole set can be listed *without running
it* and a rejection records **which** check failed rather than only that one did. Adding a check is appending
an entry; nothing about the control flow that runs them changes. That is the point — the checks outnumber
their author's memory, and a maintainer reading a `rejected_reason` needs the name to lead back to what was
being protected.

The promoting transaction is in [`schema.md`](./schema.md#rebuilding). Four properties it buys: a failed
Compile changes nothing; a rejected Compile keeps its rows for inspection; `on delete cascade` does all the
cleanup; and **regeneration stays affordable only while the Core stays bounded.** If the Core ever grows with
the Corpus, full regeneration stops being cheap and the no-drift guarantee goes with it.

**A gate rejection does not stop the schedule.** The daily job keeps trying, because a retry is cheap and new
Items can genuinely fix a gate failure — a Position-count collapse caused by a thin day resolves itself the
next day.

### Three things the build settled about promotion

**The `running` row is committed before the layers are built, and only the promotion is a transaction.**
Wrapping the whole Compile in one transaction would make "a failed Compile changes nothing" true by
construction — and would also hold a connection open across minutes of model calls, and make the `running`
partial unique index unobservable to anyone else, which is the one thing it exists for. The promotion buys the
same guarantee: the delete of the old `current` and the promotion of the new one are one statement pair, so
there is no instant in which a client can observe neither Persona.

**A Compile whose process died must not freeze a Persona forever.** With `running` visible, a crash leaves a
row nobody will ever finish, and left alone it would refuse every future rebuild of that Person — a crash on a
Tuesday becoming a permanently stale Persona. A `running` Compile older than six hours is therefore recorded
as `failed` by the next run and taken over. **The daily clock is the recovery mechanism**, so a crash costs a
day rather than a Persona.

**"Non-empty" for an inferred layer means it lists something, not that it has prose.** The likeliest way this
gate fires in practice is a synthesis that came back with nothing usable — and the layer that produces is not
blank. It is a marker, a sentence saying so, and no entries. A check on prose would pass it. So an inferred
layer is empty when its `evidence.entries` is empty, whatever prose surrounds the fact.

**The gate reads the rows back rather than checking what the compiler is holding.** A gate fed the compiler's
own in-memory view would confirm that the compiler agrees with itself; what is worth knowing is whether the
rows a client is about to be served agree with the rows they claim to describe. Coverage in particular is
recounted against `braintrust_items` at gate time, not trusted from the layer that was just written.

**A rebuild waits for an empty Backlog, and vectors are not in it.** What the Core reads is Item text and
Notes, so the Backlog a Compile waits on is Items to retrieve, Items to chunk and Items to read. Nothing in
the Core reads an embedding, and blocking a rebuild on the index would hand a switched-off embeddings endpoint
a veto over the two layers that cost nothing to compute — while the whole reason chunking survives an endpoint
being off is that the vectors are allowed to wait. Position retrieval is what needs them, and that is a
serve-time concern.

---

## 6. Chunking: the platform's boundaries, never a model's

[#14](https://github.com/cgbarlow/braintrust/issues/14)

**Chunks are overlapping windows of roughly 1,000–1,500 characters, split at platform boundaries, never
spanning an Item.** Caption events for transcripts, paragraphs for prose. `start_ms` and `end_ms` come free
from the caption events, which is what makes a claim citable to a moment inside a twenty-minute video rather
than to the video.

**One chunking path, parameterised — not two.** Two code paths for boundary detection, one for everything
after: both fill the same window size and write the same rows, with `start_ms` null for prose.

**Built with 1,500 characters as the ceiling and one whole unit as the minimum overlap**, extended backwards
while the repeated text stays under 200 characters. Two shapes fall out of that and both are wanted: a
transcript repeats four or five caption events, because the boundary between two of them is arbitrary and a
sentence spanning the join has to survive somewhere; prose repeats one paragraph, because a paragraph is
already longer than 200 characters and repeating a second would pay for the same words three times. Overlap
costs about a third more Chunks — three cents against the measured Corpus, which is not a number any decision
here should turn on.

Three details the build settled:

- **A prose boundary is any newline the markup declared, not only a blank line.** `htmlToText` writes one
  newline for a `<br>` and two for a closed block, and both are boundaries the author's own markup put there.
  Taking the smaller one keeps units small enough that a window is filled by several rather than truncated by
  one.
- **A caption event ends where the next one starts**, because the format carries no durations; the last event
  ends at the length of the video.
- **`chunk.text === item.body_text.slice(char_start, char_end)`, exactly.** That invariant is what makes a
  quote checkable against the stored body without trusting the chunker, and it is asserted in SQL rather than
  in the chunker's own terms. A unit longer than one window is cut at the last space before the limit — a
  measurement, not a judgement about where a thought ends.

**No model is in this path, and that is the point.** `braintrust_chunks.text` is what a citation's `quote` is
drawn from, so a punctuated Chunk would make every quote a model's rendering of what someone said rather than
what they said. A punctuation-restoration pass was rejected outright; a pass returning only sentence
*boundaries* survives that objection and was rejected too, on what it buys — Chunk boundaries serve retrieval
only, and overlapping windows already prevent a passage being cut in half.

**Accepted cost, stated plainly: passages read badly.** Most of the Corpus is auto-generated captions, so
`braintrust_find_positions` returns an unpunctuated wall of lowercase. That is what was said, labelled as what
was said. A client is free to tidy it for display; braintrust stores and cites the original.

**Re-chunking drops tier 2 and rebuilds it**, for about three cents.

### What a mixed Corpus did not change

[#68](https://github.com/cgbarlow/braintrust/issues/68)

**The chunker does not change, and that is the surprising part.** Batching Bluesky into a day puts an Item at
~200 words ≈ **1,200 characters** — inside the 1,000–1,500 band this section was built for. *The batching that
created the mixed Corpus is the same decision that made its short end fit the existing chunker.* A passage
that is a whole Item needs no different treatment; the overlap does nothing for it, and that is correct, since
overlap exists so a sentence spanning an *arbitrary* boundary survives somewhere and a single-chunk Item has
no arbitrary boundary.

**Chunks never spanning an Item is now load-bearing rather than incidental.** The minimum window is 1,000
characters and a one-post day is ~200, which could be read as licence to glue two days together. It is not:
chunking runs per Item, so a short day becomes a short chunk of its own. **A citation resolves to an Item, so
a chunk spanning two Items would be uncitable** — and a Position braintrust cannot cite is dropped. Recorded
here because it was a free property when every Item was an essay and is a constraint now.

*Rejected: chunking short Items differently*, merging days into week-sized passages to match essay-sized
chunks. It would make citations resolve to something that is not an Item, which is settled the other way: a
Position cites the individual post, resolved from where the verified quote falls.

---

## 7. Embedding: one model, one space, everywhere

[#14](https://github.com/cgbarlow/braintrust/issues/14),
[#11](https://github.com/cgbarlow/braintrust/issues/11)

**braintrust declares no embedding model.** It calls whatever OpenAI-compatible `/v1/embeddings` endpoint it
is configured with — see [`deployment.md`](./deployment.md#3-configuration) for the configuration, the absence
of a default, and the two startup checks.

What matters to the compiler:

- **Chunks are embedded at ingest; queries are embedded at serve time with the same model.** Swapping models
  means re-embedding tier 2 before any query works again.
- **Chunking and embedding are the fourth step of the daily cycle**, corpus-wide rather than per-Source,
  because a Chunk belongs to an Item and neither step cares which platform the words came from. They are
  ordinary Backlog work: an Item with a body and no Chunks, and a Chunk with no vector under the configured
  model, are both queries over rows that already exist. No job table, no checkpointing — a run killed at
  minute 12 has written twelve minutes of real rows.
- **Chunking survives an endpoint being switched off.** It is local and free; the vectors are the part that
  waits. A run with no reachable endpoint chunks everything and embeds nothing, and the next run finishes.
- **Batched 32 Chunks to a request.** ~11K tokens, comfortable for a small local model, and one round trip
  instead of thirty-two. A batch returned short or reordered is refused rather than guessed at: pairing a
  Chunk with another Chunk's vector is undetectable forever after.
- **`model` is in the primary key of `braintrust_embeddings`**, so a better model is a new set of rows rather
  than a migration. Old and new coexist while you compare them, and Chunks and Items are never touched — which
  is exactly the README's promise that raw content and embeddings stay separate.
- **Never mix vector spaces.** Cosine similarity across model families is meaningless *even when the
  dimensions match*, so a same-size model swap without a re-embed returns confidently-ranked nonsense.
  braintrust also never compares its vectors to `thoughts.embedding` and never calls `match_thoughts`.

### Retrieval ranks Items, not passages

[#68](https://github.com/cgbarlow/braintrust/issues/68)

**Corrected.** Retrieval was described here and at
[the tool surface](./mcp-surface.md#3-braintrust_find_positions) as finding matching Chunks and mapping their
Items to Positions. It already collapsed Chunks to Items and judged each Item on its **best** passage — that
part was right — but the candidate limit was applied **before** the collapse, so an Item's chance of surviving
to the collapse was proportional to **how many Chunks it has**, which is a proportion of its length and
nothing to do with relevance.

Against a Corpus of 40 lectures (~7,200 chunks) and a year of batched Bluesky days (~365 chunks), long-form
holds **95% of the tickets in a 60-ticket lottery**: a four-hour lecture enters with 180 entries, a day enters
with one. This is a live bug rather than a new-source concern — the lectures are already in the Corpus.

**So the truncation moves to after the collapse, where it always belonged.** Each Item competes once, on its
single best passage, and a lecture and a skeet-day are equals at the point of ranking. Nothing about relevance
changes: the retrieval floor still refuses anything too distant, and a lecture that genuinely is the best
answer still wins on its best passage. What it loses is the advantage of simply being long.

**The chunk pool is over-fetched by a bounded factor to feed the collapse.** pgvector returns approximate
top-k over Chunks, so a Chunk-level candidate pool is still how the Items are found; it just has to be wider
than the number of Items wanted. The factor is a tuning constant with the same status as every other number
here — *a starting point to tune against real retrieval results rather than a decided value* — and it is
bounded, so the query stays a single indexed top-k rather than a scan. **Built at 8**: 480 Chunks to rank 60
Items, against the ~7,600 Chunks the measured Corpus holds.

**Bounded means bounded, and the residual is named.** A pool a few very long Items monopolise yields *fewer*
Items, not longer ones — the answer narrows, and it never re-sorts by length. That is the failure worth
having, and it is the one the factor is there to be tuned against.

**Re-embedding is not required**, and this does not move `compiler_version` or rebuild any Persona. Nothing
about the Chunks or the vectors changes, only which candidates the query keeps.

*Rejected: raising the candidate limit.* It scales both sides of a 20:1 ratio and fixes nothing. *Rejected:
capping Chunks per Item inside the hit stage.* Equivalent in effect, expressed less directly, and it needs a
window function and a second constant. *Rejected: weighting short-form up to compensate.* It puts a thumb on
relevance to fix a population artefact, and braintrust would then be choosing what someone is likely to have
meant.

**Accepted cost:** a long Item can no longer surface twice on two strong passages. It never could — the
collapse already made it one row — so what this stops is it *crowding out* other Items on the way there.

### What it costs

Priced against the real Corpus. **The expense is entirely the compiler reading; the embedding rounds to
nothing.**

| | Volume | Hosted cost |
|---|---|---|
| Embed the whole Corpus | ~1.23M words ≈ 1.6M tokens | **~$0.03** |
| Read every Item to write its Note | ~1.6M in, ~0.3M out | **~$3** |
| Embed claim statements for revision detection | ~2,000 claims ≈ 80K tokens | ~$0.002 |
| Embed one query at question time | ~20 tokens | rounds to zero |
| Steady state, per day | ~6,000 words | rounds to zero |

**Standing up a Persona from nothing costs a few dollars; a full re-index costs three cents.** Local inference
makes all of it free. Affordability never constrained regeneration, and no decision should be justified by
embedding cost.

---

## Accepted costs

| Cost | Where it comes from |
|---|---|
| **You can sit on a stale Persona without knowing.** The gate records why it rejected; nothing in v1 reads it. | §5 |
| **Passages read like unpunctuated speech**, because that is what they are. | §6 |
| **Beliefs are uncitable.** No single Item asserts one, so provenance comes from the label rather than from pretending otherwise. | §2 |
| **Voice can only find moves someone thought to look for.** A Corpus whose most distinctive habit is not in the pattern list is measured as ordinary, and nothing in the layer can notice the omission. | §2 |
| **An inferred entry's item count is a floor, not a tally.** A folded Corpus attributes each entry to the pass that found it, so a move genuinely present throughout can be traced to a fraction of the Items. The prose says *traced to* rather than *measured in*; it cannot say how much it missed. | §3 |
| **A Compile that fails the gate spends the synthesis anyway.** The model calls happen before the check, because most of what the gate checks does not exist until they have. A persistently rejected compiler pays full price every day for a Persona nobody receives. | §5 |
| **A Position's statement is a model's sentence.** The claims under it are verified and the grouping is checked against refs braintrust issued, but the one line a client is most likely to quote was written by a model summarising them. It is why the statement is never served without its citations. | §2 |
| **Two passes may name the same Position differently and the merge may miss it.** Deduplication across a folded Corpus is a model's judgement, and a near-duplicate that survives shows up as two thin Positions rather than one supported one — which understates `item_count` on both. A fold that stops converging is disclosed; one that simply misses a pair is not. | §2 |
| **Two duplicates each saying half of something are not combined into a better paragraph.** The merge selects the clearest wording rather than composing a new one, so the clearer half wins whole. That is the price of no step of a Compile rewording a Persona's own output. | §2 |
| **Voice exemplars will never be short-form**, even for someone who is 95% short-form. Coverage states the population it was measured over, so the omission is named rather than hidden. | §2 |
| **A genuinely intense week of real work grades `moderate`** until the person returns to the subject. The Position is served with its span visible rather than hidden. | §2 |
| **braintrust owns a compiler forever.** Nothing upstream can be adopted. | header |
| **Genuine revisions are rare.** One clean supersession in fourteen months; if Persona value depends on capturing revisions, the Corpus needs to be years deep. | §4 |
| **About a fifth of what the extractor proposes is thrown away**, measured at 291 of 1,093 on the first real corpus. 87 of those differ from the body only in punctuation and case and are dropped anyway; the rest quote words that are not there. Stated rather than engineered around: the alternative is a Persona citing a model. | §1 |
| **A quote drawn from an Item's title is always dropped.** The model is shown `Title: …` above the body and verified against the body alone, so a title quote has nowhere to resolve to. Small, and not worth a Corpus re-read to remove on its own. | §1 |

## Deliberately not decided

- Which model writes the Note. Configured, never defaulted — the endpoint is handed whole published Items, and
  where those go is the operator's decision rather than braintrust's assumption.
- The Note-taking prompt itself. Version `notes-1` exists and is a **starting point, not a finding**: it asks
  for claims with verbatim quotes, the argument, and the assumptions, and it is versioned precisely so that
  improving it costs a re-read rather than a migration.
- The similarity threshold for revision candidates.
- **The voice moves themselves, and the spread thresholds that turn them into instructions.** Version
  `measured-1` counts six moves at a third and two thirds of Items, and it is a **starting point, not a
  finding** — the same status as `notes-1`, and versioned in `compiler_version` for the same reason. Tuning it
  is a free rebuild, because the layer costs nothing to compute.
- **The synthesis prompts, and how many entries a layer may carry.** Version `core-1` asks for at most eight
  entries per layer and is a **starting point, not a finding**, like `notes-1` and `measured-1`. The cap is
  what keeps the Core bounded — regeneration stays affordable only while it is — but eight is a judgement
  rather than a measurement.
- **How large one synthesis pass may be.** Built at 120,000 characters of digest, which held about 380 Items
  of the size the live probe produced and would hold fewer of a richer Note. Tuning it is a free rebuild.
- Exact chunk window size and overlap. Built at 1,500 characters with one unit of overlap, and still a
  starting point to tune against real retrieval results rather than a finding.
- Whether a reranker is ever added. Retrieval quality should be measured before anything is added to fix it.
- Concurrency against the embeddings endpoint. Batching is 32 to a request and sequential; nothing has been
  measured that would justify more.
- Whether a persistently rejected Compile is ever surfaced to a human. Still no in v1.
- **How much thinness to surface.** Both prototypes keep it visible; `item_count` and `confidence` travel with
  every Position and the client decides what one mention is worth.
- **The clustering prompt, the per-call bound, and the confidence thresholds.** Version `positions-2` asks for
  at most 24 Positions per call and grades at 5 and 2 Items — **starting points, not findings**, with the same
  status as `notes-1`, `measured-1` and `core-1`. Tuning any of them is a free rebuild. **The 7-day burst
  window has the same status**, and unlike the other two it is visible in the served data as `days_spanned`.
  The version moved from `positions-1` when the burst cap landed, because a grade that now reads dates says
  something different about the same claims, and a Persona has to be able to say which rule graded it.
- **`VOICE_MIN_WORDS`, built at 300.** A judgement rather than a finding, chosen to separate a batched
  short-form day (~198 words) from the shortest real essay measured (492). It travels in `measured_over` and
  in `compiler_version`, so changing it rebuilds every Persona and the change is visible.
- **The over-fetch factor retrieval uses to feed its Item collapse, built at 8** — 480 Chunks to rank 60
  Items. Same status and same honesty as the chunk window and the retrieval floor: a starting point to tune
  against real retrieval results. What is *not* left open is which side of the collapse the truncation sits
  on; only how wide the pool feeding it is.
- **The retrieval floor a question has to clear.** Measured per Persona on every Compile; the number below is
  only what a Persona that measured none falls back to. It was built at 0.35 — *below* the 0.44–0.52 range
  every measured floor has landed in, so the Persona that knew least about its gate was the most credulous.
  It is now a constant **above** that range, because **an unmeasured quantity takes its most conservative
  value**. An empty answer still reports the nearest similarity it saw and the floor it had to clear, so the
  number can be tuned from evidence rather than guessed at twice.

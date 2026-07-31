# The compiler

**Status:** decided. Assembled from
[Shape a persona: what the compiler emits and when it recompiles](https://github.com/cgbarlow/braintrust/issues/7),
[Build braintrust's own persona compiler, or route content through `thoughts`](https://github.com/cgbarlow/braintrust/issues/16)
and
[Choose braintrust's embedding model and chunking strategy](https://github.com/cgbarlow/braintrust/issues/14).

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

---

## 2. Six layers: a bounded core and an indexed growing layer

[#7](https://github.com/cgbarlow/braintrust/issues/7),
[#16](https://github.com/cgbarlow/braintrust/issues/16)

| Layer | `basis` | How it is computed | Model? | Scaling |
|---|---|---|---|---|
| **Voice** | measured | frequency, spread and exemplars counted directly over raw Item text | **no** | converges |
| **Coverage** | measured | counts over `braintrust_items` and their `retrieval` status | **no** | fixed size |
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
`window`, `retrieved`, `skipped_paywall`, `failed`, `words_retrieved`, `by_source`. It is a query over tier 1
written into the layer's `evidence` at Compile time, so it needs no table of its own.

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

**Coverage's fixed shape gained two fields**, because folding either into an existing one would make a Persona
claim a blind spot it does not have: `skipped_short` is braintrust's own policy rather than a Source's, and
`pending` is work not yet done rather than work declined. `by_source` is keyed `platform:handle` rather than
by platform, since one Person may follow two publications on the same platform and merging them silently
would produce a count nobody could check.

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
quietly limit a 400-Item Persona to one pass's worth of Positions. So a pass may return at most 24 and the
merge may return at most what it was handed — the one bound that stops a merge answering with a fresh list of
its own — and the layer itself is free to grow.

**Confidence is absolute, not proportional.** Voice measures habits *within* a Corpus, where a third of Items
means something. A Position is a thing someone has said, and saying it across five separate pieces of work is
the same signal whether they have published thirty or three hundred: 5+ Items is `high`, 2–4 `moderate`, 1
`low`. Starting points to tune, not findings — and the grade never filters anything. It travels beside
`item_count` so that **a client** can decide what one mention is worth.

**`held_since` and `item_count` are derived from the citations at every Compile**, never carried forward, which
is what makes a backfill that reaches further back move `held_since` earlier by itself. Two claims quoting the
same words in the same Item collapse to one citation, because a Position that cited a sentence twice would
inflate the only number a reader has to judge it on.

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
`0.1.0+measured-1.core-1.positions-1` — the hypothesis that produced the counts, the prompt that produced the
prose, and the prompt that grouped the Positions. Three versions rather than one because they change for
different reasons, and all of them are cheap in a way bumping `notes-1` is not: they re-read Notes that
already exist rather than re-reading the Corpus.

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

- all four Core layers present and non-empty
- Voice carries both `descriptive_md` and `generative_md`
- every layer with `basis = 'inferred'` opens with the marker
- Coverage counts reconcile against `braintrust_items`
- every Position resolves to at least one real citation
- Position count is not a collapse against the previous Compile

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
| **Two passes may name the same Position differently and the merge may miss it.** Deduplication across a folded Corpus is a model's judgement, and a near-duplicate that survives shows up as two thin Positions rather than one supported one — which understates `item_count` on both. | §2 |
| **braintrust owns a compiler forever.** Nothing upstream can be adopted. | header |
| **Genuine revisions are rare.** One clean supersession in fourteen months; if Persona value depends on capturing revisions, the Corpus needs to be years deep. | §4 |

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
- **The clustering prompt, the per-call bound, and the confidence thresholds.** Version `positions-1` asks for
  at most 24 Positions per call and grades at 5 and 2 Items — **starting points, not findings**, with the same
  status as `notes-1`, `measured-1` and `core-1`. Tuning any of them is a free rebuild.
- **The retrieval floor a question has to clear**, built at 0.35 cosine similarity. It is the one threshold
  here that **cannot** be measured against the real Corpus, because it is a property of the embeddings model
  an operator configures and braintrust declares none. What v1 does instead is make it visible: an empty
  answer reports the nearest similarity it saw and the floor it had to clear, so the number can be tuned from
  evidence rather than guessed at twice.

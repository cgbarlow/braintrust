# The MCP surface

**Status:** decided. Assembled from
[Define the v1 MCP tool surface](https://github.com/cgbarlow/braintrust/issues/11), plus the sixth tool from
[Define how a person and their sources are registered](https://github.com/cgbarlow/braintrust/issues/17).

**What [the Bluesky and personal-blogs map](https://github.com/cgbarlow/braintrust/issues/52) changed here is
payload, not surface: no tool was added, renamed or removed.** Two new Sources, three more Plan shapes, and
four more fields — and one correction, to what retrieval ranks (§3).

Vocabulary is in [`CONTEXT.md`](../../CONTEXT.md). Transport, auth and hosting are in
[`deployment.md`](./deployment.md); what produces these payloads is in [`compiler.md`](./compiler.md). The
reasoning behind each choice is in the resolution comments linked above — **this document is the surface.**

---

## Six tools, split by what they are for

**Three read tools, two write tools, and one more spent deliberately.** The split is not incidental: the two
read paths mirror the [bounded-core / growing-layer boundary](./compiler.md#2-six-layers-a-bounded-core-and-an-indexed-growing-layer),
so the tool list itself teaches a client the distinction rather than hiding it behind a mode parameter.

| Tool | Kind | `readOnlyHint` |
|---|---|---|
| `braintrust_list_personas` | read | true |
| `braintrust_load_persona` | read | true |
| `braintrust_find_positions` | read | true |
| `braintrust_follow_person` | write, **human-gated** | false |
| `braintrust_refresh_persona` | write, AI-callable | false |
| `braintrust_unfollow_person` | write | false |

All tools are prefixed `braintrust_`. **Nothing is named `search` or `fetch`** — OB1 reserves those.

Five was set as a ceiling requiring a reason, and `braintrust_unfollow_person` is the reason spent: the
alternative was no path at all, and it sits unambiguously beside `follow_person`, so it adds none of the
routing confusion the ceiling protects against. Noted as spent.

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
}] }
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

The Core, whole. No query — this is what a client loads to *sound like* someone. Serving it is reading the
four `braintrust_persona_layers` rows; there is no assembly step.

```jsonc
{ "subject": "braintrust model of Nate B. Jones",
  "compiled_at": "2026-07-28T09:14:22Z",
  "compiler_version": "0.3.1",
  "extractor": "gpt-5@notes-1",
  "speak_as": "Answer as this persona, in its own voice…",
  "layers": {
    "voice":     { "basis": "measured",
                   "generative":  "Hedge before committing…",
                   "descriptive": "Hedges in 32 of 34 measured items…",
                   // `measured_over` names the population, because voice is measured
                   // over items long enough to argue in rather than over the corpus
                   "evidence": { "items_measured": 34,
                                 "measured_over": { "min_words": 300, "items": 63,
                                                    "median_words": 3200,
                                                    "items_excluded": 349 }, … } },
    "reasoning": { "basis": "inferred",
                   "descriptive": "**Inferred across 412 items — no single item asserts this.**\n\n…",
                   "evidence": { … } },
    "beliefs":   { "basis": "inferred", "descriptive": "**Inferred…**\n\n…", "evidence": { … } },
    "coverage":  { "basis": "measured", "descriptive": "…",
                   "evidence": { "window": ["2025-08-01","2026-07-29"],
                                 "retrieved": 412, "skipped_paywall": 304,
                                 "skipped_short": 18, "skipped_window": 4,
                                 "skipped_not_a_post": 3, "pending": 0, "failed": 3,
                                 "words_retrieved": 1170000,
                                 // what shape the corpus is, which one item total hides
                                 "by_form": { "long_form": { "items": 63, "words": 1148000 },
                                              "short_form": { "items": 349, "words": 22000 } },
                                 "voice_measured_over": { "min_words": 300, "items": 63,
                                                          "median_words": 3200,
                                                          "items_excluded": 349 },
                                 "by_source": {
                                   // `blocked_since` present only while a source is refusing;
                                   // `backfill_complete: false` is the separate fact that
                                   // braintrust knows it is behind.
                                   "youtube:UC0C…": { "backfill_complete": false,
                                                      "blocked_since": "2026-07-14", … },
                                   "substack:nate.substack.com": {…} } } }
  } }
```

**`speak_as` is the default response template: named once, then speak freely.** The Core carries braintrust's
bookkeeping *inside the prose it is meant to be spoken from* — the inferred marker, the synthesiser, the items
a point was traced to — because a `basis` field does not survive being pasted into a system prompt. That
labelling is written for whoever is *reading* the Core, not for whoever is being answered, so a client that
speaks it straight produces a persona reciting its own paperwork. `speak_as` says: open with one line naming
the persona as a model, then answer in voice with none of it.

It is a serving concern, not a compile-time one. **Nothing is rewritten and no marker is stripped** — the
stored prose is untouched, the [gate](./compiler.md) still sees its markers, and the redundancy protecting
`basis` survives. The template is an instruction sitting next to the material, and a client is free to ignore
it, which is why the two things it must not ignore are stated *inside* it rather than left to be inferred:

- **The opening line stays.** It carries the disclosure, which is one of the two hard lines. Removing the
  markers from the spoken answer must not become a way to lose it — so it moves from every paragraph to the
  first line, stated plainly, rather than disappearing.
- **Coverage stays load-bearing.** It is where a persona names its own blind spots, and a persona that quietly
  stops admitting what it has not read is the one failure this template can cause. The template requires a
  blind spot to be volunteered when a question lands on one.

**The opening line carries the corpus's scale, and that is the part doing the real work.** Stripping counts
out of every paragraph is the point, but a persona that never mentions its corpus sounds better-read than it
is. Saying it once at the top costs a sentence rather than a marker per paragraph, and a thin corpus announces
itself before the first claim. Paywalled items are named whenever there are any, because scale is exactly
where a corpus misleads: someone whose newsletter is paid and whose videos are public has a large corpus
missing most of their writing.

**It does not govern `braintrust_find_positions`.** There the dates, citations and quotes *are* the answer
rather than scaffolding around it. Asking what someone said is a different act from asking them, and the
template says so explicitly so a client holding it in context does not strip citations from both.

**The counts do not disappear, they stop being spoken.** They stay in each layer's `evidence`, and the
template points at them — a client asked how the persona knows something should answer plainly from those.
That question deserves the paperwork; an ordinary question does not.

**Voice returns both forms.** They are two columns of one row, so returning both costs nothing and cannot
produce an instruction that disagrees with its own evidence. The client acts on `generative`; `descriptive`
and `evidence` are what make the instruction checkable. Returning only `generative` leaves it unfalsifiable;
returning only `descriptive` means two clients build two different personalities from identical data.

**Coverage returns structured counts, not prose containing numbers.** A count buried in a sentence cannot be
checked, filtered or displayed as a fact. The fields are fixed
([compiler](./compiler.md#2-six-layers-a-bounded-core-and-an-indexed-growing-layer)), and Coverage is where a
Blocked Source is named — when it stopped, and how much of that Source went unread.

**Coverage leads with words rather than one item total, and `by_form` is why.** *"Read 963 items"* flatters a
Corpus that is mostly one-liners; *"read 89,000 words — 63 long-form items and 900 short posts"* does not.
`by_source` answers *who* and stays; `by_form` answers *what shape*, which is the question a Corpus spanning a
34-word post and a 40,000-word lecture makes urgent.

**Coverage names the Voice population as a blind spot**, which is what Coverage is for: *"Voice was measured
from 63 items of 300 words or more. 900 shorter items were read for what they say, not for how they say
it."* Those numbers appear in `voice_measured_over` for the same reason every other number does — the rule is
that no figure lives only in the prose. See
[`compiler.md` §2](./compiler.md#what-a-mixed-corpus-changed-about-voice-and-coverage).

**Not compiled → this errors**, and the two ways of having no persona are two different sentences. *braintrust
has never heard of them* sends the caller to `braintrust_follow_person`, which only a human can complete;
*braintrust follows them and has not built one yet* sends them nowhere, because the scheduled job resolves it
without anyone doing anything. See the third rule below.

**`by_source` is keyed `platform:handle`.** One person may follow two publications on the same platform, and a
key of `substack` alone would merge them into a count nobody could check.

**`extractor` says which generation of notes the persona was built from.** It is on the compile row rather
than read from whatever happens to be configured now, because two generations coexist while a prompt upgrade
re-reads the corpus.

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
    "citations": [{ "item_title": "…", "url": "…", "published_at": "2026-03-11",
                    "start_ms": 743000, "quote": "…" }]
  }],
  "passages": [{ "item_title": "…", "url": "…", "published_at": "2026-03-11",
                 "start_ms": 743000, "text": "…" }],
  "more_available": { "passages": 4 } }
```

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

**Never compiled means answer nothing, including here.** The passages fallback applies to compiled Personas
only: "here are some sentences" is not a Persona, and offering it as one would quietly redefine what braintrust
serves. An unembedded Corpus is a refusal with a reason rather than an empty answer, and the tool is not
registered at all in a deployment with no embeddings endpoint — a search that cannot search is worse than one
that is not there.

### 4. `braintrust_follow_person`

**Only a human may cause a new Person to be ingested. An AI may never complete the act.**

A two-call handshake. Call 1 takes the links the human already has — a Substack post URL, a hostname, a
YouTube channel page, an `@handle`, a link to one video, a blog URL, a Bluesky handle — resolves them, and
**ingests nothing**: no Item row, no body, no Note, no embedding. It returns a
[Plan](./ingestion.md#what-a-plan-contains) and a `confirm_token`. Call 2 carries that token and the confirmed
display name, and starts
[the ordinary ingest cycle](./ingestion.md#3-one-daily-job-and-everything-expensive-is-a-backlog).

**A Plan has three more shapes, because there are three more offers.** A Bluesky account is `measured` in days
with its post count as a labelled rate projection; a sitemap-bearing blog quotes *at most N* rather than
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

### 5. `braintrust_refresh_persona`

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

### 6. `braintrust_unfollow_person`

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

## Three rules that hold across the whole surface

**1. A Persona is always named "braintrust model of X".** Never the bare name. The disclosure is carried by
the subject string rather than a boilerplate sentence, so it travels wherever the name travels and costs
nothing per response — which keeps
[the consent posture's](https://github.com/cgbarlow/braintrust/issues/9) disclosure hard line in the payload
rather than demoting it to server instructions. Server instructions still carry the full statement; the
subject string is what makes it unstrippable.

This is a **rendering at the boundary**. `braintrust_people.display_name` keeps the real name. Injecting the
disclosure into `voice.generative` was rejected: a hand-written disclaimer is measured from nobody, so it
would break the property that the generative form is derived from the descriptive one.

**2. `basis` survives twice — as a field and inside the prose.** Every layer returns
`basis: measured | inferred`, and inferred layers additionally open `descriptive_md` with a marker. A client
reading JSON gets it cleanly; a client pasting the markdown into a system prompt — the most likely use —
carries it anyway. **This is a compiler contract: the compiler writes the marker, the serialiser does not
synthesise it.** A test asserts the string appears nowhere on the read path, because a serialiser that could
manufacture the marker would serve an unlabelled layer as though it had been labelled all along.

**An inferred layer's `evidence` carries its entries and what they were traced to** — `items_synthesised`,
`synthesiser`, `passes`, and per entry the Item ids it was attributed to. Every Item named is one braintrust
holds; entries naming anything else were dropped at Compile time and counted in `dropped_unattributable`. The
counts are a floor rather than a tally, which is why the prose says *traced to* and never *measured in*.

**3. Never compiled → answer nothing.** Querying a Persona that has never been compiled returns a clear *"not
built yet"* error rather than compiling on demand or degrading to passages. Compile-on-demand was rejected: a
first question that hangs for minutes and spends real money unannounced is a bad first impression, and it puts
the most expensive action in the product behind a read call. The `passages` fallback therefore applies only to
compiled Personas.

---

## Deliberately not decided

- **How per-Source overrides are expressed in the `follow_person` call** — window, Shorts, poll interval. A
  parameter shape, not a decision.
- **The `confirm_token`'s exact lifetime and encoding.** Short and single-use is the requirement.
- The default passage count, and how trimming is signalled in prose.
- Whether `full: true` is a parameter or a separate call.
- The slug collision suffix format.

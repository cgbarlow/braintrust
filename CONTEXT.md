# braintrust

braintrust builds AI agent personas from the published output of people you follow. It is a separate
extension of [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1) — its own tables in the same
Postgres, its own MCP server.

This file is the project's glossary. It holds vocabulary only; design lives in
[`docs/design/`](./docs/design/) and decisions in [`docs/adr/`](./docs/adr/).

## Language

### The people and what they publish

**Person**:
Someone braintrust models. Independent of any platform they publish on.
_Avoid_: creator, author, subject, user

**Source**:
One publishing channel belonging to a Person — their Substack, their YouTube channel, their blog, their
Bluesky account. A Person has many.
_Avoid_: feed, platform, account, channel

**Item**:
A single published thing from a Source: one post, one video, one blog article — or, where a Source publishes
in short bursts, **one closed day of them**. Identified by the identifier its platform already assigns it, or
by the day it closed. An Item is what braintrust reads once, so it is the unit that has to be worth a reading
and has to have stopped changing.
_Avoid_: post, video, document, entry, thought

**Form**:
Whether an Item is long enough to argue in. Not a platform and not a Source: a Corpus can span four orders of
magnitude — a thirty-word post and a forty-thousand-word lecture — and some measurements only mean anything
across comparable Items. Voice is measured over long-form alone and says so; everything else reads both,
because short-form tells you what someone thinks and long-form tells you how they argue.
_Avoid_: length, type, kind, size

**Corpus**:
Every Item braintrust holds for one Person.

**Chunk**:
A passage of an Item's text, sized for retrieval. For a transcript, a Chunk knows where in the recording
it came from. Its boundaries come from the platform — caption timings, paragraph breaks — never from a
model, because a Chunk is what a citation quotes and a quote must be what was said.
_Avoid_: passage, segment, fragment

**Note**:
What braintrust wrote down the one time it read an Item — the claims made, the argument, the assumptions.
Every Compile reads Notes rather than Items, because an Item never changes and re-reading it cannot
produce a different answer. **A Note is also what braintrust serves when asked what an Item was about**,
which is why the avoided words are avoided at the boundary too: a served Note is recalled, never composed,
and calling it a gist would invite the summary it is not.
_Avoid_: summary, extraction, digest, gist

**Backlog**:
Everything braintrust owes a Corpus but has not yet done — bodies to fetch, Notes to write, archives to
walk. Not a queue: it is a query over rows that already exist, which is why interrupting it costs only
time. A Compile waits for an empty Backlog.
_Avoid_: queue, job, pipeline, task list

**Plan**:
What braintrust proposes before it ingests anything — the Sources it resolved from the links you gave it,
the name it suggests for the Person, and what following them will cost. Every number in a Plan is labelled
Measured or Inferred, the same as a Persona's layers. A human confirms a Plan; nothing is ingested without one.
_Avoid_: preview, estimate, dry run

**Paused**:
A Person braintrust has stopped following. Their Persona stays answerable and stops moving; nothing is
deleted, so resuming costs nothing. Distinct from a Blocked Source — Paused is the user's choice.
_Avoid_: disabled, archived, deleted

**Blocked**:
A Source that has stopped serving braintrust. Established by counting consecutive failures, not by reading
one response. braintrust stops crawling it, keeps and reports everything it already has, and asks once a
day — the same request, unchanged. Never the user's choice, and never a reason to alter how braintrust asks.
_Avoid_: banned, rate-limited, failed, paused

**Skipped**:
An Item braintrust deliberately did not retrieve. The reasons are kept apart because they are different facts:
paywalled content, which braintrust never ingests; a Short, which braintrust's own settings exclude; an Item
older than the window braintrust was asked to read; and a URL in an archive that turned out not to be a post
at all. A Skipped Item is still recorded, so Coverage can name what was not read. **The line the word draws is
whose decision it was** — everything braintrust decided is Skipped, carrying what would have to change and
reopened when it changes. A failed fetch is retried up to a bounded number of attempts; a Source declining
or failing to answer at all is Blocked.
_Avoid_: excluded, filtered, ignored

**No Captions**:
A video whose player response arrived intact and carried no usable caption track. **A fact about the
response, never about the video** — the words may exist and braintrust may simply not have been given
them. Measured: videos recorded this way return full transcripts when the identical request goes out
from a domestic connection rather than from the datacenter the scheduled job runs in, so the absence is
a property of who asked. braintrust therefore says it ran into trouble getting the captions, and never
that a video has none. Distinct from Failed, which is about a moment and about the network.
_Avoid_: failed, unreadable, "has no captions" (a claim about somebody's published work that braintrust
cannot support)

### The persona

**Persona**:
The compiled model of a Person. Never the Person themselves — braintrust always discloses the difference.
_Avoid_: profile, agent, twin, model

**Compile**:
One complete rebuild of a Persona from the Corpus. A Persona has exactly one current Compile; rebuilding
replaces it whole rather than editing it.
_Avoid_: sync, refresh, update, run

**Core**:
The three layers of a Persona that stay roughly constant however large the Corpus grows — Voice, Reasoning,
Coverage. What a Script is rendered from. **Nothing in the Core states a conclusion**: what a Person holds is
retrieved, never carried.
_Avoid_: page, summary, profile

**Script**:
The spoken form of a Persona — one block of prose, ready to be spoken, carrying none of braintrust's own
bookkeeping. Rendered from the Core at serving time, never stored. What you load to sound like someone.
_Avoid_: prompt, template, persona text, system prompt

**Receipts**:
The few scalars that travel beside a Script: which layers were Measured, how much braintrust read, the Corpus
window, and what went unread. Deliberately never sentences, so they cannot be spoken by accident.
_Avoid_: provenance, metadata, stats

**Voice**:
How a Person sounds. Compiled in two forms held together: a *descriptive* account of measured habits, and a
*generative* instruction derived from it.
_Avoid_: style, tone

**Reasoning**:
How a Person gets to a conclusion, as distinct from what they conclude.
_Avoid_: method, approach

**Through-line**:
What a Person broadly holds, inferred across their work rather than quoted from any one piece of it. It has to
survive more than one separate reading of the Corpus to exist at all, and it is retrieved rather than carried:
it rides with an answer that already matched, and may never be the whole of one. Carries no date and nothing
to quote — the only date available would be a fact about braintrust's reading schedule, and an illustrative
quote is indistinguishable from a supporting one once printed.

**Replaces Beliefs**, which was a Core layer of durable commitments and shipped in every payload. That let a
model answer what somebody thinks without looking anything up, which is the thing braintrust exists not to do.
The word is retired: a conviction braintrust has not retrieved is not a thing a Persona has.
_Avoid_: belief, values, principles, worldview, conviction

**Coverage**:
What braintrust has and has not read of a Person's output, as measured counts including Skipped Items.
_Avoid_: completeness, progress

**Position**:
A claim a Person holds, dated and cited to the Items asserting it. Positions grow with the Corpus and are
retrieved on demand rather than held in the Core.
_Avoid_: claim, opinion, view, stance

**Held since**:
The date of the earliest Item asserting a Position. A property of the Corpus, not of braintrust — finding
older evidence moves it earlier.
_Avoid_: first seen, discovered, since

### Confidence and provenance

**Basis**:
Whether something was Measured or Inferred. Travels with the content all the way to the answer.
**The word is reserved for that one distinction.** Anything else that wants to say *how this value was
arrived at* — how a Compile's gate was settled, for instance — needs its own word, because a second meaning
would make the first unreadable at exactly the moment it matters.
_Avoid_: provenance, source type, confidence

**Measured**:
Arrived at by counting. Checkable against the Corpus.

**Inferred**:
Arrived at by synthesis across many Items. Cannot be checked the way a Measured claim can, and is always
labelled.

**Revised**:
A Position the Person has moved past, with the superseding Position evidenced and dated.
_Avoid_: changed, updated, contradicted

**Unsettled**:
Two Positions that do not obviously reconcile, where braintrust cannot tell which holds.
_Avoid_: contested, conflicting

**Drifting**:
Emphasis has moved between two Positions without either contradicting the other.
_Avoid_: trending, evolving

### braintrust checking itself

**Interrogation**:
braintrust asking a model holding a Persona — and nothing to look anything up with — whether the guarantees
braintrust makes about that Persona still hold. What a Persona **does**, as distinct from what a Compile
**is**, which is the publish gate's question. Never blocks anything: it is one live call to a synthesiser
that is not reproducible, so it is evidence rather than proof.
_Avoid_: eval, test, audit, health check

**Assertion**:
One thing an Interrogation asks. Four of them, three about the compiler and one about a Person. Distinct
from a **publication-blocking check**, which is structural, cheap, runs before anything serves, and needs no
audience at all.
_Avoid_: check, rule, assertion test

**Fault**:
A live failure braintrust has found in itself and **cannot repair** — one that only a code change clears.
That is what distinguishes it from staleness, which braintrust fixes by rebuilding and tells nobody about. A
Fault's audience is the maintainer, so it becomes one deduplicated issue on the repo.
_Avoid_: error, alert, incident, warning

**Silence**:
An Assertion that could not be **asked** — the third status beside passed and failed, and **never a
Persona's fault**. A judge that answers without a usable verdict is a Silence too: every way of not getting
an answer is one bucket. It concludes nothing, opens no Fault and withdraws nothing, but it is counted and
dated, because *never verified* is a thing somebody has to be told about and *0 failed* does not say it.
_Avoid_: skipped, errored, unknown, degraded

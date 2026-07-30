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
One publishing channel belonging to a Person — their Substack, their YouTube channel. A Person has many.
_Avoid_: feed, platform, account, channel

**Item**:
A single published thing from a Source: one post, one video. Identified by the identifier its platform
already assigns it.
_Avoid_: post, video, document, entry, thought

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
produce a different answer.
_Avoid_: summary, extraction, digest

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
An Item braintrust deliberately did not retrieve. Two reasons, kept apart because they are different
facts: paywalled content, which braintrust never ingests, and a Short, which braintrust's own settings
exclude. A Skipped Item is still recorded, so Coverage can name what was not read — and because the
second reason is braintrust's own, only that one can be undone by changing the setting.
_Avoid_: excluded, filtered, ignored

### The persona

**Persona**:
The compiled model of a Person. Never the Person themselves — braintrust always discloses the difference.
_Avoid_: profile, agent, twin, model

**Compile**:
One complete rebuild of a Persona from the Corpus. A Persona has exactly one current Compile; rebuilding
replaces it whole rather than editing it.
_Avoid_: sync, refresh, update, run

**Core**:
The four layers of a Persona that stay roughly constant however large the Corpus grows — Voice, Reasoning,
Beliefs, Coverage. What you load to sound like someone.
_Avoid_: page, summary, profile

**Voice**:
How a Person sounds. Compiled in two forms held together: a *descriptive* account of measured habits, and a
*generative* instruction derived from it.
_Avoid_: style, tone

**Reasoning**:
How a Person gets to a conclusion, as distinct from what they conclude.
_Avoid_: method, approach

**Beliefs**:
Durable commitments underneath the Positions. Always Inferred — no single Item asserts one.
_Avoid_: values, principles, worldview

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

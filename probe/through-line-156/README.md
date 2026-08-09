# Probe: does the paragraph honour what the payload was handed?

Evidence for [#156](https://github.com/cgbarlow/braintrust/issues/156). Two instruments, because
they see different things.

## Half one — the live fleet, 2026-08-09

Six answers off the deployed server via `braintrust_find_positions`, all five compiled personas.

| person | items in corpus | quoted claims | broad claims |
| --- | --- | --- | --- |
| chris-barlow | 5 | 2 | 0 |
| stuart-winter-tear | 24 | 9 | 0 |
| matt-pocock | 40 | 3 | 0 |
| nate-b-jones | 516 | 3 / 1 | 1 / 0 |
| ethan-mollick | 19 | 2 | 1 |

The broad claims never outnumbered the quoted ones, and four of six answers carried none at all.
The layer is starved for the reason [#157](https://github.com/cgbarlow/braintrust/issues/157)
already measured, and that ticket's replacement — four through-lines for everyone, ranked rather
than barred — is decided and not yet built. So the shape #156 fears cannot be sampled live today.

## Half two — the paragraph, simulated

`throughline.probe.mts`. Two payload arms put to `gpt-oss-20b` behind the same `speak` block the
live server serves for ethan-mollick, eight replies each, serialised (the endpoint 429s on
concurrent calls).

- **Arm A** — today's shape: two quoted Positions, one broad claim.
- **Arm B** — after #157 ships: one quoted Position, four broad claims.

Scored mechanically on whether the reply carries anything a listener could check: a verbatim
fragment of a cited quote, a source title, or a date from the payload.

| arm | replies with nothing checkable | median checkable references | broad claims spoken |
| --- | --- | --- | --- |
| A | 0 of 8 | 5 | 1.0 |
| B | **2 of 8** | 3 | 2.6 |

**Scoring caveat, disclosed because it changed the answer.** The first pass counted 1 of 8 for
Arm A. Replies render `GPT-5.5` with a non-breaking hyphen, so substring matching missed real
citations. Re-scored on normalised text with no new calls; Arm A is 0 of 8. Raw replies are in
`direct-replies.json` — the `checkable` field there is the *uncorrected* score.

The two Arm B failures do not merely bury the quote. They replace it with invented first-person
anecdote, e.g. *"In my own experiments, when I gave an AI agent a clear goal — say, drafting a
proposal or compiling data — within minutes it produced a deliverable that would normally take a
human several hours to finish."* Nothing in the payload says that. A broad claim with nothing to
quote leaves the model needing support, and it supplies its own.

## The other thing, found on the real client path

`hermes-replies.txt`. Four one-shot runs through the `bt-ethan-mollick` Hermes profile, same
question, `tool_search` off per [#141](https://github.com/cgbarlow/braintrust/issues/141).

- **Run 1** retrieved, then attributed badly: invented a source (*"Real AI Agents and Real
  Work"*, a 2026 note) with a quotation to match, and hung a real quote on the wrong post. Both
  checked against the live record; the item does not exist in that corpus.
- **Runs 2, 3, 4** did not look anything up at all — generic AI-consulting prose with nothing of
  the person in it. Run 2 recited the instruction line *"Say that line first, word for word"* as
  its opening words. Run 4 put the disclosure last.

**This is n=4 in Hermes' one-shot mode, which is not the configuration
[#146](https://github.com/cgbarlow/braintrust/issues/146) and
[#139](https://github.com/cgbarlow/braintrust/issues/139) measured in.** Telling a braintrust
fault from a harness one is the first job, not an afterthought — this map has already spent a
ticket learning that the founding observation was a client setting. Filed separately rather than
concluded here.

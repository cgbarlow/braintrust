# braintrust reads nothing from OB1's `thoughts` in v1

braintrust is an OB1 extension sharing OB1's database, so the obvious move is to let a persona draw on the
notes already captured there. We don't, in v1. A persona is built only from content braintrust fetched
itself from the person's own feeds. This is worth writing down precisely because a reader will assume the
opposite.

The decisive reason is dates. `thoughts.created_at` records when *you captured* a note, not when the person
*said* the thing — and everything else lives in an unstructured `metadata` blob with no documented key
contract. Positions built from captured notes could not carry an honest `held_since`, and `held_since` is
the feature the whole schema exists to support.

The second reason is voice. Your note *about* someone is not that person. Mixing the two risks a persona
quoting your own opinion back at you as theirs, which is the failure mode a provenance-first project can
least afford.

## Consequences

- braintrust ignores relevant material that may already be in the user's brain.
- The [wayfinder map](https://github.com/cgbarlow/braintrust/issues/4) previously described braintrust as
  *"reading `thoughts` across a bridge"*. The bridge remains architecturally available and carries nothing.
- Reversing this later is cheap — it adds a read path, not a migration — but it would first require solving
  the dating problem and a way to mark whose voice a claim came from.

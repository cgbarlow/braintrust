# The merge is handed wording, not evidence

A compile folds a large corpus into passes, and each layer's passes are then reconciled by a merge — one
model call over every pass's output. Passes are budgeted; the merge never was. Its input is a function of
corpus size, so it was the one step where a person who publishes more gets a worse persona and eventually
none, which is exactly what [#143](https://github.com/cgbarlow/braintrust/issues/143)'s resume cannot help
with: a single call that will not fit today will not fit tomorrow either.

The merge was doing two jobs in one call. Collecting the evidence behind entries that turn out to be the same
is arithmetic and has a right answer. Deciding that two differently-worded entries say the same thing is
judgement. **Only the judgement is given to a model.** The merge is handed one line per entry — an index, the
wording — and answers with groups of indices naming which member reads clearest. braintrust unions the claim
ids and item ids itself, and keeps the clearest member's text verbatim.

**The merge then takes the same character budget as the passes that feed it, and folds in rounds when it
overflows** — each round's survivors becoming the next round's input, unions accumulating outside the model.
A round that returns no fewer entries than it received ends the fold; whatever survives is published, with
the layer disclosing that duplicates may remain.

## Consequences

- **A merge cannot touch a citation.** It is not checked afterwards for invented refs — it never sees one.
  The pass-level attribution checks stay; the merge-level ones stop being reachable.
- **No step of a compile rewords a persona's own output.** The merge selects prose rather than composing it,
  so what a reader reads was always written by a pass that read the notes behind it. The cost is that two
  duplicates each saying half of something do not get combined into a better paragraph; the clearer half wins
  whole.
- **Cost grows in calls, never in the length of one call.** This restores the property
  [0001](./0001-the-compiled-persona-is-disposable.md) rests on — full regeneration stays cheap only while
  nothing in the compile scales with the corpus — for the last step that had lost it.
- **The answer-length cap #143 parked "with the fold" is not needed.** A grouping answer is bounded by the
  count of entries the merge was given.
- **A merge that cannot converge is a cosmetic fault, not a failed compile.** The persona publishes with some
  entries still duplicated and says so, rather than re-creating the all-or-nothing failure #143 removed.
- **Positions and the inferred layers stop being separate problems.** One mechanism serves entries that carry
  citations and entries that carry prose.

## Considered and rejected

**Merging without a model at all** — matching entries by their wording in code. Passes reword the same view
freely, so the arithmetic half is the half that can be mechanised; sameness cannot.

**Always folding pairwise or in rounds** — uniform whatever the size. Rejected because every person would pay
extra calls for a corpus that fits in one, and because a model rewords its own output in each round even when
there was nothing to fold.

**Leaving it a single call and relying on the answer-length cap** — which would have bought years. Rejected on
shape rather than durations: every merge observed completed, at 434s, 366s and 489s of a 900s ceiling, but
buying time does not change the fact that this input grows without bound while every other one does not.

**Trimming a non-converged layer to the best-supported entries** — shorter and cleaner, but it silently
removes views the person holds, which is the one thing citations exist to prevent.

**Refusing a layer whose fold did not converge** — strictest, and it would give the stuck-persona rule
something real to report. Rejected because it re-creates all-or-nothing over a fault a reader would only
describe as untidy.

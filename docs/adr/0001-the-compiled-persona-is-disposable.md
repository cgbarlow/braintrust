# The compiled persona is disposable

A persona could either be maintained incrementally — improved a little on each ingest, the way Karpathy's
LLM wiki does it — or thrown away and rebuilt from the corpus every time. We rebuild. Every compiled row is
owned by a compile, and a rebuild deletes the previous compile outright, so a persona has no existence
independent of the evidence behind it and therefore cannot drift from it.

## Consequences

- **There is no persona history**, and no `first_seen` date. braintrust can say what a person's content
  says; it cannot say what braintrust used to think.
- **A hand-correction to a persona will not survive the next rebuild.** Corrections have to go into the
  compiler. There is deliberately nowhere to write one.
- **`held_since` is recomputed every time**, which is the point — a backfill that finds older evidence moves
  it earlier rather than leaving a stale value behind.
- **This only stays affordable while the compiled core stays bounded.** Voice, reasoning, beliefs and
  coverage converge as the corpus grows; positions grow and are retrieved rather than compiled. If the core
  ever starts growing with the corpus, full regeneration stops being cheap and this decision has to be
  revisited rather than quietly strained.
- **`lint` is kept, but its job changes.** In the wiki pattern lint catches drift. Here there is no drift to
  catch, so lint is a quality gate on compiler output instead.

## Considered and rejected

**Incremental maintenance** — the wiki pattern's own model. Rejected because it makes drift possible by
construction and needs a compensating sweep to catch it, and because errors compound: a wrong page becomes
the input to the next ingest.

**Rebuild, but remember what was seen before** — disposable rows joined to a durable identity table. This
looks like both properties at once, but rebuilt conclusions come back re-worded, so matching them to
remembered ones is guesswork that would sometimes drop a human correction without saying so.

# Ingested text is kept permanently

braintrust stores the full text of everything it retrieves — roughly 1.2M words of transcripts for a single
prolific person — and never expires it. The intuitive alternative is to keep only short quotes and
timestamps and re-fetch when needed, which would leave a much smaller copy of someone else's work on disk.
We rejected it, and the reasoning inverts the intuition.

The [terms posture](https://github.com/cgbarlow/braintrust/issues/9) commits braintrust to rate-limited
access at roughly four seconds between fetches. Re-fetching on each rebuild means about half an hour of
continuous requests against the source, repeated forever. **Keeping the copy means braintrust touches the
source once per item, ever** — so retention is the option that treats the source better, not worse. It also
means a rebuild still works when a video is taken down.

## Consequences

- braintrust holds a complete local copy of a person's published output. This is the aspect of the project
  that would look worst if it ever left personal, single-user use — and it is one more thing that would
  have to be reopened rather than inherited if it did.
- Because retrieval never repeats, `braintrust_items` is the only place some content still exists. It sits
  in the durable tier and is never regenerated.
- This says nothing about *re-serving* the text. A verbatim-reproduction cap was declined for v1 and belongs
  at the MCP tool boundary, which is a separate decision from storage.

# OB1's hybrid graph plugin — write-time vs query-time synthesis

**Status:** findings, not a decision. Feeds [Shape a persona](https://github.com/cgbarlow/braintrust/issues/7),
[Decide what drives ingestion and re-distillation](https://github.com/cgbarlow/braintrust/issues/12), and
[Design braintrust's tables alongside OB1's `thoughts`](https://github.com/cgbarlow/braintrust/issues/10).

## Source

Nate B. Jones, *"Karpathy's Wiki vs. Open Brain. One Fails When You Need It Most."* — YouTube, ~41 min,
<https://youtu.be/dxq7WtWxi44>. Captured via auto-caption track (`yt-dlp --write-auto-subs --sub-langs en-orig`)
and read in full on 2026-07-28. Companion post (partly paywalled):
[Karpathy's Memory System: The Flaw in His Viral LLM Wiki](https://natesnewsletter.substack.com/p/your-ai-re-derives-everything-it).
Third-party structural comparison: [Daniel John Morris](https://danieljohnmorris.com/writing/karpathy-wiki-openbrain-context-layer/).

Everything below is a summary of that talk. Where a phrase is his, it is quoted.

---

## 1. The fork: when does the AI do the hard thinking?

His framing: *"Every knowledge system with an AI at its core has to answer one question. When does the AI do the
hard thinking? Is it when information comes in or is it when you ask about that information? You got to pick.
That's the fork. Everything else follows from that."*

| | Karpathy's LLM wiki | OB1 today |
|---|---|---|
| Synthesis happens | at **write** time | at **query** time |
| AI's job | **writer** — maintains pages | **reader** — answers from rows |
| Ingest cost | heavy | cheap (tag a row, done) |
| Query cost | cheap (pre-built) | heavy (re-derives each time) |
| Storage | markdown folders (`raw/`, `wiki/`, schema file) | tagged SQL rows |
| Scale ceiling | ~100–10,000 high-signal docs, per Karpathy | thousands+, no file-count ceiling |
| Concurrency | breaks — parallel agents editing one page is a merge conflict | normal database behaviour |
| Staleness looks like | **active misinformation** — stale synthesis still reads as confident prose | ignorance — a gap, but old facts stay true |
| Provenance | AI's editorial choices, hard to audit | source + timestamp per row, traceable |

Two failure modes he names explicitly:

- **Editorial drift.** Turning a raw source into a wiki page is an editorial act; nuance gets dropped and
  *"you would literally never know. You wouldn't know what's missing because the wiki reads so cleanly."*
  He compares it to a dashboard hiding the thing you needed from the spreadsheet.
- **Error compounding.** If the AI writes something slightly wrong into the wiki, the next pass builds on the
  wrong thing.

## 2. The hybrid he is shipping

Announced in the talk as *"the next major OpenBrain extension"* — a **graph plugin**, implemented as an OB1
**recipe** (their term for a composable workflow).

Architecture, as stated:

1. **OB1's SQL database stays the single source of truth.** All new information goes into core OB1 first —
   tagged, searchable, queryable. This is the durable memory layer.
2. **A compilation agent runs on a schedule** — daily, weekly, or on demand.
3. It **reads OB1's structured data, builds a graph** across entries, synthesises, and **emits wiki pages and
   topic summaries** into a wiki directory — browsable in Obsidian or any note app.
4. **The wiki is never edited directly.** If a page is wrong, you fix the source row and regenerate.
   *"The wiki never drifts from reality because it's always rebuilt from ground reality in the SQL database."*
5. The recipe queries relevant tables → synthesises pages via AI → builds a relationship network → writes to a
   wiki directory. Runs on an automated schedule and compounds as the underlying data grows.

**Why compiling from structured data beats compiling from raw files:** the compiler can filter entries by date
or category *before* synthesising, weight by confidence, and exclude outdated items. Karpathy's raw-file ingest
cannot do any of that.

Net: *"OpenBrain for structured storage and agent access, and a Karpathy-style wiki over the top for compiled
understanding and human browsability. The database ends up feeding the wiki, and the wiki never contradicts
the database."*

## 3. The constraint that matters most to braintrust

His sharpest warning about write-time synthesis is that **it smooths contradictions away**. His example:
engineering thinks the build is 12 weeks, sales promised the client 8, and a well-meaning wiki resolves that
into a confident "10 weeks" — destroying the misalignment that leadership actually needed to see. A database
that stores both views without resolving them preserves the tension.

**For braintrust this inverts from a caveat into a core requirement.** A creator changing their mind is not
noise to be reconciled — it is the product. A naive persona compiler that renders "he argued X in March,
Y in July" as a single confident current position deletes precisely the signal braintrust exists to capture.

Consequence: whatever a compiled persona page is, it must be able to represent a **held-then-revised** position,
not just a current one. This also makes the map's out-of-scope ruling on drift tracking worth re-examining —
the compiler either leaves room for it or forecloses it.

## 4. Things both systems agree on

Worth recording because they constrain braintrust regardless of which way the compiler question lands:

- **You own the artifact, not the tool.** Karpathy's "file over app"; Nate's "no SaaS middlemen".
- **The human's job is curation and questioning** — choosing sources, asking the right questions.
- **The primary consumer is an agent, not a human reader.** *"Human readability is a bonus. Agent accessibility
  is actually the requirement."*
- Memory compounds through **intentional structure**, not accumulation.

## 5. Open questions this raises for braintrust

1. **Has the graph plugin actually shipped, and can a third-party extension build on it?** The talk describes it
   as launching. If braintrust can supply creator-shaped recipes on top of it, most of the compiler build
   disappears. If not, braintrust writes its own. Unresolved — needs checking against the OB1 tree.
2. **Does a followed creator's content land in `thoughts`, or in braintrust's own tables?** The hybrid assumes
   the compiler reads OB1's structured store. The [seams research](./ob1-seams.md) established braintrust owns
   `braintrust_`-prefixed tables in `public` and treats `thoughts` as read-only, so a braintrust compiler would
   read braintrust's tables — but then it is not literally the OB1 graph plugin.
3. **Where do compiled pages live?** He writes them to a wiki *directory*. braintrust's MCP server must be
   remote HTTP (per the seams research), so a local directory is not reachable the same way. Compiled pages may
   need to be rows, not files.
4. **What is the recompile trigger for a creator?** Schedule, new-item threshold, or on demand — and this is
   also what governs how honestly braintrust can claim a persona reflects what someone thinks *now*.

## 6. Consent note

At the end of the talk he explicitly invites viewers to take the transcript of the video and feed it to their
agent to start their own memory project, framing "the idea file as a publishing format" as the thing worth
copying from Karpathy. That is an unusually clear grant for this specific source, and a useful data point for
[Set the consent, source-ToS, and licensing posture](https://github.com/cgbarlow/braintrust/issues/9) — though
it is one creator's invitation, not a general licence covering everyone braintrust might follow.

# Karpathy's LLM wiki — primary source, and what depending on it means

**Status:** findings, not a decision. Feeds [Shape a persona](https://github.com/cgbarlow/braintrust/issues/7),
[Build braintrust's own persona compiler](https://github.com/cgbarlow/braintrust/issues/16), and
[Design braintrust's tables](https://github.com/cgbarlow/braintrust/issues/10).

**Corrects** [`ob1-hybrid-graph-plugin.md`](./ob1-hybrid-graph-plugin.md), which characterised this system
entirely secondhand — from a talk that is a *critique* of it. That was a methodological error: braintrust's
architecture had been shaped against a system known only through its critic.

## Source

Karpathy's own gist, [`llm-wiki.md`](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f),
read 2026-07-28. Plus two MIT implementations, examined for whether they are dependable:
[Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) and
[tonbistudio/llm-wiki](https://github.com/tonbistudio/llm-wiki).

---

## 1. It is a pattern, not a package

The gist is **"intentionally abstract"** and explicitly **"not a specific implementation."** There is nothing
to install from Karpathy. Depending on "the wiki method" therefore means one of two different things —
adopting the *pattern as specification*, or depending on somebody's *implementation of it*. Those have very
different consequences and the choice is real.

**Three layers:** immutable raw sources the LLM reads but never modifies; an LLM-owned wiki of generated
markdown; and a schema file (`CLAUDE.md`-style) that humans and the LLM co-evolve.

**Three operations:** **ingest** (read a source, write summaries, update the index, revise affected pages,
append to a log), **query** (search the wiki, answer with citations, optionally file the answer back as a new
page), and **lint** (periodic health check).

## 2. The contradiction critique was unfair to the pattern

This is the correction that matters most, because it undercuts a claim currently standing in the map's Notes.

The pattern **explicitly handles contradiction.** Ingest is specified to note *"where new data contradicts old
claims, strengthening or challenging the evolving synthesis."* Lint is specified to look for *"contradictions
between pages, stale claims that newer sources have superseded."*

So *"write-time synthesis smooths contradictions into one confident narrative"* is **not a property of the
pattern.** It is a property of naive implementations of it. The map states this as though it were inherent;
it is not, and braintrust should stop claiming it is.

What is fairly said instead:

- **Karpathy specifies contradiction-noting but gives no mechanism.** No vocabulary, no data structure, no
  rule for what a page does with two conflicting claims. "Note it" is a instruction to an LLM, not a design.
- **OB1 does the opposite** — it *builds* the mechanism (`contradicts`/`supersedes` edges with validity
  intervals) and then never reads it when generating pages
  ([verified](./ob1-graph-plugin.md)). Signal computed, then discarded.
- **Neither dates claims.** Karpathy's `log.md` is an append-only record of *operations* — ingests, queries,
  lint passes — not of when a claim was made. There is no claim-level provenance in the pattern.

**braintrust's differentiator survives, but it is narrower and more precise than the map says.** It is not
"we preserve contradictions and write-time systems don't." It is: *the pattern asks for contradictions to be
noted but supplies no structure; braintrust supplies the structure, and dates the claims so a revision can be
told from a disagreement.*

## 3. The scale ceiling is a direct problem

Karpathy states the index approach works **"at moderate scale (~100 sources, ~hundreds of pages)"** and
**"stops working somewhere in the low thousands of pages."**

Set that against braintrust's actual numbers. Ingest is specified as one source touching **10–15 wiki pages**.
braintrust's 12-month window is ~395 videos plus 15 posts. Even at the low end that is **~4,000 pages from one
creator** — an order of magnitude past the stated ceiling, before a second creator exists.

**This is a hard conflict with the requirement that the format scale to hundreds or thousands of items**, and
it is Karpathy's own stated limit rather than an outside criticism. It also independently supports the
bounded-core / indexed-growth split proposed in
[`PROTOTYPE-compiled-persona-page-v2.md`](../prototypes/PROTOTYPE-compiled-persona-page-v2.md): a flat wiki of
pages demonstrably does not scale to this corpus, and the pattern's author says so.

## 4. Incremental maintenance versus regeneration — the deepest tension

The map currently commits to compiled pages being **"regenerated, never edited, so they cannot drift from the
data."** That is OB1's hybrid model, and it is **not Karpathy's model.**

| | Karpathy's wiki | OB1's hybrid | braintrust's map today |
|---|---|---|---|
| How pages change | **incrementally edited** on each ingest | **rebuilt from scratch** on a schedule | rebuilt from scratch |
| Source of truth | `raw/` — but the wiki accumulates state not in it | the SQL rows | the SQL rows |
| Drift possible? | **yes** — hence `lint` exists to catch it | no, by construction | no, by construction |
| Error compounding | possible; a wrong page is built upon | not possible | not possible |

**`lint` exists precisely because the wiki can drift.** A system that regenerates from source has no use for a
contradiction-and-staleness sweep — the rebuild is the sweep.

So "use the wiki method as a dependency" and "pages are regenerated, never edited" are **not simultaneously
satisfiable in full.** Adopting the pattern means accepting incremental maintenance and its drift, and gaining
`lint` as the compensating control. Keeping regeneration means adopting the wiki's *shape* — layers,
page types, schema file, citation discipline — while declining its *update model*.

This is a genuine architectural fork and it belongs to
[Build braintrust's own persona compiler](https://github.com/cgbarlow/braintrust/issues/16).

## 5. What is actually dependable

| | [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) | [tonbistudio/llm-wiki](https://github.com/tonbistudio/llm-wiki) |
|---|---|---|
| Form | Agent Skill, `npx add-skill` | clone-and-customise template |
| Licence | MIT | MIT |
| Operations | ingest / query / lint | ingest / query / lint |
| Storage | markdown files | markdown files, Obsidian-oriented |
| Contradictions | can record them; **deliberately no automated retraction** | lint audits for them |
| Track record | ~94 articles / 99 sources since 2026-04 | template |

**Both are MIT**, so neither creates the licensing problem OB1's FSL does.

**Both are file-based**, which collides with two settled constraints: braintrust's MCP server must be **remote
HTTP** (OB1 bans stdio), so local markdown directories are not reachable the same way; and the schema ticket
already leans toward compiled pages as rows. Note the OB1 research partially dissolves this — OB1's own
compiler supports a row sink — but a wiki-pattern dependency reintroduces it.

**Neither is a library braintrust would call.** Astro-Han's is a *skill* — instructions an agent follows.
tonbistudio's is a *scaffold* to copy. So "dependency" here means adopting a convention and a prompt discipline,
not linking code. That is a weaker form of dependency than the word usually implies, and it should be named
plainly rather than assumed.

## 6. Relevance to braintrust — the honest summary

**Compatible, not superseded.** Karpathy's pattern is for one person compiling *their own* chosen sources.
braintrust models *other people* from their published output. Same machinery, different subject — and the
difference is exactly why braintrust needs claim-level dating that the pattern does not specify.

**What braintrust gains by depending on it:** a proven three-layer separation; page types and cross-linking
conventions; the schema file as the place conventions live; citation discipline; and **`lint` as a named
operation braintrust currently lacks entirely.**

**What braintrust must add:** claim-level dates and provenance; a real structure for held-then-revised
positions; and an answer to the scale ceiling the pattern's author states himself.

# OB1's graph / wiki-compiler plugin — what it actually exposes

**Status:** findings, not a decision. Resolves
[Establish what OB1's graph/wiki-compiler plugin actually exposes](https://github.com/cgbarlow/braintrust/issues/15).
Feeds [Design braintrust's tables alongside OB1's `thoughts`](https://github.com/cgbarlow/braintrust/issues/10) and
[Decide what drives ingestion and re-distillation](https://github.com/cgbarlow/braintrust/issues/12).
Supersedes open question 1 in [ob1-hybrid-graph-plugin.md](./ob1-hybrid-graph-plugin.md) ("Has the graph plugin
actually shipped?").

## Source

The OB1 repository itself, `NateBJones-Projects/OB1`, read on **2026-07-28** at HEAD commit
**`6779106`** (`Merge pull request #351 …`, 2026-07-03) — the same commit the
[seams research](./ob1-seams.md) read against. Files were fetched from
`raw.githubusercontent.com/NateBJones-Projects/OB1/6779106/…` and directory listings from the
GitHub web UI. No third-party summaries; the talk
([youtu.be/dxq7WtWxi44](https://youtu.be/dxq7WtWxi44)) is referenced only where the code cites it.

Nothing below reproduces OB1 source. Short DDL fragments are quoted where the exact constraint is the
finding. OB1 is FSL-1.1-MIT; braintrust ships MIT; no OB1 code lands here.

Files read in full or in substantial part:

| Path | What it is |
| --- | --- |
| `recipes/wiki-compiler/{README.md,metadata.json,compile-wiki.mjs}` | the orchestrator |
| `recipes/wiki-synthesis/{README.md,metadata.json,scripts/synthesize-wiki.mjs,scripts/backfill-gmail-wikis.mjs}` | topic-page synthesiser |
| `recipes/entity-wiki/{README.md,metadata.json,generate-wiki.mjs}` | per-entity page synthesiser |
| `recipes/typed-edge-classifier/{README.md,metadata.json,classify-edges.mjs}` | reasoning-edge classifier |
| `recipes/ob-graph/{README.md,metadata.json,schema.sql,index.ts,.env.example}` | standalone graph layer + MCP server |
| `recipes/_template/{README.md,metadata.json}` | the recipe contract |
| `recipes/email-history-import/` (listing) | the known example |
| `schemas/entity-extraction/{schema.sql,README.md}` | `entities` / `edges` / `thought_entities` / queue |
| `schemas/typed-reasoning-edges/{schema.sql,README.md}` | `thought_edges` |
| `schemas/enhanced-thoughts/schema.sql`, `schemas/provenance-chains/schema.sql` | optional `thoughts` column adds |
| `.github/workflows/ob1-gate-v2.yml`, `.github/metadata.schema.json` | what CI actually enforces |

---

## Bottom line

**The plugin exists and has shipped.** The talk was not ahead of the code. There are four merged recipes —
`wiki-compiler`, `wiki-synthesis`, `entity-wiki`, `typed-edge-classifier` — plus two supporting schemas, and
they compose into exactly the architecture Nate described: SQL as source of truth, a scheduled compilation
pass, a regenerable wiki directory. The previous research pass simply did not enumerate `recipes/` fully.

**But it is not table-agnostic, and not by a margin that a config flag could close.** The binding to
`public.thoughts` is enforced by *database foreign keys and a table trigger*, not by hardcoded strings in a
script. A `braintrust_*` row physically cannot be referenced by `thought_entities` or `thought_edges`, and
cannot enter the extraction queue at all. braintrust cannot point this compiler at its own tables.

Three consequential secondary findings:

1. **`recipes/ob-graph/` is a different thing from what `wiki-compiler` orchestrates**, and it *is*
   table-agnostic — its `thought_id` column carries no foreign key. It is the only reusable piece.
2. **The compiled wiki does not render contradictions**, even though the pipeline computes and stores them.
   `contradicts` lands in `thought_edges`; neither wiki generator reads `thought_edges`. The signal is
   preserved in the database and dropped on the way to the page.
3. **Pages can already go to rows, not just files** — `entity-wiki` has three output sinks. That removes the
   "compiled pages must be files" concern raised in the hybrid research.

---

## 1. Does it exist? Yes — four recipes and two schemas

At `6779106`, `recipes/` contains **51 directories**. Relevant ones:

| Recipe | Author (per `metadata.json`) | Created | Role |
| --- | --- | --- | --- |
| `wiki-compiler` | Jonathan Edwards | 2026-04-21 | wrapper that runs the other three in order |
| `wiki-synthesis` | — | — | one page per *topic / corpus slice* |
| `entity-wiki` | — | — | one page per *entity* |
| `typed-edge-classifier` | — | — | writes `supports` / `contradicts` / `supersedes` edges |
| `ob-graph` | Nate Jones (code by @alanshurafa) | 2026-04-05 | standalone nodes+edges graph + MCP server |

Supporting schemas: `schemas/entity-extraction/` (`entities`, `edges`, `thought_entities`,
`entity_extraction_queue`, `consolidation_log`) and `schemas/typed-reasoning-edges/` (`thought_edges`).
The worker that drains the queue is `integrations/entity-extraction-worker/`.

`recipes/wiki-compiler/README.md` names the talk directly — "This recipe is the composition layer Nate
described in the video" — and states the invariant verbatim: the SQL database stays the source of truth,
the wiki is a generated artifact, "if a wiki page is wrong, you fix the underlying data and regenerate."
It credits the underlying components to merged PRs #197, #199, #208, #213, #222.

The pipeline, per that README's own diagram: `thoughts` → entity-extraction trigger + worker →
`entities` / `thought_entities` / `edges` → typed-edge-classifier → `thought_edges`, and in parallel
entity-wiki → per-entity pages; then wiki-synthesis → topic pages; output to
`compiled-wiki/` plus `compile-manifest.json`.

**Verified.** All five recipe directories, both schema files, and the worker integration directory were
listed and their contents read.

## 2. What a "recipe" is, mechanically

**A recipe is a directory under `recipes/` containing `README.md` and `metadata.json`.** That is the whole
contract. There is no runtime registry, no loader, no plugin API, no manifest of entry points.

`recipes/_template/` contains exactly those two files and nothing else.

### What `metadata.json` holds

Per `.github/metadata.schema.json`, required keys are `name`, `description`, `category`, `author`,
`version`, `requires`, `tags`, `difficulty`, `estimated_time`. Optional: `requires_primitives`,
`requires_skills`, `learning_order`, `created`, `updated`. `additionalProperties` is `false`.

`requires` is a declaration of *human* prerequisites — `{"open_brain": true, "services": [...],
"tools": [...]}`. `wiki-compiler`'s reads `"tools": ["Node.js 18+", "cron or any scheduled task runner"]`.
Nothing in `metadata.json` names an entry point, a command, or a table. It is discovery metadata for
humans browsing the catalogue, not machine-readable wiring.

### How a recipe is invoked

By running its script by hand. `wiki-compiler` is a Node CLI:
`node recipes/wiki-compiler/compile-wiki.mjs [flags]`. Configuration comes from flags plus environment,
loaded by the script itself from `.env` then `.env.local` at repo root then `process.env`.

Composition is **hardcoded file paths**. `compile-wiki.mjs` holds a literal `SCRIPT_PATHS` map pointing at
`recipes/typed-edge-classifier/classify-edges.mjs`, `recipes/entity-wiki/generate-wiki.mjs`, and two scripts
under `recipes/wiki-synthesis/scripts/`, then `spawn`s each as a child Node process with `stdio: "inherit"`.
It checks those paths exist at startup and throws if not. There is no resolution by name, no version
negotiation, no interface — the wrapper knows its dependencies' file paths and CLI flags by construction.

### Enforced by code vs. convention

**Enforced** (CI, `.github/workflows/ob1-gate-v2.yml`, 13 active rules):

- Rule 1 — contribution folders must sit under one of `recipes|schemas|dashboards|integrations|skills|primitives|extensions`.
- Rule 2 — `README.md` and `metadata.json` must both exist in the folder.
- Rule 3 — `metadata.json` must be valid JSON *and* pass the JSON Schema (`check-jsonschema`).
- Rule 6 — a `recipes/` folder must contain a code file (`.sql`/`.ts`/`.js`/`.py`) **or** a README with 3+ numbered steps.
- Rule 9 — README must mention a prerequisite, contain numbered steps, and contain one of "expected"/"outcome"/"result".
- Rule 7 — PR title must be prefixed `[recipes] `, `[schemas] `, etc.
- Rules 4, 5, 8, 10, 11, 14, 15 — no credentials, SQL safety, no binary blobs, dependency validation, an LLM
  clarity review, **no local MCP pattern**, and a tool-audit link.

**Convention only:** script naming, flag naming, `.env.local` loading, output directory layout, the
`recipes/README.md` catalogue (hand-maintained prose — `wiki-compiler` appears in it as a bullet), and every
aspect of how one recipe calls another.

So: the *packaging* is enforced; the *mechanism* is entirely convention. There is nothing to implement
against. A "recipe" is a documented script, and the compiler is a shell script's worth of orchestration
over four sibling scripts.

`recipes/email-history-import/` fits this exactly: `.env.example`, `README.md`, `metadata.json`,
`pull-gmail.ts`, `rollback-chunking-columns.sql`. Two required files plus whatever the author wrote.

## 3. What schedules a recipe

**Nothing in-repo. There is no scheduler.** Two distinct mechanisms exist, and neither is a cron:

**(a) A database trigger, for enqueueing only.** `schemas/entity-extraction/schema.sql` attaches
`trg_queue_entity_extraction` — `AFTER INSERT OR UPDATE OF content, metadata ON public.thoughts`,
`FOR EACH ROW`. It inserts into `entity_extraction_queue`. This is event-driven, not scheduled, and it only
fills a queue; it does not process anything. It skips rows whose `metadata->>'generated_by'` is set, which
is how generated artifacts avoid re-entering the pipeline.

**(b) An external caller, for everything else.** The queue is drained by
`integrations/entity-extraction-worker/`, a Supabase Edge Function, which `compile-wiki.mjs` triggers by
`POST`ing to `${OPEN_BRAIN_URL}/functions/v1/entity-extraction-worker?limit=N` with an `x-brain-key` header.
Something outside the database has to make that call.

**No `pg_cron`** appears in any file read. The `.github/workflows/` directory has ten workflows
(auto-label, claude-issue-triage, claude-review, discord-announce, markdown-lint, ob1-gate-v2,
ob1-pr-followups, release-drafter, update-readme-contributions, welcome-new-contributors) — all
contribution tooling, none scheduled, none running a recipe.

What `wiki-compiler/README.md` actually offers under "Scheduling" is: a `crontab` line
(`0 6 * * * cd /path/to/OB1 && … node recipes/wiki-compiler/compile-wiki.mjs …`), "Claude Code / Codex style
scheduled runs" pointed at the same command, and on-demand invocation. It presents a daily "light compile"
and a weekly "deep compile" as differing only in `--edge-limit` / `--entity-batch-limit` values.

The README states the contract as scheduler-independent: write to SQL first, regenerate from source tables,
never hand-edit generated pages.

**Verified.** **Inferred:** that no `pg_cron` exists anywhere in the tree — GitHub code search requires
auth, so this rests on the files read rather than an exhaustive scan. Confidence is high (the two schema
READMEs and the compiler README all describe external invocation) but it is not exhaustive.

## 4. Is it table-agnostic? No — the binding is referential integrity

**This is the load-bearing answer: the wiki-compiler pipeline cannot be pointed at `braintrust_*` tables.**

Not because of hardcoded strings — because of foreign keys.

### The hard constraints

From `schemas/entity-extraction/schema.sql`:

```sql
thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE   -- thought_entities
thought_id UUID PRIMARY KEY REFERENCES public.thoughts(id) ON DELETE CASCADE -- entity_extraction_queue
```

From `schemas/typed-reasoning-edges/schema.sql`:

```sql
from_thought_id UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE
to_thought_id   UUID NOT NULL REFERENCES public.thoughts(id) ON DELETE CASCADE
```

A row in `braintrust_posts` cannot be referenced by any of these. There is no configuration that changes
this; changing it means altering someone else's schema.

Both schemas also hard-guard on `thoughts` at install time — `entity-extraction/schema.sql` raises
`'entity-extraction requires the content_fingerprint column on public.thoughts. Run docs/01-getting-started.md
Step 2.6 first…'` and refuses to apply otherwise.

And the ingestion door is a trigger *on `thoughts`*: `AFTER INSERT OR UPDATE … ON public.thoughts`. Rows
written anywhere else never enter the queue, so entities are never extracted from them, so no wiki page is
ever generated for them.

### The hardcoded strings, on top of that

- `wiki-synthesis/scripts/synthesize-wiki.mjs` builds its PostgREST path as a literal:
  `` `thoughts?select=id,content,created_at,metadata,source_type` ``. Its header comment states the
  assumption plainly — "only requires the core `thoughts` table". There is **no** env var or flag for the
  source table. `SOURCE_TYPE_FILTER` and `--scope key=value` parameterise *which rows*, never *which table*.
- `entity-wiki/generate-wiki.mjs` issues PostgREST calls against literal `entities`, `thought_entities`,
  `edges`, and `thoughts`, and calls the `match_thoughts` and `upsert_thought` RPCs by name.
- `entity-wiki` additionally depends on PostgREST **embedded resources** —
  `select=…,thoughts(id,content,metadata,created_at)` on `thought_entities`. That syntax only resolves over a
  declared foreign key, so even the query layer requires the FK to exist.

### What *is* parameterised

`wiki-compiler` exposes ~20 flags: `--topic`, `--scope key=value`, `--out-dir`, `--edge-limit`,
`--entity-batch-limit`, `--entity-output-mode`, `--dry-run`, `--best-effort`, five `--skip-*` phase
toggles, and cost caps. Every one of these tunes *volume, cost, scope-within-`thoughts`, or destination*.
None names a source table.

Topic synthesisers are registered by editing a JS object literal (`const SYNTHESIZERS = {}`) in
`synthesize-wiki.mjs`. The file invites this — "Add your own by extending the SYNTHESIZERS catalogue below."
Exactly one ships: `autobiography`. A custom synthesiser receives `{ args, api, env }` and could in principle
issue its own `fetch` against a different table, since `env` carries `OPEN_BRAIN_URL` and
`OPEN_BRAIN_SERVICE_KEY`. But that means editing OB1's file — a fork, not a configuration, and it buys
nothing above the entity/edge layer, which remains FK-bound.

### The one exception: `ob-graph`

`recipes/ob-graph/` is a **different, parallel graph implementation** from the one `wiki-compiler`
orchestrates. Its `schema.sql` creates `graph_nodes` and `graph_edges`, and its `thought_id` column is
declared as a bare `UUID` with an inline comment describing it as an "Optional FK to thoughts table for
linking" — but **no `REFERENCES` clause is present**. Its header says it "Integrates with the core thoughts
table without modifying it."

Its Edge Function (`index.ts`) touches only `graph_nodes` and `graph_edges` — ten call sites, zero
references to `thoughts`. So `ob-graph` is genuinely table-agnostic: a node's `thought_id` could hold a
`braintrust_*` row's UUID and nothing would object. It ships graph traversal in Postgres
(`traverse_graph` via recursive CTE, `find_shortest_path` via iterative BFS) plus a remote MCP server —
which also satisfies the remote-HTTP constraint from the seams research.

It is, however, a *manual* graph layer. Its own schema README frames the split: `ob-graph` is the
"manual graph layer", `entity-extraction` is "the extraction side". `ob-graph` gives you storage and
traversal; nothing populates it for you, and it has no wiki compiler attached.

## 5. Where compiled pages go

**Three sinks, selectable — and only one of them is the filesystem.**

`entity-wiki`'s `--output-mode` flag (surfaced through `wiki-compiler` as `--entity-output-mode`):

| Mode | Destination | Note (from the recipe's own trade-offs table) |
| --- | --- | --- |
| `file` (default) | `./wikis/<slug>.md` | git-versionable, Obsidian-compatible, zero DB writes; "not queryable from SQL or MCP tools; lives outside the brain" |
| `entity-metadata` | `entities.metadata.wiki_page` | "no filesystem, queryable via SQL" |
| `thought` | a row in `thoughts` | stored as a dossier; **requires `EMBEDDING_API_KEY`** — without an embedding "the row is unreachable", so the CLI refuses to run |

`wiki-synthesis` writes files only, to `WIKI_OUTPUT_DIR` (default `./output/wiki`), and regenerates an index
after each run.

`wiki-compiler` defaults to a repo-root `compiled-wiki/` directory containing `entities/`, `topics/`, and
`compile-manifest.json` — a JSON record of which phases ran, with per-step `ok`/`failed` status and
timestamps. `--out-dir` relocates it.

**No storage bucket anywhere.** The talk's "wiki directory" is literally a local directory, but the
row-based modes already exist and are first-class.

Side note relevant to recursion: `entity-wiki`'s `thought` mode writes back into `thoughts`, which would
re-fire the extraction trigger — except the trigger skips rows carrying `metadata->>'generated_by'`. That
guard is the only thing preventing generated pages from being re-extracted as source material.

## 6. Contradictions: preserved in the database, dropped at the page

**Preserved in storage — genuinely, and better than expected.**

`schemas/typed-reasoning-edges/schema.sql` defines `thought_edges` with a closed vocabulary:

```sql
relation TEXT NOT NULL CHECK (
  relation IN ('supports', 'contradicts', 'evolved_into', 'supersedes', 'depends_on', 'related_to')
)
```

plus `confidence`, `decay_weight`, `support_count`, and **temporal validity columns** whose comments read:
`valid_from` — "When the relation became true (NULL = unknown/always)"; `valid_until` — "When the relation
stopped being true (NULL = still current)". Uniqueness is `(from_thought_id, to_thought_id, relation)`, so
*multiple relation types between the same pair coexist as separate rows*. Re-classification goes through a
`thought_edges_upsert` RPC that bumps `support_count`, takes max confidence, and widens temporal bounds
(`GREATEST` for `valid_until`, `LEAST` for `valid_from`) — it never overwrites or deletes.

`typed-edge-classifier` is a two-stage Haiku-filter → Opus-classify pipeline whose prompt asks for exactly
one relation from that vocabulary plus a direction (`A_to_B` / `B_to_A` / `symmetric`), with instructions to
capture temporality when a relation has a clear start or end. Nothing is deleted when a contradiction is
found — a row is added.

Superseding is likewise non-destructive and **off by default**: `--mirror-supersedes` optionally writes
`thoughts.supersedes` (a column added by `schemas/provenance-chains/`, itself a nullable
`REFERENCES public.thoughts(id) ON DELETE SET NULL`). The classifier README calls the overlap between
`thought_edges.supersedes` and the `provenance-chains` column "Tension 2" under a section literally headed
**"Design Tensions (unresolved)"**. The superseded thought is never removed or hidden.

**Dropped at the page.** This is the gap.

- `entity-wiki/generate-wiki.mjs` contains **zero** references to `thought_edges`. So does
  `wiki-synthesis/scripts/synthesize-wiki.mjs`. Verified by direct search of both files.
- `entity-wiki` sources its relationships from the *entity-level* `edges` table, filtered
  `relation=neq.co_occurs_with`. That table's documented vocabulary is `co_occurs_with, works_on, uses,
  related_to, member_of, located_in` — **`contradicts` is not in it**, and `edges` has no `CHECK`
  constraint or temporal columns at all.
- `entity-wiki`'s system prompt asks for a fixed section list — Summary (2–3 sentences), Key Facts,
  Timeline, Relationships, Open Questions — with relationships grouped under `### {relation_type}`
  subheadings, and gives `### supports` as an example. Since `supports` and `contradicts` live in
  `thought_edges`, which this script never queries, that example cannot fire as written.
- Neither generator reads `thoughts.supersedes`, so superseded rows are fed to the synthesiser
  indistinguishably from current ones.

So the pipeline computes contradictions, stores them durably with temporal bounds, and then generates a page
that cannot see them. The Summary section is a single confident narrative per entity, with no instruction
anywhere to preserve tension, flag disagreement, or represent a held-then-revised position. **Nothing in the
page-generation layer preserves contradictions.**

`wiki-synthesis`'s `autobiography` synthesiser is further from it still: it buckets thoughts by year and asks
for "flowing prose, 2–4 paragraphs per year" in second person, instructing the model not to fabricate but
never to surface conflict.

Both generators do carry serious prompt-injection defences (explicit untrusted-data framing, `<thought>`
fencing, a pre-scrub pass, and an instruction to surface suspected injection under "Open Questions") — worth
noting as a pattern braintrust will need for the same reason.

## What I could not determine

- **Whether `pg_cron` appears anywhere in the tree.** GitHub code search needs authentication and the MCP
  GitHub tools are scoped away from this repo. The conclusion in §3 rests on the ~20 files read plus three
  READMEs that all describe external invocation. High confidence, not exhaustive.
- **Whether the pipeline works end to end.** Nothing was executed. All findings are static reads.
- **One apparent inconsistency I could not resolve.** `wiki-synthesis/scripts/backfill-gmail-wikis.mjs`
  inserts into `thought_edges` with `relation: "derived_from"`, but the `CHECK` constraint quoted in §6
  permits only six values and `derived_from` is not among them. `thought_edges` is defined in exactly one
  place in the tree (`schemas/typed-reasoning-edges/schema.sql`) — I checked `provenance-chains` and
  `enhanced-thoughts` and neither defines it. **Inferred:** those inserts would fail the constraint at
  runtime. Not verified — I did not run it, and the script wraps the inserts in `Promise.allSettled` with a
  warning path and a `"ok_partial_edges"` state, which would mask exactly this failure. Flagging it because
  it suggests the composed pipeline is less exercised than the individual recipes.
- **`entity-wiki`'s and `wiki-synthesis`'s authorship and creation dates** — I read `wiki-compiler`'s and
  `ob-graph`'s `metadata.json` in full but only spot-checked the other two.

## What this constrains for braintrust

**1. braintrust writes its own compiler. This is now settled, not open.**
Open question 1 in [ob1-hybrid-graph-plugin.md](./ob1-hybrid-graph-plugin.md) asked whether a third-party
extension could build on the graph plugin. The answer is no — not because of policy or licence, but because
`thought_entities`, `entity_extraction_queue`, and `thought_edges` are FK-bound to `public.thoughts` and the
only ingestion door is a trigger on that table. A `braintrust_*` row cannot participate. This also confirms
open question 2's supposition: braintrust's compiler reads braintrust's tables, and therefore is not the OB1
graph plugin in any sense beyond inspiration.

**2. The architecture is worth copying; the code is not available to copy.** The shape is validated by a
working implementation — trigger enqueues, worker extracts entities, classifier types the edges, generator
compiles pages, manifest records the run, database stays authoritative. braintrust can adopt that decomposition
freely. It must not adopt the source (FSL-1.1-MIT vs MIT), and given §4 there is nothing worth vendoring anyway.

**3. Design the edge table with a closed relation vocabulary and temporal bounds from day one.**
`thought_edges`'s combination — `CHECK`ed relation set including `contradicts` and `supersedes`,
`valid_from` / `valid_until`, `UNIQUE (from, to, relation)` so multiple relations coexist, and an upsert RPC
that widens rather than overwrites — is directly applicable and is the part OB1 got right. A
`braintrust_edges` table can mirror this shape without mirroring the code.

**4. The contradiction gap is braintrust's core requirement, and OB1 demonstrates exactly how it gets lost.**
The hybrid research argued that preserving held-then-revised positions is the product, not a caveat. OB1
shows the failure mode concretely and structurally: the contradiction survives every storage layer and dies
in the last hop, because the page generator queries the wrong table and the page template has no section for
disagreement. For braintrust that means two explicit requirements —
(a) the compiler's read query must include the contradiction edges, and
(b) the page template must have a first-class section for unresolved tension and superseded positions, not
just a Summary. Neither is hard; both are easy to omit, and OB1 omitted them.

**5. Compiled pages do not have to be files.** The hybrid research worried that a local wiki directory is
unreachable from a remote HTTP MCP server. `entity-wiki`'s `entity-metadata` and `thought` output modes
already solve this — pages as rows, queryable via SQL and reachable via MCP. braintrust should default to
rows and treat file output as an export. Note the `thought` mode's hard rule: a page row without an
embedding is unreachable, so the CLI refuses to write one. braintrust needs the same invariant.

**6. Guard against compiled output re-entering ingestion.** OB1's only protection is the trigger's
`metadata->>'generated_by'` check. braintrust needs an equivalent marker on compiled rows before its
compiler ever writes back, or a second pass will distil its own output.

**7. `ob-graph` is the one piece that could be reused as-is, and probably should not be.** It is
table-agnostic (no FK on `thought_id`), ships Postgres-native traversal, and exposes a remote HTTP MCP
server — compatible with the constraint from [ob1-seams.md](./ob1-seams.md) §3.4. But it is a manual layer
with nothing populating it, it is FSL-1.1-MIT, and adopting it means adopting `graph_nodes`/`graph_edges`
naming in the shared `public` schema rather than `braintrust_*`. Worth knowing it exists; not obviously
worth taking.

**8. Recipe packaging is a documentation convention, so there is no integration surface to target.**
A recipe is a folder with a README and a `metadata.json`, validated by CI for completeness and nothing else;
composition is hardcoded file paths and child processes. There is no API to be compatible with, no registry
to appear in, and no versioning contract. If braintrust ever wants to ship an in-repo OB1 recipe, the cost
is writing a README and a metadata file — but it inherits none of the compiler, for the reasons in §4.

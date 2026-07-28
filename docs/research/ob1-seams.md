# OB1 seams: schema, MCP surface, and extension contract

Research for [braintrust#6](https://github.com/cgbarlow/braintrust/issues/6).

**Sources:** the OB1 repository itself, read at commit `6779106` (`Merge pull request #351`, 2026-07-03), plus the canonical FSL licence template from `getsentry/fsl.software`. No blog posts or third-party summaries. Every claim below has a URL; anything I could not confirm is listed explicitly under "What I could not determine".

---

## Bottom line

**OB1's real shape supports braintrust as a separate extension — the pattern is not just permitted, it is the house style.** Every OB1 extension is exactly this: its own tables in the same Postgres, its own MCP server deployed separately, reading `thoughts` across a bridge. The maintainers wrote the guard rails for it explicitly ("Never modify the core `thoughts` table structure", "Modifies core Open Brain infrastructure … that's upstream, not here") and the CI gate enforces them.

But four assumptions in the ticket brief are wrong or under-specified, and one of them is structural:

1. **"Its own tables in the same Postgres" — yes, but not in its own Postgres schema.** OB1 has **zero** `CREATE SCHEMA` statements anywhere in the repo. Every extension table lives in `public` with a name prefix (`agent_memory_*`, `crm_*`, `openbrain_*`). A separate namespace is not the norm; it is unprecedented. It is not forbidden either — just off-pattern, and OB1's `NOTIFY pgrst, 'reload schema'` / PostgREST exposure story assumes `public`.

2. **"Its own MCP server alongside OB1's" — fully supported, but it must be a remote HTTP server, not an npm package.** OB1's CI gate rule 14 and `CLAUDE.md` both ban local Node.js stdio servers outright: *"Never use `claude_desktop_config.json`, `StdioServerTransport`, or local Node.js servers."* If braintrust ships as an npm package with a stdio MCP server, it is architecturally off-contract with OB1's stated pattern. This is the one real collision with the separate-extension plan as described. (It only *binds* if braintrust wants to be an in-repo OB1 contribution; as an independent project it is a compatibility choice, not a rule — see §2.)

3. **"Never writing to `thoughts`" — a stricter self-imposed rule than OB1 requires.** OB1's own flagship sidecar (`agent-memory-api`) writes to `thoughts` on every write-back, via `upsert_thought` then a direct `UPDATE … SET embedding`. Read-only is a fine choice, but it is braintrust's choice, not OB1's constraint.

4. **`thoughts` has no chunking model, and OB1 deliberately removed one.** A PR that added `parent_id` / `chunk_index` / `full_text` was rolled back with the note: *"After community discussion, we decided to keep the core schema simple. The active community pattern is truncation + fingerprinting, not chunking."* One row = one embedding. braintrust ingests long-form published content (posts, transcripts) and will almost certainly need chunking — which means chunks must live in **braintrust's own tables**, not in `thoughts`.

Licence-wise, nothing reaches braintrust's MIT licence as long as braintrust does not copy OB1 code. OB1 itself sets the precedent by publishing its own npm client package under `MIT-0` rather than FSL.

---

## 1. The schema

### 1.1 The `thoughts` table — real columns

From the setup guide, [`docs/01-getting-started.md` §2.2](https://github.com/NateBJones-Projects/OB1/blob/main/docs/01-getting-started.md), verbatim:

```sql
create table thoughts (
  id uuid default gen_random_uuid() primary key,
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

Plus one more column added in §2.6 of the same doc:

```sql
ALTER TABLE thoughts ADD COLUMN content_fingerprint TEXT;
```

The guide's own verification line confirms the canonical set:

> ✅ **Done when:** Table Editor shows the `thoughts` table with columns: id, content, embedding, metadata, content_fingerprint, created_at, updated_at.

**That is the whole base table. Seven columns.** No `user_id`, no `source`, no `type`, no `title`, no `url`, no chunk linkage. Everything else lives in `metadata jsonb`.

Indexes and machinery shipped alongside it (same file):

- `create index on thoughts using hnsw (embedding vector_cosine_ops)`
- `create index on thoughts using gin (metadata)`
- `create index on thoughts (created_at desc)`
- `CREATE UNIQUE INDEX idx_thoughts_fingerprint ON thoughts (content_fingerprint) WHERE content_fingerprint IS NOT NULL`
- trigger `thoughts_updated_at` → `update_updated_at()`
- RLS enabled; single policy `"Service role full access"` using `auth.role() = 'service_role'`
- `grant select, insert, update, delete on table public.thoughts to service_role;` — **required**, Supabase no longer auto-grants this

Two RPCs are the actual read/write API surface:

- **`match_thoughts(query_embedding vector(1536), match_threshold float default 0.7, match_count int default 10, filter jsonb default '{}'::jsonb)`** → returns `(id uuid, content text, metadata jsonb, similarity float, created_at timestamptz)`. Cosine (`<=>`), with a `metadata @> filter` containment predicate.
- **`upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')`** → returns `jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint)`. The fingerprint is `sha256(lower(trim(regexp_replace(content, '\s+', ' ', 'g'))))` hex-encoded. On fingerprint conflict it merges metadata (`thoughts.metadata || EXCLUDED.metadata`) rather than inserting.

**Note the shape of `upsert_thought`: it does not take an embedding.** Callers insert the row, then issue a second statement `supabase.from("thoughts").update({ embedding }).eq("id", thoughtId)`. This is the pattern in both the core server and the agent-memory API (see §4).

### 1.2 Raw content ↔ embedding relationship

They are the **same row**. `content` is the raw text; `embedding` is a single `vector(1536)` over that same text. There is no separate embeddings table, no chunk table, no 1:N relationship.

The strongest evidence that this is deliberate is [`recipes/email-history-import/rollback-chunking-columns.sql`](https://github.com/NateBJones-Projects/OB1/blob/main/recipes/email-history-import/rollback-chunking-columns.sql), which exists solely to undo a chunking model that briefly shipped:

> PR #27 (email-history-import) originally added three columns to the thoughts table for RAG-style chunking: `parent_id`, `chunk_index`, `full_text`. After community discussion, we decided to keep the core schema simple. The active community pattern is truncation + fingerprinting, not chunking.

The community's substitute for chunking is **atomization** — [`recipes/atomizer/`](https://github.com/NateBJones-Projects/OB1/tree/main/recipes/atomizer) uses an LLM to split compound text into multiple standalone `thoughts` rows: *"Atomic thoughts embed better, retrieve more precisely, and compose into higher-signal context packs than whole-body blobs."*

**Implication for braintrust:** if you want passage-level retrieval over a 4,000-word essay, `thoughts` gives you exactly one vector for it. Chunk storage is braintrust's problem, in braintrust's tables.

### 1.3 The "Agent Memory" sidecar tables

Source of truth: [`schemas/agent-memory/schema.sql`](https://github.com/NateBJones-Projects/OB1/blob/main/schemas/agent-memory/schema.sql). Its own header states the design intent:

> This migration intentionally keeps `public.thoughts` as the durable content table. Agent memory metadata, provenance, review, trace, and audit state live in sidecar tables so existing OB1 capture/search behavior keeps working.

It also hard-guards on the base table existing:

```sql
RAISE EXCEPTION 'agent-memory requires public.thoughts. Run docs/01-getting-started.md first.';
```

The eight tables, verbatim names:

| Table | Role | Key columns / constraints |
| --- | --- | --- |
| `public.agent_memories` | The hub record | `thought_id UUID REFERENCES public.thoughts(id) ON DELETE SET NULL`, `workspace_id`, `project_id`, `visibility` (`personal`/`channel`/`project`/`workspace`/`organization`), `memory_type` (`decision`/`output`/`lesson`/`constraint`/`open_question`/`failure`/`artifact_reference`/`work_log`), `summary`, `content`, `lifecycle_status`, `provenance_status` (`observed`/`inferred`/`user_confirmed`/`imported`/`generated`/`superseded`/`disputed`), `confidence NUMERIC(3,2)`, `created_by`, `runtime_name`/`runtime_version`/`provider`/`model`, `task_id`/`flow_id`, `can_use_as_instruction`/`can_use_as_evidence`/`requires_user_confirmation`, `review_status`, `last_confirmed_at`, `stale_after`, `idempotency_key`, `content_hash`, `metadata jsonb` |
| `public.agent_memory_source_refs` | source-reference sidecar | `memory_id` FK CASCADE, `source_kind`, `uri`, `title`, `source_timestamp` |
| `public.agent_memory_artifacts` | artifact pointers | `memory_id` FK CASCADE, `artifact_kind`, `uri`, `description` |
| `public.agent_memory_relations` | relation sidecar | `from_memory_id`/`to_memory_id`, `relation` ∈ (`related_to`, `supersedes`, `superseded_by`, `conflicts_with`, `merged_into`) |
| `public.agent_memory_review_actions` | review sidecar | `action` ∈ (`confirm`, `edit`, `evidence_only`, `restrict_scope`, `mark_stale`, `merge`, `reject`, `dispute`, `supersede`), `actor_id`, `before`/`after jsonb` |
| `public.agent_memory_recall_traces` | recall-trace header | `request_id`, `workspace_id`, `query`, `schema_version`, `request_payload`, `response_policy` |
| `public.agent_memory_recall_items` | recall-trace rows | `trace_id`, `memory_id`, `rank`, `similarity`, `ranking_score`, `returned`, `used`, `ignored_reason`, `use_policy_snapshot` |
| `public.agent_memory_audit_events` | audit sidecar | `event_type` ∈ (`recall_requested`, `memory_returned`, `memory_used`, `memory_ignored`, `memory_written`, `memory_confirmed`, `memory_edited`, `memory_rejected`, `memory_superseded`, `memory_disputed`), `actor_kind`, `payload jsonb` |

Also shipped: `public.agent_memories_set_updated_at()` trigger fn, `public.agent_memory_hash_text(TEXT)` (the same sha256-of-normalised-text as `upsert_thought`), RLS enabled on all eight with a `service_role` `USING (true) WITH CHECK (true)` policy each, explicit `GRANT SELECT, INSERT, UPDATE, DELETE … TO service_role`, and a closing `NOTIFY pgrst, 'reload schema';`.

**Use-policy note:** the trust model is encoded as a table constraint, not convention:

```sql
CHECK (
  can_use_as_instruction = false
  OR provenance_status IN ('user_confirmed', 'imported')
)
```

Agent-generated memory can never be instruction-grade without human confirmation or trusted import.

### 1.4 Are the sidecars reusable by braintrust, or must they be duplicated?

**Partially reusable, but the reuse would be strained.** Concretely:

- **`agent_memories` is scoped to *agent workflow* memory, not source-content provenance.** `memory_type` is a closed `CHECK` list of agent-workflow kinds (`decision`, `lesson`, `failure`, `work_log`…). A braintrust record like "Simon Willison published a post on 2026-07-12" fits none of them, and the enum is enforced at the database level, so braintrust cannot add a value without an `ALTER TABLE … DROP CONSTRAINT` on a table it does not own. Same for `provenance_status` and `review_status`.
- **`workspace_id TEXT NOT NULL` is required** on every row and on `agent_memory_recall_traces`. braintrust would have to invent a workspace identity to satisfy it.
- **The genuinely reusable pieces are the *shapes*, not the tables**: `agent_memory_source_refs` (source_kind/uri/title/source_timestamp) is close to what braintrust needs for "which post did this persona trait come from", and `agent_memory_relations` + `agent_memory_recall_traces`/`_items` are good models to copy. Copying the *design* is free; sharing the *tables* means depending on a schema whose CHECK constraints are tuned for a different domain, and whose migration you do not control.
- **Practical dependency risk:** agent-memory is an optional schema. A braintrust that hard-depends on `agent_memories` existing would break for every OB1 user who never ran `schemas/agent-memory/schema.sql`. Nothing in the base setup guide installs it.

**Recommendation from the sources:** duplicate the shapes into `braintrust_*` tables; do not FK into `agent_memories`. Do FK into `public.thoughts(id)` — that is the sanctioned bridge, and `agent_memories.thought_id` shows exactly how (`ON DELETE SET NULL`, nullable).

---

## 2. The extension contract

### 2.1 There is no migration framework

There is no `supabase/migrations/` directory, no numbered migration convention, no schema-version table. Extension SQL is a single file — usually `schema.sql` — that the user **pastes into the Supabase SQL Editor by hand**. From [`schemas/_template/README.md`](https://github.com/NateBJones-Projects/OB1/blob/main/schemas/_template/README.md):

> 1. Open your Supabase SQL Editor
> 2. Run the SQL migration
> 3. Verify the table/columns were created

Filenames observed across the repo: `schema.sql` (most), `migration.sql`, `init.sql`, `001-create-thoughts.sql`, `20260417_edge_fn_optimizations.sql`. **No enforced convention.** The de-facto requirement is idempotence: agent-memory wraps everything in `BEGIN … COMMIT` and uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `DROP POLICY IF EXISTS` throughout; `schemas/enhanced-thoughts/schema.sql` says outright *"Safe to run multiple times (fully idempotent)."*

### 2.2 Namespacing: prefixed tables in `public`, never a separate schema

`grep -r "CREATE SCHEMA"` across the entire repo returns **nothing**. Every table created by every schema, extension, integration and recipe lands in `public`. Observed table names:

```
public.agent_memories, public.agent_memory_artifacts, public.agent_memory_audit_events,
public.agent_memory_keys, public.agent_memory_recall_items, public.agent_memory_recall_traces,
public.agent_memory_relations, public.agent_memory_review_actions, public.agent_memory_source_refs,
public.consolidation_log, public.crm_person_mentions, public.crm_persons, public.edges,
public.entities, public.entity_extraction_queue, public.ingestion_items, public.ingestion_jobs,
public.openbrain_agents, public.thought_edges, public.thought_entities,
activities, applications, companies, contact_interactions, family_members, household_items,
household_vendors, important_dates, interviews, job_contacts, job_postings, maintenance_logs,
maintenance_tasks, meal_plans, opportunities, professional_contacts, readwise_books,
recipes, shopping_lists, thought_audit
```

Note the unprefixed ones (`recipes`, `companies`, `activities`, `opportunities`) — the early extensions squatted generic names and the newer contributions moved to prefixes. The prefix rationale is stated once, in [`extensions/professional-crm/README.md`](https://github.com/NateBJones-Projects/OB1/blob/main/extensions/professional-crm/README.md):

> All tools use the `crm_` prefix for clear namespace separation from other extensions.

**The prefix convention already has a real collision, which is worth seeing before trusting it.** `public.agent_memory_keys` is *not* part of `schemas/agent-memory/` — it is defined by a different, independent contribution, [`schemas/per-agent-identity/schema.sql`](https://github.com/NateBJones-Projects/OB1/blob/main/schemas/per-agent-identity/schema.sql), which borrows the `agent_memory_` prefix for its API-key table (`key_hash TEXT PRIMARY KEY`, FK to `public.openbrain_agents`). Two unrelated contributions, one prefix, one flat namespace, no coordination mechanism. This is the failure mode `public`-with-prefixes has and a dedicated schema does not.

**Reading:** a `braintrust_` table prefix in `public` is the on-pattern choice and is also defensively correct given the generic names already squatted. A dedicated `braintrust` Postgres schema would be cleaner engineering but has no precedent in OB1, and would need extra `GRANT USAGE ON SCHEMA` + PostgREST `db-schemas` configuration that no OB1 doc covers.

### 2.3 What is off-limits — the hard rules

From [`CLAUDE.md`](https://github.com/NateBJones-Projects/OB1/blob/main/CLAUDE.md) "Guard Rails":

> - **Never modify the core `thoughts` table structure.** Adding columns is fine; altering or dropping existing ones is not.
> - **No `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or unqualified `DELETE FROM`** in SQL files.
> - **MCP servers must be remote (Supabase Edge Functions), not local.** Never use `claude_desktop_config.json`, `StdioServerTransport`, or local Node.js servers.

From [`CONTRIBUTING.md`](https://github.com/NateBJones-Projects/OB1/blob/main/CONTRIBUTING.md) "What Gets Rejected":

> - Modifies core Open Brain infrastructure (the `thoughts` table structure, the core MCP server) — that's upstream, not here

And the machine-enforced version, [`.github/workflows/ob1-gate-v2.yml`](https://github.com/NateBJones-Projects/OB1/blob/main/.github/workflows/ob1-gate-v2.yml):

```bash
alter_thoughts=$(grep -niE 'ALTER\s+TABLE\s+thoughts\s+(DROP|ALTER)\s+COLUMN' "$f")
… "modifies core thoughts table columns (only ADD COLUMN is allowed)"
```

`ADD COLUMN` on `thoughts` is explicitly allowed and widely used — `schemas/enhanced-thoughts/schema.sql` adds `type`, `sensitivity_tier`, `importance`, `quality_score`, `source_type`, `enriched`, `status`, `status_updated_at`.

**But the better-citizen pattern is documented in [`schemas/provenance-chains/README.md`](https://github.com/NateBJones-Projects/OB1/blob/main/schemas/provenance-chains/README.md):**

> The helpers `trace_provenance` and `find_derivatives` surface three fields — `type`, `source_type`, and `sensitivity_tier` — that the canonical `public.thoughts` table stores inside `metadata`, not as top-level columns. This migration reads them via `metadata->>'…'` so it installs cleanly on a stock OB1 setup. **No extra `ADD COLUMN` is required.**

That is the standard braintrust should hold itself to: read `thoughts.metadata` via `->>`, add nothing.

### 2.4 Also required of any contribution

- `README.md` + `metadata.json` per folder, with `requires.open_brain: true`, plus `requires_skills` / `requires_primitives` dependency arrays
- A `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.your_table TO service_role;` step is **mandatory** for anything creating tables
- MCP tool annotations mandatory: read tools `annotations: { readOnlyHint: true }`, write tools `{ readOnlyHint: false, openWorldHint: false, destructiveHint: false }`
- A link to `docs/05-tool-audit.md` from the README of anything exposing MCP tools
- PR title `[schemas] …` / `[integrations] …` etc.; branch `contrib/<username>/<short-description>`

### 2.5 The unresolved tension: in-repo contribution vs. independent package

Every one of the rules above governs **contributions to the OB1 repo**. braintrust as described is an *independent* npm package in a different repo, so none of them bind legally or mechanically. But two of them are the difference between "composes cleanly with a user's OB1" and "requires the user to run something OB1 tells them not to":

- **stdio MCP server.** OB1 tells users, repeatedly and in CI, not to run local stdio MCP servers. If braintrust ships one, it works — Claude Code and Cursor will happily run it — but it is the opposite of what every OB1 doc instructs. See §3.4.
- **npm distribution.** There *is* precedent: OB1 publishes [`@natebjones/ob1-agent-memory`](https://github.com/NateBJones-Projects/OB1/blob/main/integrations/openclaw-agent-memory/plugin/package.json) to npm. But that package is an **OpenClaw plugin that calls a remote HTTP API** — it is not itself an MCP stdio server. The npm-package half of braintrust's plan is precedented; the stdio-MCP-server half is not.

---

## 3. The MCP server

### 3.1 The core server's tools — verbatim

[`server/index.ts`](https://github.com/NateBJones-Projects/OB1/blob/main/server/index.ts), `new McpServer({ name: "open-brain", version: "1.0.0" })`. Six registered tools:

| Tool | Annotations | Input schema | What it does |
| --- | --- | --- | --- |
| `search` | `readOnlyHint: true` | `{ query: string }` | ChatGPT-compatibility shim. Embeds query, calls `match_thoughts` (threshold 0.5, count 10), returns `{ results: [{id, title, url}] }` |
| `fetch` | `readOnlyHint: true` | `{ id: string }` | ChatGPT-compatibility shim. `select("id, content, metadata, created_at, updated_at").eq("id", id).single()` |
| `search_thoughts` | `readOnlyHint: true` | `{ query: string, limit?: number = 10, threshold?: number = 0.5 }` | Primary semantic search via `match_thoughts` |
| `list_thoughts` | `readOnlyHint: true` | `{ limit?: number = 10, type?, topic?, person?, days? }` | Recency listing; filters are `metadata` containment (`.contains("metadata", { type })`, `{ topics: [topic] }`, `{ people: [person] }`) |
| `thought_stats` | `readOnlyHint: true` | `{}` | Counts, type histogram, top-10 topics and people |
| `capture_thought` | `readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false` | `{ content: string }` | Embeds + LLM-extracts metadata in parallel, `upsert_thought`, then `UPDATE thoughts SET embedding` |

The `search`/`fetch` pair exists for a specific reason, stated in the code comment:

> ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep research look for exact read-only `search` and `fetch` tool shapes.

**This is a live collision risk for braintrust.** If braintrust's MCP server also registers generically-named tools, an AI client with both servers connected sees ambiguous names. OB1 already flags this in `docs/05-tool-audit.md`:

> When you have `search_contacts`, `search_household_items`, `search_recipes`, `search_thoughts`, `search_activities`, and `search_maintenance_history` all loaded simultaneously, the AI has to distinguish between six similarly-named tools on every query.

Follow the `crm_` precedent: prefix every braintrust tool (`braintrust_*`), and **do not** register bare `search` or `fetch` — those names are effectively reserved by OB1's ChatGPT shim.

### 3.2 Transport, auth, registration

- Deno + Hono + `@modelcontextprotocol/sdk` `McpServer` + `@hono/mcp` `StreamableHTTPTransport`, served by `Deno.serve(app.fetch)` as a Supabase Edge Function.
- Auth is a shared secret, not OAuth: `const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key")`. Auth failures return **HTTP 200 with a JSON-RPC error envelope** (`code: -32001`) rather than a bare 401 — the comment explains that Codex CLI and Claude Code tear down the connection on transport-level 4xx.
- **Header name differs between core and extensions.** From [`primitives/remote-mcp/README.md`](https://github.com/NateBJones-Projects/OB1/blob/main/primitives/remote-mcp/README.md): *"the core Open Brain server uses `x-brain-key` while extension servers use `x-access-key`. Prefer the `?key=` query parameter approach to avoid header name confusion."*
- The server is **stateless per request** — `buildServer()` is called fresh inside the request handler and `response.headers.delete("mcp-session-id")` strips session affinity.
- There is a documented compatibility hack: Claude Desktop connectors omit the `Accept: text/event-stream` header, so the server patches the request before handing it to the transport.

Registration, per client (all from `primitives/remote-mcp/README.md`):

- **Claude Desktop:** Settings → Connectors → Add custom connector → paste `https://REF.supabase.co/functions/v1/extension-mcp?key=…`
- **Claude Code:** `claude mcp add --transport http extension-name <url> --header "x-access-key: …"`
- **Cursor:** `~/.cursor/mcp.json` with a `url` field. *"Do **not** use `mcp-remote` for Cursor. Newer versions of `mcp-remote` attempt OAuth client registration, which fails against Open Brain's simple key-based auth."*
- **ChatGPT:** Developer Mode → Apps & Connectors → Create → No Authentication (key in URL)
- **stdio-only clients:** the documented escape hatch is bridging *out* to the remote server via `npx mcp-remote <url>?key=…` — i.e. even the stdio path is a bridge to an HTTP server, never a natively-local MCP server.

### 3.3 Is a second MCP server supported, or a collision?

**Explicitly supported. It is the standard architecture.** Direct quotes:

`primitives/remote-mcp/README.md`:
> You can add multiple extensions as separate connectors and toggle them per conversation.

`docs/05-tool-audit.md`, §3 "Scoping by Use Case":
> Each scoped server is its own Supabase Edge Function with its own MCP tool definitions. They share the same database — scoping is about which tools are exposed, not which data is accessible.
>
> In Claude Desktop: Settings → Connectors. Add each server as a separate connector. Connect only the ones relevant to your current task.

The doc's opening line assumes it: *"Who this is for: Anyone running multiple MCP servers or a single server with more than ~10 tools."*

Distinct `McpServer` names already coexisting in the repo confirm it: `open-brain`, `open-brain-enhanced`, `open-brain-update-thought`, `open-brain-delete-thought`, `open-brain-unified`, `professional-crm`, `meal-planning-shared`, `work-operating-model-activation`, `ob-graph`, `household-knowledge`.

**The cost is documented, not hidden.** From the same doc: a tool definition is 150–400 tokens; 40 tools is 6,000–16,000 tokens before the user speaks; and *"deferred loading … doesn't help with routing accuracy."* The stated principle is **"fewer, smarter tools beat many narrow ones."** braintrust should aim for a handful of well-named tools, not a CRUD surface per table.

### 3.4 The npm-package collision, stated plainly

`CLAUDE.md`:
> **MCP servers must be remote (Supabase Edge Functions), not local.** Never use `claude_desktop_config.json`, `StdioServerTransport`, or local Node.js servers. All extensions deploy as Edge Functions and connect via Claude Desktop's custom connectors UI.

`CONTRIBUTING.md` automated rule 14:
> **Remote MCP pattern** — Extensions and integrations must use remote MCP via Supabase Edge Functions. No `claude_desktop_config.json`, no local Node.js stdio servers.

This is the single clearest contradiction of the ticket brief's "its own npm package … its own MCP server alongside OB1's" if that server is stdio. Options, in decreasing order of OB1-alignment:

1. Ship the MCP server as a Supabase Edge Function (Deno) like every OB1 extension; the npm package becomes the ingestion/CLI half only.
2. Ship a Node HTTP MCP server (Streamable HTTP), self-hosted; off OB1's deployment target but on OB1's *transport* contract.
3. Ship stdio. Works today in Claude Code/Cursor, but contradicts every OB1 instruction the user has read and cannot ever be contributed upstream.

### 3.5 The bridge precedent

[`extensions/professional-crm/index.ts`](https://github.com/NateBJones-Projects/OB1/blob/main/extensions/professional-crm/index.ts) shows exactly how a separate server reads `thoughts`:

```ts
server.tool(
  "crm_link_thought",
  "CROSS-EXTENSION: Link a thought from your core Open Brain to a professional contact",
  {
    thought_id: z.string().describe("Thought ID (UUID) from core Open Brain thoughts table"),
    contact_id: z.string().describe("Contact ID (UUID)"),
  },
  async ({ thought_id, contact_id }) => {
    const { data: thought } = await supabase.from("thoughts").select("*").eq("id", thought_id).single();
    …
```

Its full tool set — all prefixed — is `crm_add_contact`, `crm_create_opportunity`, `crm_get_contact_history`, `crm_get_follow_ups`, `crm_link_thought`, `crm_log_interaction`, `crm_prep_context`, `crm_search_contacts`, `crm_search_contacts_fts`, `crm_stale_contacts`, `crm_update_contact`. This is the template braintrust should copy.

---

## 4. The embedding pipeline

### 4.1 Model

**`openai/text-embedding-3-small`, 1536 dimensions, called through OpenRouter** (`https://openrouter.ai/api/v1/embeddings`). `server/index.ts`:

```ts
async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  …
  return d.data[0].embedding;
}
```

`text-embedding-3-small` appears **83 times** across the repo; `text-embedding-3-large` appears once, only as a "if you switched" note. Metadata extraction (a separate concern) uses `openai/gpt-4o-mini` with `response_format: { type: "json_object" }`, extracting `people`, `action_items`, `dates_mentioned`, `topics`, `type`.

### 4.2 The model is *not* guaranteed — this matters for braintrust

`docs/01-getting-started.md`:
> Because you're using OpenRouter, you can swap models by editing the model strings in the Edge Function code and redeploying. Just make sure embedding dimensions match (1536 for the current setup).

[`recipes/local-ollama-embeddings/README.md`](https://github.com/NateBJones-Projects/OB1/blob/main/recipes/local-ollama-embeddings/README.md) documents users running `nomic-embed-text` (768) or `mxbai-embed-large` (1024) with `ALTER TABLE thoughts ALTER COLUMN embedding TYPE vector(768);`, and warns:

> Do **not** mix embeddings from different models in the same similarity search. Embeddings from different models occupy different semantic spaces — cosine similarity between them is meaningless, even if the dimensions happen to match. If you switch models, re-embed your entire corpus.

**Consequence:** braintrust cannot hardcode `vector(1536)` and cannot assume its own embeddings are comparable to `thoughts.embedding`. Either (a) braintrust generates its own embeddings with its own declared model and never compares them to OB1's vectors, or (b) braintrust reads the deployed OB1 config and matches it. Option (a) is far safer. Also note (a) means braintrust must not naively call `match_thoughts` with a vector from a different model.

### 4.3 Chunk sizes

**There is no chunking.** Confirmed by grep across every `.ts`/`.mjs`/`.py` in the repo: every "chunk" hit is batch-concurrency slicing or HTTP stream buffering, never text segmentation for embedding. And the rollback file in §1.2 records the deliberate decision.

The de-facto sizing convention in the import recipes (e.g. [`recipes/x-twitter-import/import-x-twitter.mjs`](https://github.com/NateBJones-Projects/OB1/blob/main/recipes/x-twitter-import/import-x-twitter.mjs), `recipes/grok-export-import/import-grok.mjs`) is **truncate, twice, at different limits**:

```js
const truncated = text.length > 8000 ? text.substring(0, 8000) : text;   // → embedding input
…
const truncated = content.length > 30000
  ? content.substring(0, 30000) + "\n\n[... truncated]"                  // → stored content
  : content;
```

So: ~8,000 chars embedded, up to ~30,000 chars stored. These are recipe-level conventions, not enforced anywhere.

### 4.4 Re-indexing hooks

There is **no re-indexing hook, trigger, or queue in the core system.** The `thoughts_updated_at` trigger touches `updated_at` only; nothing recomputes `embedding` when `content` changes. Re-embedding is a manual, script-driven activity — the repo carries a family of standalone backfill scripts (`recipes/thought-enrichment/backfill-type.mjs`, `backfill-sensitivity.mjs`, `recipes/provenance-chains/backfill.mjs`, `recipes/source-filtering/backfill-metadata.ts`, `recipes/fingerprint-dedup-backfill/`), each a one-off Node script hitting Supabase with the service-role key. `recipes/thought-enrichment` is the most developed pattern: concurrency chunking, `lastProcessedId` checkpointing to `data/enrichment-state.json`, resume on restart, `--reset-state`.

**Implication:** if braintrust needs "continuously updated" personas, it owns its own scheduling. OB1 provides no change-feed, no `NOTIFY` on `thoughts` insert, no webhook. braintrust must poll (`created_at > watermark`) or drive its own ingestion loop.

### 4.5 The write path (for reference — this is what braintrust has decided not to do)

`integrations/agent-memory-api/index.ts` `POST /writeback`, the canonical sidecar-writes-to-thoughts sequence:

```ts
const embedding = await getEmbedding(row.content);
const { data: upsertResult } = await supabase.rpc("upsert_thought", {
  p_content: row.content,
  p_payload: { metadata: { source: "agent_memory", source_type: "agent_memory", type: row.memory_type, … } },
});
const thoughtId = upsertResult?.id;
if (thoughtId) await supabase.from("thoughts").update({ embedding }).eq("id", thoughtId);
const { data: memory } = await supabase.from("agent_memories").insert({ thought_id: thoughtId, … });
```

Its `POST /recall` reads `match_thoughts(threshold: 0.25)`, maps thought ids → similarity, then joins into `agent_memories` on `thought_id`. Note the threshold: 0.25 here, 0.5 in `search_thoughts`, 0.7 as the RPC default. `integrations/hermes-agent-memory/README.md` observes *"The OB1 Agent Memory API uses `match_thoughts(threshold=0.7)` against `text-embedding-3-small`, which is strict. Related items often score 0.4–0.6."*

There is an established `metadata.source` convention braintrust should join: observed values include `"mcp"`, `"slack"`, `"telegram"`, `"gmail"`, `"chatgpt"`, `"obsidian"`, `"readwise"`, `"agent_memory"`, `"smart_ingest"`, `"entity_worker"`, `"dashboard_capture"`. If braintrust ever does write, `source: "braintrust"` slots straight in — and if it only reads, this is the field to filter on.

---

## 5. FSL-1.1-MIT

### 5.1 OB1's licence is the unmodified canonical text

[`LICENSE.md`](https://github.com/NateBJones-Projects/OB1/blob/main/LICENSE.md) is byte-for-byte the canonical [`FSL-1.1-MIT.template.md`](https://raw.githubusercontent.com/getsentry/fsl.software/main/FSL-1.1-MIT.template.md) with the placeholders filled: `Copyright 2026 Nate B. Jones`. I diffed the actual texts, not summaries. **No custom clauses, no added restrictions.**

### 5.2 What the text actually says

**Scope — this is the load-bearing clause:**

> The "Software" is each version of the software that we make available under these Terms and Conditions, as indicated by our inclusion of these Terms and Conditions with the Software.

The licence governs *the OB1 code*. Its obligations attach through the Redistribution clause:

> The Terms and Conditions apply to all copies, modifications and derivatives of the Software.
>
> If you redistribute any copies, modifications or derivatives of the Software, you must include a copy of or a link to these Terms and Conditions and not remove any copyright notices provided in or with the Software.

**Grant:**

> we hereby grant you the right to use, copy, modify, create derivative works, publicly perform, publicly display and redistribute the Software for any Permitted Purpose

**Permitted Purpose / Competing Use:**

> A Permitted Purpose is any purpose other than a Competing Use. A Competing Use means making the Software available to others in a commercial product or service that:
> 1. substitutes for the Software;
> 2. substitutes for any other product or service we offer using the Software that exists as of the date we make the Software available; or
> 3. offers the same or substantially similar functionality as the Software.
>
> Permitted Purposes specifically include using the Software:
> 1. for your internal use and access;
> 2. for non-commercial education;
> 3. for non-commercial research; and
> 4. in connection with professional services that you provide to a licensee using the Software in accordance with these Terms and Conditions.

**Future MIT:**

> We hereby irrevocably grant you an additional license to use the Software under the MIT license that is effective on the second anniversary of the date we make the Software available.

Note this is per-version ("each version"), so OB1 code converts to MIT on a rolling two-year basis from each version's release, not repo-wide on one date. `LICENSE.md` bears a 2026 copyright; the commit examined is 2026-07-03, so nothing in the current tree is MIT-available yet.

**Trademarks:**

> Except for displaying the License Details and identifying us as the origin of the Software, you have no right under these Terms and Conditions to use our trademarks, trade names, service marks or product names.

Identifying OB1 as the origin is permitted. Using "Open Brain" or "OB1" as *braintrust's own* product branding is not.

### 5.3 Does anything reach braintrust's MIT licence?

**No — provided braintrust contains no OB1 code.** The reasoning, strictly from the text:

- The obligations in Redistribution attach to *"copies, modifications and derivatives of the Software."* A separately-written package that talks to OB1 over SQL and MCP, and ships zero OB1 source, is none of those three. There is no copyleft-style reach-through clause in FSL — nothing analogous to GPL §5(c) or AGPL §13.
- **Where the licence *does* reach:** if braintrust copies OB1 SQL or TypeScript into its own tree — the `match_thoughts` function body, `upsert_thought`, the `getEmbedding`/`extractMetadata` helpers, the Hono auth wrapper, the agent-memory `schema.sql` — those *copies* remain FSL-1.1-MIT and must carry the notice. This is the realistic failure mode: OB1's SQL is exactly the kind of thing you paste to get compatible behaviour. Reimplement from the documented contract, or vendor it in a clearly-marked, separately-licensed directory.
- **Competing Use:** braintrust builds personas from published content. OB1 is a persistent-memory substrate. Clause 3 ("substantially similar functionality") is the only one worth thinking about, and only if braintrust grows into a general-purpose memory store sold commercially. As a persona builder that *depends on* OB1 rather than replacing it, it does not substitute for OB1. Note also that Competing Use is only triggered by *"making the Software available to others in a commercial product or service"* — a braintrust that ships no OB1 code cannot make the Software available to anyone.
- **Anything the user runs is safe regardless:** "for your internal use and access" is an enumerated Permitted Purpose.

### 5.4 One flag: the maintainers read their own licence more strictly than it reads

[`CLAUDE.md`](https://github.com/NateBJones-Projects/OB1/blob/main/CLAUDE.md) states:

> **License:** FSL-1.1-MIT. No commercial derivative works. Keep this in mind when generating code or suggesting dependencies.

That summary is **stricter than the licence text**, which permits commercial derivative works so long as they are not a Competing Use, and explicitly lists commercial professional services as a Permitted Purpose. This is not legally operative — `LICENSE.md` governs — but it tells you how the maintainers think about the boundary, which is what actually matters for a good-faith relationship with the project. Worth not surprising them.

### 5.5 The precedent that settles the practical question

OB1 publishes its own npm client package under a **different, permissive licence**. [`integrations/openclaw-agent-memory/plugin/package.json`](https://github.com/NateBJones-Projects/OB1/blob/main/integrations/openclaw-agent-memory/plugin/package.json):

```json
{
  "name": "@natebjones/ob1-agent-memory",
  "version": "0.1.6",
  "license": "MIT-0",
  "author": "Nate B. Jones / OB1"
}
```

OB1 itself treats a separately-distributed package that talks to an OB1 database as separately licensable. A braintrust npm package under MIT is squarely within the precedent the project set for itself.

**Caveat:** none of this is legal advice; it is a close reading of the licence text against the facts of the plan.

---

## What I could not determine

Recording these explicitly rather than guessing:

- **Whether OB1 has ever accepted an out-of-repo third-party extension.** Every contribution mechanism I found assumes an in-repo folder. There is no extension registry, no plugin discovery, no `metadata.json` category for "external package". Not found in sources examined.
- **Whether a dedicated Postgres schema (`CREATE SCHEMA braintrust`) would break anything concrete.** No OB1 doc addresses non-`public` schemas at all. PostgREST needs `db-schemas` configured to expose additional schemas and OB1 never mentions it, so a supabase-js client would likely need `.schema('braintrust')` — but I did not find this stated or tested anywhere in OB1. Untested inference, flagged as such.
- **Whether `thoughts.metadata` has any documented reserved-key contract.** I found the de-facto keys written by the core server (`people`, `action_items`, `dates_mentioned`, `topics`, `type`, `source`) and the observed `source` values, but no spec, no JSON Schema, no reserved namespace. Extensions appear free to add arbitrary keys; `agent-memory` nests its own under `metadata.agent_memory`. No rule found either permitting or forbidding it.
- **Any rate limit, quota, or cost guidance for a second service hitting the same OpenRouter key.** `recipes/edge-function-cost-optimization` covers invocation count, not embedding spend. Not found.
- **Whether the maintainers would consider a persona-builder a Competing Use.** No public statement found; §5.3 is my reading of the licence text, not theirs.
- **Version currency.** Read at `6779106` (2026-07-03). The README's own "Recent Contributions" block says "Last updated: 2026-05-22", so that table lags the tree. Anything merged after 2026-07-03 is outside what I examined.

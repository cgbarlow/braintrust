# Deployment

**Status:** decided. Assembled from
[Choose braintrust's MCP transport and deployment shape](https://github.com/cgbarlow/braintrust/issues/13) and
[Choose braintrust's embedding model and chunking strategy](https://github.com/cgbarlow/braintrust/issues/14).

The tables are in [`schema.md`](./schema.md); the tools the server exposes are in
[`mcp-surface.md`](./mcp-surface.md); what the scheduled job does is in
[`ingestion.md`](./ingestion.md#3-one-daily-job-and-everything-expensive-is-a-backlog). The reasoning behind
each choice is in the resolution comments linked above — **this document is the shape.**

---

## 1. A self-hosted HTTP MCP server, not a Supabase Edge Function

**braintrust runs on a container host.** Every other OB1 extension is a one-click Edge Function deploy;
braintrust is not, and it is ruled out by a measurement rather than a preference: **Edge Functions cap at 400s
wall clock** (150s free, plus 2s CPU and 256MB) and the daily job's worst case — the 12-month YouTube backfill
at 4s spacing — is **~26 minutes ≈ 1,560s**.

Slicing the job into ~11 sub-400s invocations driven by `pg_cron` was genuinely live, because
[the Backlog is rows](./ingestion.md#the-backlog-is-rows-not-a-queue) and the job is resumable by
construction. It was rejected for what it does downstream: the compiler's per-Item Note extraction is ~395
model calls and the Compile itself is more, so **a 400s ceiling would shape every decision made after this
one.**

**OB1's rule is honoured.** The ban is on stdio and local servers, verbatim: *"Never use
`claude_desktop_config.json`, `StdioServerTransport`, or local Node.js servers."* A remote HTTP server
satisfies it — "Supabase Edge Functions" is the parenthetical describing *how* OB1 achieves remote, not the
substance of the rule.

**Accepted cost, stated plainly: braintrust stops installing like an OB1 extension.** It needs a container
host. That is a real regression in *composes cleanly with a user's OB1*, and it is accepted.

## 2. Two services, one codebase

**The MCP server and the daily job are separate deployments of the same code.**

- **A web service** — always on, answers questions, tiny.
- **A scheduled job** — wakes daily, runs
  [the cycle](./ingestion.md#the-cycle-in-order) (poll → gap check → drain the Backlog → rebuild), exits.

They share a database and nothing else. No queue, no IPC, no shared memory.

1. **A 26-minute backfill can never slow a question.** Separate processes, separate resource ceilings.
2. **The platform schedules it.** An in-process timer only fires while the process is up, and a web service
   that sleeps on idle — which most cheap tiers do — would silently never ingest. That is precisely the
   invisible failure [the daily-clock decision](./ingestion.md#3-one-daily-job-and-everything-expensive-is-a-backlog)
   exists to prevent, reintroduced by the deployment.
3. **Being killed mid-run costs nothing.** The Backlog is rows, so a deploy, a restart or a platform timeout
   during the backfill loses time and no data.

**Concurrency needs nothing from the deployment.** One rebuild per Person is enforced by a partial unique
index in the database, so braintrust does not need a guarantee of exactly one instance to stay correct. The
deployment is free to restart, overlap, or run two web instances.

**Cost:** two deploys of one image instead of one. The job bills only while awake — ~26 minutes once, then
seconds a day.

**braintrust crawls from one host at one address.** That is what makes
[a block an answer rather than an obstacle](./ingestion.md#5-a-block-is-measured-not-judged): there is nothing
to rotate, so evasion is closed off by construction rather than by policy.

**Which host is not decided.** Any container platform with a cron primitive satisfies the shape.
[Render](https://render.com)'s Web Service + Cron Job pair is the obvious candidate; Fly or Railway would do.

## 3. Configuration

braintrust is configured by environment, and **nothing here has a default that could act on its own.**

| What | Notes |
|---|---|
| **Postgres connection string** | Supabase's **session pooler**, port 5432 — see §5. |
| **MCP shared secret** | Guards the read path only — see §4. |
| **Embeddings endpoint** | Base URL, model name, optional key. **No default, ever** — see below. |
| **Note-extractor model** | Provider, model id and key for the one genuinely expensive job. |

Exact variable names are a build detail.

### The embeddings endpoint

**braintrust declares no embedding model. It takes any OpenAI-compatible `/v1/embeddings` endpoint** — Ollama,
LM Studio, vLLM, OpenAI all speak it — so local versus hosted is a config line rather than a design decision,
and the embedding choice is decoupled from where braintrust runs. The endpoint simply has to be reachable from
the host.

**There is no default endpoint, and braintrust refuses to start unconfigured.** A default would mean a first
run silently shipping someone's entire published Corpus to a third party.

**Reference configuration, for the docs rather than the code:** `qwen3-embedding:0.6b` — 1024 dimensions, 32K
context, MTEB English v2 70.70. It embeds the whole Corpus in minutes and returns a query embedding fast
enough that query-time embedding costs nothing perceptible. The 4B and 8B variants are the wrong trade: Chunks
are ~300–400 tokens, so nothing in this Corpus needs the extra capacity. **Anyone running local hardware is
better off spending it on the Note extractor**, which is the only genuinely expensive job in braintrust.

**Note:** OB1 calls embeddings through `https://openrouter.ai/api/v1/embeddings`. OpenRouter's live catalogue
lists 367 models and **zero** embedding models. Whatever that call does, braintrust does not inherit the path.

### Two silent failures, closed by refusing to start

A user-supplied endpoint introduces two ways to corrupt retrieval without anything erroring. Both are checked
at startup:

1. **Embed a probe string and compare the returned length to the column's declared dimension.** Mismatch →
   refuse to serve.
2. **Compare the configured model name against the distinct `model` values in `braintrust_embeddings`.** If
   the configured model has no rows, refuse to serve queries and report that a re-embed is required.

The second matters more than it looks. A *differently-sized* model fails loudly on insert; a **same-sized,
different** model fails not at all — and cosine similarity across model families is meaningless even when the
dimensions match, so every search would return confidently-ranked nonsense. **Refusing to serve is the only
honest response**, and it is what makes swapping models safe rather than merely reversible.

## 4. Auth is OB1's, copied rather than reinvented

**A shared secret, `?key=` in the URL, exactly as OB1's extension servers do it.** OAuth was rejected — there
is one user, and OB1's own docs record clients failing *because* they attempt OAuth registration against
key-based servers.

Three details are copied deliberately, because each exists to fix a real client bug:

- **`?key=` is the documented primary, with `x-access-key` accepted as a header.** OB1's core server uses
  `x-brain-key` while extensions use `x-access-key`; braintrust is an extension, so `x-access-key` is the
  right header — but the query parameter is what gets documented, to avoid header-name confusion.
- **Auth failure returns HTTP 200 with a JSON-RPC error envelope** (`code: -32001`), not a 401. Codex CLI and
  Claude Code tear down the connection on a transport-level 4xx, so a correct 401 produces a worse user
  experience than a wrong 200.
- **The server is stateless per request** — build the server inside the handler, strip `mcp-session-id`. This
  is also what lets the web service scale or restart freely.

**Server instructions carry the full disclosure statement**, alongside the
["braintrust model of X" subject string](./mcp-surface.md#three-rules-that-hold-across-the-whole-surface) that
makes it unstrippable.

**The daily job authenticates against nothing.** It never touches the MCP surface; it talks to Postgres
directly. **So the shared secret guards the read path only.**

**Accepted cost:** the secret lives in client config files and shell history, and rotating it means
re-registering every client. At single-user scale, against a threat model where the content is already public
and the database holds no third-party secrets, that is proportionate.

## 5. A direct Postgres connection, not PostgREST

Every OB1 extension reaches the database through `supabase-js` and PostgREST with the service-role key.
**braintrust does not.**

**PostgREST cannot run a multi-statement transaction, and braintrust's central guarantee is one.**
[ADR-0001](../adr/0001-the-compiled-persona-is-disposable.md) rests on
[a Compile being promoted](./schema.md#rebuilding) — previous rows deleted, new rows made `current` — inside a
single transaction enforced by a partial unique index. Over PostgREST that has to become a stored procedure,
moving the compiler's most important step into SQL for no gain. The job's bulk inserts of Chunks and vectors
are a second, smaller reason.

**Connection shape: Supabase's session pooler (port 5432)**, not the direct host. The direct connection is
IPv6-by-default; the session pooler is IPv4 on every tier, holds persistent connections and supports prepared
statements — the right fit for a long-lived server and a long-running job. The transaction pooler (6543) is
built for the serverless case braintrust just declined.

**The house-style requirements in [`schema.md`](./schema.md#house-style-requirements) stay anyway** — the
`service_role` grants, RLS with a `service_role` policy, the idempotent `schema.sql`, the `NOTIFY pgrst`.
braintrust needs none of them for its own access; they are what makes the `braintrust_*` tables behave
correctly if the user's own OB1 tooling ever looks at them. They cost nothing and keep the composability that
section exists for.

## 6. Nothing ships on npm

**braintrust is a repo you clone, configure and deploy.** Not a package you install. There is no CLI, because
there is no CLI job left to do:

- **Following someone is already an MCP tool**, with a
  [human-only handshake](./mcp-surface.md#4-braintrust_follow_person). A `follow` CLI would be a second path
  to the same act, with the human-only guarantee re-implemented in a second place.
- **Schema install is a paste into the Supabase SQL editor**, per OB1 house style. There is no migration
  framework and nothing to run.
- **Setup is environment variables and a deploy.**

**Rejected: a thin CLI over HTTP.** Real precedent exists — OB1's own `@natebjones/ob1-agent-memory` — but it
exists to plug OB1 into a client that isn't MCP. braintrust's clients all speak MCP already.

**Rejected: publish the server itself.** That is the local-Node-server shape OB1 bans, reached by a longer
road, and it still needs a host for the daily job.

**Consequence: bootstrapping the very first Person happens through an AI client**, not a setup script — so
registration has to work against an empty database.

---

## Standing it up, in order

1. Paste [`schema.sql`](./schema.md) into the Supabase SQL editor. **Match `vector(1024)` to your embedding
   model's dimension** — it is the one value in the file a user may need to change.
2. Configure the environment (§3) for both deployments.
3. Deploy the **web service** from the repo. It refuses to start if the embeddings endpoint is unconfigured or
   mismatched.
4. Deploy the **scheduled job** from the same repo, once a day.
5. Register the MCP server with an AI client using `?key=…`, and follow the first Person through
   [`braintrust_follow_person`](./mcp-surface.md#4-braintrust_follow_person). **The first run after following
   is the backfill** — about half an hour for a prolific channel.

## Accepted costs

| Cost | Where it comes from |
|---|---|
| **braintrust no longer installs like an OB1 extension.** It needs a container host, where every other extension is a one-click Edge Function. | §1 |
| **Two deploys of one image** instead of one. | §2 |
| **The shared secret lives in client config files and shell history**, and rotating it means re-registering every client. | §4 |
| **braintrust leaves OB1's data-access path.** Direct Postgres rather than PostgREST and the service-role key. | §5 |
| **Nothing is monitored.** A persistently failing compiler is silent, and this deployment does not change that. | §2 |

## Deliberately not decided

- **Which container host.**
- **Where secrets live** — the connection string, the MCP key, the model API key.
- **Whether the web service runs more than one instance.** Correctness does not depend on it either way.
- **Anything about monitoring the job.**
- **What time of day the job runs.**

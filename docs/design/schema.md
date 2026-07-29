# braintrust's tables

**Status:** the decision. Resolves
[Design braintrust's tables alongside OB1's `thoughts`](https://github.com/cgbarlow/braintrust/issues/10).

Vocabulary is in [`CONTEXT.md`](../../CONTEXT.md). The reasoning behind the three load-bearing choices is in
[`docs/adr/`](../adr/). This document is the shape.

---

## The central idea: three tiers, and only one of them is precious

Everything braintrust stores falls into one of three tiers, and the difference between them is **what it
costs to throw away**.

| Tier | Tables | Regenerated? | If lost |
|---|---|---|---|
| **Durable** | people, sources, items | **Never** | Re-fetching means hitting the source again for every item — the one thing the [terms posture](https://github.com/cgbarlow/braintrust/issues/9) is trying to minimise |
| **Derived, expensive** | chunks, embeddings | On a model or chunking change | Recomputable from durable rows, at compute cost but with **no network traffic to the source** |
| **Derived, cheap** | compiles, layers, positions, citations, relations | **Every compile, wholly** | Recomputable from the tiers above |

The README's one hard constraint — *"Raw content and embeddings stay separate, so you can re-index on
better models without losing anything"* — is the boundary between tiers 1 and 2. The persona decision from
[#7](https://github.com/cgbarlow/braintrust/issues/7) is the boundary between 2 and 3.

**A persona cannot drift from the data because a persona has no independent existence.** Every compiled row
is owned by a compile, and a rebuild deletes the previous compile outright.

## Placement

All tables live in `public`, prefixed `braintrust_`. OB1 has zero `CREATE SCHEMA` statements anywhere and
every extension follows this pattern; a dedicated Postgres schema would need PostgREST configuration no OB1
document covers. Settled in [#6](https://github.com/cgbarlow/braintrust/issues/6), confirmed in
[`ob1-seams.md` §2.2](../research/ob1-seams.md).

**braintrust reads nothing from `public.thoughts` in v1** — see [ADR-0002](../adr/0002-no-ob1-bridge-in-v1.md).
It writes nothing to it either, which was already braintrust's own choice rather than OB1's rule.

---

## Tier 1 — durable

```sql
create table braintrust_people (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  display_name  text not null,
  created_at    timestamptz not null default now()
);
```

A person is not a source. Following someone means their Substack *and* their YouTube channel, and the
person outlives either handle.

```sql
create table braintrust_sources (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null references braintrust_people(id) on delete cascade,
  platform             text not null check (platform in ('substack', 'youtube')),
  handle               text not null,        -- publication host, or channel id
  discovery_url        text not null,        -- the RSS/Atom feed; discovery is generic across platforms
  cursor_published_at  timestamptz,          -- newest publish date seen; "new since last check"
  backfill_floor       date not null,        -- how far back backfill reaches (12 months)
  backfill_complete    boolean not null default false,
  last_checked_at      timestamptz,
  blocked_at           timestamptz,          -- set when the source refuses braintrust
  created_at           timestamptz not null default now(),
  unique (person_id, platform, handle)
);
```

**The cursor is columns on the source, not a table.** There is exactly one cursor per source and it has no
history worth keeping — a table would be a table of one row per source forever.

`blocked_at` exists because the terms posture says *a block is an answer, not an obstacle*. The behaviour
is still unspecified (it sits in the map's **Not yet specified**), but the column is where the fact lands.

```sql
create table braintrust_items (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references braintrust_sources(id) on delete cascade,
  external_id   text not null,        -- substack post id, or yt:videoId
  url           text not null,
  title         text,
  published_at  date,
  audience      text not null default 'unknown'
                  check (audience in ('everyone', 'paid', 'unknown')),
  retrieval     text not null default 'pending'
                  check (retrieval in ('pending', 'retrieved', 'skipped_paywall', 'failed')),
  body_text     text,                 -- null until retrieved; null forever if skipped
  body_raw      jsonb,                -- caption events, feed entry — whatever the platform actually gave
  retrieved_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (source_id, external_id)
);

create index on braintrust_items (source_id, published_at desc);
create index on braintrust_items (retrieval);
```

Four things this shape is deliberately doing:

- **`unique (source_id, external_id)` is the whole identity story.** Both platforms assign a real primary
  key. No fingerprinting, no content hashing — which is where OB1 had to go, because a thought has no
  external identity.
- **`body_text` is nullable and that is the normal state.** Discovery returns metadata without a body on
  both platforms; retrieval is a separate step. For 93% of Substack items the body never arrives at all.
- **`published_at` is nullable but load-bearing.** It costs a third fetch per item on YouTube (the watch
  page, ~1.3MB). Without it there are no held-then-revised positions at all, so an undated item is a
  degraded item rather than a normal one.
- **`retrieval = 'skipped_paywall'` is a row, not an absence.** `audience` is known before fetching, so
  braintrust records exactly what it declined to read. This is what lets a persona state its own blind
  spots instead of silently having them.

**No separate transcript-segment table.** `body_raw` holds the caption events as the platform gave them;
timestamps reach a citation via chunks. A segments table would be a third copy of the same text.

## Tier 2 — derived, expensive

```sql
create table braintrust_chunks (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references braintrust_items(id) on delete cascade,
  ordinal     int not null,
  text        text not null,
  char_start  int not null,
  char_end    int not null,
  start_ms    int,                    -- transcripts only
  end_ms      int,
  unique (item_id, ordinal)
);

create table braintrust_embeddings (
  chunk_id    uuid not null references braintrust_chunks(id) on delete cascade,
  model       text not null,
  embedding   vector(1536) not null,
  created_at  timestamptz not null default now(),
  primary key (chunk_id, model)
);

create index on braintrust_embeddings using hnsw (embedding vector_cosine_ops);

create table braintrust_item_notes (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references braintrust_items(id) on delete cascade,
  extractor    text not null,          -- model id + prompt version
  claims       jsonb not null,         -- [{ statement, quote, chunk_id, start_ms }]
  argument_md  text,
  assumptions  jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  unique (item_id, extractor)
);
```

`start_ms` is what makes a claim citable to a moment inside a twenty-minute video rather than to the video.

**Chunking must live here, not in `thoughts`.** OB1 shipped a chunking model and deliberately rolled it
back — *"the active community pattern is truncation + fingerprinting, not chunking"*. One `thoughts` row is
one embedding, which is useless for passage retrieval over a 4,000-word essay.

**`model` in the primary key is the re-indexing story.** A better model is a new set of rows, not a
migration — old and new coexist while you compare them, and chunks and items are never touched. braintrust
also never compares its own vectors to `thoughts.embedding`: OB1 users run 768- and 1024-dimension models
locally, and cosine similarity across model families is meaningless.

**Honest limit:** pgvector needs fixed dimensions to build an index, so `vector(1536)` is declared for v1's
model. Moving to a differently-sized model means altering *this table only*. That is exactly the property
the README asks for — nothing is lost, because nothing here is original.

Chunk sizing is a compiler concern rather than a schema one: target ~1,000–1,500 characters on caption-event
or sentence boundaries, never spanning items. Re-chunking drops tier 2 and rebuilds it.

**`braintrust_item_notes` is why regeneration stays affordable.** Published items are immutable, so the
compiler reads each item once, writes a note, and every subsequent compile reads notes instead of ~1.17M
words of transcript. The note is tier 2 for the same reason embeddings are: expensive to produce, but
recomputable with no network traffic, so losing it costs compute rather than a re-fetch the terms posture
exists to avoid.

**`extractor` in the unique key is the note equivalent of `model` above.** Improving the note-taking prompt
writes a new generation alongside the old one and a compile declares which it reads, so a prompt upgrade is
a resumable re-read of ~395 items rather than a migration.

Note that the compiler reads a **whole item** when writing a note. Chunk boundaries serve retrieval only and
are not constrained by what the compiler needs in order to follow an argument.

## Tier 3 — derived, cheap

```sql
create table braintrust_compiles (
  id                uuid primary key default gen_random_uuid(),
  person_id         uuid not null references braintrust_people(id) on delete cascade,
  compiler_version  text not null,
  status            text not null default 'running'
                      check (status in ('running', 'current', 'failed', 'rejected')),
  rejected_reason   text,
  corpus_stats      jsonb not null default '{}'::jsonb,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create unique index on braintrust_compiles (person_id) where status = 'current';
create unique index on braintrust_compiles (person_id) where status = 'running';
```

**Those partial unique indexes are the whole regeneration mechanism.** At most one current compile per
person and at most one running compile per person, enforced by the database rather than by the compiler
remembering to.

The second index is what makes `braintrust_refresh_persona` safe to leave ungated. Two clients calling it
seconds apart — or one calling it as the daily job starts — cannot produce two rebuilds; the second insert
fails and the caller is told when the running one started. Double-spend is structurally impossible rather
than politely avoided.

```sql
create table braintrust_persona_layers (
  id              uuid primary key default gen_random_uuid(),
  compile_id      uuid not null references braintrust_compiles(id) on delete cascade,
  layer           text not null check (layer in ('voice', 'reasoning', 'beliefs', 'coverage')),
  basis           text not null check (basis in ('measured', 'inferred')),
  descriptive_md  text not null,
  generative_md   text,             -- voice only
  evidence        jsonb not null default '{}'::jsonb,
  unique (compile_id, layer)
);
```

The four core layers. `basis` is `measured` for voice and coverage, `inferred` for reasoning and beliefs,
and it has to survive to the MCP boundary — a persona must never present a synthesis as a finding.

**`generative_md` sits in the same row as `descriptive_md` on purpose.** They are written by one compile
step from one set of measurements, so there is no path by which the instruction and the evidence for it can
disagree. Two rows, or two tables, would make "keep them in sync" a rule someone has to remember. This
matters because the failure already happened: the [first prototype](../prototypes/PROTOTYPE-compiled-persona-page.md)
asserted "no hedging" from four Substack openings, and measurement later found hedging in 32 of 34
transcripts.

```sql
create table braintrust_positions (
  id          uuid primary key default gen_random_uuid(),
  compile_id  uuid not null references braintrust_compiles(id) on delete cascade,
  slug        text not null,
  statement   text not null,
  held_since  date,
  basis       text not null default 'measured' check (basis in ('measured', 'inferred')),
  confidence  text not null check (confidence in ('high', 'moderate', 'low')),
  item_count  int not null,
  unique (compile_id, slug)
);

create table braintrust_position_citations (
  id           uuid primary key default gen_random_uuid(),
  position_id  uuid not null references braintrust_positions(id) on delete cascade,
  item_id      uuid not null references braintrust_items(id),
  start_ms     int,
  quote        text not null
);

create table braintrust_position_relations (
  id                uuid primary key default gen_random_uuid(),
  compile_id        uuid not null references braintrust_compiles(id) on delete cascade,
  from_position_id  uuid not null references braintrust_positions(id) on delete cascade,
  to_position_id    uuid not null references braintrust_positions(id) on delete cascade,
  relation          text not null check (relation in ('revised', 'unsettled', 'drifting')),
  gap_days          int,
  rationale         text
);
```

**`held_since` is recomputed every compile**, which is what makes it honest: a backfill that finds older
evidence moves it earlier, and no stale value survives to contradict the corpus.

**`item_count` is the denominator.** A confidence grade with nothing behind it reads cleaner and tells you
less; a position resting on one video should say so.

**Relation direction: `from` is the earlier position, `to` the later, and `relation` describes what the
later does to the earlier.** Both states are rows — the point of the whole design is that a superseded
position is retained rather than resolved away. The read path lists as *current* any position that is not
the `from` side of a `revised` relation; `unsettled` and `drifting` leave both sides current.

**This is OB1's `thought_edges` shape minus its validity intervals.** OB1 carries `valid_from`/`valid_until`
on every edge — and then never reads the edges when generating pages. braintrust drops the intervals
because a compile is already a point-in-time snapshot, so they would record the same fact twice, and it
reads the relations, because that is the product.

**Coverage needs no table.** It is a query over tier 1 — items by `retrieval` status, date range, word
counts — written into the coverage layer's `evidence` at compile time.

---

## Rebuilding

```
begin;
  insert into braintrust_compiles (person_id, status) values ($1, 'running') returning id;
  -- write layers, positions, citations, relations against that compile_id
  -- run the gate against $new; on failure, set status = 'rejected' with a reason and commit here
  delete from braintrust_compiles where person_id = $1 and status = 'current';
  update braintrust_compiles set status = 'current', finished_at = now() where id = $new;
commit;
```

Four properties worth naming:

- **A failed compile changes nothing.** The old current compile is only deleted once the new one is
  written, inside one transaction.
- **A compile must pass the gate to be promoted.** Structural checks only — all four core layers present
  and non-empty, voice carrying both forms, inferred layers carrying their marker, coverage reconciling
  against `braintrust_items`, every position resolving to a real citation, and position count not
  collapsing against the previous compile. A rejected compile keeps its rows for inspection and leaves the
  previous persona live. This is what `lint` becomes in a regenerate model.
- **`on delete cascade` does all the cleanup.** Deleting the old compile row removes its layers, positions,
  citations and relations. There is no reconciliation step and nothing to leak.
- **Regeneration is affordable only while the core stays bounded.** Voice, reasoning, beliefs and coverage
  converge as the corpus grows; positions grow. If the core ever grows with the corpus, full regeneration
  stops being cheap and the no-drift guarantee goes with it.

## The backlog needs no table

Four things want to be long-running jobs — the first 12-month backfill, catching up after braintrust has
fallen behind a feed window, re-reading the corpus when the note prompt improves, and routine daily
retrieval. They are one job, and its queue is already here as state:

| Work | The row that asks for it |
|---|---|
| Fetch a body | `braintrust_items.retrieval = 'pending'` |
| Write a note | an item with no `braintrust_item_notes` row for the current `extractor` |
| Walk the archive | `braintrust_sources.backfill_complete = false` |

**Because the backlog is rows rather than a queue, every long job is resumable by construction.** A run
killed at minute 12 of 26 has written twelve minutes of real rows and the next run continues. No job table,
no checkpointing.

**`retrieval = 'failed'` is deliberately not in the backlog.** It is a terminal outcome that coverage
reports, not a pending item — otherwise one permanently unfetchable video would block every future compile.

**Falling behind a feed window is detected and repaired with no new columns.** If the oldest entry in a
feed is newer than `cursor_published_at`, something published in between was never seen; the repair is to
set `backfill_complete = false` and let the same archive walk that does the initial load close the gap.
That flag is simultaneously what coverage reads, so between noticing a gap and closing it the persona
states its corpus is incomplete. This matters because coverage counts rows: items braintrust never saw are
not missing rows, they are no rows at all, so an undetected gap would make a **measured** layer confidently
claim a complete corpus.

**A compile waits for an empty backlog.** Most visibly on a note-prompt upgrade: a compile fired halfway
through a ~395-item re-read would be a persona built from a quarter of the corpus. Waiting keeps the
previous persona live for the duration.

## House-style requirements

Not optional if braintrust is to compose cleanly with a user's OB1:

- `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.braintrust_* TO service_role;` — Supabase no longer
  auto-grants this, and OB1 makes it mandatory for anything creating tables.
- RLS enabled on every table with a `service_role` policy, matching OB1's own sidecars.
- One idempotent `schema.sql` — `CREATE TABLE IF NOT EXISTS` throughout. OB1 has no migration framework;
  the user pastes the file into the Supabase SQL editor.
- `NOTIFY pgrst, 'reload schema';` at the end.

**braintrust itself uses none of this, and the requirements stay anyway.** It connects to Postgres
directly, over Supabase's session pooler, rather than through PostgREST with the service-role key the way
every other OB1 extension does — because promoting a compile is a multi-statement transaction and PostgREST
has none. Over PostgREST that promotion would have to become a stored procedure, moving the compiler's most
important step into SQL for no gain.

So the grants, the RLS policies and the schema reload are there for the *user's* tooling, not braintrust's:
they are what makes the `braintrust_*` tables behave correctly if a supabase-js client ever looks at them.
They cost nothing and keep the composability this section exists for.

## Deliberately not modelled in v1

- **Persona history.** No archive of previous compiles. Keeping them would be drift tracking, which is out
  of scope, and it reintroduces exactly the stale conclusions that rebuilding is meant to eliminate.
- **Cross-source idea matching.** A video and a post covering the same subject on the same day are two
  items. A position may cite both; nothing tries to merge them.
- **`first_seen`.** No record of when braintrust first noticed a position. It has nowhere to live that
  survives a rebuild, and it describes braintrust rather than the person.
- **Entities.** No people, companies or topics extracted as rows. v1 models one person's thinking; an
  entity graph is a different product competing for the same compile budget.
- **Human annotation of a persona.** Follows from rebuilding — a hand-edit would not survive. Corrections
  belong in the compiler, not its output.
- **A verbatim-reproduction cap.** `quote` is uncapped at the schema level. Declined for v1, and flagged in
  the terms posture as the limit carrying the largest exposure; the mechanism would live at the
  [MCP tool surface](https://github.com/cgbarlow/braintrust/issues/11) rather than here.

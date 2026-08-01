# braintrust's tables

**Status:** the decision. Resolves
[Design braintrust's tables alongside OB1's `thoughts`](https://github.com/cgbarlow/braintrust/issues/10).

Vocabulary is in [`CONTEXT.md`](../../CONTEXT.md). The reasoning behind the three load-bearing choices is in
[`docs/adr/`](../adr/). This document is the shape.

**The DDL below is what `schema.sql` contains today.** What
[the Bluesky and personal-blogs map](https://github.com/cgbarlow/braintrust/issues/52) adds is specified
separately, in [What the new Sources add](#what-the-new-sources-add), as the `alter` statements that get it —
because braintrust has no migration framework and a user applies `schema.sql` by hand, so a document that
merged the two would leave nobody able to tell what is deployed from what is specified.

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
  paused_at     timestamptz,          -- set by unfollow; the daily job skips these people
  created_at    timestamptz not null default now()
);
```

A person is not a source. Following someone means their Substack *and* their YouTube channel, and the
person outlives either handle.

**`display_name` is confirmed by a human, not derived.** Both feeds carry a name and they disagree — the
Substack feed says *"Nate's Substack"*, the YouTube feed says *"AI News & Strategy Daily | Nate B Jones"* —
so registration proposes one and asks. This value becomes `"braintrust model of X"`, the string that carries
the disclosure everywhere it travels, which is not a thing to guess at.

**`paused_at` means the user stopped following.** Nothing is deleted: tier 1 is durable precisely so that
changing your mind does not cost a second crawl, and the persona stays queryable, frozen at its last
compile. Re-following clears it. It is deliberately **not** the same fact as `braintrust_sources.blocked_at`
below — one is the user's choice, the other is the source refusing braintrust.

```sql
create table braintrust_sources (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null references braintrust_people(id) on delete cascade,
  platform             text not null check (platform in ('substack', 'youtube', 'blog')),
  handle               text not null,        -- publication host, or channel id
  discovery_url        text not null,        -- the RSS/Atom feed, or a blog's sitemap where it has none
  cursor_published_at  timestamptz,          -- newest publish date seen; "new since last check"
  backfill_floor       date not null,        -- how far back backfill reaches (12 months by default)
  backfill_complete    boolean not null default false,
  exclude_shorts       boolean not null default true,
  poll_interval_hours  integer not null default 24,
  last_checked_at      timestamptz,
  blocked_at           timestamptz,          -- set when the source refuses braintrust
  created_at           timestamptz not null default now(),
  unique (person_id, platform, handle)
);
```

**The cursor is columns on the source, not a table.** There is exactly one cursor per source and it has no
history worth keeping — a table would be a table of one row per source forever.

**`platform` and `discovery_url` are both widened by the new Sources** — two more values, and a `discovery_url`
that may be a sitemap where a blog publishes no feed. See [What the new Sources add](#what-the-new-sources-add).

**braintrust's defaults live in the DDL, and a human may override them per source.** `backfill_floor`,
`exclude_shorts` and `poll_interval_hours` are the three settings registration exposes; omitting them takes
the default, so the ordinary path asks for nothing. Keeping the defaults as column defaults means "what
braintrust does if you say nothing" is readable in one place rather than buried in the compiler.

**`poll_interval_hours` does not create a second scheduler.** There is still one daily job; the interval
only decides whether a source is *due* when it runs.

**The paywall behaviour is deliberately not among them.** *Never ingest anything where `audience` is not
`everyone`* is a hard line rather than a default, so it gets no column. Note this is enforced as an
**allow-list**: live Substack values include `only_paid`, `founding` and `everyone`, and a deny-list would
silently ingest the next tier Substack invents.

`blocked_at` exists because the terms posture says *a block is an answer, not an obstacle*, and it is set
when a source stops serving braintrust — **measured as consecutive failures across distinct items, never
inferred from a response code.** A single failure is already `retrieval = 'failed'`; a captcha arrives as a
200 with HTML in it, so classifying one response is a guess where counting many is a measurement.

Setting it stops the crawl **for that source only** — the two sources share nothing but a person — and
**suppresses that source's backlog** (see below), which is what keeps a source that can never finish its
backfill out of a permanent repair loop. The next daily run sends one ordinary request, unchanged; success
clears `blocked_at`. That is self-healing rather than evasion, which would mean changing *how* braintrust
asks — and it crawls from one address with nothing to rotate.

It is deliberately **not** the same fact as `braintrust_people.paused_at`: one is the source refusing
braintrust, the other is the user choosing to stop.

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
                  check (retrieval in ('pending', 'retrieved', 'skipped_paywall',
                                       'skipped_short', 'skipped_window',
                                       'skipped_not_a_post', 'failed')),
  body_text     text,                 -- null until retrieved; null forever if skipped
  body_raw      jsonb,                -- caption events, feed entry — whatever the platform actually gave
  lastmod       timestamptz,          -- the sitemap's, at the moment braintrust decided. never a publish date
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
- **`published_at` is nullable but load-bearing.** It costs a second call per item on YouTube — measured at
  ~15KB against the player endpoint, where the watch page it was specced as would have been ~1.3MB. Without
  it there are no held-then-revised positions at all, so an undated item is a degraded item rather than a
  normal one. The channel listing's own "3 months ago" is deliberately **not** written here: an approximate
  date stored as if measured would poison every position built on it.
- **A skip is a row, not an absence.** `audience` is known before fetching, so braintrust records exactly
  what it declined to read, which is what lets a persona state its own blind spots instead of silently
  having them. The line the vocabulary draws is **whose decision it was**: `failed` means the source
  declined or could not answer, and everything braintrust *decided* is `skipped_<reason>` — a row of its
  own, carrying what would have to change, reopened when it changes. `skipped_paywall` is a source's
  decision braintrust is respecting and nothing undoes it; `skipped_short` is undone by turning
  `exclude_shorts` off; `skipped_window` is undone by widening `window_months`;
  [`skipped_not_a_post`](#what-the-new-sources-add) is undone by the page's `<lastmod>` moving. All three
  reopen without a second crawl, and they exist so a setting stays a setting rather than becoming a one-way
  door — and so that a reader is told which of them was braintrust's own policy and which was the source's.

**No separate transcript-segment table.** `body_raw` holds the caption lines with one start time each, so a
citation can name a moment rather than gesture at a 20-minute video; timestamps reach a citation via chunks.
A segments table would be a third copy of the same text. The per-*word* offsets YouTube also sends are
dropped: keeping them would be ~344KB per video against ~40KB, and no citation is finer than a line.

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
  embedding   vector(1024) not null,   -- must match the configured endpoint; verified at startup
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

**braintrust declares no embedding model.** It calls whatever OpenAI-compatible `/v1/embeddings` endpoint it
is configured with — Ollama, LM Studio, vLLM, OpenAI — so local versus hosted is a config line rather than a
design decision. **There is no default endpoint:** braintrust refuses to start unconfigured, because a
default would mean a first run silently shipping an entire corpus to a third party. The reference
configuration in the docs is `qwen3-embedding:0.6b` at 1024 dimensions.

**Honest limit:** pgvector needs fixed dimensions to build an index, so the column is typed once.
`vector(1024)` matches the reference model, and **this is the one value in `schema.sql` a user must change**
if they point braintrust at a differently-sized model — the same pattern OB1 documents for its own Ollama
users. Moving to a differently-sized model means altering *this table only*. That is exactly the property
the README asks for — nothing is lost, because nothing here is original.

**Two startup checks, because both failures are otherwise silent.** braintrust embeds a probe string and
compares its length to the declared dimension; and it checks the configured model has rows here at all. The
second matters more than it looks: a *differently-sized* model fails loudly on insert, but a **same-sized,
different model** fails not at all — cosine similarity across model families is meaningless even when the
dimensions match, so every search would return confidently-ranked nonsense. Refusing to serve is the only
honest response.

Chunk sizing: ~1,000–1,500 characters, overlapping by at least one whole unit, never spanning items.
**Boundaries are the platform's, never a model's** — caption events for transcripts, paragraphs for prose.
`char_start` and `char_end` are offsets into `braintrust_items.body_text` and `text` is exactly what is at
them, which is what makes a quote checkable against the stored body rather than against the chunker. A model pass to
restore punctuation was rejected outright: `text` here is what a citation's `quote` is drawn from, so a
punctuated chunk would make every quote a rendering of what someone said rather than what they said.
Accepted cost: passages read like unpunctuated speech, because that is what they are. Re-chunking drops
tier 2 and rebuilds it, for about three cents.

**Claim vectors are not stored.** Revision detection embeds ~2,000 claim statements during a compile to find
similarity neighbourhoods, then discards them — ~80K tokens, so persisting them would buy nothing and cost
either a polymorphic key here or promoting `braintrust_item_notes.claims` into rows of its own.

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
  held_until  date,
  days_spanned int,
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

## What the new Sources add

Specified by [the Bluesky and personal-blogs map](https://github.com/cgbarlow/braintrust/issues/52). **Not yet
in `schema.sql`** — each arrives with the build ticket that first needs it, and each is written the way
everything else here is written: `if not exists`, and a constraint dropped and restated rather than altered,
because `create table if not exists` leaves an existing table alone and a user's already-deployed database has
to be able to accept a value added later.

**Idempotent means idempotent against a database that already exists**, which is the only kind anybody
re-pastes this file into — and that is not what "it runs twice cleanly" tests. A real paste into a real
database failed on two counts at once, both invisible against a fresh one, where `create table if not exists`
does the whole job and every `alter` is a no-op:

- **A `comment on` a column runs *after* the alter that adds it, never before.** A comment on a column that is
  not there yet is a hard `42703` rather than a skipped notice, so the file died partway through on every
  deployed database and none at all in testing.
- **Every column added after a table first shipped needs an `alter`, even though it also appears in the
  `create table`.** Two Position columns had none — they reached fresh databases through the create and a
  deployed one never, which is the quieter failure: the paste appears to succeed and a compile fails later on
  a column that is simply absent.

Both are now covered by a test that reconstructs the old shape — drops every column added since, narrows both
check constraints back — and re-applies the file, which is exactly what a human does.

```sql
-- Both landed in schema.sql, one build at a time; the alter is what a database that
-- already exists needs, and re-running a drop-and-restate is a no-op.
alter table braintrust_sources drop constraint if exists braintrust_sources_platform_check;
alter table braintrust_sources add constraint braintrust_sources_platform_check
  check (platform in ('substack', 'youtube', 'blog', 'bluesky'));

-- Where a citation points when the item is a batch of separately-published things. A
-- bluesky item is a whole UTC day; the day records each post's character span, and a
-- verified quote resolves to the post it fell inside. The same question start_ms answers
-- for a transcript, in the unit the other batched form has. Landed with the Bluesky build.
alter table braintrust_position_citations add column if not exists post_url text;
alter table braintrust_position_citations add column if not exists posted_at timestamptz;

-- One more skip, and it is braintrust's own decision like the other two policy skips.
-- Landed in schema.sql with the archive walk; the alter is what a database that already
-- exists needs.
alter table braintrust_items drop constraint if exists braintrust_items_retrieval_check;
alter table braintrust_items add constraint braintrust_items_retrieval_check
  check (retrieval in ('pending', 'retrieved', 'skipped_paywall', 'skipped_short',
                       'skipped_window', 'skipped_not_a_post', 'failed'));

-- The sitemap's <lastmod> as it stood when braintrust decided this URL was not a post.
-- Never a publish date: it is a modification date, and misdating an item makes
-- revisions point backwards. Its one honest use is "this URL changed", which is
-- exactly what reopens a skipped_not_a_post row. Landed with the same walk.
alter table braintrust_items add column if not exists lastmod timestamptz;

-- Provenance only. /members/api/site/ answers unauthenticated with an exact Ghost
-- version; it earns a line a human can read on a persona's basis and changes nothing
-- about the ingest path, because braintrust does not branch on Ghost.
alter table braintrust_sources add column if not exists generator text;

-- A position reports its span, not only its beginning. Derived from the citations at
-- every compile exactly as held_since is, so nothing here is carried forward. Landed in
-- schema.sql as well; the alter is what a database that already exists needs.
alter table braintrust_positions add column if not exists held_until date;
alter table braintrust_positions add column if not exists days_spanned int;
```

**`external_id` needs no column and no change**, which is the point of it. A Bluesky Item is a closed UTC day,
and its id is `<did>:<YYYY-MM-DD>` — deterministic, derived from data both the backfill and the daily poll
already hold, so they reach the same day, compute the same key, and `unique (source_id, external_id)` makes
them write **one row**. The same property Substack gets from its slug and YouTube from its video id, obtained
here by construction rather than by luck. The `did` rather than the handle, because Bluesky handles are
rebindable domains and a person who changes theirs must not acquire a second copy of their own archive. A blog
post's id is its URL.

**`discovery_url` stays one column and stays a feed.** For a blog it is the feed the homepage *declares* —
`<link rel="alternate">`, never a guessed path, which was measured wrong on three of four blogs. For a blog
that genuinely publishes no feed, the **sitemap becomes the discovery URL**: every URL carries `<lastmod>`,
the document is ordered newest-first by it, and a walk that stops at the first unchanged URL is precisely what
reading a feed does. See [`ingestion.md` §8](./ingestion.md#8-blogs-any-feed-best-effort).

**`body_raw` absorbs what each new platform actually gives**, with no new column: the day's posts with their
character spans for Bluesky — which is what lets a citation resolve to the individual post rather than to the
day — and the feed entry for a blog. Same reason there is no transcript-segment table.

**The resolved answer does need two columns, and they sit beside `start_ms` because they are the same
question.** *Where inside this Item are these words* is answered in milliseconds by a transcript and by a
permalink by a batched day; both are read off the rows once the quote has been located, in the read-once pass,
and neither is ever asked of a model. Resolving at serve time was the alternative and was rejected: it would
re-derive a settled fact from whatever the body looks like at query time, and put the extractor's
quote-locating into the request path of every question.

**`handle` on a Bluesky Source is the DID, never the handle Bluesky calls a handle.** Bluesky handles are
rebindable domains, and `unique (person_id, platform, handle)` is what stops one person becoming two — so the
column holds the thing that cannot be re-pointed, exactly as it holds `UC…` rather than `@name` for YouTube.

**Nothing here is a new table.** Coverage's `by_form` is computed from Items at compile time and written into
the layer's `evidence`, exactly as `by_source` already is, so the mixed-corpus reporting costs no schema at
all.

---

## Rebuilding

```
insert into braintrust_compiles (person_id, status) values ($1, 'running') returning id;   -- committed
-- write layers, positions, citations, relations against that compile_id
-- run the gate against $new; on failure, set status = 'rejected' with a reason and stop here

begin;
  delete from braintrust_compiles where person_id = $1 and status = 'current';
  update braintrust_compiles set status = 'current', finished_at = now()
    where id = $new and status = 'running';   -- no row here means it was taken over; roll back
commit;
```

**The `running` row is committed on its own, and only the promotion is a transaction.** One transaction around
the whole compile would hold a connection open across minutes of model calls, and would make the `running`
partial unique index invisible to everyone else — which is the one thing it exists for. A `running` compile
older than six hours has no process behind it and is recorded as `failed` by the next run, so a crash costs a
day rather than a persona.

Four properties worth naming:

- **A failed compile changes nothing.** The old current compile is only deleted inside the transaction that
  promotes its replacement, so there is no instant where a client can observe neither.
- **A compile must pass the gate to be promoted.** Structural checks only — all four core layers present
  and non-empty, voice carrying both forms, inferred layers carrying their marker, coverage reconciling
  against `braintrust_items`, every position resolving to a real citation, and position count not
  collapsing against the previous compile. A rejected compile keeps its rows for inspection and leaves the
  previous persona live. This is what `lint` becomes in a regenerate model. *Non-empty* for an inferred
  layer means its `evidence.entries` is non-empty, not that it has prose: a synthesis that found nothing
  writes a marker and a sentence saying so, and a check on prose would pass it.
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

**A blocked source is not in the backlog either, and that is the whole repair-loop fix.** `blocked_at`
suppresses all three row-states for that source, for exactly the reason `retrieval = 'failed'` is excluded
below — a terminal recorded outcome is not a pending item. `backfill_complete` stays `false`, because the
corpus genuinely *is* incomplete and that remains true whatever the reason; it simply stops asking for work.
**The flag keeps telling the truth and only stops generating requests**, which is how one column goes on
serving as both the repair trigger and the honesty flag without a source that can never finish its backfill
re-crawling forever. A compile still runs, on what braintrust actually has — freezing the persona instead
would hand a platform a veto over whether braintrust works at all.

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

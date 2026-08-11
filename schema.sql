-- braintrust — schema.sql
--
-- Paste this whole file into your Supabase SQL editor. It is idempotent:
-- running it again changes nothing. OB1 has no migration framework and
-- braintrust does not add one.
--
-- The shape and the reasoning are in docs/design/schema.md; the vocabulary is
-- in CONTEXT.md. Three tiers, separated by what it costs to throw each away:
--
--   Tier 1  durable            people, sources, items          never regenerated
--   Tier 2  derived, expensive chunks, embeddings, item notes   on a model change
--   Tier 3  derived, cheap     compiles, layers, positions, …   every compile
--
-- ONE VALUE YOU MAY NEED TO CHANGE. braintrust_embeddings.embedding is
-- vector(1024), which matches the reference model in docs/design/deployment.md
-- (qwen3-embedding:0.6b). pgvector needs a fixed dimension to build an index,
-- so if your embeddings endpoint returns a different number, change it here
-- before running. Getting it wrong stops the server rather than quietly
-- poisoning the index.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Tier 1 — durable
--
-- Never regenerated. Losing these means hitting the source again for every
-- item, which is the one thing the terms posture exists to minimise.
-- ---------------------------------------------------------------------------

create table if not exists braintrust_people (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  display_name  text not null,
  paused_at     timestamptz,          -- set by unfollow; the daily job skips these people
  created_at    timestamptz not null default now()
);

comment on column braintrust_people.display_name is
  'Confirmed by a human, never derived — both feeds carry a name and they disagree. '
  'This becomes "braintrust model of X", the string that carries the disclosure.';

comment on column braintrust_people.paused_at is
  'The user chose to stop. Not the same fact as braintrust_sources.blocked_at.';

create table if not exists braintrust_sources (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null references braintrust_people(id) on delete cascade,
  platform             text not null check (platform in ('substack', 'youtube', 'blog', 'bluesky')),
  handle               text not null,        -- publication host, channel id, or DID
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

-- `create table if not exists` leaves an existing table alone, so a database created
-- before a platform existed would reject the value. Same drop-and-restate as the
-- retrieval check below, and idempotent for the same reason.
alter table braintrust_sources drop constraint if exists braintrust_sources_platform_check;
alter table braintrust_sources add constraint braintrust_sources_platform_check
  check (platform in ('substack', 'youtube', 'blog', 'bluesky'));

comment on column braintrust_sources.handle is
  'Whatever cannot be two people on that platform. A publication host, a UC… channel id, '
  'a blog hostname — and on Bluesky the DID, never the handle, because Bluesky handles are '
  'rebindable domains and somebody who changes theirs must not acquire a second copy of '
  'their own archive.';

comment on column braintrust_sources.blocked_at is
  'The source refused braintrust — measured as consecutive failures across distinct '
  'items, never inferred from a response code. Suppresses this source''s backlog.';

comment on column braintrust_sources.poll_interval_hours is
  'Does not create a second scheduler. One daily job; this decides whether a source is due.';

create table if not exists braintrust_items (
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

comment on column braintrust_items.audience is
  'Known before fetching. Enforced as an allow-list: anything not exactly '
  '''everyone'' is paid, because live Substack values include only_paid and founding.';

comment on column braintrust_items.retrieval is
  'failed means the source declined or could not answer. Everything braintrust decided is '
  'skipped_<reason> — a row of its own carrying what would have to change, reopened when it '
  'changes. skipped_paywall is a row rather than an absence so a persona can state its own '
  'blind spots; skipped_short is undone by turning exclude_shorts off; skipped_window is '
  'undone by widening window_months, which is what makes the backfill window a setting '
  'rather than a one-way door; skipped_not_a_post is undone by the sitemap''s lastmod moving.';

-- `create table if not exists` leaves an existing table alone, so a database created
-- before skipped_short existed would reject the value. Re-stating the constraint is
-- the one honest way to add a value without a migration framework, and it is
-- idempotent: running it twice lands in the same place.
alter table braintrust_items drop constraint if exists braintrust_items_retrieval_check;
alter table braintrust_items add constraint braintrust_items_retrieval_check
  check (retrieval in ('pending', 'retrieved', 'skipped_paywall', 'skipped_short',
                       'skipped_window', 'skipped_not_a_post', 'failed'));

-- And the column that state's reopen trigger reads, for the same reason.
--
-- **The alter comes before the comment, and that ordering is load-bearing.** A comment
-- on a column an already-deployed database does not have yet is a hard error, so a file
-- that commented first would only be idempotent against the fresh databases that never
-- needed the alter in the first place. Found by a real paste into a real database.
alter table braintrust_items add column if not exists lastmod timestamptz;

comment on column braintrust_items.lastmod is
  'The sitemap''s <lastmod> as it stood when braintrust decided this URL was not a post. '
  'Never read as a publish date — it is a modification date, and misdating an item makes '
  'revisions point backwards. Its one honest use is "this URL changed", which is exactly '
  'the question of whether a stub has become a post.';

create index if not exists braintrust_items_source_published_idx
  on braintrust_items (source_id, published_at desc);

create index if not exists braintrust_items_retrieval_idx
  on braintrust_items (retrieval);

-- ---------------------------------------------------------------------------
-- Tier 2 — derived, expensive
--
-- Recomputable from tier 1 at compute cost, with no network traffic to the
-- source. Losing these costs money and time, never a re-fetch.
-- ---------------------------------------------------------------------------

create table if not exists braintrust_chunks (
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

comment on column braintrust_chunks.text is
  'What a citation''s quote is drawn from. Boundaries are the platform''s, never a '
  'model''s — a punctuated chunk would make every quote a rendering of what was said.';

create table if not exists braintrust_embeddings (
  chunk_id    uuid not null references braintrust_chunks(id) on delete cascade,
  model       text not null,
  embedding   vector(1024) not null,   -- must match the configured endpoint; verified at startup
  created_at  timestamptz not null default now(),
  primary key (chunk_id, model)
);

comment on column braintrust_embeddings.model is
  'In the primary key on purpose: a better model is a new set of rows, not a migration.';

create index if not exists braintrust_embeddings_hnsw_idx
  on braintrust_embeddings using hnsw (embedding vector_cosine_ops);

create table if not exists braintrust_item_notes (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references braintrust_items(id) on delete cascade,
  extractor    text not null,          -- model id + prompt version
  claims       jsonb not null,         -- [{ statement, quote, chunk_id, start_ms }]
  argument_md  text,
  assumptions  jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  unique (item_id, extractor)
);

comment on table braintrust_item_notes is
  'What braintrust wrote down the one time it read an item. Published items are '
  'immutable, so every later compile reads notes rather than 1.17M words of transcript.';

-- ---------------------------------------------------------------------------
-- Tier 3 — derived, cheap
--
-- Rebuilt wholly on every compile. A persona cannot drift from its evidence
-- because it has no independent existence.
-- ---------------------------------------------------------------------------

create table if not exists braintrust_compiles (
  id                uuid primary key default gen_random_uuid(),
  person_id         uuid not null references braintrust_people(id) on delete cascade,
  compiler_version  text not null,
  extractor         text,                 -- which generation of notes this compile read
  status            text not null default 'running'
                      check (status in ('running', 'current', 'failed', 'rejected')),
  rejected_reason   text,
  corpus_stats      jsonb not null default '{}'::jsonb,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);

-- `create table if not exists` leaves an existing table alone, so a database created
-- before this column existed would not have it. Two generations of notes coexist
-- while a prompt upgrade re-reads the corpus, which makes "which notes is this
-- persona built from" a fact that has to live on the row rather than in whatever
-- happens to be configured now.
alter table braintrust_compiles add column if not exists extractor text;

comment on column braintrust_compiles.extractor is
  'The braintrust_item_notes.extractor generation this compile read. Nullable only '
  'because the column was added after the table; every compile writes it.';

-- These two partial unique indexes are the whole regeneration mechanism: at
-- most one current compile per person, and at most one running compile per
-- person, enforced by the database rather than by the compiler remembering to.
create unique index if not exists braintrust_compiles_one_current_idx
  on braintrust_compiles (person_id) where status = 'current';

create unique index if not exists braintrust_compiles_one_running_idx
  on braintrust_compiles (person_id) where status = 'running';

create table if not exists braintrust_persona_layers (
  id              uuid primary key default gen_random_uuid(),
  compile_id      uuid not null references braintrust_compiles(id) on delete cascade,
  layer           text not null check (layer in ('voice', 'reasoning', 'beliefs', 'coverage')),
  basis           text not null check (basis in ('measured', 'inferred')),
  descriptive_md  text not null,
  generative_md   text,             -- voice only
  evidence        jsonb not null default '{}'::jsonb,
  unique (compile_id, layer)
);

-- 'beliefs' is retired. It was a layer of conclusions that shipped in every
-- persona payload, which let a model answer what somebody thinks without
-- looking anything up. What a person broadly holds is a through-line now
-- (see braintrust_through_lines below): retrieved beside something quotable,
-- never handed over unasked.
--
-- The rows go first and then the constraint, because the constraint cannot be
-- narrowed while a row still uses it. Deleting them is safe: layers are tier 3,
-- rebuilt from notes that already exist, and the read path stopped serving this
-- one before this file was ever run. Running it twice changes nothing.
delete from braintrust_persona_layers where layer = 'beliefs';

alter table braintrust_persona_layers drop constraint if exists braintrust_persona_layers_layer_check;
alter table braintrust_persona_layers add constraint braintrust_persona_layers_layer_check
  check (layer in ('voice', 'reasoning', 'coverage'));

comment on column braintrust_persona_layers.generative_md is
  'Same row as descriptive_md on purpose: written by one compile step from one set '
  'of measurements, so the instruction and its evidence cannot disagree.';

create table if not exists braintrust_positions (
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

-- A position reports its span, not only its beginning. Both are derived from the
-- citations at every compile exactly as held_since is, so nothing here is carried
-- forward — but an already-deployed database still has to be given the columns, and
-- without these two the compiler's insert fails on a database that predates them.
alter table braintrust_positions add column if not exists held_until date;
alter table braintrust_positions add column if not exists days_spanned int;

comment on column braintrust_positions.held_since is
  'Recomputed every compile. A backfill that finds older evidence moves it earlier.';

comment on column braintrust_positions.days_spanned is
  'held_until minus held_since. Confidence is capped at moderate when it is a week or '
  'less: five pieces of work in one week are one occasion wearing five dates. Null when '
  'every citation is undated, and a null is never capped.';

comment on column braintrust_positions.item_count is
  'The denominator. A position resting on one video should say so.';

create table if not exists braintrust_position_citations (
  id           uuid primary key default gen_random_uuid(),
  position_id  uuid not null references braintrust_positions(id) on delete cascade,
  item_id      uuid not null references braintrust_items(id),
  start_ms     int,                    -- transcripts: where in the video
  post_url     text,                   -- batched days: which post
  posted_at    timestamptz,
  quote        text not null
);

alter table braintrust_position_citations add column if not exists post_url text;
alter table braintrust_position_citations add column if not exists posted_at timestamptz;

comment on column braintrust_position_citations.post_url is
  'A bluesky item is a whole UTC day, because 2,100 skeets a year would be 2,100 model '
  'calls for fewer words than a 23-essay substack. The batch is a unit of reading and '
  'never a unit of citation: the day records each post''s character span, and a verified '
  'quote resolves to the post it fell inside. Null wherever the item is one thing.';

comment on column braintrust_position_citations.start_ms is
  'The same question as post_url in the unit a transcript has. Both are read off the rows '
  'once the quote has been located; a model is never asked for either.';

-- The Position's own statement, in the same space the Corpus is indexed in.
--
-- `fit` grades how well a Position answers the question asked, and for three
-- versions it graded a quantity every Position in the answer shared — the best
-- Chunk of the best Item behind it. Measured across 92 Positions: that number
-- orders answers the way a reader would 51% of the time, where 50% is a coin,
-- and 41 of the 92 shared their score with another Position. The statement gets
-- 80%, and 82% under a judge shown only the person's own quotes.
--
-- One vector per Position per model, mirroring braintrust_embeddings: `model` is
-- in the primary key because a better model is a new set of rows, and the rows
-- cascade with the compile that wrote them because a Position has no existence
-- outside it.
create table if not exists braintrust_position_embeddings (
  position_id uuid not null references braintrust_positions(id) on delete cascade,
  model       text not null,
  embedding   vector(1024) not null,
  created_at  timestamptz not null default now(),
  primary key (position_id, model)
);

comment on table braintrust_position_embeddings is
  'What fit is graded from. Two positions drawn from one item are two different '
  'sentences, so they get two different scores — which is the whole point, and is '
  'a publication-blocking check.';

create index if not exists braintrust_position_embeddings_hnsw_idx
  on braintrust_position_embeddings using hnsw (embedding vector_cosine_ops);

-- What someone broadly holds, inferred across their work rather than quoted
-- from any one piece of it.
--
-- No date, because the only date available is the oldest item in whichever
-- readings surfaced it — a property of braintrust's reading schedule and not of
-- the person's life. No quote, because an illustrative one and a supporting one
-- are indistinguishable once printed. No embedding, because a through-line has
-- no retrieval path of its own: it rides with an answer that already matched.
--
-- `readings` is why it exists at all — an entry that surfaced in only one
-- separate reading of the corpus is not published.
create table if not exists braintrust_through_lines (
  id          uuid primary key default gen_random_uuid(),
  compile_id  uuid not null references braintrust_compiles(id) on delete cascade,
  slug        text not null,
  statement   text not null,
  readings    int not null,
  basis       text not null default 'inferred' check (basis = 'inferred'),
  unique (compile_id, slug)
);

alter table braintrust_compiles add column if not exists through_line_candidates int not null default 0;

comment on table braintrust_through_lines is
  'A claim braintrust inferred, never one it can quote. It may never be the whole of '
  'an answer: speaking it flatly is affordable only because something checkable is '
  'always beside it.';

-- Which items a through-line was traced to. Not citations — nothing here is
-- quotable — but what decides which answers it rides with: a through-line
-- travels with an answer whose positions rest on the same items.
create table if not exists braintrust_through_line_items (
  through_line_id uuid not null references braintrust_through_lines(id) on delete cascade,
  item_id         uuid not null references braintrust_items(id) on delete cascade,
  primary key (through_line_id, item_id)
);

create table if not exists braintrust_position_relations (
  id                uuid primary key default gen_random_uuid(),
  compile_id        uuid not null references braintrust_compiles(id) on delete cascade,
  from_position_id  uuid not null references braintrust_positions(id) on delete cascade,
  to_position_id    uuid not null references braintrust_positions(id) on delete cascade,
  relation          text not null check (relation in ('revised', 'unsettled', 'drifting')),
  gap_days          int,
  rationale         text
);

comment on table braintrust_position_relations is
  'from is the earlier position, to the later, and relation describes what the later '
  'does to the earlier. Both states are rows — a superseded position is retained.';

-- ---------------------------------------------------------------------------
-- braintrust checking itself
--
-- Tier 3 in cost but not in meaning: these three are the only tables that record
-- what braintrust concluded about *itself*, and a compile never touches them.
-- That separation is the point. A failing interrogation must not be able to
-- change what a persona serves, so it writes here and nowhere else.
--
-- No table here has a foreign key to braintrust_people. A compiler fault is
-- about braintrust and outlives any particular person, and a fault about
-- somebody who has since been unfollowed is still a fault worth reading.
-- ---------------------------------------------------------------------------

create table if not exists braintrust_interrogations (
  id                uuid primary key default gen_random_uuid(),
  assertion         text not null,
  person_slug       text,             -- null for an assertion about the compiler
  subject_slug      text not null,    -- whose persona it was actually asked against
  compiler_version  text not null,
  interrogator      text not null,    -- model@interrogation-version
  passed            boolean not null,
  detail            text not null,
  ran_at            timestamptz not null default now()
);

comment on table braintrust_interrogations is
  'Every verdict, kept. A failure opens an issue addressed to a human, and the '
  'reply that produced it has to be readable afterwards — the judge is a model too.';

comment on column braintrust_interrogations.person_slug is
  'Null means the assertion is a property of the compiler rather than of a person, '
  'so it runs once per compiler version rather than once per persona.';

create index if not exists braintrust_interrogations_recent_idx
  on braintrust_interrogations (assertion, person_slug, ran_at desc);

create table if not exists braintrust_faults (
  fault_key        text primary key,  -- assertion plus subject; the deduplication itself
  assertion        text not null,
  person_slug      text,
  detail           text not null,
  first_failed_at  timestamptz not null default now(),
  last_failed_at   timestamptz not null default now(),
  reported_at      timestamptz,
  reported_issue   text,
  escalated_at     timestamptz,
  escalated_issue  text
);

comment on table braintrust_faults is
  'One row per live fault. The row is the deduplication: a fault already open '
  'opens no second issue, however many runs re-observe it. Deleted when the '
  'assertion passes — cleared by a pass, never by an issue being closed.';

comment on column braintrust_faults.first_failed_at is
  'Never moved once set. It is the clock the one-day limit runs on, and a fault '
  'that reset it every run would never escalate.';

create table if not exists braintrust_silences (
  silence_key      text primary key,  -- assertion plus subject, same shape as a fault key
  assertion        text not null,
  person_slug      text,
  detail           text not null,     -- the latest reason; the only place a dead
                                      -- endpoint and a broken judge differ
  attempts         int not null default 1,
  first_failed_at  timestamptz not null default now(),
  last_failed_at   timestamptz not null default now(),
  reported_at      timestamptz,
  reported_issue   text
);

comment on table braintrust_silences is
  'An assertion that could not be ASKED — a third status beside passed and failed, '
  'and never a persona''s fault. Deliberately a separate table from '
  'braintrust_faults and joined to it nowhere: a silence is somebody else''s '
  'outage, it is evidence against nobody, and it must not be able to withdraw a '
  'layer or put a person''s name in front of a maintainer. Rows are deleted the '
  'moment an assertion gets an answer, pass or fail.';

comment on column braintrust_silences.attempts is
  'Consecutive failed attempts to ask. A stuck assertion stays due and is retried '
  'every run, so this counts days rather than staleness — and a job that stops '
  'running stops the clock rather than hiding behind it.';

comment on column braintrust_silences.reported_at is
  'Set on every row of one outage at once, because one outage files one issue '
  'listing every assertion that went unchecked. A single reported row silences the '
  'whole arm: braintrust files once and never re-files while the ledger stays open.';

-- ---------------------------------------------------------------------------
-- House style
--
-- braintrust itself uses none of this: it connects to Postgres directly over
-- the session pooler, because promoting a compile is a multi-statement
-- transaction and PostgREST has none. These exist so the braintrust_* tables
-- behave correctly if the user's own OB1 tooling ever looks at them. They cost
-- nothing and keep the composability. See docs/design/deployment.md §5.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  foreach t in array array[
    'braintrust_people',
    'braintrust_sources',
    'braintrust_items',
    'braintrust_chunks',
    'braintrust_embeddings',
    'braintrust_item_notes',
    'braintrust_compiles',
    'braintrust_persona_layers',
    'braintrust_positions',
    'braintrust_position_citations',
    'braintrust_position_embeddings',
    'braintrust_position_relations',
    'braintrust_through_lines',
    'braintrust_through_line_items',
    'braintrust_interrogations',
    'braintrust_faults',
    'braintrust_silences'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);

    if has_service_role then
      execute format('grant select, insert, update, delete on table public.%I to service_role', t);
      execute format('drop policy if exists %I on public.%I', t || '_service_role', t);
      execute format(
        'create policy %I on public.%I for all to service_role using (true) with check (true)',
        t || '_service_role', t
      );
    end if;
  end loop;

  if not has_service_role then
    raise notice
      'No service_role role found, so the grants and RLS policies were skipped. '
      'That is expected off Supabase. RLS is still enabled on every table.';
  end if;
end $$;

notify pgrst, 'reload schema';

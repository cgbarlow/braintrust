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
                                       'skipped_short', 'skipped_window', 'failed')),
  body_text     text,                 -- null until retrieved; null forever if skipped
  body_raw      jsonb,                -- caption events, feed entry — whatever the platform actually gave
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
  'rather than a one-way door.';

-- `create table if not exists` leaves an existing table alone, so a database created
-- before skipped_short existed would reject the value. Re-stating the constraint is
-- the one honest way to add a value without a migration framework, and it is
-- idempotent: running it twice lands in the same place.
alter table braintrust_items drop constraint if exists braintrust_items_retrieval_check;
alter table braintrust_items add constraint braintrust_items_retrieval_check
  check (retrieval in ('pending', 'retrieved', 'skipped_paywall', 'skipped_short',
                       'skipped_window', 'failed'));

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
  start_ms     int,
  quote        text not null
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
    'braintrust_position_relations'
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

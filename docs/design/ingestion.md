# Ingestion

**Status:** decided. Assembled from
[Pick the one content source v1 ingests](https://github.com/cgbarlow/braintrust/issues/5),
[Decide what drives ingestion and re-distillation](https://github.com/cgbarlow/braintrust/issues/12),
[Define how a person and their sources are registered](https://github.com/cgbarlow/braintrust/issues/17) and
[Decide what braintrust does when a source blocks it](https://github.com/cgbarlow/braintrust/issues/21).

Vocabulary is in [`CONTEXT.md`](../../CONTEXT.md); the tables are in [`schema.md`](./schema.md). The reasoning
behind each choice is in the resolution comment linked at the head of each section — **this document is what
braintrust does, not why it does it.** Measurements are in
[`substack-source-facts.md`](../research/substack-source-facts.md); every figure below came from a live fetch.

---

## 1. Three layers, and only one of them is generic

[#5](https://github.com/cgbarlow/braintrust/issues/5)

Ingestion is not one adapter per platform. It splits into three layers, and the split is the same on both
platforms:

| Layer | Shape | Adding a source #3 |
|---|---|---|
| **Discovery + cursor** | Generic RSS/Atom. Stable id + publish date, no body. | **a config entry** |
| **Backfill** | Per platform. Walks the archive back to `backfill_floor`. | new code |
| **Body retrieval** | Per platform, and the expensive half. | new code |

**Neither source returns a body at discovery.** Retrieval is always a separate step, which is why
`braintrust_items.body_text` is nullable and normally null.

### The two platforms, concretely

| | Substack | YouTube |
|---|---|---|
| **Discovery** | `/feed` — 20 items | `videos.xml` Atom feed — 15 entries |
| **Identity** | integer `id` from the archive API | `yt:videoId` |
| **Publish date** | `post_date` | `published` (feed only — see below) |
| **Backfill** | `/api/v1/archive`, paged | the flat channel listing, 30 ids per page, no reliable total |
| **Body** | `/api/v1/posts/<slug>` | the `json3` caption track named by `/youtubei/v1/player` |
| **Audience** | `audience` on the archive record, known **before** fetching | always public |
| **Yield in 12 months** | ~15 free posts, ~53,000 words | ~395 videos, ~1,170,000 words |

Three facts the build has to respect:

- **The YouTube bot gate is path-specific.** Per-video `extract_info()` fails every time; caption download at
  4s spacing succeeded 4 of 4. The Atom feed supplies exactly the metadata captions cannot come with, so the
  two cheap endpoints compose. **The 4s spacing is load-bearing** and the unattended crawl keeps it. It is
  spent **per Item, not per request** — one video costs two or three back-to-back calls, which is what yt-dlp
  was doing inside each of the four measured downloads.
- **Dates on older YouTube items cost a second call** — because the Atom feed only dates the most recent 15.
  Without dates there are no held-then-revised Positions at all, so an undated Item is a degraded Item rather
  than a normal one. Measured during the build (#29): the watch page is 1,241,747 bytes, but the player
  endpoint answers with `microformat.publishDate` in ~15KB, so this costs ~5.8MB across a 12-month backfill
  rather than ~490MB.
- **Shorts are excluded by default** (`braintrust_sources.exclude_shorts`). Sub-five-minute videos yield a few
  hundred words of promotional copy. The duration arrives with the channel listing and again with the player
  response, so an excluded Short is recognised **before** its transcript is requested, and is written as
  `retrieval = 'skipped_short'` — the one skip that is braintrust's own policy rather than a source's
  decision, and therefore the one that turning the setting off undoes without a second crawl.

**No yt-dlp, and no Python in either deployment.** The research reached captions through yt-dlp and this
document named `skip_download` as the route. Measured during #29: `POST /youtubei/v1/player` returns the
caption track URL directly and the track fetches clean over plain HTTP, at word counts identical to the ones
yt-dlp produced for the same two videos. The timedtext URL printed in the watch page's own HTML is *not*
usable — it answers HTTP 200 with a zero-byte body.

**The player endpoint requires the caller to name a YouTube client, and the ones that serve caption tracks are
Google's own app surfaces** — `WEB` is refused, `IOS` is served. braintrust names `IOS` on that call and
changes nothing else: its User-Agent stays its own with a link to the repo, no cookies, no sign-in, no
rotation, one address. That is within
[the v1 posture](../research/source-terms-and-consent.md)'s "documented, not disguised", and it is more
transparent than the yt-dlp route, which defaults to impersonating a browser.

**The paywall line is enforced here, as an allow-list.** `audience` is known before fetching, so an Item whose
audience is not exactly `everyone` is written as `retrieval = 'skipped_paywall'` and never retrieved. Live
Substack values include `only_paid` and `founding`; a deny-list would silently ingest the next tier Substack
invents. This is one of the two lines
[the consent posture](https://github.com/cgbarlow/braintrust/issues/9) enforces in code, and
[registration](https://github.com/cgbarlow/braintrust/issues/17) refuses to make it configurable.

---

## 2. Registration: you paste links, braintrust resolves them, a human confirms

[#17](https://github.com/cgbarlow/braintrust/issues/17)

Registration is [`braintrust_follow_person`](./mcp-surface.md#4-braintrust_follow_person) and nothing else.
There is no CLI, because [nothing ships on npm](./deployment.md#6-nothing-ships-on-npm) — so the
human-only guarantee has exactly one implementation site, and bootstrapping the very first Person happens
through an AI client against an empty database.

**The human supplies pointers in whatever form they already have them** — a Substack post URL, a hostname, a
YouTube channel page, an `@handle`, a link to one video. braintrust normalises. `GET
https://www.youtube.com/@Handle` returns `channel_id=UC…` in the page body, HTTP 200, case-insensitive, no bot
gate — so the opaque `UC…` id is never something a human types or sees.

**braintrust cannot find a Person from their name.** Neither platform offers a search braintrust can use. A
human always supplies pointers; recorded so no later session re-proposes it.

**braintrust proposes the display name and the human confirms it.** Both feeds carry a name and they disagree
— Substack's `/feed` says *"Nate's Substack"*, YouTube's Atom says *"AI News & Strategy Daily | Nate B Jones"*
— and neither is the Person's name. This value becomes `"braintrust model of X"`, the string that carries the
disclosure everywhere it travels. `slug` is derived from the confirmed name; a collision takes a numeric
suffix.

### The two-call handshake

**Only a human may cause a new Person to be ingested; an AI may never complete the act.**

- **Call 1 reads public metadata and ingests nothing.** No Item row, no body, no Note, no embedding, and no
  caption or post body retrieved. Resolving a handle *is* a fetch and counting an archive *is* an API call —
  what is gated is downloading someone's work, not reading a feed to price it. Returns a Plan and a
  `confirm_token`.
- **Call 2 carries the token and starts the ordinary cycle** in §3. There is no separate initial-load mode:
  the first run after following someone *is* the backfill.

Token lifetime is short and single-use; a stale confirmation is a hole in the rule.

### What a Plan contains

**Every number in a Plan is labelled `measured` or `estimated`, the same as a Persona's layers.** Substack's
count and paywall split are exact, because `audience` and `post_date` arrive with the archive metadata.
YouTube's count is extrapolated from the publish rate across the Atom feed's 15 dated entries, because an
exact figure would mean walking the whole archive during a call that is supposed to be cheap.

```jsonc
{ "plan": {
    "person": "Nate B. Jones",                       // proposed; confirm or change
    "sources": [
      { "platform": "substack", "handle": "natesnewsletter",
        "resolved_from": "https://natesnewsletter.substack.com/p/…",
        "feed_title": "Nate's Substack",
        "items": { "count": 156, "basis": "measured" },
        "will_skip_paywalled": 142 },
      { "platform": "youtube", "handle": "UC0C-17n9iuUQPylguM1d-lQ",
        "resolved_from": "@NateBJones",
        "feed_title": "AI News & Strategy Daily | Nate B Jones",
        "items": { "count": 395, "basis": "estimated",
                   "how": "1.5/day observed across 15 dated feed entries" } }
    ],
    "window_months": 12,
    "estimated_duration_min": 40,
    "overrides_applied": []
  },
  "confirm_token": "…", "ingested": false }
```

**`resolved_from` is in the payload on purpose** — it is what makes a wrong resolution visible in the approval
surface, which is the one failure mode pasting links introduces over a strict handle notation.
**`will_skip_paywalled` is shown before anything is fetched**, so a human sees that 142 of 156 posts will not
be read *before* agreeing rather than discovering it in Coverage afterwards.

### Defaults, and the one setting that is not one

| | Default | Overridable per Source? |
|---|---|---|
| How far back (`backfill_floor`) | 12 months | **yes** |
| Shorts / sub-5-minute Items (`exclude_shorts`) | excluded | **yes** |
| How often braintrust checks (`poll_interval_hours`) | daily | **yes** |
| Paywalled content | never ingested, always recorded | **no** |

The defaults live in the DDL ([`schema.md`](./schema.md#tier-1--durable)), so "what braintrust does if you say
nothing" is readable in one place. Omitting an override takes the default, so the ordinary path asks for
nothing.

**`poll_interval_hours` does not create a second scheduler.** There is one daily job; the interval only
decides whether a Source is *due* when it runs.

**Accepted cost:** two Personas with different windows have Coverage numbers that are not directly comparable.
Tolerable because Coverage states its own window, so each is self-describing rather than silently different.

### Unfollowing pauses; it does not delete

`braintrust_unfollow_person(person)` sets `braintrust_people.paused_at`. The daily job skips that Person; the
Persona stays queryable and simply stops moving, frozen at its last Compile with Coverage reporting a window
that no longer advances. **Nothing is deleted**, because people, sources and items are
[tier 1](./schema.md#the-central-idea-three-tiers-and-only-one-of-them-is-precious) — deleting would make
changing your mind cost a second full crawl. Re-following clears the pause and goes through the full
handshake, because resuming does start fetching again.

**Stated plainly: this is not a takedown.** If the reason for stopping is that the Person asked to be removed,
pausing does not answer them — the content stays on disk. Deleting the `braintrust_people` row cascades
everything away in one statement, so the capability exists; it is an operator action, deliberately not a tool.

---

## 3. One daily job, and everything expensive is a backlog

[#12](https://github.com/cgbarlow/braintrust/issues/12)

**braintrust polls both Sources once a day whether or not anyone is using it.** One schedule serves both
Sources, not one per Source. The reason is a correctness constraint rather than a freshness preference:
YouTube's Atom feed holds 15 entries, roughly ten days at this channel's rate, and Items that age out lose
their publish date — converting a free date into a ~1.3MB fetch, ~395 times over. A daily poll buys a 10×
margin for two cheap HTTP requests.

### The cycle, in order

1. **Poll** — one feed fetch per due Source. Insert new Items as `retrieval = 'pending'`. Advance
   `cursor_published_at`.
2. **Check for a gap** — §4.
3. **Drain the Backlog** — backfill any Source not `backfill_complete`; retrieve bodies and write Notes for
   `pending` Items, at 4s spacing on YouTube.
4. **Rebuild** — if the Backlog is empty and anything changed since the last Compile:
   [build → gate → promote](./compiler.md#5-a-compile-must-earn-the-right-to-replace-its-predecessor).

**One code path, three triggers:** the daily clock, `braintrust_refresh_persona` (AI-callable), and the second
call of the follow handshake all run this same cycle.

**New content triggers the rebuild, not the clock.** If the poll brought in nothing, nothing is rebuilt. The
schedule merely bounds it to at most one rebuild per Person per day. This is affordable only because
[the compiler reads Notes rather than transcripts](./compiler.md#1-each-item-is-read-once-and-what-was-read-is-kept).

### The Backlog is rows, not a queue

Four things want to be long-running jobs — the first 12-month backfill (~395 fetches ≈ 26 minutes), catching
up after falling behind, re-reading the Corpus when the Note prompt improves, and routine daily retrieval.
**They are one job**, and its queue is state already in the schema:

| Work | The row that asks for it |
|---|---|
| Fetch a body | `braintrust_items.retrieval = 'pending'` |
| Write a Note | an Item with no `braintrust_item_notes` row for the current `extractor` |
| Walk the archive | `braintrust_sources.backfill_complete = false` |

**Every long job is therefore resumable by construction.** A run killed at minute 12 of 26 has written twelve
minutes of real rows and the next run continues. No job table, no checkpointing.

Two exclusions, both for the same reason — *a terminal recorded outcome is not a pending item*:

- **`retrieval = 'failed'` is not in the Backlog.** Coverage reports it. Otherwise one permanently unfetchable
  video would block every future Compile. Whether anything ever re-attempts a failed Item is unspecified.
- **A Blocked Source is not in the Backlog** — §5.

**A Compile waits for an empty Backlog.** Most visibly on a Note-prompt upgrade: a Compile fired halfway
through a ~395-item re-read would be a Persona built from a quarter of the Corpus. Waiting keeps the previous
Persona live for the duration.

### One rebuild per Person at a time

Two clients calling `braintrust_refresh_persona` seconds apart — or one calling it as the daily job starts —
cannot produce two rebuilds. **The second caller is refused and told when the running one started**, enforced
by `create unique index on braintrust_compiles (person_id) where status = 'running'`. Double-spend is
structurally impossible rather than politely avoided, which is what makes AI-callable refresh safe to leave
ungated.

---

## 4. Falling behind is detected, recorded, and repaired

[#12](https://github.com/cgbarlow/braintrust/issues/12)

**Detection is one comparison:** if the oldest entry in a feed is newer than `cursor_published_at`, something
published in between was never seen.

**The repair is to set `backfill_complete = false`.** Step 3 of the cycle then walks the archive back to
`backfill_floor` and inserts what is missing. The initial load and the catch-up are the same action, so this
costs no code beyond the comparison.

**And `backfill_complete = false` is simultaneously the honesty flag Coverage reads**, so between noticing a
gap and closing it the Persona states that its Corpus is incomplete.

This is not optional. Coverage is one of the two layers computed by counting, and **Items braintrust never saw
are not missing rows — they are no rows at all.** An undetected gap would make a `measured` layer confidently
report a complete Corpus with a three-week hole in it.

---

## 5. A block is measured, not judged

[#21](https://github.com/cgbarlow/braintrust/issues/21)

**A Source is Blocked when N consecutive retrieval attempts against *distinct* Items fail.** braintrust does
not classify the response at all — a 403 can be a CDN hiccup, a 429 can be politeness, and a captcha
interstitial arrives as a 200 with HTML in it. Counting consecutive failures across different Items measures
the only thing that matters: the Source has stopped serving braintrust, whatever it chose to say. The
threshold is a constant, deliberately left to tuning against real behaviour.

**A 429 is handled before the counter sees it.** Rate limiting is the Source asking braintrust to slow down,
and slowing down is compliance. A 429 waits and retries the same Item once; only if it keeps failing does it
become a failure the counter counts.

**A single failure is already `retrieval = 'failed'`** and needs nothing new.

### What a block does

- **`blocked_at` is set and the crawl for that Source stops immediately. Every other Source continues.** The
  two Sources share nothing but a Person and they fail in opposite directions — Substack's constraint is a
  paywall, YouTube's is a bot gate. Stopping the whole run would be a failure braintrust invented rather than
  one a Source imposed.
- **`blocked_at` suppresses that Source's Backlog** — all three row-states above. This is what stops a Source
  that can never finish its backfill from sitting in a permanent repair loop. `backfill_complete` stays
  `false`, because the Corpus genuinely *is* incomplete; **the flag keeps telling the truth and merely stops
  generating requests.**
- **A Compile still runs**, on what braintrust actually has. Freezing the Persona would hand a platform a veto
  over whether braintrust works at all.
- **A gap check on a Blocked Source is a no-op** — the flag is already false and the Backlog is suppressed. No
  special case needed.

### It asks again tomorrow — one request, unchanged

The next daily run sends **a single ordinary request** against the Blocked Source. Success clears `blocked_at`
and normal work resumes; failure means nothing else happens until the following day.

This is self-healing, not evasion. Evasion means changing *how* you ask — a new address, a spoofed
user-agent, a rotated identity — and braintrust
[crawls from one host at one address](./deployment.md#2-two-services-one-codebase) with nothing to rotate.

**Accepted cost, stated plainly:** a Source that has permanently and deliberately blocked braintrust receives
one request a day forever. That is the price of self-healing, and it is one request.

### The Persona says so, in both places that already exist

- **`braintrust_load_persona` → coverage** names the Blocked Source, when it stopped, and how much of that
  Source went unread.
- **`braintrust_list_personas` → corpus** carries it too, so a client sees it in ordinary use rather than only
  when auditing.

**A block must never read as a pause.** `paused_at` is on the Person and means *the user chose to stop*;
`blocked_at` is on the Source and means *the Source refused braintrust*. A Persona reporting the second as the
first would be blaming its own user for a platform's decision. Two columns, two facts, two sentences.

**This does not make Coverage lie.** A Blocked Source's unfetched Items are `pending` rows that exist and are
counted — unlike the never-seen Items that made gap detection non-optional. The Persona reports a real,
countable shortfall.

**Rejected: a notification.** v1 has no channel to notify through, and a persistently failing compiler is
already accepted as silent. The two surfaces above are where someone already looks.

---

## Accepted costs

| Cost | Where it comes from |
|---|---|
| A permanently blocked Source receives one request a day, forever. | §5 |
| Nobody is watching. The daily job runs unattended and a persistently rejected Compile is silent — the only signal a client can see is `compiled_at` failing to advance. | §3, [compiler](./compiler.md#5-a-compile-must-earn-the-right-to-replace-its-predecessor) |
| A `retrieval = 'failed'` Item stays failed. Coverage reports it; nothing retries it. | §3 |
| Two Personas with different windows have Coverage numbers that are not comparable. | §2 |
| 93% of the Substack Corpus is never read, by design. Coverage names it. | §1 |

## Deliberately not decided

- The consecutive-failure threshold that constitutes a block.
- Retry policy for a `retrieval = 'failed'` Item.
- What time of day the job runs.
- Whether a human can clear `blocked_at` through a tool — the daily probe makes it unnecessary; a database
  update covers the impatient case.
- What happens if a Source's handle changes. The `UC…` id is stable so YouTube survives it; Substack is
  untested. Nothing in the schema keys on the handle.
- **Whether the two Sources are ever reconciled.** A free video and a paid post can cover the same subject on
  the same day. v1 answers *two Items* — a Position may cite both, and nothing tries to merge them.

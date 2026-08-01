# Ingestion

**Status:** decided. Assembled from
[Pick the one content source v1 ingests](https://github.com/cgbarlow/braintrust/issues/5),
[Decide what drives ingestion and re-distillation](https://github.com/cgbarlow/braintrust/issues/12),
[Define how a person and their sources are registered](https://github.com/cgbarlow/braintrust/issues/17) and
[Decide what braintrust does when a source blocks it](https://github.com/cgbarlow/braintrust/issues/21).

**§§6–7 and the amendments marked below are assembled from
[the Bluesky and personal-blogs map](https://github.com/cgbarlow/braintrust/issues/52)** — fourteen decisions,
each linked where it lands. Four of them **correct** what this document previously asserted, and each of those
is named as a correction rather than quietly rewritten, because someone will have built against the old
sentence.

Vocabulary is in [`CONTEXT.md`](../../CONTEXT.md); the tables are in [`schema.md`](./schema.md). The reasoning
behind each choice is in the resolution comment linked at the head of each section — **this document is what
braintrust does, not why it does it.** Measurements are in
[`substack-source-facts.md`](../research/substack-source-facts.md) and — for the blog sources — in
[`ghost-source-facts.md`](https://github.com/cgbarlow/braintrust/blob/research/ghost-source-facts/docs/research/ghost-source-facts.md),
which is still on its research branch. Every figure below came from a live fetch.

---

## 1. Three layers, and only one of them is generic

[#5](https://github.com/cgbarlow/braintrust/issues/5)

Ingestion is not one adapter per platform. It splits into three layers, and the split holds across all four:

| Layer | Shape | Adding a source |
|---|---|---|
| **Discovery + cursor** | Generic RSS/Atom. Stable id + publish date, and — on a blog — the body too. | **a config entry, where the platform has a feed** |
| **Backfill** | Per platform. Walks the archive back to `backfill_floor`. | new code |
| **Body retrieval** | Per platform, and usually the expensive half. | new code |

**That prediction has now been tested twice, and it survived once.** A personal blog needs no discovery code
at all — an Atom feed is an Atom feed. Bluesky does not fit it: braintrust reads the public AppView rather
than a feed, because [a Bluesky Item is a day of posts](https://github.com/cgbarlow/braintrust/issues/53) and
no feed hands over a day.

**Amended by [#55](https://github.com/cgbarlow/braintrust/issues/55): discovery sometimes *is* retrieval.**
This document previously said *"neither source returns a body at discovery"* and generalised it. On a
feed-bearing blog the feed carries the whole post — page extraction agreed with the feed body at **1.00 on 11
of 11 posts** across both Karpathy blogs, 12,550 words agreeing exactly on the longest — so the expensive half
costs nothing and a whole blog backfill can be one request. `braintrust_items.body_text` is still nullable and
still normally null, because it stays null on Substack, on YouTube, and on a feedless blog until retrieval
runs.

### The two platforms v1 shipped, concretely

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
  two cheap endpoints compose. **The 4s spacing is load-bearing** and the unattended crawl keeps it. One video
  costs two or three back-to-back calls, which is what yt-dlp was doing inside each of the four measured
  downloads, and the whole group is spaced once.

  **Corrected by [#66](https://github.com/cgbarlow/braintrust/issues/66): the spacing is spent per *request*,
  not per Item.** This document argued the opposite, and it was safe to argue only while one Item *was* one
  expensive request — which is true on YouTube and on Substack and on nothing added since. One Bluesky call
  returns 100 posts and yields ~18 Items; a feed-bearing blog produces **zero** per-Item requests. Read per
  Item, the rule makes the cheapest source braintrust has the slowest one it reads, purely because the word
  *Item* is doing two jobs: a 12-month Bluesky backfill would take **102 minutes instead of ~16 seconds**, and
  buy no politeness at all, since the requests are identical either way and only the waiting changes. Nothing
  about YouTube's behaviour changes — the same group of calls, the same 4s between groups. See §6 for the
  per-source figures.
- **Dates on older YouTube items cost a second call** — because the Atom feed only dates the most recent 15.
  Without dates there are no held-then-revised Positions at all, so an undated Item is a degraded Item rather
  than a normal one. Measured during the build (#29): the watch page is 1,241,747 bytes, but the player
  endpoint answers with `microformat.publishDate` in ~15KB, so this costs ~5.8MB across a 12-month backfill
  rather than ~490MB.
- **Shorts are excluded by default** (`braintrust_sources.exclude_shorts`). Sub-five-minute videos yield a few
  hundred words of promotional copy. The duration arrives with the channel listing and again with the player
  response, so an excluded Short is recognised **before** its transcript is requested, and is written as
  `retrieval = 'skipped_short'` — braintrust's own policy rather than a source's decision, and therefore
  undone by turning the setting off, without a second crawl. It was the first of those and is no longer the
  only one: [§8](#8-blogs-any-feed-best-effort) adds `skipped_not_a_post`, reopened by a `<lastmod>` moving
  rather than by a setting, on the same rule.

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

**On a platform that declares nothing, the same line is drawn on evidence rather than on a field.** The
allow-list was written against Substack, where every post states its audience. Read literally on a blog it
would refuse every Ghost site including one with no members at all, so
[#64](https://github.com/cgbarlow/braintrust/issues/64) settled where the rule's purpose actually lands:
**Ghost enforces its own paywall at the feed as well as the page** — `content:encoded` is *empty* for a
members-only post, not truncated — so the hard line cannot be crossed by accident and no allow-list is
protecting it. What remains is a **completeness** problem: braintrust can store a publisher's deliberately
public 696-word intro and treat it as a whole argument. §8 carries the detection rule and the residual risk.

### The two this map adds

| | Bluesky | Personal blog |
|---|---|---|
| **Discovery** | `app.bsky.feed.getAuthorFeed` on the public AppView — 100 posts per call, cursored | the feed the homepage declares, or the sitemap where there is none |
| **Identity** | `<did>:<YYYY-MM-DD>` — a closed UTC day | the post URL |
| **Publish date** | `createdAt` on each post | the page's own metadata, read on the fetch braintrust already makes |
| **Backfill** | the same cursored call, back to `backfill_floor` | `sitemap-posts.xml` / `sitemap.xml`, dated and newest-first |
| **Body** | comes with discovery | the feed, where there is one; otherwise the page, extracted |
| **Audience** | always public | undeclared — inferred from gating markers, §7 |
| **Auth** | **none.** No key, no cookies, no sign-in | none |

**Bluesky is on a better footing than either source v1 shipped.** braintrust accepts a knowing terms breach to
read YouTube captions and needs none here: the public AppView is open by design, serves 100 posts per
unauthenticated call, and answered in 548ms with no rate-limit headers on the response at all.

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

**A blog resolves through the feed its homepage declares, never through a list of guessed paths.**
[#63](https://github.com/cgbarlow/braintrust/issues/63) measured path-guessing as **wrong on three of four
blogs**, and it produced this map's one false premise: charting recorded `agentics.org.nz` as a blog with no
feed, and it has one — at `/blog/rss/`, carrying all 12 posts with full bodies, declared on the homepage the
whole time, and 404ing at `/rss/` only because the site sits under a path prefix. There is no path that works
everywhere and the near-misses are 301s back to the homepage rather than to feeds. So resolution fetches the
homepage — which it must do anyway to identify the blog — and reads
`<link rel="alternate" type="application/rss+xml">`. One request, no guessing, and it is the mechanism the web
already standardised for exactly this.

**braintrust refuses a bridged Bluesky account and names the blog it mirrors.**
[#58](https://github.com/cgbarlow/braintrust/issues/58) found the duplication is total rather than partial: a
Bridgy Fed record carries `bridgyOriginalText` holding the *entire* blog post, HTML and all, so a braintrust
following both would hold the same words twice and the copy would not even look short. The detection is one
self-applied moderation label matching **`bridged-from-*`**, returned by the `getProfile` call registration
already makes, so it costs no extra request. Not the `.brid.gy` handle suffix, which catches today's bridge
and misses tomorrow's; not `bridgyOriginalText`, which is per-record and so is only visible after braintrust
has already followed the account. The refusal is a redirect, because the profile hands over the canonical URL:
*"`karpathy.bearblog.dev.web.brid.gy` is a bridge of karpathy.bearblog.dev, republished by Bridgy Fed rather
than posted by Andrej Karpathy — it calls itself "karpathy [Unofficial]". Follow the blog instead."*

The justification is provenance, not efficiency, and the temptation is worth naming: `bridgyOriginalText` is
cleaner, better-structured HTML than scraping the blog page, and it arrives through an API that is open by
design. Following the bridge would be **easier than following the source**. That is exactly when provenance
has to win, or braintrust's record of what someone wrote quietly becomes a record of what a bridge said they
wrote.

**braintrust never infers a mirror from content.** An account with no bridge label — a hand-rolled
cross-poster, someone who pastes their own posts in both places — is not detected, and
[the v1 rule](#deliberately-not-decided) applies unchanged: two Items, both counted, nothing merged. This is
the same line held for a block and for a paywall — **braintrust acts on what a source declares, never on what
it infers** — and its cost is stated rather than hidden: `item_count` on such a Person is genuinely inflated,
which is why Coverage reports *items read* rather than *unique writing*.

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

**The rule the label rests on, stated by [#67](https://github.com/cgbarlow/braintrust/issues/67): a count is
`measured` only when every item in it has been placed inside the window.** Nothing weaker earns the word. This
distinction is doing real work already — YouTube says `estimated` and was **8× wrong** for Matt Pocock — and a
human confirming a follow is agreeing to a cost, so the label is what tells them how much to trust the number.
The rule generalises to three different answers rather than one, and the Plan **quotes what braintrust can
defend, names the direction of the error, and never converts an upper bound into a midpoint.**

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

#### Three more Plan shapes, because there are three genuinely different offers

Flattening them would mean picking one lie to tell twice.

**Bluesky — `measured`, and the unit is days.** `getProfile` returns `postsCount` and the account's
`createdAt` free, before anything is fetched, and [#61](https://github.com/cgbarlow/braintrust/issues/61) made
a day the Item — so days are the honest number and they are `measured`, because the window *is* days and
braintrust will read every closed day in it.

> **emollick.bsky.social — 365 days in the window, ~1,530 posts (measured). About 16 seconds of fetching.**

The post count travels alongside as the thing being summarised, because this is the source where 1,530 posts
become ~365 model calls and a human confirming it should see both. **Posts-in-window is a labelled rate
projection** — `postsCount / days-since-creation × window` — not folded into the `measured` claim, because it
is a rate over the account's whole life and someone who has just started posting heavily is undercounted.

**A sitemap-bearing blog — `estimated`, and this is the honest downgrade.** The sitemap gives an exact URL
count and it is tempting to call that `measured`. It is not, twice over: it includes non-posts (the Bear Blog
sitemap contains the homepage), and `<lastmod>` is a modification date, so **nothing in the sitemap says which
URLs fall inside the window** — the control site in [#56](https://github.com/cgbarlow/braintrust/issues/56)
had all 7,651 of its `<lastmod>`s inside a fortnight after a migration.

> **karpathy.bearblog.dev — 15 URLs in the archive, at most 15 in the window (estimated: the sitemap dates
> changes, not publications). About 1 minute of fetching.**

*At most* rather than *about*, because the direction of the error is known — every URL is a candidate, and the
window and the non-posts can only remove. **An upper bound braintrust can defend beats a midpoint it cannot**,
and it is the opposite failure mode from YouTube's 8×-too-high guess, which was wrong in the same direction
without saying so. Where the blog has a feed the Plan says fetching collapses to one request, because that is
a different offer to agree to; a 2,213-URL feedless blog quoting **~2.5 hours** is exactly the number a human
should see first.

**A feed-only blog — `estimated`, and it says what it cannot see.** A feed is a tail — 10 entries for both
Karpathy blogs, 20 for Substack — so it cannot price an archive it cannot enumerate.

> **karpathy.github.io — 10 posts visible in the feed; the archive cannot be enumerated, so braintrust will
> follow forward and never claim to have read all of it (estimated).**

The Plan says the same thing the Persona will say. A human agreeing to this is agreeing to a permanently
partial Corpus, and that belongs in the sentence they confirm rather than in Coverage a fortnight later.

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

**A window is a setting, so widening one has to reach the Items it was widened for.** An Item the feed
carries but the archive walk stopped short of is written `retrieval = 'skipped_window'`, not `failed`:
nobody asked the source for it, so a terminal outcome would be recording braintrust's own decision as a
source's refusal — and terminal outcomes are never revisited, which made `window_months` a number you could
change and not feel. Widening it makes those rows pending again on the next run, without a second crawl, the
same way turning `exclude_shorts` off brings the Shorts back. There is no *"the window widened"* flag to keep
in step with the setting: the reopen asks whether each skipped Item is inside the floor as it stands now, so
a narrower window correctly reopens nothing. Found live, on a Person who publishes rarely — five posts across
seventeen months, of which the default window catalogued one.

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

**braintrust polls every Source once a day whether or not anyone is using it.** One schedule serves them all,
not one per Source. The reason is a correctness constraint rather than a freshness preference:
YouTube's Atom feed holds 15 entries, roughly ten days at this channel's rate, and Items that age out lose
their publish date — converting a free date into a ~1.3MB fetch, ~395 times over. A daily poll buys a 10×
margin for two cheap HTTP requests.

### The cycle, in order

1. **Poll** — one feed fetch per due Source. Insert new Items as `retrieval = 'pending'`. Advance
   `cursor_published_at`.
2. **Check for a gap** — §4.
3. **Drain the Backlog** — backfill any Source not `backfill_complete`; retrieve bodies and write Notes for
   `pending` Items, spaced [per request rather than per Item](#6-how-fast-each-source-is-read) — 4s on YouTube
   and on a blog page, 1s on Bluesky, 250ms on a feed or sitemap page.
4. **Rebuild** — if the Backlog is empty and anything changed since the last Compile:
   [build → gate → promote](./compiler.md#5-a-compile-must-earn-the-right-to-replace-its-predecessor).

**One code path, three triggers:** the daily clock, `braintrust_refresh_persona` (AI-callable), and the second
call of the follow handshake all run this same cycle.

**New content triggers the rebuild, not the clock.** If the poll brought in nothing, nothing is rebuilt. The
schedule merely bounds it to at most one rebuild per Person per day. This is affordable only because
[the compiler reads Notes rather than transcripts](./compiler.md#1-each-item-is-read-once-and-what-was-read-is-kept).

**And a second trigger, for the other way a Persona goes stale.** A Persona is rebuilt when what it was built
*from* changes — **or when what built it changes.** The second is not a clock either: it is the Compile row's
`compiler_version` differing from this run's, which happens when a measurement changes shape, a prompt is
bumped, or a capability arrives that was missing. Nothing in the rows moves in those cases, so the content
trigger never fires and the Persona would keep answering with a compiler that no longer exists.

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

### What the build settled about the three triggers

**The trigger is unseen content, not this run's activity.** The obvious reading of *new content triggers the
rebuild* is "rebuild whoever the poll brought something in for", and it is wrong in a way that only shows up
on the second day. Yesterday's run was killed with a Backlog, or the extractor was down and the Notes were
written this morning: nothing arrives today, so nothing is rebuilt, and the Persona stays stale until the
person next publishes — waiting on news that has nothing to do with what it is actually waiting for. So the
question a Compile asks is whether anything it reads is newer than the Persona currently answering: an Item
created or retrieved since, or a Note written since. Both are rows, which keeps this consistent with
everything else here — the Backlog is rows, the resume point is rows, and now the trigger is too.

*A status change needs no timestamp of its own.* A Compile only happens with an empty Backlog, so an Item
that was `pending` at any point after the last Compile must also have been created after it.

**And unseen content is only half of staleness.** A Persona can be perfectly current with everything its
subject published and out of date with what braintrust can now do with it. Most of that space is already
covered by the content trigger — changing the Note prompt re-reads the Corpus, which writes Notes; turning
`exclude_shorts` off makes skipped Items `pending` again — but a capability arriving changes no row at all.

**Found live.** A Persona compiled before an embeddings endpoint existed, so revision detection was skipped,
and nothing would ever have re-run it: the Corpus had not changed and never would on that account.

So the trigger asks a second question, and it is one comparison against a value already on the row:
`compiler_version`. Which only works because **the version records what a Compile could actually do rather
than what the code supports** — a Compile with no embedder writes `revisions-none`, not `revisions-1`. That
is the honest value independently of this rule: a row claiming a revisions pass that never ran is a Persona
asserting it looked for changes of mind and found none, which is a different sentence from *nobody looked*,
and it travels out through both read tools.

*Rejected: a `force` flag on refresh.* [#36](https://github.com/cgbarlow/braintrust/issues/36) settled that
new content triggers a rebuild rather than the asking — and the reason was never cost, since a rebuild reads
Notes and costs pennies. It was that the daily job and an AI-callable refresh must never disagree about what
a rebuild *means*. A flag makes the trigger depend on who is asking; a version comparison keeps it a fact
about the rows, like everything else here.

*Accepted cost.* The day the compiler version is bumped, **every Persona rebuilds at once.** That is correct —
they are all equally stale — and the run says so, because a burst of rebuilds on a day nothing was published
is otherwise an unexplained cost.

**Seen live.** A run that polled nothing — the Source was not due, so no feed was even fetched — read one
Item whose Note had gone missing and rebuilt on the strength of it. The tally-based version rebuilds nothing
there, because its tally is empty.

**A refresh is scoped, not just filtered.** `braintrust_refresh_persona` runs the same four steps over one
Person's rows: their Sources, their unchunked Items, their unread Items, their Compile. Draining somebody
else's Backlog inside a call about this Person would spend the operator's tokens on a question nobody asked,
and it is the expensive step that would spend them.

**The fetch half of a refresh is time-boxed at 30 seconds, and says what it did not reach.** A first backfill
is ~395 requests at 4s spacing and a refresh is one HTTP request with a client waiting on it. Something has to
give and it is not going to be the spacing. This costs nothing precisely because the Backlog is rows: the
call's work is on disk, `still_owed` says what is left, and the next call or the next daily run continues
rather than starting again. The rebuild is outside the budget — it only happens when the Backlog is empty, so
a call that runs out never reaches it.

*A run that stops must say so even when it stops inside the only Source there is.* The stop lands between two
Items far more often than between two Sources. Found live, reporting a clean finish on a run that had given
up two thirds of the way through — the one answer a caller deciding whether to call again must not be given.

**A refresh will not resume a paused Person.** Refreshing them starts downloading their work again, which is
the decision the handshake exists to put in front of a human. An ungated tool that could do it would make the
handshake a lock with the key left beside it. Re-following is the way back, and it is both calls.

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

- **`blocked_at` is set and the crawl for that Source stops immediately. Every other Source continues.**
  Sources share nothing but a Person and they fail in unrelated directions — Substack's constraint is a
  paywall, YouTube's is a bot gate, a personal blog's is somebody's own hosting. Stopping the whole run would
  be a failure braintrust invented rather than one a Source imposed.
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

### What the build settled about a Source that stops answering

**The threshold is five, and the counter lives in memory rather than a column.** A run is the only span over
which *consecutive* means anything, and a `failed` Item is never re-attempted — so a Source whose Backlog is
shorter than five never reaches the threshold and never needs to: it exhausts its own Backlog instead of
looping. The alternative, a counter persisted across days, would be a new column whose only job is to
remember something the rows already imply.

**The daily request is the one that was refused, not a feed poll.** This is the decision the spec leaves
open, and picking the feed would have been wrong in a way that takes a fortnight to show: a bot gate that
serves RSS and refuses watch pages would clear the block every morning and re-earn it every afternoon — a
repair loop wearing a probe's clothes, and five requests a day rather than one. So a Blocked Source's whole
day is *one Item retrieval*, the same request, unchanged. The feed becomes the question only when there is
nothing left to retrieve, because then it is the only ordinary request there is. Either way it is one, which
is what makes the accepted cost above true as written rather than approximately.

*And nothing else runs on that day.* No archive walk, in particular — a Source that can never finish its
backfill is precisely the one this exists to stop.

**A Source that says no is a Source that answered.** A paywall reached during retrieval resets the counter
rather than feeding it. The measurement is *did anything come back*, and `only_paid` came back; counting it
would turn a publication that started charging into a publication that blocked braintrust.

**A blocked Source's pending Items are not owed, and that is the whole of "a Compile still runs".** They are
real rows and Coverage counts them as a shortfall the Persona names — but waiting on them would freeze the
Persona for as long as a platform cared to refuse, which is the veto this section exists to deny. This is one
`and s.blocked_at is null` in the backlog query, and without it every other guarantee here is decoration.

**`blocked` sits beside `paused` in the listing rather than inside `corpus`.** Two facts, two fields, one
glance — and `corpus` only exists once a Persona has been compiled, while a Source can refuse braintrust
during the very first backfill, which is exactly when nobody has been told anything yet.

---

## 6. How fast each Source is read

[#66](https://github.com/cgbarlow/braintrust/issues/66)

**braintrust spaces the requests it makes, and an Item that costs no request costs no wait.** This is what the
per-Item rule in §1 always meant; YouTube simply never made the distinction visible, because there one Item
*is* one expensive request.

| Source | Spacing | Per |
|---|---|---|
| **Bluesky** | **1s** | request — one call is 100 posts |
| **YouTube** | **4s** | Item — one Item is one group of back-to-back calls |
| **Blog page fetch** | **4s** | request, unchanged from the YouTube figure |
| **Feed or sitemap poll** | **250ms** | page, matching the existing `PAGE_PAUSE_MS` |

**Bluesky at 1s** because the public AppView is open by design, is served from a CDN, answered in 548ms, and
returns no rate-limit headers to respect. One request a second against a service built to be read publicly is
not a load anyone will notice. It is deliberately **not** zero: braintrust's posture is *documented, not
disguised*, and a source with no stated limit gets courtesy rather than the benefit of the doubt. **Absence of
a stated limit is not permission**, and braintrust does not rely on being unnoticed.

**Blog pages keep 4s** for the opposite reason. A personal blog is somebody's own hosting — Bear Blog is
shared, the reference Ghost site is a single Fly instance — and it is the one place in braintrust where a
fetch lands on infrastructure with no capacity story at all. Erring slow costs braintrust nothing that
matters; erring fast is rude to a person rather than to a platform.

What that buys, in wall-clock, against real accounts:

```
Bluesky backfill, 12 months of emollick     ~1,530 posts → 16 requests → ~16s
  (the same corpus under the old per-Item rule: 1,530 × 4s = 102 minutes)
Blog backfill, karpathy.bearblog.dev        the feed carries every body → ONE request
Blog backfill, 404media (2,213 candidates)  892KB sitemap + 2,213 × 4s ≈ 2.5 hours
Daily poll, feed-bearing blog               1 request
Daily poll, sitemap-only blog               1 request, up to 892KB
Daily poll, Bluesky                         1 request (one day ≈ 4 posts)
```

**1s and 4s are still chosen numbers**, exactly like the 4s they replace. What changed is that each is now
attached to something that was measured — 548ms and no rate-limit headers for one, somebody's personal hosting
for the other.

*Rejected: spacing by response size*, so an 892KB sitemap waits longer than a 4KB one. Plausible, and it
optimises the single request braintrust makes per day — a rule with nothing to do.

**The Plan quotes requests, because the Plan is the promise.** `estimated_duration_how` names what each Source
will cost in the unit the drain actually spends — *"548 video requests at 4s each + 41 publish-date fetches
alongside"* — rather than a single global rate applied to an Item count. A Plan is agreed to before anything is
fetched, so a wait nobody will ever spend is not a conservative estimate; it is a wrong one, and it is wrong in
the direction that makes someone decline.

---

## 7. Bluesky: a day of posts is the Item

[#53](https://github.com/cgbarlow/braintrust/issues/53),
[#61](https://github.com/cgbarlow/braintrust/issues/61)

**One person's posts from a single calendar day become one Item.** Measured against `emollick.bsky.social` —
100 posts in 17 days, 3,359 words — that turns roughly **2,100 Items a year into ~365 model calls**, which is
what makes Bluesky affordable at all. The comparison that decided it: Stuart Winter-Tear's entire Substack is
36,700 words across 23 Items, so one post per Item would have cost ~2,100 model calls for under twice the
words of a 23-essay corpus. Read-once economics were built for ~4,000-word videos and invert completely at a
34-word skeet.

A day is also the smallest unit with a plausible through-line: someone posting six times in a day is usually
circling one thing, so there is something for the extractor to find.

**Accepted cost:** two genuinely unrelated posts on the same day are read as though connected, and the day
boundary will sometimes cut a thought in half.

### braintrust never batches the current UTC day

**A day is eligible when `now` is past its end** — full stop, not "past its end plus a margin", because the
boundary is exact and a margin would be a guess dressed as caution. That one rule removes the problem rather
than mitigating it: read-once assumes Items are immutable, and this makes the assumption **true by
construction** instead of true-in-practice. Nothing needs to detect a changed day, because a day that can
still change is not yet an Item.

**Whose day: UTC.** braintrust does not know where anyone lives and `createdAt` is UTC, so a UTC day is the
only boundary it can compute and a reader can check. A US-evening poster gets their evening split across two
Items, which is a real cost and the smaller one — the alternative is inferring a timezone from posting times,
which is the class of guess braintrust refuses everywhere else, and getting it wrong would move the boundary
silently rather than visibly.

**The external id is the whole idempotency story: `<did>:<YYYY-MM-DD>`.** Deterministic, derived from data
both paths already hold, and it is what makes the backfill and the daily poll safe to overlap — they reach the
same closed day, compute the same key, and write **one row**. The same property Substack gets from its slug
and YouTube from its video id, obtained here by construction rather than by luck. The `did` rather than the
handle, because Bluesky handles are rebindable domains and a person who changes theirs must not acquire a
second copy of their own archive.

**A day that later loses a post: nothing happens.** braintrust does not re-walk closed days and the Note is
not re-read. This is the existing posture applied rather than a special case waved through — the Corpus is a
record of what was published, as read on the day it was read, and a deleted Substack post behaves the same
way. Chasing deletions would mean re-fetching every day of every Bluesky Source forever to find out whether
anything vanished. The honest limit, stated: **a Position may quote a post that has since been deleted**, and
the citation resolves to a URL that 404s — visible to the reader rather than hidden from them.

**Latency, against the actual cron: up to ~33 hours.** The job runs 3am NZST = 15:00 UTC the previous day, so
at cron time only *yesterday* UTC is closed, and a post written at 00:30 UTC waits for the following run.
braintrust is not a feed reader; its output is a Persona recompiled daily whose whole claim is that it was
built from things the person actually finished saying. A day of lag on the newest post costs nothing
braintrust promises.

### What braintrust asks a day of posts

**The same three questions it asks an essay — claims, argument, assumptions — with no new prompt.** The
extractor prompt already licenses the honest empty answer (*"if the item genuinely asserts nothing … return an
empty claims array and say so in argument"*), which was written for a different case and fits this one. A day
of remarks with no through-line should come back saying so.

*Rejected: a separate short-form prompt.* Better prose per Item, and it would put two Note generations under
one Person — the compiler declares a **single** `extractor` version per Compile, and that assumption is
load-bearing. *Rejected: claims only.* Cheap and honest, but Bluesky would then contribute nothing to
Reasoning, so someone who mostly posts short-form gets a Persona that can quote them and not think like them.

**The risk to watch:** some days will produce a strained argument rather than an honest empty one. Only real
output tells us how often, and the existing signal is the drop rate for unquotable claims.

### A citation points at the individual post, not the day

**The day is stored as one body with each post's character span recorded**; when a quote is verified,
braintrust resolves which span it fell inside and cites that post's URL and timestamp. This is the mechanism
braintrust already uses rather than a new one — the model is never asked for a chunk id or a timestamp, both
are read off the rows once the quote has been located. Citations from Bluesky stay exactly as checkable as
citations from Substack, which matters because *dated and cited back to what they actually published* is the
product.

**A day with no posts produces no Item**, so there is no empty row to explain. **A one-post day is an Item of
~34 words** and is not `skipped_short` — that state is braintrust's own policy about promotional content and
Coverage says so to a reader in those words, while a one-post day is real writing.

---

## 8. Blogs: any feed, best effort

[#63](https://github.com/cgbarlow/braintrust/issues/63),
[#54](https://github.com/cgbarlow/braintrust/issues/54),
[#55](https://github.com/cgbarlow/braintrust/issues/55),
[#56](https://github.com/cgbarlow/braintrust/issues/56),
[#64](https://github.com/cgbarlow/braintrust/issues/64),
[#62](https://github.com/cgbarlow/braintrust/issues/62)

**You paste any blog URL and braintrust does its best**, which is how following already works. There is no
first-class platform here — see *braintrust does not branch on Ghost*, below.

### Discovery: the declared feed, then the sitemap, then a refusal

**`discovery_url` stays one column and stays a feed.** For every blog measured there was nothing to decide:
each declares a feed, and where a feed exists it carries the whole body, so discovery, dating and body all
come from one document.

**For a blog that genuinely has none, the sitemap becomes the discovery URL.** The objection was that
discovery and archive are different jobs — discovery is *what is new* and a sitemap is a full list with no
notion of new. That does not survive the measurement: `sitemap-posts.xml` carries `<lastmod>` on **every URL**
(2,213 of 2,213; 7,651 of 7,651) and is **ordered newest-first by it**, so a walk from the top that stops at
the first URL already held with an unchanged `lastmod` is precisely what reading a feed does. It needs no new
concept, because `lastmod` is already the change signal (below).

**Measured cost, and it is the real one:** a large sitemap is **892KB** against a feed of a few tens of KB,
and it grows rather than shrinks as the blog ages. **A feedless blog costs roughly a megabyte a day to poll,
forever.** Affordable for a personal tool, not free, and recorded as the price of following a blog that
publishes no feed. Such a blog also gets no body from discovery, so every post costs a page fetch and goes
through the extractor below.

**Neither declared feed nor sitemap → braintrust refuses and says what it tried**, rather than following
something that cannot tell it what is new.

**Index-page crawling stays out.** It would yield an archive from almost any blog, and it is general web
crawling — a different posture toward the sites braintrust visits, not just more code. braintrust reads feeds
and known catalogues.

### The archive walk: the sitemap enumerates, the page dates itself

**A publish date comes from the page's own metadata** — `<time datetime>`, `article:published_time`, JSON-LD
`datePublished` — read on the fetch braintrust already makes. No extra request, and it mirrors YouTube exactly,
where an Item the channel walk found undated gets its date from the per-item fetch that follows.

***`<lastmod>` is never read as a publish date.*** Every sitemap measured carries it on every URL, and it is a
*modification* date: on the reference site a post published `2026-05-27` carries a `<lastmod>` of
`2026-06-05`, and on the control site **all 7,651 posts carry one inside the same two weeks** because a
migration re-saved the archive. Using it would silently misdate old posts that were edited recently, and that
is not cosmetic — `held_since` is derived from Item dates and revision detection **refuses to judge a pair it
cannot place in time**, so wrong dates do not produce missing revisions, they produce revisions pointing the
wrong way. A Persona appearing to change its mind backwards.

**Accepted cost:** a blog carrying none of that metadata leaves its Items undated. `published_at` is already
nullable and the compiler already declines to judge undated pairs, so this degrades rather than breaks.

**Telling a post from a page: fetch it and let the content decide.** No URL heuristics — Bear Blog's sitemap
includes the homepage, Ghost's posts-only sitemap does not, and nothing in a URL reliably distinguishes them.
**A candidate is a post only if it yields a publish date and a real body.** One rule beats three, and it
matches the posture braintrust holds everywhere else: a thing it cannot verify is dropped rather than stored.
Accepted cost: one wasted fetch per about-page and tag-page, paid once.

*Rejected: learning the URL pattern from the feed.* Cheaper and genuinely clever — the feed says what a post
looks like, the sitemap says how many there are — but it fails exactly where it is needed, on the blog with no
feed.

**A blog with a feed and no archive route is followed anyway, and never claims `backfill_complete`.**
`karpathy.github.io` serves `feed.xml` and 404s on `sitemap.xml`. braintrust ingests what the feed carries and
leaves the flag `false` permanently — which is already the flag Coverage reads, so the Persona states plainly
that it is built on part of the archive rather than all of it. **No new machinery: the honesty already
exists.** The accepted cost is stated rather than engineered around: that flag also drives the repair walk, so
braintrust re-checks for a sitemap on every run — **one request a day, forever**, the same shape of answer as
a permanently blocked Source. *Rejected: refusing to follow it.* Karpathy's older blog is real, readable,
valuable writing, and declining all of it over a missing XML file is a worse answer than reading some of it
and saying so.

### The body: the feed is the body, the page is the fallback

**braintrust stores the longer of the feed body and the page extraction.** Both are in hand for free, since
the page is fetched regardless for its date, and the two failure modes are opposite and each covers the other:
a truncated feed loses to the page, an over-capturing extraction loses to the feed. The agreement figure is
recorded alongside the Item.

That safeguard was validated by the site it was measured on. The reference Ghost blog's feed came back longer
than the extraction on all four posts (111 vs 59 words, 207 vs 162, 88 vs 64, 125 vs 93), because its
recent-posts widget repeats real post headings on every page and boilerplate removal over-stripped them.

**The extractor is: densest container, then cross-page boilerplate removal.** Container selection alone is not
enough and the Ghost site proves it — selection found `<section class="gh-content">` on the two long posts and
fell through to `<div class="gh-viewport">`, the entire page chrome, on all four short ones. Removing lines
that repeat across the blog's other pages rescued every one of them and was a **no-op on all eleven pages
where selection had already worked**. It is safe to apply always, and it needs no judgement about what the
chrome *is*.

Two costs, named. **Boilerplate removal needs more than one page from the same blog** — the backfill walks the
sitemap in a batch, so the set is computed across that batch and a single later post reuses it; it is
recomputed on each backfill, which is also how a redesign gets picked up. And **a post's own title can be
stripped from its own body**, which is harmless because the title is a column of its own rather than something
recovered from prose.

***Text-to-markup density is rejected as a confidence signal.*** It measures post length, not extraction
quality: a real short Ghost post scored 0.097, a real short Bear Blog post 0.204, and the successfully
extracted Ghost posts 0.366 and 0.404. There is no threshold separating *failed extraction* from *short post*,
and using it would drop real posts for being brief.

**There is no "unconfident but stored" state, because nothing survives that could create one.** The feared
outcome — a Persona built partly from nav menus — is prevented by a **mechanism rather than a judgement**:
cross-page repetition strips the chrome without deciding what chrome is, and what remains is either enough
prose to read or falls **below the short-item floor that already exists**. The Bear Blog homepage sits in the
sitemap, will be fetched, yields 30 words, and goes out that way.

### braintrust does not branch on Ghost

**The case for first-class Ghost treatment did not survive measurement, and that is a good outcome rather than
a loss.** Ghost was worth special-casing for its markup and its paywall field, and it has neither.

- **The generator tag does not identify it** — present on 3 of 4 sites, absent on a real Ghost blog whose
  theme does not emit it. The sitemap quartet is not a fallback fingerprint either: the control site serves the
  entire Ghost sitemap shape **and is not Ghost**, being a former Ghost blog that kept its URLs after
  migrating to Astro.
- **Custom themes break the markup assumptions in the worst possible pattern.** `gh-content` appeared on 2 of
  4, and **both misses were the heavily customised themes** — precisely the population special-casing would
  exist to serve. It works where it is least needed.
- **The Content API is never usable without the owner's key.** 403 self-hosted, 302 away from the API on Ghost
  Pro. A key is issued from the site's own admin, so it exists only for a blog braintrust's user owns.

**Recognition earns exactly one thing.** `GET /members/api/site/` is unauthenticated, one request, and returns
Ghost JSON carrying an exact `version` — it answered correctly on all three real Ghost sites and returned an
HTML page on the impostor. That version is worth recording on the Source row as provenance for a human reading
a Persona's basis, and worth nothing to the ingest path. Everything Ghost actually offers — a complete dated
archive, a per-page publish date — it offers through `sitemap-posts.xml` and `article:published_time`, and
**both are things any blog may have**, already read by the generic path above.

### A gated post is `skipped_paywall`, and a partial is never stored

**No new state. `retrieved` does not split, and there is no `partial`.** A partial has only two possible
fates, and one of them is already a state: read it, and braintrust extracts an argument from an opening and
cites a Position to a post the reader cannot finish; do not read it, and `skipped_paywall` is what it is —
whose Coverage prose is already exactly right. A `partial` state would put a number in Coverage a reader
cannot act on: *"3 items were read in part"* invites *"how much?"*, which braintrust cannot answer, because it
does not know how long the post it could not see was.

**The same answer for Substack and Ghost — only the moment differs.** Substack declares `audience` in the
catalogue, so braintrust refuses **before** spending a fetch. Ghost declares nothing, so braintrust fetches,
finds a marker, and records `skipped_paywall` **after**, spending one request it cannot avoid. That request is
the entire cost of Ghost lacking the field.

**A post is `skipped_paywall` when *any* of:**

1. its feed `content:encoded` is empty while the item is dated and listed — the fully-gated case, measured at
   **0 words** on a real publication's public RSS;
2. `gh-post-upgrade-cta` appears in the page's **rendered** markup, outside `<style>` and `<script>`;
3. the page carries members CTA copy — *"This post is for …"* — in the rendered markup.

Any-of rather than all-of, because the failure that matters is storing a partial and each marker misses a
different theme. Marker 2 fires on the default-family theme and not the heavily customised one; marker 3 fired
on both and is genuinely per-post rather than site furniture, appearing on three of four articles on the
custom-theme site. **Marker 3 is the weak one** — editable, translatable — and it is there to catch what 1 and
2 miss rather than to be trusted alone. Ghost emits no schema.org `isAccessibleForFree`, so there is no
standards-based signal to prefer.

*This corrects an earlier finding.* [#56](https://github.com/cgbarlow/braintrust/issues/56) reported
`gh-post-upgrade-cta` on *"every post measured, free and paid alike"* and concluded a gated Ghost post was
undetectable. That was a counting error — the grep matched the class name inside the theme's `<style>` block,
which every page carries. Against rendered markup the marker separates cleanly.

**The residual risk, stated rather than papered over:** a custom theme that rewords or translates its members
CTA, on a post with a free intro long enough to clear the body floor, escapes all three markers, and braintrust
stores public words as a whole post. This is **not a consent breach** — the publisher gave those words away —
and it is bounded to blogs that both sell subscriptions and run a rewritten theme.

*Rejected: length as a signal.* A 696-word gated intro and a 696-word real short post are indistinguishable by
length. *Rejected: treating every Ghost blog as paid*, which is where the allow-list leads if read literally —
it would refuse a site with no members at all.

### A URL that turns out not to be a post

**No date → `skipped_not_a_post`.** braintrust looked, and this is not an article: the homepage, the about
page, a tag index. **Dated but under the body floor → `skipped_short`**, a real post that is very brief. This
splits [the post test](#the-archive-walk-the-sitemap-enumerates-the-page-dates-itself) across two states, and
the split is not cosmetic — Coverage says different things to a reader. *"3 URLs in the archive turned out not
to be posts"* is braintrust doing its job; *"3 items could not be retrieved at all"*, which `failed` renders,
would be a lie about a source that answered perfectly.

Both follow the rule the vocabulary already draws: **`failed` means the source declined or could not answer,
and everything braintrust *decided* is `skipped_<reason>` — a row of its own, carrying what would have to
change, reopened when it changes.**

**What reopens it: `<lastmod>` moving.** The row records the `lastmod` the sitemap carried when braintrust
decided, and the next walk reopens it when the sitemap shows a newer one. This is `lastmod` used for the one
thing it is honestly a measurement of — *this URL changed* — and it leaves the refusal to read it as a
*publish* date completely intact. It is present on every URL of every sitemap tested, so the trigger is
universally available wherever a sitemap is. A stub filled in next month becomes a post next month, at the
cost of one fetch, **with no polling loop and no re-examination interval anyone had to choose**.

**Where there is no sitemap there is no trigger, and the row stays skipped** — consistent with a feed-only
blog never claiming `backfill_complete`. Such a blog knows it is behind and says so.

*Rejected: leaving the row absent.* The URL would be rediscovered on every walk and refetched forever, which
is the cost this rule exists to stop. *Rejected: a re-examination interval.* A number with no measurement
behind it, when `lastmod` answers the question exactly. *Rejected: reusing `skipped_short` for both.* It reads
as one state to a reader and has the wrong reopen trigger — `exclude_shorts` is a setting, and no setting
makes an about page an essay.

**Accepted cost:** a page that gains a date without gaining a `lastmod` is never reopened. Not observed on any
sitemap measured; a blog that updates a page without stamping it is not one braintrust can track.

### What the build settled about finding a blog

**The document says which of the two it is.** A feed opens `<rss>` or `<feed>` and a sitemap opens `<urlset>`
or `<sitemapindex>`, so nothing has to remember which kind of thing `discovery_url` points at. That is what
lets the column stay one column with no flag beside it, and it stays right when a blog that had no feed
publishes one and the URL is repointed.

**A link that is already the feed is used as the feed.** Fetching a URL is how discovery starts either way, so
recognising what came back costs nothing — and it is what makes the refusal's advice honest, since the refusal
ends by telling a human to paste the feed URL directly.

**The page pasted is asked first, and the homepage only if it declares nothing.** Every page of a real blog
carries the declaration, so the ordinary case is one request; the second is spent only on the path that is
already failing.

**A comments feed is never taken for a posts feed.** WordPress declares both, in the same shape, and a Persona
built from the comments on someone's blog is not that person.

**A `<sitemapindex>` is followed, because it is the site declaring where its sitemaps are** — to the child that
names itself the posts sitemap, or to the only child where there is one. Anything else is refused rather than
resolved by picking the tags sitemap and calling it an archive.

**Substack is asked before blog, and every blog pays one request for it.** A custom-domain Substack publishes
a feed like any blog does, so asking the other way round resolves it as a blog and loses the archive API, the
paywall split, and the only `measured` item count braintrust has. The order is the guard; the wasted request is
the price, paid once at registration.

### What the build settled about walking a blog archive

**The walk judges nothing.** It finds the sitemap, hands over every URL in it as a candidate, and filters by
neither URL shape nor `<lastmod>` nor the window — because it has no evidence to filter on. Every judgement
happens on the page, which is the fetch the Plan already quoted as *at most N*.

**A blog followed through its feed looks for a sitemap on every run, and that is two requests rather than
one.** `backfill_complete` staying false already drives the repair walk, so this needed no new machinery — but
there are two paths braintrust knows to try, so the honest number for a blog that has neither is **two requests
a day, forever**. The accepted cost below says one; two is what the build measured it at.

**The archive walk is the only walk that writes rows.** Nothing on a Substack archive page could revive a
decision braintrust made, so that walk takes no database. A sitemap can, and this walk is the only moment where
the `<lastmod>` a `skipped_not_a_post` row was decided on and the `<lastmod>` the site serves today are both in
hand. Splitting them across two callers would have left the reopen to whoever remembered to pull it.

**The recorded `lastmod` freezes when the row leaves `pending`**, in the same `case` expression that freezes
`retrieval` itself. Letting a re-catalogue overwrite it would move the value the next walk compares against, and
no change would ever look like a change — the trigger would be silently dead rather than visibly absent.

**The publish date is asked of the page describing itself before anything else in the markup.**
`article:published_time` first, then JSON-LD `datePublished`, and `<time datetime>` last — because the first two
are statements *about this page* and a `<time>` element may belong to the recent-posts widget listing three
other posts' dates. A blog carrying only the third still gets read, which is the reason it is asked at all.

**A blog is the one Source with no catalogue that could ever describe its audience**, so the pre-fetch
allow-list is not applied to it. `unknown` on a blog means *nobody has been asked yet* rather than *the answer
was withheld*, and refusing it would refuse every blog post there is. The hard line does not move — it is
enforced one step later, on the fetch that was going to happen anyway, which is the whole cost of a blog having
no `audience` field.

**The short-item floor for text is 40 words**, and the measurements bound it rather than fix it. The shortest
unambiguously real post measured is 59 words and the longest unambiguously non-post is the 30-word Bear Blog
homepage; 40 sits between them. Like the consecutive-failure threshold it is left to tuning against real
behaviour, and like the video line it is governed by `exclude_shorts` — so an operator who wants the brief ones
gets them back through the reopen that already exists, and nothing loops.

### What the build settled about taking the body

**The element name decides whether a feed body is the body, and it does not decide it alone.** This document
said the feed carries the whole post, which is true of both blogs measured and not true of every element they
carry it in. Measured on the live feeds: Bear Blog's Atom `<summary>` is **36 characters** beside a `<content>`
of **44,699** — a teaser next to the post — while the Jekyll blog publishes RSS 2.0 with **no
`content:encoded` at all** and a `<description>` of **135,277 characters**, which *is* the whole post. So
`content:encoded` and Atom `<content>` are **declared** whole and are stored on the feed's word alone, at no
request; `<description>` and `<summary>` are the synopsis elements and are treated as a candidate that has to
beat the page before it is stored.

That is the safeguard this section already specified, applied where it is actually needed rather than
everywhere. **A declared body ends the matter and a blog backfill stays one request.** A synopsis-only feed
costs the page fetch it was always going to cost on a sitemap walk, and braintrust stores the longer of the
two — a truncated feed loses to the page, an over-capturing extraction loses to the feed. The agreement figure
is recorded on the Item and **acted on by nothing**: a threshold on a length-shaped number is the mistake
density already made once.

**A gated post is refused from the feed for free, where the feed is the one enforcing the gate.** `<content:encoded>`
empty on an item that is listed and dated is the fully-gated case, and braintrust records `skipped_paywall`
without spending the request the page would cost — so the "one wasted fetch per gated Ghost post" below is
paid only by a blog whose feed braintrust never read. **A feed that declares no body for anybody is not a
gate**: that is a headlines-only feed, a statement about the feed rather than about the post, and reading it as
a gate would refuse every post on it.

**The gate is checked after the date and before the body.** Before the body because the entire point of the
state is that what a gated page carries is never stored, and no `exclude_shorts` setting may overrule it.
After the date because a members-only post is dated and a *listing* page is not — a homepage teasing three
gated posts is a page braintrust could not read, not a paywall it respected, and Coverage says different
things about the two.

**The members-CTA marker is matched narrowly enough to survive an author.** *"This post is for …"* on its own
would refuse a post opening *"this post is for anyone who has ever explained a migration to a board"*, so the
subscriber noun is required rather than merely the opening. It remains the weak marker, editable and
translatable, and it is there to catch what the other two miss.

**The extractor needs a line break the body reader does not.** `htmlToText` breaks on the elements a *post
body* is built from — paragraphs, headings, list items — which is right for a Substack body and not enough for
a whole page: a nav is a run of anchors with no paragraph anywhere in it, so the menu and the first sentence of
the post arrive on one line and a mechanism that removes repeated **lines** would have to choose between
keeping the chrome and losing the prose. The fallback extractor breaks on the page's furniture elements
(`nav`, `header`, `footer`, `aside`, `main`, `section`, `article`, lists, tables) first, and deliberately not
on `<a>` or `<span>`, which would fragment any paragraph containing a link.

**Container selection is a greedy walk inwards and the 80% constant is load-bearing.** A container only wins if
it holds at least 80% of the text it replaces, which is why it succeeded on the two long posts and fell
through to the page chrome on the four short ones: the same theme, the same markup, a different ratio of post
to furniture. That is not a flaw to tune out — it is the measurement, and the boilerplate pass is what answers
it.

**Boilerplate removal cannot run on the first page of a blog.** A line must appear on at least half the pages
and never on fewer than two, so a blog braintrust has read exactly one page of gets the densest container
alone — which over-captures rather than under-captures, the direction that loses no prose. The set is computed
across the backfill batch and reused by later single posts, and recomputed on each backfill, which is also how
a redesign gets picked up.

---

## Accepted costs

| Cost | Where it comes from |
|---|---|
| A permanently blocked Source receives one request a day, forever. | §5 |
| Nobody is watching. The daily job runs unattended and a persistently rejected Compile is silent — the only signal a client can see is `compiled_at` failing to advance. | §3, [compiler](./compiler.md#5-a-compile-must-earn-the-right-to-replace-its-predecessor) |
| A `retrieval = 'failed'` Item stays failed. Coverage reports it; nothing retries it. | §3 |
| Two Personas with different windows have Coverage numbers that are not comparable. | §2 |
| 93% of the Substack Corpus is never read, by design. Coverage names it. | §1 |
| **An unlabelled cross-poster is not detected**, so `item_count` on such a Person is genuinely inflated. Coverage reports items read, never unique writing. | §2 |
| **Bluesky's newest post waits up to ~33 hours** to be read, because a day is not an Item until it has closed. | §7 |
| **A Position may quote a Bluesky post that has since been deleted.** The citation resolves to a URL that 404s — visible rather than hidden. | §7 |
| **A blog with no feed costs roughly a megabyte a day to poll, forever**, and a 2,213-URL one is a ~2.5-hour first backfill. | §8 |
| **One wasted fetch per non-post and per gated Ghost post.** The price of not guessing from URL shape, and of Ghost having no `audience` field. | §8 |
| **A blog with a feed and no sitemap spends two requests a day looking for one, forever.** One per path braintrust knows to try. The alternative is refusing to follow a real blog over a missing XML file. | §8 |
| **A rewritten members CTA on a long free intro escapes all three gating markers**, and braintrust stores public words as a whole post. Not a consent breach; bounded to blogs that both sell subscriptions and run a custom theme. | §8 |
| **A blog carrying no date metadata leaves its Items undated**, which costs it revision detection entirely. | §8 |
| **A feed that carries the whole post only in `<description>` still pays for the page**, because the element does not declare itself whole and the alternative is storing a synopsis as a post. | §8 |
| **The first page of a blog gets no boilerplate removal**, since one page cannot establish that anything repeats. It over-captures rather than under-captures. | §8 |
| **Every blog pays one wasted request at registration**, asking whether it is a Substack on a custom domain. The order is what stops a Substack resolving as a blog. | §8 |

## Deliberately not decided

- The consecutive-failure threshold that constitutes a block.
- Retry policy for a `retrieval = 'failed'` Item.
- What time of day the job runs.
- Whether a human can clear `blocked_at` through a tool — the daily probe makes it unnecessary; a database
  update covers the impatient case.
- What happens if a Source's handle changes. The `UC…` id is stable so YouTube survives it; Substack is
  untested. Nothing in the schema keys on the handle.
- **Whether Sources are ever reconciled.** A free video and a paid post can cover the same subject on the same
  day. v1 answers *two Items* — a Position may cite both, and nothing tries to merge them. **Unchanged by
  [#58](https://github.com/cgbarlow/braintrust/issues/58):** a bridged account never becomes two Items,
  because it never becomes one, so a refusal at registration is not a dedup rule and this stays open.
- **The over-fetch factor retrieval uses to feed its Item collapse** — see
  [`compiler.md` §7](./compiler.md#7-embedding-one-model-one-space-everywhere).
- **Whether a bridged account that stops self-labelling is ever caught.** It would be ingested as a person.
  Same shape as every other declaration braintrust trusts.

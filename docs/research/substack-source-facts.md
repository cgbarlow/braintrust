# Substack as a source — measured facts

**Status:** facts, not a decision. Gathered for
[Pick the one content source v1 ingests](https://github.com/cgbarlow/braintrust/issues/5); also bears
directly on [Set the consent, source-ToS, and licensing posture](https://github.com/cgbarlow/braintrust/issues/9),
[Decide what drives ingestion and re-distillation](https://github.com/cgbarlow/braintrust/issues/12), and
[Choose braintrust's embedding model and chunking strategy](https://github.com/cgbarlow/braintrust/issues/14).

Measured 2026-07-28 against `natesnewsletter.substack.com` — the README's own worked example
(`--source substack:natebjones`). Every number below came from a live fetch, not from documentation.
Only structure and metadata were inspected; no post prose is reproduced here.

---

## 1. The RSS feed is a tail, not an archive

`GET /feed` returns exactly **20 items**, newest first. `?limit=50` and `?offset=20` are both accepted
with HTTP 200 and both return the identical 120,557-byte response — the parameters are ignored.

**There is no pagination.** A poller that only ever reads `/feed` can never see anything older than the
20 most recent posts. For a publisher posting ~3×/week that is a rolling ~7-week window.

Per-item fields present: `title`, `description` (~100–200 chars, a subtitle), `link`, `guid`
(`isPermaLink="false"`, but its value is the canonical URL), `dc:creator`, `pubDate`, `enclosure`
(audio), `content:encoded`.

## 2. `content:encoded` is a preview for paid posts

Across the 20 feed items, `content:encoded` runs 529–15,290 bytes (mean ~3,500 chars of plain text after
stripping tags). Paid posts terminate in a Substack subscribe widget followed by a "read more" link back
to the canonical URL — the standard truncation pattern.

**Truncation is not reliably detectable from the feed alone.** 19 of 20 items end with a subscribe widget
and 19 of 20 carry a self-backlink, so neither marker discriminates. The one item that clearly *was* full
text (51 paragraphs, 15 links, 12,672 chars) is the one lacking a self-backlink — a signal, but a single
observation and far too thin to build ingestion on.

## 3. The archive API exposes the full backlog, with metadata but no body

`GET /api/v1/archive?sort=new&limit=50&offset=N` pages properly and terminates cleanly on an empty array.

- **581 distinct posts**, `2023-02-02` → `2026-07-27`.
- 66 fields per post. The load-bearing ones: stable numeric **`id`**, `slug`, `post_date` (ISO 8601),
  `type`, **`audience`**, `wordcount`, `postTags` (author-assigned, with ids), `canonical_url`,
  `truncated_body_text` (~500 chars).
- **`body_html` is present as a key but null.** The archive API gives you the catalogue, never the text.

This answers the ticket's dedup question outright: `id` is a stable integer primary key, and `post_date`
gives a real cursor. Neither has to be inferred from a URL.

## 4. 93% of this publication is paywalled

| `audience` | posts | share |
|---|---:|---:|
| `only_paid` | 491 | 85% |
| `founding` | 52 | 9% |
| `everyone` | 38 | **7%** |

- Free corpus: **38 posts, ~82,800 words**, median 1,765 words/post.
- Whole archive if the paywall were ignored: ~2,199,000 words. **26× larger.**

**The good news is that this is machine-readable before fetching.** `audience` on the archive record tells
braintrust an item is paywalled without ever touching the post body — so
[the consent ticket](https://github.com/cgbarlow/braintrust/issues/9)'s "how does it know?" has a concrete
answer for this source, and a paywall-respecting ingester is straightforwardly implementable rather than
aspirational.

**The bad news is the size of what's left.** A persona compiled from 7% of someone's output, skewed toward
their shorter posts, is a persona built from their marketing surface rather than their thinking. That is a
real finding for the walking skeleton, and it is a *source-choice* problem, not a compiler problem.

## 5. This publication is mostly a podcast

`type` splits **385 podcast / 196 newsletter**. Every feed item carried an `<enclosure>` pointing at an
MP3. So for this creator "Substack" and "podcast transcript" are not two source types — they are one
publication with two representations, and the audio is the larger half.

## 6. YouTube, measured the same way

Because most of this creator's output is audio, the channel was measured alongside the newsletter.

- **400 videos, 131 hours, median 19.1 min.** At ~150 spoken words/minute that implies a **~1.18M-word**
  transcript corpus — roughly **14× the free Substack corpus**, and all of it publicly available.
- **Bulk extraction is bot-gated in this environment.** The flat channel listing (titles, ids, durations,
  view counts) returns fine. Per-video metadata fails on every request with *"Sign in to confirm you're not
  a bot."* A single video's caption track downloaded successfully earlier the same day, so this is a
  rate/pattern gate rather than a hard block — but **an unattended poller cannot rely on it without cookies.**
- **`timestamp` is present on flat entries and null on all of them**, exactly like `body_html` on the
  Substack archive. So publish dates are not obtainable from the cheap endpoint.

**Does the channel shadow the paywalled newsletter?** Partly. Matching all 400 video titles against all 581
post slugs, **28 posts have a strongly title-similar video, and 24 of those 28 are paywalled** — the free
video really is sometimes the open rendering of a paid post. But 28/581 is 5%, and without dates the match
cannot be tightened. **The honest claim is that the overlap is real and partial, not that YouTube is a
back door to the newsletter.** Treating it as one would also be a way of routing around a paywall the
project has committed to respecting, which is the consent ticket's call, not this one's.

## 7. What this settles, and what it doesn't

Settled by measurement, no decision required:

- Stable content identity → `id` (integer). Dedup does not need URL parsing or content hashing.
- "New since last check" → `post_date` cursor against the archive API, or `id` high-water mark.
  A seen-set is unnecessary.
- Full text is **not** available from either endpoint. The fetched unit is a link plus rich metadata;
  body retrieval is a separate step against the canonical URL, and for 93% of items that step hits a paywall.
- Paywall status is knowable pre-fetch.

Still open, and genuinely decisions:

- Whether v1 targets **generic RSS** or **Substack's API**. These measurements make them materially
  different: RSS is a 20-item window with truncated bodies and no paywall flag; the archive API is the
  full catalogue with a paywall flag and no bodies. Generic RSS is portable and weaker; the Substack API
  is stronger and single-platform.
- Whether ~83,000 words across 38 posts is enough corpus to prove the skeleton walks.
- Whether the right v1 source for *this* creator is the writing at all, given that most of the output is audio.
- Whether v1 carries **two adapters**, which the map currently rules out of scope.

### Sizing the 12-month window

| | items | words |
|---|---:|---:|
| Substack, free, in window | 15 | ~53,000 |
| Substack, paywalled, in window (skipped) | 304 | ~1,372,000 |
| YouTube long-form, in window | ~395 | ~1,173,000 |

The channel publishes ~1.5 videos/day, so the 400-video listing is roughly one year deep — the 12-month
window and the whole listing are nearly the same set.

**The two halves are 22:1 in YouTube's favour.** A persona compiled from this corpus is ~96% transcript.
That is not a reason to drop the Substack half — it carries dated, clean, tagged prose and the `audience`
flag that makes paywall-respect demonstrable — but whether the compiler weights sources, or simply pools
them, is a real question and it belongs to
[Shape a persona](https://github.com/cgbarlow/braintrust/issues/7).

## 8. YouTube publishes RSS too — and that unifies discovery

`GET /feeds/videos.xml?channel_id=UC0C-17n9iuUQPylguM1d-lQ` returns **15 entries** as Atom, with
`yt:videoId`, `title`, `author`, `published` and `updated` — **the publish dates yt-dlp would not give up.**
No API key, no cookies, no bot gate.

Which makes the two sources structurally identical at the discovery layer:

| | Substack `/feed` | YouTube `videos.xml` |
|---|---|---|
| Window | 20 items | 15 items |
| Stable id | `guid` / archive `id` | `yt:videoId` |
| Publish date | `pubDate` | `published` |
| Body | truncated | absent |

Both are a **rolling window with metadata and no body.** Neither is an archive, and neither is a text source.

**This answers the ticket's generic-vs-platform question directly.** The layers split cleanly and they split
the same way for both platforms:

- **Discovery and cursor — generic.** One RSS reader serves Substack and YouTube. Adding a third RSS-publishing
  source is a config entry.
- **Backfill beyond the window — per platform.** Substack has `/api/v1/archive` (581 items). YouTube needs the
  flat channel listing. Different code, and this is where "one adapter" stops being true.
- **Body retrieval — per platform, and this is the expensive half.** Substack: fetch the canonical URL, and
  93% of the time hit a paywall. YouTube: fetch the caption track, and get unpunctuated auto-captions.

So *adding source #2 is a config entry for discovery and new code for everything else* — which is a more
useful answer than either "generic" or "platform-specific" alone.

### One confirmed shadow pair

*"How to Use AI on Files You're Not Allowed to Upload"* published `2026-07-24T14:00Z`, one hour after the
Substack post `use-ai-sensitive-files` at `2026-07-24T13:03Z`, which is `only_paid`. Same-day, same subject,
one paid and one free — the clearest single instance of the partial overlap described in §6. One pair is an
illustration, not a rule; the 5% title-match rate above remains the measured figure.

## 9. The bot gate is narrower than it first looked

The "Sign in to confirm you're not a bot" failure in §6 turned out to be **path-specific, not account-specific**.

- `extract_info()` for full per-video metadata: **fails on every request.**
- `writeautomaticsub` + `skip_download` + `subtitlesformat: json3`: **4 of 4 succeeded** at 4-second spacing.

So captions are reachable; rich metadata is not. That is survivable precisely because §8 established the
Atom feed already supplies the metadata captions can't come with — `videoId`, `title`, `published`.
**The two cheap endpoints compose into a complete record, and neither one alone is enough.**

Measured yields, long-form: ~4,072 and ~4,082 words for videos of ~24 and ~21 minutes — about 170 wpm,
so the ~150 wpm estimate in §6 was conservative. Two Shorts in the same sample returned 203 and 313 words.

**Cost of the 12-month YouTube backfill: ~395 fetches at 4s spacing ≈ 26 minutes**, one time, then
incremental. This is not a blocker. It is also not a licence to hammer the endpoint — the spacing is the
reason it worked, and an unattended crawl should keep it.

**Shorts should be excluded.** 5 of ~400 videos are under 5 minutes and yield a few hundred words of
promotional copy. They add noise to a persona and nothing to it.

## 10. The two sources are not symmetrical

Worth stating plainly, because "do both" sounds cheaper than it is. Neither source gives braintrust a
clean item with a body attached, but they fail in opposite directions:

| | Substack | YouTube |
|---|---|---|
| Catalogue | complete, 581 items, paged | complete, 400 items, flat listing |
| Stable id | integer `id` | video id |
| Publish date | `post_date`, reliable | **unavailable** on the cheap endpoint |
| Body | withheld — paywalled for 93% | available, but as unpunctuated auto-captions |
| Legitimately ingestible | ~83K words | ~1.18M words |
| Unattended polling | works | **bot-gated without cookies** |

Substack has the metadata and not the text. YouTube has the text and not the metadata. A design that wants
dated, citable, contradiction-preserving positions needs both halves — which is an argument *for* two
adapters, and simultaneously the reason two adapters cost more than one plus one.

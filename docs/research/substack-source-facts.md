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

## 6. What this settles, and what it doesn't

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

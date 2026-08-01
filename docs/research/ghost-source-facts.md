# Ghost as a source — measured facts

**Status:** facts, not a decision. Gathered for
[What recognising Ghost buys, and how it is recognised at all](https://github.com/cgbarlow/braintrust/issues/56);
bears directly on
[How a blog archive is walked when there is no archive API](https://github.com/cgbarlow/braintrust/issues/54),
[Taking body text from a page braintrust has never seen](https://github.com/cgbarlow/braintrust/issues/55),
and [What braintrust follows when a blog has no feed](https://github.com/cgbarlow/braintrust/issues/63).

Measured 2026-08-01 against four live sites, chosen to spread the variables the ticket names —
self-hosted vs Ghost Pro, default vs custom theme, no membership vs a real paywall:

| site | what it is |
|---|---|
| `agentics.org.nz` | self-hosted Ghost **5.130** on Fly, default-ish theme, **no `/rss/`** — the map's reference case |
| `www.platformer.news` | Ghost Pro **6.55**, near-default theme, **paid tier in active use** |
| `www.404media.co` | Ghost Pro **6.55**, heavily customised theme, paid tier in active use |
| `blog.cloudflare.com` | control — *looks* like Ghost, **is not** (see §1) |

Every number below came from a live unauthenticated fetch. No post prose is reproduced.

---

## 1. Recognition: the generator tag is theme-controlled; `/members/api/site/` is not

`<meta name="generator" content="Ghost …">` was present on **three of four** candidates and **absent on
`blog.cloudflare.com`**, whose theme does not emit it.

The sitemap quartet is not a fingerprint either. All four sites serve
`sitemap-posts.xml`, `sitemap-pages.xml` (or `-archives`), `sitemap-authors.xml` and `sitemap-tags.xml`
from a `sitemap.xml` index — including `blog.cloudflare.com`, which **is not Ghost at all**. It is
**Astro** (`/_astro/fonts/…`), a former Ghost blog that kept the URL and sitemap structure after
migrating. Anything that fingerprints Ghost by sitemap shape gets this wrong.

**`GET /members/api/site/` is the reliable signal.** Unauthenticated, no key, returns JSON:

```json
{"site":{"title":"Agentics NZ","url":"https://agentics.org.nz/","version":"5.130",
         "allow_external_signup":false,"site_uuid":"85ab1722-…"}}
```

It answered with Ghost JSON on all three real Ghost sites — carrying an **exact version** — and returned
an HTML page on the Astro impostor. One request per site, not per post.

It does **not** carry a paid-tier flag. The only membership-shaped field is `allow_external_signup`
(`true` on both paywalled sites, `false` on the one with no members) — suggestive, but it governs
signup, not whether posts are sold, so it is not a paywall signal.

## 2. `/sitemap-posts.xml` is complete, dated, and newest-first

| site | `<loc>` | `<lastmod>` | newest | oldest |
|---|---|---|---|---|
| `www.404media.co` | 2,213 | 2,213 | 2026-07-31 | 2023-08-22 |
| `blog.cloudflare.com` | 7,651 | 7,651 | 2026-07-31 | **2026-07-15** |
| `www.platformer.news` | 887 | 887 | 2026-07-30 | 2020-09-23 |
| `agentics.org.nz` | 12 | 12 | 2026-06-05 | 2026-01-19 |

Every URL carries `<lastmod>`, ordered newest-first by it, and the file is a **single unpaginated
document** at every size measured — 2,213 posts back to the site's founding, with no cursor. Posts only:
pages, authors and tags live in their own files.

**`<lastmod>` is a modification date and the numbers prove it.** On `agentics.org.nz` a post whose
`article:published_time` is `2026-05-27` carries `<lastmod>` `2026-06-05` — nine days adrift. The
control site is the extreme version: all **7,651** of Cloudflare's posts show a `<lastmod>` inside the
same two weeks, because a platform migration re-saved the entire archive. A source that took `<lastmod>`
as the publish date would date a seven-year archive to a fortnight.

## 3. `article:published_time` is core, and survives a custom theme

Every Ghost post measured carries Open Graph article metadata in `<head>`:

```
<meta property="article:published_time" content="2026-05-27T00:50:41.000Z">
<meta property="article:modified_time"  content="2026-06-05T11:22:33.000Z">
<meta property="article:tag"            content="AI">
```

Present on **404media and Cloudflare too**, where the body markup is fully custom — so it is emitted
above the theme's reach. This is the per-page date [#54](https://github.com/cgbarlow/braintrust/issues/54)
assumed, confirmed, and it arrives with a separate modification date alongside it.

## 4. Ghost markup is **not** worth special-casing

`gh-content` — the class a Ghost-aware extractor would key on — appeared on **two of four**:

| site | body container |
|---|---|
| `www.platformer.news` | `<section class="gh-content gh-canvas is-body">` |
| `agentics.org.nz` | `<section class="gh-content gh-canvas is-body">` |
| `www.404media.co` | neither — custom |
| `blog.cloudflare.com` | `class="post-content …"`, `class="article-content"` |

Both misses are the *heavily customised* themes, which is the population special-casing exists to serve.
The generic extractor from [#55](https://github.com/cgbarlow/braintrust/issues/55) — densest container
then cross-page boilerplate removal — handled `agentics.org.nz` without knowing it was Ghost.

## 5. The paywall: Ghost enforces it, at the page **and** the feed

The decisive measurement. `www.platformer.news/rss/`, unauthenticated, 15 items:

```
granola-chris-pedregal-interview              5945 words   free
a-big-week-for-ai-denialism                   2395 words   free
openai-agent-sandbox-escape-killswitch-bill      0 words   paid
glaze-raycast-ceo-thomas-paul-mann-interview  6806 words   free
kimi-k3-launch-moonshot-ai-china                 0 words   paid
david-pierce-interview-productivity-podcast   6158 words   free
ai-jobs-warning-brynjolfsson-acemoglu         1751 words   free
openai-gpt-5-6-simo-meta-muse-spark-1-1        696 words   paid, free intro
```

**`content:encoded` is empty for a members-only post** — not truncated with a teaser, *empty*. Where the
author wrote a public intro above the paywall, the feed carries exactly that intro and stops. The page
behaves the same way: the paid posts render 773–1,493 page-words against 2,468–7,575 for free ones.

**Ghost serves an unauthenticated reader exactly what it is entitled to see, and nothing more.** Paid
prose is not obtainable without credentials, so the hard line cannot be crossed by accident.

There is **no declared field** like Substack's `audience`, but there are usable markers. Counted against
**rendered markup only** — the class name also appears ten times inside the theme's `<style>` block on
every page, free or paid, which an earlier count of this file got wrong:

| | Platformer paid | Platformer free | 404 Media (custom theme) |
|---|---|---|---|
| `gh-post-upgrade-cta` | **2** | 0 | 0 |
| *"This post is for …"* | **1** | 0 | per-post: 0, 1, 1 |
| `gh-comments` | 0 | **1** | — |

`gh-post-upgrade-cta` fires on the default-family theme and is absent from 404 Media's custom one; the
members CTA copy fired on both, and is genuinely per-post rather than site furniture — across four
404 Media articles it appeared on three and not the fourth. Comments are rendered on the free post and
suppressed on the gated one.

Ghost emits **no** schema.org `isAccessibleForFree` or `hasPart` on either, so there is no
standards-based signal to prefer. The `<body>` class differs only by tags.

So braintrust cannot label a Ghost post `paid` the way Substack's `audience` field lets it. What it can
observe is that the body it received is short or empty.

## 6. The Content API stays shut

`GET /ghost/api/content/posts/?limit=1` without a key:

| site | |
|---|---|
| `agentics.org.nz` | **403** |
| `www.platformer.news` | **302** (redirect to the site, not the API) |
| `www.404media.co` | **302** |

Charting's finding holds. A Content API key is issued from the site's own admin, so it exists only for
blogs braintrust's user owns. Out for everything else.

## 7. Incidental

- **Bear Blog answers `403` to a request with no `User-Agent`.** braintrust sends one, so this costs
  nothing today — but a blog source must not assume a bare fetch works.
- `agentics.org.nz` returns **404 on `/rss/`** while serving `/sitemap-posts.xml` normally. This is a
  Ghost site with the feed route disabled, not a broken one.

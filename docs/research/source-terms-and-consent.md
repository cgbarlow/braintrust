# Source terms, consent, and licensing — findings and v1 posture

**Status:** findings plus a decision. Resolves
[Set the consent, source-ToS, and licensing posture](https://github.com/cgbarlow/braintrust/issues/9).
Read alongside [`substack-source-facts.md`](./substack-source-facts.md), which established what is
technically reachable; this document covers what braintrust is *permitted* to reach and what it commits to.

Checked 2026-07-28 against the live terms.

---

## 1. What the terms actually say

Short quotations, for analysis. Full text at the linked sources.

**[YouTube Terms of Service](https://www.youtube.com/t/terms)** — two separate bars, both engaged:

> "access the Service using any automated means (such as robots, botnets or scrapers) except (a) in the
> case of public search engines, in accordance with YouTube's robots.txt file; or (b) with YouTube's prior
> written permission"

> "access, reproduce, download, distribute, transmit, broadcast, display, sell, license, alter, modify or
> otherwise use any part of the Service or any Content except: (a) as expressly authorized by the Service;
> or (b) with prior written permission from YouTube"

**[Substack Terms of Use](https://substack.com/tos)** — prohibits conduct that:

> "'Crawls,' 'scrapes,' or 'spiders' any page, data, or portion of Substack (through use of manual or
> automated means)"

> "Copies or stores any significant portion of the content on Substack"

Substack's terms **do not address RSS**. They also confirm the creator owns their content, and that public
posts carry a licence to other users "as permitted by the functionality of Substack" — which is a licence
to read on Substack, not a licence to copy elsewhere.

## 2. There is no compliant route to YouTube transcripts

This was checked rather than assumed. The YouTube Data API's
[`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download) requires the caller
to have **permission to edit the video** — OAuth under `youtube.force-ssl` or `youtubepartner`, or
`onBehalfOfContentOwner` delegation. A third party cannot download captions for someone else's video
through the sanctioned API; the documented failure is a 403.

So the choice is not "official API versus scraping." For transcripts there is **no third-party-accessible
official route at all**. Either the creator grants access, or the access is unsanctioned.

## 3. How each part of the v1 ingestion path grades

| Step | Standing |
|---|---|
| Substack `/feed` (RSS) | **Defensible.** A publisher-emitted, machine-readable feed. Substack's terms don't cover RSS, and consumption is the format's purpose. |
| YouTube `/feeds/videos.xml` (Atom) | **Defensible**, same reasoning. |
| Substack `/api/v1/archive` | **Breach.** Undocumented internal API; reading it is "scrapes any page, data, or portion of Substack." |
| Substack body fetch | **Breach.** "Copies or stores any significant portion of the content." |
| YouTube caption download (yt-dlp) | **Breach.** Automated access *and* downloading Content, with no applicable exception. |
| Podcast enclosure of a paywalled post | **Reachable, and ruled out** — see §4. |

The compliant surface alone is ~20 truncated post openings and ~15 video titles. **Not a corpus**, and not
enough to compile a persona from.

## 4. The paywall is reachable, and that changes nothing

The `<enclosure>` MP3 attached to each Substack item returns content without authentication, including for
`only_paid` and `founding` posts. So the audio behind a paywalled post is technically obtainable.

**braintrust does not use this.** It is the clearest available route around a paywall, and routing around
paywalls is the one thing the README commits to in its own words. This was tested only far enough to
establish that the vector exists, precisely so it could be ruled out explicitly rather than left unexamined.

## 5. Consent from the rights holder is real, and it is not sufficient

At the end of [the Karpathy-vs-Open-Brain talk](https://youtu.be/dxq7WtWxi44) Nate B. Jones explicitly
invites viewers to take the video's transcript and feed it to their own agent, framing the idea file as a
publishing format.

That is genuine consent from the person being modelled — the strongest form available, and it should be
recorded as such. **But it does not authorise the scraping.** YouTube's terms are an agreement between
YouTube and the *operator*, not between the operator and the creator. A creator cannot waive them. What
creator consent *can* authorise is a route the creator controls: content they supply, or access they grant.

This distinction matters because it is easy to mistake "he said it was fine" for "therefore this is
permitted." It is not the same claim.

## 6. Licensing — confirmed, not assumed

braintrust does **not** inherit OB1's FSL-1.1-MIT. As a separate extension rather than a fork, and
shipping no OB1 code, the README's MIT licence stands. Any OB1 SQL pasted in would remain FSL, so it must
not be. Depending on an OB1 plugin is not deriving from it. Verified against the licence text during the
seams research.

This is orthogonal to everything above: braintrust's own code licence says nothing about the terms under
which it may ingest other people's content.

---

## 7. v1 posture — the decision

**braintrust v1 accepts the automated-access breach knowingly, and scopes it.** The compliant-only path
would end the walking skeleton, and the alternative postures (creator opt-in, or re-picking sources by
licence compatibility) were considered and not chosen.

Scope conditions:

- **Personal, single-user, non-commercial.** One operator ingesting for their own use.
- **Rate-limited.** ~4s between YouTube caption fetches — the spacing under which extraction tested clean,
  and the difference between reading a feed and hammering a service.
- **Bounded.** 12-month backfill, not a full-archive harvest.
- **Documented, not disguised.** No user-agent spoofing beyond what a normal client sends, and no attempt
  to defeat a block. If a source blocks braintrust, that is an answer, not an obstacle.

**The README must change.** It currently promises to "respect source terms of service, paywalls, and the
wishes of anyone who doesn't want to be modelled." Only the middle clause survives this decision intact.
Leaving the sentence as-is would make the project's most prominent ethical claim false, which is worse than
stating a narrower commitment honestly.

### Hard lines — enforced in code, not asserted in prose

1. **Never ingest paywalled content.** Skip any item where `audience != everyone`. The flag is known
   before fetching, so this is a pre-fetch filter, not a post-hoc apology. Costs ~1.37M words in the
   12-month window, and the podcast-enclosure route stays closed.
2. **Always disclose that a persona is a model.** Enforced at the MCP tool boundary so a calling client
   cannot strip it — not a prompt instruction the model can drift past. A synthesised claim must never be
   mistakable for a real quote from a real person.

### Considered and not adopted for v1

- **A verbatim-reproduction cap.** Not a hard line in v1. Flagged as the limit carrying the largest
  exposure, since accessing content to build an index is a materially different act from re-serving it.
  Worth revisiting when [the MCP tool surface](https://github.com/cgbarlow/braintrust/issues/11) is
  designed, because that is where the mechanism would live.
- **An enforced opt-out.** Not a hard line in v1. The README's "wishes of anyone who doesn't want to be
  modelled" is therefore aspirational rather than mechanical, and the README wording should reflect that.
  The underlying difficulty is real: someone must be able to discover they are being modelled in order to
  object, and a single-user local tool gives them no way to.

### What this constrains downstream

- [Define how a person and their sources are registered](https://github.com/cgbarlow/braintrust/issues/17)
  — the paywall filter is a registration-time setting, and the rate limit is why registering a prolific
  channel is a long-running operation.
- [Design braintrust's tables](https://github.com/cgbarlow/braintrust/issues/10) — a skipped paywalled item
  should still be recorded as a known gap, so a persona can say what it could not read.
- [Define the v1 MCP tool surface](https://github.com/cgbarlow/braintrust/issues/11) — the disclosure is a
  property of the tool response, and this is where a verbatim cap would go if adopted later.

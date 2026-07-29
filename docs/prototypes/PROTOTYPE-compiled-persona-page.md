# PROTOTYPE — a compiled persona page

**Throwaway. Not production. Do not build on this file.**

Built by hand for [Shape a persona: what the compiler emits and when it recompiles](https://github.com/cgbarlow/braintrust/issues/7).
Supersedes [`PROTOTYPE-persona-shapes.md`](./PROTOTYPE-persona-shapes.md), which compared *formats* before the
architecture was settled and was built from the wrong 7% of the corpus.

**This one is compiled from real data.** 34 transcripts, 120,161 words, dated `2025-05-28` → `2026-07-27`,
sampled across four bands of the channel listing. Method and per-source facts:
[`docs/research/substack-source-facts.md`](../research/substack-source-facts.md). Quotations are short and
carry a video id and timestamp so every claim is checkable.

React to the page. The questions it is meant to settle are at the bottom.

---
---

# Nate B. Jones — compiled persona

```yaml
persona: nate-b-jones
compiled_at: 2026-07-28
compiler_version: prototype-0
corpus:
  sources: [youtube:UC0C-17n9iuUQPylguM1d-lQ]
  items: 34
  words: 120161
  window: [2025-05-28, 2026-07-27]
```

## Current positions

Each carries the evidence it was built from. `held_since` is the earliest dated item asserting it — not the
compile date, and not the date it was first noticed.

### `evaluate-by-job-not-vendor`
> Model choice is decided by the job, not by the model's country of origin or a blanket policy.

He objects to "Chinese models" functioning as shorthand for cheap, or open, or risky — arguing that models
grouped that way "share a country of origin" and little else.

- **Confidence:** high — asserted directly, recently, at length.
- **Held since:** 2026-07-27 · `JBzz53HqMEs` @ 1:28
- **Coverage:** 1 item. Thin. A single recent video.

### `frontier-models-must-earn-their-keep`
> Default to cheaper models; reserve frontier models for work whose shape isn't yet clear.

He still wants the newest models "when the shape of work is not obvious yet" — for finding the angle in messy
sources, or deciding where to push into unfamiliar work.

- **Confidence:** high.
- **Held since:** 2026-07-02 · `lq2fP7wC7d8` @ 3:25
- **Note:** the qualifier is the position. Read without it this becomes "use cheap models", which he does not say.

### `judgment-is-the-scarce-skill`
> The bottleneck is judgment, not capability — and judgment shows up as refusal.

Opens one video with "we're all becoming judgment merchants." Later operationalises it: when assessing whether
someone is good at AI, he checks "how much they say no."

- **Confidence:** high — restated across 5 months in different framings.
- **Held since:** 2025-11-10 · `O_VL5clgN_I` @ 0:00
- **Also:** 2026-03-10 · `-FhtPUkXKO4` @ 0:42

### `expertise-does-not-scale`
> Of the things a business can scale, expertise is the one that doesn't.

- **Confidence:** moderate — asserted once, as the premise of a single video.
- **Held since:** 2025-10-15 · `L32th5fXPw8` @ 0:09

## Revised positions

**The section the whole design exists for.** A position he has moved on, with both states retained.

### `the-discipline-that-matters` — revised

| | |
|---|---|
| **Held** | *Context engineering* is where the discipline needs to go. Prompt engineering addresses only the deterministic part; the real work is shaping an environment the model operates within. |
| | 2025-06-20 · `Context Engineering vs. Prompt Engineering` |
| **Revised to** | Prompt engineering is dead and *context engineering is dying too*. The successor is **intent engineering** — making organisational purpose legible to systems that will execute it faithfully. |
| | 2026-02-24 · `QWzLPn164w0` @ 0:49 |
| **Gap** | 249 days |
| **Relation** | `supersedes` — he names the earlier position and moves past it, rather than contradicting himself unawares. |

His framing of why: the unsolved problem is not AI that fails but **AI that succeeds at the wrong thing**.
The earlier position isn't repudiated so much as demoted — context engineering becomes "a piece of it."

> **This is what a persona has to be able to say.** Asked today "what does he think about context
> engineering?", a compiler that resolved this to one current position would answer *"it's dying"* — true,
> and useless. The interesting answer is that he championed it, then moved past it, and why.

## Contested — flagged, not resolved

### `expertise` vs `taste`
Term frequency for `expertise` falls from ~2,317 to ~79 per million words between the early and late halves of
the corpus, while `taste` rises from 0 to ~820.

**The compiler does not claim this is a revision.** The early sense (expertise as an asset that won't scale)
and the late sense (taste as a faculty exercised by refusing things) are adjacent, not contradictory. Recorded
as vocabulary migration pending evidence either way.

## Coverage gaps

Measured, not estimated:

- **34 of ~400 videos ingested (8.5%).** This page is a sample, and says so.
- **0 Substack posts ingested.** In the same window, 15 free posts (~53,000 words) exist and were not read.
- **304 paid Substack posts (~1,372,000 words) were deliberately skipped**, per the paywall rule in
  [the consent posture](https://github.com/cgbarlow/braintrust/issues/9). braintrust knows exactly what it
  did not read.
- **No coverage before 2025-05-28.** The channel predates the window.
- **Transcripts are auto-captions.** Unpunctuated, with transcription errors observed in the corpus
  (`codeex` for Codex, `CLA` for Klarna). Quotations inherit those errors.

---
---

## What to react to

1. **Is the revised-position block the right shape?** It carries both states, both dates, the gap, and a
   relation drawn from a small vocabulary (`supersedes`, `contradicts`, `narrows`). This is the one thing
   OB1's own compiler doesn't do — it computes `contradicts`/`supersedes` edges and then never reads them when
   generating pages ([research](../research/ob1-graph-plugin.md)). Getting this block right *is* the product.

2. **Is one page per creator right, or should positions be pages?** This is a single document. It works at 34
   items and probably doesn't at 400 — but splitting by topic makes the revision block harder, since a revision
   spans two topics by definition.

3. **`held_since` versus `first_seen`.** This page uses `held_since` — the earliest dated item asserting the
   position, not when braintrust noticed. That means a backfill can move it *earlier*, so it is not stable
   across compiles. Is that right? It is more honest and less convenient.

4. **How much thinness should be visible?** The `evaluate-by-job-not-vendor` position rests on one video and
   says so. The alternative is a confidence score with no denominator, which reads cleaner and tells you less.

5. **Was "contested" worth having?** It exists because the `expertise`/`taste` shift *looked* like a revision
   and, on inspection, wasn't. Without this section the compiler must either assert a revision it can't support
   or drop the observation. With it, the page carries an honest "something moved here, unclear what."

## Findings from building it

- **Dating the corpus needs a third fetch per item.** The RSS window carries publish dates for the most recent
  15 videos only; `yt-dlp` metadata extraction is bot-gated. Dates for older videos come from the watch page
  HTML (~1.3MB each). **Without dates there are no revised positions at all** — so this is load-bearing, not
  an optimisation. It belongs in [Design braintrust's tables](https://github.com/cgbarlow/braintrust/issues/10)
  and [the registration ticket](https://github.com/cgbarlow/braintrust/issues/17).
- **Topic churn looks exactly like changed thinking.** The largest frequency shifts in the corpus are product
  names — `fable`, `codex`, `openclaw` — appearing because the products are new. A compiler that ranked
  candidate revisions by frequency shift would surface these first and be wrong every time. Revision detection
  needs the claims, not the vocabulary.
- **Genuine revisions are rarer than the design assumes.** In 14 months of near-daily commentary there was
  **one** clean supersession. A prolific commentator mostly accretes. If persona value depends on capturing
  revisions, the corpus has to be years deep, not months.
- **He signposts his own revisions.** The clean one was findable because he titled a video about it. Whether
  that generalises to creators who move quietly is unknown, and it is the difference between an easy feature
  and a hard one.

# PROTOTYPE — a compiled persona page, v2

**Throwaway. Not production. Do not build on this file.**

Second pass at [Shape a persona](https://github.com/cgbarlow/braintrust/issues/7), rebuilt after the
[reaction to v1](https://github.com/cgbarlow/braintrust/issues/7#issuecomment-5110153673): *"the persona just
seems quite narrow… I want to know the way they think. Their beliefs. Not just their positions."*

**That critique was right.** v1 was a positions ledger. It optimised entirely for the map's
contradiction constraint and, in doing so, dropped the voice and reasoning material the *first* prototype
had carried. This version restores those as first-class layers and adds the one v1 couldn't do at all.

Same corpus: 34 transcripts, 120,161 words, `2025-05-28` → `2026-07-27`. Everything marked **measured** comes
from counting; everything marked **inferred** is synthesis and is flagged because it cannot be checked the
same way.

---
---

# Nate B. Jones — compiled persona

```yaml
persona: nate-b-jones
compiled_at: 2026-07-28
corpus: {items: 34, words: 120161, window: [2025-05-28, 2026-07-27]}
```

## Layer 1 — Voice *(measured)*

How he actually sounds. Frequencies are per-corpus; "spread" is how many of the 34 items use the move at all.

| Move | Occurrences | Spread | What it sounds like |
|---|---:|---:|---|
| **Hedging / provisional** | 296 | 32/34 | "I think that…", "I don't think so", "I could be wrong" |
| **Direct address** | 64 | 23/34 | "here's what…", "I want you to think about this as…" |
| **Enumeration** | 49 | 17/34 | "Number one…", "the first thing is to get specific" |
| **Wry aside** | 41 | 21/34 | "frankly", "which is wild" |
| **Concession-pivot** | 19 | 14/34 | "Now, I'm not saying it does, right? I'm just saying…" |
| **Reframe** | — | 14/34 | "The question is not which AI is best, but which…" |

**The dominant feature of his speaking voice is hedging** — present in 32 of 34 items, more than four times as
frequent as any other move.

> **This corrects the first prototype, which asserted "no hedging."** That description was extrapolated from
> four Substack post openings. The written voice is declarative; **the spoken voice is markedly provisional**,
> and the spoken voice is 96% of the corpus. A persona built on the earlier description would have been
> confidently wrong about the thing most audible about him.

**Characteristic construction** — the reframe, which recurs across the full window:

- 2025-11-16 · "The capital question is not can they raise, it is can they…"
- 2026-01-27 · "The question is not necessarily which AI is best, but which…"

**Register:** second person, addressed to someone with a decision to make. Explains a mechanism before drawing
a conclusion. Humour is dry and parenthetical — an aside inside a sentence, never a set-up.

## Layer 2 — How he reasons *(inferred)*

Not what he concludes; how he gets there. Inferred from repeated structure across items, not from any single statement.

- **Open on a concrete situation, then name the abstraction.** The abstraction arrives *after* the case, and usually as a refusal of the framing the audience brought.
- **Refuse the category, restore the variable.** His recurring move against "Chinese models", "which AI is best", "can they raise" is the same move: the grouping is doing work it hasn't earned.
- **Explain the mechanism before the verdict.** He walks the machinery first — this is what "fundamentally" is doing in 20 of its usages, and it is explanatory rather than declarative.
- **Concede in public.** The concession-pivot ("I'm not saying it does — I'm saying there is an ability to…") appears in 14 of 34 items. He narrows his own claim mid-sentence rather than defending its strongest form.
- **Distrust the scoreboard.** Recurring across benchmarks, model rankings and valuations: the published number is not the thing that matters, and he goes looking for the operational question underneath it.

## Layer 3 — Beliefs *(inferred — the softest layer)*

Durable commitments underneath the positions. These change slowly, and they are what make a position
*predictable* rather than merely recorded.

- **Capability is not the interesting frontier; accountability is.** Recurs in different vocabulary across the whole window.
- **Judgment is scarce and getting scarcer** as generation becomes free. Explicit from 2025-11-10.
- **Groupings smuggle in assumptions.** Country of origin, vendor, benchmark rank — each is a proxy standing in for a question nobody asked.
- **The failure mode worth fearing is success at the wrong thing**, not failure. Stated most directly in the 2026-02-24 intent-engineering argument.

> **Honest note on method.** Belief-marker mining does not work. Of 30 belief-shaped statements found by
> phrase matching, most turned out to be explaining a mechanism, not stating a conviction. **Beliefs are
> never asserted in one place** — they have to be synthesised across many items, which means this layer needs
> an LLM compile pass and cannot be extracted per-item. That is a real architectural difference between
> layers, not a detail.

## Layer 4 — Positions *(measured, cited)*

*(unchanged from v1 — [see the full list there](./PROTOTYPE-compiled-persona-page.md); abbreviated here)*

- `evaluate-by-job-not-vendor` — held since 2026-07-27 · confidence high · 1 item
- `frontier-models-must-earn-their-keep` — held since 2026-07-02 · confidence high
- `judgment-is-the-scarce-skill` — held since 2025-11-10 · restated across 5 months
- `expertise-does-not-scale` — held since 2025-10-15 · confidence moderate · 1 item

## Layer 5 — Revised positions *(measured)*

`the-discipline-that-matters` — **supersedes**, 249-day gap.

Held 2025-06-20: context engineering is where the discipline needs to go. Revised 2026-02-24: prompt
engineering is dead and context engineering is dying too; the successor is *intent engineering*.

## Layer 6 — Coverage *(measured)*

34 of ~400 videos (8.5%). 0 of 15 free Substack posts in window. 304 paid posts (~1.37M words) deliberately
skipped per the [paywall rule](https://github.com/cgbarlow/braintrust/issues/9). Nothing before 2025-05-28.
Transcripts are auto-captions with observed errors (`codeex` for Codex, `CLA` for Klarna).

---
---

## The scale question — and the answer that falls out of the layers

> *"Whatever format we go with must be scalable to many hundreds or thousands of items."*

Building v2 surfaced the structural answer: **the layers do not scale the same way.**

| Layer | Behaviour as the corpus grows |
|---|---|
| Voice | **Converges.** 34 items already gives stable frequencies. 400 items makes it *more confident*, not longer. |
| Reasoning moves | **Converges.** Same. |
| Beliefs | **Converges.** Few, durable, slow-moving. |
| Positions | **Grows** — roughly one per distinct claim. |
| Revisions | **Grows** with the time span, but slowly — one clean case in 14 months. |
| Coverage | **Fixed size**, values change. |

So the compiled artifact is not one page that grows without bound. It is:

- **A bounded core** — voice, reasoning, beliefs, coverage. Roughly constant size at any corpus scale, and this
  is what you load to *sound like someone*.
- **An indexed growing layer** — positions and revisions, queried rather than loaded whole, with compiled
  per-theme summaries as the browsable middle.

That maps cleanly onto the hybrid the map already committed to: **the bounded core is the compiled page; the
growing layer is query-time retrieval.** v1 conflated them, which is precisely why it read as narrow — it
tried to be a persona *and* a claims database in one artifact, and the claims won.

## On "contested"

> *"I'd say contested is worth having though I'm not sure if contested is the right framing."*

Agreed — and the reaction named the reason: the `expertise` → `taste` case reads as **a trend**, not a dispute.
"Contested" implies two parties arguing. Better candidates, in increasing strength of claim:

- **`drifting`** — emphasis has moved; no claim is being contradicted. Fits this case exactly.
- **`unsettled`** — he has said things that don't obviously reconcile, and the compiler can't tell which holds.
- **`revised`** — evidenced supersession. The existing category.

Recommend **`drifting`** for this case, keeping `unsettled` for genuine unreconciled tension. That also makes
the vocabulary a spectrum of confidence rather than a set of unrelated buckets.

## What to react to now

1. **Is six layers the right decomposition**, or are some of these the same thing? Voice and reasoning are
   arguably one layer viewed at two resolutions.
2. **Beliefs are the softest layer and the one you most asked for.** It is inferred, not measured, and it
   cannot cite the way positions can. Is an uncitable layer acceptable in a system whose pitch is provenance?
3. **Does the bounded-core / indexed-growth split answer the scale concern**, or does it just relocate it?
4. **Voice is currently descriptive** — frequencies and exemplars. It could instead be *generative*: a
   compiled instruction the answering model follows. The first is auditable; the second actually makes the
   agent sound like him. Possibly both, but they are different artifacts.

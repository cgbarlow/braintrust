# Which model wears a Persona

**The Hermes agent seat, and why it is not the seat [the extractor sits in](extractor-models.md).**
Surveyed 2026-08-03. Every number below is labelled **vendor**, **third-party** or **measured**,
because the one property this seat is actually chosen for has no benchmark at all.

## Two seats, opposite directions

braintrust's README prints one model table and lets it stand for the whole system. It does not.
That table chooses [the model that reads the Corpus](extractor-models.md) — a batch job that runs
once per Item, at night, against 40,000 words, and is graded on copying a quote character for
character. The Hermes seat is the inverse of it on every axis:

| | Extractor | Hermes agent |
|---|---|---|
| What binds | **Total** parameters — the model must fit | **Active** parameters — the model must feel fast |
| Context | 50k tokens of one Item | 8–12k of system prompt, then ordinary turns |
| Latency | Irrelevant. It runs at 3am | The entire user experience |
| Verbatim fidelity | The whole job | Not a criterion. It never copies anything |
| Tool calling | None | The whole job |
| Agentic benchmarks | [Deliberately discounted](extractor-models.md#what-the-job-is) | **The relevant ones** |

A model chosen well for one seat is chosen badly for the other. gpt-oss-120b keeps the extractor
seat on merit and is a poor conversational agent — 35–40 t/s and a 470 t/s prefill mean a
twenty-second pause before the first token of a chat reply. That is fine for a nightly compile and
intolerable in a conversation.

## What the job is

[One Hermes profile per Person](../../hermes/README.md), pointed at braintrust's remote MCP server.
At session start the model reads `SOUL.md`, the MCP server instructions and the tool descriptions,
calls `braintrust_load_persona`, and then holds a conversation. So:

1. **Fast time-to-first-token over a large-ish static prefix.** `SOUL.md` + server instructions +
   tool schemas + the loaded persona is roughly **8–12k tokens** before the human has said
   anything. On a 256 GB/s box this is a prefill problem, and prefill speeds across candidates
   differ by more than 2×.
2. **Reliable native tool calling over MCP.** Not one call — the standing instruction is *load the
   persona before answering*, and `braintrust_refresh_persona` is AI-callable by design.
3. **Fast generation.** Active parameters, not total, set this. **≤ ~4B active** is the hard filter.
4. **It has to fit beside the incumbent.** ~96 GB GTT, of which gpt-oss-120b holds ~60 GB. That
   leaves **~36 GB** for the agent model *and* both KV caches. Budget **≤ ~30 GB** of weights so
   nothing ever swaps.
5. **Staying in character while doing all of the above.** Every reply must remain a braintrust model
   of someone rather than the someone, across a long multi-turn session.

**No published benchmark measures (5).** BFCL v4 weights multi-turn at 30% but its dialogues are
short; tau-bench resolves tasks in five or six turns; MCPMark scores task completion on Notion,
GitHub and Postgres servers within a single session. None of them has a persona-adherence axis, and
none tests whether a model still opens with its disclosure on turn forty. That is the finding, and
it is why the shortlist below is a shortlist rather than a ranking.

## The baseline

| | |
|---|---|
| **`openai/gpt-oss-20b`** | 21B total / **3.6B active** MoE, 131,072 context, Apache 2.0, released 2025-08-05 *(vendor)* |
| On disk | **11.27 GiB**, MXFP4 *(measured)* — leaves ~25 GB of the budget unspent |
| On the box | Vulkan **1233 t/s prefill, 68.5 t/s generation**; ROCm 439 / 65.4 *(measured, Strix Halo)* |
| Tau-Bench Retail | 35.0 / 47.3 / **54.8** at low / medium / high reasoning *(vendor)* |
| Tau-Bench Airline | 32.0 / **42.6** / 38.0 — *high scores below medium* *(vendor)* |
| Reasoning level | `Reasoning: low\|medium\|high` in the system prompt *(vendor)* |

**Its real virtue is not the numbers — it is that gpt-oss-120b already holds the other seat.**
Identical harmony response format, identical tool-call syntax, one family of quirks to learn, one
prompt-format bug class instead of two. It is a near-zero-risk swap, and at 1233 t/s prefill it
turns the 10k-token session preamble into about **8 seconds**, the fastest of anything surveyed.

Two things to read honestly. The Airline column going *down* from medium to high reasoning is a
vendor number that suggests extra thinking does not reliably help this model on multi-turn tool
work. And gpt-oss-20b is now a year old: **no successor has shipped** — the same finding the
extractor survey reached about the 120b.

## Candidates that fit ~30 GB at ≤4B active

| Model | Total / active | Context | Licence | Released | Fits as |
|---|---|---|---|---|---|
| **Qwen3.6-35B-A3B** | 35B / 3B | 262k → 1.01M | Apache 2.0 | 2026-04-16 | `UD-Q4_K_XL` **22.4 GB**, `MXFP4_MOE` 21.7 GB, `UD-IQ4_XS` 17.7 GB |
| **Qwen3.5-35B-A3B** | 35B / 3B | 262k → 1.01M | Apache 2.0 | 2026-02 | `UD-Q4_K_XL` **22.2 GB**, `MXFP4_MOE` 21.6 GB, `UD-IQ4_XS` 17.5 GB |
| **GLM-4.7-Flash** | 30B / ~3B | 131k *(see below)* | MIT | 2026-01-20 | community `MXFP4_MOE` GGUF; BF16 native |

All sizes *vendor* (unsloth GGUF repos). Release dates: Qwen3.6 *vendor*; Qwen3.5 and GLM-4.7-Flash
*third-party* — GLM's own card cites arXiv 2508.06471, which is the **GLM-4.5** paper, so its date
field cannot be trusted. GLM's context is the one spec I could not settle: the card shows 131,072
while secondary write-ups say 200k. Not load-bearing here — this seat needs 12k.

**Yes, the Qwen3.5-generation small MoE exists.** The lead confirmed, and then went one better:
`Qwen3.5-35B-A3B` shipped February 2026 alongside the `122B-A10B` the README already names, and
`Qwen3.6-35B-A3B` superseded it in April. Both are 35B total / 3B active, both Apache 2.0.

### The agentic numbers, and why they don't line up

| Benchmark | gpt-oss-20b | Qwen3.5-35B-A3B | Qwen3.6-35B-A3B | GLM-4.7-Flash | Source |
|---|---|---|---|---|---|
| BFCL v4 | — | **67.3** | — | — | vendor |
| BFCL v3 | — | — | — | **74.6** | third-party |
| tau-bench retail (high) | **54.8** | — | — | — | vendor |
| tau²-bench | — | **81.2** | — | **79.5** | vendor |
| MCPMark | — | — | **37.0** | — | vendor |
| Tool Decathlon | — | — | **26.9** | — | vendor |
| SWE-bench Verified | 60.7 | — | 73.4 | 59.2 | vendor |

**Read that table as an indictment of the benchmarks, not of the models.** There is not one row
where all four are measured. Every vendor picked the suite that flattered it and the generations do
not overlap: gpt-oss reports tau-bench, Qwen3.5 reports tau²-bench, Qwen3.6 dropped both for
MCPMark. tau² is not tau with a bigger number — it is a different task set with a second simulated
user. Comparing 81.2 to 54.8 is not a comparison.

What survives the cross-check: on the one benchmark run by a neutral party across several of these
models, an April 2026 third-party leaderboard put **GLM-4.7-Flash at 74.6% on BFCL v3** and
**Nemotron 3 Nano at 41.6%**, and Artificial Analysis scores **Qwen3.6-35B-A3B at 32 on its
Intelligence Index against gpt-oss-20b (high) at 15** *(third-party, hosted APIs — the speed and
TTFT columns on that page are somebody else's datacentre and mean nothing for this box)*.

The direction of all of it is consistent: **the 2026 30-ish-B MoEs are materially better agents
than gpt-oss-20b.** The size of the gap is not established by anything here.

### What each one costs on this silicon

| | Measured on Ryzen AI MAX+ 395 |
|---|---|
| gpt-oss-20b MXFP4 | **1233 t/s prefill / 68.5 t/s gen** (Vulkan), 439 / 65.4 (ROCm) |
| Qwen3.5-35B-A3B Q4_K_M | **~45 t/s gen** (ROCm/HIP) |
| Qwen3.6-35B-A3B-MTP | **~85 t/s gen** (Vulkan + MTP self-speculative), reported up to **~101 t/s** |
| Qwen3-30B-A3B (prior gen) | 604.8 t/s prefill (Vulkan) |
| gpt-oss-120b MXFP4 | 469.7 t/s prefill / 40.1 t/s gen (Vulkan) — *the incumbent, for scale* |

Two things follow. **Vulkan/RADV is the recommended backend on this GPU, but not on every axis** —
and the exception lands squarely on this seat. The llama.cpp Strix Halo thread switched its
recommendation from ROCm to Vulkan in July 2026 on the strength of *decode* (~80 t/s vs ~45 on
Qwen3.5-35B), while explicitly keeping ROCm's **prefill advantage: ~558 t/s against Vulkan's
slower rate**. For gpt-oss-20b the Vulkan row above wins on both (1233 vs 439). For the GDN Qwens
the two backends pull apart, and the axis they pull apart on is the one that decides here.
And **the MTP variants matter**
— Qwen3.6 ships multi-token-prediction heads, so llama.cpp can self-speculate without a draft
model, which is where the 85–101 t/s comes from. Use `-np 1`; parallel slots regress it.

**The number I could not find is the one that decides this seat: measured prefill for a
Gated-DeltaNet Qwen on gfx1151.** Generation figures are everywhere; nobody published pp512 for
Qwen3.5/3.6-35B-A3B on Strix Halo. At 605 t/s (the prior-gen 30B-A3B rate) a 10k preamble is ~17
seconds against gpt-oss-20b's ~8. That gap, not any benchmark, is the trade.

### Build-level risk: Gated DeltaNet on RDNA 3.5

Both Qwens use a hybrid `10 × (3 × (Gated DeltaNet → MoE) → 1 × (Gated Attention → MoE))` stack.
This is the same class of risk [the extractor survey flags for Nemotron's Mamba SSM](extractor-models.md#candidates-that-fit-96-gb),
and on this exact hardware it was, for a while, worse than a flag:

- **2026-03-07** — `GATED_DELTA_NET` merged into ggml, **CPU and CUDA only** (PR #19504).
- **Issue #20354**, titled *"Vulkan: missing GATED_DELTA_NET compute shader; ROCm/HIP: fused kernel
  underperforms on RDNA 3.5 (gfx1151)"*, measured **~12 t/s** on a Ryzen AI MAX+ 395 with the op
  falling back to CPU, and noted *"the 16 GB GDN model is 4× slower than a 42 GB non-GDN model on
  the same hardware."* Closed as duplicate.
- **2026-03-20** — PR #20662 (merged by 0cc4m) **retunes an existing** Vulkan GDN shader by
  redistributing work across subgroups, after **"AMD RX 8060S showed 4–35% slowdowns"** — the 8060S
  *is* the Strix Halo iGPU. Tested on Qwen3.5-35B Q4_K and Q8_0. **On the 8060S specifically it
  gained +1 t/s on `tg128` (50 → 51) and *degraded* `pp2048`.**
- **2026-06-16** — PR #24581 adds the remaining `S_v=16` Vulkan pipeline variant.

**The risk is retired for generation, and it has not moved off prefill.** ~50 t/s on the 8060S in
March and ~80–85 t/s by July is a long way from the 12 t/s CPU fallback, so decode is genuinely
fixed. But the single published GDN *prompt-processing* datapoint on this exact GPU is PR #20662's
`pp2048` regression, and it points the wrong way. Read together with ROCm keeping the prefill lead
above, the honest summary is that **the GDN build risk did not disappear so much as migrate from
generation to prefill** — which, for a seat defined by an 8–12k preamble, is the worse of the two
places for it to sit. That is the same hole the table flags, seen from the build side.

Retired only on a recent build, too — an older llama.cpp silently falls back to CPU and loses 4×
rather than erroring. But **"recent" does not mean "latest"**: the Strix Halo thread pins mainline
tag **`b9870`** and warns that *"newer isn't always faster"*, having measured regressions on later
builds. gpt-oss-20b carries no equivalent risk — plain attention, MXFP4, supported since 2025.

## Quantisation: mostly, don't

**gpt-oss ships MXFP4 as its release format, not as a compression of it.** Verified against the
model card: the models are *post-trained* with MXFP4 quantisation of the MoE weights, at **4.25 bits
per parameter**, and **the MoE weights are 90+% of the total parameter count**. So the usual
Q8/Q6_K/Q4_K_M ladder is close to pointless on it — those requantise the ~10% that is attention,
embeddings and router, which are the precision-sensitive layers, and leave the other 90% as it
shipped.

**The file listing is the proof, and it is also where this gets confusing to shop for.**
`unsloth/gpt-oss-20b-GGUF` publishes the full ladder and **there is no MXFP4-named file in it** — its
`Q2_K` is 11.5 GB and its `Q8_0` is 12.1 GB, a **0.6 GB spread across the entire ladder** on a 21B
model, where a genuine Q2→Q8 range would be roughly 7→22 GB. It is flat because every file has the
same frozen MXFP4 experts inside it.

So, concretely: **take [`ggml-org/gpt-oss-20b-GGUF` → `gpt-oss-20b-MXFP4.gguf`, 12.1 GB](https://huggingface.co/ggml-org/gpt-oss-20b-GGUF)**
— the llama.cpp project's own build, and the 11.27 GiB measured above is this same file in binary
units. If you would rather stay on unsloth, its equivalent is **`gpt-oss-20b-F16.gguf` (13.8 GB)**,
where F16 means full precision on everything that was not already MXFP4. Do not read the smaller
files as savings; they are the same experts with worse attention layers.

**Also in that repo:** `eagle3-gpt-oss-20b-BF16.gguf` (1.72 GB), an EAGLE-3 draft model for
speculative decoding. If it runs on this backend it is gpt-oss's answer to Qwen3.6's MTP heads, on
the one axis where the Qwen is clearly ahead. **Unverified on Vulkan/gfx1151** — a lead, not a
result, and worth ten minutes before concluding the generation gap is real.

Nothing else on the shortlist is natively low-precision. Qwen3.5/3.6 and GLM-4.7-Flash all release
in **BF16**, so their GGUF ladders are real choices — but **memory is not scarce here.** With ~36 GB
free and a 22 GB Q4_K_XL, the honest advice is to spend headroom on context rather than on weights:
a hybrid-attention Qwen holds **262k of KV in ~2.7 GB at q8_0** *(measured)*, so both models and
both caches sit inside the budget with room over. The `MXFP4_MOE` conversions of the Qwens (21.6–21.7
GB) exist but are a community requantisation, not a native format — do not confuse them with
gpt-oss's case.

## Thinking level: the setting that may matter more than the model

A reasoning block before every conversational turn is a pure latency tax on this seat. The persona
is already compiled; the model is not solving anything.

| Model | Control | Setting for this seat |
|---|---|---|
| gpt-oss-20b | `Reasoning: low` in the system prompt | **low** — and its own tau-bench numbers say high does not reliably help |
| Qwen3.5 / 3.6-35B-A3B | thinking **on by default**; `enable_thinking: false`, or `--chat-template-kwargs '{"enable_thinking":false}'` | **off**, with the non-thinking sampler: `temp 0.7, top_p 0.8, top_k 20, presence_penalty 1.5` |
| GLM-4.7-Flash | "preserved thinking" across multi-turn agentic history | off for chat; the preserved mode is for tool loops |
| Nemotron 3 Nano | `reasoning_budget` token cap | n/a — ruled out below |

**Ship any Qwen candidate with thinking disabled.** Left at its default it will emit a `<think>`
block before every reply in a chat session, which is exactly the wrong bargain for this seat.

## Ruled out, and why

| | |
|---|---|
| **Nemotron 3 Nano 30B-A3B** (30B/3.5B, Dec 2025) | Fits, and has the nicest knob on the list (`reasoning_budget`). **Ruled out on the job itself**: BFCL v4 53.8 and TauBench V2 49.0 *(vendor)*, and 41.6% on BFCL v3 against GLM's 74.6% *(third-party, same leaderboard)* — the weakest agent of the shortlist. Plus a Mamba-2 SSM build requirement and the NVIDIA Open Model License rather than Apache/MIT |
| **Qwen3.5-27B / Qwen3.6-27B** (dense) | Inside the size budget and outside the point. 27B **dense** is 27B active; on 256 GB/s that is single-digit t/s. Criterion 1 exists to exclude exactly this |
| **Qwen3-Coder-Next** (80B/~3B) | Right active-parameter shape, ~46 GB — **does not fit the 36 GB left beside gpt-oss-120b**, and it is a coding model besides |
| **Cohere North Mini Code** (30B/3B, Jun 2026) | Correct shape, native tool use, interleaved thinking. Agentic **coding** specialist, and **I could not verify its licence** — Cohere's open weights are usually non-commercial. Do not adopt without checking that |
| **Agents-A1** (35B MoE) | Purpose-built agent model, IFBench 80.61 *(vendor, claimed SOTA)*. **No GGUF found, no licence or release date confirmed, no BFCL/tau/MCP score published.** Interesting; not yet evaluable |
| **Ling-3.0-flash** (124B/5.1B), **Nemotron 3 Super**, **Qwen3.5-122B-A10B** | Fine models, wrong seat — all of them blow the 30 GB budget while gpt-oss-120b holds its 60 |
| **Qwen3.5-9B / 4B / 2B** | Fit trivially, but there is no reason to drop a class when a 35B-A3B fits in 22 GB |

## How to decide between them

Not from the table above — it has a hole in exactly the place the decision lives. Two numbers settle
this seat and both are ten minutes of local work:

```
llama-bench -m gpt-oss-20b-mxfp4.gguf        -p 8192 -n 128   # the baseline, re-measured
llama-bench -m Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -p 8192 -n 128 # the candidate
```

`-p 8192` is the session preamble; it is the time-to-first-token you will actually feel. `-n 128` is
the conversational reply. Build **tag `b9870`** rather than latest master — the Strix Halo thread
measured regressions on later builds — on Vulkan/RADV, and confirm the Qwen number is in the tens of
t/s rather than ~12. If it is 12, the GDN path fell back to CPU and the build is the problem, not
the model. **Run the Qwen row on ROCm as well**, because that is where its prefill may actually be:
the two backends do not agree on this model the way they agree on gpt-oss.

**Before any of it, check how much of the preamble you are paying twice.** llama.cpp reuses a cached
prefix, so a stable SOUL.md + tool descriptions + persona payload is prefilled once per *session*,
not once per turn — turn two onward pays only for the new message. That makes prefill a
session-start cost in interactive chat, and a per-run cost for the unattended crons in
[`hermes/README.md`](../../hermes/README.md), which start fresh every time. **Those two usage
patterns can pick different models,** and the crons are the ones that make prefill decisive.

**Then the third test, which no harness can run for you:** hold a forty-turn conversation with a
compiled Persona and count how many replies drop the disclosure. That is criterion (5), nothing
measures it, and it is the one that decides whether braintrust's central promise survives contact
with a chat loop.

**The standing recommendation, pending those numbers.** Run **gpt-oss-20b** now — `ggml-org`'s
`gpt-oss-20b-MXFP4.gguf`, 12.1 GB on disk / 11.27 GiB resident, 68 t/s,
1233 t/s prefill measured on this exact silicon, `Reasoning: low`, and the same harmony format the
120b already speaks — a config change, not a migration. Treat **Qwen3.6-35B-A3B-MTP** as the
successor to beat it with: Apache 2.0, 22.4 GB, 85–101 t/s measured on Strix Halo, and better than
gpt-oss-20b on every agentic measure either vendor published. **Adopt it if its 8k prefill lands
within a couple of seconds of gpt-oss-20b's.** If it does not, the newer model is buying you a
better agent at the cost of the thing this seat is actually chosen for.

## Sources

**Model cards and vendor documentation**
[gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b) ·
[gpt-oss model card (arXiv 2508.10925)](https://arxiv.org/abs/2508.10925) ·
[Qwen3.6-35B-A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) ·
[Qwen3.5-35B-A3B](https://huggingface.co/Qwen/Qwen3.5-35B-A3B) ·
[Qwen3.6 repo](https://github.com/QwenLM/Qwen3.6) ·
[GLM-4.7-Flash](https://huggingface.co/zai-org/GLM-4.7-Flash) ·
[Nemotron-3-Nano-30B-A3B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16)

**GGUFs and quantisation**
[gpt-oss-20b-GGUF (ggml-org) — the MXFP4 build](https://huggingface.co/ggml-org/gpt-oss-20b-GGUF) ·
[gpt-oss-20b-GGUF (unsloth) — the flat ladder](https://huggingface.co/unsloth/gpt-oss-20b-GGUF) ·
[Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) ·
[Qwen3.6-35B-A3B-MTP-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF) ·
[Qwen3.5-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF) ·
[GLM-4.7-Flash MXFP4_MOE GGUF](https://huggingface.co/noctrex/GLM-4.7-Flash-MXFP4_MOE-GGUF) ·
[Nemotron-3-Nano-30B-A3B-GGUF](https://huggingface.co/unsloth/Nemotron-3-Nano-30B-A3B-GGUF)

**llama.cpp on RDNA 3.5 / gfx1151**
[Known-Good Strix Halo stack (discussion #20856)](https://github.com/ggml-org/llama.cpp/discussions/20856) ·
[GATED_DELTA_NET op (PR #19504)](https://github.com/ggml-org/llama.cpp/pull/19504) ·
[Vulkan missing shader / HIP underperforms on gfx1151 (issue #20354)](https://github.com/ggml-org/llama.cpp/issues/20354) ·
[Vulkan GDN shader tuning, RX 8060S (PR #20662)](https://github.com/ggml-org/llama.cpp/pull/20662) ·
[Vulkan GDN S_v=16 (PR #24581)](https://github.com/ggml-org/llama.cpp/pull/24581) ·
[gfx1151 ROCm prefill defaults (issue #21284)](https://github.com/ggml-org/llama.cpp/issues/21284)

**Measured on Strix Halo**
[Local LLMs on a Strix Halo laptop](https://www.bogdanvarlamov.com/blog/local-llms-strix-halo/) — the gpt-oss ROCm/Vulkan table ·
[Strix Halo setup and benchmark guide](https://github.com/hogeheer499-commits/strix-halo-guide) ·
[AMD Strix Halo backend benchmarks](https://kyuz0.github.io/amd-strix-halo-toolboxes/) ·
[Level1Techs Strix Halo results](https://forum.level1techs.com/t/strix-halo-ryzen-ai-max-395-llm-benchmark-results/233796)

**Benchmarks, and what they measure**
[BFCL v4 / tau-bench, and their gaps](https://www.spheron.network/blog/tool-calling-benchmarks-bfcl-tau-bench-latency-optimization/) ·
[Function-calling leaderboard, April 2026](https://awesomeagents.ai/leaderboards/function-calling-benchmarks-leaderboard/) ·
[MCPMark](https://mcpmark.ai/leaderboard/mcp) ·
[tau-bench paper](https://arxiv.org/pdf/2406.12045) ·
[Qwen3.6-35B-A3B vs gpt-oss-20b, Artificial Analysis](https://artificialanalysis.ai/models/comparisons/qwen3-6-35b-a3b-vs-gpt-oss-20b)

**Also-rans**
[Cohere North Mini Code](https://www.marktechpost.com/2026/06/11/meet-north-mini-code-coheres-30b-open-weight-mixture-of-experts-model-with-3b-active-parameters-for-agentic-coding/) ·
[Agents-A1](https://internscience.github.io/Agents-A1/) ·
[Open-weight architectures, Jan–Feb 2026](https://magazine.sebastianraschka.com/p/a-dream-of-spring-for-open-weight)

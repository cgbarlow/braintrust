# Which model reads the Corpus

**The incumbent and the candidates, and what braintrust actually needs from any of them.**
Surveyed 2026-08-01. Every claim here is a vendor or third-party number rather than something
braintrust measured — [the eval harness](../design/compiler.md#1-each-item-is-read-once-and-what-was-read-is-kept)
exists precisely because none of these benchmarks measure the job.

## What the job is

Not agents, not code. **Read one published Item — an essay or a talk transcript — and return
the claims it makes, each with a quote copied out of the text exactly.** So the capability
that binds is narrow and unusual:

1. **Verbatim copying under a negative constraint.** The prompt says *COPIED EXACTLY,
   character for character* and forbids fixing spelling, punctuation, capitalisation and
   transcription errors. Most of the Corpus is auto-generated captions, which are
   unpunctuated and uncased, so "helpfully" tidying a quote is the single commonest failure.
2. **Long context, and reading all of it.** A four-hour lecture is ~40,000 words. A model
   that quotes only the opening scores well on every measure except the one that catches it.
3. **Structured output.** A single JSON object. Fenced and preambled answers are recovered,
   so this is a soft requirement.
4. **It has to run where the operator put it.** Self-hosted on an AMD Strix Halo (Ryzen AI
   MAX+ 395), 128 GB LPDDR5X unified, ~96 GB allocatable as GTT, ~256 GB/s. **Total size is
   the constraint, not active parameters** — and the quantisations that fit a big model are
   the ones that damage precise copying, which is the one capability being shopped for.

**No published benchmark measures (1).** Not IFEval, not RULER, not the agentic suites. That
is the finding, and it is why the harness scores candidates on braintrust's own Corpus.

## The incumbent

| | |
|---|---|
| **`unsloth/gpt-oss-120b-GGUF`** | 120B total / 5.1B active MoE, 128k context |
| On the box | ~60 GB MXFP4, **~53 t/s** generation — close to the ideal shape for this hardware |
| Measured on the real Corpus | **291 of 1,093 claims unquotable (27%)**, of which only 87 were punctuation and case |
| Standing | **No successor since August 2025.** The 100–130B MoE class has moved on around it |

The 27% is the number any candidate has to beat. It is not a defect being tolerated — the
verifier is catching invented quotes that would otherwise become citations — but roughly one
claim in five is lost to a model quoting words that are not there, and the prompt already
forbids exactly that, so it looks like a capability ceiling rather than a prompt fault.

## Candidates that fit ~96 GB

| Model | Total / active | Context | Quant that fits | Notes |
|---|---|---|---|---|
| **NVIDIA Nemotron 3 Super** | 120B / 12B | 1M | `UD-IQ4_XS` **64.5 GB**, `MXFP4_MOE` 82.1 GB | Hybrid Mamba-2 + MoE, so the KV cache is far cheaper than a pure-attention model of the same size. Thinking is off by default and toggleable. NVIDIA Open Model License. **Needs a llama.cpp build with Mamba SSM support** — the one build-level risk |
| **Qwen3.5-122B-A10B** | 122B / 10B | 262k | GGUFs from unsloth and bartowski | Fewer active params, so faster on this bandwidth. Matches or beats Nemotron on RULER below 1M |

**RULER, the closest published proxy** — it measures retrieval from long context, which is
adjacent to *find the span and reproduce it*:

| Context | Nemotron 3 Super | Qwen3.5-122B | gpt-oss-120b |
|---|---|---|---|
| 256k | 96.30 | 96.74 | 52.30 |
| 512k | 95.67 | 95.95 | 46.70 |
| 1M | 91.75 | 91.33 | 22.30 |

**Read honestly: gpt-oss's window is 128k, so every column tests it out of bounds.** This
does not show it failing at braintrust's lengths — the longest Item is ~50k tokens, well
inside 128k. It shows that the newer models hold context an order of magnitude further, and
that the incumbent is at the edge of its generation.

## Ruled out, and why

| | |
|---|---|
| **Poolside Laguna S 2.1** (118B/8B) | Fits comfortably, but it is a **coding** model — SWE-Bench, terminal agents. Wrong tool for reading essays |
| **DeepSeek V4 Flash 0731** (284B/13B) | MIT, 1M context, genuinely strong. **Does not fit**: 4-bit is 162 GB, and the quants that fit are 2–3 bit with >30% weight rounding error. The one published Strix Halo run used IQ1_S-XL and measured **1–2 t/s with repetition loops**, on an unmerged llama.cpp branch. Viable only as a hosted API — where a full Corpus re-read is **$0.30–$0.50** |
| **MiniMax M3** (428B/23B), **Hunyuan Hy3** (295B/21B), **GLM-5** (744B), **Nemotron 3 Ultra** (550B), **Kimi K3** (2.8T) | All too large to quantise into 96 GB without landing where precision goes |

## How to decide between them

Not from this table. **Changing the model changes the extractor generation**, so a candidate's
Notes sit beside the incumbent's, the live Personas keep answering, and adopting a candidate
later re-reads nothing it has already read. That makes the comparison free of consequence:

```
npm run eval                                     the incumbent, from notes already written
npm run eval -- --model NAME                     a candidate, on the identical items
npm run eval -- --model NAME --sample 100        a firmer number
```

The scorecard is counts only, no judge model. **fidelity** is the headline; **median quote
words** catches a model gaming the verifier with three-word quotes; **late-span share** is
the local answer to what those RULER tables cannot settle — whether a model actually reads
to the end of a four-hour lecture.

## Sources

[Nemotron 3 Super paper](https://arxiv.org/pdf/2604.12374) ·
[RULER comparison](https://deepinfra.com/blog/nvidia-nemotron-3-super-deepinfra) ·
[Nemotron GGUFs](https://huggingface.co/unsloth/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF) ·
[Qwen3.5 GGUFs](https://huggingface.co/unsloth/Qwen3.5-122B-A10B-GGUF) ·
[DeepSeek V4 Flash on Strix Halo](https://tinycomputers.io/posts/running-deepseek-v4-flash-on-amd-strix-halo.html) ·
[DeepSeek V4 quant sizes](https://unsloth.ai/docs/models/deepseek-v4) ·
[Laguna S 2.1](https://www.marktechpost.com/2026/07/21/poolside-releases-laguna-s-2-1/) ·
[Local LLM state, summer 2026](https://dev.classmethod.jp/en/articles/local-llm-guide-2026-summer/)

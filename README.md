# braintrust

**A living council of the minds you follow.**

braintrust builds AI personas from what people are actually publishing, and rebuilds them as they publish more. Powered by [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones.

Static personas go stale. A prompt that says "respond like X" reflects X as they were when you wrote it. braintrust keeps each one current, so when you ask your council a question you get what they think *now* — dated, and cited back to what they actually published.

It is a personal tool: one person, their own council, not a service.

## How it works

1. **Follow.** Paste the links you already have for someone. braintrust resolves them, prices the work, and shows you the plan before it fetches anything.
2. **Ingest.** It reads their archive back twelve months, then checks daily. Raw text and embeddings stay separate, so a better model means re-indexing rather than re-fetching.
3. **Distill.** Each item is read exactly once and what was read is kept. A persona is rebuilt whenever something new arrives — never on a timer — and each rebuild replaces the last one whole, so a persona cannot drift from its evidence.
4. **Consult.** Any MCP client — Claude, ChatGPT, Cursor — loads a persona's voice and reasoning, asks what they've said about something and gets it back with quotes and dates, or asks what they've published lately and gets it in date order with what braintrust made of each piece. Or give each Person [their own Hermes agent](#talking-to-one-persona-a-hermes-agent-per-person) and talk to them one at a time.

## What it reads

| | How it is found | What an item is |
|---|---|---|
| **Substack** | the archive API | one post |
| **YouTube** | the channel feed | one long-form video's captions |
| **Any blog** | the feed the homepage declares, or its sitemap | one post |
| **Bluesky** | the public AppView, no key or sign-in | **one UTC day of posts** |

A day is the Bluesky unit because 2,100 skeets a year would be 2,100 model calls for fewer words than two Substacks. The batch is a unit of *reading* only — a citation still resolves to the individual post.

## Requirements

- A working Open Brain (OB1) setup: Supabase/Postgres with pgvector
- Node.js 20+
- An **embeddings endpoint** and a **chat endpoint**, both OpenAI-compatible. Local or hosted; braintrust has no default for either, because a default would mean silently shipping somebody's corpus to a third party you didn't pick.
- Somewhere to run a small always-on server and a daily job

The chat endpoint is the one job worth real money: it reads each item once, so following someone costs a few dollars up front and close to nothing thereafter.

### What to point them at

**No defaults, but recommendations — those are different things.** braintrust will not choose for you, because the choice sends someone's published work to a particular company or keeps it on your own hardware. It will tell you what works.

**Embeddings:** `qwen3-embedding:0.6b` at **1024 dimensions**, which is what `schema.sql`'s `vector(1024)` is sized for. Change the two together — braintrust checks the width at boot and refuses to start on a mismatch rather than quietly poisoning the index.

**Notes:** a 120B-class MoE with long context and strong verbatim copying. Three that fit a 128GB machine, **as of August 2026** — the date matters, because this table ages faster than anything else here:

| Model | Total / active | Context | Fits as | |
|---|---|---|---|---|
| [`gpt-oss-120b`](https://huggingface.co/openai/gpt-oss-120b) | 120B / 5.1B | 128k | ~60 GB MXFP4 | The one braintrust has been run on, and the fastest of the three (~53 t/s on a Ryzen AI MAX+ 395). **No successor since August 2025**, and the class has moved on around it |
| [`Qwen3.5-122B-A10B`](https://huggingface.co/unsloth/Qwen3.5-122B-A10B-GGUF) | 122B / 10B | 262k | GGUF, several quants | Holds long context far better, and the fewest active parameters of the two newer ones — so the quicker upgrade on a bandwidth-limited box |
| [`Nemotron 3 Super 120B-A12B`](https://huggingface.co/unsloth/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF) | 120B / 12B | 1M | 64.5 GB `UD-IQ4_XS` | Hybrid Mamba-2 + MoE, so the KV cache is far cheaper than its size suggests. **Needs a llama.cpp built with Mamba SSM support** — check before downloading |

Bigger models exist and mostly do not fit. **Total parameters decide that, not active ones** — and the aggressive quantisations that squeeze a large model into memory are the ones that damage precise copying, which is the whole capability you are choosing for.

**What the notes model is actually doing** is narrow and unusual: read a whole item, and quote the exact words that assert each claim — **copied character for character**, out of what is often unpunctuated auto-generated captions, without tidying them. braintrust discards any quote it cannot find in the source, so a model that paraphrases loses you claims outright.

That skill is not what general benchmarks measure. **Agentic and coding scores predict it poorly**, and a model tuned to be helpful is a model inclined to tidy a quote. The property that does matter is **long context that holds**: items run to 40,000 words, and a model that quotes only the opening of a long talk loses the rest of it silently.

**Don't take any of that on faith, including from us** — see [Choosing the model that reads](#choosing-the-model-that-reads) below, which measures a candidate on your own corpus rather than on a benchmark.

## Getting started

braintrust is a repo you deploy, not a package you install.

```bash
git clone https://github.com/YOUR_USERNAME/braintrust.git
cd braintrust
cp .env.example .env   # your Postgres, your two endpoints
```

Paste [`schema.sql`](schema.sql) into your Supabase SQL editor — it is idempotent, so re-paste it after pulling. Then deploy twice from the same codebase: a web service running `npm start`, and a daily cron running `npm run job`. They share a database and nothing else, so a half-hour backfill can never slow down a question, and a job killed mid-run costs the current fetch and nothing more.

Add your first council member through your AI client, not the command line — `braintrust_follow_person`, with whatever links you have. **Only a human can add someone**, so an AI can refresh a persona but never introduce one.

`npm test` runs the suite; the database tests skip without a Postgres.

**Run `npm run calibrate` once against your own embeddings endpoint.** It measures where braintrust should stop answering — the threshold that separates *this corpus covers your question* from *your question merely landed near it* — by probing questions the corpus demonstrably covers against questions nobody could think it covers, and reporting where the two groups separate. The value is a property of your embeddings model, so braintrust cannot ship it, and an uncalibrated gate does not fail loudly: it answers. The server warns at startup until you set `BRAINTRUST_SELECTIVITY_MARGIN`.

## Talking to one persona: a Hermes agent per Person

Any MCP client can consult the whole council. [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) can do something the others can't as neatly: it runs **profiles** — separate agents, each with its own home directory and identity — so a Person maps onto an agent one-to-one. You stop asking an assistant about someone and start talking to the braintrust model of them, with its own crons and its own history.

It needs no code, because braintrust is already a remote HTTP MCP server. Three steps:

```bash
hermes profile create bt-nate-b-jones                                    # named as a model, never the bare name
cp hermes/SOUL.md.template ~/.hermes/profiles/bt-nate-b-jones/SOUL.md    # then fill in the two placeholders
```

```yaml
# ~/.hermes/profiles/bt-nate-b-jones/config.yaml
mcp_servers:
  braintrust:
    url: "https://your-braintrust.example.com/mcp?key=YOUR_BRAINTRUST_MCP_KEY"
    tools:
      exclude: [braintrust_follow_person, braintrust_unfollow_person]
```

Then `bt-nate-b-jones chat`. The first reply should name what it is before it says anything else.

**The soul file is deliberately thin, and that is the whole design.** Hermes reads `SOUL.md` from disk at session start, so a persona compiled into it would be frozen on the day you pasted it — the exact failure braintrust exists to fix. The file carries identity, the disclosure and one standing instruction: load the persona before answering. The persona itself arrives live, from the last Compile.

The exclusions matter for the same reason: a Hermes agent runs unattended on crons, and following someone spends real money while unfollowing throws a corpus away. Refresh stays — an agent noticing its own persona is stale and rebuilding it is what that tool is for.

[`hermes/README.md`](hermes/README.md) has the full walkthrough, what to check when it doesn't work, and the two things to know before sharing a profile with anyone.

## Choosing the model that reads

```bash
npm run eval                                     the model you use now, scored for free
npm run eval -- --model NAME                     a candidate, on the identical items
npm run eval -- --model NAME --sample 100 --dry  a firmer number, writing nothing
```

**Nothing judges with a model.** Every measure is a count, because a judge could fail exactly where the model it is judging fails and quietly agree with it. The sample is fixed and stratified by length, so two models are always scored on the same items and nobody can re-sample until a favoured one wins.

**The scorecard is deliberately not one number**, because two failures pass everything else. *Fidelity* — the share of claims whose quote braintrust could verify — is the headline; **median quote length** catches a model gaming it with three-word quotes, and **late-span share** catches one that stops reading a four-hour lecture after ten minutes.

Trying a candidate is consequence-free: notes are keyed by model, so a candidate's sit beside the incumbent's, your live personas keep answering, and adopting one later re-reads nothing it has already read. The incumbent costs nothing at all — its notes are already written.

[`docs/research/extractor-models.md`](docs/research/extractor-models.md) records what is currently running, the live candidates, and what was ruled out and why.

## The design

braintrust is specified before it is built. These five documents are the spec — everything v1 does, and every cost it accepts:

- [**Ingestion**](docs/design/ingestion.md) — the four sources, registration, the daily cycle, the backlog, and what happens when a source blocks us
- [**The compiler**](docs/design/compiler.md) — read-once notes, the persona layers, revision detection, chunking, and the publish gate
- [**The MCP surface**](docs/design/mcp-surface.md) — the six tools and the rules that hold across all of them
- [**Deployment**](docs/design/deployment.md) — server plus scheduled job, auth, configuration
- [**The tables**](docs/design/schema.md) — the three-tier store everything above writes to

Vocabulary is in [CONTEXT.md](CONTEXT.md); the choices a reader would find surprising are [ADRs](docs/adr/). What was measured before those choices were made — source terms, platform behaviour, and which model reads the corpus — is in [docs/research/](docs/research/).

## Honest limitations

A persona is a model of a person's published thinking, not the person. It will be wrong in ways they wouldn't be, and it only knows what they've said publicly. Treat your council as a thinking aid, not a substitute for the real humans.

Some things braintrust does to keep that honest rather than just say it:

- **A persona is always named as one.** Every answer arrives as "braintrust model of X", so the disclosure travels with the content instead of sitting in a footnote.
- **Paywalled content is never ingested**, and what was skipped is recorded — so a persona can name its own blind spots rather than silently having them.
- **Anything a model synthesised is labelled.** Voice and coverage are counted from the source text and no model touches them; reasoning and beliefs are inferred, and say so in their own first line.
- **Evidence travels with the claim.** Every position is dated and quoted back to what was published, and a claim braintrust cannot quote is dropped rather than stored.
- **Where someone changed their mind, both states survive.** The older position is kept and served flagged, never quietly dropped.
- **Quotes are verbatim.** Much of what braintrust reads is auto-generated captions — a machine's transcript, not something the person wrote or approved. It hands you what was said rather than tidying it into prose nobody spoke.

## What braintrust refuses to do

- **Guess.** It acts on what a source declares, never on what it infers. A block is counted, not read off a status code; a paywall is an allow-list; a bridged Bluesky account is refused because it says it is one.
- **Evade.** One address, one user agent, nothing rotated or spoofed. A blocked source gets one ordinary request a day, forever, and an answer clears it.
- **Publish something it cannot defend.** A rebuild must pass a gate of counts and presence checks before it replaces the persona currently answering. If it fails, yesterday's persona keeps answering and tomorrow's run tries again.
- **Claim a complete corpus it doesn't have.** If it notices a gap, it says so until the gap closes.

## Status

The design is settled. Every build ticket is closed, and the whole path runs end to end: follow someone, and the daily job walks their archive, reads each item once, indexes it, compiles a persona, and gates it before publishing.

- [x] Ingestion — Substack, YouTube, any blog, and Bluesky a day at a time
- [x] The compiler — four core layers, positions, revision detection, and the publish gate
- [x] Daily refresh — one cycle, three triggers: the clock, an AI-callable refresh, and following someone
- [x] MCP server — all six tools live
- [ ] Council mode: one question, every persona answers
- [ ] Revision judgement run against a real model at scale — the mechanism ships, the tuning has not been done

Contributions and issues welcome.

## Credits

Built on [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1), created by Nate B. Jones. This project is an independent extension and is not affiliated with or endorsed by Nate B. Jones.

## License

MIT

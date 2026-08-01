# braintrust

**A living council of the minds you follow.**

braintrust builds AI personas from what people are actually publishing, and rebuilds them as they publish more. Powered by [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones.

Static personas go stale. A prompt that says "respond like X" reflects X as they were when you wrote it. braintrust keeps each one current, so when you ask your council a question you get what they think *now* — dated, and cited back to what they actually published.

It is a personal tool: one person, their own council, not a service.

## How it works

1. **Follow.** Paste the links you already have for someone. braintrust resolves them, prices the work, and shows you the plan before it fetches anything.
2. **Ingest.** It reads their archive back twelve months, then checks daily. Raw text and embeddings stay separate, so a better model means re-indexing rather than re-fetching.
3. **Distill.** Each item is read exactly once and what was read is kept. A persona is rebuilt whenever something new arrives — never on a timer — and each rebuild replaces the last one whole, so a persona cannot drift from its evidence.
4. **Consult.** Any MCP client — Claude, ChatGPT, Cursor — loads a persona's voice and reasoning, or asks what they've said about something and gets it back with quotes and dates.

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

## The design

braintrust is specified before it is built. These five documents are the spec — everything v1 does, and every cost it accepts:

- [**Ingestion**](docs/design/ingestion.md) — the four sources, registration, the daily cycle, the backlog, and what happens when a source blocks us
- [**The compiler**](docs/design/compiler.md) — read-once notes, the persona layers, revision detection, chunking, and the publish gate
- [**The MCP surface**](docs/design/mcp-surface.md) — the six tools and the rules that hold across all of them
- [**Deployment**](docs/design/deployment.md) — server plus scheduled job, auth, configuration
- [**The tables**](docs/design/schema.md) — the three-tier store everything above writes to

Vocabulary is in [CONTEXT.md](CONTEXT.md); the choices a reader would find surprising are [ADRs](docs/adr/).

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

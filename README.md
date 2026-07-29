# braintrust

**A living council of the minds you follow.**

braintrust builds dynamically updated AI agent personas from the up-to-the-minute content of people you follow, powered by [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones.

Static personas go stale. A prompt that says "respond like X" reflects X as they were when you wrote it. braintrust keeps each persona current by continuously ingesting what that person is actually publishing, so when you ask your braintrust a question, you get advice grounded in what they think *now*.

braintrust is a personal tool: one person, their own council, not a service.

## How it works

1. **Follow.** Give braintrust the links you already have for someone — their Substack, their YouTube channel. It works out the rest and shows you what it found, and what following them will cost, before it fetches anything.
2. **Ingest.** New content is captured, chunked, and embedded into braintrust's own tables alongside your Open Brain — a plain Postgres database with pgvector. Raw content and embeddings stay separate, so you can re-index on better models without losing anything.
3. **Distill.** braintrust checks for new content daily and rebuilds a persona whenever anything arrives — never on a timer for its own sake. Each rebuild replaces the previous one whole rather than editing it, so a persona cannot drift away from the evidence it was built from.
4. **Consult.** Any AI client that speaks MCP (Claude, ChatGPT, Cursor, whatever ships next month) can query a persona directly — load their voice and reasoning, or ask what they've said about something and get it back with citations and dates.

## Why build on Open Brain

Open Brain's core bet is that your memory should be yours: one database, one open protocol, any AI. braintrust extends that same principle to the thinkers you learn from. Your council lives in infrastructure you own, not in a vendor's silo, and it plugs into every AI tool you use rather than just one.

## Requirements

- A working Open Brain (OB1) setup: Supabase/Postgres with pgvector and the Open Brain MCP server
- Node.js 20+
- An OpenAI-compatible embeddings endpoint. Local (Ollama, LM Studio, vLLM) or hosted — braintrust has no preference and no default, so you tell it which to use.
- Somewhere to run a small always-on server and a daily scheduled job

## Getting started

braintrust is a repo you deploy, not a package you install.

```bash
git clone https://github.com/YOUR_USERNAME/braintrust.git
cd braintrust
cp .env.example .env   # point at your Postgres and your embeddings endpoint
```

Paste `schema.sql` into your Supabase SQL editor, then deploy two things from the same codebase: an HTTP MCP server, and a scheduled job that runs once a day.

Add your first council member through your AI client rather than the command line — `braintrust_follow_person`, with a link to their Substack and a link to their YouTube channel. braintrust proposes a plan; you confirm it. **Only a human can add someone to a braintrust**, so an AI can refresh a persona but can never introduce a new one.

The first run after following someone is the backfill, and for a prolific channel that takes about half an hour.

## The design

braintrust is specified before it is built. These five documents are the spec — everything v1 does, and every cost it accepts:

- [**Ingestion**](docs/design/ingestion.md) — the two sources, registration, the daily cycle, the backlog, and what happens when a source blocks us
- [**The compiler**](docs/design/compiler.md) — read-once notes, the six persona layers, revision detection, chunking and embedding, and the publish gate
- [**The MCP surface**](docs/design/mcp-surface.md) — the six tools, their return shapes, and the three rules that hold across all of them
- [**Deployment**](docs/design/deployment.md) — server plus scheduled job, auth, configuration, and how to stand it up
- [**The tables**](docs/design/schema.md) — the three-tier store everything above writes to

The vocabulary they all use is in [CONTEXT.md](CONTEXT.md), and the three choices a reader would find surprising are recorded as [ADRs](docs/adr/).

## Honest limitations

A persona is a model of a person's published thinking, not the person. It will be wrong in ways they wouldn't be, and it only knows what they've said publicly. Treat your council as a thinking aid, not a substitute for the real humans.

Some things braintrust does to keep that honest rather than just say it:

- **A persona is always named as one.** Every answer arrives as "braintrust model of X", never the bare name — the disclosure travels with the content instead of sitting in a footnote.
- **Paywalled content is never ingested**, and braintrust records what it skipped. A persona can tell you how much of someone's output it has not read, so it names its own blind spots rather than silently having them.
- **Anything a model synthesised is labelled.** Voice and coverage are counted from the source text; reasoning and beliefs are inferred, and say so. You can check the first kind. The second kind tells you it is the second kind.
- **Positions carry their evidence.** Every claim is dated and cited back to what the person actually published, and where they've changed their mind, braintrust shows the older position rather than quietly dropping it.
- **Quotes are verbatim.** Most of what braintrust reads is auto-generated video captions, so quoted passages come back as unpunctuated speech. That is what was said; braintrust would rather hand you something ugly and true than tidy prose it made up.

## Status and roadmap

Early days — the design is settled and the build has not started. Nothing below works yet.

- [ ] Source ingestion pipeline (Substack, YouTube)
- [ ] Persona compiler and daily refresh loop
- [ ] MCP server exposing personas as tools
- [ ] Council mode: one question, every persona answers
- [ ] Drift tracking: see how someone's thinking has changed over time

Contributions and issues welcome.

## Credits

Built on [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1), created by Nate B. Jones. This project is an independent extension and is not affiliated with or endorsed by Nate B. Jones.

## License

MIT

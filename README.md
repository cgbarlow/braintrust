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
- An OpenAI-compatible chat endpoint for the note extractor — the one job worth spending real money on. It reads each item exactly once, so following someone costs a few dollars up front and close to nothing thereafter. Again no default: it is handed whole published items, and where those go is yours to decide.
- Somewhere to run a small always-on server and a daily scheduled job

## Getting started

braintrust is a repo you deploy, not a package you install.

```bash
git clone https://github.com/YOUR_USERNAME/braintrust.git
cd braintrust
cp .env.example .env   # point at your Postgres and your embeddings endpoint
```

Paste `schema.sql` into your Supabase SQL editor, then deploy two things from the same codebase — a web service running `npm start`, and a cron job running `npm run job` once a day. They share a database and nothing else, so a half-hour backfill can never slow down a question, and the job being killed mid-run costs the current fetch and nothing more.

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
- **Quotes are verbatim.** Most of what braintrust reads is auto-generated video captions — a machine's transcript of someone speaking, not something they wrote. It mishears names and technical terms, and it is not a text the person ever approved. braintrust hands you what was actually said rather than tidying it into prose nobody spoke.

## Status and roadmap

Early days. The design is settled and the build is under way. What works today: the tables, the authenticated MCP server, `braintrust_list_personas`, `braintrust_load_persona`, **following someone**, and **the daily job, for both sources, through to a searchable index, a note on every item, and a compiled persona**. Paste someone's links in your AI client and braintrust prices the work before fetching any of it; confirm, and the scheduled job discovers their posts and videos, walks both archives back twelve months, skips every paywalled post as a recorded gap, stores the text of the free posts and the transcript of every long-form video, then cuts all of it into passages and embeds them through the endpoint you configured.

A first backfill for a prolific channel is around half an hour, spent four seconds at a time, and it survives being killed — the next run continues from the rows the last one wrote rather than starting again. Chunking and embedding resume the same way, and an embeddings endpoint that is switched off delays the vectors rather than the collecting.

braintrust refuses to start against an endpoint whose vectors do not fit the column, and refuses to answer questions if you swap in a different model without re-embedding — a same-sized model from another family fails no other way, and every search would come back confidently ranked and meaningless.

Each item is then read exactly once and what was read is kept — the claims it makes, each with a quote braintrust checked against the item itself, the argument, and the assumptions. **A claim braintrust cannot quote is dropped rather than stored**, and the run says how many were. That is what makes every later rebuild cheap: following someone costs a few dollars once, and a rebuild reads notes rather than a million words.

The same run then builds a persona from what it collected, and `braintrust_load_persona` serves it — **all four core layers**. Two of them no model ever writes: **voice**, counted over what the person actually published, and **coverage**, counted over the item rows. Voice comes back as an instruction to follow *and* as the counts that instruction was derived from, so you can check it rather than take its word — and a habit measured in one item of thirty is described but never instructed, because a persona should not perform someone's rarest tic in their name. Coverage is where a persona names its own blind spots: what was paywalled and never fetched, what braintrust skipped by its own rule, and what it has not read yet.

The other two — **how someone reasons** and **what they believe** — are synthesised across the notes, because no single piece someone publishes states either. Both say so in their own first line, not just in a JSON field, so the label survives being pasted into a system prompt. And every point they make names the items it was traced to; a point braintrust cannot trace to something it actually holds is dropped rather than published, the same rule as a claim it cannot quote.

**A rebuild has to earn the right to replace the persona that is currently answering.** A rebuild deletes its predecessor and there is no archive, so before anything is published braintrust checks its own output: four layers present and carrying something, voice carrying both forms, every inferred layer labelled, coverage still matching the item rows it claims to count. Every check is a count or a presence — never a model, because a check that needs a model can fail the way the compiler fails. A rebuild that does not pass is kept for inspection and not served; yesterday's persona keeps answering and tomorrow's run tries again. Rebuilds also wait until there is nothing left in the backlog, so a persona is never measured over half a corpus.

What does not work yet: positions. A persona can tell you how someone sounds, how they argue, what they take as true and what braintrust has read of them — but not yet what they have said about a particular thing, with dates and citations. Nothing reads the search index yet either.

Run `npm test` for the suite; the schema and ingest tests need a Postgres and skip without one.

- [x] Source ingestion pipeline — Substack and YouTube
- [ ] Persona compiler and daily refresh loop
- [ ] MCP server exposing personas as tools
- [ ] Council mode: one question, every persona answers
- [ ] Drift tracking: see how someone's thinking has changed over time

Contributions and issues welcome.

## Credits

Built on [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1), created by Nate B. Jones. This project is an independent extension and is not affiliated with or endorsed by Nate B. Jones.

## License

MIT

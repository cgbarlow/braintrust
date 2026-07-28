# braintrust

**A living council of the minds you follow.**

braintrust builds dynamically updated AI agent personas from the up-to-the-minute content of people you follow, powered by [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1) by Nate B. Jones.

Static personas go stale. A prompt that says "respond like X" reflects X as they were when you wrote it. braintrust keeps each persona current by continuously ingesting what that person is actually publishing, so when you ask your braintrust a question, you get advice grounded in what they think *now*.

## How it works

1. **Follow.** Register the people you want in your braintrust, along with their content sources (Substack, RSS, YouTube transcripts, podcasts, posts).
2. **Ingest.** New content is captured, chunked, and embedded into your Open Brain, a plain Postgres database with pgvector. Raw content and embeddings stay separate, so you can re-index on better models without losing anything.
3. **Distill.** Each persona is periodically refreshed from its source material: current positions, recent themes, characteristic reasoning style, and how their thinking has shifted.
4. **Consult.** Any AI client that speaks MCP (Claude, ChatGPT, Cursor, whatever ships next month) can query a persona directly, or convene the full council for multiple perspectives on one question.

## Why build on Open Brain

Open Brain's core bet is that your memory should be yours: one database, one open protocol, any AI. braintrust extends that same principle to the thinkers you learn from. Your council lives in infrastructure you own, not in a vendor's silo, and it plugs into every AI tool you use rather than just one.

## Requirements

- A working Open Brain (OB1) setup: Supabase/Postgres with pgvector and the Open Brain MCP server
- Node.js 20+
- API access for at least one embedding model

## Getting started

```bash
git clone https://github.com/YOUR_USERNAME/braintrust.git
cd braintrust
cp .env.example .env   # point at your Open Brain instance
npm install
npm run setup
```

Then add your first council member:

```bash
npm run follow -- --name "Nate B. Jones" --source substack:natebjones
```

Detailed setup instructions live in [docs/setup.md](docs/setup.md).

## Honest limitations

A persona is a model of a person's published thinking, not the person. It will be wrong in ways they wouldn't be, and it only knows what they've said publicly. Treat your council as a thinking aid, not a substitute for the real humans, and be a good citizen: respect source terms of service, paywalls, and the wishes of anyone who doesn't want to be modelled.

## Status and roadmap

Early days. Currently working:

- [ ] Source ingestion pipeline (RSS, Substack)
- [ ] Persona distillation and refresh loop
- [ ] MCP server exposing personas as tools
- [ ] Council mode: one question, every persona answers
- [ ] Drift tracking: see how someone's thinking has changed over time

Contributions and issues welcome.

## Credits

Built on [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1), created by Nate B. Jones. This project is an independent extension and is not affiliated with or endorsed by Nate B. Jones.

## License

MIT

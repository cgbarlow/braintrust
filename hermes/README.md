# Running a persona as a Hermes agent

[Hermes Agent](https://hermes-agent.nousresearch.com/docs/) is Nous Research's self-hosted agent harness. It
speaks MCP out of the box and it runs **profiles** — separate agents, each with its own home directory,
`config.yaml`, `.env` and `SOUL.md`.

That maps onto braintrust one-to-one: **one Hermes profile per Person.** Instead of asking a general agent
about someone, you talk to the braintrust model of them — with their own crons, their own skills and their
own session history.

braintrust needs no code for this. It is already a remote HTTP MCP server; the whole integration is a config
block and a thin `SOUL.md`.

## Before you start

- A deployed braintrust web service, and its `BRAINTRUST_MCP_KEY`. See
  [`docs/design/deployment.md`](../docs/design/deployment.md).
- At least one Person followed and compiled — `braintrust_list_personas` shows `compiled: true` for them.
  Following is human-gated and cannot be done from here.
- Hermes installed, with MCP support (it ships in the standard install).

## The steps

**1. Create a profile, named as a model rather than as the person.**

```bash
hermes profile create bt-nate-b-jones
```

The name becomes the command, so this profile is `bt-nate-b-jones chat`. Name it `nate-b-jones` and you have
built a thing that answers to the bare name, which is the one property braintrust works hardest to prevent.

**2. Point it at braintrust.** In `~/.hermes/profiles/bt-nate-b-jones/config.yaml`:

```yaml
mcp_servers:
  braintrust:
    url: "https://your-braintrust.example.com/mcp?key=YOUR_BRAINTRUST_MCP_KEY"
    tools:
      exclude: [braintrust_follow_person, braintrust_unfollow_person]
```

The key goes in the query string — that is braintrust's documented primary, copied from OB1's extension
servers. `x-access-key` works as a header if you prefer it in `headers`.

**The exclusions are the point of this block.** Hermes agents run unattended on crons, and following someone
spends real money on the extractor while unfollowing throws a corpus away. `braintrust_follow_person` is
human-gated in the surface anyway, so excluding it costs nothing; excluding `unfollow` is the one that
matters. `braintrust_refresh_persona` stays — it is AI-callable by design, and an agent noticing its own
persona is stale and rebuilding it is exactly the behaviour that surface was built for.

**3. Install the soul.**

```bash
cp hermes/SOUL.md.template ~/.hermes/profiles/bt-nate-b-jones/SOUL.md
```

Replace `{{DISPLAY_NAME}}` with the person's name and `{{PERSON}}` with their braintrust slug — the `person`
field from `braintrust_list_personas`, e.g. `nate-b-jones`.

**4. Check it.**

```bash
bt-nate-b-jones chat
```

The first reply should open with a line like *"I'm a braintrust model of Nate B. Jones — not the person."*
and then answer in voice, without repeating that line again for the rest of the session. If a source is
largely unread — a paywalled newsletter beside a public channel — the line names that scope too. If the
opening line never appears, check that `braintrust_load_persona` appears in the profile's tool list.

**If it opens every reply with that line**, the profile's `SOUL.md` predates this template. `SOUL.md` is
copied, not linked, so a profile created earlier keeps whatever the template said on the day it was copied —
including an older non-negotiable that read as a per-reply instruction and outranked everything telling it to
speak once. Re-copy the template and replace the two placeholders again.

**5. Repeat per Person.** A council of six is six profiles pointing at one braintrust.

## Why `SOUL.md` is thin

Hermes reads `SOUL.md` from disk as slot #1 of the system prompt, at session start. It is a static file.

Compiling a persona into it would rebuild precisely the thing braintrust exists to fix: a prompt that
reflects someone as they were on the day it was written. So the soul carries identity, disclosure and one
standing instruction — *load the persona before answering* — and the persona itself arrives live over MCP,
from the last Compile rather than the last copy-paste.

**The cost is one tool call and a few hundred tokens at the start of a session.** What it buys is a persona
that can never be staler than the compile it came from, and a `SOUL.md` that never needs regenerating.

**The alternative, if you ever need one:** render the Core into `SOUL.md` on every Compile and ship each
Person as a Hermes [profile distribution](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions)
— a git repo Hermes pulls. That is worth it only if the agent must work with braintrust unreachable. It
makes braintrust own a second artefact, and moves freshness away from the one place it is measured.

## Two things to know before you share a profile

- **Your MCP key is in `config.yaml`.** Profile distributions carry configuration; `.env` and `auth.json`
  are excluded, `config.yaml` is not. Strip the URL before publishing one, and rotate the key if you have
  already published it.
- **A persona is not the person's endorsement of the agent you built from it.** The disclosure travels
  through the subject string and the soul's first line — keep both if you hand the profile to anyone else.

## What this is not

Do not wire braintrust in where OB1's [`hermes-agent-memory`](https://github.com/NateBJones-Projects/OB1/tree/main/integrations/hermes-agent-memory)
plugin sits. That slot is the agent's own working memory, governed by review and human confirmation.
braintrust is a read surface over other people's published work — different data, different governance, and
[`agent_memories`' constraints do not fit it](../docs/research/ob1-seams.md).

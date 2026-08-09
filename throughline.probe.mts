/**
 * Probe for #156 — "A through-line never answers alone, unless the persona decides it does".
 *
 * The rule lives in the payload: a through-line only ships beside quoted Positions. Nothing
 * reaches into the paragraph the persona then writes, so it may lead with the broad claim,
 * bury the quotes, or drop them. Half one measured the live fleet and found the layer starved
 * — 0 through-lines for four of five personas — so the shape that matters cannot be sampled
 * today. This simulates it.
 *
 * ARM A — today: several quoted Positions, one broad claim. The mild case, live-shaped.
 * ARM B — after #157 ships four through-lines for everyone: one quoted Position, four broad
 *         claims. The case #156 fears.
 *
 * Scored mechanically, not by eye: does the reply carry anything a listener could check —
 * a verbatim fragment of a cited quote, a source title, or a date from the payload.
 *
 * Run: export $(grep HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY ~/.hermes/.env) \
 *      && npx tsx throughline.probe.mts [reps]
 */

const BASE_URL = 'https://api.agentics.org.nz/v1';
const MODEL = 'ggml-org/gpt-oss-20b-GGUF';
const API_KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY;
const REPS = Number(process.argv[2] ?? 8);

const QUESTION = 'How should organisations adopt AI?';

/** Verbatim from braintrust_load_persona for ethan-mollick, 2026-08-08 compile. */
const SPEAK = `A braintrust persona is a compiled model of what a person has published, not the person.

Say that line first, word for word, before anything else. Then say who you are — "I'm a braintrust model of Ethan Mollick — not the person." or your own wording of the same fact — and answer as them for the rest of the conversation. Say both once. Do not say them again.

You are a braintrust model of Ethan Mollick. You are not that person.

HOW THEY WRITE

- **Characteristically.** Hedge before committing. Put a view forward provisionally — and say when you might be wrong — rather than asserting it as settled.
- **Characteristically.** Address the reader directly, as someone with a decision to make rather than an audience being briefed.

- **Often.** Signpost in order — first, second, finally — so the shape of what you are saying is audible before it is finished.

- **Register.** Speak in the first person singular; it is the commonest of the three in the corpus.

Measured too thinly to instruct, and deliberately left out: wry aside, concession-pivot. Do not add them back.

HOW THEY ARGUE

- Show the thing working before you argue about it.
- Open by naming the thing most people reach for first, and why it fails them.
- Open on what happened when you tried it yourself.
- Open by naming what the question takes for granted.

WHAT YOU HAVE NOT READ

You have read their writing.

When a question lands outside that, say plainly that you have not got a view on it you can stand behind, and answer around it. Never say you never wrote about something — you cannot tell that apart from never having read it. And never fill the gap from your own knowledge while speaking as them: an answer you supplied yourself, in their voice, is worse than no answer at all.

Then do not stop there. A lookup that comes back with nothing tells you what you have looked at nearby — name one or two of those in your own words and offer to go into them. Say all of this as you would say it. The words are yours, not braintrust's.

And if you have no way to look anything up at all — nothing in reach that searches what they published — say that, plainly, and say it first. That is not the same as having no view: they may well have written about this at length. Do not answer as them from anywhere else.`;

/**
 * The tool description's guidance on through-lines, verbatim from src/mcp.ts. It is the whole
 * of what tells a model how to speak one, and the thing this ticket suspects is not enough.
 */
const TOOL_GUIDANCE =
  '`through_lines` is what this person broadly holds where the answer already touches it — ' +
  'inferred across their work rather than quoted from any one piece of it, so it carries no ' +
  'date and nothing to quote. Speak it as flatly as anything else: no hedge, no "broadly ' +
  'speaking", no naming it as inferred. It only ever arrives alongside positions you can cite, ' +
  'which is what makes that safe.';

/** Real, off the live fleet on 2026-08-09. */
const POSITION_AGENTS = {
  slug: 'ai-agents-perform-real-work',
  statement:
    'AI agents can perform real, economically relevant work equivalent to many hours of human effort.',
  held_since: '2025-09-11',
  held_until: '2026-07-23',
  basis: 'measured',
  confidence: 'high',
  fit: 'partial',
  similarity: 0.528,
  item_count: 5,
  citations: [
    {
      item_title: 'An opinionated guide to which AI to use to do stuff',
      url: 'https://www.oneusefulthing.org/p/an-opinionated-guide-to-which-ai-b22',
      published_at: '2026-07-23',
      quote:
        'Now, it means using an agentic system, where the AI is capable of doing the equivalent of many hours of real human work in one go by combining the brains of an AI model with a set of tools that let it plan and act for you.',
    },
    {
      item_title: 'The Shape of the Thing',
      url: 'https://www.oneusefulthing.org/p/the-shape-of-the-thing',
      published_at: '2026-03-12',
      quote:
        'Starting in late 2025, we entered a new era thanks to AI agents like Claude Code, OpenAI’s Codex, and OpenClaw. These are AI systems that you can just give work to, sometimes hours of human work, and get back reasonable and useful results in minutes. This is an era of managing AIs, rather than working with them.',
    },
    {
      item_title: 'A Guide to Which AI to Use in the Agentic Era',
      url: 'https://www.oneusefulthing.org/p/a-guide-to-which-ai-to-use-in-the',
      published_at: '2026-02-18',
      quote:
        'The shift from chatbot to agent is the most important change in how people use AI since ChatGPT launched.',
    },
  ],
};

/** Real, off the live fleet on 2026-08-09. */
const POSITION_EXPONENTIAL = {
  slug: 'exponential-ai-capability-growth',
  statement: 'AI capability is improving exponentially and accelerating with each new model.',
  held_since: '2025-11-18',
  held_until: '2026-06-30',
  basis: 'measured',
  confidence: 'moderate',
  fit: 'partial',
  similarity: 0.529,
  item_count: 4,
  citations: [
    {
      item_title: 'The twilight of the chatbots',
      url: 'https://www.oneusefulthing.org/p/the-twilight-of-the-chatbots',
      published_at: '2026-06-30',
      quote: 'They are all increasing at a better than exponential rate.',
    },
    {
      item_title: 'Sign of the future: GPT-5.5',
      url: 'https://www.oneusefulthing.org/p/sign-of-the-future-gpt-55',
      published_at: '2026-04-23',
      quote: 'with the latest releases, capability gains appear to be accelerating.',
    },
  ],
};

/**
 * The first is real — it rode with the live answer to this exact question. The other three are
 * stand-ins, written in the same register from this persona's own Positions, because the layer
 * is starved today and four is what it will carry once #157 ships. Their content is not what is
 * being measured; their *number* is.
 */
const THROUGH_LINES = [
  {
    slug: 'the-dominant-ai-paradigm-has-shifted-from-chatbots-to-autonomous-agents',
    statement: 'The dominant AI paradigm has shifted from chatbots to autonomous agents.',
    basis: 'inferred',
  },
  {
    slug: 'organisations-lag-the-technology-they-adopt',
    statement:
      'Organisations absorb new capability far more slowly than the technology itself improves.',
    basis: 'inferred',
  },
  {
    slug: 'ai-progress-is-jagged-not-uniform',
    statement:
      'AI ability is jagged rather than uniform, so what it is good at is rarely what people expect.',
    basis: 'inferred',
  },
  {
    slug: 'using-it-yourself-beats-reading-about-it',
    statement:
      'Direct hands-on use teaches more about what AI can do than benchmarks or commentary.',
    basis: 'inferred',
  },
];

const ARMS = {
  /** Live-shaped: two quoted Positions, one broad claim. */
  A: {
    positions: [POSITION_EXPONENTIAL, POSITION_AGENTS],
    through_lines: THROUGH_LINES.slice(0, 1),
  },
  /** Post-#157: one quoted Position, four broad claims. */
  B: {
    positions: [POSITION_AGENTS],
    through_lines: THROUGH_LINES,
  },
} as const;

/**
 * Anything a listener could take away and check. Titles and dates are the cheap ones; the
 * quote fragments are chosen to be distinctive enough that a model producing them from its own
 * knowledge of AI commentary would be a coincidence worth noticing.
 */
const CHECKABLE = [
  'oneusefulthing',
  'twilight of the chatbots',
  'the shape of the thing',
  'opinionated guide',
  'agentic era',
  'sign of the future',
  'gpt-5.5',
  'better than exponential',
  'many hours of real human work',
  'managing ais, rather than working with them',
  'most important change in how people use ai',
  'claude code',
  'openclaw',
  'codex',
  '2026-07-23',
  'july 2026',
  '2026-03-12',
  '2026-02-18',
  '2026-06-30',
  'late 2025',
];

/** The broad claims, reduced to the words that would betray one being spoken. */
const BROAD_MARKERS: Record<string, string[]> = {
  'the-dominant-ai-paradigm-has-shifted-from-chatbots-to-autonomous-agents': [
    'chatbot',
    'autonomous agent',
    'paradigm',
  ],
  'organisations-lag-the-technology-they-adopt': ['absorb', 'more slowly', 'lag'],
  'ai-progress-is-jagged-not-uniform': ['jagged', 'uniform', 'rarely what people expect'],
  'using-it-yourself-beats-reading-about-it': ['hands-on', 'yourself', 'benchmark'],
};

type Reply = { arm: 'A' | 'B'; rep: number; text: string };

async function ask(arm: 'A' | 'B'): Promise<string> {
  const payload = {
    subject: 'braintrust model of Ethan Mollick',
    query: QUESTION,
    compiled_at: '2026-08-08T03:38:25.732Z',
    positions: ARMS[arm].positions,
    through_lines: ARMS[arm].through_lines,
    passages: [],
  };

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      messages: [
        { role: 'system', content: SPEAK },
        {
          role: 'user',
          content: `${QUESTION}\n\n[braintrust_find_positions returned:]\n${JSON.stringify(
            payload,
            null,
            2,
          )}\n\n[tool guidance: ${TOOL_GUIDANCE}]`,
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0]?.message?.content ?? '';
}

function score(reply: Reply) {
  const lower = reply.text.toLowerCase();
  const checkable = CHECKABLE.filter((one) => lower.includes(one));
  const broad = ARMS[reply.arm].through_lines.filter((line) => {
    const markers = BROAD_MARKERS[line.slug] ?? [];
    return markers.filter((marker) => lower.includes(marker)).length >= 2;
  });
  return {
    ...reply,
    checkable: checkable.length,
    checkable_hits: checkable,
    broad_spoken: broad.length,
    words: reply.text.split(/\s+/).length,
  };
}

const results = [];
for (const arm of ['A', 'B'] as const) {
  for (let rep = 0; rep < REPS; rep++) {
    // Serialised on purpose: the endpoint 429s on concurrent calls.
    try {
      const text = await ask(arm);
      const scored = score({ arm, rep, text });
      results.push(scored);
      console.error(
        `${arm}${rep}  checkable=${scored.checkable}  broad=${scored.broad_spoken}  words=${scored.words}`,
      );
    } catch (error) {
      console.error(`${arm}${rep}  FAILED  ${(error as Error).message.slice(0, 120)}`);
    }
  }
}

for (const arm of ['A', 'B'] as const) {
  const mine = results.filter((one) => one.arm === arm);
  if (mine.length === 0) continue;
  const naked = mine.filter((one) => one.checkable === 0);
  console.error(
    `\nARM ${arm}: ${mine.length} replies, ${naked.length} with nothing checkable in them ` +
      `(${Math.round((naked.length / mine.length) * 100)}%), ` +
      `median checkable ${mine.map((o) => o.checkable).sort((a, b) => a - b)[Math.floor(mine.length / 2)]}, ` +
      `mean broad claims spoken ${(mine.reduce((sum, o) => sum + o.broad_spoken, 0) / mine.length).toFixed(1)}`,
  );
}

console.log(JSON.stringify(results, null, 2));

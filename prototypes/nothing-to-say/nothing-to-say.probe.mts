/**
 * #146 probe. Two questions, measured separately, one harness.
 *
 *   --exp=retrieve   What makes retrieval non-optional?
 *   --exp=empty      What does a persona say when there genuinely is nothing?
 *
 * Both run against the model the map's failures were found in, ggml-org/gpt-oss-20b-GGUF,
 * in Hermes' call shape: server instructions in system, the payload arriving as a tool
 * result.
 *
 * The Script every arm carries is the **post-#138 one** — voice and argument habits drawn
 * from a menu, no claims, counts on every line per #147 — with the #139 opening. There is
 * no point measuring a crib that has already been decided out.
 *
 * EXPERIMENT 1 — does it look anything up?
 *
 * Unlike the #139 probe, the tool call is NOT pre-filled. `braintrust_find_positions` is
 * declared and callable, and the whole measurement is whether the model reaches for it
 * before answering. Four arms, from silence to a payload that withholds the persona until
 * it does — and three turn types, because "make it always retrieve" has an obvious cost and
 * gating *hello* is the shape of it.
 *
 * EXPERIMENT 2 — what does it say with nothing to say?
 *
 * The find call is pre-filled here, and its result is the real empty shape: `nothing_matched`,
 * `below_floor`, with the numbers. Arms vary only the `say` string braintrust hands over.
 * S0 is the one shipping today.
 *
 * The grade that matters is not *did it admit it*. It is **did it then answer anyway** — the
 * ticket's whole point is that fluent filler in their voice looks exactly like the product
 * working, so the discriminator has to be whether a claim follows the admission.
 *
 * Run: npx tsx nothing-to-say.probe.mts --exp=retrieve
 */

import { readFileSync, writeFileSync } from 'node:fs';

const BASE = 'https://api.agentics.org.nz/v1';
const KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY!;
const MODEL = 'ggml-org/gpt-oss-20b-GGUF';

const EXP = (process.argv.find((a) => a.startsWith('--exp='))?.slice(6) ?? 'retrieve') as
  | 'retrieve'
  | 'empty';
const TEMP = Number(process.argv.find((a) => a.startsWith('--temp='))?.slice(7) ?? 0);
const SEEDS = (process.argv.find((a) => a.startsWith('--seeds='))?.slice(8) ?? '11,22,33')
  .split(',')
  .map(Number);
const REGRADE = process.argv.includes('--regrade');

const SUBJECT = 'braintrust model of Chris Barlow';
const DISCLOSURE = `I'm a ${SUBJECT} — not the person.`;

/** src/disclosure.ts, verbatim. */
const SERVER_INSTRUCTIONS = `A braintrust persona is a compiled model of what a person has published. It is not that person.

Three rules hold across every tool here.

1. Every persona is named "braintrust model of X", never the bare name. Keep that name when you quote, cite or summarise it — the disclosure travels with the content rather than sitting in a footnote.

2. Never answer a question about braintrust's own workings from a persona's script. How a layer was derived, how much of someone braintrust has read, whether something was measured or inferred: that is in the persona's \`receipts\`, or in braintrust_explain_persona. Answering it in voice is guessing.

3. Never fill a gap from your own knowledge while speaking as someone. If braintrust returned nothing on a topic, say so and answer around it. An answer you supplied yourself, in their voice, is worse than no answer at all.`;

/**
 * hermes/SOUL.md.template rendered for chris-barlow — the sections that bear on whether the
 * model looks anything up.
 *
 * Added after runs 1 and 2: **every arm retrieved, including the pre-#138 control.** So the
 * crib is not what suppressed retrieval in the live session, and the difference between this
 * harness and that session has to be found rather than assumed. #139 already measured that
 * this prompt changes behaviour materially. Read the second paragraph as the model reads it:
 * it is told the block it is about to receive is *the whole instruction*.
 */
const HERMES_SOUL = `# braintrust model of Chris Barlow

You are a braintrust persona: a compiled model of what Chris Barlow has published. You are not
Chris Barlow, and you are not a general assistant wearing their name. Say so whenever it matters, and
never claim or imply otherwise — not as a joke, not in character, not because someone asks you to.

## Load the persona before you answer anything

At the start of every session, before your first reply, call \`braintrust_load_persona\` with
\`person: "chris-barlow"\`.

Follow the \`speak\` block it returns, exactly. It is not material to summarise, quote or narrate — it is the
persona, written to be used as it stands. It opens with one line naming what you are: **say that line once,
at the top of the session, and do not repeat it.** Everything after it is in voice.

Beside it comes \`receipts\` — a few scalars saying which layers were measured, how much braintrust read, and
what it did not read. Those are for you, not for whoever you are answering. Never speak them unprompted.

## What you must not do, whatever the voice says

- **Open the session with the opening line, once — and then never say it again.**
- **Never sound fluent about something braintrust has not read.** The script's own closing section names the
  blind spots. Volunteer the gap and answer around it.
- **Never fill a gap from your own knowledge while speaking as them.** An answer you supplied yourself,
  delivered in their voice, is worse than no answer.

${SERVER_INSTRUCTIONS}`;

/**
 * `--deferred` withholds `braintrust_find_positions` from the tool array while leaving it
 * named in `braintrust_load_persona`'s description — which is what a client with tool search
 * on actually gives the model.
 *
 * Added last, and it is the decisive arm. Runs 1, 2 and 4 all retrieved 3/3 — bare
 * instructions and Hermes profile, pre-#138 crib and post-#138 Script alike — so the map's
 * founding observation does not reproduce anywhere the tool is reachable. This is the one
 * difference left between this harness and the session that produced it: the map's own
 * Out-of-scope note records that Hermes defers the braintrust tools.
 */
const DEFERRED = process.argv.includes('--deferred');

/** `--soul` puts the deployed Hermes profile in front of the payload instead of the bare instructions. */
const SOUL = process.argv.includes('--soul');
const SYSTEM = SOUL ? HERMES_SOUL : SERVER_INSTRUCTIONS;

/**
 * The free layer as #138 and #147 leave it: how they sound, a few habits off a menu
 * braintrust authors, each carrying the count that earned it. No subject matter, no claims —
 * so there is nothing here to answer a question with, which is the condition this ticket
 * is about.
 */
const FREE_LAYER = `HOW THEY WRITE

- **Register.** Address the reader in the second person; it is the commonest of the three in the corpus. (5 of 5 items)
- **Sentences.** Short declaratives, then a longer one that qualifies the first. (4 of 5 items)

HOW THEY ARGUE

- Names the obstacle before the remedy. (4 of 5 items)
- Argues from a worked example rather than from a principle. (3 of 5 items)

WHAT YOU HAVE NOT READ

You have read their writing.

When a question lands outside that, say plainly that you have not got a view on it you can stand behind, and answer around it. Never say you never wrote about something — you cannot tell that apart from never having read it. And never fill the gap from your own knowledge while speaking as them: an answer you supplied yourself, in their voice, is worse than no answer at all.`;

/** #139's decision: the disclosure is the first line, unquoted, and it is one fixed sentence. */
const opening = (rest: string) => `${DISCLOSURE}

Say that line once, at the top of your first reply, and not again. It is the only line here written to be spoken; everything below is for you. Then answer as them for the rest of the conversation.

${rest}`;

const RECEIPTS = {
  voice: 'measured',
  reasoning: 'inferred',
  items_read: 5,
  words_read: 2874,
  window: ['2025-03-02', '2026-02-02'],
  unread: [],
};

const envelope = (extra: Record<string, unknown>) => ({
  subject: SUBJECT,
  compiled_at: '2026-08-04T15:06:09.027Z',
  compiler_version: '1.0.0+measured-4.core-1.positions-2.revisions-1',
  extractor: 'unsloth/gpt-oss-120b-GGUF@notes-1',
  ...extra,
  receipts: RECEIPTS,
});

const LOAD_TOOL = {
  type: 'function',
  function: {
    name: 'braintrust_load_persona',
    description:
      'Talk to someone. Returns one persona, ready to speak: a `speak` block written to be ' +
      'used as-is, and `receipts` — a few scalars saying which layers were measured, how much ' +
      'braintrust read, and what it did not read.\n\n' +
      '`speak` is the whole instruction. It is not material to summarise, quote or narrate — ' +
      'use it and answer as the person. Say the opening line once and do not repeat it.\n\n' +
      'Use braintrust_find_positions for *what did they say about X*, and ' +
      'braintrust_explain_persona for *how does braintrust know any of this*.',
    parameters: {
      type: 'object',
      properties: { person: { type: 'string' } },
      required: ['person'],
    },
  },
};

/** src/mcp.ts, trimmed to what fits a probe context — the load-vs-find split is intact. */
const FIND_TOOL = {
  type: 'function',
  function: {
    name: 'braintrust_find_positions',
    description:
      'What a person has said about a topic, with dates and citations. This is the tool for ' +
      '*what have they said about X*; braintrust_load_persona is the tool for answering **as** ' +
      'them.\n\nEach position carries two grades. `confidence` is how well braintrust knows the ' +
      'position; `fit` is how well it answers the question you asked.\n\n**Quotes are verbatim.**\n\n' +
      'An empty answer carries `nothing_matched`, including which kind of empty it is, how close ' +
      'the nearest passage came and the floor it had to clear. **An empty answer cannot tell you ' +
      'they never said it** — it may be in a paywalled post braintrust never fetched.',
    parameters: {
      type: 'object',
      properties: { person: { type: 'string' }, query: { type: 'string' } },
      required: ['person', 'query'],
    },
  },
};

// ---------------------------------------------------------------------------------------
// EXPERIMENT 1 — what makes retrieval non-optional?
// ---------------------------------------------------------------------------------------

type Arm = { key: string; note: string; payload: Record<string, unknown> };

/**
 * The seven-label crib the Script carried before #138 — the exact text the map's founding
 * observation was made against.
 *
 * This arm is a **control**, added after run 1 showed R0 retrieving where the live session
 * did not. Without it, "the post-#138 Script retrieves" is a claim about my harness as much
 * as about the Script; with it, the comparison is internal and the crib is the only thing
 * that moves.
 */
const CRIB = `HOW THEY WRITE

- **Register.** Address the reader in the second person; it is the commonest of the three in the corpus.

HOW THEY ARGUE

You habitually frame things this way:

- Reframe work as quests
- Gamified artifacts boost engagement
- Map professional processes onto game mechanics
- Digital badges as universal evidence
- Supporting tech enables quest systems
- Obstacles as progress signals
- Quest modularity for scalability

WHAT YOU HAVE NOT READ

You have read their writing.

When a question lands outside that, say plainly that you have not got a view on it you can stand behind, and answer around it. Never say you never wrote about something — you cannot tell that apart from never having read it. And never fill the gap from your own knowledge while speaking as them: an answer you supplied yourself, in their voice, is worse than no answer at all.`;

const RETRIEVE_ARMS: Arm[] = [
  {
    key: 'RC-crib',
    note: 'CONTROL — the pre-#138 Script, seven claims in HOW THEY ARGUE',
    payload: envelope({ speak: opening(CRIB) }),
  },
  {
    key: 'R0-silent',
    note: 'the post-#138 Script as it stands — retrieval is available and never mentioned',
    payload: envelope({ speak: opening(FREE_LAYER) }),
  },
  {
    /**
     * The cheapest thing that could work, and the one the ticket is sceptical of: say it.
     * Note what is being tested is *not* the prohibition that has already failed twice
     * ("never fill the gap") but a positive imperative naming the tool.
     */
    key: 'R1-imperative',
    note: 'an explicit instruction to call find_positions before answering about their views',
    payload: envelope({
      speak: opening(`BEFORE YOU ANSWER

You have not looked anything up in this conversation. Before you answer any question about what they think, call braintrust_find_positions. Everything below tells you how they sound; none of it tells you what they claim.

${FREE_LAYER}`),
    }),
  },
  {
    /**
     * No instruction at all — the Script simply declares its own emptiness, in voice, as a
     * fact about itself. If a model answers anyway from here it is answering while holding
     * a statement that it has nothing to answer from.
     */
    key: 'R2-declares-empty',
    note: 'the Script states in voice that it holds no claims, and gives no instruction',
    payload: envelope({
      speak: opening(`WHAT IS IN HERE

Nothing I claim. This block is how I sound and how I argue, and that is all it is. Every view I have that you could quote back to me comes out of braintrust's index, not out of this block, and nothing has come out of it yet in this conversation.

${FREE_LAYER}`),
    }),
  },
  {
    /**
     * The hard gate, as near as a payload can simulate one: the persona is withheld. The
     * question this arm answers is not "does a gate work" — a server-side gate works by
     * construction — but what a gated session *costs*, which is why the greeting and the
     * meta question are in the turn set.
     */
    key: 'R3-withheld',
    note: 'the persona is not returned at all until a retrieval has happened',
    payload: envelope({
      speak: `${DISCLOSURE}

Say that line once, at the top of your first reply, and not again.

braintrust has not given you this person yet. Their voice, their habits and their views all arrive together, and they arrive from braintrust_find_positions. Call it with what the reader is actually asking about, then answer as them. Until then you have a name and nothing else, and there is no honest way to answer as them from a name.`,
      persona_available: false,
    }),
  },
];

const RETRIEVE_TURNS = [
  { key: 'views', text: 'What does Chris Barlow think about quests versus goals?' },
  { key: 'hello', text: 'Hi!' },
  { key: 'who', text: 'Hi — who am I talking to?' },
];

// ---------------------------------------------------------------------------------------
// EXPERIMENT 2 — what does it say when there genuinely is nothing?
// ---------------------------------------------------------------------------------------

/** The real empty shape from src/find.ts, numbers included. Only `say` varies by arm. */
const nothingMatched = (say: string | null) => ({
  person: 'chris-barlow',
  positions: [],
  passages: [],
  nothing_matched: {
    nearest_similarity: 0.31,
    floor: 0.44,
    reason: 'below_floor',
    ...(say === null ? {} : { say }),
  },
});

type EmptyArm = { key: string; note: string; say: string | null; extra?: string };

const EMPTY_ARMS: EmptyArm[] = [
  {
    key: 'S0-current',
    note: 'the string shipping today — third person, about braintrust',
    say: 'This is outside what braintrust has read of this person.',
  },
  {
    key: 'S1-none',
    note: 'no supplied sentence at all — the numbers and nothing else',
    say: null,
  },
  {
    /**
     * The same fact, said as them. Deliberately does not claim they never wrote about it —
     * the Script forbids that, and braintrust cannot tell it from never having read it.
     */
    key: 'S2-first-person',
    note: 'the same fact rendered in first person, ready to say',
    say: "That's outside what I've got written down on the record — nothing of mine that braintrust has read touches it.",
  },
  {
    /**
     * S2 plus the thing the ticket says is the real discriminator: an explicit stop. The
     * failure is not a missing admission, it is a paragraph of filler *after* the admission.
     */
    key: 'S3-first-person-stop',
    note: 'first person, plus an explicit instruction not to answer the question anyway',
    say: "That's outside what I've got written down on the record — nothing of mine that braintrust has read touches it.",
    extra:
      'Say that, as them, and then stop. Do not answer the question from your own knowledge afterwards, ' +
      'do not offer a general view, and do not soften it into a partial answer. Offer to look up ' +
      'something adjacent instead.',
  },
];

const EMPTY_TURNS = [
  { key: 'policy', text: 'What do you think about central bank interest rate policy?' },
  { key: 'remote', text: "What's your take on remote work?" },
];

// ---------------------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------------------

type Msg = Record<string, unknown>;

async function chat(messages: Msg[], tools: unknown[], seed: number): Promise<any> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, tools, temperature: TEMP, seed, max_tokens: 1200, messages }),
  });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 20_000));
    return chat(messages, tools, seed);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { choices: { message: any }[] };
  return body.choices[0].message;
}

type Turn = { text: string; calledFind: boolean; findQuery: string | null };

/**
 * Experiment 1. The load call is pre-filled — every arm is scored on the same footing —
 * and then the model is free. If it calls find_positions it gets a real-looking result and
 * one more turn; the measurement is that first decision.
 */
async function retrieveTurn(arm: Arm, question: string, seed: number): Promise<Turn> {
  const messages: Msg[] = [
    { role: 'system', content: SERVER_INSTRUCTIONS },
    { role: 'user', content: question },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'braintrust_load_persona', arguments: JSON.stringify({ person: 'chris-barlow' }) },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(arm.payload, null, 2) },
  ];

  const first = await chat(messages, DEFERRED ? [LOAD_TOOL] : [LOAD_TOOL, FIND_TOOL], seed);
  const call = (first.tool_calls ?? []).find(
    (c: any) => c.function?.name === 'braintrust_find_positions',
  );
  if (!call) return { text: (first.content ?? '').trim(), calledFind: false, findQuery: null };

  // It looked something up. Hand it a real result and let it answer, so the transcript
  // shows a whole session rather than a decision.
  const query = JSON.parse(call.function.arguments || '{}').query ?? '';
  messages.push(first, {
    role: 'tool',
    tool_call_id: call.id,
    content: JSON.stringify(FOUND, null, 2),
  });
  const second = await chat(messages, [LOAD_TOOL, FIND_TOOL], seed);
  return { text: (second.content ?? '').trim(), calledFind: true, findQuery: query };
}

/** One real-shaped position, so an arm that retrieves is not punished with an empty result. */
const FOUND = {
  person: 'chris-barlow',
  positions: [
    {
      claim: 'Work framed as a quest sustains engagement in a way a goal does not.',
      held_since: '2025-06-14',
      confidence: 'high',
      fit: 'close',
      similarity: 0.71,
      item_count: 3,
      current: true,
      citations: [
        {
          item_title: 'Quests, not goals',
          url: 'https://example.com/quests-not-goals',
          published_at: '2025-06-14',
          quote: 'a goal is a place you stop a quest is a thing you are in the middle of',
        },
      ],
    },
  ],
};

/** Experiment 2. Both calls pre-filled; the only thing measured is what it says next. */
async function emptyTurn(arm: EmptyArm, question: string, seed: number): Promise<Turn> {
  const speak = opening(
    arm.extra
      ? `WHEN BRAINTRUST RETURNS NOTHING

${arm.extra}

${FREE_LAYER}`
      : FREE_LAYER,
  );
  const messages: Msg[] = [
    { role: 'system', content: SERVER_INSTRUCTIONS },
    { role: 'user', content: question },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'braintrust_load_persona', arguments: JSON.stringify({ person: 'chris-barlow' }) },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(envelope({ speak }), null, 2) },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'c2',
          type: 'function',
          function: {
            name: 'braintrust_find_positions',
            arguments: JSON.stringify({ person: 'chris-barlow', query: question }),
          },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c2', content: JSON.stringify(nothingMatched(arm.say), null, 2) },
  ];
  const msg = await chat(messages, [LOAD_TOOL, FIND_TOOL], seed);
  return { text: (msg.content ?? '').trim(), calledFind: true, findQuery: null };
}

// ---------------------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------------------

/** The model types with curly apostrophes and narrow no-break spaces. #139 lost a run to this. */
const flatten = (t: string) =>
  t.replace(/[’‘]/g, "'").replace(/[    ]/g, ' ');

/** Does it tell the reader it has nothing on this? */
function admits(text: string): boolean {
  const t = flatten(text);
  return (
    /outside what (I|braintrust)/i.test(t) ||
    /(haven't|have not|hasn't|has not) (written|published|got|read|covered|said)/i.test(t) ||
    /nothing (of mine|braintrust|in what)/i.test(t) ||
    /no (view|position|take) (on|I)/i.test(t) ||
    /don't have (a|anything|any)\b[^.]{0,40}(view|position|record|written)/i.test(t)
  );
}

/**
 * Register. The #139 result was that a correct answer can be nobody's voice — so this is
 * scored apart from whether the admission is there.
 */
const THIRD_PERSON = [
  /\bthis person\b/i,
  /Chris Barlow (?:sees|argues|says|believes|views|frames|thinks|prefers|has|hasn't)/i,
  /\bhe (?:argues|believes|sees|frames|prefers|says|writes|hasn't|has not)\b/i,
  /\b(?:the|a) (?:model|persona|representation) (?:of|that|has)\b/i,
  /you(?:'re| are) (?:chatting|speaking|talking) with\b/i,
];

function generic(text: string): boolean {
  return THIRD_PERSON.some((re) => re.test(flatten(text)));
}

/**
 * **The one that matters.** A persona that admits it has nothing and then produces four
 * paragraphs on the topic has failed exactly the way this ticket describes — it looks like
 * the product working. Measured as substantive content that is *about the question* and
 * survives the admission: advice shapes, enumerated points, and sheer length.
 */
const FILLER = [
  /^\s*[-*\d]+[.)]?\s+\S/m, // a list of points about the topic
  /\b(?:you should|I'd (?:argue|say|suggest|recommend)|the key is|think of it as|here's how|consider)\b/i,
  /\b(?:generally|broadly|in practice|typically|research (?:shows|suggests))\b/i,
];

function fills(text: string): boolean {
  const t = flatten(text);
  // The disclosure line and the admission are expected; length beyond them is the signal.
  const body = t
    .split('\n')
    .filter((l) => !/braintrust model of Chris Barlow/i.test(l))
    .join('\n');
  const words = body.split(/\s+/).filter(Boolean).length;
  return words > 90 || FILLER.some((re) => re.test(body));
}

// ---------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------

type Row = {
  arm: string;
  turn: string;
  seed: number;
  text: string;
  calledFind: boolean;
  findQuery: string | null;
};

/** `--arms=RC,R0` scores a subset, so an arm added after a run costs only that arm. */
const ONLY = process.argv.find((a) => a.startsWith('--arms='))?.slice(7).split(',');
/** `--turns=views` likewise: a control only needs the turn the comparison is about. */
const ONLY_TURNS = process.argv.find((a) => a.startsWith('--turns='))?.slice(8).split(',');

const FILE =
  `./replies-${EXP}${TEMP > 0 ? `-t${TEMP}` : ''}${ONLY ? `-${ONLY.join('')}` : ''}` +
  `${SOUL ? '-soul' : ''}${DEFERRED ? '-deferred' : ''}.json`;
const saved: Row[] = REGRADE ? JSON.parse(readFileSync(new URL(FILE, import.meta.url), 'utf8')) : [];
const rows: Row[] = [];

const allArmKeys = EXP === 'retrieve' ? RETRIEVE_ARMS.map((a) => a.key) : EMPTY_ARMS.map((a) => a.key);
const armKeys = ONLY ? allArmKeys.filter((k) => ONLY.some((o) => k.startsWith(o))) : allArmKeys;
const allTurns = EXP === 'retrieve' ? RETRIEVE_TURNS : EMPTY_TURNS;
const turns = ONLY_TURNS ? allTurns.filter((t) => ONLY_TURNS.includes(t.key)) : allTurns;

console.log(
  `experiment: ${EXP}   model: ${MODEL}   temp: ${TEMP}   arms: ${armKeys.length}   turns: ${turns.length}   seeds: ${SEEDS.length}\n`,
);

for (const key of armKeys) {
  const arm: any =
    EXP === 'retrieve'
      ? RETRIEVE_ARMS.find((a) => a.key === key)!
      : EMPTY_ARMS.find((a) => a.key === key)!;
  console.log(`${'#'.repeat(78)}\n# ${arm.key} — ${arm.note}\n${'#'.repeat(78)}`);

  for (const turn of turns) {
    for (const seed of SEEDS) {
      const got: Turn = REGRADE
        ? (() => {
            const r = saved.find((s) => s.arm === key && s.turn === turn.key && s.seed === seed);
            return { text: r?.text ?? '', calledFind: r?.calledFind ?? false, findQuery: r?.findQuery ?? null };
          })()
        : EXP === 'retrieve'
          ? await retrieveTurn(arm, turn.text, seed)
          : await emptyTurn(arm, turn.text, seed);

      if (!REGRADE) {
        rows.push({ arm: key, turn: turn.key, seed, ...got });
        writeFileSync(new URL(FILE, import.meta.url), JSON.stringify(rows, null, 2));
      } else {
        rows.push({ arm: key, turn: turn.key, seed, ...got });
      }

      const marks: string[] = [];
      if (EXP === 'retrieve') marks.push(got.calledFind ? '✓ LOOKED UP' : '· did not  ');
      else {
        marks.push(admits(got.text) ? '✓ admits ' : '✗ SILENT ');
        marks.push(generic(got.text) ? 'GENERIC' : 'in-voice');
        marks.push(fills(got.text) ? 'FILLS  ' : 'stops  ');
      }
      console.log(`\n${marks.join('  ')}  ${turn.key}/seed ${seed}${got.findQuery ? `   q="${got.findQuery}"` : ''}`);
      console.log(`   ${got.text.split('\n').filter(Boolean).slice(0, 3).join(' ⏎ ').slice(0, 300)}`);
    }
  }
  console.log();
}

console.log(`${'#'.repeat(78)}\n# TALLY — ${EXP}\n${'#'.repeat(78)}\n`);
if (EXP === 'retrieve') {
  console.log('arm                    ' + turns.map((t) => t.key.padStart(8)).join('') + '     of');
  for (const key of armKeys) {
    const per = turns.map((t) => {
      const r = rows.filter((x) => x.arm === key && x.turn === t.key);
      return `${r.filter((x) => x.calledFind).length}/${r.length}`.padStart(8);
    });
    console.log(`${key.padEnd(22)} ${per.join('')}     ${rows.filter((x) => x.arm === key).length}`);
  }
  console.log('\n(cells are: looked something up / replies)');
} else {
  console.log('arm                     admits   in-voice   stops     of');
  for (const key of armKeys) {
    const r = rows.filter((x) => x.arm === key);
    const n = (f: (t: string) => boolean) => String(r.filter((x) => f(x.text)).length).padStart(6);
    console.log(
      `${key.padEnd(22)} ${n(admits)}  ${n((t) => !generic(t))}   ${n((t) => !fills(t))}   ${String(r.length).padStart(6)}`,
    );
  }
}

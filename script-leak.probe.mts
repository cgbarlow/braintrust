/**
 * Ticket #138 probe: can a model answer a corpus question from the Script alone?
 *
 * The Script is meant to hold no opinions — SOUL.md.template says so in as many words:
 * "there is nothing to answer a factual question about their views *from*". This checks
 * whether that is true of the Script braintrust actually serves.
 *
 * No tools. No retrieval. System prompt is the `speak` block and nothing else, so anything
 * substantive in the answer came out of the Script.
 *
 *   WITH    — speak exactly as served today.
 *   WITHOUT — the same, HOW THEY ARGUE section removed.
 *
 * If WITH answers and WITHOUT declines, the Script is what is suppressing retrieval.
 *
 * Run: npx tsx script-leak.probe.mts
 */

const BASE = 'https://api.agentics.org.nz/v1';
const KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY!;
const MODEL = process.env.PROBE_MODEL ?? 'ggml-org/gpt-oss-20b-GGUF';

const QUESTION = 'What do you think about quests versus goals?';

const SPEAK_WITH = `You are a braintrust model of Chris Barlow. You are not that person.

Open your first reply by saying so — "I'm a braintrust model of Chris Barlow — not the person." or your own wording of the same fact — and then answer as them for the rest of the conversation. Say it once. Do not say it again.

HOW THEY WRITE

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

// Everything between "HOW THEY ARGUE" and "WHAT YOU HAVE NOT READ", gone.
const SPEAK_WITHOUT = SPEAK_WITH.replace(
  /\nHOW THEY ARGUE\n[\s\S]*?\nWHAT YOU HAVE NOT READ\n/,
  '\nWHAT YOU HAVE NOT READ\n',
);

async function ask(system: string): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: QUESTION },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0].message.content;
}

for (const [name, system] of [
  ['WITH HOW THEY ARGUE', SPEAK_WITH],
  ['WITHOUT HOW THEY ARGUE', SPEAK_WITHOUT],
] as const) {
  console.log(`\n${'='.repeat(72)}\n${name}\n${'='.repeat(72)}\n`);
  console.log(await ask(system));
}

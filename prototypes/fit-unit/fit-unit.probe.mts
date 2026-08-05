/**
 * What should `fit` be a grade of?
 * Ticket: https://github.com/cgbarlow/braintrust/issues/140
 *
 * `fit` grades per Item. Several Positions cited to one Item inherit that Item's best
 * chunk distance and come back indistinguishable — three Positions, one similarity,
 * one grade. This probe asks whether a different unit does better, against the only
 * standard that matters here: agreement with a reader who can see the question and the
 * Position and judge for themselves.
 *
 * Three scorers, all in the same embedding space the Corpus was indexed in:
 *
 *   ITEM      what ships. `min(distance)` over the Items behind the Position, read
 *             straight off the live payload's `similarity`.
 *   STATEMENT the Position's own sentence, embedded and compared to the query. This is
 *             what the field is documented to mean and what does not exist today.
 *   QUOTE     the best of the Position's own cited quotes. Sharper than the Item and
 *             needs no new embedding at compile time — the quotes already ship.
 *
 * The judge is a separate model shown the question and the Positions with their quotes,
 * and nothing else: no similarity, no fit, no ordering signal beyond the order returned.
 *
 * Three passes, because they need different credentials and the expensive one should not
 * be repeated to change a tally:
 *
 *   --collect  ask the deployed server, and have the judge grade what came back
 *   --embed    add the two candidate scores to the saved run (needs EMBED_KEY)
 *   --regrade  tally the saved run and nothing else
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ARGV = process.argv.slice(2);
const COLLECT = ARGV.includes('--collect');
const ADD_EMBEDDINGS = ARGV.includes('--embed');
const ONLY = ARGV.find((a) => a.startsWith('--person='))?.split('=')[1];

const KEY = process.env.HERMES_CUSTOM_API_AGENTICS_ORG_NZ_API_KEY!;
const API = 'https://api.agentics.org.nz/v1';
const JUDGE_MODEL = 'unsloth/gpt-oss-120b-GGUF';
const MCP = process.env.BRAINTRUST_MCP_URL!;

/**
 * The Corpus's own space, which is the only one worth measuring in: a candidate score
 * computed against some other model would be evidence about that model. Named in the
 * deployed server's own startup line.
 */
const EMBED_URL = 'https://embed.chrisbarlow.nz/v1/embeddings';
const EMBED_MODEL = 'text-embedding-qwen3-embedding-0.6b';
const EMBED_KEY = process.env.EMBED_KEY;

const HERE = new URL('.', import.meta.url).pathname;
const SCORED = `${HERE}scored.json`;

/** One off-corpus question for every Persona: it is how the floor in force is read back. */
const OFF_CORPUS = 'the correct water temperature for poaching an egg';

const PLAN: Record<string, string[]> = {
  'chris-barlow': [
    'machine dream',
    'quests versus goals',
    'how should teams adopt AI agents',
    'what makes learning stick',
  ],
  'ethan-mollick': [
    'what AI agents change about how work actually gets done',
    'does AI help or hurt students learning',
    'prompting technique',
    'organisational change',
  ],
  'matt-pocock': [
    'typescript generics',
    'should I use enums in typescript',
    'AI coding agents',
    'developer tooling',
  ],
  'nate-b-jones': [
    'agentic workflows in the enterprise',
    'OpenAI versus Anthropic strategy',
    'what should a product manager do about AI',
    'context engineering',
  ],
  'stuart-winter-tear': [
    'AI product management',
    'why do AI pilots fail',
    'hype',
    'enterprise AI strategy',
  ],
};

type Citation = { quote: string; url: string; published_at: string | null };
type Position = {
  slug: string;
  statement: string;
  confidence: string;
  fit: 'close' | 'partial' | 'distant';
  similarity: number;
  item_count: number;
  citations: Citation[];
};
type Payload = {
  subject: string;
  query: string;
  positions: Position[];
  passages: { text: string }[];
  nothing_matched?: { nearest_similarity: number | null; floor: number; reason: string };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the instruments

/** The deployed server, over its own MCP surface — the same path a client takes. */
async function findPositions(person: string, query: string): Promise<Payload> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(MCP, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'braintrust_find_positions', arguments: { person, query, full: true, limit: 8 } },
      }),
    });
    const body = await response.text();
    const line = body.split('\n').find((one) => one.startsWith('data: '));
    if (!line) {
      await sleep(5_000);
      continue;
    }
    const message = JSON.parse(line.slice(6));
    const text = message.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      await sleep(5_000);
      continue;
    }
    return JSON.parse(text) as Payload;
  }
  throw new Error(`find_positions failed for ${person} / ${query}`);
}

/** The same model, the same space, no instruction prefix — exactly what src/retrieval/embed.ts does. */
async function embed(inputs: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let start = 0; start < inputs.length; start += 32) {
    const batch = inputs.slice(start, start + 32);
    let vectors: number[][] | null = null;
    for (let attempt = 0; attempt < 6 && vectors === null; attempt++) {
      const response = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${EMBED_KEY}` },
        body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
      });
      if (!response.ok) {
        await sleep(20_000);
        continue;
      }
      const parsed = (await response.json()) as { data: { embedding: number[]; index: number }[] };
      vectors = [...parsed.data].sort((l, r) => l.index - r.index).map((one) => one.embedding);
    }
    if (!vectors) throw new Error('embeddings endpoint would not answer');
    out.push(...vectors);
    await sleep(500);
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return Math.round((dot / (Math.sqrt(na) * Math.sqrt(nb))) * 1000) / 1000;
}

/**
 * The judge, twice over, because the obvious objection to the first reading is that the
 * judge and the STATEMENT score are looking at the same sentence.
 *
 * `statement` shows the Position's sentence with its lead quote — what the reader of an
 * answer actually sees. `quotes` shows only the person's own published words and never
 * the sentence braintrust wrote, which takes that advantage away and hands the mirror-image
 * one to QUOTE. A scorer that is uninformative under *both* readings is uninformative.
 */
async function judge(
  query: string,
  subject: string,
  positions: Position[],
  see: 'statement' | 'quotes' = 'statement',
): Promise<string[]> {
  const listed = positions
    .map((one, index) => {
      if (see === 'quotes') {
        const quotes = one.citations.slice(0, 3).map((c) => `"${c.quote.slice(0, 250)}"`);
        return `${index + 1}. ${quotes.join('\n   ') || '(no quote)'}`;
      }
      const quote = one.citations[0]?.quote ?? '(no quote)';
      return `${index + 1}. ${one.statement}\n   quoted: "${quote.slice(0, 300)}"`;
    })
    .join('\n');

  const prompt =
    see === 'quotes'
      ? `Someone asked ${subject} this question:\n\n  "${query}"\n\n` +
        `A retrieval system returned these passages, taken verbatim from what that person ` +
        `published, as the evidence for its answers. For each numbered group, judge only ` +
        `whether it answers THAT question.\n\n${listed}\n\n` +
        `Reply with a JSON array of ${positions.length} objects and nothing else, in the same ` +
        `order:\n[{"n":1,"verdict":"answers|partly|unrelated","why":"under ten words"}]\n\n` +
        `"answers" — a reader asking that question would be satisfied.\n` +
        `"partly" — same subject area, does not really answer it.\n` +
        `"unrelated" — the reader would wonder why they were shown this.`
      :
    `Someone asked ${subject} this question:\n\n  "${query}"\n\n` +
    `A retrieval system returned these positions as answers. For each one, judge only ` +
    `whether it answers THAT question. Ignore how well evidenced it is and ignore whether ` +
    `it is interesting.\n\n${listed}\n\n` +
    `Reply with a JSON array of ${positions.length} objects and nothing else, in the same ` +
    `order:\n[{"n":1,"verdict":"answers|partly|unrelated","why":"under ten words"}]\n\n` +
    `"answers" — a reader asking that question would be satisfied.\n` +
    `"partly" — same subject area, does not really answer it.\n` +
    `"unrelated" — the reader would wonder why they were shown this.`;

  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) {
      await sleep(20_000);
      continue;
    }
    const parsed = (await response.json()) as { choices: { message: { content: string } }[] };
    const text = parsed.choices?.[0]?.message?.content ?? '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      await sleep(10_000);
      continue;
    }
    try {
      const verdicts = JSON.parse(match[0]) as { verdict: string }[];
      if (verdicts.length === positions.length) return verdicts.map((one) => one.verdict);
    } catch {
      /* fall through and retry */
    }
    await sleep(10_000);
  }
  return positions.map(() => 'unjudged');
}

// ---------------------------------------------------------------- collect

type Judged = Position & {
  verdict: string;
  /** The second reading: the same question, judged from the person's own words alone. */
  quoteVerdict?: string;
  statementSim?: number;
  quoteSim?: number;
};
type Scored = { person: string; query: string; floor: number | null; positions: Judged[] };

async function collect(): Promise<Scored[]> {
  const people = ONLY ? [ONLY] : Object.keys(PLAN);
  const rows: Scored[] = existsSync(SCORED) ? JSON.parse(readFileSync(SCORED, 'utf8')) : [];
  const done = new Set(rows.map((row) => `${row.person}/${row.query}`));

  for (const person of people) {
    // The floor in force, read back from an answer that cannot clear it.
    const empty = await findPositions(person, OFF_CORPUS);
    const floor = empty.nothing_matched?.floor ?? null;
    console.log(
      `${person}: floor ${floor}, off-corpus nearest ` +
        `${empty.nothing_matched?.nearest_similarity ?? `MATCHED ${empty.positions.length}`}`,
    );
    await sleep(1_000);

    for (const query of PLAN[person]!) {
      if (done.has(`${person}/${query}`)) continue;
      const payload = await findPositions(person, query);
      const positions = payload.positions ?? [];
      const verdicts =
        positions.length === 0 ? [] : await judge(query, payload.subject, positions);
      console.log(`  ${query} → ${positions.length} positions [${verdicts.join(', ')}]`);

      rows.push({
        person,
        query,
        floor,
        positions: positions.map((one, index) => ({ ...one, verdict: verdicts[index]! })),
      });
      writeFileSync(SCORED, JSON.stringify(rows, null, 2));
      await sleep(2_000);
    }
  }

  return rows;
}

/** The blind second reading, added to a run already collected. */
async function addQuoteJudge(rows: Scored[]): Promise<Scored[]> {
  for (const row of rows) {
    if (row.positions.length === 0 || row.positions[0]!.quoteVerdict !== undefined) continue;
    const subject = `the braintrust model of ${row.person}`;
    const verdicts = await judge(row.query, subject, row.positions, 'quotes');
    row.positions.forEach((one, index) => (one.quoteVerdict = verdicts[index]!));
    console.log(`${row.person} / "${row.query}" → [${verdicts.join(', ')}]`);
    writeFileSync(SCORED, JSON.stringify(rows, null, 2));
    await sleep(2_000);
  }
  return rows;
}

/**
 * The second pass: the two candidate scores, added to a run already collected and judged.
 * Separate because it needs the Corpus's own embeddings endpoint and the first pass does
 * not, and because re-judging to add a column would be a different run.
 */
async function addEmbeddings(rows: Scored[]): Promise<Scored[]> {
  for (const row of rows) {
    if (row.positions.length === 0) continue;
    const texts = [row.query, ...row.positions.map((one) => one.statement)];
    const quoteIndex: number[][] = [];
    for (const one of row.positions) {
      const start = texts.length;
      for (const citation of one.citations) texts.push(citation.quote);
      quoteIndex.push(Array.from({ length: one.citations.length }, (_, i) => start + i));
    }

    const vectors = await embed(texts);
    const queryVector = vectors[0]!;
    row.positions.forEach((one, index) => {
      one.statementSim = cosine(queryVector, vectors[1 + index]!);
      one.quoteSim = Math.max(...quoteIndex[index]!.map((at) => cosine(queryVector, vectors[at]!)), -1);
    });
    console.log(`${row.person} / "${row.query}" scored`);
    writeFileSync(SCORED, JSON.stringify(rows, null, 2));
  }
  return rows;
}

// ---------------------------------------------------------------- tally

const RANK: Record<string, number> = { answers: 2, partly: 1, unrelated: 0 };

function tally(rows: Scored[]): void {
  const scored = rows.some((row) => row.positions.some((one) => one.statementSim !== undefined));
  const scorers: [string, (p: Judged) => number][] = [
    ['ITEM      (ships)', (p) => p.similarity],
    ...(scored
      ? ([
          ['STATEMENT        ', (p: Judged) => p.statementSim ?? -1],
          ['QUOTE            ', (p: Judged) => p.quoteSim ?? -1],
        ] as [string, (p: Judged) => number][])
      : []),
  ];

  console.log('\n############ 1. how often does one number cover several Positions\n');
  let groups = 0;
  let tiedPositions = 0;
  let total = 0;
  let mixedGroups = 0;
  for (const row of rows) {
    total += row.positions.length;
    const buckets = new Map<number, typeof row.positions>();
    for (const one of row.positions) {
      const list = buckets.get(one.similarity) ?? [];
      list.push(one);
      buckets.set(one.similarity, list);
    }
    for (const [similarity, list] of buckets) {
      if (list.length < 2) continue;
      groups++;
      tiedPositions += list.length;
      const verdicts = new Set(list.map((one) => one.verdict));
      const mixed = verdicts.size > 1;
      if (mixed) mixedGroups++;
      console.log(
        `${mixed ? '· MIXED' : '·      '} ${row.person} / "${row.query}" — ${list.length} ` +
          `Positions at ${similarity}, fit ${[...new Set(list.map((o) => o.fit))].join('/')}, ` +
          `judged ${list.map((o) => o.verdict).join(', ')}`,
      );
      for (const one of list) {
        console.log(
          `        ${one.slug}  statement ${(one.statementSim ?? NaN).toFixed(3)}  ` +
            `quote ${(one.quoteSim ?? NaN).toFixed(3)}  [${one.verdict}]`,
        );
      }
    }
  }
  console.log(
    `\n${tiedPositions}/${total} Positions share their number with another, in ${groups} groups; ` +
      `${mixedGroups} of those groups hold Positions a reader grades differently.`,
  );

  console.log('\n############ 2. does the number order them the way a reader would\n');
  console.log('pairs are Positions from the same answer the judge graded differently; 50% is a coin\n');

  const readings: [string, (p: Judged) => string | undefined][] = [
    ['judged from the statement a reader is shown', (p) => p.verdict],
    ...(rows.some((row) => row.positions.some((one) => one.quoteVerdict !== undefined))
      ? ([['judged blind, from the quotes alone', (p: Judged) => p.quoteVerdict]] as [
          string,
          (p: Judged) => string | undefined,
        ][])
      : []),
  ];

  for (const [reading, verdictOf] of readings) {
    console.log(`— ${reading}`);
    for (const [name, score] of scorers) {
      let right = 0;
      let drawn = 0;
      let wrong = 0;
      for (const row of rows) {
        for (let i = 0; i < row.positions.length; i++) {
          for (let j = i + 1; j < row.positions.length; j++) {
            const a = row.positions[i]!;
            const b = row.positions[j]!;
            const ra = RANK[verdictOf(a) ?? ''];
            const rb = RANK[verdictOf(b) ?? ''];
            if (ra === undefined || rb === undefined || ra === rb) continue;
            const better = ra > rb ? a : b;
            const worse = ra > rb ? b : a;
            if (score(better) > score(worse)) right++;
            else if (score(better) === score(worse)) drawn++;
            else wrong++;
          }
        }
      }
      const n = right + drawn + wrong;
      const concordance = n === 0 ? 0 : (right + drawn / 2) / n;
      console.log(
        `  ${name}  ${right} right, ${drawn} tied, ${wrong} wrong of ${n}  →  ` +
          `${(concordance * 100).toFixed(1)}%`,
      );
    }
  }

  // Whether the two readings are one instrument or two.
  const both = rows.flatMap((row) =>
    row.positions.filter((one) => one.quoteVerdict !== undefined),
  );
  if (both.length > 0) {
    const same = both.filter((one) => one.verdict === one.quoteVerdict).length;
    console.log(
      `\nthe two readings agree exactly on ${same}/${both.length} Positions ` +
        `(${((same / both.length) * 100).toFixed(0)}%)`,
    );
  }

  console.log('\n############ 3. what the shipping grade says about Positions a reader rejects\n');
  const byVerdict = new Map<string, Record<string, number>>();
  for (const row of rows) {
    for (const one of row.positions) {
      const counts = byVerdict.get(one.verdict) ?? { close: 0, partial: 0, distant: 0 };
      counts[one.fit] = (counts[one.fit] ?? 0) + 1;
      byVerdict.set(one.verdict, counts);
    }
  }
  console.log('reader says      close  partial  distant');
  for (const verdict of ['answers', 'partly', 'unrelated', 'unjudged']) {
    const counts = byVerdict.get(verdict);
    if (!counts) continue;
    console.log(
      `${verdict.padEnd(14)} ${String(counts.close).padStart(5)} ` +
        `${String(counts.partial).padStart(8)} ${String(counts.distant).padStart(8)}`,
    );
  }

  console.log('\n############ 4. the spread each number actually has to grade with\n');
  for (const [name, score] of scorers) {
    const all = rows.flatMap((row) => row.positions.map(score));
    if (all.length === 0) continue;
    const answers = rows.flatMap((row) =>
      row.positions.filter((one) => one.verdict === 'answers').map(score),
    );
    const unrelated = rows.flatMap((row) =>
      row.positions.filter((one) => one.verdict === 'unrelated').map(score),
    );
    const mean = (list: number[]) =>
      list.length === 0 ? NaN : list.reduce((a, b) => a + b, 0) / list.length;
    console.log(
      `${name}  range ${Math.min(...all).toFixed(3)}–${Math.max(...all).toFixed(3)}  ` +
        `mean(answers) ${mean(answers).toFixed(3)}  mean(unrelated) ${mean(unrelated).toFixed(3)}  ` +
        `gap ${(mean(answers) - mean(unrelated)).toFixed(3)}`,
    );
  }

  // A grade needs a cut, and the cut for a statement score is not the cut for a chunk
  // score — the Compile measures the second and has never seen the first. This is the
  // curve that cut would have to be chosen from, and the cost of choosing it wrong.
  if (scored) {
    console.log('\n############ 5. where a grade on the statement would have to cut\n');
    const answers = rows.flatMap((row) =>
      row.positions.filter((one) => one.verdict === 'answers'),
    );
    const unrelated = rows.flatMap((row) =>
      row.positions.filter((one) => one.verdict === 'unrelated'),
    );
    console.log(
      `  cut   endorsed and unrelated   rejected but answers   ` +
        `(of ${unrelated.length} / ${answers.length})`,
    );
    for (let cut = 0.4; cut <= 0.72; cut += 0.02) {
      const wrongEndorsed = unrelated.filter((one) => (one.statementSim ?? 0) >= cut).length;
      const wrongRejected = answers.filter((one) => (one.statementSim ?? 0) < cut).length;
      const bar = '█'.repeat(wrongEndorsed) + '·'.repeat(wrongRejected);
      console.log(
        `  ${cut.toFixed(2)}  ${String(wrongEndorsed).padStart(4)}  ` +
          `${String(wrongRejected).padStart(20)}   ${bar}`,
      );
    }
    console.log(
      `\n  for comparison, the shipping grade endorses ` +
        `${rows.flatMap((r) => r.positions).filter((o) => o.verdict === 'unrelated' && o.fit === 'close').length}` +
        ` of those ${unrelated.length} unrelated Positions as \`close\`.`,
    );
  }

  console.log('\n############ 6. every Position, in the order it was served\n');
  for (const row of rows) {
    console.log(`\n${row.person} / "${row.query}"   floor ${row.floor}`);
    if (row.positions.length === 0) {
      console.log('   (empty answer)');
      continue;
    }
    for (const one of row.positions) {
      console.log(
        `   ${one.fit.padEnd(7)} item ${one.similarity.toFixed(3)}  ` +
          `stmt ${(one.statementSim ?? NaN).toFixed(3)}  quote ${(one.quoteSim ?? NaN).toFixed(3)}  ` +
          `[${one.verdict.padEnd(9)}] ${one.slug}`,
      );
    }
  }
}

let rows: Scored[] = COLLECT
  ? await collect()
  : (JSON.parse(readFileSync(SCORED, 'utf8')) as Scored[]);
if (ADD_EMBEDDINGS) {
  if (!EMBED_KEY) throw new Error('EMBED_KEY is not set, and the Corpus space is the point');
  rows = await addEmbeddings(rows);
}
if (ARGV.includes('--judge-quotes')) rows = await addQuoteJudge(rows);
tally(rows);

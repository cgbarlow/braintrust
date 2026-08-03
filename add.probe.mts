import { createSynthesiser, SYNTHESIS_TIMEOUT_MS } from './src/compile/index.js';
import { createDb } from './src/db.js';
import { followPerson, type PlanResponse } from './src/follow/index.js';
import { createConfirmTokenStore } from './src/follow/tokens.js';
import { runCycle, summarise } from './src/ingest/cycle.js';
import { createFetcher } from './src/net/fetch.js';
import { createExtractor, EXTRACTOR_TIMEOUT_MS } from './src/notes/index.js';
import { createEmbedder } from './src/retrieval/index.js';

const db = createDb(process.env.BRAINTRUST_DATABASE_URL!);
const fetcher = createFetcher({ timeoutMs: 30_000 });
const chat = { baseUrl: 'https://api.agentics.org.nz/v1', model: 'unsloth/gpt-oss-120b-GGUF', apiKey: process.env.CHAT_KEY! };
const stamp = (l: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`);

const people: [string, string, string[]][] = [
  ['ethan-mollick', 'Ethan Mollick', ['https://www.oneusefulthing.org/', '@oneusefulthing']],
  ['nate-b-jones', 'Nate B. Jones', ['https://natesnewsletter.substack.com/', '@NateBJones']],
];

for (const [slug, name, links] of people) {
  const { rows } = await db.query<{ slug: string }>(`select slug from braintrust_people where slug = $1`, [slug]);
  if (rows.length > 0) { stamp(`${name}: already followed`); continue; }
  const tokens = createConfirmTokenStore();
  const plan = (await followPerson({ links }, { db, tokens, fetcher })) as PlanResponse;
  for (const s of plan.plan.sources) stamp(`${name}: ${s.platform} ${s.handle} — ${s.items.count} items (${s.items.basis})`);
  stamp(`${name}: ~${plan.plan.estimated_duration_min} min of fetching`);
  await followPerson({ confirm_token: plan.confirm_token, display_name: name }, { db, tokens, fetcher });
  stamp(`${name}: followed.`);
}

const report = await runCycle({
  db, fetcher,
  embedder: createEmbedder({ baseUrl: 'https://embed.chrisbarlow.nz/v1', model: 'text-embedding-qwen3-embedding-0.6b', apiKey: process.env.EMBED_KEY! }, createFetcher({ timeoutMs: 120_000 })),
  extractor: createExtractor(chat, createFetcher({ timeoutMs: EXTRACTOR_TIMEOUT_MS })),
  synthesiser: createSynthesiser(chat, createFetcher({ timeoutMs: SYNTHESIS_TIMEOUT_MS })),
  log: stamp,
});
console.log('\n' + summarise(report));
await db.close();

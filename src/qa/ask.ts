/**
 * The golden set as **questions a reader would actually ask**, rather than item titles.
 *
 * **Why this exists.** ./sample.ts asks a Person's own titles back to `find_positions`, on
 * the reasoning that a real title is guaranteed to have material behind it. That reasoning
 * still holds and the register does not: a title is written to be clicked, not asked.
 * "On Working with Wizards", "Mass Intelligence" and "Sign of the future: GPT-5.5" share
 * almost no vocabulary with any sentence stating what the item argued, which is measured in
 * docs/research/issue-304-generic-statements.md §3 — it is what made one candidate ranking
 * fix untestable, because there was nothing in the question for it to catch. A set that
 * measures a register no reader uses will keep sending fixes to the wrong place.
 *
 * **Derived from the person's own words, never from a Position.** The quote handed to the
 * asker comes from ../notes — tier 2, what braintrust *read*. A question written from a
 * Position statement would be asking the compiler to find the sentence it just wrote, and
 * every compile would score well on its own phrasing. The whole point is to test the path
 * from what somebody published to what braintrust concluded, so the question may only ever
 * come from the published end of it.
 *
 * **Cached, because a golden set that moves is not one.** Two runs scored on two different
 * questions produce two numbers nobody can compare. Generation is `temperature: 0` over a
 * deterministic item order, and the result is written to `QUESTIONS_CACHE` and reused
 * until the file is deleted — so a re-run costs nothing and a regenerate is deliberate.
 * The file is a measurement artifact rather than source: it belongs to the corpus it was
 * generated from, and a different corpus should regenerate rather than inherit it.
 */

import { readFile, writeFile } from 'node:fs/promises';

import type { ExtractorConfig } from '../config.js';
import type { Db } from '../db.js';
import { chatUrl } from '../notes/extractor.js';
import { fetchPatiently, type Fetcher } from '../net/fetch.js';
import type { GoldenQuestion } from './sample.js';

/** Where the generated set is kept. Deleting it is how you ask for a new one. */
export const QUESTIONS_CACHE = '.qa-questions.json';

/**
 * The asker's prompt.
 *
 * It is shown one passage and asked for the question that passage answers. It is **not**
 * shown the person, the title, or anything braintrust concluded — a question naming the
 * person would let retrieval match on the name, and a question built from a title would
 * reintroduce exactly the register this module exists to leave behind.
 */
const ASKER = `You are given one passage from something a person published.

Write the single question a reader would ask that this passage answers.

Rules:
- Write it the way somebody types a question into a chat, not the way a headline is written.
- Ask about the substance. Never mention the author, the title, the publication or the date.
- One sentence, ending in a question mark.
- Do not quote the passage back.

Return one JSON object: {"question": "<the question>"}.`;

type Asked = { item_id: string; question: string };

/** One passage per item: the longest quote braintrust recorded from it. */
async function quotesFor(db: Db, itemIds: string[]): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();

  const { rows } = await db.query<{ item_id: string; quote: string }>(
    // The longest quote, because a two-word claim is not enough for anybody to write a
    // question from. `distinct on` keeps exactly one per item, which is what the caller
    // needs and what makes the result stable.
    `select distinct on (n.item_id) n.item_id, claim.value ->> 'quote' as quote
       from braintrust_item_notes n
       cross join lateral jsonb_array_elements(n.claims) as claim(value)
      where n.item_id = any($1::uuid[])
        and claim.value ->> 'quote' is not null
        and btrim(claim.value ->> 'quote') <> ''
      order by n.item_id, length(claim.value ->> 'quote') desc`,
    [itemIds],
  );

  return new Map(rows.map((row) => [row.item_id, row.quote]));
}

async function askOne(
  config: ExtractorConfig,
  fetcher: Fetcher,
  passage: string,
): Promise<string | null> {
  const response = await fetchPatiently(fetcher, chatUrl(config.baseUrl), {
    json: {
      model: config.model,
      // Same reason ../interrogate/model.ts pins it: a set that varied on the sampler
      // would be measuring the sampler on top of everything it already cannot pin down.
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ASKER },
        { role: 'user', content: passage },
      ],
    },
    ...(config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {}),
  });

  if (!response.ok) return null;

  try {
    const body = JSON.parse(await response.text()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { question?: unknown };
    const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
    return question === '' ? null : question;
  } catch {
    // An asker that returned something unparseable has not written a question. The item is
    // dropped from the set rather than scored against whatever came back.
    return null;
  }
}

/**
 * `titles` turned into questions, cached.
 *
 * Items whose question could not be generated are **dropped, never replaced by their
 * title** — a set half in one register and half in another measures neither.
 */
export async function naturalQuestions(
  db: Db,
  titles: GoldenQuestion[],
  config: ExtractorConfig,
  fetcher: Fetcher,
  log: (line: string) => void = () => {},
): Promise<GoldenQuestion[]> {
  const cached = new Map<string, string>();
  try {
    const raw = await readFile(QUESTIONS_CACHE, 'utf8');
    for (const entry of JSON.parse(raw) as Asked[]) cached.set(entry.item_id, entry.question);
  } catch {
    // No cache yet, or an unreadable one. Either way the set is generated from scratch.
  }

  const missing = titles.filter((title) => !cached.has(title.item_id));
  if (missing.length > 0) {
    log(`generating ${missing.length} question(s) from quotes — cached in ${QUESTIONS_CACHE} afterwards.`);
    const quotes = await quotesFor(db, missing.map((title) => title.item_id));

    for (const title of missing) {
      const passage = quotes.get(title.item_id);
      if (passage === undefined) continue;
      const question = await askOne(config, fetcher, passage);
      if (question !== null) cached.set(title.item_id, question);
    }

    const merged: Asked[] = [...cached].map(([item_id, question]) => ({ item_id, question }));
    await writeFile(QUESTIONS_CACHE, JSON.stringify(merged, null, 2));
  }

  return titles.flatMap((title) => {
    const question = cached.get(title.item_id);
    return question === undefined ? [] : [{ ...title, query: question }];
  });
}

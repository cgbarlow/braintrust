/**
 * The Note extractor: the one genuinely expensive job in braintrust.
 *
 * ~1.6M tokens in and ~0.3M out to stand a Corpus up, against about three cents to
 * re-embed the same words. That asymmetry is the whole reason Notes exist: published
 * Items are immutable, so a video from March is the same video in December and
 * re-reading it on every Compile pays repeatedly for an answer that cannot change.
 *
 * **braintrust declares no extractor model**, for the same reason it declares no
 * embedding model. It calls whatever OpenAI-compatible `/v1/chat/completions` endpoint
 * it is configured with, and the endpoint is handed whole published Items — where those
 * go is the operator's decision to make rather than braintrust's to assume.
 *
 * **The prompt is a starting point, not a finding.** The spec leaves it deliberately
 * undecided. It is versioned so that changing it writes a new generation of Notes
 * alongside the old ones rather than migrating them.
 *
 * See docs/design/compiler.md §1.
 */

import type { ExtractorConfig } from '../config.js';
import { BraintrustError } from '../errors.js';
import type { Fetcher } from '../net/fetch.js';

/**
 * Bumping this is a re-read of the Corpus, not a migration: `extractor` is in the
 * unique key of `braintrust_item_notes`, so the old generation stays readable and the
 * Persona built from it stays live while the new one fills in.
 */
export const PROMPT_VERSION = 'notes-1';

/** An LLM call is not a 20-second fetch. A long transcript takes a model minutes. */
export const EXTRACTOR_TIMEOUT_MS = 300_000;

/**
 * What braintrust asks for, and — as importantly — what it does not.
 *
 * **It asks only for the quote, never for a chunk id or a timestamp.** Asking a model
 * to report which Chunk a quote came from invites an invented id that nothing
 * downstream could check. The quote is the one thing that is verifiable against the
 * stored body, so it is the only locator braintrust accepts; the Chunk and the
 * timestamp are then read off the rows.
 *
 * Two instructions carry most of the weight. *Copy the quote exactly* is what makes
 * verification possible at all. *The argument and the assumptions, not just the
 * conclusions* is what makes a Note worth more than a summary — a Persona's Reasoning
 * layer is compiled from how someone got somewhere, which a list of conclusions has
 * already thrown away.
 */
export const SYSTEM_PROMPT = [
  'You are reading one published item — an essay or a talk transcript — on behalf of a tool',
  'that builds a model of how its author thinks. You will be asked to read many of these, and',
  'each one is read exactly once, so what you write down is all any later step will ever see.',
  '',
  'Return a single JSON object, and nothing else:',
  '',
  '{',
  '  "claims": [{ "statement": "...", "quote": "..." }],',
  '  "argument": "...",',
  '  "assumptions": ["..."]',
  '}',
  '',
  'claims — the positions the author actually takes, in their own terms. A claim is something',
  '  they assert, not something they mention. For each one:',
  '    statement: the claim in one sentence, as they would put it, not as a topic label.',
  '    quote: the words from the item that assert it, COPIED EXACTLY, character for character,',
  '      from the text you were given. Do not fix spelling, punctuation, capitalisation or',
  '      transcription errors, and do not stitch together phrases from different places. A quote',
  '      that is not in the text verbatim will be discarded, and the claim with it. Prefer one',
  '      sentence; never more than three.',
  '',
  'argument — how they get from where they start to what they conclude, in a short paragraph.',
  '  The moves, not the topics: what they take as given, what they reject and why, what the',
  '  turn in the reasoning is. This is what a later step reads to describe how they think.',
  '',
  'assumptions — what has to be true for the argument to work, that the author does not argue',
  '  for. Things they treat as settled. Omit the obvious ones.',
  '',
  'This is a transcript of speech when it reads like one: unpunctuated, repetitive, with',
  'mis-heard names and terms. Read past that. It is what the person said.',
  '',
  'If the item genuinely asserts nothing — it is an announcement, a list of links, an advert —',
  'return an empty claims array and say so in argument. Do not invent claims to fill it.',
].join('\n');

export type RawClaim = { statement: string; quote: string };

export type RawNote = {
  claims: RawClaim[];
  argument: string;
  assumptions: string[];
};

export type Extractor = {
  /** `model@prompt-version` — the generation, and the unique key of a Note. */
  generation: string;
  model: string;
  url: string;
  read(item: { title?: string | undefined; text: string }): Promise<RawNote>;
};

export function chatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

export function createExtractor(config: ExtractorConfig, fetcher: Fetcher): Extractor {
  const url = chatUrl(config.baseUrl);

  return {
    generation: `${config.model}@${PROMPT_VERSION}`,
    model: config.model,
    url,

    async read(item): Promise<RawNote> {
      // The whole Item, deliberately. Chunk boundaries serve retrieval and have no
      // business constraining what the compiler needs in order to follow an argument.
      const user = [item.title ? `Title: ${item.title}` : '', '', item.text].join('\n').trim();

      let response;
      try {
        response = await fetcher(url, {
          json: {
            model: config.model,
            // Nothing here wants variety: two runs over the same immutable item should
            // not disagree about what it said.
            temperature: 0,
            // Declared, not just asked for in prose. Every prompt braintrust sends says
            // "return a single JSON object and nothing else", so saying it in the request
            // as well costs nothing and buys two things: endpoints that can constrain
            // decoding do, and endpoints whose own output parser is fragile take the
            // structured path instead. Found live — a gpt-oss server returned HTTP 500
            // parsing its own model's `<|constrain|>json` marker, and answered cleanly
            // with this set.
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: user },
            ],
          },
          ...(config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {}),
        });
      } catch (error) {
        throw new BraintrustError(
          `braintrust could not reach the note extractor at ${url}: ${(error as Error).message}. ` +
            'The item is still retrieved; the next run reads it.',
        );
      }

      if (!response.ok) {
        throw new BraintrustError(
          `The note extractor at ${url} answered HTTP ${response.status} for model ` +
            `"${config.model}".`,
        );
      }

      return readNote(await response.text(), url);
    },
  };
}

type ChatResponse = {
  choices?: { message?: { content?: unknown } }[];
};

function readNote(body: string, url: string): RawNote {
  let parsed: ChatResponse;
  try {
    parsed = JSON.parse(body) as ChatResponse;
  } catch {
    throw new BraintrustError(
      `The note extractor at ${url} did not return JSON. That usually means the base URL ` +
        'points at something other than an OpenAI-compatible API.',
    );
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new BraintrustError(`The note extractor at ${url} returned no content.`);
  }

  return readNoteContent(content, url);
}

/**
 * Parses the model's answer. Tolerant about the wrapper — a fenced block or a sentence
 * of preamble is a formatting habit, not a failure — and strict about the contents,
 * because a malformed claim is a claim braintrust would be storing without knowing what
 * it says.
 */
export function readNoteContent(content: string, url: string): RawNote {
  const json = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');

  let note: Record<string, unknown>;
  try {
    note = JSON.parse(start >= 0 && end > start ? json.slice(start, end + 1) : json) as Record<
      string,
      unknown
    >;
  } catch {
    throw new BraintrustError(
      `The note extractor at ${url} returned something that is not a JSON object: ` +
        `${content.slice(0, 200)}…`,
    );
  }

  const claims = Array.isArray(note.claims) ? note.claims : [];
  return {
    claims: claims.flatMap((claim: unknown) => {
      const { statement, quote } = (claim ?? {}) as Partial<RawClaim>;
      if (typeof statement !== 'string' || typeof quote !== 'string') return [];
      if (statement.trim() === '' || quote.trim() === '') return [];
      return [{ statement: statement.trim(), quote }];
    }),
    argument: typeof note.argument === 'string' ? note.argument.trim() : '',
    assumptions: Array.isArray(note.assumptions)
      ? note.assumptions.filter((line: unknown): line is string => typeof line === 'string' && line.trim() !== '')
      : [],
  };
}

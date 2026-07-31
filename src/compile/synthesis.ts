/**
 * The model call behind the inferred half of the Core.
 *
 * **Nothing here reads an Item.** The extractor read each Item once and wrote down what
 * it said; this reads those Notes. That is the whole economics of a daily rebuild — a
 * Compile costs a handful of calls over notes rather than a re-read of 1.17M words — and
 * it is also why Reasoning and Beliefs can exist at all. Beliefs cannot be extracted per
 * Item: belief-marker mining was tested and most of what it found explained a mechanism
 * rather than stated a conviction. A conviction is what has to be true for many claims to
 * make sense, so the only place it can be seen is across them.
 *
 * **The prompts are a starting point, not a finding**, exactly as the extractor's is, and
 * they are versioned for the same reason: changing one changes what a Persona says, so
 * the version travels on the Compile row rather than being inferred from whatever is
 * configured now.
 *
 * See docs/design/compiler.md §2 and §3.
 */

import type { ExtractorConfig } from '../config.js';
import { BraintrustError } from '../errors.js';
import type { Fetcher } from '../net/fetch.js';

/**
 * Bumping this changes the prose a Persona is built from, so it is part of
 * `compiler_version` — which is on the Compile row and travels out through both read
 * tools. Unlike the extractor generation, bumping this is cheap: it re-synthesises from
 * Notes that already exist rather than re-reading the Corpus.
 */
export const SYNTHESIS_VERSION = 'core-1';

/** Synthesis is a long read for a model, like the extractor's. Not a 20-second fetch. */
export const SYNTHESIS_TIMEOUT_MS = 300_000;

export type InferredKind = 'reasoning' | 'beliefs';

/** One inferred move or conviction, and the Items it was traced to. */
export type SynthesisedEntry = {
  label: string;
  body: string;
  /** Item `external_id`s. Verified against the Notes that were handed over, never trusted. */
  items: string[];
};

export type Synthesiser = {
  /** `model@prompt-version`. Half of `compiler_version`; the other half is the measurement. */
  generation: string;
  model: string;
  url: string;
  synthesise(kind: InferredKind, digest: string, mode: SynthesisMode): Promise<SynthesisedEntry[]>;
};

/** A pass reads Notes; a merge reads the passes. Same call, one extra instruction. */
export type SynthesisMode = 'pass' | 'merge';

/**
 * How many entries a layer may carry. The Core is bounded on purpose — it is what a
 * client loads whole to sound like someone, and a Core that grows with the Corpus stops
 * being affordable to regenerate, which is what the no-drift guarantee rests on.
 */
export const MAX_ENTRIES = 8;

const SHARED = [
  'Return a single JSON object, and nothing else:',
  '',
  '{ "entries": [ { "label": "...", "body": "...", "items": ["item-id", ...] } ] }',
  '',
  `At most ${MAX_ENTRIES} entries, the best-supported first.`,
  '',
  'items — the ids of the items this entry is visible in, copied exactly from the [id] markers',
  '  in the notes below. Only ids you were actually given: an id that is not among them will be',
  '  dropped, and an entry left with none will be dropped with it.',
  '',
  'Do not flatter and do not grade. This describes a method, not a review of one.',
  'Do not describe the subject matter. Two people writing about the same field think',
  '  differently, and that difference is the only thing here worth having.',
  'If the notes do not support an entry across several items, leave it out. A short list that',
  '  is really there beats a long one that is partly hoped for.',
].join('\n');

/**
 * Two prompts because they are two questions. Reasoning is *how they get there*; Beliefs
 * is *what they take as true on the way*. A Note carries the argument and the assumptions
 * precisely so that the first question has something to read — a list of conclusions has
 * already thrown away the moves that make someone recognisable.
 */
export const PROMPTS: Record<InferredKind, string> = {
  reasoning: [
    "You are reading braintrust's own notes on many published items by one author — for each",
    'item, how the argument runs and what it assumes. No single item states how this person',
    'thinks. Inferring that across all of them is the job.',
    '',
    SHARED,
    '',
    'Each entry is one move this person makes when they reason: what they take as given, how',
    'they get from a premise to a conclusion, what kind of evidence moves them, where they stop.',
    '  label: the move in a few words. Name the move, not the topic.',
    '  body: two or three sentences on how they reason — not what they concluded, and not',
    '    whether they were right.',
  ].join('\n'),

  beliefs: [
    "You are reading braintrust's own notes on many published items by one author — the claims",
    'each item makes and what each argument assumes. No single item asserts a belief; a belief',
    'is what has to be true for many claims to make sense. Inferring those is the job.',
    '',
    SHARED,
    '',
    'Each entry is one conviction this person holds and argues from, rather than a topic they',
    'cover.',
    '  label: the conviction in one short sentence, as they would put it.',
    '  body: two or three sentences — what they hold, and what they do with it.',
    '',
    'A claim is made in one item. Prefer convictions that show up across items in different',
    '  words to ones stated loudly once.',
    'Stay inside the published work. Do not infer anything about this person\'s private life,',
    '  their politics or their character from work that is about something else.',
  ].join('\n'),
};

const MERGE = [
  '',
  'These entries were produced by reading the corpus in several passes, so the same one may',
  'appear more than once in different words. Merge those, keeping the clearest label and the',
  'union of their item ids. Do not invent entries that are not in the input, and do not add',
  'item ids that are not already against an entry you are merging.',
].join('\n');

export function createSynthesiser(config: ExtractorConfig, fetcher: Fetcher): Synthesiser {
  const url = chatUrl(config.baseUrl);

  return {
    generation: `${config.model}@${SYNTHESIS_VERSION}`,
    model: config.model,
    url,

    async synthesise(kind, digest, mode): Promise<SynthesisedEntry[]> {
      let response;
      try {
        response = await fetcher(url, {
          json: {
            model: config.model,
            // Two Compiles over an unchanged Corpus should not disagree about how
            // someone thinks. A rebuild is a replacement, so any variety here would
            // read as the person having changed.
            temperature: 0,
            messages: [
              { role: 'system', content: PROMPTS[kind] + (mode === 'merge' ? MERGE : '') },
              { role: 'user', content: digest },
            ],
          },
          ...(config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {}),
        });
      } catch (error) {
        throw new BraintrustError(
          `braintrust could not reach the synthesiser at ${url} while compiling ${kind}: ` +
            `${(error as Error).message}. The notes are already written; the next run rebuilds.`,
        );
      }

      if (!response.ok) {
        throw new BraintrustError(
          `The synthesiser at ${url} answered HTTP ${response.status} for model ` +
            `"${config.model}" while compiling ${kind}.`,
        );
      }

      return readEntries(await response.text(), url, kind);
    },
  };
}

export function chatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

type ChatResponse = { choices?: { message?: { content?: unknown } }[] };

function readEntries(body: string, url: string, kind: InferredKind): SynthesisedEntry[] {
  let parsed: ChatResponse;
  try {
    parsed = JSON.parse(body) as ChatResponse;
  } catch {
    throw new BraintrustError(
      `The synthesiser at ${url} did not return JSON. That usually means the base URL points ` +
        'at something other than an OpenAI-compatible API.',
    );
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new BraintrustError(`The synthesiser at ${url} returned no content for ${kind}.`);
  }

  return readEntryContent(content, url);
}

/**
 * Tolerant about the wrapper and strict about the contents, like the Note parser. An
 * entry missing a label or a body is dropped rather than stored half-formed: it would
 * otherwise reach a Persona as a heading with nothing under it.
 */
export function readEntryContent(content: string, url: string): SynthesisedEntry[] {
  const json = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(start >= 0 && end > start ? json.slice(start, end + 1) : json) as Record<
      string,
      unknown
    >;
  } catch {
    throw new BraintrustError(
      `The synthesiser at ${url} returned something that is not a JSON object: ` +
        `${content.slice(0, 200)}…`,
    );
  }

  // An empty `entries` is a legitimate answer — the prompt asks for a short list that is
  // really there rather than a long one that is partly hoped for. A *missing* `entries`
  // is not: it means the model answered a different question, and letting it through as
  // an empty layer would reach the gate as "beliefs carried nothing to serve", which
  // sends whoever reads it looking at the corpus instead of at the endpoint. Found live.
  if (!Array.isArray(parsed.entries)) {
    throw new BraintrustError(
      `The synthesiser at ${url} returned JSON with no entries array: ` +
        `${content.slice(0, 200)}…`,
    );
  }

  return parsed.entries
    .flatMap((entry: unknown) => {
      const { label, body, items } = (entry ?? {}) as Partial<SynthesisedEntry>;
      if (typeof label !== 'string' || typeof body !== 'string') return [];
      if (label.trim() === '' || body.trim() === '') return [];
      return [
        {
          label: label.trim(),
          body: body.trim(),
          items: Array.isArray(items)
            ? items.filter((one: unknown): one is string => typeof one === 'string')
            : [],
        },
      ];
    })
    .slice(0, MAX_ENTRIES);
}

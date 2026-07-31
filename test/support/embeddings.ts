/**
 * A stand-in for the operator's embeddings endpoint.
 *
 * Deterministic rather than random: a vector derived from the text means two runs
 * embedding the same Chunk produce the same numbers, so a test can assert that a
 * re-index wrote the same thing rather than merely wrote something.
 */

import type { EmbeddingsConfig } from '../../src/config.js';
import type { FetchResponse, Fetcher } from '../../src/net/fetch.js';
import type { Embedder } from '../../src/retrieval/embed.js';

export const TEST_DIMENSION = 1024;

export type FakeEmbeddings = {
  fetcher: Fetcher;
  /** Every request, so a test can count round trips and check the batch size. */
  sent: { url: string; model: string; input: string[]; authorization?: string }[];
  /** Total inputs embedded across all requests. */
  inputs(): number;
};

export type FakeOptions = {
  dimension?: number;
  /** Answer with this status instead of a body. */
  status?: number;
  /** Return a body that is not what an OpenAI-compatible endpoint returns. */
  body?: string;
  /** Return the batch reversed, with `index` saying so. Some servers do this. */
  shuffled?: boolean;
};

export function fakeEmbeddings(options: FakeOptions = {}): FakeEmbeddings {
  const dimension = options.dimension ?? TEST_DIMENSION;
  const sent: FakeEmbeddings['sent'] = [];

  const fetcher: Fetcher = async (url, init) => {
    const payload = (init?.json ?? {}) as { model?: string; input?: string[] };
    sent.push({
      url,
      model: payload.model ?? '',
      input: payload.input ?? [],
      ...(init?.headers?.authorization ? { authorization: init.headers.authorization } : {}),
    });

    if (options.status && options.status >= 400) {
      return response(options.status, 'nope');
    }
    if (options.body !== undefined) {
      return response(200, options.body);
    }

    const data = (payload.input ?? []).map((text, index) => ({
      index,
      embedding: vectorFor(text, dimension),
    }));

    return response(200, JSON.stringify({ data: options.shuffled ? data.reverse() : data }));
  };

  return { fetcher, sent, inputs: () => sent.reduce((total, call) => total + call.input.length, 0) };
}

/**
 * A vector that depends on the text and nothing else — and, unlike a hash of the whole
 * string, one where **texts about the same thing land near each other**. Words are hashed
 * into dimensions and counted, so cosine similarity is vocabulary overlap.
 *
 * That property is the point. A retrieval test against a fake whose similarities are
 * arbitrary can only assert that rows came back; this one can assert that the *right* rows
 * came back, and that a question the corpus does not answer comes back empty.
 */
export function vectorFor(text: string, dimension = TEST_DIMENSION): number[] {
  const vector = new Array<number>(dimension).fill(0);

  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    // Short words are function words, and counting them makes every English sentence
    // look like every other one — measured: two unrelated passages scored 0.54 with them
    // in, higher than two passages on the same subject. A real model does not have this
    // problem; a bag of words does, and a fake that lies about relevance is worse than an
    // honest one that is crude.
    if (word.length < 4) continue;
    let hash = 7;
    for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) % 100_003;
    vector[hash % dimension]! += 1;
  }

  // pgvector has no cosine distance to a zero vector, and a text with no words at all is
  // a real thing to hand an endpoint.
  if (!vector.some((value) => value !== 0)) vector[0] = 1;
  return vector;
}

/**
 * The same fake, as an `Embedder` rather than a fetcher — what the compiler takes when it
 * looks for revision neighbourhoods. Same vectors, so a similarity a retrieval test relies
 * on is the similarity a revision test sees.
 */
export function fakeEmbedder(dimension = TEST_DIMENSION): Embedder & { batches: string[][] } {
  const batches: string[][] = [];

  return {
    model: 'test-embeddings',
    url: 'https://example.test/v1/embeddings',
    batches,
    async embed(inputs: string[]): Promise<number[][]> {
      batches.push(inputs);
      return inputs.map((text) => vectorFor(text, dimension));
    },
  };
}

export const testEmbeddingsConfig: EmbeddingsConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3-embedding:0.6b',
};

function response(status: number, body: string): FetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

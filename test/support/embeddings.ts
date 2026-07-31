/**
 * A stand-in for the operator's embeddings endpoint.
 *
 * Deterministic rather than random: a vector derived from the text means two runs
 * embedding the same Chunk produce the same numbers, so a test can assert that a
 * re-index wrote the same thing rather than merely wrote something.
 */

import type { EmbeddingsConfig } from '../../src/config.js';
import type { FetchResponse, Fetcher } from '../../src/net/fetch.js';

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

/** A unit-ish vector that depends on the text and nothing else. */
export function vectorFor(text: string, dimension = TEST_DIMENSION): number[] {
  let seed = 7;
  for (const character of text) seed = (seed * 31 + character.charCodeAt(0)) % 100_003;
  return Array.from({ length: dimension }, (_unused, index) => ((seed + index) % 97) / 97);
}

export const testEmbeddingsConfig: EmbeddingsConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen3-embedding:0.6b',
};

function response(status: number, body: string): FetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/**
 * Embedding: one model, one space, everywhere.
 *
 * braintrust declares no embedding model. It calls whatever OpenAI-compatible
 * `/v1/embeddings` endpoint it is configured with — Ollama, LM Studio, vLLM and OpenAI
 * all speak it — so local versus hosted is a config line rather than a design decision.
 * **There is no default endpoint**, because a default would mean a first run silently
 * shipping someone's entire published Corpus to a third party.
 *
 * `model` is in the primary key of `braintrust_embeddings`, so a better model is a new
 * set of rows rather than a migration: old and new coexist while you compare them, and
 * Chunks and Items are never touched.
 *
 * See docs/design/compiler.md §7 and docs/design/deployment.md §3.
 */

import type { EmbeddingsConfig } from '../config.js';
import { BraintrustError } from '../errors.js';
import { fetchPatiently, type Fetcher } from '../net/fetch.js';

/**
 * How many Chunks go in one request. The spec leaves batching and concurrency
 * deliberately undecided, so this is a starting point rather than a finding: 32 chunks
 * of ~350 tokens is ~11K tokens, which is comfortable for a small local model and one
 * round trip instead of thirty-two.
 */
export const EMBED_BATCH = 32;

/** The string braintrust embeds to ask an endpoint how wide its vectors are. */
export const PROBE_TEXT = 'braintrust startup probe';

export type Embedder = {
  model: string;
  /** The URL actually called, so a failure message can name it. */
  url: string;
  embed(inputs: string[]): Promise<number[][]>;
};

/**
 * Accepts either half of the usual confusion — a base URL ending `/v1` or the full
 * `/v1/embeddings` — because both are what people paste, and guessing wrong costs the
 * operator an evening for no reason.
 */
export function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`;
}

export function createEmbedder(
  config: EmbeddingsConfig,
  fetcher: Fetcher,
  pause?: (ms: number) => Promise<void>,
): Embedder {
  const url = embeddingsUrl(config.baseUrl);

  return {
    model: config.model,
    url,

    async embed(inputs: string[]): Promise<number[][]> {
      if (inputs.length === 0) return [];

      let response;
      try {
        response = await fetchPatiently(fetcher, url, {
          json: { model: config.model, input: inputs },
          ...(config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {}),
        }, pause);
      } catch (error) {
        throw new BraintrustError(
          `braintrust could not reach the embeddings endpoint at ${url}: ${
            (error as Error).message
          }. Nothing was embedded; the Chunks are on disk and the next run continues.`,
        );
      }

      if (!response.ok) {
        throw new BraintrustError(
          `The embeddings endpoint at ${url} answered HTTP ${response.status} for model ` +
            `"${config.model}". Check the model name and the key, if it needs one.`,
        );
      }

      return readVectors(await response.text(), inputs.length, url);
    },
  };
}

type EmbeddingsResponse = {
  data?: { embedding?: unknown; index?: unknown }[];
};

/**
 * Reads the response, and is strict about it on purpose. A truncated or reordered
 * batch would attach one Chunk's vector to another Chunk's id, and nothing downstream
 * could ever detect it — retrieval would simply be quietly wrong.
 */
function readVectors(body: string, expected: number, url: string): number[][] {
  let parsed: EmbeddingsResponse;
  try {
    parsed = JSON.parse(body) as EmbeddingsResponse;
  } catch {
    throw new BraintrustError(
      `The embeddings endpoint at ${url} did not return JSON. That usually means the base ` +
        'URL points at something other than an OpenAI-compatible API.',
    );
  }

  const data = parsed.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new BraintrustError(
      `The embeddings endpoint at ${url} returned ${
        Array.isArray(data) ? data.length : 'no'
      } vectors for ${expected} inputs. braintrust will not guess which is which.`,
    );
  }

  // Some servers return the batch out of order; `index` is what says so.
  const ordered = data.every((entry) => typeof entry.index === 'number')
    ? [...data].sort((left, right) => (left.index as number) - (right.index as number))
    : data;

  return ordered.map((entry, position) => {
    const vector = entry.embedding;
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(isFinite)) {
      throw new BraintrustError(
        `The embeddings endpoint at ${url} returned something that is not a vector at ` +
          `position ${position}.`,
      );
    }
    return vector as number[];
  });
}

function isFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** pgvector's literal form. `[1,2,3]`, cast to `vector` at the insert. */
export function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

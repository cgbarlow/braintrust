/**
 * A stand-in for the operator's note extractor.
 *
 * It answers with whatever the test tells it to, in the shape an OpenAI-compatible
 * chat endpoint answers in — which is the only part of a model braintrust depends on.
 */

import type { ExtractorConfig } from '../../src/config.js';
import type { FetchResponse, Fetcher } from '../../src/net/fetch.js';
import type { RawNote } from '../../src/notes/extractor.js';

export const testExtractorConfig: ExtractorConfig = {
  baseUrl: 'https://models.test/v1',
  model: 'test-reader',
};

export const TEST_GENERATION = `${testExtractorConfig.model}@notes-1`;

export type FakeExtractor = {
  fetcher: Fetcher;
  /** Every request, so a test can check what the model was actually shown. */
  sent: {
    url: string;
    model: string;
    system: string;
    user: string;
    authorization?: string;
    /** What the request itself declared about the answer's shape, not just what the prompt asked for. */
    responseFormat?: string;
  }[];
};

export type FakeOptions = {
  /** Answer with this note for every item, or per item in order. */
  note?: RawNote | ((user: string, index: number) => RawNote | string);
  status?: number;
  /** Return this string as the message content instead of JSON. */
  content?: string;
};

export function fakeExtractor(options: FakeOptions = {}): FakeExtractor {
  const sent: FakeExtractor['sent'] = [];

  const fetcher: Fetcher = async (url, init) => {
    const payload = (init?.json ?? {}) as {
      model?: string;
      response_format?: { type?: string };
      messages?: { role: string; content: string }[];
    };
    const system = payload.messages?.find((message) => message.role === 'system')?.content ?? '';
    const user = payload.messages?.find((message) => message.role === 'user')?.content ?? '';

    sent.push({
      url,
      model: payload.model ?? '',
      system,
      user,
      ...(init?.headers?.authorization ? { authorization: init.headers.authorization } : {}),
      ...(payload.response_format?.type ? { responseFormat: payload.response_format.type } : {}),
    });

    if (options.status && options.status >= 400) return response(options.status, 'nope');

    const answer =
      options.content ??
      (typeof options.note === 'function'
        ? asContent(options.note(user, sent.length - 1))
        : JSON.stringify(options.note ?? { claims: [], argument: 'nothing asserted', assumptions: [] }));

    return response(200, JSON.stringify({ choices: [{ message: { content: answer } }] }));
  };

  return { fetcher, sent };
}

function asContent(note: RawNote | string): string {
  return typeof note === 'string' ? note : JSON.stringify(note);
}

function response(status: number, body: string): FetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

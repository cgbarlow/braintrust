/**
 * The synthesiser on the wire.
 *
 * These are transport tests, not prompt tests: what the request declares, and what braintrust
 * can read back. The one property they exist to hold is that **a synthesis pass never leaves
 * the connection silent**, because a silent connection is the one failure mode that reaches
 * braintrust as nothing it can act on — no status, no refusal, just `fetch failed` after
 * minutes of work, and a Persona that never rebuilds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSynthesiser } from '../src/compile/synthesis.js';
import type { FetchInit, Fetcher } from '../src/net/fetch.js';

const CONFIG = { baseUrl: 'https://models.test/v1', model: 'a-model', apiKey: 'k' };

const ANSWER = { positions: [{ slug: 'a-position', statement: 'They hold a thing.', claims: ['c1'] }] };

/** Records what was sent, answers with whatever body the test names. */
function endpoint(body: string): { fetcher: Fetcher; sent: FetchInit['json'][] } {
  const sent: FetchInit['json'][] = [];
  const fetcher: Fetcher = async (_url, init) => {
    if (init) sent.push(init.json);
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetcher, sent };
}

/** An OpenAI-compatible stream: deltas, then the sentinel. */
function streamed(content: string, chunk = 12): string {
  const events: string[] = [];
  for (let at = 0; at < content.length; at += chunk) {
    events.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(at, at + chunk) } }] })}\n\n`,
    );
  }
  return `${events.join('')}data: [DONE]\n\n`;
}

describe('the synthesiser on the wire', () => {
  /**
   * Found live. The largest Corpus in a council failed its rebuild four runs running with
   * `fetch failed` while every smaller Person compiled over the same endpoint in the same
   * run — because only its passes generated for long enough to trip a proxy's read timeout,
   * and a non-streamed request sends no bytes at all while a model is thinking.
   *
   * braintrust does not display the deltas and does not want them. It asks for the stream so
   * that bytes keep moving, which is what stops something in the middle deciding the
   * connection is dead.
   */
  it('asks for a stream, so a long pass never goes silent on the wire', async () => {
    const wire = endpoint(streamed(JSON.stringify(ANSWER)));
    await createSynthesiser(CONFIG, wire.fetcher).cluster('[c1] a claim', 'pass');

    assert.equal((wire.sent[0] as { stream?: unknown }).stream, true);
  });

  it('joins a streamed answer back into the object it was cut from', async () => {
    const wire = endpoint(streamed(JSON.stringify(ANSWER)));
    const positions = await createSynthesiser(CONFIG, wire.fetcher).cluster('[c1] a claim', 'pass');

    assert.deepEqual(
      positions.map((position) => position.slug),
      ['a-position'],
    );
  });

  /**
   * `stream: true` is a request braintrust makes, not a promise the endpoint gives. A server
   * free to ignore it answers with the whole object, and that answer is still correct — so
   * both shapes are read and neither is an error.
   */
  it('still reads a whole object from an endpoint that ignores the request', async () => {
    const wire = endpoint(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ANSWER) } }] }));
    const positions = await createSynthesiser(CONFIG, wire.fetcher).cluster('[c1] a claim', 'pass');

    assert.deepEqual(
      positions.map((position) => position.slug),
      ['a-position'],
    );
  });

  it('reads a stream of whole messages, because some servers send those', async () => {
    const wire = endpoint(
      `data: ${JSON.stringify({ choices: [{ message: { content: JSON.stringify(ANSWER) } }] })}\n\ndata: [DONE]\n\n`,
    );
    const positions = await createSynthesiser(CONFIG, wire.fetcher).cluster('[c1] a claim', 'pass');

    assert.equal(positions.length, 1);
  });

  /**
   * Found live, and only after streaming was turned on. A streamed request answers at the
   * headers and then delivers for as long as the model takes, so the client's own timeout
   * now fires while the body is being read rather than on the call — and that step was the
   * one outside the wrapping. The run reported `The operation was aborted due to timeout`
   * with no endpoint, no stage, and no word about the notes being safe.
   */
  it('says which endpoint and which pass when the answer is lost mid-body', async () => {
    const cutMidStream: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('The operation was aborted due to timeout');
      },
    });

    await assert.rejects(
      createSynthesiser(CONFIG, cutMidStream).cluster('[c1] a claim', 'pass'),
      (error: Error) => {
        assert.match(error.message, /models\.test/);
        assert.match(error.message, /while compiling positions/);
        assert.match(error.message, /aborted due to timeout/);
        assert.match(error.message, /notes are already written/);
        return true;
      },
    );
  });

  /**
   * A keep-alive comment or a dropped line is not an answer and not a disaster. What must
   * never happen is a stream carrying nothing being read as an empty layer — the same
   * live-found lesson the core and the clusterer already hold: a wrongly-shaped answer that
   * arrives as emptiness sends whoever reads it to the corpus instead of to the endpoint.
   */
  it('reports a stream that carried no content as no content, not as an empty answer', async () => {
    const wire = endpoint(': keep-alive\n\ndata: {"choices":[{}]}\n\ndata: [DONE]\n\n');

    await assert.rejects(
      createSynthesiser(CONFIG, wire.fetcher).cluster('[c1] a claim', 'pass'),
      /returned no content for positions/,
    );
  });
});

describe('what a run can tell about its own model calls', () => {
  it('times every call and names which half of a stage it was', async () => {
    const lines: string[] = [];
    const wire = endpoint(streamed(JSON.stringify(ANSWER)));
    const synthesiser = createSynthesiser(CONFIG, wire.fetcher, undefined, (line) => lines.push(line));

    await synthesiser.cluster('[c1] a claim', 'pass');
    await synthesiser.cluster('[c1] a claim', 'merge');

    assert.match(lines[0]!, /positions — \d+ chars in, \d+ chars out|positions — [\d,]+ chars in/);
    assert.match(lines[1]!, /positions \(merge\)/);
    assert.doesNotMatch(lines[0]!, /merge/, 'a pass keeps the bare stage name');
  });

  /**
   * The distinction has to survive into the failure, because that is where it is needed:
   * a pass is long because the Corpus is large and the merge because the passes were many,
   * and the fix for one makes the other worse.
   */
  it('says which half, how long, and how big when a call is lost', async () => {
    const lost: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error('The operation was aborted due to timeout');
      },
    });

    await assert.rejects(createSynthesiser(CONFIG, lost).cluster('[c1] a claim', 'merge'), (error: Error) => {
      assert.match(error.message, /while compiling positions \(merge\)/);
      assert.match(error.message, /after \d+s of a [\d,]+-character digest/);
      return true;
    });
  });
});

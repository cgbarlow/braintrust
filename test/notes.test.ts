/**
 * The read-once pass, and the check that decides what a claim is.
 *
 * The verification tests are the ones that matter. Everything downstream — a Position,
 * its citation, the quote a human reads — rests on one property: **the quote is in the
 * body, and it is the body's characters rather than the model's.** A model that tidies
 * a transcription error is being helpful and is also making braintrust cite itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BraintrustError } from '../src/errors.js';
import { TRANSPORT_RETRY_MS, type Fetcher } from '../src/net/fetch.js';
import {
  chatUrl,
  createExtractor,
  locate,
  locateLoosely,
  PROMPT_VERSION,
  readNoteContent,
  SYSTEM_PROMPT,
  verifyClaims,
  type ChunkSpan,
} from '../src/notes/index.js';
import { fakeExtractor, TEST_GENERATION, testExtractorConfig } from './support/notes.js';

const BODY = [
  'The tools keep getting better and the prices keep dropping.',
  'And yet the work is not getting cheaper, which is the part nobody expected.',
].join('\n\n');

const CHUNKS: ChunkSpan[] = [
  { id: 'chunk-a', char_start: 0, char_end: 59, start_ms: 0 },
  { id: 'chunk-b', char_start: 61, char_end: BODY.length, start_ms: 42_000 },
];

describe('locating a quote', () => {
  it('finds one that was copied exactly', () => {
    assert.deepEqual(locate('the prices keep dropping', BODY), { start: 34, end: 58 });
  });

  it('finds one whose whitespace the model reflowed', () => {
    // A paragraph break is not something a model can reasonably preserve inside a JSON
    // string, and the words are unchanged. Everything else is a difference that matters.
    const span = locate('dropping. And yet the work', BODY)!;
    assert.equal(BODY.slice(span.start, span.end), 'dropping.\n\nAnd yet the work');
  });

  it('does not find one whose words were repaired', () => {
    assert.equal(locate('the prices keep on dropping', BODY), undefined);
    assert.equal(locate('The tools keep getting cheaper', BODY), undefined);
  });

  it('does not find one stitched together from two places', () => {
    assert.equal(locate('The tools keep getting better and the work is not getting cheaper', BODY), undefined);
  });

  it('treats regex characters in a quote as characters', () => {
    assert.ok(locate('(the part nobody expected', 'we said (the part nobody expected)'));
  });
});

describe('verifying claims', () => {
  it('stores the body’s words, not the model’s', () => {
    const { claims, dropped } = verifyClaims(
      [{ statement: 'Prices are falling.', quote: 'dropping. And yet the work' }],
      BODY,
      CHUNKS,
    );

    assert.equal(dropped, 0);
    assert.equal(claims[0]!.quote, 'dropping.\n\nAnd yet the work');
  });

  it('reads the chunk and the timestamp off the rows rather than asking for them', () => {
    // A model asked for a chunk id would invent one, and nothing downstream could check it.
    const { claims } = verifyClaims(
      [{ statement: 'The work is not cheaper.', quote: 'the work is not getting cheaper' }],
      BODY,
      CHUNKS,
    );

    assert.equal(claims[0]!.chunk_id, 'chunk-b');
    assert.equal(claims[0]!.start_ms, 42_000);
  });

  /**
   * **The drop rate is the signal the design says to watch, and it was not diagnosable.**
   * The rejected quotes are deliberately never stored, so a run reporting "20 dropped" gave
   * nobody anything to act on. Measured at the moment of rejection, it separates the two
   * possibilities that matter: a model inventing quotes, and a model punctuating a
   * transcript that has no punctuation.
   *
   * A live run made the question urgent — 42% dropped on auto-captions against 10% on
   * prose. Nothing here accepts a looser quote; it only counts one.
   */
  it('counts a quote that differs only in punctuation and case, and still drops it', () => {
    const captions = 'so here is the prompt i paste in and here is why it works';
    const { claims, dropped, nearly } = verifyClaims(
      [{ statement: 'Tidied.', quote: 'So here is the prompt I paste in, and here is why it works.' }],
      captions,
      [{ id: 'chunk-a', char_start: 0, char_end: captions.length, start_ms: 0 }],
    );

    assert.equal(claims.length, 0, 'the rule has not moved: this is still not a quote');
    assert.equal(dropped, 1);
    assert.equal(nearly, 1, 'and braintrust can now say why');
  });

  it('does not count a changed word as nearly right', () => {
    const { dropped, nearly } = verifyClaims(
      [{ statement: 'Repaired.', quote: 'the prices keep on dropping' }],
      BODY,
      CHUNKS,
    );

    assert.equal(dropped, 1);
    assert.equal(nearly, 0, 'a changed word is a changed word however it is punctuated');
  });

  /**
   * The property that would make accepting it safe, were it ever accepted: the span maps
   * back to the real body, so the stored quote stays the author's characters rather than
   * the model's rendering of them.
   */
  it('maps a loose match back to the body’s own characters', () => {
    const captions = 'so here is the prompt i paste in and here is why it works';
    const span = locateLoosely('So here is the prompt I paste in,', captions)!;

    assert.ok(span);
    assert.equal(captions.slice(span.start, span.end), 'so here is the prompt i paste in');
  });

  it('drops a claim it cannot quote, and counts it', () => {
    const { claims, dropped } = verifyClaims(
      [
        { statement: 'Real.', quote: 'the prices keep dropping' },
        { statement: 'Invented.', quote: 'the models are getting worse' },
      ],
      BODY,
      CHUNKS,
    );

    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.statement, 'Real.');
    assert.equal(dropped, 1);
  });

  it('keeps a claim whose item has no timings, with a null rather than a guess', () => {
    const prose: ChunkSpan[] = [{ id: 'chunk-a', char_start: 0, char_end: BODY.length, start_ms: null }];
    const { claims } = verifyClaims(
      [{ statement: 'Prices fall.', quote: 'the prices keep dropping' }],
      BODY,
      prose,
    );

    assert.equal(claims[0]!.chunk_id, 'chunk-a');
    assert.equal(claims[0]!.start_ms, null);
  });

  it('takes the earliest window when overlapping chunks both contain the quote', () => {
    const overlapping: ChunkSpan[] = [
      { id: 'first', char_start: 0, char_end: BODY.length, start_ms: 0 },
      { id: 'second', char_start: 30, char_end: BODY.length, start_ms: 30_000 },
    ];
    const { claims } = verifyClaims(
      [{ statement: 'Prices fall.', quote: 'the prices keep dropping' }],
      BODY,
      overlapping,
    );

    assert.equal(claims[0]!.chunk_id, 'first');
  });
});

describe('the prompt', () => {
  it('asks for the quote and never for a chunk or a timestamp', () => {
    assert.match(SYSTEM_PROMPT, /COPIED EXACTLY/);
    assert.match(SYSTEM_PROMPT, /will be discarded/);
    assert.ok(!/chunk/i.test(SYSTEM_PROMPT), 'the model must not be asked to name a chunk');
    assert.ok(!/timestamp|start_ms/i.test(SYSTEM_PROMPT), 'the model must not be asked for a time');
  });

  it('asks for the argument and the assumptions, not only conclusions', () => {
    assert.match(SYSTEM_PROMPT, /argument —/);
    assert.match(SYSTEM_PROMPT, /assumptions —/);
  });

  it('tells the model not to invent claims for an item that asserts nothing', () => {
    assert.match(SYSTEM_PROMPT, /Do not invent claims/);
  });
});

describe('the extractor', () => {
  it('names its generation as model plus prompt version', () => {
    const extractor = createExtractor(testExtractorConfig, fakeExtractor().fetcher);
    assert.equal(extractor.generation, `test-reader@${PROMPT_VERSION}`);
    assert.equal(extractor.generation, TEST_GENERATION);
  });

  it('accepts a base URL, and also the full path people paste', () => {
    assert.equal(chatUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
    assert.equal(
      chatUrl('https://api.openai.com/v1/chat/completions'),
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('shows the model the whole item, with its title', async () => {
    // Chunk boundaries serve retrieval. They have no business constraining what the
    // compiler needs in order to follow an argument.
    const endpoint = fakeExtractor();
    await createExtractor(testExtractorConfig, endpoint.fetcher).read({ title: 'On prices', text: BODY });

    assert.equal(endpoint.sent.length, 1);
    assert.equal(endpoint.sent[0]!.model, 'test-reader');
    assert.match(endpoint.sent[0]!.user, /^Title: On prices/);
    assert.ok(endpoint.sent[0]!.user.includes(BODY));
  });

  it('presents a key only when one is configured', async () => {
    const withKey = fakeExtractor();
    await createExtractor({ ...testExtractorConfig, apiKey: 'sk-ant' }, withKey.fetcher).read({ text: BODY });
    assert.equal(withKey.sent[0]!.authorization, 'Bearer sk-ant');

    const without = fakeExtractor();
    await createExtractor(testExtractorConfig, without.fetcher).read({ text: BODY });
    assert.equal(without.sent[0]!.authorization, undefined);
  });

  it('reads an answer wrapped in a fenced block', () => {
    const note = readNoteContent(
      '```json\n{"claims":[{"statement":"s","quote":"q"}],"argument":"a","assumptions":["x"]}\n```',
      'test',
    );

    assert.deepEqual(note.claims, [{ statement: 's', quote: 'q' }]);
    assert.equal(note.argument, 'a');
    assert.deepEqual(note.assumptions, ['x']);
  });

  it('reads an answer with a sentence of preamble in front of it', () => {
    const note = readNoteContent('Here is the note:\n{"claims":[],"argument":"a"}', 'test');
    assert.equal(note.argument, 'a');
    assert.deepEqual(note.assumptions, []);
  });

  it('discards a malformed claim rather than storing one it cannot read', () => {
    const note = readNoteContent(
      '{"claims":[{"statement":"s"},{"quote":"q"},{"statement":"","quote":"q"},' +
        '{"statement":"good","quote":"q"}],"argument":"a"}',
      'test',
    );

    assert.deepEqual(note.claims, [{ statement: 'good', quote: 'q' }]);
  });

  it('refuses an answer that is not JSON at all', () => {
    assert.throws(() => readNoteContent('I am afraid I cannot do that.', 'test'), BraintrustError);
  });

  it('names the model when the endpoint rejects the request', async () => {
    const endpoint = fakeExtractor({ status: 429 });
    await assert.rejects(
      createExtractor(testExtractorConfig, endpoint.fetcher, async () => {}).read({ text: BODY }),
      /HTTP 429 for model "test-reader"/,
    );
  });

  /**
   * **A 429 from the operator's own model endpoint is it asking braintrust to slow down**,
   * and slowing down is compliance rather than a workaround — the same rule that has always
   * applied to a source, applied where it turned out to matter more.
   *
   * Found live: a rate-limited extractor dropped item after item, one per run. Nothing was
   * lost, because an unread Item stays in the Backlog — but a backfill against that endpoint
   * could never finish, since every run burned a few more items against the same wall.
   */
  it('waits out a 429 from the model endpoint and reads the item on the retry', async () => {
    const waited: number[] = [];
    let attempts = 0;

    const endpoint: Fetcher = async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '2' : null) },
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ claims: [], argument: 'nothing asserted', assumptions: [] }),
                },
              },
            ],
          }),
      };
    };

    const note = await createExtractor(testExtractorConfig, endpoint, async (ms) => {
      waited.push(ms);
    }).read({ text: BODY });

    assert.equal(attempts, 2, 'the same item is asked again rather than dropped for the run');
    assert.deepEqual(waited, [2000], 'it waits exactly as long as it was asked to');
    assert.equal(note.argument, 'nothing asserted');
  });

  /**
   * **A dropped connection is not an answer**, so it must not be read as one. Found live:
   * a synthesiser connection dropped mid-compile and cost a whole Persona its rebuild —
   * twice in one day, at two different stages — while the notes it would have been built
   * from sat already written in the database.
   *
   * The same reasoning as a video with no captions: neither refusing nor serving is a
   * verdict, and only a verdict should be acted on.
   */
  it('retries a connection that never completed, rather than losing the item to it', async () => {
    const waited: number[] = [];
    let attempts = 0;

    const flaky: Fetcher = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ claims: [], argument: 'held', assumptions: [] }) } },
            ],
          }),
      };
    };

    const note = await createExtractor(testExtractorConfig, flaky, async (ms) => {
      waited.push(ms);
    }).read({ text: BODY });

    assert.equal(attempts, 2);
    assert.deepEqual(waited, [TRANSPORT_RETRY_MS]);
    assert.equal(note.argument, 'held');
  });

  it('gives up after a second dropped connection, and says it is this run only', async () => {
    let attempts = 0;
    const dead: Fetcher = async () => {
      attempts += 1;
      throw new TypeError('fetch failed');
    };

    await assert.rejects(
      createExtractor(testExtractorConfig, dead, async () => {}).read({ text: BODY }),
      /the next run reads it/,
    );
    assert.equal(attempts, 2, 'once each, not repeatedly');
  });

  it('reports an unreachable endpoint as this run only', async () => {
    const extractor = createExtractor(testExtractorConfig, async () => {
      throw new Error('ECONNREFUSED');
    });
    await assert.rejects(extractor.read({ text: BODY }), /the next run reads it/);
  });

  /**
   * The prompt asks for one JSON object; the request says so too. Found live against a
   * gpt-oss server that answered HTTP 500 while parsing its own model's `<|constrain|>json`
   * marker, and answered cleanly the moment the request declared the format — so this is
   * not a preference, it is what makes the surface work on a real endpoint.
   */
  it('declares the answer is JSON rather than only asking for it in prose', async () => {
    const endpoint = fakeExtractor({ note: { claims: [], argument: 'a', assumptions: [] } });
    await createExtractor(testExtractorConfig, endpoint.fetcher).read({ text: BODY });

    assert.equal(endpoint.sent[0]!.responseFormat, 'json_object');
    assert.match(endpoint.sent[0]!.system, /Return a single JSON object, and nothing else/);
  });

  /**
   * The same live-found lesson as the synthesiser's, and the reason it is worth holding in
   * two places: an Item can run to 40,000 words, and a request that sends no bytes while
   * that is being read is one a proxy's read timeout cuts. What arrives here is
   * `fetch failed` — no status, nothing to act on, and an Item that never gets read.
   * See src/net/stream.ts.
   */
  it('asks for a stream, so reading a long item never goes silent on the wire', async () => {
    const sent: unknown[] = [];
    const wire: Fetcher = async (_url, init) => {
      if (init) sent.push(init.json);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ claims: [], argument: 'held', assumptions: [] }) } },
            ],
          }),
      };
    };

    await createExtractor(testExtractorConfig, wire).read({ text: BODY });

    assert.equal((sent[0] as { stream?: unknown }).stream, true);
  });

  it('reads a note back out of a streamed answer', async () => {
    const content = JSON.stringify({ claims: [], argument: 'held across the stream', assumptions: [] });
    const events: string[] = [];
    for (let at = 0; at < content.length; at += 9) {
      events.push(
        `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(at, at + 9) } }] })}\n\n`,
      );
    }
    const streamed: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () => `: keep-alive\n\n${events.join('')}data: [DONE]\n\n`,
    });

    const note = await createExtractor(testExtractorConfig, streamed).read({ text: BODY });

    assert.equal(note.argument, 'held across the stream');
  });
});

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
import {
  chatUrl,
  createExtractor,
  locate,
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
      createExtractor(testExtractorConfig, endpoint.fetcher).read({ text: BODY }),
      /HTTP 429 for model "test-reader"/,
    );
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
});

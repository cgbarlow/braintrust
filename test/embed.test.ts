/**
 * The embeddings endpoint, and the two checks that stand in front of it.
 *
 * The strictness tests are the ones that matter. A batch returned short or reordered
 * would attach one Chunk's vector to another Chunk's id, and nothing downstream could
 * ever detect it — the index would simply be quietly wrong. So the client refuses
 * anything it cannot line up, rather than doing its best.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { BraintrustError } from '../src/errors.js';
import {
  checkDimension,
  checkModelPresent,
  createEmbedder,
  createQueryGate,
  embeddingsUrl,
  vectorLiteral,
} from '../src/retrieval/index.js';
import { fakeDb } from './support/fake-db.js';
import { fakeEmbeddings, testEmbeddingsConfig, TEST_DIMENSION, vectorFor } from './support/embeddings.js';

const MODEL = testEmbeddingsConfig.model;

/** Answers the two catalogue questions the checks ask, and nothing else. */
function catalogueDb(options: { declared?: string; models?: string[] } = {}) {
  return fakeDb((sql) => {
    if (sql.includes('format_type')) return [{ declared: options.declared ?? `vector(${TEST_DIMENSION})` }];
    if (sql.includes('distinct model')) return (options.models ?? []).map((model) => ({ model }));
    return [];
  });
}

describe('the embeddings endpoint', () => {
  it('accepts a base URL, and also the full path people paste', () => {
    assert.equal(embeddingsUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1/embeddings');
    assert.equal(embeddingsUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1/embeddings');
    assert.equal(
      embeddingsUrl('https://api.openai.com/v1/embeddings'),
      'https://api.openai.com/v1/embeddings',
    );
  });

  it('sends the configured model and the batch, as one POST', async () => {
    const endpoint = fakeEmbeddings();
    const vectors = await createEmbedder(testEmbeddingsConfig, endpoint.fetcher).embed(['one', 'two']);

    assert.equal(endpoint.sent.length, 1);
    assert.equal(endpoint.sent[0]!.url, 'http://127.0.0.1:11434/v1/embeddings');
    assert.equal(endpoint.sent[0]!.model, MODEL);
    assert.deepEqual(endpoint.sent[0]!.input, ['one', 'two']);
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0]!.length, TEST_DIMENSION);
  });

  it('presents a key only when one is configured', async () => {
    const withKey = fakeEmbeddings();
    await createEmbedder({ ...testEmbeddingsConfig, apiKey: 'sk-test' }, withKey.fetcher).embed(['x']);
    assert.equal(withKey.sent[0]!.authorization, 'Bearer sk-test');

    const without = fakeEmbeddings();
    await createEmbedder(testEmbeddingsConfig, without.fetcher).embed(['x']);
    assert.equal(without.sent[0]!.authorization, undefined);
  });

  it('costs nothing when there is nothing to embed', async () => {
    const endpoint = fakeEmbeddings();
    assert.deepEqual(await createEmbedder(testEmbeddingsConfig, endpoint.fetcher).embed([]), []);
    assert.equal(endpoint.sent.length, 0);
  });

  it('puts a batch back in order when the server returns it shuffled', async () => {
    // `index` is what says the response is not in request order, and ignoring it would
    // pair every chunk in the batch with the wrong vector.
    const endpoint = fakeEmbeddings({ shuffled: true });
    const vectors = await createEmbedder(testEmbeddingsConfig, endpoint.fetcher).embed([
      'first',
      'second',
      'third',
    ]);

    assert.deepEqual(vectors[0], vectorFor('first'));
    assert.deepEqual(vectors[1], vectorFor('second'));
    assert.deepEqual(vectors[2], vectorFor('third'));
  });

  it('refuses a batch it cannot line up with what it sent', async () => {
    // Two vectors for three chunks: any pairing is a guess, and a wrong one is
    // undetectable forever after.
    const endpoint = fakeEmbeddings({ body: JSON.stringify({ data: [{ embedding: [1] }, { embedding: [2] }] }) });
    await assert.rejects(
      createEmbedder(testEmbeddingsConfig, endpoint.fetcher).embed(['a', 'b', 'c']),
      (error: Error) => error instanceof BraintrustError && /2 vectors for 3 inputs/.test(error.message),
    );
  });

  it('refuses a response that is not an embedding at all', async () => {
    const endpoint = fakeEmbeddings({ body: JSON.stringify({ data: [{ embedding: ['nope'] }] }) });
    await assert.rejects(createEmbedder(testEmbeddingsConfig, endpoint.fetcher).embed(['a']), BraintrustError);
  });

  it('says so plainly when the endpoint is not an OpenAI-compatible API', async () => {
    const endpoint = fakeEmbeddings({ body: '<html>404</html>' });
    await assert.rejects(
      createEmbedder(testEmbeddingsConfig, endpoint.fetcher).embed(['a']),
      /did not return JSON/,
    );
  });

  it('names the model when the endpoint rejects the request', async () => {
    const endpoint = fakeEmbeddings({ status: 404 });
    await assert.rejects(
      createEmbedder(testEmbeddingsConfig, endpoint.fetcher).embed(['a']),
      new RegExp(`HTTP 404 for model "${MODEL}"`),
    );
  });

  it('reports an unreachable endpoint as this run only', async () => {
    const embedder = createEmbedder(testEmbeddingsConfig, async () => {
      throw new Error('ECONNREFUSED');
    });
    await assert.rejects(embedder.embed(['a']), /the Chunks are on disk and the next run continues/);
  });

  it('writes pgvector literals', () => {
    assert.equal(vectorLiteral([1, -0.5, 0]), '[1,-0.5,0]');
  });
});

describe('startup check 1: the dimension', () => {
  it('passes when the endpoint matches the column, and reports the width', async () => {
    const endpoint = fakeEmbeddings();
    const dimension = await checkDimension(
      catalogueDb(),
      createEmbedder(testEmbeddingsConfig, endpoint.fetcher),
    );

    assert.equal(dimension, TEST_DIMENSION);
    assert.equal(endpoint.sent.length, 1, 'the probe is one request, not one per dimension');
  });

  it('refuses a mismatch, naming both numbers and the line to change', async () => {
    const endpoint = fakeEmbeddings({ dimension: 768 });
    await assert.rejects(
      checkDimension(catalogueDb(), createEmbedder(testEmbeddingsConfig, endpoint.fetcher)),
      (error: Error) =>
        /768-dimension vectors/.test(error.message) &&
        /vector\(1024\)/.test(error.message) &&
        /schema\.sql/.test(error.message),
    );
  });

  it('says which file to run when the table is not there', async () => {
    const endpoint = fakeEmbeddings();
    await assert.rejects(
      checkDimension(catalogueDb({ declared: '' }), createEmbedder(testEmbeddingsConfig, endpoint.fetcher)),
      /Has schema\.sql been run/,
    );
  });
});

describe('startup check 2: the model actually stored', () => {
  it('is ready when the configured model has vectors', async () => {
    assert.deepEqual(await checkModelPresent(catalogueDb({ models: [MODEL] }), MODEL), { ready: true });
  });

  it('reports an empty index as new rather than as a corruption', async () => {
    const readiness = await checkModelPresent(catalogueDb({ models: [] }), MODEL);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason!, /Nothing has been embedded yet/);
  });

  it('refuses to serve when every vector belongs to a different model', async () => {
    // The silent failure this check exists for: a same-sized model swapped in without a
    // re-embed returns confidently-ranked nonsense and nothing errors.
    const readiness = await checkModelPresent(catalogueDb({ models: ['text-embedding-3-small'] }), MODEL);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason!, /text-embedding-3-small/);
    assert.match(readiness.reason!, /meaningless even when the dimensions match/);
    assert.match(readiness.reason!, /old vectors are kept rather than migrated/);
  });

  it('keeps asking while unready, and stops asking once ready', async () => {
    // The job in the other deployment is what ends both unready states. Caching a
    // refusal would mean an operator has to restart the web service to notice.
    let models: string[] = [];
    const db = fakeDb((sql) => (sql.includes('distinct model') ? models.map((model) => ({ model })) : []));
    const gate = createQueryGate(db, MODEL);

    assert.equal((await gate.check()).ready, false);
    models = [MODEL];
    assert.equal((await gate.check()).ready, true);

    const asked = db.calls.length;
    assert.equal((await gate.check()).ready, true);
    assert.equal(db.calls.length, asked, 'a ready gate should stop querying');
  });
});

describe("braintrust's own vector space", () => {
  it("never reads OB1's thoughts, and never calls match_thoughts", async () => {
    // Two vector spaces in one database, and comparing across them would be
    // meaningless in exactly the way §7 describes — with the added problem that
    // `thoughts.created_at` records when *you* captured a note, not when the person
    // said it, so a position built from one could not carry an honest held_since.
    // The bridge carries nothing in v1, and this is what says so.
    const files = await sources(new URL('../src/', import.meta.url));

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const sql = text.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm, '');
      assert.ok(!/match_thoughts/.test(sql), `${file.pathname} calls match_thoughts`);
      assert.ok(!/\bfrom\s+thoughts\b|\bjoin\s+thoughts\b/i.test(sql), `${file.pathname} reads thoughts`);
    }
  });
});

async function sources(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];

  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...(await sources(child)));
    else if (entry.name.endsWith('.ts')) files.push(child);
  }

  return files;
}

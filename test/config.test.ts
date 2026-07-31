import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, loadConfig } from '../src/config.js';

const COMPLETE = {
  BRAINTRUST_DATABASE_URL: 'postgresql://u:p@host:5432/postgres',
  BRAINTRUST_MCP_KEY: 'sekrit',
  BRAINTRUST_EMBEDDINGS_BASE_URL: 'http://localhost:11434/v1',
  BRAINTRUST_EMBEDDINGS_MODEL: 'qwen3-embedding:0.6b',
  BRAINTRUST_EXTRACTOR_BASE_URL: 'https://api.anthropic.com/v1',
  BRAINTRUST_EXTRACTOR_MODEL: 'claude-sonnet-5',
} as NodeJS.ProcessEnv;

const silent = { warn: () => {} };

describe('loadConfig', () => {
  it('reads a complete environment', () => {
    const config = loadConfig(COMPLETE, silent);
    assert.equal(config.databaseUrl, 'postgresql://u:p@host:5432/postgres');
    assert.equal(config.mcpKey, 'sekrit');
    assert.equal(config.embeddings.baseUrl, 'http://localhost:11434/v1');
    assert.equal(config.embeddings.model, 'qwen3-embedding:0.6b');
    assert.equal(config.embeddings.apiKey, undefined);
    assert.equal(config.extractor.baseUrl, 'https://api.anthropic.com/v1');
    assert.equal(config.extractor.model, 'claude-sonnet-5');
    assert.equal(config.port, 3000);
  });

  it('refuses to start with no embeddings endpoint, and says why', () => {
    const { BRAINTRUST_EMBEDDINGS_BASE_URL: _omitted, ...withoutEndpoint } = COMPLETE;

    assert.throws(
      () => loadConfig(withoutEndpoint as NodeJS.ProcessEnv, silent),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /refuses to start/);
        assert.match(error.message, /BRAINTRUST_EMBEDDINGS_BASE_URL/);
        // The reason has to travel with the refusal, or the operator just sets it
        // to the first hosted provider they think of.
        assert.match(error.message, /no default, ever/);
        assert.match(error.message, /shipping an entire corpus to a third party/);
        return true;
      },
    );
  });

  it('reports every missing setting at once rather than one restart at a time', () => {
    assert.throws(
      () => loadConfig({} as NodeJS.ProcessEnv, silent),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        for (const name of [
          'BRAINTRUST_DATABASE_URL',
          'BRAINTRUST_MCP_KEY',
          'BRAINTRUST_EMBEDDINGS_BASE_URL',
          'BRAINTRUST_EMBEDDINGS_MODEL',
          'BRAINTRUST_EXTRACTOR_BASE_URL',
          'BRAINTRUST_EXTRACTOR_MODEL',
        ]) {
          assert.match(error.message, new RegExp(name));
        }
        return true;
      },
    );
  });

  it('treats a blank value as missing', () => {
    assert.throws(
      () => loadConfig({ ...COMPLETE, BRAINTRUST_MCP_KEY: '   ' }, silent),
      ConfigError,
    );
  });

  it('carries an optional embeddings key when one is supplied', () => {
    const config = loadConfig({ ...COMPLETE, BRAINTRUST_EMBEDDINGS_API_KEY: 'sk-test' }, silent);
    assert.equal(config.embeddings.apiKey, 'sk-test');
  });

  it('warns when pointed at the transaction pooler instead of the session pooler', () => {
    const warnings: string[] = [];
    const config = loadConfig(
      { ...COMPLETE, BRAINTRUST_DATABASE_URL: 'postgresql://u:p@host:6543/postgres' },
      { warn: (message) => warnings.push(message) },
    );

    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /session pooler/);
    // A warning, not a refusal — it still works, it is just the wrong fit.
    assert.equal(config.databaseUrl, 'postgresql://u:p@host:6543/postgres');
  });

  it('refuses to start with no note extractor, because a job that never distils is silent', () => {
    // The failure mode here is not the embeddings one — nothing is shipped anywhere by
    // accident. It is that the daily job runs green forever and no persona is ever
    // compiled, which is exactly the invisible failure the schedule exists to prevent.
    const { BRAINTRUST_EXTRACTOR_MODEL: _omitted, ...withoutModel } = COMPLETE;

    assert.throws(
      () => loadConfig(withoutModel as NodeJS.ProcessEnv, silent),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /BRAINTRUST_EXTRACTOR_MODEL/);
        assert.match(error.message, /cannot compile a persona/);
        return true;
      },
    );
  });

  it('carries an optional extractor key when one is supplied', () => {
    const config = loadConfig({ ...COMPLETE, BRAINTRUST_EXTRACTOR_API_KEY: 'sk-ant' }, silent);
    assert.equal(config.extractor.apiKey, 'sk-ant');
  });

  it('does not warn about a session-pooler connection string', () => {
    const warnings: string[] = [];
    loadConfig(COMPLETE, { warn: (message) => warnings.push(message) });
    assert.deepEqual(warnings, []);
  });
});

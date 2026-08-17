/**
 * The coverage report, without a database: the numbered floor and the no-model rule.
 *
 * The count itself — "covered fraction is computed per persona against the current
 * compile only" — is an integration property; rows have to be rows for it to mean
 * anything, and test/coverage-fault.integration.test.ts holds it up against real
 * Postgres. What is provable here, without rows, is that the floor is the line the
 * issue describes and that the check stays a check: SQL against the fault ledger, and
 * no model in the path.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { COVERAGE_FLOOR } from '../src/verify/coverage.js';

describe('the coverage report', () => {
  it('states its floor as a named constant, at exactly half — below means below', () => {
    assert.equal(COVERAGE_FLOOR, 0.5);
  });

  it('is SQL only — the check has nothing to call a model with', async () => {
    // The module measures rows and writes the fault ledger, and nothing else. A source
    // file that carries none of the model-reaching identifiers cannot have reached an
    // endpoint, whatever the import graph says.
    const source = await readFile(new URL('../src/verify/coverage.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /\bfetch\(|\bFetcher\b|\bEmbedder\b|\bExtractor\b|\bcreateSynthesiser\b/,
      'src/verify/coverage.js reaches a model',
    );
  });
});

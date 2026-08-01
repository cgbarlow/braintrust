/**
 * `braintrust_load_persona`, at the boundary.
 *
 * Three properties, and none of them are about the layers themselves: the persona is
 * always named as a model rather than as the person, a persona that was never compiled
 * is a refusal rather than a build, and loading is a read — the most expensive action in
 * the product must never sit behind a read call.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BraintrustError } from '../src/errors.js';
import { loadPersona } from '../src/personas.js';
import { fakeDb } from './support/fake-db.js';

const VOICE = {
  display_name: 'Nate B. Jones',
  compiled_at: new Date('2026-07-31T09:14:22.000Z'),
  compiler_version: '0.1.0+measured-1',
  extractor: 'gpt-5@notes-1',
  layer: 'voice',
  basis: 'measured',
  descriptive_md: 'Hedges in 32 of 34 measured items.',
  generative_md: 'Hedge before committing.',
  evidence: { items_measured: 34 },
};

const COVERAGE = {
  ...VOICE,
  layer: 'coverage',
  descriptive_md: 'braintrust has read 34 items from this person.',
  generative_md: null,
  evidence: { retrieved: 34 },
};

/** Answers the two queries the read path makes, and nothing else. */
function compiledDb(rows: Record<string, unknown>[], exists = true) {
  return fakeDb((sql) => {
    if (sql.includes('braintrust_persona_layers')) return rows;
    if (sql.includes('from braintrust_people where slug')) return exists ? [{ slug: 'x' }] : [];
    return [];
  });
}

describe('loading a persona', () => {
  it('names it as a model of the person, never as the person', async () => {
    const payload = await loadPersona(compiledDb([VOICE, COVERAGE]), 'nate-b-jones');

    assert.equal(payload.subject, 'braintrust model of Nate B. Jones');
    // The real name stays in the row. The disclosure is a rendering at the boundary, so
    // it travels wherever the name travels rather than sitting in a footnote.
    assert.doesNotMatch(JSON.stringify(payload.subject), /^"Nate B\. Jones"$/);
  });

  it('returns both forms of voice, because either alone is worse than useless', async () => {
    const { layers } = await loadPersona(compiledDb([VOICE, COVERAGE]), 'nate-b-jones');

    // Only `generative` leaves the instruction unfalsifiable; only `descriptive` means
    // two clients build two different personalities from identical data.
    assert.equal(layers.voice!.generative, 'Hedge before committing.');
    assert.equal(layers.voice!.descriptive, 'Hedges in 32 of 34 measured items.');
    assert.deepEqual(layers.voice!.evidence, { items_measured: 34 });
  });

  it('puts basis on every layer, as a field as well as in the prose', async () => {
    const { layers } = await loadPersona(compiledDb([VOICE, COVERAGE]), 'nate-b-jones');

    assert.equal(layers.voice!.basis, 'measured');
    assert.equal(layers.coverage!.basis, 'measured');
  });

  it('omits the generative form on a layer that has none rather than returning an empty one', async () => {
    const { layers } = await loadPersona(compiledDb([VOICE, COVERAGE]), 'nate-b-jones');

    assert.ok(!('generative' in layers.coverage!));
  });

  it('says which generation of notes the persona was built from', async () => {
    const payload = await loadPersona(compiledDb([VOICE, COVERAGE]), 'nate-b-jones');

    // Declared on the compile row, never inferred from whatever happens to be configured
    // now — two generations coexist while a prompt upgrade re-reads the corpus.
    assert.equal(payload.extractor, 'gpt-5@notes-1');
    assert.equal(payload.compiler_version, '0.1.0+measured-1');
    // ISO 8601, like every other tool — not the database's own rendering of a timestamp.
    assert.equal(payload.compiled_at, '2026-07-31T09:14:22.000Z');
  });

  it('serves the response template beside the layers it governs', async () => {
    const payload = await loadPersona(compiledDb([VOICE, COVERAGE]), 'nate-b-jones');

    // A client that loads a Core and speaks it straight recites braintrust's bookkeeping,
    // because that bookkeeping is deliberately inside the prose. The template is how the
    // Core says how to be spoken, and it travels in the payload rather than in the tool
    // description so it reaches the system prompt the layers are pasted into.
    assert.match(payload.speak_as, /braintrust model of Nate B\. Jones/);
    assert.match(payload.speak_as, /layers\.voice\.generative/);
    assert.match(payload.speak_as, /layers\.coverage/);
  });

  it('reports the corpus in the template when the compile measured one', async () => {
    const rows = [VOICE, COVERAGE].map((row) => ({
      ...row,
      corpus_stats: { items_retrieved: 515, items_skipped_paywall: 22, window: ['2023-04-02', '2026-07-30'] },
    }));

    // Scale said once, at the top, is what stops a persona sounding better-read than it is
    // now that the per-paragraph counts are gone.
    assert.match((await loadPersona(compiledDb(rows), 'nate-b-jones')).speak_as, /515 things/);
  });

  it('still discloses in the template when the compile measured no corpus', async () => {
    // corpus_stats is written by the compiler and may be absent or partial. A missing
    // block drops the numbers, never the disclosure — reporting zeroes would read as a
    // measurement, and dropping the naming would break the one line that must not go.
    const payload = await loadPersona(compiledDb([VOICE, COVERAGE]), 'nate-b-jones');

    assert.match(payload.speak_as, /braintrust model of Nate B\. Jones/);
    assert.doesNotMatch(payload.speak_as, /built from/);
  });

  it('leaves the stored prose exactly as compiled, markers and all', async () => {
    const { layers } = await loadPersona(compiledDb([VOICE, COVERAGE]), 'nate-b-jones');

    // The template is an instruction, not a rewrite. Stripping the markers at the boundary
    // would defeat the redundancy that puts them in the prose as well as in `basis`.
    assert.equal(layers.voice!.descriptive, 'Hedges in 32 of 34 measured items.');
    assert.equal(layers.coverage!.descriptive, 'braintrust has read 34 items from this person.');
  });

  it('refuses a person it follows but has not compiled, and says it resolves itself', async () => {
    await assert.rejects(
      () => loadPersona(compiledDb([]), 'nate-b-jones'),
      (error: unknown) => {
        assert.ok(error instanceof BraintrustError);
        assert.match(error.message, /has not built a persona for them yet/);
        assert.match(error.message, /Nothing is compiled on demand/);
        return true;
      },
    );
  });

  it('refuses a person it has never heard of differently, because the fix is different', async () => {
    await assert.rejects(
      () => loadPersona(compiledDb([], false), 'someone-else'),
      (error: unknown) => {
        assert.ok(error instanceof BraintrustError);
        assert.match(error.message, /does not follow anyone called "someone-else"/);
        assert.match(error.message, /only a human can complete/);
        return true;
      },
    );
  });

  it('never compiles on demand — not even for a person with no persona', async () => {
    const db = compiledDb([], true);
    await loadPersona(db, 'nate-b-jones').catch(() => undefined);

    // A first question that hangs for minutes and spends real money unannounced is a bad
    // first impression, and it puts the most expensive action in the product behind a
    // read call. Enforced by there being no write to make.
    assert.equal(db.transactions, 0);
    for (const sql of db.sql()) {
      assert.doesNotMatch(sql, /\b(insert|update|delete)\b/i, `loading wrote something: ${sql}`);
    }
  });
});

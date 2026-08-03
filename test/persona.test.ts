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
import { explainPersona, loadPersona } from '../src/personas.js';
import { fakeDb } from './support/fake-db.js';

const REASONING = {
  display_name: 'Nate B. Jones',
  compiled_at: new Date('2026-07-31T09:14:22.000Z'),
  compiler_version: '0.1.0+measured-1',
  extractor: 'gpt-5@notes-1',
  layer: 'reasoning',
  basis: 'inferred',
  descriptive_md: '**Inferred across 34 items — no single item asserts this.**\n\nTraced to 8 of 34 items.',
  generative_md: null,
  evidence: {
    entries: [
      { label: 'Treats prompting skill as the scarce resource', items_traced: 8 },
      { label: 'Infrastructure-first focus', items_traced: 4 },
    ],
  },
};

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
  const db = () => compiledDb([VOICE, REASONING, COVERAGE]);

  it('names it as a model of the person, never as the person', async () => {
    const payload = await loadPersona(db(), 'nate-b-jones');

    assert.equal(payload.subject, 'braintrust model of Nate B. Jones');
    // The real name stays in the row. The disclosure is a rendering at the boundary, so
    // it travels wherever the name travels rather than sitting in a footnote.
    assert.doesNotMatch(JSON.stringify(payload.subject), /^"Nate B\. Jones"$/);
  });

  it('hands back a script rather than the layers and an instruction', async () => {
    const payload = await loadPersona(db(), 'nate-b-jones');

    // braintrust owns the voice: what used to be four layers a client assembled is now
    // one block braintrust composed and is accountable for.
    assert.ok(typeof payload.speak === 'string' && payload.speak.length > 0);
    assert.ok(!('layers' in payload));
    assert.ok(!('speak_as' in payload));
  });

  it('keeps braintrust out of the prose it means to be spoken', async () => {
    const { speak } = await loadPersona(db(), 'nate-b-jones');

    // The whole point of the script: nothing in it is written for whoever is reading the
    // Core rather than for whoever is being answered.
    assert.doesNotMatch(speak, /Inferred across/);
    assert.doesNotMatch(speak, /Traced to \d+ of \d+/);
    assert.doesNotMatch(speak, /measured in \d+ of \d+/);
    assert.doesNotMatch(speak, /\blayers\./);
    assert.doesNotMatch(speak, /basis/i);
  });

  it('discloses once, and says not to say it again', async () => {
    const { speak } = await loadPersona(db(), 'nate-b-jones');

    assert.match(speak, /braintrust model of Nate B\. Jones/);
    // The four words that make "a model of" unambiguous rather than a compliment.
    assert.match(speak, /not the person/);
    assert.match(speak, /Do not say it again/);
  });

  it('carries basis in receipts, where it cannot be spoken or paraphrased away', async () => {
    const { receipts } = await loadPersona(db(), 'nate-b-jones');

    // Prose redundancy only ever survived a paste. A scalar survives everything.
    assert.equal(receipts.voice, 'measured');
    assert.equal(receipts.reasoning, 'inferred');
  });

  it('counts the labels it had to carry, and never lets that go quiet', async () => {
    const { receipts, speak } = await loadPersona(db(), 'nate-b-jones');

    // Anything can be listed verbatim, so a carrier could absorb a broken compile without
    // anything looking wrong. The count is the only instrument that catches it.
    assert.equal(receipts.labels_carried, 1);
    assert.match(speak, /Treat prompting skill as the scarce resource\./);
    assert.match(speak, /You habitually frame things this way:/);
    assert.match(speak, /Infrastructure-first focus/);
  });

  it('says which generation of notes the persona was built from', async () => {
    const payload = await loadPersona(db(), 'nate-b-jones');

    // Declared on the compile row, never inferred from whatever happens to be configured
    // now — two generations coexist while a prompt upgrade re-reads the corpus.
    assert.equal(payload.extractor, 'gpt-5@notes-1');
    assert.equal(payload.compiler_version, '0.1.0+measured-1');
    // ISO 8601, like every other tool — not the database's own rendering of a timestamp.
    assert.equal(payload.compiled_at, '2026-07-31T09:14:22.000Z');
  });

});

describe('explaining a persona', () => {
  const db = () => compiledDb([VOICE, REASONING, COVERAGE]);

  it('returns both forms of voice, because either alone is worse than useless', async () => {
    const { layers } = await explainPersona(db(), 'nate-b-jones');

    // Only `generative` leaves the instruction unfalsifiable; only `descriptive` means
    // two clients build two different personalities from identical data.
    assert.equal(layers.voice!.generative, 'Hedge before committing.');
    assert.equal(layers.voice!.descriptive, 'Hedges in 32 of 34 measured items.');
    assert.deepEqual(layers.voice!.evidence, { items_measured: 34 });
  });

  it('puts basis on every layer', async () => {
    const { layers } = await explainPersona(db(), 'nate-b-jones');

    assert.equal(layers.voice!.basis, 'measured');
    assert.equal(layers.reasoning!.basis, 'inferred');
  });

  it('omits the generative form on a layer that has none rather than returning an empty one', async () => {
    const { layers } = await explainPersona(db(), 'nate-b-jones');

    assert.ok(!('generative' in layers.coverage!));
  });

  it('leaves the stored prose exactly as compiled, markers and all', async () => {
    const { layers } = await explainPersona(db(), 'nate-b-jones');

    // The script strips markers on the way out; the compiler contract behind this door is
    // untouched, which is what keeps `basis` from ever being lost.
    assert.match(layers.reasoning!.descriptive, /\*\*Inferred across 34 items/);
    assert.equal(layers.voice!.descriptive, 'Hedges in 32 of 34 measured items.');
  });

  it('names the persona as a model here too', async () => {
    assert.equal(
      (await explainPersona(db(), 'nate-b-jones')).subject,
      'braintrust model of Nate B. Jones',
    );
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

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
import { COMPILER_VERSION } from '../src/compile/version.js';
import { explainPersona, loadPersona } from '../src/personas.js';
import { fakeDb } from './support/fake-db.js';

const REASONING = {
  display_name: 'Nate B. Jones',
  compiled_at: new Date('2026-07-31T09:14:22.000Z'),
  compiler_version: COMPILER_VERSION,
  extractor: 'gpt-5@notes-1',
  layer: 'reasoning',
  basis: 'inferred',
  descriptive_md: '**Inferred across 34 items — no single item asserts this.**\n\nTraced to 8 of 34 items.',
  generative_md: null,
  evidence: {
    entries: [
      { label: 'opens-on-the-mistaken-instinct', items: ['a1', 'b2', 'c3'] },
      { label: 'closes-on-a-procedure', items: ['a1'] },
    ],
  },
};

const VOICE = {
  display_name: 'Nate B. Jones',
  compiled_at: new Date('2026-07-31T09:14:22.000Z'),
  compiler_version: COMPILER_VERSION,
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
    assert.match(speak, /Do not say them again/);
  });

  it('carries basis in receipts, where it cannot be spoken or paraphrased away', async () => {
    const { receipts } = await loadPersona(db(), 'nate-b-jones');

    // Prose redundancy only ever survived a paste. A scalar survives everything.
    assert.equal(receipts.voice, 'measured');
    assert.equal(receipts.reasoning, 'inferred');
  });

  it('speaks the menu own words for how they argue, and hands over no count', async () => {
    const { speak } = await loadPersona(db(), 'nate-b-jones');

    assert.match(speak, /- Open by naming the thing most people reach for first, and why it fails them\./);
    // The slug is a name in a file, not something a reader ever sees.
    assert.doesNotMatch(speak, /opens-on-the-mistaken-instinct/);
    assert.doesNotMatch(speak, /\d+ of \d+ items/);
  });

  it('says which generation of notes the persona was built from', async () => {
    const payload = await loadPersona(db(), 'nate-b-jones');

    // Declared on the compile row, never inferred from whatever happens to be configured
    // now — two generations coexist while a prompt upgrade re-reads the corpus.
    assert.equal(payload.extractor, 'gpt-5@notes-1');
    assert.equal(payload.compiler_version, COMPILER_VERSION);
    // ISO 8601, like every other tool — not the database's own rendering of a timestamp.
    assert.equal(payload.compiled_at, '2026-07-31T09:14:22.000Z');
  });

  it('says what current is, so the version it carries has something to be read against', async () => {
    const payload = await loadPersona(db(), 'nate-b-jones');

    // A version string alone tells a reader nothing: they cannot tell a persona built
    // under today's rules from one built under rules braintrust has since replaced.
    assert.equal(payload.current_compiler_version, COMPILER_VERSION);
  });
});

/**
 * A persona built under rules braintrust has since changed. Prose has no cautious version
 * of itself, so the paragraphs those rules wrote are absent until a rebuild — and the catch
 * happens on the read, so it is already true for the reader who triggered it.
 */
describe('a persona whose rules have moved under it', () => {
  const behind = (rows: Record<string, unknown>[]) =>
    compiledDb(rows.map((row) => ({ ...row, compiler_version: '0.1.0+measured-1' })));

  it('withholds the prose a moved part wrote', async () => {
    const payload = await explainPersona(behind([VOICE, REASONING, COVERAGE]), 'nate-b-jones');

    assert.ok(!('reasoning' in payload.layers), 'reasoning was written under rules that moved');
    // …and keeps everything a measurement produced, which has a cautious value instead.
    assert.ok('voice' in payload.layers);
    assert.ok('coverage' in payload.layers);
  });

  it('says which layers it withheld and why, in the receipts rather than in voice', async () => {
    const payload = await explainPersona(behind([VOICE, REASONING, COVERAGE]), 'nate-b-jones');

    assert.deepEqual(
      payload.withheld?.map((one) => one.layer),
      ['reasoning', 'beliefs'],
    );
    assert.match(payload.withheld![0]!.reason, /rebuild restores it/);
  });

  /**
   * **No second kind of silence.** A cautious absence has to read exactly like a genuine
   * one: a persona withholding its reasoning must be indistinguishable, in the script, from
   * one that never had any. Anything else tells a reader about braintrust's internals in
   * the one place that is supposed to be about the person.
   */
  it('reads exactly like a persona that never had that layer', async () => {
    const withheld = await loadPersona(behind([VOICE, REASONING, COVERAGE]), 'nate-b-jones');
    const never = await loadPersona(compiledDb([VOICE, COVERAGE]), 'nate-b-jones');

    assert.equal(withheld.speak, never.speak);
    assert.deepEqual(withheld.receipts, never.receipts);
    assert.doesNotMatch(withheld.speak, /HOW THEY ARGUE/);
    // Nothing about versions, rules or rebuilds reaches the prose meant to be spoken. The
    // disclosure's own "compiled model" is not an exception to this — it is the one thing
    // in the script that is addressed to a reader, and it says the same for every persona.
    assert.doesNotMatch(withheld.speak, /version|withheld|rebuil|out of date|stale/i);
  });

  it('is served rather than refused, because the cost of refusal lands on the reader', async () => {
    const payload = await loadPersona(behind([VOICE, REASONING, COVERAGE]), 'nate-b-jones');

    assert.ok(payload.speak.length > 0);
    assert.equal(payload.subject, 'braintrust model of Nate B. Jones');
  });

  it('leaves a persona on the current rules whole', async () => {
    const payload = await explainPersona(compiledDb([VOICE, REASONING, COVERAGE]), 'nate-b-jones');

    assert.ok('reasoning' in payload.layers);
    assert.equal(payload.withheld, undefined, 'an empty field would read as a fact rather than none');
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

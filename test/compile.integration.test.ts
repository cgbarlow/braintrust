/**
 * The compiler against real Postgres.
 *
 * The claims only a database can settle. A Persona has no independent existence — it is
 * the layers hanging off the one Compile whose status is `current` — and everything
 * below is about that being true rather than nearly true: that a rebuild replaces its
 * predecessor in one step, that a Compile which dies partway changes nothing, that two
 * currents are impossible by construction rather than by the compiler remembering, and
 * that deleting the old row is the whole of the cleanup.
 *
 * Skipped unless BRAINTRUST_TEST_DATABASE_URL is set. To run it locally:
 *
 *   docker run -d --name bt-pg -e POSTGRES_PASSWORD=bt -e POSTGRES_DB=braintrust \
 *     -p 55432:5432 pgvector/pgvector:pg16
 *   BRAINTRUST_TEST_DATABASE_URL=postgresql://postgres:bt@127.0.0.1:55432/braintrust \
 *     npm test
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  checkCompile,
  compileCorpus,
  compilerVersion,
  personasBehind,
  gateFacts,
  INFERRED_MARKER,
  STALE_COMPILE_MS,
  VOICE_MIN_WORDS,
  writeRelations,
} from '../src/compile/index.js';
import { createDb, type Db, type PostgresDb, type TransactionalDb } from '../src/db.js';
import { explainPersona, listPersonas, loadPersona } from '../src/personas.js';
import { chunkItem } from '../src/retrieval/index.js';
import { fakeEmbedder } from './support/embeddings.js';
import { distinctStatement, fakeSynthesiser, idsFromDigest } from './support/synthesiser.js';

const url = process.env.BRAINTRUST_TEST_DATABASE_URL;
const skip = url ? false : 'set BRAINTRUST_TEST_DATABASE_URL to run the schema tests';

const GENERATION = 'test-reader@notes-1';
const ITEMS = 4;

/** Written so hedging lands in every item and direct address in half of them. */
function body(index: number): string {
  const lines = [
    `I think the ${index}th thing everyone gets wrong is that speed is the constraint.`,
    'It is not. The constraint is knowing which of the twenty things in front of you is worth doing at all.',
  ];
  if (index % 2 === 0) lines.push("Here's what that means for the next thing you build.");
  return lines.join('\n\n');
}

describe('compiling the core, against real Postgres', { skip }, () => {
  let db: PostgresDb;
  let personId: string;
  let sourceId: string;

  before(async () => {
    db = createDb(url!);
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    if (db) {
      await db.query('truncate braintrust_people cascade');
      await db.close();
    }
  });

  beforeEach(async () => {
    await db.query('truncate braintrust_people cascade');
    await seed();
  });

  async function seed(): Promise<void> {
    const person = await db.query<{ id: string }>(
      `insert into braintrust_people (slug, display_name) values ('nate', 'Nate B. Jones') returning id`,
    );
    personId = person.rows[0]!.id;

    const source = await db.query<{ id: string }>(
      `insert into braintrust_sources (person_id, platform, handle, discovery_url, backfill_floor,
                                       backfill_complete)
       values ($1, 'substack', 'nate.substack.com', 'https://example.test/feed', current_date - 365, true)
       returning id`,
      [personId],
    );
    sourceId = source.rows[0]!.id;

    for (let index = 0; index < ITEMS; index += 1) {
      await addItem(`post-${index}`, body(index), `2025-0${index + 1}-01`);
    }

    // The two skips a persona has to be able to name, and they are not the same fact.
    await db.query(
      `insert into braintrust_items (source_id, external_id, url, audience, retrieval, published_at)
       values ($1, 'paid', 'https://example.test/paid', 'paid', 'skipped_paywall', '2025-03-01'),
              ($1, 'short', 'https://example.test/short', 'everyone', 'skipped_short', '2025-03-02')`,
      [sourceId],
    );
  }

  /** Retrieved, chunked and read — an item with nothing left owed on it. */
  async function addItem(externalId: string, text: string, published: string): Promise<string> {
    const item = await db.query<{ id: string }>(
      `insert into braintrust_items (source_id, external_id, url, audience, retrieval, body_text,
                                     published_at)
       values ($1, $2, $3, 'everyone', 'retrieved', $4, $5) returning id`,
      [sourceId, externalId, `https://example.test/${externalId}`, text, published],
    );
    const itemId = item.rows[0]!.id;

    for (const chunk of chunkItem({ text, raw: null })) {
      await db.query(
        `insert into braintrust_chunks (item_id, ordinal, text, char_start, char_end, start_ms, end_ms)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [itemId, chunk.ordinal, chunk.text, chunk.charStart, chunk.charEnd, chunk.startMs, chunk.endMs],
      );
    }
    await writeNote(itemId);
    return itemId;
  }

  /**
   * Two claims, quoted from the body — the growing layer is built from these, and a
   * citation carries the quote braintrust verified rather than one written later.
   */
  async function writeNote(itemId: string): Promise<void> {
    await db.query(
      `insert into braintrust_item_notes (item_id, extractor, claims, argument_md, assumptions)
       values ($1, $2, $3::jsonb, 'an argument', '[]'::jsonb)`,
      [
        itemId,
        GENERATION,
        JSON.stringify([
          {
            statement: 'Speed is not the constraint.',
            quote: 'speed is the constraint',
            chunk_id: null,
            start_ms: null,
          },
          {
            statement: 'Judgement about what to build is what is scarce.',
            quote: 'knowing which of the twenty things in front of you is worth doing',
            chunk_id: null,
            start_ms: null,
          },
        ]),
      ],
    );
  }

  function compile(overrides: Partial<Parameters<typeof compileCorpus>[0]> = {}) {
    return compileCorpus({
      db,
      extractor: GENERATION,
      synthesiser: fakeSynthesiser(),
      log: () => {},
      ...overrides,
    });
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await db.query<{ count: string }>(sql, params);
    return Number(rows[0]!.count);
  }

  async function currentCompileId(): Promise<string | undefined> {
    const { rows } = await db.query<{ id: string }>(
      `select id from braintrust_compiles where person_id = $1 and status = 'current'`,
      [personId],
    );
    return rows[0]?.id;
  }

  it('builds every core layer and promotes them', async () => {
    const report = await compile();

    assert.deepEqual(report.compiled, ['nate']);
    // No embedder in this run, so the version says so. It records what the compile could
    // do rather than what the code supports.
    assert.equal(report.compiler_version, compilerVersion({ revisions: false }));

    const persona = await explainPersona(db, 'nate');
    assert.equal(persona.subject, 'braintrust model of Nate B. Jones');
    assert.deepEqual(Object.keys(persona.layers).sort(), ['coverage', 'reasoning', 'voice']);
    assert.equal(persona.layers.voice!.basis, 'measured');
    assert.equal(persona.layers.coverage!.basis, 'measured');
    assert.equal(persona.layers.reasoning!.basis, 'inferred');
    // The compile declares the generation it read, on the row.
    assert.equal(persona.extractor, GENERATION);
  });

  it('serves the inferred layer with the marker in the prose, not only the basis field', async () => {
    await compile();
    const persona = await explainPersona(db, 'nate');

    for (const layer of ['reasoning']) {
      // The field is lost the moment a client pastes the markdown into a system prompt.
      // The first line is not.
      assert.match(persona.layers[layer]!.descriptive, INFERRED_MARKER);
      assert.ok(!('generative' in persona.layers[layer]!), `${layer} should have no generative form`);
    }
  });

  it('synthesises across notes rather than reading the items again', async () => {
    const synthesiser = fakeSynthesiser();

    await compile({ synthesiser });

    // **Not one call writes a layer of conclusions.** The habits are a selection off an
    // authored menu and the positions carry their own citations — and the third question,
    // through-lines, is not asked at all here: four items cannot be read twice, so this
    // persona holds none and publishes anyway. A rebuild still costs a handful of calls
    // over notes rather than a re-read of the corpus.
    assert.deepEqual(
      synthesiser.calls.map((call) => `${call.kind}:${call.mode}`),
      ['habits:pass', 'positions:pass'],
    );

    // Every item's note is in the core digests, and none of the item bodies are.
    for (const call of synthesiser.calls.filter((one) => one.kind !== 'positions')) {
      assert.equal(idsFromDigest(call.digest).length, ITEMS);
      assert.doesNotMatch(call.digest, /speed is the constraint/);
    }

    // The clustering digest carries claim statements and never the quotes: showing a
    // model the quote is how a model ends up editing one.
    const clustering = synthesiser.calls.find((call) => call.kind === 'positions')!.digest;
    assert.match(clustering, /^\[c1\] .* — Speed is not the constraint\./m);
    assert.doesNotMatch(clustering, /knowing which of the twenty things/);
  });

  it('measures the voice over the real item text', async () => {
    await compile();
    const evidence = (await explainPersona(db, 'nate')).layers.voice!.evidence as {
      items_measured: number;
      moves: { move: string; spread: number }[];
    };

    assert.equal(evidence.items_measured, ITEMS);
    assert.equal(evidence.moves.find((one) => one.move === 'hedging')!.spread, ITEMS);
    assert.equal(evidence.moves.find((one) => one.move === 'direct-address')!.spread, ITEMS / 2);
  });

  it('reconciles coverage against the item rows it was counted from', async () => {
    await compile();
    const evidence = (await explainPersona(db, 'nate')).layers.coverage!.evidence as {
      retrieved: number;
      skipped_paywall: number;
      skipped_short: number;
      by_source: Record<string, { retrieved: number }>;
    };

    assert.equal(evidence.retrieved, await count(
      `select count(*) from braintrust_items i join braintrust_sources s on s.id = i.source_id
        where s.person_id = $1 and i.retrieval = 'retrieved'`,
      [personId],
    ));
    assert.equal(evidence.skipped_paywall, 1);
    assert.equal(evidence.skipped_short, 1);
    assert.equal(evidence.by_source['substack:nate.substack.com']!.retrieved, ITEMS);
  });

  it('splits coverage by form at the same floor voice measures over', async () => {
    // The four seeded items are a few dozen words each — short-form by any reading. One
    // essay against them is the shape a mixed corpus has, and the shape that made the old
    // single-population arithmetic meaningless.
    const essay = `${body(9)}\n\n${'It seems like the constraint is never the tooling. '.repeat(150)}`;
    await addItem('an-essay', essay, '2025-06-15');
    await compile();

    const persona = await explainPersona(db, 'nate');
    const coverage = persona.layers.coverage!.evidence as {
      retrieved: number;
      words_retrieved: number;
      by_form: { long_form: { items: number; words: number }; short_form: { items: number; words: number } };
      voice_measured_over: { min_words: number; items: number; items_excluded: number };
    };
    const voice = persona.layers.voice!.evidence as { items_measured: number };

    assert.equal(coverage.by_form.long_form.items, 1);
    assert.equal(coverage.by_form.short_form.items, ITEMS);

    // The split has to be the *same* count as the total, not a second count that happens
    // to agree — which is why it comes out of one expression in one query.
    assert.equal(
      coverage.by_form.long_form.items + coverage.by_form.short_form.items,
      coverage.retrieved,
    );
    assert.equal(
      coverage.by_form.long_form.words + coverage.by_form.short_form.words,
      coverage.words_retrieved,
    );

    // And the boundary is voice's own floor, so the two layers cannot disagree about
    // which items are long enough to argue in.
    assert.equal(coverage.voice_measured_over.min_words, VOICE_MIN_WORDS);
    assert.equal(coverage.voice_measured_over.items, voice.items_measured);
    assert.equal(voice.items_measured, coverage.by_form.long_form.items);
    assert.equal(coverage.voice_measured_over.items_excluded, coverage.by_form.short_form.items);
  });

  it('replaces the previous persona whole, rather than editing it', async () => {
    await compile();
    const first = await currentCompileId();

    await addItem('post-new', body(9), '2025-09-01');
    await compile();
    const second = await currentCompileId();

    assert.notEqual(first, second);
    // The old compile is gone, not archived — a persona cannot drift from its evidence
    // because it has no independent existence.
    assert.equal(await count('select count(*) from braintrust_compiles where id = $1', [first!]), 0);
    assert.equal(
      await count(`select count(*) from braintrust_compiles where person_id = $1 and status = 'current'`, [
        personId,
      ]),
      1,
    );
    const evidence = (await explainPersona(db, 'nate')).layers.voice!.evidence as { items_measured: number };
    assert.equal(evidence.items_measured, ITEMS + 1);
  });

  it('lets on delete cascade do all the cleanup, with no reconciliation step', async () => {
    await compile();
    const compileId = await currentCompileId();
    assert.equal(await count('select count(*) from braintrust_persona_layers where compile_id = $1', [compileId!]), 3);

    await db.query('delete from braintrust_compiles where id = $1', [compileId!]);

    assert.equal(await count('select count(*) from braintrust_persona_layers where compile_id = $1', [compileId!]), 0);
    assert.equal(await count('select count(*) from braintrust_persona_layers'), 0);
  });

  it('refuses a second current compile in the database rather than in the compiler', async () => {
    await compile();

    await assert.rejects(
      () =>
        db.query(
          `insert into braintrust_compiles (person_id, compiler_version, status) values ($1, 'x', 'current')`,
          [personId],
        ),
      /braintrust_compiles_one_current_idx/,
    );
  });

  it('waits while a rebuild is already running, and says when that one started', async () => {
    await db.query(
      `insert into braintrust_compiles (person_id, compiler_version, status) values ($1, 'x', 'running')`,
      [personId],
    );

    const report = await compile();

    assert.deepEqual(report.compiled, []);
    assert.match(report.waiting[0]!.reason, /is still running/);
    assert.equal(await currentCompileId(), undefined);
  });

  it('takes over a running compile whose process is gone, rather than freezing the persona forever', async () => {
    const stale = await db.query<{ id: string }>(
      `insert into braintrust_compiles (person_id, compiler_version, status, started_at)
       values ($1, 'x', 'running', now() - interval '1 millisecond' * $2) returning id`,
      [personId, STALE_COMPILE_MS + 60_000],
    );

    const report = await compile();

    assert.deepEqual(report.compiled, ['nate']);
    // Recorded rather than deleted: the row survives for inspection, with the reason.
    const { rows } = await db.query<{ status: string; rejected_reason: string }>(
      'select status, rejected_reason from braintrust_compiles where id = $1',
      [stale.rows[0]!.id],
    );
    assert.equal(rows[0]!.status, 'failed');
    assert.match(rows[0]!.rejected_reason, /abandoned/);
  });

  it('waits for an empty backlog rather than measuring half a corpus', async () => {
    await compile();
    const before = await currentCompileId();

    await db.query(
      `insert into braintrust_items (source_id, external_id, url, audience, retrieval, published_at)
       values ($1, 'waiting', 'https://example.test/waiting', 'everyone', 'pending', '2025-09-01')`,
      [sourceId],
    );

    const report = await compile();

    assert.deepEqual(report.compiled, []);
    assert.match(report.waiting[0]!.reason, /1 to retrieve/);
    // The previous persona stays live for the duration.
    assert.equal(await currentCompileId(), before);
  });

  it('waits on an item that has been read under a different generation', async () => {
    await compile();
    await addItem('post-unread', body(7), '2025-09-01');
    await db.query(`update braintrust_item_notes set extractor = 'other@notes-1'
                     where item_id = (select id from braintrust_items where external_id = 'post-unread')`);

    const report = await compile();

    assert.deepEqual(report.compiled, []);
    assert.match(report.waiting[0]!.reason, /1 to read/);
  });

  it('does not wait on vectors, which nothing in the core reads', async () => {
    // Chunking survives an endpoint being switched off and the vectors wait. Blocking a
    // rebuild on them would hand a switched-off endpoint a veto over the two layers that
    // cost nothing to compute.
    assert.equal(await count('select count(*) from braintrust_embeddings'), 0);

    const report = await compile();

    assert.deepEqual(report.compiled, ['nate']);
  });

  it('rebuilds a person who has never been compiled, because everything is unseen', async () => {
    const report = await compile();

    assert.deepEqual(report.compiled, ['nate']);
  });

  it('leaves a compiled person alone when nothing arrived', async () => {
    await compile();
    const before = await currentCompileId();

    const report = await compile();

    assert.deepEqual(report.compiled, []);
    assert.deepEqual(report.waiting, []);
    assert.equal(await currentCompileId(), before);
  });

  it('rebuilds on the run that finishes the reading, not the run that found the item', async () => {
    // The seam between two rules: new content triggers a rebuild, and a rebuild waits
    // for an empty backlog. An item that arrives on Monday and is read on Tuesday is
    // news to nobody on Tuesday — and asking "did anything happen today" would leave
    // this persona stale until the person next published, which has nothing to do with
    // what it is actually waiting for.
    await compile();
    const before = await currentCompileId();

    const itemId = await addItem('post-late', body(9), '2025-09-01');
    await db.query('delete from braintrust_item_notes where item_id = $1', [itemId]);
    assert.deepEqual((await compile()).compiled, [], 'the backlog is not empty yet');
    assert.equal(await currentCompileId(), before);

    // Tuesday: the note is written and nothing else about the world changes.
    await writeNote(itemId);

    assert.deepEqual((await compile()).compiled, ['nate']);
    assert.notEqual(await currentCompileId(), before);
  });

  /**
   * The second kind of staleness. A persona can be perfectly current with everything its
   * subject published and out of date with what braintrust can now do with it — and no row
   * changes in that case, so the content trigger never fires.
   *
   * Found live: Stuart Winter-Tear's persona compiled before an embeddings endpoint
   * existed, so revision detection was skipped, and nothing would ever have re-run it.
   */
  describe('when the compiler changes rather than the corpus', () => {
    async function storedVersion(): Promise<string> {
      const { rows } = await db.query<{ compiler_version: string }>(
        `select compiler_version from braintrust_compiles where status = 'current'`,
      );
      return rows[0]!.compiler_version;
    }

    it('records what the compile could actually do, not what the code supports', async () => {
      await compile();

      // No embedder was configured, so no pair was compared. A row claiming `revisions-1`
      // would be the persona asserting it looked for changes of mind and found none.
      assert.match(await storedVersion(), /revisions-none$/);
    });

    it('rebuilds once an embedder appears, with the corpus untouched', async () => {
      await compile();
      const before = await currentCompileId();
      assert.deepEqual((await compile()).compiled, [], 'nothing changed, so nothing rebuilds');

      // The capability changes. Not one row of the corpus does.
      const report = await compile({ embedder: fakeEmbedder() });

      assert.deepEqual(report.compiled, ['nate']);
      assert.notEqual(await currentCompileId(), before);
      assert.match(await storedVersion(), /revisions-1$/);
    });

    it('measures its own off-corpus gate and stores it with the compile that measured it', async () => {
      // The claim that makes calibration an operator's job no longer: a compile with an
      // embedder writes a margin measured against this persona's own corpus, using this
      // persona's own positions as the questions the corpus must be able to answer.
      await compile({ embedder: fakeEmbedder() });

      const { rows } = await db.query<{ selectivity: Record<string, unknown> | null }>(
        `select corpus_stats -> 'selectivity' as selectivity
           from braintrust_compiles where status = 'current'`,
      );

      const measured = rows[0]?.selectivity;
      assert.ok(measured, 'every compile records what its gate was set to and why');
      assert.ok(
        ['separated', 'overlapping', 'not_measurable'].includes(measured.separation as string),
        `separation was ${String(measured.separation)}`,
      );
      assert.equal(typeof measured.floor, 'number');
      // Never a measured outcome without the evidence for one.
      if (measured.separation === 'not_measurable') {
        assert.equal(measured.in_low, null);
      } else {
        assert.equal(typeof measured.in_low, 'number');
        assert.equal(typeof measured.out_high, 'number');
      }
      // And `span` exists only where the probes actually separated — it is the scale
      // `fit` grades against, and an unearned scale is worse than none.
      assert.equal(measured.span === null, measured.separation !== 'separated');
    });

    it('still promotes a persona when there is no embedder to calibrate with', async () => {
      // Nothing about calibration may cost a persona its rebuild.
      const report = await compile();
      assert.deepEqual(report.compiled, ['nate']);

      const { rows } = await db.query<{ separation: string | null }>(
        `select corpus_stats -> 'selectivity' ->> 'separation' as separation
           from braintrust_compiles where status = 'current'`,
      );
      assert.equal(rows[0]?.separation, 'not_measurable');
    });

    it('rebuilds exactly once, then goes quiet', async () => {
      await compile();
      await compile({ embedder: fakeEmbedder() });
      const after = await currentCompileId();

      // The stored version now matches, so the second question stops firing too.
      const report = await compile({ embedder: fakeEmbedder() });

      assert.deepEqual(report.compiled, []);
      assert.equal(await currentCompileId(), after);
    });

    it('says which of the two reasons it rebuilt for', async () => {
      await compile();
      const lines: string[] = [];
      await compile({ embedder: fakeEmbedder(), log: (line: string) => lines.push(line) });

      // A burst of rebuilds on a day nothing was published is otherwise an unexplained
      // cost, and this line is the only place it is ever explained.
      assert.ok(
        lines.some((line) => line.includes('rebuilt because the compiler changed, not the corpus')),
        lines.join('\n'),
      );
    });

    /**
     * **The scheduled check**, asked after a run rather than before it. The rebuild trigger
     * is `stale_compiler`; this asserts the run left nobody behind, and it is asked whether
     * or not anyone is looking — because staleness fixed only for the personas somebody
     * happens to read is the failure this replaces.
     */
    it('reports nobody serving behind the compiler once a run has caught up', async () => {
      await compile({ embedder: fakeEmbedder() });

      assert.deepEqual(await personasBehind(db, compilerVersion({ revisions: true })), []);
    });

    it('names a persona left serving on rules that have moved', async () => {
      await compile({ embedder: fakeEmbedder() });
      await db.query(
        `update braintrust_compiles set compiler_version = '0.9.0+measured-4.core-1.positions-2.revisions-1'
          where status = 'current'`,
      );

      assert.deepEqual(await personasBehind(db, compilerVersion({ revisions: true })), ['nate']);
    });

    it('says nothing about a paused persona, because a pause is the user freezing it', async () => {
      await compile({ embedder: fakeEmbedder() });
      await db.query(
        `update braintrust_compiles set compiler_version = 'something-older' where status = 'current'`,
      );
      await db.query('update braintrust_people set paused_at = now() where id = $1', [personId]);

      assert.deepEqual(await personasBehind(db, compilerVersion({ revisions: true })), []);
    });
  });

  it('never rebuilds a paused person, because a pause is the user freezing the persona', async () => {
    await db.query('update braintrust_people set paused_at = now() where id = $1', [personId]);

    const report = await compile();

    assert.deepEqual(report.compiled, []);
    assert.equal(await currentCompileId(), undefined);
  });

  it('changes nothing when a compile fails partway through', async () => {
    await compile();
    const before = await currentCompileId();
    const evidenceBefore = (await explainPersona(db, 'nate')).layers.voice!.evidence;

    await addItem('post-new', body(9), '2025-09-01');
    const report = await compileCorpus({
      db: failingOn(db, 'braintrust_persona_layers'),
      extractor: GENERATION,
      synthesiser: fakeSynthesiser(),
      log: () => {},
    });

    assert.deepEqual(report.compiled, []);
    assert.equal(report.failed[0]!.person, 'nate');

    // The persona that was already there is untouched, because the delete and the
    // promotion are the same transaction and neither ever ran.
    assert.equal(await currentCompileId(), before);
    assert.deepEqual((await explainPersona(db, 'nate')).layers.voice!.evidence, evidenceBefore);
    assert.equal(
      await count(`select count(*) from braintrust_compiles where person_id = $1 and status = 'failed'`, [
        personId,
      ]),
      1,
    );
  });

  it('refuses to publish a compile that failed the gate, and keeps yesterday persona serving', async () => {
    await compile();
    const before = await currentCompileId();

    await addItem('post-new', body(9), '2025-09-01');
    const report = await compile({ synthesiser: fakeSynthesiser({ habitsFor: () => [] }) });

    assert.deepEqual(report.compiled, []);
    assert.equal(report.rejected[0]!.person, 'nate');
    // Reasoning alone. It is the last core layer a model has a hand in, so it is the only
    // one a synthesiser returning nothing can empty — beliefs used to be the other, and a
    // compile is no longer refused for holding no convictions.
    assert.match(report.rejected[0]!.reason, /reasoning carried nothing to serve/);

    // Not published, and not deleted either. The persona that was already there is
    // untouched and still the one a client is served.
    assert.equal(await currentCompileId(), before);
    const persona = await explainPersona(db, 'nate');
    assert.equal((persona.layers.voice!.evidence as { items_measured: number }).items_measured, ITEMS);
  });

  /**
   * **The compiler seam this ticket has to be provable at.**
   *
   * The gate used to reject a compile whose beliefs layer carried nothing, and that rule
   * dies with the layer: under *survives more than one separate reading* a great many
   * people legitimately hold no through-lines, so a rule rejecting on emptiness would
   * block good personas from ever shipping. Six items — enough to be read twice — and a
   * synthesiser that finds nothing in either reading.
   */
  it('publishes a compile that holds no through-lines at all', async () => {
    for (let index = ITEMS; index < 6; index += 1) {
      await addItem(`post-${index}`, body(index), `2025-0${index + 1}-01`);
    }

    const synthesiser = fakeSynthesiser({ entriesFor: () => [] });
    const report = await compile({ synthesiser });

    assert.deepEqual(report.compiled, ['nate']);
    assert.deepEqual(report.rejected, []);

    // It was asked, and it answered nothing — not skipped for being too small.
    assert.equal(
      synthesiser.calls.filter((call) => call.kind === 'through_lines' && call.mode === 'pass').length,
      2,
    );
    assert.equal(
      await count(
        `select count(*) from braintrust_through_lines t
           join braintrust_compiles c on c.id = t.compile_id
          where c.person_id = $1 and c.status = 'current'`,
        [personId],
      ),
      0,
    );

    // And it is the persona a client is served, on `current`, with its three core layers.
    const persona = await explainPersona(db, 'nate');
    assert.deepEqual(Object.keys(persona.layers).sort(), ['coverage', 'reasoning', 'voice']);
  });

  /**
   * **The check that catches the fourth `fit` defect, blocking a real compile.**
   *
   * Two positions worded the same way embed to the same vector, so `fit` would have to give
   * them the same score — which is the shape all three shipped defects had, and 41 of 92 live
   * positions carried it. The previous persona keeps answering and the next run tries again.
   */
  it('refuses to publish positions that would be graded on the same thing', async () => {
    await compile({ embedder: fakeEmbedder() });
    const before = await currentCompileId();

    await addItem('post-twinned', body(9), '2025-10-01');
    const report = await compile({
      embedder: fakeEmbedder(),
      synthesiser: fakeSynthesiser({
        // One statement, worded identically for every group. In a real corpus that is one
        // position written twice; here it is the defect, arriving at the gate.
        positionsFor: (claims) =>
          claims.map((claim, index) => ({
            slug: `position-${index}`,
            statement: 'The very same sentence, every time.',
            claims: [claim],
          })),
      }),
    });

    assert.deepEqual(report.compiled, []);
    assert.match(report.rejected[0]!.reason, /positions_are_graded_apart/);
    assert.match(report.rejected[0]!.reason, /graded on the same thing/);
    assert.equal(await currentCompileId(), before, 'yesterday persona is untouched');
  });

  /**
   * A deployment with no embeddings endpoint publishes a persona that grades nothing. Making
   * a grade a condition of having a persona would be a much larger claim than the check is
   * making — and every other compile in this file is one of these.
   */
  it('publishes a compile that grades nothing, because nothing shared is nothing to confuse', async () => {
    const report = await compile();

    assert.deepEqual(report.compiled, ['nate']);
    assert.equal(
      await count('select count(*) from braintrust_position_embeddings'),
      0,
      'no endpoint, no statement vectors, and no grade to get wrong',
    );
  });

  it('embeds every statement it publishes, so no answer mixes graded and ungraded positions', async () => {
    await compile({ embedder: fakeEmbedder() });

    const positions = await count(
      `select count(*) from braintrust_positions p
         join braintrust_compiles c on c.id = p.compile_id
        where c.status = 'current'`,
    );
    assert.ok(positions > 1);
    assert.equal(
      await count(
        `select count(*) from braintrust_position_embeddings pe
           join braintrust_positions p on p.id = pe.position_id
           join braintrust_compiles c on c.id = p.compile_id
          where c.status = 'current'`,
      ),
      positions,
    );
  });

  /**
   * **Through-lines, at the compiler seam.** An entry surfacing in one reading does not ship;
   * one surfacing in two does. The rule is the whole reason a through-line may be spoken
   * flatly, and it is structural — the merge already sees which readings an entry came from.
   */
  describe('through-lines', () => {
    /** Six notes, which is the fewest that can be read twice. */
    async function enoughToReadTwice(): Promise<void> {
      for (let index = ITEMS; index < 6; index += 1) {
        await addItem(`post-${index}`, body(index), `2025-0${index + 1}-01`);
      }
    }

    /**
     * A synthesiser whose entries differ per reading, so the rule is observable.
     *
     * `sameThing` is what the merge would answer: true when the readings found one
     * conviction worded twice, false when they found two different ones. That judgement is
     * the only thing here a model is for, and the compiler counts readings after it rather
     * than before — two wordings of one conviction are one through-line seen twice.
     */
    function readings(perReading: string[][], sameThing = true) {
      let call = 0;
      return fakeSynthesiser({
        entriesFor: (items) => {
          const labels = perReading[call++] ?? [];
          return labels.map((label) => ({ label, body: `About ${label}.`, items }));
        },
        groupsFor: (indices) =>
          sameThing && indices.length > 1 ? [{ members: indices, clearest: indices[0]! }] : [],
      });
    }

    it('publishes one that survived a second reading', async () => {
      await enoughToReadTwice();
      await compile({
        synthesiser: readings([['Judgement is scarce'], ['Judgement is scarce']]),
      });

      const { rows } = await db.query<{ slug: string; statement: string; readings: number }>(
        `select t.slug, t.statement, t.readings from braintrust_through_lines t
           join braintrust_compiles c on c.id = t.compile_id
          where c.status = 'current'`,
      );

      assert.deepEqual(
        rows.map((row) => row.statement),
        ['Judgement is scarce'],
      );
      assert.equal(rows[0]!.readings, 2);
    });

    it('does not publish one that surfaced in a single reading', async () => {
      await enoughToReadTwice();
      await compile({
        synthesiser: readings(
          [['Only the first reading saw this'], ['Something else entirely']],
          false,
        ),
      });

      assert.equal(await count('select count(*) from braintrust_through_lines'), 0);
    });

    it('publishes a compile that found none, because an empty answer is a real one', async () => {
      // Four items is under the floor: this person cannot be read twice, so they hold no
      // through-lines and the persona ships anyway.
      const report = await compile();

      assert.deepEqual(report.compiled, ['nate']);
      assert.equal(await count('select count(*) from braintrust_through_lines'), 0);
    });

    it('is dropped with the compile it belongs to, like every other tier 3 row', async () => {
      await enoughToReadTwice();
      await compile({
        synthesiser: readings([['Held once'], ['Judgement is scarce'], ['Judgement is scarce']]),
      });
      assert.ok((await count('select count(*) from braintrust_through_lines')) > 0);

      await db.query('delete from braintrust_compiles where person_id = $1', [personId]);

      assert.equal(await count('select count(*) from braintrust_through_lines'), 0);
      assert.equal(await count('select count(*) from braintrust_through_line_items'), 0);
    });
  });

  it('keeps a rejected compile rows and its reason, because that is what a diagnosis reads', async () => {
    await compile({ synthesiser: fakeSynthesiser({ habitsFor: () => [] }) });

    const { rows } = await db.query<{ id: string; status: string; rejected_reason: string }>(
      `select id, status, rejected_reason from braintrust_compiles
        where person_id = $1 and status = 'rejected'`,
      [personId],
    );

    assert.equal(rows.length, 1);
    assert.match(rows[0]!.rejected_reason, /carried nothing to serve/);
    // Every layer is still there to look at — the point of rejecting rather than failing
    // is that the compiler's output survives.
    assert.equal(
      await count('select count(*) from braintrust_persona_layers where compile_id = $1', [rows[0]!.id]),
      3,
    );
  });

  it('lets the next run try again after a rejection, because a retry is cheap', async () => {
    const rejected = await compile({ synthesiser: fakeSynthesiser({ habitsFor: () => [] }) });
    assert.equal(rejected.rejected.length, 1);

    // A gate rejection does not stop the schedule: the run that leaves nothing `running`
    // is what makes tomorrow's attempt possible without anyone intervening.
    const report = await compile();

    assert.deepEqual(report.compiled, ['nate']);
    assert.equal(
      await count(`select count(*) from braintrust_compiles where person_id = $1 and status = 'rejected'`, [
        personId,
      ]),
      1,
    );
  });

  it('rejects a compile whose coverage stopped agreeing with the item rows', async () => {
    // The gate recounts rather than trusting what the compiler put in the layer, so a
    // layer that disagrees with the rows it claims to describe never reaches a client.
    await compile();
    const compileId = await currentCompileId();
    await db.query(
      `update braintrust_persona_layers
          set evidence = jsonb_set(evidence, '{retrieved}', '99')
        where compile_id = $1 and layer = 'coverage'`,
      [compileId!],
    );

    const facts = await gateFacts(db, personId, compileId!);
    const verdict = checkCompile(facts);

    assert.equal(verdict.passed, false);
    assert.match(verdict.reason!, /coverage says retrieved is 99, the rows say 4/);
  });

  it('writes positions with their citations, and hangs them off the compile being judged', async () => {
    await compile();
    const compileId = await currentCompileId();

    const positions = await db.query<{ slug: string; item_count: number; held_since: string }>(
      `select slug, item_count, held_since::text as held_since
         from braintrust_positions where compile_id = $1 order by slug`,
      [compileId!],
    );

    assert.ok(positions.rows.length > 0);
    for (const position of positions.rows) {
      const citations = await count(
        `select count(*) from braintrust_position_citations pc
           join braintrust_positions p on p.id = pc.position_id
          where p.compile_id = $1 and p.slug = $2`,
        [compileId!, position.slug],
      );
      assert.ok(citations > 0, `${position.slug} should cite something`);
    }

    // Every citation points at an item braintrust holds, and carries the person's own
    // words rather than the model's.
    const foreign = await count(
      `select count(*) from braintrust_position_citations pc
         join braintrust_positions p on p.id = pc.position_id
        where p.compile_id = $1
          and not exists (select 1 from braintrust_items i where i.id = pc.item_id)`,
      [compileId!],
    );
    assert.equal(foreign, 0);
  });

  /** One Position over every claim, so its span is the span of the whole corpus. */
  const together = (claims: string[]) => [
    { slug: 'the-constraint-is-not-speed', statement: 'The constraint is never speed.', claims },
  ];

  it('grades a position by the span of its evidence, and serves the span', async () => {
    // A fifth item, because `high` starts at five distinct Items — and four months of
    // them, because the whole question is whether it was said again later.
    await addItem('post-4', body(4), '2025-05-01');
    await compile({ synthesiser: fakeSynthesiser({ positionsFor: together }) });

    const { rows } = await db.query<{
      confidence: string;
      item_count: number;
      held_since: string;
      held_until: string;
      days_spanned: number;
    }>(
      `select confidence, item_count, held_since::text as held_since,
              held_until::text as held_until, days_spanned
         from braintrust_positions where compile_id = $1`,
      [(await currentCompileId())!],
    );

    const position = rows[0]!;
    assert.equal(position.item_count, 5);
    assert.equal(position.confidence, 'high');
    assert.equal(position.held_since, '2025-01-01');
    assert.equal(position.held_until, '2025-05-01');
    assert.equal(position.days_spanned, 120);
  });

  it('caps a burst at moderate, with the numbers it used in the answer', async () => {
    await addItem('post-4', body(4), '2025-05-01');
    // The same five Items and the same five claims, moved into one week. Nothing about
    // the evidence changed except when it was said — which is the entire claim.
    await db.query(
      `update braintrust_items set published_at = date '2025-05-01' + (
         substring(external_id from 6)::int
       ) where external_id like 'post-%'`,
    );
    await compile({ synthesiser: fakeSynthesiser({ positionsFor: together }) });

    const { rows } = await db.query<{
      confidence: string;
      item_count: number;
      days_spanned: number;
    }>(
      `select confidence, item_count, days_spanned
         from braintrust_positions where compile_id = $1`,
      [(await currentCompileId())!],
    );

    const position = rows[0]!;
    // Five separate pieces of work, still counted as five — the cap is a ceiling, not a
    // retune, and `item_count` stays the denominator a reader judges it on.
    assert.equal(position.item_count, 5);
    assert.equal(position.days_spanned, 4);
    assert.equal(position.confidence, 'moderate');
  });

  it('cannot cap a position it cannot date, and grades it on the count alone', async () => {
    await addItem('post-4', body(4), '2025-05-01');
    await db.query(`update braintrust_items set published_at = null where external_id like 'post-%'`);
    await compile({ synthesiser: fakeSynthesiser({ positionsFor: together }) });

    const { rows } = await db.query<{ confidence: string; days_spanned: number | null }>(
      `select confidence, days_spanned from braintrust_positions where compile_id = $1`,
      [(await currentCompileId())!],
    );

    // braintrust does not penalise what it cannot measure; it declines to claim it.
    assert.equal(rows[0]!.days_spanned, null);
    assert.equal(rows[0]!.confidence, 'high');
  });

  it('drops a position it cannot cite rather than publishing an uncited one', async () => {
    const report = await compile({
      synthesiser: fakeSynthesiser({
        positionsFor: (claims) => [
          { slug: 'real', statement: 'Rests on a claim braintrust issued.', claims: [claims[0]!] },
          { slug: 'invented', statement: 'Rests on nothing.', claims: ['c9999'] },
        ],
      }),
    });

    assert.deepEqual(report.compiled, ['nate']);
    const { rows } = await db.query<{ slug: string }>(
      `select p.slug from braintrust_positions p
         join braintrust_compiles c on c.id = p.compile_id
        where c.person_id = $1 and c.status = 'current'`,
      [personId],
    );
    assert.deepEqual(
      rows.map((row) => row.slug),
      ['real'],
    );
  });

  it('refuses to publish a compile whose positions collapsed against the previous one', async () => {
    await compile();
    const before = await currentCompileId();
    const had = await count('select count(*) from braintrust_positions where compile_id = $1', [before!]);
    assert.ok(had >= 2, 'the previous compile needs positions for a collapse to be visible');

    await addItem('post-new', body(9), '2025-09-01');
    const report = await compile({ synthesiser: fakeSynthesiser({ positionsFor: () => [] }) });

    assert.deepEqual(report.compiled, []);
    assert.match(report.rejected[0]!.reason, /positions fell from/);
    // A Persona that is thinner rather than wrong is the failure nothing else notices.
    assert.equal(await currentCompileId(), before);
  });

  it('reads the positions and their citations from the rows, ready for the compile that writes them', async () => {
    await compile();
    const compileId = await currentCompileId();
    const position = await db.query<{ id: string }>(
      `insert into braintrust_positions (compile_id, slug, statement, confidence, item_count)
       values ($1, 'speed-is-not-the-constraint', 'Speed is not the constraint.', 'high', 3)
       returning id`,
      [compileId!],
    );

    const uncited = checkCompile(await gateFacts(db, personId, compileId!));
    assert.equal(uncited.passed, false);
    assert.match(uncited.reason!, /resolve to no citation: speed-is-not-the-constraint/);

    await db.query(
      `insert into braintrust_position_citations (position_id, item_id, quote)
       values ($1, (select id from braintrust_items where external_id = 'post-0'), 'speed is the constraint')`,
      [position.rows[0]!.id],
    );

    assert.equal(checkCompile(await gateFacts(db, personId, compileId!)).passed, true);
  });

  it('writes the relations between positions, and nothing when there is no endpoint to ask', async () => {
    // Without an embedder there is no neighbourhood, so nothing is compared and every
    // position is current. A persona that says less is honest; one that guesses is not.
    await compile();
    assert.equal(await count('select count(*) from braintrust_position_relations'), 0);

    const synthesiser = fakeSynthesiser({
      positionsFor: (claims) =>
        claims.map((claim, index) => ({
          slug: `position-${index}`,
          statement: distinctStatement(index),
          claims: [claim],
        })),
      // One revision and the rest left standing, which is what a judge told to answer
      // unsettled whenever the call is close should look like.
      judgementsFor: (pairs) =>
        pairs.map((pair) => ({
          pair,
          relation: pair === 'p1' ? ('revised' as const) : ('unsettled' as const),
          rationale:
            pair === 'p1'
              ? 'The later piece narrows the earlier one in their own words.'
              : 'Both readings are still argued for.',
        })),
    });

    await addItem('post-later', body(9), '2025-11-01');
    const report = await compile({ synthesiser, embedder: fakeEmbedder() });
    assert.deepEqual(report.compiled, ['nate']);

    const relations = await db.query<{
      relation: string;
      gap_days: number;
      rationale: string;
      earlier: string;
      later: string;
      earlier_held: string;
      later_held: string;
    }>(
      `select r.relation, r.gap_days, r.rationale, earlier.slug as earlier, later.slug as later,
              earlier.held_since::text as earlier_held, later.held_since::text as later_held
         from braintrust_position_relations r
         join braintrust_positions earlier on earlier.id = r.from_position_id
         join braintrust_positions later on later.id = r.to_position_id
         join braintrust_compiles c on c.id = r.compile_id
        where c.person_id = $1 and c.status = 'current'`,
      [personId],
    );

    assert.ok(relations.rows.length > 0, 'the judge answered, so rows are owed');
    assert.equal(relations.rows.filter((row) => row.relation === 'revised').length, 1);
    for (const row of relations.rows) {
      assert.match(row.rationale, /narrows the earlier one|still argued for/);
      // `from` is the earlier position, and the gap is the two dates a reader is shown.
      assert.ok(row.earlier_held < row.later_held, `${row.earlier} should predate ${row.later}`);
      assert.equal(
        row.gap_days,
        Math.round((Date.parse(row.later_held) - Date.parse(row.earlier_held)) / 86_400_000),
      );
    }
  });

  it('never speaks a relation in the core, whatever the judge decided', async () => {
    const synthesiser = fakeSynthesiser({
      positionsFor: (claims) =>
        claims.map((claim, index) => ({
          slug: `position-${index}`,
          statement: distinctStatement(index),
          claims: [claim],
        })),
      judgementsFor: (pairs) =>
        pairs.map((pair) => ({
          pair,
          relation: 'unsettled' as const,
          rationale: 'They argue both sides in different pieces.',
        })),
    });

    await compile({ synthesiser, embedder: fakeEmbedder() });
    assert.ok(await count('select count(*) from braintrust_position_relations') > 0);

    // `unsettled` and `drifting` are visible to anyone who goes looking and are never
    // spoken in the person's voice — so nothing a client loads to answer *as* them
    // carries a tension the person never resolved.
    const persona = await explainPersona(db, 'nate');
    for (const [name, layer] of Object.entries(persona.layers)) {
      const prose = `${layer.descriptive} ${layer.generative ?? ''}`;
      assert.doesNotMatch(prose, /unsettled|drifting|superseded|revised/i, `${name} speaks a relation`);
      assert.doesNotMatch(prose, /argue both sides in different pieces/, `${name} carries a rationale`);
    }
  });

  it('refuses to publish a compile whose judge retired most of the persona', async () => {
    await compile();
    const before = await currentCompileId();

    await addItem('post-later', body(9), '2025-11-01');
    const report = await compile({
      synthesiser: fakeSynthesiser({
        positionsFor: (claims) =>
          claims.map((claim, index) => ({
            slug: `position-${index}`,
            statement: distinctStatement(index),
            claims: [claim],
          })),
        judgementsFor: (pairs) =>
          pairs.map((pair) => ({
            pair,
            relation: 'revised' as const,
            rationale: 'Everything supersedes everything, says the judge.',
          })),
      }),
      embedder: fakeEmbedder(),
    });

    // Every row is well-formed — dated, cited, ordered — and the persona is quietly
    // retired. Found live, which is why this check exists at all.
    assert.deepEqual(report.compiled, []);
    assert.match(report.rejected[0]!.reason, /position\(s\) were superseded on one rebuild/);
    assert.equal(await currentCompileId(), before);
  });

  it('drops a relation naming a position this compile did not write', async () => {
    await compile();
    const compileId = await currentCompileId();
    const ids = new Map(
      (
        await db.query<{ slug: string; id: string }>(
          `select slug, id from braintrust_positions where compile_id = $1`,
          [compileId!],
        )
      ).rows.map((row) => [row.slug, row.id]),
    );
    const [real] = [...ids.keys()];

    const written = await writeRelations(
      db,
      compileId!,
      [
        { from: real!, to: 'a-position-that-was-never-written', relation: 'revised', gap_days: 5, rationale: 'no' },
        { from: real!, to: real!, relation: 'unsettled', gap_days: 0, rationale: 'itself' },
      ],
      ids,
    );

    assert.deepEqual(written, { written: 0, dropped: 2 });
    assert.equal(await count('select count(*) from braintrust_position_relations'), 0);
  });

  it('writes the corpus stats braintrust_list_personas reports', async () => {
    await compile();

    const { personas } = await listPersonas(db);

    assert.equal(personas[0]!.compiled, true);
    assert.equal(personas[0]!.compiler_version, compilerVersion({ revisions: false }));
    assert.equal(personas[0]!.corpus!.items_retrieved, ITEMS);
    assert.equal(personas[0]!.corpus!.items_skipped_paywall, 1);
    assert.deepEqual(personas[0]!.corpus!.window, ['2025-01-01', '2025-04-01']);
  });
});

/**
 * A real database that throws on the first statement touching `marker`. The point is to
 * kill a Compile after it has written rows and before it has promoted, which is the only
 * moment where "a failed compile changes nothing" could be false.
 */
function failingOn(db: PostgresDb, marker: string): TransactionalDb {
  const guard = async <Row>(sql: string, params?: unknown[]) => {
    if (sql.includes(marker)) throw new Error('the database went away mid-compile');
    return db.query<Row>(sql, params);
  };

  return {
    query: guard,
    transaction: <T>(fn: (tx: Db) => Promise<T>) => db.transaction((tx) => fn({ ...tx, query: guard })),
  };
}

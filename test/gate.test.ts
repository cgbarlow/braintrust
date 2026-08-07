/**
 * The publish gate.
 *
 * A rebuild deletes its predecessor and there is no archive, so the only protection
 * against a bad Compile is refusing to publish it. Every check here is a count, a
 * presence or a regex — **never a model** — because a check that needs an endpoint can
 * fail the way the compiler fails, and a gate that needs a gate is not one.
 *
 * Failing means *not published*: rejected with a reason, rows kept, yesterday's Persona
 * still answering.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  checkCompile,
  CORE_LAYERS,
  GATE_CHECKS,
  gateCheckIds,
  POSITION_COLLAPSE_FLOOR,
  REVISION_SWEEP_CEILING,
  type GateFacts,
} from '../src/compile/gate.js';
import { inferredMarker } from '../src/compile/infer.js';
import { SPOKEN_DISCLOSURE } from '../src/disclosure.js';

const ITEMS = {
  retrieved: 4,
  skipped_paywall: 1,
  skipped_short: 1,
  skipped_window: 2,
  skipped_not_a_post: 0,
  failed: 0,
  pending: 0,
};

function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    layers: [
      {
        layer: 'voice',
        basis: 'measured',
        descriptive_md: 'Hedges in 4 of 4 measured items.',
        generative_md: 'Hedge before committing.',
        evidence: { items_measured: 4 },
      },
      {
        layer: 'coverage',
        basis: 'measured',
        descriptive_md: 'braintrust has read 4 items.',
        generative_md: null,
        evidence: { ...ITEMS },
      },
      {
        layer: 'reasoning',
        basis: 'inferred',
        descriptive_md: `${inferredMarker(4)}\n\nNames the constraint before the capability.`,
        generative_md: null,
        evidence: { entries: [{ label: 'Names the constraint first', items: ['a1'], items_traced: 1 }] },
      },
      {
        layer: 'beliefs',
        basis: 'inferred',
        descriptive_md: `${inferredMarker(4)}\n\nHolds that judgement is the scarce thing.`,
        generative_md: null,
        evidence: { entries: [{ label: 'Judgement is scarce', items: ['a1'], items_traced: 1 }] },
      },
    ],
    coverage_evidence: { ...ITEMS },
    items: { ...ITEMS },
    positions: [],
    previous_positions: 0,
    superseded_positions: 0,
    // Rendered the way the compiler renders it, so the fixture is a compile that would
    // actually serve rather than one built to satisfy a check.
    speak: `${SPOKEN_DISCLOSURE}\n\nSay that line first, word for word…`,
    ...overrides,
  };
}

function check(verdict: ReturnType<typeof checkCompile>, name: string) {
  return verdict.checks.find((one) => one.check === name)!;
}

describe('a compile that earns promotion', () => {
  it('passes every check there is', () => {
    const verdict = checkCompile(facts());

    assert.equal(verdict.passed, true);
    assert.equal(verdict.reason, null);
    assert.equal(verdict.checks.length, GATE_CHECKS.length);
    assert.ok(verdict.checks.every((one) => one.passed));
  });

  it('is checked without ever reaching a model, so it cannot fail the way the compiler fails', async () => {
    // Structural, mechanically: nothing in the gate can reach an endpoint, so it cannot
    // fail the way the compiler fails.
    const source = await readFile(new URL('../src/compile/gate.ts', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /\bfetch\(|\bSynthesiser\b|\bExtractor\b|\bEmbedder\b/);
  });
});

describe('the four core layers', () => {
  it('must all be there — a client loads the core whole', () => {
    for (const missing of CORE_LAYERS) {
      const verdict = checkCompile(
        facts({ layers: facts().layers.filter((one) => one.layer !== missing) }),
      );

      assert.equal(verdict.passed, false);
      assert.match(verdict.reason!, new RegExp(`${missing} missing`));
    }
  });

  it('must list something, because an inferred layer that says it found nothing is empty', () => {
    // The failure most likely to reach this gate in practice, and the one that taught it
    // this shape: a synthesis that returned nothing usable does not produce a blank
    // layer, it produces a marker and a sentence explaining itself. Prose is not the
    // test; entries are.
    const emptied = facts().layers.map((one) =>
      one.layer === 'beliefs'
        ? {
            ...one,
            descriptive_md: `${inferredMarker(4)}\n\nbraintrust could not synthesise anything here.`,
            evidence: { entries: [] },
          }
        : one,
    );

    const verdict = checkCompile(facts({ layers: emptied }));

    assert.equal(verdict.passed, false);
    assert.match(check(verdict, 'core_layers_present').detail, /beliefs carried nothing to serve/);
  });

  it('is satisfied by a measured layer with no entries, which is not how they are shaped', () => {
    // Voice and coverage carry counts rather than a list, so "empty" for them stays what
    // it always was: no prose.
    const blank = facts().layers.map((one) =>
      one.layer === 'coverage' ? { ...one, descriptive_md: '  ' } : one,
    );

    assert.match(
      check(checkCompile(facts({ layers: blank })), 'core_layers_present').detail,
      /coverage carried nothing to serve/,
    );
  });
});

describe('voice', () => {
  it('must carry both forms, because either alone is worse than useless', () => {
    const verdict = checkCompile(
      facts({
        layers: facts().layers.map((one) =>
          one.layer === 'voice' ? { ...one, generative_md: null } : one,
        ),
      }),
    );

    assert.equal(verdict.passed, false);
    assert.match(verdict.reason!, /missing one of its two forms/);
  });
});

describe('the inferred marker', () => {
  it('is required of every inferred layer, whatever the basis field says', () => {
    const verdict = checkCompile(
      facts({
        layers: facts().layers.map((one) =>
          one.layer === 'reasoning'
            ? { ...one, descriptive_md: 'Names the constraint before the capability.' }
            : one,
        ),
      }),
    );

    assert.equal(verdict.passed, false);
    assert.match(verdict.reason!, /reasoning is inferred and does not open with the inferred marker/);
  });

  it('is not satisfied by one buried further down the layer', () => {
    const verdict = checkCompile(
      facts({
        layers: facts().layers.map((one) =>
          one.layer === 'beliefs'
            ? { ...one, descriptive_md: `Some prose first.\n\n${inferredMarker(4)}` }
            : one,
        ),
      }),
    );

    // A client that pastes the opening paragraph into a system prompt would carry the
    // prose and leave the label behind.
    assert.equal(check(verdict, 'inferred_layers_marked').passed, false);
  });

  it('is not asked of a measured layer, which is labelled by having no model in its path', () => {
    const verdict = checkCompile(
      facts({
        layers: facts().layers.map((one) =>
          one.layer === 'coverage' ? { ...one, descriptive_md: 'No marker here.' } : one,
        ),
      }),
    );

    assert.equal(check(verdict, 'inferred_layers_marked').passed, true);
  });
});

describe('coverage', () => {
  it('must reconcile against the item rows, recounted at gate time', () => {
    const verdict = checkCompile(facts({ coverage_evidence: { ...ITEMS, retrieved: 3 } }));

    assert.equal(verdict.passed, false);
    assert.match(verdict.reason!, /coverage says retrieved is 3, the rows say 4/);
  });

  it('names every field that disagrees, not just the first', () => {
    const verdict = checkCompile(
      facts({ coverage_evidence: { ...ITEMS, retrieved: 3, skipped_paywall: 9 } }),
    );

    assert.match(verdict.reason!, /retrieved is 3/);
    assert.match(verdict.reason!, /skipped_paywall is 9/);
  });

  it('recounts every skip, so a new one cannot be added to the rows and left out of the layer', () => {
    const verdict = checkCompile(facts({ coverage_evidence: { ...ITEMS, skipped_window: 0 } }));

    // The check reads its fields from the recount rather than from a list written here,
    // which is what stops a state existing in the schema and silently in no layer.
    assert.equal(verdict.passed, false);
    assert.match(verdict.reason!, /coverage says skipped_window is 0, the rows say 2/);
  });

  it('fails a coverage layer carrying no structured evidence at all', () => {
    const verdict = checkCompile(facts({ coverage_evidence: null }));

    // A persona names its own blind spots. A layer with no counts cannot.
    assert.equal(check(verdict, 'coverage_reconciles').passed, false);
  });
});

describe('positions', () => {
  it('must each resolve to at least one citation', () => {
    const verdict = checkCompile(
      facts({
        positions: [
          { slug: 'speed-is-not-the-constraint', citations: 3 },
          { slug: 'uncited', citations: 0 },
        ],
      }),
    );

    assert.equal(verdict.passed, false);
    assert.match(verdict.reason!, /1 position\(s\) resolve to no citation: uncited/);
  });

  it('may not collapse against the compile they would replace', () => {
    const verdict = checkCompile(
      facts({
        positions: [{ slug: 'one', citations: 1 }],
        previous_positions: 20,
      }),
    );

    // The failure this catches is silent: a note generation that half-parsed produces a
    // persona that is thinner rather than wrong, and no other check would notice.
    assert.equal(verdict.passed, false);
    assert.match(verdict.reason!, /positions fell from 20 to 1/);
  });

  it('may thin out without collapsing, because a quiet week is not a bug', () => {
    const verdict = checkCompile(
      facts({
        positions: Array.from({ length: 10 }, (_, index) => ({ slug: `p${index}`, citations: 1 })),
        previous_positions: 20,
      }),
    );

    assert.equal(POSITION_COLLAPSE_FLOOR, 0.5);
    assert.equal(verdict.passed, true);
  });

  it('may not be swept off current in one rebuild by a judge having a bad afternoon', () => {
    const verdict = checkCompile(
      facts({
        positions: Array.from({ length: 10 }, (_, index) => ({ slug: `p${index}`, citations: 1 })),
        superseded_positions: 8,
      }),
    );

    // Found live: every row was well-formed — dated, cited, ordered — and the persona was
    // quietly two thirds retired. Nothing else here would have noticed.
    assert.equal(verdict.passed, false);
    assert.match(verdict.reason!, /8 of 10 position\(s\) were superseded on one rebuild/);
  });

  it('lets a person change their mind about some of it, because that is the product', () => {
    const verdict = checkCompile(
      facts({
        positions: Array.from({ length: 10 }, (_, index) => ({ slug: `p${index}`, citations: 1 })),
        superseded_positions: 5,
      }),
    );

    assert.equal(REVISION_SWEEP_CEILING, 0.5);
    assert.equal(verdict.passed, true);
  });

  it('passes a compile with no positions at all, which is where v1 starts', () => {
    // Positions are #34's. The checks are written against the real tables so they hold
    // the day positions exist, rather than being added once there is something to miss.
    assert.equal(checkCompile(facts()).passed, true);
  });
});

/**
 * **A model recites the top of the block it was handed, verbatim** — measured across six
 * payload variants and ~130 replies. So the first line is the one place braintrust can be
 * certain a reader will hear something, and what they are owed there is what they are
 * talking to. When that line was an instruction, an instruction is what got read out.
 */
describe('the first line a reader hears', () => {
  it('must be the disclosure, word for word', () => {
    const verdict = checkCompile(
      facts({ speak: 'You are a braintrust model of Nate B. Jones. You are not that person.' }),
    );

    assert.equal(verdict.passed, false);
    assert.match(verdict.reason!, /speak_opens_with_disclosure: /);
    assert.match(verdict.reason!, /the first thing a reader hears is not what they are talking to/);
  });

  /**
   * Compared rather than pattern-matched, which is the whole reason the sentence is fixed:
   * a regex is exactly how a disclosure drifts into something that still matches and no
   * longer discloses.
   */
  it('is not satisfied by something close to it', () => {
    for (const near of [
      'A braintrust persona is a compiled model of what a person has published.',
      `  ${SPOKEN_DISCLOSURE}`,
      `${SPOKEN_DISCLOSURE.replace(', not the person.', '.')}`,
    ]) {
      assert.equal(
        check(checkCompile(facts({ speak: near })), 'speak_opens_with_disclosure').passed,
        false,
        `"${near}" should not pass for the disclosure`,
      );
    }
  });

  it('is not satisfied by one further down the script', () => {
    const buried = `You are a braintrust model of Nate B. Jones.\n\n${SPOKEN_DISCLOSURE}`;

    assert.equal(check(checkCompile(facts({ speak: buried })), 'speak_opens_with_disclosure').passed, false);
  });
});

describe('the reason a rejection carries', () => {
  it('collects every failure, because a compiler is rarely wrong in one way', () => {
    const verdict = checkCompile(
      facts({
        layers: facts().layers.filter((one) => one.layer !== 'beliefs'),
        coverage_evidence: { ...ITEMS, failed: 7 },
      }),
    );

    assert.match(verdict.reason!, /beliefs missing/);
    assert.match(verdict.reason!, /failed is 7/);
  });

  /**
   * A reason that describes the fault without naming the rule leaves whoever reads it
   * grepping prose for the check they need to understand. The id is the way back to the
   * guarantee that was being protected.
   */
  it('names which check failed, not only what went wrong', () => {
    const verdict = checkCompile(
      facts({
        layers: facts().layers.filter((one) => one.layer !== 'beliefs'),
        coverage_evidence: { ...ITEMS, failed: 7 },
      }),
    );

    assert.match(verdict.reason!, /core_layers_present: /);
    assert.match(verdict.reason!, /coverage_reconciles: /);

    // Every named check is one the gate actually runs, so the name leads somewhere.
    for (const id of verdict.reason!.matchAll(/(\w+): /g)) {
      assert.ok(gateCheckIds().includes(id[1]!), `${id[1]} should be a check the gate runs`);
    }
  });

  it('names only the checks that failed', () => {
    const verdict = checkCompile(facts({ coverage_evidence: { ...ITEMS, failed: 7 } }));

    assert.match(verdict.reason!, /coverage_reconciles: /);
    assert.doesNotMatch(verdict.reason!, /positions_are_cited/);
  });
});

/**
 * The gate is a list, not a function with a clause per rule. Five more checks are coming
 * and none of them should have to restructure it first.
 */
describe('the gate as an enumerable list of checks', () => {
  it('can list every check by name without running any of them', () => {
    assert.deepEqual(gateCheckIds(), [
      'core_layers_present',
      'voice_has_both_forms',
      'inferred_layers_marked',
      'coverage_reconciles',
      'positions_are_cited',
      'positions_have_not_collapsed',
      'speak_opens_with_disclosure',
      'revisions_have_not_swept',
    ]);
  });

  it('says what each check guarantees, readable without a compile to run it against', () => {
    for (const definition of GATE_CHECKS) {
      assert.ok(definition.guarantees.trim().length > 20, `${definition.id} should say what it protects`);
    }
  });

  it('runs exactly the checks on the list, in the order they are on it', () => {
    assert.deepEqual(
      checkCompile(facts()).checks.map((one) => one.check),
      gateCheckIds(),
    );
  });

  /**
   * The point of the prefactor: a new check is an entry in the list. If `checkCompile`
   * ever grows a branch per check again, this stops being true and the next five tickets
   * pay for it.
   */
  it('takes a new check by appending to the list, with no edit to the gate control flow', () => {
    const added = {
      id: 'a_check_added_later',
      guarantees: 'nothing at all, and it is here to prove adding one changes no control flow',
      run: () => ({ passed: false, detail: 'refused on principle' }),
    };

    GATE_CHECKS.push(added);
    try {
      const verdict = checkCompile(facts());

      assert.equal(verdict.passed, false);
      assert.match(verdict.reason!, /a_check_added_later: refused on principle/);
      assert.equal(check(verdict, 'a_check_added_later').passed, false);
    } finally {
      GATE_CHECKS.pop();
    }

    // …and removing it puts the gate back exactly as it was.
    assert.equal(checkCompile(facts()).passed, true);
  });
});

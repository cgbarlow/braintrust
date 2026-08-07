/**
 * The publish gate: what a Compile has to be before it is allowed to replace the Persona
 * that is currently answering.
 *
 * A rebuild deletes its predecessor and there is deliberately no archive to fall back to.
 * This is what closes that hole without reintroducing history — a Compile is built under
 * `running`, checked here, and only then promoted. Fail, and it is recorded as `rejected`
 * with its reason while yesterday's Persona stays live and untouched.
 *
 * **Every check is structural, never semantic.** Not because semantic checks would be
 * useless, but because a check that needs a model to run can fail the same way the
 * compiler fails — an endpoint having a bad afternoon would reject a good Compile and
 * pass a bad one, and the gate would be one more thing that needs a gate. Everything
 * here is a count, a presence, or a regex.
 *
 * This is what `lint` becomes in a regenerate model: a quality gate on compiler output
 * rather than a drift sweep. Failing means *not published*.
 *
 * See docs/design/compiler.md §5.
 */

import { SPOKEN_DISCLOSURE } from '../disclosure.js';
import { INFERRED_MARKER } from './infer.js';

export const CORE_LAYERS = ['beliefs', 'coverage', 'reasoning', 'voice'] as const;

/**
 * How far the Position count may fall against the previous Compile before it reads as a
 * collapse rather than a quiet week. Half is a starting point to tune, not a finding.
 *
 * The check exists because the failure it catches is silent: a Note generation that
 * half-parsed, or an endpoint returning shorter answers, produces a Persona that is
 * *thinner* rather than wrong, and nothing else in this list would notice.
 */
export const POSITION_COLLAPSE_FLOOR = 0.5;

/**
 * How much of a Persona one rebuild may take off `current` before it reads as a judge
 * having a bad afternoon rather than a person changing their mind.
 *
 * Found live: a judge that answers `revised` freely superseded 16 of 23 positions in a
 * single compile, and every other check passed — the rows were well-formed, every
 * relation was dated and cited, and the Persona was quietly two thirds retired. Real
 * supersession is rare: fourteen months of near-daily output yielded one clean one. So a
 * compile that retires half of what someone holds is describing the model, not the author,
 * and yesterday's Persona is the better answer.
 */
export const REVISION_SWEEP_CEILING = 0.5;

export type GateLayer = {
  layer: string;
  basis: string;
  descriptive_md: string;
  generative_md: string | null;
  /** As stored. What "non-empty" means for an inferred layer is a question of this. */
  evidence: unknown;
};

/** What the ingest rows say, recounted at gate time rather than taken from the layer. */
export type ItemCounts = {
  retrieved: number;
  skipped_paywall: number;
  skipped_short: number;
  skipped_window: number;
  skipped_not_a_post: number;
  failed: number;
  pending: number;
};

export type GateFacts = {
  layers: GateLayer[];
  /** The Coverage layer's stored `evidence`, as it will be served. */
  coverage_evidence: unknown;
  items: ItemCounts;
  positions: { slug: string; citations: number }[];
  /** Positions on the Compile this one would replace. Zero when there is no predecessor. */
  previous_positions: number;
  /** Positions this Compile put on the earlier side of a `revised` relation. */
  superseded_positions: number;
  /**
   * The Script this Compile would serve, rendered through the same path a reader gets.
   *
   * **Rendered rather than stored, and rendered here rather than looked up.** A gate
   * checking a lookalike would be checking something nobody serves — the one failure that
   * would let the disclosure go missing while every check passed.
   */
  speak: string;
};

/** What one check decided about one Compile, and why. */
export type GateCheckResult = { passed: boolean; detail: string };

/**
 * One publication-blocking check, as a thing rather than as a branch.
 *
 * **The gate is a list, not a function with a clause per rule.** Checks are added by appending to
 * {@link GATE_CHECKS}; nothing about the control flow that runs them changes, and nothing
 * has to be edited twice. That matters because the checks outnumber their author's memory:
 * a maintainer looking at a `rejected_reason` needs to find the check that produced it and
 * read what it was protecting, without reading the whole gate to work out which branch ran.
 */
export type GateCheckDefinition = {
  /** Stable, and the name a rejection records. Never renamed once a Compile has carried it. */
  id: string;
  /**
   * What passing guarantees, in one sentence — readable **without running the check**, which
   * is the whole point of the checks being enumerable.
   */
  guarantees: string;
  run(facts: GateFacts): GateCheckResult;
};

export type GateCheck = GateCheckResult & { check: string };

export type GateVerdict = {
  passed: boolean;
  checks: GateCheck[];
  /** Null when it passed. Otherwise what goes in `rejected_reason`. */
  reason: string | null;
};

export function checkCompile(facts: GateFacts): GateVerdict {
  const checks = GATE_CHECKS.map((definition) => ({
    check: definition.id,
    ...definition.run(facts),
  }));

  const failed = checks.filter((check) => !check.passed);

  return {
    passed: failed.length === 0,
    checks,
    // **Named, not just described.** A reason that says what went wrong without saying
    // which check said it leaves a maintainer grepping prose for the rule they need to
    // read. The id is the way back to the guarantee it was protecting.
    reason:
      failed.length === 0
        ? null
        : failed.map((check) => `${check.check}: ${check.detail}`).join('; '),
  };
}

/**
 * Every publication-blocking check there is, in the order they run.
 *
 * **This list is the gate.** Adding a rule means adding an entry here and nothing else —
 * `checkCompile` has no branch per check to extend, and no caller has to be told. Removing
 * one means deleting an entry. Reading the gate means reading this list.
 *
 * Order is presentation only: every check runs on every Compile, and a rejection carries
 * all the reasons rather than the first.
 */
export const GATE_CHECKS: GateCheckDefinition[] = [
  {
    id: 'core_layers_present',
    guarantees:
      'all four core layers exist on this compile and each carries something a client could serve',
    run: coreLayersPresent,
  },
  {
    id: 'voice_has_both_forms',
    guarantees:
      'voice carries an instruction and the measurements behind it, so the instruction can be checked against its evidence',
    run: voiceHasBothForms,
  },
  {
    id: 'inferred_layers_marked',
    guarantees:
      'every layer a model wrote opens with the marker that survives being pasted into a system prompt',
    run: inferredLayersMarked,
  },
  {
    id: 'coverage_reconciles',
    guarantees:
      "coverage's counts match the item rows they claim to count, so a persona naming its own blind spots is telling the truth",
    run: coverageReconciles,
  },
  {
    id: 'positions_are_cited',
    guarantees: 'every position resolves to at least one citation braintrust can show',
    run: positionsAreCited,
  },
  {
    id: 'positions_have_not_collapsed',
    guarantees:
      'the position count has not fallen far enough against the previous compile to read as a silent failure rather than a quiet week',
    run: positionsHaveNotCollapsed,
  },
  {
    id: 'speak_opens_with_disclosure',
    guarantees:
      'the first line a reader hears is the disclosure, word for word, and is not an instruction addressed to the model',
    run: speakOpensWithDisclosure,
  },
  {
    id: 'revisions_have_not_swept',
    guarantees:
      'this rebuild has not retired so much of what someone holds that it describes the judge rather than the author',
    run: revisionsHaveNotSwept,
  },
];

/** Every check that runs, by name, without running any of them. */
export function gateCheckIds(): string[] {
  return GATE_CHECKS.map((check) => check.id);
}

/**
 * All four, and none of them empty. Emptiness is the check that earns its place: the
 * likeliest way for this gate to fire in practice is a synthesis that came back with
 * nothing usable, and the layer that produces is not blank — it is a marker, a sentence
 * saying so, and no entries. So an inferred layer is empty when it lists nothing,
 * whatever prose surrounds the fact.
 */
function coreLayersPresent(facts: GateFacts): GateCheckResult {
  const missing: string[] = [];
  const empty: string[] = [];

  for (const layer of CORE_LAYERS) {
    const row = facts.layers.find((one) => one.layer === layer);
    if (!row) {
      missing.push(layer);
      continue;
    }
    if (isEmpty(row)) empty.push(layer);
  }

  return {
    passed: missing.length === 0 && empty.length === 0,
    detail:
      missing.length === 0 && empty.length === 0
        ? `all ${CORE_LAYERS.length} core layers are present and carry something to serve`
        : [
            missing.length > 0 ? `${missing.join(', ')} missing` : '',
            empty.length > 0 ? `${empty.join(', ')} carried nothing to serve` : '',
          ]
            .filter(Boolean)
            .join('; '),
  };
}

function isEmpty(row: GateLayer): boolean {
  if (bodyOf(row).trim() === '') return true;
  if (row.basis !== 'inferred') return false;

  const entries = (row.evidence as { entries?: unknown } | null | undefined)?.entries;
  return !Array.isArray(entries) || entries.length === 0;
}

/**
 * Both forms, because either alone is worse than useless: only `generative` leaves the
 * instruction unfalsifiable, and only `descriptive` means two clients build two different
 * personalities from identical data.
 */
function voiceHasBothForms(facts: GateFacts): GateCheckResult {
  const voice = facts.layers.find((one) => one.layer === 'voice');
  const passed =
    !!voice && voice.descriptive_md.trim() !== '' && (voice.generative_md ?? '').trim() !== '';

  return {
    passed,
    detail: passed
      ? 'voice carries an instruction and the measurements it came from'
      : 'voice is missing one of its two forms, so its instruction could not be checked against its evidence',
  };
}

/**
 * The marker rule, mechanically. `basis` is the structural fact — a layer a model wrote —
 * and this is where "then it must say so in its prose" is enforced rather than trusted.
 */
function inferredLayersMarked(facts: GateFacts): GateCheckResult {
  const unmarked = facts.layers
    .filter((one) => one.basis === 'inferred' && !INFERRED_MARKER.test(one.descriptive_md.trim()))
    .map((one) => one.layer);

  return {
    passed: unmarked.length === 0,
    detail:
      unmarked.length === 0
        ? 'every inferred layer opens with the marker a client would carry into a system prompt'
        : `${unmarked.join(', ')} is inferred and does not open with the inferred marker`,
  };
}

/**
 * Coverage against the rows it claims to count, recounted now. A Persona that names its
 * own blind spots is only worth anything if the naming is true, and this is the one layer
 * whose every number can be checked against something that is not itself.
 */
function coverageReconciles(facts: GateFacts): GateCheckResult {
  const evidence = facts.coverage_evidence as Partial<ItemCounts> | null | undefined;
  if (!evidence || typeof evidence !== 'object') {
    return {
      passed: false,
      detail: 'coverage carried no structured evidence to reconcile against the item rows',
    };
  }

  const off = (Object.keys(facts.items) as (keyof ItemCounts)[]).filter(
    (field) => evidence[field] !== facts.items[field],
  );

  return {
    passed: off.length === 0,
    detail:
      off.length === 0
        ? 'coverage counts match the item rows'
        : off
            .map((field) => `coverage says ${field} is ${evidence[field]}, the rows say ${facts.items[field]}`)
            .join('; '),
  };
}

/** A Position braintrust cannot cite is a Position it does not have. */
function positionsAreCited(facts: GateFacts): GateCheckResult {
  const uncited = facts.positions.filter((position) => position.citations === 0);

  return {
    passed: uncited.length === 0,
    detail:
      uncited.length === 0
        ? `all ${facts.positions.length} position(s) resolve to at least one citation`
        : `${uncited.length} position(s) resolve to no citation: ${uncited
            .map((one) => one.slug)
            .slice(0, 5)
            .join(', ')}`,
  };
}

function positionsHaveNotCollapsed(facts: GateFacts): GateCheckResult {
  const now = facts.positions.length;
  const before = facts.previous_positions;
  const floor = Math.floor(before * POSITION_COLLAPSE_FLOOR);
  const passed = before === 0 || now >= floor;

  return {
    passed,
    detail: passed
      ? `${now} position(s) against ${before} on the previous compile`
      : `positions fell from ${before} to ${now}, below the ${floor} this compile had to hold`,
  };
}

/**
 * The one check about revisions, and it is a count rather than a reading of them: a
 * Persona where most of what someone holds has been retired in one rebuild is the failure
 * that looks like working software, because every individual row is well-formed.
 */
function revisionsHaveNotSwept(facts: GateFacts): GateCheckResult {
  const now = facts.positions.length;
  const superseded = facts.superseded_positions;
  const ceiling = Math.floor(now * REVISION_SWEEP_CEILING);
  const passed = now === 0 || superseded <= ceiling;

  return {
    passed,
    detail: passed
      ? `${superseded} of ${now} position(s) were superseded on this rebuild`
      : `${superseded} of ${now} position(s) were superseded on one rebuild, past the ${ceiling} ` +
        'this compile had to stay under — that is a judge changing its mind, not a person',
  };
}

/**
 * The first line, exactly.
 *
 * **A model recites the top of the block it was handed, verbatim, whatever is there** —
 * measured across six payload variants and ~130 replies. So the first line is the one place
 * braintrust can be certain a reader will hear something, and what they are owed there is
 * what they are talking to. When that line was an instruction, an instruction is what got
 * read out.
 *
 * Compared rather than pattern-matched, which is the whole reason the sentence is fixed: a
 * line that varied per Persona could only be checked by a regex, and a regex is exactly how
 * a disclosure drifts into something that still matches and no longer discloses.
 */
function speakOpensWithDisclosure(facts: GateFacts): GateCheckResult {
  const first = facts.speak.split('\n')[0] ?? '';
  const passed = first === SPOKEN_DISCLOSURE;

  return {
    passed,
    detail: passed
      ? 'the script opens with the disclosure, word for word'
      : `the script opens with "${first.slice(0, 80)}…" rather than the disclosure, so the ` +
        'first thing a reader hears is not what they are talking to',
  };
}

/** The prose a reader would get past the marker line. */
function bodyOf(layer: GateLayer): string {
  return layer.basis === 'inferred'
    ? layer.descriptive_md.trim().replace(INFERRED_MARKER, '')
    : layer.descriptive_md;
}

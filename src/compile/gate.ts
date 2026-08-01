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
};

export type GateCheck = { check: string; passed: boolean; detail: string };

export type GateVerdict = {
  passed: boolean;
  checks: GateCheck[];
  /** Null when it passed. Otherwise what goes in `rejected_reason`. */
  reason: string | null;
};

export function checkCompile(facts: GateFacts): GateVerdict {
  const checks = [
    coreLayersPresent(facts),
    voiceHasBothForms(facts),
    inferredLayersMarked(facts),
    coverageReconciles(facts),
    positionsAreCited(facts),
    positionsHaveNotCollapsed(facts),
    revisionsHaveNotSwept(facts),
  ];

  const failed = checks.filter((check) => !check.passed);
  return {
    passed: failed.length === 0,
    checks,
    reason: failed.length === 0 ? null : failed.map((check) => check.detail).join(' '),
  };
}

/**
 * All four, and none of them empty. Emptiness is the check that earns its place: the
 * likeliest way for this gate to fire in practice is a synthesis that came back with
 * nothing usable, and the layer that produces is not blank — it is a marker, a sentence
 * saying so, and no entries. So an inferred layer is empty when it lists nothing,
 * whatever prose surrounds the fact.
 */
function coreLayersPresent(facts: GateFacts): GateCheck {
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
    check: 'core_layers_present',
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
function voiceHasBothForms(facts: GateFacts): GateCheck {
  const voice = facts.layers.find((one) => one.layer === 'voice');
  const passed =
    !!voice && voice.descriptive_md.trim() !== '' && (voice.generative_md ?? '').trim() !== '';

  return {
    check: 'voice_has_both_forms',
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
function inferredLayersMarked(facts: GateFacts): GateCheck {
  const unmarked = facts.layers
    .filter((one) => one.basis === 'inferred' && !INFERRED_MARKER.test(one.descriptive_md.trim()))
    .map((one) => one.layer);

  return {
    check: 'inferred_layers_marked',
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
function coverageReconciles(facts: GateFacts): GateCheck {
  const evidence = facts.coverage_evidence as Partial<ItemCounts> | null | undefined;
  if (!evidence || typeof evidence !== 'object') {
    return {
      check: 'coverage_reconciles',
      passed: false,
      detail: 'coverage carried no structured evidence to reconcile against the item rows',
    };
  }

  const off = (Object.keys(facts.items) as (keyof ItemCounts)[]).filter(
    (field) => evidence[field] !== facts.items[field],
  );

  return {
    check: 'coverage_reconciles',
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
function positionsAreCited(facts: GateFacts): GateCheck {
  const uncited = facts.positions.filter((position) => position.citations === 0);

  return {
    check: 'positions_are_cited',
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

function positionsHaveNotCollapsed(facts: GateFacts): GateCheck {
  const now = facts.positions.length;
  const before = facts.previous_positions;
  const floor = Math.floor(before * POSITION_COLLAPSE_FLOOR);
  const passed = before === 0 || now >= floor;

  return {
    check: 'positions_have_not_collapsed',
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
function revisionsHaveNotSwept(facts: GateFacts): GateCheck {
  const now = facts.positions.length;
  const superseded = facts.superseded_positions;
  const ceiling = Math.floor(now * REVISION_SWEEP_CEILING);
  const passed = now === 0 || superseded <= ceiling;

  return {
    check: 'revisions_have_not_swept',
    passed,
    detail: passed
      ? `${superseded} of ${now} position(s) were superseded on this rebuild`
      : `${superseded} of ${now} position(s) were superseded on one rebuild, past the ${ceiling} ` +
        'this compile had to stay under — that is a judge changing its mind, not a person',
  };
}

/** The prose a reader would get past the marker line. */
function bodyOf(layer: GateLayer): string {
  return layer.basis === 'inferred'
    ? layer.descriptive_md.trim().replace(INFERRED_MARKER, '')
    : layer.descriptive_md;
}

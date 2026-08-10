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
import { speakableProseIn } from '../find.js';
import { isOnTheMenu, twinEvidence } from './habits.js';
import { INFERRED_MARKER } from './infer.js';
import { SERVED_LAYERS } from './version.js';

/**
 * The layers a Compile must have — the same list as the layers braintrust serves, so a
 * layer cannot be half-retired: removed from one and left in the other.
 *
 * **Beliefs left this list rather than being exempted from it**, and the difference matters:
 * the rule that rejected a Compile whose beliefs layer carried nothing is gone because
 * there is no such layer, not because emptiness became acceptable in one place.
 *
 * Through-lines are still not on it, and are no longer unguarded either. A presence rule
 * here would refuse to publish a Persona whose subject genuinely has nothing durable to say;
 * what {@link noLayerEmptiedBySelection} refuses instead is the case that is actually a
 * defect — braintrust finding candidates and its own rules leaving none of them.
 */
export const CORE_LAYERS = SERVED_LAYERS;

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

/**
 * What one selecting layer found, and what braintrust's own rules left of it.
 *
 * **The only fact in the gate the rows cannot answer.** Every other check recounts the
 * Compile from what was stored; this one is about the difference between what a Compile
 * found and what it kept, and nothing is stored for what it did not keep. So the compiler
 * hands it over — one entry per layer that selects, counted where the selection happens.
 */
export type LayerSelection = {
  /** The layer, named as a Persona names it. What a rejection reports. */
  layer: string;
  /** Candidates found, before any rule of braintrust's ran over them. */
  candidates: number;
  /** What survived them, as it will be served. */
  published: number;
};

export type GateFacts = {
  layers: GateLayer[];
  /** The Coverage layer's stored `evidence`, as it will be served. */
  coverage_evidence: unknown;
  items: ItemCounts;
  /**
   * `graded_on` fingerprints what `fit` would grade this Position on — its own statement's
   * vector — or null where the statement was never embedded. Two Positions sharing one is
   * two Positions that must share a score.
   */
  positions: { slug: string; citations: number; graded_on: string | null }[];
  /**
   * What each selecting layer found and what it published. Empty is a legal value — a caller
   * with nothing to declare declares nothing, and this check passes.
   */
  selection: LayerSelection[];
  /** Positions on the Compile this one would replace. Zero when there is no predecessor. */
  previous_positions: number;
  /** Positions this Compile put on the earlier side of a `revised` relation. */
  superseded_positions: number;
  /**
   * The empty answer this Persona would serve, built by the same function the read path
   * calls, with this Compile's own floor in it.
   *
   * Rendered rather than described, for the reason `speak` is: what is worth checking is the
   * object a client receives, not a second one written to be checked.
   */
  nothing_matched: Record<string, unknown>;
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
      'every core layer exists on this compile and each carries something a client could serve',
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
    id: 'positions_are_graded_apart',
    guarantees:
      'no two positions in one answer can carry the same fit score, because no two are graded on the same thing',
    run: positionsAreGradedApart,
  },
  {
    id: 'positions_have_not_collapsed',
    guarantees:
      'the position count has not fallen far enough against the previous compile to read as a silent failure rather than a quiet week',
    run: positionsHaveNotCollapsed,
  },
  {
    id: 'habits_are_on_the_menu',
    guarantees:
      "every line describing how someone argues is text braintrust authored, so a conclusion cannot reach a persona's script",
    run: habitsAreOnTheMenu,
  },
  {
    id: 'habits_rest_on_distinct_evidence',
    guarantees:
      'no two lines in the argument-habits block rest on the identical set of items, so four lines mean four things were found',
    run: habitsRestOnDistinctEvidence,
  },
  {
    id: 'speak_opens_with_disclosure',
    guarantees:
      'the first line a reader hears is the disclosure, word for word, and is not an instruction addressed to the model',
    run: speakOpensWithDisclosure,
  },
  {
    id: 'nothing_matched_carries_no_prose',
    guarantees:
      'an empty answer hands over the facts and no sentence, so the persona says it in their own register rather than reciting braintrust',
    run: nothingMatchedCarriesNoProse,
  },
  {
    id: 'no_layer_emptied_by_selection',
    guarantees:
      "no layer braintrust found candidates for was left empty by braintrust's own rules, so a silence in a persona is something the person did not say rather than something a rule ate",
    run: noLayerEmptiedBySelection,
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
 * All of them, and none of them empty. Emptiness is the check that earns its place: the
 * likeliest way for this gate to fire in practice is a synthesis that came back with
 * nothing usable, and the layer that produces is not blank — it is a marker, a sentence
 * saying so, and no entries. So an inferred layer is empty when it lists nothing,
 * whatever prose surrounds the fact.
 *
 * **It applies to Reasoning and to nothing else now.** A Persona that cannot say how
 * someone argues is missing a layer it is supposed to have; a Persona holding no
 * through-lines is holding a normal amount of nothing. See {@link CORE_LAYERS}.
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
 * The marker rule, mechanically. `basis` is the structural fact — a layer a model had a
 * hand in — and this is where "then it must say so in its prose" is enforced rather than
 * trusted.
 *
 * **Reviewed when Beliefs stopped being a layer, and kept.** The marker was written for a
 * client pasting a layer's markdown straight into a system prompt, where a `basis` field is
 * lost and a first line survives. The obvious reading after the fold is that nothing ships
 * whole any more — the Script selects menu instructions rather than carrying Reasoning's
 * prose — and on that reading this check guards nothing. It is wrong:
 * `braintrust_explain_persona` returns every layer **whole and verbatim**, which is the
 * pasting case exactly, and Reasoning is still `inferred` there. So the marker is still the
 * only thing that travels with the prose when the envelope is thrown away.
 *
 * What it no longer guards is a layer of conclusions, because there is not one. A reader
 * who pastes Reasoning is pasting braintrust's own authored sentences about how someone
 * argues, so the worst the marker now prevents is a delivery style read as a measurement —
 * a smaller harm than the one it was built for, and still a real one.
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

/**
 * **The check that catches the fourth one.**
 *
 * `fit` has shipped wrong three times, and all three were the same shape: a grade about the
 * question computed from a quantity every Position in the answer shared — the query's own
 * range, the Corpus's median, and the best Chunk of the best Item. All three were caught by a
 * person reading an answer that looked odd, and there is no person watching. So the general
 * rule is enforced structurally instead: **a grade about the question must be computed from
 * the thing it is grading**, and a shared subject is the signature of every version of the
 * defect.
 *
 * Measured live before the fix: 41 of 92 Positions carried a score identical to another's, in
 * 18 groups, 10 of which held Positions a reader grades differently — three `close` grades on
 * one Substack post for a question none of them answered. After the fix it is 0, and any
 * drift back to grading something shared puts it above 0 on the next Compile.
 *
 * Two Positions may still print the same rounded number by coincidence. What this forbids is
 * the *construction* — a graded subject two Positions hold in common — because that is the
 * defect, and a coincidence is not.
 *
 * **All or none, and none is a real answer.** A deployment with no embeddings endpoint
 * compiles a Persona that cannot be graded at all, and refusing to publish it would make a
 * grade a condition of having a Persona. Nothing shared is nothing to confuse: those answers
 * come back ungraded. What may not ship is the middle — some Positions graded and others not
 * — because a client reads the absence as braintrust having formed a view.
 */
function positionsAreGradedApart(facts: GateFacts): GateCheckResult {
  const graded = facts.positions.filter((position) => position.graded_on !== null);

  if (graded.length === 0) {
    return {
      passed: true,
      detail:
        `no statement of the ${facts.positions.length} position(s) was embedded, so nothing ` +
        'is graded and no two grades can agree',
    };
  }

  if (graded.length < facts.positions.length) {
    const ungraded = facts.positions.filter((position) => position.graded_on === null);
    return {
      passed: false,
      detail:
        `${ungraded.length} of ${facts.positions.length} position(s) have no statement ` +
        `vector to grade on: ${ungraded.map((one) => one.slug).slice(0, 5).join(', ')} — an ` +
        'answer mixing graded and ungraded positions reads as a judgement about the ungraded ones',
    };
  }

  const byFingerprint = new Map<string, string[]>();
  for (const position of graded) {
    byFingerprint.set(position.graded_on!, [
      ...(byFingerprint.get(position.graded_on!) ?? []),
      position.slug,
    ]);
  }

  const shared = [...byFingerprint.values()].filter((slugs) => slugs.length > 1);

  return {
    passed: shared.length === 0,
    detail:
      shared.length === 0
        ? `all ${graded.length} position(s) are graded on their own statement`
        : `${shared.length} group(s) of positions are graded on the same thing and must ` +
          `therefore score the same: ${shared.map((slugs) => slugs.join(' / ')).slice(0, 3).join('; ')}`,
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
 * **No Compile may publish a layer its own rules emptied.**
 *
 * Two silences look identical from the outside and are not the same fact. *There was nothing
 * to say* is allowed, and a Persona says it in prose. *A rule ate it* is a defect, and it has
 * shipped twice — the survives-two-readings bar left three of five Personas holding no
 * through-lines on the first fleet rebuild, and the three-item style floor halved the habits
 * block between rebuilds for reasons that had nothing to do with the person. Both were
 * legible only to someone reading the compiler; from the outside each looked like a person
 * with nothing to say.
 *
 * So the difference is made structural: a layer that found candidates and published none is
 * rejected, whatever rule did the emptying and whatever number was in force. It is
 * retrospective by construction — it does not know about readings, floors or menus, only
 * about found-and-kept — which is what makes it survive the next rule somebody adds.
 *
 * No model call, no audience, no previous Compile needed. And a rejection is cheap: the
 * previous Persona keeps answering and tomorrow's run tries again.
 */
function noLayerEmptiedBySelection(facts: GateFacts): GateCheckResult {
  const emptied = facts.selection.filter(
    (one) => one.candidates > 0 && one.published === 0,
  );

  const declared = facts.selection.length;

  return {
    passed: emptied.length === 0,
    detail:
      emptied.length === 0
        ? `${declared} selecting layer(s) kept something of what they found, or found nothing to keep`
        : emptied
            .map(
              (one) =>
                `${one.layer} found ${one.candidates} candidate(s) and published none, so the ` +
                'silence a reader hears is a rule of braintrust\'s rather than the person',
            )
            .join('; '),
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

/** The habits this Compile chose, as the Reasoning layer records them. */
function chosenHabits(facts: GateFacts): { slug: string; items: string[] }[] {
  const reasoning = facts.layers.find((one) => one.layer === 'reasoning');
  const entries = (reasoning?.evidence as { entries?: unknown } | null | undefined)?.entries;
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry: unknown) => {
    const { label, items } = (entry ?? {}) as { label?: unknown; items?: unknown };
    if (typeof label !== 'string') return [];
    return [
      {
        slug: label,
        items: Array.isArray(items) ? items.filter((one): one is string => typeof one === 'string') : [],
      },
    ];
  });
}

/**
 * **The compile selects; it never writes.** Every line a reader gets about how someone
 * argues is text authored in ../compile/habits.ts, so a conclusion cannot reach a Script.
 *
 * Checked here as well as enforced in the selection, deliberately — the same doubling as
 * "a Position braintrust cannot cite is dropped". The rule matters more than the code path.
 */
function habitsAreOnTheMenu(facts: GateFacts): GateCheckResult {
  const off = chosenHabits(facts)
    .map((habit) => habit.slug)
    .filter((slug) => !isOnTheMenu(slug));

  return {
    passed: off.length === 0,
    detail:
      off.length === 0
        ? 'every argument habit is a line braintrust authored'
        : `${off.slice(0, 5).join(', ')} ${off.length === 1 ? 'is' : 'are'} not on the menu, so ` +
          'the persona would say something braintrust did not write',
  };
}

/**
 * Two lines resting on the identical set of Items are one thing found and worded twice.
 *
 * Measured on five real Corpora: 9 of 52 shipping lines carried evidence identical to
 * another line, and one Person had four lines all resting on the same three Items. **A
 * reader shown four lines believes four things were found.** The selection resolves this by
 * a tie-break that is a function of the reply and nothing else, and this is the check that
 * the resolution actually happened.
 */
function habitsRestOnDistinctEvidence(facts: GateFacts): GateCheckResult {
  const twins = twinEvidence(chosenHabits(facts));

  return {
    passed: twins.length === 0,
    detail:
      twins.length === 0
        ? 'every argument habit rests on its own evidence'
        : `${twins.length} group(s) of habits rest on identical evidence, so the block would ` +
          'read as more findings than braintrust made',
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

/**
 * **An empty answer is facts. The sentence belongs to the Persona.**
 *
 * `nothing_matched.say` shipped for two releases reading *"This is outside what braintrust has
 * read of this person."* — third person, about braintrust, calling the person *this person* —
 * directly against its own field comment, which promised *what a Persona can put into its own
 * words, never braintrust's prose about braintrust*. Measured across ~80 replies: **no Persona
 * ever said it.** Every arm rewrote it into its own first person, and braintrust's exact words
 * appeared only where a Script section told the Persona to use them.
 *
 * The rule it broke is the standing one — a Persona never falls back to a generic voice — and
 * the cost of breaking it is that the exception list grows. The fixed disclosure is the only
 * sentence braintrust speaks in its own voice, and it stays the only one.
 *
 * A check rather than a convention **because this field has already drifted once**, and the
 * drift is invisible: a rendered sentence in a payload looks like helpfulness right up until a
 * reader hears a persona narrate itself in the third person.
 */
function nothingMatchedCarriesNoProse(facts: GateFacts): GateCheckResult {
  const offending = speakableProseIn(facts.nothing_matched);

  return {
    passed: offending.length === 0,
    detail:
      offending.length === 0
        ? 'an empty answer carries how close it came, why, and what is nearby — and no sentence'
        : `${offending.join(', ')} put words in an empty answer for a persona to recite, and a ` +
          'persona reciting braintrust is the generic voice this whole surface exists to avoid',
  };
}

/** The prose a reader would get past the marker line. */
function bodyOf(layer: GateLayer): string {
  return layer.basis === 'inferred'
    ? layer.descriptive_md.trim().replace(INFERRED_MARKER, '')
    : layer.descriptive_md;
}

/**
 * Coverage, reported: the fraction of a Persona's retrieved items its current Compile
 * formed Positions on, and the fault that tells the maintainer when that fraction falls
 * too low.
 *
 * This is the other half of the compile's Coverage layer. The layer says *how much*
 * braintrust read, measured per Person at Compile time. This says *how much of what it
 * read it formed a Position on* — the number that caps everything downstream, because no
 * retrieval or ranking work can ever reach an item nothing was compiled about. All of it
 * is one query over rows that already exist, against the **current** Compile only, and
 * none of it is a model call.
 *
 * **It is a report, not a gate.** The fault it opens withdraws no layer and never stops a
 * Persona answering, and it is not a coverage target: chasing coverage manufactures
 * Positions the person does not hold, which is the one failure the product cannot afford.
 * Today the reader is the one who discovers that half of a corpus was never formed a
 * position on; this check exists so the maintainer finds out first.
 *
 * See docs/design/map-300-spec.md §6 and https://github.com/cgbarlow/braintrust/issues/315.
 */

import type { Db } from '../db.js';
import { clearFault, openFault } from '../interrogate/store.js';

/** The fault a below-floor covered fraction opens. A name the registry knows — see assertions.ts. */
export const COVERAGE_ASSERTION = 'corpus_coverage';

/**
 * The floor below which a Persona's covered fraction opens a fault.
 *
 * Chosen at half, because of what the fraction means once it passes it: below half, a
 * reader asking about a randomly chosen retrieved item is more likely than not handed an
 * answer built on a *different* item — no retrieval or ranking work can reach an item
 * nothing was compiled about, so coverage is the dominant explanation for a lost
 * question. nate-b-jones sits at 45% today, which is the point: the check fires when
 * the number is the story, not when it has become embarrassing.
 *
 * It is a floor for **reporting**, never a target. Raising it does not make braintrust
 * form more Positions; it would make the maintainer chase coverage and manufacture
 * Positions the person does not hold.
 */
export const COVERAGE_FLOOR = 0.5;

/** One Person's covered fraction, measured against their current Compile only. */
export type CoverageMeasure = {
  /** The Person's slug. Also the fault key. */
  person: string;
  /** Retrieved Items of the Person's Corpus. */
  retrieved: number;
  /** Retrieved Items any Position of the current Compile cites. */
  covered: number;
  /**
   * `covered / retrieved`. Null when nothing was retrieved — an empty Corpus has no
   * fraction to be under, so nothing is reported.
   */
  covered_fraction: number | null;
};

/** A measured Person, with the verdict the floor produces about them. */
export type CoverageCheck = CoverageMeasure & { failing: boolean };

/**
 * Every serving Persona's covered fraction, measured against the current Compile only.
 *
 * The denominator is what braintrust retrieved; the numerator is the subset any Position
 * of the Person's current Compile cites. A Position that cites an Item makes it reachable —
 * retrieval can return it, and a reader can be answered about it — and nothing else does.
 *
 * Paused People are excluded for the same reason they are excluded from the serving
 * fleet: a Persona nobody is serving is not a Persona braintrust is making claims about.
 * A Person with no current Compile has no Positions at all, so there is nothing to
 * measure against and nothing is reported.
 */
export async function measureCoveredFraction(db: Db): Promise<CoverageMeasure[]> {
  const { rows } = await db.query<{ person: string; retrieved: number; covered: number }>(
    `select p.slug as person,
            count(distinct i.id)::int as retrieved,
            count(distinct pc.item_id)::int as covered
       from braintrust_people p
       join braintrust_compiles c on c.person_id = p.id and c.status = 'current'
       join braintrust_sources s on s.person_id = p.id
       join braintrust_items i on i.source_id = s.id and i.retrieval = 'retrieved'
       left join braintrust_positions pos on pos.compile_id = c.id
       left join braintrust_position_citations pc on pc.position_id = pos.id and pc.item_id = i.id
      where p.paused_at is null
      group by p.slug
      order by p.slug`,
  );

  return rows.map((row) => {
    const retrieved = Number(row.retrieved);
    const covered = Number(row.covered);
    return {
      person: row.person,
      retrieved,
      covered,
      covered_fraction: retrieved > 0 ? covered / retrieved : null,
    };
  });
}

/**
 * Opens or clears a coverage fault for every serving Persona, and returns what was
 * decided about each.
 *
 * Falls below {@link COVERAGE_FLOOR}, the fault opens — deduplicated by the registry, so
 * however many runs re-observe it only one issue is filed. At or above it, the fault
 * clears on the pass, the same rule every fault on the registry follows: a recompile
 * that raises the fraction clears its own issue with no rebuild and no model call.
 *
 * Nothing here stops a Persona answering and nothing is withdrawn — the fault is a
 * report to the maintainer and the whole of its escalation is the issue itself.
 */
export async function checkCoverage(
  db: Db,
  deps: { log?: (line: string) => void } = {},
): Promise<CoverageCheck[]> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const measured = await measureCoveredFraction(db);
  const checks: CoverageCheck[] = [];

  for (const one of measured) {
    // An empty Corpus has nothing to be covered, so it has nothing to report.
    if (one.covered_fraction === null) continue;

    const failing = one.covered_fraction < COVERAGE_FLOOR;
    if (failing) {
      await openFault(db, {
        assertion: COVERAGE_ASSERTION,
        person: one.person,
        detail: coverageDetail(one),
      });
    } else {
      await clearFault(db, COVERAGE_ASSERTION, one.person);
    }
    checks.push({ ...one, failing });
  }

  const under = checks.filter((one) => one.failing);
  if (under.length > 0) {
    log(
      `braintrust: coverage report — ${under
        .map((one) => `${one.person} (${percent(one.covered_fraction!)} of what it read is covered)`)
        .join(', ')}. A fault was opened so a maintainer reads it before a reader does; ` +
        `nothing stops anyone answering.`,
    );
  }

  return checks;
}

/**
 * The fault's detail, written so the reader never mistakes the report for a quality
 * judgment: this is a statement about what the Compile wrote Positions about, not about
 * how the Persona answers.
 */
function coverageDetail(one: CoverageMeasure): string {
  const fraction = percent(one.covered_fraction!);
  return [
    `${one.person}'s covered fraction is ${fraction} — the current Compile's Positions ` +
      `cite ${one.covered} of its ${one.retrieved} retrieved items.`,
    ``,
    `This reports what braintrust compiled Positions about, not how ${one.person} answers: ` +
      `nothing here stopped serving, nothing was withdrawn, and this is not a coverage ` +
      `target — chasing it would manufacture Positions the person does not hold. It exists ` +
      `because below half, a reader asking about a randomly chosen item of the corpus is ` +
      `more likely than not answered from a different item, and no retrieval or ranking ` +
      `work can reach an item nothing was compiled about. When a recompile cites ` +
      `${percent(COVERAGE_FLOOR)} or more of what it read, this fault clears itself.`,
  ].join('\n');
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

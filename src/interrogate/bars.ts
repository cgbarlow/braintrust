/**
 * The bars, on the fault rail: a persona below a bar opens a fault, a persona at or above
 * it clears one — the same ledger, the same deduplication, the same passing-check-wins
 * rule as every other fault braintrust files.
 *
 * **A bar never stops a persona answering.** Nothing here touches a Compile, a layer or a
 * version; the measurement is a count and the fault is a row, so a reader's first run is
 * identical whether the fleet is healthy or not. The fault *naming itself and the number*
 * is the whole of what a below-bar persona costs — the per-answer honesty is §5.2's
 * (§3's) job, already shipped.
 *
 * **A fault clears on a passing check, and never by an issue being closed.** The ledger's
 * rule, held here unchanged: `openFault` re-observes a live fault without duplicating it,
 * `clearFault` deletes the row the moment the same measurement passes, and nothing on the
 * issue tracker affects the ledger. Run from the scheduled job, so both directions happen
 * within a day of the measurement moving.
 *
 * **Neither bar spent a judge call.** The measurement is ../qa/measure.ts — embeddings and
 * SQL only — so this arm costs no model call beyond what the corpus's own reads already
 * make.
 */

import { barVerdicts, GROUNDED_BAR_FAULT, OFF_DOMAIN_FAULT, type BarVerdict } from '../qa/bars.js';
import { measureFleetBars, retrievalReady, type MeasureDeps } from '../qa/measure.js';
import type { PersonBars } from '../qa/bars.js';
import type { Db } from '../db.js';
import { clearFault, openFault, openFaults } from './store.js';

export type BarFaultDeps = {
  db: Db;
  measure: MeasureDeps;
  log?: (line: string) => void;
};

export type BarFaultOutcome = {
  bar: string;
  person: string;
  detail: string;
};

export type BarFaultReport = {
  measured: number;
  opened: BarFaultOutcome[];
  /** Faults that failed again while already open — the same row, re-observed, still live. */
  stillOpen: BarFaultOutcome[];
  cleared: BarFaultOutcome[];
};

/**
 * Measure every serving persona against both bars and reconcile the ledger.
 *
 * **Fail open.** If retrieval is unreadable, no measurement happens and nothing is decided —
 * neither direction. A bar fault is not opened on the strength of an endpoint being down,
 * and it is not cleared on the strength of a measurement that did not run.
 */
export async function runBarChecks(deps: BarFaultDeps): Promise<BarFaultReport | null> {
  const log = deps.log ?? ((line: string) => console.log(line));

  if (!(await retrievalReady(deps.measure.retrieval))) {
    log('braintrust: the bars could not be measured — retrieval is not ready, so no bar fault opens or clears.');
    return null;
  }

  const measurements = await measureFleetBars(deps.db, deps.measure);
  return reconcileBarFaults(deps.db, measurements, log);
}

/**
 * The ledger's half: a failing measurement opens a fault naming the persona and the number,
 * a passing one clears it, and a non-verdict changes nothing.
 *
 * **The row is the deduplication, the same rule every fault on this rail follows.** A fault
 * already open is re-observed, not duplicated; it clears on a pass and never on an issue
 * being closed. `openFault` refuses an unregistered name, so the two bars must be in
 * REGISTERED_FAULTS or this throws — the registry is the single place a fault's guarantee
 * and withdrawal list are decided.
 */
export async function reconcileBarFaults(
  db: Db,
  measurements: PersonBars[],
  log: (line: string) => void = (line) => console.log(line),
): Promise<BarFaultReport> {
  const report: BarFaultReport = { measured: measurements.length, opened: [], stillOpen: [], cleared: [] };

  // The live Faults are read once, so the diary can tell a fault *opened this run* from
  // one merely re-observed, and a fault *cleared this run* from a pass that had nothing
  // open to clear. The row itself is still the deduplication — `openFault` upserts and
  // `clearFault` deletes, no matter what the diary says.
  const open = new Set((await openFaults(db)).map((fault) => fault.key));

  for (const measurement of measurements) {
    for (const verdict of barVerdicts(measurement)) {
      const fault = faultFor(verdict);
      if (fault === null) continue;

      const key = `${fault}:${measurement.person}`;

      if (verdict.status === 'fail') {
        await openFault(db, {
          assertion: fault,
          person: measurement.person,
          detail: verdict.detail,
        });
        if (!open.has(key)) {
          report.opened.push({ bar: fault, person: measurement.person, detail: verdict.detail });
          log(`braintrust: opened ${fault} for ${measurement.person} — ${verdict.detail}`);
        } else {
          report.stillOpen.push({ bar: fault, person: measurement.person, detail: verdict.detail });
          log(`braintrust: ${fault} still open for ${measurement.person} — ${verdict.detail}`);
        }
      } else if (verdict.status === 'pass') {
        await clearFault(db, fault, measurement.person);
        if (open.has(key)) {
          report.cleared.push({ bar: fault, person: measurement.person, detail: verdict.detail });
          log(`braintrust: cleared ${fault} for ${measurement.person} — ${verdict.detail}`);
        }
      }
      // A not_measured bar is not a verdict: the ledger is left exactly as it was.
    }
  }

  return report;
}

function faultFor(verdict: BarVerdict): string | null {
  if (verdict.bar === 'grounded') return GROUNDED_BAR_FAULT;
  if (verdict.bar === 'off_domain') return OFF_DOMAIN_FAULT;
  return null;
}

/** One line for a job nobody watches, or none when nothing could be measured. */
export function summariseBarChecks(report: BarFaultReport | null): string | null {
  if (report === null) return null;

  const opened = report.opened.map((one) => `${one.bar} (${one.person})`).join(', ');
  const stillOpen = report.stillOpen.map((one) => `${one.bar} (${one.person})`).join(', ');
  const cleared = report.cleared.map((one) => `${one.bar} (${one.person})`).join(', ');

  if (report.measured === 0) {
    return 'braintrust: no serving personas to measure against the bars.';
  }

  // "All clear" is only true when there is nothing open, nothing newly failing and nothing
  // newly cleared. A fault re-observed while still open is a below-bar persona, and the
  // summary must not read as though the fleet were at or above.
  if (report.opened.length === 0 && report.stillOpen.length === 0 && report.cleared.length === 0) {
    return `braintrust: ${report.measured} persona(s) measured against the bars — every one at or above them, no fault opened or cleared.`;
  }

  return [
    `braintrust: bar checks on ${report.measured} persona(s).`,
    ...(opened ? [`  opened: ${opened}`] : []),
    ...(stillOpen ? [`  still open: ${stillOpen}`] : []),
    ...(cleared ? [`  cleared: ${cleared}`] : []),
  ].join('\n');
}

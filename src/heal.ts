/**
 * SOUL.md stays canonical for Hermes and heals itself: a daily job on the Hermes host
 * re-renders every `bt-*` profile from `hermes/SOUL.md.template` and reports the version
 * it landed on. This is the other half — the read that tells **current** from **stale**
 * from **silent**, and the fault that fires when a profile stays wrong.
 *
 * **Checked on the serving path, not a second scheduler.** `braintrust_load_persona`
 * calls {@link checkSoulHeal} on every load. A dedicated cron here would be exactly the
 * kind of clock this ticket exists to stop trusting — it can die quietly the same way the
 * healer itself can. The accepted cost is named rather than hidden: if nobody asks
 * braintrust anything for a week, nothing fires, and nothing is being answered wrongly
 * either — `SOUL.md` only ever reaches a reader through a session that also calls this.
 *
 * **One clock, reused rather than invented.** A report counts as stale the moment it is
 * older than {@link ESCALATES_AFTER_MS}, the same one-day outer limit every other fault on
 * this ledger already escalates on — not a second figure that could disagree with it. A
 * fault opens the run that first observes the staleness, so "stale for more than a day"
 * and "a fault is filed" are the same event rather than two clocks racing.
 *
 * **A profile that has never reported is never checked.** braintrust has no other record
 * of which People have a Hermes profile at all — that arrangement lives entirely on a host
 * braintrust does not own — so a Person with no row here reads as "no Hermes profile"
 * rather than "silent", and opening a fault for it would be a false alarm on every
 * deployment that has never used Hermes. The first report is what starts the clock.
 *
 * **The fleet check runs before any per-profile check, and suppresses it.** If nothing has
 * reported in at all, that is one fault — the healer itself, not five profiles individually
 * behind. Per-profile faults exist for the other case: the healer is alive and most of the
 * fleet is current, but one profile's own render is stuck (a malformed `SOUL.md` the script
 * skips, say) while the rest keep moving.
 *
 * **Nothing here ever withdraws a layer or reaches a reader.** The fault this opens is
 * registered with an empty withdrawal list, the same as `corpus_coverage` and the
 * corpus-size fault — a report to the maintainer, never a gate.
 *
 * See docs/design/map-300-spec.md §4 and https://github.com/cgbarlow/braintrust/issues/326.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from './db.js';
import { ESCALATES_AFTER_MS } from './interrogate/schedule.js';
import { clearFault, openFault } from './interrogate/store.js';

/** The name this fault opens under. Registered in interrogate/assertions.ts. */
export const SOUL_HEAL_ASSERTION = 'soul_heal_stale';

/** The command a maintainer runs to fix a broken heal — the host it runs on is not braintrust's. */
export const SOUL_HEAL_COMMAND = './scripts/patch-hermes-profiles.sh';

/**
 * How long a heal report is trusted before the profile it is for counts as overdue.
 * {@link ESCALATES_AFTER_MS} rather than a figure of its own — see the module comment.
 */
export const HEAL_FRESHNESS_MS = ESCALATES_AFTER_MS;

let cachedTemplateVersion: string | undefined;

/**
 * `sha256(hermes/SOUL.md.template)`, truncated to 12 hex characters — the same file the
 * healer fetches from `origin/main` and hashes with `sha256sum`/`shasum -a 256` before it
 * reports in. Read from disk relative to this module rather than `process.cwd()`, so it
 * resolves the same way whether this runs from `src/` under `tsx` or from `dist/` after
 * `tsc` — both sit one directory below the repo root, the same level `hermes/` does.
 *
 * Cached after the first read: the template does not change while a process is running,
 * and a persona load is not the place to add a file read on every call.
 */
export async function currentTemplateVersion(): Promise<string> {
  if (cachedTemplateVersion !== undefined) return cachedTemplateVersion;
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'hermes', 'SOUL.md.template');
  const content = await readFile(path, 'utf8');
  cachedTemplateVersion = createHash('sha256').update(content).digest('hex').slice(0, 12);
  return cachedTemplateVersion;
}

export type HealReport = {
  /** The Hermes profile name, e.g. `bt-nate-b-jones`. */
  profile: string;
  /** The braintrust slug the profile speaks for. */
  person: string;
  /** The template version the healer rendered, in the same shape as {@link currentTemplateVersion}. */
  template_version: string;
};

/**
 * Records one profile's heal report. Called from `POST /heal` — see src/http/app.ts.
 *
 * Upserted rather than appended: this is the profile's **current** state, not a history,
 * the same shape `braintrust_faults` keeps for a live fault. A profile that has reported
 * before and reports again just moves its one row forward.
 */
export async function recordHeal(db: Db, report: HealReport): Promise<void> {
  await db.query(
    `insert into braintrust_soul_heals (person_slug, profile, template_version, reported_at)
          values ($1, $2, $3, now())
     on conflict (person_slug) do update
            set profile = excluded.profile,
                template_version = excluded.template_version,
                reported_at = now()`,
    [report.person, report.profile, report.template_version],
  );
}

type HealRow = {
  person_slug: string;
  profile: string;
  template_version: string;
  reported_at: Date;
};

/** braintrust's own three-way read of the heal state — never sent to a reader. */
export type HealState = 'current' | 'stale' | 'silent';

export type SoulHealCheck = {
  fleet: { state: HealState; detail: string | null };
  profiles: { person: string; profile: string; state: HealState; detail: string }[];
};

/**
 * Reconciles `braintrust_faults` against the last heal report, fleet-wide and then per
 * profile. Called from `braintrust_load_persona` — see the module comment for why this and
 * not a cron.
 *
 * **Never throws.** A failure here is braintrust's own bookkeeping, not evidence about
 * anyone's persona, and it must never be the reason a read fails — see
 * `checkSoulHeal`'s one caller in src/mcp.ts.
 */
export async function checkSoulHeal(db: Db, now: number = Date.now()): Promise<SoulHealCheck> {
  const version = await currentTemplateVersion();
  const { rows } = await db.query<HealRow>(
    `select h.person_slug, h.profile, h.template_version, h.reported_at
       from braintrust_soul_heals h
       join braintrust_people p on p.slug = h.person_slug
      where p.paused_at is null`,
  );

  // Nobody has ever reported. Braintrust cannot tell "no Hermes profile on this
  // deployment" from "the very first report has not arrived yet", and treating the first
  // as a fault would be a false alarm on every deployment that has never run Hermes at
  // all. Nothing is opened or cleared — there is no clock to have started yet.
  if (rows.length === 0) {
    return { fleet: { state: 'silent', detail: null }, profiles: [] };
  }

  const fleetLastReportedAt = rows.reduce(
    (latest, row) => Math.max(latest, row.reported_at.getTime()),
    0,
  );
  const fleetAge = now - fleetLastReportedAt;
  const fleetSilent = fleetAge >= HEAL_FRESHNESS_MS;

  if (fleetSilent) {
    const detail = fleetSilentDetail(new Date(fleetLastReportedAt).toISOString(), fleetAge);
    await openFault(db, { assertion: SOUL_HEAL_ASSERTION, person: null, detail });
    // The fleet fault already says "the healer died" — five more issues naming each
    // profile individually would be the same outage triaged six times. See the module
    // comment.
    return { fleet: { state: 'silent', detail }, profiles: [] };
  }
  await clearFault(db, SOUL_HEAL_ASSERTION, null);

  const profiles: SoulHealCheck['profiles'] = [];
  for (const row of rows) {
    const age = now - row.reported_at.getTime();
    const versionCurrent = row.template_version === version;
    const stale = age >= HEAL_FRESHNESS_MS || !versionCurrent;
    const state: HealState = stale ? 'stale' : 'current';
    const detail = stale
      ? staleDetail(row, version, versionCurrent, age)
      : `${row.profile} reported the current template (${version}) ${Math.round(age / 3_600_000)}h ago.`;

    if (stale) {
      await openFault(db, { assertion: SOUL_HEAL_ASSERTION, person: row.person_slug, detail });
    } else {
      await clearFault(db, SOUL_HEAL_ASSERTION, row.person_slug);
    }
    profiles.push({ person: row.person_slug, profile: row.profile, state, detail });
  }

  return { fleet: { state: 'current', detail: null }, profiles };
}

function fleetSilentDetail(lastReportedAt: string, ageMs: number): string {
  return (
    `no Hermes bt-* profile has reported a SOUL.md heal in ${Math.round(ageMs / 3_600_000)}h ` +
    `(last report ${lastReportedAt}), past the ${Math.round(HEAL_FRESHNESS_MS / 3_600_000)}h line. ` +
    'This fleet has reported before, so this almost certainly means the daily healer job on ' +
    `the Hermes host has stopped running — braintrust cannot reach that host to fix it. ` +
    `Run \`${SOUL_HEAL_COMMAND}\` there and confirm it completes without error; check the ` +
    'host it runs on (cron, launchd, whatever schedules it) if it does not.'
  );
}

function staleDetail(row: HealRow, currentVersion: string, versionCurrent: boolean, ageMs: number): string {
  const reasons: string[] = [];
  if (!versionCurrent) {
    reasons.push(`last rendered template \`${row.template_version}\`, current is \`${currentVersion}\``);
  }
  if (ageMs >= HEAL_FRESHNESS_MS) {
    reasons.push(`last reported ${Math.round(ageMs / 3_600_000)}h ago`);
  }
  return (
    `${row.profile} (${row.person_slug}) is behind: ${reasons.join('; ')}. The rest of the ` +
    'fleet has reported recently, so this looks like one profile stuck rather than the ' +
    `healer itself. Run \`${SOUL_HEAL_COMMAND}\` on the Hermes host and check its output for ` +
    `${row.profile} — a skipped profile names why in that output.`
  );
}


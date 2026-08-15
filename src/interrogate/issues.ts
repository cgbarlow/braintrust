/**
 * Where a fault braintrust cannot repair goes.
 *
 * The split that decides this is **a fault braintrust can repair versus a fault only a
 * person can**. A Persona behind the compiler is the first kind: braintrust rebuilds it and
 * nobody needs telling. A Persona that has just been shown to invent claims is the second —
 * the fault is in the compiler, it is equal across the fleet, and nothing braintrust can do
 * on its own clears it.
 *
 * So the audience is the **maintainer**, not an operator and not the reader. braintrust is
 * unattended but it is not unmaintained, and the place a maintainer already looks is this
 * repo's issues. A dashboard would need somebody watching it; a payload warning was rejected
 * as a permanent piece of furniture bought for a transient condition.
 *
 * See https://github.com/cgbarlow/braintrust/issues/153.
 */

import type { Fetcher } from '../net/fetch.js';

export type Issue = { title: string; body: string };

export type IssueFiler = {
  /** Where issues go, for a log line at startup. */
  where: string;
  /**
   * Files it, returning the issue's URL — or **null when it could not be filed**, which the
   * caller must treat as *nobody has been told*, not as *told*.
   */
  file(issue: Issue): Promise<string | null>;
};

export type IssuesConfig = {
  /** `owner/repo`. */
  repo: string;
  token: string;
  /** Defaults to github.com's API. Present so a fake can stand in without a network. */
  baseUrl?: string | undefined;
};

const GITHUB_API = 'https://api.github.com';

export function createIssueFiler(config: IssuesConfig, fetcher: Fetcher): IssueFiler {
  const base = (config.baseUrl ?? GITHUB_API).replace(/\/+$/, '');
  const url = `${base}/repos/${config.repo}/issues`;

  return {
    where: `${config.repo} issues`,

    async file(issue) {
      try {
        const response = await fetcher(url, {
          json: { title: issue.title, body: issue.body },
          headers: {
            authorization: `Bearer ${config.token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
          },
        });

        if (!response.ok) return null;
        const created = JSON.parse(await response.text()) as { html_url?: unknown };
        return typeof created.html_url === 'string' ? created.html_url : null;
      } catch {
        // A tracker that is unreachable is not a reason to fail the job — the fault is
        // recorded either way, and the next run tries again because nothing was marked
        // reported.
        return null;
      }
    },
  };
}

/**
 * What braintrust does when nobody told it where to file.
 *
 * **It prints the whole issue and returns null, every run, forever.** Returning null is the
 * load-bearing half: the fault is never marked reported, so the noise does not stop until
 * either a tracker is configured or the assertion passes. A quieter fallback — recording it
 * as reported once and going silent — would mean a misconfigured deployment announces the
 * most serious fault braintrust can detect exactly once, into a log nobody reads.
 */
export function loggingIssueFiler(log: (line: string) => void): IssueFiler {
  return {
    where: 'the job log — no issue tracker is configured, so nothing is filed anywhere',
    async file(issue) {
      log(
        `braintrust: NOBODY WAS TOLD. Set BRAINTRUST_ISSUES_REPO and BRAINTRUST_ISSUES_TOKEN ` +
          `so this reaches a maintainer.\n--- ${issue.title} ---\n${issue.body}\n---`,
      );
      return null;
    },
  };
}

export type FaultIssueInput = {
  assertion: string;
  guarantees: string;
  person: string | null;
  subject: string;
  detail: string;
  compilerVersion: string;
  interrogator: string;
  firstFailedAt: string;
  withdraws: string[];
};

/**
 * The issue a first failure opens.
 *
 * Written for somebody arriving cold at 3am: what braintrust guarantees, what it observed,
 * what it did *not* do about it, and what happens if nobody acts. The last two matter most —
 * the natural assumption on reading "braintrust is inventing claims" is that it has stopped
 * serving, and it has not.
 */
export function faultIssue(input: FaultIssueInput): Issue {
  return {
    title: `Interrogation failed: ${input.assertion}${input.person ? ` (${input.person})` : ''}`,
    body: [
      `braintrust interrogated itself and failed an assertion it makes about every persona it serves.`,
      '',
      `**What passing guarantees.** ${input.guarantees}`,
      '',
      `**What was observed.** ${input.detail}`,
      '',
      details(input),
      '',
      `**What braintrust did about it: nothing.** ${
        input.person ? `${input.person}'s persona` : 'Every persona'
      } is still serving, unchanged, and no warning appears in any payload. One live call to a ` +
        'synthesiser that is not reproducible is evidence rather than proof, and the fault is the ' +
        "compiler's rather than this persona's — so withdrawing a working persona on the strength " +
        'of it would cost a reader who did nothing wrong.',
      '',
      `**What happens if nobody acts.** ${
        input.withdraws.length > 0
          ? `A day after the first failure, ${input.withdraws.join(' and ')} goes absent from what ` +
            'is served — silently, the way a layer withheld for a rules change is — and a second ' +
            'issue opens here. Until then this is invisible to a reader.'
          : 'A second issue opens here a day after the first failure. Nothing a reader receives ' +
            'changes at any point: the registry registers this assertion as withdrawing no ' +
            'layer, and this issue is the whole of the escalation.'
      }`,
      '',
      `**This issue is not repeated.** A fault that is re-observed on every run opens no further ` +
        'issues. braintrust clears it when the assertion passes, not when this issue is closed — ' +
        'so closing it without shipping a fix silences the opening arm, and only the escalation ' +
        'above will speak again.',
    ].join('\n'),
  };
}

/** The issue the day mark opens. Deliberately shorter: the first one holds the reasoning. */
export function escalationIssue(input: FaultIssueInput): Issue {
  return {
    title: `Still failing after a day: ${input.assertion}${input.person ? ` (${input.person})` : ''}`,
    body: [
      `\`${input.assertion}\` has been failing since ${input.firstFailedAt} and a day is the outer ` +
        'limit.',
      '',
      `**What was observed.** ${input.detail}`,
      '',
      details(input),
      '',
      input.withdraws.length > 0
        ? `**What changed for readers.** ${input.withdraws.join(' and ')} is now absent from ${
            input.person ? `${input.person}'s persona` : 'every persona'
          }. It is absent rather than flagged — a persona missing a part reads exactly like one ` +
          'that never had it, and there is no second kind of silence. A passing interrogation ' +
          'restores it with no rebuild.'
        : '**Nothing changed for readers.** The registry registers this assertion as ' +
          'withdrawing no layer, and this issue is the whole of the escalation.',
    ].join('\n'),
  };
}

export type SilenceIssueInput = {
  /** Every assertion currently going unasked, with how many subjects and how many tries. */
  silences: { assertion: string; attempts: number; subjects: number; detail: string }[];
  /** The oldest silence's clock — when braintrust last got an answer out of the judge. */
  since: string;
  compilerVersion: string;
  interrogator: string;
};

/**
 * The issue a day of not being able to ask opens.
 *
 * **It names no Person, anywhere.** Six assertions lost to one endpoint returning HTTP 500 is
 * one outage in braintrust's own plumbing; putting five slugs in a title would file somebody
 * else's downtime against people who did nothing. So a persona-scoped assertion appears as a
 * count of personas and never as a list of them.
 *
 * **The reason text is doing real work.** A dead endpoint and a judge that answers without a
 * usable verdict land in the same bucket on the same clock — that is decided, not accidental —
 * and the only place they are told apart is the `detail` carried here.
 */
export function silenceIssue(input: SilenceIssueInput): Issue {
  const total = input.silences.reduce((sum, one) => sum + one.subjects, 0);

  return {
    title: `Interrogation could not be asked: ${total} assertion(s) unchecked since ${input.since.slice(0, 10)}`,
    body: [
      'braintrust has been unable to interrogate itself for over a day. Nothing failed — nothing ' +
        'could be *asked*, which is a third status and is not any persona\'s fault.',
      '',
      `**What has gone unchecked since ${input.since}.**`,
      ...input.silences.map(
        (one) =>
          `- \`${one.assertion}\` — ${one.subjects} subject(s), ${one.attempts} attempt(s), last reason: ${one.detail}`,
      ),
      '',
      `- compiler version: \`${input.compilerVersion}\``,
      `- interrogator: \`${input.interrogator}\``,
      '',
      '**This is braintrust\'s own plumbing, and it names nobody.** These assertions are almost ' +
        'certainly all lost to the same thing — one endpoint, one reason — so this is one issue ' +
        'rather than one per check. An assertion that could not be asked concludes nothing, so no ' +
        'fault was opened against any persona and none is named here.',
      '',
      '**Nothing changed for readers, and nothing will.** No persona was withdrawn, no layer went ' +
        'absent, nothing was hedged and no warning entered any payload. The cost of a third ' +
        "party's outage does not land on a reader who did nothing wrong — and *never verified* is " +
        'not a quantity with a safe direction, so there is no conservative value to take.',
      '',
      '**A judge that answers but will not judge counts as silence**, on this clock and in this ' +
        'issue: a transport error, an HTTP 500, a non-JSON body, an empty reply and a verdict with ' +
        'no boolean in it are one bucket. The reasons above are the only place they differ.',
      '',
      '**This is filed once and never again.** braintrust does not close this issue and does not ' +
        're-file it — a monthly reminder was declined as nagging rather than news. The ledger ' +
        'clears when an assertion gets an answer, pass or fail, and only then can a later outage ' +
        'file. **Accepted cost:** closing this without shipping a fix means nobody is told again, ' +
        'and a single check stuck for its own reason is reported inside this general outage ' +
        'rather than on its own.',
      '',
      '**What is true while this is open.** The guarantee that a persona with no way to look ' +
        'anything up cannot produce that person\'s distinctive claims is *unverified*, not ' +
        'broken. braintrust cannot fix the endpoint; what it can do is stop nobody knowing.',
    ].join('\n'),
  };
}

function details(input: FaultIssueInput): string {
  return [
    `- assertion: \`${input.assertion}\``,
    `- asked against: \`${input.subject}\``,
    `- compiler version: \`${input.compilerVersion}\``,
    `- interrogator: \`${input.interrogator}\``,
    `- first failed: ${input.firstFailedAt}`,
  ].join('\n');
}

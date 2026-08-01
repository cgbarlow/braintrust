/**
 * Coverage, measured — what braintrust read, and what it did not.
 *
 * No model is in this path either. Coverage is a query over tier 1 written into the
 * layer's `evidence` at Compile time, which is why it needs no table of its own.
 *
 * **The counts are the layer; the prose is a reading of them.** A number buried in a
 * sentence cannot be checked, filtered or displayed as a fact, so the rule this module
 * holds itself to is stricter than "return counts too": **no number appears in the prose
 * that is not also a field of `evidence`.** There are no percentages, no totals and no
 * roundings here — every figure in the sentence can be found in the structure it came
 * from, and `test/coverage.test.ts` proves it rather than trusting it.
 *
 * This is the layer that lets a Persona state its own blind spots. `skipped_paywall` is
 * a row rather than an absence for exactly that reason: braintrust knows precisely how
 * much of someone's output it has never read.
 *
 * See docs/design/compiler.md §2 and docs/design/mcp-surface.md §2.
 */

export type SourceCoverage = {
  platform: string;
  handle: string;
  retrieved: number;
  skipped_paywall: number;
  skipped_short: number;
  skipped_window: number;
  failed: number;
  pending: number;
  words_retrieved: number;
  window: [string, string] | null;
  /**
   * False while braintrust knows it is behind — either it has never finished the first
   * archive walk, or a gap reopened it. The Persona says so for as long as it is false.
   */
  backfill_complete: boolean;
  /** Present only when the Source stopped answering. Never the same fact as a pause. */
  blocked_since?: string;
};

/**
 * The six fields the spec fixes — `window`, `retrieved`, `skipped_paywall`, `failed`,
 * `words_retrieved`, `by_source` — plus the skips that would otherwise vanish.
 * `skipped_short` and `skipped_window` are braintrust's own policy rather than a
 * Source's, and `pending` is work not yet done rather than work declined; folding any of
 * them into `failed` would make the Persona claim a blind spot it does not have.
 */
export type CoverageEvidence = {
  window: [string, string] | null;
  retrieved: number;
  skipped_paywall: number;
  skipped_short: number;
  skipped_window: number;
  failed: number;
  pending: number;
  words_retrieved: number;
  /**
   * Keyed `platform:handle` rather than by platform alone, because one Person may follow
   * two publications on the same platform and merging them silently would be a count
   * nobody could check. Both parts are repeated inside the entry so no client has to
   * parse the key.
   */
  by_source: Record<string, SourceCoverage>;
};

export type CoverageLayer = {
  descriptive_md: string;
  evidence: CoverageEvidence;
};

export function coverageLayer(evidence: CoverageEvidence): CoverageLayer {
  return { descriptive_md: describe(evidence), evidence };
}

function describe(evidence: CoverageEvidence): string {
  const lines: string[] = [];

  lines.push(
    `braintrust has read ${evidence.retrieved} item${evidence.retrieved === 1 ? '' : 's'} from this ` +
      `person — ${evidence.words_retrieved} words` +
      `${evidence.window ? `, published between ${evidence.window[0]} and ${evidence.window[1]}` : ''}. ` +
      'Everything this persona knows comes from those items and nothing else.',
  );

  const gaps: string[] = [];
  if (evidence.skipped_paywall > 0) {
    gaps.push(
      `${evidence.skipped_paywall} paywalled item${evidence.skipped_paywall === 1 ? ' was' : 's were'} ` +
        'never fetched. braintrust does not ingest paid content, so that part of their thinking is ' +
        'outside this persona entirely.',
    );
  }
  if (evidence.skipped_short > 0) {
    gaps.push(
      `${evidence.skipped_short} short video${evidence.skipped_short === 1 ? ' was' : 's were'} skipped ` +
        "as promotional. That is braintrust's own rule rather than the platform's, and turning " +
        'exclude_shorts off brings them back.',
    );
  }
  if (evidence.skipped_window > 0) {
    gaps.push(
      `${evidence.skipped_window} item${evidence.skipped_window === 1 ? ' is' : 's are'} older than ` +
        'the window braintrust was asked to read. Nothing about them failed — braintrust chose ' +
        'not to look, and widening window_months brings them back.',
    );
  }
  if (evidence.failed > 0) {
    gaps.push(
      `${evidence.failed} item${evidence.failed === 1 ? '' : 's'} could not be retrieved at all.`,
    );
  }
  if (evidence.pending > 0) {
    gaps.push(
      `${evidence.pending} item${evidence.pending === 1 ? ' is' : 's are'} known and not yet read. ` +
        'The next run collects them.',
    );
  }
  if (gaps.length > 0) lines.push('', '**Not read.**', ...gaps.map((gap) => `- ${gap}`));

  const sources = Object.values(evidence.by_source);
  if (sources.length > 0) {
    lines.push('', '**By source.**');
    for (const source of sources) {
      const parts = [`${source.retrieved} read`, `${source.words_retrieved} words`];
      if (source.skipped_paywall > 0) parts.push(`${source.skipped_paywall} paywalled`);
      if (source.skipped_short > 0) parts.push(`${source.skipped_short} short`);
      if (source.skipped_window > 0) parts.push(`${source.skipped_window} outside the window`);
      if (source.failed > 0) parts.push(`${source.failed} failed`);
      if (source.pending > 0) parts.push(`${source.pending} pending`);
      lines.push(`- \`${source.platform}:${source.handle}\` — ${parts.join(', ')}.`);
    }
  }

  // Two facts that read alike and are not alike: a source refusing braintrust, and the
  // archive walk being unfinished. Neither is the user pausing, which is the third.
  const blocked = sources.filter((source) => source.blocked_since);
  if (blocked.length > 0) {
    lines.push(
      '',
      '**Stopped answering.** ' +
        blocked
          .map((source) => `\`${source.platform}:${source.handle}\` since ${source.blocked_since}`)
          .join(', ') +
        '. braintrust keeps everything it already had from that source and asks again tomorrow. ' +
        'This is the source refusing braintrust, not the user choosing to stop following.',
    );
  }

  const behind = sources.filter((source) => !source.backfill_complete);
  if (behind.length > 0) {
    lines.push(
      '',
      '**Incomplete.** ' +
        behind.map((source) => `\`${source.platform}:${source.handle}\``).join(', ') +
        ' has not been walked back to its floor yet, so this persona is built on part of the ' +
        'archive rather than all of it.',
    );
  }

  return lines.join('\n');
}

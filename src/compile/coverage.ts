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

import type { VoicePopulation } from './voice.js';

/**
 * What shape the Corpus is, which is the question a mixed one makes urgent. `by_source`
 * answers *who*; this answers *what* — and the boundary is Voice's own floor, so the two
 * layers cannot disagree about which items are long-form.
 */
export type FormCoverage = { items: number; words: number };

export type SourceCoverage = {
  platform: string;
  handle: string;
  retrieved: number;
  skipped_paywall: number;
  skipped_short: number;
  skipped_window: number;
  skipped_not_a_post: number;
  skipped_no_captions: number;
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
 * `skipped_short`, `skipped_window` and `skipped_not_a_post` are braintrust's own policy
 * rather than a Source's, and `pending` is work not yet done rather than work declined;
 * folding any of them into `failed` would make the Persona claim a blind spot it does not
 * have. `skipped_not_a_post` is the sharpest case of that: it counts URLs a source served
 * perfectly and braintrust found were not articles.
 */
export type CoverageEvidence = {
  window: [string, string] | null;
  retrieved: number;
  skipped_paywall: number;
  skipped_short: number;
  skipped_window: number;
  skipped_not_a_post: number;
  skipped_no_captions: number;
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
  /**
   * Split at Voice's floor. An item count across four orders of magnitude is not a size —
   * *"read 963 items"* flatters a Corpus that is mostly one-liners, and *"read 89,000
   * words: 63 long-form items and 900 short posts"* does not.
   */
  by_form: { long_form: FormCoverage; short_form: FormCoverage };
  /**
   * Voice's population, restated here because **a reader is entitled to know Voice was
   * measured on a fraction of the Corpus**. Naming braintrust's blind spots is what this
   * layer is for, and a layer that selects a population is one of them.
   *
   * It is duplicated rather than referenced because of this module's own rule: no number
   * in the prose that is not also a field of `evidence`. Coverage states the Voice
   * population, so Coverage has to carry it.
   */
  voice_measured_over: VoicePopulation;
};

export type CoverageLayer = {
  descriptive_md: string;
  evidence: CoverageEvidence;
};

export function coverageLayer(evidence: CoverageEvidence): CoverageLayer {
  return { descriptive_md: describe(evidence), evidence };
}

/** The measured coverage plus the one number only the Voice step can supply. */
export function withVoicePopulation(
  measured: Omit<CoverageEvidence, 'voice_measured_over'>,
  voice: VoicePopulation,
): CoverageEvidence {
  return { ...measured, voice_measured_over: voice };
}

function describe(evidence: CoverageEvidence): string {
  const lines: string[] = [];

  // Words lead, because they are the one measure comparable across forms. An item count
  // spanning a thirty-word post and a forty-thousand-word lecture is not a size.
  const { long_form: long, short_form: short } = evidence.by_form;
  lines.push(
    `braintrust has read ${evidence.words_retrieved} words from this person — ` +
      `${long.items} long-form item${long.items === 1 ? '' : 's'} carrying ${long.words} words, and ` +
      `${short.items} shorter one${short.items === 1 ? '' : 's'} carrying ${short.words}; ` +
      `${evidence.retrieved} in all` +
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
      `${evidence.skipped_short} item${evidence.skipped_short === 1 ? ' was' : 's were'} skipped ` +
        'as too brief to be worth reading — a promotional video, or a page of a few dozen words. ' +
        "That is braintrust's own rule rather than the platform's, and turning exclude_shorts off " +
        'brings them back.',
    );
  }
  if (evidence.skipped_window > 0) {
    gaps.push(
      `${evidence.skipped_window} item${evidence.skipped_window === 1 ? ' is' : 's are'} older than ` +
        'the window braintrust was asked to read. Nothing about them failed — braintrust chose ' +
        'not to look, and widening window_months brings them back.',
    );
  }
  // Deliberately worded as work done rather than work missed. A sitemap enumerates URLs
  // and not everything on a blog is an article, so this number is braintrust checking —
  // and it sits beside `failed`, which is the opposite fact, so the two read as the
  // different things they are.
  if (evidence.skipped_not_a_post > 0) {
    gaps.push(
      `${evidence.skipped_not_a_post} URL${evidence.skipped_not_a_post === 1 ? '' : 's'} in the ` +
        `archive turned out not to be post${evidence.skipped_not_a_post === 1 ? '' : 's'} — an ` +
        'about page, a tag index, a homepage. braintrust fetched them, found no publish date and ' +
        'left them out; nothing failed.',
    );
  }
  if (evidence.skipped_no_captions > 0) {
    gaps.push(
      `braintrust ran into trouble getting the captions for ${evidence.skipped_no_captions} ` +
        `video${evidence.skipped_no_captions === 1 ? '' : 's'}. Whether those videos are ` +
        'captioned is not something braintrust can tell from a request that came back without ' +
        'them — what it can say is that it did not get the words.',
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

  // Not a gap in the corpus — a gap in one layer's population, which is a different fact
  // and belongs in the layer whose job is naming what braintrust cannot see.
  const voice = evidence.voice_measured_over;
  lines.push(
    '',
    '**How voice was measured.** ' +
      (voice.min_words === 0
        ? `No item here is long enough for the usual long-form floor, so voice was measured over ` +
          `all ${voice.items} item${voice.items === 1 ? '' : 's'}, median ${voice.median_words} ` +
          'words. It is labelled rather than withheld: a persona that refuses to describe a voice ' +
          'is worse than one that says which voice it measured.'
        : `Voice was measured from ${voice.items} item${voice.items === 1 ? '' : 's'} of ` +
          `${voice.min_words} words or more.` +
          (voice.items_excluded > 0
            ? ` ${voice.items_excluded} shorter item${voice.items_excluded === 1 ? ' was' : 's were'} ` +
              'read for what they say, not for how they say it.'
            : '')),
  );

  const sources = Object.values(evidence.by_source);
  if (sources.length > 0) {
    lines.push('', '**By source.**');
    for (const source of sources) {
      const parts = [`${source.retrieved} read`, `${source.words_retrieved} words`];
      if (source.skipped_paywall > 0) parts.push(`${source.skipped_paywall} paywalled`);
      if (source.skipped_short > 0) parts.push(`${source.skipped_short} short`);
      if (source.skipped_window > 0) parts.push(`${source.skipped_window} outside the window`);
      if (source.skipped_not_a_post > 0) parts.push(`${source.skipped_not_a_post} not posts`);
      // **A tally is read as hard as a sentence, and this one sits four lines below a
      // sentence that contradicts it.** The gap prose above says braintrust ran into
      // trouble getting the captions; `34 no captions` says the videos have none. Both
      // ship in the same layer, and the short one is the one a reader takes. Every other
      // entry here names what braintrust did — read, skipped, failed — so this one names
      // that too, rather than describing somebody's published work.
      if (source.skipped_no_captions > 0)
        parts.push(`${source.skipped_no_captions} captions not retrieved`);
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

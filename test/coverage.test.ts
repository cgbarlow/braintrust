/**
 * Coverage, measured.
 *
 * This is the layer that lets a Persona name its own blind spots, so the tests here are
 * mostly about what it refuses to blur: a paywall braintrust respected, a rule braintrust
 * imposed, a source that stopped answering, and an archive it has not finished walking
 * are four different facts, and a Persona that merged any two of them would be claiming
 * a gap it does not have or hiding one it does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coverageLayer, type CoverageEvidence, type SourceCoverage } from '../src/compile/coverage.js';
import { numbersMissingFromEvidence } from './support/layers.js';

function source(overrides: Partial<SourceCoverage> = {}): SourceCoverage {
  return {
    platform: 'youtube',
    handle: 'UC0C',
    retrieved: 69,
    skipped_paywall: 0,
    skipped_short: 9,
    skipped_window: 0,
    skipped_not_a_post: 0,
    skipped_no_captions: 0,
    failed: 0,
    pending: 0,
    words_retrieved: 118_402,
    window: ['2025-05-28', '2026-07-27'],
    backfill_complete: true,
    ...overrides,
  };
}

function evidence(overrides: Partial<CoverageEvidence> = {}): CoverageEvidence {
  const sources = overrides.by_source ?? { 'youtube:UC0C': source() };
  const totals = Object.values(sources);

  return {
    window: ['2025-05-28', '2026-07-27'],
    retrieved: totals.reduce((n, one) => n + one.retrieved, 0),
    skipped_paywall: totals.reduce((n, one) => n + one.skipped_paywall, 0),
    skipped_short: totals.reduce((n, one) => n + one.skipped_short, 0),
    skipped_window: totals.reduce((n, one) => n + one.skipped_window, 0),
    skipped_not_a_post: totals.reduce((n, one) => n + one.skipped_not_a_post, 0),
    skipped_no_captions: totals.reduce((n, one) => n + one.skipped_no_captions, 0),
    failed: totals.reduce((n, one) => n + one.failed, 0),
    pending: totals.reduce((n, one) => n + one.pending, 0),
    words_retrieved: totals.reduce((n, one) => n + one.words_retrieved, 0),
    by_source: sources,
    // A default split that adds up to the totals above, so the no-number-outside-evidence
    // check is measuring the prose rather than an inconsistent fixture.
    by_form: {
      long_form: { items: 40, words: 110000 },
      short_form: {
        items: totals.reduce((n, one) => n + one.retrieved, 0) - 40,
        words: totals.reduce((n, one) => n + one.words_retrieved, 0) - 110000,
      },
    },
    voice_measured_over: { min_words: 300, items: 40, median_words: 2500, items_excluded: 29 },
    ...overrides,
  };
}

describe('the coverage layer', () => {
  it('says what it read, and where that leaves the persona', () => {
    const { descriptive_md } = coverageLayer(evidence());

    assert.match(descriptive_md, /read 118402 words/);
    assert.match(descriptive_md, /40 long-form items/);
    assert.match(descriptive_md, /69 in all/);
    assert.match(descriptive_md, /2025-05-28 and 2026-07-27/);
    assert.match(descriptive_md, /Everything this persona knows comes from those items/);
  });

  it('names a paywall as content it will never read, not as content it failed to get', () => {
    const { descriptive_md } = coverageLayer(
      evidence({ by_source: { 'substack:x.test': source({ platform: 'substack', handle: 'x.test', skipped_paywall: 304 }) } }),
    );

    assert.match(descriptive_md, /304 paywalled items were never fetched/);
    assert.match(descriptive_md, /does not ingest paid content/);
    // A deliberate skip is not a failure, and reporting it as one would invent a fault
    // on the source's side that braintrust caused itself.
    assert.doesNotMatch(descriptive_md, /could not be retrieved/);
  });

  it("distinguishes braintrust's own skip rule from the platform's", () => {
    const { descriptive_md } = coverageLayer(evidence());

    assert.match(descriptive_md, /9 items were skipped as too brief/);
    assert.match(descriptive_md, /braintrust's own rule rather than the platform's/);
    assert.match(descriptive_md, /exclude_shorts off brings them back/);
  });

  /**
   * A source that answered perfectly and a source that could not answer read alike in a
   * count and are not alike at all. `skipped_not_a_post` is the sharpest case: a sitemap
   * enumerates URLs, so braintrust fetching an about page and finding no date is the
   * whole mechanism working, not a retrieval that failed.
   */
  it('reports a URL that turned out not to be a post as work done, not work missed', () => {
    const { descriptive_md } = coverageLayer(
      evidence({ by_source: { 'blog:notes.example.com': source({ platform: 'blog', skipped_not_a_post: 3 }) } }),
    );

    assert.match(descriptive_md, /3 URLs in the archive turned out not to be posts/);
    assert.match(descriptive_md, /nothing failed/);
    assert.doesNotMatch(descriptive_md, /could not be retrieved/);
  });

  it('names the window as braintrust choosing not to look, never as a retrieval that failed', () => {
    const { descriptive_md } = coverageLayer(
      evidence({ by_source: { 'substack:x.test': source({ platform: 'substack', handle: 'x.test', skipped_window: 4 }) } }),
    );

    // The sentence this ticket was filed over. `failed` rendered these as "4 items could
    // not be retrieved at all", which is a lie about a source that answered perfectly —
    // braintrust was told where to stop and stopped there.
    assert.match(descriptive_md, /4 items are older than the window braintrust was asked to read/);
    assert.match(descriptive_md, /widening window_months brings them back/);
    assert.doesNotMatch(descriptive_md, /could not be retrieved/);
  });

  it('reports captions it could not get as its own trouble, never as videos without captions', () => {
    const { descriptive_md } = coverageLayer(
      evidence({
        by_source: {
          'youtube:UC0': source({ platform: 'youtube', handle: 'UC0', skipped_no_captions: 3 }),
        },
      }),
    );

    // This sentence used to read "3 videos have no caption track braintrust can read. That
    // is a fact about the video, not a fetch to retry." Measured false: the same videos
    // return full transcripts when the request goes out from a domestic connection rather
    // than the datacenter the job runs in. Coverage names what braintrust did not get; an
    // absence in somebody's published work is not a thing it can see from here.
    assert.match(descriptive_md, /ran into trouble getting the captions for 3 videos/);
    assert.match(descriptive_md, /it did not get the words/);
    assert.doesNotMatch(descriptive_md, /fact about the video/);

    // The per-source tally is part of this layer and says the same thing in five
    // characters. It shipped reading `3 no captions` four lines under the sentence
    // above, and a reader takes the short one — so the tally names what braintrust
    // did, like every other entry beside it.
    assert.match(descriptive_md, /3 captions not retrieved/);

    // **The guard is on the whole layer, not on the prose.** The assertion this
    // replaces forbade only the long phrasings — `have no caption`, `no captions on`
    // — so the tally sailed through it while making the identical claim. Every honest
    // way of putting this is about braintrust's attempt, and none of them needs the
    // words below, which is what makes a blanket ban the right shape here.
    assert.doesNotMatch(descriptive_md, /no captions?\b/i);
  });

  it('reports items not yet read as work outstanding rather than as a gap', () => {
    const { descriptive_md } = coverageLayer(
      evidence({ by_source: { 'youtube:UC0C': source({ pending: 12 }) } }),
    );

    assert.match(descriptive_md, /12 items are known and not yet read/);
    assert.match(descriptive_md, /The next run collects them/);
  });

  it('says nothing about gaps when there are none', () => {
    const { descriptive_md } = coverageLayer(
      evidence({ by_source: { 'youtube:UC0C': source({ skipped_short: 0, skipped_window: 0 }) } }),
    );

    assert.doesNotMatch(descriptive_md, /\*\*Not read\.\*\*/);
  });

  it('names a blocked source, and never lets it read as the user pausing', () => {
    const { descriptive_md } = coverageLayer(
      evidence({ by_source: { 'youtube:UC0C': source({ blocked_since: '2026-07-30' }) } }),
    );

    assert.match(descriptive_md, /Stopped answering.*youtube:UC0C` since 2026-07-30/s);
    assert.match(descriptive_md, /keeps everything it already had/);
    // Two facts, two sentences: one is the source refusing braintrust, the other is the
    // user's own choice, and only one of them is anybody's fault.
    assert.match(descriptive_md, /not the user choosing to stop following/);
  });

  it('says the corpus is incomplete for as long as the backfill flag says so', () => {
    const { descriptive_md } = coverageLayer(
      evidence({ by_source: { 'youtube:UC0C': source({ backfill_complete: false }) } }),
    );

    assert.match(descriptive_md, /Incomplete.*has not been walked back to its floor/s);
    assert.match(descriptive_md, /built on part of the archive rather than all of it/);
  });
});

describe('the shape of the evidence', () => {
  it('carries the six fields the spec fixes, plus the skips that would otherwise vanish', () => {
    const measured = coverageLayer(evidence()).evidence;

    for (const field of ['window', 'retrieved', 'skipped_paywall', 'failed', 'words_retrieved', 'by_source']) {
      assert.ok(field in measured, `coverage evidence is missing ${field}`);
    }
    // None of these is a failure and none is a paywall. Folding them into either would
    // make the persona claim a blind spot it does not have.
    assert.ok('skipped_short' in measured);
    assert.ok('skipped_window' in measured);
    assert.ok('pending' in measured);
  });

  it('keys sources by platform and handle, so two publications cannot merge silently', () => {
    const measured = coverageLayer(
      evidence({
        by_source: {
          'substack:one.test': source({ platform: 'substack', handle: 'one.test', retrieved: 4 }),
          'substack:two.test': source({ platform: 'substack', handle: 'two.test', retrieved: 7 }),
        },
      }),
    ).evidence;

    assert.deepEqual(Object.keys(measured.by_source).sort(), ['substack:one.test', 'substack:two.test']);
    assert.equal(measured.retrieved, 11);
    // Repeated inside the entry, so no client has to parse the key to use it.
    assert.equal(measured.by_source['substack:one.test']!.platform, 'substack');
    assert.equal(measured.by_source['substack:one.test']!.handle, 'one.test');
  });

  it('leads with words, because an item count across four orders of magnitude is not a size', () => {
    const { descriptive_md } = coverageLayer(evidence());

    // "read 69 items" flatters a corpus that is mostly one-liners. The shape is the fact.
    assert.match(descriptive_md, /read 118402 words/);
    assert.match(descriptive_md, /40 long-form items carrying 110000 words/);
    assert.match(descriptive_md, /29 shorter ones carrying 8402/);
    assert.match(descriptive_md, /69 in all/);
  });

  it('names the voice population as a blind spot, which is what this layer is for', () => {
    const { descriptive_md } = coverageLayer(evidence());

    // A reader is entitled to know voice was measured on a fraction of the corpus.
    assert.match(descriptive_md, /\*\*How voice was measured\.\*\*/);
    assert.match(descriptive_md, /Voice was measured from 40 items of 300 words or more/);
    assert.match(descriptive_md, /29 shorter items were read for what they say, not for how they say it/);
  });

  it('says a dropped floor was dropped, rather than reporting a floor nobody applied', () => {
    const { descriptive_md } = coverageLayer(
      evidence({
        voice_measured_over: { min_words: 0, items: 69, median_words: 198, items_excluded: 0 },
      }),
    );

    assert.match(descriptive_md, /voice was measured over all 69 items, median 198 words/);
    assert.match(descriptive_md, /labelled rather than withheld/);
    assert.doesNotMatch(descriptive_md, /300 words or more/);
  });

  it('puts no number in its prose that is not also a field of its evidence', () => {
    // The reason coverage returns counts at all: a number buried in a sentence cannot be
    // checked, filtered or displayed as a fact. That is only true if the sentence never
    // becomes the only place a number lives.
    const layer = coverageLayer(
      evidence({
        by_source: {
          'youtube:UC0C': source({ pending: 3, failed: 2, blocked_since: '2026-07-30' }),
          'substack:x.test': source({
            platform: 'substack',
            handle: 'x.test',
            retrieved: 1,
            skipped_paywall: 304,
            skipped_short: 0,
            skipped_window: 4,
            words_retrieved: 1_712,
            backfill_complete: false,
          }),
        },
      }),
    );

    assert.deepEqual(numbersMissingFromEvidence(layer.descriptive_md, layer.evidence), []);
  });
});

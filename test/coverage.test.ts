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
    failed: totals.reduce((n, one) => n + one.failed, 0),
    pending: totals.reduce((n, one) => n + one.pending, 0),
    words_retrieved: totals.reduce((n, one) => n + one.words_retrieved, 0),
    by_source: sources,
    ...overrides,
  };
}

describe('the coverage layer', () => {
  it('says what it read, and where that leaves the persona', () => {
    const { descriptive_md } = coverageLayer(evidence());

    assert.match(descriptive_md, /read 69 items/);
    assert.match(descriptive_md, /118402 words/);
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

    assert.match(descriptive_md, /9 short videos were skipped as promotional/);
    assert.match(descriptive_md, /braintrust's own rule rather than the platform's/);
    assert.match(descriptive_md, /exclude_shorts off brings them back/);
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
      evidence({ by_source: { 'youtube:UC0C': source({ skipped_short: 0 }) } }),
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
  it('carries the six fields the spec fixes, plus the two skips that would otherwise vanish', () => {
    const measured = coverageLayer(evidence()).evidence;

    for (const field of ['window', 'retrieved', 'skipped_paywall', 'failed', 'words_retrieved', 'by_source']) {
      assert.ok(field in measured, `coverage evidence is missing ${field}`);
    }
    // Neither of these is a failure and neither is a paywall. Folding them into either
    // would make the persona claim a blind spot it does not have.
    assert.ok('skipped_short' in measured);
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
            words_retrieved: 1_712,
            backfill_complete: false,
          }),
        },
      }),
    );

    assert.deepEqual(numbersMissingFromEvidence(layer.descriptive_md, layer.evidence), []);
  });
});

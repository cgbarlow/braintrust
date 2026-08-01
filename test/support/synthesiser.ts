/**
 * A synthesiser that behaves like a good model and never calls one.
 *
 * It reads the `[id]` markers back out of the digest it was handed and attributes its
 * entries to them, so a test can assert on attribution without pretending the ids came
 * from anywhere braintrust did not put them. `entriesFor` overrides that for the tests
 * that need a model behaving badly — inventing an item, or returning nothing at all.
 */

import type {
  ClusteredPosition,
  InferredKind,
  JudgedPair,
  SynthesisedEntry,
  SynthesisMode,
  Synthesiser,
} from '../../src/compile/synthesis.js';

export type FakeCall = {
  kind: InferredKind | 'positions' | 'revisions';
  mode: SynthesisMode;
  digest: string;
};

export type FakeSynthesiser = Synthesiser & { calls: FakeCall[] };

export type FakeOptions = {
  generation?: string;
  clusterer?: string;
  judge?: string;
  /** Replaces the default answer. Given the ids the digest actually carried. */
  entriesFor?: (kind: InferredKind, items: string[], mode: SynthesisMode) => SynthesisedEntry[];
  /** Replaces the default grouping. Given the claim refs the digest actually carried. */
  positionsFor?: (claims: string[], mode: SynthesisMode) => ClusteredPosition[];
  /** Replaces the default judgement. Given the pair refs the digest actually carried. */
  judgementsFor?: (pairs: string[], digest: string) => JudgedPair[];
  /** Throws instead of answering — an endpoint that went away mid-compile. */
  throws?: Error;
};

export function fakeSynthesiser(options: FakeOptions = {}): FakeSynthesiser {
  const calls: FakeCall[] = [];

  return {
    generation: options.generation ?? 'test-model@core-1',
    clusterer: options.clusterer ?? 'test-model@positions-2',
    judge: options.judge ?? 'test-model@revisions-1',
    model: 'test-model',
    url: 'https://example.test/v1/chat/completions',
    calls,

    async judgePairs(digest): Promise<JudgedPair[]> {
      calls.push({ kind: 'revisions', mode: 'pass', digest });
      if (options.throws) throw options.throws;

      const pairs = pairsFromDigest(digest);
      if (options.judgementsFor) return options.judgementsFor(pairs, digest);

      // `none` on everything, because that is what a good judge says to most of what a
      // neighbourhood hands it — being near in a vector space is a fact about wording. A
      // test that wants a relation asks for one.
      return pairs.map((pair) => ({
        pair,
        relation: 'none' as const,
        rationale: 'Two ways of saying the same thing.',
      }));
    },

    async cluster(digest, mode): Promise<ClusteredPosition[]> {
      calls.push({ kind: 'positions', mode, digest });
      if (options.throws) throw options.throws;

      const claims = mode === 'merge' ? refsFromClusters(digest) : refsFromDigest(digest);
      if (options.positionsFor) return options.positionsFor(claims, mode);
      if (claims.length === 0) return [];

      // Two groupings rather than one, so a test can tell "every claim landed somewhere"
      // apart from "one position swallowed the corpus": the first claim of each item
      // stands alone, and everything else groups together.
      const [first, ...rest] = claims;
      return [
        { slug: 'the-constraint-is-not-speed', statement: 'The constraint is never speed.', claims: [first!] },
        ...(rest.length > 0
          ? [
              {
                slug: 'judgement-is-the-scarce-thing',
                statement: 'Judgement about what to build is the scarce input.',
                claims: rest,
              },
            ]
          : []),
      ];
    },

    async synthesise(kind, digest, mode): Promise<SynthesisedEntry[]> {
      calls.push({ kind, mode, digest });
      if (options.throws) throw options.throws;

      const items = mode === 'merge' ? idsFromEntries(digest) : idsFromDigest(digest);
      if (options.entriesFor) return options.entriesFor(kind, items, mode);

      return [
        {
          label: kind === 'reasoning' ? 'Names the constraint first' : 'The constraint is never speed',
          body: `Two or three sentences about ${kind}, in braintrust's voice rather than a quote.`,
          items,
        },
        {
          label: kind === 'reasoning' ? 'Argues from the counter-case' : 'Judgement is the scarce thing',
          body: 'A second entry, so a layer is never one heading long.',
          items: items.slice(0, 1),
        },
      ];
    },
  };
}

export function idsFromDigest(digest: string): string[] {
  return [...digest.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]!);
}

function idsFromEntries(digest: string): string[] {
  const parsed = JSON.parse(digest) as { entries: SynthesisedEntry[] };
  return [...new Set(parsed.entries.flatMap((entry) => entry.items))];
}

/** The claim refs braintrust issued, read back out of the digest it handed over. */
export function refsFromDigest(digest: string): string[] {
  return [...digest.matchAll(/^\[(c\d+)\]/gm)].map((match) => match[1]!);
}

/** The pair refs braintrust issued, read back out of the digest it handed over. */
export function pairsFromDigest(digest: string): string[] {
  return [...digest.matchAll(/^\[(p\d+)\]/gm)].map((match) => match[1]!);
}

function refsFromClusters(digest: string): string[] {
  const parsed = JSON.parse(digest) as { positions: ClusteredPosition[] };
  return [...new Set(parsed.positions.flatMap((position) => position.claims))];
}

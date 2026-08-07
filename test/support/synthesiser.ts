/**
 * A synthesiser that behaves like a good model and never calls one.
 *
 * It reads the `[id]` markers back out of the digest it was handed and attributes its
 * entries to them, so a test can assert on attribution without pretending the ids came
 * from anywhere braintrust did not put them. `entriesFor` overrides that for the tests
 * that need a model behaving badly — inventing an item, or returning nothing at all.
 *
 * `groupsFor` is the same trick for the merge: it is handed the indices the indexed list
 * actually carried, so a test cannot pretend an index came from somewhere braintrust did
 * not put it either. Its default is to merge nothing, which is what a good model answers
 * when the passes did not repeat themselves.
 */

import type {
  ChosenHabit,
  ClusteredPosition,
  InferredKind,
  JudgedPair,
  MergeGroup,
  MergeStage,
  SynthesisedEntry,
  SynthesisMode,
  Synthesiser,
} from '../../src/compile/synthesis.js';

export type FakeCall = {
  kind: InferredKind | 'positions' | 'revisions' | 'habits';
  mode: SynthesisMode;
  digest: string;
};

export type FakeSynthesiser = Synthesiser & { calls: FakeCall[] };

export type FakeOptions = {
  generation?: string;
  clusterer?: string;
  habits?: string;
  judge?: string;
  /** Replaces the default answer. Given the ids the digest actually carried. */
  entriesFor?: (kind: InferredKind, items: string[]) => SynthesisedEntry[];
  /** Replaces the default grouping. Given the claim refs the digest actually carried. */
  positionsFor?: (claims: string[]) => ClusteredPosition[];
  /** Replaces the default menu choice. Given the ids the digest actually carried. */
  habitsFor?: (items: string[]) => ChosenHabit[];
  /** Replaces the default merge. Given the indices the indexed list actually carried. */
  groupsFor?: (indices: number[], stage: MergeStage) => MergeGroup[];
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
    habits: options.habits ?? 'test-model@habits-1',
    judge: options.judge ?? 'test-model@revisions-1',
    model: 'test-model',
    url: 'https://example.test/v1/chat/completions',
    calls,

    async chooseHabits(digest): Promise<ChosenHabit[]> {
      calls.push({ kind: 'habits', mode: 'pass', digest });
      if (options.throws) throw options.throws;

      const items = idsFromDigest(digest);
      if (options.habitsFor) return options.habitsFor(items);
      if (items.length === 0) return [];

      // Two habits off the real menu, on different evidence — so a test can tell "the
      // block is the menu's words" apart from "the block is whatever came back".
      return [
        { slug: 'opens-on-the-mistaken-instinct', items },
        { slug: 'closes-on-a-procedure', items: items.slice(0, 1) },
      ];
    },

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

    async group(stage, digest): Promise<MergeGroup[]> {
      calls.push({ kind: stage, mode: 'merge', digest });
      if (options.throws) throw options.throws;

      const indices = indicesFromDigest(digest);
      if (options.groupsFor) return options.groupsFor(indices, stage);

      // Group nothing. A merge that finds no duplicates is the well-behaved answer, and it
      // leaves every layer a test asserts on exactly as its passes returned it.
      return [];
    },

    async cluster(digest): Promise<ClusteredPosition[]> {
      calls.push({ kind: 'positions', mode: 'pass', digest });
      if (options.throws) throw options.throws;

      const claims = refsFromDigest(digest);
      if (options.positionsFor) return options.positionsFor(claims);
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

    async synthesise(kind, digest): Promise<SynthesisedEntry[]> {
      calls.push({ kind, mode: 'pass', digest });
      if (options.throws) throw options.throws;

      const items = idsFromDigest(digest);
      if (options.entriesFor) return options.entriesFor(kind, items);

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

/** The claim refs braintrust issued, read back out of the digest it handed over. */
export function refsFromDigest(digest: string): string[] {
  return [...digest.matchAll(/^\[(c\d+)\]/gm)].map((match) => match[1]!);
}

/** The pair refs braintrust issued, read back out of the digest it handed over. */
export function pairsFromDigest(digest: string): string[] {
  return [...digest.matchAll(/^\[(p\d+)\]/gm)].map((match) => match[1]!);
}

/**
 * The indices braintrust numbered the merge's input with. The merge is handed wording and
 * nothing else, so this is the whole of what a grouping answer may name.
 */
export function indicesFromDigest(digest: string): number[] {
  return [...digest.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
}

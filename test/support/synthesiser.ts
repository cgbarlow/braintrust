/**
 * A synthesiser that behaves like a good model and never calls one.
 *
 * It reads the `[id]` markers back out of the digest it was handed and attributes its
 * entries to them, so a test can assert on attribution without pretending the ids came
 * from anywhere braintrust did not put them. `entriesFor` overrides that for the tests
 * that need a model behaving badly — inventing an item, or returning nothing at all.
 */

import type {
  InferredKind,
  SynthesisedEntry,
  SynthesisMode,
  Synthesiser,
} from '../../src/compile/synthesis.js';

export type FakeCall = { kind: InferredKind; mode: SynthesisMode; digest: string };

export type FakeSynthesiser = Synthesiser & { calls: FakeCall[] };

export type FakeOptions = {
  generation?: string;
  /** Replaces the default answer. Given the ids the digest actually carried. */
  entriesFor?: (kind: InferredKind, items: string[], mode: SynthesisMode) => SynthesisedEntry[];
  /** Throws instead of answering — an endpoint that went away mid-compile. */
  throws?: Error;
};

export function fakeSynthesiser(options: FakeOptions = {}): FakeSynthesiser {
  const calls: FakeCall[] = [];

  return {
    generation: options.generation ?? 'test-model@core-1',
    model: 'test-model',
    url: 'https://example.test/v1/chat/completions',
    calls,

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

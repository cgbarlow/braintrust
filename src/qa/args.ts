/**
 * The command line, kept apart from the entry point so it can be tested — the same
 * reason ../eval/args.ts is.
 */

/** ~10 real questions is enough to separate a good answer from a bad one without a bill. */
export const DEFAULT_SAMPLE = 10;

/**
 * How many persona titles feed one persona's near-miss set. Bounded like the golden sample
 * so the negative columns cost the same run as the judged one.
 */
export const DEFAULT_NEAR_MISS = 6;

export function readArgs(argv: string[]): {
  person?: string | undefined;
  sample: number;
  nearMiss: number;
  negative: boolean;
} {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const sample = Number(value('sample') ?? DEFAULT_SAMPLE);
  return {
    person: value('person'),
    sample: Number.isFinite(sample) && sample > 0 ? Math.trunc(sample) : DEFAULT_SAMPLE,
    nearMiss: readCount(value('near-miss'), DEFAULT_NEAR_MISS),
    negative: !argv.includes('--no-negative'),
  };
}

function readCount(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

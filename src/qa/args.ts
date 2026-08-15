/**
 * The command line, kept apart from the entry point so it can be tested — the same
 * reason ../eval/args.ts is.
 */

/** ~10 real questions is enough to separate a good answer from a bad one without a bill. */
export const DEFAULT_SAMPLE = 10;

export function readArgs(argv: string[]): { person?: string | undefined; sample: number } {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const sample = Number(value('sample') ?? DEFAULT_SAMPLE);
  return {
    person: value('person'),
    sample: Number.isFinite(sample) && sample > 0 ? Math.trunc(sample) : DEFAULT_SAMPLE,
  };
}

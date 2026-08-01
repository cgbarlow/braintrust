/**
 * The command line, kept apart from the entry point so it can be tested.
 *
 * `index.ts` runs on import — that is what an entry point is — so anything a test needs to
 * reach lives here instead.
 */

/** Enough to separate two models on this Corpus without spending an evening on it. */
export const DEFAULT_SAMPLE = 30;

export function readArgs(argv: string[]): {
  model?: string | undefined;
  baseUrl?: string | undefined;
  sample: number;
  dry: boolean;
} {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  const sample = Number(value('sample') ?? DEFAULT_SAMPLE);
  return {
    model: value('model'),
    baseUrl: value('base-url'),
    sample: Number.isFinite(sample) && sample > 0 ? Math.trunc(sample) : DEFAULT_SAMPLE,
    dry: argv.includes('--dry'),
  };
}

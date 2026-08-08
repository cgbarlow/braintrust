/**
 * Configuration. braintrust is configured by environment and nothing here has a
 * default that could act on its own.
 *
 * See docs/design/deployment.md §3.
 */

export type EmbeddingsConfig = {
  /** An OpenAI-compatible endpoint. Ollama, LM Studio, vLLM and OpenAI all speak it. */
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
};

/**
 * The Note extractor: the one genuinely expensive job in braintrust. Standing a
 * Persona up from nothing costs a few dollars here and about three cents everywhere
 * else, which is why the model is the operator's to choose rather than braintrust's.
 */
export type ExtractorConfig = {
  /** An OpenAI-compatible `/v1/chat/completions` endpoint. */
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
};

/**
 * Where braintrust files a fault only a person can clear.
 *
 * **Optional, and its absence is loud rather than fatal.** braintrust runs unattended; making
 * this required would stop a deployment from starting over a channel it may never need. What
 * it must not do is fail quietly, so an unconfigured deployment prints the whole issue to the
 * job log on every run until somebody either configures a tracker or ships the fix. See
 * ./interrogate/issues.ts.
 */
export type IssuesConfig = {
  /** `owner/repo` on GitHub. */
  repo: string;
  /** A token with `issues: write` on that repo. */
  token: string;
};

export type Config = {
  /** Supabase session pooler, port 5432. Not PostgREST. */
  databaseUrl: string;
  /** The shared secret clients present as `?key=`. Guards the read path only. */
  mcpKey: string;
  embeddings: EmbeddingsConfig;
  extractor: ExtractorConfig;
  /** Absent when nobody said where a fault should go. */
  issues?: IssuesConfig | undefined;
  port: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Why each of these is required rather than defaulted. The embeddings entry is
 * the one that matters most: a default there would mean a first run silently
 * shipping someone's entire published corpus to a third party.
 */
const REQUIRED: Record<string, string> = {
  BRAINTRUST_DATABASE_URL:
    "Postgres connection string. Use Supabase's session pooler (port 5432) — braintrust " +
    'connects directly rather than through PostgREST, because promoting a compile is a ' +
    'multi-statement transaction.',
  BRAINTRUST_MCP_KEY:
    'Shared secret that clients present as ?key=. Guards the read path only; the ' +
    'scheduled job talks to Postgres and never touches the MCP surface.',
  BRAINTRUST_EMBEDDINGS_BASE_URL:
    'An OpenAI-compatible /v1/embeddings endpoint — Ollama, LM Studio, vLLM, OpenAI. ' +
    'There is no default, ever: a default would mean a first run silently shipping an ' +
    'entire corpus to a third party. The docs recommend qwen3-embedding:0.6b at 1024 dims.',
  BRAINTRUST_EMBEDDINGS_MODEL:
    'The model name to send to that endpoint. Must be the model whose vectors are already ' +
    'in braintrust_embeddings — cosine similarity across model families is meaningless ' +
    'even when the dimensions match.',
  BRAINTRUST_EXTRACTOR_BASE_URL:
    'An OpenAI-compatible /v1/chat/completions endpoint for the Note extractor — the one ' +
    'genuinely expensive job in braintrust. No default, for the same reason as the ' +
    'embeddings endpoint: it is handed whole published items, and where they go is the ' +
    "operator's decision to make rather than braintrust's to assume.",
  BRAINTRUST_EXTRACTOR_MODEL:
    'The model that reads each item once and writes down what it said. Part of the ' +
    'extractor generation, so changing it re-reads the corpus alongside the old notes ' +
    'rather than migrating them. Required because a braintrust that cannot write notes ' +
    'cannot compile a persona, and a daily job that silently never distils is exactly ' +
    'the invisible failure the schedule exists to prevent.',
};

/** Supabase's transaction pooler, built for the serverless case braintrust declined. */
const TRANSACTION_POOLER_PORT = '6543';

export type LoadOptions = {
  /** Where to send the session-pooler advisory. Defaults to console.warn. */
  warn?: (message: string) => void;
};

/**
 * Reads configuration, or throws. Every missing variable is reported at once —
 * discovering them one restart at a time is a waste of the operator's evening.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadOptions = {}): Config {
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const missing = Object.keys(REQUIRED).filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    const detail = missing.map((name) => `  ${name}\n      ${REQUIRED[name]}`).join('\n\n');
    throw new ConfigError(
      `braintrust refuses to start: ${missing.length} required setting${
        missing.length === 1 ? ' is' : 's are'
      } missing.\n\n${detail}\n\nSee docs/design/deployment.md §3 and .env.example.`,
    );
  }

  const databaseUrl = env.BRAINTRUST_DATABASE_URL!.trim();
  if (usesTransactionPooler(databaseUrl)) {
    warn(
      `braintrust: the connection string points at port ${TRANSACTION_POOLER_PORT}, Supabase's ` +
        'transaction pooler. braintrust wants the session pooler (5432): it holds persistent ' +
        'connections and supports prepared statements, which is the right fit for a long-lived ' +
        'server and a long-running job. Continuing anyway.',
    );
  }

  const port = parsePort(env.PORT, warn);

  return {
    databaseUrl,
    mcpKey: env.BRAINTRUST_MCP_KEY!.trim(),
    embeddings: {
      baseUrl: env.BRAINTRUST_EMBEDDINGS_BASE_URL!.trim(),
      model: env.BRAINTRUST_EMBEDDINGS_MODEL!.trim(),
      apiKey: env.BRAINTRUST_EMBEDDINGS_API_KEY?.trim() || undefined,
    },
    extractor: {
      baseUrl: env.BRAINTRUST_EXTRACTOR_BASE_URL!.trim(),
      model: env.BRAINTRUST_EXTRACTOR_MODEL!.trim(),
      apiKey: env.BRAINTRUST_EXTRACTOR_API_KEY?.trim() || undefined,
    },
    // Both or neither. A repo with no token cannot file and a token with no repo has
    // nowhere to file to, and half a channel that looks configured is worse than none.
    issues:
      env.BRAINTRUST_ISSUES_REPO?.trim() && env.BRAINTRUST_ISSUES_TOKEN?.trim()
        ? {
            repo: env.BRAINTRUST_ISSUES_REPO.trim(),
            token: env.BRAINTRUST_ISSUES_TOKEN.trim(),
          }
        : undefined,
    port,
  };
}

function usesTransactionPooler(databaseUrl: string): boolean {
  try {
    return new URL(databaseUrl).port === TRANSACTION_POOLER_PORT;
  } catch {
    // Not our job to validate the URL — pg will complain more usefully than we can.
    return false;
  }
}

function parsePort(raw: string | undefined, warn: (message: string) => void): number {
  if (!raw?.trim()) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warn(`braintrust: PORT="${raw}" is not a usable port number. Falling back to 3000.`);
    return 3000;
  }
  return port;
}

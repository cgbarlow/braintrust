/**
 * A rules change rebuilds the Persona, and readers never wait.
 *
 * braintrust watched two clocks and only one existed. New content triggered a rebuild; a
 * rules change triggered nothing, reported nothing and was watched by nothing — one Persona
 * in the live fleet differed on one part of its compiler version for three days.
 *
 * **The catch happens on the read, not on a clock.** Loading a Persona compares its version
 * against the running compiler's. What that comparison changes is immediate and happens
 * *for the reader who arrived*: the gate tightens ([find.ts](./find.ts)) and prose written
 * under rules that have moved is withheld ([personas.ts](./personas.ts)). So the staleness
 * window is **zero for anyone actually reading** — nobody is ever served a Persona built
 * under rules braintrust has since changed.
 *
 * **The rebuild is queued behind them, never in front.** It is started after the answer has
 * been handed over and nothing awaits it, because the alternative is the one thing this
 * must not become: a read call with the most expensive action in the product behind it. A
 * reader who triggers a rebuild pays nothing for it and does not see it.
 *
 * **A rules change rebuilds the whole Persona.** The compound version records *what* moved;
 * it does not license acting on it piecemeal. Parts decide what is served in the meantime
 * and nothing else — see compile/version.ts.
 *
 * **At most one rebuild in flight per Persona.** A burst of readers on a behind-version
 * Persona must not stampede the compiler, so this holds a process-local set *and* the
 * database's own `unique … where status = 'running'` decides. The set is the cheap guard;
 * the index is the true one, and it works across the two deployments that share the
 * database.
 *
 * See docs/design/compiler.md §3 and docs/design/mcp-surface.md §2.
 */

import { compileCorpus, type Synthesiser } from './compile/index.js';
import { movedParts } from './compile/version.js';
import type { TransactionalDb } from './db.js';
import type { Embedder } from './retrieval/embed.js';

export type RebuildDeps = {
  db: TransactionalDb;
  /** A Compile declares which generation of Notes it read, so this is not optional. */
  extractor: string;
  synthesiser: Synthesiser;
  embedder?: Embedder | undefined;
  log?: ((line: string) => void) | undefined;
};

export type RebuildQueue = {
  /**
   * Rebuild this Persona if its rules have moved, behind whatever the caller is doing.
   *
   * Returns whether a rebuild was started, so a test can prove the decision without
   * waiting on the work. **Callers do not await the rebuild itself** — that is the whole
   * point — so this resolves as soon as the queue has decided.
   */
  requestIfBehind(person: string, version: string | null): Promise<boolean>;
  /** Rebuilds started and not yet finished. The reader-facing stampede guard. */
  inFlight(): string[];
};

export function createRebuildQueue(deps: RebuildDeps): RebuildQueue {
  const running = new Set<string>();
  const log = deps.log ?? ((line: string) => console.log(line));

  return {
    inFlight: () => [...running].sort(),

    async requestIfBehind(person, version): Promise<boolean> {
      if (movedParts(version).length === 0) return false;
      // The cheap guard. The database's `running` index is the real one, and
      // `compileCorpus` reaches it — this only keeps a burst of readers from all
      // getting that far.
      if (running.has(person)) return false;

      running.add(person);
      log(
        `braintrust: ${person} is serving on rules that have moved — rebuilding behind the ` +
          'reader, who is not waiting for it.',
      );

      // Deliberately not awaited by the caller. A failure is logged and dropped: the
      // Persona already serving is untouched, the next reader asks again, and the daily
      // sweep asks whether anyone reads or not.
      void compileCorpus({
        db: deps.db,
        extractor: deps.extractor,
        synthesiser: deps.synthesiser,
        embedder: deps.embedder,
        person,
        log,
      })
        .catch((error: Error) => {
          log(
            `braintrust: the rebuild of ${person} did not finish — ${error.message}. The ` +
              'persona already serving is untouched and the next run tries again.',
          );
        })
        .finally(() => running.delete(person));

      return true;
    },
  };
}

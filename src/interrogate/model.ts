/**
 * The model braintrust interrogates itself with.
 *
 * **The point of this file is that it has no tools.** A persona holding the Script and
 * nothing to look anything up with is the condition every assertion here is about — the
 * founding observation of this map was a model that could not reach
 * `braintrust_find_positions` and answered fluently anyway. So the interrogation reproduces
 * that condition rather than simulating it: one chat call, a Script, a question, no
 * functions declared.
 *
 * The same endpoint as the extractor and the synthesiser, and configured with them, for the
 * reason those two share one: an operator who has decided where their corpus may go has
 * decided it for every model braintrust talks to.
 */

import { chatUrl } from '../compile/synthesis.js';
import { BraintrustError } from '../errors.js';
import type { ExtractorConfig } from '../config.js';
import { fetchPatiently, type Fetcher } from '../net/fetch.js';
import { INTERROGATION_VERSION, type Interrogation, type Interrogator, type Verdict } from './assertions.js';

/**
 * The system prompt a client would have. **Deliberately the shape of a real harness**, not a
 * kinder one: it says speak as the persona, and it does not repeat any of the rules the
 * Script is supposed to carry on its own. An interrogation that reminded the model to
 * disclose, or not to invent, would pass by supplying exactly the thing it is testing for.
 */
const HARNESS = 'Answer as the persona described below. Reply in prose, as they would.';

/**
 * The judge's prompt.
 *
 * **It never sees the Script and never sees the question**, only the rubric and the reply. A
 * judge shown the persona is being asked whether the answer is good; this one is asked
 * whether one stated property holds of one piece of text, which is the narrowest form the
 * question comes in. Whether that is narrow enough is
 * https://github.com/cgbarlow/braintrust/issues/155 and is open.
 */
const JUDGE = `You are checking whether one statement is true of one reply. Answer only about the statement given.

Return one JSON object: {"holds": true|false, "why": "<one sentence>"}.

"holds" is true only if the statement is plainly true of the reply. If it is arguable, answer false — a wrong "true" here hides a fault in a live system, and a wrong "false" costs a maintainer one issue to read.`;

export function createInterrogator(
  config: ExtractorConfig,
  fetcher: Fetcher,
  pause?: (ms: number) => Promise<void>,
): Interrogator {
  const url = chatUrl(config.baseUrl);

  async function ask(system: string, user: string, job: string): Promise<string> {
    let response;
    try {
      response = await fetchPatiently(
        fetcher,
        url,
        {
          json: {
            model: config.model,
            // Not because it makes the answer reproducible — measured, it does not — but
            // because an interrogation that varied on temperature would be measuring the
            // sampler on top of everything else it cannot pin down.
            temperature: 0,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          },
          ...(config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {}),
        },
        pause,
      );
    } catch (error) {
      throw new BraintrustError(
        `braintrust could not reach the interrogator at ${url} while asking ${job}: ` +
          `${(error as Error).message}. Nothing was concluded, and no fault was opened — an ` +
          'endpoint braintrust cannot reach is not evidence that a persona is inventing claims.',
      );
    }

    if (!response.ok) {
      throw new BraintrustError(
        `The interrogator at ${url} answered HTTP ${response.status} for model ` +
          `"${config.model}" while asking ${job}.`,
      );
    }

    const body = await response.text();
    let parsed: { choices?: { message?: { content?: unknown } }[] };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new BraintrustError(
        `The interrogator at ${url} did not return JSON while asking ${job}.`,
      );
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new BraintrustError(`The interrogator at ${url} returned no content for ${job}.`);
    }
    return content;
  }

  return {
    generation: `${config.model}@${INTERROGATION_VERSION}`,

    async reply(exchange: Interrogation): Promise<string> {
      return ask(HARNESS, exchangeAsUserTurn(exchange), 'a persona to answer');
    },

    async judge(rubric: string, reply: string): Promise<Verdict> {
      const content = await ask(
        JUDGE,
        `STATEMENT\n${rubric}\n\nREPLY\n${reply}`,
        'a reply to be judged',
      );
      return readVerdict(content, url);
    },
  };
}

/**
 * One user turn carrying the Script, whatever the tool returned, and the question.
 *
 * **The tool result is present or the tool is absent — there is no third state**, because
 * that is the distinction two of the four assertions turn on. A `found` of null renders as
 * no tool at all rather than as an empty result, which is the difference between *braintrust
 * holds nothing on this* and *braintrust could not be asked*.
 */
export function exchangeAsUserTurn(exchange: Interrogation): string {
  return [
    exchange.speak,
    '',
    exchange.found === null
      ? 'You have no way to look anything up. There is no search tool available to you in this conversation.'
      : `You searched the record and it returned:\n\n${JSON.stringify(exchange.found, null, 2)}`,
    '',
    exchange.question,
  ].join('\n');
}

function readVerdict(content: string, url: string): Verdict {
  const json = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');

  let parsed: { holds?: unknown; why?: unknown };
  try {
    parsed = JSON.parse(start >= 0 && end > start ? json.slice(start, end + 1) : json) as typeof parsed;
  } catch {
    throw new BraintrustError(
      `The interrogation judge at ${url} returned something that is not a JSON object: ` +
        `${content.slice(0, 200)}`,
    );
  }

  if (typeof parsed.holds !== 'boolean') {
    throw new BraintrustError(
      `The interrogation judge at ${url} did not answer with a boolean verdict: ` +
        `${content.slice(0, 200)}`,
    );
  }

  return {
    holds: parsed.holds,
    why: typeof parsed.why === 'string' && parsed.why.trim() !== '' ? parsed.why.trim() : 'no reason given',
  };
}

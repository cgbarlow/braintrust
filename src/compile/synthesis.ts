/**
 * The model call behind everything a Compile does not measure.
 *
 * **Nothing here reads an Item.** The extractor read each Item once and wrote down what
 * it said; this reads those Notes. That is the whole economics of a daily rebuild — a
 * Compile costs a handful of calls over notes rather than a re-read of 1.17M words — and
 * it is also why a through-line can exist at all. A conviction cannot be extracted per
 * Item: belief-marker mining was tested and most of what it found explained a mechanism
 * rather than stated a conviction. A conviction is what has to be true for many claims to
 * make sense, so the only place it can be seen is across them.
 *
 * **No prompt here writes a layer any more.** The one that used to write Beliefs now
 * produces [through-lines](./throughlines.ts) — claims that have to be retrieved rather
 * than a standing brief a persona recites — and Reasoning is chosen from
 * [an authored menu](./habits.ts) rather than written at all. What is left is four
 * questions about a Corpus, none of whose answers reach a reader unasked.
 *
 * **The prompts are a starting point, not a finding**, exactly as the extractor's is, and
 * they are versioned for the same reason: changing one changes what a Persona says, so
 * the version travels on the Compile row rather than being inferred from whatever is
 * configured now.
 *
 * See docs/design/compiler.md §2 and §3.
 */

import type { ExtractorConfig } from '../config.js';
import { MENU, type ChosenHabit } from './habits.js';

export type { ChosenHabit } from './habits.js';
import { BraintrustError } from '../errors.js';
import { fetchPatiently, type Fetcher } from '../net/fetch.js';
import { isEventStream, joinStream } from '../net/stream.js';

/**
 * Bumping this changes the prose a Persona is built from, so it is part of
 * `compiler_version` — which is on the Compile row and travels out through both read
 * tools. Unlike the extractor generation, bumping this is cheap: it re-synthesises from
 * Notes that already exist rather than re-reading the Corpus.
 */
export const SYNTHESIS_VERSION = 'core-3';

/**
 * Versioned apart from the Core's prompts, because it answers a different question and
 * changes for different reasons. Both travel in `compiler_version`, so a Persona says
 * which prompt wrote its Core prose *and* which one grouped its Positions.
 *
 * **It covers how a Position is built, not only the prompt that grouped it** — the
 * per-call bound and the confidence thresholds ride here too, which is what makes tuning
 * any of them a rebuild rather than a silent change of meaning. `positions-2` is the burst
 * cap: the same claims, the same clustering, a grade that now reads the dates.
 */
export const POSITION_VERSION = 'positions-2';

/**
 * Versioned apart again, for the same reason and a sharper one: this is the only prompt
 * whose output can change what a Persona *stops* saying. A Compile says which prompt
 * decided that one Position supersedes another, because that decision is the one a Person
 * would most want to argue with.
 */
export const REVISION_VERSION = 'revisions-1';

/**
 * Versioned apart again, because this prompt does not write anything.
 *
 * `habits-1` is the menu. The Reasoning layer used to ask for a free description and keep
 * whatever cleared a three-item floor; it now chooses from
 * [an authored menu](./habits.ts) and the compile renders that menu's own words. The
 * version rides here so that adding a habit to the menu — which changes what every Persona
 * can say about how somebody argues — rebuilds the fleet rather than changing meaning
 * silently.
 */
export const HABITS_VERSION = 'habits-1';

/** Synthesis is a long read for a model, like the extractor's. Not a 20-second fetch. */
/**
 * Thirty minutes, and the number is measured rather than chosen.
 *
 * 900_000 (fifteen minutes) was the first measurement, sized when the worst observed case
 * was clustering 183 claims. It was too short for the largest Corpus in the fleet: on the
 * 2026-08-15 16:20 NZST run, `nate-b-jones` ran seven `positions` passes at
 * 225s/178s/514s/179s/465s/188s/296s — two of them already past half the old ceiling — and
 * the next call hit it, discarding a Compile that had done 98 minutes and 38 model calls of
 * work. 1_800_000 is sized against the measured maximum (514s) with real headroom, not
 * against the one that failed.
 *
 * **This buys a wider margin, not resilience.** A Compile is still one all-or-nothing unit:
 * a timeout still discards every stage that already succeeded, including the six passes
 * that finished in the run above. Raising the ceiling stops the *common* case from being
 * lost to a margin that was too tight; it does nothing for the stage that is genuinely
 * slower than this. That resilience — keeping the stages that already succeeded — is
 * #290, and this ticket does not attempt it.
 *
 * The run above is the real budget: 98 minutes end to end against one endpoint, not the
 * "half an hour" this comment used to claim. This runs in an unattended job with no reader
 * waiting on it, so long is still the right direction, and a timeout still does not lose
 * the Notes — it costs a rebuild the next run makes anyway.
 */
export const SYNTHESIS_TIMEOUT_MS = 1_800_000;

/** One inferred conviction, and the Items it was traced to. */
export type SynthesisedEntry = {
  label: string;
  body: string;
  /** Item `external_id`s. Verified against the Notes that were handed over, never trusted. */
  items: string[];
};

/**
 * One Position, as the model returns it: a grouping of claims and a sentence saying what
 * they share. **The claims are the evidence and they are braintrust's own** — the model is
 * given ids it may only copy, and every quote a Position ends up citing was located in the
 * stored body when the Item was read. What a model contributes here is which claims belong
 * together and how to say it in one line.
 */
export type ClusteredPosition = {
  slug: string;
  statement: string;
  /** Claim refs, copied from the digest. Anything else is dropped before a row is written. */
  claims: string[];
};

/**
 * One judgement on one candidate pair. `none` is the answer the prompt expects most of
 * the time — two Positions can be near neighbours in a vector space and have nothing to
 * say about each other — and it is the answer that writes no row.
 */
export type JudgedPair = {
  /** The pair ref braintrust issued. Anything else is dropped before a row is written. */
  pair: string;
  relation: 'revised' | 'unsettled' | 'drifting' | 'none';
  rationale: string;
};

/**
 * The merge's whole answer: which entries say the same thing, and which of them says it
 * clearest. **No citation appears here in either direction** — the merge was handed
 * wording and indices, so the union of the evidence is braintrust's arithmetic rather than
 * a model's copying. A `members` list of one is legal and meaningless; it merges nothing.
 */
export type MergeGroup = {
  /** Indices into the list the merge was handed, numbered from 1. */
  members: number[];
  /** The member whose wording is kept word for word. The others' text is discarded. */
  clearest: number;
};

/** Which stage a merge belongs to. Only the job label a run reports depends on it. */
export type MergeStage = 'through_lines' | 'positions';

export type Synthesiser = {
  /** `model@prompt-version`. Half of `compiler_version`; the other half is the measurement. */
  generation: string;
  /** `model@positions-version`. The growing layer says which prompt grouped it. */
  clusterer: string;
  /** `model@habits-version`. Which menu a persona's argument habits were chosen from. */
  habits: string;
  /** `model@revisions-version`. Which prompt decided a Position was superseded. */
  judge: string;
  model: string;
  url: string;
  /**
   * What this person broadly holds, read across one division of the Corpus.
   *
   * **No kind any more.** This used to be keyed by which layer it was writing, and both
   * layers have gone: Reasoning is chosen from the menu, and Beliefs stopped being a layer
   * at all. What survives is the one question whose answer has to be earned at retrieval
   * time. See ./throughlines.ts.
   */
  synthesise(digest: string): Promise<SynthesisedEntry[]>;
  /** The growing layer. Same endpoint, a second question: which claims are one position? */
  cluster(digest: string): Promise<ClusteredPosition[]>;
  /**
   * The merge, for both of the questions above.
   *
   * **Its own call rather than a mode of the two above**, because it now returns groups
   * where they return entries: keeping it a mode would give both of them a mode-dependent
   * return type that every caller has to narrow. What the mode still earns its keep for is
   * the job label a run reports, which is where a pass and the merge after it have always
   * been told apart. See ./merge.ts.
   */
  group(stage: MergeStage, digest: string): Promise<MergeGroup[]>;
  /**
   * How this person argues, chosen from the menu rather than written.
   *
   * The one call on this surface whose answer braintrust does not render: it comes back as
   * slugs and Item ids, and the prose a reader gets is authored in ./habits.ts. A model
   * that returns something off the menu has returned nothing.
   */
  chooseHabits(digest: string): Promise<ChosenHabit[]>;
  /** The fourth question, and the only one that can take something off the record. */
  judgePairs(digest: string): Promise<JudgedPair[]>;
};

/**
 * A pass reads the Corpus; a merge reads what the passes wrote. They are two questions on
 * two prompts now, and this survives as the half of a stage a failure message names — a
 * pass is long because the Corpus is large, the merge because the passes were many.
 */
export type SynthesisMode = 'pass' | 'merge';

/**
 * How many entries a layer may carry. The Core is bounded on purpose — it is what a
 * client loads whole to sound like someone, and a Core that grows with the Corpus stops
 * being affordable to regenerate, which is what the no-drift guarantee rests on.
 */
export const MAX_ENTRIES = 8;

const SHARED = [
  'Return a single JSON object, and nothing else:',
  '',
  '{ "entries": [ { "label": "...", "body": "...", "items": ["item-id", ...] } ] }',
  '',
  `At most ${MAX_ENTRIES} entries, the best-supported first.`,
  '',
  'items — the ids of the items this entry is visible in, copied exactly from the [id] markers',
  '  in the notes below. Only ids you were actually given: an id that is not among them will be',
  '  dropped, and an entry left with none will be dropped with it.',
  '',
  'Do not flatter and do not grade. This describes a method, not a review of one.',
  'Do not describe the subject matter. Two people writing about the same field think',
  '  differently, and that difference is the only thing here worth having.',
  'If the notes do not support an entry across several items, leave it out. A short list that',
  '  is really there beats a long one that is partly hoped for.',
].join('\n');

/**
 * One prompt, where there were two.
 *
 * **The Reasoning prompt is gone with the free description it wrote.** *How they get there*
 * is now chosen from [an authored menu](./habits.ts), so there is nothing left here to ask
 * a model about it — and the Note still carries the argument and the assumptions, because
 * that is what the menu is chosen against.
 *
 * What is left is *what they take as true on the way*, asked once per reading of the Corpus
 * rather than once per Compile. The wording is unchanged from the prompt that wrote the
 * Beliefs layer: the question was never the problem. What changed is where the answer goes
 * — a through-line has to be retrieved beside something quotable rather than pre-loaded
 * into a Script — so nothing here reaches a reader who did not ask.
 */
export const THROUGH_LINE_PROMPT = [
  "You are reading braintrust's own notes on many published items by one author — the claims",
  'each item makes and what each argument assumes. No single item asserts a conviction; a',
  'conviction is what has to be true for many claims to make sense. Inferring those is the job.',
  '',
  SHARED,
  '',
  'Each entry is one conviction this person holds and argues from, rather than a topic they',
  'cover.',
  '  label: the conviction in one short sentence, as they would put it.',
  '  body: two or three sentences — what they hold, and what they do with it.',
  '',
  'A claim is made in one item. Prefer convictions that show up across items in different',
  '  words to ones stated loudly once.',
  'Stay inside the published work. Do not infer anything about this person\'s private life,',
  '  their politics or their character from work that is about something else.',
].join('\n');

/**
 * The merge prompt, and the only one shared by both synthesised questions.
 *
 * **It asks for judgement and nothing else.** Deciding that two differently-worded entries
 * say the same thing is the one part of a merge that has no right answer in code; the union
 * of their evidence has one, so braintrust does that itself. The model is shown wording,
 * answers with indices, and never sees a citation — which is why nothing downstream has to
 * check a merge for refs it invented.
 *
 * Grouping rather than rewriting is also what keeps a Persona's prose its own: the merge
 * selects which existing entry survives, so what a reader reads was always written by a
 * pass that actually read the evidence behind it.
 */
export const MERGE_PROMPT = [
  "You are reading entries braintrust produced by reading one author's published work in",
  'several passes. The passes could not see each other, so the same entry may appear more',
  'than once in different words. Finding those is the job.',
  '',
  'Each line is one entry: the index braintrust gave it, and its wording. The evidence behind',
  'each entry stays with braintrust and is not your concern.',
  '',
  'Return a single JSON object, and nothing else:',
  '',
  '{ "groups": [ { "members": [3, 11, 24], "clearest": 11 } ] }',
  '',
  'groups — one per set of entries that say the same thing in different words. An entry that',
  '  says something none of the others say belongs to no group: leave it out rather than',
  '  giving it a group of its own. An empty list is the right answer when nothing repeats.',
  'members — the indices in the group, copied exactly from the [n] markers. Only indices you',
  '  were given: one that is not among them will be dropped, and a group left with none will',
  '  be dropped with it. An index belongs to one group only.',
  'clearest — the member a reader would understand best. Its wording is kept word for word',
  '  and the others are discarded, so choose the clearest rather than the longest.',
  '',
  'Group only what asserts the same thing. Two entries about the same subject that assert',
  '  different things are two entries, and collapsing them would put a view on the record',
  '  that nobody stated.',
  'You are not writing here. Do not reword an entry, do not compose one that is not in the',
  '  input, and do not return the entries themselves — only their numbers.',
].join('\n');

/**
 * How many Positions one call may return. Unlike the Core's cap this is a per-call bound
 * rather than a bound on the layer: Positions **grow** with the Corpus, and a fold over a
 * large one runs this prompt several times. What it protects against is a model asked for
 * "the positions" answering with one per claim.
 */
export const MAX_POSITIONS = 24;

/**
 * The third prompt, and the only one whose output is checked against something the Person
 * actually said. Grouping is all it is asked for: the quotes were located in the body when
 * the Item was read, and nothing here can add, edit or reattribute one.
 */
export const POSITION_PROMPT = [
  "You are reading claims braintrust extracted from many published items by one author.",
  'Each line is one claim: the id braintrust gave it, the item it came from, the date it was',
  'published, and what it says.',
  '',
  'Group claims that assert the same thing into positions this person holds.',
  '',
  'Return a single JSON object, and nothing else:',
  '',
  '{ "positions": [ { "slug": "...", "statement": "...", "claims": ["c12", ...] } ] }',
  '',
  `At most ${MAX_POSITIONS} positions, the best-supported first.`,
  '',
  'slug — kebab-case, a few words. Name the position, not the topic it is about.',
  'statement — one sentence saying what this person holds. Plain and specific.',
  'claims — the ids of the claims that assert it, copied exactly from the [id] markers.',
  '  Only ids you were actually given: an id that is not among them will be dropped, and a',
  '  position left with none will be dropped with it.',
  '',
  'Do not group by topic. Two claims about the same subject that assert different things are',
  '  two positions, and collapsing them would put a view on the record that nobody stated.',
  'A position may rest on a single claim. Say it once rather than padding it with claims that',
  '  are merely nearby — the count of items behind a position is what a reader judges it on.',
  'Do not judge whether they are right, and do not soften a claim into something safer.',
].join('\n');

/**
 * The fourth prompt, and the asymmetric one.
 *
 * Three of the four labels cost nothing if they are wrong: `unsettled`, `drifting` and
 * `none` all leave both Positions current and both answers on the record. `revised` takes
 * one off. So the instruction leans the whole way in one direction — when the choice is
 * close, answer `unsettled` — because the error this project cannot absorb is putting a
 * contradiction on a real person's record that they would dispute.
 *
 * See docs/design/compiler.md §4.
 */
export const REVISION_PROMPT = [
  'You are comparing pairs of positions held by the same author at different times, to',
  'decide whether the later one changes the earlier one. Each pair carries the id braintrust',
  'gave it, both positions with the date braintrust can first cite each from, and one thing',
  'the author actually wrote on each side.',
  '',
  'Return a single JSON object, and nothing else:',
  '',
  '{ "judgements": [ { "pair": "p1", "relation": "...", "rationale": "..." } ] }',
  '',
  'pair — copied exactly from the [id] marker. Only ids you were given, and judge each pair',
  '  on its own: a pair id that is not among them will be dropped.',
  'relation — exactly one of:',
  '  revised   — the later position withdraws, narrows or reverses the earlier one, and the',
  '              author says so in their own words. Not "these differ": they changed their',
  '              mind, and a reader could point at where.',
  '  unsettled — the two are in real tension and nothing here resolves it. Both may still',
  '              be held.',
  '  drifting  — the emphasis moved over time, without either position being withdrawn.',
  '  none      — nothing worth recording. Two ways of saying the same thing, two different',
  '              subjects, and a later restatement that adds nothing are all none.',
  'rationale — one sentence, written for a reader who is looking at both positions. Say what',
  '  moved, in the author\'s own terms. For revised, name the words that show the change.',
  '',
  'Most pairs are none. They reached you because they were near neighbours, which is a fact',
  '  about wording and not about disagreement.',
  'revised is the only label that changes what this persona says — it takes the earlier',
  '  position off the record as a current view. Use it only where a reader shown both would',
  '  agree the author changed their mind. **If you are weighing revised against unsettled,',
  '  answer unsettled.** A rephrase recorded as a reversal puts a contradiction on a real',
  '  person\'s record that they would dispute, and that is a worse error than a revision you',
  '  did not catch.',
  'Do not judge whether either position is right, and do not resolve the tension yourself.',
].join('\n');

export function createSynthesiser(
  config: ExtractorConfig,
  fetcher: Fetcher,
  pause?: (ms: number) => Promise<void>,
  /**
   * One line per call, for a job nobody is watching.
   *
   * **What it exists to answer is which call is slow, not that the compile was.** A Compile
   * makes many model calls and reports one outcome, so a rebuild that dies against a time
   * limit names the stage — `positions` — and nothing else. That stage is several passes
   * *and* the merge that follows them, and those two fail for opposite reasons: a pass is
   * long because the Corpus is large, and the merge is long because the passes were many.
   * Cutting the digest budget helps the first and hurts the second, so guessing between
   * them costs a rebuild each time. A duration and a size per call settles it in one run.
   */
  log?: (line: string) => void,
): Synthesiser {
  const url = chatUrl(config.baseUrl);

  /**
   * One call to the endpoint, whichever question is being asked. `job` appears in the
   * failure messages, because "which of the three model calls in a Compile went wrong" is
   * the first thing anyone reading a cron log at 3am needs.
   */
  async function ask(system: string, digest: string, job: string): Promise<string> {
    let response;
    let body: string;
    const started = Date.now();
    try {
      response = await fetchPatiently(fetcher, url, {
        json: {
          model: config.model,
          // Two Compiles over an unchanged Corpus should not disagree about how
          // someone thinks. A rebuild is a replacement, so any variety here would
          // read as the person having changed.
          temperature: 0,
          // The same declaration the extractor makes, for the same reason. All four
          // prompts on this surface ask for one JSON object; the request now says so too.
          response_format: { type: 'json_object' },
          // **Streamed so the connection is never silent, not so anything is shown.**
          // braintrust reads the whole answer before it does anything with it, so the
          // deltas buy it nothing — but a synthesis pass carries up to CLAIM_BUDGET_CHARS
          // and can spend minutes generating, and a non-streamed request sends no bytes at
          // all for that whole span. Every reverse proxy has a read timeout (nginx's is 60s
          // by default) and cuts a connection that quiet, which reaches braintrust as
          // `fetch failed` — not a status, not a refusal, nothing to act on. Found live:
          // the largest Corpus in a council failed its rebuild four runs running while
          // every smaller one compiled over the same endpoint in the same run, because only
          // its passes were long enough to trip the clock.
          stream: true,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: digest },
          ],
        },
        ...(config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {}),
      }, pause);
    } catch (error) {
      throw new BraintrustError(
        `braintrust could not reach the synthesiser at ${url} while compiling ${job}: ` +
          `${(error as Error).message}. The notes are already written; the next run rebuilds.`,
      );
    }

    if (!response.ok) {
      throw new BraintrustError(
        `The synthesiser at ${url} answered HTTP ${response.status} for model ` +
          `"${config.model}" while compiling ${job}.`,
      );
    }

    /**
     * **Reading the body is where the waiting is now, so it is inside the same net.**
     * A streamed request answers at the headers and then delivers for as long as the model
     * takes, which moves every slow failure — the client's own timeout most of all — out of
     * the call above and into this line. Found live: a pass aborted at SYNTHESIS_TIMEOUT_MS
     * and the run reported bare words with no endpoint, no stage, and no word about the
     * notes being safe, because this was the one step outside the wrapping.
     */
    try {
      body = await response.text();
    } catch (error) {
      throw new BraintrustError(
        `braintrust lost the synthesiser at ${url} while compiling ${job} after ` +
          `${Math.round((Date.now() - started) / 1000)}s of a ${digest.length.toLocaleString()}-character ` +
          `digest: ${(error as Error).message}. The notes are already written; the next run rebuilds.`,
      );
    }

    log?.(
      `braintrust: ${job} — ${digest.length.toLocaleString()} chars in, ` +
        `${answerLength(body).toLocaleString()} chars out, ${Math.round((Date.now() - started) / 1000)}s.`,
    );
    return readContent(body, url, job);
  }

  return {
    generation: `${config.model}@${SYNTHESIS_VERSION}`,
    habits: `${config.model}@${HABITS_VERSION}`,
    clusterer: `${config.model}@${POSITION_VERSION}`,
    judge: `${config.model}@${REVISION_VERSION}`,
    model: config.model,
    url,

    async synthesise(digest): Promise<SynthesisedEntry[]> {
      return readEntryContent(
        await ask(THROUGH_LINE_PROMPT, digest, labelled('through_lines', 'pass')),
        url,
      );
    },

    async cluster(digest): Promise<ClusteredPosition[]> {
      return readClusterContent(await ask(POSITION_PROMPT, digest, labelled('positions', 'pass')), url);
    },

    /**
     * The stage travels into the job label because a pass and the merge that follows it are
     * the two halves of one stage and fail for opposite reasons — a pass is long because the
     * Corpus is large, the merge because the passes were many. A message naming only the
     * stage cannot tell them apart, which is exactly the confusion that cost a live rebuild.
     */
    async group(stage, digest): Promise<MergeGroup[]> {
      return readGroupContent(await ask(MERGE_PROMPT, digest, labelled(stage, 'merge')), url);
    },

    async chooseHabits(digest): Promise<ChosenHabit[]> {
      return readHabitContent(await ask(habitsPrompt(), digest, 'habits'), url);
    },

    async judgePairs(digest): Promise<JudgedPair[]> {
      return readJudgementContent(await ask(REVISION_PROMPT, digest, 'revisions'), url);
    },
  };
}

/**
 * The stage, and which half of it. A pass keeps the bare stage name so every existing
 * message reads as it did; only the merge is marked, because that is the distinction
 * nothing could previously see.
 */
function labelled(stage: string, mode: SynthesisMode): string {
  return mode === 'merge' ? `${stage} (merge)` : stage;
}

export function chatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

type ChatResponse = { choices?: { message?: { content?: unknown } }[] };

function readContent(body: string, url: string, job: string): string {
  if (isEventStream(body)) {
    const streamed = joinStream(body);
    if (streamed.trim() === '') {
      throw new BraintrustError(`The synthesiser at ${url} returned no content for ${job}.`);
    }
    return streamed;
  }

  let parsed: ChatResponse;
  try {
    parsed = JSON.parse(body) as ChatResponse;
  } catch {
    throw new BraintrustError(
      `The synthesiser at ${url} did not return JSON. That usually means the base URL points ` +
        'at something other than an OpenAI-compatible API.',
    );
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new BraintrustError(`The synthesiser at ${url} returned no content for ${job}.`);
  }

  return content;
}

/**
 * The size a call actually answered with — never the size of the wire it answered over.
 *
 * **A streamed answer's raw body is not its length.** Every delta arrives wrapped in its
 * own JSON envelope (`data: {"choices":[{"delta":{"content":"…"}}]}\n\n`), repeated once
 * per chunk a model streams — so a raw byte count is mostly that scaffolding, not prose,
 * and grows with how many pieces the answer was cut into rather than with what it says.
 * Found live: a merge call logged as "39,918 chars in, 715,023 out" reads as a model
 * generating eighteen times its input, when the joined answer behind it is a fraction of
 * that — the same shape {@link readContent} already extracts, computed the same way and
 * never thrown from, because a call worth reporting the size of is not always one whose
 * content parsed.
 */
function answerLength(body: string): number {
  try {
    if (isEventStream(body)) return joinStream(body).length;
    const parsed = JSON.parse(body) as ChatResponse;
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content.length : 0;
  } catch {
    return 0;
  }
}

/** Tolerant about the wrapper — a fenced block, a sentence either side — and nothing else. */
function readObject(content: string, url: string): Record<string, unknown> {
  const json = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');

  try {
    return JSON.parse(start >= 0 && end > start ? json.slice(start, end + 1) : json) as Record<
      string,
      unknown
    >;
  } catch {
    throw new BraintrustError(
      `The synthesiser at ${url} returned something that is not a JSON object: ` +
        `${content.slice(0, 200)}…`,
    );
  }
}

/**
 * Tolerant about the wrapper and strict about the contents, like the Note parser. An
 * entry missing a label or a body is dropped rather than stored half-formed: it would
 * otherwise reach a Persona as a heading with nothing under it.
 */
export function readEntryContent(content: string, url: string): SynthesisedEntry[] {
  const parsed = readObject(content, url);

  // An empty `entries` is a legitimate answer — the prompt asks for a short list that is
  // really there rather than a long one that is partly hoped for, and a Persona holding no
  // through-lines publishes normally. A *missing* `entries` is not: it means the model
  // answered a different question, and letting it through would be indistinguishable from
  // a reading that genuinely found nothing. Throwing here is what keeps the two apart, and
  // it is the only thing that does now that no gate check counts them. Found live.
  if (!Array.isArray(parsed.entries)) {
    throw new BraintrustError(
      `The synthesiser at ${url} returned JSON with no entries array: ` +
        `${content.slice(0, 200)}…`,
    );
  }

  return parsed.entries
    .flatMap((entry: unknown) => {
      const { label, body, items } = (entry ?? {}) as Partial<SynthesisedEntry>;
      if (typeof label !== 'string' || typeof body !== 'string') return [];
      if (label.trim() === '' || body.trim() === '') return [];
      return [
        {
          label: label.trim(),
          body: body.trim(),
          items: Array.isArray(items)
            ? items.filter((one: unknown): one is string => typeof one === 'string')
            : [],
        },
      ];
    })
    .slice(0, MAX_ENTRIES);
}

/**
 * The same shape of strictness for the growing layer. A Position with no slug or no
 * statement is dropped here; one whose claim refs braintrust never issued is dropped
 * later, where the refs it *did* issue are known.
 */
export function readClusterContent(content: string, url: string): ClusteredPosition[] {
  const parsed = readObject(content, url);

  // Empty is legitimate — a Corpus can genuinely hold no claim worth calling a position —
  // and missing is not, for the same reason as `entries` above: an endpoint answering a
  // different question would otherwise reach the gate as a Persona with no positions,
  // which reads as a thin week rather than as a misconfiguration.
  if (!Array.isArray(parsed.positions)) {
    throw new BraintrustError(
      `The synthesiser at ${url} returned JSON with no positions array: ` +
        `${content.slice(0, 200)}…`,
    );
  }

  return parsed.positions
    .flatMap((position: unknown) => {
      const { slug, statement, claims } = (position ?? {}) as Partial<ClusteredPosition>;
      if (typeof slug !== 'string' || typeof statement !== 'string') return [];
      if (slug.trim() === '' || statement.trim() === '') return [];
      return [
        {
          slug: slug.trim(),
          statement: statement.trim(),
          claims: Array.isArray(claims)
            ? claims.filter((one: unknown): one is string => typeof one === 'string')
            : [],
        },
      ];
    });
  // Deliberately not capped here, unlike the Core's entries. Positions grow with the
  // Corpus, and a cap applied to every call would quietly limit a 400-item Persona to one
  // pass's worth of positions. The per-pass bound lives with the fold, in ./positions.ts;
  // the merge needs no cap of its own, because a grouping answer is bounded by the count
  // of entries it was given.
}

/**
 * The merge's answer, and the third sibling of the two readers above: the same tolerance
 * for a fenced block, the same distinction between an empty answer and a wrong-shaped one.
 *
 * An empty `groups` is the answer the prompt asks for whenever nothing repeats, so it is
 * legitimate and a *missing* one is not — an endpoint answering a different question would
 * otherwise read as "these passes found nothing in common", which is believable and wrong.
 *
 * Strict about shape and permissive about content: a non-integer index survives to
 * ./merge.ts, where every index is checked against the list the merge was actually handed.
 */
export function readGroupContent(content: string, url: string): MergeGroup[] {
  const parsed = readObject(content, url);

  if (!Array.isArray(parsed.groups)) {
    throw new BraintrustError(
      `The synthesiser at ${url} returned JSON with no groups array: ${content.slice(0, 200)}…`,
    );
  }

  return parsed.groups.flatMap((group: unknown) => {
    const { members, clearest } = (group ?? {}) as Partial<MergeGroup>;
    if (!Array.isArray(members)) return [];

    const whole = members.filter(
      (member: unknown): member is number => typeof member === 'number' && Number.isInteger(member),
    );
    if (whole.length === 0) return [];

    return [
      {
        members: whole,
        // A missing or unusable `clearest` costs the group nothing: the merge is here to
        // find the duplicates, and any member's wording is better than dropping them.
        clearest: typeof clearest === 'number' && Number.isInteger(clearest) ? clearest : whole[0]!,
      },
    ];
  });
}

const RELATIONS = new Set(['revised', 'unsettled', 'drifting', 'none']);

/**
 * The judge's answers, strictly. A judgement missing its pair id or carrying a label that
 * is not one of the four is dropped: the alternative is a relation braintrust cannot
 * explain, on a record whose whole value is that every line can be explained.
 *
 * A *missing* `judgements` throws, as the other two parsers do — an endpoint answering a
 * different question would otherwise read as "no revisions in this corpus", which is the
 * most believable wrong answer in the whole compiler.
 */
export function readJudgementContent(content: string, url: string): JudgedPair[] {
  const parsed = readObject(content, url);

  if (!Array.isArray(parsed.judgements)) {
    throw new BraintrustError(
      `The synthesiser at ${url} returned JSON with no judgements array: ` +
        `${content.slice(0, 200)}…`,
    );
  }

  return parsed.judgements.flatMap((judgement: unknown) => {
    const { pair, relation, rationale } = (judgement ?? {}) as Partial<JudgedPair>;
    if (typeof pair !== 'string' || pair.trim() === '') return [];
    if (typeof relation !== 'string' || !RELATIONS.has(relation)) return [];
    return [
      {
        pair: pair.trim(),
        relation: relation as JudgedPair['relation'],
        rationale: typeof rationale === 'string' ? rationale.trim() : '',
      },
    ];
  });
}

/**
 * The menu prompt, and the only one that asks a model to *choose* rather than to write.
 *
 * **It is built from the menu rather than duplicating it**, so a habit added to
 * ./habits.ts is a habit the model is offered, and there is no second list to keep in step.
 * Each line is the slug and the `test` — deliberately about the *move* rather than the
 * subject, because two people writing about the same field argue differently and that
 * difference is the only thing here worth having.
 *
 * **No quota.** The instruction to return fewer rather than reach a number is the whole of
 * "no force-fitting": the count that ships is decided in code, from evidence, and a model
 * asked for four would supply four whatever the Corpus held.
 */
export function habitsPrompt(): string {
  return [
    "You are reading braintrust's own notes on many published items by one author — for each",
    'item, how the argument runs. No single item states how this person thinks. Recognising',
    'that across all of them is the job.',
    '',
    'You are NOT writing a description. You are choosing from the fixed menu below. You may',
    'only return slugs that appear in it; anything else is discarded.',
    '',
    'Return a single JSON object, and nothing else:',
    '',
    '{ "habits": [ { "slug": "...", "items": ["item-id", ...] } ] }',
    '',
    'slug — copied exactly from the menu below.',
    'items — the ids of the items this habit is visible in, copied exactly from the [id]',
    '  markers in the notes. Only ids you were actually given: an id that is not among them',
    '  will be dropped, and a habit left with none will be dropped with it.',
    '',
    'Choose only habits that are characteristic of this person across several items. A habit',
    '  visible once is a thing that happened, not a way of arguing. Leave it out.',
    'Do not fill a quota. Three habits that are really there beats eight that are partly',
    '  hoped for, and returning none is a valid answer.',
    'Do not choose on subject matter. Two people writing about the same field argue',
    '  differently, and that difference is the only thing here worth having.',
    '',
    'THE MENU',
    ...MENU.map((habit) => `- ${habit.slug}: ${habit.test}`),
  ].join('\n');
}

/**
 * The menu answer, read the way every other answer on this surface is read: tolerant about
 * the wrapper, strict about the contents.
 *
 * An empty `habits` is legitimate — the prompt says so, and a Corpus can genuinely support
 * no habit worth naming. A *missing* one is not, for the same live-found reason as the
 * others: an endpoint answering a different question would reach the gate as a Persona that
 * argues no particular way, which reads as a thin corpus rather than a misconfiguration.
 *
 * Membership of the menu is **not** checked here. It is checked where the ids are — in
 * ./habits.ts, against the same list the prompt was built from.
 */
export function readHabitContent(content: string, url: string): ChosenHabit[] {
  const parsed = readObject(content, url);

  if (!Array.isArray(parsed.habits)) {
    throw new BraintrustError(
      `The synthesiser at ${url} returned JSON with no habits array: ${content.slice(0, 200)}…`,
    );
  }

  return parsed.habits.flatMap((habit: unknown) => {
    const { slug, items } = (habit ?? {}) as Partial<ChosenHabit>;
    if (typeof slug !== 'string' || slug.trim() === '') return [];
    return [
      {
        slug: slug.trim(),
        items: Array.isArray(items)
          ? items.filter((one: unknown): one is string => typeof one === 'string')
          : [],
      },
    ];
  });
}

/**
 * The Script: the spoken form of a Persona, rendered from the Core at serving time.
 *
 * braintrust owns the voice. It stops handing a client four layers and an instruction and
 * hoping, and hands over one block of prose written to be spoken — no `basis`, no counts,
 * no layer names, no braintrust vocabulary. What a client used to assemble, braintrust now
 * composes and is accountable for.
 *
 * **Rendered on every call, never stored.** That is what keeps the reach: every Persona
 * already compiled improves the moment this deploys, with no recompile. No model is in the
 * path — everything here is selection, deletion or inflection over prose the compiler
 * already wrote.
 *
 * **The boundary may select and inflect. It may never paraphrase.** This replaces the older
 * and broader rule in speak.ts — *nothing here rewrites a layer or strips a marker* — whose
 * purpose was to stop `basis` being lost. `receipts` now holds that in a form which cannot
 * be spoken or paraphrased away, so what is left worth forbidding is braintrust composing
 * new prose about what someone thinks.
 *
 * See docs/design/mcp-surface.md §2 and https://github.com/cgbarlow/braintrust/issues/107.
 */

import { habitFor } from './compile/habits.js';
import { SPOKEN_DISCLOSURE } from './disclosure.js';

/** What a Source publishes, in the words a person would use for it. Never "items". */
const FORMS: Record<string, { read: string; unread: string }> = {
  youtube: { read: 'their videos', unread: 'their videos' },
  substack: { read: 'their writing', unread: 'their writing' },
  blog: { read: 'their blog', unread: 'their blog' },
  bluesky: { read: 'their posts', unread: 'their posts' },
};

function formOf(platform: string): string {
  return FORMS[platform]?.read ?? 'their posts';
}

/**
 * **The inflection table and the carrier are gone.**
 *
 * They existed because the Reasoning layer handed over a model's own noun phrase — *"Treats
 * prompting skill as the scarce resource"* — which had to be turned into an instruction, and
 * carried verbatim when it could not be. `labels_carried` counted the failures, because
 * anything can be listed verbatim and a carrier could absorb a completely broken Compile
 * without anything looking wrong.
 *
 * Nothing is inflected any more: every line in HOW THEY ARGUE is an imperative sentence
 * authored in ./compile/habits.ts, and the instrument that replaced the count is the
 * `habits_are_on_the_menu` gate check — which is stronger, because it fails the Compile
 * rather than reporting a number nobody reads.
 */

/**
 * Voice, with braintrust's bookkeeping taken out and the length instruction with it.
 *
 * `words_per_item` measures how long someone's *articles* are. Nothing in a Corpus
 * measures how long their *replies* are, because nobody publishes replies — so "match that
 * length" is an inference the measurement does not license, and following it answers a chat
 * message with a keynote. The measurement is true and stays in the layer; the instruction
 * derived from it does not survive the boundary.
 */
export function renderVoice(generative: string): string {
  return generative
    .split('\n')
    .map((line) =>
      line
        // "— measured in 17 of 19 items." — written for whoever is reading the layer.
        .replace(/\s*—\s*measured in \d+ of \d+ items\.?/gi, '')
        // "Items run around 1955 words across 19 of them, so match that length, not a
        // summary of it." — the clause this map deletes outright. Anchored to the end of
        // the line rather than to a full stop: the sentence it sits in is full of decimal
        // points, and a stop is not a sentence boundary in this prose.
        .replace(/\s*Items run around [\d,]+ words[^\n]*$/gim, '')
        // The per-ten-thousand register counts, which are evidence rather than instruction.
        .replace(/\s*—\s*[\d.]+ second-person[^\n]*?per ten thousand\./gi, '.')
        // "(1 of 19)" beside a move named as too thin to instruct.
        .replace(/\s*\(\d+ of \d+\)/g, ''),
    )
    .filter((line) => !/^Write as this person writes\./.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type SourceCoverage = {
  platform: string;
  retrieved: number;
  skipped_paywall: number;
  failed: number;
  backfill_complete: boolean;
};

/**
 * Whether a Source is a *structural* blind spot rather than an incident.
 *
 * Nate's Substack is 23 paywalled against 1 read: a Persona built from his videos will
 * answer questions about his writing fluently and wrongly, and no mid-conversation
 * admission ever fires because the videos always have something to say. That is a
 * permanent fact about what the Persona *is*, so it leads. A single failed fetch is an
 * incident and waits until a question lands on it.
 */
export function isStructuralSkew(source: SourceCoverage): boolean {
  return source.skipped_paywall > source.retrieved;
}

export type Receipts = {
  voice: string;
  reasoning: string;
  items_read: number;
  words_read: number;
  window: [string, string] | null;
  unread: string[];
};

export type StuckRebuildEvidence = {
  first_stuck_at: string;
  cycles_behind: number;
};

export type ScriptInput = {
  subject: string;
  voiceGenerative: string | null;
  voiceBasis: string | null;
  reasoningBasis: string | null;
  reasoningLabels: string[];
  bySource: Record<string, SourceCoverage>;
  itemsRead: number;
  wordsRead: number;
  window: [string, string] | null;
  stuckRebuild?: StuckRebuildEvidence;
};

export type RenderedScript = { speak: string; receipts: Receipts };

/** One stored layer, as both the read path and the gate hand it over. */
export type ScriptLayer = {
  basis: string;
  descriptive: string;
  generative?: string;
  evidence: unknown;
};

/**
 * Reads the shapes the compiler writes, defensively: a partial layer must not throw.
 *
 * Lives here rather than at the read path because [the gate](./compile/gate.ts) renders the
 * same Script to check its first line, and a gate checking a lookalike would be checking
 * something nobody serves.
 */
export function scriptInputFrom(
  subject: string,
  layers: Record<string, ScriptLayer>,
  stuckRebuild?: StuckRebuildEvidence,
): ScriptInput {
  const voice = layers.voice;
  const reasoning = layers.reasoning;
  const coverage = layers.coverage;

  const evidence = (coverage?.evidence ?? {}) as Record<string, unknown>;
  const rawSources = (evidence.by_source ?? {}) as Record<string, Record<string, unknown>>;

  const bySource: Record<string, SourceCoverage> = {};
  for (const [key, source] of Object.entries(rawSources)) {
    bySource[key] = {
      platform: typeof source.platform === 'string' ? source.platform : key.split(':')[0] ?? '',
      retrieved: numberOr(source.retrieved, 0),
      skipped_paywall: numberOr(source.skipped_paywall, 0),
      failed: numberOr(source.failed, 0),
      backfill_complete: source.backfill_complete !== false,
    };
  }

  const window = evidence.window;
  const entries = ((reasoning?.evidence ?? {}) as { entries?: { label?: unknown }[] }).entries ?? [];

  return {
    subject,
    voiceGenerative: voice?.generative ?? null,
    voiceBasis: voice?.basis ?? null,
    reasoningBasis: reasoning?.basis ?? null,
    reasoningLabels: entries
      .map((entry) => entry.label)
      .filter((label): label is string => typeof label === 'string'),
    bySource,
    itemsRead: numberOr(evidence.retrieved, 0),
    wordsRead: numberOr(evidence.words_retrieved, 0),
    window:
      Array.isArray(window) && typeof window[0] === 'string' && typeof window[1] === 'string'
        ? [window[0], window[1]]
        : null,
    ...(stuckRebuild ? { stuckRebuild } : {}),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}


/**
 * The opening line.
 *
 * Once, at the top, and not again. braintrust asks rather than enforces — it cannot see a
 * session — and that is acceptable because the *enforced* carrier is the subject string,
 * which never stops. Declining to repeat this on turn forty breaches nothing.
 *
 * **`— not the person` is not repeated here**, and that is what protects the corpus clause.
 * The denial is the fixed first line, recited verbatim and held there by
 * `speak_opens_with_disclosure`; saying it again one line later added no disclosure and
 * competed for the attention of a model deciding what to keep. The wording licence below
 * ("or your own wording of the same fact") means a model that compresses keeps the shortest
 * true reading — and while the halves overlapped, the shortest true reading was the half a
 * reader had already heard. With the overlap gone, "the same fact" is the name and the
 * scope, so dropping the scope is no longer free. Those four words are still load-bearing
 * where the name travels alone: see `subjectFor` in ./disclosure.ts, which is unchanged.
 *
 * Scale has left this sentence. It used to recite the item count and the window, and that
 * measured the wrong thing: "515 things, with 23 more behind a paywall" reads as a rounding
 * error while concealing that an entire Source is unread. **Scale is not skew.** The counts
 * are in `receipts`, speakable the moment anyone asks.
 */
function openingLine(subject: string, skewed: string[]): string {
  const named = `${subject}.`;
  if (skewed.length === 0) return named;
  return `${named} braintrust has read ${skewed.join(' and ')}.`;
}

export function renderScript(input: ScriptInput): RenderedScript {
  const sources = Object.values(input.bySource);
  const skewed = sources.filter(isStructuralSkew);
  const read = sources.filter((s) => s.retrieved > 0 && !isStructuralSkew(s));

  // Scope, not statistics: "their videos, not their writing" is what a person says.
  const scope =
    skewed.length > 0 && read.length > 0
      ? [`${read.map((s) => formOf(s.platform)).join(' and ')}, not ${skewed.map((s) => formOf(s.platform)).join(' or ')}`]
      : [];

  // **Selection, never composition.** Every line here is text authored in
  // ./compile/habits.ts; a slug the compiler chose that is not on the menu renders nothing.
  // That is the whole guarantee — a conclusion cannot reach the Script, because the Script
  // is assembled only from words this repository holds.
  const instructions = input.reasoningLabels
    .map((slug) => habitFor(slug)?.instruction)
    .filter((text): text is string => text !== undefined);

  const parts: string[] = [
    // **The first line, and the only one not addressed to the model.** A model recites the
    // top of the block it was handed, verbatim, whatever is there — so what is there is
    // the disclosure rather than an instruction about it. See ./disclosure.ts.
    SPOKEN_DISCLOSURE,
    '',
    `Say that line first, word for word, before anything else. Then say who you are — ` +
      `"I'm a ${openingLine(input.subject, scope)}" or your own wording of the same fact — and ` +
      'answer as them for the rest of the conversation. Say both once. Do not say them again.',
    '',
    `You are a ${input.subject}. You are not that person.`,
  ];

  if (input.voiceGenerative) {
    parts.push('', 'HOW THEY WRITE', '', renderVoice(input.voiceGenerative));
  }

  // Absent rather than empty. A heading with nothing under it reads as a person who argues
  // no particular way, which is a claim braintrust did not make.
  if (instructions.length > 0) {
    parts.push('', 'HOW THEY ARGUE', '', instructions.map((text) => `- ${text}`).join('\n'));
  }

  parts.push('', 'WHEN YOU HAVE LOOKED SOMETHING UP', '', SPEAK_DO_NOT_RECITE);
  parts.push('', 'WHAT YOU HAVE NOT READ', '', blindSpots(read, skewed, sources));

  if (input.stuckRebuild) {
    parts.push(
      '',
      'ABOUT THIS MODEL',
      '',
      'Your model has not been rebuilt after ' +
        `${input.stuckRebuild.cycles_behind} rounds of changes to how it is made. ` +
        'Say so if it comes up, in your own words, the way you would say anything else.',
    );
  }

  return {
    speak: parts.join('\n'),
    receipts: {
      voice: input.voiceBasis ?? 'unknown',
      reasoning: input.reasoningBasis ?? 'unknown',
      items_read: input.itemsRead,
      words_read: input.wordsRead,
      window: input.window,
      unread: unreadSummary(input.bySource),
    },
  };
}

/**
 * What the Persona does with the record it was handed: speaks it, and does not read it out.
 *
 * **A forged citation is a class every other guard on this map misses.** Everything else here
 * protects against a Persona saying something with *nothing behind it* — absence. Run live
 * through the Hermes client, a Persona **retrieved** and then invented a source title, a 2026
 * date and a quotation to match, with no such item in that Corpus, plus a real quote hung on
 * the wrong post. It had something behind it and produced a checkable-*looking* pointer that
 * resolves to a post nobody wrote, which defeats the one defence a listener has — and defeats
 * it worse than silence does, because a listener who follows it up believes they checked.
 *
 * No client configuration makes a model author a title, so the invention happened after the
 * record was in hand. **What this removes is the incentive, not the capability**: a model told
 * to attribute reaches for an attribution it may not have, where a model asked to speak plainly
 * has nothing it is expected to produce.
 *
 * **The payload is unchanged.** Quotes, titles, dates and urls all still ship — a reader can
 * still tell the difference from the payload alone. What changes is what gets said out loud
 * unprompted. Withholding the citation from the *payload* until asked is the honest form and is
 * rejected on measurement: take the quotable thing away and 2 of 8 replies replaced it with
 * invented first-person anecdote. Starvation is what makes this model manufacture support.
 *
 * **Two costs, both accepted.** *Ship, don't recite* is an instruction, and this map's own line
 * is that a Persona is honest because it looked and not because it was told to. And an unasked
 * answer now carries nothing a listener can check, so it looks — to that listener, in that
 * moment — exactly like this map's founding failure. **The tell moves from the answer to the
 * follow-up question.**
 *
 * **Nothing invites the reader to ask.** That the record is produced on request is a guarantee,
 * never an offer, so the last line here is a prohibition rather than a prompt.
 *
 * **The carve-out sits with the prohibition, as the same rule's second side.** Raised from a
 * trailing bullet into the paragraph that opens with *nobody asked you for the record*, the
 * hand-it-over-half no longer reads as the weaker of two clauses a model can weigh against each
 * other: asked for the record, a Persona quotes it exactly and says where it came from; unasked,
 * nothing changes. The asking is the whole difference, and it is stated in the same voice as the
 * prohibition so neither can win on volume. See
 * https://github.com/cgbarlow/braintrust/issues/252.
 *
 * **The bound is stated here and not only in a tool description.** *What have you published
 * lately* is a question whose whole answer is titles and dates, and an unqualified prohibition
 * empties it — which is the degenerate answer `braintrust_recent_items` exists to prevent. The
 * rule governs a pointer hung on a claim, never the subject of the question, and this is the
 * one surface guaranteed to be in a model's context: a bound that lives only in a description
 * read at choosing time, or in a Hermes soul copied into a profile months ago, is a bound that
 * does not reach the model that needs it.
 *
 * **Both sides of the bound are named, because one side alone reads onto the other.** *What
 * have you written about hiring?* is a question about hiring — the topic shape this rule
 * exists to keep unattributed — and a carve-out triggered on *asked what you have written*
 * would collect it. So the trigger is the inventory question (*what you have put out lately*)
 * and the exclusion is said out loud beside it. It is the question the interrogation probes
 * with; see ../interrogate/assertions.ts.
 *
 * See docs/design/mcp-surface.md, rule 5, and
 * https://github.com/cgbarlow/braintrust/issues/202.
 */
const SPEAK_DO_NOT_RECITE = [
  'Say what you found as your own view, in your own words. No title, no date, no quotation, ' +
    'and nothing about where it came from — nobody asked you for the record, and an answer ' +
    'that reaches for an attribution is where an invented one gets said out loud.',
  '',
  'Asked for the record, the same rule hands it over whole — the quotation exactly as it was ' +
    'said, and where it came from, plainly and in your own register. One rule with two sides, ' +
    'and the asking is the whole difference.',
  '',
  'Unless what they published is itself the question. Asked what you have put out lately, ' +
    'or what is new, the titles and the dates are what was asked for — name them. Asked what ' +
    'you think about something, they are not: what stays out is a title and a date hung on a ' +
    'claim nobody asked the source of.',
  '',
  'Flat, and in your register: not "I wrote about this last year", not "as I put it in a ' +
    'piece on X", not "broadly speaking". Just the thing itself, the way you would say it.',
  '',
  'Never offer it first, and never tell anyone they can ask. The record is a guarantee, ' +
    'never an offer — you keep it unless you are asked for it, and you hand it over whole ' +
    'if somebody asks for it.',
].join('\n');

/**
 * What the Persona says when a question lands outside what braintrust read.
 *
 * **"I never wrote about that" is forbidden**, and it is the natural thing to say. An empty
 * answer means *they never said it* or *braintrust never read it*, and nothing distinguishes
 * them — so the admission is always about this Persona's reach, never about the person's
 * output.
 *
 * And the rule that survives every other guard: having admitted it has nothing, the Persona
 * must not then answer anyway out of the client's own knowledge. That is the same lie with
 * better manners, and worse, because it sounds like considered judgement.
 *
 * **Three moves, and the last two are what #165 adds.** braintrust supplies the facts of an
 * empty answer and never the sentence — measured, no Persona ever said the sentence — so this
 * is where the Persona is told what to do with them.
 *
 * *Offer, do not stop.* A Persona handed an empty answer already admits it and does not fill,
 * 24 of 24 across every arm and seed, so honesty was never the defect here. The shape of the
 * dead end was: *"I don't have a view on central bank interest rate policy."* and no next
 * move, on the first question a reader asks. `nothing_matched.nearest` is what makes the
 * offer possible, and in the probe the Persona volunteered it unprompted once it had both the
 * fact and this instruction.
 *
 * *Say when you cannot look at all.* Withhold the search tool from the model while leaving it
 * named in the persona tool's description — which is what a client with tool search actually
 * hands over — and the founding failure of this whole map returns: 0 of 3 lookups, three
 * fluent invented answers in voice. What is left after #138 is *"I don't have a view on quests
 * versus goals"* — honest about the Persona and **false about the person**, who does have a
 * view that braintrust is holding. braintrust never sees the call that was not made, so this
 * is mitigation and the fix is the Hermes tool-deferral setting. Mitigation is still worth
 * having, because the alternative is a reader told something untrue about a real human with no
 * way to know why.
 */
function blindSpots(
  read: SourceCoverage[],
  skewed: SourceCoverage[],
  all: SourceCoverage[],
): string {
  const lines: string[] = [];

  if (read.length > 0) {
    const what = read.map((s) => formOf(s.platform)).join(' and ');
    lines.push(`You have read ${what}${skewed.length > 0 ? ' and nothing else' : ''}.`);
  }
  if (skewed.length > 0) {
    lines.push(`braintrust has not read ${skewed.map((s) => formOf(s.platform)).join(' or ')}.`);
  }
  if (all.some((s) => !s.backfill_complete)) {
    lines.push('Some of the archive has not been walked back to its beginning yet.');
  }

  lines.push(
    '',
    'When a question lands outside that, say plainly that you have not got a view on it you ' +
      'can stand behind, and answer around it. Never say you never wrote about something — ' +
      'you cannot tell that apart from never having read it. And never fill the gap from ' +
      'your own knowledge while speaking as them: an answer you supplied yourself, in their ' +
      'voice, is worse than no answer at all.',
    '',
    'Then do not stop there. A lookup that comes back with nothing tells you what you have ' +
      'looked at nearby — name one or two of those in your own words and offer to go into ' +
      'them. Say all of this as you would say it. The words are yours, not braintrust\'s.',
    '',
    'And if you have no way to look anything up at all — nothing in reach that searches what ' +
      'they published — say that, plainly, and say it first. That is not the same as having ' +
      'no view: they may well have written about this at length. Do not answer as them from ' +
      'anywhere else.',
  );

  return lines.join('\n');
}

function unreadSummary(bySource: Record<string, SourceCoverage>): string[] {
  const unread: string[] = [];
  for (const [key, source] of Object.entries(bySource)) {
    const notes: string[] = [];
    if (source.skipped_paywall > 0) notes.push(`${source.skipped_paywall} paywalled`);
    if (source.failed > 0) notes.push(`${source.failed} failed`);
    if (!source.backfill_complete) notes.push('not walked back to its beginning');
    if (notes.length > 0) unread.push(`${key} — ${notes.join(', ')}, ${source.retrieved} read`);
  }
  return unread;
}

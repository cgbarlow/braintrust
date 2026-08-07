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
 * Third-person-singular disposition verbs, mapped to the imperative.
 *
 * **A lookup table rather than a morphology rule, deliberately.** Stripping a trailing `s`
 * would turn *"Systems thinking as a lever"* into *"System thinking as a lever"* — a
 * silently mangled noun phrase, which is exactly the guessing the carrier exists to avoid.
 * A label whose first word is not in this table is carried verbatim instead, so the failure
 * mode is a label that reads as a frame rather than a label that reads as nonsense.
 */
const IMPERATIVE: Record<string, string> = {
  advocates: 'Advocate',
  anchors: 'Anchor',
  argues: 'Argue',
  assumes: 'Assume',
  avoids: 'Avoid',
  believes: 'Believe',
  builds: 'Build',
  casts: 'Cast',
  conflates: 'Conflate',
  defaults: 'Default',
  distrusts: 'Distrust',
  emphasises: 'Emphasise',
  emphasizes: 'Emphasize',
  expects: 'Expect',
  extrapolates: 'Extrapolate',
  favours: 'Favour',
  favors: 'Favor',
  frames: 'Frame',
  grounds: 'Ground',
  insists: 'Insist',
  judges: 'Judge',
  maps: 'Map',
  measures: 'Measure',
  models: 'Model',
  prefers: 'Prefer',
  prioritises: 'Prioritise',
  prioritizes: 'Prioritize',
  reaches: 'Reach',
  reads: 'Read',
  rejects: 'Reject',
  relies: 'Rely',
  seeks: 'Seek',
  separates: 'Separate',
  splits: 'Split',
  takes: 'Take',
  tests: 'Test',
  treats: 'Treat',
  trusts: 'Trust',
  uses: 'Use',
  views: 'View',
  weighs: 'Weigh',
};

/**
 * A label as it will appear in the Script, and how it got there.
 *
 * `carried` is the one that has to stay visible. Because *anything* can be listed
 * verbatim, a carrier can absorb a completely broken Compile without anything looking
 * wrong — and the count is the only instrument that catches it. A Persona where every
 * label was carried is a Persona whose Compile needs fixing.
 */
export type RenderedLabel = { text: string; carried: boolean };

/**
 * Inflect, else carry. Omission is the third step and is unreachable for any non-empty
 * label, which is the point: `nate-b-jones` has no verb-initial labels at all, and
 * dropping them left that Persona with a manner and no mind.
 */
export function renderLabel(label: string): RenderedLabel | undefined {
  const trimmed = label.trim().replace(/\.$/, '');
  if (trimmed === '') return undefined;

  const [first, ...rest] = trimmed.split(/\s+/);
  const imperative = first === undefined ? undefined : IMPERATIVE[first.toLowerCase()];

  if (imperative !== undefined && rest.length > 0) {
    return { text: `${imperative} ${rest.join(' ')}.`, carried: false };
  }
  return { text: trimmed, carried: true };
}

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
  /**
   * How many `reasoning` labels had to be carried verbatim because they were not
   * verb-initial. **Never allowed to go quiet.** See RenderedLabel.
   */
  labels_carried: number;
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
 * **`— not the person` is the part that cannot be cut.** "A braintrust model of" alone can
 * be read as homage or imitation; those four words are what make it unambiguous.
 *
 * Scale has left this sentence. It used to recite the item count and the window, and that
 * measured the wrong thing: "515 things, with 23 more behind a paywall" reads as a rounding
 * error while concealing that an entire Source is unread. **Scale is not skew.** The counts
 * are in `receipts`, speakable the moment anyone asks.
 */
function openingLine(subject: string, skewed: string[]): string {
  const named = `${subject} — not the person.`;
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

  const labels = input.reasoningLabels
    .map(renderLabel)
    .filter((label): label is RenderedLabel => label !== undefined);

  const instructions = labels.filter((l) => !l.carried);
  const carried = labels.filter((l) => l.carried);

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

  if (instructions.length > 0 || carried.length > 0) {
    parts.push('', 'HOW THEY ARGUE');
    if (instructions.length > 0) {
      parts.push('', instructions.map((l) => `- ${l.text}`).join('\n'));
    }
    // The carrier. Fixed boilerplate plus the label verbatim — selection, never paraphrase.
    if (carried.length > 0) {
      parts.push(
        '',
        'You habitually frame things this way:',
        '',
        carried.map((l) => `- ${l.text}`).join('\n'),
      );
    }
  }

  parts.push('', 'WHAT YOU HAVE NOT READ', '', blindSpots(read, skewed, sources));

  return {
    speak: parts.join('\n'),
    receipts: {
      voice: input.voiceBasis ?? 'unknown',
      reasoning: input.reasoningBasis ?? 'unknown',
      items_read: input.itemsRead,
      words_read: input.wordsRead,
      window: input.window,
      unread: unreadSummary(input.bySource),
      labels_carried: carried.length,
    },
  };
}

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

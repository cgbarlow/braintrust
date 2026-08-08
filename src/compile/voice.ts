/**
 * Voice, measured — and the one layer where "measured" needs defending.
 *
 * No model is in this path. Every number below is counted directly over
 * `braintrust_items.body_text`, and every exemplar is a slice of it, so the whole
 * layer is free at every Compile and stays correct while the Note prompt is mid-upgrade.
 *
 * **The patterns are a hypothesis; the counts are the measurement.** Deciding that
 * `I think` is hedging is a judgement a human made, and pretending otherwise would be
 * the dishonest part. So the judgement is written down where it can be argued with —
 * `pattern` travels in the evidence as its own regex source — and nothing is asserted
 * on its strength alone. What protects the Persona is the second half: a move earns a
 * line in the generative form from its **spread across Items**, and the strength of the
 * wording is a function of that spread rather than of anyone's ear.
 *
 * That failure has already happened here once. The first prototype asserted *"no
 * hedging"* from four Substack post openings; measurement later found hedging in 32 of
 * 34 transcripts — the dominant feature of a spoken voice that is 96% of the Corpus.
 * A description extrapolated from a handful of items was confidently wrong about the
 * most audible thing about someone.
 *
 * See docs/design/compiler.md §2.
 */

/**
 * A move must appear in this fraction of measured Items to be instructed at all, and
 * in this fraction to be instructed as characteristic. Both are starting points to tune
 * against real Corpora rather than findings — see the "deliberately not decided" list.
 *
 * The floor is what stops one loud Item becoming a personality trait. Below it a move is
 * still *described*, because the count is real; it is simply not turned into an
 * instruction a model would then perform in someone's name.
 */
export const SPREAD_FLOOR = 1 / 3;
export const SPREAD_CHARACTERISTIC = 2 / 3;

/** Per move, drawn from Items spread across the window rather than from the newest three. */
export const EXEMPLARS_PER_MOVE = 3;

/** An exemplar is a fragment, cut at a space. Long enough to hear, short enough to scan. */
export const EXEMPLAR_MAX_CHARS = 140;

/**
 * **How long an Item has to be before it can answer the question Voice asks.**
 *
 * An Item now spans four orders of magnitude — a 34-word skeet against a 40,000-word
 * lecture transcript — and every statistic below assumed one population. The spread
 * thresholds are fractions of `items_measured`, so on a Corpus of 900 skeets and 23
 * essays the essays are 2.5% of the denominator and **cannot reach either threshold
 * however consistent they are**. The arithmetic is one-directional too: a 34-word post
 * can hold at most one hedge, so short-form drags frequency up while making spread
 * unreachable. And `words_per_item` becomes an average of 34 and 40,000 — a number
 * describing nothing that exists.
 *
 * 300 is a judgement, and it travels in `measured_over` for the same reason the patterns
 * travel in the evidence: so it can be argued with rather than trusted. The measured case
 * is that a batched Bluesky day lands at ~198 words and the shortest real essay in any
 * Corpus measured is 492, so 300 separates the two populations with roughly 1.6×
 * clearance on each side — above every Ghost event announcement, below every blog post.
 *
 * **Short-form is excluded from Voice alone.** It still feeds Reasoning, Positions,
 * Through-lines and Coverage. *Short-form tells you what someone thinks; long-form tells you
 * how they argue* — and the moves counted here are argumentative moves.
 *
 * See docs/design/compiler.md §2.
 */
export const VOICE_MIN_WORDS = 300;

export type MeasuredItem = {
  external_id: string;
  url: string;
  published_at: string | null;
  body_text: string;
};

export type Exemplar = {
  /** Verbatim from `body_text`. A tidied exemplar would make the evidence unauditable. */
  text: string;
  item: string;
  url: string;
  published_at: string | null;
};

export type MoveMeasurement = {
  move: string;
  label: string;
  /** Total matches across the Corpus. */
  occurrences: number;
  /** How many Items use the move at all. This is the number the instruction turns on. */
  spread: number;
  per_10k_words: number;
  /** The hypothesis, in full, so it can be argued with rather than trusted. */
  pattern: string;
  exemplars: Exemplar[];
};

export type Register = {
  second_person_per_10k: number;
  first_person_singular_per_10k: number;
  first_person_plural_per_10k: number;
  words_per_item: number;
};

/**
 * Which Items Voice was measured over, and which it was not. Present on every Persona,
 * because a layer that selects a population and does not say so is a layer describing a
 * Corpus the reader thinks they are looking at.
 */
export type VoicePopulation = {
  /**
   * The floor actually applied. `VOICE_MIN_WORDS` normally — and **0 when no Item in the
   * Corpus reaches it**, because a Persona that refuses to describe a voice is worse than
   * one that says which voice it measured. The floor drops; the layer is not withheld.
   */
  min_words: number;
  items: number;
  median_words: number;
  /** Read for what they say rather than for how they say it. Never simply discarded. */
  items_excluded: number;
};

export type VoiceEvidence = {
  items_measured: number;
  words_measured: number;
  window: [string, string] | null;
  measured_over: VoicePopulation;
  moves: MoveMeasurement[];
  register: Register;
};

export type VoiceLayer = {
  descriptive_md: string;
  generative_md: string;
  evidence: VoiceEvidence;
};

type MoveDefinition = {
  move: string;
  label: string;
  /** What the pattern is looking for, in words. Method, not finding. */
  gloss: string;
  /** The instruction this move becomes when the counts support it. */
  instruction: string;
  /**
   * One alternation rather than a list, so two patterns that describe the same phrase
   * cannot count it twice — `lastIndex` moves past a match, and the alternation takes
   * the first branch that fits at each position.
   */
  alternatives: string[];
};

/**
 * Auto-captions are the majority of the Corpus and they are inconsistent about
 * apostrophes, so every contraction is written `'?`. Word boundaries throughout: `\bI
 * think\b` must not fire inside "I thinking" and must fire at the start of a line.
 */
const MOVES: MoveDefinition[] = [
  {
    move: 'hedging',
    label: 'Hedging / provisional',
    gloss: 'Marks a view as provisional rather than settled.',
    instruction:
      'Hedge before committing. Put a view forward provisionally — and say when you might be wrong — rather than asserting it as settled.',
    alternatives: [
      "I think\\b",
      "I do ?n'?t think\\b",
      "I'?m not sure\\b",
      "I could be wrong\\b",
      "I suspect\\b",
      "my sense is\\b",
      'probably\\b',
      'perhaps\\b',
      'maybe\\b',
      'might be\\b',
      'seems? (?:like|to)\\b',
      'kind of\\b',
      'sort of\\b',
    ],
  },
  {
    move: 'direct-address',
    label: 'Direct address',
    gloss: 'Speaks to the reader as someone with a decision in front of them.',
    instruction:
      'Address the reader directly, as someone with a decision to make rather than an audience being briefed.',
    alternatives: [
      "here'?s (?:what|the thing|why|how|where)\\b",
      'I want you to\\b',
      'you need to\\b',
      'you should\\b',
      "if you'?re\\b",
      'think about (?:it|this) as\\b',
      'ask yourself\\b',
    ],
  },
  {
    move: 'enumeration',
    // Named for what the pattern counts rather than for what it hopes to find. Measured
    // against a real corpus it also fires on narrative sequence — "Finally, I'll put it
    // on a piece of paper" is a step, not a point being made — and calling the move
    // "enumeration" would have quietly promoted an ordinal marker into an argument.
    label: 'Ordinal signposting',
    gloss: 'Marks parts and steps with ordinal words, at the start of a clause.',
    instruction:
      'Signpost in order — first, second, finally — so the shape of what you are saying is audible before it is finished.',
    alternatives: [
      'number (?:one|two|three|four|five)\\b',
      'the (?:first|second|third) thing\\b',
      '\\b(?:first|second|third|fourth|finally),',
      'point (?:one|two|three)\\b',
    ],
  },
  {
    move: 'wry-aside',
    label: 'Wry aside',
    gloss: 'Dryness delivered inside a sentence rather than as a set-up.',
    instruction:
      'Let humour arrive dry and parenthetical — an aside inside a sentence, never a set-up and a punchline.',
    alternatives: [
      'frankly\\b',
      'honestly\\b',
      'which is (?:wild|nuts|bananas|insane|mad)\\b',
      'to be fair\\b',
      'funnily enough\\b',
    ],
  },
  {
    move: 'concession-pivot',
    label: 'Concession-pivot',
    gloss: 'Narrows a claim mid-sentence rather than defending its strongest form.',
    instruction:
      'Narrow your own claim mid-sentence rather than defending its strongest form — concede the overreach, then say the smaller thing you actually mean.',
    alternatives: [
      "I'?m not saying\\b",
      "I'?m just saying\\b",
      'that said\\b',
      'having said that\\b',
      'to be clear\\b',
      'not to say\\b',
    ],
  },
  {
    move: 'reframe',
    label: 'Reframe',
    gloss: 'Refuses the framing of a question before answering it.',
    instruction:
      'Refuse the framing before answering: say what the question is not, then what it actually is.',
    alternatives: [
      'the (?:real )?question is not\\b',
      'is not (?:which|whether|can|what|how)\\b',
      "it'?s not (?:about )?\\w+,? it'?s\\b",
      'rather than asking\\b',
      'the wrong question\\b',
    ],
  },
];

const REGISTER_PATTERNS = {
  second_person: /\b(?:you|you'?re|you'?ve|your|yours|yourself)\b/gi,
  first_person_singular: /\b(?:I|I'?m|I'?ve|I'?ll|me|my|mine|myself)\b/gi,
  first_person_plural: /\b(?:we|we'?re|we'?ve|us|our|ours|ourselves)\b/gi,
};

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Measures every move over every Item, whether or not the Corpus uses it. A move that
 * never fires is a row of zeroes and stays in the evidence, because "braintrust looked
 * for this and did not find it" is a different statement from silence — and it is the
 * statement the first prototype needed and did not have.
 */
/**
 * The population, chosen by length.
 *
 * **The floor drops rather than the layer being withheld.** A Corpus with no long-form at
 * all — someone who is only ever on Bluesky — is measured over whatever it does have, and
 * `min_words: 0` records that truthfully. The same posture the gate already takes with the
 * inferred layers, and refusing here would make an entire Source unbuildable.
 *
 * Nothing about how anything is *counted* changes. The population was always an argument
 * to the Voice step; this is a change to what is passed in.
 */
/** The population a bare set of Items is, with no floor applied. */
function describing(items: MeasuredItem[]): VoicePopulation {
  return { min_words: 0, items: items.length, median_words: medianWords(items), items_excluded: 0 };
}

function medianWords(items: MeasuredItem[]): number {
  const lengths = items.map((item) => countWords(item.body_text)).sort((a, b) => a - b);
  return lengths.length === 0 ? 0 : lengths[Math.floor((lengths.length - 1) / 2)]!;
}

export function selectVoiceItems(items: MeasuredItem[]): {
  measured: MeasuredItem[];
  population: VoicePopulation;
} {
  const longForm = items.filter((item) => countWords(item.body_text) >= VOICE_MIN_WORDS);
  const dropped = longForm.length === 0;
  const measured = dropped ? items : longForm;

  return {
    measured,
    population: {
      min_words: dropped ? 0 : VOICE_MIN_WORDS,
      items: measured.length,
      median_words: medianWords(measured),
      items_excluded: items.length - measured.length,
    },
  };
}

export function measureVoice(items: MeasuredItem[], population?: VoicePopulation): VoiceEvidence {
  // Given no population, the measurement describes exactly the set it was handed: no
  // floor applied, nothing excluded. Truthful rather than convenient — `voiceLayer` is
  // where the selection happens, and this stays a pure count over whatever it is given.
  const over = population ?? describing(items);
  const words = items.reduce((total, item) => total + countWords(item.body_text), 0);
  const per10k = (count: number): number =>
    words === 0 ? 0 : Math.round((count / words) * 10_000 * 10) / 10;

  const moves = MOVES.map((definition) => {
    const regex = new RegExp(definition.alternatives.join('|'), 'gi');
    const hits = items.map((item) => ({ item, spans: matchSpans(regex, item.body_text) }));
    const used = hits.filter((hit) => hit.spans.length > 0);
    const occurrences = hits.reduce((total, hit) => total + hit.spans.length, 0);

    return {
      move: definition.move,
      label: definition.label,
      occurrences,
      spread: used.length,
      per_10k_words: per10k(occurrences),
      pattern: regex.source,
      exemplars: pickExemplars(used),
    } satisfies MoveMeasurement;
  });

  const dates = items.map((item) => item.published_at).filter((date): date is string => date !== null).sort();

  return {
    items_measured: items.length,
    words_measured: words,
    window: dates.length > 0 ? [dates[0]!, dates[dates.length - 1]!] : null,
    measured_over: over,
    moves,
    register: {
      second_person_per_10k: per10k(countMatches(items, REGISTER_PATTERNS.second_person)),
      first_person_singular_per_10k: per10k(countMatches(items, REGISTER_PATTERNS.first_person_singular)),
      first_person_plural_per_10k: per10k(countMatches(items, REGISTER_PATTERNS.first_person_plural)),
      words_per_item: items.length === 0 ? 0 : Math.round(words / items.length),
    },
  };
}

/**
 * Both forms, from one set of measurements, in one step. They are written here rather
 * than by two callers precisely so there is no path by which the instruction and its
 * evidence can disagree — see docs/design/compiler.md §2.
 */
export function voiceLayer(items: MeasuredItem[]): VoiceLayer {
  const { measured, population } = selectVoiceItems(items);
  const evidence = measureVoice(measured, population);
  return {
    descriptive_md: describe(evidence),
    generative_md: instruct(evidence),
    evidence,
  };
}

/**
 * The auditable account. Every number here is a field of `evidence`, so a reader can
 * check the prose against the structure rather than taking the sentence's word for it.
 */
function describe(evidence: VoiceEvidence): string {
  const { items_measured: items, words_measured: words, register } = evidence;
  const lines: string[] = [];

  const over = evidence.measured_over;

  lines.push(
    `Measured over ${items} item${items === 1 ? '' : 's'} — ${words} words` +
      `${evidence.window ? `, ${evidence.window[0]} to ${evidence.window[1]}` : ''}. ` +
      'Counted directly over the published text, with no model in the path. Spread is how ' +
      'many items use the move at all.',
  );

  // The population, always, and in the layer's own prose rather than only in Coverage.
  // Voice is what a client loads to sound like someone, and a layer that selected its
  // population without saying so would describe a corpus the reader thinks they see.
  lines.push(
    '',
    over.min_words === 0
      ? `**Which items.** No item in this corpus is long enough for the usual long-form floor, so ` +
          `the floor was dropped rather than the layer withheld: voice is measured over all ` +
          `${over.items} item${over.items === 1 ? '' : 's'}, median ${over.median_words} words. ` +
          'Read that for what it is — how this person writes at this length.'
      : `**Which items.** Voice is measured over the ${over.items} item` +
          `${over.items === 1 ? '' : 's'} of ${over.min_words} words or more, median ` +
          `${over.median_words} words. ` +
          (over.items_excluded > 0
            ? `${over.items_excluded} shorter item${over.items_excluded === 1 ? ' was' : 's were'} ` +
              'read for what they say rather than for how they say it — they feed reasoning, ' +
              'positions and through-lines, and a thirty-word post cannot answer how someone argues.'
            : 'Nothing was excluded.'),
  );

  lines.push('', '| Move | Occurrences | Spread | Per ten thousand words | What it counts |', '|---|---:|---:|---:|---|');
  for (const move of evidence.moves) {
    const gloss = MOVES.find((definition) => definition.move === move.move)!.gloss;
    lines.push(
      `| **${move.label}** | ${move.occurrences} | ${move.spread} of ${items} | ` +
        `${move.per_10k_words} | ${gloss} |`,
    );
  }

  const unused = evidence.moves.filter((move) => move.occurrences === 0);
  if (unused.length > 0) {
    lines.push(
      '',
      `braintrust looked for ${unused.map((move) => move.label.toLowerCase()).join(', ')} and found ` +
        'none. That is a measurement, not an omission — and it is not an instruction either: an ' +
        'absence cannot be asserted into a voice any more than a presence can.',
    );
  }

  const heard = evidence.moves.filter((move) => move.exemplars.length > 0);
  if (heard.length > 0) {
    lines.push('', '**How it sounds.** Verbatim, spread across the window.');
    for (const move of heard) {
      lines.push('', `*${move.label}*`);
      for (const exemplar of move.exemplars) {
        lines.push(
          `- "${exemplar.text}" — ${exemplar.item}${exemplar.published_at ? `, ${exemplar.published_at}` : ''}`,
        );
      }
    }
  }

  lines.push(
    '',
    `**Register.** Per ten thousand words: second person ${register.second_person_per_10k}, first person ` +
      `singular ${register.first_person_singular_per_10k}, first person plural ` +
      `${register.first_person_plural_per_10k}. Items average ${register.words_per_item} words.`,
  );

  return lines.join('\n');
}

/**
 * The instruction, derived. A move's line exists because of its spread and is worded by
 * its spread; the sentence itself is fixed alongside the pattern that found it, and
 * carries its own count inline so it can be checked against the layer it came from.
 *
 * Nothing unmeasured enters here. In particular the model-not-the-person disclosure does
 * not: it is measured from nobody, and it travels in the subject string instead.
 */
function instruct(evidence: VoiceEvidence): string {
  const items = evidence.items_measured;
  const characteristic = evidence.moves.filter((move) => move.spread >= items * SPREAD_CHARACTERISTIC && move.spread > 0);
  const occasional = evidence.moves.filter(
    (move) => move.spread >= items * SPREAD_FLOOR && move.spread < items * SPREAD_CHARACTERISTIC,
  );
  const thin = evidence.moves.filter((move) => move.spread > 0 && move.spread < items * SPREAD_FLOOR);

  const lines: string[] = ['Write as this person writes. Every instruction below is followed by what it was measured from.'];

  const render = (move: MoveMeasurement, lead: string): string =>
    `- **${lead}** ${instructionFor(move.move)} — measured in ${move.spread} of ${items} items.`;

  if (characteristic.length > 0) {
    lines.push('', ...characteristic.map((move) => render(move, 'Characteristically.')));
  }
  if (occasional.length > 0) {
    lines.push('', ...occasional.map((move) => render(move, 'Often.')));
  }

  lines.push('', registerLine(evidence.register, items));

  if (thin.length > 0) {
    lines.push(
      '',
      `Measured too thinly to instruct, and deliberately left out: ` +
        `${thin.map((move) => `${move.label.toLowerCase()} (${move.spread} of ${items})`).join(', ')}. ` +
        'Do not add them back.',
    );
  }

  return lines.join('\n');
}

/**
 * The dominant pronoun is decided by comparing all three counts, not two of them. An
 * earlier version compared second person against first person singular and then called
 * the winner dominant — which on a corpus whose commonest pronoun was `we` asserted a
 * superlative it had not measured. A measured layer may only claim the comparison it ran.
 */
function registerLine(measured: Register, items: number): string {
  const second = measured.second_person_per_10k;
  const singular = measured.first_person_singular_per_10k;
  const plural = measured.first_person_plural_per_10k;

  const dominant = [
    { count: second, instruction: 'Address the reader in the second person' },
    { count: singular, instruction: 'Speak in the first person singular' },
    { count: plural, instruction: 'Speak in the first person plural — "we", not "I" and not "you"' },
  ].reduce((best, one) => (one.count > best.count ? one : best));

  return (
    `- **Register.** ${dominant.instruction}; it is the commonest of the three in the corpus — ` +
    `${second} second-person, ${singular} first-person-singular and ${plural} first-person-plural ` +
    `words per ten thousand. Items run around ${measured.words_per_item} words across ${items} of ` +
    'them, so match that length, not a summary of it.'
  );
}

function instructionFor(move: string): string {
  return MOVES.find((definition) => definition.move === move)!.instruction;
}

function matchSpans(regex: RegExp, text: string): number[] {
  regex.lastIndex = 0;
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    starts.push(match.index);
    // A zero-width match would loop forever. None of the patterns can produce one, but
    // a future pattern that could should fail loudly rather than hang a cron job.
    if (match[0].length === 0) throw new Error(`voice pattern matched nothing at ${match.index}`);
  }
  return starts;
}

function countMatches(items: MeasuredItem[], regex: RegExp): number {
  return items.reduce((total, item) => total + matchSpans(regex, item.body_text).length, 0);
}

/**
 * Exemplars spread across the window rather than the three most recent, because three
 * exemplars from one week describe a week. Deterministic: the first match of the first,
 * middle and last Item that used the move.
 */
function pickExemplars(used: { item: MeasuredItem; spans: number[] }[]): Exemplar[] {
  if (used.length === 0) return [];

  const wanted = Math.min(EXEMPLARS_PER_MOVE, used.length);
  const chosen = new Set<number>();
  for (let slot = 0; slot < wanted; slot += 1) {
    chosen.add(wanted === 1 ? 0 : Math.round((slot * (used.length - 1)) / (wanted - 1)));
  }

  return [...chosen]
    .sort((left, right) => left - right)
    .map((index) => {
      const { item, spans } = used[index]!;
      return {
        text: fragment(item.body_text, spans[0]!),
        item: item.external_id,
        url: item.url,
        published_at: item.published_at,
      };
    });
}

/**
 * A slice of the body, cut at a space. Never re-punctuated, never joined, never tidied.
 *
 * It also stops at the first newline rather than rendering across one. A caption event
 * boundary inside an exemplar would have to be either flattened — which edits the text —
 * or emitted raw, which breaks the markdown list it lands in. Stopping short of it edits
 * nothing.
 */
function fragment(body: string, start: number): string {
  const limit = Math.min(body.length, start + EXEMPLAR_MAX_CHARS);
  const newline = body.indexOf('\n', start);
  const end = newline >= 0 && newline < limit ? newline : limit;
  if (end === body.length) return body.slice(start).trim();
  const space = body.lastIndexOf(' ', end);
  return body.slice(start, space > start ? space : end).trim();
}

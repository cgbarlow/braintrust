/**
 * The menu of argument habits: what a Persona may say about how someone argues, authored
 * here and nowhere else.
 *
 * **The compile selects; it never writes.** Every line that reaches a reader is text in this
 * file, so a conclusion cannot reach the Script — the model's whole contribution is choosing
 * which of these are characteristic and which Items show it. That is what the
 * `habits_are_on_the_menu` gate check enforces against this list, and it is why changing
 * what a Persona can say about anybody is a code change with a diff.
 *
 * **The block is always the same length.** Before this, the compiler asked for a free
 * description and kept whatever cleared a three-item floor. Measured: the synthesiser's
 * verdict on a given habit agrees with itself 85% of the time, but the count of Items it
 * cites moves by 1.4 — and a floor of three sat on the fattest part of that distribution. So
 * the block halved between rebuilds for reasons that had nothing to do with the person, and
 * a reader watching it get thinner could not point at what changed. **The floor is gone.**
 * Nothing ships or fails on a count.
 *
 * **What a reader gets is {@link HABITS_SHIPPED} lines, ranked by evidence, or fewer.**
 * Fewer when a thin Corpus genuinely supports fewer — the ranking never force-fits, because
 * a habit invented to reach four is worse than a block of three.
 *
 * Organised by where in an argument the move happens, because that is what stops the menu
 * quietly filling up with near-synonyms of "uses examples".
 *
 * The draft menu and every measurement behind it are on `prototype/argument-habits-menu` and
 * `probe/style-stability-152`. See docs/design/compiler.md §3.
 */

export type Habit = { slug: string; instruction: string; test: string };

export const MENU: Habit[] = [
  // ── How they open ───────────────────────────────────────────────────────────
  {
    slug: 'opens-on-the-mistaken-instinct',
    instruction: 'Open by naming the thing most people reach for first, and why it fails them.',
    test: 'Starts from a widespread habit, assumption or default the audience already holds, and treats correcting it as the work.',
  },
  {
    slug: 'opens-on-a-case',
    instruction: 'Open on a specific episode, then widen to what it shows.',
    test: 'Begins with one concrete event, incident or story, and moves outward from it rather than starting general.',
  },
  {
    slug: 'opens-on-own-experiment',
    instruction: 'Open on what happened when you tried it yourself.',
    test: 'Begins from first-hand trial of the thing under discussion, with the author as the one who ran it.',
  },
  {
    slug: 'opens-on-the-buried-assumption',
    instruction: 'Open by naming what the question takes for granted.',
    test: 'Begins by surfacing an unstated premise underneath the discussion, rather than by taking a side in it.',
  },

  // ── How they get from premise to conclusion ─────────────────────────────────
  {
    slug: 'reasons-by-analogy',
    instruction: 'Reach for an analogy before you reach for a definition.',
    test: 'Carries the argument on a sustained comparison to a different domain, where the comparison does the explanatory work.',
  },
  {
    slug: 'builds-a-named-frame',
    instruction: 'Give the pattern a name, then reason inside it.',
    test: 'Coins or names a framework, then uses that name as the unit of the rest of the argument.',
  },
  {
    slug: 'reasons-from-first-principles',
    instruction: 'Go back to what has to be true, then rebuild forward.',
    test: 'Strips a question to underlying constraints and reconstructs the answer from them rather than from precedent.',
  },
  {
    slug: 'extrapolates-a-trend',
    instruction: 'Take the direction of travel seriously, and say where it lands.',
    test: 'Reads a trajectory across time and argues from where it is heading rather than where it is.',
  },
  {
    slug: 'separates-conflated-questions',
    instruction: 'Split the question before answering it.',
    test: 'Argues that what is being treated as one question is several, and answers them apart.',
  },
  {
    slug: 'dissolves-rather-than-answers',
    instruction: "Show why the question can't be settled in advance, and say what to do instead.",
    test: 'Argues the question as posed cannot be answered up front, and replaces it with a procedure for finding out.',
  },
  {
    slug: 'argues-from-cost-shift',
    instruction: 'Ask what just got cheap, and follow what that changes.',
    test: 'Locates a change in what something costs and derives the consequence from it.',
  },

  // ── What moves them ─────────────────────────────────────────────────────────
  {
    slug: 'moved-by-the-worked-example',
    instruction: 'Show the thing working before you argue about it.',
    test: 'Treats a demonstration or walked-through instance as the load-bearing evidence.',
  },
  {
    slug: 'moved-by-measurement',
    instruction: 'Reach for the number, and say where it came from.',
    test: 'Leans on counts, benchmarks or study results, and attributes them.',
  },
  {
    slug: 'moved-by-what-was-built',
    instruction: 'Argue from what you built, not what you propose.',
    test: 'Treats having shipped the thing as the argument, with the artefact standing in for the claim.',
  },
  {
    slug: 'discounts-the-official-account',
    instruction: 'Check what the record actually supports before accepting the story.',
    test: 'Sets aside the popular or stated explanation and reasons from what is independently evidenced.',
  },

  // ── How they handle opposition ──────────────────────────────────────────────
  {
    slug: 'concedes-then-narrows',
    instruction: 'Grant the objection, then show how little it costs you.',
    test: 'Accepts the strongest counterpoint on its own terms, then bounds its consequences.',
  },
  {
    slug: 'rejects-the-standard-framing',
    instruction: 'Refuse the terms of the question, and re-set them.',
    test: 'Declines the conventional framing outright and substitutes another before arguing.',
  },
  {
    slug: 'flags-its-own-limits',
    instruction: 'Say what you are unsure of, in the same breath as the claim.',
    test: 'Attaches caveats, unknowns or failure conditions to its own conclusions as it makes them.',
  },
  {
    slug: 'refuses-the-monolith',
    instruction: 'Break the category up before judging it.',
    test: 'Argues a group being treated as uniform is not, and insists on case-by-case treatment.',
  },

  // ── How they close ──────────────────────────────────────────────────────────
  {
    slug: 'closes-on-a-procedure',
    instruction: 'End with the steps, in order.',
    test: 'Finishes with a repeatable sequence the reader can follow.',
  },
  {
    slug: 'closes-on-a-condition',
    instruction: 'End on when this holds and when it does not.',
    test: 'Finishes with a qualified recommendation scoped to circumstances rather than a flat one.',
  },
  {
    slug: 'closes-on-an-invitation',
    instruction: 'End by handing the reader something to go and do with you.',
    test: 'Finishes by recruiting the reader into the work rather than concluding for them.',
  },
  {
    slug: 'closes-on-what-it-costs-us',
    instruction: 'End on what we lose if this keeps going.',
    test: 'Finishes on the stakes or the price of the trajectory rather than on advice.',
  },
];


/**
 * How many lines ship. **Four, and the same four-ness every rebuild** — a block whose length
 * moves is one a reader reads as the person having changed, when what changed was how many
 * Items a model happened to cite that night.
 */
export const HABITS_SHIPPED = 4;

/** One habit as the model returns it: a slug off the menu, and the Items it is visible in. */
export type ChosenHabit = {
  slug: string;
  /** Item `external_id`s. Verified against the Notes that were handed over, never trusted. */
  items: string[];
};

const BY_SLUG = new Map(MENU.map((habit) => [habit.slug, habit]));

/** The authored habit behind a slug, or nothing. Nothing off the menu can be rendered. */
export function habitFor(slug: string): Habit | undefined {
  return BY_SLUG.get(slug);
}

export function isOnTheMenu(slug: string): boolean {
  return BY_SLUG.has(slug);
}

/**
 * The lines that ship, from what the model chose.
 *
 * Three things happen here and all three are arithmetic, so all three have a right answer.
 *
 * **Anything off the menu is dropped.** Not corrected, not matched loosely — a slug
 * braintrust did not author is a line braintrust cannot stand behind.
 *
 * **Two habits resting on identical evidence become one.** Measured on five real Corpora:
 * 9 of 52 shipping lines carried evidence *identical* to another line, and one Person had
 * four lines all resting on the same three Items. A reader shown four lines believes four
 * things were found; when the evidence is the same set, one thing was found and worded four
 * ways. The survivor is the one the tie-break picks, and the tie-break is a function of the
 * reply and nothing else — measured stable across three seeds on every twin group found.
 *
 * **The ranking is by evidence, and ties break deterministically.** More Items first, then
 * menu order — so the same reply always produces the same four lines in the same order, and
 * a rebuild that changed nothing changes nothing.
 */
export function shippableHabits(chosen: ChosenHabit[], known: Set<string>): ChosenHabit[] {
  const seen = new Set<string>();
  const valid: ChosenHabit[] = [];

  for (const habit of chosen) {
    if (!isOnTheMenu(habit.slug) || seen.has(habit.slug)) continue;
    // The same rule as every other attribution: an id braintrust did not hand over is an
    // id it cannot show, and a habit left with none is a habit it cannot evidence.
    const items = [...new Set(habit.items.filter((item) => known.has(item)))].sort();
    if (items.length === 0) continue;
    seen.add(habit.slug);
    valid.push({ slug: habit.slug, items });
  }

  const order = new Map(MENU.map((habit, index) => [habit.slug, index]));
  const ranked = [...valid].sort(
    (left, right) =>
      right.items.length - left.items.length ||
      (order.get(left.slug) ?? 0) - (order.get(right.slug) ?? 0),
  );

  // Twins, resolved after ranking so the survivor is the highest-ranked of the group.
  const takenEvidence = new Set<string>();
  const distinct: ChosenHabit[] = [];
  for (const habit of ranked) {
    const key = habit.items.join('\u0000');
    if (takenEvidence.has(key)) continue;
    takenEvidence.add(key);
    distinct.push(habit);
  }

  // Never padded. A thin corpus yields fewer habits; it never yields invented ones.
  return distinct.slice(0, HABITS_SHIPPED);
}

/** Two lines in one block resting on the identical set of Items. What the gate refuses. */
export function twinEvidence(habits: { items: string[] }[]): string[][] {
  const byEvidence = new Map<string, string[][]>();
  for (const habit of habits) {
    const key = [...habit.items].sort().join('\u0000');
    byEvidence.set(key, [...(byEvidence.get(key) ?? []), habit.items]);
  }
  return [...byEvidence.values()].filter((group) => group.length > 1).map((group) => group[0]!);
}

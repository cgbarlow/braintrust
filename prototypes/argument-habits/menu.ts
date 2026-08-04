/**
 * Menu of argument habits — draft 0, for #145.
 *
 * The guarantee this menu exists to provide: a conclusion cannot reach the Script, because the
 * Script is assembled only from text authored here. The compile *selects*; it never writes. So
 * both fields below are authored by hand and neither is ever model-generated.
 *
 *   slug        what the compile picks, and what the hard check tests membership against
 *   instruction what renders into HOW THEY ARGUE, verbatim
 *   test        what the compile matches against — deliberately about the move, not the subject
 *
 * Organised by where in an argument the move happens, because that is what stops the menu
 * quietly filling up with near-synonyms of "uses examples".
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

/** Renders exactly as the Script would. Instruction text only — slugs never surface. */
export function renderHowTheyArgue(slugs: string[]): string {
  const chosen = slugs
    .map((s) => MENU.find((h) => h.slug === s))
    .filter((h): h is Habit => Boolean(h));
  if (chosen.length === 0) return '';
  return ['HOW THEY ARGUE', '', ...chosen.map((h) => `- ${h.instruction}`)].join('\n');
}

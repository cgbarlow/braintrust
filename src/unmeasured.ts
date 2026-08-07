/**
 * What braintrust does with a quantity it has not measured.
 *
 * **An unmeasured quantity takes its most conservative value, not its most convenient
 * one.** The rule exists because the first version of it pointed the wrong way and a
 * Persona answered a question about poaching eggs.
 *
 * The retrieval floor is measured per Persona on every Compile, and every floor braintrust
 * has ever measured sits between 0.44 and 0.52. The fallback for a Persona that had
 * measured none was 0.35 — *below the whole range*. So the one Persona that knew least
 * about its own gate was the most credulous, letting through exactly what a measured value
 * would have caught. An absence of evidence had been quietly read as evidence of absence.
 *
 * Two halves, because two kinds of thing go unmeasured.
 *
 * **A number takes its cautious value.** There is always a direction that fails safe: a
 * floor points up, a span that grades confidence points wide. That value is a *constant*
 * and never a calculation over what other Personas measured — one Person's calibration
 * moving another Person's gate is a coupling nobody can debug and nobody asked for.
 *
 * **Prose has no cautious direction, so it is absent until rebuilt.** There is no careful
 * way to read a paragraph written under a rule that has since changed; the only honest
 * options are to serve it or not to. Synthesised text governed by a part of the compiler
 * that has moved is withheld, and the Persona reads exactly like one that never had it.
 * See ./compile/version.ts.
 *
 * **The caution is never announced.** A Persona that declines because it is uncalibrated
 * must be indistinguishable from one that declines because the question is genuinely off
 * its Corpus — a second kind of silence was recommended and declined, because it would tell
 * a reader something about braintrust's internals in the one place that is supposed to be
 * about the Person. What braintrust could not measure is in the receipts, where questions
 * about braintrust's own workings belong.
 *
 * **And it never refuses a whole Persona.** The cost of refusal lands on a reader who did
 * nothing wrong; the cost of caution lands on a question that was probably a stretch.
 */

/**
 * The floor a Persona uses when its own has not been measured.
 *
 * **Above every floor braintrust has measured (0.44–0.52), and deliberately a constant.**
 * A fallback inside or below the measured range is one that answers questions a measured
 * value would have refused, which is the failure this replaces. Above it, an uncalibrated
 * Persona is cautious rather than credulous: it declines some questions it could have
 * answered, and a reader can still ask them of a Persona whose next Compile measures a
 * floor of its own.
 *
 * By design this produces **more empty answers**, and that is the trade the number
 * encodes. An empty answer costs a reader one question; a confident answer to a question
 * nobody wrote about costs them their reason to trust any of the others.
 */
export const UNMEASURED_RETRIEVAL_FLOOR = 0.55;

/**
 * **`fit` has no unmeasured value, and that is the exception this file needs to state.**
 *
 * There was one: a deliberately wide span, on the reasoning that a wide scale grades genuine
 * matches `partial` where a narrow one would call weak matches `close`, and that an
 * uninformative grade is a smaller failure than a confidently wrong one. The first half was
 * sound and the conclusion was not. **A grade has no cautious direction.** A floor points up
 * and an uncalibrated Persona simply declines more; a grade has two ways to be wrong that
 * point opposite ways — `distant` on the answer a reader wanted, `close` on the one they did
 * not — and no setting of the scale avoids both. A wide span does not decline; it *guesses*,
 * and it guesses `partial` on everything, which is the shape the live probe found: 46 `close`
 * grades of which 21 went to Positions a reader rejects outright.
 *
 * So the third option is taken, and it only exists for a grade: **say nothing.** A Persona
 * whose Compile measured no cut of its own returns every Position it holds, in the order the
 * statement score puts them, with `fit: 'ungraded'` beside each — which is not a fourth grade
 * but the absence of one. See ./compile/fit.ts and ./find.ts.
 *
 * The general rule stands and this sharpens it: an unmeasured *number* takes its cautious
 * value, unmeasured *prose* is absent until rebuilt, and an unmeasured *judgement* is
 * withheld. What braintrust could not measure is in the receipts.
 */

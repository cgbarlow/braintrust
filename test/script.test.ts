/**
 * The Script — the spoken form, rendered at the boundary.
 *
 * Two properties carry this file. **The boundary may select and inflect, never
 * paraphrase**: everything here is prose the compiler already wrote, with braintrust's
 * bookkeeping removed and nothing composed in its place. And **the carrier must never go
 * quiet**: a label that cannot become an instruction is carried verbatim, and the count of
 * those is the only instrument that catches a Compile writing labels nobody can speak.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SPOKEN_DISCLOSURE } from '../src/disclosure.js';
import {
  isStructuralSkew,
  renderScript,
  renderVoice,
  type ScriptInput,
} from '../src/script.js';

const NATE_VOICE = [
  'Write as this person writes. Every instruction below is followed by what it was measured from.',
  '',
  '- **Characteristically.** Hedge before committing. — measured in 515 of 515 items.',
  '',
  '- **Register.** Address the reader in the second person; it is the commonest of the three in the corpus — 304.7 second-person, 189.7 first-person-singular and 116.1 first-person-plural words per ten thousand. Items run around 3165 words across 515 of them, so match that length, not a summary of it.',
  '',
  'Measured too thinly to instruct, and deliberately left out: reframe (98 of 515). Do not add them back.',
].join('\n');

function input(overrides: Partial<ScriptInput> = {}): ScriptInput {
  return {
    subject: 'braintrust model of Nate B. Jones',
    voiceGenerative: NATE_VOICE,
    voiceBasis: 'measured',
    reasoningBasis: 'inferred',
    reasoningLabels: [],
    bySource: {
      'youtube:UC0C': {
        platform: 'youtube',
        retrieved: 514,
        skipped_paywall: 0,
        failed: 1,
        backfill_complete: true,
      },
    },
    itemsRead: 515,
    wordsRead: 1629968,
    window: ['2024-08-01', '2026-07-29'],
    ...overrides,
  };
}


describe('voice, with the bookkeeping taken out', () => {
  const rendered = renderVoice(NATE_VOICE);

  it('deletes the length instruction outright', () => {
    // words_per_item measures how long his articles are. Nothing measures how long his
    // replies are, so "match that length" is an inference the measurement never licensed —
    // and following it answers a chat message with a keynote.
    assert.doesNotMatch(rendered, /match that length/);
    assert.doesNotMatch(rendered, /3165 words/);
  });

  it('keeps every move, because the moves are what make someone recognisable', () => {
    assert.match(rendered, /Hedge before committing\./);
    assert.match(rendered, /Address the reader in the second person/);
    assert.match(rendered, /Do not add them back\./);
  });

  it('strips the counts the moves were measured from', () => {
    assert.doesNotMatch(rendered, /measured in \d+ of \d+/);
    assert.doesNotMatch(rendered, /per ten thousand/);
    assert.doesNotMatch(rendered, /\(\d+ of \d+\)/);
    assert.doesNotMatch(rendered, /Write as this person writes/);
  });
});

describe('a structural blind spot', () => {
  it('is a source whose unread share dominates what was read', () => {
    // Nate's Substack: 23 paywalled against 1 read. A persona built from his videos
    // answers questions about his writing fluently and wrongly, and no mid-conversation
    // admission ever fires because the videos always have something to say.
    assert.equal(
      isStructuralSkew({
        platform: 'substack',
        retrieved: 1,
        skipped_paywall: 23,
        failed: 0,
        backfill_complete: true,
      }),
      true,
    );
  });

  it('is not a single failed fetch, which is an incident', () => {
    assert.equal(
      isStructuralSkew({
        platform: 'youtube',
        retrieved: 514,
        skipped_paywall: 0,
        failed: 1,
        backfill_complete: true,
      }),
      false,
    );
  });
});

describe('the script', () => {
/**
   * **The first line, and the only one not addressed to the model.** A model recites the
   * top of the block it was handed, verbatim, whatever is there — measured across six
   * payload variants and ~130 replies, with both the Hermes profile and the tool
   * description independently telling it to. When that line was an instruction, an
   * instruction is what a reader heard.
   */
  it('opens with the disclosure itself, unquoted, as the literal first line', () => {
    const { speak } = renderScript(input());

    assert.equal(speak.split('\n')[0], SPOKEN_DISCLOSURE);
    // Unquoted: a line in quotation marks is a line a model reports rather than says.
    assert.doesNotMatch(speak.split('\n')[0]!, /["'`]/);
  });

  it('says the same sentence for every persona and every session', () => {
    const nate = renderScript(input());
    const ethan = renderScript(input({ subject: 'braintrust model of Ethan Mollick' }));
    const skewed = renderScript(
      input({
        bySource: {
          'youtube:UC0C': {
            platform: 'youtube',
            retrieved: 40,
            skipped_paywall: 0,
            failed: 0,
            backfill_complete: true,
          },
          'substack:nate': {
            platform: 'substack',
            retrieved: 1,
            skipped_paywall: 23,
            failed: 0,
            backfill_complete: true,
          },
        },
      }),
    );

    for (const { speak } of [nate, ethan, skewed]) {
      assert.equal(speak.split('\n')[0], SPOKEN_DISCLOSURE);
    }
    // Rendered fresh on every call and identical every time — nothing about the session,
    // the corpus or the person reaches it.
    assert.equal(renderScript(input()).speak, nate.speak);
  });

  it('puts everything addressed to the model below it', () => {
    const { speak } = renderScript(input());
    const [first, ...rest] = speak.split('\n');

    assert.equal(first, SPOKEN_DISCLOSURE);
    // The instruction that used to be the first line is still there — one line down.
    assert.match(rest.join('\n'), /You are a braintrust model of Nate B\. Jones\. You are not that person\./);
    assert.doesNotMatch(first!, /You are|Open your|Say /);
  });

  /**
   * The two-field split was the worst of the six variants measured, for the same reason a
   * first-line instruction fails: a model reads the top of what it is given, and a second
   * field is not the top of anything.
   */
  it('is one field, because splitting spoken from instructing was measured and rejected', () => {
    const rendered = renderScript(input());

    assert.deepEqual(Object.keys(rendered).sort(), ['receipts', 'speak']);
    assert.ok(!('say' in rendered) && !('instruct' in rendered));
  });

  it('discloses once and says not to repeat it', () => {
    const { speak } = renderScript(input());
    const [first, ...rest] = speak.split('\n');

    // The denial is asserted against the *first* line, the enforced one — so a regression
    // that empties it cannot be absorbed by the opening line saying the same thing.
    assert.match(first!, /not the person/);
    assert.match(rest.join('\n'), /braintrust model of Nate B\. Jones/);
    assert.match(speak, /Say both once\. Do not say them again\./);
  });

  /**
   * The opening line carried `— not the person` too, and the duplication is what crowded the
   * corpus clause out: the Script licenses the model's own wording, so the shortest true
   * reading was the half the reader had already heard one line above.
   */
  it('does not repeat the denial in the opening line', () => {
    const { speak } = renderScript(input());
    const opening = speak.split('\n').slice(1).join('\n');

    assert.match(speak, /"I'm a braintrust model of Nate B\. Jones\."/);
    assert.doesNotMatch(opening, /not the person/);
  });

  it('leads with scope, not scale, when a source is majority unread', () => {
    const { speak } = renderScript(
      input({
        bySource: {
          'youtube:UC0C': {
            platform: 'youtube',
            retrieved: 514,
            skipped_paywall: 0,
            failed: 0,
            backfill_complete: true,
          },
          'substack:nate': {
            platform: 'substack',
            retrieved: 1,
            skipped_paywall: 23,
            failed: 0,
            backfill_complete: true,
          },
        },
      }),
    );

    // "515 things, with 23 more behind a paywall" reads as a rounding error while
    // concealing that an entire source is unread. Scale is not skew.
    assert.match(speak, /their videos, not their writing/);
    assert.doesNotMatch(speak, /515 things/);
    // The name, then the one clause that varies per persona — and nothing else competing
    // with it for a compressing model's attention.
    assert.match(
      speak,
      /"I'm a braintrust model of Nate B\. Jones\. braintrust has read their videos, not their writing\."/,
    );
  });

  /**
   * **Selection, never composition.** Every line is text authored in compile/habits.ts, so
   * a conclusion cannot reach the Script — the whole guarantee the menu exists to provide.
   */
  it('renders the menu own words, and nothing the compiler chose off it', () => {
    const { speak } = renderScript(
      input({
        reasoningLabels: [
          'opens-on-the-mistaken-instinct',
          'reasons-by-analogy',
          'a-habit-nobody-authored',
        ],
      }),
    );

    assert.match(speak, /- Open by naming the thing most people reach for first, and why it fails them\./);
    assert.match(speak, /- Reach for an analogy before you reach for a definition\./);
    // The slug never surfaces, and neither does a line braintrust did not write.
    assert.doesNotMatch(speak, /a-habit-nobody-authored/);
    assert.doesNotMatch(speak, /opens-on-the-mistaken-instinct/);
  });

  it('hands a reader no count, anywhere', () => {
    const { speak, receipts } = renderScript(
      input({ reasoningLabels: ['opens-on-the-mistaken-instinct', 'reasons-by-analogy'] }),
    );

    // The count moved by 1.4 between rebuilds on identical notes, so a reader watching the
    // block change was watching the measurement wobble rather than the person.
    assert.doesNotMatch(speak, /\d+ of \d+/);
    assert.doesNotMatch(speak, /Traced to/);
    assert.ok(!('labels_carried' in receipts));
  });

  it('leaves the block out entirely when nothing was chosen', () => {
    const { speak } = renderScript(input({ reasoningLabels: [] }));

    // Absent rather than empty: a heading with nothing under it reads as a person who
    // argues no particular way, which is a claim braintrust did not make.
    assert.doesNotMatch(speak, /HOW THEY ARGUE/);
  });

  it('forbids the two things that survive every other guard', () => {
    const { speak } = renderScript(input());

    // An empty answer cannot tell "they never said it" from "braintrust never read it",
    // so the admission is always about this persona's reach.
    assert.match(speak, /Never say you never wrote about something/);
    // And the same lie with better manners: an answer the client supplied itself,
    // delivered in their voice.
    assert.match(speak, /never fill the gap from your own knowledge/i);
  });

  /**
   * **A dead end is handed back as a choice.** Nothing was broken about the honesty — a
   * persona handed an empty answer admits it and does not fill, 24 of 24 across every arm and
   * seed. What was wrong was the shape: *"I don't have a view on central bank interest rate
   * policy."* and no next move, on the first question a reader asks.
   */
  it('tells the persona to offer what is nearby rather than stopping', () => {
    const { speak } = renderScript(input());

    assert.match(speak, /do not stop there/i);
    assert.match(speak, /offer to go into them/i);
    // In their words, not braintrust's — which is what keeps the never-generic rule at one
    // exception. braintrust hands over the facts of an empty answer and never the sentence.
    assert.match(speak, /The words are yours, not braintrust's/);
  });

  /**
   * **The founding failure of this map, mitigated where it actually lives.** Withhold the
   * search tool from the model while leaving it named in the persona tool's description —
   * what a client with tool search hands over — and the persona invents: 0 of 3 lookups,
   * three fluent answers in voice. What survives #138 is *"I don't have a view on quests
   * versus goals"*: honest about the persona, false about the person.
   */
  it('tells the persona to say when it cannot reach the record at all', () => {
    const { speak } = renderScript(input());

    assert.match(speak, /no way to look anything up at all/i);
    assert.match(speak, /not the same as having\s*\n?\s*no view/i);
    assert.match(speak, /Do not answer as them from anywhere else/i);
  });

  /**
   * **A forged citation is the one class every other guard here misses.** Run live, a persona
   * retrieved and then invented a source title, a 2026 date and a quotation to match — with
   * something behind it, and a checkable-*looking* pointer to a post nobody wrote. That is
   * worse than silence, because a listener who follows it up believes they checked.
   */
  it('tells the persona to speak what it looked up rather than recite it', () => {
    const { speak } = renderScript(input());

    const section = speak.split('WHEN YOU HAVE LOOKED SOMETHING UP')[1]!;
    assert.match(section, /Say what you found as your own view, in your own words\./);
    // The three things that leave the unasked answer, named so none of them can go quiet.
    assert.match(section, /No title, no date, no quotation/);
    assert.match(section, /nothing about where it came from/);
    // Paraphrased and flat: no attribution, and no hedge standing in for one either.
    assert.match(section, /Flat, and in your register/);
    assert.match(section, /not "I wrote about this last year"/);
    assert.match(section, /not "broadly speaking"/);
  });

  /**
   * **The bound belongs here, not only in a tool description.** *What have you published
   * lately* is a question whose whole answer is titles and dates, so an unqualified
   * prohibition empties it — the degenerate answer braintrust_recent_items exists to prevent.
   * A description is read at choosing time and a Hermes soul is copied into a profile once;
   * the script is the only surface guaranteed to be in front of the model.
   */
  it('bounds the rule where the question is itself what they published', () => {
    const { speak } = renderScript(input());

    const section = speak.split('WHEN YOU HAVE LOOKED SOMETHING UP')[1]!;
    assert.match(section, /Unless what they published is itself the question\./);
    assert.match(section, /the titles and the dates are what was asked for — name them/);
    // And the distinction that keeps the bound from swallowing the rule.
    assert.match(section, /Asked what you think about something, they are not/);
    assert.match(section, /a title and a date hung on a claim nobody asked the source of/);

    // **The trigger is the inventory question and nothing wider.** "What have you written
    // about hiring?" is a question about hiring — the topic shape this rule exists to keep
    // unattributed, and the sentence the interrogation probes with — so a carve-out reading
    // "asked what you have written" would collect it.
    assert.doesNotMatch(section, /[Aa]sked what you have written/);
  });

  /**
   * **That asking works is a guarantee, never an offer.** No invitation ships — not in the
   * disclosure, not in the self-identification line, not as a trailing offer — so the script
   * spends a sentence forbidding one rather than leaving it to taste.
   */
  it('forbids inviting the reader to ask for the record', () => {
    const { speak } = renderScript(input());

    assert.match(speak, /hand it over whole if somebody asks for it/i);
    assert.match(speak, /Never offer it first, and never tell anyone they can ask\./);
    // The trailing offer this rules out, in the shapes a model reaches for.
    assert.doesNotMatch(speak, /(ask me|let me know|happy to) (for|share|provide)/i);
    assert.doesNotMatch(speak, /if you(?:'d| would) like the (source|citation|quote)/i);
  });

  /** The two lines this ticket was told not to touch, asserted where they are rendered. */
  it('leaves the fixed disclosure and the first-line rule alone', () => {
    const { speak } = renderScript(input());
    const lines = speak.split('\n');

    assert.equal(lines[0], SPOKEN_DISCLOSURE);
    assert.match(speak, /Say that line first, word for word, before anything else\./);
    // The new section is below both, where everything addressed to the model lives.
    assert.ok(speak.indexOf('WHEN YOU HAVE LOOKED SOMETHING UP') > speak.indexOf('Say that line first'));
  });

  it('puts basis in the receipts, where it cannot be spoken', () => {
    const { speak, receipts } = renderScript(input());

    assert.equal(receipts.voice, 'measured');
    assert.equal(receipts.reasoning, 'inferred');
    assert.deepEqual(receipts.window, ['2024-08-01', '2026-07-29']);
    // Not a sentence anywhere in the spoken block.
    assert.doesNotMatch(speak, /measured|inferred/);
  });

  describe('a persona whose rebuild is stuck', () => {
    it('says nothing when the persona is healthy', () => {
      const { speak } = renderScript(input());
      assert.doesNotMatch(speak, /ABOUT THIS MODEL/);
    });

    it('includes a stuck-rebuild section when the persona is behind for two or more cycles', () => {
      const { speak } = renderScript(
        input({ stuckRebuild: { first_stuck_at: '2026-08-08T09:00:00.000Z', cycles_behind: 2 } }),
      );

      assert.match(speak, /ABOUT THIS MODEL/);
      assert.match(speak, /2 rounds of changes/);
      assert.match(speak, /say so if it comes up/i);
      assert.doesNotMatch(speak, /if anybody asks/);
    });
  });

  it('names what went unread per source, in the receipts rather than in voice', () => {
    const { receipts } = renderScript(
      input({
        bySource: {
          'substack:nate': {
            platform: 'substack',
            retrieved: 1,
            skipped_paywall: 23,
            failed: 0,
            backfill_complete: false,
          },
        },
      }),
    );

    assert.deepEqual(receipts.unread, [
      'substack:nate — 23 paywalled, not walked back to its beginning, 1 read',
    ]);
  });
});

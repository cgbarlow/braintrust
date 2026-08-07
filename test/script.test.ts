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
  renderLabel,
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

describe('turning a compiled label into something speakable', () => {
  it('inflects a verb-initial label to the imperative', () => {
    assert.deepEqual(renderLabel('Assumes continued exponential capability growth'), {
      text: 'Assume continued exponential capability growth.',
      carried: false,
    });
  });

  it('carries a label with no verb to inflect, rather than guessing at one', () => {
    // Every one of nate-b-jones's eight reasoning labels is shaped like this. Dropping
    // them left that persona with a manner and no mind.
    assert.deepEqual(renderLabel('Infrastructure-first focus'), {
      text: 'Infrastructure-first focus',
      carried: true,
    });
  });

  it('carries rather than mangling a noun phrase whose first word ends in s', () => {
    // The reason this is a lookup table and not a morphology rule: stripping the trailing
    // `s` here produces "System thinking", which is not English and not a disposition.
    const rendered = renderLabel('Systems thinking as a lever');

    assert.equal(rendered!.carried, true);
    assert.equal(rendered!.text, 'Systems thinking as a lever');
  });

  it('drops a label with nothing in it, which is the only omission left', () => {
    assert.equal(renderLabel('   '), undefined);
  });
});

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

    assert.match(speak, /braintrust model of Nate B\. Jones/);
    assert.match(speak, /not the person/);
    assert.match(speak, /Say both once\. Do not say them again\./);
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
  });

  it('separates the labels it could instruct from the ones it had to carry', () => {
    const { speak, receipts } = renderScript(
      input({
        reasoningLabels: [
          'Treats prompting skill as the scarce resource',
          'Infrastructure-first focus',
          'Bottleneck-oriented value framework',
        ],
      }),
    );

    assert.match(speak, /- Treat prompting skill as the scarce resource\./);
    assert.match(speak, /You habitually frame things this way:/);
    assert.match(speak, /- Infrastructure-first focus/);
    assert.match(speak, /- Bottleneck-oriented value framework/);
    // The number that says the Compile needs fixing. Because anything can be listed
    // verbatim, a carrier could otherwise absorb a broken compile silently.
    assert.equal(receipts.labels_carried, 2);
  });

  it('reports nothing carried when every label inflected', () => {
    const { speak, receipts } = renderScript(
      input({ reasoningLabels: ['Frames AI use as a shift to autonomous agents'] }),
    );

    assert.equal(receipts.labels_carried, 0);
    assert.doesNotMatch(speak, /You habitually frame things this way/);
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

  it('puts basis in the receipts, where it cannot be spoken', () => {
    const { speak, receipts } = renderScript(input());

    assert.equal(receipts.voice, 'measured');
    assert.equal(receipts.reasoning, 'inferred');
    assert.deepEqual(receipts.window, ['2024-08-01', '2026-07-29']);
    // Not a sentence anywhere in the spoken block.
    assert.doesNotMatch(speak, /measured|inferred/);
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

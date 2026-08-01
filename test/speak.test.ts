/**
 * The default response template.
 *
 * Two things it must never stop doing — naming the persona as a model, and pointing at
 * the blind spots — and one thing it must never start doing: rewriting a layer. The
 * markers stay in the stored prose; all this adds is an instruction beside them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { subjectFor } from '../src/disclosure.js';
import { openingLine, speakAs } from '../src/speak.js';

const SUBJECT = subjectFor('Nate B. Jones');

const CORPUS = {
  items_retrieved: 515,
  items_skipped_paywall: 22,
  window: ['2023-04-02', '2026-07-30'] as [string, string],
};

describe('the opening line', () => {
  it('names the persona as a model, never as the person', () => {
    const line = openingLine(SUBJECT, CORPUS);
    assert.match(line, /braintrust model of Nate B\. Jones/);
    assert.match(line, /not the person/);
  });

  it('says how much was read, so a thin corpus announces itself before the first claim', () => {
    assert.match(openingLine(SUBJECT, CORPUS), /515 things they published between 2023-04-02 and 2026-07-30/);
  });

  it('names paywalled items, because scale is exactly where a corpus misleads', () => {
    assert.match(openingLine(SUBJECT, CORPUS), /22 more behind a paywall braintrust never read/);
  });

  it('stays silent about a paywall there is no evidence of', () => {
    const line = openingLine(SUBJECT, { ...CORPUS, items_skipped_paywall: 0 });
    assert.doesNotMatch(line, /paywall/);
    assert.match(line, /515 things/);
  });

  it('counts one item as a thing rather than as things', () => {
    const line = openingLine(SUBJECT, { ...CORPUS, items_retrieved: 1, items_skipped_paywall: 0 });
    assert.match(line, /built from 1 thing they published/);
  });

  it('still discloses when there is no corpus block to report', () => {
    const line = openingLine(SUBJECT);
    assert.match(line, /braintrust model of Nate B\. Jones/);
    assert.match(line, /not the person/);
    assert.doesNotMatch(line, /built from/);
  });
});

describe('the template', () => {
  it('carries the opening line it is asking for', () => {
    assert.ok(speakAs(SUBJECT, CORPUS).includes(openingLine(SUBJECT, CORPUS)));
  });

  it('describes the bookkeeping it is asking the client not to speak', () => {
    const template = speakAs(SUBJECT, CORPUS);
    assert.match(template, /measured or synthesised/);
    assert.match(template, /which model wrote it/);
    assert.match(template, /traced back to/);
  });

  it('describes those markers rather than quoting them, so the boundary never emits one', () => {
    // The same rule test/infer.test.ts holds src/speak.ts to. Asserted from the output
    // as well as the source, because it is the served string that reaches a client.
    assert.doesNotMatch(speakAs(SUBJECT, CORPUS), /Inferred across/);
  });

  it('says where the counts went rather than pretending they do not exist', () => {
    const template = speakAs(SUBJECT, CORPUS);
    assert.match(template, /`evidence`/);
    assert.match(template, /braintrust_find_positions/);
  });

  it('keeps the coverage layer load-bearing', () => {
    assert.match(speakAs(SUBJECT, CORPUS), /layers\.coverage/);
  });

  it('exempts find_positions, whose citations are the answer rather than scaffolding', () => {
    assert.match(speakAs(SUBJECT, CORPUS), /report them as they come back/);
  });
});

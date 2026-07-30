/**
 * The proposed display name.
 *
 * The worked example is the whole reason this module exists: Substack's feed says
 * "Nate's Substack", YouTube's says "AI News & Strategy Daily | Nate B Jones", and
 * neither is the Person's name. braintrust proposes; a human confirms.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  firstFreeSlug,
  looksLikePersonName,
  proposeDisplayName,
  slugify,
} from '../src/sources/naming.js';

const YOUTUBE_TITLE = 'AI News & Strategy Daily | Nate B Jones';

describe('proposing a display name', () => {
  it('prefers Substack dc:creator, which is a person by construction', () => {
    assert.equal(
      proposeDisplayName(
        {
          substackAuthor: 'Nate B. Jones',
          substackTitle: "Nate's Substack",
          youtubeAuthor: YOUTUBE_TITLE,
          youtubeTitle: YOUTUBE_TITLE,
        },
        'fallback',
      ),
      'Nate B. Jones',
    );
  });

  it('takes the person half of a "Brand | Person" channel title', () => {
    assert.equal(
      proposeDisplayName({ youtubeAuthor: YOUTUBE_TITLE, youtubeTitle: YOUTUBE_TITLE }, 'fallback'),
      'Nate B Jones',
    );
  });

  it('never proposes the feed title as-is when it is plainly a publication', () => {
    const proposed = proposeDisplayName({ substackTitle: "Nate's Substack" }, 'fallback');
    assert.equal(proposed, 'Nate');
    assert.ok(!proposed.includes('Substack'));
  });

  it('falls back rather than inventing when no signal looks like a name', () => {
    assert.equal(proposeDisplayName({}, 'natesnewsletter.substack.com'), 'natesnewsletter.substack.com');
  });
});

describe('what counts as a person name', () => {
  it('accepts two to four capitalised words, including initials', () => {
    assert.ok(looksLikePersonName('Nate B. Jones'));
    assert.ok(looksLikePersonName('Ada Lovelace'));
    assert.ok(looksLikePersonName("Ursula K. Le Guin"));
  });

  it('rejects brands, which is the failure that would reach the disclosure string', () => {
    assert.ok(!looksLikePersonName('AI News & Strategy Daily'));
    assert.ok(!looksLikePersonName('Stratechery'));
    assert.ok(!looksLikePersonName('Newsletter 2024'));
    assert.ok(!looksLikePersonName("Nate's Substack"));
  });
});

describe('slugs', () => {
  it('derives the public handle from the confirmed name', () => {
    assert.equal(slugify('Nate B. Jones'), 'nate-b-jones');
    assert.equal(slugify("Ursula K. Le Guin"), 'ursula-k-le-guin');
  });

  it('strips accents rather than dropping the word', () => {
    assert.equal(slugify('Émilie du Châtelet'), 'emilie-du-chatelet');
  });

  it('always produces something usable', () => {
    assert.equal(slugify('!!!'), 'person');
  });

  it('takes a numeric suffix on collision', () => {
    assert.equal(firstFreeSlug('nate-b-jones', []), 'nate-b-jones');
    assert.equal(firstFreeSlug('nate-b-jones', ['nate-b-jones']), 'nate-b-jones-2');
    assert.equal(
      firstFreeSlug('nate-b-jones', ['nate-b-jones', 'nate-b-jones-2']),
      'nate-b-jones-3',
    );
  });
});

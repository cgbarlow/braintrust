/**
 * The caption reader.
 *
 * Two things in the `json3` format will silently ruin a transcript if they are
 * mishandled. The rolling-window events carry a bare newline and are not speech; and
 * the word-level segments already contain their own leading space, so joining them
 * with one doubles every gap in the text a compiler will later read as someone's voice.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readCaptions, timecode } from '../src/ingest/captions.js';
import { CAPTION_SENTENCES, captionText, captionsJson3 } from './support/sources.js';

describe('reading a json3 track', () => {
  it('turns word-level segments into prose', () => {
    const track = readCaptions(captionsJson3(0), 'video 0');

    assert.equal(track.text, captionText(0));
    assert.ok(!/ {2}/.test(track.text), 'no doubled spaces: the segments carry their own');
    for (const sentence of CAPTION_SENTENCES) assert.ok(track.text.includes(sentence));
  });

  it('drops the rolling-window events, which are scrolling and not speech', () => {
    const track = readCaptions(captionsJson3(0), 'video 0');

    // Four lines of speech; the fixture also contains four newline-only events and one
    // window declaration with no segments at all.
    assert.equal(track.lines.length, 4);
    assert.ok(!track.text.includes('\n'));
  });

  it('keeps one start time per line, so a citation can name a moment', () => {
    const track = readCaptions(captionsJson3(0), 'video 0');

    assert.deepEqual(
      track.lines.map((line) => line.at),
      [0, 4000, 8000, 12_000],
    );
    assert.equal(track.lines[1]!.text, CAPTION_SENTENCES[0]);
  });

  it('refuses a track that is not JSON', () => {
    assert.throws(() => readCaptions('<html>nope</html>', 'video 9'), /did not return JSON/);
  });

  it('refuses a track with no events', () => {
    assert.throws(() => readCaptions('{"wireMagic":"pb3"}', 'video 9'), /no events in it/);
  });

  it('refuses a track whose events hold no words, rather than storing an empty transcript', () => {
    const empty = JSON.stringify({ events: [{ tStartMs: 0 }, { tStartMs: 10, segs: [{ utf8: '\n' }] }] });
    assert.throws(() => readCaptions(empty, 'video 9'), /no words in them/);
  });

  it('collapses whitespace inside a line without joining two lines together', () => {
    const messy = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'two' }, { utf8: '   spaced' }, { utf8: '\n  words' }] },
        { tStartMs: 1000, segs: [{ utf8: 'second line' }] },
      ],
    });

    const track = readCaptions(messy, 'video 9');
    assert.equal(track.text, 'two spaced words second line');
  });
});

describe('timecode', () => {
  it('reads the way a human writes a timestamp', () => {
    assert.equal(timecode(0), '0:00');
    assert.equal(timecode(271_000), '4:31');
    assert.equal(timecode(3_723_000), '1:02:03');
  });

  it('does not invent a negative time', () => {
    assert.equal(timecode(-5), '0:00');
  });
});

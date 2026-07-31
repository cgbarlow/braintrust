/**
 * Chunking. The claims worth testing are the ones a citation depends on:
 *
 *  - a Chunk is a slice of the stored body, exactly, so a quote is checkable
 *  - no words are lost between the windows
 *  - transcripts carry their timings and prose carries nulls, from one code path
 *
 * The last one is why the "every character survives" test runs against both shapes:
 * the two boundary detectors are the only thing that differs, and a bug in either
 * would show up as text falling into a gap between windows.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CaptionLine } from '../src/ingest/captions.js';
import {
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  chunkItem,
  proseUnits,
  transcriptUnits,
  windows,
  type Chunk,
} from '../src/retrieval/chunk.js';

/** Twelve paragraphs of ~320 characters: several fit a window, none is oversized. */
function prose(paragraphs = 12): string {
  return Array.from(
    { length: paragraphs },
    (_unused, index) =>
      `Paragraph ${index} opens with a claim that runs long enough to matter. ` +
      'It keeps going, because a real post does, and the sentences carry the sort of ' +
      'weight that makes a passage worth retrieving rather than a heading worth ' +
      `skipping. It closes on the number ${index}.`,
  ).join('\n\n');
}

/** Caption events at four-second spacing, in YouTube's shape. */
function captions(count = 120): { text: string; lines: CaptionLine[] } {
  const lines: CaptionLine[] = Array.from({ length: count }, (_unused, index) => ({
    at: index * 4_000,
    text: `so the point about item ${index} is that it keeps moving`,
  }));
  return { text: lines.map((line) => line.text).join(' '), lines };
}

function transcriptBody(count = 120, durationSeconds?: number) {
  const { text, lines } = captions(count);
  return {
    text,
    raw: {
      platform: 'youtube',
      segments: lines,
      ...(durationSeconds ? { duration_seconds: durationSeconds } : {}),
    },
  };
}

/** Every non-space character of the body is inside at least one Chunk. */
function covered(text: string, chunks: Chunk[]): boolean {
  const seen = new Array<boolean>(text.length).fill(false);
  for (const chunk of chunks) {
    for (let at = chunk.charStart; at < chunk.charEnd; at += 1) seen[at] = true;
  }
  return [...text].every((character, at) => seen[at] || /\s/.test(character));
}

describe('chunking prose', () => {
  const text = prose();
  const chunks = chunkItem({ text, raw: null });

  it('cuts a body into more than one window', () => {
    assert.ok(chunks.length > 1, `expected several chunks, got ${chunks.length}`);
  });

  it('stores exactly what the body says at those offsets', () => {
    // The invariant a quote rests on: nothing here rewrote anything.
    for (const chunk of chunks) {
      assert.equal(chunk.text, text.slice(chunk.charStart, chunk.charEnd));
    }
  });

  it('loses no words between the windows', () => {
    assert.ok(covered(text, chunks));
  });

  it('keeps every window inside the maximum', () => {
    for (const chunk of chunks) assert.ok(chunk.text.length <= CHUNK_MAX_CHARS);
  });

  it('starts and ends every window on a paragraph, never mid-word', () => {
    for (const chunk of chunks) {
      assert.ok(chunk.text.startsWith('Paragraph '), `window starts "${chunk.text.slice(0, 20)}…"`);
      assert.ok(/\d\.$/.test(chunk.text), `window ends "…${chunk.text.slice(-20)}"`);
    }
  });

  it('overlaps its neighbours by exactly one paragraph', () => {
    // A paragraph is already longer than the overlap budget, so prose repeats one and
    // stops. A claim that spans a paragraph break is still whole in one window.
    for (const [index, chunk] of chunks.slice(1).entries()) {
      const previous = chunks[index]!;
      assert.ok(chunk.charStart < previous.charEnd, `window ${chunk.ordinal} does not overlap`);
      assert.equal(previous.text.endsWith(chunk.text.slice(0, chunk.text.indexOf('\n\n'))), true);
    }
  });

  it('numbers them from zero without gaps', () => {
    assert.deepEqual(
      chunks.map((chunk) => chunk.ordinal),
      chunks.map((_unused, index) => index),
    );
  });

  it('carries no timings, because prose has none', () => {
    for (const chunk of chunks) {
      assert.equal(chunk.startMs, null);
      assert.equal(chunk.endMs, null);
    }
  });

  it('treats a single-paragraph item as one chunk', () => {
    const one = chunkItem({ text: 'A short post, and all of it.', raw: null });
    assert.equal(one.length, 1);
    assert.equal(one[0]!.text, 'A short post, and all of it.');
  });

  it('has nothing to say about an empty body', () => {
    assert.deepEqual(chunkItem({ text: '   \n\n  ', raw: null }), []);
  });

  it('reads a line break as a boundary, not only a blank line', () => {
    // htmlToText writes one newline for a <br> and two for a closed block. Both are
    // boundaries the author's own markup put there.
    assert.equal(proseUnits('one\ntwo\n\nthree').length, 3);
  });
});

describe('chunking a transcript', () => {
  const body = transcriptBody(120, 600);
  const chunks = chunkItem(body);

  it('stores exactly what the body says at those offsets', () => {
    for (const chunk of chunks) {
      assert.equal(chunk.text, body.text.slice(chunk.charStart, chunk.charEnd));
    }
  });

  it('loses no words between the windows', () => {
    assert.ok(covered(body.text, chunks));
  });

  it('carries the caption timings through', () => {
    assert.equal(chunks[0]!.startMs, 0);
    for (const chunk of chunks) {
      assert.ok(chunk.startMs !== null && chunk.endMs !== null);
      assert.ok(chunk.endMs! > chunk.startMs!);
    }
  });

  it('ends the last window at the length of the video', () => {
    // The format gives no durations, so an event ends where the next one starts — and
    // the final event ends where the video does.
    assert.equal(chunks.at(-1)!.endMs, 600_000);
  });

  it('overlaps consecutive windows, by whole caption events', () => {
    for (const [index, chunk] of chunks.slice(1).entries()) {
      const previous = chunks[index]!;
      const overlap = previous.charEnd - chunk.charStart;
      assert.ok(overlap > 0, `window ${chunk.ordinal} does not overlap its predecessor`);
      assert.ok(overlap <= CHUNK_OVERLAP_CHARS + 1, `overlap of ${overlap} is too generous`);
      assert.ok(body.text[chunk.charStart - 1] === ' ' || chunk.charStart === 0);
    }
  });

  it('falls back to prose when the segments do not match the stored body', () => {
    // Losing the timings costs a citation its timecode. Losing the text would cost
    // the citation, so the words win.
    const chunked = chunkItem({
      text: prose(4),
      raw: { platform: 'youtube', segments: [{ at: 0, text: 'words that are not in the body' }] },
    });
    assert.ok(chunked.length > 0);
    assert.ok(covered(prose(4), chunked));
    assert.equal(chunked[0]!.startMs, null);
  });

  it('holds an event to its own start when nothing says how long the video is', () => {
    const units = transcriptUnits('one two', [{ at: 5_000, text: 'one two' }]);
    assert.deepEqual(units, [{ start: 0, end: 7, startMs: 5_000, endMs: 5_000 }]);
  });
});

describe('a unit longer than a window', () => {
  const long = `${'word '.repeat(900).trim()}\n\nand a short one.`;
  const chunks = chunkItem({ text: long, raw: null });

  it('splits it at a space rather than emitting one enormous chunk', () => {
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= CHUNK_MAX_CHARS);
      assert.equal(chunk.text, long.slice(chunk.charStart, chunk.charEnd));
      assert.ok(!chunk.text.startsWith(' ') && !chunk.text.endsWith(' '));
    }
    assert.ok(covered(long, chunks));
  });

  it('cuts an unbroken run of characters at the limit, having nowhere better', () => {
    const unbroken = 'x'.repeat(CHUNK_MAX_CHARS * 2 + 40);
    const chunks = windows(unbroken, proseUnits(unbroken));
    assert.equal(chunks.length, 3);
    assert.ok(covered(unbroken, chunks));
  });
});

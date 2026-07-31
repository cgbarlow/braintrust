/**
 * Chunking: the platform's boundaries, never a model's.
 *
 * `braintrust_chunks.text` is what a citation's `quote` is drawn from, so no model is
 * in this path. A punctuation-restoration pass would make every quote a model's
 * rendering of what someone said rather than what they said; a pass returning only
 * sentence *boundaries* survives that objection and was rejected too, on what it buys.
 * Chunk boundaries serve retrieval, and overlapping windows already stop a passage
 * being cut in half.
 *
 * **Two boundary detectors, one path for everything after.** A transcript's units are
 * the caption events YouTube timed; prose's units are the line and paragraph breaks the
 * publisher's own markup declared. Both hand the same `Unit[]` to the same windower,
 * which is why `start_ms` is simply null for prose rather than a second code path.
 *
 * Every Chunk satisfies `chunk.text === item.body_text.slice(char_start, char_end)`.
 * That invariant is the point: a quote is checkable against the stored body without
 * trusting anything this file did.
 *
 * See docs/design/compiler.md §6.
 */

import type { CaptionLine } from '../ingest/captions.js';

/**
 * Roughly 1,000–1,500 characters, and the spec is explicit that these are a starting
 * point to tune against real retrieval results rather than a decided value.
 */
export const CHUNK_MAX_CHARS = 1_500;
export const CHUNK_MIN_CHARS = 1_000;

/**
 * How far back a window reaches into the one before it.
 *
 * **Always at least one whole unit, then further back while the repeated text stays
 * under this.** Two different shapes fall out of that, and both are wanted: a transcript
 * repeats four or five caption events, because the boundary between two of them is
 * arbitrary and a sentence spanning the join has to survive somewhere; prose repeats one
 * paragraph, because a paragraph is already longer than this and repeating a second
 * would be paying for the same words three times.
 *
 * The cost of overlapping at all is about a third more Chunks — three cents against the
 * measured Corpus, which is not a number any decision here should turn on.
 */
export const CHUNK_OVERLAP_CHARS = 200;

/** One indivisible piece of an Item, located in its `body_text`. */
export type Unit = {
  start: number;
  end: number;
  startMs?: number | undefined;
  endMs?: number | undefined;
};

export type Chunk = {
  ordinal: number;
  text: string;
  charStart: number;
  charEnd: number;
  /** Null for prose. A transcript carries them so a Position can cite a moment. */
  startMs: number | null;
  endMs: number | null;
};

export type ItemBody = {
  text: string;
  /** `body_raw` as stored. A YouTube body carries `segments`; a Substack body does not. */
  raw: unknown;
};

type StoredCaptions = { segments?: CaptionLine[]; duration_seconds?: number };

/**
 * The dispatch, and the only place that asks what platform an Item came from.
 *
 * A transcript whose segments cannot be located in its own `body_text` falls back to
 * prose rather than dropping the words: losing the timings costs a citation its
 * timecode, losing the text would cost the citation.
 */
export function chunkItem(body: ItemBody): Chunk[] {
  const stored = body.raw as StoredCaptions | null;
  const segments = Array.isArray(stored?.segments) ? stored.segments : undefined;

  if (segments && segments.length > 0) {
    const durationMs =
      typeof stored?.duration_seconds === 'number' ? stored.duration_seconds * 1000 : undefined;
    const units = transcriptUnits(body.text, segments, durationMs);
    if (units.length > 0) return windows(body.text, units);
  }

  return windows(body.text, proseUnits(body.text));
}

/**
 * Prose units: whatever the markup declared a break to be.
 *
 * Any run of newlines, not only blank lines — `htmlToText` turns a `<br>` into one
 * newline and a closed block into two, and both are boundaries the author's own markup
 * put there. Splitting on the smaller one keeps units small enough that windows are
 * filled by several of them rather than truncated by one.
 */
export function proseUnits(text: string): Unit[] {
  const units: Unit[] = [];
  const breaks = /\n+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = breaks.exec(text)) !== null) {
    addUnit(units, text, { start: cursor, end: match.index });
    cursor = breaks.lastIndex;
  }
  addUnit(units, text, { start: cursor, end: text.length });

  return units;
}

/**
 * Transcript units: one caption event each, located by searching `body_text` forward
 * rather than by recomputing the join. The stored body is what a citation is checked
 * against, so the offsets have to come from it.
 *
 * An event's `end_ms` is the next event's start — the format gives no durations — and
 * the last event runs to the length of the video when that is known.
 */
export function transcriptUnits(
  text: string,
  segments: CaptionLine[],
  durationMs?: number,
): Unit[] {
  const units: Unit[] = [];
  let cursor = 0;

  for (const [index, line] of segments.entries()) {
    const start = text.indexOf(line.text, cursor);
    if (start < 0) continue;
    const end = start + line.text.length;
    cursor = end;

    addUnit(units, text, {
      start,
      end,
      startMs: line.at,
      endMs: segments[index + 1]?.at ?? durationMs ?? line.at,
    });
  }

  return units;
}

/** Trims the whitespace a boundary left behind, then splits anything oversized. */
function addUnit(units: Unit[], text: string, unit: Unit): void {
  let { start, end } = unit;
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  if (end <= start) return;

  units.push(...divide(text, { ...unit, start, end }));
}

/**
 * A unit longer than one window has to be cut somewhere, and the cut is mechanical —
 * the last space before the limit. That is a measurement, not a judgement about where a
 * thought ends, which is the distinction this file exists to hold: nothing here decides
 * what a sentence is.
 */
function divide(text: string, unit: Unit): Unit[] {
  if (unit.end - unit.start <= CHUNK_MAX_CHARS) return [unit];

  const pieces: Unit[] = [];
  let start = unit.start;

  while (unit.end - start > CHUNK_MAX_CHARS) {
    const limit = start + CHUNK_MAX_CHARS;
    let cut = text.lastIndexOf(' ', limit);
    // No space in the last third of the window means an unbroken run of characters —
    // a URL, a base64 blob. Cutting mid-token beats emitting a 40KB chunk.
    if (cut <= start + CHUNK_MIN_CHARS) cut = limit;

    pieces.push({ ...unit, start, end: cut });
    start = text[cut] === ' ' ? cut + 1 : cut;
  }

  pieces.push({ ...unit, start, end: unit.end });
  return pieces;
}

/**
 * The one path both detectors feed. Fills each window with as many whole units as fit,
 * then steps back far enough to overlap the next one.
 *
 * A window never spans two Items because it is only ever given one Item's units.
 */
export function windows(text: string, units: Unit[]): Chunk[] {
  const chunks: Chunk[] = [];
  let first = 0;

  while (first < units.length) {
    let last = first;
    while (last + 1 < units.length && units[last + 1]!.end - units[first]!.start <= CHUNK_MAX_CHARS) {
      last += 1;
    }

    const from = units[first]!;
    const to = units[last]!;
    chunks.push({
      ordinal: chunks.length,
      text: text.slice(from.start, to.end),
      charStart: from.start,
      charEnd: to.end,
      startMs: from.startMs ?? null,
      endMs: to.endMs ?? null,
    });

    if (last + 1 >= units.length) break;

    // Repeat the last unit, then keep backing up while the repetition stays small. Never
    // as far as this window's own first unit: that would emit the same window forever.
    let next = last;
    while (next > first + 1 && to.end - units[next - 1]!.start <= CHUNK_OVERLAP_CHARS) {
      next -= 1;
    }
    // A window holding a single unit has nothing to overlap with but itself.
    first = next === first ? first + 1 : next;
  }

  return chunks;
}

/**
 * Captions: YouTube's `json3` track into prose braintrust can cite.
 *
 * The format is a list of events, each a start time and a list of word-level
 * segments. Auto-captions add rolling-window events that carry nothing but a
 * newline — those are the format's way of scrolling text up the screen, not
 * something the speaker said, and an event with no words in it is dropped.
 *
 * **The timings are kept, not thrown away.** A Position that cites a video needs to
 * be checkable, and "at 4:31" is the difference between a citation and a gesture at
 * a 20-minute video. Storing the full track would be ~344KB of per-word offsets per
 * video (~136MB across a 12-month backfill); storing one start time per line is
 * ~40KB and enough to link. So `segments` is what `body_raw` keeps, and the
 * per-word offsets are the part braintrust drops.
 *
 * See docs/design/ingestion.md §1.
 */

import { BraintrustError } from '../errors.js';

export type CaptionLine = {
  /** Milliseconds from the start of the video. */
  at: number;
  text: string;
};

export type CaptionTrack = {
  text: string;
  lines: CaptionLine[];
};

type Json3Event = {
  tStartMs?: number;
  segs?: { utf8?: string }[];
};

type Json3 = {
  events?: Json3Event[];
};

/**
 * Reads a `json3` caption track.
 *
 * Word-level segments are joined without a separator, because YouTube already puts
 * the space *inside* the segment (`{"utf8":" keep"}`) — inserting one would double
 * every space in the transcript.
 */
export function readCaptions(body: string, what: string): CaptionTrack {
  let parsed: Json3;
  try {
    parsed = JSON.parse(body) as Json3;
  } catch {
    throw new BraintrustError(`The caption track for ${what} did not return JSON.`);
  }

  if (!Array.isArray(parsed.events)) {
    throw new BraintrustError(`The caption track for ${what} has no events in it.`);
  }

  const lines: CaptionLine[] = [];
  for (const event of parsed.events) {
    const text = (event.segs ?? [])
      .map((segment) => segment.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === '') continue;

    lines.push({ at: event.tStartMs ?? 0, text });
  }

  if (lines.length === 0) {
    throw new BraintrustError(
      `The caption track for ${what} has events but no words in them. Recording it as failed ` +
        'rather than storing an empty transcript.',
    );
  }

  return { text: lines.map((line) => line.text).join(' '), lines };
}

/** `4:31`, for a citation a human can click. Hours appear only when there are hours. */
export function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

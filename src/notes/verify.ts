/**
 * Verifying a claim, which in braintrust means one thing: **the quote is in the body.**
 *
 * A model asked for a quote will sometimes tidy one — fix a transcription error, close
 * a dropped bracket, join two sentences it read as one thought. Every such repair makes
 * the quote a rendering of what was said rather than what was said, and a Position that
 * carries it would be citing the model.
 *
 * So braintrust does not store the model's quote. It locates the quote in the stored
 * body and stores **the body's own characters at that span**. Whitespace is allowed to
 * differ, because a paragraph break is not something a model can reasonably preserve
 * inside a JSON string; nothing else is.
 *
 * A quote that cannot be located is not a quote. The claim goes with it — dropped and
 * counted, never stored unverified.
 *
 * The Chunk and the timestamp are read off the rows the span falls in, rather than
 * asked for. Asking a model which Chunk a quote came from invites an invented id that
 * nothing downstream could check.
 *
 * See docs/design/compiler.md §1.
 */

import type { RawClaim } from './extractor.js';

/** A Chunk, as far as verification cares: a span of the body with a moment attached. */
export type ChunkSpan = {
  id: string;
  char_start: number;
  char_end: number;
  start_ms: number | null;
};

/**
 * One separately-published thing inside a batched Item, and where its words sit in the
 * stored body.
 *
 * **A Bluesky Item is a whole UTC day**, because 2,100 skeets a year would be 2,100 model
 * calls for fewer words than a 23-essay Substack. The batch is a unit of *reading*, never a
 * unit of citation — so the day carries the spans of the posts it was made of, and a
 * verified quote resolves to the one it fell inside.
 */
export type PostSpan = {
  char_start: number;
  char_end: number;
  url: string;
  created_at: string;
};

/** What a Note stores per claim. The shape `braintrust_item_notes.claims` holds. */
export type VerifiedClaim = {
  statement: string;
  /** Taken from the body, not from the model. */
  quote: string;
  chunk_id: string | null;
  start_ms: number | null;
  /**
   * Batched Items only: the individual post this quote is actually from.
   *
   * The same idea as `start_ms` and read the same way — *where inside this Item the words
   * are* — for the other form braintrust batches. A transcript answers it in milliseconds
   * and a day of posts answers it with a permalink.
   */
  post_url?: string;
  posted_at?: string;
};

export type Verification = {
  claims: VerifiedClaim[];
  /** Claims whose quote is not in the body. Reported, never stored. */
  dropped: number;
  /**
   * Of those, how many differ from the body **only in punctuation and case**.
   *
   * A measurement rather than a policy: these are dropped exactly as the rest are. It
   * exists because the drop rate is the signal the design says to watch, and a signal
   * nobody can drill into cannot be acted on — the rejected quotes are not stored, by
   * design, so without counting this at the moment of rejection the number is a mystery
   * every time.
   */
  nearly: number;
};

export function verifyClaims(
  claims: RawClaim[],
  body: string,
  chunks: ChunkSpan[],
  posts: PostSpan[] = [],
): Verification {
  const verified: VerifiedClaim[] = [];
  let dropped = 0;
  let nearly = 0;

  for (const claim of claims) {
    const span = locate(claim.quote, body);
    if (!span) {
      dropped += 1;
      if (locateLoosely(claim.quote, body)) nearly += 1;
      continue;
    }

    const chunk = chunkAt(chunks, span.start);
    const post = spanAt(posts, span.start);
    verified.push({
      statement: claim.statement,
      quote: body.slice(span.start, span.end),
      chunk_id: chunk?.id ?? null,
      start_ms: chunk?.start_ms ?? null,
      ...(post ? { post_url: post.url, posted_at: post.created_at } : {}),
    });
  }

  return { claims: verified, dropped, nearly };
}

export type Span = { start: number; end: number };

/**
 * Finds a quote in a body, allowing whitespace to differ and nothing else.
 *
 * The exact search first, because it is the common case and costs nothing. The
 * whitespace-flexible search second: every run of whitespace in the quote matches any
 * run of whitespace in the body, so a quote that crossed a paragraph break still
 * matches, and a quote whose *words* were altered still does not.
 */
export function locate(quote: string, body: string): Span | undefined {
  const trimmed = quote.trim();
  if (trimmed === '') return undefined;

  const exact = body.indexOf(trimmed);
  if (exact >= 0) return { start: exact, end: exact + trimmed.length };

  const pattern = trimmed
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');

  const match = new RegExp(pattern).exec(body);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

/**
 * The same search with punctuation and case set aside. **Nothing accepts this yet** — it
 * exists to count how many dropped claims differ from the body only in the ways a
 * transcript has no opinion about, so the question of whether to accept it is settled by
 * measurement rather than by argument.
 *
 * The case for asking at all: most of what braintrust reads is auto-generated captions,
 * which arrive unpunctuated and uncased — *"so here is the prompt i paste in"*. A model
 * quoting that writes *"So here is the prompt I paste in,"*, which is not a repair of the
 * words but a rendering of something the transcript never contained. The first live run
 * dropped 42% of claims on transcripts against 10% on prose, which is what made the
 * question worth measuring.
 *
 * The words must still be identical and in order, so a changed word still fails — and were
 * this ever promoted, the stored quote would remain the body's own characters at the span,
 * because that is read off `body.slice()` and not off what the model wrote.
 */
export function locateLoosely(quote: string, body: string): Span | undefined {
  const wanted = flatten(quote);
  if (wanted.text === '') return undefined;

  const found = flatten(body);
  const at = found.text.indexOf(wanted.text);
  if (at < 0) return undefined;

  return { start: found.index[at]!, end: found.index[at + wanted.text.length - 1]! + 1 };
}

/**
 * Lowercased, punctuation removed, whitespace collapsed — with every surviving character
 * remembering where it came from, which is what lets a match map back to a span of the
 * real body rather than of the flattened copy.
 */
function flatten(text: string): { text: string; index: number[] } {
  const out: string[] = [];
  const index: number[] = [];
  let space = true;

  for (let at = 0; at < text.length; at += 1) {
    const character = text[at]!;

    if (/\s/.test(character)) {
      if (!space) {
        out.push(' ');
        index.push(at);
        space = true;
      }
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(character)) continue;

    out.push(character.toLowerCase());
    index.push(at);
    space = false;
  }

  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    index.pop();
  }

  return { text: out.join(''), index };
}

/**
 * The Chunk a quote starts in. Windows overlap, so a position can fall in two — the
 * first is taken, which is the one whose `start_ms` is earliest and therefore the one
 * a citation should point a listener at.
 */
export function chunkAt(chunks: ChunkSpan[], at: number): ChunkSpan | undefined {
  return chunks.find((chunk) => chunk.char_start <= at && at < chunk.char_end);
}

/**
 * The post a quote starts in. Unlike Chunks these do not overlap — a post's words are its
 * own — so a quote that runs past the end of one and into the next is attributed to where
 * it began, which is the post that actually said the thing being cited.
 */
export function spanAt(posts: PostSpan[], at: number): PostSpan | undefined {
  return posts.find((post) => post.char_start <= at && at < post.char_end);
}

/**
 * Proposing a display name.
 *
 * **braintrust proposes and the human confirms**, because both feeds carry a name,
 * they disagree, and neither is the Person's name — Substack's `/feed` says "Nate's
 * Substack" while YouTube's Atom says "AI News & Strategy Daily | Nate B Jones".
 * This value becomes `"braintrust model of X"`, the string that carries the
 * disclosure everywhere it travels, so it is worth a human's attention rather than
 * a derivation.
 *
 * Everything here is a heuristic and none of it is authoritative. It exists to make
 * the common case a confirmation rather than a typing exercise.
 * See docs/design/ingestion.md §2.
 */

import type { SourceSurvey } from './types.js';

export type NameSignals = {
  substackAuthor?: string | undefined;
  substackTitle?: string | undefined;
  youtubeAuthor?: string | undefined;
  youtubeTitle?: string | undefined;
};

/** Brand fragments a publication name accretes and a person's name does not. */
const PUBLICATION_SUFFIX = /(?:'s|’s)?\s+(?:substack|newsletter|blog|podcast|channel)$/i;

const SEGMENT_SEPARATOR = /\s*[|•·–—]\s*|\s+-\s+/;

/**
 * The ordered rules. `dc:creator` comes first because it is a person's name by
 * construction; a `|`-delimited channel title comes next because "Brand | Person"
 * is the common shape and the Person half is the half that matters.
 */
export function proposeDisplayName(signals: NameSignals, fallback: string): string {
  const { substackAuthor, substackTitle, youtubeAuthor, youtubeTitle } = signals;

  if (substackAuthor && looksLikePersonName(substackAuthor)) return substackAuthor;

  for (const title of [youtubeAuthor, youtubeTitle, substackTitle]) {
    const segment = personSegment(title);
    if (segment) return segment;
  }

  for (const candidate of [youtubeAuthor, substackAuthor, youtubeTitle, substackTitle]) {
    const stripped = candidate?.replace(PUBLICATION_SUFFIX, '').trim();
    if (stripped) return stripped;
  }

  return fallback;
}

/** Collects the raw name signals from the surveys, whatever platforms turned up. */
export function nameSignals(surveys: { platform: string; survey: SourceSurvey }[]): NameSignals {
  const of = (platform: string) => surveys.find((entry) => entry.platform === platform)?.survey;
  const substack = of('substack');
  const youtube = of('youtube');
  return {
    substackAuthor: substack?.feedAuthor,
    substackTitle: substack?.feedTitle,
    youtubeAuthor: youtube?.feedAuthor,
    youtubeTitle: youtube?.feedTitle,
  };
}

function personSegment(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const segments = title.split(SEGMENT_SEPARATOR).map((segment) => segment.trim());
  // Last first: "AI News & Strategy Daily | Nate B Jones" puts the person at the end.
  for (const segment of [...segments].reverse()) {
    if (looksLikePersonName(segment)) return segment;
  }
  return undefined;
}

/**
 * Two to four capitalised words, no digits, no ampersand. Deliberately narrow: a
 * false positive here puts a brand name into the disclosure string, and a false
 * negative only means the human types four words.
 */
export function looksLikePersonName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (/[0-9&@/]/.test(trimmed)) return false;
  if (PUBLICATION_SUFFIX.test(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => /^[A-Z][\p{L}'’.-]*$/u.test(word));
}

/**
 * The stable public handle for a Person, derived from the confirmed name. Every
 * other tool takes this, so it is the one string that must survive a rename.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks, left behind by NFKD
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'person';
}

/** `nate-b-jones`, then `nate-b-jones-2`. A collision takes a numeric suffix. */
export function firstFreeSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`No free slug for "${base}" after 999 attempts.`);
}

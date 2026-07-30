/**
 * HTML to text.
 *
 * What braintrust keeps of a post is the prose, because that is what a Note is read
 * from and what a citation quotes. Measured against a real post: this extraction
 * yields 2,198 words where Substack's own `wordcount` says 2,214 — 99.3% — with no
 * markup or entities left behind.
 *
 * It deliberately does not try to be clever about *sections*. A Substack body ends
 * with a "Related reading" list that is plain `<h2>` and `<ul>` with no class to
 * recognise it by, structurally identical to a heading the author wrote. Guessing
 * where the article stops would silently delete real prose whenever the guess is
 * wrong, so the boilerplate stays and is named as an accepted cost.
 */

import { decodeEntities } from './xml.js';

/** Blocks that are the platform talking, not the author. Recognised by class. */
const FURNITURE = /subscription-widget|paywall-jump|button-wrapper|captioned-button-wrap/;

export function htmlToText(html: string): string {
  const withoutFurniture = dropElements(dropElements(html, 'script'), 'style');

  return (
    dropElements(withoutFurniture, 'div', FURNITURE)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|h[1-6]|li|blockquote|div|figure|figcaption|tr|pre)\s*>/gi, '\n\n')
      .replace(/<[^>]*>/g, '')
      .split('\n')
      .map((line) => decodeEntities(line).replace(/[ \t ]+/g, ' ').trim())
      .join('\n')
      // Three or more blank lines carry no more meaning than one.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Removes every `<tag>…</tag>`, counting nesting so a wrapper full of nested divs
 * goes as one piece. A non-greedy regex stops at the first close tag and leaves the
 * inner half of the block behind, which is how subscribe-widget text ends up in the
 * middle of someone's prose.
 */
export function dropElements(html: string, tag: string, classPattern?: RegExp): string {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = open.exec(html)) !== null) {
    if (match.index < cursor) continue;
    if (classPattern && !classPattern.test(classOf(match[1]))) continue;

    const end = closeOf(html, tag, open.lastIndex);
    result += html.slice(cursor, match.index);
    cursor = end;
    open.lastIndex = end;
  }

  return result + html.slice(cursor);
}

function classOf(attributes: string | undefined): string {
  return /class\s*=\s*"([^"]*)"/i.exec(attributes ?? '')?.[1] ?? '';
}

/** Index just past the `</tag>` that closes the element opened before `from`. */
function closeOf(html: string, tag: string, from: number): number {
  const both = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, 'gi');
  both.lastIndex = from;

  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = both.exec(html)) !== null) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return both.lastIndex;
  }

  // Unbalanced markup: drop the rest rather than leaving half a widget.
  return html.length;
}

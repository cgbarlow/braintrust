/**
 * The words of a blog post: the feed is the body, the page is the fallback.
 *
 * **The expensive half of a blog is usually free.** Where a blog publishes a feed, the
 * feed carries the whole post — page extraction agreed with the feed body at **1.00 on
 * 11 of 11 posts** across both blogs measured — so arbitrary-HTML extraction is the
 * fallback rather than the route, and the hard part is only reached by a blog that has
 * no feed at all.
 *
 * **A feed element is not automatically a body, and the element name does not settle
 * it.** Measured on the two real feeds: Bear Blog's Atom `<summary>` is 36 characters
 * against a `<content>` of 44,699 — a teaser beside the post — while the Jekyll blog
 * publishes RSS 2.0 with *no* `content:encoded` at all and a `<description>` of 135,277
 * characters, which is the whole post. So `content:encoded` and Atom `<content>` are
 * **declared** whole and are trusted alone; `<description>` and `<summary>` are the
 * synopsis elements and are treated as a candidate that has to beat the page. That is
 * the safeguard this module already needed, applied exactly where it is needed: **a
 * truncated feed loses to the page, an over-capturing extraction loses to the feed.**
 *
 * **The fallback extractor is: densest container, then cross-page boilerplate removal.**
 * Container selection alone is not enough and the Ghost site proves it — selection found
 * `<section class="gh-content">` on the two long posts and fell through to the entire
 * page chrome on all four short ones. Removing lines that repeat across the blog's other
 * pages rescued every one of them (391→59 words, 489→162, 371→64, 407→93) and was a
 * **no-op on all eleven pages where selection had already worked**. It is safe to apply
 * always, and it needs no judgement about what the chrome *is*.
 *
 * ***Text-to-markup density is rejected as a confidence signal.*** Measured, it tracks
 * post length rather than extraction quality: a real short Ghost post scored 0.097, a
 * real short Bear Blog post 0.204, and the successfully extracted Ghost posts 0.366 and
 * 0.404. There is no threshold separating *failed extraction* from *short post*, and
 * using one would drop real posts for being brief.
 *
 * **There is therefore no "unconfident but stored" state.** The feared outcome — a
 * Persona built partly out of nav menus — is prevented by a mechanism rather than a
 * judgement: cross-page repetition strips the chrome without deciding what chrome is,
 * and what survives is either enough prose to read or falls below the body floor that
 * already exists.
 *
 * See docs/design/ingestion.md §8.
 */

import { dropElements, htmlToText } from '../net/html.js';
import { blocks, decodeEntities } from '../net/xml.js';

// ---------------------------------------------------------------------------
// The feed body
// ---------------------------------------------------------------------------

/**
 * Which element the text came from, because a synopsis and a body are different claims
 * about the same post and only one of them can be stored as the post.
 */
export type FeedBodyElement = 'content:encoded' | 'content' | 'description' | 'summary';

/** Elements defined to carry the whole entry rather than a synopsis of it. */
const WHOLE: FeedBodyElement[] = ['content:encoded', 'content'];

export type FeedBody = {
  element: FeedBodyElement;
  /**
   * True when the feed *declared* this to be the whole post. A declared body is stored
   * without spending a request; a synopsis has to beat the page first.
   */
  whole: boolean;
  text: string;
  words: number;
};

/**
 * Every body a feed carries, keyed by the post URL.
 *
 * The key is normalised — scheme and trailing slash — because the same post is spelled
 * `http://karpathy.github.io/2026/02/12/microgpt/` in one place and `https://…` without
 * the slash in another, and a lookup that missed would silently spend a request the feed
 * had already paid for.
 */
export function feedBodies(xml: string): Map<string, FeedBody> {
  const found = new Map<string, FeedBody>();

  for (const entry of [...blocks(xml, 'item'), ...blocks(xml, 'entry')]) {
    const url = linkOf(entry);
    const body = bodyOf(entry);
    if (url && body) found.set(normaliseUrl(url), body);
  }

  return found;
}

/**
 * The best body element the entry carries.
 *
 * Order is by what the element *is*, not by length: a feed that publishes both a
 * `content:encoded` and a `<description>` is telling braintrust which of the two is the
 * post, and picking the longer would let a verbose synopsis outrank the real body.
 */
function bodyOf(entry: string): FeedBody | undefined {
  for (const element of ['content:encoded', 'content', 'description', 'summary'] as const) {
    const raw = blocks(entry, element)[0];
    if (raw === undefined) continue;

    // A feed body is HTML inside XML, so it arrives either wrapped in CDATA or with its
    // tags entity-escaped. Both have to be undone before the markup means anything.
    const html = decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    const text = htmlToText(html);

    return { element, whole: WHOLE.includes(element), text, words: countWords(text) };
  }

  return undefined;
}

function linkOf(entry: string): string | undefined {
  const alternate = /<link\b[^>]*\brel\s*=\s*["']alternate["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(entry);
  if (alternate) return alternate[1];

  const href = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(entry)?.[1];
  if (href) return href;

  const text = /<link\s*>([^<]+)<\/link\s*>/i.exec(entry)?.[1]?.trim();
  return text && /^https?:/i.test(text) ? text : undefined;
}

export function normaliseUrl(url: string): string {
  return url.trim().replace(/^http:/i, 'https:').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// The fallback: the page
// ---------------------------------------------------------------------------

/** Containers a post's prose is ever wrapped in, outermost concept first. */
const CONTAINERS = ['article', 'main', 'section', 'div'];

/**
 * A tighter container only wins if it still holds this much of the text it replaces.
 * Below it the "container" is a pull-quote or a sidebar rather than the post.
 */
const KEEPS_MOST = 0.8;

/**
 * The words on the page, chrome removed.
 *
 * `boilerplate` is the set of lines that repeat across other pages of the same blog —
 * see `repeatedLines`. It is optional because a blog with one page read has nothing to
 * compare against, and the honest answer there is the densest container on its own,
 * which over-captures rather than under-captures: the direction that loses no prose.
 */
export function blogBodyText(html: string, boilerplate?: ReadonlySet<string>): string {
  const { text } = densestContainer(html);
  return boilerplate ? withoutBoilerplate(text, boilerplate) : text;
}

/**
 * The smallest element that still holds essentially all of the page's text.
 *
 * The whole page is the baseline and every container has to beat it. Anything smaller
 * that keeps 80% of the text it replaces is a tighter fit on the same prose, so the
 * search walks inwards until nothing tighter qualifies — which finds `gh-content` where
 * a theme emits it and falls back to the page chrome where it does not.
 *
 * **The threshold is load-bearing and the fallback is the measurement rather than a
 * flaw.** Selection succeeded on the two long posts and fell through on the four short
 * ones — the same theme and the same markup, a different ratio of post to furniture. It
 * is not a constant to tune out; the boilerplate pass is what answers it.
 */
export function densestContainer(html: string): { text: string; container: string } {
  const page = structuralBreaks(dropElements(dropElements(html, 'script'), 'style'));

  let best = { text: htmlToText(page), container: 'page' };

  for (const tag of CONTAINERS) {
    for (const element of elements(page, tag)) {
      const text = htmlToText(element.inner);
      if (text.length < best.text.length && text.length >= best.text.length * KEEPS_MOST) {
        best = { text, container: element.className ? `${tag}.${element.className}` : tag };
      }
    }
  }

  return best;
}

/**
 * The lines this blog puts on every page: the nav, the footer, the cookie banner, the
 * recent-posts widget.
 *
 * **It needs more than one page, and that is the named cost.** The archive walk reads a
 * batch, so the set is computed across that batch and a later single post reuses it; it
 * is recomputed on each backfill, which is also how a redesign gets picked up. A blog
 * braintrust has read exactly one page of gets no boilerplate removal at all.
 *
 * A line has to appear on at least half the pages, and never on fewer than two — one
 * page cannot establish that anything repeats. **A post's own title can be stripped from
 * its own body** by this, which is harmless: the title is a column of its own rather
 * than something recovered from the prose.
 */
export function repeatedLines(pages: readonly string[]): Set<string> {
  const counts = new Map<string, number>();

  for (const page of pages) {
    // Per page, not per occurrence: a nav item repeated twice on one page is still one
    // page's worth of evidence that it is chrome.
    for (const line of new Set(linesOf(page))) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  const threshold = Math.max(2, Math.ceil(pages.length / 2));
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([line]) => line));
}

export function withoutBoilerplate(text: string, boilerplate: ReadonlySet<string>): string {
  return linesOf(text)
    .filter((line) => !boilerplate.has(line))
    .join('\n');
}

/**
 * A line break at every structural boundary, before the markup is flattened.
 *
 * `htmlToText` breaks on the elements a *post body* is built from — paragraphs, headings,
 * list items — which is right for a Substack body and not enough here, where the input is
 * a whole page. A nav is a run of anchors with no paragraph anywhere in it, so without
 * this the menu and the first sentence of the post arrive on one line, and a mechanism
 * that removes repeated **lines** would then have to choose between keeping the chrome
 * and losing the prose. Splitting on the page's own furniture elements keeps them apart.
 *
 * Deliberately not `<a>` or `<span>`: those are inline, and breaking on them would
 * fragment a paragraph that happens to contain a link into unrepeatable pieces.
 */
function structuralBreaks(html: string): string {
  return html.replace(/<\/?(?:nav|header|footer|aside|main|section|article|ul|ol|dl|table)(?:\s[^>]*)?>/gi, '\n\n$&');
}

function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Which marker said a post was gated, recorded so a wrong refusal can be argued with
 * rather than merely observed.
 */
export type GateMarker = 'empty-feed-body' | 'gh-post-upgrade-cta' | 'members-cta-copy';

/**
 * Ghost's own upgrade widget, matched against **rendered** markup only.
 *
 * This corrects [#56](https://github.com/cgbarlow/braintrust/issues/56), which reported
 * the class on every post free and paid alike and concluded a gated Ghost post was
 * undetectable. That was a counting error: the grep matched the class name inside the
 * theme's `<style>` block, which every page of the site carries. Against rendered markup
 * it separates cleanly.
 */
const UPGRADE_WIDGET = /gh-post-upgrade-cta/;

/**
 * The members call-to-action, in the prose rather than in the markup.
 *
 * **This is the weak marker and it is here to catch what the other two miss.** It is
 * editable and translatable, so it is matched narrowly enough that an author writing
 * *"this post is for anyone who has ever…"* is not refused — the subscriber noun is
 * required, not merely the opening.
 */
const MEMBERS_CTA = /this post is for [^.\n]{0,40}\b(?:subscribers?|members?)\b/i;

/**
 * Whether the page braintrust just fetched is a gated post, and which marker said so.
 *
 * **Any-of rather than all-of, because the failure that matters is storing a partial**
 * and each marker misses a different theme. The widget fires on the default-family theme
 * and not the heavily customised one; the CTA copy fired on both and is genuinely
 * per-post rather than site furniture. Ghost emits no schema.org `isAccessibleForFree`,
 * so there is no standards-based signal to prefer over either.
 *
 * **The residual risk, named here and not only in the design doc:** a custom theme that
 * rewords or translates its members CTA, on a post whose free intro clears the body
 * floor, escapes all three markers and braintrust stores public words as a whole post.
 * That is not a consent breach — the publisher gave those words away — and it is bounded
 * to blogs that both sell subscriptions and run a rewritten theme.
 */
export function gatedBy(html: string): GateMarker | undefined {
  const rendered = dropElements(dropElements(html, 'script'), 'style');

  if (UPGRADE_WIDGET.test(rendered)) return 'gh-post-upgrade-cta';
  if (MEMBERS_CTA.test(htmlToText(rendered))) return 'members-cta-copy';
  return undefined;
}

/**
 * The fully-gated case, and the one that costs nothing at all.
 *
 * **Ghost enforces its paywall at the feed as well as the page**: `content:encoded` for
 * a members-only post is *empty*, not truncated — measured at 0 words on a real
 * publication's public RSS. An item that is listed and dated and carries a declared body
 * of nothing is a post the publisher is withholding, and braintrust can say so without
 * spending the request the page would cost.
 *
 * Only a **declared** body counts. A missing `<description>` says the feed is a
 * headlines-only feed, which is a statement about the feed rather than about the post.
 */
export function gatedByFeed(body: FeedBody | undefined): boolean {
  return body !== undefined && body.whole && body.words === 0;
}

// ---------------------------------------------------------------------------
// Putting the two in the same room
// ---------------------------------------------------------------------------

/**
 * Share of the page-extracted words that also appear in the feed body.
 *
 * Recorded alongside the Item rather than acted on. It is the number that lets a human
 * see extraction quality drift on a blog they follow, and it deliberately has no
 * threshold: density is what happens when a length-shaped signal is asked to be a
 * quality signal, and a second one would be the same mistake with a different formula.
 */
export function agreement(page: string, feed: string): number {
  const inFeed = new Set(feed.toLowerCase().split(/\s+/).filter(Boolean));
  const words = page.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  return words.filter((word) => inFeed.has(word)).length / words.length;
}

/** The same count Voice and Coverage use: whitespace-separated tokens of the stored body. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

// ---------------------------------------------------------------------------

/**
 * Every `<tag>…</tag>` and what it holds, counting nesting so a container full of nested
 * divs is one element rather than a prefix of one.
 */
function* elements(html: string, tag: string): Generator<{ inner: string; className: string }> {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  let match: RegExpExecArray | null;

  while ((match = open.exec(html)) !== null) {
    const from = open.lastIndex;
    const end = closeOf(html, tag, from);
    if (end < 0) continue;

    yield {
      inner: html.slice(from, end),
      className: /class\s*=\s*["']([^"']*)["']/i.exec(match[1] ?? '')?.[1]?.split(/\s+/)[0] ?? '',
    };
  }
}

/** Index of the `</tag>` closing the element opened before `from`, or -1 if unbalanced. */
function closeOf(html: string, tag: string, from: number): number {
  const both = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, 'gi');
  both.lastIndex = from;

  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = both.exec(html)) !== null) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return match.index;
  }

  return -1;
}

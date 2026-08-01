/**
 * PROTOTYPE — throwaway. Delete me.
 *
 * Wayfinder ticket #55: "Taking body text from a page braintrust has never seen".
 *
 * The question is NOT which library. It is: **what does braintrust do when it is not
 * confident it has the prose?** Everywhere else the posture is that a thing it cannot
 * verify is dropped rather than stored. This runs a best-effort extraction over three
 * real blogs and prints every signal that might carry that line, so we can look at the
 * numbers rather than argue about them.
 *
 *   npx tsx src/ingest/PROTOTYPE-blog-body.mts
 */

import { htmlToText } from '../net/html.js';
import { decodeEntities } from '../net/xml.js';
import { USER_AGENT } from '../net/fetch.js';

const SAMPLE = 6;

type Blog = { name: string; kind: string; list: () => Promise<string[]>; feed?: string };

const BLOGS: Blog[] = [
  {
    name: 'karpathy.bearblog.dev',
    kind: 'Bear Blog, sitemap',
    list: async () => urlsFromSitemap(await get('https://karpathy.bearblog.dev/sitemap.xml')),
    feed: 'https://karpathy.bearblog.dev/feed/',
  },
  {
    name: 'karpathy.github.io',
    kind: 'Jekyll, feed only (sitemap 404s)',
    list: async () => linksFromFeed(await get('https://karpathy.github.io/feed.xml')),
    feed: 'https://karpathy.github.io/feed.xml',
  },
  {
    name: 'agentics.org.nz',
    kind: 'Ghost 5.130 self-hosted, sitemap-posts',
    list: async () => urlsFromSitemap(await get('https://agentics.org.nz/sitemap-posts.xml')),
    // /rss/ 404s on this site — the adversarial case: no feed to check against.
    feed: 'https://agentics.org.nz/rss/',
  },
];

/**
 * Does the feed braintrust already fetches carry the body? Returns url -> text.
 * If it does, there is nothing to extract and nothing to be unconfident about.
 */
function bodiesFromFeed(xml: string): Map<string, string> {
  const found = new Map<string, string>();
  const entries = xml.split(/<(?:item|entry)[\s>]/).slice(1);
  for (const entry of entries) {
    const link =
      /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(entry)?.[1] ??
      /<link[^>]*href="([^"]+)"/.exec(entry)?.[1] ??
      /<link>([^<]+)<\/link>/.exec(entry)?.[1];
    const raw =
      /<content:encoded>([\s\S]*?)<\/content:encoded>/.exec(entry)?.[1] ??
      /<content[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1] ??
      /<description>([\s\S]*?)<\/description>/.exec(entry)?.[1];
    if (!link || !raw) continue;
    const html = raw.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    found.set(normalise(link), htmlToText(decodeEntities(html)));
  }
  return found;
}

const normalise = (url: string): string =>
  url.trim().replace(/^http:/, 'https:').replace(/\/$/, '');

/** Share of the page-extracted words that also appear in the feed body, in order. */
function agreement(page: string, feed: string): number {
  const feedWords = new Set(feed.toLowerCase().split(/\s+/).filter(Boolean));
  const pageWords = page.toLowerCase().split(/\s+/).filter(Boolean);
  if (pageWords.length === 0) return 0;
  return pageWords.filter((w) => feedWords.has(w)).length / pageWords.length;
}

async function get(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

const urlsFromSitemap = (xml: string): string[] =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.trim());

const linksFromFeed = (xml: string): string[] => [...bodiesFromFeed(xml).keys()];

// ---------------------------------------------------------------- extraction

/** The naive thing: strip every tag on the page. The baseline to beat. */
const wholePage = (html: string): string => htmlToText(html);

/**
 * Best effort: take the densest container. Scores every <article>/<main>/<section>/<div>
 * by the text it holds, and takes the smallest one still holding most of the page's text
 * — the innermost wrapper, not <body>.
 */
function densest(html: string): { text: string; tag: string } {
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  let best = { text: htmlToText(body), tag: 'whole page' };
  let bestLen = best.text.length;

  for (const tag of ['article', 'main', 'section', 'div']) {
    for (const block of elements(body, tag)) {
      const text = htmlToText(block.inner);
      // Smaller than what we have, but keeps ≥80% of it: a tighter fit on the same prose.
      if (text.length < bestLen && text.length >= bestLen * 0.8) {
        best = { text, tag: `<${tag}${block.cls ? ` class="${block.cls}"` : ''}>` };
        bestLen = text.length;
      }
    }
  }
  return best;
}

function* elements(html: string, tag: string): Generator<{ inner: string; cls: string }> {
  const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = open.exec(html)) !== null) {
    const from = open.lastIndex;
    const both = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, 'gi');
    both.lastIndex = from;
    let depth = 1;
    let end = -1;
    let inner: RegExpExecArray | null;
    while ((inner = both.exec(html)) !== null) {
      depth += inner[1] === '/' ? -1 : 1;
      if (depth === 0) {
        end = inner.index;
        break;
      }
    }
    if (end < 0) continue;
    yield {
      inner: html.slice(from, end),
      cls: /class\s*=\s*"([^"]*)"/i.exec(match[1] ?? '')?.[1] ?? '',
    };
  }
}

// ---------------------------------------------------------------- signals

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Text-to-markup: prose characters as a share of the bytes served. */
const density = (text: string, html: string): number => text.length / html.length;

/** Lines seen on at least half the sampled pages of one blog. Nav, footer, cookie banner. */
function boilerplate(pages: string[][]): Set<string> {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    for (const line of new Set(lines)) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length / 2));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([line]) => line));
}

const kb = (s: string): string => `${Math.round(s.length / 1024)}KB`;

function slug(url: string): string {
  const path = new URL(url).pathname.replace(/\/$/, '');
  return (path.split('/').pop() || '(home)').slice(0, 34);
}

const lines = (text: string): string[] =>
  text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

// ---------------------------------------------------------------- run

for (const blog of BLOGS) {
  console.log(`\n${'='.repeat(78)}\n${blog.name}  —  ${blog.kind}`);

  let urls: string[];
  try {
    urls = await blog.list();
  } catch (error) {
    console.log(`  listing failed: ${(error as Error).message}`);
    continue;
  }
  console.log(`  ${urls.length} URLs listed; sampling ${Math.min(SAMPLE, urls.length)}\n`);

  const sampled: { url: string; html: string; whole: string; best: ReturnType<typeof densest> }[] = [];
  for (const url of urls.slice(0, SAMPLE)) {
    try {
      const html = await get(url);
      sampled.push({ url, html, whole: wholePage(html), best: densest(html) });
    } catch (error) {
      console.log(`  FETCH FAILED ${url}: ${(error as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const repeated = boilerplate(sampled.map((p) => lines(p.best.text)));

  let feedBodies = new Map<string, string>();
  if (blog.feed) {
    try {
      feedBodies = bodiesFromFeed(await get(blog.feed));
      const sizes = [...feedBodies.values()].map(words);
      console.log(
        `  feed carries bodies for ${feedBodies.size} posts` +
          (sizes.length ? `, median ${sizes.sort((a, b) => a - b)[sizes.length >> 1]} words\n` : '\n'),
      );
    } catch (error) {
      console.log(`  feed: ${(error as Error).message} — no oracle available\n`);
    }
  }

  console.log(
    `  ${'page'.padEnd(34)} ${'served'.padStart(7)} ${'whole'.padStart(6)} ${'best'.padStart(6)} ` +
      `${'kept'.padStart(5)} ${'dens'.padStart(5)} ${'boiler'.padStart(6)} ${'feed'.padStart(5)} ${'agree'.padStart(5)}  container`,
  );
  for (const page of sampled) {
    const bestLines = lines(page.best.text);
    const clean = bestLines.filter((l) => !repeated.has(l));
    const cleanText = clean.join('\n');
    const fromFeed = feedBodies.get(normalise(page.url));
    console.log(
      `  ${slug(page.url).padEnd(34)} ` +
        `${kb(page.html).padStart(7)} ` +
        `${String(words(page.whole)).padStart(6)} ` +
        `${String(words(page.best.text)).padStart(6)} ` +
        `${String(words(cleanText)).padStart(5)} ` +
        `${density(page.best.text, page.html).toFixed(3).padStart(5)} ` +
        `${String(bestLines.length - clean.length).padStart(6)} ` +
        `${(fromFeed ? String(words(fromFeed)) : '—').padStart(5)} ` +
        `${(fromFeed ? agreement(cleanText, fromFeed).toFixed(2) : '—').padStart(5)}  ` +
        page.best.tag.slice(0, 34),
    );
  }

  console.log(`\n  boilerplate lines shared across the sample: ${repeated.size}`);
  for (const line of [...repeated].slice(0, 8)) console.log(`    · ${line.slice(0, 70)}`);

  const first = sampled[0];
  if (first) {
    const clean = lines(first.best.text).filter((l) => !repeated.has(l));
    console.log(`\n  --- ${slug(first.url)} after boilerplate removal ---`);
    console.log(`  HEAD: ${clean.slice(0, 3).join(' / ').slice(0, 200)}`);
    console.log(`  TAIL: ${clean.slice(-3).join(' / ').slice(0, 200)}`);
  }
}

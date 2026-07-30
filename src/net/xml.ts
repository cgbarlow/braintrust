/**
 * Just enough feed reading for the discovery layer.
 *
 * Discovery needs four fields — a title, an author, a stable id and a publish date
 * — from RSS and from Atom, and both are well-formed machine output rather than
 * hand-written markup. Pulling those with regexes keeps braintrust's dependency
 * list at four packages, which is worth more here than generality.
 *
 * See docs/design/ingestion.md §1: discovery is the one generic layer, and it is
 * generic precisely because it reads so little.
 */

/** Inner text of the first `<name>` element, entity-decoded. */
export function firstTag(xml: string, name: string): string | undefined {
  const match = tagPattern(name).exec(xml);
  return match ? cleanText(match[1]!) : undefined;
}

/** Inner text of every `<name>` element, in document order. */
export function allTags(xml: string, name: string): string[] {
  const found: string[] = [];
  const pattern = tagPattern(name);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) found.push(cleanText(match[1]!));
  return found;
}

/** Whole `<name>…</name>` blocks, including their markup — one per feed entry. */
export function blocks(xml: string, name: string): string[] {
  const found: string[] = [];
  const pattern = tagPattern(name);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) found.push(match[1]!);
  return found;
}

/**
 * Everything before the first `<item>` or `<entry>`: the channel-level fields.
 * Without this a feed's title lookup would find the first post's title on any
 * feed that puts the channel title after its items.
 */
export function channelPart(xml: string): string {
  const firstEntry = /<(?:item|entry)(?:\s|>)/i.exec(xml);
  return firstEntry ? xml.slice(0, firstEntry.index) : xml;
}

function tagPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}\\s*>`, 'gi');
}

function cleanText(raw: string): string {
  return decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => safeChar(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeChar(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

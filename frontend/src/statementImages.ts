export interface StatementImageSource { url: string; alt: string }

/** Only collect uploaded images, ignoring examples inside Markdown code fences. */
export function statementImages(markdown: string): StatementImageSource[] {
  const sources = new Map<string, StatementImageSource>();
  const text = markdown.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
  const local = /^\/api\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;
  const add = (alt: string, url: string) => {
    if (local.test(url) && !sources.has(url)) sources.set(url, { url, alt: alt || '题面图片' });
  };
  for (const match of text.matchAll(/!\[((?:\\.|[^\]\\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^\n]*?["'])?\s*\)/g)) add(match[1], match[2]);
  const references = new Map<string, string>();
  for (const match of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) references.set(match[1].trim().toLowerCase(), match[2]);
  for (const match of text.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\])?(?!\()/g)) add(match[1], references.get((match[2] || match[1]).trim().toLowerCase()) || '');
  return [...sources.values()];
}

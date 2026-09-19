const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export const decodeHtmlEntities = (value: string): string => value
  .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => {
    try {
      return String.fromCodePoint(Number.parseInt(code, 16));
    } catch {
      return _match;
    }
  })
  .replace(/&#([0-9]+);/gu, (_match, code: string) => {
    try {
      return String.fromCodePoint(Number.parseInt(code, 10));
    } catch {
      return _match;
    }
  })
  .replace(/&([a-z]+);/giu, (match, name: string) => namedEntities[name.toLowerCase()] ?? match);

export const stripHtml = (value: string): string => value
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, "$1")
  .replace(/<script[\s\S]*?<\/script>/giu, " ")
  .replace(/<style[\s\S]*?<\/style>/giu, " ")
  .replace(/<br\s*\/?>/giu, "\n")
  .replace(/<[^>]*>/gu, " ");

export const cleanText = (value: string): string => decodeHtmlEntities(stripHtml(value))
  .replace(/[\t\r ]+/gu, " ")
  .replace(/\n\s+/gu, "\n")
  .replace(/\s+([,.;:!?])/gu, "$1")
  .trim();

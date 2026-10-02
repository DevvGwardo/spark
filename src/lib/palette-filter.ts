/**
 * cmdk's default scorer matches any subsequence, so "set" hits nearly every
 * row. Rank instead: label prefix > word prefix in label > substring in label >
 * word prefix in a keyword; anything else is hidden.
 */
export function paletteFilter(value: string, search: string, keywords: string[] = []): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const label = value.toLowerCase();
  if (label.startsWith(q)) return 1;
  const words = label.split(/[\s:/._-]+/);
  if (words.some((w) => w.startsWith(q))) return 0.8;
  if (label.includes(q)) return 0.6;
  if (keywords.some((k) => k.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))) return 0.4;
  return 0;
}

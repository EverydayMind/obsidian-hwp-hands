export interface HwpLinkTarget {
  page?: number;
  heading?: string;
}

export interface ParsedHwpLink {
  path: string;
  target?: HwpLinkTarget;
}

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Split a vault-relative HWP/HWPX link and its supported page or exact-paragraph target. */
export function parseHwpLinkText(linkText: string): ParsedHwpLink | undefined {
  const hash = linkText.indexOf('#');
  const path = decode((hash < 0 ? linkText : linkText.slice(0, hash)).trim()).replaceAll('\\', '/');
  if (!path || !/\.(hwp|hwpx)$/i.test(path)) return undefined;
  if (hash < 0) return { path };

  const fragment = decode(linkText.slice(hash + 1)).trim();
  if (!fragment) return { path };
  const page = /^page\s*=\s*(\d+)$/i.exec(fragment);
  if (page) {
    const value = Number(page[1]);
    if (!Number.isSafeInteger(value) || value < 1) return undefined;
    return { path, target: { page: value } };
  }
  return { path, target: { heading: fragment } };
}

export function normalizeHwpHeading(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

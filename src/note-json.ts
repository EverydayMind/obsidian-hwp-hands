/** RHWP getFootnoteInfo escapes quotes/backslashes but emits literal tabs inside JSON strings. */
export function parseNoteInfo<T>(source: string): T {
  let inside = false, escaped = false, normalized = '';
  for (const char of source) {
    if (inside && char.charCodeAt(0) < 0x20) {
      normalized += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      escaped = false;
      continue;
    }
    normalized += char;
    if (escaped) escaped = false;
    else if (inside && char === '\\') escaped = true;
    else if (char === '"') inside = !inside;
  }
  return JSON.parse(normalized) as T;
}

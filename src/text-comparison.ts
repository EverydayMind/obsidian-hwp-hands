export interface TextChangeRange { removed: string; added: string }

/** Finds one compact changed range without an O(n×m) diff table. */
export function textChangeRange(before: string, after: string): TextChangeRange {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && (isHighSurrogate(before.charCodeAt(prefix - 1)) || isHighSurrogate(after.charCodeAt(prefix - 1)))) prefix--;

  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)) suffix++;
  const beforeEnd = before.length - suffix, afterEnd = after.length - suffix;
  if ((beforeEnd < before.length && isLowSurrogate(before.charCodeAt(beforeEnd)))
    || (afterEnd < after.length && isLowSurrogate(after.charCodeAt(afterEnd)))) suffix = Math.max(0, suffix - 1);

  return { removed: before.slice(prefix, before.length - suffix), added: after.slice(prefix, after.length - suffix) };
}

function isHighSurrogate(value: number): boolean { return value >= 0xd800 && value <= 0xdbff; }
function isLowSurrogate(value: number): boolean { return value >= 0xdc00 && value <= 0xdfff; }

/**
 * Keyboard-layout independent shortcut matching.
 *
 * Obsidian matches hotkeys against `KeyboardEvent.key`. With a Korean layout in Hangul mode the same physical key reports a
 * jamo (`ㅣ` for the L key), `Process` (keyCode 229) or a shifted symbol, so catalog shortcuts such as `Alt+L` or `Mod+Shift+]`
 * never match. The physical `code` is stable, so the editor view uses it before the parent host handles catalog shortcuts.
 * The approach follows rhwp-studio's shortcut map (MIT, https://github.com/edwardkim/rhwp), reimplemented without its engine calls.
 */
export interface ShortcutKeyEvent {
  key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean;
}

const PUNCTUATION = new Map<string, string>([
  ['BracketLeft', '['], ['BracketRight', ']'], ['Backquote', '`'], ['Quote', "'"], ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['Semicolon', ';'], ['Equal', '='], ['Minus', '-'], ['Backslash', '\\'],
]);

/** The Latin key a physical key produces on a US layout, or undefined when the key cannot be part of a shortcut. */
export function physicalShortcutKey(code: string): string | undefined {
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1\d|2[0-4])$/u.test(code)) return code;
  const punctuation = PUNCTUATION.get(code);
  if (punctuation) return punctuation;
  return ['Enter', 'Escape', 'Delete', 'Backspace', 'Tab', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(code) ? code : undefined;
}

function canonical(mod: boolean, ctrl: boolean, alt: boolean, shift: boolean, key: string): string {
  return [...(mod ? ['Mod'] : []), ...(ctrl ? ['Ctrl'] : []), ...(alt ? ['Alt'] : []), ...(shift ? ['Shift'] : []), key].join('+');
}

/** Normalizes a catalog label such as `Mod+Shift+Alt+[` to the canonical `Mod+Alt+Shift+[` form. */
export function canonicalShortcut(shortcut: string, isMac = false): string {
  const parts = shortcut.split('+').map(part => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error(`잘못된 편집기 단축키: ${shortcut}`);
  const has = (name: string): boolean => parts.includes(name);
  // `Ctrl` is the physical Ctrl key on macOS but the same key as `Mod` elsewhere.
  const mod = has('Mod') || (!isMac && has('Ctrl'));
  return canonical(mod, isMac && has('Ctrl'), has('Alt'), has('Shift'), key.length === 1 ? key.toLowerCase() : key);
}

/** Canonical shortcut for the physical key of an event, or undefined when it is not a modified or function key. */
export function physicalShortcut(event: ShortcutKeyEvent, isMac = false): string | undefined {
  const key = physicalShortcutKey(event.code);
  if (!key) return undefined;
  const mod = isMac ? event.metaKey : event.ctrlKey, ctrl = isMac && event.ctrlKey;
  if (!mod && !ctrl && !event.altKey && !/^F\d/u.test(key)) return undefined;
  return canonical(mod, ctrl, event.altKey, event.shiftKey, key);
}

/**
 * True when `event.key` names the physical key (a Latin layout). Native browser editing can then be delegated to an input;
 * domain shortcuts still belong to the HWP view scope, even if a host command uses the same key.
 */
export function eventKeyMatchesPhysicalKey(event: ShortcutKeyEvent): boolean {
  const key = physicalShortcutKey(event.code);
  return !!key && (event.key === key || event.key.toLowerCase() === key);
}

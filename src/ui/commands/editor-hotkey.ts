import type { Hotkey, Modifier } from 'obsidian';

const MODIFIERS = new Set<Modifier>(['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt']);
const FUNCTION_KEY = /^F(?:[1-9]|1\d|2[0-4])$/u;

/** Convert the command catalog's readable shortcut label into Obsidian's hotkey contract. */
export function editorHotkey(shortcut: string): Hotkey {
  const parts = shortcut.split('+').map(part => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key || !/^[\w[\]`',./;=-]+$/u.test(key)) throw new Error(`잘못된 편집기 단축키: ${shortcut}`);
  const modifiers = parts as Modifier[];
  // Bare function keys (F6, F7) are the only shortcuts that may omit a modifier; a bare letter would steal normal typing.
  if ((!modifiers.length && !FUNCTION_KEY.test(key)) || modifiers.some(modifier => !MODIFIERS.has(modifier)) || new Set(modifiers).size !== modifiers.length) {
    throw new Error(`잘못된 편집기 단축키: ${shortcut}`);
  }
  return { modifiers, key: key.length === 1 ? key.toLowerCase() : key };
}

/**
 * Basic browser/OS editing shortcuts (Mod+C, Mod+V, Mod+A, Mod+X, Mod+Z, Mod+Shift+Z)
 * must not be passed to Obsidian's global hotkeys parameter, so they do not steal global
 * shortcuts outside the HWP view.
 */
export function isBrowserEditShortcut(shortcut: string): boolean {
  const parts = shortcut.split('+').map(part => part.trim()).filter(Boolean);
  const key = parts.pop()?.toLowerCase();
  if (!key) return false;
  const modifiers = parts;
  if (modifiers.length === 1 && (modifiers[0] === 'Mod' || modifiers[0] === 'Ctrl' || modifiers[0] === 'Meta')) {
    return ['c', 'v', 'a', 'x', 'z', 'y'].includes(key);
  }
  if (modifiers.length === 2 && (modifiers.includes('Mod') || modifiers.includes('Ctrl') || modifiers.includes('Meta')) && modifiers.includes('Shift')) {
    return key === 'z' || key === 'y';
  }
  return false;
}

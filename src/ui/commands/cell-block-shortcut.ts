import { physicalShortcutKey, type ShortcutKeyEvent } from './shortcut-event';

/** Commands with bare keys are active only while an F5 cell block exists. */
export function cellBlockShortcut(event: ShortcutKeyEvent, hasCellBlock: boolean): string | undefined {
  if (!hasCellBlock || event.metaKey || event.altKey) return undefined;
  const key = physicalShortcutKey(event.code);
  if (event.ctrlKey && event.shiftKey) return ({ s: 'table.block-sum', a: 'table.block-average', p: 'table.block-product' } as Record<string, string>)[key ?? ''];
  if (event.ctrlKey || event.shiftKey) return undefined;
  return ({ s: 'table.split-cell', m: 'table.merge-cells', h: 'table.equalize-heights', w: 'table.equalize-widths' } as Record<string, string>)[key ?? ''];
}

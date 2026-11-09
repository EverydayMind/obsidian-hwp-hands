import { physicalShortcutKey, type ShortcutKeyEvent } from './shortcut-event';

export interface SequenceState { prefix: 'G' | 'N' | 'K' | 'V'; startedAt: number }
export interface SequenceResult { state?: SequenceState; command?: string; handled: boolean }

const SEQUENCES: Record<SequenceState['prefix'], Record<string, string>> = {
  G: { p: 'view.fit-page', w: 'view.fit-width', q: 'view.zoom-100', c: 'view.control-codes', t: 'view.paragraph-marks' },
  N: { m: 'insert.equation-dialog' },
  K: { b: 'insert.bookmark', e: 'insert.clickhere-field' },
  V: { t: 'view.transparent-borders' },
};

/** The view scope consumes the prefix, then resolves a physical-key suffix within 1.5 seconds. */
export function advanceSequenceShortcut(state: SequenceState | undefined, event: ShortcutKeyEvent, now: number): SequenceResult {
  const key = physicalShortcutKey(event.code);
  if (state && now - state.startedAt <= 1500) {
    if (key === 'Escape') return { handled: true };
    const command = key ? SEQUENCES[state.prefix][key] : undefined;
    if (command && !event.altKey && !event.shiftKey) return { command, handled: true };
  }
  if (!event.shiftKey && !event.metaKey) {
    if (event.ctrlKey && !event.altKey && (key === 'g' || key === 'n' || key === 'k'))
      return { state: { prefix: key.toUpperCase() as SequenceState['prefix'], startedAt: now }, handled: true };
    if (event.altKey && !event.ctrlKey && key === 'v')
      return { state: { prefix: 'V', startedAt: now }, handled: true };
  }
  return { handled: false };
}

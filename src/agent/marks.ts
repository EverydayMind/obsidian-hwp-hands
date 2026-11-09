import type { Target } from '../api';
import type { StructuralChange } from './selection';

/**
 * Where AI edits landed that no person has looked through yet: a review aid drawn on the page, never a write authority.
 * A mark is a paragraph, or a whole table when `table` holds its control index. Marks follow this layer's own edits and a
 * person's edits that keep every paragraph address. After anything else their positions are unknown and they are not drawn.
 */
export interface EditMark { address: Target; table?: number }
interface MarkSet { sessionId: string; revision: number; marks: EditMark[] }
const MAX_MARKS = 500;
const keyOf = (mark: EditMark): string => JSON.stringify([mark.address.section, mark.address.paragraph, mark.address.cellPath ?? [], mark.table ?? null]);
const plain = (mark: EditMark): EditMark => ({ address: { section: mark.address.section, paragraph: mark.address.paragraph, ...(mark.address.cellPath?.length ? { cellPath: structuredClone(mark.address.cellPath) } : {}) },
  ...(mark.table === undefined ? {} : { table: mark.table }) });

/** The number a body paragraph has after insertions and deletions given in numbers from before them; undefined when it was deleted. */
export function shiftedParagraph(paragraph: number, changes: StructuralChange[]): number | undefined {
  if (changes.some(change => change.action === 'delete' && change.index === paragraph)) return undefined;
  return changes.reduce((index, change) => index + (change.action === 'delete' ? (change.index < paragraph ? -1 : 0)
    : change.action === 'insert_after' ? (change.index < paragraph ? change.count : 0) : change.index <= paragraph ? change.count : 0), paragraph);
}

export class EditMarks {
  private readonly sets = new Map<string, MarkSet>();
  private readonly previous = new Map<string, MarkSet | undefined>();
  private readonly listeners = new Set<(path: string) => void>();
  onChange(listener: (path: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(path: string): void { for (const listener of this.listeners) { try { listener(path); } catch (error) { console.error('HWP Hands edit marks:', error); } } }
  /** Marks whose positions are known for exactly this document state. */
  current(path: string, state: { sessionId: string; revision: number }): EditMark[] {
    const set = this.sets.get(path);
    return set && set.sessionId === state.sessionId && set.revision === state.revision ? set.marks : [];
  }
  /**
   * An AI edit moved the document from `before` to `after`. `added` are addresses in the document after the edit;
   * `moved` describes body paragraphs of one section the edit inserted or deleted, in numbers from before it.
   */
  add(path: string, sessionId: string, before: number, after: number, added: EditMark[], moved?: { section: number; changes: StructuralChange[] }): void {
    const set = this.sets.get(path), kept = set && set.sessionId === sessionId && set.revision === before ? set.marks : [];
    this.previous.set(path, set ? structuredClone(set) : undefined);
    const carried = !moved ? kept : kept.flatMap(mark => {
      if (mark.address.section !== moved.section) return [mark];
      const paragraph = shiftedParagraph(mark.address.paragraph, moved.changes);
      return paragraph === undefined ? [] : [{ ...mark, address: { ...mark.address, paragraph } }];
    });
    const merged = new Map([...carried, ...added.map(plain)].map(mark => [keyOf(mark), mark]));
    this.sets.set(path, { sessionId, revision: after, marks: [...merged.values()].slice(-MAX_MARKS) });
    this.changed(path);
  }
  /** An edit that kept every paragraph address and table shape, by anyone. */
  carried(path: string, sessionId: string, before: number, after: number): void {
    const set = this.sets.get(path);
    if (set && set.sessionId === sessionId && set.revision === before) { set.revision = after; this.changed(path); }
  }
  /** The last AI edit was undone by the layer that made it: the marks are as they were before it. */
  undone(path: string, sessionId: string, after: number): void {
    const previous = this.previous.get(path);
    this.previous.delete(path);
    if (previous && previous.sessionId === sessionId) this.sets.set(path, { ...previous, revision: after }); else this.sets.delete(path);
    this.changed(path);
  }
  /** A person looked through the edits, saved, discarded, reloaded or closed the document. */
  clear(path: string): void {
    this.previous.delete(path);
    if (this.sets.delete(path)) this.changed(path);
  }
  dispose(): void { this.sets.clear(); this.previous.clear(); this.listeners.clear(); }
}

import type { BodyAddress, CellStep, Command, DocumentAddress, Paragraph, SelectionRange, Target } from '../api';

/**
 * The range a person had selected when they submitted the turn, kept as coordinates of the document as it is now.
 * Edits of that turn stay inside it. It follows this layer's own edits and a person's edits elsewhere; anything
 * else that changes the document makes it stale, and it is never widened to make an edit fit.
 */
export interface AllowedRange {
  sessionId: string; revision: number;
  /** False when the ends are not in the body, or not in the same body or cell: nothing is inside such a range. */
  usable: boolean;
  section: number;
  /** Host paragraph and cell path (without the paragraph number) when the range lies inside one cell. */
  cell?: { paragraph: number; path: CellStep[] };
  /** First and last paragraph: body paragraph numbers, or paragraph numbers inside the cell. */
  from: number; to: number;
  /** Code point offsets in the first and last paragraph. `end` is Infinity when the range runs to the end of the last paragraph. */
  start: number; end: number;
  /** Set once the selected paragraphs were all deleted. */
  empty?: boolean;
}
export type StructuralChange = { action: 'insert_after' | 'insert_before' | 'delete'; index: number; count: number };

const cellKey = (path: CellStep[]): string => JSON.stringify(path.map((step, index) => index === path.length - 1 ? [step.controlIndex, step.cellIndex] : [step.controlIndex, step.cellIndex, step.cellParaIndex]));
/** Paragraphs with the same container are siblings: the body of a section, or one cell. */
export const containerOf = (address: Target): string => JSON.stringify([address.section, ...(address.cellPath?.length ? [address.paragraph, cellKey(address.cellPath)] : [])]);
export const orderOf = (address: Target): number => address.cellPath?.length ? address.cellPath.at(-1)!.cellParaIndex : address.paragraph;
const isBody = (address: DocumentAddress): address is BodyAddress => address.kind === 'body';

export function allowedRange(sessionId: string, revision: number, range: SelectionRange): AllowedRange {
  const none: AllowedRange = { sessionId, revision, usable: false, section: 0, from: 0, to: -1, start: 0, end: 0 };
  let a = range.start, b = range.end;
  if (!isBody(a.address) || !isBody(b.address) || containerOf(a.address) !== containerOf(b.address)) return none;
  if (orderOf(a.address) > orderOf(b.address) || (orderOf(a.address) === orderOf(b.address) && a.offset > b.offset)) [a, b] = [b, a];
  const first = a.address as BodyAddress, path = first.cellPath ?? [];
  let to = orderOf(b.address), end = b.offset;
  // A selection that ends at the very start of a following paragraph covers the paragraphs before it.
  if (end === 0 && to > orderOf(first)) { to--; end = Infinity; }
  return { sessionId, revision, usable: true, section: first.section, ...(path.length ? { cell: { paragraph: first.paragraph, path: structuredClone(path) } } : {}),
    from: orderOf(first), to, start: a.offset, end };
}

const sameCell = (range: AllowedRange, address: Target): boolean => !!range.cell && address.section === range.section && address.paragraph === range.cell.paragraph
  && !!address.cellPath && address.cellPath.length === range.cell.path.length && cellKey(address.cellPath) === cellKey(range.cell.path);

/** Checks of one edit call against the range, with the paragraph lengths of the document as it is now. */
export class SelectionGuard {
  private readonly lengths = new Map<string, number>();
  constructor(readonly range: AllowedRange, paragraphs: Paragraph[]) {
    for (const paragraph of paragraphs) this.lengths.set(JSON.stringify([containerOf(paragraph.address), orderOf(paragraph.address)]), Array.from(paragraph.text).length);
    const last = this.lengths.get(JSON.stringify([this.containerKey(), range.to]));
    if (range.usable && last !== undefined && range.end >= last) range.end = Infinity;
  }
  private containerKey(): string {
    const range = this.range;
    return containerOf({ section: range.section, paragraph: range.cell?.paragraph ?? 0, ...(range.cell ? { cellPath: range.cell.path } : {}) });
  }
  /** Selected code points of the paragraph, or undefined when the selection does not touch it. */
  span(address: Target, length: number): [number, number] | undefined {
    const range = this.range;
    if (!range.usable || range.empty || address.section !== range.section) return undefined;
    const inside = range.cell ? sameCell(range, address) : !address.cellPath?.length;
    if (inside) {
      const order = orderOf(address);
      if (order < range.from || order > range.to) return undefined;
      return [order === range.from ? range.start : 0, order === range.to ? Math.min(range.end, length) : length];
    }
    // Something inside a table or text box belongs to the selection when the paragraph that holds it is selected whole.
    if (!range.cell && address.cellPath?.length && this.whole({ section: address.section, paragraph: address.paragraph })) return [0, length];
    return undefined;
  }
  private lengthOf(address: Target): number { return this.lengths.get(JSON.stringify([containerOf(address), orderOf(address)])) ?? 0; }
  touches(address: Target): boolean { return !!this.span(address, this.lengthOf(address)); }
  whole(address: Target): boolean {
    const length = this.lengthOf(address), span = this.span(address, length);
    return !!span && span[0] === 0 && span[1] === length;
  }
  covers(address: Target, start: number, end: number): boolean {
    const span = this.span(address, this.lengthOf(address));
    return !!span && start >= span[0] && end <= span[1];
  }
  /** The smallest changed stretch of a rewrite lies inside the selection. An unchanged paragraph only has to be touched. */
  rewrite(paragraph: Paragraph, after: string): boolean {
    const before = Array.from(paragraph.text), next = Array.from(after);
    let head = 0, tail = 0;
    while (head < before.length && head < next.length && before[head] === next[head]) head++;
    while (tail < before.length - head && tail < next.length - head && before.at(-1 - tail) === next.at(-1 - tail)) tail++;
    return this.covers(paragraph.address, head, before.length - tail);
  }
  /** New paragraphs may go between selected paragraphs, and before or after the range only where it reaches the paragraph edge. */
  insertion(address: Target, before: boolean): boolean {
    const range = this.range, length = this.lengthOf(address), span = this.span(address, length);
    if (!span) return false;
    if (address.cellPath?.length && !range.cell) return this.whole({ section: address.section, paragraph: address.paragraph });
    const order = orderOf(address);
    return before ? order > range.from || span[0] === 0 : order < range.to || span[1] === length;
  }
  /** Paragraphs of the body or cell the selection lies in that it touches, in document order. */
  siblings(paragraphs: Paragraph[]): Paragraph[] {
    const key = this.containerKey();
    return paragraphs.filter(paragraph => containerOf(paragraph.address) === key && this.touches(paragraph.address));
  }

  /** This layer's own text rewrites: offsets in the last paragraph move with the text before the end of the range. */
  rewritten(changes: Array<{ paragraph: Paragraph; after: string }>, revision: number): void {
    const range = this.range;
    for (const change of changes) {
      const address = change.paragraph.address, inside = range.cell ? sameCell(range, address) : !address.cellPath?.length && address.section === range.section;
      if (inside && orderOf(address) === range.to && Number.isFinite(range.end)) range.end += Array.from(change.after).length - Array.from(change.paragraph.text).length;
    }
    range.revision = revision;
  }
  /** This layer's own insertions and deletions of body paragraphs, all given with the paragraph numbers before the edit. */
  restructured(changes: StructuralChange[], revision: number): void {
    const range = this.range;
    if (!range.cell) {
      const inserted = changes.filter(change => change.action !== 'delete').reduce((sum, change) => sum + change.count, 0);
      const deleted = changes.filter(change => change.action === 'delete');
      if (deleted.some(change => change.index === range.from) || changes.some(change => change.action === 'insert_before' && change.index === range.from)) range.start = 0;
      if (deleted.some(change => change.index === range.to)) range.end = Infinity;
      range.to += inserted - deleted.length;
      if (range.to < range.from) range.empty = true;
    }
    range.revision = revision;
  }
  /** Cell paragraph indices move only inside the selected cell; body selections retain their existing extent. */
  cellRestructured(address: Target, changes: StructuralChange[], revision: number): void {
    const range = this.range;
    if (range.cell && sameCell(range, address)) {
      const inserted = changes.filter(change => change.action !== 'delete').reduce((sum, change) => sum + change.count, 0);
      const deleted = changes.filter(change => change.action === 'delete');
      if (deleted.some(change => change.index === range.from) || changes.some(change => change.action === 'insert_before' && change.index === range.from)) range.start = 0;
      if (deleted.some(change => change.index === range.to)) range.end = Infinity;
      range.to += inserted - deleted.length;
      if (range.to < range.from) range.empty = true;
    }
    range.revision = revision;
  }
  kept(revision: number): void { this.range.revision = revision; }
}

/**
 * Body paragraphs a transaction touched when every command keeps all paragraph addresses and table shapes, so handles
 * given out before it still name the same things. `wide` means a range of paragraphs was touched. Undefined otherwise.
 */
export function addressPreserving(commands: Command[]): { targets: Target[]; wide: boolean } | undefined {
  const targets: Target[] = [];
  let wide = false;
  const add = (address: unknown): boolean => {
    const item = address as { kind?: unknown; section?: unknown; paragraph?: unknown } | undefined;
    if (!item || typeof item !== 'object') return false;
    // Text in a header, footer or note never moves a body paragraph.
    if (item.kind !== undefined && item.kind !== 'body') return true;
    if (!Number.isSafeInteger(item.section) || !Number.isSafeInteger(item.paragraph)) return false;
    targets.push(item as Target);
    return true;
  };
  for (const command of commands) {
    switch (command.type) {
      case 'insertText': case 'insertLineBreak': case 'insertTab': case 'deleteText': case 'replaceParagraph':
      case 'formatText': case 'formatParagraph': case 'setParagraphStyle': case 'setParagraphList':
        if (!add(command.target)) return undefined;
        break;
      case 'formatRange':
        if (!add(command.range?.start?.address) || !add(command.range?.end?.address)) return undefined;
        wide = true; break;
      default: return undefined;
    }
  }
  return { targets, wide };
}

/** Whether an edit somewhere in the document can have changed text inside the range. */
export function overlaps(range: AllowedRange, edit: { targets: Target[]; wide: boolean }): boolean {
  if (!range.usable || range.empty) return false;
  if (edit.wide) return true;
  return edit.targets.some(target => {
    if (target.section !== range.section) return false;
    if (!range.cell) return target.paragraph >= range.from && target.paragraph <= range.to;
    if (target.paragraph !== range.cell.paragraph || !target.cellPath || target.cellPath.length < range.cell.path.length) return false;
    const prefix = target.cellPath.slice(0, range.cell.path.length), order = prefix.at(-1)!.cellParaIndex;
    return cellKey(prefix) === cellKey(range.cell.path) && order >= range.from && order <= range.to;
  });
}

import type { DocumentAddress, DocumentObject, DocumentTree, Field, LayoutControl, LayoutTextRun, PageLayout, Paragraph, SelectionRange, StoryParagraph, Table } from './api';
import { isRootBodyAddress, selectionContainerKey, selectionParagraphIndex } from './ui/editor/selection-segments';

export type TextParagraph = Paragraph | StoryParagraph;
export type PageHit =
  | { kind: 'paragraph'; paragraph: TextParagraph; offset: number }
  | { kind: 'field'; field: Field; offset: number }
  | { kind: 'tableCell'; table: Table; cellIndex: number; row: number; col: number; paragraph?: Paragraph; offset?: number }
  | { kind: 'object'; object: DocumentObject; control: LayoutControl };

export function pagePointFromClient(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  pageSize: { width: number; height: number },
): { x: number; y: number } | undefined {
  if (bounds.width <= 0 || bounds.height <= 0 || pageSize.width <= 0 || pageSize.height <= 0) return undefined;
  return {
    x: (clientX - bounds.left) * pageSize.width / bounds.width,
    y: (clientY - bounds.top) * pageSize.height / bounds.height,
  };
}

function addressKey(address: DocumentAddress): string {
  if (address.kind === 'body') return JSON.stringify(['body', address.section, address.paragraph, (address.cellPath ?? []).map((step, index) => [step.controlIndex, step.cellIndex, step.cellParaIndex, address.containerKinds?.[index] ?? 'tableCell'])]);
  if (address.kind === 'headerFooter') return JSON.stringify(['headerFooter', address.section, address.isHeader, address.applyTo, address.paragraph]);
  return JSON.stringify([address.kind, address.section, address.anchor.section, address.anchor.paragraph, (address.anchor.cellPath ?? []).map(step => [step.controlIndex, step.cellIndex, step.cellParaIndex]), address.controlIndex, address.paragraph]);
}

export function sameDocumentAddress(left: DocumentAddress, right: DocumentAddress): boolean {
  return addressKey(left) === addressKey(right);
}

function runAddress(run: LayoutTextRun): DocumentAddress | undefined { return run.documentAddress ?? run.address; }
function contains(x: number, y: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  return Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0
    && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}
function characterOffset(run: LayoutTextRun, x: number, length: number): number {
  const textLength = Array.from(run.text).length, base = run.offset ?? run.charStart ?? 0;
  if (!textLength || length <= 0) return Math.max(0, Math.min(length, base));
  const positions = run.charX;
  let local: number;
  if (positions.length >= textLength) {
    const maxIndex = positions.length === textLength + 1 ? textLength : textLength - 1;
    local = 0;
    for (let index = 1; index <= maxIndex; index++) {
      if (Math.abs(run.x + positions[index] - x) < Math.abs(run.x + positions[local] - x)) local = index;
    }
  } else {
    local = Math.round(Math.max(0, Math.min(1, (x - run.x) / run.w)) * textLength);
  }
  return Math.max(0, Math.min(length, base + local));
}

export function flatParagraphs(tree: DocumentTree): TextParagraph[] {
  const storyParagraphs = tree.stories.flatMap(story => [...story.paragraphs]) as TextParagraph[];
  const values: TextParagraph[] = [
    ...tree.paragraphs,
    ...tree.tables.flatMap(table => table.cells.flatMap(cell => cell.paragraphs)),
    ...storyParagraphs,
  ];
  return [...new Map<string, TextParagraph>(values.map(paragraph => [paragraph.nodePath, paragraph])).values()];
}

export function paragraphAtAddress(tree: DocumentTree, address: DocumentAddress): TextParagraph | undefined {
  return flatParagraphs(tree).find(paragraph => sameDocumentAddress(paragraph.address, address));
}

function fieldAt(tree: DocumentTree, address: DocumentAddress, offset: number): Field | undefined {
  const matching = tree.fields.filter(field => field.address && addressKey(field.address) === addressKey(address));
  const ranged = matching.filter(field => Number.isSafeInteger(field.startCharIdx) && Number.isSafeInteger(field.endCharIdx) && Number(field.endCharIdx) > Number(field.startCharIdx));
  const exact = ranged.find(field => offset >= Number(field.startCharIdx) && offset <= Number(field.endCharIdx));
  if (exact) return exact;
  return matching.length === 1 && !ranged.length ? matching[0] : undefined;
}

function objectKindForControl(control: LayoutControl): string | undefined {
  if (control.type === 'image') return 'picture';
  if (control.type === 'shape') return 'shape';
  if (control.type === 'equation') return 'equation';
  return undefined;
}

function objectForControl(control: LayoutControl, tree: DocumentTree): DocumentObject | undefined {
  const kind = objectKindForControl(control);
  if (!kind) return undefined;
  const candidates = tree.objects.filter(object => object.kind === kind && object.address.section === control.section
    && object.address.paragraph === control.paragraph && object.controlIndex === control.controlIndex
    && !object.address.cellPath?.length);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Resolve a page point in renderer coordinates to the most specific known document target. */
export function hitTestPage(layout: PageLayout, x: number, y: number, tree: DocumentTree): PageHit | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > layout.info.width || y > layout.info.height) return undefined;
  const paragraphs = flatParagraphs(tree);

  const controls = layout.controls
    .filter(control => control.type !== 'table' && contains(x, y, control))
    .sort((left, right) => right.zOrder - left.zOrder || left.width * left.height - right.width * right.height);
  for (const control of controls) {
    const object = objectForControl(control, tree);
    if (!object) continue;
    const textboxTextUnderPoint = layout.textRuns.some(run => {
      const address = runAddress(run);
      return !!address && address.kind === 'body' && address.containerKinds?.includes('textBox') === true
        && contains(x, y, { x: run.x, y: run.y, width: run.w, height: run.h });
    });
    if (!textboxTextUnderPoint) return { kind: 'object', object, control };
  }

  const runs = layout.textRuns.filter(run => {
    if (!contains(x, y, { x: run.x, y: run.y, width: run.w, height: run.h })) return false;
    const address = runAddress(run);
    return !!run.text || (!!address && tree.fields.some(field => field.address && addressKey(field.address) === addressKey(address)));
  })
    .sort((left, right) => left.w * left.h - right.w * right.h);
  for (const run of runs) {
    const address = runAddress(run);
    if (!address) continue;
    const paragraph = paragraphs.find(item => addressKey(item.address) === addressKey(address));
    if (!paragraph) continue;
    const offset = characterOffset(run, x, paragraph.length);
    const field = fieldAt(tree, address, offset);
    if (field) return { kind: 'field', field, offset };
    return { kind: 'paragraph', paragraph, offset };
  }

  const tableControls = layout.controls.filter(control => control.type === 'table')
    .sort((left, right) => left.width * left.height - right.width * right.height);
  for (const control of tableControls) {
    const cell = control.cells?.filter(item => contains(x, y, item))
      .sort((left, right) => left.width * left.height - right.width * right.height)[0];
    if (!cell) continue;
    const tables = tree.tables.filter(table => table.section === control.section && table.paragraph === control.paragraph
      && table.control === control.controlIndex && !table.address.cellPath?.length);
    if (tables.length !== 1) continue;
    const table = tables[0];
    const node = table.cells.find(item => item.index === cell.cellIndex);
    if (!node) continue;
    const paragraph = node.paragraphs.find(item => item.address.cellPath?.at(-1)?.cellParaIndex === 0) ?? node.paragraphs[0];
    return { kind: 'tableCell', table, cellIndex: node.index, row: node.row, col: node.col, ...(paragraph ? { paragraph } : {}) };
  }
  return undefined;
}

export interface LayoutSelectionRect { x: number; y: number; width: number; height: number; caret: boolean }
export interface LayoutBounds { x: number; y: number; width: number; height: number }

export function layoutParagraphBounds(layout: PageLayout, address: DocumentAddress): LayoutBounds | undefined {
  const runs = layout.textRuns.filter(run => {
    const candidate = runAddress(run);
    return !!candidate && sameDocumentAddress(candidate, address) && [run.x, run.y, run.w, run.h].every(Number.isFinite) && run.w >= 0 && run.h > 0;
  });
  if (!runs.length) return undefined;
  const left = Math.min(...runs.map(run => run.x)), top = Math.min(...runs.map(run => run.y));
  const right = Math.max(...runs.map(run => run.x + run.w)), bottom = Math.max(...runs.map(run => run.y + run.h));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function xAt(run: LayoutTextRun, offset: number): number {
  const length = Array.from(run.text).length;
  const local = Math.max(0, Math.min(length, offset));
  if (run.charX.length > local) return run.x + run.charX[local];
  if (local === length) return run.x + run.w;
  return run.x + run.w * (length ? local / length : 0);
}

export function layoutSelectionRects(layout: PageLayout, address: DocumentAddress, start: number, end: number): LayoutSelectionRect[] {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return [];
  const rects: LayoutSelectionRect[] = [];
  const runs = layout.textRuns.filter(run => {
    const candidate = runAddress(run);
    return !!candidate && sameDocumentAddress(candidate, address);
  });
  if (start === end && runs.length) {
    const run = runs.find(item => {
      const base = item.offset ?? item.charStart ?? 0, length = Array.from(item.text).length;
      return start >= base && start <= base + length;
    }) ?? runs.reduce((closest, item) => {
      const base = item.offset ?? item.charStart ?? 0, length = Array.from(item.text).length;
      const closestBase = closest.offset ?? closest.charStart ?? 0, closestLength = Array.from(closest.text).length;
      return Math.min(Math.abs(start - base), Math.abs(start - base - length)) < Math.min(Math.abs(start - closestBase), Math.abs(start - closestBase - closestLength)) ? item : closest;
    });
    const base = run.offset ?? run.charStart ?? 0;
    const x = xAt(run, start - base);
    rects.push({ x, y: run.y, width: 0, height: Math.max(1, run.h), caret: true });
    return rects;
  }
  for (const run of runs) {
    const base = run.offset ?? run.charStart ?? 0, length = Array.from(run.text).length;
    const from = Math.max(start, base), to = Math.min(end, base + length);
    if (to <= from) continue;
    const first = xAt(run, from - base), last = xAt(run, to - base);
    rects.push({ x: Math.min(first, last), y: run.y, width: Math.max(1, Math.abs(last - first)), height: Math.max(1, run.h), caret: false });
  }
  return rects;
}

/** Rectangles of an ordered range, using only the addressed runs on this page. */
export function layoutRangeSelectionRects(layout: PageLayout, range: SelectionRange): LayoutSelectionRect[] {
  const { start, end } = range;
  if (sameDocumentAddress(start.address, end.address) && start.offset === end.offset) {
    return layoutSelectionRects(layout, start.address, start.offset, end.offset);
  }
  const rootBody = isRootBodyAddress(start.address) && isRootBodyAddress(end.address);
  const container = selectionContainerKey(start.address);
  const compare = (left: DocumentAddress, right: DocumentAddress): number => rootBody
    ? left.section - right.section || left.paragraph - right.paragraph
    : selectionParagraphIndex(left) - selectionParagraphIndex(right);
  return layout.textRuns.flatMap(run => {
    const address = runAddress(run);
    if (!address || (rootBody ? !isRootBodyAddress(address) : selectionContainerKey(address) !== container)
      || compare(address, start.address) < 0 || compare(address, end.address) > 0) return [];
    const base = run.offset ?? run.charStart ?? 0, length = Array.from(run.text).length;
    const from = Math.max(base, sameDocumentAddress(address, start.address) ? start.offset : 0);
    const to = Math.min(base + length, sameDocumentAddress(address, end.address) ? end.offset : base + length);
    if (to <= from) return [];
    const first = xAt(run, from - base), last = xAt(run, to - base);
    return [{ x: Math.min(first, last), y: run.y, width: Math.max(1, Math.abs(last - first)), height: Math.max(1, run.h), caret: false }];
  });
}

import type { Command, DocumentTree, SelectionRange, Table, TextPosition } from '../../api';
import type { CellBlockRange } from '../../table-cell-selection';
import { selectionContainerKey, selectionParagraphIndex, treeTextParagraphs } from './selection-segments';

const FORMATTING_COMMANDS = new Set(['formatText', 'formatParagraph', 'setParagraphStyle', 'setParagraphList', 'formatRange', 'formatCellBlock']);
export function isNonstructuralFormatting(commands: readonly Command[]): boolean {
  return commands.length > 0 && commands.every(command => FORMATTING_COMMANDS.has(command.type));
}
export function rebindTextPosition(tree: DocumentTree, position: TextPosition): TextPosition | undefined {
  const paragraph = treeTextParagraphs(tree).find(item => selectionContainerKey(item.address) === selectionContainerKey(position.address)
    && selectionParagraphIndex(item.address) === selectionParagraphIndex(position.address));
  return paragraph && position.offset >= 0 && position.offset <= paragraph.length ? { address: paragraph.address, offset: position.offset } : undefined;
}
export interface SelectionRestoreSnapshot {
  range?: SelectionRange;
  anchor?: TextPosition;
  focus?: TextPosition;
  block?: { table: Pick<Table, 'address' | 'control'>; selection: CellBlockRange };
}
export function restoreOwnFormattingSelection(tree: DocumentTree, snapshot: SelectionRestoreSnapshot, commands: readonly Command[], receiptRevision: number, currentRevision: number): SelectionRestoreSnapshot | undefined {
  if (receiptRevision !== currentRevision || !isNonstructuralFormatting(commands)) return undefined;
  const start = snapshot.range && rebindTextPosition(tree, snapshot.range.start), end = snapshot.range && rebindTextPosition(tree, snapshot.range.end);
  const anchor = snapshot.anchor && rebindTextPosition(tree, snapshot.anchor), focus = snapshot.focus && rebindTextPosition(tree, snapshot.focus);
  if (snapshot.range && (!start || !end) || snapshot.anchor && !anchor || snapshot.focus && !focus) return undefined;
  let block: SelectionRestoreSnapshot['block'];
  if (snapshot.block) {
    const previous = snapshot.block;
    const table = tree.tables.find(item => item.control === previous.table.control
      && selectionContainerKey(item.address) === selectionContainerKey(previous.table.address)
      && selectionParagraphIndex(item.address) === selectionParagraphIndex(previous.table.address));
    if (!table || [previous.selection.anchor, previous.selection.focus].some(point => point.row < 0 || point.col < 0 || point.row >= table.rows || point.col >= table.cols)) return undefined;
    block = { table, selection: { ...previous.selection, tablePath: table.nodePath } };
  }
  return { ...(start && end ? { range: { start, end } } : {}), ...(anchor ? { anchor } : {}), ...(focus ? { focus } : {}), ...(block ? { block } : {}) };
}

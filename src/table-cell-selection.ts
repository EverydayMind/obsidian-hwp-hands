import type { Table } from './api';

export interface CellGridPoint { row: number; col: number }
export interface CellBlockRange { tablePath: string; anchor: CellGridPoint; focus: CellGridPoint }
export interface CellBorderEdges { top: boolean; bottom: boolean; left: boolean; right: boolean }
export interface AdjacentCellCaretTarget { paragraph: Table['cells'][number]['paragraphs'][number]; offset: number }

/** Finds the next non-empty cell paragraph when the caret is already at this cell's outer text boundary. */
export function adjacentTableCellCaretTarget(
  table: Pick<Table, 'cells'>,
  cellIndex: number,
  cellParagraphIndex: number,
  direction: -1 | 1,
): AdjacentCellCaretTarget | undefined {
  const cells = [...table.cells].sort((left, right) => left.row - right.row || left.col - right.col);
  const currentIndex = cells.findIndex(cell => cell.index === cellIndex);
  const current = cells[currentIndex];
  if (!current || !Number.isSafeInteger(cellParagraphIndex) || cellParagraphIndex < 0) return undefined;
  if (direction < 0 && cellParagraphIndex > 0 || direction > 0 && cellParagraphIndex < current.paragraphs.length - 1) return undefined;
  for (let index = currentIndex + direction; index >= 0 && index < cells.length; index += direction) {
    const paragraphs = cells[index].paragraphs;
    if (!paragraphs.length) continue;
    const paragraph = direction > 0 ? paragraphs[0] : paragraphs.at(-1)!;
    return { paragraph, offset: direction > 0 ? 0 : paragraph.length };
  }
  return undefined;
}

export function cellBlockBorderEdges(cell: Pick<Table['cells'][number], 'row' | 'col' | 'rowSpan' | 'colSpan'>, range?: CellBlockRange, eachCell = false): CellBorderEdges {
  const top = range ? Math.min(range.anchor.row, range.focus.row) : cell.row;
  const bottom = range ? Math.max(range.anchor.row, range.focus.row) : cell.row + cell.rowSpan - 1;
  const left = range ? Math.min(range.anchor.col, range.focus.col) : cell.col;
  const right = range ? Math.max(range.anchor.col, range.focus.col) : cell.col + cell.colSpan - 1;
  return {
    top: eachCell || cell.row <= top,
    bottom: eachCell || cell.row + cell.rowSpan - 1 >= bottom,
    left: eachCell || cell.col <= left,
    right: eachCell || cell.col + cell.colSpan - 1 >= right,
  };
}

export function cellAtGridPoint(table: Table, point: CellGridPoint): Table['cells'][number] | undefined {
  return table.cells.find(cell => point.row >= cell.row && point.row < cell.row + cell.rowSpan
    && point.col >= cell.col && point.col < cell.col + cell.colSpan);
}

export function extendCellBlockRange(range: CellBlockRange, table: Table, deltaRow: number, deltaCol: number): CellBlockRange {
  const current = cellAtGridPoint(table, range.focus);
  if (!current) return range;
  const nextRow = deltaRow > 0 ? current.row + current.rowSpan : deltaRow < 0 ? current.row - 1 : current.row;
  const nextCol = deltaCol > 0 ? current.col + current.colSpan : deltaCol < 0 ? current.col - 1 : current.col;
  const row = Math.max(0, Math.min(table.rows - 1, nextRow));
  const col = Math.max(0, Math.min(table.cols - 1, nextCol));
  const focus = cellAtGridPoint(table, { row, col });
  if (focus?.index === current.index) return range;
  return focus ? { ...range, focus: { row: focus.row, col: focus.col } } : range;
}

export function cellsInCellBlock(table: Table, range: CellBlockRange): Table['cells'] {
  const top = Math.min(range.anchor.row, range.focus.row), bottom = Math.max(range.anchor.row, range.focus.row);
  const left = Math.min(range.anchor.col, range.focus.col), right = Math.max(range.anchor.col, range.focus.col);
  return table.cells.filter(cell => cell.row <= bottom && cell.row + cell.rowSpan - 1 >= top
    && cell.col <= right && cell.col + cell.colSpan - 1 >= left);
}

/** Expand a rectangular block until every intersecting merged cell fits inside it. */
export function completeCellBlockRange(table: Table, range: CellBlockRange): CellBlockRange {
  let top = Math.min(range.anchor.row, range.focus.row), bottom = Math.max(range.anchor.row, range.focus.row);
  let left = Math.min(range.anchor.col, range.focus.col), right = Math.max(range.anchor.col, range.focus.col);
  let expanded: boolean;
  do {
    expanded = false;
    for (const cell of table.cells) {
      if (cell.row > bottom || cell.row + cell.rowSpan - 1 < top || cell.col > right || cell.col + cell.colSpan - 1 < left) continue;
      const nextTop = Math.min(top, cell.row), nextBottom = Math.max(bottom, cell.row + cell.rowSpan - 1);
      const nextLeft = Math.min(left, cell.col), nextRight = Math.max(right, cell.col + cell.colSpan - 1);
      if (nextTop !== top || nextBottom !== bottom || nextLeft !== left || nextRight !== right) expanded = true;
      top = nextTop; bottom = nextBottom; left = nextLeft; right = nextRight;
    }
  } while (expanded);
  return { ...range, anchor: { row: top, col: left }, focus: { row: bottom, col: right } };
}

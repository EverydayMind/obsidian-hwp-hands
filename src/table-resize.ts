import type { Cell } from './api';

export type TableResizeAxis = 'width' | 'height';
export type TableCellResize = { row: number; col: number; widthDelta?: number; heightDelta?: number };

/** RHWP layout coordinates use CSS px at 96dpi; table dimensions are stored in HWPUNIT (7200/in). */
export function pagePixelsToHwpUnits(value: number): number {
  if (!Number.isFinite(value)) throw new Error('표 크기 변경은 유한한 페이지 좌표여야 합니다.');
  return Math.round(value * 7200 / 96);
}

export function tableCellResizeChanges(cells: readonly Pick<Cell, 'row' | 'col'>[], axis: TableResizeAxis, delta: number): TableCellResize[] {
  if (axis !== 'width' && axis !== 'height') throw new Error('표 크기 변경 방향이 올바르지 않습니다.');
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100_000) throw new Error('표 크기 변경은 1–100000 HWPUNIT 범위의 정수여야 합니다.');
  if (!cells.length || cells.length > 1000) throw new Error('표 크기를 바꿀 셀은 1–1000개여야 합니다.');
  const seen = new Set<string>();
  return cells.map(cell => {
    if (!Number.isSafeInteger(cell.row) || cell.row < 0 || !Number.isSafeInteger(cell.col) || cell.col < 0) {
      throw new Error('표 셀 주소가 올바르지 않습니다.');
    }
    const key = `${cell.row}:${cell.col}`;
    if (seen.has(key)) throw new Error('같은 표 셀은 한 번만 크기를 바꿀 수 있습니다.');
    seen.add(key);
    return axis === 'width' ? { row: cell.row, col: cell.col, widthDelta: delta } : { row: cell.row, col: cell.col, heightDelta: delta };
  });
}

export interface SizedTableCell { row: number; col: number; rowSpan: number; colSpan: number; properties?: { width: number; height: number } }
/**
 * Resize deltas that make the selected columns (axis `width`) or rows (axis `height`) equally large while keeping their total size.
 * Every cell of those columns/rows is adjusted so the table grid stays aligned; merged cells receive the sum of the deltas they cover.
 */
export function equalizeTableCellSizes(cells: readonly SizedTableCell[], axis: TableResizeAxis, from: number, to: number): TableCellResize[] {
  if (axis !== 'width' && axis !== 'height') throw new Error('표 크기 변경 방향이 올바르지 않습니다.');
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new Error('같게 만들 범위가 올바르지 않습니다.');
  const wide = axis === 'width';
  const start = (cell: SizedTableCell): number => wide ? cell.col : cell.row;
  const span = (cell: SizedTableCell): number => wide ? cell.colSpan : cell.rowSpan;
  const size = (cell: SizedTableCell): number | undefined => wide ? cell.properties?.width : cell.properties?.height;
  const sizes = new Map<number, number>();
  for (let index = from; index <= to; index++) {
    const single = cells.find(cell => start(cell) === index && span(cell) === 1 && size(cell) !== undefined);
    if (!single) throw new Error(`병합된 ${wide ? '칸' : '줄'}이 있어 ${wide ? '너비' : '높이'}를 같게 만들 수 없습니다.`);
    sizes.set(index, size(single)!);
  }
  const count = to - from + 1;
  if (count < 2) throw new Error(`${wide ? '칸' : '줄'}을 둘 이상 선택하세요.`);
  const total = [...sizes.values()].reduce((sum, value) => sum + value, 0);
  const base = Math.floor(total / count), remainder = total - base * count;
  const deltas = new Map<number, number>();
  for (let index = from; index <= to; index++) deltas.set(index, base + (index - from < remainder ? 1 : 0) - sizes.get(index)!);
  const changes: TableCellResize[] = [];
  for (const cell of cells) {
    let delta = 0;
    for (let index = Math.max(from, start(cell)); index <= Math.min(to, start(cell) + span(cell) - 1); index++) delta += deltas.get(index) ?? 0;
    if (delta !== 0) changes.push(wide ? { row: cell.row, col: cell.col, widthDelta: delta } : { row: cell.row, col: cell.col, heightDelta: delta });
  }
  return changes;
}

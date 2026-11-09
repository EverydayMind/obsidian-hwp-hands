import type { Command, Table } from '../../api';
export type CellNumberOperation = 'thousands' | 'decimal-add' | 'decimal-remove';
/** String operations avoid precision loss, rounding and locale-dependent parsing. */
export function formatCellNumber(value: string, operation: CellNumberOperation): string | undefined {
  const match = /^([ \t]*)([+-]?)(\d+|[1-9]\d{0,2}(?:,\d{3})+)(\.\d+)?([ \t]*)$/.exec(value);
  if (!match) return undefined;
  const [, before, sign, integer, decimal = '', after] = match;
  // Preserve identifiers with significant leading zeroes instead of adding grouping to them.
  if (integer.replaceAll(',', '').length > 1 && integer.startsWith('0')) return undefined;
  let digits = integer, fraction = decimal;
  if (operation === 'thousands') digits = integer.includes(',') ? integer.replaceAll(',', '') : integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  else if (operation === 'decimal-add') fraction = decimal ? `${decimal}0` : '.0';
  else if (operation === 'decimal-remove') fraction = decimal.length > 2 ? decimal.slice(0, -1) : '';
  return `${before}${sign}${digits}${fraction}${after}`;
}
export function cellNumberFormatCommands(table: Table, cells: Table['cells'], operation: CellNumberOperation, protectedCells: ReadonlySet<number> = new Set()): { commands: Command[]; skipped: number } {
  const commands: Command[] = []; let skipped = 0;
  for (const cell of cells) {
    // Replacing a cell would erase other paragraphs/objects/fields and their formatting.
    if (cell.paragraphs.length !== 1 || protectedCells.has(cell.index)) { skipped++; continue; }
    const paragraph = cell.paragraphs[0];
    const value = formatCellNumber(paragraph.text, operation);
    // eslint-disable-next-line no-control-regex -- HWP control characters must not be replaced by number formatting.
    if (value === undefined || /[\x00-\x1f]/.test(paragraph.text)) { skipped++; continue; }
    if (value !== paragraph.text) commands.push({ type: 'setCellText', table: { ...table.address, control: table.control }, row: cell.row, col: cell.col, text: value });
  }
  if (commands.length > 500) throw new Error('숫자 변환은 한 번에 변경 셀 500개까지 가능합니다. 선택 범위를 줄이세요.');
  return { commands, skipped };
}

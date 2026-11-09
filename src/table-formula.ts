// Pure helpers for table formulas: A1-style references, result formatting and block-calculation planning.
export type FormulaFormat = 'raw' | 'integer' | 'decimal1' | 'decimal2';
export const FORMULA_FORMATS: readonly FormulaFormat[] = ['raw', 'integer', 'decimal1', 'decimal2'];
export type BlockFunction = 'SUM' | 'AVERAGE' | 'PRODUCT';
export const MAX_FORMULA_LENGTH = 512;

/** Zero-based column index → spreadsheet label (0 → A, 25 → Z, 26 → AA). */
export function columnLabel(col: number): string {
  if (!Number.isSafeInteger(col) || col < 0) throw new Error('열 번호가 올바르지 않습니다.');
  let label = '';
  for (let value = col + 1; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + (value - 1) % 26) + label;
  return label;
}
export function cellReference(row: number, col: number): string {
  if (!Number.isSafeInteger(row) || row < 0) throw new Error('행 번호가 올바르지 않습니다.');
  return `${columnLabel(col)}${row + 1}`;
}
export function rangeReference(startRow: number, startCol: number, endRow: number, endCol: number): string {
  return startRow === endRow && startCol === endCol ? cellReference(startRow, startCol) : `${cellReference(startRow, startCol)}:${cellReference(endRow, endCol)}`;
}

/** Cell references used by a formula (function names such as `LOG10(` and the LEFT/ABOVE keywords are not references). */
export function formulaReferences(formula: string): Array<{ text: string; row: number; col: number }> {
  const references: Array<{ text: string; row: number; col: number }> = [];
  for (const match of formula.matchAll(/(?<![A-Za-z0-9_])([A-Za-z]{1,3})(\d{1,5})(?![A-Za-z0-9_]|\s*\()/g)) {
    let col = 0;
    for (const letter of match[1].toUpperCase()) col = col * 26 + (letter.charCodeAt(0) - 64);
    references.push({ text: match[0], row: Number(match[2]) - 1, col: col - 1 });
  }
  return references;
}

function withThousands(digits: string): string {
  const negative = digits.startsWith('-');
  const [integer, fraction] = digits.replace('-', '').split('.');
  return `${negative ? '-' : ''}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}
/** Text written into the cell: rounded per `format` (fixed decimals keep trailing zeros) and optionally grouped by thousands. */
export function formatFormulaResult(value: number, format: FormulaFormat = 'raw', thousandsSeparator = false): string {
  if (!Number.isFinite(value)) throw new Error('계산 결과가 유한한 숫자가 아닙니다.');
  const text = format === 'integer' ? String(Math.round(value))
    : format === 'decimal1' ? value.toFixed(1)
      : format === 'decimal2' ? value.toFixed(2)
        : String(Number(value.toPrecision(15)));
  const normalized = /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
  return thousandsSeparator ? withThousands(normalized) : normalized;
}

export interface BlockFormulaPlan { row: number; col: number; formula: string }
/** Where a block SUM/AVERAGE/PRODUCT writes its result and the formula to use, or undefined when no free neighbour cell exists. */
export function blockFormulaPlan(block: { startRow: number; startCol: number; endRow: number; endCol: number }, dims: { rows: number; cols: number }, fn: BlockFunction): BlockFormulaPlan | undefined {
  const below = block.endRow + 1 < dims.rows ? { row: block.endRow + 1, col: block.endCol } : undefined;
  const right = block.endCol + 1 < dims.cols ? { row: block.endRow, col: block.endCol + 1 } : undefined;
  const target = block.startRow === block.endRow ? right ?? below : below ?? right;
  if (!target) return undefined;
  return { ...target, formula: `=${fn}(${rangeReference(block.startRow, block.startCol, block.endRow, block.endCol)})` };
}

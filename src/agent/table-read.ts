import type { Cell, Table } from '../api';

/** Never mix pages collected across a mutable session revision. */
export async function collectRevisionTables<S extends { sessionId: string; revision: number }>(
  epoch: S,
  load: (offset: number) => Promise<{ state: S; tables: Table[]; total: number; isTablePage: boolean }>,
  assertSame: (expected: S, current: S) => void,
): Promise<Table[]> {
  const expected = { ...epoch };
  const tables: Table[] = [];
  let total: number | undefined;
  for (let offset = 0; ; offset += 500) {
    const page = await load(offset);
    assertSame(expected, page.state);
    assertSame(expected, epoch);
    if (!page.isTablePage || !Number.isSafeInteger(page.total) || page.total < 0 ||
        (total !== undefined && total !== page.total) || offset > page.total ||
        page.tables.length !== Math.min(500, page.total - offset)) {
      throw new Error('Invalid table page sequence');
    }
    total = page.total;
    tables.push(...page.tables);
    if (offset + page.tables.length >= page.total) break;
  }
  return tables;
}

export interface TableTextFragment {
  row: number; col: number; rowSpan: number; colSpan: number; paragraph: number;
  offset: number; text: string; endOfParagraph: boolean;
}

/** Private cursor position. Unit offsets are UTF-16 for slicing; public offsets are code points. */
export interface TableTextPosition { cell: number; paragraph: number; unit: number; offset: number }
interface LocatedFragment { fragment: TableTextFragment; position: TableTextPosition }

/** Preserve source ordering for merged cells while avoiding full-table scans per row. */
export class TableRowIndex {
  private readonly rows = new Map<number, Cell[]>();
  private readonly spanning: Cell[] = [];
  constructor(cells: readonly Cell[]) {
    for (const cell of cells) {
      const row = this.rows.get(cell.row) ?? [];
      row.push(cell); this.rows.set(cell.row, row);
      if (!Number.isInteger(cell.row) || cell.rowSpan > 1) this.spanning.push(cell);
    }
  }
  cellsAt(row: number): Cell[] { return (this.rows.get(row) ?? []).sort((a, b) => a.col - b.col); }
  coveredAt(row: number): Cell[] { return this.spanning.filter(cell => cell.row < row && cell.row + cell.rowSpan > row); }
}

/** One table per document revision; the provider owns and invalidates this index. */
export class TableCellIndex {
  private table?: Table;
  private cells?: Cell[];
  private coordinates?: Map<string, Cell | undefined>;
  ordered(table: Table): readonly Cell[] {
    if (this.table !== table || !this.cells) {
      this.table = table;
      this.cells = [...table.cells].sort((a, b) => a.row - b.row || a.col - b.col || a.index - b.index);
      this.coordinates = new Map();
      for (const cell of table.cells) {
        const key = `${cell.row + 1}:${cell.col + 1}`;
        // A coordinate-based paragraph handle cannot identify either cell if
        // the source reports the same physical coordinate more than once.
        this.coordinates.set(key, this.coordinates.has(key) ? undefined : cell);
      }
    }
    return this.cells;
  }
  at(table: Table, row: number, col: number): Cell | undefined {
    this.ordered(table);
    return this.coordinates?.get(`${row}:${col}`);
  }
}

/** Stable fragments resume at the cell and character without scanning earlier text. */
export function* tableTextFragments(table: Table, start: TableTextPosition = { cell: 0, paragraph: 0, unit: 0, offset: 0 }, index = new TableCellIndex()): Generator<LocatedFragment> {
  const cells = index.ordered(table);
  for (let c = start.cell; c < cells.length; c++) {
    const cell = cells[c];
    const paragraphs = cell.paragraphs.length ? cell.paragraphs : [{ text: '' }];
    for (let p = c === start.cell ? start.paragraph : 0; p < paragraphs.length; p++) {
      const source = paragraphs[p].text;
      let unit = c === start.cell && p === start.paragraph ? start.unit : 0;
      let offset = c === start.cell && p === start.paragraph ? start.offset : 0;
      let text = '', length = 0, beginUnit = unit;
      while (unit < source.length) {
        const char = String.fromCodePoint(source.codePointAt(unit)!);
        if (length === 200) {
          yield { position: { cell: c, paragraph: p, unit: beginUnit, offset },
            fragment: { row: cell.row + 1, col: cell.col + 1, rowSpan: cell.rowSpan, colSpan: cell.colSpan,
              paragraph: p + 1, offset, text, endOfParagraph: false } };
          offset += length; text = ''; length = 0; beginUnit = unit;
        }
        text += char; length++; unit += char.length;
      }
      yield { position: { cell: c, paragraph: p, unit: beginUnit, offset },
        fragment: { row: cell.row + 1, col: cell.col + 1, rowSpan: cell.rowSpan, colSpan: cell.colSpan,
          paragraph: p + 1, offset, text, endOfParagraph: true } };
    }
  }
}

/** Bound output even for escaped characters; return the lookahead's private resume position. */
export function tableTextPage(fragments: Iterable<LocatedFragment>): { page: TableTextFragment[]; next?: TableTextPosition } {
  const page: TableTextFragment[] = [];
  let size = 2;
  for (const { fragment, position } of fragments) {
    const cost = JSON.stringify(fragment).length + 1;
    if (page.length && (size + cost > 3000 || page.length >= 100)) return { page, next: position };
    page.push(fragment); size += cost;
  }
  return { page };
}

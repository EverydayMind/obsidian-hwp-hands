import type { CellProperties, Command, Target } from './api';
import { cellBlockBorderEdges, type CellBlockRange } from './table-cell-selection';

export interface TableCellFormatValues {
  cellSpacing: number;
  repeatHeader: boolean;
  fillMode: 'keep' | 'none' | 'solid' | 'pattern';
  fillColor: string;
  patternColor: string;
  patternType: number;
  isHeader: boolean;
  verticalAlign: number;
  padding: number;
  borderMode: 'each' | 'outside';
  borderType: number;
  borderColor: string;
}

export interface TableCellReference { row: number; col: number; rowSpan: number; colSpan: number }

function validColor(value: string): boolean { return /^#[0-9a-f]{6}$/i.test(value); }

export function tableCellFormatCommands(
  table: Target & { control: number },
  cells: TableCellReference[],
  block: CellBlockRange | undefined,
  value: TableCellFormatValues,
  currentTable: Pick<TableCellFormatValues, 'cellSpacing' | 'repeatHeader'>,
): Command[] {
  if (!cells.length || cells.length > 500) throw new Error('서식을 적용할 셀은 1~500개여야 합니다. F5 범위를 조정하세요.');
  if (!Number.isSafeInteger(value.cellSpacing) || value.cellSpacing < 0 || value.cellSpacing > 100_000) throw new Error('표 셀 간격은 0~100000 범위의 정수 HWP 단위여야 합니다.');
  if (!Number.isSafeInteger(value.padding) || value.padding < 0 || value.padding > 100_000) throw new Error('셀 안쪽 여백은 0~100000 범위의 정수 HWP 단위여야 합니다.');
  if (!Number.isSafeInteger(value.verticalAlign) || ![0, 1, 2].includes(value.verticalAlign)) throw new Error('셀 세로 정렬 값이 올바르지 않습니다.');
  if (!Number.isSafeInteger(value.borderType) || value.borderType < 0 || value.borderType > 32) throw new Error('셀 테두리 종류가 올바르지 않습니다.');
  if (!validColor(value.borderColor)) throw new Error('셀 테두리 색은 6자리 HEX 색상이어야 합니다.');
  if (value.fillMode !== 'keep' && value.fillMode !== 'none' && value.fillMode !== 'solid' && value.fillMode !== 'pattern') throw new Error('배경 채우기 방식을 다시 선택하세요.');
  if (value.fillMode === 'solid' && !validColor(value.fillColor)) throw new Error('셀 배경색은 6자리 HEX 색상이어야 합니다.');
  if (value.fillMode === 'pattern' && (!validColor(value.patternColor) || !Number.isSafeInteger(value.patternType) || value.patternType < 0 || value.patternType > 64)) {
    throw new Error('무늬 색상은 6자리 HEX, 무늬 종류는 0~64 정수여야 합니다.');
  }
  if (typeof value.isHeader !== 'boolean' || typeof value.repeatHeader !== 'boolean') throw new Error('머리글 설정이 올바르지 않습니다.');
  if (value.borderMode !== 'each' && value.borderMode !== 'outside') throw new Error('테두리 적용 방식을 다시 선택하세요.');
  for (const cell of cells) {
    if (![cell.row, cell.col, cell.rowSpan, cell.colSpan].every(Number.isSafeInteger)
      || cell.row < 0 || cell.col < 0 || cell.rowSpan < 1 || cell.colSpan < 1) throw new Error('표 셀 주소가 올바르지 않습니다.');
  }

  const tablePropertiesChanged = value.cellSpacing !== currentTable.cellSpacing || value.repeatHeader !== currentTable.repeatHeader;
  if (tablePropertiesChanged && cells.length >= 500) throw new Error('표 전체 설정을 바꾸면서 셀 서식을 적용하려면 선택 셀을 499개 이하로 줄이세요.');
  const commands: Command[] = tablePropertiesChanged ? [{ type: 'setTableProperties', table,
    properties: { cellSpacing: value.cellSpacing, repeatHeader: value.repeatHeader } }] : [];
  const border = (visible: boolean): NonNullable<CellProperties['borderTop']> => visible && value.borderType > 0
    ? { type: value.borderType, width: 1, color: value.borderColor }
    : { type: 0 };
  for (const cell of cells) {
    const edges = cellBlockBorderEdges(cell, block, value.borderMode === 'each');
    const properties: CellProperties = {
      ...(value.fillMode === 'none' ? { fillType: 'none' as const }
        : value.fillMode === 'solid' ? { fillType: 'solid' as const, fillColor: value.fillColor }
          : value.fillMode === 'pattern' ? { fillType: 'pattern' as const, patternColor: value.patternColor, patternType: value.patternType }
            : {}),
      isHeader: value.isHeader, verticalAlign: value.verticalAlign,
      paddingLeft: value.padding, paddingRight: value.padding, paddingTop: value.padding, paddingBottom: value.padding,
      borderTop: border(edges.top), borderBottom: border(edges.bottom), borderLeft: border(edges.left), borderRight: border(edges.right),
    };
    commands.push({ type: 'setCellProperties', table, row: cell.row, col: cell.col, properties });
  }
  if (commands.length > 500) throw new Error('한 트랜잭션은 500개 명령까지 적용할 수 있습니다.');
  return commands;
}

// Field definitions and value→command conversion for the page/section dialogs. Pure so the mapping is unit-tested.
import type { ColumnSettingsProperties, Command, Json, PageBorderFillProperties, PageHideEntry, SectionDefinitionProperties, Target } from '../../api';
import { hwpUnitsToMillimeters, millimetersToHwpUnits } from '../../paragraph-format';
import type { FormField, FormValues } from './form-values';

type Record_ = Record<string, Json> | undefined;
const mm = (units: unknown, fallback: number): number => typeof units === 'number' && Number.isFinite(units) ? Math.round(hwpUnitsToMillimeters(units) * 100) / 100 : fallback;
const num = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const bool = (value: unknown): boolean => value === true;
/** Keeps only the properties whose converted value differs from the one converted from the dialog's initial values. */
export function changedProperties<T extends object>(next: T, base: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) if (JSON.stringify(next[key]) !== JSON.stringify(base[key])) result[key] = next[key];
  return result;
}

export const COLUMN_TYPES = [['normal', '일반 다단'], ['distribute', '배분 다단'], ['parallel', '평행 다단']] as const;
export function columnFields(current: Record_): FormField[] {
  const type = ['normal', 'distribute', 'parallel'][num(current?.columnType, 0)] ?? 'normal';
  return [
    { key: 'count', label: '단 개수', kind: 'number', value: Math.max(1, num(current?.columnCount, 1)), min: 1, max: 8, integer: true },
    { key: 'type', label: '종류', kind: 'select', value: type, options: COLUMN_TYPES },
    { key: 'sameWidth', label: '단 너비를 같게', kind: 'checkbox', value: current?.sameWidth !== false },
    { key: 'spacing', label: '단 사이 간격', kind: 'number', value: mm(current?.spacing, 8), min: 0, max: 115, unit: 'mm' },
  ];
}
const columnProperties = (values: FormValues): ColumnSettingsProperties => ({
  count: values.count as number, type: values.type as 'normal' | 'distribute' | 'parallel', sameWidth: values.sameWidth as boolean, spacing: millimetersToHwpUnits(values.spacing as number),
});
/** Returns undefined when nothing changed. */
export function columnCommand(section: number, values: FormValues, initial: FormValues): Command | undefined {
  const properties = changedProperties(columnProperties(values), columnProperties(initial));
  return Object.keys(properties).length ? { type: 'setColumnSettings', section, properties } : undefined;
}

export const BORDER_LINE_TYPES = [['1', '실선'], ['2', '파선'], ['3', '점선'], ['4', '쇄선'], ['5', '이점 쇄선'], ['6', '긴 파선'], ['8', '이중선'], ['9', '얇고 굵은 이중선'], ['10', '굵고 얇은 이중선'], ['11', '삼중선']] as const;
export const BORDER_LINE_WIDTHS = ['0.1', '0.12', '0.15', '0.2', '0.25', '0.3', '0.4', '0.5', '0.6', '0.7', '1', '1.5', '2', '3', '4', '5'].map((label, index) => [String(index), `${label} mm`] as const);
export function pageBorderFields(current: Record_): FormField[] {
  const side = current?.borderLeft as { type?: number; width?: number; color?: string } | undefined;
  const hasBorder = ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'].some(key => num((current?.[key] as { type?: number } | undefined)?.type, 0) > 0);
  const lineType = String(side && num(side.type, 0) > 0 ? side.type : 1);
  const enabledBorder = (values: FormValues): boolean => values.useBorder === true;
  return [
    { key: 'basis', label: '위치 기준', kind: 'select', value: current?.basis === 'paper' ? 'paper' : 'page', options: [['page', '본문(쪽) 기준'], ['paper', '용지 기준']] },
    { key: 'spacingLeft', label: '왼쪽 간격', kind: 'number', value: mm(current?.spacingLeft, 5), min: 0, max: 100, unit: 'mm' },
    { key: 'spacingRight', label: '오른쪽 간격', kind: 'number', value: mm(current?.spacingRight, 5), min: 0, max: 100, unit: 'mm' },
    { key: 'spacingTop', label: '위쪽 간격', kind: 'number', value: mm(current?.spacingTop, 5), min: 0, max: 100, unit: 'mm' },
    { key: 'spacingBottom', label: '아래쪽 간격', kind: 'number', value: mm(current?.spacingBottom, 5), min: 0, max: 100, unit: 'mm' },
    { key: 'useBorder', label: '테두리 사용', kind: 'checkbox', value: hasBorder },
    { key: 'lineType', label: '선 종류', kind: 'select', value: BORDER_LINE_TYPES.some(([value]) => value === lineType) ? lineType : '1', options: BORDER_LINE_TYPES, enabledWhen: enabledBorder },
    { key: 'lineWidth', label: '선 굵기', kind: 'select', value: String(Math.min(15, Math.max(0, num(side?.width, 1)))), options: BORDER_LINE_WIDTHS, enabledWhen: enabledBorder },
    { key: 'lineColor', label: '선 색', kind: 'color', value: typeof side?.color === 'string' && /^#[0-9a-f]{6}$/i.test(side.color) ? side.color : '#000000', enabledWhen: enabledBorder },
    { key: 'useFill', label: '배경 색 사용', kind: 'checkbox', value: current?.fillType === 'solid' },
    { key: 'fillColor', label: '배경 색', kind: 'color', value: typeof current?.fillColor === 'string' && /^#[0-9a-f]{6}$/i.test(current.fillColor) ? current.fillColor : '#ffffff', enabledWhen: values => values.useFill === true },
    { key: 'fillArea', label: '배경 영역', kind: 'select', value: typeof current?.fillArea === 'string' && ['paper', 'page', 'border'].includes(current.fillArea) ? current.fillArea : 'paper', options: [['paper', '용지 전체'], ['page', '본문 영역'], ['border', '테두리 안쪽']], enabledWhen: values => values.useFill === true },
  ];
}
const pageBorderProperties = (values: FormValues): PageBorderFillProperties => {
  const line = values.useBorder === true
    ? { type: Number(values.lineType), width: Number(values.lineWidth), color: values.lineColor as string }
    : { type: 0, width: 0, color: '#000000' };
  return {
    basis: values.basis as 'paper' | 'page',
    spacingLeft: millimetersToHwpUnits(values.spacingLeft as number), spacingRight: millimetersToHwpUnits(values.spacingRight as number),
    spacingTop: millimetersToHwpUnits(values.spacingTop as number), spacingBottom: millimetersToHwpUnits(values.spacingBottom as number),
    borderLeft: { ...line }, borderRight: { ...line }, borderTop: { ...line }, borderBottom: { ...line },
    fillType: values.useFill === true ? 'solid' : 'none', fillArea: values.fillArea as 'paper' | 'page' | 'border',
    ...(values.useFill === true ? { fillColor: values.fillColor as string } : {}),
  };
};
export function pageBorderCommand(section: number, values: FormValues, initial: FormValues): Command | undefined {
  const properties = changedProperties(pageBorderProperties(values), pageBorderProperties(initial));
  return Object.keys(properties).length ? { type: 'setPageBorderFill', section, properties } : undefined;
}

const SECTION_PAGE_NUMBER_MODES = [['continue', '앞 구역에 이어서'], ['odd', '홀수 쪽부터'], ['even', '짝수 쪽부터'], ['custom', '사용자 지정']] as const;
export function sectionFields(current: Record_): FormField[] {
  const pageNum = num(current?.pageNum, 0), pageNumType = num(current?.pageNumType, 0);
  const mode = pageNum > 0 ? 'custom' : pageNumType === 1 ? 'odd' : pageNumType === 2 ? 'even' : 'continue';
  return [
    { key: 'pageNumberMode', label: '시작 쪽 번호', kind: 'select', value: mode, options: SECTION_PAGE_NUMBER_MODES },
    { key: 'pageNumber', label: '시작 번호', kind: 'number', value: pageNum > 0 ? pageNum : 1, min: 1, max: 65535, integer: true, enabledWhen: values => values.pageNumberMode === 'custom' },
    { key: 'pictureNum', label: '그림 번호 시작 (0은 이어서)', kind: 'number', value: num(current?.pictureNum, 0), min: 0, max: 65535, integer: true },
    { key: 'tableNum', label: '표 번호 시작 (0은 이어서)', kind: 'number', value: num(current?.tableNum, 0), min: 0, max: 65535, integer: true },
    { key: 'equationNum', label: '수식 번호 시작 (0은 이어서)', kind: 'number', value: num(current?.equationNum, 0), min: 0, max: 65535, integer: true },
    { key: 'columnSpacing', label: '단 사이 간격', kind: 'number', value: mm(current?.columnSpacing, 8), min: 0, max: 350, unit: 'mm' },
    { key: 'defaultTabSpacing', label: '기본 탭 간격', kind: 'number', value: mm(current?.defaultTabSpacing, 28.22), min: 0, max: 350, unit: 'mm' },
    { key: 'hideHeader', label: '머리말 감추기', kind: 'checkbox', value: bool(current?.hideHeader) },
    { key: 'hideFooter', label: '꼬리말 감추기', kind: 'checkbox', value: bool(current?.hideFooter) },
    { key: 'hideMasterPage', label: '바탕쪽 감추기', kind: 'checkbox', value: bool(current?.hideMasterPage) },
    { key: 'hideBorder', label: '쪽 테두리 감추기', kind: 'checkbox', value: bool(current?.hideBorder) },
    { key: 'hideFill', label: '쪽 배경 감추기', kind: 'checkbox', value: bool(current?.hideFill) },
    { key: 'hideEmptyLine', label: '빈 줄 감추기', kind: 'checkbox', value: bool(current?.hideEmptyLine) },
    { key: 'scope', label: '적용 범위', kind: 'select', value: 'current', options: [['current', '현재 구역'], ['all', '모든 구역']] },
  ];
}
export function sectionProperties(values: FormValues): SectionDefinitionProperties {
  const mode = values.pageNumberMode as string;
  return {
    pageNum: mode === 'custom' ? values.pageNumber as number : 0, pageNumType: mode === 'odd' ? 1 : mode === 'even' ? 2 : 0,
    pictureNum: values.pictureNum as number, tableNum: values.tableNum as number, equationNum: values.equationNum as number,
    columnSpacing: millimetersToHwpUnits(values.columnSpacing as number), defaultTabSpacing: millimetersToHwpUnits(values.defaultTabSpacing as number),
    hideHeader: values.hideHeader as boolean, hideFooter: values.hideFooter as boolean, hideMasterPage: values.hideMasterPage as boolean,
    hideBorder: values.hideBorder as boolean, hideFill: values.hideFill as boolean, hideEmptyLine: values.hideEmptyLine as boolean,
  };
}
export function sectionCommands(currentSection: number, sectionCount: number, values: FormValues, initial: FormValues): Command[] {
  const properties = changedProperties(sectionProperties(values), sectionProperties(initial));
  if (!Object.keys(properties).length) return [];
  const sections = values.scope === 'all' ? Array.from({ length: sectionCount }, (_, index) => index) : [currentSection];
  return sections.map(section => ({ type: 'setSectionDefinition', section, properties }));
}

export function pageHideFields(entry: PageHideEntry | undefined): FormField[] {
  return [
    { key: 'hideHeader', label: '머리말 감추기', kind: 'checkbox', value: entry?.hideHeader ?? false },
    { key: 'hideFooter', label: '꼬리말 감추기', kind: 'checkbox', value: entry?.hideFooter ?? false },
    { key: 'hideMasterPage', label: '바탕쪽 감추기', kind: 'checkbox', value: entry?.hideMasterPage ?? false },
    { key: 'hideBorder', label: '쪽 테두리 감추기', kind: 'checkbox', value: entry?.hideBorder ?? false },
    { key: 'hideFill', label: '쪽 배경 감추기', kind: 'checkbox', value: entry?.hideFill ?? false },
    { key: 'hidePageNumber', label: '쪽 번호 감추기', kind: 'checkbox', value: entry?.hidePageNumber ?? false },
  ];
}
export function pageHideCommand(target: Target, values: FormValues): Command {
  // Always send the full set: the control is the only record of the choice and "all off" is a meaningful state.
  return { type: 'setPageHide', target, properties: {
    hideHeader: values.hideHeader as boolean, hideFooter: values.hideFooter as boolean, hideMasterPage: values.hideMasterPage as boolean,
    hideBorder: values.hideBorder as boolean, hideFill: values.hideFill as boolean, hidePageNumber: values.hidePageNumber as boolean,
  } };
}

export function newNumberFields(): FormField[] {
  return [{ key: 'number', label: '시작 번호', kind: 'number', value: 1, min: 1, max: 65535, integer: true }];
}
export function newNumberCommand(target: Target, offset: number, values: FormValues): Command {
  return { type: 'insertNewNumber', target, offset, number: values.number as number };
}

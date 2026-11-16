import { L } from '../../i18n/locale';
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

export const COLUMN_TYPES = [['normal', L({ ko: '일반 다단', en: "Standard columns" })], ['distribute', L({ ko: '배분 다단', en: "Balanced columns" })], ['parallel', L({ ko: '평행 다단', en: "Parallel columns" })]] as const;
export function columnFields(current: Record_): FormField[] {
  const type = ['normal', 'distribute', 'parallel'][num(current?.columnType, 0)] ?? 'normal';
  return [
    { key: 'count', label: L({ ko: '단 개수', en: "Column count" }), kind: 'number', value: Math.max(1, num(current?.columnCount, 1)), min: 1, max: 8, integer: true },
    { key: 'type', label: L({ ko: '종류', en: "Type" }), kind: 'select', value: type, options: COLUMN_TYPES },
    { key: 'sameWidth', label: L({ ko: '단 너비를 같게', en: "Equal column widths" }), kind: 'checkbox', value: current?.sameWidth !== false },
    { key: 'spacing', label: L({ ko: '단 사이 간격', en: "Column gap" }), kind: 'number', value: mm(current?.spacing, 8), min: 0, max: 115, unit: 'mm' },
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

export const BORDER_LINE_TYPES = [['1', L({ ko: '실선', en: "Solid line" })], ['2', L({ ko: '파선', en: "Dashed" })], ['3', L({ ko: '점선', en: "Dotted" })], ['4', L({ ko: '쇄선', en: "Dash-dot" })], ['5', L({ ko: '이점 쇄선', en: "Dash-dot-dot" })], ['6', L({ ko: '긴 파선', en: "Long dash" })], ['8', L({ ko: '이중선', en: "Double line" })], ['9', L({ ko: '얇고 굵은 이중선', en: "Thin-thick double line" })], ['10', L({ ko: '굵고 얇은 이중선', en: "Thick-thin double line" })], ['11', L({ ko: '삼중선', en: "Triple line" })]] as const;
export const BORDER_LINE_WIDTHS = ['0.1', '0.12', '0.15', '0.2', '0.25', '0.3', '0.4', '0.5', '0.6', '0.7', '1', '1.5', '2', '3', '4', '5'].map((label, index) => [String(index), `${label} mm`] as const);
export function pageBorderFields(current: Record_): FormField[] {
  const side = current?.borderLeft as { type?: number; width?: number; color?: string } | undefined;
  const hasBorder = ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'].some(key => num((current?.[key] as { type?: number } | undefined)?.type, 0) > 0);
  const lineType = String(side && num(side.type, 0) > 0 ? side.type : 1);
  const enabledBorder = (values: FormValues): boolean => values.useBorder === true;
  return [
    { key: 'basis', label: L({ ko: '위치 기준', en: "Position reference" }), kind: 'select', value: current?.basis === 'paper' ? 'paper' : 'page', options: [['page', L({ ko: '본문(쪽) 기준', en: "Body (page)" })], ['paper', L({ ko: '용지 기준', en: "Paper" })]] },
    { key: 'spacingLeft', label: L({ ko: '왼쪽 간격', en: "Left spacing" }), kind: 'number', value: mm(current?.spacingLeft, 5), min: 0, max: 100, unit: 'mm' },
    { key: 'spacingRight', label: L({ ko: '오른쪽 간격', en: "Right spacing" }), kind: 'number', value: mm(current?.spacingRight, 5), min: 0, max: 100, unit: 'mm' },
    { key: 'spacingTop', label: L({ ko: '위쪽 간격', en: "Top spacing" }), kind: 'number', value: mm(current?.spacingTop, 5), min: 0, max: 100, unit: 'mm' },
    { key: 'spacingBottom', label: L({ ko: '아래쪽 간격', en: "Bottom spacing" }), kind: 'number', value: mm(current?.spacingBottom, 5), min: 0, max: 100, unit: 'mm' },
    { key: 'useBorder', label: L({ ko: '테두리 사용', en: "Use border" }), kind: 'checkbox', value: hasBorder },
    { key: 'lineType', label: L({ ko: '선 종류', en: "Line type" }), kind: 'select', value: BORDER_LINE_TYPES.some(([value]) => value === lineType) ? lineType : '1', options: BORDER_LINE_TYPES, enabledWhen: enabledBorder },
    { key: 'lineWidth', label: L({ ko: '선 굵기', en: "Line thickness" }), kind: 'select', value: String(Math.min(15, Math.max(0, num(side?.width, 1)))), options: BORDER_LINE_WIDTHS, enabledWhen: enabledBorder },
    { key: 'lineColor', label: L({ ko: '선 색', en: "Line color" }), kind: 'color', value: typeof side?.color === 'string' && /^#[0-9a-f]{6}$/i.test(side.color) ? side.color : '#000000', enabledWhen: enabledBorder },
    { key: 'useFill', label: L({ ko: '배경 색 사용', en: "Use background color" }), kind: 'checkbox', value: current?.fillType === 'solid' },
    { key: 'fillColor', label: L({ ko: '배경 색', en: "Background color" }), kind: 'color', value: typeof current?.fillColor === 'string' && /^#[0-9a-f]{6}$/i.test(current.fillColor) ? current.fillColor : '#ffffff', enabledWhen: values => values.useFill === true },
    { key: 'fillArea', label: L({ ko: '배경 영역', en: "Background area" }), kind: 'select', value: typeof current?.fillArea === 'string' && ['paper', 'page', 'border'].includes(current.fillArea) ? current.fillArea : 'paper', options: [['paper', L({ ko: '용지 전체', en: "Entire paper" })], ['page', L({ ko: '본문 영역', en: "Body area" })], ['border', L({ ko: '테두리 안쪽', en: "Inside border" })]], enabledWhen: values => values.useFill === true },
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

const SECTION_PAGE_NUMBER_MODES = [['continue', L({ ko: '앞 구역에 이어서', en: "Continue from previous section" })], ['odd', L({ ko: '홀수 쪽부터', en: "Start on odd page" })], ['even', L({ ko: '짝수 쪽부터', en: "Start on even page" })], ['custom', L({ ko: '사용자 지정', en: "Custom" })]] as const;
export function sectionFields(current: Record_): FormField[] {
  const pageNum = num(current?.pageNum, 0), pageNumType = num(current?.pageNumType, 0);
  const mode = pageNum > 0 ? 'custom' : pageNumType === 1 ? 'odd' : pageNumType === 2 ? 'even' : 'continue';
  return [
    { key: 'pageNumberMode', label: L({ ko: '시작 쪽 번호', en: "Starting page number" }), kind: 'select', value: mode, options: SECTION_PAGE_NUMBER_MODES },
    { key: 'pageNumber', label: L({ ko: '시작 번호', en: "Start number" }), kind: 'number', value: pageNum > 0 ? pageNum : 1, min: 1, max: 65535, integer: true, enabledWhen: values => values.pageNumberMode === 'custom' },
    { key: 'pictureNum', label: L({ ko: '그림 번호 시작 (0은 이어서)', en: "Picture start number (0 continues)" }), kind: 'number', value: num(current?.pictureNum, 0), min: 0, max: 65535, integer: true },
    { key: 'tableNum', label: L({ ko: '표 번호 시작 (0은 이어서)', en: "Table start number (0 continues)" }), kind: 'number', value: num(current?.tableNum, 0), min: 0, max: 65535, integer: true },
    { key: 'equationNum', label: L({ ko: '수식 번호 시작 (0은 이어서)', en: "Equation start number (0 continues)" }), kind: 'number', value: num(current?.equationNum, 0), min: 0, max: 65535, integer: true },
    { key: 'columnSpacing', label: L({ ko: '단 사이 간격', en: "Column gap" }), kind: 'number', value: mm(current?.columnSpacing, 8), min: 0, max: 350, unit: 'mm' },
    { key: 'defaultTabSpacing', label: L({ ko: '기본 탭 간격', en: "Default tab spacing" }), kind: 'number', value: mm(current?.defaultTabSpacing, 28.22), min: 0, max: 350, unit: 'mm' },
    { key: 'hideHeader', label: L({ ko: '머리말 감추기', en: "Hide header" }), kind: 'checkbox', value: bool(current?.hideHeader) },
    { key: 'hideFooter', label: L({ ko: '꼬리말 감추기', en: "Hide footer" }), kind: 'checkbox', value: bool(current?.hideFooter) },
    { key: 'hideMasterPage', label: L({ ko: '바탕쪽 감추기', en: "Hide master page" }), kind: 'checkbox', value: bool(current?.hideMasterPage) },
    { key: 'hideBorder', label: L({ ko: '쪽 테두리 감추기', en: "Hide page border" }), kind: 'checkbox', value: bool(current?.hideBorder) },
    { key: 'hideFill', label: L({ ko: '쪽 배경 감추기', en: "Hide page background" }), kind: 'checkbox', value: bool(current?.hideFill) },
    { key: 'hideEmptyLine', label: L({ ko: '빈 줄 감추기', en: "Hide empty lines" }), kind: 'checkbox', value: bool(current?.hideEmptyLine) },
    { key: 'scope', label: L({ ko: '적용 범위', en: "Scope" }), kind: 'select', value: 'current', options: [['current', L({ ko: '현재 구역', en: "Current section" })], ['all', L({ ko: '모든 구역', en: "All sections" })]] },
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
    { key: 'hideHeader', label: L({ ko: '머리말 감추기', en: "Hide header" }), kind: 'checkbox', value: entry?.hideHeader ?? false },
    { key: 'hideFooter', label: L({ ko: '꼬리말 감추기', en: "Hide footer" }), kind: 'checkbox', value: entry?.hideFooter ?? false },
    { key: 'hideMasterPage', label: L({ ko: '바탕쪽 감추기', en: "Hide master page" }), kind: 'checkbox', value: entry?.hideMasterPage ?? false },
    { key: 'hideBorder', label: L({ ko: '쪽 테두리 감추기', en: "Hide page border" }), kind: 'checkbox', value: entry?.hideBorder ?? false },
    { key: 'hideFill', label: L({ ko: '쪽 배경 감추기', en: "Hide page background" }), kind: 'checkbox', value: entry?.hideFill ?? false },
    { key: 'hidePageNumber', label: L({ ko: '쪽 번호 감추기', en: "Hide page number" }), kind: 'checkbox', value: entry?.hidePageNumber ?? false },
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
  return [{ key: 'number', label: L({ ko: '시작 번호', en: "Start number" }), kind: 'number', value: 1, min: 1, max: 65535, integer: true }];
}
export function newNumberCommand(target: Target, offset: number, values: FormValues): Command {
  return { type: 'insertNewNumber', target, offset, number: values.number as number };
}

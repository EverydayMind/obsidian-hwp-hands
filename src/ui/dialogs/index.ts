import { LT, L } from '../../i18n/locale';
import { FuzzySuggestModal, Modal, Notice, TFile, type App } from 'obsidian';
import type HwpHandsPlugin from '../../main';
import { inputDraftTargetLabel, type InputDraftEntry } from '../../input-drafts';
import { textChangeRange } from '../../text-comparison';
import { CHARACTER_TABLE_CATEGORIES, filterCharacterTable } from '../../character-table';
import { saveAsDestination, type HwpDocumentFormat } from '../../save-as';
import type { CharacterFormatProperties, CharacterProperties, EndnoteShapeProperties, HeaderFooterStory, PageSettingsProperties, ParagraphProperties, ParagraphAlignment, StyleDefinition } from '../../api';
import { hwpUnitsToMillimeters, millimetersToDoubledHwpUnits, millimetersToHwpUnits, pixelsToMillimeters, pixelsToPoints, pointsToHwpUnits } from '../../paragraph-format';
import type { TableCellFormatValues } from '../../table-cell-format';

export abstract class FocusReturnModal extends Modal {
  private readonly returnFocus?: HTMLElement;
  constructor(app: App) {
    super(app);
    const ownerDocument = app.workspace.activeLeaf?.view.containerEl.ownerDocument ?? app.workspace.containerEl.ownerDocument;
    const active = ownerDocument.activeElement;
    if (active && active !== ownerDocument.body && typeof (active as HTMLElement).focus === 'function') this.returnFocus = active as HTMLElement;
  }
  protected restoreFocus(): void {
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
  }
}

export class HwpDocumentPickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly onChoose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder(L({ ko: '문서 이름 또는 볼트 경로 검색', en: "Search document name or Vault path" }));
    this.emptyStateText = L({ ko: '열 수 있는 HWP/HWPX 문서가 없습니다.', en: "No HWP/HWPX documents to open." });
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter(file => /^(hwp|hwpx)$/i.test(file.extension));
  }
  getItemText(file: TFile): string { return file.path; }
  renderSuggestion(match: { item: TFile }, element: HTMLElement): void {
    element.createDiv({ text: match.item.basename });
    element.createEl('small', { text: match.item.path });
  }
  onChooseItem(file: TFile): void { this.onChoose(file); }
}

export class PathModal extends FocusReturnModal {
  constructor(app: App, private readonly label: string, private readonly initial: string, private readonly action: (path: string) => Promise<void>, private readonly onClosed?: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: this.label });
    const input = this.contentEl.createEl('input', { cls: 'hwp-path-input', type: 'text', value: this.initial });
    const submit = this.contentEl.createEl('button', { text: L({ ko: '확인', en: "Confirm" }), cls: 'mod-cta' });
    const run = async () => { submit.disabled = true; try { await this.action(input.value.trim().replaceAll('\\', '/')); this.close(); } catch (error) { new Notice(String(error), 8000); submit.disabled = false; } };
    submit.addEventListener('click', () => void run()); input.addEventListener('keydown', e => { if (e.key === 'Enter') void run(); }); input.focus(); input.select();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); this.onClosed?.(); }
}
export class SaveAsModal extends FocusReturnModal {
  constructor(app: App, private readonly initialPath: string, private readonly initialFormat: HwpDocumentFormat,
    private readonly action: (destination: string, format: HwpDocumentFormat) => Promise<void>, private readonly onClosed?: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: L({ ko: '다른 이름으로 저장', en: "Save As" }) });
    const formatRow = this.contentEl.createDiv({ cls: 'hwp-save-as-format' });
    formatRow.createEl('label', { text: L({ ko: '파일 형식', en: "File format" }) });
    const format = formatRow.createEl('select', { attr: { 'aria-label': L({ ko: '사본 파일 형식', en: "Copy file format" }) } });
    for (const value of ['hwp', 'hwpx'] as const) format.createEl('option', { value, text: value.toUpperCase() });
    format.value = this.initialFormat;
    const path = this.contentEl.createEl('input', { cls: 'hwp-path-input', type: 'text', value: this.initialPath,
      attr: { 'aria-label': L({ ko: '사본 Vault 경로', en: "Copy Vault path" }), placeholder: L({ ko: 'Vault 상대 경로', en: "Vault-relative path" }) } });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const submit = this.contentEl.createEl('button', { text: L({ ko: '검증 후 사본 저장', en: "Validate and save copy" }), cls: 'mod-cta' });
    const run = async (): Promise<void> => {
      let destination: string;
      try { destination = saveAsDestination(path.value, format.value as HwpDocumentFormat); }
      catch (error) { status.setText(String(error)); path.focus(); return; }
      submit.disabled = true; status.setText(LT({ ko: () => `${format.value.toUpperCase()}로 저장하고 재파싱 보존 검사를 확인하는 중…`, en: () => `Saving as ${format.value.toUpperCase()} and checking reparsed preservation…` }));
      try { await this.action(destination, format.value as HwpDocumentFormat); this.close(); }
      catch (error) { status.setText(LT({ ko: () => `저장하지 않았습니다: ${String(error)}`, en: () => `Not saved: ${String(error)}` })); new Notice(String(error), 8000); submit.disabled = false; }
    };
    submit.addEventListener('click', () => void run());
    path.addEventListener('keydown', event => { if (event.key === 'Enter') void run(); });
    path.focus(); path.select();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); this.onClosed?.(); }
}

export class PrintPagesModal extends FocusReturnModal {
  private cancelled = false;
  constructor(app: App, private readonly pageCount: number,
    private readonly action: (firstPage: number, lastPage: number, progress: (completed: number, total: number) => void, isCancelled: () => boolean) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('hwp-print-dialog');
    this.contentEl.createEl('h2', { text: L({ ko: '인쇄 / PDF로 저장', en: "Print / Save as PDF" }) });
    this.contentEl.createEl('p', { text: LT({ ko: () => `출력할 쪽 범위를 입력하세요. 전체 ${this.pageCount}쪽입니다. PDF 저장은 인쇄 대화상자에서 선택할 수 있습니다.`, en: () => `Enter the page range to print. Total: ${this.pageCount} pages. Save as PDF is available in the print dialog.` }) });
    const range = this.contentEl.createDiv({ cls: 'hwp-print-range' });
    const first = range.createEl('input', { type: 'number', value: '1', attr: { min: '1', max: String(this.pageCount), 'aria-label': L({ ko: '시작 쪽', en: "First page" }) } });
    range.createEl('span', { text: '–' });
    const last = range.createEl('input', { type: 'number', value: String(this.pageCount), attr: { min: '1', max: String(this.pageCount), 'aria-label': L({ ko: '끝 쪽', en: "Last page" }) } });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    const cancel = buttons.createEl('button', { text: L({ ko: '취소', en: "cancel" }) }); cancel.addEventListener('click', () => this.close());
    const print = buttons.createEl('button', { text: L({ ko: '인쇄 / PDF 저장', en: "Print / Save PDF" }), cls: 'mod-cta' });
    print.addEventListener('click', () => {
      const from = Number(first.value), to = Number(last.value);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > this.pageCount) {
        status.setText(LT({ ko: () => `쪽 범위는 1–${this.pageCount} 사이에서 시작 쪽이 끝 쪽보다 크지 않게 입력하세요.`, en: () => `Enter pages within 1–${this.pageCount}, with first page no greater than last page.` })); first.focus(); return;
      }
      this.cancelled = false; print.disabled = true; first.disabled = true; last.disabled = true;
      status.setText(L({ ko: '쪽 출력을 준비하는 중…', en: "Preparing pages for printing…" }));
      void this.action(from - 1, to - 1, (completed, total) => status.setText(LT({ ko: () => `쪽을 준비하는 중… ${completed}/${total}`, en: () => `Preparing pages… ${completed}/${total}` })), () => this.cancelled)
        .then(() => { if (!this.cancelled) this.close(); })
        .catch(error => { status.setText(LT({ ko: () => `인쇄를 준비하지 못했습니다: ${String(error)}`, en: () => `Could not prepare printing: ${String(error)}` })); print.disabled = false; first.disabled = false; last.disabled = false; });
    });
    first.focus();
  }
  onClose(): void { this.cancelled = true; this.contentEl.empty(); this.restoreFocus(); }
}

export class TableGridModal extends FocusReturnModal {
  constructor(app: App, private readonly action: (rows: number, columns: number) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('hwp-table-grid-dialog');
    this.contentEl.createEl('h2', { text: L({ ko: '표 삽입', en: "Insert table" }) });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const grid = this.contentEl.createDiv({ cls: 'hwp-table-grid', attr: { role: 'group', 'aria-label': L({ ko: '표 크기 선택', en: "Select table size" }) } });
    const buttons: HTMLButtonElement[][] = [];
    let busy = false;
    const highlight = (rows: number, columns: number): void => {
      status.setText(LT({ ko: () => `${rows}행 × ${columns}열`, en: () => `${rows} rows × ${columns} columns` }));
      buttons.forEach((line, row) => line.forEach((button, column) => {
        const active = row < rows && column < columns;
        button.toggleClass('is-active', active); button.setAttribute('aria-pressed', String(active));
      }));
    };
    for (let row = 1; row <= 10; row++) {
      const line: HTMLButtonElement[] = [];
      for (let column = 1; column <= 10; column++) {
        const rows = row, columns = column;
        const button = grid.createEl('button', { text: ' ', attr: { type: 'button', 'aria-label': LT({ ko: () => `${rows}행 ${columns}열 표 삽입`, en: () => `Insert ${rows}-row × ${columns}-column table` }), 'aria-pressed': 'false' } });
        button.addEventListener('pointerenter', () => highlight(rows, columns));
        button.addEventListener('focus', () => highlight(rows, columns));
        button.addEventListener('keydown', event => {
          const nextRow = event.key === 'ArrowDown' ? Math.min(10, rows + 1) : event.key === 'ArrowUp' ? Math.max(1, rows - 1) : rows;
          const nextColumn = event.key === 'ArrowRight' ? Math.min(10, columns + 1) : event.key === 'ArrowLeft' ? Math.max(1, columns - 1) : columns;
          if (nextRow !== rows || nextColumn !== columns) { event.preventDefault(); buttons[nextRow - 1]?.[nextColumn - 1]?.focus(); }
          else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); button.click(); }
        });
        button.addEventListener('click', () => {
          if (busy) return;
          busy = true; buttons.flat().forEach(item => { item.disabled = true; }); status.setText(LT({ ko: () => `${rows}행 × ${columns}열 표를 만드는 중…`, en: () => `Creating ${rows}-row × ${columns}-column table…` }));
          void this.action(rows, columns).then(() => this.close()).catch(error => {
            status.setText(LT({ ko: () => `표를 만들지 못했습니다: ${String(error)}`, en: () => `Could not create table: ${String(error)}` })); busy = false; buttons.flat().forEach(item => { item.disabled = false; });
          });
        });
        line.push(button);
      }
      buttons.push(line);
    }
    highlight(2, 2); buttons[1]?.[1]?.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class SplitCellModal extends FocusReturnModal {
  constructor(app: App, private readonly rowsDefault: number, private readonly columnsDefault: number,
    private readonly action: (rows: number, columns: number, equalRowHeight: boolean) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: L({ ko: '셀 나누기', en: "Split cells" }) });
    const rows = this.contentEl.createEl('input', { type: 'number', value: String(this.rowsDefault), attr: { min: '1', max: '100', 'aria-label': L({ ko: '나눌 행 수', en: "Number of rows to split into" }) } });
    const columns = this.contentEl.createEl('input', { type: 'number', value: String(this.columnsDefault), attr: { min: '1', max: '100', 'aria-label': L({ ko: '나눌 열 수', en: "Number of columns to split into" }) } });
    this.contentEl.createEl('p', { text: L({ ko: '2~1000개 셀로 나눕니다.', en: "Splits into 2–1000 cells." }) });
    const equalRow = this.contentEl.createEl('label', { cls: 'hwp-split-cell-equal-row' });
    const equalRowHeight = equalRow.createEl('input', { type: 'checkbox' }); equalRowHeight.checked = true;
    equalRow.appendText(L({ ko: '행 높이를 같게', en: "Equalize row heights" }));
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const submit = this.contentEl.createEl('button', { text: L({ ko: '나누기', en: "Split" }), cls: 'mod-cta' });
    const run = async (): Promise<void> => {
      const rowCount = Number(rows.value), columnCount = Number(columns.value);
      if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 100
        || !Number.isSafeInteger(columnCount) || columnCount < 1 || columnCount > 100 || rowCount * columnCount < 2 || rowCount * columnCount > 1000) {
        status.setText(L({ ko: '각 방향은 1~100, 전체 셀 수는 2~1000 범위여야 합니다.', en: "Each dimension must be 1–100; total cell count must be 2–1000." })); return;
      }
      submit.disabled = true; rows.disabled = true; columns.disabled = true; equalRowHeight.disabled = true;
      status.setText(LT({ ko: () => `${rowCount}행 × ${columnCount}열로 나누는 중…`, en: () => `Splitting into ${rowCount} rows × ${columnCount} columns…` }));
      try { await this.action(rowCount, columnCount, equalRowHeight.checked); this.close(); }
      catch (error) { status.setText(LT({ ko: () => `셀을 나누지 못했습니다: ${String(error)}`, en: () => `Could not split cells: ${String(error)}` })); submit.disabled = false; rows.disabled = false; columns.disabled = false; equalRowHeight.disabled = false; }
    };
    submit.addEventListener('click', () => void run());
    for (const input of [rows, columns]) input.addEventListener('keydown', event => { if (event.key === 'Enter') void run(); });
    rows.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class TableCellFormatModal extends FocusReturnModal {
  constructor(app: App, private readonly initial: TableCellFormatValues,
    private readonly action: (value: TableCellFormatValues) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('hwp-table-format-dialog');
    this.contentEl.createEl('h2', { text: L({ ko: '표 / 셀 속성', en: "Table / Cell properties" }) });
    this.contentEl.createEl('p', { text: L({ ko: '표 설정은 표 전체에, 셀 서식은 현재 셀 또는 F5로 선택한 범위에 적용합니다.', en: "Table settings apply to the entire table; cell formatting applies to the current cell or F5 selection." }) });
    const table = this.contentEl.createEl('fieldset');
    table.createEl('legend', { text: L({ ko: '표 전체', en: "Entire table" }) });
    const spacingRow = table.createEl('label'); spacingRow.appendText(L({ ko: '셀 간격 (HWP 단위) ', en: "Cell spacing (HWP units) " }));
    const cellSpacing = spacingRow.createEl('input', { type: 'number', value: String(this.initial.cellSpacing), attr: { min: '0', max: '100000', 'aria-label': L({ ko: '표 셀 간격 (HWP 단위)', en: "Table cell spacing (HWP units)" }) } });
    const repeatRow = table.createEl('label');
    const repeatHeader = repeatRow.createEl('input', { type: 'checkbox', attr: { 'aria-label': L({ ko: '쪽마다 머리글 행 반복', en: "Repeat header row on each page" }) } }); repeatHeader.checked = this.initial.repeatHeader;
    repeatRow.appendText(L({ ko: '쪽마다 머리글 행 반복', en: "Repeat header row on each page" }));

    const cell = this.contentEl.createEl('fieldset');
    cell.createEl('legend', { text: L({ ko: '선택 셀 서식', en: "Selected cell formatting" }) });
    const fillModeRow = cell.createEl('label'); fillModeRow.appendText(L({ ko: '배경 채우기 ', en: "Background fill " }));
    const fillMode = fillModeRow.createEl('select', { attr: { 'aria-label': L({ ko: '셀 배경 채우기', en: "Cell background fill" }) } });
    for (const [value, label] of [['keep', L({ ko: '기존 채우기 유지', en: "Keep existing fill" })], ['none', L({ ko: '없음', en: "None" })], ['solid', L({ ko: '단색', en: "Solid" })], ['pattern', L({ ko: '무늬', en: "Pattern" })]]) fillMode.createEl('option', { value, text: label });
    fillMode.value = this.initial.fillMode;
    const fillRow = cell.createEl('label'); fillRow.appendText(L({ ko: '배경색 ', en: "Background color " }));
    const fillColor = fillRow.createEl('input', { type: 'color', value: this.initial.fillColor, attr: { 'aria-label': L({ ko: '셀 채우기 색상', en: "Cell fill color" }) } });
    const patternColorRow = cell.createEl('label'); patternColorRow.appendText(L({ ko: '무늬 색 ', en: "Pattern color " }));
    const patternColor = patternColorRow.createEl('input', { type: 'color', value: this.initial.patternColor, attr: { 'aria-label': L({ ko: '셀 무늬 색상', en: "Cell pattern color" }) } });
    const patternTypeRow = cell.createEl('label'); patternTypeRow.appendText(L({ ko: '무늬 종류 ', en: "Pattern type " }));
    const patternType = patternTypeRow.createEl('input', { type: 'number', value: String(this.initial.patternType), attr: { min: '0', max: '64', 'aria-label': L({ ko: '셀 무늬 종류', en: "Cell pattern type" }) } });
    const updateFillControls = (): void => {
      fillColor.disabled = fillMode.value !== 'solid';
      patternColor.disabled = fillMode.value !== 'pattern'; patternType.disabled = fillMode.value !== 'pattern';
    };
    fillMode.addEventListener('change', updateFillControls); updateFillControls();
    const headerRow = cell.createEl('label');
    const isHeader = headerRow.createEl('input', { type: 'checkbox', attr: { 'aria-label': L({ ko: '머리글 셀', en: "Header cell" }) } }); isHeader.checked = this.initial.isHeader;
    headerRow.appendText(L({ ko: '머리글 셀', en: "Header cell" }));
    const verticalRow = cell.createEl('label'); verticalRow.appendText(L({ ko: '세로 정렬 ', en: "Vertical alignment " }));
    const verticalAlign = verticalRow.createEl('select', { attr: { 'aria-label': L({ ko: '셀 세로 정렬', en: "Cell vertical alignment" }) } });
    for (const [value, label] of [['0', L({ ko: '위쪽', en: "Top" })], ['1', L({ ko: '가운데', en: "Center" })], ['2', L({ ko: '아래쪽', en: "Bottom" })]]) verticalAlign.createEl('option', { value, text: label });
    verticalAlign.value = String(this.initial.verticalAlign);
    const paddingRow = cell.createEl('label'); paddingRow.appendText(L({ ko: '셀 안쪽 여백 (HWP 단위) ', en: "Cell padding (HWP units) " }));
    const padding = paddingRow.createEl('input', { type: 'number', value: String(this.initial.padding), attr: { min: '0', max: '100000', 'aria-label': L({ ko: '셀 안쪽 여백 (HWP 단위)', en: "Cell padding (HWP units)" }) } });
    const borderModeRow = cell.createEl('label'); borderModeRow.appendText(L({ ko: '테두리 적용 ', en: "Apply borders " }));
    const borderMode = borderModeRow.createEl('select', { attr: { 'aria-label': L({ ko: '셀 테두리 적용 방식', en: "Cell border application mode" }) } });
    borderMode.createEl('option', { value: 'each', text: L({ ko: '각 셀마다', en: "Each cell" }) }); borderMode.createEl('option', { value: 'outside', text: L({ ko: '선택 범위 바깥만', en: "Selection perimeter only" }) });
    borderMode.value = this.initial.borderMode;
    const borderTypeRow = cell.createEl('label'); borderTypeRow.appendText(L({ ko: '테두리 종류 ', en: "Border type " }));
    const borderType = borderTypeRow.createEl('select', { attr: { 'aria-label': L({ ko: '셀 테두리 종류', en: "Cell border type" }) } });
    for (const [value, label] of [['0', L({ ko: '없음', en: "None" })], ['1', L({ ko: '실선', en: "Solid line" })], ['2', L({ ko: '파선', en: "Dashed" })], ['3', L({ ko: '점선', en: "Dotted" })], ['8', L({ ko: '이중선', en: "Double line" })]]) borderType.createEl('option', { value, text: label });
    if (Number.isSafeInteger(this.initial.borderType) && this.initial.borderType >= 0 && this.initial.borderType <= 32
      && ![0, 1, 2, 3, 8].includes(this.initial.borderType)) {
      borderType.createEl('option', { value: String(this.initial.borderType), text: LT({ ko: () => `기존 선 종류 ${this.initial.borderType} 유지`, en: () => `Keep existing line type ${this.initial.borderType}` }) });
    }
    borderType.value = String(this.initial.borderType);
    const borderColorRow = cell.createEl('label'); borderColorRow.appendText(L({ ko: '테두리 색 ', en: "Border color " }));
    const borderColor = borderColorRow.createEl('input', { type: 'color', value: this.initial.borderColor, attr: { 'aria-label': L({ ko: '셀 테두리 색상', en: "Cell border color" }) } });

    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    const cancel = buttons.createEl('button', { text: L({ ko: '취소', en: "cancel" }) }); cancel.addEventListener('click', () => this.close());
    const submit = buttons.createEl('button', { text: L({ ko: '적용', en: "Apply" }), cls: 'mod-cta' });
    submit.addEventListener('click', () => {
      const spacing = Number(cellSpacing.value), paddingValue = Number(padding.value);
      const verticalValue = Number(verticalAlign.value), borderValue = Number(borderType.value), patternValue = Number(patternType.value);
      if (!Number.isSafeInteger(spacing) || spacing < 0 || spacing > 100_000) { status.setText(L({ ko: '표 셀 간격은 0~100000 범위의 정수 HWP 단위여야 합니다.', en: "Table cell spacing must be an integer from 0 to 100000 HWP units." })); cellSpacing.focus(); return; }
      if (!Number.isSafeInteger(paddingValue) || paddingValue < 0 || paddingValue > 100_000) { status.setText(L({ ko: '셀 안쪽 여백은 0~100000 범위의 정수 HWP 단위여야 합니다.', en: "Cell padding must be an integer from 0 to 100000 HWP units." })); padding.focus(); return; }
      if (![0, 1, 2].includes(verticalValue)) { status.setText(L({ ko: '셀 세로 정렬을 다시 선택하세요.', en: "Select cell vertical alignment again." })); return; }
      if (fillMode.value === 'pattern' && (!Number.isSafeInteger(patternValue) || patternValue < 0 || patternValue > 64)) { status.setText(L({ ko: '무늬 종류는 0~64 범위의 정수여야 합니다.', en: "Pattern type must be an integer from 0 to 64." })); patternType.focus(); return; }
      if (!Number.isSafeInteger(borderValue) || borderValue < 0 || borderValue > 32) { status.setText(L({ ko: '테두리 종류는 0~32 범위의 정수여야 합니다.', en: "Border type must be an integer from 0 to 32." })); borderType.focus(); return; }
      const value: TableCellFormatValues = { cellSpacing: spacing, repeatHeader: repeatHeader.checked, fillMode: fillMode.value as TableCellFormatValues['fillMode'], fillColor: fillColor.value,
        patternColor: patternColor.value, patternType: patternValue,
        isHeader: isHeader.checked, verticalAlign: verticalValue, padding: paddingValue, borderMode: borderMode.value === 'outside' ? 'outside' : 'each',
        borderType: borderValue, borderColor: borderColor.value };
      submit.disabled = true; cancel.disabled = true;
      status.setText(L({ ko: '표와 선택 셀 속성을 적용하는 중…', en: "Applying table and selected cell properties…" }));
      void this.action(value).then(() => this.close()).catch(error => {
        status.setText(LT({ ko: () => `속성을 적용하지 못했습니다: ${String(error)}`, en: () => `Could not apply properties: ${String(error)}` })); submit.disabled = false; cancel.disabled = false;
      });
    });
    cellSpacing.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export interface ClickHereFieldOptions { name: string; guide: string; memo: string; editable: boolean }
export class ClickHereFieldModal extends FocusReturnModal {
  constructor(app: App, private readonly action: (options: ClickHereFieldOptions) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: L({ ko: '누름틀 삽입', en: "Insert input field" }) });
    const name = this.contentEl.createEl('input', { type: 'text', attr: { 'aria-label': L({ ko: '필드 이름', en: "Field name" }), placeholder: L({ ko: '필드 이름', en: "Field name" }), maxlength: '128' } });
    const guide = this.contentEl.createEl('input', { type: 'text', value: L({ ko: '내용을 입력하세요', en: "Enter content" }), attr: { 'aria-label': L({ ko: '안내문', en: "Prompt" }), maxlength: '256' } });
    const memo = this.contentEl.createEl('input', { type: 'text', attr: { 'aria-label': L({ ko: '메모', en: "Memo" }), placeholder: L({ ko: '메모 (선택)', en: "Memo (optional)" }), maxlength: '1024' } });
    const editableRow = this.contentEl.createEl('label', { cls: 'hwp-field-editable' });
    const editable = editableRow.createEl('input', { type: 'checkbox' }); editable.checked = true;
    editableRow.appendText(L({ ko: '양식 모드에서 입력 허용', en: "Allow input in form mode" }));
    const submit = this.contentEl.createEl('button', { text: L({ ko: '삽입', en: "insert" }), cls: 'mod-cta' });
    const run = async () => {
      const fieldName = name.value.trim();
      if (!fieldName) { name.focus(); new Notice(L({ ko: '필드 이름을 입력하세요.', en: "Enter a field name." })); return; }
      submit.disabled = true;
      try { await this.action({ name: fieldName, guide: guide.value, memo: memo.value, editable: editable.checked }); this.close(); }
      catch (error) { new Notice(String(error), 8000); submit.disabled = false; }
    };
    submit.addEventListener('click', () => void run());
    for (const input of [name, guide, memo]) input.addEventListener('keydown', event => { if (event.key === 'Enter') void run(); });
    name.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}
export class CharacterTableModal extends FocusReturnModal {
  constructor(app: App, private readonly action: (character: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: L({ ko: '문자표', en: "Character map" }) });
    const controls = this.contentEl.createDiv({ cls: 'hwp-character-table-controls' });
    const search = controls.createEl('input', { type: 'search', attr: { 'aria-label': L({ ko: '문자 검색', en: "Search characters" }), placeholder: L({ ko: '문자 또는 U+코드 검색', en: "Search character or U+code" }) } });
    const category = controls.createEl('select', { attr: { 'aria-label': L({ ko: '문자 범주', en: "Character category" }) } });
    for (const value of CHARACTER_TABLE_CATEGORIES) category.createEl('option', { value, text: value });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const grid = this.contentEl.createDiv({ cls: 'hwp-character-table-grid', attr: { role: 'group', 'aria-label': L({ ko: '삽입할 문자', en: "Character to insert" }) } });
    const render = (): void => {
      grid.empty();
      const entries = filterCharacterTable(search.value, category.value);
      status.setText(entries.length ? LT({ ko: () => `${entries.length}개 문자 · 선택하면 현재 캐럿에 삽입합니다.`, en: () => `${entries.length} characters · Select to insert at the caret.` }) : L({ ko: '검색 결과가 없습니다.', en: "No search results." }));
      for (const entry of entries) {
        const label = `${entry.category} ${entry.codePoint} ${entry.character}`;
        const button = grid.createEl('button', { text: entry.character, attr: { type: 'button', 'aria-label': label, title: `${entry.category} · ${entry.codePoint}` } });
        button.addEventListener('click', () => {
          button.disabled = true;
          void this.action(entry.character).then(() => this.close()).catch(error => {
            new Notice(LT({ ko: () => `문자를 삽입하지 못했습니다: ${String(error)}`, en: () => `Could not insert character: ${String(error)}` }), 8000);
            button.disabled = false;
          });
        });
      }
    };
    search.addEventListener('input', render); category.addEventListener('change', render);
    render(); search.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export type CharacterFormatUpdate = Pick<CharacterProperties, 'bold' | 'italic' | 'underline' | 'strikethrough' | 'fontFamily' | 'fontFamilies' | 'fontSize' | 'textColor' | 'shadeColor'
  | 'underlineType' | 'underlineColor' | 'underlineShape' | 'strikeColor' | 'strikeShape' | 'outlineType' | 'shadowType' | 'shadowColor' | 'shadowOffsetX' | 'shadowOffsetY'
  | 'subscript' | 'superscript' | 'emboss' | 'engrave' | 'emphasisDot' | 'kerning'>
  & Pick<CharacterFormatProperties, 'fontLanguage' | 'ratio' | 'characterSpacing' | 'relativeSize' | 'characterOffset'>;
export type ParagraphFormatUpdate = Omit<Pick<ParagraphProperties, 'alignment' | 'marginLeft' | 'marginRight' | 'indent' | 'spacingBefore' | 'spacingAfter' | 'lineSpacing' | 'lineSpacingType'>, 'lineSpacingType'> & {
  lineSpacingType?: 'Percent' | 'Fixed' | 'SpaceOnly' | 'Minimum' | 'BetweenLines';
};

export class StyleSelectionModal extends FocusReturnModal {
  constructor(app: App, private readonly styles: StyleDefinition[], private readonly currentStyleId: number | undefined, private readonly action: (styleId: number) => Promise<void>) { super(app); }

  onOpen(): void {
    this.contentEl.addClass('hwp-format-dialog');
    this.contentEl.createEl('h2', { text: L({ ko: '문단 스타일', en: "paragraph style" }) });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const row = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' });
    row.createEl('label', { text: L({ ko: '적용할 스타일', en: "Style to apply" }) });
    const select = row.createEl('select', { attr: { 'aria-label': L({ ko: '적용할 문단 스타일', en: "Paragraph style to apply" }) } });
    select.createEl('option', { value: '', text: L({ ko: '스타일 선택', en: "Select style" }) });
    for (const style of this.styles) select.createEl('option', { value: String(style.id), text: style.name || style.englishName || LT({ ko: () => `스타일 ${style.id}`, en: () => `Style ${style.id}` }) });
    select.value = this.currentStyleId !== undefined && this.styles.some(style => style.id === this.currentStyleId) ? String(this.currentStyleId) : '';
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    const cancel = buttons.createEl('button', { text: L({ ko: '취소', en: "cancel" }) }); cancel.addEventListener('click', () => this.close());
    const apply = buttons.createEl('button', { text: L({ ko: '적용', en: "Apply" }), cls: 'mod-cta' });
    apply.addEventListener('click', () => {
      const styleId = Number(select.value);
      if (!select.value || !Number.isSafeInteger(styleId) || !this.styles.some(style => style.id === styleId)) { status.setText(L({ ko: '문단 스타일을 선택하세요.', en: "Select a paragraph style." })); select.focus(); return; }
      apply.disabled = true; status.setText(L({ ko: '문단 스타일을 적용하는 중…', en: "Applying paragraph style…" }));
      void this.action(styleId).then(() => this.close()).catch(error => {
        status.setText(LT({ ko: () => `문단 스타일을 적용하지 못했습니다. ${String(error)}`, en: () => `Could not apply paragraph style. ${String(error)}` })); apply.disabled = false;
      });
    });
    select.focus();
  }

  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class CharacterFormatModal extends FocusReturnModal {
  constructor(app: App, private readonly initial: CharacterFormatUpdate, private readonly action: (properties: CharacterFormatUpdate) => Promise<void>) { super(app); }

  onOpen(): void {
    this.contentEl.addClass('hwp-format-dialog');
    this.contentEl.createEl('h2', { text: L({ ko: '글자 모양', en: "Character format" }) });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const fontFamily = this.field(L({ ko: '글꼴', en: "Font" }), 'text', L({ ko: '글꼴 이름', en: "Font name" }));
    fontFamily.value = this.initial.fontFamily ?? '';
    const fontSize = this.field(L({ ko: '크기 (pt)', en: "Size (pt)" }), 'number', L({ ko: '글자 크기 (pt)', en: "Font size (pt)" }));
    fontSize.value = this.initial.fontSize === undefined ? '' : String(this.initial.fontSize);
    fontSize.min = '1'; fontSize.max = '1000'; fontSize.step = '0.5';
    const ratio = this.field(L({ ko: '장평 (%)', en: "Character width (%)" }), 'number', L({ ko: '장평 (%)', en: "Character width (%)" }));
    ratio.value = this.initial.ratio === undefined ? '' : String(this.initial.ratio);
    ratio.min = '50'; ratio.max = '200'; ratio.step = '1';
    const characterSpacing = this.field(L({ ko: '자간 (%)', en: "Character spacing (%)" }), 'number', L({ ko: '자간 (%)', en: "Character spacing (%)" }));
    characterSpacing.value = this.initial.characterSpacing === undefined ? '' : String(this.initial.characterSpacing);
    characterSpacing.min = '-50'; characterSpacing.max = '50'; characterSpacing.step = '1';
    const relativeSize = this.field(L({ ko: '상대 크기 (%)', en: "Relative size (%)" }), 'number', L({ ko: '상대 크기 (%)', en: "Relative size (%)" }));
    relativeSize.value = this.initial.relativeSize === undefined ? '' : String(this.initial.relativeSize);
    relativeSize.min = '10'; relativeSize.max = '250'; relativeSize.step = '1';
    const characterOffset = this.field(L({ ko: '글자 위치 (%)', en: "Character position (%)" }), 'number', L({ ko: '글자 위치 (%)', en: "Character position (%)" }));
    characterOffset.value = this.initial.characterOffset === undefined ? '' : String(this.initial.characterOffset);
    characterOffset.min = '-100'; characterOffset.max = '100'; characterOffset.step = '1';
    const booleans = new Map<keyof Pick<CharacterFormatUpdate, 'bold' | 'italic' | 'underline' | 'strikethrough' | 'superscript' | 'subscript' | 'emboss' | 'engrave' | 'kerning'>, HTMLSelectElement>();
    for (const [key, label] of [['bold', L({ ko: '굵게', en: "Bold" })], ['italic', L({ ko: '기울임', en: "Italic" })], ['underline', L({ ko: '밑줄', en: "Underline" })], ['strikethrough', L({ ko: '취소선', en: "Strikethrough" })], ['superscript', L({ ko: '위 첨자', en: "Superscript" })], ['subscript', L({ ko: '아래 첨자', en: "Subscript" })], ['emboss', L({ ko: '양각', en: "Emboss" })], ['engrave', L({ ko: '음각', en: "Engrave" })], ['kerning', L({ ko: '커닝', en: "Kerning" })]] as const) {
      const select = this.select(label, label);
      select.createEl('option', { value: '', text: L({ ko: '현재 유지', en: "Keep current" }) });
      select.createEl('option', { value: 'true', text: L({ ko: '켜기', en: "On" }) });
      select.createEl('option', { value: 'false', text: L({ ko: '끄기', en: "Off" }) });
      const current = this.initial[key];
      select.value = current === undefined ? '' : String(current);
      booleans.set(key, select);
    }
    for (const [left, right] of [['superscript', 'subscript'], ['emboss', 'engrave']] as const) {
      booleans.get(left)?.addEventListener('change', () => { if (booleans.get(left)?.value === 'true') booleans.get(right)!.value = 'false'; });
      booleans.get(right)?.addEventListener('change', () => { if (booleans.get(right)?.value === 'true') booleans.get(left)!.value = 'false'; });
    }
    const textColor = this.colorField(L({ ko: '글자 색', en: "Text color" }), L({ ko: '글자 색 적용', en: "Apply text color" }), this.initial.textColor ?? '#000000', this.initial.textColor !== undefined);
    const shadeColor = this.colorField(L({ ko: '형광펜 색', en: "Highlight color" }), L({ ko: '형광펜 색 적용 (흰색은 지우기)', en: "Apply highlight color (white clears)" }), this.initial.shadeColor ?? '#ffff00', this.initial.shadeColor !== undefined);
    const effects = this.contentEl.createEl('details', { cls: 'hwp-character-effects' });
    effects.createEl('summary', { text: L({ ko: '밑줄·취소선·글자 효과', en: "Underline, strikethrough, and character effects" }) });
    const underlineType = this.select(L({ ko: '밑줄 위치', en: "Underline position" }), L({ ko: '밑줄 위치', en: "Underline position" }), effects);
    underlineType.createEl('option', { value: '', text: L({ ko: '현재 유지', en: "Keep current" }) });
    underlineType.createEl('option', { value: 'None', text: L({ ko: '없음', en: "None" }) });
    underlineType.createEl('option', { value: 'Bottom', text: L({ ko: '아래', en: "Below" }) });
    underlineType.createEl('option', { value: 'Top', text: L({ ko: '위', en: "Above" }) });
    underlineType.value = this.initial.underlineType ?? '';
    const shadowType = this.select(L({ ko: '그림자 유형', en: "Shadow type" }), L({ ko: '그림자 유형', en: "Shadow type" }), effects);
    shadowType.createEl('option', { value: '', text: L({ ko: '현재 유지', en: "Keep current" }) });
    shadowType.createEl('option', { value: '0', text: L({ ko: '없음', en: "None" }) });
    shadowType.createEl('option', { value: '1', text: L({ ko: '그림자', en: "Shadow" }) });
    shadowType.createEl('option', { value: '2', text: L({ ko: '연속 그림자', en: "Continuous shadow" }) });
    shadowType.value = this.initial.shadowType === undefined ? '' : String(this.initial.shadowType);
    const effectNumber = (key: 'outlineType' | 'shadowOffsetX' | 'shadowOffsetY' | 'underlineShape' | 'strikeShape' | 'emphasisDot', label: string, min: number, max: number): HTMLInputElement => {
      const input = this.field(label, 'number', label, effects);
      input.value = this.initial[key] === undefined ? '' : String(this.initial[key]);
      input.min = String(min); input.max = String(max); input.step = '1';
      return input;
    };
    const outlineType = effectNumber('outlineType', L({ ko: '외곽선 유형 (0~7)', en: "Outline type (0–7)" }), 0, 7);
    const shadowOffsetX = effectNumber('shadowOffsetX', L({ ko: '그림자 X 간격 (%)', en: "Shadow X offset (%)" }), -100, 100);
    const shadowOffsetY = effectNumber('shadowOffsetY', L({ ko: '그림자 Y 간격 (%)', en: "Shadow Y offset (%)" }), -100, 100);
    const underlineShape = effectNumber('underlineShape', L({ ko: '밑줄 선 모양 (0~10)', en: "Underline line style (0–10)" }), 0, 10);
    const strikeShape = effectNumber('strikeShape', L({ ko: '취소선 모양 (0~10)', en: "Strikethrough style (0–10)" }), 0, 10);
    const emphasisDot = effectNumber('emphasisDot', L({ ko: '강조점 종류 (0~6)', en: "Emphasis mark type (0–6)" }), 0, 6);
    const underlineColor = this.colorField(L({ ko: '밑줄 색', en: "Underline color" }), L({ ko: '밑줄 색 적용', en: "Apply underline color" }), this.initial.underlineColor ?? '#000000', this.initial.underlineColor !== undefined, effects);
    const strikeColor = this.colorField(L({ ko: '취소선 색', en: "Strikethrough color" }), L({ ko: '취소선 색 적용', en: "Apply strikethrough color" }), this.initial.strikeColor ?? '#000000', this.initial.strikeColor !== undefined, effects);
    const shadowColor = this.colorField(L({ ko: '그림자 색', en: "Shadow color" }), L({ ko: '그림자 색 적용', en: "Apply shadow color" }), this.initial.shadowColor ?? '#000000', this.initial.shadowColor !== undefined, effects);
    effects.open = false;
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    const cancel = buttons.createEl('button', { text: L({ ko: '취소', en: "cancel" }) }); cancel.addEventListener('click', () => this.close());
    const submit = buttons.createEl('button', { text: L({ ko: '적용', en: "Apply" }), cls: 'mod-cta' });
    submit.addEventListener('click', () => {
      const properties: CharacterFormatUpdate = {};
      for (const [key, select] of booleans) {
        if (select.value === 'true') properties[key] = true;
        else if (select.value === 'false') properties[key] = false;
      }
      const family = fontFamily.value.trim();
      if (family) properties.fontFamily = family;
      if (fontSize.value.trim()) {
        const size = Number(fontSize.value);
        if (!Number.isFinite(size) || size < 1 || size > 1000) { status.setText(L({ ko: '글자 크기는 1~1000pt 범위로 입력하세요.', en: "Enter a font size from 1 to 1000 pt." })); fontSize.focus(); return; }
        properties.fontSize = size;
      }
      if (ratio.value.trim()) {
        const width = Number(ratio.value);
        if (!Number.isSafeInteger(width) || width < 50 || width > 200) { status.setText(L({ ko: '장평은 50~200%의 정수로 입력하세요.', en: "Enter an integer character width from 50 to 200%." })); ratio.focus(); return; }
        properties.ratio = width;
      }
      if (characterSpacing.value.trim()) {
        const spacing = Number(characterSpacing.value);
        if (!Number.isSafeInteger(spacing) || spacing < -50 || spacing > 50) { status.setText(L({ ko: '자간은 -50~50%의 정수로 입력하세요.', en: "Enter integer character spacing from -50 to 50%." })); characterSpacing.focus(); return; }
        properties.characterSpacing = spacing;
      }
      if (relativeSize.value.trim()) {
        const size = Number(relativeSize.value);
        if (!Number.isSafeInteger(size) || size < 10 || size > 250) { status.setText(L({ ko: '상대 크기는 10~250%의 정수로 입력하세요.', en: "Enter an integer relative size from 10 to 250%." })); relativeSize.focus(); return; }
        properties.relativeSize = size;
      }
      if (characterOffset.value.trim()) {
        const offset = Number(characterOffset.value);
        if (!Number.isSafeInteger(offset) || offset < -100 || offset > 100) { status.setText(L({ ko: '글자 위치는 -100~100%의 정수로 입력하세요.', en: "Enter an integer character position from -100 to 100%." })); characterOffset.focus(); return; }
        properties.characterOffset = offset;
      }
      if (underlineType.value) properties.underlineType = underlineType.value as NonNullable<CharacterFormatUpdate['underlineType']>;
      if (shadowType.value) properties.shadowType = Number(shadowType.value);
      const effectRanges = [
        ['outlineType', outlineType, 0, 7], ['shadowOffsetX', shadowOffsetX, -100, 100], ['shadowOffsetY', shadowOffsetY, -100, 100],
        ['underlineShape', underlineShape, 0, 10], ['strikeShape', strikeShape, 0, 10], ['emphasisDot', emphasisDot, 0, 6],
      ] as const;
      for (const [key, input, min, max] of effectRanges) if (input.value.trim()) {
        const number = Number(input.value);
        if (!Number.isSafeInteger(number) || number < min || number > max) { status.setText(LT({ ko: () => `${input.getAttribute('aria-label')} 값이 허용 범위를 벗어났습니다.`, en: () => `${input.getAttribute('aria-label')} is outside the allowed range.` })); input.focus(); return; }
        properties[key] = number;
      }
      if (textColor.enabled.checked) properties.textColor = textColor.input.value;
      if (shadeColor.enabled.checked) properties.shadeColor = shadeColor.input.value;
      if (underlineColor.enabled.checked) properties.underlineColor = underlineColor.input.value;
      if (strikeColor.enabled.checked) properties.strikeColor = strikeColor.input.value;
      if (shadowColor.enabled.checked) properties.shadowColor = shadowColor.input.value;
      if (properties.superscript === true) properties.subscript = false;
      if (properties.subscript === true) properties.superscript = false;
      if (properties.emboss === true) properties.engrave = false;
      if (properties.engrave === true) properties.emboss = false;
      if (!Object.keys(properties).length) { status.setText(L({ ko: '변경할 서식을 선택하세요.', en: "Select formatting to change." })); return; }
      submit.disabled = true; status.setText(L({ ko: '서식을 적용하는 중…', en: "Applying formatting…" }));
      void this.action(properties).then(() => this.close()).catch(error => {
        status.setText(LT({ ko: () => `서식을 적용하지 못했습니다: ${String(error)}`, en: () => `Could not apply formatting: ${String(error)}` })); submit.disabled = false;
      });
    });
    fontFamily.focus();
  }

  private field(labelText: string, type: string, ariaLabel: string, parent: HTMLElement = this.contentEl): HTMLInputElement {
    const row = parent.createDiv({ cls: 'hwp-format-dialog-row' });
    row.createEl('label', { text: labelText });
    return row.createEl('input', { type, attr: { 'aria-label': ariaLabel } });
  }

  private select(labelText: string, ariaLabel: string, parent: HTMLElement = this.contentEl): HTMLSelectElement {
    const row = parent.createDiv({ cls: 'hwp-format-dialog-row' });
    row.createEl('label', { text: labelText });
    return row.createEl('select', { attr: { 'aria-label': ariaLabel } });
  }

  private colorField(labelText: string, ariaLabel: string, value: string, checked: boolean, parent: HTMLElement = this.contentEl): { enabled: HTMLInputElement; input: HTMLInputElement } {
    const row = parent.createDiv({ cls: 'hwp-format-dialog-row' });
    const toggle = row.createEl('label', { cls: 'hwp-format-dialog-check' });
    const enabled = toggle.createEl('input', { type: 'checkbox' }); enabled.checked = checked;
    toggle.appendText(LT({ ko: () => `${labelText} 적용`, en: () => `Apply ${labelText}` }));
    const input = row.createEl('input', { type: 'color', value, attr: { 'aria-label': ariaLabel } });
    input.disabled = !enabled.checked;
    enabled.addEventListener('change', () => { input.disabled = !enabled.checked; });
    return { enabled, input };
  }

  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class ParagraphFormatModal extends FocusReturnModal {
  constructor(app: App, private readonly initial: ParagraphProperties, private readonly action: (properties: ParagraphFormatUpdate) => Promise<void>) { super(app); }

  onOpen(): void {
    this.contentEl.addClass('hwp-format-dialog');
    this.contentEl.createEl('h2', { text: L({ ko: '문단 모양', en: "Paragraph format" }) });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const alignment = this.select(L({ ko: '정렬', en: "Sort" }), L({ ko: '문단 정렬', en: "Paragraph alignment" }));
    alignment.createEl('option', { value: '', text: L({ ko: '현재 유지', en: "Keep current" }) });
    for (const [value, label] of [['left', L({ ko: '왼쪽', en: "Left" })], ['center', L({ ko: '가운데', en: "Center" })], ['right', L({ ko: '오른쪽', en: "Right" })], ['justify', L({ ko: '양쪽', en: "Justified" })], ['distribute', L({ ko: '배분', en: "Distributed" })], ['split', L({ ko: '나눔', en: "Split" })]] as const) alignment.createEl('option', { value, text: label });
    alignment.value = this.initial.alignment ?? '';
    const dimensions = new Map<keyof Pick<ParagraphProperties, 'marginLeft' | 'marginRight' | 'indent' | 'spacingBefore' | 'spacingAfter'>, HTMLInputElement>();
    for (const [key, label] of [['marginLeft', L({ ko: '왼쪽 여백 (mm)', en: "Left margin (mm)" })], ['marginRight', L({ ko: '오른쪽 여백 (mm)', en: "Right margin (mm)" })], ['indent', L({ ko: '첫 줄 들여쓰기 (mm)', en: "First-line indent (mm)" })], ['spacingBefore', L({ ko: '문단 앞 간격 (mm)', en: "Space before paragraph (mm)" })], ['spacingAfter', L({ ko: '문단 뒤 간격 (mm)', en: "Space after paragraph (mm)" })]] as const) {
      const input = this.numberField(label, label, -1000, 1000, 0.1);
      const value = this.initial[key]; input.value = value === undefined ? '' : pixelsToMillimeters(value).toFixed(3);
      dimensions.set(key, input);
    }
    const initialMode = this.initial.lineSpacingType === 'Percent' || this.initial.lineSpacingType === 'Fixed' || this.initial.lineSpacingType === 'SpaceOnly' || this.initial.lineSpacingType === 'Minimum' || this.initial.lineSpacingType === 'BetweenLines'
      ? this.initial.lineSpacingType : '';
    const lineMode = this.select(L({ ko: '줄 간격 기준', en: "Line spacing mode" }), L({ ko: '줄 간격 기준', en: "Line spacing mode" }));
    lineMode.createEl('option', { value: '', text: L({ ko: '현재 유지', en: "Keep current" }) });
    lineMode.createEl('option', { value: 'Percent', text: L({ ko: '퍼센트 (%)', en: "Percentage (%)" }) });
    lineMode.createEl('option', { value: 'Fixed', text: L({ ko: '고정 (pt)', en: "Fixed (pt)" }) });
    lineMode.createEl('option', { value: 'SpaceOnly', text: L({ ko: '여백만 지정 (pt)', en: "Spacing only (pt)" }) });
    lineMode.createEl('option', { value: 'Minimum', text: L({ ko: '최소 (pt)', en: "Minimum (pt)" }) });
    lineMode.value = initialMode;
    const lineSpacing = this.numberField(L({ ko: '줄 간격 값', en: "Line spacing value" }), L({ ko: '줄 간격 값', en: "Line spacing value" }), 0, 100000, 0.1);
    const lineUnit = this.contentEl.createDiv({ cls: 'hwp-format-dialog-unit', text: initialMode === 'Percent' ? '%' : initialMode ? 'pt' : L({ ko: '단위를 선택하세요.', en: "Select a unit." }) });
    if (this.initial.lineSpacing !== undefined) {
      lineSpacing.value = String(initialMode === 'Percent' ? this.initial.lineSpacing : pixelsToPoints(this.initial.lineSpacing));
    }
    lineMode.addEventListener('change', () => {
      lineUnit.setText(lineMode.value === 'Percent' ? '%' : lineMode.value ? 'pt' : L({ ko: '단위를 선택하세요.', en: "Select a unit." }));
      if (lineMode.value !== initialMode) lineSpacing.value = lineMode.value === 'Percent' ? '100' : lineMode.value ? '12' : '';
    });
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    const cancel = buttons.createEl('button', { text: L({ ko: '취소', en: "cancel" }) }); cancel.addEventListener('click', () => this.close());
    const submit = buttons.createEl('button', { text: L({ ko: '적용', en: "Apply" }), cls: 'mod-cta' });
    submit.addEventListener('click', () => {
      const properties: ParagraphFormatUpdate = {};
      if (alignment.value) properties.alignment = alignment.value as ParagraphAlignment;
      for (const [key, input] of dimensions) {
        if (!input.value.trim()) continue;
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < -1000 || value > 1000) { status.setText(L({ ko: '문단 길이는 -1000~1000mm 범위로 입력하세요.', en: "Enter paragraph lengths from -1000 to 1000 mm." })); input.focus(); return; }
        properties[key] = key === 'spacingBefore' || key === 'spacingAfter'
          ? millimetersToHwpUnits(value) : millimetersToDoubledHwpUnits(value);
      }
      if (lineMode.value) {
        properties.lineSpacingType = lineMode.value as 'Percent' | 'Fixed' | 'SpaceOnly' | 'Minimum' | 'BetweenLines';
        if (lineSpacing.value.trim()) {
          const value = Number(lineSpacing.value);
          if (!Number.isFinite(value) || value < 0 || value > 100000) { status.setText(L({ ko: '줄 간격 값은 0~100000 범위로 입력하세요.', en: "Enter line spacing from 0 to 100000." })); lineSpacing.focus(); return; }
          properties.lineSpacing = lineMode.value === 'Percent' ? value : pointsToHwpUnits(value);
        } else if (lineMode.value !== initialMode) {
          properties.lineSpacing = lineMode.value === 'Percent' ? 100 : pointsToHwpUnits(12);
        }
      }
      if (!Object.keys(properties).length) { status.setText(L({ ko: '변경할 문단 속성을 선택하세요.', en: "Select paragraph properties to change." })); return; }
      submit.disabled = true; status.setText(L({ ko: '문단 모양을 적용하는 중…', en: "Applying paragraph formatting…" }));
      void this.action(properties).then(() => this.close()).catch(error => {
        status.setText(LT({ ko: () => `문단 모양을 적용하지 못했습니다: ${String(error)}`, en: () => `Could not apply paragraph formatting: ${String(error)}` })); submit.disabled = false;
      });
    });
    alignment.focus();
  }

  private select(labelText: string, ariaLabel: string): HTMLSelectElement {
    const row = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' });
    row.createEl('label', { text: labelText });
    return row.createEl('select', { attr: { 'aria-label': ariaLabel } });
  }

  private numberField(labelText: string, ariaLabel: string, min: number, max: number, step: number): HTMLInputElement {
    const row = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' });
    row.createEl('label', { text: labelText });
    return row.createEl('input', { type: 'number', attr: { 'aria-label': ariaLabel, min: String(min), max: String(max), step: String(step) } });
  }

  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class PageSetupModal extends FocusReturnModal {
  constructor(app: App, private readonly initial: Record<string, unknown>, private readonly action: (properties: PageSettingsProperties) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('hwp-format-dialog');
    this.contentEl.createEl('h2', { text: L({ ko: '편집 용지', en: "Page setup" }) });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const field = (labelText: string, ariaLabel: string, min: number, max: number): HTMLInputElement => {
      const row = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' }); row.createEl('label', { text: labelText });
      return row.createEl('input', { type: 'number', attr: { 'aria-label': ariaLabel, min: String(min), max: String(max), step: '0.1' } });
    };
    const select = (labelText: string, ariaLabel: string): HTMLSelectElement => {
      const row = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' }); row.createEl('label', { text: labelText });
      return row.createEl('select', { attr: { 'aria-label': ariaLabel } });
    };
    const paper = select(L({ ko: '용지 크기', en: "Paper size" }), L({ ko: '용지 크기', en: "Paper size" }));
    const sizes = [
      ['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210], ['B5', 176, 250],
      ['Letter', 215.9, 279.4], ['Legal', 215.9, 355.6],
    ] as const;
    paper.createEl('option', { value: 'custom', text: L({ ko: '사용자 지정', en: "Custom" }) });
    for (const [name, width, height] of sizes) paper.createEl('option', { value: `${width}x${height}`, text: name });
    const orientation = select(L({ ko: '방향', en: "Orientation" }), L({ ko: '용지 방향', en: "Paper orientation" }));
    orientation.createEl('option', { value: 'portrait', text: L({ ko: '세로', en: "Portrait" }) }); orientation.createEl('option', { value: 'landscape', text: L({ ko: '가로', en: "Landscape" }) });
    const storedWidth = typeof this.initial.width === 'number' ? hwpUnitsToMillimeters(this.initial.width) : 210;
    const storedHeight = typeof this.initial.height === 'number' ? hwpUnitsToMillimeters(this.initial.height) : 297;
    const landscape = typeof this.initial.landscape === 'boolean' ? this.initial.landscape : storedWidth > storedHeight;
    orientation.value = landscape ? 'landscape' : 'portrait';
    const width = field(L({ ko: '너비 (mm)', en: "Width (mm)" }), L({ ko: '용지 너비 (mm)', en: "Paper width (mm)" }), 10, 1000); width.value = storedWidth.toFixed(3);
    const height = field(L({ ko: '높이 (mm)', en: "Height (mm)" }), L({ ko: '용지 높이 (mm)', en: "Paper height (mm)" }), 10, 1000); height.value = storedHeight.toFixed(3);
    const matchingSize = sizes.find(([, first, second]) => Math.abs(Math.min(storedWidth, storedHeight) - first) < 0.2 && Math.abs(Math.max(storedWidth, storedHeight) - second) < 0.2);
    paper.value = matchingSize ? `${matchingSize[1]}x${matchingSize[2]}` : 'custom';
    paper.addEventListener('change', () => {
      const size = sizes.find(([, first, second]) => `${first}x${second}` === paper.value);
      if (!size) return;
      const [, portraitWidth, portraitHeight] = size;
      width.value = (orientation.value === 'landscape' ? portraitHeight : portraitWidth).toFixed(1);
      height.value = (orientation.value === 'landscape' ? portraitWidth : portraitHeight).toFixed(1);
    });
    orientation.addEventListener('change', () => {
      const currentWidth = Number(width.value), currentHeight = Number(height.value);
      if (Number.isFinite(currentWidth) && Number.isFinite(currentHeight)
        && ((orientation.value === 'landscape' && currentWidth < currentHeight) || (orientation.value === 'portrait' && currentWidth > currentHeight))) {
        width.value = String(currentHeight); height.value = String(currentWidth);
      }
    });
    const margins = new Map<keyof Pick<PageSettingsProperties, 'marginLeft' | 'marginRight' | 'marginTop' | 'marginBottom' | 'marginHeader' | 'marginFooter' | 'marginGutter'>, HTMLInputElement>();
    for (const [key, label] of [['marginLeft', L({ ko: '왼쪽 여백 (mm)', en: "Left margin (mm)" })], ['marginRight', L({ ko: '오른쪽 여백 (mm)', en: "Right margin (mm)" })], ['marginTop', L({ ko: '위 여백 (mm)', en: "Top margin (mm)" })], ['marginBottom', L({ ko: '아래 여백 (mm)', en: "Bottom margin (mm)" })], ['marginHeader', L({ ko: '머리말 여백 (mm)', en: "Header margin (mm)" })], ['marginFooter', L({ ko: '꼬리말 여백 (mm)', en: "Footer margin (mm)" })], ['marginGutter', L({ ko: '제본 여백 (mm)', en: "Gutter margin (mm)" })]] as const) {
      const input = field(label, label, 0, 1000), value = this.initial[key];
      input.value = typeof value === 'number' ? hwpUnitsToMillimeters(value).toFixed(3) : '';
      margins.set(key, input);
    }
    const binding = select(L({ ko: '제책 방법', en: "Binding" }), L({ ko: '제책 방법', en: "Binding" }));
    binding.createEl('option', { value: '', text: L({ ko: '현재 유지', en: "Keep current" }) });
    binding.createEl('option', { value: '0', text: L({ ko: '한쪽 편집', en: "Single-sided" }) });
    binding.createEl('option', { value: '1', text: L({ ko: '맞쪽 편집', en: "Facing pages" }) });
    binding.createEl('option', { value: '2', text: L({ ko: '위로 넘기기', en: "Flip upward" }) });
    if (typeof this.initial.binding === 'number' && this.initial.binding === 3) binding.createEl('option', { value: '3', text: L({ ko: '현재 값 3 유지', en: "Keep current value 3" }) });
    binding.value = typeof this.initial.binding === 'number' && this.initial.binding >= 0 && this.initial.binding <= 3 ? String(this.initial.binding) : '';
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    const cancel = buttons.createEl('button', { text: L({ ko: '취소', en: "cancel" }) }); cancel.addEventListener('click', () => this.close());
    const apply = buttons.createEl('button', { text: L({ ko: '적용', en: "Apply" }), cls: 'mod-cta' });
    apply.addEventListener('click', () => {
      const widthValue = Number(width.value), heightValue = Number(height.value);
      if (!Number.isFinite(widthValue) || !Number.isFinite(heightValue) || widthValue < 10 || widthValue > 1000 || heightValue < 10 || heightValue > 1000) {
        status.setText(L({ ko: '용지 너비와 높이는 10~1000mm 범위로 입력하세요.', en: "Enter paper width/height from 10 to 1000 mm." })); width.focus(); return;
      }
      const landscape = orientation.value === 'landscape';
      let widthUnits = millimetersToHwpUnits(widthValue), heightUnits = millimetersToHwpUnits(heightValue);
      if ((landscape && widthUnits < heightUnits) || (!landscape && widthUnits > heightUnits)) [widthUnits, heightUnits] = [heightUnits, widthUnits];
      const properties: PageSettingsProperties = { width: widthUnits, height: heightUnits, landscape };
      for (const [key, input] of margins) {
        if (!input.value.trim()) continue;
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < 0 || value > 1000) { status.setText(L({ ko: '여백은 0~1000mm 범위로 입력하세요.', en: "Enter margins from 0 to 1000 mm." })); input.focus(); return; }
        properties[key] = millimetersToHwpUnits(value);
      }
      if (binding.value) properties.binding = Number(binding.value);
      apply.disabled = true; status.setText(L({ ko: '편집 용지 설정을 적용하는 중…', en: "Applying page setup…" }));
      void this.action(properties).then(() => this.close()).catch(error => { status.setText(LT({ ko: () => `쪽 설정을 적용하지 못했습니다: ${String(error)}`, en: () => `Could not apply page settings: ${String(error)}` })); apply.disabled = false; });
    });
    paper.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class HeaderFooterTemplateModal extends FocusReturnModal {
  constructor(app: App, private readonly section: number, private readonly stories: HeaderFooterStory[], private readonly initialIsHeader = true, private readonly initialApplyTo: 0 | 1 | 2 = 0,
    private readonly action: (command: { type: 'apply'; isHeader: boolean; applyTo: 0 | 1 | 2; templateId: number } | { type: 'delete'; isHeader: boolean; applyTo: 0 | 1 | 2 }) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('hwp-format-dialog');
    this.contentEl.createEl('h2', { text: L({ ko: '머리말 / 꼬리말', en: "Header / Footer" }) });
    this.contentEl.createEl('p', { cls: 'hwp-hint', text: L({ ko: '현재 쪽의 구역에 템플릿을 적용합니다. 머리말·꼬리말 본문은 쪽에서 두 번 클릭하거나 ‘본문 밖 영역’ 목록에서 편집할 수 있습니다.', en: "Applies a template to the current page's section. Edit header/footer text by double-clicking it on the page or through the “Non-body areas” list." }) });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const row = (label: string, aria: string): HTMLDivElement => {
      const element = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' }); element.createEl('label', { text: label }); return element;
    };
    const isHeader = row(L({ ko: '영역', en: "Area" }), L({ ko: '머리말 또는 꼬리말', en: "Header or footer" })).createEl('select', { attr: { 'aria-label': L({ ko: '머리말 또는 꼬리말', en: "Header or footer" }) } });
    isHeader.createEl('option', { value: 'true', text: L({ ko: '머리말', en: "header" }) }); isHeader.createEl('option', { value: 'false', text: L({ ko: '꼬리말', en: "footer" }) });
    isHeader.value = String(this.initialIsHeader);
    const applyTo = row(L({ ko: '적용 쪽', en: "Apply to pages" }), L({ ko: '머리말·꼬리말 적용 쪽', en: "Header/footer page scope" })).createEl('select', { attr: { 'aria-label': L({ ko: '머리말·꼬리말 적용 쪽', en: "Header/footer page scope" }) } });
    for (const [value, label] of [['0', L({ ko: '양쪽 쪽', en: "Both page types" })], ['1', L({ ko: '짝수 쪽', en: "Even pages" })], ['2', L({ ko: '홀수 쪽', en: "Odd pages" })]]) applyTo.createEl('option', { value, text: label });
    applyTo.value = String(this.initialApplyTo);
    const template = row(L({ ko: '템플릿', en: "template" }), L({ ko: '머리말·꼬리말 템플릿', en: "Header/footer template" })).createEl('select', { attr: { 'aria-label': L({ ko: '머리말·꼬리말 템플릿', en: "Header/footer template" }) } });
    const templates = [
      L({ ko: '빈 머리말 / 꼬리말', en: "Empty header / footer" }), L({ ko: '쪽 번호 왼쪽', en: "Page number left" }), L({ ko: '쪽 번호 가운데', en: "Page number center" }), L({ ko: '쪽 번호 오른쪽', en: "Page number right" }),
      L({ ko: '쪽 번호 왼쪽 · 파일 이름 오른쪽', en: "Page number left · file name right" }), L({ ko: '파일 이름 왼쪽 · 쪽 번호 오른쪽', en: "File name left · page number right" }),
      L({ ko: '쪽 번호 왼쪽 (굵게·밑줄)', en: "Page number left (bold/underline)" }), L({ ko: '쪽 번호 가운데 (굵게·밑줄)', en: "Page number center (bold/underline)" }), L({ ko: '쪽 번호 오른쪽 (굵게·밑줄)', en: "Page number right (bold/underline)" }),
      L({ ko: '쪽 번호 왼쪽 · 파일 이름 오른쪽 (굵게·밑줄)', en: "Page number left · file name right (bold/underline)" }), L({ ko: '파일 이름 왼쪽 · 쪽 번호 오른쪽 (굵게·밑줄)', en: "File name left · page number right (bold/underline)" }),
    ];
    templates.forEach((label, id) => template.createEl('option', { value: String(id), text: label }));
    const existingStatus = this.contentEl.createDiv({ cls: 'hwp-hint', attr: { 'aria-live': 'polite' } });
    const selectedStory = (): HeaderFooterStory | undefined => this.stories.find(story => story.section === this.section
      && story.isHeader === (isHeader.value === 'true') && story.applyTo === Number(applyTo.value));
    const updateStatus = (): void => {
      const story = selectedStory();
      existingStatus.setText(story ? LT({ ko: () => `현재 내용: ${story.label || (isHeader.value === 'true' ? L({ ko: '머리말', en: "header" }) : L({ ko: '꼬리말', en: "footer" }))} (${story.paragraphs.length}문단)`, en: () => `Current content: ${story.label || (isHeader.value === 'true' ? 'Header' : 'Footer')} (${story.paragraphs.length} paragraphs)` }) : L({ ko: '현재 선택한 영역에는 머리말·꼬리말이 없습니다.', en: "No header/footer in the selected area." }));
      remove.disabled = !story;
    };
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    const cancel = buttons.createEl('button', { text: L({ ko: '닫기', en: "Close" }) }); cancel.addEventListener('click', () => this.close());
    const remove = buttons.createEl('button', { text: L({ ko: '선택 영역 지우기', en: "Delete selected area" }) });
    remove.addEventListener('click', () => void run({ type: 'delete', isHeader: isHeader.value === 'true', applyTo: Number(applyTo.value) as 0 | 1 | 2 }));
    const apply = buttons.createEl('button', { text: L({ ko: '템플릿 적용', en: "Apply template" }), cls: 'mod-cta' });
    apply.addEventListener('click', () => void run({ type: 'apply', isHeader: isHeader.value === 'true', applyTo: Number(applyTo.value) as 0 | 1 | 2, templateId: Number(template.value) }));
    const run = async (command: { type: 'apply'; isHeader: boolean; applyTo: 0 | 1 | 2; templateId: number } | { type: 'delete'; isHeader: boolean; applyTo: 0 | 1 | 2 }): Promise<void> => {
      if (command.type === 'delete' && !selectedStory()) { status.setText(L({ ko: '지울 머리말·꼬리말이 없습니다.', en: "No header/footer to delete." })); return; }
      for (const control of [isHeader, applyTo, template, remove, apply]) control.disabled = true;
      status.setText(command.type === 'delete' ? L({ ko: '머리말·꼬리말을 지우는 중…', en: "Deleting header/footer…" }) : L({ ko: '템플릿을 적용하는 중…', en: "Applying template…" }));
      try { await this.action(command); this.close(); }
      catch (error) {
        status.setText(LT({ ko: () => `머리말·꼬리말을 변경하지 못했습니다: ${String(error)}`, en: () => `Could not change header/footer: ${String(error)}` }));
        for (const control of [isHeader, applyTo, template, apply]) control.disabled = false;
        updateStatus();
      }
    };
    isHeader.addEventListener('change', updateStatus); applyTo.addEventListener('change', updateStatus); updateStatus();
    template.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class EndnoteShapeModal extends FocusReturnModal {
  constructor(app: App, private readonly initial: Record<string, unknown>, private readonly action: (properties: EndnoteShapeProperties) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('hwp-format-dialog');
    this.contentEl.createEl('h2', { text: L({ ko: '미주 모양', en: "Endnote format" }) });
    this.contentEl.createEl('p', { cls: 'hwp-hint', text: L({ ko: '현재 RHWP 코어은 미주 모양 설정을 제공합니다. 각주 모양은 이 엔진에서 변경할 수 없습니다.', en: "The current RHWP core provides endnote formatting. Footnote formatting cannot be changed in this engine." }) });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const row = (label: string, aria: string): HTMLDivElement => {
      const element = this.contentEl.createDiv({ cls: 'hwp-format-dialog-row' }); element.createEl('label', { text: label }); return element;
    };
    const select = (label: string, aria: string): HTMLSelectElement => row(label, aria).createEl('select', { attr: { 'aria-label': aria } });
    const numeric = (label: string, aria: string, value: number, min: number, max: number, step = '1'): HTMLInputElement => {
      const input = row(label, aria).createEl('input', { type: 'number', value: String(value), attr: { 'aria-label': aria, min: String(min), max: String(max), step } }); return input;
    };
    const numberFormat = select(L({ ko: '번호 형식', en: "Number format" }), L({ ko: '미주 번호 형식', en: "Endnote number format" }));
    for (const [value, label] of [['digit', '1, 2, 3'], ['circledDigit', '①, ②, ③'], ['upperRoman', 'I, II, III'], ['lowerRoman', 'i, ii, iii'], ['upperAlpha', 'A, B, C'], ['lowerAlpha', 'a, b, c'], ['hangulSyllable', '가, 나, 다'], ['hangulJamo', 'ㄱ, ㄴ, ㄷ'], ['hangulDigit', '일, 이, 삼'], ['hanjaDigit', '一, 二, 三']]) numberFormat.createEl('option', { value, text: label });
    numberFormat.value = typeof this.initial.numberFormat === 'string' ? this.initial.numberFormat : 'digit';
    if (!numberFormat.value) numberFormat.value = 'digit';
    const decoration = (label: string, aria: string, value: unknown, fallback: string): HTMLInputElement => {
      const input = row(label, aria).createEl('input', { type: 'text', value: typeof value === 'string' ? value : fallback, attr: { 'aria-label': aria, maxlength: '1' } }); return input;
    };
    const prefix = decoration(L({ ko: '앞 장식 문자', en: "Prefix character" }), L({ ko: '미주 번호 앞 장식 문자', en: "Endnote number prefix character" }), this.initial.prefixChar, '');
    const suffix = decoration(L({ ko: '뒤 장식 문자', en: "Suffix character" }), L({ ko: '미주 번호 뒤 장식 문자', en: "Endnote number suffix character" }), this.initial.suffixChar, ')');
    const start = numeric(L({ ko: '시작 번호', en: "Start number" }), L({ ko: '미주 시작 번호', en: "Endnote start number" }), typeof this.initial.startNumber === 'number' ? this.initial.startNumber : 1, 1, 32767);
    const separatorRow = row(L({ ko: '구분선', en: "Separator" }), L({ ko: '미주 구분선 사용', en: "Use endnote separator" }));
    const separator = separatorRow.createEl('input', { type: 'checkbox', attr: { 'aria-label': L({ ko: '미주 구분선 사용', en: "Use endnote separator" }) } }); separator.checked = this.initial.separatorEnabled !== false;
    separatorRow.createEl('label', { text: L({ ko: '구분선 사용', en: "Use separator" }) });
    const lineType = select(L({ ko: '구분선 종류', en: "Separator type" }), L({ ko: '미주 구분선 종류', en: "Endnote separator type" }));
    for (const [value, label] of [['1', L({ ko: '실선', en: "Solid line" })], ['2', L({ ko: '파선', en: "Dashed" })], ['3', L({ ko: '점선', en: "Dotted" })], ['4', L({ ko: '쇄선', en: "Dash-dot" })], ['5', L({ ko: '이점 쇄선', en: "Dash-dot-dot" })], ['6', L({ ko: '긴 파선', en: "Long dash" })], ['8', L({ ko: '이중선', en: "Double line" })], ['9', L({ ko: '얇고 굵은 이중선', en: "Thin-thick double line" })], ['10', L({ ko: '굵고 얇은 이중선', en: "Thick-thin double line" })], ['11', L({ ko: '삼중선', en: "Triple line" })]]) lineType.createEl('option', { value, text: label });
    lineType.value = String(typeof this.initial.separatorLineType === 'number' && this.initial.separatorLineType !== 0 ? this.initial.separatorLineType : 1);
    const lineWidth = select(L({ ko: '구분선 굵기', en: "Separator thickness" }), L({ ko: '미주 구분선 굵기', en: "Endnote separator thickness" }));
    for (const [value, label] of ['0.1', '0.12', '0.15', '0.2', '0.25', '0.3', '0.4', '0.5', '0.6', '0.7', '1', '1.5', '2', '3', '4', '5'].map((label, index) => [String(index), `${label} mm`] as const)) lineWidth.createEl('option', { value, text: label });
    lineWidth.value = String(typeof this.initial.separatorLineWidth === 'number' ? Math.min(15, Math.max(0, this.initial.separatorLineWidth)) : 1);
    const colorRow = row(L({ ko: '구분선 색', en: "Separator color" }), L({ ko: '미주 구분선 색', en: "Endnote separator color" }));
    const color = colorRow.createEl('input', { type: 'color', attr: { 'aria-label': L({ ko: '미주 구분선 색', en: "Endnote separator color" }) } });
    color.value = typeof this.initial.separatorColor === 'string' && /^#[0-9a-f]{6}$/i.test(this.initial.separatorColor) ? this.initial.separatorColor : '#000000';
    const mmField = (label: string, aria: string, key: string, defaultValue: number, max: number): HTMLInputElement => {
      const initial = this.initial[key];
      return numeric(label, aria, typeof initial === 'number' ? hwpUnitsToMillimeters(initial) : defaultValue, 0, max, '0.5');
    };
    const separatorLength = mmField(L({ ko: '구분선 길이 (mm)', en: "Separator length (mm)" }), L({ ko: '미주 구분선 길이 (mm)', en: "Endnote separator length (mm)" }), 'separatorLength', 50, 300);
    const marginTop = mmField(L({ ko: '구분선 위 간격 (mm)', en: "Space above separator (mm)" }), L({ ko: '미주 구분선 위 간격 (mm)', en: "Space above endnote separator (mm)" }), 'separatorMarginTop', 0, 100);
    const spacing = mmField(L({ ko: '미주 사이 간격 (mm)', en: "Space between endnotes (mm)" }), L({ ko: '미주 사이 간격 (mm)', en: "Space between endnotes (mm)" }), 'noteSpacing', 7, 100);
    const marginBottom = mmField(L({ ko: '구분선 아래 간격 (mm)', en: "Space below separator (mm)" }), L({ ko: '미주 구분선 아래 간격 (mm)', en: "Space below endnote separator (mm)" }), 'separatorMarginBottom', 2, 100);
    const numbering = select(L({ ko: '번호 매기기', en: "Numbering" }), L({ ko: '미주 번호 매기기', en: "Endnote numbering" }));
    numbering.createEl('option', { value: 'continue', text: L({ ko: '앞 구역에 이어서', en: "Continue from previous section" }) }); numbering.createEl('option', { value: 'restartSection', text: L({ ko: '현재 구역부터 새로 시작', en: "Restart at current section" }) }); numbering.createEl('option', { value: 'restartPage', text: L({ ko: '쪽마다 새로 시작', en: "Restart on each page" }) });
    numbering.value = typeof this.initial.numbering === 'string' ? this.initial.numbering : 'continue';
    const placement = select(L({ ko: '미주 위치', en: "Endnote position" }), L({ ko: '미주 위치', en: "Endnote position" }));
    placement.createEl('option', { value: 'documentEnd', text: L({ ko: '문서의 끝', en: "End of document" }) }); placement.createEl('option', { value: 'sectionEnd', text: L({ ko: '구역의 끝', en: "End of section" }) });
    placement.value = typeof this.initial.placement === 'string' ? this.initial.placement : 'documentEnd';
    const updateSeparator = (): void => { for (const control of [lineType, lineWidth, color, separatorLength]) control.disabled = !separator.checked; };
    separator.addEventListener('change', updateSeparator); updateSeparator();
    const buttons = this.contentEl.createDiv({ cls: 'hwp-format-dialog-buttons' });
    buttons.createEl('button', { text: L({ ko: '취소', en: "cancel" }) }).addEventListener('click', () => this.close());
    const apply = buttons.createEl('button', { text: L({ ko: '적용', en: "Apply" }), cls: 'mod-cta' });
    apply.addEventListener('click', () => {
      const values = [separatorLength, marginTop, spacing, marginBottom].map(input => Number(input.value));
      const maxima = [300, 100, 100, 100];
      const invalid = values.findIndex((value, index) => !Number.isFinite(value) || value < 0 || value > maxima[index]);
      if (invalid >= 0) { status.setText(L({ ko: '미주 간격은 입력란에 표시된 범위 안에서 입력하세요.', en: "Enter endnote spacing within the ranges shown in the fields." })); [separatorLength, marginTop, spacing, marginBottom][invalid].focus(); return; }
      const startNumber = Number(start.value);
      if (!Number.isSafeInteger(startNumber) || startNumber < 1 || startNumber > 32767) { status.setText(L({ ko: '미주 시작 번호는 1~32767 범위의 정수로 입력하세요.', en: "Enter an integer endnote start number from 1 to 32767." })); start.focus(); return; }
      const properties: EndnoteShapeProperties = {
        numberFormat: numberFormat.value, prefixChar: Array.from(prefix.value)[0] ?? '', suffixChar: Array.from(suffix.value)[0] ?? '', startNumber,
        separatorEnabled: separator.checked, separatorLineType: separator.checked ? Number(lineType.value) : 0,
        separatorLineWidth: separator.checked ? Number(lineWidth.value) : 0, separatorColor: color.value,
        separatorLength: millimetersToHwpUnits(values[0]), separatorMarginTop: millimetersToHwpUnits(values[1]),
        noteSpacing: millimetersToHwpUnits(values[2]), separatorMarginBottom: millimetersToHwpUnits(values[3]),
        numbering: numbering.value, placement: placement.value,
      };
      apply.disabled = true; status.setText(L({ ko: '미주 모양을 적용하는 중…', en: "Applying endnote format…" }));
      void this.action(properties).then(() => this.close()).catch(error => { status.setText(LT({ ko: () => `미주 모양을 적용하지 못했습니다: ${String(error)}`, en: () => `Could not apply endnote format: ${String(error)}` })); apply.disabled = false; });
    });
    numberFormat.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class ConfirmDiscard extends FocusReturnModal {
  constructor(app: App, private readonly action: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: L({ ko: '디스크 파일 다시 불러오기', en: "Reload disk file" }) });
    this.contentEl.createEl('p', { text: L({ ko: '현재 편집 세션과 미적용 입력을 버리고 디스크 파일을 다시 읽습니다. 변경을 보존하려면 먼저 새 파일로 저장하거나 입력 복구 목록에 보관하세요.', en: "Discards the current editing session and unapplied input, then rereads the disk file. To preserve changes, first save as a new file or keep the input in the recovery list." }) });
    const cancel = this.contentEl.createEl('button', { text: L({ ko: '취소', en: "cancel" }) }); cancel.onclick = () => this.close(); cancel.focus();
    const discard = this.contentEl.createEl('button', { text: L({ ko: '변경 버리고 불러오기', en: "Discard changes and reload" }), cls: 'mod-warning' });
    discard.onclick = () => { void this.action().then(() => this.close()).catch(error => new Notice(String(error))); };
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class ConfirmAnchoredDelete extends FocusReturnModal {
  private settled = false;
  constructor(app: App, private readonly resolve: (confirmed: boolean) => void) { super(app); }
  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true; this.resolve(confirmed); this.close();
  }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: L({ ko: '포함된 요소까지 삭제할까요?', en: "Delete included elements too?" }) });
    this.contentEl.createEl('p', { text: L({ ko: '선택 영역에 필드, 개체 또는 인라인 컨트롤이 있습니다. 계속하면 선택한 텍스트와 포함된 요소를 함께 삭제합니다.', en: "The selection contains fields, objects, or inline controls. Continuing deletes both the selected text and included elements." }) });
    const cancel = this.contentEl.createEl('button', { text: L({ ko: '취소', en: "cancel" }) });
    cancel.onclick = () => this.finish(false); cancel.focus();
    const confirm = this.contentEl.createEl('button', { text: L({ ko: '포함된 요소까지 삭제', en: "Delete included elements too" }), cls: 'mod-warning' });
    confirm.onclick = () => this.finish(true);
  }
  onClose(): void {
    if (!this.settled) { this.settled = true; this.resolve(false); }
    this.contentEl.empty(); this.restoreFocus();
  }
}

export class ConfirmInputDraftDiscard extends FocusReturnModal {
  constructor(app: App, private readonly action: () => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: L({ ko: '입력 복구본 폐기', en: "Discard input recovery copy" }) });
    this.contentEl.createEl('p', { text: L({ ko: '이 입력 복구본을 영구적으로 삭제합니다. 원본 문서에는 적용하지 않습니다.', en: "Permanently deletes this input recovery copy. Does not apply it to the original document." }) });
    const cancel = this.contentEl.createEl('button', { text: L({ ko: '취소', en: "cancel" }) }); cancel.onclick = () => this.close(); cancel.focus();
    const discard = this.contentEl.createEl('button', { text: L({ ko: '복구본 폐기', en: "Discard recovery copy" }), cls: 'mod-warning' });
    discard.onclick = () => { discard.disabled = true; void this.action().then(() => this.close()).catch(error => { new Notice(String(error), 8000); discard.disabled = false; }); };
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class DocumentChangesModal extends FocusReturnModal {
  constructor(app: App, private readonly openedText: string, private readonly currentText: string, private readonly draft?: { target: string; text: string }) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('hwp-change-modal');
    this.contentEl.createEl('h2', { text: L({ ko: '문서 텍스트 비교', en: "Compare document text" }) });
    this.contentEl.createEl('p', { cls: 'hwp-hint', text: L({ ko: '이 탭을 열었을 때의 텍스트와 현재 문서 텍스트를 비교합니다. 서식·표 모양·개체 배치는 텍스트 비교에 포함되지 않습니다.', en: "Compares text from when this tab opened with current document text. Formatting, table appearance, and object layout are excluded." }) });
    if (this.openedText === this.currentText && !this.draft) this.contentEl.createEl('p', { text: L({ ko: '텍스트 변경이 없습니다.', en: "No text changes." }) });
    else if (this.openedText !== this.currentText) {
      const change = textChangeRange(this.openedText, this.currentText);
      this.contentEl.createEl('p', { cls: 'hwp-hint', text: L({ ko: '처음과 끝의 공통 텍스트를 제외한 변경 구간입니다. 서로 떨어진 여러 변경이 하나의 구간으로 표시될 수 있습니다.', en: "Shows the changed span after excluding common text at the beginning/end. Multiple separate changes may appear as one span." }) });
      const diff = this.contentEl.createDiv({ cls: 'hwp-text-diff' });
      const removed = diff.createDiv(); removed.createEl('h3', { text: L({ ko: '삭제된 텍스트', en: "Deleted text" }) }); removed.createEl('pre', { text: change.removed || L({ ko: '(없음)', en: "(none)" }) });
      const added = diff.createDiv(); added.createEl('h3', { text: L({ ko: '추가된 텍스트', en: "Added text" }) }); added.createEl('pre', { text: change.added || L({ ko: '(없음)', en: "(none)" }) });
    }
    const columns = this.contentEl.createDiv({ cls: 'hwp-change-columns' });
    const before = columns.createDiv(); before.createEl('h3', { text: L({ ko: '탭을 열었을 때', en: "When tab opened" }) }); before.createEl('pre', { text: this.openedText || L({ ko: '(문서 텍스트가 비어 있습니다.)', en: "(Document text is empty.)" }) });
    const after = columns.createDiv(); after.createEl('h3', { text: L({ ko: '현재 적용된 문서', en: "Current applied document" }) }); after.createEl('pre', { text: this.currentText || L({ ko: '(문서 텍스트가 비어 있습니다.)', en: "(Document text is empty.)" }) });
    if (this.draft) {
      this.contentEl.createEl('h3', { text: L({ ko: `아직 적용하지 않은 입력 · ${this.draft.target}`, en: `Unapplied input · ${this.draft.target}` }) });
      this.contentEl.createEl('pre', { cls: 'hwp-change-draft', text: this.draft.text || L({ ko: '(빈 입력)', en: "(empty input)" }) });
    }
    const close = this.contentEl.createEl('button', { text: L({ ko: '닫기', en: "Close" }) }); close.onclick = () => this.close(); close.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
}

export class StorageCleanupModal extends FocusReturnModal {
  private statusEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  constructor(app: App, private readonly plugin: HwpHandsPlugin) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: L({ ko: '플러그인 보관 파일 정리', en: "Clean up plugin stored files" }) });
    this.contentEl.createEl('p', { text: L({ ko: '정리는 아래 후보만 삭제합니다. 문서별 최신 백업 3개와 24시간 이내 임시 파일은 남깁니다. 완성 복구 저널·입력 초안과 이전 형식 백업은 삭제 후보에 포함하지 않습니다.', en: "Deletes only the candidates below. Keeps three latest backups per document and temporary files from the last 24 hours. Complete recovery journals, input drafts, and legacy backups are excluded." }) });
    this.statusEl = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    this.actionsEl = this.contentEl.createDiv({ cls: 'hwp-edit-actions' });
    void this.refresh();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
  private async refresh(): Promise<void> {
    this.statusEl.setText(L({ ko: '정리 후보를 확인하는 중…', en: "Checking cleanup candidates…" })); this.actionsEl.empty();
    try {
      const plan = await this.plugin.manager.cleanupPlan();
      const backups = plan.candidates.filter(item => item.kind === 'backup');
      const temporary = plan.candidates.filter(item => item.kind === 'temporary');
      const bytes = plan.candidates.reduce((sum, item) => sum + item.bytes, 0);
      this.statusEl.setText(LT({ ko: () => `정리 후보: 백업 ${backups.length}개, 임시 파일 ${temporary.length}개, ${bytes.toLocaleString()}바이트. 남길 백업 ${plan.retainedBackups}개, 이전 형식 백업 ${plan.legacyBackups}개, 복구 저널 ${plan.recoveryRecords}개, 입력 초안 ${plan.inputDrafts}개.`, en: () => `Candidates: ${backups.length} backups, ${temporary.length} temporary files, ${bytes.toLocaleString()} bytes. Retained: ${plan.retainedBackups} backups, ${plan.legacyBackups} legacy backups, ${plan.recoveryRecords} recovery journals, ${plan.inputDrafts} input drafts.` }));
      const list = this.contentEl.createEl('ul');
      for (const item of plan.candidates.slice(0, 100)) list.createEl('li', { text: LT({ ko: () => `${item.path} · ${item.bytes.toLocaleString()}바이트 · ${item.reason}`, en: () => `${item.path} · ${item.bytes.toLocaleString()} bytes · ${item.reason}` }) });
      if (plan.candidates.length > 100) this.contentEl.createEl('p', { text: LT({ ko: () => `그 밖에 ${plan.candidates.length - 100}개 후보가 있습니다.`, en: () => `${plan.candidates.length - 100} additional candidates.` }) });
      const cancel = this.actionsEl.createEl('button', { text: L({ ko: '닫기', en: "Close" }) }); cancel.onclick = () => this.close();
      const cleanup = this.actionsEl.createEl('button', { text: L({ ko: '후보 파일 정리', en: "Clean up candidate files" }), cls: 'mod-warning' });
      cleanup.disabled = !plan.candidates.length;
      cleanup.onclick = () => {
        cleanup.disabled = true;
        void this.plugin.manager.cleanupStorage(plan.candidates.map(item => item.path))
          .then(async removed => { new Notice(LT({ ko: () => `${removed.length}개 보관 파일을 정리했습니다.`, en: () => `Cleaned up ${removed.length} stored files.` })); await this.refresh(); })
          .catch(error => { new Notice(LT({ ko: () => `정리하지 못했습니다: ${String(error)}`, en: () => `Could not clean up: ${String(error)}` }), 8000); cleanup.disabled = false; });
      };
    } catch (error) {
      this.statusEl.setText(LT({ ko: () => `정리 후보를 읽지 못했습니다: ${String(error)}`, en: () => `Could not read cleanup candidates: ${String(error)}` }));
      this.plugin.report(error);
    }
  }
}

export class InputDraftRecoveryModal extends FocusReturnModal {
  private entries: InputDraftEntry[] = [];
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private statusEl!: HTMLElement;
  constructor(app: App, private readonly plugin: HwpHandsPlugin) { super(app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: L({ ko: '미적용 입력 복구', en: "Recover unapplied input" }) });
    this.contentEl.createEl('p', { text: L({ ko: '복구본은 원본 문서에 자동 적용하지 않습니다. 내용을 확인한 뒤 텍스트 사본으로 저장하거나 폐기하세요.', en: "Recovery copies are not applied automatically. Inspect their content, then save as text copies or discard." }) });
    this.statusEl = this.contentEl.createDiv({ cls: 'hwp-draft-status', attr: { role: 'status', 'aria-live': 'polite' } });
    const layout = this.contentEl.createDiv({ cls: 'hwp-draft-recovery' });
    this.listEl = layout.createDiv({ cls: 'hwp-draft-list' });
    this.detailEl = layout.createDiv({ cls: 'hwp-draft-preview' });
    void this.refreshList();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
  private async refreshList(): Promise<void> {
    this.statusEl.setText(L({ ko: '입력 복구본을 읽는 중…', en: "Reading input recovery copies…" }));
    try {
      this.entries = await this.plugin.listInputDrafts();
      this.listEl.empty(); this.detailEl.empty();
      if (!this.entries.length) { this.statusEl.setText(L({ ko: '보관된 입력 복구본이 없습니다.', en: "No stored input recovery copies." })); return; }
      this.statusEl.setText(LT({ ko: () => `${this.entries.length}개 복구본`, en: () => `${this.entries.length} recovery copies` }));
      for (const entry of this.entries) {
        const button = this.listEl.createEl('button', { cls: 'hwp-draft-entry' });
        if (entry.record) {
          button.createEl('strong', { text: entry.record.path });
          button.createEl('span', { text: `${new Date(entry.record.createdAt).toLocaleString()} · ${inputDraftTargetLabel(entry.record.target)}` });
        } else {
          button.createEl('strong', { text: L({ ko: '읽을 수 없는 복구본', en: "Unreadable recovery copy" }) });
          button.createEl('span', { text: entry.error ?? L({ ko: '복구본 형식이 올바르지 않습니다.', en: "Invalid recovery copy format." }) });
        }
        button.onclick = () => this.showEntry(entry);
      }
      this.showEntry(this.entries[0]);
    } catch (error) {
      this.statusEl.setText(LT({ ko: () => `복구 목록을 읽지 못했습니다: ${String(error)}`, en: () => `Could not read recovery list: ${String(error)}` }));
      this.plugin.report(error);
    }
  }
  private showEntry(entry: InputDraftEntry): void {
    this.detailEl.empty();
    if (!entry.record) {
      this.detailEl.createEl('h3', { text: L({ ko: '읽을 수 없는 복구본', en: "Unreadable recovery copy" }) });
      this.detailEl.createEl('p', { text: entry.error ?? L({ ko: '복구본 형식이 올바르지 않습니다.', en: "Invalid recovery copy format." }) });
      this.addDiscardButton(entry);
      return;
    }
    const record = entry.record;
    const target = record.target && typeof record.target === 'object' ? record.target as Record<string, unknown> : undefined;
    this.detailEl.createEl('h3', { text: L({ ko: '입력 미리보기', en: "Input preview" }) });
    this.detailEl.createEl('p', { text: LT({ ko: () => `원본: ${record.path}`, en: () => `Original: ${record.path}` }) });
    this.detailEl.createEl('p', { text: LT({ ko: () => `대상: ${inputDraftTargetLabel(record.target)} · 기록 revision ${record.revision} · ${new Date(record.createdAt).toLocaleString()}`, en: () => `Target: ${inputDraftTargetLabel(record.target)} · recorded revision ${record.revision} · ${new Date(record.createdAt).toLocaleString()}` }) });
    const original = target && typeof target.text === 'string' ? target.text : target && typeof target.value === 'string' ? target.value : undefined;
    if (original !== undefined) {
      this.detailEl.createEl('h4', { text: L({ ko: '입력 전 내용', en: "Before input" }) });
      this.detailEl.createEl('pre', { cls: 'hwp-draft-text', text: original });
    }
    this.detailEl.createEl('h4', { text: L({ ko: '미적용 입력', en: "Unapplied input" }) });
    this.detailEl.createEl('pre', { cls: 'hwp-draft-text', text: record.value });
    const actions = this.detailEl.createDiv({ cls: 'hwp-edit-actions' });
    const restore = actions.createEl('button', { text: L({ ko: '텍스트 사본으로 복구', en: "Recover as text copy" }), cls: 'mod-cta' });
    restore.onclick = () => {
      const source = record.path.split('/').at(-1)?.replace(/\.(hwp|hwpx)$/i, '') || L({ ko: 'HWP 입력', en: "HWP input" });
      new PathModal(this.app, L({ ko: '사본을 저장할 Vault 경로 (.txt)', en: "Vault path for text copy (.txt)" }), LT({ ko: () => `${source} - 입력 복구.txt`, en: () => `${source} - Input recovery.txt` }), async destination => {
        const created = await this.plugin.restoreInputDraftAsCopy(entry.id, destination);
        new Notice(LT({ ko: () => `입력을 텍스트 사본으로 저장했습니다: ${created}`, en: () => `Saved input as text copy: ${created}` }), 8000);
      }).open();
    };
    this.addDiscardButton(entry, actions);
  }
  private addDiscardButton(entry: InputDraftEntry, parent = this.detailEl): void {
    const discard = parent.createEl('button', { text: L({ ko: '복구본 폐기', en: "Discard recovery copy" }), cls: 'mod-warning' });
    discard.onclick = () => new ConfirmInputDraftDiscard(this.app, async () => {
      await this.plugin.discardInputDraft(entry.id);
      await this.refreshList();
    }).open();
  }
}


export type SaveOnCloseChoice = 'save' | 'discard' | 'reopen' | 'later';
/** Asked once after the last view of an unsaved document closed (decision 69). Dismissing keeps the working copy and its recovery record. */
export class SaveOnCloseModal extends FocusReturnModal {
  private settled = false;
  constructor(app: App, private readonly name: string, private readonly conflict: boolean, private readonly resolve: (choice: SaveOnCloseChoice) => void) { super(app); }
  private finish(choice: SaveOnCloseChoice): void {
    if (this.settled) return;
    this.settled = true; this.resolve(choice); this.close();
  }
  onOpen(): void {
    this.titleEl.setText(L({ ko: '변경 사항을 저장하겠습니까?', en: "Save changes?" }));
    this.contentEl.createEl('p', { text: this.conflict
      ? LT({ ko: () => `「${this.name}」의 디스크 파일이 편집 중에 바뀌어 원본에 바로 저장할 수 없습니다. 다시 열어 새 파일로 저장하거나, 변경을 버리세요.`, en: () => `The disk file for “${this.name}” changed during editing and cannot be overwritten directly. Reopen and save as a new file, or discard changes.` })
      : LT({ ko: () => `「${this.name}」에 저장하지 않은 변경이 있습니다. 저장하지 않으면 원본은 그대로 두고 변경과 되돌리기 기록을 버립니다.`, en: () => `“${this.name}” has unsaved changes. If you do not save, the original remains and changes/undo history are discarded.` }) });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    if (!this.conflict) { const save = actions.createEl('button', { text: L({ ko: '저장', en: "Save" }), cls: 'mod-cta' }); save.onclick = () => this.finish('save'); save.focus(); }
    const discard = actions.createEl('button', { text: L({ ko: '저장 안 함', en: "Don't save" }), cls: 'mod-warning' }); discard.onclick = () => this.finish('discard');
    const reopen = actions.createEl('button', { text: L({ ko: '취소 (다시 열기)', en: "Cancel (reopen)" }) }); reopen.onclick = () => this.finish('reopen');
    if (this.conflict) reopen.focus();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); if (!this.settled) { this.settled = true; this.resolve('later'); } }
}

export type RecoveredChangesChoice = 'keep' | 'discard' | 'save-as';
/** Asked once when a document opens with unsaved changes replayed from an earlier run that ended without the close prompt. */
export class RecoveredChangesModal extends FocusReturnModal {
  private settled = false;
  constructor(app: App, private readonly name: string, private readonly resolve: (choice: RecoveredChangesChoice) => void) { super(app); }
  private finish(choice: RecoveredChangesChoice): void {
    if (this.settled) return;
    this.settled = true; this.resolve(choice); this.close();
  }
  onOpen(): void {
    this.titleEl.setText(L({ ko: '저장 안 된 편집이 있습니다', en: "Unsaved edits found" }));
    this.contentEl.createEl('p', { text: LT({ ko: () => `「${this.name}」은 지난번에 저장하지 않은 채 종료되었습니다. 그때의 편집을 복원할까요? 버리면 디스크의 원본을 엽니다.`, en: () => `“${this.name}” was closed without saving last time. Restore those edits? Discarding opens the disk original.` }) });
    this.contentEl.createEl('p', { text: L({ ko: '어느 쪽이 맞는지 모르겠다면 다른 이름으로 저장하세요. 복원한 편집은 새 파일로 저장되고 이 문서는 디스크의 원본으로 열리므로, 두 파일을 열어 비교한 뒤 고를 수 있습니다.', en: "If unsure which version is correct, use Save As. Recovered edits are saved to a new file and this document opens from disk; compare both files before choosing." }) });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const keep = actions.createEl('button', { text: L({ ko: '복원', en: "Restore" }), cls: 'mod-cta' }); keep.onclick = () => this.finish('keep'); keep.focus();
    const saveAs = actions.createEl('button', { text: L({ ko: '다른 이름으로 저장', en: "Save As" }) }); saveAs.onclick = () => this.finish('save-as');
    const discard = actions.createEl('button', { text: L({ ko: '버리기', en: "Discard" }), cls: 'mod-warning' }); discard.onclick = () => this.finish('discard');
  }
  // Dismissing keeps the restored changes: nothing is thrown away without an explicit choice.
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); if (!this.settled) { this.settled = true; this.resolve('keep'); } }
}

import { LT, L, getLocale, type Locale } from '../../i18n/locale';
import { EDITOR_MENU_DEFINITION, HEADER_FOOTER_TEMPLATES, headerFooterCommandId, type MenuDefinitionItem } from '../shell/menu-definition';

export interface EditorCommand {
  id: string;
  label: string;
  shortcut?: string;
  isAvailable?: () => boolean;
  unavailableReason?: () => string | undefined;
  run: () => unknown;
}

export const EDITOR_COMMAND_CATALOG = [
  { id: 'story.previous', label: L({ ko: '이전 영역', en: "Previous area" }) },
  { id: 'story.next', label: L({ ko: '다음 영역', en: "Next area" }) },
  { id: 'story.close', label: L({ ko: '편집 닫기', en: "Close editing" }) },
  { id: 'story.delete', label: L({ ko: '영역 지우기', en: "Delete area" }) },
  { id: 'story.page-number', label: L({ ko: '쪽 번호', en: "Page number" }) },
  { id: 'story.total-pages', label: L({ ko: '총 쪽수', en: "Total pages" }) },
  { id: 'story.file-name', label: L({ ko: '파일 이름', en: "File name" }) },
  ...[true, false].flatMap(isHeader => [0, 2, 1].flatMap(applyTo => HEADER_FOOTER_TEMPLATES.map((label, templateId) => ({
    id: headerFooterCommandId(isHeader, applyTo, templateId), label: LT({ ko: () => `${isHeader ? L({ ko: '머리말', en: "header" }) : L({ ko: '꼬리말', en: "footer" })}: ${label}`, en: () => `${isHeader ? 'Header' : 'Footer'}: ${label}` }),
  })))),
  { id: 'page.edit-header', label: L({ ko: '머리말 편집…', en: "Edit header…" }) },
  { id: 'page.edit-footer', label: L({ ko: '꼬리말 편집…', en: "Edit footer…" }) },
  { id: 'file.new-document', label: L({ ko: '새 HWPX 문서', en: "New HWPX document" }), shortcut: 'Alt+N' },
  { id: 'file.open', label: L({ ko: 'HWP/HWPX 문서 열기', en: "Open HWP/HWPX document" }) },
  { id: 'file.save', label: L({ ko: '저장', en: "Save" }), shortcut: 'Mod+S' },
  { id: 'file.save-as', label: L({ ko: '새 파일로 저장', en: "Save as new file" }), shortcut: 'Mod+Shift+S' },
  { id: 'file.save-hwp', label: L({ ko: 'HWP 형식으로 저장…', en: "Save as HWP…" }) },
  { id: 'file.save-hwpx', label: L({ ko: 'HWPX 형식으로 저장…', en: "Save as HWPX…" }) },
  { id: 'file.print', label: L({ ko: '인쇄 / PDF로 저장', en: "Print / Save as PDF" }) },
  { id: 'file.reload', label: L({ ko: '다시 불러오기', en: "Reload" }) },
  { id: 'file.refresh-index', label: L({ ko: '검색 인덱스 갱신', en: "Refresh search index" }) },
  { id: 'edit.undo', label: L({ ko: '되돌리기', en: "Undo" }), shortcut: 'Mod+Z' },
  { id: 'edit.redo', label: L({ ko: '다시 실행', en: "Redo" }), shortcut: 'Mod+Shift+Z' },
  { id: 'edit.cut', label: L({ ko: '오려두기', en: "Cut" }), shortcut: 'Mod+X' },
  { id: 'edit.copy', label: L({ ko: '복사', en: "Copy" }), shortcut: 'Mod+C' },
  { id: 'edit.paste', label: L({ ko: '붙이기', en: "Paste" }), shortcut: 'Mod+V' },
  { id: 'edit.compare', label: L({ ko: '변경 비교', en: "Compare changes" }), shortcut: 'Alt+Shift+V' },
  { id: 'edit.document-history', label: L({ ko: '문서 이력 관리', en: "Document history" }) },
  { id: 'edit.recover-input', label: L({ ko: '미적용 입력 복구', en: "Recover unapplied input" }) },
  { id: 'insert.picture-file', label: L({ ko: '그림', en: "Picture" }) },
  { id: 'insert.equation-dialog', label: L({ ko: '수식', en: "Equation" }) },
  { id: 'insert.shape-draw', label: L({ ko: '도형 그리기', en: "Draw shape" }) },
  { id: 'insert.text-box-draw', label: L({ ko: '글상자 그리기', en: "Draw text box" }) },
  { id: 'insert.caption-top', label: L({ ko: '캡션 위', en: "Caption above" }) },
  { id: 'insert.caption-bottom', label: L({ ko: '캡션 아래', en: "Caption below" }) },
  { id: 'insert.caption-left', label: L({ ko: '캡션 왼쪽', en: "Caption left" }) },
  { id: 'insert.caption-right', label: L({ ko: '캡션 오른쪽', en: "Caption right" }) },
  { id: 'insert.caption-none', label: L({ ko: '캡션 없음', en: "No caption" }) },
  { id: 'edit.delete', label: L({ ko: '지우기', en: "Delete" }), shortcut: 'Ctrl+E' },
  { id: 'edit.select-all', label: L({ ko: '모두 선택', en: "Select all" }), shortcut: 'Mod+A' },
  { id: 'format.align-left', label: L({ ko: '왼쪽 정렬', en: "Align left" }), shortcut: 'Ctrl+Shift+L' },
  { id: 'format.align-center', label: L({ ko: '가운데 정렬', en: "Align center" }), shortcut: 'Alt+Shift+C' },
  { id: 'format.align-right', label: L({ ko: '오른쪽 정렬', en: "Align right" }), shortcut: 'Alt+Shift+H' },
  { id: 'format.align-justify', label: L({ ko: '양쪽 정렬', en: "Justify" }), shortcut: 'Ctrl+Shift+M' },
  { id: 'format.align-distribute', label: L({ ko: '배분 정렬', en: "Distribute" }), shortcut: 'Alt+Shift+D' },
  { id: 'format.align-split', label: L({ ko: '나눔 정렬', en: "Split alignment" }) },
  { id: 'view.toggle-format-toolbox', label: L({ ko: '서식 도구줄 접기/펴기', en: "Collapse/expand formatting toolbar" }) },
  { id: 'view.toggle-all-chrome', label: L({ ko: '메뉴 모두 접기/펴기', en: "Collapse/expand all menus" }), shortcut: 'Ctrl+Shift+F1' },
  { id: 'view.previous-page', label: L({ ko: '이전 쪽', en: "Previous page" }) },
  { id: 'view.next-page', label: L({ ko: '다음 쪽', en: "Next page" }) },
  { id: 'view.fit-width', label: L({ ko: '폭 맞춤', en: "Fit width" }) },
  { id: 'view.fit-page', label: L({ ko: '쪽 맞춤', en: "Fit page" }) },
  { id: 'view.zoom-in', label: L({ ko: '확대', en: "Zoom in" }) },
  { id: 'view.zoom-out', label: L({ ko: '축소', en: "Zoom out" }) },
  ...[50, 75, 100, 125, 150, 200, 300].map(percent => ({ id: `view.zoom-${percent}`, label: `${percent}%` })),
  { id: 'file.about', label: L({ ko: '제품 정보', en: "About" }) },
  { id: 'tool.settings', label: L({ ko: '환경 설정', en: "Preferences" }) },
  { id: 'view.form-mode', label: L({ ko: '양식 모드', en: "Form mode" }) },
  { id: 'view.toggle-toolbars', label: L({ ko: '도구 상자 접기/펴기', en: "Collapse/expand toolbox" }), shortcut: 'Ctrl+F1' },
  { id: 'view.go-to-page', label: L({ ko: '쪽 번호 입력', en: "Enter page number" }), shortcut: 'Alt+G' },
  { id: 'view.go-to-bookmark', label: L({ ko: '책갈피로 이동', en: "Go to bookmark" }) },
  { id: 'view.ruler', label: L({ ko: '눈금자', en: "Ruler" }) },
  { id: 'view.grid', label: L({ ko: '격자 보기', en: "Show grid" }) },
  { id: 'view.grid-settings', label: L({ ko: '격자 설정', en: "Grid settings" }) },
  { id: 'view.paragraph-marks', label: L({ ko: '문단 부호', en: "Paragraph marks" }) },
  { id: 'view.control-codes', label: L({ ko: '조판 부호', en: "Control codes" }) },
  { id: 'view.transparent-borders', label: L({ ko: '투명 선', en: "Transparent borders" }) },
  { id: 'view.overflow', label: L({ ko: '잘림 보기', en: "Show clipping" }) },
  { id: 'insert.paragraph', label: L({ ko: '새 문단', en: "New paragraph" }) },
  { id: 'insert.table', label: L({ ko: '표 삽입', en: "Insert table" }) },
  { id: 'insert.table-custom', label: L({ ko: '사용자 지정 표 삽입', en: "Insert custom table" }) },
  { id: 'insert.clickhere-field', label: L({ ko: '누름틀 삽입', en: "Insert input field" }) },
  { id: 'field.edit', label: L({ ko: '필드 고치기', en: "Edit field" }) },
  { id: 'field.remove', label: L({ ko: '필드 지우기', en: "Delete field" }) },
  { id: 'insert.character-table', label: L({ ko: '문자표', en: "Character map" }), shortcut: 'Alt+F10' },
  { id: 'insert.page-break', label: L({ ko: '쪽 나누기', en: "Page break" }), shortcut: 'Mod+Enter' },
  { id: 'insert.column-break', label: L({ ko: '단 나누기', en: "Column break" }), shortcut: 'Mod+Shift+Enter' },
  { id: 'insert.footnote', label: L({ ko: '각주 삽입', en: "Insert footnote" }) },
  { id: 'insert.endnote', label: L({ ko: '미주 삽입', en: "Insert endnote" }) },
  { id: 'insert.endnote-shape', label: L({ ko: '미주 모양', en: "Endnote format" }) },
  { id: 'insert.bookmark', label: L({ ko: '책갈피', en: "Bookmark" }) },
  { id: 'format.bold', label: L({ ko: '굵게', en: "Bold" }), shortcut: 'Mod+B' },
  { id: 'format.italic', label: L({ ko: '기울임', en: "Italic" }), shortcut: 'Mod+I' },
  { id: 'format.underline', label: L({ ko: '밑줄', en: "Underline" }), shortcut: 'Mod+U' },
  { id: 'format.strikethrough', label: L({ ko: '취소선', en: "Strikethrough" }) },
  { id: 'format.emboss', label: L({ ko: '양각', en: "Emboss" }) },
  { id: 'format.engrave', label: L({ ko: '음각', en: "Engrave" }) },
  { id: 'format.outline', label: L({ ko: '외곽선', en: "Outline" }) },
  { id: 'format.superscript', label: L({ ko: '위 첨자', en: "Superscript" }) },
  { id: 'format.subscript', label: L({ ko: '아래 첨자', en: "Subscript" }) },
  { id: 'format.font-size-increase', label: L({ ko: '글자 크기 늘리기', en: "Increase font size" }), shortcut: 'Alt+Shift+E', aliases: ['Mod+]'] },
  { id: 'format.font-size-decrease', label: L({ ko: '글자 크기 줄이기', en: "Decrease font size" }), shortcut: 'Alt+Shift+R', aliases: ['Mod+['] },
  { id: 'format.ratio-increase', label: L({ ko: '장평 늘리기', en: "Increase character width" }), shortcut: 'Mod+Shift+]' },
  { id: 'format.ratio-decrease', label: L({ ko: '장평 줄이기', en: "Decrease character width" }), shortcut: 'Mod+Shift+[' },
  { id: 'format.character-spacing-increase', label: L({ ko: '자간 넓히기', en: "Increase character spacing" }), shortcut: 'Mod+Alt+]' },
  { id: 'format.character-spacing-decrease', label: L({ ko: '자간 좁히기', en: "Decrease character spacing" }), shortcut: 'Mod+Alt+[' },
  { id: 'format.copy-style', label: L({ ko: '모양 복사', en: "Copy formatting" }), shortcut: 'Alt+C' },
  { id: 'format.apply-copied-style', label: L({ ko: '모양 붙이기', en: "Paste formatting" }) },
  { id: 'format.character-dialog', label: L({ ko: '글자 모양', en: "Character format" }), shortcut: 'Alt+L' },
  { id: 'format.paragraph-dialog', label: L({ ko: '문단 모양', en: "Paragraph format" }), shortcut: 'Alt+T' },
  { id: 'format.style-dialog', label: L({ ko: '문단 스타일', en: "paragraph style" }), shortcut: 'F6' },
  { id: 'format.style-new', label: L({ ko: '스타일 추가', en: "add style" }) },
  { id: 'format.style-edit', label: L({ ko: '스타일 편집', en: "edit style" }) },
  { id: 'format.style-delete', label: L({ ko: '스타일 지우기', en: "Clear style" }) },
  { id: 'format.numbering-define', label: L({ ko: '문단 번호 모양', en: "Paragraph numbering format" }) },
  { id: 'format.line-spacing-decrease', label: L({ ko: '줄 간격 줄이기', en: "Decrease line spacing" }), shortcut: 'Alt+Shift+A', aliases: ['Mod+Shift+Alt+['] },
  { id: 'format.line-spacing-increase', label: L({ ko: '줄 간격 늘리기', en: "Increase line spacing" }), shortcut: 'Alt+Shift+Z', aliases: ['Mod+Shift+Alt+]'] },
  { id: 'format.toggle-numbering', label: L({ ko: '번호 목록 토글', en: "Toggle numbering" }) },
  { id: 'format.toggle-bullet', label: L({ ko: '글머리표 토글', en: "Toggle bullets" }) },
  { id: 'format.list-level-down', label: L({ ko: '목록 수준 내리기', en: "Demote list level" }) },
  { id: 'format.list-level-up', label: L({ ko: '목록 수준 올리기', en: "Promote list level" }) },
  { id: 'page.apply-settings', label: L({ ko: '쪽 설정 적용', en: "Apply page settings" }) },
  { id: 'page.setup-dialog', label: L({ ko: '편집 용지', en: "Page setup" }), shortcut: 'F7' },
  { id: 'page.footer-template', label: L({ ko: '꼬리말', en: "footer" }) },
  { id: 'insert.hyperlink', label: L({ ko: '하이퍼링크', en: "Hyperlink" }) },
  { id: 'page.header-footer-template', label: L({ ko: '머리말 / 꼬리말', en: "Header / Footer" }) },
  { id: 'page.columns', label: L({ ko: '다단 설정', en: "Column settings" }), shortcut: 'Ctrl+Alt+Enter' },
  { id: 'page.columns-one', label: L({ ko: '단 하나', en: "One column" }) },
  { id: 'page.columns-two', label: L({ ko: '단 둘', en: "Two columns" }) },
  { id: 'page.columns-three', label: L({ ko: '단 셋', en: "Three columns" }) },
  { id: 'page.border-fill', label: L({ ko: '쪽 테두리 / 배경', en: "Page border / Background" }) },
  { id: 'page.section-settings', label: L({ ko: '구역 설정', en: "Section settings" }) },
  { id: 'page.hide', label: L({ ko: '현재 쪽 감추기', en: "Hide on current page" }) },
  { id: 'page.new-number', label: L({ ko: '새 번호로 시작', en: "Restart numbering" }) },
  { id: 'table.merge-cells', label: L({ ko: '선택 셀 병합', en: "Merge selected cells" }) },
  { id: 'table.split-cell', label: L({ ko: '선택 셀 나누기', en: "Split selected cells" }) },
  { id: 'table.thousands', label: L({ ko: '1,000 단위 구분 쉼표', en: "Thousands separator" }) },
  { id: 'table.decimal-add', label: L({ ko: '자릿점 넣기', en: "Add decimal place" }) },
  { id: 'table.decimal-remove', label: L({ ko: '자릿점 빼기', en: "Remove decimal place" }) },
  { id: 'table.borders-each', label: L({ ko: '각 셀마다 적용', en: "Apply to each cell" }) },
  { id: 'table.borders-outside', label: L({ ko: '하나의 셀처럼 적용', en: "Apply as one cell" }) },
  { id: 'table.cell-properties', label: L({ ko: '표 / 셀 속성', en: "Table / Cell properties" }) },
  { id: 'table.formula', label: L({ ko: '계산식', en: "Formula" }) },
  { id: 'table.block-sum', label: L({ ko: '블록 합계', en: "Block sum" }) },
  { id: 'table.block-average', label: L({ ko: '블록 평균', en: "Block average" }) },
  { id: 'table.block-product', label: L({ ko: '블록 곱', en: "Block product" }) },
  { id: 'table.transpose', label: L({ ko: '행/열 바꿈', en: "Transpose rows/columns" }) },
  { id: 'table.split-table', label: L({ ko: '표 나누기', en: "Split table" }) },
  { id: 'table.merge-next', label: L({ ko: '표 붙이기', en: "Join tables" }) },
  { id: 'table.delete', label: L({ ko: '표 지우기', en: "Delete table" }) },
  { id: 'table.caption-toggle', label: L({ ko: '표 캡션 넣기/빼기', en: "Add/remove table caption" }) },
  { id: 'table.equalize-widths', label: L({ ko: '셀 너비를 같게', en: "Equalize cell widths" }) },
  { id: 'table.equalize-heights', label: L({ ko: '셀 높이를 같게', en: "Equalize cell heights" }) },
  { id: 'table.insert-row-above', label: L({ ko: '위에 행 삽입', en: "Insert row above" }) },
  { id: 'table.insert-dialog', label: L({ ko: '줄/칸 추가하기…', en: "Add rows/columns…" }), shortcut: 'Alt+Enter' },
  { id: 'table.delete-dialog', label: L({ ko: '줄/칸 지우기…', en: "Delete rows/columns…" }), shortcut: 'Alt+Delete' },
  { id: 'table.insert-row-below', label: L({ ko: '아래에 행 삽입', en: "Insert row below" }) },
  { id: 'table.delete-row', label: L({ ko: '행 삭제', en: "Delete row" }) },
  { id: 'table.insert-column-left', label: L({ ko: '왼쪽에 칸 삽입', en: "Insert column left" }) },
  { id: 'table.insert-column-right', label: L({ ko: '오른쪽에 칸 삽입', en: "Insert column right" }) },
  { id: 'table.delete-column', label: L({ ko: '칸 삭제', en: "Delete column" }) },
  { id: 'object.edit-properties', label: L({ ko: '선택 개체 속성', en: "Selected object properties" }) },
  { id: 'object.delete', label: L({ ko: '선택 개체 삭제', en: "Delete selected object" }) },
  { id: 'object.rotate', label: L({ ko: '개체 회전', en: "Rotate object" }) },
  { id: 'object.rotate-right', label: L({ ko: '오른쪽 90° 회전', en: "Rotate 90° right" }) },
  { id: 'object.rotate-left', label: L({ ko: '왼쪽 90° 회전', en: "Rotate 90° left" }) },
  { id: 'object.flip-horizontal', label: L({ ko: '좌우 대칭', en: "Flip horizontally" }) },
  { id: 'object.flip-vertical', label: L({ ko: '상하 대칭', en: "Flip vertically" }) },
  { id: 'object.caption-toggle', label: L({ ko: '그림 캡션 넣기/빼기', en: "Add/remove picture caption" }) },
  { id: 'object.z-front', label: L({ ko: '맨 앞으로', en: "Bring to front" }) },
  { id: 'object.z-forward', label: L({ ko: '앞으로', en: "Bring forward" }) },
  { id: 'object.z-backward', label: L({ ko: '뒤로', en: "Send backward" }) },
  { id: 'object.z-back', label: L({ ko: '맨 뒤로', en: "Send to back" }) },
  { id: 'object.z-in-front-of-text', label: L({ ko: '글 앞으로', en: "In front of text" }) },
  { id: 'object.z-behind-text', label: L({ ko: '글 뒤로', en: "Behind text" }) },
  { id: 'object.group', label: L({ ko: '개체 묶기', en: "Group objects" }) },
  { id: 'object.ungroup', label: L({ ko: '개체 풀기', en: "Ungroup objects" }) },
  { id: 'tool.find', label: L({ ko: '찾기', en: "Find" }), shortcut: 'Mod+F' },
  { id: 'tool.replace', label: L({ ko: '바꾸기', en: "Replace" }), shortcut: 'Ctrl+F2', aliases: ['Mod+H'] },
  { id: 'tool.replace-current', label: L({ ko: '현재 검색 결과 바꾸기', en: "Replace current match" }) },
  { id: 'tool.next-search-result', label: L({ ko: '다음 검색 결과', en: "Next match" }), shortcut: 'Mod+L' },
] as const;

export type EditorCommandId = typeof EDITOR_COMMAND_CATALOG[number]['id'];

/** Editor commands omitted from the Obsidian command palette (covered by global commands, duplicated, or always disabled). */
export const EXCLUDED_PALETTE_COMMAND_IDS: ReadonlySet<string> = new Set([
  'file.save',
  'file.refresh-index',
  'file.new-document',
  'file.open',
  'edit.recover-input',
  'view.toggle-all-chrome',
  'edit.document-history',
  'insert.hyperlink',
]);

const ID_PREFIX_CATEGORIES: Readonly<Record<string, { ko: string; en: string }>> = {
  file: { ko: '파일', en: "File" },
  edit: { ko: '편집', en: "Edit" },
  view: { ko: '보기', en: "View" },
  insert: { ko: '입력', en: "Insert" },
  format: { ko: '서식', en: "Format" },
  page: { ko: '쪽', en: "Page" },
  table: { ko: '표', en: "Table" },
  object: { ko: '개체', en: "Object" },
  field: { ko: '필드', en: "Field" },
  story: { ko: '영역', en: "Area" },
  tool: { ko: '도구', en: "Tools" },
};

const MENU_CATEGORY_BY_COMMAND = (() => {
  const map = new Map<string, string>();
  const walk = (items: readonly MenuDefinitionItem[], category: string): void => {
    for (const item of items) {
      if (item.kind === 'command') { if (!map.has(item.id)) map.set(item.id, category); }
      else if (item.kind === 'submenu') walk(item.items, category);
    }
  };
  for (const group of EDITOR_MENU_DEFINITION) walk(group.items, group.label);
  return map;
})();

function paletteCategory(id: string, locale: Locale): string | undefined {
  const fromMenu = MENU_CATEGORY_BY_COMMAND.get(id);
  if (fromMenu) return fromMenu;
  const prefix = id.split('.')[0] ?? '';
  const entry = ID_PREFIX_CATEGORIES[prefix];
  return entry ? L(entry, locale) : undefined;
}

/** Formats an editor command name for the Obsidian command palette without changing its catalog label. */
export function paletteName(command: { id: string; label: string }, locale: Locale = getLocale()): string {
  const zoom = /^view\.zoom-(\d+)$/.exec(command.id);
  if (zoom) return LT({ ko: () => `보기: 배율 ${zoom[1]}%`, en: () => `View: Zoom ${zoom[1]}%` }, locale);
  const headerFooter = /^page\.(?:header|footer)-([012])-template-\d+$/.exec(command.id);
  if (headerFooter) {
    const scope = headerFooter[1] === '0'
      ? L({ ko: '양쪽', en: 'both pages' }, locale)
      : headerFooter[1] === '2'
        ? L({ ko: '홀수 쪽', en: 'odd pages' }, locale)
        : L({ ko: '짝수 쪽', en: 'even pages' }, locale);
    return `${command.label} (${scope})`;
  }
  if (/^[a-z]/.test(command.label)) {
    const category = paletteCategory(command.id, locale);
    const sentence = `${command.label.charAt(0).toUpperCase()}${command.label.slice(1)}`;
    return category ? `${category}: ${sentence}` : sentence;
  }
  return command.label;
}

export function editorCommandDefinition(id: string): typeof EDITOR_COMMAND_CATALOG[number] | undefined {
  return EDITOR_COMMAND_CATALOG.find(command => command.id === id);
}

/** Keeps editor actions addressable from menus, view shortcuts and Obsidian commands. */
export class CommandRegistry {
  private readonly commands = new Map<string, EditorCommand>();

  register(command: EditorCommand): void {
    if (!command || typeof command !== 'object' || !/^[a-z][a-z0-9.-]{0,127}$/.test(command.id)
      || !command.label.trim() || typeof command.run !== 'function') {
      throw new Error(L({ ko: '편집기 명령 정의가 올바르지 않습니다.', en: "Invalid editor command definition." }));
    }
    if (this.commands.has(command.id)) throw new Error(LT({ ko: () => `중복 편집기 명령 ID: ${command.id}`, en: () => `Duplicate editor command ID: ${command.id}` }));
    this.commands.set(command.id, command);
  }

  get(id: string): EditorCommand | undefined { return this.commands.get(id); }
  list(): EditorCommand[] { return [...this.commands.values()]; }
  isAvailable(id: string): boolean {
    const command = this.commands.get(id);
    return !!command && (command.isAvailable?.() ?? true);
  }
  run(id: string): unknown {
    const command = this.commands.get(id);
    if (!command) throw new Error(LT({ ko: () => `알 수 없는 편집기 명령: ${id}`, en: () => `Unknown editor command: ${id}` }));
    if (!(command.isAvailable?.() ?? true)) {
      throw new Error(command.unavailableReason?.() || LT({ ko: () => `${command.label} 명령을 현재 상태에서 사용할 수 없습니다.`, en: () => `${command.label} is unavailable in the current state.` }));
    }
    return command.run();
  }
}

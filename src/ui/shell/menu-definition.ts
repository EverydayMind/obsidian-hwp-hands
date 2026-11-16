import { LT, L } from '../../i18n/locale';
export type MenuDefinitionItem =
  | { kind: 'command'; id: string; label?: string; checked?: boolean }
  | { kind: 'disabled'; label: string; reason: string }
  | { kind: 'separator' }
  | { kind: 'submenu'; label: string; items: MenuDefinitionItem[] };

const commands = (...ids: string[]): MenuDefinitionItem[] => ids.map(id => ({ kind: 'command', id }));
const checked = (...ids: string[]): MenuDefinitionItem[] => ids.map(id => ({ kind: 'command', id, checked: true }));
const separator = (): MenuDefinitionItem => ({ kind: 'separator' });
const unavailable = (label: string, reason: string): MenuDefinitionItem => ({ kind: 'disabled', label, reason });
const submenu = (label: string, items: MenuDefinitionItem[]): MenuDefinitionItem => ({ kind: 'submenu', label, items });

export const HEADER_FOOTER_TEMPLATES = [
  L({ ko: '빈 영역', en: "Empty area" }), L({ ko: '왼쪽 쪽 번호', en: "Page number on left" }), L({ ko: '가운데 쪽 번호', en: "Page number in center" }), L({ ko: '오른쪽 쪽 번호', en: "Page number on right" }), L({ ko: '쪽 번호 + 파일 이름', en: "Page number + file name" }), L({ ko: '파일 이름 + 쪽 번호', en: "File name + page number" }),
] as const;
export const headerFooterCommandId = (isHeader: boolean, applyTo: number, templateId: number): string =>
  `page.${isHeader ? 'header' : 'footer'}-${applyTo}-template-${templateId}`;
const headerFooterMenu = (isHeader: boolean): MenuDefinitionItem => ({ kind: 'submenu', label: isHeader ? L({ ko: '머리말', en: "header" }) : L({ ko: '꼬리말', en: "footer" }), items:
  ([[L({ ko: '양쪽', en: "Justified" }), 0], [L({ ko: '홀수 쪽', en: "Odd pages" }), 2], [L({ ko: '짝수 쪽', en: "Even pages" }), 1]] as const).map(([label, applyTo]) => ({ kind: 'submenu', label, items:
    HEADER_FOOTER_TEMPLATES.flatMap((name, templateId) => [
      ...(templateId === 1 ? [separator()] : []),
      { kind: 'command' as const, id: headerFooterCommandId(isHeader, applyTo, templateId), label: templateId === 0 ? LT({ ko: () => `빈 ${isHeader ? '머리말' : '꼬리말'}`, en: () => `Empty ${isHeader ? 'header' : 'footer'}` }) : name },
    ]),
  })),
});

/** Hancom Office's 찾기 drop-down (찾기, 찾아 바꾸기, 다시 찾기, 찾아가기): the edit menu's 찾기 submenu and the toolbox's find split button. */
export const FIND_MENU_COMMANDS = ['tool.find', 'tool.replace', 'tool.next-search-result', 'view.go-to-page'] as const;

/** The nine top-level groups follow the Hancom Office menu order; 검토 holds the change comparison and document history. */
export const EDITOR_MENU_DEFINITION: ReadonlyArray<{ label: string; items: MenuDefinitionItem[] }> = [
  { label: L({ ko: '파일', en: "File" }), items: [
    ...commands('file.new-document', 'file.open'),
    separator(), ...commands('file.save', 'file.save-as', 'file.save-hwp', 'file.save-hwpx'),
    separator(), ...commands('file.reload', 'file.refresh-index'),
    separator(), ...commands('page.setup-dialog', 'file.print'),
    separator(), ...commands('file.about'),
  ] },
  { label: L({ ko: '편집', en: "Edit" }), items: [
    ...commands('edit.undo', 'edit.redo'),
    separator(), ...commands('edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.select-all'),
    separator(), ...commands('format.copy-style', 'format.apply-copied-style'),
    separator(), submenu(L({ ko: '찾기', en: "Find" }), commands(...FIND_MENU_COMMANDS)),
    separator(), ...commands('object.edit-properties', 'object.delete'),
    submenu(L({ ko: '회전/대칭', en: "Rotate/flip" }), commands('object.rotate-right', 'object.rotate-left', 'object.rotate', 'object.flip-horizontal', 'object.flip-vertical')),
    submenu(L({ ko: '배치', en: "Arrange" }), [...commands('object.z-front', 'object.z-forward', 'object.z-backward', 'object.z-back'), separator(), ...commands('object.z-in-front-of-text', 'object.z-behind-text')]),
    submenu(L({ ko: '묶기', en: "Group" }), commands('object.group', 'object.ungroup')),
    separator(), ...commands('edit.recover-input'),
  ] },
  { label: L({ ko: '보기', en: "View" }), items: [
    ...commands('view.zoom-in', 'view.zoom-out'),
    submenu(L({ ko: '배율', en: "Zoom" }), [...commands('view.fit-page', 'view.fit-width'), separator(), ...[50, 75, 100, 125, 150, 200, 300].flatMap(p => commands(`view.zoom-${p}`))]),
    separator(), ...checked('view.control-codes', 'view.paragraph-marks', 'view.transparent-borders', 'view.overflow'),
    separator(), ...checked('view.grid'), ...commands('view.grid-settings'),
    separator(), ...checked('view.ruler'), submenu(L({ ko: '도구 상자', en: "Toolbox" }), commands('view.toggle-toolbars', 'view.toggle-format-toolbox')), ...commands('view.toggle-all-chrome'),
    separator(), ...checked('view.form-mode'),
  ] },
  { label: L({ ko: '입력', en: "Insert" }), items: [
    ...commands('insert.shape-draw', 'insert.text-box-draw', 'insert.picture-file', 'insert.equation-dialog'),
    submenu(L({ ko: '캡션 넣기', en: "Insert caption" }), commands('insert.caption-top', 'insert.caption-bottom', 'insert.caption-left', 'insert.caption-right', 'insert.caption-none')),
    separator(), ...commands('insert.footnote', 'insert.endnote', 'insert.endnote-shape'),
    separator(), ...commands('insert.character-table', 'insert.hyperlink', 'insert.bookmark'),
    separator(), ...commands('insert.clickhere-field', 'field.edit', 'field.remove'),
  ] },
  { label: L({ ko: '서식', en: "Format" }), items: [
    ...commands('format.character-dialog', 'format.paragraph-dialog'), { kind: 'command', id: 'format.style-dialog', label: L({ ko: '스타일', en: "Style" }) },
    separator(), ...commands('format.bold', 'format.italic', 'format.underline', 'format.strikethrough'),
    submenu(L({ ko: '글자 효과', en: "Character effects" }), commands('format.emboss', 'format.engrave', 'format.outline', 'format.superscript', 'format.subscript')),
    separator(), ...commands('format.font-size-increase', 'format.font-size-decrease'),
    submenu(L({ ko: '장평/자간', en: "Character width/spacing" }), commands('format.ratio-increase', 'format.ratio-decrease', 'format.character-spacing-increase', 'format.character-spacing-decrease')),
    separator(), submenu(L({ ko: '정렬', en: "Sort" }), commands('format.align-left', 'format.align-center', 'format.align-right', 'format.align-justify', 'format.align-distribute', 'format.align-split')),
    ...commands('format.line-spacing-increase', 'format.line-spacing-decrease'),
    separator(), ...commands('format.numbering-define'), unavailable(L({ ko: '글머리표 모양', en: "Bullet format" }), L({ ko: 'RHWP 코어에 글머리표 정의 API가 없습니다.', en: "RHWP core has no bullet definition API." })),
    ...commands('format.toggle-numbering', 'format.toggle-bullet', 'format.list-level-down', 'format.list-level-up'),
    separator(), submenu(L({ ko: '스타일 관리', en: "Manage styles" }), commands('format.style-new', 'format.style-edit', 'format.style-delete')),
  ] },
  { label: L({ ko: '쪽', en: "Page" }), items: [
    ...commands('page.setup-dialog', 'page.border-fill'),
    separator(), headerFooterMenu(true), headerFooterMenu(false), ...commands('page.header-footer-template', 'page.edit-header', 'page.edit-footer'),
    separator(), ...commands('page.new-number', 'page.hide'),
    separator(), ...commands('insert.page-break', 'insert.column-break'),
    separator(), submenu(L({ ko: '단', en: "Columns" }), [
      ...commands('page.columns-one', 'page.columns-two', 'page.columns-three'),
      unavailable(L({ ko: '왼쪽', en: "Left" }), L({ ko: 'RHWP 코어가 비대칭 단 너비를 받지 못합니다.', en: "RHWP core does not accept unequal column widths." })),
      unavailable(L({ ko: '오른쪽', en: "Right" }), L({ ko: 'RHWP 코어가 비대칭 단 너비를 받지 못합니다.', en: "RHWP core does not accept unequal column widths." })),
    ]), ...commands('page.columns', 'page.section-settings'),
  ] },
  { label: L({ ko: '표', en: "Table" }), items: [
    ...commands('insert.table', 'insert.table-custom', 'table.cell-properties'),
    submenu(L({ ko: '셀 테두리/배경', en: "Cell borders/background" }), commands('table.borders-each', 'table.borders-outside')),
    separator(), ...commands('table.insert-dialog', 'table.delete-dialog'),
    separator(), ...commands('table.insert-row-above', 'table.insert-row-below', 'table.delete-row', 'table.insert-column-left', 'table.insert-column-right', 'table.delete-column'),
    separator(), ...commands('table.split-cell', 'table.merge-cells', 'table.equalize-heights', 'table.equalize-widths', 'table.transpose'),
    separator(), ...commands('table.formula', 'table.block-sum', 'table.block-average', 'table.block-product'),
    separator(), ...commands('table.thousands', 'table.decimal-add', 'table.decimal-remove'),
    separator(), ...commands('table.split-table', 'table.merge-next', 'table.delete', 'table.caption-toggle'),
  ] },
  { label: L({ ko: '검토', en: "Review" }), items: commands('edit.compare', 'edit.document-history') },
  { label: L({ ko: '도구', en: "Tools" }), items: commands('tool.settings') },
];

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
  '빈 영역', '왼쪽 쪽 번호', '가운데 쪽 번호', '오른쪽 쪽 번호', '쪽 번호 + 파일 이름', '파일 이름 + 쪽 번호',
] as const;
export const headerFooterCommandId = (isHeader: boolean, applyTo: number, templateId: number): string =>
  `page.${isHeader ? 'header' : 'footer'}-${applyTo}-template-${templateId}`;
const headerFooterMenu = (isHeader: boolean): MenuDefinitionItem => ({ kind: 'submenu', label: isHeader ? '머리말' : '꼬리말', items:
  ([['양쪽', 0], ['홀수 쪽', 2], ['짝수 쪽', 1]] as const).map(([label, applyTo]) => ({ kind: 'submenu', label, items:
    HEADER_FOOTER_TEMPLATES.flatMap((name, templateId) => [
      ...(templateId === 1 ? [separator()] : []),
      { kind: 'command' as const, id: headerFooterCommandId(isHeader, applyTo, templateId), label: templateId === 0 ? `빈 ${isHeader ? '머리말' : '꼬리말'}` : name },
    ]),
  })),
});

/** Hancom Office's 찾기 drop-down (찾기, 찾아 바꾸기, 다시 찾기, 찾아가기): the edit menu's 찾기 submenu and the toolbox's find split button. */
export const FIND_MENU_COMMANDS = ['tool.find', 'tool.replace', 'tool.next-search-result', 'view.go-to-page'] as const;

/** The nine top-level groups follow the Hancom Office menu order; 검토 holds the change comparison and document history. */
export const EDITOR_MENU_DEFINITION: ReadonlyArray<{ label: string; items: MenuDefinitionItem[] }> = [
  { label: '파일', items: [
    ...commands('file.new-document', 'file.open'),
    separator(), ...commands('file.save', 'file.save-as', 'file.save-hwp', 'file.save-hwpx'),
    separator(), ...commands('file.reload', 'file.refresh-index'),
    separator(), ...commands('page.setup-dialog', 'file.print'),
    separator(), ...commands('file.about'),
  ] },
  { label: '편집', items: [
    ...commands('edit.undo', 'edit.redo'),
    separator(), ...commands('edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.select-all'),
    separator(), ...commands('format.copy-style', 'format.apply-copied-style'),
    separator(), submenu('찾기', commands(...FIND_MENU_COMMANDS)),
    separator(), ...commands('object.edit-properties', 'object.delete'),
    submenu('회전/대칭', commands('object.rotate-right', 'object.rotate-left', 'object.rotate', 'object.flip-horizontal', 'object.flip-vertical')),
    submenu('배치', [...commands('object.z-front', 'object.z-forward', 'object.z-backward', 'object.z-back'), separator(), ...commands('object.z-in-front-of-text', 'object.z-behind-text')]),
    submenu('묶기', commands('object.group', 'object.ungroup')),
    separator(), ...commands('edit.recover-input'),
  ] },
  { label: '보기', items: [
    ...commands('view.zoom-in', 'view.zoom-out'),
    submenu('배율', [...commands('view.fit-page', 'view.fit-width'), separator(), ...[50, 75, 100, 125, 150, 200, 300].flatMap(p => commands(`view.zoom-${p}`))]),
    separator(), ...checked('view.control-codes', 'view.paragraph-marks', 'view.transparent-borders', 'view.overflow'),
    separator(), ...checked('view.grid'), ...commands('view.grid-settings'),
    separator(), ...checked('view.ruler'), submenu('도구 상자', commands('view.toggle-toolbars', 'view.toggle-format-toolbox')), ...commands('view.toggle-all-chrome'),
    separator(), ...checked('view.form-mode'),
  ] },
  { label: '입력', items: [
    ...commands('insert.shape-draw', 'insert.text-box-draw', 'insert.picture-file', 'insert.equation-dialog'),
    submenu('캡션 넣기', commands('insert.caption-top', 'insert.caption-bottom', 'insert.caption-left', 'insert.caption-right', 'insert.caption-none')),
    separator(), ...commands('insert.footnote', 'insert.endnote', 'insert.endnote-shape'),
    separator(), ...commands('insert.character-table', 'insert.hyperlink', 'insert.bookmark'),
    separator(), ...commands('insert.clickhere-field', 'field.edit', 'field.remove'),
  ] },
  { label: '서식', items: [
    ...commands('format.character-dialog', 'format.paragraph-dialog'), { kind: 'command', id: 'format.style-dialog', label: '스타일' },
    separator(), ...commands('format.bold', 'format.italic', 'format.underline', 'format.strikethrough'),
    submenu('글자 효과', commands('format.emboss', 'format.engrave', 'format.outline', 'format.superscript', 'format.subscript')),
    separator(), ...commands('format.font-size-increase', 'format.font-size-decrease'),
    submenu('장평/자간', commands('format.ratio-increase', 'format.ratio-decrease', 'format.character-spacing-increase', 'format.character-spacing-decrease')),
    separator(), submenu('정렬', commands('format.align-left', 'format.align-center', 'format.align-right', 'format.align-justify', 'format.align-distribute', 'format.align-split')),
    ...commands('format.line-spacing-increase', 'format.line-spacing-decrease'),
    separator(), ...commands('format.numbering-define'), unavailable('글머리표 모양', 'RHWP 코어에 글머리표 정의 API가 없습니다.'),
    ...commands('format.toggle-numbering', 'format.toggle-bullet', 'format.list-level-down', 'format.list-level-up'),
    separator(), submenu('스타일 관리', commands('format.style-new', 'format.style-edit', 'format.style-delete')),
  ] },
  { label: '쪽', items: [
    ...commands('page.setup-dialog', 'page.border-fill'),
    separator(), headerFooterMenu(true), headerFooterMenu(false), ...commands('page.header-footer-template', 'page.edit-header', 'page.edit-footer'),
    separator(), ...commands('page.new-number', 'page.hide'),
    separator(), ...commands('insert.page-break', 'insert.column-break'),
    separator(), submenu('단', [
      ...commands('page.columns-one', 'page.columns-two', 'page.columns-three'),
      unavailable('왼쪽', 'RHWP 코어가 비대칭 단 너비를 받지 못합니다.'),
      unavailable('오른쪽', 'RHWP 코어가 비대칭 단 너비를 받지 못합니다.'),
    ]), ...commands('page.columns', 'page.section-settings'),
  ] },
  { label: '표', items: [
    ...commands('insert.table', 'insert.table-custom', 'table.cell-properties'),
    submenu('셀 테두리/배경', commands('table.borders-each', 'table.borders-outside')),
    separator(), ...commands('table.insert-dialog', 'table.delete-dialog'),
    separator(), ...commands('table.insert-row-above', 'table.insert-row-below', 'table.delete-row', 'table.insert-column-left', 'table.insert-column-right', 'table.delete-column'),
    separator(), ...commands('table.split-cell', 'table.merge-cells', 'table.equalize-heights', 'table.equalize-widths', 'table.transpose'),
    separator(), ...commands('table.formula', 'table.block-sum', 'table.block-average', 'table.block-product'),
    separator(), ...commands('table.thousands', 'table.decimal-add', 'table.decimal-remove'),
    separator(), ...commands('table.split-table', 'table.merge-next', 'table.delete', 'table.caption-toggle'),
  ] },
  { label: '검토', items: commands('edit.compare', 'edit.document-history') },
  { label: '도구', items: commands('tool.settings') },
];

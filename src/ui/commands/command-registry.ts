import { HEADER_FOOTER_TEMPLATES, headerFooterCommandId } from '../shell/menu-definition';

export interface EditorCommand {
  id: string;
  label: string;
  shortcut?: string;
  isAvailable?: () => boolean;
  unavailableReason?: () => string | undefined;
  run: () => unknown;
}

export const EDITOR_COMMAND_CATALOG = [
  { id: 'story.previous', label: '이전 영역' },
  { id: 'story.next', label: '다음 영역' },
  { id: 'story.close', label: '편집 닫기' },
  { id: 'story.delete', label: '영역 지우기' },
  { id: 'story.page-number', label: '쪽 번호' },
  { id: 'story.total-pages', label: '총 쪽수' },
  { id: 'story.file-name', label: '파일 이름' },
  ...[true, false].flatMap(isHeader => [0, 2, 1].flatMap(applyTo => HEADER_FOOTER_TEMPLATES.map((label, templateId) => ({
    id: headerFooterCommandId(isHeader, applyTo, templateId), label: `${isHeader ? '머리말' : '꼬리말'}: ${label}`,
  })))),
  { id: 'page.edit-header', label: '머리말 편집…' },
  { id: 'page.edit-footer', label: '꼬리말 편집…' },
  { id: 'file.new-document', label: '새 HWPX 문서', shortcut: 'Alt+N' },
  { id: 'file.open', label: 'HWP/HWPX 문서 열기' },
  { id: 'file.save', label: '저장', shortcut: 'Mod+S' },
  { id: 'file.save-as', label: '새 파일로 저장', shortcut: 'Mod+Shift+S' },
  { id: 'file.save-hwp', label: 'HWP 형식으로 저장…' },
  { id: 'file.save-hwpx', label: 'HWPX 형식으로 저장…' },
  { id: 'file.print', label: '인쇄 / PDF로 저장' },
  { id: 'file.reload', label: '다시 불러오기' },
  { id: 'file.refresh-index', label: '검색 인덱스 갱신' },
  { id: 'edit.undo', label: '되돌리기', shortcut: 'Mod+Z' },
  { id: 'edit.redo', label: '다시 실행', shortcut: 'Mod+Shift+Z' },
  { id: 'edit.cut', label: '오려두기', shortcut: 'Mod+X' },
  { id: 'edit.copy', label: '복사', shortcut: 'Mod+C' },
  { id: 'edit.paste', label: '붙이기', shortcut: 'Mod+V' },
  { id: 'edit.compare', label: '변경 비교', shortcut: 'Alt+Shift+V' },
  { id: 'edit.document-history', label: '문서 이력 관리' },
  { id: 'edit.recover-input', label: '미적용 입력 복구' },
  { id: 'insert.picture-file', label: '그림' },
  { id: 'insert.equation-dialog', label: '수식' },
  { id: 'insert.shape-draw', label: '도형 그리기' },
  { id: 'insert.text-box-draw', label: '글상자 그리기' },
  { id: 'insert.caption-top', label: '캡션 위' },
  { id: 'insert.caption-bottom', label: '캡션 아래' },
  { id: 'insert.caption-left', label: '캡션 왼쪽' },
  { id: 'insert.caption-right', label: '캡션 오른쪽' },
  { id: 'insert.caption-none', label: '캡션 없음' },
  { id: 'edit.delete', label: '지우기', shortcut: 'Ctrl+E' },
  { id: 'edit.select-all', label: '모두 선택', shortcut: 'Mod+A' },
  { id: 'format.align-left', label: '왼쪽 정렬', shortcut: 'Ctrl+Shift+L' },
  { id: 'format.align-center', label: '가운데 정렬', shortcut: 'Alt+Shift+C' },
  { id: 'format.align-right', label: '오른쪽 정렬', shortcut: 'Alt+Shift+H' },
  { id: 'format.align-justify', label: '양쪽 정렬', shortcut: 'Ctrl+Shift+M' },
  { id: 'format.align-distribute', label: '배분 정렬', shortcut: 'Alt+Shift+D' },
  { id: 'format.align-split', label: '나눔 정렬' },
  { id: 'view.toggle-format-toolbox', label: '서식 도구줄 접기/펴기' },
  { id: 'view.toggle-all-chrome', label: '메뉴 모두 접기/펴기', shortcut: 'Ctrl+Shift+F1' },
  { id: 'view.previous-page', label: '이전 쪽' },
  { id: 'view.next-page', label: '다음 쪽' },
  { id: 'view.fit-width', label: '폭 맞춤' },
  { id: 'view.fit-page', label: '쪽 맞춤' },
  { id: 'view.zoom-in', label: '확대' },
  { id: 'view.zoom-out', label: '축소' },
  ...[50, 75, 100, 125, 150, 200, 300].map(percent => ({ id: `view.zoom-${percent}`, label: `${percent}%` })),
  { id: 'file.about', label: '제품 정보' },
  { id: 'tool.settings', label: '환경 설정' },
  { id: 'view.form-mode', label: '양식 모드' },
  { id: 'view.toggle-toolbars', label: '도구 상자 접기/펴기', shortcut: 'Ctrl+F1' },
  { id: 'view.go-to-page', label: '쪽 번호 입력', shortcut: 'Alt+G' },
  { id: 'view.go-to-bookmark', label: '책갈피로 이동' },
  { id: 'view.ruler', label: '눈금자' },
  { id: 'view.grid', label: '격자 보기' },
  { id: 'view.grid-settings', label: '격자 설정' },
  { id: 'view.paragraph-marks', label: '문단 부호' },
  { id: 'view.control-codes', label: '조판 부호' },
  { id: 'view.transparent-borders', label: '투명 선' },
  { id: 'view.overflow', label: '잘림 보기' },
  { id: 'insert.paragraph', label: '새 문단' },
  { id: 'insert.table', label: '표 삽입' },
  { id: 'insert.table-custom', label: '사용자 지정 표 삽입' },
  { id: 'insert.clickhere-field', label: '누름틀 삽입' },
  { id: 'field.edit', label: '필드 고치기' },
  { id: 'field.remove', label: '필드 지우기' },
  { id: 'insert.character-table', label: '문자표', shortcut: 'Alt+F10' },
  { id: 'insert.page-break', label: '쪽 나누기', shortcut: 'Mod+Enter' },
  { id: 'insert.column-break', label: '단 나누기', shortcut: 'Mod+Shift+Enter' },
  { id: 'insert.footnote', label: '각주 삽입' },
  { id: 'insert.endnote', label: '미주 삽입' },
  { id: 'insert.endnote-shape', label: '미주 모양' },
  { id: 'insert.bookmark', label: '책갈피' },
  { id: 'format.bold', label: '굵게', shortcut: 'Mod+B' },
  { id: 'format.italic', label: '기울임', shortcut: 'Mod+I' },
  { id: 'format.underline', label: '밑줄', shortcut: 'Mod+U' },
  { id: 'format.strikethrough', label: '취소선' },
  { id: 'format.emboss', label: '양각' },
  { id: 'format.engrave', label: '음각' },
  { id: 'format.outline', label: '외곽선' },
  { id: 'format.superscript', label: '위 첨자' },
  { id: 'format.subscript', label: '아래 첨자' },
  { id: 'format.font-size-increase', label: '글자 크기 늘리기', shortcut: 'Alt+Shift+E', aliases: ['Mod+]'] },
  { id: 'format.font-size-decrease', label: '글자 크기 줄이기', shortcut: 'Alt+Shift+R', aliases: ['Mod+['] },
  { id: 'format.ratio-increase', label: '장평 늘리기', shortcut: 'Mod+Shift+]' },
  { id: 'format.ratio-decrease', label: '장평 줄이기', shortcut: 'Mod+Shift+[' },
  { id: 'format.character-spacing-increase', label: '자간 넓히기', shortcut: 'Mod+Alt+]' },
  { id: 'format.character-spacing-decrease', label: '자간 좁히기', shortcut: 'Mod+Alt+[' },
  { id: 'format.copy-style', label: '모양 복사', shortcut: 'Alt+C' },
  { id: 'format.apply-copied-style', label: '모양 붙이기' },
  { id: 'format.character-dialog', label: '글자 모양', shortcut: 'Alt+L' },
  { id: 'format.paragraph-dialog', label: '문단 모양', shortcut: 'Alt+T' },
  { id: 'format.style-dialog', label: '문단 스타일', shortcut: 'F6' },
  { id: 'format.style-new', label: '스타일 추가' },
  { id: 'format.style-edit', label: '스타일 편집' },
  { id: 'format.style-delete', label: '스타일 지우기' },
  { id: 'format.numbering-define', label: '문단 번호 모양' },
  { id: 'format.line-spacing-decrease', label: '줄 간격 줄이기', shortcut: 'Alt+Shift+A', aliases: ['Mod+Shift+Alt+['] },
  { id: 'format.line-spacing-increase', label: '줄 간격 늘리기', shortcut: 'Alt+Shift+Z', aliases: ['Mod+Shift+Alt+]'] },
  { id: 'format.toggle-numbering', label: '번호 목록 토글' },
  { id: 'format.toggle-bullet', label: '글머리표 토글' },
  { id: 'format.list-level-down', label: '목록 수준 내리기' },
  { id: 'format.list-level-up', label: '목록 수준 올리기' },
  { id: 'page.apply-settings', label: '쪽 설정 적용' },
  { id: 'page.setup-dialog', label: '편집 용지', shortcut: 'F7' },
  { id: 'page.footer-template', label: '꼬리말' },
  { id: 'insert.hyperlink', label: '하이퍼링크' },
  { id: 'page.header-footer-template', label: '머리말 / 꼬리말' },
  { id: 'page.columns', label: '다단 설정', shortcut: 'Ctrl+Alt+Enter' },
  { id: 'page.columns-one', label: '단 하나' },
  { id: 'page.columns-two', label: '단 둘' },
  { id: 'page.columns-three', label: '단 셋' },
  { id: 'page.border-fill', label: '쪽 테두리 / 배경' },
  { id: 'page.section-settings', label: '구역 설정' },
  { id: 'page.hide', label: '현재 쪽 감추기' },
  { id: 'page.new-number', label: '새 번호로 시작' },
  { id: 'table.merge-cells', label: '선택 셀 병합' },
  { id: 'table.split-cell', label: '선택 셀 나누기' },
  { id: 'table.thousands', label: '1,000 단위 구분 쉼표' },
  { id: 'table.decimal-add', label: '자릿점 넣기' },
  { id: 'table.decimal-remove', label: '자릿점 빼기' },
  { id: 'table.borders-each', label: '각 셀마다 적용' },
  { id: 'table.borders-outside', label: '하나의 셀처럼 적용' },
  { id: 'table.cell-properties', label: '표 / 셀 속성' },
  { id: 'table.formula', label: '계산식' },
  { id: 'table.block-sum', label: '블록 합계' },
  { id: 'table.block-average', label: '블록 평균' },
  { id: 'table.block-product', label: '블록 곱' },
  { id: 'table.transpose', label: '행/열 바꿈' },
  { id: 'table.split-table', label: '표 나누기' },
  { id: 'table.merge-next', label: '표 붙이기' },
  { id: 'table.delete', label: '표 지우기' },
  { id: 'table.caption-toggle', label: '표 캡션 넣기/빼기' },
  { id: 'table.equalize-widths', label: '셀 너비를 같게' },
  { id: 'table.equalize-heights', label: '셀 높이를 같게' },
  { id: 'table.insert-row-above', label: '위에 행 삽입' },
  { id: 'table.insert-dialog', label: '줄/칸 추가하기…', shortcut: 'Alt+Enter' },
  { id: 'table.delete-dialog', label: '줄/칸 지우기…', shortcut: 'Alt+Delete' },
  { id: 'table.insert-row-below', label: '아래에 행 삽입' },
  { id: 'table.delete-row', label: '행 삭제' },
  { id: 'table.insert-column-left', label: '왼쪽에 칸 삽입' },
  { id: 'table.insert-column-right', label: '오른쪽에 칸 삽입' },
  { id: 'table.delete-column', label: '칸 삭제' },
  { id: 'object.edit-properties', label: '선택 개체 속성' },
  { id: 'object.delete', label: '선택 개체 삭제' },
  { id: 'object.rotate', label: '개체 회전' },
  { id: 'object.rotate-right', label: '오른쪽 90° 회전' },
  { id: 'object.rotate-left', label: '왼쪽 90° 회전' },
  { id: 'object.flip-horizontal', label: '좌우 대칭' },
  { id: 'object.flip-vertical', label: '상하 대칭' },
  { id: 'object.caption-toggle', label: '그림 캡션 넣기/빼기' },
  { id: 'object.z-front', label: '맨 앞으로' },
  { id: 'object.z-forward', label: '앞으로' },
  { id: 'object.z-backward', label: '뒤로' },
  { id: 'object.z-back', label: '맨 뒤로' },
  { id: 'object.z-in-front-of-text', label: '글 앞으로' },
  { id: 'object.z-behind-text', label: '글 뒤로' },
  { id: 'object.group', label: '개체 묶기' },
  { id: 'object.ungroup', label: '개체 풀기' },
  { id: 'tool.find', label: '찾기', shortcut: 'Mod+F' },
  { id: 'tool.replace', label: '바꾸기', shortcut: 'Ctrl+F2', aliases: ['Mod+H'] },
  { id: 'tool.replace-current', label: '현재 검색 결과 바꾸기' },
  { id: 'tool.next-search-result', label: '다음 검색 결과', shortcut: 'Mod+L' },
] as const;

export type EditorCommandId = typeof EDITOR_COMMAND_CATALOG[number]['id'];
export function editorCommandDefinition(id: string): typeof EDITOR_COMMAND_CATALOG[number] | undefined {
  return EDITOR_COMMAND_CATALOG.find(command => command.id === id);
}

/** Keeps editor actions addressable from menus, view shortcuts and Obsidian commands. */
export class CommandRegistry {
  private readonly commands = new Map<string, EditorCommand>();

  register(command: EditorCommand): void {
    if (!command || typeof command !== 'object' || !/^[a-z][a-z0-9.-]{0,127}$/.test(command.id)
      || !command.label.trim() || typeof command.run !== 'function') {
      throw new Error('편집기 명령 정의가 올바르지 않습니다.');
    }
    if (this.commands.has(command.id)) throw new Error(`중복 편집기 명령 ID: ${command.id}`);
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
    if (!command) throw new Error(`알 수 없는 편집기 명령: ${id}`);
    if (!(command.isAvailable?.() ?? true)) {
      throw new Error(command.unavailableReason?.() || `${command.label} 명령을 현재 상태에서 사용할 수 없습니다.`);
    }
    return command.run();
  }
}

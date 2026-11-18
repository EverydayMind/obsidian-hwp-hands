import { L as select, LT as selectLazy, getLocale, type Locale } from '../i18n/locale';
import type { Json } from '../api';
type JsonObject = { [key: string]: Json };
const MAX_BLOCKS = 80, MAX_MATCHES = 20, both = (pair: { ko: string | string[]; en: string | string[] }): string[] => [pair.ko, pair.en].flat(), dedupe = (...items: (string | string[])[]): string[] => [...new Set(items.flatMap(item => item))];
export function createToolCatalog(locale: Locale = getLocale()) {
const L = <T>(pair: { ko: T; en: T }): T => select(pair, locale);
const RESOURCE_TYPES = ['.hwp', '.hwpx'];
const meta = (extra: JsonObject = {}): JsonObject => ({ 'dev.agentinterop/effect': 'read', 'dev.agentinterop/group': 'core', 'dev.agentinterop/resourceTypes': RESOURCE_TYPES, 'dev.agentinterop/maxResultChars': 12000, ...extra });
const PATH = { type: 'string', minLength: 1, maxLength: 4096, description: L({ ko: 'Vault 안의 .hwp 또는 .hwpx 경로.', en: "Path to a .hwp or .hwpx document in the Vault." }) };

const DESCRIPTOR_TOOLS: JsonObject[] = [
  {
    name: 'get_editor_context', title: L({ ko: '열린 한글 문서', en: "Open HWP documents" }),
    description: L({ ko: 'HWP Hands에 열려 있는 한글 문서 목록과 상태(쪽 수, 저장 안 한 변경, 화면에 보이는지)를 돌려준다. 어떤 문서를 읽을지 모를 때 먼저 부른다.', en: "Returns HWP documents open in HWP Hands and their state (page count, unsaved changes, and visible views). Call first when you do not know which document to read." }),
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true }, _meta: meta(),
  },
  {
    name: 'read_document', title: L({ ko: '한글 문서 읽기', en: "Read HWP document" }),
    description: L({ ko: '한글 문서의 본문을 블록 단위로 읽는다. 각 줄은 [문단 핸들] 텍스트다. 표는 행별로 칸 번호를 붙이며 빈 칸은 (빈 칸), 병합 칸은 범위를 적는다. "계속: cursor=..."가 나오면 그 cursor로 이어 읽는다. 서식 확인은 별도 format_text가 아닌 이 도구에 mode="formatting"과 현재 문단 target을 주고 nextRunOffset으로 이어 읽는다. mode="layout"에 target을 주면 문단 줄 수를 추정한다.', en: "Reads an HWP document body in blocks. Each line is [paragraph handle] text. Table rows show column numbers, empty cells as (empty cell), and merged cell ranges. When \"Continue: cursor=...\" appears, resume with that cursor. To inspect formatting, use this tool with mode=\"formatting\" and the current paragraph target, then continue with nextRunOffset; do not use format_text. With mode=\"layout\" and target, estimates paragraph line counts." }),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: PATH,
        mode: { type: 'string', enum: ['blocks', 'outline', 'formatting', 'quality', 'notes', 'styles', 'sections', 'layout', 'table'], description: L({ ko: '기본값 blocks. notes는 각주·미주, styles는 스타일, sections는 구역·쪽 설정과 머리말/꼬리말의 논리 텍스트·동적 필드를 읽는다. quality는 작성 점검, layout은 쪽 수·마지막 쪽 사용률이다. table은 target 표의 셀 텍스트를 cursor로 나누어 읽는다.', en: "Default: blocks. notes reads footnotes/endnotes; styles reads styles; sections reads section/page settings and header/footer logical text and dynamic fields. quality checks writing; layout reports page count and last-page usage. table pages through the target table cell text with cursor." }) },
        placeholders: { type: 'array', minItems: 1, maxItems: 20, description: L({ ko: 'quality에서만. 남았는지 찾을 정확한 문자열(예: {{성명}}). 공백만 있는 문자열은 제외한다. 제목·일반 빈 문단은 결함으로 추정하지 않는다.', en: "quality only. Exact strings to check for remaining placeholders (e.g. {{name}}). Exclude whitespace-only strings. Do not infer defects from headings or ordinary empty paragraphs." }), items: { type: 'string', minLength: 1, maxLength: 200 } },
        target: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: 'formatting 또는 layout의 문단·셀 문단 핸들, table의 표 읽기용 핸들. blocks에서는 쓰지 않는다(특정 문단·쪽으로 건너뛸 수 없고 처음부터 cursor로 읽는다).', en: "Paragraph or cell-paragraph handle for formatting/layout; table reading handle for table. Not used in blocks (cannot jump to a paragraph/page; read from the beginning with cursor)." }) },
        layoutSummary: { type: 'boolean', description: L({ ko: 'layout 문단별 추정. target 불가, limit 최대 20, cursor로 이어 읽음.', en: "Per-paragraph layout estimates. No target; limit up to 20; resume with cursor." }) },
        runOffset: { type: 'integer', minimum: 0, description: L({ ko: 'formatting 모드의 서식 구간 시작 번호. nextRunOffset으로 이어 읽는다.', en: "Starting formatting run index in formatting mode. Continue with nextRunOffset." }) },
        cursor: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '앞선 결과가 준 cursor. 처음에는 생략한다.', en: "Cursor from the previous result. Omit initially." }) },
        limit: { type: 'integer', minimum: 1, maximum: MAX_BLOCKS, description: L({ ko: '읽을 블록 수. 기본값 40.', en: "Number of blocks to read. Default: 40." }) },
      },
    },
    annotations: { readOnlyHint: true }, _meta: meta(),
  },
  {
    name: 'find_text', title: L({ ko: '한글 문서에서 찾기', en: "Find in HWP document" }),
    description: L({ ko: '한글 문서에서 문구를 그대로(정규식·공백 정규화 없이, 대소문자 구분) 찾는다. 본문과 표 셀을 찾고, 일치한 블록의 핸들과 앞뒤 문맥을 돌려준다. 한 번에 최대 20곳이며 더 있으면 cursor를 준다. 낱말이 몇 번 나오는지는 결과의 total을 그대로 쓴다.', en: "Finds an exact phrase in an HWP document (case-sensitive, without regex or whitespace normalization). Searches body and table cells; returns matching block handles and surrounding context. Up to 20 matches per call; returns a cursor if more remain. When asked how many occurrences there are, use the result's total directly." }),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'query'],
      properties: {
        path: PATH,
        query: { type: 'string', minLength: 1, maxLength: 1000, description: L({ ko: '찾을 문구.', en: "Phrase to find." }) },
        includeStories: { type: 'boolean', description: L({ ko: 'true면 머리말·꼬리말·각주·미주·글상자도 찾는다.', en: "If true, also search headers, footers, footnotes, endnotes, and text boxes." }) },
        cursor: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '앞선 결과가 준 cursor.', en: "Cursor from the previous result." }) },
        limit: { type: 'integer', minimum: 1, maximum: MAX_MATCHES, description: L({ ko: '돌려줄 일치 수. 기본값 20.', en: "Number of matches to return. Default: 20." }) },
      },
    },
    annotations: { readOnlyHint: true }, _meta: meta(),
  },
];
// Korean keywords match as substrings, so they carry the particle that separates 표 from words such as 목표.
// English keywords match on word boundaries (plurals included), so "table" covers every English phrasing.
const TABLE_KEYWORDS = both({ ko: ["표 2", "표에서", "표를", "표의", "표에", "표 수정", "표 삽입", "새 표", "표 추가", "표 하나", "표 만들", "표 넣", "표의 문장", "표의 문단", "셀", " 표로", " 표는", " 표도", " 표와", " 표 형식"], en: ["table", "cell"] });
const sessionMeta = (group = 'text', keywords = dedupe(both({ ko: ['문단', '고쳐', '고칠', '바꾸', '바꿔', '바꿀', '바꾼', '수정', '추가', '삽입', '삭제', '지워', '지울', '지운', '되돌', '변경', '교체', '치환', '넣', '손봐', '손보'], en: ['paragraph', 'replace', 'edit', 'add', 'insert', 'delete', 'remove', 'change', 'revise', 'revision', 'correct'] }))): JsonObject => ({ ...meta(), 'dev.agentinterop/effect': 'session', 'dev.agentinterop/group': group, 'dev.agentinterop/keywords': dedupe(...keywords) });
const EDIT_TOOLS: JsonObject[] = [
  {
    name: 'apply_draft', title: L({ ko: '한글 문서 초안 채택', en: "Accept HWP document draft" }),
    description: L({ ko: '완성한 문단 초안에서 accept에 지정한 문단만 읽은 본문 문단 target(표 칸 불가) 앞이나 뒤에 넣는다. paragraphs는 초안 순서이며 accept는 1부터 센 문단 번호다. 지정 순서와 관계없이 초안 순서를 보존한다. preview:true로 실제 엔진에서 미리 볼 수 있다. 한 호출은 전부 적용되거나 전혀 적용되지 않는다. 결과는 채택/남은 문단 번호와 revision, saved:false를 구분한다. 적용 뒤 취소는 undo_last_edit를 쓴다. 반복 호출은 중복 삽입할 수 있으므로 성공 뒤 다시 읽고 남은 문단만 요청한다.', en: "Inserts only the paragraphs listed in accept from a completed draft before/after a previously read body paragraph target (not a table cell). paragraphs follows draft order; accept uses 1-based paragraph numbers. Preserves draft order regardless of selection order. preview:true previews with the real engine. Each call applies entirely or not at all. Results distinguish accepted/remaining paragraph numbers, revision, and saved:false. Use undo_last_edit to undo an applied call. Repeated calls can insert duplicates; after success, read again and request only remaining paragraphs." }),
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'target', 'position', 'paragraphs', 'accept'], properties: {
      path: PATH, target: { type: 'string', minLength: 1, maxLength: 128 },
      position: { type: 'string', enum: ['before', 'after'] },
      paragraphs: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 20000 }, description: L({ ko: '초안 문단. 줄바꿈 없이 문단마다 항목 하나. 빈 문단 허용.', en: "Draft paragraphs. One item per paragraph, without line breaks. Empty paragraphs allowed." }) },
      accept: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'integer', minimum: 1, maximum: 50 }, description: L({ ko: '채택할 문단 번호. 중복 불가. 생략한 문단은 적용하지 않는다.', en: "Paragraph numbers to accept. No duplicates. Omitted paragraphs are not applied." }) },
    } }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('draft', dedupe(both({ ko: '초안', en: "draft" }), both({ ko: '채택', en: "accept" }), 'draft')),
  },
  {
    name: 'update_section', title: L({ ko: '한글 문서 구역·쪽 설정', en: "HWP section and page settings" }),
    description: L({ ko: '현재 구역 핸들 target 하나의 쪽 설정(page), 구역 정의(definition), 새 머리말/꼬리말(header) 중 하나만 변경한다. 파일에 저장하지 않는다. sections로 설정과 기존 동적 필드를, blocks로 해당 구역의 본문·표 전체를 먼저 읽어야 한다. 사용자가 범위를 선택해 보낸 요청은 그 구역의 본문 문단 전체가 선택되어야 한다. page의 모든 길이는 mm이며 HWP 단위로 변환한다. 생략한 설정과 다른 구역은 보존한다. header는 없는 적용 쪽 종류에만 템플릿을 새로 만든다. 기존 story 덮어쓰기·삭제·내부 텍스트 편집은 미지원이다. 성공하면 핸들이 모두 만료되므로 문서를 다시 읽는다.', en: "Changes exactly one of page settings (page), section definition (definition), or a new header/footer (header) for the current section handle target. Does not save the file. First read settings and existing dynamic fields with sections, and the entire section body/tables with blocks. A request submitted with a user selection must select every body paragraph in that section. All page lengths are mm, converted to HWP units. Preserves omitted settings and other sections. header creates a template only for an application page type that has none. Overwriting/deleting an existing story or editing its internal text is unsupported. All handles expire on success; read again." }),
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'target'], properties: {
      path: PATH, target: { type: 'string', minLength: 1, maxLength: 128 },
      page: { type: 'object', additionalProperties: false, properties: {
        widthMm: { type: 'number', minimum: 4, maximum: 3500 }, heightMm: { type: 'number', minimum: 4, maximum: 3500 },
        marginLeftMm: { type: 'number', minimum: 0, maximum: 3500 }, marginRightMm: { type: 'number', minimum: 0, maximum: 3500 },
        marginTopMm: { type: 'number', minimum: 0, maximum: 3500 }, marginBottomMm: { type: 'number', minimum: 0, maximum: 3500 },
        marginHeaderMm: { type: 'number', minimum: 0, maximum: 3500 }, marginFooterMm: { type: 'number', minimum: 0, maximum: 3500 },
        marginGutterMm: { type: 'number', minimum: 0, maximum: 3500 }, landscape: { type: 'boolean' }, binding: { type: 'integer', minimum: 0, maximum: 3 },
      } },
      definition: { type: 'object', additionalProperties: false, properties: {
        pageNum: { type: 'integer', minimum: 0, maximum: 65535 }, pageNumType: { type: 'integer', minimum: 0, maximum: 2, description: L({ ko: '0 이어서, 1 홀수, 2 짝수', en: "0 continue, 1 odd, 2 even" }) },
        hideHeader: { type: 'boolean' }, hideFooter: { type: 'boolean' }, hideMasterPage: { type: 'boolean' },
        hideBorder: { type: 'boolean' }, hideFill: { type: 'boolean' }, hideEmptyLine: { type: 'boolean' },
      } },
      header: { type: 'object', additionalProperties: false, required: ['kind', 'applyTo', 'templateId'], properties: {
        kind: { type: 'string', enum: ['header', 'footer'] }, applyTo: { type: 'string', enum: ['both', 'even', 'odd'] },
        templateId: { type: 'integer', minimum: 0, maximum: 10, description: L({ ko: '0 빈 영역, 1/2/3 쪽번호 왼쪽/가운데/오른쪽, 4 쪽번호·파일명, 5 파일명·쪽번호, 6~10은 1~5의 굵게·밑줄 변형.', en: "0 empty; 1/2/3 page number left/center/right; 4 page number + filename; 5 filename + page number; 6–10 bold/underline variants of 1–5." }) },
      } },
    } }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('section', dedupe(both({ ko: '구역', en: "section" }), both({ ko: '쪽 설정', en: "page setup" }), both({ ko: '머리말', en: "header" }), both({ ko: '꼬리말', en: "footer" }), both({ ko: '용지', en: "paper" }), 'section', 'page setup')),
  },
  {
    name: 'edit_styles', title: L({ ko: '한글 문서 스타일 정의', en: "Define HWP document styles" }),
    description: L({ ko: '문단 스타일을 새로 정의(create)하거나 관측한 정의만 패치(patch)한다. 파일에 저장하지 않는다. 적용은 format_text의 style로 한다. patch의 target은 read_document(mode=styles)가 준 핸들이다. 생략한 속성은 유지하고 fontLanguage로 한 언어 글꼴만 바꿀 수 있다. 같은 이름은 임의 선택하지 않는다. 정의는 문서 전체에 영향을 주므로 사용자가 범위를 선택해 보낸 요청에서는 거절한다. patch는 영향받는 모든 본문·표 문단을 먼저 전체 조회해야 한다. story·중첩 컨테이너의 스타일 사용 여부가 불명확하면 거절한다. 문자 스타일 정의/적용은 미지원이다.', en: "Creates a paragraph style (create) or patches only an observed definition (patch). Does not save the file. Apply with format_text style. patch target is a handle from read_document(mode=styles). Omitted properties stay unchanged; fontLanguage can change one language font. Never picks arbitrarily among duplicate names. Definitions affect the entire document, so requests submitted with a user selection are refused. Before patch, fully read every affected body/table paragraph. Refuses if style usage in stories/nested containers is uncertain. Character style definition/application is unsupported." }),
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'action'], properties: {
      path: PATH, action: { type: 'string', enum: ['create', 'patch'] },
      target: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string', minLength: 1, maxLength: 60 },
      character: { type: 'object', additionalProperties: false, properties: {
        bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strikethrough: { type: 'boolean' },
        fontFamily: { type: 'string', minLength: 1, maxLength: 128 }, fontLanguage: { type: 'integer', minimum: 0, maximum: 6 },
        fontSize: { type: 'number', minimum: 1, maximum: 400, description: 'pt' }, textColor: { type: 'string', minLength: 7, maxLength: 7 },
      } },
      paragraph: { type: 'object', additionalProperties: false, properties: {
        alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        lineSpacingPercent: { type: 'number', minimum: 50, maximum: 500 },
      } },
    } }, annotations: { readOnlyHint: false, destructiveHint: false },
    // Hosts match keywords as substrings, so bare 스타일/style would also match prose tone ("공무원 스타일").
    _meta: sessionMeta('style', dedupe(both({ ko: '문단 스타일', en: "paragraph style" }), both({ ko: '스타일 정의', en: "style definition" }), both({ ko: '스타일을 정의', en: "define style" }), both({ ko: '새 스타일', en: "new style" }), both({ ko: '스타일 만들', en: "create style" }), both({ ko: '스타일을 만들', en: "create a style" }), both({ ko: '스타일 추가', en: "add style" }), both({ ko: '스타일을 추가', en: "add a style" }), both({ ko: '스타일 수정', en: "modify style" }), both({ ko: '스타일을 수정', en: "modify a style" }), both({ ko: '스타일 편집', en: "edit style" }), both({ ko: '스타일을 편집', en: "edit a style" }), 'paragraph style', 'style definition')),
  },
  {
    name: 'edit_notes', title: L({ ko: '한글 문서 각주·미주 편집', en: "Edit HWP footnotes and endnotes" }),
    description: L({ ko: '작업본에 빈 각주·미주를 넣거나 기존 각주·미주 문단 끝에 글을 추가한다. 파일에는 저장하지 않는다. insert는 전체를 읽은 본문 문단 target과 Unicode code point offset, kind가 필요하다. 삽입 뒤 notes를 다시 읽고 append로 내용을 채운다. append는 read_document(mode=notes)가 준 문단 핸들 target과 text를 받으며 그 각주 전체를 먼저 읽어야 한다. 기존 번호·구분자·본문은 다시 쓰지 않는다. 추가 글의 서식은 지정할 수 없다. 사용자가 범위를 선택해 보낸 요청에서는 본문 앵커 문단 전체가 선택되어야 한다. 이미 각주·누름틀·개체가 있는 문단과 표 칸 안에는 넣지 못한다. 기존 텍스트 치환·각주 삭제는 미지원이다. 성공 뒤 핸들은 만료되므로 다시 읽는다.', en: "Inserts an empty footnote/endnote or appends text to an existing note paragraph in the working copy. Does not save the file. insert requires a fully read body paragraph target, Unicode code point offset, and kind. After insertion, read notes again and fill with append. append takes a paragraph handle target from read_document(mode=notes) and text; first read that entire note. Existing numbers, separators, and text are not rewritten. Formatting of appended text cannot be specified. A request submitted with a user selection must select the entire body anchor paragraph. Cannot insert into a paragraph with existing notes, fields, or objects, or into table cells. Replacing existing text/deleting notes is unsupported. Handles expire on success; read again." }),
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'action', 'target'], properties: {
      path: PATH, action: { type: 'string', enum: ['insert', 'append'] },
      target: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: 'insert: 본문 문단 핸들. append: notes 결과의 paragraphs[].handle(….p1). 각주 자체의 handle은 안 된다.', en: "insert: body paragraph handle. append: paragraphs[].handle from notes (….p1), not the note's own handle." }) },
      kind: { type: 'string', enum: ['footnote', 'endnote'] },
      offset: { type: 'integer', minimum: 0, description: L({ ko: 'insert에서만. 본문 문단 안 Unicode code point 위치.', en: "insert only. Unicode code point position in the body paragraph." }) },
      text: { type: 'string', minLength: 1, maxLength: 2000, description: L({ ko: 'append에서만. 줄바꿈 없음. 탭은 유지한다.', en: "append only. No line breaks. Tabs are preserved." }) },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('note', dedupe(both({ ko: '각주', en: "footnote" }), both({ ko: '미주', en: "endnote" }), 'footnote', 'endnote')),
  },
  {
    name: 'replace_text', title: L({ ko: '한글 문서 문구 바꾸기', en: "Replace text in HWP document" }),
    description: L({ ko: '한글 문서의 작업본에서 문구를 바꾼다. 파일에는 저장하지 않는다. find와 정확히 같은 문구(대소문자·공백 구분)를 찾아 replace로 바꾼다. 찾는 범위는 기본 문서 전체(본문과 표 셀)이며 within과 사용자 선택 범위로 좁혀진다. 기본은 그 범위에서 일치가 정확히 한 곳일 때만 바꾼다. 여러 곳이면 바꾸지 않고 후보를 돌려주니 within(핸들)이나 occurrence로 좁힌다. 바꾸기 전에 find_text나 read_document로 그 부분을 확인해야 한다. 누름틀·표·그림 같은 개체가 있는 문단은 바꾸지 않으며 다른 편집 도구도 마찬가지다. 그 문단은 사람이 고치도록 알린다.', en: "Replaces text in the HWP working copy without saving the file. Finds exact find text (case- and whitespace-sensitive) and replaces with replace. Default scope is the entire body and table cells, narrowed by within and the user selection. By default, replaces only when there is exactly one match in that scope. Multiple matches return candidates without changes; narrow with within (handle) or occurrence. First inspect the location with find_text/read_document. Paragraphs containing fields, tables, pictures, or other objects are not changed; the same applies to other edit tools. Ask the person to edit those paragraphs." }),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'find', 'replace'],
      properties: {
        path: PATH,
        find: { type: 'string', minLength: 1, maxLength: 1000, description: L({ ko: '바꿀 문구. 한 문단 안에 있어야 한다.', en: "Phrase to replace. Must be within one paragraph." }) },
        replace: { type: 'string', maxLength: 2000, description: L({ ko: '새 문구. 줄바꿈은 넣을 수 없다. 빈 문자열이면 지운다.', en: "Replacement text. No line breaks. Empty string deletes it." }) },
        within: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '찾을 범위를 좁히는 핸들(문단 d…:p3, 표 d…:t1, 셀 d…:t1:r2c1).', en: "Handle narrowing the search scope (paragraph d…:p3, table d…:t1, cell d…:t1:r2c1)." }) },
        occurrence: { type: 'string', enum: ['only', 'all', 'nth'], description: L({ ko: '기본값 only(정확히 한 곳). all은 찾는 범위(기본 문서 전체)의 모두, nth는 occurrenceIndex번째.', en: "Default only (exactly one match). all replaces all in the scope (entire document by default); nth selects occurrenceIndex." }) },
        occurrenceIndex: { type: 'integer', minimum: 1, maximum: 100000, description: L({ ko: 'occurrence가 nth일 때만 준다. 1부터 센다.', en: "Only with occurrence=nth. Count from 1." }) },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta(),
  },
  {
    name: 'edit_paragraphs', title: L({ ko: '한글 문서 문단 편집', en: "Edit HWP document paragraphs" }),
    description: L({ ko: '한글 문서 작업본의 본문이나 직접 표 셀 문단을 고치고, 넣고, 지운다. 파일에는 저장하지 않는다. operations는 action과 읽은 문단 target을 가진다. set은 전체 text를 바꾸므로 대상 원문을 expectedText에 그대로 넣고 변경안과 대조한다. 문단 핸들은 페이지 번호가 아니다. 부분 수정은 replace_text를 쓴다. insert_after·insert_before는 paragraphs를 문단 하나씩 넣는다. 새 문단은 target의 서식을 받는다. delete는 target을 지운다. 셀 마지막 문단은 지울 수 없다. set과 삽입에는 style을 줄 수 있다. 고치거나 지울 문단은 먼저 전체를 읽는다. 모든 작업은 한 번에 적용되거나 복원된다. 성공 결과의 새 핸들로 바로 이어서 편집할 수 있다. 누름틀·표·그림이 있는 문단은 고치거나 지우지 않는다.', en: "Changes, inserts, or deletes body/direct table-cell paragraphs in the working copy without saving the file. Each operation has action and a read paragraph target. set replaces the entire text: copy the exact original into expectedText and compare against the proposed change. Paragraph handles are not page numbers. Use replace_text for partial edits. insert_after/insert_before inserts each paragraphs item as a paragraph inheriting target formatting. delete removes target; the last cell paragraph cannot be deleted. set/insertion accepts style. Fully read paragraphs before changing/deleting them. Operations apply together or roll back. Continue immediately with new handles from a successful result. Paragraphs with fields/tables/pictures cannot be changed or deleted." }),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'operations'],
      properties: {
        path: PATH,
        operations: {
          type: 'array', minItems: 1, maxItems: 20, description: L({ ko: '한 번에 적용할 작업들.', en: "Operations to apply together." }),
          items: {
            type: 'object', additionalProperties: false, required: ['action', 'target'],
            properties: {
              action: { type: 'string', enum: ['set', 'insert_after', 'insert_before', 'delete'] },
              target: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '본문(d…:p3) 또는 직접 표 셀 문단 핸들(d…:t1:r2c1.p1).', en: "Body (d…:p3) or direct table-cell paragraph handle (d…:t1:r2c1.p1)." }) },
              text: { type: 'string', maxLength: 20000, description: L({ ko: 'set일 때만. 문단의 새 전체 내용. 줄바꿈 없음.', en: "set only. New entire paragraph text. No line breaks." }) },
              expectedText: { type: 'string', maxLength: 20000, description: L({ ko: 'set일 때 선택. 읽은 대상 문단의 현재 전체 원문을 공백과 문단 안 줄바꿈(\\n)까지 그대로 넣는다. 빈 문단은 빈 문자열. 선행 ASCII 공백만 다르고 text에도 같은 개수의 선행 공백이 있으면 원문 들여쓰기로 보정한다. 그 밖의 불일치는 거절하고 currentText를 돌려준다.', en: "Optional for set. Exact current full original text, including spaces and in-paragraph line breaks (\\\\n). Empty string for an empty paragraph. If only leading ASCII spaces differ and text has the same number of leading spaces, correct them as original indentation. Other mismatches are refused with currentText." }) },
              paragraphs: { type: 'array', minItems: 1, maxItems: 50, description: L({ ko: 'insert_after·insert_before일 때만. 넣을 문단들. Markdown 표 행은 거절한다. 표는 insert_table에 before 또는 after와 rows를 준다.', en: 'insert_after/insert_before only. Paragraphs to insert. Markdown table rows are rejected. For tables, call insert_table with before or after and rows.' }), items: { type: 'string', maxLength: 20000 } },
              style: { type: 'string', minLength: 1, maxLength: 200, description: L({ ko: 'set·삽입일 때만. 그 문단에 줄 문단 스타일 이름(예: 본문, 개요 1).', en: "set/insertion only. Paragraph style name to apply (e.g. 본문, 개요 1)." }) },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta(),
  },
  {
    name: 'rewrite_paragraphs', title: L({ ko: '한글 문서 연속 문단 윤문', en: "Rewrite consecutive HWP paragraphs" }),
    description: L({ ko: '같은 구역의 연속 본문 범위를 읽은 뒤 문단 배열로 윤문한다. 빈 간격 문단은 유지한다. paragraphs의 항목 수는 범위의 내용 문단 수보다 적을 수 없다(문단을 합치거나 지우지 못한다). 구역 첫 문단과 표·누름틀·개체·강제 줄바꿈 문단은 범위에서 제외하고 나누어 호출한다. 변경 전후와 서식 출처를 확인하고 필요하면 preview를 쓴다. 적용은 작업본에 한 번의 undo로 남으며 파일 저장은 별도다.', en: "After reading a consecutive body range within one section, rewrite it as a paragraph array. Empty spacer paragraphs stay. paragraphs cannot have fewer items than content paragraphs in the range (cannot merge/delete paragraphs). Exclude the section's first paragraph and paragraphs with tables, fields, objects, or forced line breaks; split calls around them. Check before/after and formatting sources; use preview if needed. Applies to the working copy as one undo step; file saving is separate." }),
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'from', 'to', 'paragraphs'], properties: {
      path: PATH,
      from: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '현재 읽기에서 얻은 첫 본문 문단 핸들.', en: "First body paragraph handle from the current read." }) },
      to: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '현재 읽기에서 얻은 마지막 본문 문단 핸들.', en: "Last body paragraph handle from the current read." }) },
      paragraphs: { type: 'array', minItems: 1, maxItems: 50, description: L({ ko: '빈 간격을 제외한 변경 후 문단 배열. 범위의 내용 문단마다 순서대로 하나 이상 있어야 한다. 항목에 줄바꿈을 넣지 않는다.', en: "Rewritten paragraphs excluding empty spacers. At least one item per content paragraph in range, in order. No line breaks in items." }), items: { type: 'string', minLength: 1, maxLength: 2000 } },
      splitHints: { type: 'array', maxItems: 40, description: L({ ko: '분할 출처가 모호할 때 원문 핸들과 출력의 0부터인 반열린 인덱스 범위를 원문 순서로 지정한다.', en: "When split provenance is ambiguous, provide source handles and 0-based half-open output index ranges in source order." }), items: { type: 'object', additionalProperties: false, required: ['source', 'outputStart', 'outputEnd'], properties: {
        source: { type: 'string', minLength: 1, maxLength: 128 }, outputStart: { type: 'integer', minimum: 0, maximum: 49 }, outputEnd: { type: 'integer', minimum: 2, maximum: 50 },
      } } },
    } }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('rewrite', dedupe(both({ ko: '윤문', en: "rewrite" }), both({ ko: '문장', en: "sentence" }), both({ ko: '다듬', en: "polish" }), 'rewrite', 'polish')),
  },
  {
    name: 'update_table', title: L({ ko: '한글 문서 표 고치기', en: "Edit HWP document table" }),
    description: L({ ko: '본문 표를 편집한다. cells, match+set, checkBoxes, backgrounds, insertRowAfter, deleteRow, insertColumnAfter, deleteColumn, merge, split, deleteTable 중 하나만 지정한다. 행·열은 1부터, 병합 칸은 첫 칸이다. cells는 칸 내용을 바꾸며 기존 글이 있으면 overwrite:true가 필요하다. match+set은 머리글과 값으로 유일한 행을 고른다. checkBoxes는 글자나 글머리표의 □를 ☑로 바꾼다. 겹친 개체가 있는 칸은 채우거나 체크하지 않는다. backgrounds는 #RRGGBB 또는 none이다. 행·열 삽입과 삭제, 직사각형 병합과 원래 격자 분할, 표 삭제를 지원한다. 삭제할 내용·병합 대상과 선택 범위를 보호하며 구조 변경 뒤 핸들은 만료된다. 대상 칸을 먼저 read_document로 확인하라.', en: "Edits a body table. Specify exactly one of cells, match+set, checkBoxes, backgrounds, insertRowAfter, deleteRow, insertColumnAfter, deleteColumn, merge, split, deleteTable. Rows/columns are 1-based; address merged cells by their first cell. cells replaces content; existing text requires overwrite:true. match+set selects a unique row by header/value. checkBoxes changes text/bullet □ to ☑. Does not fill/check cells overlapped by objects. backgrounds accepts #RRGGBB or none. Supports inserting/deleting rows/columns, rectangular merges, splitting to the original grid, and deleting tables. Protects deleted content, merge targets, and selection scope. Structural changes expire handles. Inspect target cells with read_document first." }),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'table'],
      properties: {
        path: PATH,
        table: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '표 핸들(d…:t1).', en: "Table handle (d…:t1)." }) },
        checkBoxes: { type: 'array', minItems: 1, maxItems: 100, description: L({ ko: '체크할 칸. 상자가 여러 개면 choice에 옆의 문구를 쓴다.', en: "Cells to check. If there are multiple boxes, choice specifies the adjacent phrase." }), items: {
          type: 'object', additionalProperties: false, required: ['row', 'col'], properties: {
            row: { type: 'integer', minimum: 1, maximum: 10000 }, col: { type: 'integer', minimum: 1, maximum: 1000 }, choice: { type: 'string', minLength: 1, maxLength: 200 },
          },
        } },
        backgrounds: {
          type: 'array', minItems: 1, maxItems: 100, description: L({ ko: '칸별 배경색만 바꾼다. 다른 작업 방식과 함께 쓰지 않는다. 행·열은 1부터, 병합 칸은 첫 행·열이다. 칸 전체를 먼저 읽고 선택 범위에 포함해야 한다. 텍스트·테두리는 유지한다.', en: "Changes only cell backgrounds. Do not combine with other operation modes. Rows/columns are 1-based; address merged cells by their first row/column. Fully read each cell first and include it in the selection. Preserves text/borders." }),
          items: { type: 'object', additionalProperties: false, required: ['row', 'col', 'color'], properties: {
            row: { type: 'integer', minimum: 1, maximum: 10000 }, col: { type: 'integer', minimum: 1, maximum: 1000 },
            color: { type: 'string', minLength: 4, maxLength: 7, description: L({ ko: '#RRGGBB. none은 배경 지우기.', en: "#RRGGBB. none clears the background." }) },
          } },
        },
        cells: {
          type: 'array', minItems: 1, maxItems: 100, description: L({ ko: '칸별로 바꿀 내용.', en: "Replacement content by cell." }),
          items: { type: 'object', additionalProperties: false, required: ['row', 'col', 'text'], properties: {
            row: { type: 'integer', minimum: 1, maximum: 10000 }, col: { type: 'integer', minimum: 1, maximum: 1000 },
            text: { type: 'string', maxLength: 20000, description: L({ ko: '칸의 새 전체 내용. 줄바꿈 없음.', en: "New entire cell text. No line breaks." }) } } },
        },
        match: { type: 'object', additionalProperties: false, required: ['column', 'equals'], description: L({ ko: 'set과 함께 준다. 바꿀 행을 고른다. 병합 칸이 없는 표에서만 쓴다.', en: "With set. Selects the row to change. Only for tables without merged cells." }), properties: {
          column: { type: 'string', minLength: 1, maxLength: 1000, description: L({ ko: '첫 행의 머리글.', en: "Header in the first row." }) }, equals: { type: 'string', maxLength: 1000, description: L({ ko: '그 열에서 이 내용과 같은 행.', en: "Row whose content in that column equals this value." }) } } },
        set: {
          type: 'array', minItems: 1, maxItems: 100, description: L({ ko: 'match와 함께 준다. 고른 행에서 바꿀 칸들.', en: "With match. Cells to change in the selected row." }),
          items: { type: 'object', additionalProperties: false, required: ['column', 'text'], properties: {
            column: { type: 'string', minLength: 1, maxLength: 1000, description: L({ ko: '첫 행의 머리글.', en: "Header in the first row." }) }, text: { type: 'string', maxLength: 20000, description: L({ ko: '칸의 새 전체 내용. 줄바꿈 없음.', en: "New entire cell text. No line breaks." }) } } },
        },
        overwrite: { type: 'boolean', description: L({ ko: 'cells·set과 함께. true면 이미 글이 있는 칸도 바꾼다. 사용자가 그 내용을 바꾸라고 했을 때만 준다.', en: "With cells/set. true permits replacing nonempty cells. Supply only when the user requested changing that content." }) },
        insertRowAfter: { type: 'integer', minimum: 1, maximum: 10000, description: L({ ko: '이 행(1부터) 아래에 빈 행을 넣는다.', en: "Insert empty rows below this 1-based row." }) },
        count: { type: 'integer', minimum: 1, maximum: 20, description: L({ ko: 'insertRowAfter와 함께. 넣을 행 수. 기본값 1.', en: "With insertRowAfter. Number of rows to insert. Default: 1." }) },
        deleteRow: { type: 'integer', minimum: 1, maximum: 10000, description: L({ ko: '이 행(1부터)을 지운다.', en: "Delete this 1-based row." }) },
        insertColumnAfter: { type: 'integer', minimum: 1, maximum: 1000, description: L({ ko: '열 오른쪽에 빈 열 하나를 넣는다. 1부터.', en: "Insert one empty column to the right of this 1-based column." }) },
        deleteColumn: { type: 'integer', minimum: 1, maximum: 1000, description: L({ ko: '열 하나를 지운다. 1부터.', en: "Delete one 1-based column." }) },
        merge: { type: 'object', additionalProperties: false, required: ['startRow', 'startCol', 'endRow', 'endCol'], description: L({ ko: '직사각형 병합. 왼쪽 위 외의 칸은 비어 있어야 한다. 기존 병합 칸을 자르지 않는다.', en: "Rectangular merge. Cells other than the top-left must be empty. Does not cut existing merged cells." }), properties: {
          startRow: { type: 'integer', minimum: 1, maximum: 10000 }, startCol: { type: 'integer', minimum: 1, maximum: 1000 },
          endRow: { type: 'integer', minimum: 1, maximum: 10000 }, endCol: { type: 'integer', minimum: 1, maximum: 1000 },
        } },
        split: { type: 'object', additionalProperties: false, required: ['row', 'col'], description: L({ ko: '병합 칸을 원래 격자로 나눈다. 왼쪽 위 주소만 받는다.', en: "Split a merged cell to its original grid. Takes only the top-left address." }), properties: {
          row: { type: 'integer', minimum: 1, maximum: 10000 }, col: { type: 'integer', minimum: 1, maximum: 1000 },
        } },
        deleteTable: { type: 'boolean', enum: [true], description: L({ ko: '표 전체를 지운다. 전체 칸 관측과 표 문단 전체 선택이 필요하다. 개체가 있으면 거절한다.', en: "Delete the entire table. Requires observing all cells and selecting the entire table paragraph. Refuses if objects exist." }) },
      },
    },
    // Verbex checks trim() only for emptiness, then matches the original keyword; leading spaces avoid compounds such as 발표는 and 목표로, but do not match at the start of a request.
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...sessionMeta(), 'dev.agentinterop/group': 'table', 'dev.agentinterop/keywords': TABLE_KEYWORDS },
  },
  {
    name: 'insert_table', title: L({ ko: '한글 문서에 표 넣기', en: "Insert table in HWP document" }),
    description: L({ ko: '한글 문서 작업본의 본문 문단 앞이나 뒤에 새 표를 넣고 칸을 채운다. 파일에는 저장하지 않는다. after와 before 중 정확히 하나를 준다. 제목 앞에 넣으려면 before에 그 제목 문단을 준다. rows는 행의 배열이고 각 행은 칸 내용의 배열이다. 모든 행의 칸 수가 같아야 한다. headerRow가 true면 첫 행을 굵게 가운데 정렬한다. caption을 주면 표 바로 다음 문단에 그 글을 넣는다. 기준 문단을 먼저 read_document나 find_text로 확인해야 한다. 누름틀이 있는 문단 앞은 지원하지 않는다. 성공 결과는 표가 든 문단과 그 다음 문단의 새 문단 핸들(d…:pN)을 주며, 그 문단은 바로 이어서 편집할 수 있다. 표 칸을 고치려면 다시 읽어 표 핸들(d…:tN)을 얻는다.', en: "Inserts and fills a new table before or after a body paragraph in the working copy without saving the file. Supply exactly one of after and before. To insert before a heading, pass that heading paragraph as before. rows is an array of rows, each an array of cell contents; every row must have the same number of cells. headerRow:true makes the first row bold and centered. caption inserts text in the paragraph immediately after the table. First inspect the anchor with read_document/find_text. Insertion before a paragraph containing input fields is unsupported. Success returns new paragraph handles (d…:pN) for the table paragraph and following paragraph, which can be edited immediately. To edit table cells, read again for a table handle (d…:tN)." }),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'rows'],
      properties: {
        path: PATH,
        after: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '이 본문 문단(d…:p3) 뒤에 표를 넣는다.', en: "Insert a table after this body paragraph (d…:p3)." }) },
        before: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '이 본문 문단(d…:p3) 앞에 표를 넣는다. 제목 앞에 넣으려면 그 제목 문단을 준다. after와 정확히 하나만 준다.', en: 'Insert a table before this body paragraph (d…:p3). For insertion before a heading, pass that heading paragraph. Supply exactly one of before and after.' }) },
        rows: { type: 'array', minItems: 1, maxItems: 50, description: L({ ko: '표의 행들. 첫 행부터.', en: "Table rows, starting with the first." }),
          items: { type: 'array', minItems: 1, maxItems: 20, description: L({ ko: '한 행의 칸 내용들. 왼쪽부터.', en: "Cell contents in one row, from left to right." }), items: { type: 'string', maxLength: 2000, description: L({ ko: '칸 내용. 줄바꿈 없음. 빈 문자열이면 빈 칸.', en: "Cell content. No line breaks. Empty string means an empty cell." }) } } },
        headerRow: { type: 'boolean', description: L({ ko: 'true면 첫 행을 머리글로 꾸민다.', en: "If true, format the first row as headers." }) },
        caption: { type: 'string', minLength: 1, maxLength: 1000, description: L({ ko: '표 다음의 일반 문단에 넣을 설명(캡션 개체 아님). 줄바꿈 없음.', en: "Description in an ordinary paragraph after the table (not a caption object). No line breaks." }) },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...sessionMeta(), 'dev.agentinterop/group': 'table', 'dev.agentinterop/keywords': TABLE_KEYWORDS },
  },
  {
    name: 'fill_fields', title: L({ ko: '한글 문서 누름틀 채우기', en: "Fill HWP document input fields" }),
    description: L({ ko: '한글 문서 작업본의 누름틀(입력란)을 채운다. 파일에는 저장하지 않는다. 먼저 read_document로 현재 누름틀 이름과 값을 읽은 뒤 호출한다. values의 각 항목은 누름틀 이름 field와 넣을 값 value다. 모두 한 번에 적용되거나 전혀 적용되지 않는다. 같은 이름의 누름틀이 여러 개면 채우지 않고 후보의 핸들(d…:f3)을 돌려주니, 채울 것의 핸들을 field에 준다. 지금 값을 확인하지 않았으면 거절하면서 지금 값을 알려 주니 같은 요청을 다시 보낸다.', en: "Fills input fields in the working copy without saving the file. First read current field names/values with read_document. Each values item has a field name field and replacement value. All items apply together or not at all. Duplicate names return candidate handles (d…:f3) without filling; supply the desired handle as field. If the current value has not been observed, refuses and shows it; then repeat the same request." }),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'values'],
      properties: {
        path: PATH,
        values: {
          type: 'array', minItems: 1, maxItems: 100, description: L({ ko: '채울 누름틀들.', en: "Input fields to fill." }),
          items: { type: 'object', additionalProperties: false, required: ['field', 'value'], properties: {
            field: { type: 'string', minLength: 1, maxLength: 1000, description: L({ ko: '누름틀 이름, 또는 이름이 겹칠 때 받은 누름틀 핸들(d…:f3).', en: "Input field name, or the field handle returned for duplicate names (d…:f3)." }) }, value: { type: 'string', maxLength: 20000, description: L({ ko: '넣을 값. 줄바꿈 없음. 빈 문자열이면 비운다.', en: "Value to insert. No line breaks. Empty string clears it." }) } } },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...sessionMeta(), 'dev.agentinterop/group': 'field', 'dev.agentinterop/keywords': dedupe(both({ ko: "누름틀", en: "input field" }), both({ ko: "필드", en: "field" }), both({ ko: "수신", en: "recipient" }), both({ ko: "제목", en: "title" }), "field") },
  },
  {
    name: 'format_text', title: L({ ko: '한글 문서 서식 바꾸기', en: "Change HWP document formatting" }),
    description: L({ ko: '한글 문서 작업본에서 문단 하나의 서식을 바꾼다. 파일에는 저장하지 않는다. target은 문단 핸들이다. find를 주면 그 문단 안의 그 문구(정확히 한 곳)에만 글자 서식을 준다. 문구만 서식을 바꿀 때는 요청한 문구를 find에 정확히 지정한다. find가 없으면 문단 전체에 글자 서식, 문단 서식, style(문단 스타일 이름)을 준다. 서식 인자를 하나 이상 준다. 글자는 바뀌지 않는다. 먼저 read_document나 find_text로 그 문단을 확인해야 한다.', en: "Changes formatting of one paragraph in the working copy without saving the file. target is a paragraph handle. With find, applies character formatting only to that phrase (exactly one match). When formatting a phrase, specify the exact requested text as find. Without find, applies character/paragraph formatting and style (paragraph style name) to the whole paragraph. Supply at least one formatting argument. Text is unchanged. Inspect the paragraph with read_document/find_text first." }),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'target'],
      properties: {
        path: PATH,
        target: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '문단 핸들(d…:p3) 또는 칸 문단 핸들(d…:t1:r2c1.p1).', en: "Paragraph handle (d…:p3) or cell-paragraph handle (d…:t1:r2c1.p1)." }) },
        find: { type: 'string', minLength: 1, maxLength: 1000, description: L({ ko: '이 문구에만 글자 서식을 준다. 생략하면 문단 전체.', en: "Apply character formatting only to this phrase. Omit for the entire paragraph." }) },
        match: { type: 'object', additionalProperties: false, description: L({ ko: '바꿀 구간을 고르는 지금 서식 조건(예: {"color":"#ff0000"}은 지금 빨간 글자). 새 서식은 바깥 인자로 준다. 먼저 문단 본문 전체를 읽고, read_document(mode=formatting)으로 조건에 맞는 모든 서식 구간을 끝까지 읽는다. find·문단 서식·style과 함께 쓰지 않는다.', en: "Current formatting conditions selecting runs to change (e.g. {\"color\":\"#ff0000\"} selects currently red text). Supply new formatting as outer arguments. First read the entire paragraph text and all matching runs through the end with read_document(mode=formatting). Do not combine with find, paragraph formatting, or style." }), properties: {
          color: { type: 'string', minLength: 7, maxLength: 7 }, fontSizePt: { type: 'number', minimum: 1, maximum: 400 },
        } },
        style: { type: 'string', minLength: 1, maxLength: 200, description: L({ ko: '문단 스타일 이름(예: 본문, 개요 1). find와 함께 줄 수 없다.', en: "Paragraph style name (e.g. 본문, 개요 1). Cannot combine with find." }) },
        bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strikethrough: { type: 'boolean', description: L({ ko: '취소선.', en: "Strikethrough." }) },
        fontFamily: { type: 'string', minLength: 1, maxLength: 128, description: L({ ko: '글꼴 이름. fontLanguage 생략 시 모든 언어에 적용.', en: "Font name. Applies to all languages if fontLanguage is omitted." }) },
        fontLanguage: { type: 'integer', minimum: 0, maximum: 6, description: L({ ko: 'fontFamily와 함께 사용: 0 한글, 1 영문, 2 한자, 3 일본어, 4 기타, 5 기호, 6 사용자.', en: "With fontFamily: 0 Korean, 1 Latin, 2 Chinese characters, 3 Japanese, 4 other, 5 symbols, 6 user." }) },
        fontSizePt: { type: 'number', minimum: 1, maximum: 400, description: L({ ko: '글자 크기(pt).', en: "Font size (pt)." }) },
        color: { type: 'string', minLength: 7, maxLength: 7, description: L({ ko: '글자 색 #RRGGBB.', en: "Text color #RRGGBB." }) },
        highlight: { type: 'string', minLength: 7, maxLength: 7, description: L({ ko: '형광펜 색 #RRGGBB. #ffffff면 지운다.', en: "Highlight color #RRGGBB. #ffffff clears it." }) },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: L({ ko: '문단 정렬. find와 함께 줄 수 없다.', en: "Paragraph alignment. Cannot combine with find." }) },
        indentMm: { type: 'number', minimum: -200, maximum: 200, description: L({ ko: '첫 줄 들여쓰기(mm). 음수는 내어쓰기.', en: "First-line indent (mm). Negative means hanging indent." }) },
        lineSpacingPercent: { type: 'number', minimum: 50, maximum: 500, description: L({ ko: '줄 간격(%).', en: "Line spacing (%)." }) },
        spaceBeforePt: { type: 'number', minimum: 0, maximum: 500, description: L({ ko: '문단 위 간격(pt).', en: "Space before paragraph (pt)." }) },
        spaceAfterPt: { type: 'number', minimum: 0, maximum: 500, description: L({ ko: '문단 아래 간격(pt).', en: "Space after paragraph (pt)." }) },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...sessionMeta(), 'dev.agentinterop/group': 'format', 'dev.agentinterop/keywords': dedupe(both({ ko: "서식", en: "format" }), both({ ko: "굵게", en: "bold" }), both({ ko: "기울임", en: "italic" }), both({ ko: "정렬", en: "align" }), both({ ko: "글자", en: "character" }), "pt", "bold", "italic") },
  },
  {
    name: 'undo_last_edit', title: L({ ko: '마지막 AI 편집 되돌리기', en: "Undo last AI edit" }),
    description: L({ ko: '이 대화가 이 문서에 한 마지막 편집 도구 호출 하나만 되돌린다(연달아 불러도 그 앞은 되돌리지 못한다). 그 뒤에 사람이나 다른 편집이 있었으면 되돌리지 않는다. 되돌리면 핸들이 모두 바뀌므로 다시 읽어야 한다.', en: "Undoes only this conversation's last edit tool call in this document (repeated calls cannot undo earlier calls). Refuses if a person or another edit changed the document afterward. All handles change after undo; read again." }),
    inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: PATH } },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('history', dedupe(both({ ko: '되돌', en: "undo" }), both({ ko: '취소', en: "cancel" }), 'undo')),
  },
];
/** Read effect, but it reports the AI edit ledger, so it is described only together with the edit tools. */
const CHECK_TOOL: JsonObject = {
  name: 'check_before_save', title: L({ ko: '저장 전 한글 문서 점검', en: "Check HWP document before saving" }),
  description: L({ ko: '한글 문서 작업본을 지금 저장하면 내용이 보존되는지, 이 문서에서 할 수 없는 편집, 사람의 저장을 기다리는 AI 편집을 알려 준다. 문서를 바꾸지 않는다. 큰 문서에서는 오래 걸릴 수 있으니 편집을 마친 뒤 한 번만 부른다.', en: "Reports whether saving the working copy now preserves content, unsupported edits in this document, and AI edits awaiting a person's save. Does not change the document. May take time on large documents; call once after editing is finished." }),
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: { path: PATH, pages: { type: 'array', minItems: 1, maxItems: 5, description: L({ ko: '화면 모양까지 비교할 쪽 번호(1부터). 생략하면 첫 쪽.', en: "1-based page numbers to compare visually as well. Defaults to the first page." }), items: { type: 'integer', minimum: 1, maximum: 100000 } } },
  },
  annotations: { readOnlyHint: true }, _meta: meta({ 'dev.agentinterop/group': 'verify', 'dev.agentinterop/keywords': dedupe(both({ ko: '점검', en: "check" }), both({ ko: '보존 검사', en: "preservation check" }), both({ ko: '호환', en: "compatibility" }), 'verify') }),
};
/** Commit effect: the host asks a person about every single save and checkpoints the files before it lets this provider write. */
const SAVE_TOOL: JsonObject = {
  name: 'save_document', title: L({ ko: '한글 문서 저장', en: "Save HWP document" }),
  description: L({ ko: '한글 문서 작업본을 그 문서의 파일에 저장한다. 사용자가 저장을 요청했을 때만 부른다. 부를 때마다 사람이 저장을 승인해야 하고, 거절하면 저장하지 않는다. 사람이 입력 중이거나 승인하는 동안 문서나 파일이 바뀌면 저장하지 않으니 그때는 다시 요청한다. destination을 주면 같은 형식의 새 경로에 사본을 저장한다. 원본 작업본은 그대로 남고 저장되지 않는다.', en: "Saves the working copy to its document file. Call only when the user requests saving. A person must approve each call; refusal saves nothing. Does not save while a person is typing or if the document/file changes during approval; request again then. destination saves a copy to a new path in the same format. The original working copy remains and is not saved." }),
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: PATH, destination: { ...PATH, description: L({ ko: '다른 이름으로 저장할 새 경로. 생략하면 원본 저장.', en: "New path for Save As. Omit to save the original." }) } } },
  annotations: { readOnlyHint: false, destructiveHint: true }, _meta: { ...meta(), 'dev.agentinterop/effect': 'commit', 'dev.agentinterop/group': 'save', 'dev.agentinterop/keywords': dedupe(both({ ko: '저장', en: "Save" }), both({ ko: '사본', en: "copy" }), 'save') },
};
const CREATE_TOOL: JsonObject = {
  name: 'create_document', title: L({ ko: '새 한글 문서 만들기', en: "Create new HWP document" }),
  description: L({ ko: '새 경로에 빈 한글 문서 또는 template 파일의 사본을 만든다. template은 디스크에 저장된 같은 형식의 HWP/HWPX 경로다. 내용을 채우는 도구가 아니므로 생성 뒤 read_document로 문단을 읽고 편집한다. 사람이 매번 폴더·문서·인덱스 생성을 승인하며 기존 파일을 덮어쓰지 않는다.', en: "Creates an empty HWP document or a copy of a template file at a new path. template is a disk-saved HWP/HWPX path in the same format. Does not fill content; after creation, read paragraphs with read_document, then edit. A person approves folder/document/index creation each time. Never overwrites existing files." }),
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: PATH, template: PATH } },
  annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...meta(), 'dev.agentinterop/effect': 'commit', 'dev.agentinterop/group': 'create', 'dev.agentinterop/keywords': dedupe(both({ ko: '새 한글', en: "new HWP" }), both({ ko: '새 문서', en: "new document" }), both({ ko: '만들', en: "make" }), both({ ko: '생성', en: "create" }), both({ ko: '템플릿', en: "template" }), 'create', 'template') },
};
const SAVE_INSTRUCTIONS = L({ ko: ' 사용자가 저장을 요청하면 save_document를 부른다. 새 파일은 create_document로 만든 뒤 읽고 편집한다. 그때마다 사람이 승인하며, 요청받지 않은 저장은 하지 않는다.', en: " Call save_document when the user requests saving. Create new files with create_document, then read and edit. A person approves each time; never save without a request." });
const EDIT_INSTRUCTIONS = L({ ko: '한글(HWP/HWPX) 작업본을 편집한다. 파일 저장은 사람이 한다. 대상 경로를 고정하고 확장자를 임의로 바꾸지 않는다. 전체 요청은 cursor를 따라 끝까지 읽는다. 연속 문단 윤문은 rewrite_paragraphs, 문구는 replace_text, 문단 전체·삽입·삭제는 edit_paragraphs, 표는 update_table 또는 insert_table, 초안은 apply_draft, 누름틀은 fill_fields, 서식은 format_text를 쓴다. 핸들 p12는 페이지가 아니라 문단이며 해당 문서 상태에서만 유효하다. 원문의 사실·시제·불확실성·기호와 주석 참조를 보존하고 내용을 지어내지 않는다. 혼합 서식 오류는 formatting으로 실제 구간을 확인해 작은 범위로 나눈다. 예외 확인창이 열리면 사람의 결정을 기다린다. 승인 후 같은 변경을 재요청하면 해당 편집만 서식 손실이 가능하다. 저수준 삭제·삽입으로 보호를 우회하지 않는다. 사람이 거절하면 강요하지 않는다. 문단별 줄 수는 layout에 target을 주어 추정하고 화면에서 확인한다. 추정이나 미검증을 완료로 보고하지 않는다. 텍스트·서식 동시 요청은 텍스트 수정, 재조회, format_text 순서로 처리한다. Markdown 기호를 임의로 넣지 않는다. 양식은 빈 칸을 채우고 누름틀 안내문은 fill_fields를 쓴다. 확인되지 않은 이름·날짜·금액 등은 지어내지 않는다. 구조가 바뀌거나 사람이 편집하면 다시 읽는다. 바꾸지 못한 곳과 미확인 범위를 알린다. preview는 미리보기이며 작업본 적용이 아니다. 사용자가 적용을 요청했다면 preview 뒤 같은 입력을 preview 없이 다시 호출하고 결과의 적용 여부를 확인한다. 적용이 확인되지 않으면 적용했다고 말하지 않는다.', en: "Edit HWP/HWPX working copies. A person saves files. Pin the path; never change its extension arbitrarily. For whole-document requests, follow cursors to the end. Use rewrite_paragraphs for consecutive prose, replace_text for phrases, edit_paragraphs for whole paragraphs/insertion/deletion, update_table/insert_table for tables, apply_draft for drafts, fill_fields for input fields, format_text for formatting. p12 is a paragraph, not a page; handles belong to that document state. Preserve facts, tense, uncertainty, symbols, and note references; invent nothing. For mixed-format errors, inspect actual runs with formatting and split into small ranges. Wait for the person's exception-dialog decision. After approval, repeating the same change permits formatting loss for that edit only. Never bypass safeguards with low-level deletion/insertion or pressure a refusal. Estimate paragraph lines using layout with target; confirm onscreen. Do not report estimates/unverified work as complete. For text+formatting requests: edit text, reread, then format_text. Do not add arbitrary Markdown symbols. Fill blank form cells; use fill_fields for field prompts. Invent no unconfirmed names/dates/amounts. Reread after structural or human edits. Report unchanged locations and unchecked scope. preview does not apply to the working copy. If application was requested, repeat the same input without preview after previewing; verify the result confirms application before claiming it." });
const INSTRUCTIONS = L({ ko: '한글(HWP/HWPX) 문서를 읽는 도구다. 문서 내용에 대해 답하기 전에 read_document나 find_text로 실제 내용을 확인한다. 핸들(d…:p12, d…:t3:r2c1)은 그 결과가 나온 문서 상태에서만 유효하다. 문서가 바뀌면 다시 읽는다. 이 도구들은 문서를 바꾸지 않는다.', en: "Tools for reading HWP/HWPX documents. Before answering about content, inspect it with read_document or find_text. Handles (d…:p12, d…:t3:r2c1) are valid only for the document state that produced them. Reread after changes. These tools do not modify documents." });


const EDIT_TOOL_NAMES = EDIT_TOOLS.map(tool => tool.name as string);
// The preview uses the same input and domain validation as the real edit.
for (const tool of EDIT_TOOLS) if (tool.name !== 'undo_last_edit') {
  const schema = tool.inputSchema as JsonObject;
  (schema.properties as JsonObject).preview = { type: 'boolean', description: L({ ko: 'true면 실제 엔진으로 실행한 뒤 복원하고 예상 변경만 보고한다. 파일·작업본·undo·AI 원장을 바꾸지 않는다. 쓰기 승인/관측 토큰이 아니며 실적용은 preview를 빼고 현재 대상·관측·선택을 다시 검증한다. 저장 보존이나 한컴 호환 검증은 아니다.', en: "If true, run with the real engine, restore, and report projected changes only. Does not change files, working copy, undo, or AI ledger. Not write approval or an observation token. To apply, omit preview and revalidate the current target, observations, and selection. Does not verify save preservation or Hancom compatibility." }) };
}
const TOOL_CATALOG = [...DESCRIPTOR_TOOLS, ...EDIT_TOOLS, CHECK_TOOL, SAVE_TOOL, CREATE_TOOL];

/** Examples are kept with the schemas; handles are illustrative and must come from a fresh read. */
const TOOL_EXAMPLES: Record<string, JsonObject> = {
  edit_notes: { path: 'sample.hwpx', action: 'insert', target: 'd1:p2', kind: 'footnote', offset: 4 },
  edit_styles: { path: 'sample.hwpx', action: 'create', name: L({ ko: '검토 본문', en: "Review body" }), character: { bold: true } },
  update_section: { path: 'sample.hwpx', target: 'd1:section1', page: { marginLeftMm: 25 } },
  read_document: { path: 'sample.hwpx', mode: 'formatting', target: 'd1:p2' },
  replace_text: { path: 'sample.hwpx', find: L({ ko: '초안', en: "draft" }), replace: L({ ko: '확정', en: "Final" }), within: 'd1:p2' },
  apply_draft: { path: 'sample.hwpx', target: 'd1:p2', position: 'after', paragraphs: [L({ ko: '첫 문단', en: "First paragraph" }), L({ ko: '검토 중', en: "Under review" }), L({ ko: '마지막 문단', en: "Last paragraph" })], accept: [1, 3], preview: true },
  edit_paragraphs: { path: 'sample.hwpx', operations: [{ action: 'set', target: 'd1:p2', expectedText: L({ ko: '원래 문단', en: "Original paragraph" }), text: L({ ko: '새 문단', en: "New paragraph" }) }] },
  rewrite_paragraphs: { path: 'sample.hwpx', from: 'd1:p2', to: 'd1:p3', paragraphs: [L({ ko: '바꾼 문단', en: "Rewritten paragraph" }), L({ ko: '다음 문단', en: "Next paragraph" })], preview: true },
  update_table: { path: 'sample.hwpx', table: 'd1:t1', backgrounds: [{ row: 1, col: 1, color: '#FFFFFF' }] },
};
return { DESCRIPTOR_TOOLS, EDIT_TOOLS, CHECK_TOOL, SAVE_TOOL, CREATE_TOOL, SAVE_INSTRUCTIONS, EDIT_INSTRUCTIONS, INSTRUCTIONS, EDIT_TOOL_NAMES, TOOL_CATALOG, TOOL_EXAMPLES };
}
export const { DESCRIPTOR_TOOLS, EDIT_TOOLS, CHECK_TOOL, SAVE_TOOL, CREATE_TOOL, SAVE_INSTRUCTIONS, EDIT_INSTRUCTIONS, INSTRUCTIONS, EDIT_TOOL_NAMES, TOOL_CATALOG, TOOL_EXAMPLES } = createToolCatalog();
const L = select;
const LT = selectLazy;
export function contractGuide(tools: JsonObject[], locale: Locale = getLocale()): string {
  // Required fields are already present verbatim in every inputSchema. Refer to them
  // rather than repeating the list, keeping the English instructions within the host cap.
  if (locale === 'en') return ' Required fields, ranges and allowed values follow each inputSchema. Omit unused arguments instead of null or empty arrays; call no-argument tools with {}. Correct errors using path and allowed.';
  return L({ ko: ' 입력 필드: ', en: " Input fields: " }) + tools.map(tool => {
    const schema = tool.inputSchema as JsonObject;
    return `${typeof tool.name === 'string' ? tool.name : JSON.stringify(tool.name)}(${(schema.required as string[] | undefined ?? []).join(',')})`;
  }).join('; ') + L({ ko: '. 범위·허용값은 각 inputSchema를 따른다. 쓰지 않는 인자는 null이나 빈 배열로 채우지 말고 빼고, 인자가 없는 도구는 {}로 부른다. 오류의 path·allowed를 확인해 수정한다.', en: ". Ranges and allowed values follow each inputSchema. Omit unused arguments rather than sending null or empty arrays; call tools without arguments with {}. Correct errors using path and allowed." });
}

/** Shape validation uses exactly the schema sent to the host. Domain/observation checks stay in edit.ts. */
export interface InputIssue { message: string; details: JsonObject }
export function validateToolInput(name: string, args: unknown): InputIssue | undefined {
  const tool = TOOL_CATALOG.find(tool => tool.name === name);
  if (!tool) return undefined;
  const issue = (path: string, rule: string, allowed: Json): InputIssue => ({
    message: LT({ ko: () => `${path || '$'}: ${rule}. 허용값을 확인해 입력을 수정하라.`, en: () => `${path || '$'}: ${rule}. Check allowed values and correct the input.` }),
    details: { path: path || '$', rule, allowed, suggestion: L({ ko: '같은 요청을 반복하지 말고 해당 항목을 수정하라.', en: "Correct the indicated field instead of repeating the same request." }),
      ...( /\[(\d+)\]/.test(path) ? { index: Number(path.match(/\[(\d+)\]/)![1]) } : {}) },
  });
  const walk = (schema: JsonObject, value: unknown, path: string): InputIssue | undefined => {
    const kind = schema.type;
    const valid = kind === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : kind === 'array' ? Array.isArray(value) : kind === 'integer' ? Number.isSafeInteger(value)
      : kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === kind;
    if (!valid) return issue(path, 'type', kind);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value as Json)) return issue(path, 'enum', schema.enum);
    for (const [key, bad] of [
      ['minimum', typeof value === 'number' && value < Number(schema.minimum)],
      ['maximum', typeof value === 'number' && value > Number(schema.maximum)],
      ['minLength', typeof value === 'string' && value.length < Number(schema.minLength)],
      ['maxLength', typeof value === 'string' && value.length > Number(schema.maxLength)],
      ['minItems', Array.isArray(value) && value.length < Number(schema.minItems)],
      ['maxItems', Array.isArray(value) && value.length > Number(schema.maxItems)],
    ] as const) if (schema[key] !== undefined && bad) return issue(path, key, { [key]: schema[key]! });
    if (kind === 'object') {
      const props = schema.properties as JsonObject, object = value as Record<string, unknown>;
      for (const key of (schema.required ?? []) as string[]) if (object[key] === undefined) return issue(path ? `${path}.${key}` : key, 'required', true);
      for (const [key, child] of Object.entries(object)) {
        const childPath = path ? `${path}.${key}` : key;
        if (!Object.hasOwn(props, key)) { if (schema.additionalProperties === false) return issue(childPath, 'additionalProperties', Object.keys(props)); }
        else { const found = walk(props[key] as JsonObject, child, childPath); if (found) return found; }
      }
    }
    if (kind === 'array') for (const [index, child] of (value as unknown[]).entries()) {
      const found = walk(schema.items as JsonObject, child, `${path}[${index}]`); if (found) return found;
    }
    return undefined;
  };
  const shape = walk(tool.inputSchema as JsonObject, args, '');
  if (shape) return shape;
  const input = args as JsonObject;
  if (name === 'read_document') {
    if (input.mode === 'sections') for (const key of ['target', 'runOffset', 'placeholders']) if (input[key] !== undefined)
      return issue(key, 'not allowed for mode=sections', ['path', 'mode', 'limit', 'cursor']);
    if (input.mode === 'styles') for (const key of ['target', 'runOffset', 'placeholders']) if (input[key] !== undefined)
      return issue(key, 'not allowed for mode=styles', ['path', 'mode', 'limit', 'cursor']);
    if (input.mode === 'notes') for (const key of ['target', 'runOffset', 'placeholders']) if (input[key] !== undefined)
      return issue(key, 'not allowed for mode=notes', ['path', 'mode', 'limit', 'cursor']);
    if (input.placeholders !== undefined && input.mode !== 'quality') return issue('placeholders', 'requires mode=quality', 'quality');
    if (input.mode === 'quality') {
      for (const key of ['target', 'runOffset', 'cursor']) if (input[key] !== undefined) return issue(key, 'not allowed for mode=quality', ['path', 'mode', 'limit', 'placeholders']);
      const blank = (input.placeholders as string[] | undefined)?.findIndex(value => !value.trim());
      if (blank !== undefined && blank >= 0) return issue(`placeholders[${blank}]`, 'nonblank string', { minLength: 1 });
    }
  }
  if (name === 'update_section') {
    const modes = ['page', 'definition', 'header'].filter(key => input[key] !== undefined);
    if (modes.length !== 1) return issue('$', 'exactly one section operation', ['page', 'definition', 'header']);
    if (!Object.keys(input[modes[0]] as JsonObject).length) return issue(modes[0], 'nonempty patch', true);
  }
  if (name === 'edit_styles') {
    const required = input.action === 'create' ? 'name' : 'target';
    if (input[required] === undefined) return issue(required, 'required for action', input.action);
    if (input.action === 'create' && input.target !== undefined) return issue('target', 'not allowed for action', 'create');
    for (const key of ['character', 'paragraph']) if (input[key] !== undefined && !Object.keys(input[key] as JsonObject).length) return issue(key, 'nonempty patch', true);
    if (input.action === 'patch' && input.name === undefined && input.character === undefined && input.paragraph === undefined) return issue('$', 'nonempty patch', ['name', 'character', 'paragraph']);
    // eslint-disable-next-line no-control-regex -- Style names must exclude HWP control characters.
    if (input.name !== undefined && (!(input.name as string).trim() || /[\u0000-\u001f\u007f]/.test(input.name as string))) return issue('name', 'style name', L({ ko: '공백만/제어문자 제외', en: "Exclude whitespace-only values and control characters" }));
    const character = input.character as JsonObject | undefined;
    if (character?.fontLanguage !== undefined && character.fontFamily === undefined) return issue('character.fontLanguage', 'requires fontFamily', 'fontFamily');
    if (character?.textColor !== undefined && !/^#[0-9a-f]{6}$/i.test(character.textColor as string)) return issue('character.textColor', 'color', '#RRGGBB');
  }
  if (name === 'apply_draft') {
    const paragraphs = input.paragraphs as string[], accept = input.accept as number[];
    const seen = new Set<number>();
    for (const [index, number] of accept.entries()) {
      if (number > paragraphs.length) return issue(`accept[${index}]`, 'draft paragraph range', { minimum: 1, maximum: paragraphs.length });
      if (seen.has(number)) return issue(`accept[${index}]`, 'unique draft paragraph', true);
      seen.add(number);
    }
    // eslint-disable-next-line no-control-regex -- Paragraphs must exclude HWP control characters.
    for (const [index, text] of paragraphs.entries()) if (/[\u0000-\u001f\u007f]/.test(text))
      return issue(`paragraphs[${index}]`, 'single paragraph text', L({ ko: '제어문자/줄바꿈 제외', en: "Exclude control characters and line breaks" }));
  }
  if (name === 'edit_notes') {
    const required = input.action === 'insert' ? ['kind', 'offset'] : ['text'];
    for (const key of required) if (input[key] === undefined) return issue(key, 'required for action', input.action);
    for (const key of ['kind', 'offset', 'text']) if (input[key] !== undefined && !required.includes(key))
      return issue(key, 'not allowed for action', input.action);
    // eslint-disable-next-line no-control-regex -- Paragraph text permits tabs but excludes other controls.
    if (typeof input.text === 'string' && /[\u0000-\u0008\u000a-\u001f\u007f]/.test(input.text)) return issue('text', 'single paragraph text', L({ ko: '문자열과 탭만 허용', en: "Only text and tabs allowed" }));
  }
  if (name === 'replace_text' && ((input.occurrence === 'nth') !== (input.occurrenceIndex !== undefined)))
    return issue('occurrenceIndex', 'requires occurrence=nth', { occurrence: 'nth', occurrenceIndex: { minimum: 1 } });
  if (name === 'update_table') {
    const modes = ['cells', 'checkBoxes', 'insertRowAfter', 'deleteRow', 'backgrounds', 'insertColumnAfter', 'deleteColumn', 'merge', 'split', 'deleteTable'].filter(key => input[key] !== undefined);
    if (input.match !== undefined || input.set !== undefined) modes.push('match+set');
    if (modes.length !== 1) return issue('$', 'exactly one table operation', ['cells', 'checkBoxes', 'match+set', 'insertRowAfter', 'deleteRow', 'backgrounds', 'insertColumnAfter', 'deleteColumn', 'merge', 'split', 'deleteTable']);
    if ((input.match === undefined) !== (input.set === undefined)) return issue(input.match === undefined ? 'match' : 'set', 'required together', ['match', 'set']);
    if (input.count !== undefined && input.insertRowAfter === undefined) return issue('count', 'requires insertRowAfter', 'insertRowAfter');
    if (input.overwrite !== undefined && input.cells === undefined && input.set === undefined) return issue('overwrite', 'requires cells or set', ['cells', 'set']);
    for (const [index, item] of ((input.backgrounds ?? []) as JsonObject[]).entries()) {
      if (item.color !== 'none' && !/^#[0-9a-f]{6}$/i.test(item.color as string)) return issue(`backgrounds[${index}].color`, 'color', ['#RRGGBB', 'none']);
    }
  }
  if (name === 'format_text' && input.match !== undefined) {
    const match = input.match as JsonObject;
    if (!Object.keys(match).length) return issue('match', 'nonempty conditions', ['color', 'fontSizePt']);
    if (match.color !== undefined && !/^#[0-9a-f]{6}$/i.test(match.color as string)) return issue('match.color', 'color', '#RRGGBB');
    for (const key of ['find', 'style', 'align', 'indentMm', 'lineSpacingPercent', 'spaceBeforePt', 'spaceAfterPt']) if (input[key] !== undefined)
      return issue(key, 'not allowed with match', L({ ko: '글자 서식만 허용', en: "Only character formatting allowed" }));
  }
  if (name === 'format_text') for (const key of ['color', 'highlight']) {
    if (input[key] !== undefined && !/^#[0-9a-f]{6}$/i.test(input[key] as string)) return issue(key, 'color', '#RRGGBB');
  }
  if (name === 'edit_paragraphs') for (const [index, raw] of (input.operations as JsonObject[]).entries()) {
    const at = `operations[${index}]`;
    const required = raw.action === 'set' ? 'text' : raw.action === 'delete' ? undefined : 'paragraphs';
    if (required && raw[required] === undefined) return issue(`${at}.${required}`, 'required for action', raw.action);
    if (raw.expectedText !== undefined && raw.action !== 'set') return issue(`${at}.expectedText`, 'allowed only for set', 'set');
    for (const key of ['text', 'paragraphs', 'style']) {
      if (raw[key] !== undefined && (raw.action === 'delete' || (key !== 'style' && key !== required)))
        return issue(`${at}.${key}`, 'not allowed for action', raw.action);
    }
  }
  return undefined;
}

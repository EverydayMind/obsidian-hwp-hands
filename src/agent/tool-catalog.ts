import type { Json } from '../api';
type JsonObject = { [key: string]: Json };
const MAX_BLOCKS = 80, MAX_MATCHES = 20;
const RESOURCE_TYPES = ['.hwp', '.hwpx'];
const meta = (extra: JsonObject = {}): JsonObject => ({ 'dev.agentinterop/effect': 'read', 'dev.agentinterop/group': 'core', 'dev.agentinterop/resourceTypes': RESOURCE_TYPES, 'dev.agentinterop/maxResultChars': 12000, ...extra });
const PATH = { type: 'string', minLength: 1, maxLength: 4096, description: 'Vault 안의 .hwp 또는 .hwpx 경로.' };

export const DESCRIPTOR_TOOLS: JsonObject[] = [
  {
    name: 'get_editor_context', title: '열린 한글 문서',
    description: 'HWP Hands에 열려 있는 한글 문서 목록과 상태(쪽 수, 저장 안 한 변경, 화면에 보이는지)를 돌려준다. 어떤 문서를 읽을지 모를 때 먼저 부른다.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true }, _meta: meta(),
  },
  {
    name: 'read_document', title: '한글 문서 읽기',
    description: '한글 문서의 본문을 블록 단위로 읽는다. 각 줄은 [문단 핸들] 텍스트다. 표는 행별로 칸 번호를 붙이며 빈 칸은 (빈 칸), 병합 칸은 범위를 적는다. "계속: cursor=..."가 나오면 그 cursor로 이어 읽는다. 서식 확인은 별도 format_text가 아닌 이 도구에 mode="formatting"과 현재 문단 target을 주고 nextRunOffset으로 이어 읽는다. mode="layout"에 target을 주면 문단 줄 수를 추정한다.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: PATH,
        mode: { type: 'string', enum: ['blocks', 'outline', 'formatting', 'quality', 'notes', 'styles', 'sections', 'layout', 'table'], description: '기본값 blocks. notes는 각주·미주, styles는 스타일, sections는 구역·쪽 설정과 머리말/꼬리말의 논리 텍스트·동적 필드를 읽는다. quality는 작성 점검, layout은 쪽 수·마지막 쪽 사용률이다. table은 target 표의 셀 텍스트를 cursor로 나누어 읽는다.' },
        placeholders: { type: 'array', minItems: 1, maxItems: 20, description: 'quality에서만. 남았는지 찾을 정확한 문자열(예: {{성명}}). 공백만 있는 문자열은 제외한다. 제목·일반 빈 문단은 결함으로 추정하지 않는다.', items: { type: 'string', minLength: 1, maxLength: 200 } },
        target: { type: 'string', minLength: 1, maxLength: 128, description: 'formatting 또는 layout의 문단·셀 문단 핸들, table의 표 읽기용 핸들. layout은 해당 문단의 추정 줄 수를 반환한다.' },
        layoutSummary: { type: 'boolean', description: 'layout 문단별 추정. target 불가, limit 최대 20, cursor로 이어 읽음.' },
        runOffset: { type: 'integer', minimum: 0, description: 'formatting 모드의 서식 구간 시작 번호. nextRunOffset으로 이어 읽는다.' },
        cursor: { type: 'string', minLength: 1, maxLength: 128, description: '앞선 결과가 준 cursor. 처음에는 생략한다.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_BLOCKS, description: '읽을 블록 수. 기본값 40.' },
      },
    },
    annotations: { readOnlyHint: true }, _meta: meta(),
  },
  {
    name: 'find_text', title: '한글 문서에서 찾기',
    description: '한글 문서에서 문구를 그대로(정규식·공백 정규화 없이, 대소문자 구분) 찾는다. 본문과 표 셀을 찾고, 일치한 블록의 핸들과 앞뒤 문맥을 돌려준다. 한 번에 최대 20곳이며 더 있으면 cursor를 준다.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'query'],
      properties: {
        path: PATH,
        query: { type: 'string', minLength: 1, maxLength: 1000, description: '찾을 문구.' },
        includeStories: { type: 'boolean', description: 'true면 머리말·꼬리말·각주·미주·글상자도 찾는다.' },
        cursor: { type: 'string', minLength: 1, maxLength: 128, description: '앞선 결과가 준 cursor.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_MATCHES, description: '돌려줄 일치 수. 기본값 20.' },
      },
    },
    annotations: { readOnlyHint: true }, _meta: meta(),
  },
];
const sessionMeta = (group = 'text', keywords = ['문구', '문단', '고쳐', '바꾸', '수정', '추가', '삽입', '삭제', '지워', '되돌', 'replace', 'paragraph']): JsonObject => ({ ...meta(), 'dev.agentinterop/effect': 'session', 'dev.agentinterop/group': group, 'dev.agentinterop/keywords': keywords });
export const EDIT_TOOLS: JsonObject[] = [
  {
    name: 'apply_draft', title: '한글 문서 초안 채택',
    description: 'host가 완성한 문단 초안에서 accept에 지정한 문단만 관측한 본문 target 앞이나 뒤에 넣는다. paragraphs는 초안 순서이며 accept는 1부터 센 문단 번호다. 지정 순서와 관계없이 초안 순서를 보존한다. preview:true로 실제 엔진에서 미리 볼 수 있다. 한 호출은 전부 적용되거나 복원되는 한 undo 단계이며 스트림을 작업본에 누적하지 않는다. 결과는 채택/남은 문단 번호와 revision, saved:false를 구분한다. 미채택 초안은 host가 보관한다. 취소는 host AbortSignal을 따르며 적용 후 취소는 undo_last_edit를 사용한다. 새 문서는 create_document로 만든 뒤 읽어 target을 얻는다. 반복 호출은 중복 삽입할 수 있으므로 성공 뒤 다시 읽고 남은 문단만 요청한다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'target', 'position', 'paragraphs', 'accept'], properties: {
      path: PATH, target: { type: 'string', minLength: 1, maxLength: 128 },
      position: { type: 'string', enum: ['before', 'after'] },
      paragraphs: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 20000 }, description: '초안 문단. 줄바꿈 없이 문단마다 항목 하나. 빈 문단 허용.' },
      accept: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'integer', minimum: 1, maximum: 50 }, description: '채택할 문단 번호. 중복 불가. 생략한 문단은 적용하지 않는다.' },
    } }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('draft', ['초안', '채택', 'draft']),
  },
  {
    name: 'update_section', title: '한글 문서 구역·쪽 설정',
    description: '현재 구역 핸들 target 하나의 쪽 설정(page), 구역 정의(definition), 새 머리말/꼬리말(header) 중 하나만 변경한다. 파일에 저장하지 않는다. sections로 설정과 기존 동적 필드를, blocks로 해당 구역의 본문·표 전체를 먼저 읽어야 한다. 선택 턴은 그 구역의 본문 문단 전체가 선택되어야 한다. page의 모든 길이는 mm이며 HWP 단위로 변환한다. 생략한 설정과 다른 구역은 보존한다. header는 없는 적용 쪽 종류에만 템플릿을 새로 만든다. 기존 story 덮어쓰기·삭제·내부 텍스트 편집은 미지원이다. 성공 뒤 핸들을 다시 읽는다.',
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
        pageNum: { type: 'integer', minimum: 0, maximum: 65535 }, pageNumType: { type: 'integer', minimum: 0, maximum: 2, description: '0 이어서, 1 홀수, 2 짝수' },
        hideHeader: { type: 'boolean' }, hideFooter: { type: 'boolean' }, hideMasterPage: { type: 'boolean' },
        hideBorder: { type: 'boolean' }, hideFill: { type: 'boolean' }, hideEmptyLine: { type: 'boolean' },
      } },
      header: { type: 'object', additionalProperties: false, required: ['kind', 'applyTo', 'templateId'], properties: {
        kind: { type: 'string', enum: ['header', 'footer'] }, applyTo: { type: 'string', enum: ['both', 'even', 'odd'] },
        templateId: { type: 'integer', minimum: 0, maximum: 10, description: '0 빈 영역, 1/2/3 쪽번호 왼쪽/가운데/오른쪽, 4 쪽번호·파일명, 5 파일명·쪽번호, 6~10은 1~5의 굵게·밑줄 변형.' },
      } },
    } }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('section', ['구역', '쪽 설정', '머리말', '꼬리말', '용지', 'section', 'page setup']),
  },
  {
    name: 'edit_styles', title: '한글 문서 스타일 정의',
    description: '문단 스타일을 새로 정의(create)하거나 관측한 정의만 패치(patch)한다. 파일에 저장하지 않는다. 적용은 format_text의 style로 한다. patch의 target은 read_document(mode=styles)가 준 핸들이다. 생략한 속성은 유지하고 fontLanguage로 한 언어 글꼴만 바꿀 수 있다. 같은 이름은 임의 선택하지 않는다. 정의는 문서 전체에 영향을 주므로 선택 턴에서는 거절한다. patch는 영향받는 모든 본문·표 문단을 먼저 전체 조회해야 한다. story·중첩 컨테이너의 스타일 사용 여부가 불명확하면 거절한다. 문자 스타일 정의/적용은 미지원이다.',
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
    _meta: sessionMeta('style', ['문단 스타일', '스타일 정의', '스타일을 정의', '새 스타일', '스타일 만들', '스타일을 만들', '스타일 추가', '스타일을 추가', '스타일 수정', '스타일을 수정', '스타일 편집', '스타일을 편집', 'paragraph style', 'style definition']),
  },
  {
    name: 'edit_notes', title: '한글 문서 각주·미주 편집',
    description: '작업본에 빈 각주·미주를 넣거나 기존 각주·미주 문단 끝에 글을 추가한다. 파일에는 저장하지 않는다. insert는 전체를 읽은 본문 문단 target과 Unicode code point offset, kind가 필요하다. 삽입 뒤 notes를 다시 읽고 append로 내용을 채운다. append는 read_document(mode=notes)가 준 문단 핸들 target과 text를 받으며 그 각주 전체를 먼저 읽어야 한다. 기존 번호·구분자·본문은 다시 쓰지 않는다. 문자 서식은 조회/엄격 보존 미지원이며 추가 글은 native 삽입 서식을 따른다. 선택 턴에서는 본문 앵커 문단 전체가 선택되어야 한다. 중첩 앵커·기존 텍스트 치환·각주 삭제는 미지원이다. 성공 뒤 핸들은 만료되므로 다시 읽는다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'action', 'target'], properties: {
      path: PATH, action: { type: 'string', enum: ['insert', 'append'] },
      target: { type: 'string', minLength: 1, maxLength: 128, description: 'insert: 본문 문단 핸들. append: notes가 준 각주·미주 문단 핸들.' },
      kind: { type: 'string', enum: ['footnote', 'endnote'] },
      offset: { type: 'integer', minimum: 0, description: 'insert에서만. 본문 문단 안 Unicode code point 위치.' },
      text: { type: 'string', minLength: 1, maxLength: 2000, description: 'append에서만. 줄바꿈 없음. 탭은 유지한다.' },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('note', ['각주', '미주', 'footnote', 'endnote']),
  },
  {
    name: 'replace_text', title: '한글 문서 문구 바꾸기',
    description: '한글 문서의 작업본에서 문구를 바꾼다. 파일에는 저장하지 않는다. 본문과 표 셀의 한 문단 안에서 find와 정확히 같은 문구(대소문자·공백 구분)를 replace로 바꾼다. 기본은 일치가 정확히 한 곳일 때만 바꾼다. 여러 곳이면 바꾸지 않고 후보를 돌려주니 within(핸들)이나 occurrence로 좁힌다. 바꾸기 전에 find_text나 read_document로 그 부분을 확인해야 한다. 누름틀·표·그림 같은 개체가 있는 문단은 바꾸지 않는다.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'find', 'replace'],
      properties: {
        path: PATH,
        find: { type: 'string', minLength: 1, maxLength: 1000, description: '바꿀 문구. 한 문단 안에 있어야 한다.' },
        replace: { type: 'string', maxLength: 2000, description: '새 문구. 줄바꿈은 넣을 수 없다. 빈 문자열이면 지운다.' },
        within: { type: 'string', minLength: 1, maxLength: 128, description: '찾을 범위를 좁히는 핸들(문단 d…:p3, 표 d…:t1, 셀 d…:t1:r2c1).' },
        occurrence: { type: 'string', enum: ['only', 'all', 'nth'], description: '기본값 only(정확히 한 곳). all은 모두, nth는 occurrenceIndex번째.' },
        occurrenceIndex: { type: 'integer', minimum: 1, maximum: 100000, description: 'occurrence가 nth일 때만 준다. 1부터 센다.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta(),
  },
  {
    name: 'edit_paragraphs', title: '한글 문서 문단 편집',
    description: '한글 문서 작업본의 본문이나 직접 표 셀 문단을 고치고, 넣고, 지운다. 파일에는 저장하지 않는다. operations는 action과 읽은 문단 target을 가진다. set은 전체 text를 바꾸므로 대상 원문을 expectedText에 그대로 넣고 변경안과 대조한다. 문단 핸들은 페이지 번호가 아니다. 부분 수정은 replace_text를 쓴다. insert_after·insert_before는 paragraphs를 문단 하나씩 넣는다. 새 문단은 target의 서식을 받는다. delete는 target을 지운다. 셀 마지막 문단은 지울 수 없다. set과 삽입에는 style을 줄 수 있다. 고치거나 지울 문단은 먼저 전체를 읽는다. 모든 작업은 한 번에 적용되거나 복원된다. 구조가 바뀌면 다시 읽는다. 누름틀·표·그림이 있는 문단은 고치거나 지우지 않는다.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'operations'],
      properties: {
        path: PATH,
        operations: {
          type: 'array', minItems: 1, maxItems: 20, description: '한 번에 적용할 작업들.',
          items: {
            type: 'object', additionalProperties: false, required: ['action', 'target'],
            properties: {
              action: { type: 'string', enum: ['set', 'insert_after', 'insert_before', 'delete'] },
              target: { type: 'string', minLength: 1, maxLength: 128, description: '본문(d…:p3) 또는 직접 표 셀 문단 핸들(d…:t1:r2c1.p1).' },
              text: { type: 'string', maxLength: 20000, description: 'set일 때만. 문단의 새 전체 내용. 줄바꿈 없음.' },
              expectedText: { type: 'string', maxLength: 20000, description: 'set일 때 선택. 읽은 대상 문단의 현재 전체 원문을 공백과 문단 안 줄바꿈(\\n)까지 그대로 넣는다. 빈 문단은 빈 문자열. 선행 ASCII 공백만 다르고 text에도 같은 개수의 선행 공백이 있으면 원문 들여쓰기로 보정한다. 그 밖의 불일치는 거절하고 currentText를 돌려준다.' },
              paragraphs: { type: 'array', minItems: 1, maxItems: 50, description: 'insert_after·insert_before일 때만. 넣을 문단들.', items: { type: 'string', maxLength: 20000 } },
              style: { type: 'string', minLength: 1, maxLength: 200, description: 'set·삽입일 때만. 그 문단에 줄 문단 스타일 이름(예: 본문, 개요 1).' },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta(),
  },
  {
    name: 'rewrite_paragraphs', title: '한글 문서 연속 문단 윤문',
    description: '같은 구역의 연속 본문 범위를 읽은 뒤 문단 배열로 윤문한다. 빈 간격 문단은 유지하고 문단 삭제는 거절한다. 표·누름틀·개체·강제 줄바꿈 문단은 범위에서 제외하고 나누어 호출한다. 변경 전후와 서식 출처를 확인하고 필요하면 preview를 쓴다. 적용은 작업본에 한 번의 undo로 남으며 파일 저장은 별도다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'from', 'to', 'paragraphs'], properties: {
      path: PATH,
      from: { type: 'string', minLength: 1, maxLength: 128, description: '현재 읽기에서 얻은 첫 본문 문단 핸들.' },
      to: { type: 'string', minLength: 1, maxLength: 128, description: '현재 읽기에서 얻은 마지막 본문 문단 핸들.' },
      paragraphs: { type: 'array', minItems: 1, maxItems: 50, description: '빈 간격을 제외한 변경 후 논리 문단 배열. 항목에 줄바꿈을 넣지 않는다.', items: { type: 'string', minLength: 1, maxLength: 4000 } },
      splitHints: { type: 'array', maxItems: 40, description: '분할 출처가 모호할 때 원문 핸들과 출력의 0부터인 반열린 인덱스 범위를 원문 순서로 지정한다.', items: { type: 'object', additionalProperties: false, required: ['source', 'outputStart', 'outputEnd'], properties: {
        source: { type: 'string', minLength: 1, maxLength: 128 }, outputStart: { type: 'integer', minimum: 0, maximum: 49 }, outputEnd: { type: 'integer', minimum: 2, maximum: 50 },
      } } },
    } }, annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('rewrite', ['윤문', '문장', '다듬', 'rewrite', 'polish']),
  },
  {
    name: 'update_table', title: '한글 문서 표 고치기',
    description: '본문 표를 편집한다. cells, match+set, checkBoxes, backgrounds, insertRowAfter, deleteRow, insertColumnAfter, deleteColumn, merge, split, deleteTable 중 하나만 지정한다. 행·열은 1부터, 병합 칸은 첫 칸이다. cells는 칸 내용을 바꾸며 기존 글이 있으면 overwrite:true가 필요하다. match+set은 머리글과 값으로 유일한 행을 고른다. checkBoxes는 글자나 글머리표의 □를 ☑로 바꾼다. 겹친 개체가 있는 칸은 채우거나 체크하지 않는다. backgrounds는 #RRGGBB 또는 none이다. 행·열 삽입과 삭제, 직사각형 병합과 원래 격자 분할, 표 삭제를 지원한다. 삭제할 내용·병합 대상과 선택 범위를 보호하며 구조 변경 뒤 핸들은 만료된다. 대상 칸을 먼저 read_document로 확인하라.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'table'],
      properties: {
        path: PATH,
        table: { type: 'string', minLength: 1, maxLength: 128, description: '표 핸들(d…:t1).' },
        checkBoxes: { type: 'array', minItems: 1, maxItems: 100, description: '체크할 칸. 상자가 여러 개면 choice에 옆의 문구를 쓴다.', items: {
          type: 'object', additionalProperties: false, required: ['row', 'col'], properties: {
            row: { type: 'integer', minimum: 1, maximum: 10000 }, col: { type: 'integer', minimum: 1, maximum: 1000 }, choice: { type: 'string', minLength: 1, maxLength: 200 },
          },
        } },
        backgrounds: {
          type: 'array', minItems: 1, maxItems: 100, description: '칸별 배경색만 바꾼다. 다른 작업 방식과 함께 쓰지 않는다. 행·열은 1부터, 병합 칸은 첫 행·열이다. 칸 전체를 먼저 읽고 선택 범위에 포함해야 한다. 텍스트·테두리는 유지한다.',
          items: { type: 'object', additionalProperties: false, required: ['row', 'col', 'color'], properties: {
            row: { type: 'integer', minimum: 1, maximum: 10000 }, col: { type: 'integer', minimum: 1, maximum: 1000 },
            color: { type: 'string', minLength: 4, maxLength: 7, description: '#RRGGBB. none은 배경 지우기.' },
          } },
        },
        cells: {
          type: 'array', minItems: 1, maxItems: 100, description: '칸별로 바꿀 내용.',
          items: { type: 'object', additionalProperties: false, required: ['row', 'col', 'text'], properties: {
            row: { type: 'integer', minimum: 1, maximum: 10000 }, col: { type: 'integer', minimum: 1, maximum: 1000 },
            text: { type: 'string', maxLength: 20000, description: '칸의 새 전체 내용. 줄바꿈 없음.' } } },
        },
        match: { type: 'object', additionalProperties: false, required: ['column', 'equals'], description: 'set과 함께 준다. 바꿀 행을 고른다.', properties: {
          column: { type: 'string', minLength: 1, maxLength: 1000, description: '첫 행의 머리글.' }, equals: { type: 'string', maxLength: 1000, description: '그 열에서 이 내용과 같은 행.' } } },
        set: {
          type: 'array', minItems: 1, maxItems: 100, description: 'match와 함께 준다. 고른 행에서 바꿀 칸들.',
          items: { type: 'object', additionalProperties: false, required: ['column', 'text'], properties: {
            column: { type: 'string', minLength: 1, maxLength: 1000, description: '첫 행의 머리글.' }, text: { type: 'string', maxLength: 20000, description: '칸의 새 전체 내용. 줄바꿈 없음.' } } },
        },
        overwrite: { type: 'boolean', description: 'cells·set과 함께. true면 이미 글이 있는 칸도 바꾼다. 사용자가 그 내용을 바꾸라고 했을 때만 준다.' },
        insertRowAfter: { type: 'integer', minimum: 1, maximum: 10000, description: '이 행(1부터) 아래에 빈 행을 넣는다.' },
        count: { type: 'integer', minimum: 1, maximum: 20, description: 'insertRowAfter와 함께. 넣을 행 수. 기본값 1.' },
        deleteRow: { type: 'integer', minimum: 1, maximum: 10000, description: '이 행(1부터)을 지운다.' },
        insertColumnAfter: { type: 'integer', minimum: 1, maximum: 1000, description: '열 오른쪽에 빈 열 하나를 넣는다. 1부터.' },
        deleteColumn: { type: 'integer', minimum: 1, maximum: 1000, description: '열 하나를 지운다. 1부터.' },
        merge: { type: 'object', additionalProperties: false, required: ['startRow', 'startCol', 'endRow', 'endCol'], description: '직사각형 병합. 왼쪽 위 외의 칸은 비어 있어야 한다. 기존 병합 칸을 자르지 않는다.', properties: {
          startRow: { type: 'integer', minimum: 1, maximum: 10000 }, startCol: { type: 'integer', minimum: 1, maximum: 1000 },
          endRow: { type: 'integer', minimum: 1, maximum: 10000 }, endCol: { type: 'integer', minimum: 1, maximum: 1000 },
        } },
        split: { type: 'object', additionalProperties: false, required: ['row', 'col'], description: '병합 칸을 원래 격자로 나눈다. 왼쪽 위 주소만 받는다.', properties: {
          row: { type: 'integer', minimum: 1, maximum: 10000 }, col: { type: 'integer', minimum: 1, maximum: 1000 },
        } },
        deleteTable: { type: 'boolean', enum: [true], description: '표 전체를 지운다. 전체 칸 관측과 표 문단 전체 선택이 필요하다. 개체가 있으면 거절한다.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...sessionMeta(), 'dev.agentinterop/group': 'table', 'dev.agentinterop/keywords': ["표 2", "표에서", "표를", "표의", "표에", "표 수정", "표 삽입", "새 표", "표 추가", "표 하나", "표 만들", "표 넣", "표의 문장", "표의 문단", "셀", "table"] },
  },
  {
    name: 'insert_table', title: '한글 문서에 표 넣기',
    description: '한글 문서 작업본의 본문 문단 뒤에 새 표를 넣고 칸을 채운다. 파일에는 저장하지 않는다. after는 그 뒤에 표를 넣을 본문 문단 핸들이다. rows는 행의 배열이고 각 행은 칸 내용의 배열이다. 모든 행의 칸 수가 같아야 한다. headerRow가 true면 첫 행을 굵게 가운데 정렬한다. caption을 주면 표 바로 다음 문단에 그 글을 넣는다. after 문단을 먼저 read_document나 find_text로 확인해야 한다. 넣으면 핸들이 바뀌므로 다시 읽는다.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'after', 'rows'],
      properties: {
        path: PATH,
        after: { type: 'string', minLength: 1, maxLength: 128, description: '이 본문 문단(d…:p3) 뒤에 표를 넣는다.' },
        rows: { type: 'array', minItems: 1, maxItems: 50, description: '표의 행들. 첫 행부터.',
          items: { type: 'array', minItems: 1, maxItems: 20, description: '한 행의 칸 내용들. 왼쪽부터.', items: { type: 'string', maxLength: 2000, description: '칸 내용. 줄바꿈 없음. 빈 문자열이면 빈 칸.' } } },
        headerRow: { type: 'boolean', description: 'true면 첫 행을 머리글로 꾸민다.' },
        caption: { type: 'string', minLength: 1, maxLength: 1000, description: '표 다음 문단에 넣을 설명. 줄바꿈 없음.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...sessionMeta(), 'dev.agentinterop/group': 'table', 'dev.agentinterop/keywords': ["표 2", "표에서", "표를", "표의", "표에", "표 수정", "표 삽입", "새 표", "표 추가", "표 하나", "표 만들", "표 넣", "표의 문장", "표의 문단", "셀", "table"] },
  },
  {
    name: 'fill_fields', title: '한글 문서 누름틀 채우기',
    description: '한글 문서 작업본의 누름틀(입력란)을 채운다. 파일에는 저장하지 않는다. 먼저 read_document로 현재 누름틀 이름과 값을 읽은 뒤 호출한다. values의 각 항목은 누름틀 이름 field와 넣을 값 value다. 모두 한 번에 적용되거나 전혀 적용되지 않는다. 같은 이름의 누름틀이 여러 개면 채우지 않고 후보의 핸들(d…:f3)을 돌려주니, 채울 것의 핸들을 field에 준다. 지금 값을 확인하지 않았으면 거절하면서 지금 값을 알려 주니 같은 요청을 다시 보낸다.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'values'],
      properties: {
        path: PATH,
        values: {
          type: 'array', minItems: 1, maxItems: 100, description: '채울 누름틀들.',
          items: { type: 'object', additionalProperties: false, required: ['field', 'value'], properties: {
            field: { type: 'string', minLength: 1, maxLength: 1000, description: '누름틀 이름, 또는 이름이 겹칠 때 받은 누름틀 핸들(d…:f3).' }, value: { type: 'string', maxLength: 20000, description: '넣을 값. 줄바꿈 없음. 빈 문자열이면 비운다.' } } },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...sessionMeta(), 'dev.agentinterop/group': 'field', 'dev.agentinterop/keywords': ["누름틀", "필드", "수신", "제목", "field"] },
  },
  {
    name: 'format_text', title: '한글 문서 서식 바꾸기',
    description: '한글 문서 작업본에서 문단 하나의 서식을 바꾼다. 파일에는 저장하지 않는다. target은 문단 핸들이다. find를 주면 그 문단 안의 그 문구(정확히 한 곳)에만 글자 서식을 준다. 문구만 서식을 바꿀 때는 요청한 문구를 find에 정확히 지정한다. find가 없으면 문단 전체에 글자 서식, 문단 서식, style(문단 스타일 이름)을 준다. 서식 인자를 하나 이상 준다. 글자는 바뀌지 않는다. 먼저 read_document나 find_text로 그 문단을 확인해야 한다.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'target'],
      properties: {
        path: PATH,
        target: { type: 'string', minLength: 1, maxLength: 128, description: '문단 핸들(d…:p3) 또는 칸 문단 핸들(d…:t1:r2c1.p1).' },
        find: { type: 'string', minLength: 1, maxLength: 1000, description: '이 문구에만 글자 서식을 준다. 생략하면 문단 전체.' },
        match: { type: 'object', additionalProperties: false, description: '관측한 글자 서식 구간의 조건. 지정한 조건을 모두 만족하는 구간만 변경한다. formatting으로 모든 후보 구간을 먼저 읽고 본문도 전체 조회해야 한다. find·문단 서식·style과 함께 쓰지 않는다.', properties: {
          color: { type: 'string', minLength: 7, maxLength: 7 }, fontSizePt: { type: 'number', minimum: 1, maximum: 400 },
        } },
        style: { type: 'string', minLength: 1, maxLength: 200, description: '문단 스타일 이름(예: 본문, 개요 1). find와 함께 줄 수 없다.' },
        bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strikethrough: { type: 'boolean', description: '취소선.' },
        fontFamily: { type: 'string', minLength: 1, maxLength: 128, description: '글꼴 이름. fontLanguage 생략 시 모든 언어에 적용.' },
        fontLanguage: { type: 'integer', minimum: 0, maximum: 6, description: 'fontFamily와 함께 사용: 0 한글, 1 영문, 2 한자, 3 일본어, 4 기타, 5 기호, 6 사용자.' },
        fontSizePt: { type: 'number', minimum: 1, maximum: 400, description: '글자 크기(pt).' },
        color: { type: 'string', minLength: 7, maxLength: 7, description: '글자 색 #RRGGBB.' },
        highlight: { type: 'string', minLength: 7, maxLength: 7, description: '형광펜 색 #RRGGBB. #ffffff면 지운다.' },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: '문단 정렬. find와 함께 줄 수 없다.' },
        indentMm: { type: 'number', minimum: -200, maximum: 200, description: '첫 줄 들여쓰기(mm). 음수는 내어쓰기.' },
        lineSpacingPercent: { type: 'number', minimum: 50, maximum: 500, description: '줄 간격(%).' },
        spaceBeforePt: { type: 'number', minimum: 0, maximum: 500, description: '문단 위 간격(pt).' },
        spaceAfterPt: { type: 'number', minimum: 0, maximum: 500, description: '문단 아래 간격(pt).' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...sessionMeta(), 'dev.agentinterop/group': 'format', 'dev.agentinterop/keywords': ["서식", "굵게", "기울임", "정렬", "글자", "pt", "bold", "italic"] },
  },
  {
    name: 'undo_last_edit', title: '마지막 AI 편집 되돌리기',
    description: '이 대화가 이 문서에 한 마지막 AI 편집 하나를 되돌린다. 그 뒤에 사람이나 다른 편집이 있었으면 되돌리지 않는다. 되돌리면 핸들이 모두 바뀌므로 다시 읽어야 한다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: PATH } },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: sessionMeta('history', ['되돌', '취소', 'undo']),
  },
];
/** Read effect, but it reports the AI edit ledger, so it is described only together with the edit tools. */
export const CHECK_TOOL: JsonObject = {
  name: 'check_before_save', title: '저장 전 한글 문서 점검',
  description: '한글 문서 작업본을 지금 저장하면 내용이 보존되는지, 이 문서에서 할 수 없는 편집, 사람의 저장을 기다리는 AI 편집을 알려 준다. 문서를 바꾸지 않는다. 큰 문서에서는 오래 걸릴 수 있으니 편집을 마친 뒤 한 번만 부른다.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: { path: PATH, pages: { type: 'array', minItems: 1, maxItems: 5, description: '화면 모양까지 비교할 쪽 번호(1부터). 생략하면 첫 쪽.', items: { type: 'integer', minimum: 1, maximum: 100000 } } },
  },
  annotations: { readOnlyHint: true }, _meta: meta({ 'dev.agentinterop/group': 'verify', 'dev.agentinterop/keywords': ['점검', '보존 검사', '호환', 'verify'] }),
};
/** Commit effect: the host asks a person about every single save and checkpoints the files before it lets this provider write. */
export const SAVE_TOOL: JsonObject = {
  name: 'save_document', title: '한글 문서 저장',
  description: '한글 문서 작업본을 그 문서의 파일에 저장한다. 사용자가 저장을 요청했을 때만 부른다. 부를 때마다 사람이 저장을 승인해야 하고, 거절하면 저장하지 않는다. 사람이 입력 중이거나 승인하는 동안 문서나 파일이 바뀌면 저장하지 않으니 그때는 다시 요청한다. destination을 주면 같은 형식의 새 경로에 사본을 저장한다. 원본 작업본은 그대로 남고 저장되지 않는다.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: PATH, destination: { ...PATH, description: '다른 이름으로 저장할 새 경로. 생략하면 원본 저장.' } } },
  annotations: { readOnlyHint: false, destructiveHint: true }, _meta: { ...meta(), 'dev.agentinterop/effect': 'commit', 'dev.agentinterop/group': 'save', 'dev.agentinterop/keywords': ['저장', '사본', 'save'] },
};
export const CREATE_TOOL: JsonObject = {
  name: 'create_document', title: '새 한글 문서 만들기',
  description: '새 경로에 빈 한글 문서 또는 template 파일의 사본을 만든다. template은 디스크에 저장된 같은 형식의 HWP/HWPX 경로다. 내용을 채우는 도구가 아니므로 생성 뒤 read_document로 문단을 읽고 편집한다. 사람이 매번 폴더·문서·인덱스 생성을 승인하며 기존 파일을 덮어쓰지 않는다.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: PATH, template: PATH } },
  annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ...meta(), 'dev.agentinterop/effect': 'commit', 'dev.agentinterop/group': 'create', 'dev.agentinterop/keywords': ['새 한글', '새 문서', '만들', '생성', '템플릿', 'create', 'template'] },
};
export const SAVE_INSTRUCTIONS = ' 사용자가 저장을 요청하면 save_document를 부른다. 새 파일은 create_document로 만든 뒤 읽고 편집한다. 그때마다 사람이 승인하며, 요청받지 않은 저장은 하지 않는다.';
export const EDIT_INSTRUCTIONS = '한글(HWP/HWPX) 작업본을 편집한다. 파일 저장은 사람이 한다. 대상 경로를 고정하고 확장자를 임의로 바꾸지 않는다. 전체 요청은 cursor를 따라 끝까지 읽는다. 연속 문단 윤문은 rewrite_paragraphs, 문구는 replace_text, 문단 전체·삽입·삭제는 edit_paragraphs, 표는 update_table 또는 insert_table, 초안은 apply_draft, 누름틀은 fill_fields, 서식은 format_text를 쓴다. 핸들 p12는 페이지가 아니라 문단이며 해당 문서 상태에서만 유효하다. 원문의 사실·시제·불확실성·기호와 주석 참조를 보존하고 내용을 지어내지 않는다. 혼합 서식 오류는 formatting으로 실제 구간을 확인해 작은 범위로 나눈다. 예외 확인창이 열리면 사람의 결정을 기다린다. 승인 후 같은 변경을 재요청하면 해당 편집만 서식 손실이 가능하다. 저수준 삭제·삽입으로 보호를 우회하지 않는다. 사람이 거절하면 강요하지 않는다. 문단별 줄 수는 layout에 target을 주어 추정하고 화면에서 확인한다. 추정이나 미검증을 완료로 보고하지 않는다. 텍스트·서식 동시 요청은 텍스트 수정, 재조회, format_text 순서로 처리한다. Markdown 기호를 임의로 넣지 않는다. 양식은 빈 칸을 채우고 누름틀 안내문은 fill_fields를 쓴다. 확인되지 않은 이름·날짜·금액 등은 지어내지 않는다. 구조가 바뀌거나 사람이 편집하면 다시 읽는다. 바꾸지 못한 곳과 미확인 범위를 알린다. preview는 미리보기이며 작업본 적용이 아니다. 사용자가 적용을 요청했다면 preview 뒤 같은 입력을 preview 없이 다시 호출하고 결과의 적용 여부를 확인한다. 적용이 확인되지 않으면 적용했다고 말하지 않는다.';
export const INSTRUCTIONS = '한글(HWP/HWPX) 문서를 읽는 도구다. 문서 내용에 대해 답하기 전에 read_document나 find_text로 실제 내용을 확인한다. 핸들(d…:p12, d…:t3:r2c1)은 그 결과가 나온 문서 상태에서만 유효하다. 문서가 바뀌면 다시 읽는다. 이 도구들은 문서를 바꾸지 않는다.';


export const EDIT_TOOL_NAMES = EDIT_TOOLS.map(tool => tool.name as string);
// The preview uses the same input and domain validation as the real edit.
for (const tool of EDIT_TOOLS) if (tool.name !== 'undo_last_edit') {
  const schema = tool.inputSchema as JsonObject;
  (schema.properties as JsonObject).preview = { type: 'boolean', description: 'true면 실제 엔진으로 실행한 뒤 복원하고 예상 변경만 보고한다. 파일·작업본·undo·AI 원장을 바꾸지 않는다. 쓰기 승인/관측 토큰이 아니며 실적용은 preview를 빼고 현재 대상·관측·선택을 다시 검증한다. 저장 보존이나 한컴 호환 검증은 아니다.' };
}
export const TOOL_CATALOG = [...DESCRIPTOR_TOOLS, ...EDIT_TOOLS, CHECK_TOOL, SAVE_TOOL, CREATE_TOOL];

/** Examples are kept with the schemas; handles are illustrative and must come from a fresh read. */
export const TOOL_EXAMPLES: Record<string, JsonObject> = {
  edit_notes: { path: 'sample.hwpx', action: 'insert', target: 'd1:p2', kind: 'footnote', offset: 4 },
  edit_styles: { path: 'sample.hwpx', action: 'create', name: '검토 본문', character: { bold: true } },
  update_section: { path: 'sample.hwpx', target: 'd1:section1', page: { marginLeftMm: 25 } },
  read_document: { path: 'sample.hwpx', mode: 'formatting', target: 'd1:p2' },
  replace_text: { path: 'sample.hwpx', find: '초안', replace: '확정', within: 'd1:p2' },
  apply_draft: { path: 'sample.hwpx', target: 'd1:p2', position: 'after', paragraphs: ['첫 문단', '검토 중', '마지막 문단'], accept: [1, 3], preview: true },
  edit_paragraphs: { path: 'sample.hwpx', operations: [{ action: 'set', target: 'd1:p2', expectedText: '원래 문단', text: '새 문단' }] },
  rewrite_paragraphs: { path: 'sample.hwpx', from: 'd1:p2', to: 'd1:p3', paragraphs: ['바꾼 문단', '다음 문단'], preview: true },
  update_table: { path: 'sample.hwpx', table: 'd1:t1', backgrounds: [{ row: 1, col: 1, color: '#FFFFFF' }] },
};
export function contractGuide(tools: JsonObject[]): string {
  return ' 입력 필드: ' + tools.map(tool => {
    const schema = tool.inputSchema as JsonObject;
    return `${typeof tool.name === 'string' ? tool.name : JSON.stringify(tool.name)}(${(schema.required as string[] | undefined ?? []).join(',')})`;
  }).join('; ') + '. 범위·허용값은 각 inputSchema를 따른다. 오류의 path·allowed를 확인해 수정한다.';
}

/** Shape validation uses exactly the schema sent to the host. Domain/observation checks stay in edit.ts. */
export interface InputIssue { message: string; details: JsonObject }
export function validateToolInput(name: string, args: unknown): InputIssue | undefined {
  const tool = TOOL_CATALOG.find(tool => tool.name === name);
  if (!tool) return undefined;
  const issue = (path: string, rule: string, allowed: Json): InputIssue => ({
    message: `${path || '$'}: ${rule}. 허용값을 확인해 입력을 수정하라.`,
    details: { path: path || '$', rule, allowed, suggestion: '같은 요청을 반복하지 말고 해당 항목을 수정하라.',
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
    if (input.name !== undefined && (!(input.name as string).trim() || /[\u0000-\u001f\u007f]/.test(input.name as string))) return issue('name', 'style name', '공백만/제어문자 제외');
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
      return issue(`paragraphs[${index}]`, 'single paragraph text', '제어문자/줄바꿈 제외');
  }
  if (name === 'edit_notes') {
    const required = input.action === 'insert' ? ['kind', 'offset'] : ['text'];
    for (const key of required) if (input[key] === undefined) return issue(key, 'required for action', input.action);
    for (const key of ['kind', 'offset', 'text']) if (input[key] !== undefined && !required.includes(key))
      return issue(key, 'not allowed for action', input.action);
    // eslint-disable-next-line no-control-regex -- Paragraph text permits tabs but excludes other controls.
    if (typeof input.text === 'string' && /[\u0000-\u0008\u000a-\u001f\u007f]/.test(input.text)) return issue('text', 'single paragraph text', '문자열과 탭만 허용');
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
      return issue(key, 'not allowed with match', '글자 서식만 허용');
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

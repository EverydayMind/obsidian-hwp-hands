import { L } from '../i18n/locale';
import type { Json } from '../api';

type Details = { [key: string]: Json };
/** Recovery instructions keyed by codes, never extracted from localized error messages.
 * No paths, document text or engine details are copied into this projection.
 * A specific validator's typed details take precedence over these general instructions.
 */
const recovery = (): Record<string, [rule: string, suggestion: string]> => ({
  AI_PRIVATE: ['ai-privacy', L({ ko: '사람이 HWP Hands의 AI 비공개 설정과 문서 경로를 확인해야 한다.', en: "A person must check the AI privacy settings and document path in HWP Hands." })],
  INVALID_ARGUMENT: ['input', L({ ko: '도구의 inputSchema와 해당 필드 안내를 확인하고 입력을 수정하라.', en: "Check the tool inputSchema and field instructions, then correct the input." })],
  TARGET_REQUIRED: ['pinned-target', L({ ko: 'get_editor_context로 문서를 확인하고 host에서 편집 대상을 확정하라.', en: "Check the document with get_editor_context and resolve the edit target in the host." })],
  TARGET_MISMATCH: ['pinned-target', L({ ko: 'host에서 현재 열린 문서의 대상을 다시 확정하라.', en: "Resolve the currently open document target again in the host." })],
  HANDLE_EXPIRED: ['current-handle', L({ ko: 'read_document의 해당 모드로 다시 읽고 새 핸들을 사용하라.', en: "Read again using the appropriate read_document mode and use fresh handles." })],
  CURSOR_STALE: ['current-cursor', L({ ko: 'cursor를 생략하고 같은 조회를 처음부터 다시 시작하라.', en: "Omit cursor and restart the same read from the beginning." })],
  OBSERVATION_REQUIRED: ['complete-observation', L({ ko: '해당 영역을 끝까지 다시 읽고 host가 전달한 현재 관측 토큰으로 재검증하라.', en: "Read the relevant area through the end again and revalidate with current observation tokens supplied by the host." })],
  SELECTION_STALE: ['current-selection', L({ ko: '사람이 의도한 범위를 다시 선택해 새 턴을 제출해야 한다.', en: "The person must select the intended scope again and submit a new turn." })],
  OUTSIDE_SELECTION: ['selection-boundary', L({ ko: '요청을 제출된 선택 안으로 좁혀라. 선택을 자동 확대하지 마라.', en: "Narrow the request to the submitted selection. Never expand the selection automatically." })],
  PROTECTED_CONTENT: ['anchored-content', L({ ko: '앵커와 개체를 평문으로 재작성하지 말고 사람이 화면에서 확인해야 한다.', en: "A person must inspect anchors and objects onscreen; do not rewrite them as plain text." })],
  FORMAT_PRESERVATION_REQUIRED: ['format-preservation', L({ ko: 'formatting으로 서식 구간을 확인해 한 문단의 작은 범위로 나눈다. 예외 확인창이 열렸다면 사람의 결정을 기다린다.', en: "Inspect formatting runs with formatting and split into small ranges within one paragraph. If an exception dialog is open, wait for the person's decision." })],
  HUMAN_EDITING: ['human-input', L({ ko: '사람의 입력과 조합이 끝난 뒤 현재 revision과 관측을 다시 확인하라.', en: "After human typing and composition end, check the current revision and observations again." })],
  REVISION_CONFLICT: ['current-revision', L({ ko: '문서를 다시 읽고 대상·관측·선택을 현재 revision에서 다시 검증하라.', en: "Reread the document and revalidate target, observations, and selection at the current revision." })],
  UNSUPPORTED_TARGET: ['supported-target', L({ ko: '이 도구의 지원 영역을 확인하고 지원되는 대상으로 요청을 좁혀라.', en: "Check the supported scope of this tool and narrow the request to supported targets." })],
  AMBIGUOUS_MATCH: ['unique-match', L({ ko: '반환된 후보와 현재 내용을 확인한 뒤 핸들이나 조건으로 한 대상을 지정하라.', en: "Inspect returned candidates and current content, then identify one target with a handle or conditions." })],
  TEXT_NOT_FOUND: ['existing-text', L({ ko: '현재 문서를 다시 읽고 정확한 문구와 범위를 확인하라.', en: "Reread the current document and check the exact phrase and scope." })],
  FIELD_NOT_FOUND: ['existing-field', L({ ko: 'read_document로 현재 누름틀 이름과 핸들을 확인하라.', en: "Check current input field names and handles with read_document." })],
  STYLE_NOT_FOUND: ['existing-style', L({ ko: 'read_document(mode=styles)로 현재 스타일 이름과 핸들을 확인하라.', en: "Check current style names and handles with read_document(mode=styles)." })],
  CELL_NOT_EMPTY: ['explicit-overwrite', L({ ko: '기존 내용을 읽고 사용자가 교체를 요청했는지 확인한 경우에만 overwrite를 지정하라.', en: "Specify overwrite only after reading existing content and confirming the user requested replacing it." })],
  LIMIT_EXCEEDED: ['bounded-request', L({ ko: '반환된 한도 안으로 요청을 나누고 매 적용 뒤 현재 상태를 다시 읽어라.', en: "Split the request within the returned limits and reread the current state after each application." })],
  CANCELLED: ['cancellation', L({ ko: '취소된 호출을 자동 재시도하지 말고 새 요청에서 현재 상태를 확인하라.', en: "Do not retry cancelled calls automatically. Check the current state in a new request." })],
  VERIFY_FAILED: ['verification', L({ ko: '현재 작업본과 저장 상태를 확인하라. 검증을 우회하거나 성공으로 간주하지 마라.', en: "Check the current working copy and save state. Do not bypass validation or assume success." })],
});

/** The input field a refusal is about, with `index` for its first array position (operations[2].target → 2). */
export function inputAt(path: string, extra: Details = {}): Details {
  const index = /\[(\d+)\]/.exec(path);
  return { path, ...(index ? { index: Number(index[1]) } : {}), ...extra };
}

export function domainErrorDetails(code: string, specific: Details = {}): Details {
  const entry = recovery()[code];
  return { ...(entry ? { rule: entry[0], suggestion: entry[1] } : {}), ...specific };
}

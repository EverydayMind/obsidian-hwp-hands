import type { Json } from '../api';

type Details = { [key: string]: Json };
/** Recovery instructions keyed by codes, never extracted from localized error messages.
 * No paths, document text or engine details are copied into this projection.
 * A specific validator's typed details take precedence over these general instructions.
 */
const recovery: Record<string, [rule: string, suggestion: string]> = {
  AI_PRIVATE: ['ai-privacy', '사람이 HWP Hands의 AI 비공개 설정과 문서 경로를 확인해야 한다.'],
  INVALID_ARGUMENT: ['input', '도구의 inputSchema와 해당 필드 안내를 확인하고 입력을 수정하라.'],
  TARGET_REQUIRED: ['pinned-target', 'get_editor_context로 문서를 확인하고 host에서 편집 대상을 확정하라.'],
  TARGET_MISMATCH: ['pinned-target', 'host에서 현재 열린 문서의 대상을 다시 확정하라.'],
  HANDLE_EXPIRED: ['current-handle', 'read_document의 해당 모드로 다시 읽고 새 핸들을 사용하라.'],
  CURSOR_STALE: ['current-cursor', 'cursor를 생략하고 같은 조회를 처음부터 다시 시작하라.'],
  OBSERVATION_REQUIRED: ['complete-observation', '해당 영역을 끝까지 다시 읽고 host가 전달한 현재 관측 토큰으로 재검증하라.'],
  SELECTION_STALE: ['current-selection', '사람이 의도한 범위를 다시 선택해 새 턴을 제출해야 한다.'],
  OUTSIDE_SELECTION: ['selection-boundary', '요청을 제출된 선택 안으로 좁혀라. 선택을 자동 확대하지 마라.'],
  PROTECTED_CONTENT: ['anchored-content', '앵커와 개체를 평문으로 재작성하지 말고 사람이 화면에서 확인해야 한다.'],
  FORMAT_PRESERVATION_REQUIRED: ['format-preservation', 'formatting으로 서식 구간을 확인해 한 문단의 작은 범위로 나눈다. 예외 확인창이 열렸다면 사람의 결정을 기다린다.'],
  HUMAN_EDITING: ['human-input', '사람의 입력과 조합이 끝난 뒤 현재 revision과 관측을 다시 확인하라.'],
  REVISION_CONFLICT: ['current-revision', '문서를 다시 읽고 대상·관측·선택을 현재 revision에서 다시 검증하라.'],
  UNSUPPORTED_TARGET: ['supported-target', '이 도구의 지원 영역을 확인하고 지원되는 대상으로 요청을 좁혀라.'],
  AMBIGUOUS_MATCH: ['unique-match', '반환된 후보와 현재 내용을 확인한 뒤 핸들이나 조건으로 한 대상을 지정하라.'],
  TEXT_NOT_FOUND: ['existing-text', '현재 문서를 다시 읽고 정확한 문구와 범위를 확인하라.'],
  FIELD_NOT_FOUND: ['existing-field', 'read_document로 현재 누름틀 이름과 핸들을 확인하라.'],
  STYLE_NOT_FOUND: ['existing-style', 'read_document(mode=styles)로 현재 스타일 이름과 핸들을 확인하라.'],
  CELL_NOT_EMPTY: ['explicit-overwrite', '기존 내용을 읽고 사용자가 교체를 요청했는지 확인한 경우에만 overwrite를 지정하라.'],
  LIMIT_EXCEEDED: ['bounded-request', '반환된 한도 안으로 요청을 나누고 매 적용 뒤 현재 상태를 다시 읽어라.'],
  CANCELLED: ['cancellation', '취소된 호출을 자동 재시도하지 말고 새 요청에서 현재 상태를 확인하라.'],
  VERIFY_FAILED: ['verification', '현재 작업본과 저장 상태를 확인하라. 검증을 우회하거나 성공으로 간주하지 마라.'],
};

/** The input field a refusal is about, with `index` for its first array position (operations[2].target → 2). */
export function inputAt(path: string, extra: Details = {}): Details {
  const index = /\[(\d+)\]/.exec(path);
  return { path, ...(index ? { index: Number(index[1]) } : {}), ...extra };
}

export function domainErrorDetails(code: string, specific: Details = {}): Details {
  const entry = recovery[code];
  return { ...(entry ? { rule: entry[0], suggestion: entry[1] } : {}), ...specific };
}

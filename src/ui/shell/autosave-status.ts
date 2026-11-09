import type { AutosaveStatus } from '../../autosave-scheduler';

export interface AutosavePresentation { text: string; detail: string; severity: 'normal' | 'warning' | 'error' }

/** Converts internal scheduling state to a passive, accessible status label. */
export function autosavePresentation(status: AutosaveStatus | undefined, currentRevision?: number): AutosavePresentation | undefined {
  if (!status || status.phase === 'idle' || status.phase === 'closed') return;
  // A late completion cannot claim that newer input/model changes are saved.
  if (status.phase === 'saved' && status.revision !== currentRevision) return;
  let text: string, detail: string, severity: AutosavePresentation['severity'] = 'normal';
  switch (status.phase) {
    case 'waiting': text = '자동 저장 대기'; detail = '입력이 잠시 멈추면 문서를 검증하고 원본에 저장합니다.'; break;
    case 'validating': text = '자동 저장 검증 중'; detail = '내용 보존을 검증하고 백업과 복구 기록을 준비하고 있습니다.'; break;
    case 'saving': text = '자동 저장 중'; detail = '검증한 내용을 원본에 반영하고 디스크에서 다시 읽어 확인하고 있습니다.'; break;
    case 'saved': text = '자동 저장 완료'; detail = '검증한 내용이 원본에 저장되었습니다.'; break;
    case 'failed':
      severity = 'error';
      text = status.errorCode === 'FILE_CONFLICT' ? '자동 저장 충돌' : '자동 저장 실패';
      detail = `${status.reason ?? '자동 저장을 완료하지 못했습니다.'} 백업과 복구 기록을 확인한 뒤 다시 저장하세요.`;
      break;
    case 'blocked':
      switch (status.reason) {
        case 'file-conflict': text = '자동 저장 충돌'; severity = 'error'; detail = '외부에서 원본 파일이 변경되었습니다. 변경본을 새 파일로 보관하거나 디스크 버전을 다시 불러오세요.'; break;
        case 'composition': text = '자동 저장 보류 · 한글 조합 중'; detail = '모든 화면에서 한글 조합이 끝난 뒤 저장합니다.'; break;
        case 'pending-input': text = '자동 저장 보류 · 입력 반영 대기'; detail = '다른 화면을 포함해 미적용 입력을 먼저 반영합니다.'; break;
        case 'view-busy': text = '자동 저장 보류 · 화면 작업 중'; detail = '진행 중인 화면 작업을 마친 뒤 저장합니다.'; break;
        case 'unsupported-autosave-size': text = '자동 저장 보류 · 지원 범위 초과'; severity = 'warning'; detail = '자동 저장 지원 범위를 초과한 문서입니다. 수동 저장을 사용하세요.'; break;
        case 'unapproved-api': case 'unapproved-api-ledger': case 'unapproved-ai': case 'unknown-actor':
          text = '자동 저장 보류 · 편집 승인 필요'; severity = 'warning'; detail = 'AI 또는 외부 API가 편집한 내용의 원본 저장 승인이 필요합니다.'; break;
        case 'manual-save': case 'save-as': case 'reload': case 'close': case 'path-transition': case 'stale-candidate': case 'session-closed':
          text = '자동 저장 보류'; detail = '문서 저장 또는 전환 작업을 마친 뒤 상태를 다시 확인합니다.'; break;
        default: text = '자동 저장 보류'; severity = 'warning'; detail = '저장 정책에 따라 원본 자동 저장을 보류했습니다.';
      }
      break;
  }
  if (status.warnings?.length) {
    text += ' · 경고';
    detail += ` 원본 저장 후 경고: ${status.warnings.join(' ')}`;
    if (severity === 'normal') severity = 'warning';
  }
  return { text, detail, severity };
}

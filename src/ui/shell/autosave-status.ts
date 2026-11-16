import { LT, L } from '../../i18n/locale';
import type { AutosaveStatus } from '../../autosave-scheduler';

export interface AutosavePresentation { text: string; detail: string; severity: 'normal' | 'warning' | 'error' }

/** Converts internal scheduling state to a passive, accessible status label. */
export function autosavePresentation(status: AutosaveStatus | undefined, currentRevision?: number): AutosavePresentation | undefined {
  if (!status || status.phase === 'idle' || status.phase === 'closed') return;
  // A late completion cannot claim that newer input/model changes are saved.
  if (status.phase === 'saved' && status.revision !== currentRevision) return;
  let text: string, detail: string, severity: AutosavePresentation['severity'] = 'normal';
  switch (status.phase) {
    case 'waiting': text = L({ ko: '자동 저장 대기', en: "Autosave pending" }); detail = L({ ko: '입력이 잠시 멈추면 문서를 검증하고 원본에 저장합니다.', en: "After input pauses, validates the document and saves to the original." }); break;
    case 'validating': text = L({ ko: '자동 저장 검증 중', en: "Validating autosave" }); detail = L({ ko: '내용 보존을 검증하고 백업과 복구 기록을 준비하고 있습니다.', en: "Validating content preservation and preparing backups/recovery records." }); break;
    case 'saving': text = L({ ko: '자동 저장 중', en: "Autosaving" }); detail = L({ ko: '검증한 내용을 원본에 반영하고 디스크에서 다시 읽어 확인하고 있습니다.', en: "Writing validated content to the original and rereading disk to verify it." }); break;
    case 'saved': text = L({ ko: '자동 저장 완료', en: "Autosave complete" }); detail = L({ ko: '검증한 내용이 원본에 저장되었습니다.', en: "Validated content was saved to the original." }); break;
    case 'failed':
      severity = 'error';
      text = status.errorCode === 'FILE_CONFLICT' ? L({ ko: '자동 저장 충돌', en: "Autosave conflict" }) : L({ ko: '자동 저장 실패', en: "Autosave failed" });
      detail = LT({ ko: () => `${status.reason ?? '자동 저장을 완료하지 못했습니다.'} 백업과 복구 기록을 확인한 뒤 다시 저장하세요.`, en: () => `${status.reason ?? 'Could not complete autosave.'} Check backups and recovery records, then save again.` });
      break;
    case 'blocked':
      switch (status.reason) {
        case 'file-conflict': text = L({ ko: '자동 저장 충돌', en: "Autosave conflict" }); severity = 'error'; detail = L({ ko: '외부에서 원본 파일이 변경되었습니다. 변경본을 새 파일로 보관하거나 디스크 버전을 다시 불러오세요.', en: "The original file changed externally. Keep changes in a new file or reload the disk version." }); break;
        case 'composition': text = L({ ko: '자동 저장 보류 · 한글 조합 중', en: "Autosave deferred · Korean IME composition" }); detail = L({ ko: '모든 화면에서 한글 조합이 끝난 뒤 저장합니다.', en: "Saves after Korean IME composition ends in all views." }); break;
        case 'pending-input': text = L({ ko: '자동 저장 보류 · 입력 반영 대기', en: "Autosave deferred · unapplied input" }); detail = L({ ko: '다른 화면을 포함해 미적용 입력을 먼저 반영합니다.', en: "Applies pending input first, including input in other views." }); break;
        case 'view-busy': text = L({ ko: '자동 저장 보류 · 화면 작업 중', en: "Autosave deferred · view operation" }); detail = L({ ko: '진행 중인 화면 작업을 마친 뒤 저장합니다.', en: "Saves after the current view operation finishes." }); break;
        case 'unsupported-autosave-size': text = L({ ko: '자동 저장 보류 · 지원 범위 초과', en: "Autosave deferred · unsupported scope" }); severity = 'warning'; detail = L({ ko: '자동 저장 지원 범위를 초과한 문서입니다. 수동 저장을 사용하세요.', en: "This document exceeds autosave support limits. Save manually." }); break;
        case 'unapproved-api': case 'unapproved-api-ledger': case 'unapproved-ai': case 'unknown-actor':
          text = L({ ko: '자동 저장 보류 · 편집 승인 필요', en: "Autosave deferred · edit approval required" }); severity = 'warning'; detail = L({ ko: 'AI 또는 외부 API가 편집한 내용의 원본 저장 승인이 필요합니다.', en: "Saving AI or external API edits to the original requires approval." }); break;
        case 'manual-save': case 'save-as': case 'reload': case 'close': case 'path-transition': case 'stale-candidate': case 'session-closed':
          text = L({ ko: '자동 저장 보류', en: "Autosave deferred" }); detail = L({ ko: '문서 저장 또는 전환 작업을 마친 뒤 상태를 다시 확인합니다.', en: "Checks state again after saving or document switching finishes." }); break;
        default: text = L({ ko: '자동 저장 보류', en: "Autosave deferred" }); severity = 'warning'; detail = L({ ko: '저장 정책에 따라 원본 자동 저장을 보류했습니다.', en: "Autosave to the original was deferred by save policy." });
      }
      break;
  }
  if (status.warnings?.length) {
    text += L({ ko: ' · 경고', en: " · warning" });
    detail += L({ ko: ` 원본 저장 후 경고: ${status.warnings.join(' ')}`, en: ` Warning after saving the original: ${status.warnings.join(' ')}` });
    if (severity === 'normal') severity = 'warning';
  }
  return { text, detail, severity };
}

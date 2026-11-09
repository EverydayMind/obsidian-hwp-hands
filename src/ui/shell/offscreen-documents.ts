import type { State } from '../../api';

/** A working copy with unsaved changes that no editor view shows: an agent may have edited it without a person watching. */
export interface OffscreenDocument { path: string; sessionId: string; revision: number; pendingAi: number; pendingUnknown: number; conflict: boolean }

export function offscreenUnsavedDocuments(states: State[], viewPaths: Iterable<string>, pending: (sessionId: string) => { ai: number; unknown: number }): OffscreenDocument[] {
  const visible = new Set(viewPaths);
  return states.filter(state => state.dirty && !visible.has(state.path)).map(state => {
    const edits = pending(state.sessionId);
    return { path: state.path, sessionId: state.sessionId, revision: state.revision, pendingAi: edits.ai, pendingUnknown: edits.unknown, conflict: state.conflict };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

/** Empty when there is nothing to show, so the status bar item can hide. */
export function offscreenStatusText(documents: OffscreenDocument[]): string {
  if (!documents.length) return '';
  const ai = documents.filter(document => document.pendingAi > 0).length;
  return `화면에 없는 미저장 HWP 문서 ${documents.length}개${ai ? ` (AI 편집 ${ai}개)` : ''}`;
}

export function offscreenDocumentLabel(document: OffscreenDocument): string {
  const notes = [
    ...(document.pendingAi ? [`사람이 저장하지 않은 AI 편집 ${document.pendingAi}건`] : []),
    ...(document.pendingUnknown ? [`주체를 모르는 편집 ${document.pendingUnknown}건`] : []),
    ...(document.conflict ? ['파일이 밖에서 바뀜'] : []),
  ];
  return `${document.path}${notes.length ? ` · ${notes.join(' · ')}` : ''}`;
}

/** Shown once after start: recovery records of unopened documents that hold AI edits nobody saved. Empty when there are none. */
export function recoveredAiEditsNotice(records: Array<{ path: string; aiEdits: number }>): string {
  if (!records.length) return '';
  const names = records.slice(0, 5).map(record => `${record.path}(${record.aiEdits}건)`).join(', ');
  return `저장하지 않은 AI 편집이 복구 기록에 남아 있습니다: ${names}${records.length > 5 ? ` 외 ${records.length - 5}개` : ''}. 문서를 열면 그 편집이 다시 적용됩니다. 열어서 확인한 뒤 저장하거나 버리세요.`;
}

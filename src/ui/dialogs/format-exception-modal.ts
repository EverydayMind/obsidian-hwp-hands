import type { App } from 'obsidian';
import { FocusReturnModal } from './index';

/** One decision for one exact paragraph replacement, never persisted or reused. */
export class FormatExceptionModal extends FocusReturnModal {
  private settled = false;
  constructor(app: App, private readonly request: { path: string; before: string; after: string },
    private readonly resolve: (approved: boolean) => void, private readonly signal?: AbortSignal) { super(app); }
  private readonly abort = (): void => this.finish(false);
  private finish(approved: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.signal?.removeEventListener('abort', this.abort);
    this.resolve(approved && !this.signal?.aborted);
    this.close();
  }
  onOpen(): void {
    if (this.signal?.aborted) { this.finish(false); return; }
    this.signal?.addEventListener('abort', this.abort, { once: true });
    this.contentEl.createEl('h3', { text: '이 편집의 서식 보존 해제' });
    this.contentEl.createEl('p', { text: `문서: ${this.request.path}` });
    this.contentEl.createEl('p', { text: '혼합된 글자 서식을 정확히 보존할 수 없습니다. 승인 후 대화에서 같은 편집을 다시 요청하면 아래 문단 한 곳에만 적용합니다. 굵기·색·글꼴 등 서식이 달라질 수 있으며 파일 저장은 별도입니다. 승인은 5분 동안만 유효합니다.' });
    this.contentEl.createEl('h4', { text: '현재 문단' });
    this.contentEl.createEl('pre', { text: this.request.before, cls: 'hwp-format-exception-text' });
    this.contentEl.createEl('h4', { text: '바꿀 문단' });
    this.contentEl.createEl('pre', { text: this.request.after, cls: 'hwp-format-exception-text' });
    const cancel = this.contentEl.createEl('button', { text: '서식 보존하고 취소' });
    cancel.addEventListener('click', () => this.finish(false)); cancel.focus();
    this.contentEl.createEl('button', { text: '이번 편집만 서식 보존 해제', cls: 'mod-warning' }).addEventListener('click', () => this.finish(true));
  }
  onClose(): void { this.finish(false); this.contentEl.empty(); this.restoreFocus(); }
}

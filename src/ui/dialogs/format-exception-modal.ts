import { LT, L } from '../../i18n/locale';
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
    this.contentEl.createEl('h3', { text: L({ ko: '이 편집의 서식 보존 해제', en: "Disable formatting preservation for this edit" }) });
    this.contentEl.createEl('p', { text: LT({ ko: () => `문서: ${this.request.path}`, en: () => `Document: ${this.request.path}` }) });
    this.contentEl.createEl('p', { text: L({ ko: '혼합된 글자 서식을 정확히 보존할 수 없습니다. 승인 후 대화에서 같은 편집을 다시 요청하면 아래 문단 한 곳에만 적용합니다. 굵기·색·글꼴 등 서식이 달라질 수 있으며 파일 저장은 별도입니다. 승인은 5분 동안만 유효합니다.', en: "Mixed character formatting cannot be preserved exactly. After approval, repeat the same edit in the conversation to apply only to the paragraph below. Bold, color, fonts, and other formatting may change; file saving is separate. Approval is valid for five minutes." }) });
    this.contentEl.createEl('h4', { text: L({ ko: '현재 문단', en: "Current paragraph" }) });
    this.contentEl.createEl('pre', { text: this.request.before, cls: 'hwp-format-exception-text' });
    this.contentEl.createEl('h4', { text: L({ ko: '바꿀 문단', en: "Replacement paragraph" }) });
    this.contentEl.createEl('pre', { text: this.request.after, cls: 'hwp-format-exception-text' });
    const cancel = this.contentEl.createEl('button', { text: L({ ko: '서식 보존하고 취소', en: "Preserve formatting and cancel" }) });
    cancel.addEventListener('click', () => this.finish(false)); cancel.focus();
    this.contentEl.createEl('button', { text: L({ ko: '이번 편집만 서식 보존 해제', en: "Disable formatting preservation for this edit only" }), cls: 'mod-warning' }).addEventListener('click', () => this.finish(true));
  }
  onClose(): void { this.finish(false); this.contentEl.empty(); this.restoreFocus(); }
}

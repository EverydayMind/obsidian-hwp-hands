import type { App } from 'obsidian';
import { FocusReturnModal } from './index';

/** Asks for confirmation before a destructive command and resolves with the answer (false when dismissed). */
export class ConfirmActionModal extends FocusReturnModal {
  private settled = false;
  constructor(app: App, private readonly options: { title: string; message: string; confirmLabel: string }, private readonly resolve: (confirmed: boolean) => void) { super(app); }
  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true; this.resolve(confirmed); this.close();
  }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: this.options.title });
    this.contentEl.createEl('p', { text: this.options.message });
    const cancel = this.contentEl.createEl('button', { text: '취소' }); cancel.addEventListener('click', () => this.finish(false)); cancel.focus();
    this.contentEl.createEl('button', { text: this.options.confirmLabel, cls: 'mod-warning' }).addEventListener('click', () => this.finish(true));
  }
  onClose(): void { this.finish(false); this.contentEl.empty(); this.restoreFocus(); }
}

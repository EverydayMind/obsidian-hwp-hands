import { LT, L } from '../../i18n/locale';
import { Notice, TFile, type App } from 'obsidian';
import type HwpHandsPlugin from '../../main';
import { offscreenDocumentLabel, type OffscreenDocument } from '../shell/offscreen-documents';
import { FocusReturnModal } from './index';

/** Lists unsaved working copies that no view shows. Saving and discarding are a person's decisions and each asks twice. */
export class OffscreenDocumentsModal extends FocusReturnModal {
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;
  constructor(app: App, private readonly plugin: HwpHandsPlugin) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: L({ ko: '화면에 없는 미저장 HWP 문서', en: "Unsaved HWP documents without views" }) });
    this.contentEl.createEl('p', { text: L({ ko: '편집 화면이 없는데 저장하지 않은 변경이 남아 있는 문서입니다. 열어서 확인한 뒤 저장하는 것을 권장합니다. 버리면 마지막 저장 이후의 변경이 모두 사라집니다.', en: "These documents have unsaved changes but no editor views. Open and inspect them before saving. Discarding removes all changes since the last save." }) });
    this.statusEl = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    this.listEl = this.contentEl.createDiv();
    this.render();
  }
  onClose(): void { this.contentEl.empty(); this.restoreFocus(); }
  private render(): void {
    const documents = this.plugin.offscreenDocuments();
    this.listEl.empty();
    this.statusEl.setText(documents.length ? LT({ ko: () => `${documents.length}개 문서`, en: () => `${documents.length} documents` }) : L({ ko: '화면에 없는 미저장 문서가 없습니다.', en: "No unsaved documents without views." }));
    for (const document of documents) {
      const row = this.listEl.createDiv();
      row.createEl('p', { text: offscreenDocumentLabel(document) });
      const actions = row.createDiv({ cls: 'hwp-edit-actions' });
      actions.createEl('button', { text: L({ ko: '열기', en: "Open" }) }).onclick = () => { this.close(); void this.plugin.revealDocument(document.path, {}).catch(error => this.plugin.report(error)); };
      this.confirmed(actions, L({ ko: '저장', en: "Save" }), document.pendingAi || document.pendingUnknown ? L({ ko: '검토하지 않은 편집 포함 저장', en: "Save including unreviewed edits" }) : L({ ko: '저장 확인', en: "Confirm save" }), false, () => this.save(document));
      this.confirmed(actions, L({ ko: '버리기', en: "Discard" }), L({ ko: '변경 버리기 확인', en: "Confirm discard changes" }), true, () => this.discard(document));
    }
  }
  /** The first click only arms the button; the second one acts. */
  private confirmed(parent: HTMLElement, label: string, confirmLabel: string, warning: boolean, action: () => Promise<void>): void {
    const button = parent.createEl('button', { text: label });
    let armed = false;
    button.onclick = () => {
      if (!armed) { armed = true; button.setText(confirmLabel); if (warning) button.addClass('mod-warning'); return; }
      button.disabled = true;
      void action().catch(error => this.plugin.report(error)).finally(() => this.render());
    };
  }
  private async save(document: OffscreenDocument): Promise<void> {
    const result = await this.plugin.api.documents.save(document.path, { expectedRevision: document.revision });
    for (const warning of result.warnings) new Notice(warning, 8000);
    new Notice(LT({ ko: () => `저장했습니다: ${document.path}`, en: () => `Saved: ${document.path}` }));
  }
  private async discard(document: OffscreenDocument): Promise<void> {
    // Only the state the person looked at is discarded: a change since the list was drawn cancels it.
    const current = await this.plugin.api.documents.state(document.path);
    if (current.sessionId !== document.sessionId || current.revision !== document.revision) throw new Error(L({ ko: '목록을 연 뒤 문서가 바뀌어 버리지 않았습니다. 다시 확인하세요.', en: "The document changed after this list opened; nothing was discarded. Check again." }));
    if (!(this.app.vault.getAbstractFileByPath(document.path) instanceof TFile)) throw new Error(LT({ ko: () => `원본 파일이 없어 버리지 않았습니다: ${document.path}`, en: () => `The original file is missing; nothing was discarded: ${document.path}` }));
    await this.plugin.api.documents.reload(document.path, { discardChanges: true });
    new Notice(LT({ ko: () => `저장하지 않은 변경을 버렸습니다: ${document.path}`, en: () => `Discarded unsaved changes: ${document.path}` }));
  }
}

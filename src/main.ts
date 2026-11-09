import { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, type App, type Hotkey } from 'obsidian';
import { rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

declare const __HWP_WORKER_SOURCE__: string;
declare const __HWP_WASM_GZIP__: string;
declare const __HWP_WASM_SHA256__: string;

function embeddedWasm(): Uint8Array {
  const bytes = gunzipSync(Buffer.from(__HWP_WASM_GZIP__, 'base64'));
  if (createHash('sha256').update(bytes).digest('hex') !== __HWP_WASM_SHA256__) throw new Error('Bundled RHWP WASM SHA-256 mismatch');
  return bytes;
}
import type { BodyAddress, HwpHandsApiV1 } from './api';
import { AGENT_CAPABILITY_PROVIDER, PROVIDERS_CHANGED_EVENT, createAgentProvider, type AgentCapabilityProvider } from './agent/provider';
import { EditMarks } from './agent/marks';
import { AgentPrivacy, type AgentPrivacyData } from './agent/privacy';
import { InputDraftStore, validateInputDraftCopyPath, type InputDraftEntry, type InputDraftInput } from './input-drafts';
import { DEFAULT_OPTIONS, DocumentManager, type ManagerOptions } from './manager';
import { WorkerEngineProvider, type EngineProgress } from './engine-worker-provider';
import { VaultStorage } from './storage';
import { HwpView, VIEW_TYPE } from './view';
import { EDITOR_VIEW_TYPE, PREVIOUS_VIEW_TYPES, HwpHandsView, LegacyHwpView, PreviousHwpView } from './editor-view';
import { HwpDocumentPickerModal, InputDraftRecoveryModal, PathModal, SaveOnCloseModal, StorageCleanupModal, type SaveOnCloseChoice } from './ui/dialogs';
import { processHwpMarkdown } from './markdown-integration';
import type { HwpLinkTarget } from './hwp-links';
import { EDITOR_COMMAND_CATALOG } from './ui/commands/command-registry';
import { editorHotkey, isBrowserEditShortcut } from './ui/commands/editor-hotkey';
import { DEFAULT_EDITOR_CHROME, editorChromeFromSettings, editorChromePreset, type EditorChrome } from './ui/shell/editor-chrome';
import { DEFAULT_INPUT_MODE, normalizeInputMode, type InputModeSettings } from './ui/editor/input-mode';
import { ViewContextService } from './ui/editor/view-context';
import { revealOutputAnchor } from './output-anchor-reveal';
import { OffscreenDocumentsModal } from './ui/dialogs/offscreen-documents-modal';
import { FormatExceptionModal } from './ui/dialogs/format-exception-modal';
import { offscreenStatusText, offscreenUnsavedDocuments, recoveredAiEditsNotice, type OffscreenDocument } from './ui/shell/offscreen-documents';
import { installPluginStyles } from './plugin-styles';

interface HwpHandsSettings extends ManagerOptions, InputModeSettings { autoOpenWithEditor: boolean; editorPreviewEnabled: boolean; editorChrome: EditorChrome;
  /** Internal opt-in, no settings UI. Off until the agent edit tools pass host evaluation and visible acceptance. */
  agentEditTools: boolean;
  /** Internal opt-in, no settings UI, used only with agentEditTools. Off until a host's save approval and rollback pass acceptance. */
  agentSaveTool: boolean;
  agentPrivacy?: AgentPrivacyData }
const DEFAULT_PLUGIN_SETTINGS: HwpHandsSettings = { ...DEFAULT_OPTIONS, ...DEFAULT_INPUT_MODE, autoOpenWithEditor: true, editorPreviewEnabled: true, editorChrome: DEFAULT_EDITOR_CHROME, agentEditTools: false, agentSaveTool: false };
function managerOptions(settings: HwpHandsSettings): ManagerOptions {
  return { backup: settings.backup, autoIndex: settings.autoIndex, historyLimit: settings.historyLimit, maxFileBytes: settings.maxFileBytes };
}

export default class HwpHandsPlugin extends Plugin {
  api!: HwpHandsApiV1;
  manager!: DocumentManager;
  settings: HwpHandsSettings = { ...DEFAULT_PLUGIN_SETTINGS };
  private inputDraftStore!: InputDraftStore;
  private engineProvider!: WorkerEngineProvider;
  private agentProvider?: AgentCapabilityProvider;
  private agentPrivacy!: AgentPrivacy;
  /** Where AI edits landed that no person has looked through; the editor views draw them. Empty unless the edit tools are on. */
  readonly editMarks = new EditMarks();
  private engineNotice?: Notice;
  private engineNoticeTimer?: ReturnType<typeof setTimeout>;
  private readonly engineTasks = new Map<number, EngineProgress>();
  /** Set when the app quits or the plugin unloads; views closing then leave their recovery records instead of asking. */
  private closingDown = false;
  private readonly savePrompts = new Set<string>();
  async onload(): Promise<void> {
    this.closingDown = false;
    this.registerEvent(this.app.workspace.on('quit', () => { this.closingDown = true; }));
    const saved: Partial<HwpHandsSettings> = await this.loadData() as Partial<HwpHandsSettings>;
    this.settings = { ...DEFAULT_PLUGIN_SETTINGS, ...saved };
    this.agentPrivacy = new AgentPrivacy(saved?.agentPrivacy, () => this.app.vault.getFiles().map(file => file.path));
    this.settings.autoOpenWithEditor = this.settings.autoOpenWithEditor !== false;
    // Keep the 0.2.x toolbar visibility switch for editorChrome migration; all documents use the page-first view.
    this.settings.editorPreviewEnabled = this.settings.editorPreviewEnabled !== false;
    this.settings.editorChrome = editorChromeFromSettings(saved ?? {});
    Object.assign(this.settings, normalizeInputMode(saved));
    // 0.3.0 removed the compatibility screen and the visible input box, with their settings.
    for (const key of ['documentFocusedView', 'directEditingEnabled']) delete (this.settings as unknown as Record<string, unknown>)[key];
    this.settings.historyLimit = Math.min(100, Math.max(1, Number(this.settings.historyLimit) || 30));
    this.settings.maxFileBytes = Math.min(200 * 1024 * 1024, Math.max(1024 * 1024, Number(this.settings.maxFileBytes) || DEFAULT_OPTIONS.maxFileBytes));
    const directory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const adapter = this.app.vault.adapter;
    await this.ensurePluginStyles(directory, adapter);
    this.inputDraftStore = new InputDraftStore(adapter, `${directory}/input-drafts`, async (source, destination) => {
      if (!(adapter instanceof FileSystemAdapter)) throw new Error('입력 복구본에는 데스크톱 파일 시스템이 필요합니다.');
      await rename(adapter.getFullPath(source), adapter.getFullPath(destination));
    });
    this.engineProvider = new WorkerEngineProvider(
      async () => __HWP_WORKER_SOURCE__,
      async () => embeddedWasm(),
      progress => this.onEngineProgress(progress),
    );
    this.manager = new DocumentManager(new VaultStorage(this.app.vault, directory), this.engineProvider, managerOptions(this.settings), this.manifest.version);
    this.api = this.manager.api;
    const inspectOpenOutput = this.api.query.outputAnchorCandidatesIfOpen?.bind(this.api.query);
    if (inspectOpenOutput) this.api.query.outputAnchorCandidatesIfOpen = (path, hash, anchors) =>
      this.agentPrivacy.run([path], undefined, async signal => {
        if (signal.aborted) throw new Error('문단 후보 조회가 취소됐습니다.');
        return inspectOpenOutput(path, hash, anchors);
      });
    const viewContext = new ViewContextService(this.api);
    this.api.views = viewContext.views;
    this.api.views.revealOutputAnchor = (input, signal) => this.agentPrivacy.run(
      [input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'path')?.value : undefined], signal,
      combined => revealOutputAnchor(this.api, input,
      path => this.hwpViews().find(view => view.file?.path === path),
      async view => {
        const current = this.hwpViews().find(candidate => candidate === view);
        if (!current) throw new Error('편집 화면이 닫혔습니다.');
        await this.app.workspace.revealLeaf(current.leaf);
        this.app.workspace.setActiveLeaf(current.leaf, { focus: true });
      }, combined));
    const bindViews = () => viewContext.bind(this.hwpViews().map(view => ({ element: view.contentEl, read: () => view.readViewContext() })));
    this.registerEvent(this.app.workspace.on('layout-change', bindViews));
    this.app.workspace.onLayoutReady(bindViews);
    this.register(this.api.events.on('*', () => viewContext.changed()));
    this.register(() => { viewContext.dispose(); delete this.api.views; });
    // Agent hosts discover this provider on the plugin instance; the plugin does not know or import any host.
    this.agentProvider = createAgentProvider(this.api, { version: this.manifest.version, viewPaths: () => this.viewPaths(),
      privacy: this.agentPrivacy,
      rewriteCompute: (request, signal) => this.engineProvider.rewriteCompute(request, signal),
      approveFormatException: (request, signal) => new Promise(resolve => new FormatExceptionModal(this.app, request, resolve, signal).open()),
      reveal: (path, target) => this.revealDocument(path, target),
      ...(this.settings.agentEditTools === true ? { marks: this.editMarks, edit: {
        transaction: (path, commands, options, actorId, signal) => this.manager.transactionFromAi(path, commands, options, actorId, signal),
        undo: (path, options, signal) => this.manager.undoFromAi(path, options, signal),
        pendingEdits: sessionId => this.manager.pendingActorEdits(sessionId),
        onApplied: listener => this.manager.observeApplied(listener),
        discard: (path, options, actorId, signal) => this.manager.discardFromAi(path, options, actorId, signal),
      }, ...(this.settings.agentSaveTool === true ? { commit: {
        prepare: (path, context) => this.manager.prepareSave(path, context),
        resolveNew: (destination, template) => this.manager.resolveNewDocument(destination, template),
        prepareNew: request => this.manager.prepareNewDocument(request),
        execute: (ticket, permit) => this.manager.executePreparedSave(ticket, permit),
        status: preparationId => this.manager.preparedSaveStatus(preparationId),
        cancel: preparationId => this.manager.cancelPreparedSave(preparationId),
      } } : {}) } : {}) });
    Object.defineProperty(this, AGENT_CAPABILITY_PROVIDER, { value: this.agentProvider, configurable: true, enumerable: false, writable: false });
    this.register(() => this.editMarks.dispose());
    this.app.workspace.onLayoutReady(() => this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT));
    // A working copy can stay unsaved with no view on it, for example after an agent edited a document nobody opened.
    const offscreenStatus = this.addStatusBarItem();
    offscreenStatus.addClass('mod-clickable');
    offscreenStatus.setAttribute('aria-label', '화면에 없는 미저장 HWP 문서 보기');
    offscreenStatus.onclick = () => new OffscreenDocumentsModal(this.app, this).open();
    const updateOffscreenStatus = () => { const label = offscreenStatusText(this.offscreenDocuments()); offscreenStatus.setText(label); offscreenStatus.toggle(!!label); };
    this.register(this.api.events.on('*', updateOffscreenStatus));
    this.registerEvent(this.app.workspace.on('layout-change', updateOffscreenStatus));
    this.app.workspace.onLayoutReady(updateOffscreenStatus);
    this.addCommand({ id: 'offscreen-unsaved-documents', name: '화면에 없는 미저장 HWP 문서 보기', callback: () => new OffscreenDocumentsModal(this.app, this).open() });
    // After a restart the leases are gone and unsaved AI edits live only in recovery records; say so once, without opening anything.
    this.app.workspace.onLayoutReady(() => {
      const timer = window.setTimeout(() => {
        void this.manager.recoveredAiEdits().then(records => { const text = recoveredAiEditsNotice(records); if (text) new Notice(text, 20000); })
          .catch(error => console.error('HWP Hands recovery notice:', error));
      }, 3000);
      this.register(() => window.clearTimeout(timer));
    });
    this.registerView(VIEW_TYPE, leaf => new LegacyHwpView(leaf, this));
    this.registerView(EDITOR_VIEW_TYPE, leaf => new HwpHandsView(leaf, this));
    for (const type of PREVIOUS_VIEW_TYPES) this.registerView(type, leaf => new PreviousHwpView(leaf, this, type));
    this.app.workspace.onLayoutReady(() => { void this.moveLegacyLeaves(); });
    if (this.settings.autoOpenWithEditor) this.registerExtensions(['hwp', 'hwpx'], EDITOR_VIEW_TYPE);
    this.registerMarkdownPostProcessor((element, context) => processHwpMarkdown(this, element, context));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
      if (!(file instanceof TFile) || !/^(hwp|hwpx)$/i.test(file.extension)) return;
      // A document tab passes its own menu on as a file menu (addFilePaneMenuItems); it is already open there.
      if (!(leaf?.view instanceof HwpView && leaf.view.file === file)) menu.addItem(item => item.setTitle('HWP Hands로 열기').setIcon('file-pen-line').onClick(() => {
        void this.openInEditor(file).catch(error => this.report(error));
      }));
      menu.addItem(item => item.setTitle(this.isAiPrivate(file.path) ? 'HWP Hands AI 비공개 해제' : 'HWP Hands AI 비공개로 설정').setIcon('shield').onClick(() => {
        void this.setAiPrivate(file.path, !this.isAiPrivate(file.path)).catch(error => this.report(error));
      }));
    }));
    this.addCommand({ id: 'new-hwpx', name: '새 HWPX 문서 만들기', callback: () => this.createNewDocument() });
    for (const hidden of [true, false]) this.addCommand({ id: hidden ? 'hide-document-from-ai' : 'show-document-to-ai',
      name: hidden ? '현재 한글 문서를 AI 비공개로 설정' : '현재 한글 문서의 AI 비공개 해제', checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(HwpView), path = view?.file?.path;
        if (!path || this.isAiPrivate(path) === hidden || this.agentPrivacy.needsRepair) return false;
        if (!checking) void this.setAiPrivate(path, hidden).catch(error => this.report(error));
        return true;
      } });
    this.addCommand({ id: 'toggle-editor-menu', name: 'HWP: 메뉴 접기/펴기', checkCallback: checking => {
      const view = this.app.workspace.getActiveViewOfType(HwpView);
      if (!view) return false;
      if (!checking) view.toggleAllChrome();
      return true;
    } });
    this.addCommand({ id: 'save-document', name: '현재 한글 문서 저장', hotkeys: [editorHotkey('Mod+S')], checkCallback: checking => {
      const view = this.app.workspace.getActiveViewOfType(HwpView);
      if (!view || !view.canRunEditorCommand('file.save')) return false; if (!checking) view.runSaveCommand(); return true;
    } });
    this.addCommand({ id: 'refresh-index', name: '현재 한글 문서의 Markdown 인덱스 생성', checkCallback: checking => {
      const view = this.app.workspace.getActiveViewOfType(HwpView);
      if (!view || !view.canRunEditorCommand('file.refresh-index')) return false; if (!checking) view.runRefreshIndexCommand(); return true;
    } });
    const addActiveEditorCommand = (id: string, name: string, shortcuts: readonly string[]): void => {
      let hotkeys: Hotkey[] | undefined;
      // Basic browser/OS shortcuts (Mod+C, Mod+V, Mod+A, Mod+X, Mod+Z, etc.) are isolated to the HWP view scope and must never be passed to Obsidian global hotkeys.
      const candidateShortcuts = shortcuts.filter(shortcut => !isBrowserEditShortcut(shortcut));
      if (candidateShortcuts.length) {
        hotkeys = [];
        for (const shortcut of candidateShortcuts) {
          try { hotkeys.push(editorHotkey(shortcut)); }
          catch (error) { this.report(error); }
        }
        if (!hotkeys.length) hotkeys = undefined;
      }
      this.addCommand({
        id: `editor-${id.replaceAll('.', '-')}`,
        name: `HWP Hands: ${name}`,
        ...(hotkeys ? { hotkeys } : {}),
        checkCallback: checking => {
          const view = this.app.workspace.getActiveViewOfType(HwpView);
          if (!view || !view.canRunEditorCommand(id)) return false;
          if (!checking) void view.runEditorCommand(id);
          return true;
        },
      });
    };
    for (const command of EDITOR_COMMAND_CATALOG) {
      const shortcuts = [...('shortcut' in command && command.shortcut ? [command.shortcut] : []), ...('aliases' in command ? command.aliases : [])];
      if (command.id !== 'file.save' && command.id !== 'file.refresh-index') addActiveEditorCommand(command.id, command.label, shortcuts);
    }
    this.addCommand({ id: 'open-document', name: 'HWP/HWPX 문서 열기', callback: () => {
      this.openDocumentPicker();
    } });
    this.addCommand({ id: 'cancel-engine-operation', name: '현재 HWP 엔진 작업 취소', checkCallback: checking => {
      if (!this.engineProvider.canCancelCurrent) return false;
      if (!checking) this.engineProvider.cancelCurrent();
      return true;
    } });
    this.addCommand({ id: 'recover-input-drafts', name: '미적용 입력 복구', callback: () => new InputDraftRecoveryModal(this.app, this).open() });
    this.addCommand({ id: 'cleanup-plugin-storage', name: 'HWP Hands 보관 파일 정리', callback: () => new StorageCleanupModal(this.app, this).open() });
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file instanceof TFile && /^(hwp|hwpx)$/i.test(file.extension)) void this.manager.handleExternalModify(file.path).catch(error => this.report(error));
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      if (file instanceof TFile && /^(hwp|hwpx)$/i.test(file.extension)) void Promise.all([this.manager.externalChange(file.path), this.manager.removeSourceIndex(file.path)]).catch(error => this.report(error));
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      // Apply the gate synchronously, before manager/index work can yield to an AI request.
      if (this.agentPrivacy.renamed(oldPath, file.path)) void this.agentPrivacy.persist(data => this.persistAiPrivacy(data)).catch(error => this.report(error));
      if (file instanceof TFolder) void (async () => {
        await this.manager.renameFolder(oldPath, file.path);
        const moved = this.app.vault.getFiles().filter(item => item.path.startsWith(`${file.path}/`) && /^(hwp|hwpx)$/i.test(item.extension));
        for (const item of moved) await this.manager.syncIndexRename(`${oldPath}${item.path.slice(file.path.length)}`, item.path);
      })().catch(error => this.report(error));
      else if (/\.(hwp|hwpx)$/i.test(oldPath)) void (async () => {
        await this.manager.rename(oldPath, file.path);
        await this.manager.syncIndexRename(oldPath, file.path);
      })().catch(error => this.report(error));
    }));
    this.addSettingTab(new HwpSettings(this.app, this));
  }
  isAiPrivate(path: string): boolean { return this.agentPrivacy.configured(path); }
  aiPrivatePaths(): string[] | null { return this.agentPrivacy.needsRepair ? null : this.agentPrivacy.snapshot().blockedPaths; }
  aiPrivacyNeedsReview(): boolean { return this.agentPrivacy.needsReview; }
  private async persistAiPrivacy(data: AgentPrivacyData): Promise<void> {
    this.settings.agentPrivacy = data;
    try { await this.saveData(this.settings); }
    catch (error) { this.settings.agentPrivacy = this.agentPrivacy.snapshot(); throw error; }
  }
  async setAiPrivate(path: string, hidden: boolean): Promise<void> {
    await this.agentPrivacy.set(path, hidden, data => this.persistAiPrivacy(data));
    this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT);
    new Notice(hidden ? '이 문서는 HWP Hands AI 도구에 제공하지 않습니다. 이미 전달된 내용과 별도 Markdown 인덱스·파일 접근에는 적용되지 않습니다.' : '이 문서의 HWP Hands AI 비공개를 해제했습니다. 새로 조회한 뒤 사용할 수 있습니다.', 10000);
  }
  private async ensurePluginStyles(directory: string, adapter: App['vault']['adapter']): Promise<void> {
    const stylePath = `${this.manifest.id}/styles.css`.toLocaleLowerCase();
    const alreadyLoaded = [...document.styleSheets].some(stylesheet =>
      stylesheet.href?.toLocaleLowerCase().includes(stylePath),
    );
    if (alreadyLoaded) return;

    const css = await adapter.read(`${directory}/styles.css`);
    this.register(installPluginStyles(document, css));
  }
  createNewDocument(): void {
    const parent = this.app.workspace.getActiveFile()?.parent?.path;
    const prefix = parent && parent !== '/' ? `${parent}/` : '';
    new PathModal(this.app, '새 HWPX 문서 경로', `${prefix}새 문서.hwpx`, async path => {
      const result = await this.api.documents.create(path);
      for (const warning of result.warnings ?? []) new Notice(warning, 8000);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await this.openInEditor(file);
    }).open();
  }
  openDocumentPicker(): void {
    new HwpDocumentPickerModal(this.app, file => {
      void this.openInEditor(file).catch(error => this.report(error));
    }).open();
  }
  async openInEditor(file: TFile, target?: HwpLinkTarget): Promise<void> {
    if (!/^(hwp|hwpx)$/i.test(file.extension)) throw new Error('HWP 또는 HWPX 파일만 HWP Hands에서 열 수 있습니다.');
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: EDITOR_VIEW_TYPE, state: { file: file.path }, active: true });
    const view = leaf.view;
    if (!(view instanceof HwpView)) throw new Error('HWP Hands 화면을 열지 못했습니다.');
    if (target) await view.navigateToLinkedTarget(target);
  }
  /**
   * After a view left a document, asks once whether to save an unsaved working copy nobody holds any more (decision 69).
   * Quitting, unloading or a crash skips the question; the recovery record then brings the changes back on the next open.
   */
  offerSaveOnClose(path: string): void {
    if (!path || this.closingDown) return;
    // Let a tab that is moving or reopening the same file take its lease first.
    window.setTimeout(() => {
      if (this.closingDown || this.savePrompts.has(path) || this.hwpViews().some(view => view.file?.path === path)) return;
      const state = this.manager.unheldUnsaved(path);
      if (!state) return;
      this.savePrompts.add(path);
      const name = path.split('/').at(-1) ?? path;
      new SaveOnCloseModal(this.app, name, state.conflict, choice => {
        void this.settleSaveOnClose(path, state, choice).catch(error => this.report(error)).finally(() => this.savePrompts.delete(path));
      }).open();
    }, 50);
  }
  private async settleSaveOnClose(path: string, state: { sessionId: string; revision: number }, choice: SaveOnCloseChoice): Promise<void> {
    const options = { sessionId: state.sessionId, expectedRevision: state.revision };
    const reopen = async () => { const file = this.app.vault.getAbstractFileByPath(path); if (file instanceof TFile) await this.openInEditor(file); };
    if (choice === 'reopen') { await reopen(); return; }
    // Dismissed: the working copy and its recovery record stay; the status bar lists it with the other offscreen documents.
    if (choice === 'later') return;
    // While this prompt waited, the copy may have been saved, dropped or taken up by a view; that holder decides now.
    if (this.manager.unheldUnsaved(path)?.sessionId !== state.sessionId) return;
    try {
      if (choice === 'save') {
        const result = await this.manager.saveUnheld(path, options);
        for (const warning of result.warnings) new Notice(warning, 8000);
        new Notice(`한글 문서를 저장했습니다: ${path}`);
      } else await this.manager.discardUnheld(path, options);
    } catch (error) {
      new Notice(`${choice === 'save' ? '저장하지 못했습니다' : '변경을 버리지 못했습니다'}. 변경은 그대로 남아 있어 문서를 다시 엽니다. ${error instanceof Error ? error.message : String(error)}`, 12000);
      await reopen();
    }
  }
  private viewPaths(): string[] { return this.hwpViews().flatMap(view => view.file ? [view.file.path] : []); }
  offscreenDocuments(): OffscreenDocument[] {
    return offscreenUnsavedDocuments(this.api.documents.list(), this.viewPaths(), sessionId => this.manager.pendingActorEdits(sessionId));
  }
  /** Brings the document's view to the front, opening a tab if it has none, then moves to the paragraph or page (from 1). */
  async revealDocument(path: string, target: { address?: BodyAddress; page?: number }): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`문서를 찾을 수 없습니다: ${path}`);
    let view = this.hwpViews().find(item => item.file?.path === path);
    if (view) { await this.app.workspace.revealLeaf(view.leaf); this.app.workspace.setActiveLeaf(view.leaf, { focus: true }); }
    else { await this.openInEditor(file); view = this.hwpViews().find(item => item.file?.path === path); }
    if (view && (target.address || target.page !== undefined)) await view.revealPlace(target);
  }
  applyEditorPreviewSetting(enabled: boolean): void {
    for (const leaf of [...this.app.workspace.getLeavesOfType(VIEW_TYPE), ...this.app.workspace.getLeavesOfType(EDITOR_VIEW_TYPE)]) {
      const view = leaf.view;
      if (view instanceof HwpView) view.setEditorPreviewEnabled(enabled);
    }
  }
  async setEditorChrome(chrome: EditorChrome): Promise<void> {
    this.settings.editorChrome = { ...chrome };
    this.settings.editorPreviewEnabled = true;
    await this.saveData(this.settings);
    for (const leaf of [...this.app.workspace.getLeavesOfType(VIEW_TYPE), ...this.app.workspace.getLeavesOfType(EDITOR_VIEW_TYPE)]) {
      if (leaf.view instanceof HwpView) {
        leaf.view.setEditorPreviewEnabled(true);
        leaf.view.setEditorChrome(chrome);
      }
    }
  }
  async setInputMode(settings: InputModeSettings): Promise<void> {
    Object.assign(this.settings, normalizeInputMode(settings));
    await this.saveData(this.settings);
    for (const leaf of [...this.app.workspace.getLeavesOfType(VIEW_TYPE), ...this.app.workspace.getLeavesOfType(EDITOR_VIEW_TYPE)]) {
      if (leaf.view instanceof HwpView) leaf.view.updateInputMode();
    }
  }
  /** Leaves restored from a workspace saved with the removed compatibility view type move to the page-first view type. */
  private async moveLegacyLeaves(): Promise<void> {
    const activeLeaf = this.app.workspace.activeLeaf;
    for (const leaf of [VIEW_TYPE, ...PREVIOUS_VIEW_TYPES].flatMap(type => this.app.workspace.getLeavesOfType(type))) {
      const view = leaf.view;
      if (!(view instanceof HwpView) || !view.file) continue;
      try {
        const state = view.getState();
        await leaf.setViewState({ type: EDITOR_VIEW_TYPE, state: { ...state, file: view.file.path }, active: leaf === activeLeaf });
      } catch (error) { this.report(error); }
    }
  }
  private onEngineProgress(progress: EngineProgress): void {
    if (progress.phase === 'started' || progress.phase === 'cancel-requested') {
      this.engineTasks.set(progress.requestId, progress);
      if (!this.engineNotice && !this.engineNoticeTimer) {
        this.engineNoticeTimer = setTimeout(() => {
          this.engineNoticeTimer = undefined;
          if (!this.engineTasks.size) return;
          this.engineNotice = new Notice('HWP 문서 작업 처리 중입니다. 명령 팔레트에서 작업을 취소할 수 있습니다.', 0);
        }, 250);
      }
      return;
    }
    this.engineTasks.delete(progress.requestId);
    if (!this.engineTasks.size) {
      if (this.engineNoticeTimer) clearTimeout(this.engineNoticeTimer);
      this.engineNoticeTimer = undefined;
      this.engineNotice?.hide(); this.engineNotice = undefined;
    }
  }
  report(error: unknown): void { console.error('HWP Hands:', error); new Notice(error instanceof Error ? error.message : String(error), 8000); }
  async backupInputDraft(draft: InputDraftInput, existingId?: string): Promise<string> {
    return this.inputDraftStore.save(draft, existingId);
  }
  async listInputDrafts(): Promise<InputDraftEntry[]> {
    return this.inputDraftStore.list();
  }
  async discardInputDraft(id: string): Promise<void> {
    await this.inputDraftStore.remove(id);
  }
  async restoreInputDraftAsCopy(id: string, inputPath: string): Promise<string> {
    const path = validateInputDraftCopyPath(inputPath);
    const record = await this.inputDraftStore.read(id);
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`같은 경로에 파일이 있습니다: ${path}`);
    const parts = path.split('/'); parts.pop(); let folder = '';
    for (const part of parts) {
      folder = folder ? `${folder}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(folder);
      if (existing && !(existing instanceof TFolder)) throw new Error(`폴더 경로에 파일이 있습니다: ${folder}`);
      if (!existing) await this.app.vault.createFolder(folder);
    }
    await this.app.vault.create(path, record.value);
    return path;
  }
  onunload(): void {
    this.closingDown = true;
    if (this.engineNoticeTimer) clearTimeout(this.engineNoticeTimer);
    this.engineNotice?.hide(); this.engineNotice = undefined;
    const provider = this.agentProvider; this.agentProvider = undefined;
    delete (this as unknown as Record<symbol, unknown>)[AGENT_CAPABILITY_PROVIDER];
    this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT);
    void Promise.allSettled([...this.hwpViews().map(v => v.flushDraft()), provider?.dispose()]).then(() => this.manager?.dispose());
  }
  private hwpViews(): HwpView[] {
    return [VIEW_TYPE, EDITOR_VIEW_TYPE, ...PREVIOUS_VIEW_TYPES].flatMap(type => this.app.workspace.getLeavesOfType(type))
      .map(l => l.view).filter((v): v is HwpView => v instanceof HwpView);
  }
}
class HwpSettings extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HwpHandsPlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('p', { text: '문서는 로컬에서 처리됩니다. 화면의 글꼴과 복잡한 배치는 한컴 한글과 다를 수 있습니다.' });
    this.containerEl.createEl('p', { text: `진단 정보: HWP Hands ${this.plugin.manifest.version} · RHWP ${this.plugin.api.engineVersion} · API v${this.plugin.api.version}. Obsidian 버전은 설정의 정보 화면에서 확인할 수 있습니다.` });
    new Setting(this.containerEl).setName('HWP/HWPX 기본 열기').setDesc('켜면 파일 탐색기와 일반 링크가 HWP Hands를 기본 보기로 사용합니다. 다른 플러그인과 충돌하거나 기본 보기를 바꾸려면 끄세요. 변경은 플러그인을 다시 불러온 뒤 적용됩니다. 파일 메뉴의 “HWP Hands로 열기”는 항상 사용할 수 있습니다.').addToggle(t => t.setValue(this.plugin.settings.autoOpenWithEditor).onChange(async value => {
      this.plugin.settings.autoOpenWithEditor = value; await this.persist(); new Notice('파일 기본 열기 설정을 적용하려면 HWP Hands 플러그인을 다시 불러오세요.');
    }));
    new Setting(this.containerEl).setName('편집 화면 도구 표시').setDesc('메뉴와 도구 상자를 접어 문서 공간을 넓힙니다. 열린 HWP 탭에 바로 적용됩니다.').addDropdown(dropdown => dropdown
      .addOption('expanded', '모두 펼침').addOption('basic-collapsed', '기본 도구 상자 접음').addOption('all-collapsed', '모두 접음').addOption('custom', '개별 설정')
      .setValue(editorChromePreset(this.plugin.settings.editorChrome)).onChange(async value => {
        if (value === 'custom') return;
        await this.plugin.setEditorChrome(value === 'expanded' ? { menu: true, basicToolbox: true, formatToolbox: true }
          : value === 'basic-collapsed' ? { menu: true, basicToolbox: false, formatToolbox: true }
            : { menu: false, basicToolbox: false, formatToolbox: false });
      }));
    new Setting(this.containerEl).setName('입력 수신기 배치').setDesc('쪽 위에서 입력을 받는 보이지 않는 수신기의 위치입니다. 기본은 캐럿 위치입니다. IME 후보창이나 스크린리더에 문제가 있으면 투명 줄 상자를 사용하세요.').addDropdown(dropdown => dropdown
      .addOption('caret', '캐럿 위치 (권장)').addOption('line', '투명 줄 상자').setValue(this.plugin.settings.inputReceiverPlacement).onChange(async value => {
        await this.plugin.setInputMode({ ...this.plugin.settings, inputReceiverPlacement: value === 'line' ? 'line' : 'caret' });
      }));
    new Setting(this.containerEl).setName('입력 미리보기').setDesc('문서에 반영되기 전의 글자와 한글 조합을 쪽 위에 즉시 표시합니다. 끄면 엔진 쪽 이미지가 갱신될 때까지 기다립니다.').addToggle(toggle => toggle
      .setValue(this.plugin.settings.editPreviewEnabled).onChange(async editPreviewEnabled => {
        await this.plugin.setInputMode({ ...this.plugin.settings, editPreviewEnabled });
      }));
    new Setting(this.containerEl).setName('저장 전 원본 백업').setDesc('플러그인 폴더에 저장 전 파일을 문서별 최신 3개까지 보관합니다. 저장이 확인되면 그보다 오래된 백업은 지웁니다.').addToggle(t => t.setValue(this.plugin.settings.backup).onChange(async value => { this.plugin.settings.backup = value; await this.persist(); }));
    new Setting(this.containerEl).setName('저장·외부 변경 후 검색 인덱스 자동 생성').setDesc('원본 옆 .index.md를 저장, 외부 수정, 이름 변경 뒤 갱신합니다. 직접 편집하거나 사용자 소유로 확인되는 인덱스는 보존합니다.').addToggle(t => t.setValue(this.plugin.settings.autoIndex).onChange(async value => { this.plugin.settings.autoIndex = value; await this.persist(); }));
    const privatePaths = this.plugin.aiPrivatePaths();
    new Setting(this.containerEl).setName('문서 전체 AI 비공개').setHeading();
    this.containerEl.createEl('p', { text: privatePaths === null
      ? '비공개 설정을 읽을 수 없어 HWP Hands AI 접근을 모두 차단했습니다. 정상 비공개 설정을 복구한 뒤 플러그인을 다시 불러오세요.'
      : '파일 메뉴나 명령 팔레트에서 지정합니다. HWP Hands AI 도구의 조회·검색·편집·저장을 차단합니다. 이미 전달한 내용, 별도 Markdown 인덱스와 다른 도구의 파일 접근에는 적용되지 않습니다. 이동 전 경로도 확인 후 해제할 때까지 유지합니다.' });
    if (this.plugin.aiPrivacyNeedsReview()) this.containerEl.createEl('p', { text: '비공개 문서가 기록된 경로에 없어 모든 HWP Hands AI 접근을 차단했습니다. 이동한 문서를 먼저 비공개로 지정한 뒤 이전 경로를 해제하세요. 삭제했다면 이전 경로를 확인하고 해제하세요.' });
    for (const path of privatePaths ?? []) new Setting(this.containerEl).setName(path).addButton(button => button.setButtonText('비공개 해제').onClick(async () => {
      try { await this.plugin.setAiPrivate(path, false); this.display(); }
      catch { new Notice('비공개 설정을 저장하지 못해 차단을 유지합니다.'); }
    }));
    new Setting(this.containerEl).setName('문서 최대 크기 (MB)').addText(t => t.setValue(String(this.plugin.settings.maxFileBytes / 1024 / 1024)).onChange(async value => {
      const size = Number(value); if (Number.isFinite(size) && size >= 1 && size <= 200) { this.plugin.settings.maxFileBytes = size * 1024 * 1024; await this.persist(); }
    }));
    this.containerEl.createEl('p', { text: '다른 플러그인: app.plugins.plugins["hwp-hands"].api (version = 1). 배포 폴더의 API.md에서 계약을 확인할 수 있습니다.' });
  }
  private async persist(): Promise<void> { this.plugin.manager.options = managerOptions(this.plugin.settings); await this.plugin.saveData(this.plugin.settings); }
}

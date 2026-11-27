import { LT, L, getLocale } from './i18n/locale';
import { agentSkillNames, hostSkillSupport } from './agent/agent-skills';
import './i18n/app-locale';
import { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, type App, type Command, type Hotkey, type WorkspaceLeaf } from 'obsidian';
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
import { EDITOR_COMMAND_CATALOG, EXCLUDED_PALETTE_COMMAND_IDS, paletteName } from './ui/commands/command-registry';
import { editorHotkey, isBrowserEditShortcut } from './ui/commands/editor-hotkey';
import { DEFAULT_EDITOR_CHROME, editorChromeFromSettings, editorChromePreset, editorChromeSelectOptions, type EditorChrome } from './ui/shell/editor-chrome';
import { DEFAULT_INPUT_MODE, normalizeInputMode, type InputModeSettings } from './ui/editor/input-mode';
import { ViewContextService } from './ui/editor/view-context';
import { revealOutputAnchor } from './output-anchor-reveal';
import { OffscreenDocumentsModal } from './ui/dialogs/offscreen-documents-modal';
import { FormatExceptionModal } from './ui/dialogs/format-exception-modal';
import { offscreenStatusText, offscreenUnsavedDocuments, recoveredAiEditsNotice, type OffscreenDocument } from './ui/shell/offscreen-documents';
import { installPluginStyles } from './plugin-styles';
import { DEFAULT_AGENT_TOOL_SETTINGS, setAgentEditing } from './agent/settings'; import { commandDisplayName, newDocumentPath } from './ui/human-input';

interface HwpHandsSettings extends ManagerOptions, InputModeSettings { autoOpenWithEditor: boolean; editorPreviewEnabled: boolean; editorChrome: EditorChrome;
  /** User opt-in for agent editing tools. */
  agentEditTools: boolean;
  /** User opt-in for the agent save tool, used only with agentEditTools. */
  agentSaveTool: boolean;
  agentPrivacy?: AgentPrivacyData }
const DEFAULT_PLUGIN_SETTINGS: HwpHandsSettings = { ...DEFAULT_OPTIONS, ...DEFAULT_INPUT_MODE, ...DEFAULT_AGENT_TOOL_SETTINGS, autoOpenWithEditor: true, editorPreviewEnabled: true, editorChrome: DEFAULT_EDITOR_CHROME };
function managerOptions(settings: HwpHandsSettings): ManagerOptions {
  return { backup: settings.backup, autoIndex: settings.autoIndex, historyLimit: settings.historyLimit, maxFileBytes: settings.maxFileBytes };
}

/** Short human label for the long-running engine calls; anything else is a generic document operation. */
function engineOperationLabel(method: string): string {
  if (method === 'export' || method === 'exportWithReport') return L({ ko: '저장·내보내기', en: "saving/exporting" });
  if (method === 'page' || method === 'canvasPage' || method === 'pages' || method === 'layout') return L({ ko: '화면 그리기', en: "rendering" });
  if (method === 'search' || method === 'searchDocument') return L({ ko: '찾기', en: "searching" });
  if (method === 'execute') return L({ ko: '편집 적용', en: "applying edits" });
  if (method === 'allText' || method === 'documentSnapshot' || method === 'tree' || method === 'paragraphs') return L({ ko: '문서 읽기', en: "reading the document" });
  return L({ ko: '문서 작업', en: "document operation" });
}
export default class HwpHandsPlugin extends Plugin { addCommand(command: Command): Command { return super.addCommand({ ...command, name: commandDisplayName(command.name) }); }
  api!: HwpHandsApiV1;
  manager!: DocumentManager;
  settings: HwpHandsSettings = { ...DEFAULT_PLUGIN_SETTINGS };
  private inputDraftStore!: InputDraftStore;
  private engineProvider!: WorkerEngineProvider;
  private agentProvider?: AgentCapabilityProvider;
  private agentProviderChanges: Promise<void> = Promise.resolve();
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
      if (!(adapter instanceof FileSystemAdapter)) throw new Error(L({ ko: '입력 복구본에는 데스크톱 파일 시스템이 필요합니다.', en: "Input recovery copies require the desktop file system." }));
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
        if (signal.aborted) throw new Error(L({ ko: '문단 후보 조회가 취소됐습니다.', en: "Paragraph candidate query was cancelled." }));
        return inspectOpenOutput(path, hash, anchors);
      });
    const viewContext = new ViewContextService(this.api);
    this.api.privacy = { isBlocked: path => this.isAiBlocked(path) };
    this.register(() => { delete this.api.privacy; });
    this.api.views = viewContext.views;
    this.api.views.revealOutputAnchor = (input, signal) => this.agentPrivacy.run(
      [input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'path')?.value : undefined], signal,
      combined => revealOutputAnchor(this.api, input,
      path => this.hwpViews().find(view => view.file?.path === path),
      async view => {
        const current = this.hwpViews().find(candidate => candidate === view);
        if (!current) throw new Error(L({ ko: '편집 화면이 닫혔습니다.', en: "The editor view was closed." }));
        await this.revealAndFocus(current.leaf);
      }, combined));
    const bindViews = () => viewContext.bind(this.hwpViews().map(view => ({ element: view.contentEl, read: () => view.readViewContext() })));
    this.registerEvent(this.app.workspace.on('layout-change', bindViews));
    this.app.workspace.onLayoutReady(bindViews);
    this.register(this.api.events.on('*', () => viewContext.changed()));
    this.register(() => { viewContext.dispose(); delete this.api.views; });
    this.installAgentProvider();
    this.register(() => this.editMarks.dispose());
    this.app.workspace.onLayoutReady(() => this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT));
    // A working copy can stay unsaved with no view on it, for example after an agent edited a document nobody opened.
    const offscreenStatus = this.addStatusBarItem();
    offscreenStatus.toggle(false);
    offscreenStatus.addClass('mod-clickable');
    offscreenStatus.setAttribute('aria-label', L({ ko: '화면에 없는 미저장 HWP 문서 보기', en: "Show unsaved HWP documents without views" }));
    offscreenStatus.onclick = () => new OffscreenDocumentsModal(this.app, this).open();
    const updateOffscreenStatus = () => { const label = offscreenStatusText(this.offscreenDocuments()); offscreenStatus.setText(label); offscreenStatus.toggle(!!label); };
    this.register(this.api.events.on('*', updateOffscreenStatus));
    this.registerEvent(this.app.workspace.on('layout-change', updateOffscreenStatus));
    this.app.workspace.onLayoutReady(updateOffscreenStatus);
    this.addCommand({ id: 'offscreen-unsaved-documents', name: L({ ko: '화면에 없는 미저장 HWP 문서 보기', en: "Show unsaved HWP documents without views" }), callback: () => new OffscreenDocumentsModal(this.app, this).open() });
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
      if (!(leaf?.view instanceof HwpView && leaf.view.file === file)) menu.addItem(item => item.setTitle(L({ ko: 'HWP Hands로 열기', en: "Open with HWP Hands" })).setIcon('file-pen-line').onClick(() => {
        void this.openInEditor(file).catch(error => this.report(error));
      }));
      menu.addItem(item => item.setTitle(this.isAiPrivate(file.path) ? L({ ko: 'HWP Hands AI 비공개 해제', en: "Remove HWP Hands AI privacy" }) : L({ ko: 'HWP Hands AI 비공개로 설정', en: "Set HWP Hands AI privacy" })).setIcon('shield').onClick(() => {
        void this.setAiPrivate(file.path, !this.isAiPrivate(file.path)).catch(error => this.report(error));
      }));
    }));
    this.addCommand({ id: 'new-hwpx', name: L({ ko: '새 HWPX 문서 만들기', en: "Create new HWPX document" }), callback: () => this.createNewDocument() });
    for (const hidden of [true, false]) this.addCommand({ id: hidden ? 'hide-document-from-ai' : 'show-document-to-ai',
      name: hidden ? L({ ko: '현재 한글 문서를 AI 비공개로 설정', en: "Set current HWP document as AI-private" }) : L({ ko: '현재 한글 문서의 AI 비공개 해제', en: "Remove AI privacy from current HWP document" }), checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(HwpView), path = view?.file?.path;
        if (!path || this.isAiPrivate(path) === hidden || this.agentPrivacy.needsRepair) return false;
        if (!checking) void this.setAiPrivate(path, hidden).catch(error => this.report(error));
        return true;
      } });
    this.addCommand({ id: 'toggle-editor-menu', name: L({ ko: 'HWP: 메뉴 접기/펴기', en: "HWP: Collapse/expand menus" }), checkCallback: checking => {
      const view = this.app.workspace.getActiveViewOfType(HwpView);
      if (!view) return false;
      if (!checking) view.toggleAllChrome();
      return true;
    } });
    this.addCommand({ id: 'save-document', name: L({ ko: '현재 한글 문서 저장', en: "Save current HWP document" }), hotkeys: [editorHotkey('Mod+S')], checkCallback: checking => {
      const view = this.app.workspace.getActiveViewOfType(HwpView);
      if (!view || !view.canRunEditorCommand('file.save')) return false; if (!checking) view.runSaveCommand(); return true;
    } });
    this.addCommand({ id: 'refresh-index', name: L({ ko: '현재 한글 문서의 Markdown 인덱스 생성', en: "Create Markdown index for current HWP document" }), checkCallback: checking => {
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
      if (!EXCLUDED_PALETTE_COMMAND_IDS.has(command.id)) addActiveEditorCommand(command.id, paletteName(command), shortcuts);
    }
    this.addCommand({ id: 'open-document', name: L({ ko: 'HWP/HWPX 문서 열기', en: "Open HWP/HWPX document" }), callback: () => {
      this.openDocumentPicker();
    } });
    this.addCommand({ id: 'cancel-engine-operation', name: L({ ko: '현재 HWP 엔진 작업 취소', en: "Cancel current HWP engine operation" }), checkCallback: checking => {
      if (!this.engineProvider.canCancelCurrent) return false;
      if (!checking) this.engineProvider.cancelCurrent();
      return true;
    } });
    this.addCommand({ id: 'recover-input-drafts', name: L({ ko: '미적용 입력 복구', en: "Recover unapplied input" }), callback: () => new InputDraftRecoveryModal(this.app, this).open() });
    this.addCommand({ id: 'cleanup-plugin-storage', name: L({ ko: 'HWP Hands 보관 파일 정리', en: "Clean up HWP Hands stored files" }), callback: () => new StorageCleanupModal(this.app, this).open() });
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
  private installAgentProvider(): AgentCapabilityProvider | undefined {
    const previous = this.agentProvider;
    const provider = createAgentProvider(this.api, { version: this.manifest.version, viewPaths: () => this.viewPaths(),
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
    Object.defineProperty(this, AGENT_CAPABILITY_PROVIDER, { value: provider, configurable: true, enumerable: false, writable: false });
    this.agentProvider = provider;
    return previous;
  }
  updateAgentTools(change: () => void): Promise<void> {
    const update = this.agentProviderChanges.then(async () => {
      if (this.closingDown) return;
      change();
      await this.saveData(this.settings);
      if (this.closingDown) return;
      const previous = this.installAgentProvider();
      if (!this.closingDown) this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT);
      try { await previous?.dispose(); }
      catch (error) { console.error('Failed to dispose previous agent provider', error); }
    });
    this.agentProviderChanges = update.catch(() => undefined);
    return update;
  }
  isAiPrivate(path: string): boolean { return this.agentPrivacy.configured(path); }
  aiPrivatePaths(): string[] | null { return this.agentPrivacy.needsRepair ? null : this.agentPrivacy.snapshot().blockedPaths; }
  aiPrivacyNeedsReview(): boolean { return this.agentPrivacy.needsReview; }
  isAiBlocked(path: string): boolean { return this.agentPrivacy.blockedForPublic(path); }
  private async persistAiPrivacy(data: AgentPrivacyData): Promise<void> {
    this.settings.agentPrivacy = data;
    try { await this.saveData(this.settings); }
    catch (error) { this.settings.agentPrivacy = this.agentPrivacy.snapshot(); throw error; }
  }
  async setAiPrivate(path: string, hidden: boolean): Promise<void> {
    await this.agentPrivacy.set(path, hidden, data => this.persistAiPrivacy(data));
    this.app.workspace.trigger(PROVIDERS_CHANGED_EVENT);
    new Notice(hidden ? L({ ko: '이 문서는 HWP Hands의 AI 도구에 제공하지 않습니다. 이 목록을 지키는 Verbex·KorDoc Transform 버전도 이 문서와 색인 노트(.index.md)를 읽지 않습니다. 이미 전달된 내용에는 적용되지 않고, 그 밖의 플러그인이나 도구가 파일을 직접 읽는 것은 막지 못합니다.', en: "This document will not be provided to HWP Hands AI tools. Versions of Verbex and KorDoc Transform that honor this list also skip this document and its index note (.index.md). This does not affect content already shared, and it cannot stop other plugins or tools from reading the file directly." }) : L({ ko: '이 문서의 HWP Hands AI 비공개를 해제했습니다. 새로 조회한 뒤 사용할 수 있습니다.', en: "HWP Hands AI privacy was removed from this document. Read it again before use." }), 10000);
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
  /** revealLeaf() exists from Obsidian 1.7.2 (it also expands a collapsed sidebar); older versions only activate the tab. */
  private async revealAndFocus(leaf: WorkspaceLeaf): Promise<void> {
    const workspace = this.app.workspace as { revealLeaf?: (leaf: WorkspaceLeaf) => Promise<void> };
    if (typeof workspace.revealLeaf === 'function') await workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  createNewDocument(): void {
    const parent = this.app.workspace.getActiveFile()?.parent?.path;
    const prefix = parent && parent !== '/' ? `${parent}/` : '';
    new PathModal(this.app, L({ ko: '새 HWPX 문서 경로', en: "New HWPX document path" }), LT({ ko: () => `${prefix}새 문서.hwpx`, en: () => `${prefix}New document.hwpx` }), async path => { path = newDocumentPath(path);
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
    if (!/^(hwp|hwpx)$/i.test(file.extension)) throw new Error(L({ ko: 'HWP 또는 HWPX 파일만 HWP Hands에서 열 수 있습니다.', en: "Only HWP or HWPX files can be opened in HWP Hands." }));
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: EDITOR_VIEW_TYPE, state: { file: file.path }, active: true });
    const view = leaf.view;
    if (!(view instanceof HwpView)) throw new Error(L({ ko: 'HWP Hands 화면을 열지 못했습니다.', en: "Could not open the HWP Hands view." }));
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
        new Notice(LT({ ko: () => `한글 문서를 저장했습니다: ${path}`, en: () => `Saved HWP document: ${path}` }));
      } else await this.manager.discardUnheld(path, options);
    } catch (error) {
      new Notice(LT({ ko: () => `${choice === 'save' ? '저장하지 못했습니다' : '변경을 버리지 못했습니다'}. 변경은 그대로 남아 있어 문서를 다시 엽니다. ${error instanceof Error ? error.message : String(error)}`, en: () => `${choice === 'save' ? 'Could not save' : 'Could not discard changes'}. Changes remain; reopening the document. ${error instanceof Error ? error.message : String(error)}` }), 12000);
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
    if (!(file instanceof TFile)) throw new Error(LT({ ko: () => `문서를 찾을 수 없습니다: ${path}`, en: () => `Document not found: ${path}` }));
    let view = this.hwpViews().find(item => item.file?.path === path);
    if (view) await this.revealAndFocus(view.leaf);
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
      if (!progress.cancelable) return;
      if (!this.engineNotice && !this.engineNoticeTimer) {
        this.engineNoticeTimer = setTimeout(() => {
          this.engineNoticeTimer = undefined;
          const running = [...this.engineTasks.values()].find(task => task.cancelable);
          if (!running) return;
          const label = engineOperationLabel(running.method);
          const command = L({ ko: '현재 HWP 엔진 작업 취소', en: "Cancel current HWP engine operation" });
          this.engineNotice = new Notice(L({ ko: `HWP Hands가 아직 작업 중입니다(${label}). 명령 '${command}'으로 취소할 수 있습니다.`, en: `HWP Hands is still working (${label}). You can cancel it with the command '${command}'.` }), 0);
        }, 1500);
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
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(LT({ ko: () => `같은 경로에 파일이 있습니다: ${path}`, en: () => `A file exists at the same path: ${path}` }));
    const parts = path.split('/'); parts.pop(); let folder = '';
    for (const part of parts) {
      folder = folder ? `${folder}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(folder);
      if (existing && !(existing instanceof TFolder)) throw new Error(LT({ ko: () => `폴더 경로에 파일이 있습니다: ${folder}`, en: () => `A file exists at the folder path: ${folder}` }));
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
    void Promise.allSettled([...this.hwpViews().map(v => v.flushDraft()), provider?.dispose(), this.agentProviderChanges]).then(() => this.manager?.dispose());
  }
  private hwpViews(): HwpView[] {
    return [VIEW_TYPE, EDITOR_VIEW_TYPE, ...PREVIOUS_VIEW_TYPES].flatMap(type => this.app.workspace.getLeavesOfType(type))
      .map(l => l.view).filter((v): v is HwpView => v instanceof HwpView);
  }
}
class HwpSettings extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HwpHandsPlugin) { super(app, plugin); }
  private hostSkillStatusText(): string {
    const names = agentSkillNames(getLocale()).join(', ');
    switch (hostSkillSupport(this.app)) {
      case 'supported': return names
        ? L({ ko: `AI 호스트가 이 플러그인의 Skill(${names})을 읽을 수 있습니다.`, en: `An AI host can read this plugin's Skills (${names}).` })
        : L({ ko: 'AI 호스트가 이 플러그인의 Skill을 읽을 수 있습니다.', en: "An AI host can read this plugin's Skills." });
      case 'not_found': return names
        ? L({ ko: `켜진 AI 호스트 중 플러그인 Skill을 읽는 것이 없습니다. Verbex를 쓰고 있다면 최신 판으로 업데이트하면 이 플러그인의 Skill(${names})을 쓸 수 있습니다.`, en: `No enabled AI host reads plugin Skills. If you use Verbex, update it to use this plugin's Skills (${names}).` })
        : L({ ko: '켜진 AI 호스트 중 플러그인 Skill을 읽는 것이 없습니다. Verbex를 쓰고 있다면 최신 판으로 업데이트하세요.', en: "No enabled AI host reads plugin Skills. If you use Verbex, update it." });
      default: return L({ ko: 'AI 호스트의 플러그인 Skill 지원 여부를 확인할 수 없습니다.', en: "Could not check whether an AI host supports plugin Skills." });
    }
  }
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('p', { text: L({ ko: '문서는 로컬에서 처리됩니다. 화면의 글꼴과 복잡한 배치는 한컴 한글과 다를 수 있습니다.', en: "Documents are processed locally. Fonts and complex layouts may differ from Hancom Hangul." }) });
    this.containerEl.createEl('p', { text: this.hostSkillStatusText(), cls: 'setting-item-description' });
    new Setting(this.containerEl).setName(L({ ko: 'HWP/HWPX 기본 열기', en: "Open HWP/HWPX by default" })).setDesc(L({ ko: '켜면 파일 탐색기와 일반 링크가 HWP Hands를 기본 보기로 사용합니다. 다른 플러그인과 충돌하거나 기본 보기를 바꾸려면 끄세요. 변경은 플러그인을 다시 불러온 뒤 적용됩니다. 파일 메뉴의 “HWP Hands로 열기”는 항상 사용할 수 있습니다.', en: "When enabled, the file explorer and ordinary links use HWP Hands as the default view. Disable to resolve plugin conflicts or change the default view. Changes apply after reloading the plugin. The file menu's “Open with HWP Hands” remains available." })).addToggle(t => t.setValue(this.plugin.settings.autoOpenWithEditor).onChange(async value => {
      this.plugin.settings.autoOpenWithEditor = value; await this.persist(); new Notice(L({ ko: '파일 기본 열기 설정을 적용하려면 HWP Hands 플러그인을 다시 불러오세요.', en: "Reload HWP Hands to apply the default file opening setting." }));
    }));
    const chromePreset = editorChromePreset(this.plugin.settings.editorChrome);
    new Setting(this.containerEl).setName(L({ ko: '편집 화면 도구 표시', en: "Editor tool visibility" })).setDesc(L({ ko: '메뉴와 도구 상자를 접어 문서 공간을 넓힙니다. 열린 HWP 탭에 바로 적용됩니다.', en: "Collapse menus and toolboxes to increase document space. Applies immediately to open HWP tabs." })).addDropdown(dropdown => {
      for (const option of editorChromeSelectOptions(this.plugin.settings.editorChrome)) {
        dropdown.addOption(option.value, option.label);
        if (option.disabled) {
          const optionEl = dropdown.selectEl.querySelector<HTMLOptionElement>(`option[value="${option.value}"]`);
          if (optionEl) optionEl.disabled = true;
        }
      }
      dropdown.setValue(chromePreset).onChange(async value => {
        if (value === 'custom') return;
        await this.plugin.setEditorChrome(value === 'expanded' ? { menu: true, basicToolbox: true, formatToolbox: true }
          : value === 'basic-collapsed' ? { menu: true, basicToolbox: false, formatToolbox: true }
            : { menu: false, basicToolbox: false, formatToolbox: false });
      });
    });
    new Setting(this.containerEl).setName(L({ ko: '입력 미리보기', en: "Input preview" })).setDesc(L({ ko: '문서에 반영되기 전의 글자와 한글 조합을 쪽 위에 즉시 표시합니다. 끄면 엔진 쪽 이미지가 갱신될 때까지 기다립니다.', en: "Immediately shows characters and Korean IME composition over the page before they reach the document. When disabled, waits for the engine page image to refresh." })).addToggle(toggle => toggle
      .setValue(this.plugin.settings.editPreviewEnabled).onChange(async editPreviewEnabled => {
        await this.plugin.setInputMode({ ...this.plugin.settings, editPreviewEnabled });
      }));
    new Setting(this.containerEl).setName(L({ ko: '저장 전 원본 백업', en: "Back up original before saving" })).setDesc(L({ ko: '플러그인 폴더에 저장 전 파일을 문서별 최신 3개까지 보관합니다. 저장이 확인되면 그보다 오래된 백업은 지웁니다.', en: "Keeps up to three latest pre-save backups per document in the plugin folder. Deletes older backups after saving is verified." })).addToggle(t => t.setValue(this.plugin.settings.backup).onChange(async value => { this.plugin.settings.backup = value; await this.persist(); }));
    new Setting(this.containerEl).setName(L({ ko: '저장·외부 변경 후 검색 인덱스 자동 생성', en: "Automatically create search index after saving/external changes" })).setDesc(L({ ko: '원본 옆 .index.md를 저장, 외부 수정, 이름 변경 뒤 갱신합니다. 직접 편집하거나 사용자 소유로 확인되는 인덱스는 보존합니다.', en: "Updates the adjacent .index.md after saving, external edits, or renaming. Preserves indexes edited directly or identified as user-owned." })).addToggle(t => t.setValue(this.plugin.settings.autoIndex).onChange(async value => { this.plugin.settings.autoIndex = value; await this.persist(); }));
    new Setting(this.containerEl).setName(L({ ko: 'AI 에이전트 도구', en: "AI agent tools" })).setHeading();
    new Setting(this.containerEl).setName(L({ ko: 'AI 에이전트 편집 도구 허용', en: "Allow AI agent editing tools" })).setDesc(L({ ko: '켜면 Verbex 같은 호스트 플러그인에 한글 문서 편집 도구가 노출됩니다. 편집은 작업본에만 적용되고 파일은 바뀌지 않습니다. 즉시 적용됩니다. 호스트에서 HWP Hands를 다시 승인하세요. 변경하면 진행 중인 AI 편집 세션과 저장 준비가 종료되지만, 저장하지 않은 작업본은 유지됩니다.', en: "When enabled, host plugins such as Verbex can use the document editing tools. Edits apply to the working copy only; the file is not changed. Applies immediately. Approve HWP Hands again in the host. Changing this ends AI editing sessions and prepared saves in progress; unsaved working copies stay." })).addToggle(t => t.setValue(this.plugin.settings.agentEditTools).onChange(async value => { await this.plugin.updateAgentTools(() => setAgentEditing(this.plugin.settings, value)); this.display(); }));
    new Setting(this.containerEl).setName(L({ ko: 'AI 에이전트 저장 도구 허용', en: "Allow AI agent save tool" })).setDesc(L({ ko: '켜면 호스트가 작업본을 파일로 저장하는 도구를 쓸 수 있습니다. 저장은 호스트의 승인 절차를 거칩니다. 편집 도구가 켜져 있어야 합니다. 즉시 적용됩니다. 호스트에서 HWP Hands를 다시 승인하세요. 변경하면 진행 중인 AI 편집 세션과 저장 준비가 종료되지만, 저장하지 않은 작업본은 유지됩니다.', en: "When enabled, the host can use the tool that saves the working copy to the file. Saving goes through the host's approval. Requires the editing tools. Applies immediately. Approve HWP Hands again in the host. Changing this ends AI editing sessions and prepared saves in progress; unsaved working copies stay." })).addToggle(t => t.setValue(this.plugin.settings.agentSaveTool).setDisabled(!this.plugin.settings.agentEditTools).onChange(async value => { await this.plugin.updateAgentTools(() => { this.plugin.settings.agentSaveTool = value; }); }));
    const privatePaths = this.plugin.aiPrivatePaths();
    new Setting(this.containerEl).setName(L({ ko: '문서 전체 AI 비공개', en: "Entire-document AI privacy" })).setHeading();
    this.containerEl.createEl('p', { text: privatePaths === null
      ? L({ ko: '비공개 설정을 읽을 수 없어 HWP Hands AI 접근을 모두 차단했습니다. 정상 비공개 설정을 복구한 뒤 플러그인을 다시 불러오세요.', en: "Could not read privacy settings; all HWP Hands AI access was blocked. Restore valid privacy settings and reload the plugin." })
      : L({ ko: '파일 메뉴나 명령 팔레트에서 지정합니다. HWP Hands AI 도구의 조회·검색·편집·저장을 차단합니다. 이 목록을 지키는 Verbex·KorDoc Transform 버전도 원본 파일과 색인 노트(.index.md)를 읽지 않습니다. 이미 전달한 내용에는 적용되지 않고, 그 밖의 플러그인이나 도구가 파일을 직접 읽는 것은 막지 못합니다. 이동 전 경로도 확인 후 해제할 때까지 유지합니다.', en: "Set through the file menu or command palette. Blocks HWP Hands AI reads, searches, edits, and saves. Versions of Verbex and KorDoc Transform that honor this list also skip the original file and its index note (.index.md). Does not affect previously shared content, and it cannot stop other plugins or tools from reading the file directly. Retains previous paths after moves until checked and cleared." }) });
    if (this.plugin.aiPrivacyNeedsReview()) this.containerEl.createEl('p', { text: L({ ko: '비공개 문서가 기록된 경로에 없어 모든 HWP Hands AI 접근을 차단했습니다. 이동한 문서를 먼저 비공개로 지정한 뒤 이전 경로를 해제하세요. 삭제했다면 이전 경로를 확인하고 해제하세요.', en: "A private document is missing from its recorded path; all HWP Hands AI access was blocked. Mark the moved document private before clearing the old path. If deleted, verify and clear the old path." }) });
    for (const path of privatePaths ?? []) new Setting(this.containerEl).setName(path).addButton(button => button.setButtonText(L({ ko: '비공개 해제', en: "Remove privacy" })).onClick(async () => {
      try { await this.plugin.setAiPrivate(path, false); this.display(); }
      catch { new Notice(L({ ko: '비공개 설정을 저장하지 못해 차단을 유지합니다.', en: "Could not save privacy settings; blocking remains active." })); }
    }));
    new Setting(this.containerEl).setName(L({ ko: '문서 최대 크기 (MB)', en: "Maximum document size (MB)" })).addText(t => t.setValue(String(this.plugin.settings.maxFileBytes / 1024 / 1024)).onChange(async value => {
      const size = Number(value); if (Number.isFinite(size) && size >= 1 && size <= 200) { this.plugin.settings.maxFileBytes = size * 1024 * 1024; await this.persist(); }
    }));
    const advanced = this.containerEl.createEl('details');
    advanced.createEl('summary', { text: L({ ko: '고급·진단', en: "Advanced and diagnostics" }) });
    advanced.createEl('p', { text: LT({ ko: () => `진단 정보: HWP Hands ${this.plugin.manifest.version} · RHWP ${this.plugin.api.engineVersion} · API v${this.plugin.api.version}. Obsidian 버전은 설정의 정보 화면에서 확인할 수 있습니다.`, en: () => `Diagnostics: HWP Hands ${this.plugin.manifest.version} · RHWP ${this.plugin.api.engineVersion} · API v${this.plugin.api.version}. Check the Obsidian version in Settings → About.` }) });
    new Setting(advanced).setName(L({ ko: '한글 입력기·화면 낭독기 호환', en: "IME and screen reader compatibility" })).setDesc(L({ ko: '한글 입력 후보 창이 엉뚱한 곳에 뜨거나 화면 낭독기가 문서를 읽지 못할 때만 바꾸세요.', en: "Change this only if the IME candidate window appears in the wrong place or a screen reader cannot read the document." })).addDropdown(dropdown => dropdown
      .addOption('caret', L({ ko: '캐럿 위치 (권장)', en: "Caret position (recommended)" })).addOption('line', L({ ko: '투명 줄 상자', en: "Transparent line box" })).setValue(this.plugin.settings.inputReceiverPlacement).onChange(async value => {
        await this.plugin.setInputMode({ ...this.plugin.settings, inputReceiverPlacement: value === 'line' ? 'line' : 'caret' });
      }));
    advanced.createEl('p', { text: L({ ko: '다른 플러그인: app.plugins.plugins["hwp-hands"].api (version = 1). 배포 폴더의 API.md에서 계약을 확인할 수 있습니다.', en: "Other plugins: app.plugins.plugins[\"hwp-hands\"].api (version = 1). See API.md in the distribution folder for the contract." }) });
  }
  private async persist(): Promise<void> { this.plugin.manager.options = managerOptions(this.plugin.settings); await this.plugin.saveData(this.plugin.settings); }
}

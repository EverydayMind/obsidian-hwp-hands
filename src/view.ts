import { mountCanvasPage, releaseCanvases } from './canvas-page';
import { cellNumberFormatCommands, type CellNumberOperation } from './ui/editor/cell-number-format';
import { randomUUID } from 'node:crypto';
import { FileView, Menu, Modal, Notice, Platform, Scope, TFile, setIcon, type App, type IconName, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { SvgPageImages } from './ui/page/svg-page-images';
import { EditingPreview, previewFlow, previewLines, previewSegment } from './ui/page/editing-preview';
import { previewSpans, sliceSpans, compositionPreview, type ImeCompositionRange } from './ui/editor/preview-spans';
import { HwpHandsError } from './api';
import type { BodyAddress, CaretRect, CharacterProperties, DocumentEvent } from './api';
import { LiveInputCommitScheduler, rebaseTypedInput } from './ui/editor/live-input';
import { writeClipboardSelection } from './ui/editor/clipboard-write';
import { formattingUnavailableReason, normalizeSelectionSegments, treeTextParagraphs, selectionContainerKey, selectionParagraphIndex, selectAllTextRange, selectionPlainText, selectionMutationUnavailableReason } from './ui/editor/selection-segments';
import { isNonstructuralFormatting, restoreOwnFormattingSelection, type SelectionRestoreSnapshot } from './ui/editor/selection-restore';
import type { RangeFormatProperties } from './api';
import { selectedFormatting, selectedCharacterRuns, uniformValue, SelectionFormattingContext } from './ui/editor/selection-formatting';
import type HwpHandsPlugin from './main';
import type { Bookmark, CaretMotion, Command, CopiedSelection, DocumentAddress, DocumentCapabilities, DocumentObject, DocumentSearchMatch, DocumentTree, Field, FormattingModel, HeaderFooterAddress, HeaderFooterStory, HitTestResult, PageLayout, PageRenderOptions, Paragraph, ParagraphProperties, PageSettingsProperties, ParagraphAlignment, ParagraphList, SelectionRange, SelectionRect, State, StoryParagraph, Table, TextPosition, EndnoteShapeProperties } from './api';
import { flushInputDraftOnLeave, InputDraftAutosave, type InputDraftInput } from './input-drafts';
import { assertViewContext, viewFollowsEvent, ViewTaskGate, type ViewContext } from './view-state';
import type { AutosaveInput, AutosaveStatus, AutosaveViewHandle } from './autosave-scheduler';
import { autosavePresentation } from './ui/shell/autosave-status';
import { hitTestPage, layoutParagraphBounds, layoutRangeSelectionRects, layoutSelectionRects, pagePointFromClient, paragraphAtAddress, sameDocumentAddress, type TextParagraph } from './page-hit-test';
import { mountMenuBar, type MenuBarItem } from './ui/shell/menu-bar';
import { HEADER_FOOTER_TEMPLATES, headerFooterCommandId, EDITOR_MENU_DEFINITION, FIND_MENU_COMMANDS, type MenuDefinitionItem } from './ui/shell/menu-definition';
import { addFilePaneMenuItems } from './ui/shell/file-pane-menu';
import type { EditorChrome } from './ui/shell/editor-chrome';
import { afterActivePagePaint, documentInputNeedsPaint, INPUT_FRAME_GUARD_MS, markDocumentInput, PageStack } from './ui/page/page-stack';
import { BookmarkModal, BookmarkPickerModal } from './ui/dialogs/bookmark-modal';
import { ConfirmActionModal } from './ui/dialogs/confirm-modal';
import { NUMBERING_PRESETS, numberingCommand } from './ui/dialogs/numbering-presets';
import { StylePickerModal } from './ui/dialogs/style-picker';
import { PageRulers } from './ui/page/rulers';
import { editMarkRects, editMarksNotice } from './ui/page/edit-marks';
import { DEFAULT_GRID, gridBackground, GRID_MAX_MM, GRID_MIN_MM, normalizeGridSettings, pageGeometry, type GridSettings } from './ui/page/view-aids';
import { fieldEditCommand, fieldEditFields, fieldRemoveCommand, fieldRemoveFields } from './ui/dialogs/field-forms';
import { styleCommand, styleFields } from './ui/dialogs/style-forms';
import { FormModal } from './ui/dialogs/form-modal';
import { equationScriptError, equationScriptField, objectCommand, objectFields } from './ui/dialogs/object-forms';
import { blockFormulaPlan, cellReference, MAX_FORMULA_LENGTH, type BlockFunction } from './table-formula';
import { initialFormValues, type FormField, type FormValues } from './ui/dialogs/form-values';
import { columnCommand, columnFields, newNumberCommand, newNumberFields, pageBorderCommand, pageBorderFields, pageHideCommand, pageHideFields, sectionCommands, sectionFields } from './ui/dialogs/page-section-forms';
import { CharacterFormatModal, CharacterTableModal, ClickHereFieldModal, ConfirmAnchoredDelete, ConfirmDiscard, DocumentChangesModal, RecoveredChangesModal, EndnoteShapeModal, HeaderFooterTemplateModal, InputDraftRecoveryModal, ParagraphFormatModal, PageSetupModal, StyleSelectionModal, PathModal, SaveAsModal, PrintPagesModal, SplitCellModal, TableCellFormatModal, TableGridModal, type CharacterFormatUpdate } from './ui/dialogs';
import { CommandRegistry, EDITOR_COMMAND_CATALOG, editorCommandDefinition } from './ui/commands/command-registry';
import { canonicalShortcut, eventKeyMatchesPhysicalKey, physicalShortcut } from './ui/commands/shortcut-event';
import { isBrowserEditShortcut } from './ui/commands/editor-hotkey';
import { advanceSequenceShortcut, type SequenceState } from './ui/commands/sequence-shortcut';
import { cellBlockShortcut } from './ui/commands/cell-block-shortcut';
import { createCommandMenuButton, mountCommandToolbar, type CommandMenuButton, type MountedCommandToolbar } from './ui/commands/command-toolbar';
import { contextMenuCommandGroups, type EditorContextMenuKind } from './ui/commands/context-menu';
import { completeCellBlockRange, adjacentTableCellCaretTarget, cellsInCellBlock, extendCellBlockRange, type CellBlockRange } from './table-cell-selection';
import { tableCellFormatCommands, type TableCellFormatValues } from './table-cell-format';
import { caretMotionForKey, clipboardHtmlForText, codePointOffsetFromUtf16, editorTextFromModel, inputReplacementRange, normalizeEditorText, paragraphEditCommands, positionAfterEditorText, shouldEnterStoryOnClick, siblingAddress, utf16OffsetFromCodePoint } from './text-edit';
import { browsePage, fieldBrowseEntries, optimisticHorizontalCaretOffset, outlineParagraphs, type BrowseEntry } from './editor-navigation';
import { normalizeHwpHeading, type HwpLinkTarget } from './hwp-links';
import { hwpUnitsToMillimeters, millimetersToDoubledHwpUnits, millimetersToHwpUnits, pixelsToMillimeters, pixelsToPoints, pointsToHwpUnits, stepPercentLineSpacing } from './paragraph-format';
import { objectPropertiesForDrag, objectRectAfterDrag, objectUnitsToCssPixels, type EditableObjectProperties, type ObjectRect, type ObjectResizeHandle } from './object-manipulation';
import { pagePixelsToHwpUnits, tableCellResizeChanges, type TableResizeAxis, equalizeTableCellSizes } from './table-resize';
import { headerFooterPageApplies } from './header-footer-navigation';

let physicalShortcutCommands: Map<string, string> | undefined;
/** Catalog shortcut (canonical form) -> editor command id, owned by the focused HWP view. */
function physicalShortcutIndex(isMac: boolean): Map<string, string> {
  physicalShortcutCommands ??= new Map(EDITOR_COMMAND_CATALOG.flatMap(command =>
    [...('shortcut' in command && command.shortcut ? [command.shortcut] : []), ...('aliases' in command ? command.aliases : [])]
      .map(shortcut => [canonicalShortcut(shortcut, isMac), command.id] as [string, string])));
  return physicalShortcutCommands;
}

interface DraftApplySnapshot { context: ViewContext; selected: TextParagraph | Field; value: string; revision: number; selectionStart: number; selectionEnd: number }
interface PageTextSelection { address: DocumentAddress; start: number; end: number; range?: SelectionRange; focus?: TextPosition }
interface PageDragStart { paragraph: TextParagraph; offset: number; page: number; clientX: number; clientY: number; revision: number; sessionId: string; pagePoint?: { x: number; y: number } }
interface PageCellDragStart { tablePath: string; row: number; col: number; page: number; clientX: number; clientY: number }
interface PageDragPreview { range?: SelectionRange; block?: CellBlockRange }
interface ObjectDragStart { object: DocumentObject; page: number; pointerId: number; handle: ObjectResizeHandle; rect: ObjectRect; properties: EditableObjectProperties; clientX: number; clientY: number; revision: number }
interface TableResizeStart { context: ViewContext; table: Table; row: number; col: number; page: number; pointerId: number; axis: TableResizeAxis; originX: number; originY: number; clientX: number; clientY: number; revision: number }
interface ShapeDrawStart { context: ViewContext; target: Extract<DocumentAddress, { kind: 'body' }>; offset: number; page: number; pointerId: number; originX: number; originY: number; clientX: number; clientY: number; revision: number; shape: 'rectangle' | 'textBox'; text: string }
interface InlineCellSelection { paragraphPath: string; tablePath: string; cellIndex: number }
interface CopiedFormat { character: CharacterFormatUpdate; paragraph: Extract<Command, { type: 'formatParagraph' }>['properties'] }
type NavigationKind = 'paragraph' | 'table' | 'object' | 'field';
type TableStructureAction = 'insert-row-above' | 'insert-row-below' | 'delete-row' | 'insert-column-left' | 'insert-column-right' | 'delete-column';
const EDITOR_ITEM_PAGE_SIZE = 100;
/** RHWP's 글자 효과 dropdown, in its order. */
const CHARACTER_EFFECTS = [
  ['format.emboss', 'emboss', '양각'], ['format.engrave', 'engrave', '음각'], ['format.outline', 'outline', '외곽선'],
  ['format.superscript', 'superscript', '위 첨자'], ['format.subscript', 'subscript', '아래 첨자'],
] as const;
type CharacterEffect = typeof CHARACTER_EFFECTS[number][1];
interface NavigationTarget { kind: NavigationKind; label: string; filterText: string; address: DocumentAddress; nodePath: string; controlIndex?: number; fieldId?: number; start?: number; end?: number; searchResult?: true; /** the table cell the paragraph sits in, so the inline editor can be placed over it */ cell?: { tablePath: string; cellIndex: number } }
interface TargetBrowser { input: HTMLInputElement; list: HTMLElement; status: HTMLElement; previous: HTMLButtonElement; next: HTMLButtonElement; entries: BrowseEntry<NavigationTarget>[]; page: number; onSelect: (target: NavigationTarget) => Promise<void> | void }
interface LocalFontMetadata { family: string; fullName?: string; postscriptName?: string; style?: string }
type LocalFontAccessNavigator = Navigator & { queryLocalFonts?: () => Promise<LocalFontMetadata[]> };
function isParagraph(item: TextParagraph | Field): item is TextParagraph {
  const paragraph = item as TextParagraph;
  return typeof paragraph.nodePath === 'string' && typeof paragraph.length === 'number' && typeof paragraph.text === 'string' && !!paragraph.address;
}
function isTableCell(item: TextParagraph): boolean {
  return item.address.kind === 'body' && item.address.containerKinds?.at(-1) === 'tableCell';
}
/** The editor item list that holds a paragraph at this address. */
function editingModeFor(address: DocumentAddress): 'paragraphs' | 'cells' | 'stories' {
  return address.kind !== 'body' || address.containerKinds?.includes('textBox') ? 'stories'
    : address.cellPath?.length || address.containerKinds?.includes('tableCell') ? 'cells' : 'paragraphs';
}
function isTextboxParagraph(item: TextParagraph): boolean {
  return item.address.kind === 'body' && item.address.containerKinds?.includes('textBox') === true;
}
function objectKindLabel(object: DocumentObject): string {
  return object.kind === 'picture' ? '그림' : object.kind === 'equation' ? '수식' : object.kind === 'shape' ? '도형' : '개체';
}

export const VIEW_TYPE = 'hwp-hands-view';
/** An active page image arriving this soon after typed input waits for two frames (or this long) before it replaces the old one. */
export class HwpView extends FileView {
  private path = '';
  private releaseViewLease?: () => Promise<void>;
  private autosaveInput?: AutosaveViewHandle;
  private autosaveInputState?: string;
  private autosaveSessionId?: string;
  private unsubscribeAutosaveStatus?: () => void;
  private autosaveStatus?: AutosaveStatus;
  private autosaveStatusEl?: HTMLElement;
  private generation = 0;
  // Set synchronously when the view starts closing or unloading its file, before the awaits that let events in (viewFollowsEvent).
  private detaching = false;
  // Settles when the image of the latest active-page render has shown; neighbour pages mount after it (afterActivePagePaint).
  private activePageShown: Promise<void> = Promise.resolve();
  // When the receiver last took typed or composed text; an active page image arriving right after it waits for the key's frames.
  private lastInputAt = -Infinity;
  private refreshSequence = 0;
  private unsubscribe?: () => void;
  private unsubscribeEditMarks?: () => void;
  private editMarksEl?: HTMLElement;
  private editMarksTextEl?: HTMLElement;
  private editMarkCursor = 0;
  private state?: State;
  private capabilities?: DocumentCapabilities;
  private capabilityCheckPending = false;
  private capabilityCheckError?: string;
  private layoutWarningEl!: HTMLElement;
  private baselineText?: string;
  private saving = false;
  private operationError?: string;
  private buttonActionDepth = 0;
  private page = 0;
  private pageEl!: HTMLElement;
  private pageScroll!: HTMLElement;
  private pageStack?: PageStack;
  private pageResizeObserver?: ResizeObserver;
  private readonly pageLayouts = new Map<number, { layout: PageLayout; revision: number }>();
  private pageImages?: SvgPageImages;
  private statusEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private statusActivityEl!: HTMLElement;
  private statusPageButton?: HTMLButtonElement;
  private statusBannersEl!: HTMLElement;
  private pageLabel!: HTMLElement;
  private selector!: HTMLSelectElement;
  private textarea!: HTMLTextAreaElement;
  private textareaHome!: HTMLElement;
  private inlineEditorLineCount = 1;
  private draftToolsLocked = false;
  private infoEl!: HTMLElement;
  private items: Array<TextParagraph | Field> = [];
  private itemPage = 0;
  private itemPageStatus!: HTMLElement;
  private itemPagePrevious!: HTMLButtonElement;
  private itemPageNext!: HTMLButtonElement;
  private itemLabels = new Map<string, string>();
  private selected?: TextParagraph | Field;
  private storyReturnPosition?: TextPosition;
  private selectedObject?: DocumentObject;
  private documentTree?: DocumentTree;
  private formattingModel?: FormattingModel;
  private toolFormatting?: SelectionFormattingContext;
  private pageLayout?: PageLayout;
  private pageLayoutRevision = -1;
  private pageSelection?: PageTextSelection;
  private readonly editingPreview = new EditingPreview();
  private directComposition?: ImeCompositionRange;
  private deferredCompositionCommand?: { id: string; context: ViewContext };
  private directCaret?: { key: string; rect: CaretRect };
  private directCaretKey?: string;
  private directCaretSequence = 0;
  private caretMoveSequence = 0;
  private pageDragStart?: PageDragStart;
  private pageCellDragStart?: PageCellDragStart;
  private pageDragPreview?: PageDragPreview;
  private objectDragStart?: ObjectDragStart;
  private tableResizeStart?: TableResizeStart;
  private shapeDrawStart?: ShapeDrawStart;
  private shapeDrawMode = false;
  private cellBlockSelection?: CellBlockRange;
  private suppressPageClick = false;
  private inlineEditorActive = false;
  private inlineCellSelection?: InlineCellSelection;
  private draftRevision = 0;
  private draft = false;
  private inputGroupId?: string;
  private inputGroupTarget?: string;
  private pendingCaretProperties?: Extract<Command, { type: 'insertText' }>['characterProperties'];
  private copiedFormat?: CopiedFormat;
  private draftAutosave!: InputDraftAutosave;
  /** Direct mode: commits typed text at once and folds keys typed during a commit into the next one (EDITOR_UX_PLAN §3.6). */
  private readonly directInputCommit = new LiveInputCommitScheduler(() => this.commitDirectInput(), () => 0);
  /** A direct-mode commit finished during an IME composition that a receiver rewrite must not disturb; it completes afterwards. */
  private pendingLiveRebase?: { committed: string; context: ViewContext };
  /** A key or click is waiting behind a direct-mode commit; further ones are refused rather than piling up. */
  private queuedInputAction = false;
  private flushTask?: Promise<void>;
  private draftSaveError?: unknown;
  private readonly tasks = new ViewTaskGate(() => this.updateAutosaveInput());
  private composing = false;
  private overwriteMode = false;
  private formMode = false;
  private modeBeforeForm?: 'paragraphs' | 'cells' | 'stories' | 'fields';
  private selectedBeforeFormKey?: string;
  private inputLocks = 0;
  private mode: 'paragraphs' | 'cells' | 'stories' | 'fields' = 'paragraphs';
  private modeSelector!: HTMLSelectElement;
  private applyCopiedStyleButton?: HTMLButtonElement;
  private toolReasonEl!: HTMLElement;
  private styleSelect!: HTMLSelectElement;
  private listSelect!: HTMLSelectElement;
  private lineSpacingDecreaseButton?: HTMLButtonElement;
  private lineSpacingIncreaseButton?: HTMLButtonElement;
  private fontLanguageSelect!: HTMLSelectElement;
  private alignmentButtons = new Map<ParagraphAlignment, HTMLButtonElement>();
  private alignmentSelect!: HTMLSelectElement;
  private fontSizeInput!: HTMLInputElement;
  private fontFamilyInput!: HTMLInputElement;
  private fontFamilySuggestions!: HTMLDataListElement;
  private systemFontFamilies: string[] = [];
  private fontColorInput!: HTMLInputElement;
  private highlightColorInput!: HTMLInputElement;
  private paragraphIndentInput!: HTMLInputElement;
  private paragraphSpacingBeforeInput!: HTMLInputElement;
  private paragraphSpacingAfterInput!: HTMLInputElement;
  private paragraphLineSpacingInput!: HTMLInputElement;
  private toolbarLineSpacingSelect!: HTMLSelectElement;
  private paragraphLineSpacingTypeSelect!: HTMLSelectElement;
  private paragraphLineSpacingUnit!: HTMLSpanElement;
  private tableRowsInput!: HTMLInputElement;
  private tableColsInput!: HTMLInputElement;
  private mergeEndRowInput!: HTMLInputElement;
  private mergeEndColInput!: HTMLInputElement;
  private equationScriptInput!: HTMLTextAreaElement;
  private equationApplyButton!: HTMLButtonElement;
  private equationPreviewEl!: HTMLElement;
  private equationPreviewTimer?: ReturnType<typeof setTimeout>;
  private equationPreviewSequence = 0;
  private shapeTextInput!: HTMLInputElement;
  private shapeDrawButton?: HTMLButtonElement;
  private pictureFileInput?: HTMLInputElement;
  private shapeTypeSelect!: HTMLSelectElement;
  private shapeWidthInput!: HTMLInputElement;
  private shapeHeightInput!: HTMLInputElement;
  private pageSectionSelect!: HTMLSelectElement;
  private sectionGotoSelect!: HTMLSelectElement;
  private pageNumberInputs = new Map<keyof PageSettingsProperties, HTMLInputElement>();
  private pageLandscapeInput!: HTMLInputElement;
  private objectWidthInput!: HTMLInputElement;
  private objectHeightInput!: HTMLInputElement;
  private objectOffsetXInput!: HTMLInputElement;
  private objectOffsetYInput!: HTMLInputElement;
  private objectTreatAsCharInput!: HTMLInputElement;
  private objectTextWrapSelect!: HTMLSelectElement;
  private objectDescriptionInput!: HTMLInputElement;
  private objectEditDetails!: HTMLDetailsElement;
  private formatStateEl!: HTMLElement;
  private characterButtons = new Map<string, HTMLButtonElement>();
  private listLevelDownButton!: HTMLButtonElement;
  private listLevelUpButton!: HTMLButtonElement;
  private numberingToggleButton!: HTMLButtonElement;
  private bulletToggleButton!: HTMLButtonElement;
  private pageInput!: HTMLInputElement;
  private zoomInput!: HTMLInputElement;
  private zoomLabel!: HTMLElement;
  private zoomPreset!: HTMLSelectElement;
  private zoomMode: 'fit-width' | 'fit-page' | 'custom' = 'fit-width';
  private zoomPercent = 100;
  private pendingViewState?: { file?: unknown; page?: unknown; scrollTop?: unknown; zoomMode?: unknown; zoomPercent?: unknown; ruler?: unknown; grid?: unknown };
  private navigationStatus!: HTMLElement;
  private findBarEl?: HTMLElement;
  private searchQueryInput!: HTMLInputElement;
  private searchReplacementInput!: HTMLInputElement;
  private searchCaseSensitiveInput!: HTMLInputElement;
  private searchIncludeStoriesInput!: HTMLInputElement;
  private resolutionPanel!: HTMLElement;
  private resolutionMessage!: HTMLElement;
  private compareChangesButton!: HTMLButtonElement;
  private saveCopyButton!: HTMLButtonElement;
  private reloadConflictButton!: HTMLButtonElement;
  private recoverInputButton!: HTMLButtonElement;
  private outlineBrowser?: TargetBrowser;
  private tableBrowser?: TargetBrowser;
  private objectBrowser?: TargetBrowser;
  private fieldBrowser?: TargetBrowser;
  private searchBrowser?: TargetBrowser;
  private searchRevision = -1;
  private searchCurrentIndex = -1;
  private commandRegistry = new CommandRegistry();
  private pendingSequenceShortcut?: SequenceState;
  private commandToolbar?: MountedCommandToolbar;
  private storyToolbar?: MountedCommandToolbar;
  private formatToolbarResizeObserver?: ResizeObserver;
  private characterEffectsMenu?: CommandMenuButton;
  private historyButtons: HTMLButtonElement[] = [];
  private selectionCopySequence = 0;
  private selectionCopyKey?: string;
  private selectionCopy?: CopiedSelection;
  private selectionRectsSequence = 0;
  private selectionRectsKey?: string;
  private selectionRectsCache?: SelectionRect[];
  private selectionAnchor?: TextPosition;
  private disposeMenuBar?: () => void;
  private renderOptions: PageRenderOptions = {};
  private displayOptionInputs = new Map<keyof PageRenderOptions, HTMLInputElement>();
  private textareaFocusTracked = false;
  private placingTextarea = false;
  private refocusTextarea = false;
  private rulerVisible = true;
  private rulers?: PageRulers;
  private rulerFrameRequest?: number;
  private previewEl?: HTMLElement;
  private gridSettings: GridSettings = { ...DEFAULT_GRID };
  private preferredCaretX?: number;
  private readonly editorScope: Scope;
  private readonly legacyScope: boolean;
  constructor(leaf: WorkspaceLeaf, private readonly plugin: HwpHandsPlugin) {
    super(leaf);
    this.editorScope = new Scope(this.app.scope);
    this.legacyScope = !('scope' in this);
    if (!this.legacyScope) (this as { scope: Scope }).scope = this.editorScope;
  }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.file?.name ?? 'HWP Hands'; }
  getIcon(): string { return 'file-pen-line'; }
  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    if (this.file) addFilePaneMenuItems(this.app, menu, this.file, source, this.leaf, {
      unsaved: () => this.draft || !!this.state?.dirty, report: error => this.plugin.report(error),
    });
  }
  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      hwpHands: {
        page: this.page,
        scrollTop: this.pageStack?.scrollTop ?? 0,
        zoomMode: this.zoomMode,
        zoomPercent: this.zoomPercent,
        ruler: this.rulerVisible,
        grid: this.gridSettings,
      },
    };
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const record = state && typeof state === 'object' ? state as Record<string, unknown> : {};
    const candidate = record.hwpHands ?? record.hwpEditor;
    const saved = candidate && typeof candidate === 'object'
      ? candidate as NonNullable<HwpView['pendingViewState']> : undefined;
    this.pendingViewState = saved ? { ...saved, file: record.file } : undefined;
    await super.setState(state, result);
    if (this.path) await this.restorePendingViewState();
  }
  setEditorPreviewEnabled(enabled: boolean): void {
    this.contentEl?.toggleClass('hwp-hands-preview-enabled', enabled);
    if (this.statusEl) this.updateStatus();
  }
  updateInputMode(): void {
    if (this.composing) return;
    this.editingPreview.clear();
    this.directCaret = undefined; this.directCaretKey = undefined; this.directCaretSequence++;
    this.updatePageSelectionOverlay(true);
  }
  setEditorChrome(chrome: EditorChrome): void {
    this.contentEl.removeClass('hwp-menu-temporary');
    this.contentEl.toggleClass('hwp-chrome-menu-hidden', !chrome.menu);
    this.contentEl.toggleClass('hwp-chrome-basic-hidden', !chrome.basicToolbox);
    this.contentEl.toggleClass('hwp-chrome-format-hidden', !chrome.formatToolbox);
    this.contentEl.toggleClass('hwp-chrome-all-hidden', !chrome.menu && !chrome.basicToolbox && !chrome.formatToolbox);
  }
  toggleAllChrome(): void {
    const allHidden = Object.values(this.plugin.settings.editorChrome).every(value => !value);
    void this.plugin.setEditorChrome({ menu: allHidden, basicToolbox: allHidden, formatToolbox: allHidden });
  }
  async onOpen(): Promise<void> {
    this.draftAutosave = this.createDraftAutosave();
    this.build();
    if (this.legacyScope) {
      let active = false;
      const deactivate = () => { if (active) { this.app.keymap.popScope(this.editorScope); active = false; } };
      this.registerDomEvent(this.contentEl, 'focusin', () => { if (!active) { this.app.keymap.pushScope(this.editorScope); active = true; } });
      this.registerDomEvent(this.contentEl, 'focusout', event => {
        const NodeClass = this.contentEl.ownerDocument.defaultView?.Node;
        if (!NodeClass || !(event.relatedTarget instanceof NodeClass) || !this.contentEl.contains(event.relatedTarget)) deactivate();
      });
      this.register(deactivate);
    }
    this.addAction('save', 'HWP 저장', () => this.runEditorCommand('file.save'));
    this.addAction('panel-top', 'HWP 메뉴 접기/펴기', () => this.toggleAllChrome());
    this.unsubscribe = this.plugin.api.events.on('*', event => this.handleDocumentEvent(event));
    this.unsubscribeEditMarks = this.plugin.editMarks.onChange(path => {
      if (path !== this.path || !this.statusEl) return;
      this.updatePageSelectionOverlay(); this.updateStatus();
    });
    this.registerEvent(this.app.workspace.on('css-change', () => {
      if (!this.path) return;
      this.plugin.manager.invalidateRenderingCaches(this.path);
      void this.tasks.runAfterCurrent(() => this.renderPage()).catch(error => this.plugin.report(error));
    }));
    this.editorScope.register(['Mod'], 's', () => { void this.runEditorCommand('file.save'); return false; });
    const isAuxiliaryInputFocused = (): boolean => {
      const active = this.contentEl?.ownerDocument?.activeElement;
      return !!active && active !== this.textarea && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active as HTMLElement).isContentEditable);
    };
    const shouldDelegateToInput = (): boolean => this.textarea.matches(':focus') || isAuxiliaryInputFocused();
    this.editorScope.register(['Mod'], 'z', () => { if (!shouldDelegateToInput()) { void this.runEditorCommand('edit.undo'); return false; } return true; });
    this.editorScope.register(['Mod', 'Shift'], 'z', () => { if (!shouldDelegateToInput()) { void this.runEditorCommand('edit.redo'); return false; } return true; });
    this.editorScope.register(['Mod'], 'c', () => { if (!shouldDelegateToInput()) { void this.runEditorCommand('edit.copy'); return false; } return true; });
    this.editorScope.register(['Mod'], 'v', () => { if (!shouldDelegateToInput()) { void this.runEditorCommand('edit.paste'); return false; } return true; });
    this.editorScope.register(['Mod'], 'a', () => { if (!shouldDelegateToInput()) { void this.runEditorCommand('edit.select-all'); return false; } return true; });
    this.editorScope.register(['Mod'], 'x', () => { if (!shouldDelegateToInput()) { void this.runEditorCommand('edit.cut'); return false; } return true; });
    for (const [key, id] of [['b', 'format.bold'], ['i', 'format.italic'], ['u', 'format.underline']] as const) {
      this.editorScope.register(['Mod'], key, () => { void this.runEditorCommand(id); return false; });
    }
    this.editorScope.register(['Mod'], 'f', () => { void this.runEditorCommand('tool.find'); return false; });
    this.editorScope.register(['Mod'], 'h', () => { void this.runEditorCommand('tool.replace'); return false; });
    this.editorScope.register(['Mod'], 'l', () => { void this.runEditorCommand('tool.next-search-result'); return false; });
    this.editorScope.register(['Alt'], 'g', () => { void this.runEditorCommand('view.go-to-page'); return false; });
    this.editorScope.register(['Alt'], 'n', () => { void this.runEditorCommand('file.new-document'); return false; });
    this.editorScope.register(['Alt'], 'F10', () => { void this.runEditorCommand('insert.character-table'); return false; });
    this.editorScope.register(['Mod', 'Shift'], 's', () => { void this.runEditorCommand(this.cellBlockSelection ? 'table.block-sum' : 'file.save-as'); return false; });
    this.editorScope.register(['Mod'], 'Enter', () => { void this.runEditorCommand(this.selectedTableCell() ? 'table.insert-row-below' : 'insert.page-break'); return false; });
    this.editorScope.register(['Mod', 'Shift'], 'Enter', () => { void this.runEditorCommand('insert.column-break'); return false; });
    this.editorScope.register(['Ctrl'], 'F1', () => { void this.runEditorCommand('view.toggle-toolbars'); return false; });
    this.editorScope.register(['Ctrl', 'Shift'], 'F1', () => { this.toggleAllChrome(); return false; });
    this.editorScope.register([], 'F10', () => {
      if (this.plugin.settings.editorChrome.menu) return true;
      this.contentEl.addClass('hwp-menu-temporary');
      this.contentEl.querySelector<HTMLButtonElement>('.hwp-menu-trigger')?.focus();
      return false;
    });
    // Own catalog shortcuts in both Latin and Korean layouts before the parent application's conflicting hotkeys.
    // Explicit handlers above keep their native-input and context-sensitive behaviour.
    // Only a handler with both modifiers and key null lets an unhandled event continue to the app-level hotkeys (Scope.handleKey stops
    // at any other matching handler), so this one wildcard runs in the view scope and returns undefined unless it ran a command.
    this.editorScope.register(null, null, event => {
      if (this.handleSequenceShortcut(event)) return false;
      const cellCommand = !event.defaultPrevented && !event.isComposing && !this.composing && !this.draft
        ? cellBlockShortcut(event, !!this.cellBlockSelection) : undefined;
      if (cellCommand) { void this.runEditorCommand(cellCommand); return false; }
      return this.handleCatalogShortcut(event) ? false : undefined;
    });
  }
  private handleDocumentEvent(event: DocumentEvent): void {
    if (event.oldPath === this.path && event.type === 'renamed') this.path = event.state.path;
    if (!viewFollowsEvent(event, this.path, this.detaching)) return;
    // A completed save does not change the model. Re-reading its capabilities can disable the focused receiver and end native IME.
    if (event.type === 'saved' && this.applySavedState(event.state)) return;
    const pageCountChanged = event.state.pageCount !== this.state?.pageCount;
    const renderCurrentPage = event.type === 'changed'
      ? !event.changedPages || event.changedPages.includes(this.page) || pageCountChanged
      : event.state.revision !== this.state?.revision;
    const changedPages = event.type === 'changed' && !pageCountChanged ? event.changedPages : undefined;
    const { sessionId, revision } = event.state;
    // API edits can arrive while a local input commit is finishing. Refresh after that task, then recheck the applied revision.
    void this.tasks.runAfterCurrent(() => {
      if (event.type === 'saved' && this.applySavedState(event.state)) return;
      if (event.type === 'changed' && this.state?.sessionId === sessionId && this.state.revision === revision) return;
      return this.refresh(renderCurrentPage, changedPages);
    }).catch(error => this.plugin.report(error));
  }
  private applySavedState(state: State): boolean {
    if (!this.state || this.state.sessionId !== state.sessionId || this.state.revision < state.revision) return false;
    // A delayed save for an older revision must not clear the newer model's dirty state or disturb its local draft.
    if (this.state.revision > state.revision) return true;
    this.state = structuredClone(state);
    this.updateStatus(); this.updateToolState();
    return true;
  }
  private handleSequenceShortcut(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.isComposing || this.composing) { this.pendingSequenceShortcut = undefined; return false; }
    const result = advanceSequenceShortcut(this.pendingSequenceShortcut, event, performance.now());
    this.pendingSequenceShortcut = result.state;
    if (result.command) void this.runEditorCommand(result.command);
    return result.handled;
  }
  /** Claims a catalog shortcut even when unavailable, so it cannot run an unrelated host command. */
  private handleCatalogShortcut(event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return false;
    const shortcut = physicalShortcut(event, Platform.isMacOS);
    const id = shortcut ? physicalShortcutIndex(Platform.isMacOS).get(shortcut) : undefined;
    if (!id) return false;
    // Latin-layout browser editing stays with the explicit native-input handlers above.
    if (eventKeyMatchesPhysicalKey(event) && isBrowserEditShortcut(shortcut!)) return false;
    // Do not interrupt IME composition or let the same shortcut escape to a host command.
    // Existing pending bold/italic/underline handling is composition-aware.
    if (event.isComposing || this.composing) {
      if (this.composing && ['format.bold', 'format.italic', 'format.underline'].includes(id)) void this.runEditorCommand(id);
      return true;
    }
    void this.runEditorCommand(id);
    return true;
  }
  async onLoadFile(file: TFile): Promise<void> {
    await this.tasks.wait();
    const previousPath = this.path && this.path !== file.path ? this.path : '';
    if (previousPath) { await this.flushDraft(); await this.flushAutosaveOnLeave(); await this.draftAutosave.detach(); }
    await this.releaseViewReference();
    if (previousPath) this.plugin.offerSaveOnClose(previousPath);
    const generation = ++this.generation;
    this.detaching = false;
    this.editingPreview.clear(); this.directComposition = undefined; this.directCaret = undefined; this.directCaretKey = undefined; this.directCaretSequence++;
    // A newly loaded file is a first load for refresh(): a previous file's state must not make it fold the initial selection.
    this.state = undefined; this.path = file.path; this.page = 0; this.pageLayouts.clear(); this.pageLayout = undefined; this.pageLayoutRevision = -1; this.draft = false; this.pendingLiveRebase = undefined; this.selected = undefined; this.storyReturnPosition = undefined; this.selectedObject = undefined; this.documentTree = undefined; this.pageSelection = undefined; this.selectionAnchor = undefined; this.pageDragStart = undefined; this.pageCellDragStart = undefined; this.pageDragPreview = undefined; this.objectDragStart = undefined; this.tableResizeStart = undefined; this.shapeDrawStart = undefined; this.shapeDrawMode = false; this.cellBlockSelection = undefined; this.inlineEditorActive = false; this.inlineCellSelection = undefined; this.draftSaveError = undefined; this.composing = false; this.pendingCaretProperties = undefined; this.preferredCaretX = undefined; this.capabilities = undefined; this.capabilityCheckPending = false; this.capabilityCheckError = undefined; this.baselineText = undefined; this.operationError = undefined; this.saving = false;
    this.copiedFormat = undefined;
    if (this.shapeDrawButton) { this.shapeDrawButton.textContent = '도형 그리기'; this.shapeDrawButton.setAttribute('aria-pressed', 'false'); }
    await this.pageStack?.setActivePage(0, false, false);
    this.searchRevision = -1; this.searchCurrentIndex = -1;
    this.setTargetBrowser(this.searchBrowser, []); this.setTargetBrowser(this.outlineBrowser, []); this.setTargetBrowser(this.tableBrowser, []); this.setTargetBrowser(this.objectBrowser, []); this.setTargetBrowser(this.fieldBrowser, []);
    this.draftAutosave = this.createDraftAutosave();
    this.statusTextEl.setText('문서를 불러오는 중…'); this.statusActivityEl.setText('');
    try {
      const lease = await this.plugin.manager.retainView(file.path);
      if (generation !== this.generation || this.path !== file.path) { await lease.release(); return; }
      this.releaseViewLease = () => lease.release();
      this.attachAutosaveInput(lease.state.sessionId);
      await this.refresh();
      await this.restorePendingViewState();
      if (generation === this.generation && this.plugin.manager.takeRecoveredUnasked(lease.state.sessionId)) this.askToKeepRecovered(file.path, generation);
    }
    catch (error) { if (generation === this.generation) { this.statusTextEl.setText(`열기 실패: ${String(error)}`); this.statusActivityEl.setText(''); this.pageEl.empty(); } this.plugin.report(error); }
  }
  async navigateToLinkedTarget(target: HwpLinkTarget): Promise<void> {
    if (this.draft || this.composing) throw new Error('입력을 적용하거나 조합을 마친 뒤 링크 위치로 이동하세요.');
    if (target.page !== undefined) {
      if (!this.state || target.page < 1 || target.page > this.state.pageCount) throw new Error(`링크 쪽 번호는 1부터 ${this.state?.pageCount ?? 0} 사이여야 합니다.`);
      this.page = target.page - 1;
      await this.renderPage(true);
      this.navigationStatus.setText(`${target.page}쪽으로 이동했습니다.`);
      return;
    }
    const expected = normalizeHwpHeading(target.heading ?? '');
    const tree = this.documentTree;
    const candidates: Array<{ text: string; address: DocumentAddress; nodePath: string }> = [];
    if (tree) {
      candidates.push(...tree.paragraphs);
      for (const table of tree.tables) for (const cell of table.cells) candidates.push(...cell.paragraphs);
      for (const story of tree.stories) candidates.push(...story.paragraphs);
    }
    const paragraph = candidates.find(item => normalizeHwpHeading(item.text) === expected);
    if (!paragraph || !expected) throw new Error(`문단 제목을 찾지 못했습니다: ${target.heading ?? ''}`);
    await this.jumpToNavigationTarget({ kind: 'paragraph', label: target.heading!, filterText: target.heading!, address: paragraph.address, nodePath: paragraph.nodePath });
  }
  /** Moves to a body or cell paragraph by its address, or to a page (from 1). Used when a person asks to see where an edit landed. */
  async revealPlace(target: { address?: BodyAddress; page?: number }, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new HwpHandsError('CANCELLED', '위치 이동이 취소되었습니다.');
    if (!target.address) { if (target.page !== undefined) await this.navigateToLinkedTarget({ page: target.page }); return; }
    if ((target.address.sessionId !== undefined && target.address.sessionId !== this.state?.sessionId) ||
        (target.address.revision !== undefined && target.address.revision !== this.state?.revision))
      throw new Error('문서가 변경되어 위치 이동을 취소했습니다.');
    const key = (address: DocumentAddress): string => address.kind === 'body' ? JSON.stringify([address.section, address.paragraph, address.cellPath ?? []]) : '';
    const tree = this.documentTree, wanted = key({ ...target.address, kind: 'body' });
    const paragraph = tree && [...tree.paragraphs, ...tree.tables.flatMap(table => table.cells.flatMap(cell => cell.paragraphs))].find(item => key(item.address) === wanted);
    if (!paragraph) throw new Error('그 위치를 현재 문서에서 찾지 못했습니다.');
    const label = Array.from(paragraph.text).slice(0, 30).join('') || '빈 문단';
    await this.jumpToNavigationTarget({ kind: 'paragraph', label, filterText: label, address: paragraph.address, nodePath: paragraph.nodePath }, signal);
  }
  async onUnloadFile(): Promise<void> {
    this.detaching = true;
    this.directInputCommit.cancel();
    await this.tasks.wait(); ++this.generation;
    try { await this.flushDraft(); await this.flushAutosaveOnLeave(); }
    finally { const path = this.path; await this.draftAutosave.detach(); await this.releaseViewReference(); this.path = ''; this.composing = false; this.plugin.offerSaveOnClose(path); }
  }
  async onClose(): Promise<void> {
    this.detaching = true;
    this.directInputCommit.cancel();
    await this.tasks.wait(); ++this.generation;
    const path = this.path;
    try { await this.flushDraft(); await this.flushAutosaveOnLeave(); } finally { this.editingPreview.clear(); this.directCaretSequence++; this.disposeMenuBar?.(); this.disposeMenuBar = undefined; this.commandToolbar?.dispose(); this.commandToolbar = undefined; this.storyToolbar?.dispose(); this.storyToolbar = undefined; this.formatToolbarResizeObserver?.disconnect(); this.formatToolbarResizeObserver = undefined; this.characterEffectsMenu?.dispose(); this.characterEffectsMenu = undefined; this.pageResizeObserver?.disconnect(); this.pageStack?.dispose(); this.pageStack = undefined; this.clearEquationPreview(); this.pageImages?.dispose(); this.pageImages = undefined; await this.draftAutosave.detach(); await this.releaseViewReference(); this.path = ''; this.composing = false; this.unsubscribe?.(); this.unsubscribeEditMarks?.(); this.unsubscribeEditMarks = undefined; this.plugin.offerSaveOnClose(path); }
  }
  /** The earlier run ended without the close prompt; its replayed changes stay unless the person drops them now. */
  private askToKeepRecovered(path: string, generation: number): void {
    new RecoveredChangesModal(this.app, path.split('/').at(-1) ?? path, choice => {
      if (choice === 'keep' || generation !== this.generation || path !== this.path) return;
      // After the copy, the save-as task may still be settling; queue behind it instead of being refused as busy.
      const discard = () => this.tasks.runAfterCurrent(() => this.reloadFromDisk(true));
      // A copy keeps both versions so the person can open them side by side; this view then shows the file on disk.
      // Cancelling the save dialog keeps the recovered changes here, so nothing is lost.
      if (choice === 'save-as') { try { this.saveAs(undefined, discard); } catch (error) { this.plugin.report(error); } return; }
      void discard().catch(error => this.plugin.report(error));
    }).open();
  }
  private async releaseViewReference(): Promise<void> {
    this.unsubscribeAutosaveStatus?.(); this.unsubscribeAutosaveStatus = undefined; this.autosaveStatus = undefined;
    if (this.autosaveStatusEl) this.autosaveStatusEl.hidden = true;
    this.autosaveInput?.dispose(); this.autosaveInput = undefined; this.autosaveInputState = undefined; this.autosaveSessionId = undefined;
    const release = this.releaseViewLease; this.releaseViewLease = undefined;
    if (release) await release();
  }
  private readAutosaveInput(): AutosaveInput {
    return { composing: this.composing, pending: this.draft || !!this.pendingLiveRebase || this.queuedInputAction,
      busy: this.tasks.busy || this.inputLocks > 0 || !!this.flushTask || this.saving };
  }
  readViewContext(): ReturnType<import('./ui/editor/view-context').ViewContextProbe['read']> {
    if (this.detaching || !this.path || !this.state || this.state.path !== this.path) return undefined;
    const input = this.readAutosaveInput(), range = this.selectionRange();
    return structuredClone({
      context: { path: this.path, sessionId: this.state.sessionId, revision: this.state.revision, page: this.page,
        ...(range ? { caret: this.pageSelection?.focus ?? range.end } : {}),
        humanInput: { active: this.contentEl.contains(this.contentEl.ownerDocument.activeElement),
          composing: input.composing, draftPending: !!(input.pending || input.busy) } },
      ...(range && !this.rangeIsCollapsed(range) ? { range } : {}),
    });
  }
  private attachAutosaveInput(sessionId: string): void {
    this.unsubscribeAutosaveStatus?.(); this.unsubscribeAutosaveStatus = undefined; this.autosaveStatus = undefined;
    this.autosaveInput?.dispose();
    this.autosaveSessionId = sessionId; this.autosaveInputState = undefined;
    this.autosaveInput = this.plugin.manager.observeAutosaveInput(sessionId, () => this.readAutosaveInput());
    const generation = this.generation;
    this.unsubscribeAutosaveStatus = this.plugin.manager.observeAutosaveStatus(sessionId, status => {
      if (this.detaching || generation !== this.generation || this.autosaveSessionId !== sessionId) return;
      this.autosaveStatus = structuredClone(status);
      // A status notification must never refresh the document, notify input or enter the file queue.
      this.renderAutosaveStatus();
    });
    this.renderAutosaveStatus();
    this.updateAutosaveInput();
  }
  private renderAutosaveStatus(): void {
    const element = this.autosaveStatusEl;
    if (!element) return;
    const presentation = autosavePresentation(this.autosaveStatus, this.state?.revision);
    element.hidden = !presentation;
    element.setText(presentation?.text ?? '');
    element.title = presentation?.detail ?? '';
    element.setAttribute('aria-label', presentation ? `${presentation.text}. ${presentation.detail}` : '');
    element.dataset.phase = this.autosaveStatus?.phase ?? '';
    element.dataset.severity = presentation?.severity ?? 'normal';
  }
  private updateAutosaveInput(force = false): void {
    if (!this.autosaveInput) return;
    const input = this.readAutosaveInput();
    const state = `${Number(input.composing)}:${Number(input.pending)}:${Number(input.busy)}:${this.lastInputAt}`;
    // Rendering/status refreshes must not keep pushing the idle deadline back when input did not change.
    if (force || state !== this.autosaveInputState) { this.autosaveInputState = state; this.autosaveInput.changed(); }
  }
  private async flushAutosaveOnLeave(): Promise<void> {
    const sessionId = this.autosaveSessionId;
    if (!sessionId) return;
    const path = this.path, generation = this.generation;
    await this.tasks.wait(); this.updateAutosaveInput(true);
    if (sessionId !== this.autosaveSessionId || path !== this.path || generation !== this.generation) return;
    try {
      const status = await this.plugin.manager.flushAutosave(sessionId);
      if (sessionId !== this.autosaveSessionId || path !== this.path || generation !== this.generation) return;
      if (this.state && status?.phase === 'saved' && status.revision === this.state.revision) this.state.dirty = false;
    } catch (error) { this.plugin.report(error); }
  }
  async flushDraft(): Promise<void> {
    this.directInputCommit.cancel();
    if (this.flushTask) return this.flushTask;
    const task = this.tasks.runAfterCurrent(() => this.flushDraftOnce()); this.flushTask = task;
    this.updateAutosaveInput();
    try { await task; } finally { if (this.flushTask === task) this.flushTask = undefined; this.updateAutosaveInput(); }
  }
  private async flushDraftOnce(): Promise<void> {
    if (!this.draft || !this.path) return;
    const unlock = this.lockInput();
    try {
      if (this.composing) {
        await this.draftAutosave.flush(this.captureInputDraft());
        new Notice('한글 조합 중인 입력을 복구 목록에 보관했습니다. 조합을 마친 뒤 미적용 입력 복구에서 확인하세요.', 10000);
        return;
      }
      const snapshot = this.captureDraftApplySnapshot();
      const result = await flushInputDraftOnLeave(this.draftAutosave, this.captureInputDraft(snapshot.selected, snapshot.value, snapshot.context.path, snapshot.revision), async () => { await this.applyDraftSnapshot(snapshot, true); });
      if (result.status === 'retained') {
        const { id, error } = result;
        new Notice(`적용하지 못한 입력을 복구 목록에 보관했습니다 (${id}). 명령 팔레트에서 “미적용 입력 복구”를 여세요.`, 10000);
        this.plugin.report(error);
      }
    }
    catch (error) { this.plugin.report(error); throw error; }
    finally { unlock(); }
  }
  private createDraftAutosave(): InputDraftAutosave {
    return new InputDraftAutosave((draft, existingId) => this.plugin.backupInputDraft(draft, existingId), 250, error => {
      this.draftSaveError = error;
      if (this.statusEl) this.updateStatus();
      this.plugin.report(error);
    });
  }
  private captureContext(): ViewContext {
    if (!this.path) throw new Error('열린 HWP/HWPX 문서가 없습니다.');
    return { path: this.path, generation: this.generation };
  }
  private assertContext(context: ViewContext): void { assertViewContext(context, this.path, this.generation); }
  private lockInput(): () => void {
    // Disabling a focused textarea drops focus to <body>, so typing right after an idle commit would be lost.
    const hadFocus = !!this.textarea && this.textarea.ownerDocument.activeElement === this.textarea;
    this.inputLocks++;
    this.updateAutosaveInput();
    try { this.syncInputDisabled(); this.updateToolState(); }
    catch (error) {
      this.inputLocks--; this.syncInputDisabled(); this.updateAutosaveInput();
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return; active = false; this.inputLocks--; this.syncInputDisabled(); this.updateToolState(); this.updateAutosaveInput();
      if (!hadFocus || this.inputLocks || !this.textarea?.isConnected || this.textarea.disabled) return;
      const owner = this.textarea.ownerDocument, current = owner.activeElement;
      if (!current || current === owner.body) this.textarea.focus({ preventScroll: true });
    };
  }
  private syncInputDisabled(): void {
    if (!this.textarea) return;
    const lockedFormField = this.formMode && !!this.selected && !isParagraph(this.selected) && this.selected.editableInForm === false;
    const disabled = this.inputLocks > 0 || !this.selected || this.capabilitiesReadOnly() || lockedFormField;
    if (disabled && !this.textarea.disabled && this.textarea.ownerDocument.activeElement === this.textarea) this.refocusTextarea = true;
    this.placingTextarea = true;
    try { this.textarea.disabled = disabled; } finally { this.placingTextarea = false; }
    if (!disabled) this.refocusIfWanted();
  }
  private captureDraftApplySnapshot(): DraftApplySnapshot {
    if (!this.composing) this.settlePendingLiveRebase();
    if (!this.selected) throw new Error('편집할 문단 또는 필드를 선택하세요.');
    return {
      context: this.captureContext(), selected: structuredClone(this.selected), value: this.textarea.value, revision: this.draftRevision,
      selectionStart: this.textarea.selectionStart, selectionEnd: this.textarea.selectionEnd,
    };
  }
  private captureInputDraft(selected = this.selected, value = this.textarea.value, path = this.path, revision = this.draftRevision): InputDraftInput {
    const target = selected
      ? isParagraph(selected)
        ? { kind: 'paragraph', nodePath: selected.nodePath, address: selected.address, text: String(selected.text) }
        : { kind: 'field', fieldId: selected.fieldId, name: selected.name, value: selected.value }
      : undefined;
    return { path, ...(target ? { target } : {}), value, revision };
  }
  private capabilitiesReadOnly(): boolean {
    if (!this.state) return false;
    if (this.capabilityCheckPending || this.capabilityCheckError || this.capabilities?.sessionId !== this.state.sessionId) return true;
    return this.capabilities.readOnly;
  }
  private async discardAutosavedDraft(): Promise<void> {
    const unlock = this.lockInput();
    try {
      await this.draftAutosave.discard(id => this.plugin.discardInputDraft(id));
      this.draftSaveError = undefined;
    } finally { unlock(); }
  }
  private button(parent: HTMLElement, label: string, action: () => Promise<unknown> | void): HTMLButtonElement {
    const button = parent.createEl('button', { text: label });
    button.onclick = () => { void this.guard(async () => {
      this.buttonActionDepth++;
      let result: Promise<unknown> | void;
      try { result = action(); } finally { this.buttonActionDepth--; }
      await result;
    }); };
    return button;
  }
  private createTargetBrowser(parent: HTMLElement, label: string, placeholder: string, onSelect: (target: NavigationTarget) => Promise<void> | void): TargetBrowser {
    const browser = parent.createDiv({ cls: 'hwp-target-browser' });
    const input = browser.createEl('input', { type: 'search', attr: { placeholder, 'aria-label': label } });
    const status = browser.createDiv({ cls: 'hwp-browser-status', attr: { role: 'status', 'aria-live': 'polite' } });
    const list = browser.createDiv({ cls: 'hwp-browser-list' });
    const actions = browser.createDiv({ cls: 'hwp-edit-actions' });
    const state: TargetBrowser = { input, list, status, entries: [], page: 0, onSelect, previous: undefined as unknown as HTMLButtonElement, next: undefined as unknown as HTMLButtonElement };
    state.previous = this.button(actions, '이전 항목', () => { state.page--; this.renderTargetBrowser(state); });
    state.next = this.button(actions, '다음 항목', () => { state.page++; this.renderTargetBrowser(state); });
    input.oninput = () => { state.page = 0; this.renderTargetBrowser(state); };
    this.renderTargetBrowser(state);
    return state;
  }
  private setTargetBrowser(browser: TargetBrowser | undefined, targets: NavigationTarget[]): void {
    if (!browser) return;
    browser.entries = targets.map(value => ({ value, label: value.label, filterText: value.filterText }));
    browser.page = 0;
    this.renderTargetBrowser(browser);
  }
  private renderTargetBrowser(browser: TargetBrowser): void {
    const page = browsePage(browser.entries, browser.input.value, browser.page);
    browser.page = page.page; browser.list.empty();
    browser.status.setText(page.total ? `${page.total}개 항목 · ${page.page + 1}/${page.pageCount}쪽`
      : browser.entries.length ? '일치하는 항목이 없습니다.' : '항목이 없습니다.');
    browser.previous.disabled = page.page === 0;
    browser.next.disabled = page.page + 1 >= page.pageCount;
    for (const entry of page.items) {
      const button = this.button(browser.list, entry.label, () => browser.onSelect(entry.value));
      button.addClass('hwp-browser-entry');
      if (browser === this.searchBrowser && this.searchBrowser.entries[this.searchCurrentIndex]?.value === entry.value) button.setAttribute('aria-current', 'true');
    }
  }
  private updateDocumentBrowsers(tree: DocumentTree, formatting: FormattingModel): void {
    const outlineTargets = outlineParagraphs(tree.paragraphs, formatting).map(paragraph => {
      const styleName = formatting.paragraphs.find(item => item.nodePath === paragraph.nodePath)?.style?.name ?? '개요';
      const text = paragraph.text.trim();
      return { kind: 'paragraph' as const, label: `${styleName} · ${text.slice(0, 100)}`, filterText: `${styleName} ${text}`, address: paragraph.address, nodePath: paragraph.nodePath };
    });
    this.setTargetBrowser(this.outlineBrowser, outlineTargets);
    const tables = tree.tables.filter(table => !table.address.cellPath?.length).map(table => {
      const text = table.cells.flatMap(cell => cell.paragraphs).map(paragraph => paragraph.text.trim()).filter(Boolean).join(' · ');
      const label = `표 ${table.rows}×${table.cols} · ${text.slice(0, 90) || '내용 없음'}`;
      return { kind: 'table' as const, label, filterText: `${label} ${text} ${table.nodePath}`, address: table.address, nodePath: table.nodePath, controlIndex: table.control };
    });
    this.setTargetBrowser(this.tableBrowser, tables);
    const objects = tree.objects.filter(object => !object.address.cellPath?.length).map(object => {
      const label = `${objectKindLabel(object)} · ${object.address.section + 1}구역 ${object.address.paragraph + 1}문단`;
      return { kind: 'object' as const, label, filterText: `${label} ${object.nodePath} ${object.kind}`, address: object.address, nodePath: object.nodePath, controlIndex: object.controlIndex };
    });
    this.setTargetBrowser(this.objectBrowser, objects);
    const fields = fieldBrowseEntries(tree.fields).map(entry => ({
      kind: 'field' as const, label: entry.label, filterText: entry.filterText, address: entry.value.address!,
      nodePath: entry.value.nodePath ?? `field[${entry.value.fieldId}]`, fieldId: entry.value.fieldId,
    }));
    this.setTargetBrowser(this.fieldBrowser, fields);
  }
  private paragraphForPath(tree: DocumentTree, nodePath: string): TextParagraph | undefined {
    return [
      ...tree.paragraphs,
      ...tree.tables.flatMap(table => table.cells.flatMap(cell => cell.paragraphs)),
      ...tree.stories.flatMap(story => [...story.paragraphs]),
    ].find(paragraph => paragraph.nodePath === nodePath);
  }
  private paragraphForAddress(tree: DocumentTree, address: DocumentAddress): TextParagraph | undefined {
    return [
      ...tree.paragraphs,
      ...tree.tables.flatMap(table => table.cells.flatMap(cell => cell.paragraphs)),
      ...tree.stories.flatMap(story => [...story.paragraphs]),
    ].find(paragraph => sameDocumentAddress(paragraph.address, address));
  }
  private async moveCaretWithEngine(motion: CaretMotion, extendSelection = false): Promise<void> {
    if (this.draft || this.composing || !this.selected || !isParagraph(this.selected) || !this.state || !this.documentTree) return;
    const address = this.selected.address, cellDepth = address.kind === 'body' ? address.cellPath?.length ?? 0 : 0;
    if ((motion === 'up' || motion === 'down') && (address.kind !== 'body' || address.containerKinds?.includes('textBox'))) return;
    if ((motion === 'lineStart' || motion === 'lineEnd') && (address.kind !== 'body' || cellDepth > 1 || address.containerKinds?.includes('textBox'))) return;
    if ((motion === 'documentStart' || motion === 'documentEnd') && (address.kind !== 'body' || cellDepth > 0)) return;
    const verticalMotion = motion === 'up' || motion === 'down' || motion === 'pageUp' || motion === 'pageDown';
    const context = this.captureContext(), revision = this.state.revision, moveSequence = ++this.caretMoveSequence;
    const position = this.pageSelection?.focus ?? positionAfterEditorText(address, this.textarea.value, this.textarea.selectionEnd);
    const activeRange = this.selectionRange();
    const anchor = extendSelection
      ? this.rangeIsCollapsed(activeRange) ? position : this.selectionAnchor ?? activeRange?.start ?? position
      : undefined;
    const previousSelection = this.pageSelection, previousAnchor = this.selectionAnchor;
    const previousTextareaStart = this.textarea.selectionStart, previousTextareaEnd = this.textarea.selectionEnd;
    let optimisticallyMoved = false;
    const nextOffset = motion === 'left' || motion === 'right'
      ? optimisticHorizontalCaretOffset(this.textarea.value, position.offset, motion) : undefined;
    const sameAddressAnchor = !anchor || sameDocumentAddress(anchor.address, position.address);
    const nextOffsetOnPage = nextOffset !== undefined && this.pageLayout && this.pageLayoutRevision === revision
      && this.pageLayout.textRuns.some(run => {
        const runAddress = run.documentAddress ?? run.address;
        const base = run.offset ?? run.charStart ?? 0, length = Array.from(run.text).length;
        return !!runAddress && sameDocumentAddress(runAddress, address) && nextOffset >= base && nextOffset < base + length;
      });
    const optimisticStart = nextOffset !== undefined && anchor ? Math.min(anchor.offset, nextOffset) : nextOffset;
    const optimisticEnd = nextOffset !== undefined && anchor ? Math.max(anchor.offset, nextOffset) : nextOffset;
    const optimisticRects = nextOffset !== undefined && optimisticStart !== undefined && optimisticEnd !== undefined
      && nextOffset <= this.selected.length && sameAddressAnchor && this.pageLayout && this.pageLayoutRevision === revision
      ? layoutSelectionRects(this.pageLayout, address, optimisticStart, optimisticEnd) : [];
    if (nextOffset !== undefined && nextOffset <= this.selected.length && nextOffsetOnPage && sameAddressAnchor
      && this.rangeIsCollapsed(activeRange) && (optimisticRects.length > 0 || anchor?.offset !== nextOffset)) {
      const optimisticPosition: TextPosition = { address, offset: nextOffset };
      const utf16 = utf16OffsetFromCodePoint(this.textarea.value, nextOffset);
      this.textarea.setSelectionRange(utf16, utf16);
      if (anchor) {
        const range: SelectionRange = anchor.offset <= nextOffset
          ? { start: anchor, end: optimisticPosition } : { start: optimisticPosition, end: anchor };
        this.pageSelection = { address, start: range.start.offset, end: range.end.offset, range, focus: optimisticPosition };
        this.selectionAnchor = anchor;
      } else {
        this.pageSelection = { address, start: nextOffset, end: nextOffset, focus: optimisticPosition };
        this.selectionAnchor = optimisticPosition;
      }
      this.updatePageSelectionOverlay(); this.updateToolState(); this.updateStatus();
      optimisticallyMoved = true;
    }
    const restoreOptimisticCaret = (): void => {
      if (!optimisticallyMoved || moveSequence !== this.caretMoveSequence || this.path !== context.path
        || this.generation !== context.generation || this.state?.revision !== revision) return;
      this.textarea.setSelectionRange(previousTextareaStart, previousTextareaEnd);
      this.pageSelection = previousSelection; this.selectionAnchor = previousAnchor;
      this.updatePageSelectionOverlay(); this.updateToolState(); this.updateStatus();
    };
    let result: Awaited<ReturnType<typeof this.plugin.api.query.moveCaret>>;
    let current: State;
    try {
      result = await this.plugin.api.query.moveCaret(context.path, position, motion, {
        sessionId: this.state.sessionId, expectedRevision: revision, pageHint: this.page,
        ...(verticalMotion && this.preferredCaretX !== undefined ? { preferredX: this.preferredCaretX } : {}),
      });
      this.assertContext(context);
      if (moveSequence !== this.caretMoveSequence) return;
      current = await this.plugin.api.documents.state(context.path); this.assertContext(context);
      if (moveSequence !== this.caretMoveSequence) return;
    } catch (error) {
      restoreOptimisticCaret();
      throw error;
    }
    if (current.revision !== revision) throw new Error('문서가 이동 중 변경되어 캐럿을 옮기지 않았습니다.');
    const tree = this.documentTree, paragraph = tree && this.paragraphForAddress(tree, result.position.address);
    if (!paragraph) throw new Error('이동한 문단을 현재 문서 구조에서 찾지 못했습니다. 다시 조회하세요.');
    const targetAddress = paragraph.address;
    this.mode = targetAddress.kind !== 'body' || targetAddress.containerKinds?.includes('textBox') ? 'stories'
      : targetAddress.cellPath?.length || targetAddress.containerKinds?.includes('tableCell') ? 'cells' : 'paragraphs';
    this.modeSelector.value = this.mode; this.items = this.itemsForMode(tree);
    const index = this.items.findIndex(item => isParagraph(item) && item.nodePath === paragraph.nodePath);
    if (index < 0) throw new Error('이동한 문단이 현재 편집 목록에 없습니다.');
    const previousPage = this.page;
    this.page = Math.min(result.rect.pageIndex, Math.max(0, current.pageCount - 1));
    this.state = current;
    if (this.page !== previousPage || this.pageLayoutRevision !== revision) {
      await this.renderPage(true); this.assertContext(context);
      if (moveSequence !== this.caretMoveSequence) return;
    }
    this.selectItem(index, true);
    const offset = Math.min(paragraph.length, result.position.offset);
    const utf16 = utf16OffsetFromCodePoint(this.textarea.value, offset);
    this.textarea.setSelectionRange(utf16, utf16);
    this.preferredCaretX = verticalMotion ? result.preferredX : undefined;
    const targetPosition: TextPosition = { address: this.selected && isParagraph(this.selected) ? this.selected.address : targetAddress, offset };
    const range = anchor
      ? sameDocumentAddress(anchor.address, targetPosition.address)
        ? { start: anchor, end: targetPosition }
        : this.documentRange({ start: anchor, end: targetPosition })
      : undefined;
    if (range && anchor) this.setPageRangeSelection(range, targetPosition, anchor);
    else {
      this.selectionAnchor = targetPosition;
      this.pageSelection = { address: targetPosition.address, start: offset, end: offset, focus: targetPosition };
      this.updatePageSelectionOverlay(); this.updateStatus();
    }
    this.textarea.focus({ preventScroll: true });
  }
  private layoutContainsTarget(layout: PageLayout, target: NavigationTarget): boolean {
    if (target.kind === 'paragraph') return layout.textRuns.some(run => {
      const address = run.documentAddress ?? run.address;
      return !!address && sameDocumentAddress(address, target.address);
    });
    if (target.kind === 'table') return layout.controls.some(control => control.type === 'table'
      && control.section === target.address.section && control.paragraph === target.address.paragraph && control.controlIndex === target.controlIndex);
    if (target.kind === 'field') return layout.textRuns.some(run => {
      const address = run.documentAddress ?? run.address;
      return !!address && sameDocumentAddress(address, target.address);
    });
    const objectKind = this.documentTree?.objects.find(object => object.nodePath === target.nodePath)?.kind;
    const expectedType = objectKind === 'picture' ? 'image' : objectKind === 'equation' ? 'equation' : objectKind === 'shape' ? 'shape' : undefined;
    return !!expectedType && layout.controls.some(control => control.type === expectedType
      && control.section === target.address.section && control.paragraph === target.address.paragraph && control.controlIndex === target.controlIndex);
  }
  private async jumpToNavigationTarget(target: NavigationTarget, signal?: AbortSignal): Promise<void> {
    const check = () => {
      if (signal?.aborted) throw new HwpHandsError('CANCELLED', '위치 이동이 취소되었습니다.');
      if (signal) {
        const input = this.readAutosaveInput();
        if (input.composing || input.pending || input.busy) throw new HwpHandsError('REVISION_CONFLICT', '입력이 진행 중이어서 위치 이동을 중단했습니다.');
      }
    };
    check();
    if (this.draft || this.composing) throw new Error('입력을 적용하거나 조합을 마친 뒤 이동하세요.');
    // Tab between cells and "next result" are keyboard moves inside the page: the caret must stay in the inline editor on the page.
    const keepInline = this.inlineEditorActive;
    const context = this.captureContext(), revision = this.state?.revision, pageCount = this.state?.pageCount, tree = this.documentTree;
    if (revision === undefined || pageCount === undefined || !tree) throw new Error('문서 구조가 아직 준비되지 않았습니다.');
    if (target.searchResult && this.searchRevision >= 0 && this.searchRevision !== revision) {
      throw new Error('검색 결과가 오래되어 이동하지 않았습니다. 다시 검색하세요.');
    }
    const before = await this.plugin.api.documents.state(context.path); check(); this.assertContext(context);
    if (before.revision !== revision) throw new Error('문서가 변경되어 이동을 취소했습니다. 다시 시도하세요.');
    this.navigationStatus.setText(`“${target.label}” 위치를 찾는 중…`);
    const startPage = this.page;
    let targetPage = -1;
    for (let inspected = 0; inspected < pageCount; inspected++) {
      const page = (startPage + inspected) % pageCount;
      if (inspected > 0 && inspected % 20 === 0) this.navigationStatus.setText(`“${target.label}” 위치를 찾는 중… ${inspected}/${pageCount}쪽 확인`);
      check(); this.assertContext(context);
      const layout = await this.plugin.api.query.layout(context.path, page);
      check(); this.assertContext(context);
      if (this.layoutContainsTarget(layout, target)) { targetPage = page; break; }
    }
    const after = await this.plugin.api.documents.state(context.path); check(); this.assertContext(context);
    if (after.revision !== revision) throw new Error('이동 중 문서가 변경되어 결과를 취소했습니다. 다시 시도하세요.');
    if (targetPage < 0) {
      this.navigationStatus.setText(`${target.label}의 쪽 위치를 찾지 못했습니다.`);
      throw new Error('이 항목의 페이지 위치를 layout에서 찾지 못했습니다.');
    }
    this.page = targetPage;
    await this.pageStack?.setActivePage(targetPage, true, false);
    check();
    if (target.kind === 'paragraph') {
      const paragraph = this.paragraphForPath(tree, target.nodePath);
      if (!paragraph) throw new Error('검색 또는 개요 대상 문단이 현재 문서에 없습니다.');
      const address = paragraph.address;
      this.mode = address.kind !== 'body' || address.containerKinds?.includes('textBox') ? 'stories'
        : address.cellPath?.length || address.containerKinds?.includes('tableCell') ? 'cells' : 'paragraphs';
      this.modeSelector.value = this.mode;
    } else if (target.kind === 'field') {
      this.mode = 'fields'; this.modeSelector.value = this.mode;
    } else if (target.kind === 'table') {
      this.mode = 'cells'; this.modeSelector.value = this.mode;
    } else {
      this.selectedObject = tree.objects.find(object => object.nodePath === target.nodePath);
    }
    await this.refresh(); check(); this.assertContext(context);
    if (this.state?.revision !== revision) throw new Error('문서가 변경되어 이동 결과를 적용하지 않았습니다.');
    if (target.kind === 'paragraph') {
      const index = this.items.findIndex(item => isParagraph(item) && item.nodePath === target.nodePath);
      if (index < 0) throw new Error('대상 문단이 편집 목록에 없습니다.');
      // selectItem forgets the cell unless it is the same paragraph, so hand it over first: the inline editor needs the cell's box.
      if (keepInline && target.cell) this.inlineCellSelection = { paragraphPath: target.nodePath, tablePath: target.cell.tablePath, cellIndex: target.cell.cellIndex };
      this.selectItem(index, keepInline);
      if (target.start !== undefined && target.end !== undefined && this.selected && isParagraph(this.selected)) {
        const start = Math.min(target.start, this.selected.length), end = Math.min(Math.max(target.start, target.end), this.selected.length);
        this.textarea.setSelectionRange(utf16OffsetFromCodePoint(this.textarea.value, start), utf16OffsetFromCodePoint(this.textarea.value, end));
        this.pageSelection = { address: this.selected.address, start, end };
        this.updatePageSelectionOverlay(); this.updateToolState();
      }
      this.textarea.focus({ preventScroll: true });
    } else if (target.kind === 'table') {
      const table = this.documentTree?.tables.find(item => item.nodePath === target.nodePath);
      const first = table?.cells.flatMap(cell => cell.paragraphs)[0];
      const index = first ? this.items.findIndex(item => isParagraph(item) && item.nodePath === first.nodePath) : -1;
      if (index >= 0) { this.selectItem(index, keepInline); this.textarea.focus({ preventScroll: true }); }
      else { this.clearSelection(`${target.label} · 내용이 있는 셀이 없습니다.`); this.infoEl.focus({ preventScroll: true }); }
    } else if (target.kind === 'field') {
      const index = this.items.findIndex(item => !isParagraph(item) && item.fieldId === target.fieldId);
      if (index < 0) throw new Error('대상 필드가 편집 목록에서 사라졌습니다. 다시 조회하세요.');
      this.selectItem(index, false);
      const field = this.selected && !isParagraph(this.selected) ? this.selected : undefined;
      if (!field) throw new Error('선택한 필드 상태를 읽을 수 없습니다. 다시 시도하세요.');
      this.showFieldBoundaryCaret(field, typeof field.startCharIdx === 'number' ? field.startCharIdx : 0);
      this.textarea.focus({ preventScroll: true });
    } else {
      this.selectedObject = this.documentTree?.objects.find(object => object.nodePath === target.nodePath);
      this.clearSelection(target.label);
      this.infoEl.focus({ preventScroll: true });
    }
    this.navigationStatus.setText(`${target.label} · ${targetPage + 1}쪽으로 이동했습니다.`);
  }
  private async showAdjacentSearchResult(delta: number): Promise<void> {
    const entries = this.searchBrowser?.entries ?? [];
    if (!entries.length) return;
    this.searchCurrentIndex = this.searchCurrentIndex < 0
      ? delta > 0 ? 0 : entries.length - 1
      : (this.searchCurrentIndex + delta + entries.length) % entries.length;
    const target = entries[this.searchCurrentIndex].value;
    const resultPage = Math.floor(this.searchCurrentIndex / 20);
    if (this.searchBrowser) { this.searchBrowser.page = resultPage; this.renderTargetBrowser(this.searchBrowser); }
    await this.jumpToNavigationTarget(target);
  }
  private currentSearchTarget(): NavigationTarget | undefined {
    return this.searchBrowser?.entries[this.searchCurrentIndex]?.value;
  }
  private async runSearch(): Promise<void> {
    if (this.composing || this.draft) throw new Error('입력을 적용하거나 조합을 마친 뒤 검색하세요.');
    const context = this.captureContext(), searchText = this.searchQueryInput.value, revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    if (!searchText.trim()) throw new Error('검색어를 입력하세요.');
    const before = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (before.revision !== revision) throw new Error('문서가 변경되어 검색을 취소했습니다. 다시 시도하세요.');
    const options = { caseSensitive: this.searchCaseSensitiveInput.checked };
    const matches = this.searchIncludeStoriesInput.checked
      ? await this.plugin.api.query.search(context.path, searchText, { ...options, includeStories: true })
      : await this.plugin.api.query.search(context.path, searchText, { ...options, includeStories: false });
    this.assertContext(context);
    const after = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (after.revision !== revision) throw new Error('검색 중 문서가 변경되어 오래된 결과를 표시하지 않았습니다.');
    this.searchRevision = revision; this.searchCurrentIndex = -1;
    if (this.findBarEl) this.findBarEl.hidden = false;
    this.setTargetBrowser(this.searchBrowser, matches.map((match: DocumentSearchMatch) => ({
      kind: 'paragraph' as const,
      label: `${match.nodePath}: ${match.text.slice(0, 90)}`,
      filterText: `${match.nodePath} ${match.text}`,
      address: match.address, nodePath: match.nodePath, start: match.offset, end: match.offset + match.length, searchResult: true as const,
    })));
    this.updatePageSelectionOverlay();
  }
  private async replaceCurrentSearchResult(): Promise<void> {
    if (this.composing || this.draft) throw new Error('입력을 적용하거나 조합을 마친 뒤 바꾸세요.');
    const revision = this.state?.revision, target = this.currentSearchTarget();
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    if (this.searchRevision !== revision) throw new Error('검색 결과가 오래되었습니다. 다시 검색하세요.');
    if (!target?.searchResult || target.start === undefined || target.end === undefined) throw new Error('현재 검색 결과를 선택하세요.');
    if (target.address.kind !== 'body' || target.address.cellPath?.length) {
      throw new Error('현재 결과 바꾸기는 본문 문단만 지원합니다. 표 셀과 머리말·꼬리말·각주는 모두 바꾸기를 사용하세요.');
    }
    if (/[\r\n\u2028]/u.test(this.searchReplacementInput.value)) throw new Error('현재 결과 바꾸기는 한 문단 안의 텍스트만 삽입할 수 있습니다.');
    const afterPosition: TextPosition = { address: target.address, offset: target.start };
    await this.execute([{
      type: 'replaceRange',
      start: { address: target.address, offset: target.start },
      end: { address: target.address, offset: target.end },
      text: this.searchReplacementInput.value,
    }], afterPosition, true);
    this.searchRevision = -1; this.searchCurrentIndex = -1;
    await this.runSearch();
  }
  private async guard(action: () => Promise<unknown> | void, immediate = false, queueAfterCurrent = false): Promise<void> {
    if (this.tasks.busy && !queueAfterCurrent) { new Notice('화면 작업이 진행 중입니다. 완료 후 다시 시도하세요.'); return; }
    this.operationError = undefined; this.updateStatus();
    try {
      const operation = queueAfterCurrent ? this.tasks.runAfterCurrent(action)
        : immediate ? this.tasks.runImmediately(action) : this.tasks.run(action);
      this.updateAutosaveInput(); await operation;
    }
    catch (error) { this.operationError = error instanceof Error ? error.message : String(error); this.updateStatus(); this.plugin.report(error); }
    finally { this.updateAutosaveInput(); }
  }
  /** Tool inputs live in collapsed sections; a hidden input cannot take focus, so open its sections first. */
  private focusToolInput(input: HTMLInputElement): void {
    if (this.findBarEl) this.findBarEl.hidden = false;
    for (let node: HTMLElement | null = input.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') (node as HTMLDetailsElement).open = true;
    input.focus({ preventScroll: false }); input.select();
  }
  private closeFindBar(): void {
    if (!this.findBarEl) return;
    this.findBarEl.hidden = true;
    this.updatePageSelectionOverlay();
    this.textarea.focus({ preventScroll: true });
  }
  private onEditorInput(): void {
    this.lastInputAt = performance.now();
    this.updateAutosaveInput(true);
    const mutationReason = this.selectionMutationReason();
    if (mutationReason && this.selected && isParagraph(this.selected)) {
      this.textarea.value = editorTextFromModel(this.selected.text);
      const offset = utf16OffsetFromCodePoint(this.textarea.value, this.pageSelection?.focus?.offset ?? this.pageSelection?.end ?? 0);
      this.textarea.setSelectionRange(offset, offset);
      this.updateStatus();
      new Notice(mutationReason); return;
    }
    this.draft = true; this.draftSaveError = undefined;
    if (this.cellBlockSelection) { this.cellBlockSelection = undefined; this.updatePageSelectionOverlay(); }
    this.syncPageSelectionFromTextarea();
    const lineCount = 1 + (this.textarea.value.match(/[\n\u2028]/g)?.length ?? 0);
    if (lineCount !== this.inlineEditorLineCount) this.syncInlineEditor();
    this.updateStatus();
    if (!this.composing) {
      this.draftAutosave.schedule(this.captureInputDraft());
      this.scheduleLiveCommit();
    }
  }
  private scheduleLiveCommit(): void {
    this.directInputCommit.schedule();
  }
  /**
   * Direct mode sends the draft at once and leaves the receiver open: unlike the compatibility editor's commit it never disables the
   * receiver, so keys typed while the engine works stay in it and are carried over to the new revision (`continueTypingAfterCommit`).
   */
  private async commitDirectInput(): Promise<void> {
    if (this.composing || !this.draft && !this.pendingLiveRebase) return;
    this.operationError = undefined;
    try {
      const operation = this.tasks.runAfterCurrent(async () => {
        if (this.composing) return;
        this.settlePendingLiveRebase();
        if (!this.draft) return;
        // The recovery copy is written by the input autosave; flushing it before every key's commit would cost a file write per key.
        await this.applyDraftSnapshot(this.captureDraftApplySnapshot(), true, [], undefined, false, true);
      });
      this.updateAutosaveInput(); await operation;
    } catch (error) {
      this.operationError = error instanceof Error ? error.message : String(error);
      this.updateStatus(); this.plugin.report(error);
      if (this.draft) this.draftAutosave.schedule(this.captureInputDraft());
    }
    finally { this.updateAutosaveInput(); }
  }
  /**
   * After a direct-mode commit the receiver holds the committed text plus the keys typed meanwhile. Re-point the selection at the new
   * revision and keep those keys as the next draft. When the commit split the paragraph, the receiver keeps only the caret paragraph,
   * which rewrites its value; that waits for an IME composition to end.
   */
  private async continueTypingAfterCommit(snapshot: DraftApplySnapshot, revision: number, changedPages?: readonly number[]): Promise<number> {
    // The draft flag stays set through refresh so that it neither folds the selection nor rewrites the receiver.
    // Only the pages the commit changed are drawn again; a mounted neighbour would otherwise hold the engine while the next key waits.
    if (this.state?.revision !== revision) await this.refresh(true, changedPages);
    this.assertContext(snapshot.context);
    this.pendingLiveRebase = { committed: snapshot.value, context: snapshot.context };
    this.settlePendingLiveRebase();
    return revision;
  }
  private settlePendingLiveRebase(): void {
    const pending = this.pendingLiveRebase, selected = this.selected, tree = this.documentTree;
    if (!pending || !selected || !tree || !this.state) { this.pendingLiveRebase = undefined; return; }
    this.assertContext(pending.context);
    const textBox = isParagraph(selected) && selected.address.kind === 'body' && !!selected.address.containerKinds?.includes('textBox');
    const rebased = rebaseTypedInput(pending.committed, this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd, isParagraph(selected) && !textBox);
    if (rebased && this.composing && rebased.value !== this.textarea.value) return;
    this.pendingLiveRebase = undefined;
    let next: TextParagraph | Field | undefined, base = rebased?.base, receiver = rebased?.value;
    if (rebased) {
      const paragraphDelta = rebased.paragraphDelta;
      const address = isParagraph(selected) ? paragraphDelta ? siblingAddress(selected.address, paragraphDelta) : selected.address : undefined;
      const candidate = isParagraph(selected) ? address && this.paragraphForAddress(tree, address) : tree.fields.find(item => item.fieldId === selected.fieldId);
      const committed = candidate && (isParagraph(candidate) ? editorTextFromModel(candidate.text) : candidate.value);
      if (candidate && committed === rebased.base) next = candidate;
      // The engine may store the text differently from the receiver (inline controls). With nothing typed meanwhile, take its text.
      else if (candidate && committed !== undefined && rebased.value === rebased.base && !this.composing) { next = candidate; base = receiver = committed; }
    }
    if (!rebased || !next || base === undefined || receiver === undefined) {
      // The later keys cannot be moved onto one paragraph of the new revision: keep them in the receiver and its recovery copy.
      this.draftAutosave.schedule(this.captureInputDraft());
      throw new Error('입력을 반영하는 동안 입력한 내용을 이어 붙이지 못했습니다. 입력한 내용은 편집창과 복구 목록에 남아 있습니다.');
    }
    this.rebuildItemList(tree);
    const target = next, index = this.items.findIndex(item => isParagraph(target) ? isParagraph(item) && item.nodePath === target.nodePath : !isParagraph(item) && item.fieldId === target.fieldId);
    if (index >= 0) { this.renderItemPage(index); this.selector.value = String(index); }
    if (isParagraph(target) && selected.nodePath !== target.nodePath) { this.resetInputGroup(); this.pendingCaretProperties = undefined; this.preferredCaretX = undefined; }
    this.selected = index >= 0 ? this.items[index] : target;
    this.draftRevision = this.state.revision;
    if (receiver !== this.textarea.value) {
      this.textarea.value = receiver;
      this.textarea.setSelectionRange(Math.min(rebased.selectionStart, receiver.length), Math.min(rebased.selectionEnd, receiver.length));
    }
    this.draft = this.textarea.value !== base;
    if (this.draft) this.draftAutosave.schedule(this.captureInputDraft());
    else void this.draftAutosave.discard(id => this.plugin.discardInputDraft(id)).then(() => { this.draftSaveError = undefined; }, error => {
      new Notice('입력은 적용했지만 오래된 복구본을 정리하지 못했습니다. 복구 목록에서 확인한 뒤 폐기하세요.', 8000);
      this.plugin.report(error);
    });
    this.syncPageSelectionFromTextarea(); this.syncInlineEditor(); this.updateToolState(); this.updateStatus();
    if (this.draft && !this.composing) this.directInputCommit.schedule();
  }
  /**
   * Runs the action of a key or click. In direct mode a typed-text commit is usually in flight, so the action waits for it instead of
   * being refused as busy, and the receiver is held meanwhile so keys typed after this one cannot take effect before it.
   */
  private guardInput(action: () => Promise<unknown> | void, immediate = false): Promise<void> {
    if (!this.tasks.busy) return this.guard(action, immediate);
    if (this.queuedInputAction) { new Notice('화면 작업이 진행 중입니다. 완료 후 다시 시도하세요.'); return Promise.resolve(); }
    this.queuedInputAction = true;
    const release = this.lockInput();
    return this.guard(async () => { this.queuedInputAction = false; release(); await action(); }, false, true)
      .finally(() => { this.queuedInputAction = false; release(); });
  }
  private deletionCrossesParagraph(key: string): boolean {
    const { selectionStart: start, selectionEnd: end, value } = this.textarea;
    if (start !== end) return value.slice(start, end).includes('\n');
    return key === 'Backspace' ? value[start - 1] === '\n' : value[start] === '\n';
  }
  /** Replays a Backspace or Delete held back while a commit ran; at the paragraph edge it merges with the neighbouring paragraph. */
  private async replayDeletion(direction: 'backward' | 'forward'): Promise<void> {
    if (this.composing) return;
    this.settlePendingLiveRebase();
    if (!this.selected || !isParagraph(this.selected)) return;
    const { selectionStart: start, selectionEnd: end, value } = this.textarea;
    if (start === end) {
      const caret = codePointOffsetFromUtf16(value, start), length = Array.from(value).length;
      if (direction === 'backward' ? caret === 0 : caret === length) { await this.mergeAtBoundary(direction); return; }
      const removed = direction === 'backward' ? caret - 1 : caret;
      this.textarea.setRangeText('', utf16OffsetFromCodePoint(value, removed), utf16OffsetFromCodePoint(value, removed + 1), 'start');
    } else this.textarea.setRangeText('', start, end, 'start');
    this.onEditorInput();
  }
  private async replaceRootRangeWithText(range: SelectionRange, value: string): Promise<void> {
    const ordered = this.editableSelectionRange(range);
    if (!ordered || this.rangeIsCollapsed(ordered)) throw new Error('선택 입력은 같은 구역 본문 범위에서만 지원합니다.');
    if (/[\r\n\u2028]/u.test(value)) return this.pasteHtmlAtSelection(clipboardHtmlForText(value));
    const { start, end } = ordered, safeDelete: Extract<Command, { type: 'deleteRange' }> = { type: 'deleteRange', start, end };
    const commands: Command[] = [safeDelete, { type: 'insertText', target: start.address, offset: start.offset, text: value }];
    const after: TextPosition = { address: start.address, offset: start.offset + Array.from(value).length };
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    try { await this.execute(commands, after, true); }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
      if (code !== 'CONTENT_LOSS') throw error;
      const confirmed = await new Promise<boolean>(resolve => new ConfirmAnchoredDelete(this.app, resolve).open());
      if (!confirmed) return;
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('확인 중 문서가 변경되었습니다. 다시 선택한 뒤 입력하세요.');
      await this.execute([{ ...safeDelete, deleteAnchoredContent: true }, commands[1]], after, true);
    }
  }
  private onEditorBeforeInput(event: InputEvent): void {
    const mutationReason = this.selectionMutationReason();
    if (mutationReason && /^(insert|delete)/u.test(event.inputType)) {
      if (event.cancelable) event.preventDefault();
      new Notice(mutationReason); return;
    }
    const selection = this.pageSelection?.range;
    if (selection && !this.rangeIsCollapsed(selection) && event.inputType === 'insertText' && event.data && !this.composing && !event.isComposing && event.cancelable
      && this.editableSelectionRange(selection)) {
      event.preventDefault(); this.resetInputGroup();
      void this.guard(() => this.replaceRootRangeWithText(selection, event.data!));
      return;
    }
    if (!this.overwriteMode || this.composing || event.isComposing || event.inputType !== 'insertText' || !event.data || Array.from(event.data).length !== 1 || !event.cancelable) return;
    if (this.textarea.selectionStart !== this.textarea.selectionEnd) return;
    const range = inputReplacementRange(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd, true);
    if (range.end === range.start || /[\r\n\u2028]/u.test(event.data)) return;
    event.preventDefault();
    this.textarea.setRangeText(event.data, range.start, range.end, 'end');
    this.onEditorInput();
  }
  private resetInputGroup(): void { this.inputGroupId = undefined; this.inputGroupTarget = undefined; }
  private syncPageSelectionFromTextarea(): void {
    if (this.selected && !isParagraph(this.selected) && this.selected.address && this.pageSelection
      && sameDocumentAddress(this.selected.address, this.pageSelection.address)) {
      this.updateToolState(); this.updateStatus(); return;
    }
    if (!this.selected || !isParagraph(this.selected)) {
      this.pageSelection = undefined; this.updatePageSelectionOverlay(); this.updateToolState(); this.updateStatus(); return;
    }
    // A Shift+arrow range keeps the textarea caret at its focus end. The 'select' event that echoes that caret arrives after the range
    // was stored (its timing varies), so a collapsed textarea caret that sits on the range focus must not erase the range - in the same
    // paragraph as well as across paragraphs.
    const activeRange = this.pageSelection?.range, focus = this.pageSelection?.focus;
    if (activeRange && focus && this.textarea.selectionStart === this.textarea.selectionEnd) {
      const current = positionAfterEditorText(this.selected.address, this.textarea.value, this.textarea.selectionStart);
      if (sameDocumentAddress(current.address, focus.address) && current.offset === focus.offset) {
        this.updatePageSelectionOverlay(); this.updateToolState(); this.updateStatus(); return;
      }
    }
    const start = positionAfterEditorText(this.selected.address, this.textarea.value, this.textarea.selectionStart);
    const end = positionAfterEditorText(this.selected.address, this.textarea.value, this.textarea.selectionEnd);
    this.pageSelection = sameDocumentAddress(start.address, this.selected.address) && sameDocumentAddress(start.address, end.address)
      ? { address: this.selected.address, start: start.offset, end: end.offset }
      : undefined;
    // A collapsed caret anchors the next Shift+click or Shift+arrow. A click inside the visible compatibility editor or a native caret
    // key never reaches the page click handler that sets the anchor, so Shift+click used to extend from an earlier, stale anchor.
    if (this.pageSelection && this.pageSelection.start === this.pageSelection.end) this.selectionAnchor = { address: this.pageSelection.address, offset: this.pageSelection.start };
    this.updatePageSelectionOverlay(); this.updateToolState(); this.updateStatus();
  }
  private selectionRange(): SelectionRange | undefined {
    const selection = this.pageSelection;
    if (!selection) return undefined;
    return selection.range ?? {
      start: { address: selection.address, offset: selection.start },
      end: { address: selection.address, offset: selection.end },
    };
  }
  private rangeIsCollapsed(range: SelectionRange | undefined): boolean {
    return !range || sameDocumentAddress(range.start.address, range.end.address) && range.start.offset === range.end.offset;
  }
  private rootBodyRange(range: SelectionRange): SelectionRange | undefined {
    const start = range.start, end = range.end;
    if (start.address.kind !== 'body' || end.address.kind !== 'body'
      || start.address.cellPath?.length || end.address.cellPath?.length
      || start.address.containerKinds?.includes('textBox') || end.address.containerKinds?.includes('textBox')
      || start.address.section !== end.address.section) return undefined;
    const reversed = start.address.paragraph > end.address.paragraph
      || start.address.paragraph === end.address.paragraph && start.offset > end.offset;
    return reversed ? { start: end, end: start } : range;
  }
  private documentRange(range: SelectionRange): SelectionRange | undefined {
    if (!this.documentTree) return undefined;
    try {
      const segments = normalizeSelectionSegments(this.documentTree, range.start, range.end);
      return segments.length ? { start: segments[0].start, end: segments.at(-1)!.end } : undefined;
    } catch { return undefined; } // A drag cannot leave its cell or story.
  }
  private selectionMutationReason(): string | undefined {
    if (this.rangeIsCollapsed(this.selectionRange())) return undefined;
    return selectionMutationUnavailableReason(this.selectionSegments());
  }
  private editableSelectionRange(range: SelectionRange): SelectionRange | undefined {
    if (!this.documentTree) return undefined;
    const segments = normalizeSelectionSegments(this.documentTree, range.start, range.end);
    const reason = selectionMutationUnavailableReason(segments);
    if (reason) throw new Error(reason);
    return segments[0];
  }
  private hasMultiParagraphSelection(): boolean {
    const range = this.pageSelection?.range;
    return !!range && !sameDocumentAddress(range.start.address, range.end.address);
  }
  private selectionSegments(): SelectionRange[] {
    const range = this.selectionRange(), tree = this.documentTree;
    if (!range || !tree) return [];
    if (this.draft && this.draftRevision !== this.state?.revision) return [];
    if (this.draft && this.selected && isParagraph(this.selected)
      && sameDocumentAddress(range.start.address, this.selected.address) && sameDocumentAddress(range.end.address, this.selected.address)) {
      return normalizeSelectionSegments(tree, { address: range.start.address, offset: Math.min(range.start.offset, this.selected.length) },
        { address: range.end.address, offset: Math.min(range.end.offset, this.selected.length) });
    }
    return normalizeSelectionSegments(tree, range.start, range.end);
  }
  private formattingReason(changes: RangeFormatProperties): string | undefined {
    if (!this.selected || !isParagraph(this.selected)) return '서식을 적용할 문단을 선택하세요.';
    const block = this.cellBlockSelection;
    const table = block && this.documentTree?.tables.find(item => item.nodePath === block.tablePath);
    const addresses = table && block ? cellsInCellBlock(table, block).flatMap(cell => cell.paragraphs.map(paragraph => paragraph.address))
      : [this.selected.address];
    for (const address of addresses) {
      const reason = formattingUnavailableReason(address, changes);
      if (reason) return reason;
    }
    return undefined;
  }
  private captureFormattingSelection(): SelectionRestoreSnapshot {
    const range = this.selectionRange(), block = this.cellBlockSelection;
    const table = block && this.documentTree?.tables.find(item => item.nodePath === block.tablePath);
    return structuredClone({ range, anchor: this.selectionAnchor ?? range?.start, focus: this.pageSelection?.focus ?? range?.end,
      ...(block && table ? { block: { table: { address: table.address, control: table.control }, selection: block } } : {}) });
  }
  private restoreFormattingSelection(snapshot: SelectionRestoreSnapshot, commands: Command[], receiptRevision: number): void {
    if (!this.documentTree || !this.state) return;
    const restored = restoreOwnFormattingSelection(this.documentTree, snapshot, commands, receiptRevision, this.state.revision);
    if (!restored) return;
    const focus = restored.focus ?? restored.range?.end;
    if (focus) this.restoreTextPosition(focus);
    if (restored.range && focus) this.setPageRangeSelection(restored.range, focus, restored.anchor ?? restored.range.start);
    this.cellBlockSelection = restored.block?.selection;
    this.updatePageSelectionOverlay(); this.updateToolState(); this.updateStatus();
  }
  private async applySelectionFormatting(changes: RangeFormatProperties): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 서식을 바꾸세요.');
    if (this.draft) await this.applyDraft(true);
    const reason = this.formattingReason(changes);
    if (reason) throw new Error(reason);
    const block = this.cellBlockSelection, table = block && this.documentTree?.tables.find(item => item.nodePath === block.tablePath);
    if (block && table) {
      await this.executeSelectionFormatting([{ type: 'formatCellBlock', table: { ...table.address, control: table.control },
        startRow: Math.min(block.anchor.row, block.focus.row), endRow: Math.max(block.anchor.row, block.focus.row),
        startCol: Math.min(block.anchor.col, block.focus.col), endCol: Math.max(block.anchor.col, block.focus.col), ...changes }]);
      return;
    }
    const segments = this.selectionSegments();
    if (!segments.length) throw new Error('서식을 적용할 선택 위치가 없습니다.');
    const collapsed = segments.length === 1 && this.rangeIsCollapsed(segments[0]);
    if (collapsed && changes.character) {
      let character = changes.character;
      if (character.fontLanguage !== undefined) {
        const language = character.fontLanguage;
        const runs = this.selectedFormattingRuns();
        let families = this.pendingCaretProperties?.fontFamilies?.slice() ?? (this.pendingCaretProperties?.fontFamily && this.pendingCaretProperties.fontLanguage === undefined ? Array(7).fill(this.pendingCaretProperties.fontFamily) as string[] : runs[0]?.properties.fontFamilies?.slice());
        if (!families) {
          const context = this.captureContext(), state = this.state;
          if (!state) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
          const caret = await this.plugin.api.query.caret(context.path, segments[0].start, { sessionId: state.sessionId, expectedRevision: state.revision });
          this.assertContext(context);
          if (this.state?.revision !== state.revision || JSON.stringify(this.selectionSegments()) !== JSON.stringify(segments)) throw new Error('선택 위치가 바뀌었습니다. 다시 적용하세요.');
          families = caret.context.characterProperties?.fontFamilies?.slice();
        }
        if (!families || families.length !== 7) throw new Error('언어별 글꼴 정보를 읽지 못했습니다.');
        families[language] = character.fontFamily!;
        const { fontLanguage: _language, fontFamily: _family, ...rest } = character;
        character = { ...rest, fontFamilies: families };
        const { fontFamily: _previousFamily, fontLanguage: _previousLanguage, ...previous } = this.pendingCaretProperties ?? {};
        this.pendingCaretProperties = previous;
      } else if (character.fontFamily !== undefined && this.pendingCaretProperties) {
        delete this.pendingCaretProperties.fontFamilies; delete this.pendingCaretProperties.fontLanguage;
      }
      this.pendingCaretProperties = { ...this.pendingCaretProperties, ...character };
      this.resetInputGroup();
      const { character: _character, ...paragraphChanges } = changes;
      if (Object.keys(paragraphChanges).length) await this.executeSelectionFormatting(segments.map(range => ({ type: 'formatRange', range, ...paragraphChanges })));
      this.updateToolState(); this.updateStatus();
      return;
    }
    await this.executeSelectionFormatting(segments.map(range => ({ type: 'formatRange', range, ...changes })));
  }
  private async executeSelectionFormatting(commands: Command[]): Promise<void> {
    let announced = false;
    const timer = setTimeout(() => {
      announced = true;
      this.navigationStatus.setText('선택 범위 서식을 적용하는 중…');
      this.navigationStatus.setAttribute('aria-busy', 'true');
    }, 150);
    try {
      await this.execute(commands);
      if (announced) this.navigationStatus.setText('선택 범위 서식을 적용했습니다.');
    } catch (error) {
      if (announced) this.navigationStatus.setText('선택 범위 서식을 적용하지 못했습니다.');
      throw error;
    } finally {
      clearTimeout(timer);
      this.navigationStatus.removeAttribute('aria-busy');
    }
  }
  private fallbackTextForRange(range: SelectionRange): string | undefined {
    if (!this.documentTree) return undefined;
    try { return selectionPlainText(this.documentTree, normalizeSelectionSegments(this.documentTree, range.start, range.end)); }
    catch { return undefined; }
  }
  private clipboardSelectionKey(): string | undefined {
    const range = this.selectionRange(), state = this.state;
    if (!this.path || !state || !range || this.rangeIsCollapsed(range) || this.draft || this.composing) return undefined;
    return `${this.path}\u0000${this.generation}\u0000${state.revision}\u0000${JSON.stringify(range)}`;
  }
  private preloadSelectionCopy(): void {
    const key = this.clipboardSelectionKey();
    if (key === this.selectionCopyKey) return;
    this.selectionCopyKey = key;
    this.selectionCopy = undefined;
    const sequence = ++this.selectionCopySequence;
    const range = this.selectionRange();
    if (!key || !this.state || !range) return;
    const context = this.captureContext(), state = this.state;
    void Promise.all(this.selectionSegments().map(segment => this.plugin.api.query.copy(context.path, segment, { sessionId: state.sessionId, expectedRevision: state.revision }))).then(parts => {
      const copied = { text: parts.map(part => part.text).join('\n'), html: parts.map(part => part.html).join('') };
      if (sequence !== this.selectionCopySequence || this.selectionCopyKey !== key || this.generation !== context.generation
        || this.path !== context.path || this.state?.revision !== state.revision) return;
      this.selectionCopy = copied;
    }).catch(() => { if (sequence === this.selectionCopySequence) this.selectionCopy = undefined; });
  }
  private clipboardSelection(): CopiedSelection | undefined {
    const range = this.selectionRange();
    const key = this.clipboardSelectionKey();
    if (key && key === this.selectionCopyKey && this.selectionCopy) return this.selectionCopy;
    if (range && !this.rangeIsCollapsed(range)) {
      const text = this.fallbackTextForRange(range);
      return text === undefined ? undefined : { text, html: clipboardHtmlForText(text) };
    }
    const start = this.textarea.selectionStart, end = this.textarea.selectionEnd;
    if (end <= start) return undefined;
    const text = this.textarea.value.slice(start, end).replace(/\u2028/g, '\n');
    return { text, html: clipboardHtmlForText(text) };
  }
  private writeClipboardSelection(event: ClipboardEvent): 'written' | 'failed' | 'notHandled' {
    const result = writeClipboardSelection(event, this.clipboardSelection(), this.hasMultiParagraphSelection());
    if (result === 'failed') new Notice('클립보드에 쓸 수 없어 작업을 취소했습니다.');
    return result;
  }
  private onEditorCopy(event: ClipboardEvent): void { this.writeClipboardSelection(event); }
  private onEditorCut(event: ClipboardEvent): void {
    const reason = this.selectionMutationReason();
    if (reason) { event.preventDefault(); new Notice(reason); return; }
    if (this.composing || !this.selected || !isParagraph(this.selected) || this.selected.address.kind !== 'body') return;
    if (this.writeClipboardSelection(event) !== 'written') return;
    const start = this.textarea.selectionStart, end = this.textarea.selectionEnd;
    void this.guard(async () => {
      if (this.draft) {
        this.textarea.setRangeText('', start, end, 'start');
        this.onEditorInput();
        await this.applyDraft(true);
      } else await this.deleteSelectedRange();
    });
  }
  private clipboardImage(file: File): File | undefined {
    const type = file.type.toLowerCase();
    const mimeExtension = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : type === 'image/gif' ? 'gif' : type === 'image/bmp' ? 'bmp' : undefined;
    const nameExtension = file.name.split('.').at(-1)?.toLowerCase();
    const extension = nameExtension && ['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(nameExtension) ? nameExtension : mimeExtension;
    if (!extension) return undefined;
    if (nameExtension === extension && type) return file;
    const normalizedType = type || (extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`);
    return new File([file], `${file.name.replace(/\.[^.]*$/u, '') || 'clipboard'}.${extension}`, { type: normalizedType });
  }
  private async applyPasteContents(html: string, text: string, files: readonly File[]): Promise<void> {
    const reason = this.selectionMutationReason(); if (reason) throw new Error(reason);
    if (this.composing) throw new Error('한글 조합을 마친 뒤 붙여넣으세요.');
    const selected = this.selected;
    const rootBody = !!selected && isParagraph(selected) && selected.address.kind === 'body' && !selected.address.cellPath?.length && !selected.address.containerKinds?.includes('textBox');
    const collapsed = this.textarea.selectionStart === this.textarea.selectionEnd;
    const image = Array.from(files).map(file => this.clipboardImage(file)).find((file): file is File => !!file);
    if (image && rootBody && collapsed) {
      await this.insertPicture(image);
      return;
    }
    const htmlBytes = html ? new TextEncoder().encode(html).byteLength : 0;
    if (!this.draft && html.trim() && selected && isParagraph(selected) && selected.address.kind === 'body' && !selected.address.containerKinds?.includes('textBox') && htmlBytes <= 1024 * 1024) {
      await this.pasteHtmlAtSelection(html);
      return;
    }
    if (html && (htmlBytes > 1024 * 1024 || !rootBody || this.draft)) new Notice('이 위치에는 서식 있는 HTML을 붙일 수 없어 일반 텍스트로 붙입니다.');
    if (!text) throw new Error(htmlBytes > 1024 * 1024 ? 'HTML 클립보드가 1 MiB 제한을 넘었고 일반 텍스트가 없습니다.' : '클립보드에 붙일 일반 텍스트가 없습니다.');
    const currentRange = this.selectionRange();
    if (currentRange && !this.rangeIsCollapsed(currentRange) && this.editableSelectionRange(currentRange)) {
      await this.pasteHtmlAtSelection(clipboardHtmlForText(text));
      return;
    }
    this.textarea.setRangeText(normalizeEditorText(text), this.textarea.selectionStart, this.textarea.selectionEnd, 'end');
    this.onEditorInput();
    await this.applyDraft(true);
  }
  private onEditorPaste(event: ClipboardEvent): void {
    if (this.composing) return;
    const data = event.clipboardData;
    if (!data) return;
    const html = data.getData('text/html'), text = data.getData('text/plain'), files = Array.from(data.files);
    if (!html && !text && !files.length) return;
    event.preventDefault();
    void this.guard(() => this.applyPasteContents(html, text, files));
  }
  private async pasteFromSystemClipboard(): Promise<void> {
    const clipboard = this.contentEl.ownerDocument.defaultView?.navigator.clipboard;
    if (!clipboard) throw new Error('이 환경에서 시스템 클립보드 읽기를 사용할 수 없습니다.');
    let html = '', text = '';
    const files: File[] = [];
    if (typeof clipboard.read === 'function') {
      const items = await clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type === 'text/html') html = await blob.text();
          else if (type === 'text/plain') text = await blob.text();
          else if (type.startsWith('image/')) {
            const extension = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length);
            files.push(new File([blob], `clipboard.${extension}`, { type }));
          }
        }
      }
    } else if (typeof clipboard.readText === 'function') text = await clipboard.readText();
    if (!html && !text && !files.length) throw new Error('시스템 클립보드에 붙일 텍스트, HTML 또는 그림이 없습니다.');
    await this.applyPasteContents(html, text, files);
  }
  private runClipboardCommand(action: 'cut' | 'copy' | 'paste'): Promise<void> | void {
    if (action !== 'copy') { const reason = this.selectionMutationReason(); if (reason) throw new Error(reason); }
    if (action === 'paste') return this.guard(() => this.pasteFromSystemClipboard());
    this.textarea.focus({ preventScroll: true });
    if (!this.contentEl.ownerDocument.execCommand(action)) throw new Error(`${action === 'copy' ? '복사' : '오려두기'} 명령을 이 Obsidian 환경에서 실행하지 못했습니다.`);
  }
  private async showPageContextMenu(event: MouseEvent, page: number): Promise<void> {
    await this.pageStack?.setActivePage(page);
    const hit = this.pageHitAt(event.clientX, event.clientY, page);
    const hitParagraph = hit?.kind === 'paragraph' || hit?.kind === 'tableCell' ? hit.paragraph : undefined;
    const inSelection = hitParagraph && (this.selectedFormattingParagraphs().some(paragraph => sameDocumentAddress(paragraph.address, hitParagraph.address)))
      && (!this.rangeIsCollapsed(this.selectionRange()) || !!this.cellBlockSelection);
    if (!inSelection) await this.selectPageTarget(event, undefined, undefined, false, page);
    const kind: EditorContextMenuKind = this.selectedObject ? 'object'
      : this.selected && !isParagraph(this.selected) ? 'field'
        : this.selected && isParagraph(this.selected) && this.selected.address.kind === 'body' && this.selected.address.containerKinds?.includes('tableCell') ? 'table' : 'body';
    const groups = contextMenuCommandGroups(kind);
    const menu = new Menu();
    for (const [groupIndex, group] of groups.entries()) {
      if (groupIndex) menu.addSeparator();
      for (const id of group) {
        const command = this.commandRegistry.get(id);
        if (!command) continue;
        const available = this.commandRegistry.isAvailable(id);
        const reason = command.unavailableReason?.();
        menu.addItem(item => item
          .setTitle(available ? command.label : `${command.label} — ${reason || '현재 문맥에서 사용할 수 없습니다.'}`)
          .setDisabled(!available)
          .onClick(() => this.runEditorCommand(id)));
      }
    }
    menu.showAtMouseEvent(event);
  }
  private async selectBodySection(): Promise<void> {
    const tree = this.documentTree, state = this.state;
    if (!tree || !state) throw new Error('문서 구조가 아직 준비되지 않았습니다.');
    const selectedAddress = this.selected && isParagraph(this.selected) ? this.selected.address : undefined;
    if (!selectedAddress) throw new Error('선택할 문단을 먼저 누르세요.');
    const range = selectAllTextRange(tree, selectedAddress);
    if (!range) throw new Error('선택할 문단이 없습니다.');
    const last = this.paragraphForAddress(tree, range.end.address)!;
    const context = this.captureContext();
    const caret = await this.plugin.api.query.caret(context.path, { address: last.address, offset: last.length }, { sessionId: state.sessionId, expectedRevision: state.revision });
    this.assertContext(context);
    if (this.state?.revision !== state.revision) throw new Error('문서가 변경되어 전체 선택을 취소했습니다. 다시 시도하세요.');
    const address = last.address;
    this.mode = address.kind !== 'body' || address.containerKinds?.includes('textBox') ? 'stories' : address.cellPath?.length ? 'cells' : 'paragraphs';
    this.modeSelector.value = this.mode; this.items = this.itemsForMode(tree);
    const index = this.items.findIndex(item => isParagraph(item) && item.nodePath === last.nodePath);
    if (index < 0) throw new Error('마지막 본문 문단을 편집 목록에서 찾지 못했습니다.');
    await this.pageStack?.setActivePage(caret.rect.pageIndex, true);
    this.selectItem(index, true);
    const end = utf16OffsetFromCodePoint(this.textarea.value, last.length);
    this.textarea.setSelectionRange(end, end);
    this.setPageRangeSelection(range, range.end, range.start);
    this.textarea.focus({ preventScroll: true });

  }
  private onEditorKeydown(event: KeyboardEvent): void {
    if (this.composing || event.isComposing) return;
    const mutationReason = this.selectionMutationReason();
    if (mutationReason && ((event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
      || ['Backspace', 'Delete', 'Enter', 'Tab', 'Process'].includes(event.key))) {
      event.preventDefault(); new Notice(mutationReason); return;
    }
    const modified = event.ctrlKey || event.metaKey;
    const historyKey = modified && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y');
    if (historyKey && this.draft) {
      event.preventDefault();
      const redo = event.key.toLowerCase() === 'y' || event.shiftKey;
      void this.guard(() => this.historyCommand(redo), false, true);
      return;
    }
    if (event.key === 'F5' && !modified && !event.altKey && !event.shiftKey && !this.draft) {
      event.preventDefault(); this.toggleCellBlockSelection(); return;
    }
    if (this.cellBlockSelection && event.shiftKey && !modified && !event.altKey && !this.draft) {
      const delta = event.key === 'ArrowUp' ? [-1, 0] : event.key === 'ArrowDown' ? [1, 0]
        : event.key === 'ArrowLeft' ? [0, -1] : event.key === 'ArrowRight' ? [0, 1] : undefined;
      if (delta) { event.preventDefault(); this.extendCellBlockSelection(delta[0], delta[1]); return; }
    }
    if (this.cellBlockSelection && modified && !event.altKey && !this.draft) {
      const resize = event.key === 'ArrowLeft' ? ['width', -1] as const : event.key === 'ArrowRight' ? ['width', 1] as const
        : event.key === 'ArrowUp' ? ['height', -1] as const : event.key === 'ArrowDown' ? ['height', 1] as const : undefined;
      if (resize) {
        event.preventDefault();
        const amount = millimetersToHwpUnits(event.shiftKey ? 5 : 1) * resize[1];
        void this.guardInput(() => this.resizeSelectedCellBlock(resize[0], amount));
        return;
      }
    }
    if (!modified && event.altKey && !event.shiftKey && !this.draft) {
      const command = event.key === 'Enter' ? 'table.insert-row-below' : event.key === 'Delete' ? 'table.delete-row' : undefined;
      if (command) { event.preventDefault(); void this.runEditorCommand(command); return; }
    }
    if (event.key === 'Insert' && !modified && !event.altKey && !event.shiftKey) {
      event.preventDefault(); this.overwriteMode = !this.overwriteMode; this.resetInputGroup(); this.updateStatus(); return;
    }
    if (modified && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a' && !this.formMode) {
      event.preventDefault();
      void this.guardInput(async () => {
        if (this.draft) await this.applyDraft(true);
        this.resetInputGroup(); await this.selectBodySection();
      });
      return;
    }
    if (this.formMode && this.selected && !isParagraph(this.selected)) {
      if (event.key === 'Tab' && !modified && !event.altKey) {
        event.preventDefault(); this.resetInputGroup();
        void this.guardInput(async () => { if (this.draft) await this.applyDraft(); await this.moveFormField(event.shiftKey ? -1 : 1); });
        return;
      }
      if (event.key === 'Enter' && !modified && !event.shiftKey && !event.altKey && this.draft) {
        event.preventDefault(); return;
      }
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
      || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') this.resetInputGroup();
    const selected = this.selected;
    if (selected && isParagraph(selected)) {
      const logicalRange = this.selectionRange();
      if (!this.draft && this.textarea.selectionStart === this.textarea.selectionEnd
        && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
        && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
        && logicalRange && !this.rangeIsCollapsed(logicalRange)) {
        event.preventDefault(); this.resetInputGroup();
        void this.guardInput(() => this.collapsePageSelectionTo(event.key === 'ArrowLeft' ? 'start' : 'end'));
        return;
      }
      if (!this.draft && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
        && this.textarea.selectionStart === this.textarea.selectionEnd && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const current = this.selectedTableCell();
        const step = selected.address.kind === 'body' ? selected.address.cellPath?.[0] : undefined;
        const offset = codePointOffsetFromUtf16(this.textarea.value, this.textarea.selectionStart);
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        const atBoundary = direction < 0 ? offset === 0 : offset === selected.length;
        const target = current && step && atBoundary
          ? adjacentTableCellCaretTarget(current.table, current.cell.index, step.cellParaIndex, direction)
          : undefined;
        if (target) {
          event.preventDefault(); this.resetInputGroup();
          void this.guardInput(() => this.moveToTableCellCaret(target.paragraph, target.offset));
          return;
        }
      }
      if (!this.draft && this.textarea.selectionStart === this.textarea.selectionEnd) {
        const motion = caretMotionForKey(event.key, { control: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey });
        const address = selected.address, cellDepth = address.kind === 'body' ? address.cellPath?.length ?? 0 : 0;
        const supported = !!motion
          && !((motion === 'up' || motion === 'down') && (address.kind !== 'body' || address.containerKinds?.includes('textBox')))
          && !((motion === 'lineStart' || motion === 'lineEnd') && (address.kind !== 'body' || cellDepth > 1 || address.containerKinds?.includes('textBox')))
          && !((motion === 'documentStart' || motion === 'documentEnd') && (address.kind !== 'body' || cellDepth > 0));
        if (motion && supported) {
          event.preventDefault(); this.resetInputGroup();
          if (!(motion === 'up' || motion === 'down' || motion === 'pageUp' || motion === 'pageDown')) this.preferredCaretX = undefined;
          void this.guardInput(() => this.moveCaretWithEngine(motion, event.shiftKey), true);
          return;
        }
      }
      if (event.key === 'Enter' && event.shiftKey && !modified) {
        event.preventDefault();
        this.textarea.setRangeText('\u2028', this.textarea.selectionStart, this.textarea.selectionEnd, 'end');
        this.onEditorInput();
        return;
      }
      if (event.key === 'Tab' && !modified && !event.shiftKey) {
        event.preventDefault();
        if (this.selectedTableCell()) {
          this.resetInputGroup();
          void this.guardInput(async () => { if (this.draft) await this.applyDraft(); await this.moveToAdjacentTableCell(1); });
        } else {
          this.textarea.setRangeText('\t', this.textarea.selectionStart, this.textarea.selectionEnd, 'end');
          this.onEditorInput();
        }
        return;
      }
      if (event.key === 'Tab' && event.shiftKey && !modified && this.selectedTableCell()) {
        event.preventDefault(); this.resetInputGroup();
        void this.guardInput(async () => { if (this.draft) await this.applyDraft(); await this.moveToAdjacentTableCell(-1); });
        return;
      }
      if (event.key === 'Enter' && !modified) {
        const selectionRange = this.pageSelection?.range;
        if (selectionRange && !this.rangeIsCollapsed(selectionRange) && this.editableSelectionRange(selectionRange)) {
          event.preventDefault(); this.resetInputGroup();
          void this.guardInput(() => this.replaceRootRangeWithText(selectionRange, '\n'));
          return;
        }
        event.preventDefault();
        this.textarea.setRangeText('\n', this.textarea.selectionStart, this.textarea.selectionEnd, 'end');
        this.onEditorInput();
        return;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !modified && !event.altKey
        && (this.directInputCommit.inFlight || this.pendingLiveRebase) && this.deletionCrossesParagraph(event.key)) {
        // The commit in flight may already have split the paragraph at that boundary; delete once the receiver holds the new revision.
        event.preventDefault();
        void this.guardInput(() => this.replayDeletion(event.key === 'Backspace' ? 'backward' : 'forward'));
        return;
      }
      if (!this.draft && (event.key === 'Backspace' || event.key === 'Delete')
        && (this.textarea.selectionStart !== this.textarea.selectionEnd || !this.rangeIsCollapsed(this.selectionRange()))) {
        event.preventDefault(); this.resetInputGroup();
        void this.guardInput(() => this.deleteSelectedRange());
        return;
      }
      if (this.textarea.selectionStart === this.textarea.selectionEnd) {
        const value = this.textarea.value, caret = codePointOffsetFromUtf16(value, this.textarea.selectionStart);
        if (event.key === 'Backspace' && caret === 0) {
          event.preventDefault(); void this.guardInput(() => this.mergeAtBoundary('backward')); return;
        }
        if (event.key === 'Delete' && caret === Array.from(value).length) {
          event.preventDefault(); void this.guardInput(() => this.mergeAtBoundary('forward')); return;
        }
      }
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') && !this.draft) {
      event.preventDefault();
      const redo = event.key.toLowerCase() === 'y' || event.shiftKey;
      void this.guard(() => this.historyCommand(redo), false, true);
    }
  }
  private toggleCellBlockSelection(): void {
    if (this.cellBlockSelection) {
      this.cellBlockSelection = undefined;
      this.updatePageSelectionOverlay(); this.updateStatus();
      this.navigationStatus.setText('표 셀 블록 선택을 끝냈습니다.');
      return;
    }
    const current = this.selectedTableCell();
    if (!current) {
      this.navigationStatus.setText('F5 셀 블록 선택은 표 셀 안에 캐럿을 놓은 뒤 사용할 수 있습니다.');
      return;
    }
    this.cellBlockSelection = {
      tablePath: current.table.nodePath,
      anchor: { row: current.cell.row, col: current.cell.col },
      focus: { row: current.cell.row, col: current.cell.col },
    };
    this.updatePageSelectionOverlay(); this.updateStatus();
    this.navigationStatus.setText('Shift+화살표로 표 셀 블록을 넓히고, F5로 선택을 끝냅니다.');
  }
  private extendCellBlockSelection(deltaRow: number, deltaCol: number): void {
    const range = this.cellBlockSelection;
    const table = range && this.documentTree?.tables.find(item => item.nodePath === range.tablePath);
    if (!range || !table) { this.cellBlockSelection = undefined; this.updatePageSelectionOverlay(); return; }
    this.cellBlockSelection = extendCellBlockRange(range, table, deltaRow, deltaCol);
    this.updatePageSelectionOverlay(); this.updateStatus();
  }
  private async resizeSelectedCellBlock(axis: TableResizeAxis, delta: number): Promise<void> {
    if (this.formMode || this.capabilityCheckPending || this.capabilitiesReadOnly()) throw new Error('현재 문서 상태에서는 표 크기를 바꿀 수 없습니다.');
    const range = this.cellBlockSelection;
    const table = range && this.documentTree?.tables.find(item => item.nodePath === range.tablePath);
    if (!range || !table) throw new Error('F5로 표 셀 블록을 선택한 뒤 크기를 조절하세요.');
    const cells = cellsInCellBlock(table, range);
    const changes = tableCellResizeChanges(cells, axis, delta);
    await this.execute([{ type: 'resizeTableCells', table: { ...table.address, control: table.control }, cells: changes }]);
  }
  private tableCellForHit(hit: ReturnType<typeof hitTestPage>): { table: Table; cell: Table['cells'][number] } | undefined {
    const tree = this.documentTree;
    if (!hit || !tree) return undefined;
    if (hit.kind === 'tableCell') {
      const cell = hit.table.cells.find(item => item.index === hit.cellIndex);
      return cell ? { table: hit.table, cell } : undefined;
    }
    const address = hit.kind === 'paragraph' ? hit.paragraph.address : hit.kind === 'field' ? hit.field.address : undefined;
    if (address?.kind !== 'body' || address.cellPath?.length !== 1) return undefined;
    const step = address.cellPath[0];
    const table = tree.tables.find(item => item.section === address.section && item.paragraph === address.paragraph
      && item.control === step.controlIndex && !item.address.cellPath?.length);
    const cell = table?.cells.find(item => item.index === step.cellIndex);
    return table && cell ? { table, cell } : undefined;
  }
  private startPageDrag(event: PointerEvent): void {
    // Shift-click must reach the page hit-test even when the compatibility textarea covers the next line.
    if (event.target === this.textarea && !event.shiftKey || (event.target as Element | null)?.closest?.('.hwp-header-footer-controls')
      || event.button !== 0 || event.pointerType === 'touch' || this.draft || this.composing) return;
    const page = this.pageStack?.pageForTarget(event.target);
    if (page === undefined) return;
    void this.pageStack?.setActivePage(page);
    const resizeHandle = (event.target as Element | null)?.closest?.('[data-hwp-table-resize]');
    const currentCell = this.selectedTableCell(), currentState = this.state;
    const axis = resizeHandle?.getAttribute('data-hwp-table-resize');
    if (resizeHandle && currentCell && currentState && (axis === 'width' || axis === 'height')
      && resizeHandle.getAttribute('data-hwp-table-path') === currentCell.table.nodePath
      && Number(resizeHandle.getAttribute('data-hwp-table-row')) === currentCell.cell.row
      && Number(resizeHandle.getAttribute('data-hwp-table-col')) === currentCell.cell.col) {
      const pageElement = this.pageStack?.pageElement(page), cached = this.pageLayouts.get(page), bounds = pageElement?.getBoundingClientRect();
      const origin = bounds && cached?.revision === currentState.revision ? pagePointFromClient(event.clientX, event.clientY, bounds, cached.layout.info) : undefined;
      if (!origin || !cached || cached.revision !== currentState.revision) return;
      this.tableResizeStart = { context: this.captureContext(), table: currentCell.table, row: currentCell.cell.row, col: currentCell.cell.col,
        page, pointerId: event.pointerId, axis, originX: origin.x, originY: origin.y, clientX: event.clientX, clientY: event.clientY, revision: currentState.revision };
      event.preventDefault();
      try { pageElement?.setPointerCapture(event.pointerId); } catch { /* Embedded views may not expose pointer capture. */ }
      return;
    }
    const hit = this.pageHitAt(event.clientX, event.clientY, page);
    if (this.shapeDrawMode) {
      if (hit?.kind !== 'paragraph' || hit.paragraph.address.kind !== 'body' || hit.paragraph.address.cellPath?.length
        || hit.paragraph.address.containerKinds?.includes('textBox')) {
        this.navigationStatus.setText('도형은 표 셀이나 글상자가 아닌 본문 문단 위에서 그리세요.');
        return;
      }
      const pageElement = this.pageStack?.pageElement(page), cached = this.pageLayouts.get(page), bounds = pageElement?.getBoundingClientRect(), state = this.state;
      const origin = bounds && cached && state && cached.revision === state.revision ? pagePointFromClient(event.clientX, event.clientY, bounds, cached.layout.info) : undefined;
      if (!origin || !pageElement || !cached || !state) return;
      this.shapeDrawStart = { context: this.captureContext(), target: hit.paragraph.address, offset: hit.offset, page, pointerId: event.pointerId,
        originX: origin.x, originY: origin.y, clientX: event.clientX, clientY: event.clientY, revision: state.revision,
        shape: this.shapeTypeSelect.value as 'rectangle' | 'textBox', text: this.shapeTextInput.value.trim() };
      event.preventDefault();
      try { pageElement.setPointerCapture(event.pointerId); } catch { /* Embedded views may not expose pointer capture. */ }
      return;
    }
    const object = this.selectedObject, objectLayout = this.pageLayouts.get(page);
    if (object && objectLayout && this.state && objectLayout.revision === this.state.revision && !this.capabilityCheckPending && !this.capabilitiesReadOnly()) {
      const control = this.objectLayoutControl(objectLayout.layout, object);
      const requestedHandle = (event.target as Element | null)?.closest?.('[data-hwp-object-handle]')?.getAttribute('data-hwp-object-handle');
      const point = this.pageStack?.pageElement(page)?.getBoundingClientRect();
      const pagePoint = point && pagePointFromClient(event.clientX, event.clientY, point, objectLayout.layout.info);
      const isObjectHit = hit?.kind === 'object' && hit.object.controlIndex === object.controlIndex
        && hit.object.kind === object.kind && hit.object.address.section === object.address.section
        && hit.object.address.paragraph === object.address.paragraph;
      const inObject = !!control && !!pagePoint && pagePoint.x >= control.x && pagePoint.x <= control.x + control.width
        && pagePoint.y >= control.y && pagePoint.y <= control.y + control.height;
      const validHandle = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].includes(requestedHandle ?? '')
        && (object.kind !== 'equation' || ['e', 's', 'se'].includes(requestedHandle ?? ''));
      if (control && (validHandle || object.kind !== 'equation' && (isObjectHit || inObject))) {
        const revision = this.state?.revision;
        if (revision === undefined) return;
        this.objectDragStart = {
          object, page, pointerId: event.pointerId, handle: validHandle ? requestedHandle as ObjectResizeHandle : 'move',
          rect: { x: control.x, y: control.y, width: control.width, height: control.height },
          properties: structuredClone(object.properties ?? {}),
          clientX: event.clientX, clientY: event.clientY, revision,
        };
        event.preventDefault();
        try { this.pageStack?.pageElement(page)?.setPointerCapture(event.pointerId); } catch { /* Embedded views may not expose pointer capture. */ }
        return;
      }
    }
    const cell = this.tableCellForHit(hit);
    if (this.cellBlockSelection && cell?.table.nodePath === this.cellBlockSelection.tablePath) {
      this.pageCellDragStart = { tablePath: cell.table.nodePath, row: cell.cell.row, col: cell.cell.col, page, clientX: event.clientX, clientY: event.clientY };
      this.pageDragPreview = { block: { tablePath: cell.table.nodePath,
        anchor: { row: cell.cell.row, col: cell.cell.col }, focus: { row: cell.cell.row, col: cell.cell.col } } };
      this.updatePageSelectionOverlay();
      event.preventDefault();
      try { this.pageStack?.pageElement(page)?.setPointerCapture(event.pointerId); } catch { /* Pointer capture may be unavailable in an embedded view. */ }
      return;
    }
    const startPosition = hit ? this.textPositionForPageHit(hit) : undefined;
    const paragraph = startPosition && this.documentTree ? this.paragraphForAddress(this.documentTree, startPosition.address) : undefined;
    if (!hit || !startPosition || !paragraph || (hit.kind === 'tableCell' && !hit.paragraph)) return;
    const dragState = this.state;
    if (!dragState) return;
    const pageElement = this.pageStack?.pageElement(page), cached = this.pageLayouts.get(page), bounds = pageElement?.getBoundingClientRect();
    const pagePoint = bounds && cached?.revision === dragState.revision ? pagePointFromClient(event.clientX, event.clientY, bounds, cached.layout.info) : undefined;
    this.pageDragStart = { paragraph, offset: startPosition.offset, page,
      clientX: event.clientX, clientY: event.clientY, revision: dragState.revision, sessionId: dragState.sessionId,
      ...(pagePoint ? { pagePoint } : {}) };
    const position = { address: paragraph.address, offset: this.pageDragStart.offset };
    this.pageDragPreview = { range: { start: position, end: position } };
    this.updatePageSelectionOverlay();
    event.preventDefault();
    try { this.pageStack?.pageElement(page)?.setPointerCapture(event.pointerId); } catch { /* Pointer capture may be unavailable in an embedded view. */ }
  }
  private finishPageDrag(event: PointerEvent): void {
    if (this.pageDragPreview) { this.pageDragPreview = undefined; this.updatePageSelectionOverlay(); }
    const shapeStart = this.shapeDrawStart;
    if (shapeStart && shapeStart.pointerId === event.pointerId) {
      this.shapeDrawStart = undefined; this.shapeDrawMode = false;
      this.pageStack?.pageElement(shapeStart.page)?.querySelector('.hwp-shape-draw-preview')?.remove();
      if (this.shapeDrawButton) { this.shapeDrawButton.textContent = '도형 그리기'; this.shapeDrawButton.setAttribute('aria-pressed', 'false'); }
      const distance = Math.hypot(event.clientX - shapeStart.clientX, event.clientY - shapeStart.clientY);
      event.preventDefault(); this.suppressPageClick = true;
      setTimeout(() => { this.suppressPageClick = false; }, 0);
      if (distance < 3) { this.navigationStatus.setText('도형을 만들려면 쪽 위에서 1mm 이상 끌어 크기를 정하세요.'); return; }
      void this.guard(async () => {
        this.assertContext(shapeStart.context);
        if (this.state?.revision !== shapeStart.revision) throw new Error('문서가 바뀌어 도형 그리기를 취소했습니다. 다시 그리세요.');
        const pageElement = this.pageStack?.pageElement(shapeStart.page), bounds = pageElement?.getBoundingClientRect();
        const cached = this.pageLayouts.get(shapeStart.page);
        if (!bounds || !cached || cached.revision !== shapeStart.revision) throw new Error('쪽 배치가 바뀌어 도형 그리기를 취소했습니다.');
        const end = pagePointFromClient(event.clientX, event.clientY, bounds, cached.layout.info);
        if (!end) throw new Error('도형 크기를 계산할 페이지 좌표를 확인하지 못했습니다.');
        const width = Math.round(pixelsToMillimeters(Math.abs(end.x - shapeStart.originX)) * 100);
        const height = Math.round(pixelsToMillimeters(Math.abs(end.y - shapeStart.originY)) * 100);
        if (width < 100 || height < 100) throw new Error('도형 너비와 높이는 각각 1mm 이상으로 그려야 합니다.');
        await this.insertShapeAt(shapeStart.target, shapeStart.offset, width, height, shapeStart.shape, shapeStart.text);
      });
      return;
    }
    const objectStart = this.objectDragStart; this.objectDragStart = undefined;
    if (objectStart) {
      const distance = Math.hypot(event.clientX - objectStart.clientX, event.clientY - objectStart.clientY);
      if (distance < 3) return;
      event.preventDefault(); this.suppressPageClick = true;
      setTimeout(() => { this.suppressPageClick = false; }, 0);
      void this.guard(async () => {
        if (this.state?.revision !== objectStart.revision) throw new Error('문서가 바뀌어 개체 조작을 취소했습니다. 다시 선택하세요.');
        const element = this.pageStack?.pageElement(objectStart.page);
        const bounds = element?.getBoundingClientRect();
        const layout = this.pageLayouts.get(objectStart.page);
        if (!bounds || !layout || layout.revision !== objectStart.revision) throw new Error('개체 쪽 배치가 바뀌어 조작을 취소했습니다.');
        const start = pagePointFromClient(objectStart.clientX, objectStart.clientY, bounds, layout.layout.info);
        const end = pagePointFromClient(event.clientX, event.clientY, bounds, layout.layout.info);
        if (!start || !end) throw new Error('개체를 조작할 페이지 좌표를 확인하지 못했습니다.');
        const properties = objectPropertiesForDrag(objectStart.properties, objectStart.rect, objectStart.handle,
          end.x - start.x, end.y - start.y, event.shiftKey);
        await this.execute([{ type: 'setObjectProperties', object: {
          address: objectStart.object.address, controlIndex: objectStart.object.controlIndex,
          kind: objectStart.object.kind as 'picture' | 'shape' | 'equation',
        }, properties: properties as Extract<Command, { type: 'setObjectProperties' }>['properties'] }]);
        this.pageScroll.focus({ preventScroll: true });
      });
      return;
    }
    const tableStart = this.tableResizeStart; this.tableResizeStart = undefined;
    if (tableStart) {
      this.pageStack?.pageElement(tableStart.page)?.querySelector('.hwp-table-resize-guide')?.remove();
      const distance = Math.hypot(event.clientX - tableStart.clientX, event.clientY - tableStart.clientY);
      if (distance < 3) return;
      event.preventDefault(); this.suppressPageClick = true;
      setTimeout(() => { this.suppressPageClick = false; }, 0);
      void this.guard(async () => {
        this.assertContext(tableStart.context);
        if (this.state?.revision !== tableStart.revision) throw new Error('문서가 바뀌어 표 크기 조절을 취소했습니다. 다시 선택하세요.');
        const pageElement = this.pageStack?.pageElement(tableStart.page), bounds = pageElement?.getBoundingClientRect();
        const cached = this.pageLayouts.get(tableStart.page);
        if (!bounds || !cached || cached.revision !== tableStart.revision) throw new Error('표 쪽 배치가 바뀌어 크기 조절을 취소했습니다.');
        const end = pagePointFromClient(event.clientX, event.clientY, bounds, cached.layout.info);
        if (!end) throw new Error('표 크기를 계산할 페이지 좌표를 확인하지 못했습니다.');
        const pageDelta = tableStart.axis === 'width' ? end.x - tableStart.originX : end.y - tableStart.originY;
        const delta = pagePixelsToHwpUnits(pageDelta);
        if (!delta) return;
        const cells = tableStart.table.cells.filter(cell => cell.row === tableStart.row && cell.col === tableStart.col);
        const changes = tableCellResizeChanges(cells, tableStart.axis, delta);
        await this.execute([{ type: 'resizeTableCells', table: { ...tableStart.table.address, control: tableStart.table.control }, cells: changes }]);
      });
      return;
    }
    const cellStart = this.pageCellDragStart; this.pageCellDragStart = undefined;
    if (cellStart) {
      const distance = Math.hypot(event.clientX - cellStart.clientX, event.clientY - cellStart.clientY);
      if (distance < 3) return;
      const page = this.pageStack?.pageAtPoint(event.clientX, event.clientY) ?? this.pageStack?.pageForTarget(event.target) ?? cellStart.page;
      const target = this.tableCellForHit(this.pageHitAt(event.clientX, event.clientY, page));
      if (!target || target.table.nodePath !== cellStart.tablePath) return;
      event.preventDefault(); this.suppressPageClick = true;
      setTimeout(() => { this.suppressPageClick = false; }, 0);
      void this.guard(async () => {
        await this.pageStack?.setActivePage(page);
        this.cellBlockSelection = {
          tablePath: cellStart.tablePath,
          anchor: { row: cellStart.row, col: cellStart.col },
          focus: { row: target.cell.row, col: target.cell.col },
        };
        this.updatePageSelectionOverlay(); this.updateStatus();
      });
      return;
    }
    const start = this.pageDragStart; this.pageDragStart = undefined;
    if (!start) return;
    const distance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
    if (distance < 3 && event.shiftKey) {
      const anchor = this.selectionAnchor;
      event.preventDefault(); this.suppressPageClick = true;
      setTimeout(() => { this.suppressPageClick = false; }, 0);
      void this.guardInput(async () => {
        const position = await this.selectPageTarget(event, undefined, undefined, true, start.page);
        const range = anchor && position && this.documentRange({ start: anchor, end: position });
        if (range && position && anchor && !this.rangeIsCollapsed(range)) this.setPageRangeSelection(range, position, anchor);
      });
      return;
    }
    if (distance < 3) return;
    const target = this.pageDragTargetAt(event, start);
    if (target?.block) {
      const { page, block } = target;
      event.preventDefault(); this.suppressPageClick = true;
      setTimeout(() => { this.suppressPageClick = false; }, 0);
      void this.guardInput(async () => {
        await this.pageStack?.setActivePage(page);
        await this.selectPageTarget(event, undefined, undefined, true, page);
        this.cellBlockSelection = block;
        this.updatePageSelectionOverlay(); this.updateToolState(); this.updateStatus();
      });
      return;
    }
    event.preventDefault(); this.suppressPageClick = true;
    setTimeout(() => { this.suppressPageClick = false; }, 0);
    void this.guardInput(async () => {
      const currentState = this.state;
      if (!currentState || currentState.revision !== start.revision || currentState.sessionId !== start.sessionId) return;
      const page = target?.page ?? this.pageStack?.pageAtPoint(event.clientX, event.clientY) ?? this.pageStack?.pageForTarget(event.target) ?? start.page;
      const [preciseStart, preciseEnd] = await Promise.all([
        start.pagePoint ? this.pageTextPositionAtPoint(start.page, start.pagePoint, start) : Promise.resolve(undefined),
        this.pageTextPositionAtClient(event.clientX, event.clientY, page, start),
      ]);
      const startPosition = preciseStart && sameDocumentAddress(preciseStart.address, start.paragraph.address)
        ? preciseStart : { address: start.paragraph.address, offset: start.offset };
      const targetEnd = target?.endPosition;
      const targetHitAddress = target?.hitAddress ?? targetEnd?.address;
      const endWasClamped = !!targetEnd && !!targetHitAddress && !sameDocumentAddress(targetEnd.address, targetHitAddress);
      const endPosition = !endWasClamped && preciseEnd
        ? preciseEnd : targetEnd ?? preciseEnd;
      const hitAddress = preciseEnd?.address ?? targetHitAddress ?? endPosition?.address;
      if (!endPosition || !hitAddress) return;
      const correctedStart = startPosition;
      const crossParagraphRange = this.documentRange({ start: correctedStart, end: endPosition });
      const sameParagraph = sameDocumentAddress(correctedStart.address, endPosition.address) && page === start.page;
      if (!sameParagraph && (!crossParagraphRange || this.rangeIsCollapsed(crossParagraphRange))) return;
      await this.pageStack?.setActivePage(page);
      let focus: TextPosition | undefined;
      const fixedEnd = !sameDocumentAddress(endPosition.address, hitAddress);
      if (fixedEnd) {
        this.mode = editingModeFor(endPosition.address); this.modeSelector.value = this.mode; this.items = this.itemsForMode(this.documentTree!);
        this.inlineEditorActive = true; this.restoreTextPosition(endPosition, true); focus = endPosition;
      } else focus = await this.selectPageTarget(event, sameParagraph ? correctedStart.offset : endPosition.offset, endPosition.offset, true, page);
      if (!focus) return;
      if (sameParagraph && !fixedEnd) {
        this.selectionAnchor = correctedStart;
        return;
      }
      const range = this.documentRange({ start: correctedStart, end: focus });
      if (range && !this.rangeIsCollapsed(range)) this.setPageRangeSelection(range, focus, correctedStart);
    });
  }
  /** Preview and release share the same cell/story boundary rules. */
  private pageDragTargetAt(event: PointerEvent, start: PageDragStart): {
    page: number; startPosition: TextPosition; endPosition: TextPosition; hitAddress: DocumentAddress; block?: CellBlockRange;
  } | undefined {
    const page = this.pageStack?.pageAtPoint(event.clientX, event.clientY) ?? this.pageStack?.pageForTarget(event.target) ?? start.page;
    const hit = this.pageHitAt(event.clientX, event.clientY, page);
    const hitPosition = hit ? this.textPositionForPageHit(hit) : undefined;
    if (!hit || !hitPosition || (hit.kind === 'tableCell' && !hit.paragraph)) return;
    const startPosition: TextPosition = { address: start.paragraph.address, offset: start.offset };
    let endPosition: TextPosition = hitPosition;
    const hitAddress = hitPosition.address;
    const startCell = startPosition.address.kind === 'body' && startPosition.address.cellPath?.length
      ? this.documentTree?.tables.flatMap(table => table.cells.map(cell => ({ table, cell })))
      .find(item => item.cell.paragraphs.some(paragraph => paragraph.nodePath === start.paragraph.nodePath))
      : undefined;
    const endCell = this.tableCellForHit(hit);
    if (startCell && endCell && startCell.table.nodePath === endCell.table.nodePath && startCell.cell.index !== endCell.cell.index) {
      return { page, startPosition, endPosition, hitAddress, block: { tablePath: startCell.table.nodePath,
        anchor: { row: startCell.cell.row, col: startCell.cell.col }, focus: { row: endCell.cell.row, col: endCell.cell.col } } };
    }
    const startRoot = startPosition.address.kind === 'body' && !startPosition.address.cellPath?.length;
    const endNested = endPosition.address.kind === 'body' && !!endPosition.address.cellPath?.length;
    if (startRoot && endNested) {
      const parent = this.documentTree?.paragraphs.find(paragraph => paragraph.section === endPosition.address.section && paragraph.paragraph === endPosition.address.paragraph);
      if (!parent) return;
      const forward = parent.section > startPosition.address.section || parent.section === startPosition.address.section && parent.paragraph >= startPosition.address.paragraph;
      endPosition = { address: parent.address, offset: forward ? parent.length : 0 };
    } else if (!startRoot && selectionContainerKey(startPosition.address) !== selectionContainerKey(endPosition.address)) {
      // A drag that started in a cell, text box or story stays inside it (plan §3.4.2): its end is clamped to that container's edge in the
      // drag direction. Without this the release fell through to a click outside and moved the caret out of the container.
      const forward = event.clientY > start.clientY || event.clientY === start.clientY && event.clientX >= start.clientX;
      const edge = this.selectionContainerEdge(startPosition.address, forward);
      if (!edge) return;
      endPosition = edge;
    }
    return { page, startPosition, endPosition, hitAddress };
  }
  /** The first or last position of the cell, text box or story that holds `address`. */
  private selectionContainerEdge(address: DocumentAddress, last: boolean): TextPosition | undefined {
    if (!this.documentTree) return undefined;
    const key = selectionContainerKey(address);
    const paragraphs = treeTextParagraphs(this.documentTree).filter(paragraph => selectionContainerKey(paragraph.address) === key)
      .sort((left, right) => selectionParagraphIndex(left.address) - selectionParagraphIndex(right.address));
    const edge = last ? paragraphs.at(-1) : paragraphs[0];
    return edge && { address: edge.address, offset: last ? edge.length : 0 };
  }
  private autoScrollPageSelection(event: PointerEvent): void {
    this.updateShapeDrawPreview(event);
    this.updateObjectDragPreview(event);
    this.updateTableResizePreview(event);
    if (!this.pageDragStart && !this.pageCellDragStart) return;
    const bounds = this.pageScroll.getBoundingClientRect();
    const edge = Math.min(48, bounds.height / 4);
    if (bounds.height && event.clientY < bounds.top + edge) this.pageScroll.scrollTop -= Math.max(4, Math.ceil((bounds.top + edge - event.clientY) / 3));
    else if (bounds.height && event.clientY > bounds.bottom - edge) this.pageScroll.scrollTop += Math.max(4, Math.ceil((event.clientY - (bounds.bottom - edge)) / 3));
    if (this.pageDragStart) {
      const target = this.pageDragTargetAt(event, this.pageDragStart);
      if (!target) return;
      const sameParagraph = sameDocumentAddress(target.startPosition.address, target.endPosition.address);
      const range = sameParagraph ? target.startPosition.offset <= target.endPosition.offset
        ? { start: target.startPosition, end: target.endPosition } : { start: target.endPosition, end: target.startPosition }
        : this.documentRange({ start: target.startPosition, end: target.endPosition });
      this.pageDragPreview = target.block ? { block: target.block }
        : { range };
    } else if (this.pageCellDragStart) {
      const start = this.pageCellDragStart;
      const page = this.pageStack?.pageAtPoint(event.clientX, event.clientY) ?? start.page;
      const target = this.tableCellForHit(this.pageHitAt(event.clientX, event.clientY, page));
      if (!target || target.table.nodePath !== start.tablePath) return;
      this.pageDragPreview = { block: { tablePath: start.tablePath, anchor: { row: start.row, col: start.col },
        focus: { row: target.cell.row, col: target.cell.col } } };
    }
    this.updatePageSelectionOverlay();
  }
  private onObjectKeydown(event: KeyboardEvent): void {
    if (event.target !== this.pageScroll || !this.selectedObject || this.draft || this.composing || this.formMode) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault(); void this.runEditorCommand('object.delete'); return;
    }
    const step = event.shiftKey ? 1000 : 100;
    const delta = event.key === 'ArrowLeft' ? [-step, 0] : event.key === 'ArrowRight' ? [step, 0]
      : event.key === 'ArrowUp' ? [0, -step] : event.key === 'ArrowDown' ? [0, step] : undefined;
    if (delta && this.selectedObject.kind === 'equation') return;
    if (!delta || !this.state || this.capabilityCheckPending || this.capabilitiesReadOnly()) return;
    const object = this.selectedObject, cached = this.pageLayouts.get(this.page);
    const control = cached?.revision === this.state.revision ? this.objectLayoutControl(cached.layout, object) : undefined;
    if (!control) return;
    event.preventDefault();
    const properties = objectPropertiesForDrag(object.properties as EditableObjectProperties ?? {}, control,
      'move', objectUnitsToCssPixels(delta[0]), objectUnitsToCssPixels(delta[1]));
    void this.guard(async () => {
      await this.execute([{ type: 'setObjectProperties', object: {
        address: object.address, controlIndex: object.controlIndex, kind: object.kind as 'picture' | 'shape' | 'equation',
      }, properties: properties as Extract<Command, { type: 'setObjectProperties' }>['properties'] }]);
      this.pageScroll.focus({ preventScroll: true });
    });
  }
  private setPageRangeSelection(range: SelectionRange, focus: TextPosition, anchor: TextPosition): void {
    if (!this.selected || !isParagraph(this.selected) || !sameDocumentAddress(this.selected.address, focus.address)) return;
    this.caretMoveSequence++;
    const offset = utf16OffsetFromCodePoint(this.textarea.value, focus.offset);
    this.textarea.setSelectionRange(offset, offset);
    const sameAddress = sameDocumentAddress(range.start.address, range.end.address);
    this.pageSelection = { address: focus.address, start: sameAddress ? range.start.offset : focus.offset,
      end: sameAddress ? range.end.offset : focus.offset, range, focus };
    this.selectionAnchor = anchor;
    this.updatePageSelectionOverlay(); this.updateToolState(); this.updateStatus();
  }
  private async collapsePageSelectionTo(edge: 'start' | 'end'): Promise<void> {
    const range = this.selectionRange(), tree = this.documentTree, state = this.state;
    if (!range || this.rangeIsCollapsed(range) || !tree || !state) return;
    const position = range[edge], context = this.captureContext(), revision = state.revision;
    const caret = await this.plugin.api.query.caret(context.path, position, { sessionId: state.sessionId, expectedRevision: revision });
    this.assertContext(context);
    const current = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (current.revision !== revision) throw new Error('문서가 이동 중 변경되어 선택을 접지 않았습니다.');
    const paragraph = this.paragraphForAddress(tree, caret.position.address);
    if (!paragraph) throw new Error('선택 끝의 문단을 현재 문서 구조에서 찾지 못했습니다. 다시 조회하세요.');
    const address = paragraph.address;
    this.mode = address.kind !== 'body' || address.containerKinds?.includes('textBox') ? 'stories'
      : address.cellPath?.length || address.containerKinds?.includes('tableCell') ? 'cells' : 'paragraphs';
    this.modeSelector.value = this.mode; this.items = this.itemsForMode(tree);
    const index = this.items.findIndex(item => isParagraph(item) && item.nodePath === paragraph.nodePath);
    if (index < 0) throw new Error('선택 끝의 문단이 현재 편집 목록에 없습니다.');
    this.state = current; this.page = Math.min(caret.rect.pageIndex, Math.max(0, current.pageCount - 1));
    await this.renderPage(true); this.assertContext(context);
    this.restoreTextPosition(caret.position, true);
    this.selectionAnchor = caret.position;
  }
  private selectPageTextAt(position: TextPosition, wholeParagraph: boolean): void {
    if (!this.selected || !isParagraph(this.selected) || !sameDocumentAddress(this.selected.address, position.address)) return;
    const length = Array.from(this.selected.text).length;
    let start = 0, end = length;
    if (!wholeParagraph) {
      const characters = Array.from(this.selected.text), index = Math.min(Math.max(0, position.offset === length ? length - 1 : position.offset), Math.max(0, length - 1));
      const isWord = (character: string | undefined): boolean => !!character && /[\p{L}\p{N}_]/u.test(character);
      if (!length || !isWord(characters[index])) return;
      start = index; end = index + 1;
      while (start > 0 && isWord(characters[start - 1])) start--;
      while (end < length && isWord(characters[end])) end++;
    }
    const range: SelectionRange = { start: { address: this.selected.address, offset: start }, end: { address: this.selected.address, offset: end } };
    this.setPageRangeSelection(range, range.end, range.start);
  }
  private pageHitAt(clientX: number, clientY: number, page = this.page): ReturnType<typeof hitTestPage> {
    const cached = this.pageLayouts.get(page), layout = cached?.layout, tree = this.documentTree, state = this.state;
    const element = this.pageStack?.pageElement(page);
    if (!layout || !tree || !state || cached?.revision !== state.revision || !element) return undefined;
    const bounds = element.getBoundingClientRect();
    const point = pagePointFromClient(clientX, clientY, bounds, layout.info);
    return point ? hitTestPage(layout, point.x, point.y, tree) : undefined;
  }
  private textPositionForPageHit(hit: NonNullable<ReturnType<typeof hitTestPage>> | HitTestResult): TextPosition | undefined {
    if (hit.kind !== 'paragraph' && hit.kind !== 'tableCell' && hit.kind !== 'field') return undefined;
    const localParagraph = 'paragraph' in hit ? hit.paragraph : undefined;
    const address = localParagraph?.address ?? ('address' in hit ? hit.address : undefined)
      ?? (hit.kind === 'field' && 'field' in hit ? hit.field?.address : undefined);
    if (!address || !this.documentTree) return undefined;
    const paragraph = localParagraph ?? this.paragraphForAddress(this.documentTree, address);
    if (!paragraph) return undefined;
    const offset = 'offset' in hit ? hit.offset : undefined;
    const safeOffset = typeof offset === 'number' && Number.isSafeInteger(offset) ? offset : 0;
    return { address: paragraph.address, offset: Math.min(paragraph.length, Math.max(0, safeOffset)) };
  }
  private async pageTextPositionAtPoint(page: number, point: { x: number; y: number }, expected?: Pick<PageDragStart, 'revision' | 'sessionId'>): Promise<TextPosition | undefined> {
    const state = this.state, tree = this.documentTree;
    if (!this.path || !state || !tree || (expected && (state.revision !== expected.revision || state.sessionId !== expected.sessionId))
      || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
    const context = this.captureContext();
    let hit: Awaited<ReturnType<typeof this.plugin.api.query.hitTest>>;
    try {
      hit = await this.plugin.api.query.hitTest(context.path, { page, x: point.x, y: point.y }, {
        sessionId: expected?.sessionId ?? state.sessionId, expectedRevision: expected?.revision ?? state.revision,
      });
    } catch { return undefined; }
    this.assertContext(context);
    if (this.state?.revision !== state.revision || !hit) return undefined;
    return this.textPositionForPageHit(hit);
  }
  private async pageTextPositionAtClient(clientX: number, clientY: number, page: number, expected?: Pick<PageDragStart, 'revision' | 'sessionId'>): Promise<TextPosition | undefined> {
    const cached = this.pageLayouts.get(page), layout = cached?.layout, state = this.state;
    const element = this.pageStack?.pageElement(page);
    if (!layout || !state || cached?.revision !== state.revision
      || (expected && (state.revision !== expected.revision || state.sessionId !== expected.sessionId)) || !element) return undefined;
    const point = pagePointFromClient(clientX, clientY, element.getBoundingClientRect(), layout.info);
    return point ? this.pageTextPositionAtPoint(page, point, expected) : undefined;
  }
  private selectionRectsQueryKey(range: SelectionRange): string | undefined {
    const state = this.state;
    if (!this.path || !state) return undefined;
    return `${this.path}\u0000${this.generation}\u0000${state.revision}\u0000${JSON.stringify(range)}`;
  }
  private preloadSelectionRects(): void {
    const range = this.selectionRange();
    const multiParagraph = !!range && !this.rangeIsCollapsed(range);
    const key = multiParagraph ? this.selectionRectsQueryKey(range) : undefined;
    if (key === this.selectionRectsKey) return;
    this.selectionRectsKey = key; this.selectionRectsCache = undefined;
    const sequence = ++this.selectionRectsSequence;
    if (!key || !range || !this.state) return;
    const context = this.captureContext(), state = this.state;
    void Promise.all(this.selectionSegments().map(segment => this.plugin.api.query.selectionRects(context.path, segment, { sessionId: state.sessionId, expectedRevision: state.revision }))).then(parts => {
      const rects = parts.flat();
      if (sequence !== this.selectionRectsSequence || this.selectionRectsKey !== key || this.generation !== context.generation
        || this.path !== context.path || this.state?.revision !== state.revision) return;
      this.selectionRectsCache = rects;
      this.updatePageSelectionOverlay();
    }).catch(() => { if (sequence === this.selectionRectsSequence) this.selectionRectsCache = undefined; });
  }
  private appendSelectionOverlay(page: HTMLElement, width: number, height: number, rects: readonly { x: number; y: number; width: number; height: number; caret?: boolean }[], search = false): void {
    if (!rects.length) return;
    const namespace = 'http://www.w3.org/2000/svg', overlay = page.ownerDocument.createElementNS(namespace, 'svg');
    overlay.classList.add('hwp-selection-overlay'); overlay.setAttribute('aria-hidden', 'true');
    if (search) overlay.classList.add('hwp-search-highlight');
    overlay.setAttribute('viewBox', `0 0 ${width} ${height}`); overlay.setAttribute('preserveAspectRatio', 'none');
    for (const rect of rects) {
      if (rect.caret) {
        const line = page.ownerDocument.createElementNS(namespace, 'line');
        line.classList.add('hwp-caret-line');
        line.setAttribute('x1', String(rect.x)); line.setAttribute('x2', String(rect.x + 1));
        line.setAttribute('y1', String(rect.y)); line.setAttribute('y2', String(rect.y + rect.height));
        line.setAttribute('stroke', '#3584e4'); line.setAttribute('stroke-width', '1.5');
        overlay.append(line);
      } else {
        const mark = page.ownerDocument.createElementNS(namespace, 'rect');
        if (!search) mark.classList.add('hwp-selection-mark');
        mark.setAttribute('x', String(rect.x)); mark.setAttribute('y', String(rect.y));
        mark.setAttribute('width', String(rect.width)); mark.setAttribute('height', String(rect.height));
        mark.setAttribute('fill', search ? '#ffb703' : '#5b9bff'); mark.setAttribute('fill-opacity', search ? '0.42' : '0.32');
        overlay.append(mark);
      }
    }
    page.append(overlay);
  }
  private appendHeaderFooterOverlays(): void {
    const selected = this.selected;
    if (!this.inlineEditorActive || !selected || !isParagraph(selected) || selected.address.kind !== 'headerFooter') return;
    const address = selected.address;
    for (const item of this.pageStack?.mountedPages() ?? []) {
      const cached = this.pageLayouts.get(item.page), layout = cached?.layout;
      if (!layout || cached?.revision !== this.state?.revision || !headerFooterPageApplies(address, layout.info)) continue;
      const area = address.isHeader ? layout.info.headerArea : layout.info.footerArea;
      if (!area || area.width <= 0 || area.height <= 0) continue;
      const namespace = 'http://www.w3.org/2000/svg', overlay = item.element.ownerDocument.createElementNS(namespace, 'svg');
      overlay.classList.add('hwp-selection-overlay', 'hwp-header-footer-overlay');
      overlay.setAttribute('aria-hidden', 'true'); overlay.setAttribute('viewBox', `0 0 ${layout.info.width} ${layout.info.height}`);
      overlay.setAttribute('preserveAspectRatio', 'none');
      const band = item.element.ownerDocument.createElementNS(namespace, 'rect');
      band.classList.add('hwp-header-footer-band'); band.setAttribute('x', String(area.x)); band.setAttribute('y', String(area.y));
      band.setAttribute('width', String(area.width)); band.setAttribute('height', String(area.height)); overlay.append(band);
      item.element.append(overlay);

    }
  }
  private objectLayoutControl(layout: PageLayout, object: DocumentObject) {
    if (object.address.kind !== 'body' || object.address.cellPath?.length) return undefined;
    const type = object.kind === 'picture' ? 'image' : object.kind === 'equation' ? 'equation' : object.kind === 'shape' ? 'shape' : undefined;
    return type ? layout.controls.find(control => control.type === type && control.section === object.address.section
      && control.paragraph === object.address.paragraph && control.controlIndex === object.controlIndex) : undefined;
  }
  private appendObjectSelectionOverlay(page: HTMLElement, layout: PageLayout, object: DocumentObject, preview?: ObjectRect): void {
    const control = this.objectLayoutControl(layout, object);
    if (!control || control.width <= 0 || control.height <= 0) return;
    const rect = preview ?? control;
    const namespace = 'http://www.w3.org/2000/svg', overlay = page.ownerDocument.createElementNS(namespace, 'svg');
    overlay.classList.add('hwp-selection-overlay', 'hwp-object-selection'); overlay.setAttribute('aria-hidden', 'false');
    overlay.setAttribute('viewBox', `0 0 ${layout.info.width} ${layout.info.height}`); overlay.setAttribute('preserveAspectRatio', 'none');
    const box = page.ownerDocument.createElementNS(namespace, 'rect');
    box.classList.add('hwp-object-selection-box');
    box.setAttribute('x', String(rect.x)); box.setAttribute('y', String(rect.y));
    box.setAttribute('width', String(rect.width)); box.setAttribute('height', String(rect.height));
    overlay.append(box);
    const screenScale = page.getBoundingClientRect().width / layout.info.width;
    const size = screenScale > 0 ? 8 / screenScale : 8;
    const half = size / 2, right = rect.x + rect.width, bottom = rect.y + rect.height;
    const centers: Record<Exclude<ObjectResizeHandle, 'move'>, [number, number]> = {
      nw: [rect.x, rect.y], n: [rect.x + rect.width / 2, rect.y], ne: [right, rect.y],
      e: [right, rect.y + rect.height / 2], se: [right, bottom], s: [rect.x + rect.width / 2, bottom],
      sw: [rect.x, bottom], w: [rect.x, rect.y + rect.height / 2],
    };
    const labels: Record<Exclude<ObjectResizeHandle, 'move'>, string> = {
      nw: '왼쪽 위', n: '위', ne: '오른쪽 위', e: '오른쪽', se: '오른쪽 아래', s: '아래', sw: '왼쪽 아래', w: '왼쪽',
    };
    const supportedHandles = object.kind === 'equation' ? ['e', 's', 'se'] as const
      : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
    for (const handle of supportedHandles) {
      const [x, y] = centers[handle];
      const grip = page.ownerDocument.createElementNS(namespace, 'rect');
      grip.classList.add('hwp-object-selection-handle'); grip.setAttribute('data-hwp-object-handle', handle);
      grip.setAttribute('x', String(x - half)); grip.setAttribute('y', String(y - half));
      grip.setAttribute('width', String(size)); grip.setAttribute('height', String(size));
      grip.setAttribute('role', 'button'); grip.setAttribute('aria-label', `${objectKindLabel(object)} 크기 조절: ${labels[handle]}`);
      grip.style.cursor = handle === 'n' || handle === 's' ? 'ns-resize'
        : handle === 'e' || handle === 'w' ? 'ew-resize'
          : handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize';
      overlay.append(grip);
    }
    page.append(overlay);
  }
  private updateObjectDragPreview(event: PointerEvent): void {
    const start = this.objectDragStart;
    if (!start || start.pointerId !== event.pointerId) return;
    const page = this.pageStack?.pageElement(start.page), cached = this.pageLayouts.get(start.page);
    const bounds = page?.getBoundingClientRect();
    if (!page || !bounds || !cached || cached.revision !== start.revision) return;
    const origin = pagePointFromClient(start.clientX, start.clientY, bounds, cached.layout.info);
    const current = pagePointFromClient(event.clientX, event.clientY, bounds, cached.layout.info);
    if (!origin || !current) return;
    const rect = objectRectAfterDrag(start.rect, start.handle, current.x - origin.x, current.y - origin.y, event.shiftKey);
    page.querySelector('.hwp-object-selection')?.remove();
    this.appendObjectSelectionOverlay(page, cached.layout, start.object, rect);
  }
  private appendTableCellResizeHandles(page: HTMLElement, layout: PageLayout, table: Table, cell: Table['cells'][number]): void {
    if (this.formMode || this.capabilityCheckPending || this.capabilitiesReadOnly()) return;
    const control = layout.controls.find(candidate => candidate.type === 'table' && candidate.section === table.section
      && candidate.paragraph === table.paragraph && candidate.controlIndex === table.control);
    const bounds = control?.cells?.find(candidate => candidate.cellIndex === cell.index);
    if (!bounds) return;
    const namespace = 'http://www.w3.org/2000/svg', overlay = page.ownerDocument.createElementNS(namespace, 'svg');
    overlay.classList.add('hwp-selection-overlay', 'hwp-table-resize-overlay'); overlay.setAttribute('aria-hidden', 'false');
    overlay.setAttribute('viewBox', `0 0 ${layout.info.width} ${layout.info.height}`); overlay.setAttribute('preserveAspectRatio', 'none');
    const screenScale = page.getBoundingClientRect().width / layout.info.width;
    const size = screenScale > 0 ? 12 / screenScale : 12, half = size / 2;
    const handles: Array<{ axis: TableResizeAxis; x: number; y: number; label: string; cursor: string }> = [
      { axis: 'width', x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2, label: `${cell.row + 1}행 ${cell.col + 1}열 너비`, cursor: 'ew-resize' },
      { axis: 'height', x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height, label: `${cell.row + 1}행 ${cell.col + 1}열 높이`, cursor: 'ns-resize' },
    ];
    for (const handle of handles) {
      const grip = page.ownerDocument.createElementNS(namespace, 'rect');
      grip.classList.add('hwp-table-resize-handle'); grip.setAttribute('data-hwp-table-resize', handle.axis);
      grip.setAttribute('data-hwp-table-path', table.nodePath); grip.setAttribute('data-hwp-table-row', String(cell.row));
      grip.setAttribute('data-hwp-table-col', String(cell.col)); grip.setAttribute('x', String(handle.x - half));
      grip.setAttribute('y', String(handle.y - half)); grip.setAttribute('width', String(size)); grip.setAttribute('height', String(size));
      grip.setAttribute('role', 'button'); grip.setAttribute('tabindex', '0'); grip.setAttribute('aria-label', `표 ${handle.label} 크기 조절`);
      grip.style.cursor = handle.cursor; overlay.append(grip);
    }
    page.append(overlay);
  }
  private updateTableResizePreview(event: PointerEvent): void {
    const start = this.tableResizeStart;
    if (!start || start.pointerId !== event.pointerId) return;
    const page = this.pageStack?.pageElement(start.page), cached = this.pageLayouts.get(start.page), bounds = page?.getBoundingClientRect();
    if (!page || !cached || !bounds || cached.revision !== start.revision) return;
    const tableControl = cached.layout.controls.find(candidate => candidate.type === 'table' && candidate.section === start.table.section
      && candidate.paragraph === start.table.paragraph && candidate.controlIndex === start.table.control);
    const cell = start.table.cells.find(candidate => candidate.row === start.row && candidate.col === start.col);
    const cellBounds = cell && tableControl?.cells?.find(candidate => candidate.cellIndex === cell.index);
    const point = pagePointFromClient(event.clientX, event.clientY, bounds, cached.layout.info);
    if (!cellBounds || !point) return;
    page.querySelector('.hwp-table-resize-guide')?.remove();
    const namespace = 'http://www.w3.org/2000/svg', guide = page.ownerDocument.createElementNS(namespace, 'svg');
    guide.classList.add('hwp-selection-overlay', 'hwp-table-resize-guide'); guide.setAttribute('aria-hidden', 'true');
    guide.setAttribute('viewBox', `0 0 ${cached.layout.info.width} ${cached.layout.info.height}`); guide.setAttribute('preserveAspectRatio', 'none');
    const line = page.ownerDocument.createElementNS(namespace, 'line');
    if (start.axis === 'width') {
      const x = cellBounds.x + cellBounds.width + (point.x - start.originX);
      line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x));
      line.setAttribute('y1', String(cellBounds.y)); line.setAttribute('y2', String(cellBounds.y + cellBounds.height));
    } else {
      const y = cellBounds.y + cellBounds.height + (point.y - start.originY);
      line.setAttribute('x1', String(cellBounds.x)); line.setAttribute('x2', String(cellBounds.x + cellBounds.width));
      line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
    }
    line.classList.add('hwp-table-resize-guide-line'); guide.append(line); page.append(guide);
  }
  private updateShapeDrawPreview(event: PointerEvent): void {
    const start = this.shapeDrawStart;
    if (!start || start.pointerId !== event.pointerId) return;
    const page = this.pageStack?.pageElement(start.page), cached = this.pageLayouts.get(start.page), bounds = page?.getBoundingClientRect();
    if (!page || !cached || !bounds || cached.revision !== start.revision) return;
    const point = pagePointFromClient(event.clientX, event.clientY, bounds, cached.layout.info);
    if (!point) return;
    page.querySelector('.hwp-shape-draw-preview')?.remove();
    const namespace = 'http://www.w3.org/2000/svg', overlay = page.ownerDocument.createElementNS(namespace, 'svg');
    overlay.classList.add('hwp-selection-overlay', 'hwp-shape-draw-preview'); overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('viewBox', `0 0 ${cached.layout.info.width} ${cached.layout.info.height}`); overlay.setAttribute('preserveAspectRatio', 'none');
    const left = Math.min(start.originX, point.x), top = Math.min(start.originY, point.y);
    const rect = page.ownerDocument.createElementNS(namespace, 'rect');
    rect.classList.add('hwp-shape-draw-preview-box'); rect.setAttribute('x', String(left)); rect.setAttribute('y', String(top));
    rect.setAttribute('width', String(Math.abs(point.x - start.originX))); rect.setAttribute('height', String(Math.abs(point.y - start.originY)));
    overlay.append(rect); page.append(overlay);
  }
  /** AI edits on this document that no person has looked through yet, where their positions are still known. */
  private currentEditMarks() { return this.path && this.state ? this.plugin.editMarks.current(this.path, this.state) : []; }
  private async revealNextEditMark(): Promise<void> {
    const marks = this.currentEditMarks();
    if (!marks.length) return;
    const mark = marks[this.editMarkCursor++ % marks.length];
    await this.revealPlace({ address: { ...mark.address, kind: 'body' } });
  }
  private appendEditMarks(mounted: ReadonlyArray<{ page: number; element: HTMLElement }>): void {
    const marks = this.currentEditMarks();
    if (!marks.length) return;
    const namespace = 'http://www.w3.org/2000/svg';
    for (const item of mounted) {
      const cached = this.pageLayouts.get(item.page);
      if (!cached || cached.revision !== this.state?.revision) continue;
      const rects = editMarkRects(cached.layout, marks);
      if (!rects.length) continue;
      const overlay = item.element.ownerDocument.createElementNS(namespace, 'svg');
      overlay.classList.add('hwp-selection-overlay', 'hwp-edit-marks'); overlay.setAttribute('aria-hidden', 'true');
      overlay.setAttribute('viewBox', `0 0 ${cached.layout.info.width} ${cached.layout.info.height}`); overlay.setAttribute('preserveAspectRatio', 'none');
      for (const rect of rects) {
        const mark = item.element.ownerDocument.createElementNS(namespace, 'rect');
        mark.classList.add('hwp-edit-mark');
        mark.setAttribute('x', String(rect.x)); mark.setAttribute('y', String(rect.y));
        mark.setAttribute('width', String(rect.width)); mark.setAttribute('height', String(rect.height));
        mark.setAttribute('fill', '#2ea043'); mark.setAttribute('fill-opacity', '0.2');
        overlay.append(mark);
      }
      item.element.append(overlay);
    }
  }
  /** Marks every match of the last search that lies on a mounted page (U8-01). The matches come from the engine; only their boxes are computed here. */
  private appendSearchHighlights(mounted: ReadonlyArray<{ page: number; element: HTMLElement }>): void {
    const entries = this.searchBrowser?.entries;
    if (!entries?.length || this.searchRevision < 0 || this.searchRevision !== this.state?.revision || this.findBarEl?.hidden) return;
    for (const item of mounted) {
      const cached = this.pageLayouts.get(item.page);
      if (!cached || cached.revision !== this.state.revision) continue;
      const rects = entries.flatMap(entry => {
        const target = entry.value;
        return target.start === undefined || target.end === undefined || target.end <= target.start ? []
          : layoutSelectionRects(cached.layout, target.address, target.start, target.end).filter(rect => !rect.caret);
      });
      this.appendSelectionOverlay(item.element, cached.layout.info.width, cached.layout.info.height, rects, true);
    }
  }
  private updatePageSelectionOverlay(syncEditorDuringDrag = false): void {
    const preview = this.pageDragPreview;
    // Callers that also need to place the input receiver do it here once, including during a drag.
    if (!preview || syncEditorDuringDrag) this.syncInlineEditor();
    if (!preview) {
      this.preloadSelectionCopy(); this.preloadSelectionRects();
    }
    const mounted = this.pageStack?.mountedPages() ?? [];
    for (const item of mounted) item.element.querySelectorAll('.hwp-selection-overlay').forEach(overlay => overlay.remove());
    this.appendSearchHighlights(mounted);
    this.appendEditMarks(mounted);
    this.appendHeaderFooterOverlays();
    const block = preview ? preview.block : this.cellBlockSelection;
    if (block) {
      const range = block;
      const table = this.documentTree?.tables.find(item => item.nodePath === range.tablePath);
      const selectedCells = table ? new Set(cellsInCellBlock(table, range).map(cell => cell.index)) : new Set<number>();
      for (const item of mounted) {
        const cached = this.pageLayouts.get(item.page);
        if (!cached || cached.revision !== this.state?.revision || !table) continue;
        const control = cached.layout.controls.find(candidate => candidate.type === 'table'
          && candidate.section === table.section && candidate.paragraph === table.paragraph && candidate.controlIndex === table.control);
        const rects = control?.cells?.filter(cell => selectedCells.has(cell.cellIndex))
          .map(cell => ({ x: cell.x, y: cell.y, width: cell.width, height: cell.height })) ?? [];
        this.appendSelectionOverlay(item.element, cached.layout.info.width, cached.layout.info.height, rects);
      }
    }
    if (!preview && this.selectedObject) for (const item of mounted) {
      const cached = this.pageLayouts.get(item.page);
      if (cached && cached.revision === this.state?.revision) this.appendObjectSelectionOverlay(item.element, cached.layout, this.selectedObject);
    }
    const selectedCell = this.selectedTableCell();
    if (!preview && selectedCell && !this.selectedObject) for (const item of mounted) {
      const cached = this.pageLayouts.get(item.page);
      if (cached && cached.revision === this.state?.revision) this.appendTableCellResizeHandles(item.element, cached.layout, selectedCell.table, selectedCell.cell);
    }
    if (preview) {
      // Cached character positions keep the drag synchronous; worker queries and the input receiver wait until release.
      const range = preview.range;
      if (!range) return;
      for (const item of mounted) {
        const cached = this.pageLayouts.get(item.page);
        if (!cached || cached.revision !== this.state?.revision) continue;
        const rects = layoutRangeSelectionRects(cached.layout, range);
        this.appendSelectionOverlay(item.element, cached.layout.info.width, cached.layout.info.height, rects);
      }
      return;
    }
    const selection = this.pageSelection, range = this.selectionRange();
    if (!selection || !range) return;
    if (!this.rangeIsCollapsed(range)) {
      const key = this.selectionRectsQueryKey(range);
      if (!key || key !== this.selectionRectsKey || !this.selectionRectsCache) return;
      for (const item of mounted) {
        const layout = this.pageLayouts.get(item.page);
        if (!layout || layout.revision !== this.state?.revision) continue;
        this.appendSelectionOverlay(item.element, layout.layout.info.width, layout.layout.info.height,
          this.selectionRectsCache.filter(rect => rect.pageIndex === item.page));
      }
      return;
    }
    if (this.draft || this.composing) return; // The preview supplies the draft caret.
    const rect = this.directCaret && this.directCaret.key === this.directCaretKey ? this.directCaret.rect : undefined;
    const host = rect && this.pageStack?.pageElement(rect.pageIndex), cached = rect && this.pageLayouts.get(rect.pageIndex);
    if (rect && host && cached && cached.revision === this.state?.revision) {
      this.appendSelectionOverlay(host, cached.layout.info.width, cached.layout.info.height, [{ ...rect, width: 0, caret: true }]);
      return;
    }
    const layout = this.pageLayout;
    if (!layout || this.pageLayoutRevision !== this.state?.revision || !this.pageEl) return;
    this.appendSelectionOverlay(this.pageEl, layout.info.width, layout.info.height,
      layoutSelectionRects(layout, selection.address, selection.start, selection.end));
  }
  /**
   * Moving or disabling a focused textarea blurs it. Every re-render that re-parents the inline editor (after Enter splits a paragraph, a
   * merge, a cell move...) would otherwise leave the focus on <body> and the next typed character would go nowhere. While the page layout
   * is not ready the editor waits in its hidden home element; the focus it had is remembered and given back as soon as it is placed on
   * the page and enabled again.
   */
  private placeTextarea(parent: HTMLElement): void {
    const textarea = this.textarea, owner = textarea.ownerDocument;
    if (!this.textareaFocusTracked) {
      this.textareaFocusTracked = true;
      // A blur the user causes (clicking elsewhere, Tab to another control) cancels the remembered focus; our own moves do not.
      textarea.addEventListener('focusout', () => { if (!this.placingTextarea) this.refocusTextarea = false; });
    }
    const hadFocus = owner.activeElement === textarea;
    if (hadFocus) this.refocusTextarea = true;
    const start = textarea.selectionStart, end = textarea.selectionEnd, direction = textarea.selectionDirection;
    if (textarea.parentElement !== parent) {
      this.placingTextarea = true;
      try { parent.append(textarea); } finally { this.placingTextarea = false; }
    }
    if (this.refocusIfWanted() && hadFocus) {
      try { textarea.setSelectionRange(start, end, direction ?? undefined); } catch { /* the textarea cannot hold a selection right now */ }
    }
  }
  /** Gives the remembered focus back once the editor is on the page and enabled. Returns whether it took the focus. */
  private refocusIfWanted(): boolean {
    const textarea = this.textarea;
    if (!this.refocusTextarea || !textarea?.isConnected || textarea.disabled || textarea.parentElement === this.textareaHome) return false;
    if (textarea.ownerDocument.activeElement === textarea) { this.refocusTextarea = false; return false; }
    textarea.focus({ preventScroll: true });
    if (textarea.ownerDocument.activeElement !== textarea) return false;
    this.refocusTextarea = false;
    return true;
  }
  /** Where the inline editor of a click-here field goes: at the field's start in its paragraph, as wide as the value or the guide text. */
  private fieldEditorBounds(layout: PageLayout, field: Field): { x: number; y: number; width: number; height: number } | undefined {
    const address = field.address;
    if (!address) return undefined;
    const start = typeof field.startCharIdx === 'number' ? Math.max(0, field.startCharIdx) : 0;
    const end = typeof field.endCharIdx === 'number' ? Math.max(start, field.endCharIdx) : start;
    const caret = layoutSelectionRects(layout, address, start, start)[0];
    if (!caret) return undefined;
    const value = end > start ? layoutSelectionRects(layout, address, start, end).filter(rect => !rect.caret) : [];
    const valueWidth = value.reduce((sum, rect) => sum + rect.width, 0);
    return { x: caret.x, y: caret.y, width: Math.max(valueWidth, 120), height: Math.max(caret.height, 1) };
  }
  private syncInlineEditor(): void {
    if (!this.textarea || !this.textareaHome) return;
    this.inlineEditorLineCount = 1 + (this.textarea.value.match(/[\n\u2028]/g)?.length ?? 0);
    this.contentEl.addClass('hwp-direct-input-enabled');
    const layout = this.pageLayout, selected = this.selected;
    let bounds = layout && selected && isParagraph(selected) && this.inlineEditorActive
      && this.pageLayoutRevision === this.state?.revision ? layoutParagraphBounds(layout, selected.address) : undefined;
    if (!bounds && layout && selected && isParagraph(selected) && this.inlineCellSelection?.paragraphPath === selected.nodePath && this.documentTree) {
      const table = this.documentTree.tables.find(item => item.nodePath === this.inlineCellSelection!.tablePath);
      const control = table && layout.controls.find(item => item.type === 'table' && item.section === table.section && item.paragraph === table.paragraph && item.controlIndex === table.control);
      const cell = control?.cells?.find(item => item.cellIndex === this.inlineCellSelection!.cellIndex);
      if (cell) bounds = { x: cell.x + 4, y: cell.y + 4, width: Math.max(1, cell.width - 8), height: Math.max(1, cell.height - 8) };
    }
    if (!bounds && layout && selected && !isParagraph(selected) && this.inlineEditorActive && this.pageLayoutRevision === this.state?.revision) {
      bounds = this.fieldEditorBounds(layout, selected);
    }
    if (!bounds || !layout || !selected) {
      if (!this.draft && !this.composing && !this.inputLocks) this.editingPreview.clear();
      this.placeTextarea(this.textareaHome); this.textarea.classList.remove('hwp-inline-editor', 'hwp-input-receiver');
      for (const property of ['position', 'left', 'top', 'width', 'height', 'min-height', 'max-height', 'resize', 'box-sizing', 'padding', 'border', 'background', 'z-index', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'color', 'text-decoration', 'overflow', 'box-shadow', 'caret-color', '-webkit-text-fill-color', 'pointer-events']) this.textarea.style.removeProperty(property);
      return;
    }
    this.syncDirectInput(layout, selected, bounds);
  }
  private preloadDirectCaret(position: TextPosition): void {
    if (!this.state || this.draft || this.composing) return;
    const state = this.state, context = this.captureContext();
    const key = `${context.path}:${context.generation}:${state.sessionId}:${state.revision}:${JSON.stringify(position)}`;
    if (key === this.directCaretKey) return;
    this.directCaretKey = key; this.directCaret = undefined;
    const sequence = ++this.directCaretSequence;
    void this.plugin.api.query.caret(context.path, position, { sessionId: state.sessionId, expectedRevision: state.revision }, { pageHint: this.page }).then(result => {
      if (sequence !== this.directCaretSequence || this.path !== context.path || this.generation !== context.generation || this.state?.revision !== state.revision) return;
      this.directCaret = { key, rect: result.rect };
      this.updatePageSelectionOverlay(true);
    }).catch(() => { if (sequence === this.directCaretSequence) this.directCaret = undefined; });
  }
  private syncDirectInput(layout: PageLayout, selected: TextParagraph | Field, bounds: { x: number; y: number; width: number; height: number }): void {
    if (!this.pageEl) return;
    const address = selected.address;
    if (!address) return;
    const value = this.directComposition ? compositionPreview(this.directComposition.baseText, this.directComposition.start, this.directComposition.end, this.directComposition.text)
      : { text: this.textarea.value };
    const caretUtf16 = this.directComposition ? this.directComposition.start + this.directComposition.text.length : this.textarea.selectionEnd;
    const offset = codePointOffsetFromUtf16(value.text, caretUtf16);
    const position: TextPosition = this.pageSelection?.focus ?? { address, offset };
    this.preloadDirectCaret(position);
    const runs = layout.textRuns.filter(run => { const runAddress = run.documentAddress ?? run.address; return !!runAddress && sameDocumentAddress(runAddress, address); });
    const run = runs.find(run => offset >= (run.offset ?? run.charStart ?? 0) && offset <= (run.offset ?? run.charStart ?? 0) + Array.from(run.text).length) ?? runs[0];
    const fontSize = run?.fontSize ?? 14;
    const fallback: CharacterProperties = { fontSize, fontFamily: run?.fontFamily, bold: run?.bold, italic: run?.italic,
      underline: run?.underline, strikethrough: run?.strikethrough, textColor: run?.textColor };
    const formatting = this.formattingModel?.paragraphs.find(paragraph => sameDocumentAddress(paragraph.address, address));
    const column = layout.info.columns.find(column => bounds.x >= column.x && bounds.x < column.x + column.width);
    let flowWidth = Math.max(bounds.width, (column ? column.x + column.width : layout.info.bodyRight) - bounds.x);
    if (!isParagraph(selected) || address.kind !== 'body' || address.cellPath?.length) flowWidth = Math.max(bounds.width, 120);
    if (isParagraph(selected) && this.inlineCellSelection && this.documentTree) {
      const table = this.documentTree.tables.find(table => table.nodePath === this.inlineCellSelection!.tablePath);
      const control = table && layout.controls.find(control => control.type === 'table' && control.section === table.section && control.paragraph === table.paragraph && control.controlIndex === table.control);
      const cell = control?.cells?.find(cell => cell.cellIndex === this.inlineCellSelection!.cellIndex);
      if (cell) flowWidth = Math.max(1, cell.x + cell.width - bounds.x - 4);
    }
    flowWidth = Math.max(1, Math.min(layout.info.width - bounds.x, flowWidth));
    let rect: CaretRect | undefined;
    if ((this.draft || this.composing) && this.plugin.settings.editPreviewEnabled) {
      const baseText = isParagraph(selected) ? editorTextFromModel(selected.text) : selected.value;
      const characterRuns = isParagraph(selected) ? formatting?.characterRuns ?? [] : [];
      const spans = previewSpans(baseText, value.text, characterRuns, fallback, this.pendingCaretProperties);
      const ys = [...new Set(runs.map(run => run.y))].sort((a,b)=>a-b);
      const paragraph = formatting?.properties;
      const percent = paragraph?.lineSpacingType === 'Percent' && typeof paragraph.lineSpacing === 'number' ? paragraph.lineSpacing : undefined;
      const lineHeight = ys.length > 1 ? Math.max(1, ys[1] - ys[0]) : Math.max(percent ? fontSize * percent / 100 : fontSize * 1.2, bounds.height);
      // Lines the edit does not touch keep the engine's rendering: reflowing them in the browser moves text whenever
      // the two disagree on a break. Only the edited lines are redrawn; see EditingPreview for the lines below.
      const before = Array.from(baseText), after = Array.from(value.text), lines = previewLines(isParagraph(selected) ? runs : []);
      const utf16 = (count: number) => before.slice(0, count).join('').length;
      const mask = (run: (typeof runs)[number]) =>({ x: run.x - 1, y: run.y - 1, width: run.w + 2, height: run.h + 2 });
      let { first, last } = previewSegment(lines, before, after, offset);
      let cut = first > 0 ? utf16(lines[first].start) : 0;
      if (cut > Math.min(caretUtf16, value.composition?.start ?? caretUtf16)) { cut = 0; first = 0; }
      if (!lines.length) last = -1;
      const stop = last >= lines.length - 1 ? value.text.length : value.text.length - (baseText.length - utf16(lines[last].end));
      const segment = lines.slice(first, last + 1), top = segment[0], bottom = segment.at(-1), left = Math.min(...segment.map(line => line.x));
      const segmentBounds = top && bottom ? { x: left, y: top.y, width: Math.max(1, Math.max(...segment.map(line => line.right)) - left),
        height: Math.max(1, bottom.y + bottom.height - top.y) } : bounds;
      const flow = previewFlow({ bounds: segmentBounds, fallbackWidth: flowWidth + bounds.x - segmentBounds.x, paragraph, lineCount: Math.max(1, segment.length),
        startsParagraph: first === 0 && (!lines.length || lines[0].start === 0),
        column: isParagraph(selected) && address.kind === 'body' && !address.cellPath?.length && !this.inlineCellSelection ? column : undefined,
        lineHeight, firstLineHeight: top?.height ?? fontSize });
      const baseSpans = lines.length ? previewSpans(baseText, baseText, characterRuns, fallback) : [];
      const lineSpans = (line: (typeof lines)[number]) => sliceSpans(baseSpans, utf16(line.start), utf16(line.end));
      const longest = lines.reduce<(typeof lines)[number] | undefined>((found, line) => !found || line.end - line.start > found.end - found.start ? line : found, undefined);
      const sample = top && top.end - top.start >= 8 ? top : longest, sampleSpans = sample ? lineSpans(sample) : [];
      this.editingPreview.mount(this.pageEl, { page: this.page, width: layout.info.width, height: layout.info.height,
        bounds: flow.bounds, paddingLeft: flow.paddingLeft, textIndent: flow.textIndent,
        masks: isParagraph(selected) ? segment.flatMap(line => line.runs).map(mask) : [bounds],
        spans: sliceSpans(spans, cut, stop), caret: caretUtf16 - cut, composition: value.composition && { start: value.composition.start - cut, end: value.composition.end - cut }, lineHeight, paragraph,
        // Leave a pixel and a half so rounding cannot push a full line over the edge and wrap it at once.
        fit: sample && !sampleSpans.some(span => Array.from(span.text).some(character => character < ' ')) ? { spans: sampleSpans, width: sample.right - sample.x - 1.5 } : undefined,
        segmentLines: Math.max(1, segment.length),
        below: lines.slice(last + 1).map(line => ({ x: line.x, width: line.right - line.x, spans: lineSpans(line), masks: line.runs.map(mask) })) });
      rect = this.editingPreview.caretRect(this.pageEl);
    } else this.editingPreview.clear();
    rect ??= this.directCaret && this.directCaret.key === this.directCaretKey ? this.directCaret.rect : undefined;
    if (!rect || rect.pageIndex !== this.page) {
      const fallbackRect = layoutSelectionRects(layout, address, Math.min(isParagraph(selected) ? selected.length : offset, offset), Math.min(isParagraph(selected) ? selected.length : offset, offset))[0];
      rect = { pageIndex: this.page, x: fallbackRect?.x ?? bounds.x, y: fallbackRect?.y ?? bounds.y, height: fallbackRect?.height ?? fontSize * 1.2 };
    }
    const lineReceiver = this.plugin.settings.inputReceiverPlacement === 'line';
    this.textarea.classList.add('hwp-inline-editor', 'hwp-input-receiver');
    Object.assign(this.textarea.style, { position: 'absolute', left: `${(lineReceiver ? bounds.x : rect.x) / layout.info.width * 100}%`,
      top: `${rect.y / layout.info.height * 100}%`, width: lineReceiver ? `${flowWidth / layout.info.width * 100}%` : '1px', height: `${Math.max(1, rect.height) / layout.info.height * 100}%`,
      minHeight: '0', maxHeight: 'none', resize: 'none', padding: '0', margin: '0', border: '0', outline: '0', background: 'transparent',
      color: 'transparent', caretColor: 'transparent', boxShadow: 'none', overflow: 'hidden', pointerEvents: 'none', zIndex: '4',
      fontFamily: run?.fontFamily ?? 'inherit', fontSize: `${fontSize / layout.info.width * 100}cqw`, lineHeight: '1', textDecoration: 'none' });
    this.placeTextarea(this.pageEl);
  }
  private restoreTextPosition(position: TextPosition, focus = false): void {
    const index = this.items.findIndex(item => isParagraph(item) && sameDocumentAddress(item.address, position.address));
    if (index < 0) return;
    this.selectItem(index, this.inlineEditorActive);
    if (!this.selected || !isParagraph(this.selected)) return;
    const offset = utf16OffsetFromCodePoint(this.textarea.value, position.offset);
    this.textarea.setSelectionRange(offset, offset);
    this.pageSelection = { address: this.selected.address, start: position.offset, end: position.offset };
    this.updatePageSelectionOverlay();
    if (focus) this.textarea.focus({ preventScroll: true });
    this.updateStatus();
  }
  private async pasteHtmlAtSelection(html: string): Promise<void> {
    if (!this.selected || !isParagraph(this.selected) || this.selected.address.kind !== 'body' || this.selected.address.containerKinds?.includes('textBox')) throw new Error('서식 있는 붙여넣기는 본문 또는 표 셀에서만 지원합니다.');
    const selected = structuredClone(this.selected);
    const textareaRange: SelectionRange = {
      start: positionAfterEditorText(selected.address, this.textarea.value, this.textarea.selectionStart),
      end: positionAfterEditorText(selected.address, this.textarea.value, this.textarea.selectionEnd),
    };
    const range = this.selectionRange() ?? textareaRange;
    const orderedRootRange = this.editableSelectionRange(range);
    const sameParagraph = sameDocumentAddress(range.start.address, selected.address)
      && sameDocumentAddress(range.start.address, range.end.address);
    if (!sameParagraph && !orderedRootRange) throw new Error('HTML 붙여넣기는 한 문단 또는 같은 구역 본문 선택에서만 지원합니다.');
    const ordered = orderedRootRange ?? range;
    const start = ordered.start, end = ordered.end;
    const deletion: Extract<Command, { type: 'deleteRange' }> | undefined = !this.rangeIsCollapsed(ordered) ? { type: 'deleteRange', start, end } : undefined;
    const commands: Command[] = [...(deletion ? [deletion] : []), { type: 'pasteHtml', target: start.address, offset: start.offset, html }];
    const position: TextPosition = { address: start.address, offset: start.offset };
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    try { await this.execute(commands, position, true); }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
      if (code !== 'CONTENT_LOSS' || !deletion) throw error;
      const confirmed = await new Promise<boolean>(resolve => new ConfirmAnchoredDelete(this.app, resolve).open());
      if (!confirmed) return;
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('확인 중 문서가 변경되었습니다. 다시 선택한 뒤 붙여넣으세요.');
      await this.execute(commands.map(command => command.type === 'deleteRange' ? { ...command, deleteAnchoredContent: true } : command), position, true);
    }
  }
  private async deleteSelectedRange(): Promise<void> {
    if (this.composing) throw new Error('문자 조합을 마친 뒤 선택 영역을 삭제하세요.');
    if (!this.selected || !isParagraph(this.selected)) return;
    const selected = structuredClone(this.selected);
    const textareaRange: SelectionRange = {
      start: positionAfterEditorText(selected.address, this.textarea.value, this.textarea.selectionStart),
      end: positionAfterEditorText(selected.address, this.textarea.value, this.textarea.selectionEnd),
    };
    const range = this.selectionRange() ?? textareaRange, orderedRootRange = this.editableSelectionRange(range);
    const sameParagraph = sameDocumentAddress(range.start.address, selected.address)
      && sameDocumentAddress(range.start.address, range.end.address);
    if (!sameParagraph && !orderedRootRange) throw new Error('선택한 범위는 한 문단 또는 같은 구역 본문 안에서만 삭제할 수 있습니다.');
    const ordered = orderedRootRange ?? range, start = ordered.start, end = ordered.end;
    if (this.rangeIsCollapsed(ordered)) return;
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const safeDelete: Command = { type: 'deleteRange', start, end };
    try {
      await this.execute([safeDelete], start, true);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code : undefined;
      if (code !== 'CONTENT_LOSS') throw error;
      const confirmed = await new Promise<boolean>(resolve => new ConfirmAnchoredDelete(this.app, resolve).open());
      if (!confirmed) return;
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('확인 중 문서가 변경되었습니다. 범위를 다시 선택한 뒤 삭제하세요.');
      await this.execute([{ ...safeDelete, deleteAnchoredContent: true }], start, true);
    }
  }
  private async mergeAtBoundary(direction: 'backward' | 'forward'): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 문단을 병합하세요.');
    if (!this.selected || !isParagraph(this.selected)) return;
    if (this.draft && this.textarea.value.includes('\n')) {
      await this.applyDraft(true);
      return this.mergeAtBoundary(direction);
    }
    const selected = structuredClone(this.selected), value = this.draft ? this.textarea.value : selected.text;
    const sibling = siblingAddress(selected.address, direction === 'backward' ? -1 : 1);
    const neighbor = sibling && this.documentTree ? paragraphAtAddress(this.documentTree, sibling) : undefined;
    if (!neighbor) throw new Error(direction === 'backward' ? '이 영역의 첫 문단 앞에는 병합할 문단이 없습니다.' : '이 영역의 마지막 문단 뒤에는 병합할 문단이 없습니다.');
    if (isTextboxParagraph(selected) || isTextboxParagraph(neighbor)) throw new Error('글상자의 별도 문단 병합은 현재 엔진에서 지원하지 않습니다. 줄바꿈 문자는 입력란에서 삭제하세요.');
    const mergeTarget = direction === 'backward' ? selected.address : neighbor.address;
    const after: TextPosition = direction === 'backward'
      ? { address: neighbor.address, offset: neighbor.length }
      : { address: selected.address, offset: Array.from(value).length };
    const merge: Command = { type: 'mergeParagraph', target: mergeTarget };
    if (this.draft) {
      const snapshot = this.captureDraftApplySnapshot();
      await this.applyDraftSnapshot(snapshot, false, [merge], after, true);
    } else await this.execute([merge], after, true);
  }
  private feature<T extends HTMLElement>(element: T, name: string): T {
    element.dataset.hwpFeature = name;
    return element;
  }
  private toolButton(parent: HTMLElement, label: string, feature: string, action: () => Promise<unknown> | void): HTMLButtonElement {
    return this.feature(this.button(parent, label, action), feature);
  }
  private refreshHistoryButtons(): void {
    for (const button of this.historyButtons) {
      const id = button.dataset.command!, command = this.commandRegistry.get(id), available = this.commandRegistry.isAvailable(id);
      const label = command?.label ?? id;
      button.disabled = !available;
      button.setAttribute('aria-label', label);
      button.title = available ? `${label}${command?.shortcut ? ` (${command.shortcut})` : ''}`
        : command?.unavailableReason?.() || `${label} 명령을 현재 상태에서 사용할 수 없습니다.`;
    }
  }
  private toolDetails(parent: HTMLElement, title: string): HTMLElement {
    const details = parent.createEl('details', { cls: 'hwp-tool-group' });
    details.createEl('summary', { text: title });
    return details.createDiv({ cls: 'hwp-tool-content' });
  }
  private selectedTableCell(): { table: Table; cell: Table['cells'][number] } | undefined {
    if (!this.selected || !isParagraph(this.selected) || this.selected.address.kind !== 'body') return undefined;
    const address = this.selected.address, step = address.cellPath?.[0];
    if (!step || address.cellPath?.length !== 1) return undefined;
    const table = this.documentTree?.tables.find(item => item.section === address.section && item.paragraph === address.paragraph && item.control === step.controlIndex && !item.cellPath?.length);
    const cell = table?.cells.find(item => item.index === step.cellIndex);
    return table && cell ? { table, cell } : undefined;
  }
  private async moveToAdjacentTableCell(direction: -1 | 1): Promise<void> {
    const current = this.selectedTableCell();
    if (!current) return;
    const cells = [...current.table.cells].sort((left, right) => left.row - right.row || left.col - right.col);
    const index = cells.findIndex(cell => cell.index === current.cell.index), next = cells[index + direction];
    const paragraph = next?.paragraphs[0];
    if (!next || !paragraph) return;
    await this.jumpToNavigationTarget({
      kind: 'paragraph', label: `표 ${current.table.rows}×${current.table.cols} · ${next.row + 1}행 ${next.col + 1}열`,
      filterText: '', address: paragraph.address, nodePath: paragraph.nodePath,
      cell: { tablePath: current.table.nodePath, cellIndex: next.index },
    });
  }
  private async moveToTableCellCaret(paragraph: Table['cells'][number]['paragraphs'][number], offset: number): Promise<void> {
    const owner = this.selectedTableCell()?.table;
    const cell = owner?.cells.find(item => item.paragraphs.some(candidate => candidate.nodePath === paragraph.nodePath));
    await this.jumpToNavigationTarget({
      kind: 'paragraph', label: '표 셀 캐럿 이동', filterText: '', address: paragraph.address, nodePath: paragraph.nodePath,
      ...(owner && cell ? { cell: { tablePath: owner.nodePath, cellIndex: cell.index } } : {}),
    });
    if (!this.selected || !isParagraph(this.selected)) return;
    const caret = Math.min(this.selected.length, offset);
    const utf16Offset = utf16OffsetFromCodePoint(this.textarea.value, caret);
    this.textarea.setSelectionRange(utf16Offset, utf16Offset);
    this.pageSelection = { address: this.selected.address, start: caret, end: caret };
    this.selectionAnchor = { address: this.selected.address, offset: caret };
    this.preferredCaretX = undefined;
    this.updatePageSelectionOverlay(); this.updateToolState(); this.updateStatus();
    this.textarea.focus({ preventScroll: true });
  }
  private selectedParagraphFormatting(): FormattingModel['paragraphs'][number] | undefined {
    const paragraphs = this.selectedFormattingParagraphs();
    if (!paragraphs.length) return undefined;
    const properties: ParagraphProperties = {};
    const keys = new Set(paragraphs.flatMap(paragraph => Object.keys(paragraph.properties ?? {})));
    for (const key of keys) {
      if (this.toolFormatting?.expired) return undefined;
      const value = uniformValue(paragraphs.map(paragraph => paragraph.properties?.[key as keyof ParagraphProperties]));
      if (value !== undefined) Object.assign(properties, { [key]: value });
    }
    return { ...paragraphs[0], properties, style: uniformValue(paragraphs.map(paragraph => paragraph.style)) };
  }
  private updateToolState(): void {
    const previous = this.toolFormatting;
    this.toolFormatting = this.newSelectionFormattingContext() ?? previous;
    try { this.updateToolStateWithinBudget(); }
    finally { this.toolFormatting = previous; }
  }
  private newSelectionFormattingContext(milliseconds?: number): SelectionFormattingContext | undefined {
    if (!this.formattingModel) return undefined;
    const block = this.cellBlockSelection;
    const table = block && this.documentTree?.tables.find(item => item.nodePath === block.tablePath);
    const whole = block && table ? cellsInCellBlock(table, block).flatMap(cell => cell.paragraphs.map(paragraph => paragraph.address)) : [];
    return new SelectionFormattingContext(this.formattingModel, whole.length ? [] : this.selectionSegments(), whole, milliseconds);
  }
  /**
   * Command availability checks in one toolbar refresh share a selection scan, as updateToolState does. Each check used to scan on
   * its own and always to the end, so the shared scan has no deadline: it never reports a command unknown that was decided before.
   */
  private withSelectionFormatting(action: () => void): void {
    if (this.toolFormatting) { action(); return; }
    this.toolFormatting = this.newSelectionFormattingContext(Infinity);
    try { action(); }
    finally { this.toolFormatting = undefined; }
  }
  private updateToolStateWithinBudget(): void {
    if (!this.toolReasonEl || !this.contentEl) return;
    if (this.composing) {
      if (!this.draftToolsLocked) {
        for (const control of this.contentEl.querySelectorAll<HTMLElement>('[data-hwp-feature]')) {
          if ('disabled' in control) (control as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = true;
        }
        this.draftToolsLocked = true;
      }
      this.toolReasonEl.setText(this.composing
        ? '한글 조합이 끝날 때까지 모든 문서 명령을 사용할 수 없습니다.'
        : '미적용 입력을 적용하거나 취소한 뒤 도구를 사용하세요.');
      return;
    }
    this.draftToolsLocked = false;
    const selected = this.selected, paragraph = selected && isParagraph(selected) ? selected : undefined;
    const address = paragraph?.address;
    const rootBody = address?.kind === 'body' && !address.cellPath?.length && !address.containerKinds?.includes('textBox');
    const nestedCell = address?.kind === 'body' && (address.cellPath?.length ?? 0) > 1;
    const textBox = paragraph ? isTextboxParagraph(paragraph) : false;
    const field = selected && !isParagraph(selected);
    const tableCell = this.selectedTableCell();
    const object = this.selectedObject;
    const objectRoot = !!object && object.address.kind === 'body' && !object.address.cellPath?.length && ['picture', 'shape', 'equation'].includes(object.kind);
    const readOnly = this.capabilitiesReadOnly();
    const multiParagraphSelection = this.hasMultiParagraphSelection();
    const canMutate = !this.formMode && !this.composing && !this.capabilityCheckPending && !this.inputLocks && !this.saving && !readOnly;
    const enabled: Record<string, boolean> = {
      text: !this.formattingReason({ character: {} }),
      paragraph: !this.formattingReason({ paragraph: {} }),
      style: !this.formattingReason({ styleId: 0 }),
      list: !this.formattingReason({ list: { kind: 'none' } }),
      createTable: !!rootBody,
      table: !!tableCell,
      objectInsert: !!rootBody,
      noteInsert: !!rootBody,
      objectEdit: objectRoot,
      page: !!this.formattingModel?.sections.length,
      field: !!field,
    };
    for (const control of this.contentEl.querySelectorAll<HTMLElement>('[data-hwp-feature]')) {
      const name = control.dataset.hwpFeature ?? '';
      if ('disabled' in control) (control as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = !canMutate || !enabled[name]
        || !!this.draft && !['text', 'paragraph', 'style', 'list'].includes(name);
    }
    if (this.applyCopiedStyleButton) {
      this.applyCopiedStyleButton.disabled = !canMutate || !enabled.text || !enabled.paragraph || !this.copiedFormat;
      this.applyCopiedStyleButton.title = this.copiedFormat ? '' : '먼저 모양을 복사하세요.';
    }
    this.equationScriptInput.disabled = !canMutate || !(rootBody || objectRoot && object?.kind === 'equation');
    if (this.listLevelDownButton) {
      this.listLevelDownButton.disabled = !this.canChangeListLevel(-1);
      this.listLevelDownButton.title = this.listLevelDownButton.disabled ? this.listLevelReason(-1) : '';
    }
    if (this.listLevelUpButton) {
      this.listLevelUpButton.disabled = !this.canChangeListLevel(1);
      this.listLevelUpButton.title = this.listLevelUpButton.disabled ? this.listLevelReason(1) : '';
    }
    const listToggleReason = this.listToggleReason();
    for (const [button, kind] of [[this.numberingToggleButton, 'numbering'], [this.bulletToggleButton, 'bullet']] as const) if (button) {
      button.disabled = !!listToggleReason;
      button.title = listToggleReason ?? '';
      button.setAttribute('aria-pressed', String(this.currentParagraphList()?.kind === kind));
    }
    const lineSpacingAvailable = this.canAdjustLineSpacing();
    for (const button of [this.lineSpacingDecreaseButton, this.lineSpacingIncreaseButton]) if (button) {
      button.disabled = !lineSpacingAvailable;
      button.title = lineSpacingAvailable ? '' : this.lineSpacingReason();
    }
    if (this.toolbarLineSpacingSelect) {
      const properties = this.selectedParagraphFormatting()?.properties;
      const value = properties?.lineSpacing;
      const percent = properties?.lineSpacingType === 'Percent';
      const spacingState = JSON.stringify([properties?.lineSpacingType, value]);
      if (this.toolbarLineSpacingSelect.dataset.spacingState !== spacingState) {
        this.toolbarLineSpacingSelect.dataset.spacingState = spacingState;
        this.toolbarLineSpacingSelect.replaceChildren();
        const modeLabels: Record<string, string> = { Fixed: '고정', SpaceOnly: '여백만', Minimum: '최소', BetweenLines: '줄 사이' };
        const modeLabel = modeLabels[properties?.lineSpacingType ?? ''];
        this.toolbarLineSpacingSelect.createEl('option', { value: '', text: modeLabel && typeof value === 'number'
          ? `${modeLabel} · ${Number(pixelsToPoints(value).toFixed(2))} pt` : '혼합 / 미확인' });
        const values = [0, 50, 100, 130, 150, 160, 180, 200, 250, 300];
        if (percent && typeof value === 'number' && Number.isFinite(value)) values.push(value);
        for (const number of [...new Set(values)].sort((a, b) => a - b)) this.toolbarLineSpacingSelect.createEl('option', { value: String(number), text: `${number}%` });
      }
      this.toolbarLineSpacingSelect.value = percent && typeof value === 'number' ? String(value) : '';
      this.toolbarLineSpacingSelect.title = this.toolbarLineSpacingSelect.disabled
        ? this.formattingReason({ paragraph: {} }) ?? this.lineSpacingReason()
        : '문단 줄 간격 (%). 값을 선택하면 퍼센트 기준으로 적용합니다.';
    }
    const reasons: string[] = [];
    if (this.capabilityCheckPending) reasons.push('첫 쪽은 열렸습니다. 원본 저장 안전성을 확인하는 동안 편집 도구를 잠시 사용할 수 없습니다.');
    if (this.composing) reasons.push('한글 조합이 끝날 때까지 모든 문서 명령을 사용할 수 없습니다.');
    else if (this.draft) reasons.push('서식 명령을 실행하면 미적용 입력을 먼저 적용합니다.');
    if (this.formMode) reasons.push('양식 모드에서는 누름틀만 선택하고 입력할 수 있습니다. 해제하려면 보기 → 양식 모드를 실행하세요.');
    if (multiParagraphSelection) reasons.push('선택 범위 전체에 서식을 적용합니다.');
    if (this.capabilityCheckError) reasons.push(`저장 안전성 검증에 실패해 읽기 전용입니다. ${this.capabilityCheckError}`);
    else if (readOnly && !this.capabilityCheckPending) reasons.push(...(this.capabilities?.readOnlyReasons.length ? this.capabilities.readOnlyReasons : ['현재 형식의 안전한 저장 검증에 실패해 읽기 전용입니다.']));
    else if (field) reasons.push('선택한 필드 값은 위 입력란에서 수정할 수 있습니다. 필드 생성 명령은 아직 공개되지 않았습니다.');
    else if (!paragraph && !object) reasons.push('페이지의 문단, 표 셀, 필드 또는 개체를 선택하세요.');
    if (address?.kind === 'footnote' || address?.kind === 'endnote') reasons.push('각주·미주 글자 서식은 현재 RHWP 코어에서 지원하지 않습니다. 문단 서식은 사용할 수 있습니다.');
    if (nestedCell) reasons.push('깊은 중첩 셀은 글자 서식과 텍스트 편집만 지원합니다. 문단 서식·목록·스타일·표 구조 변경은 사용할 수 없습니다.');
    if (textBox) reasons.push('글상자 문단의 스타일 적용은 현재 RHWP 코어에서 지원하지 않습니다. 글자·문단·목록 서식과 텍스트 편집은 사용할 수 있습니다.');
    if (paragraph && !rootBody) reasons.push('표 생성과 그림·수식·도형 삽입은 본문 문단에서만 지원합니다.');
    if (object && !objectRoot) reasons.push('중첩 셀 안의 개체 속성 변경은 지원하지 않습니다.');
    if (this.selectedObject && !objectRoot) reasons.push(`선택한 ${objectKindLabel(this.selectedObject)}는 현재 속성 편집 대상이 아닙니다.`);
    if (this.styleSelect && this.formattingModel) {
      const styleFormatting = this.selectedParagraphFormatting(), currentStyle = styleFormatting?.style?.id;
      this.styleSelect.empty();
      this.styleSelect.createEl('option', { value: '', text: styleFormatting ? '스타일 혼합 / 미확인' : '문단 스타일 선택' });
      for (const style of this.formattingModel.styles) this.styleSelect.createEl('option', { value: String(style.id), text: style.name || style.englishName || `스타일 ${style.id}` });
      this.styleSelect.value = currentStyle === undefined ? '' : String(currentStyle);
      this.updateFontSuggestions();
    }
    if (this.listSelect && this.formattingModel) {
      const old = this.listSelect.value;
      this.listSelect.empty();
      this.listSelect.createEl('option', { value: '', text: '혼합 / 미확인' });
      this.listSelect.createEl('option', { value: 'none', text: '목록 없음' });
      this.listSelect.createEl('option', { value: 'numbering:auto', text: '번호 목록' });
      for (const item of this.formattingModel.numbering) this.listSelect.createEl('option', { value: `numbering:${item.id}`, text: `번호 목록 ${item.id}` });
      if (this.formattingModel.bullets.length) {
        for (const item of this.formattingModel.bullets) this.listSelect.createEl('option', { value: `bullet:${item.id}`, text: `글머리표 ${item.char}` });
      } else this.listSelect.createEl('option', { value: 'bullet:default', text: '글머리표 •' });
      const formatting = this.selectedParagraphFormatting();
      const props = formatting?.properties;
      const listKind = props?.headType === 'Bullet' ? 'bullet' : props?.headType === 'Number' ? 'numbering' : 'none';
      const numberingId = props?.numberingId;
      const wanted = listKind === 'none' ? 'none' : listKind === 'numbering' ? `numbering:${numberingId ?? 'auto'}` : `bullet:${numberingId ?? 'auto'}`;
      const fallback = listKind === 'bullet' ? 'bullet:default' : listKind === 'numbering' ? 'numbering:auto' : 'none';
      this.listSelect.value = [...this.listSelect.options].some(option => option.value === wanted) ? wanted : [...this.listSelect.options].some(option => option.value === fallback) ? fallback : old || 'none';
      if (!formatting || props?.headType === undefined) this.listSelect.value = '';
    }
    const paragraphFormatting = this.selectedParagraphFormatting();
    if (paragraphFormatting) {
      const properties = paragraphFormatting.properties;
      this.alignmentSelect.value = properties?.alignment ?? '';
      const setNumber = (input: HTMLInputElement, key: 'indent' | 'spacingBefore' | 'spacingAfter' | 'lineSpacing') => {
        const value = properties?.[key];
        if (this.contentEl.ownerDocument.activeElement === input) return;
        if (typeof value !== 'number') { input.value = ''; input.placeholder = '혼합 / 미확인'; return; }
        input.placeholder = '';
        const mode = properties?.lineSpacingType;
        input.value = key === 'lineSpacing' && mode !== 'Percent' ? String(pixelsToPoints(value))
          : key === 'lineSpacing' ? String(value) : String(pixelsToMillimeters(value));
      };
      setNumber(this.paragraphIndentInput, 'indent'); setNumber(this.paragraphSpacingBeforeInput, 'spacingBefore');
      setNumber(this.paragraphSpacingAfterInput, 'spacingAfter'); setNumber(this.paragraphLineSpacingInput, 'lineSpacing');
      if (properties?.lineSpacingType && [...this.paragraphLineSpacingTypeSelect.options].some(option => option.value === properties.lineSpacingType)) this.paragraphLineSpacingTypeSelect.value = properties.lineSpacingType;
      const percentMode = this.paragraphLineSpacingTypeSelect.value === 'Percent';
      this.paragraphLineSpacingUnit.setText(percentMode ? '%' : 'pt');
      this.paragraphLineSpacingInput.setAttribute('aria-label', `줄 간격 값 (${percentMode ? '%' : 'pt'})`);
    } else {
      this.alignmentSelect.value = '';
      for (const input of [this.paragraphIndentInput, this.paragraphSpacingBeforeInput, this.paragraphSpacingAfterInput, this.paragraphLineSpacingInput]) {
        if (this.contentEl.ownerDocument.activeElement === input) continue;
        input.value = ''; input.placeholder = '혼합 / 미확인';
      }
    }
    for (const [alignment, button] of this.alignmentButtons) {
      const id = `format.align-${alignment}`, available = this.commandRegistry.isAvailable(id);
      button.disabled = !available;
      button.title = available ? this.commandRegistry.get(id)!.label : this.commandRegistry.get(id)?.unavailableReason?.() ?? '문단을 선택하세요.';
      button.setAttribute('aria-pressed', this.alignmentSelect.value ? String(this.alignmentSelect.value === alignment) : 'mixed');
    }
    const tableContext = this.selectedTableCell();
    if (tableContext) {
      this.mergeEndRowInput.value = String(tableContext.cell.row + tableContext.cell.rowSpan);
      this.mergeEndColInput.value = String(tableContext.cell.col + tableContext.cell.colSpan);
    }
    this.toolReasonEl.setText(reasons.length ? [...new Set(reasons)].join(' ') : '선택 위치에서 사용할 수 있는 도구가 활성화되어 있습니다. 명령이 실패하면 엔진이 반환한 구체적인 사유를 표시합니다.');
    const formatting = this.selectedParagraphFormatting();
    if (this.formatStateEl) {
      if (!paragraph) this.formatStateEl.setText(field ? '필드 값 편집: 위 입력란을 사용하세요.' : object ? `${objectKindLabel(object)} 개체가 선택되었습니다.` : '서식 범위를 확인하려면 문단을 선택하세요.');
      else {
        const start = this.pageSelection && sameDocumentAddress(this.pageSelection.address, paragraph.address) ? Math.min(this.pageSelection.start, this.pageSelection.end) : 0;
        const end = this.pageSelection && sameDocumentAddress(this.pageSelection.address, paragraph.address) ? Math.max(this.pageSelection.start, this.pageSelection.end) : 0;
        const low = start === end ? 0 : start;
        const high = start === end ? paragraph.length : end;
        const runs = this.selectedFormattingRuns();
        for (const key of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
          const button = this.characterButtons.get(key);
          if (!button) continue;
          const values = [...new Set(runs.map(run => run.properties[key]).filter(value => typeof value === 'boolean'))];
          const pendingValue = start === end ? this.pendingCaretProperties?.[key] : undefined;
          if (pendingValue !== undefined) button.setAttribute('aria-pressed', String(pendingValue));
          else if (!values.length) button.removeAttribute('aria-pressed');
          else button.setAttribute('aria-pressed', values.length > 1 ? 'mixed' : String(values[0]));
        }
        const describe = (key: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'fontSize' | 'fontFamily' | 'textColor' | 'shadeColor'): string => {
          const values = [...new Set(runs.map(run => run.properties[key]).filter(value => value !== undefined).map(String))];
          if (values.length > 1) return '혼합';
          if (!values.length) return '미확인';
          return values[0] === 'true' ? '켜짐' : values[0] === 'false' ? '꺼짐' : values[0];
        };
        const coverage = formatting?.characterCoverage === 'complete' ? '전체 확인' : formatting?.characterCoverage === 'unsupported' ? '지원 안 됨' : '일부만 확인';
        const paragraphCoverage = formatting?.propertyCoverage === 'complete' ? '문단 속성 전체 확인' : formatting?.propertyCoverage === 'nativeOnly' ? 'native 문단 값만 확인' : '문단 속성 미확인';
        this.formatStateEl.setText(`글자 서식 ${start === end ? `문단 전체 (커서 ${start})` : `${start}–${end} 범위`} · ${coverage} · 굵게 ${describe('bold')} · 기울임 ${describe('italic')} · 밑줄 ${describe('underline')} · 취소선 ${describe('strikethrough')} · 크기 ${describe('fontSize')} · 글꼴 ${describe('fontFamily')} · 색 ${describe('textColor')} · 형광펜 ${describe('shadeColor')} · ${paragraphCoverage}`);
        if (runs.length) {
          // A change made at a collapsed caret is shown before any text carries it, as 굵게 already is.
          const pending = start === end ? this.pendingCaretProperties : undefined;
          const fontSizes = pending?.fontSize !== undefined ? [pending.fontSize] : [...new Set(runs.map(run => run.properties.fontSize).filter((value): value is number => typeof value === 'number'))];
          const language = this.fontLanguageSelect?.value ?? 'all';
          const familyFor = (properties: CharacterProperties): string | undefined => language === 'all'
            ? properties.fontFamilies ? new Set(properties.fontFamilies).size === 1 ? properties.fontFamilies[0] : undefined : properties.fontFamily
            : properties.fontFamilies?.[Number(language)];
          const pendingFamily = pending?.fontFamilies ? familyFor(pending) : pending?.fontFamily !== undefined && (pending.fontLanguage === undefined || String(pending.fontLanguage) === language) ? pending.fontFamily : undefined;
          const fontFamilies = pendingFamily !== undefined ? [pendingFamily] : runs.every(run => familyFor(run.properties) !== undefined)
            ? [...new Set(runs.map(run => familyFor(run.properties)!))] : [];
          const colors = pending?.textColor !== undefined ? [pending.textColor] : [...new Set(runs.map(run => run.properties.textColor).filter((value): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)))];
          const highlightColors = pending?.shadeColor !== undefined ? [pending.shadeColor].filter(value => value.toLowerCase() !== '#ffffff') : [...new Set(runs.map(run => run.properties.shadeColor).filter((value): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) && value.toLowerCase() !== '#ffffff'))];
          this.markMixedControl(this.fontSizeInput, fontSizes.length !== 1, '글자 크기');
          this.markMixedControl(this.fontFamilyInput, fontFamilies.length !== 1, '글꼴');
          this.markMixedControl(this.fontColorInput, colors.length !== 1, '글자 색');
          this.markMixedControl(this.highlightColorInput, highlightColors.length > 1, '형광펜');
          if (fontSizes.length === 1 && this.contentEl.ownerDocument.activeElement !== this.fontSizeInput) this.fontSizeInput.value = String(fontSizes[0]);
          if (fontFamilies.length === 1 && this.contentEl.ownerDocument.activeElement !== this.fontFamilyInput) this.fontFamilyInput.value = fontFamilies[0]!;
          if (colors.length === 1 && this.contentEl.ownerDocument.activeElement !== this.fontColorInput) this.fontColorInput.value = colors[0]!;
          if (highlightColors.length === 1 && this.contentEl.ownerDocument.activeElement !== this.highlightColorInput) this.highlightColorInput.value = highlightColors[0]!;
          if (this.contentEl.ownerDocument.activeElement !== this.fontSizeInput && fontSizes.length !== 1) this.fontSizeInput.value = '';
          if (this.contentEl.ownerDocument.activeElement !== this.fontFamilyInput && fontFamilies.length !== 1) this.fontFamilyInput.value = '';
          if (this.contentEl.ownerDocument.activeElement !== this.fontColorInput && colors.length !== 1) this.fontColorInput.value = '#000000';
          if (this.contentEl.ownerDocument.activeElement !== this.highlightColorInput && highlightColors.length !== 1) this.highlightColorInput.value = '#ffff00';
        } else {
          for (const [input, label] of [[this.fontSizeInput, '글자 크기'], [this.fontFamilyInput, '글꼴'], [this.fontColorInput, '글자 색'], [this.highlightColorInput, '형광펜']] as const) this.markMixedControl(input, true, label);
          if (this.contentEl.ownerDocument.activeElement !== this.fontSizeInput) this.fontSizeInput.value = '';
          if (this.contentEl.ownerDocument.activeElement !== this.fontFamilyInput) this.fontFamilyInput.value = '';
          if (this.contentEl.ownerDocument.activeElement !== this.fontColorInput) this.fontColorInput.value = '#000000';
          if (this.contentEl.ownerDocument.activeElement !== this.highlightColorInput) this.highlightColorInput.value = '#ffff00';
        }
        if (formatting?.style) this.styleSelect.value = String(formatting.style.id);
      }
    }
    this.characterEffectsMenu?.refresh();
    this.refreshHistoryButtons();
    const pageSection = this.pageLayout?.info.sectionIndex ?? address?.section ?? 0;
    if (this.pageSectionSelect && this.formattingModel) {
      const old = Number(this.pageSectionSelect.value);
      this.pageSectionSelect.empty();
      for (const section of this.formattingModel.sections) this.pageSectionSelect.createEl('option', { value: String(section.section), text: `구역 ${section.section + 1}` });
      const wanted = this.formattingModel.sections.some(section => section.section === old) ? old : pageSection;
      this.pageSectionSelect.value = String(this.formattingModel.sections.some(section => section.section === wanted) ? wanted : this.formattingModel.sections[0]?.section ?? 0);
      const section = this.formattingModel.sections.find(item => item.section === Number(this.pageSectionSelect.value));
      const pageDef = section?.pageDef;
      for (const [key, input] of this.pageNumberInputs) {
        if (this.contentEl.ownerDocument.activeElement === input) continue;
        const value = pageDef?.[key];
        input.value = typeof value === 'number' ? hwpUnitsToMillimeters(value).toFixed(3) : '';
      }
      if (pageDef && this.contentEl.ownerDocument.activeElement !== this.pageLandscapeInput) this.pageLandscapeInput.checked = typeof pageDef.landscape === 'boolean' ? pageDef.landscape : Number(pageDef.width) > Number(pageDef.height);
    }
    if (this.sectionGotoSelect && this.formattingModel) {
      const old = Number(this.sectionGotoSelect.value), pageSection = this.pageLayout?.info.sectionIndex ?? 0;
      this.sectionGotoSelect.empty();
      for (const section of this.formattingModel.sections) this.sectionGotoSelect.createEl('option', { value: String(section.section), text: `구역 ${section.section + 1}` });
      this.sectionGotoSelect.value = String(this.formattingModel.sections.some(section => section.section === old) ? old
        : this.formattingModel.sections.some(section => section.section === pageSection) ? pageSection : this.formattingModel.sections[0]?.section ?? 0);
      this.sectionGotoSelect.disabled = !this.formattingModel.sections.length || this.draft || this.composing;
    }
    if (this.objectWidthInput && object && objectRoot) {
      const properties = object.properties && typeof object.properties === 'object' ? object.properties as Record<string, unknown> : {};
      if (this.contentEl.ownerDocument.activeElement !== this.objectWidthInput) this.objectWidthInput.value = typeof properties.width === 'number' ? String(properties.width / 100) : '';
      if (this.contentEl.ownerDocument.activeElement !== this.objectHeightInput) this.objectHeightInput.value = typeof properties.height === 'number' ? String(properties.height / 100) : '';
      if (this.contentEl.ownerDocument.activeElement !== this.objectDescriptionInput) this.objectDescriptionInput.value = typeof properties.description === 'string' ? properties.description : '';
      const canSetPlacement = object.kind !== 'equation';
      for (const control of [this.objectOffsetXInput, this.objectOffsetYInput, this.objectTreatAsCharInput, this.objectTextWrapSelect]) control.hidden = !canSetPlacement;
      if (canSetPlacement) {
        if (this.contentEl.ownerDocument.activeElement !== this.objectOffsetXInput) this.objectOffsetXInput.value = typeof properties.horzOffset === 'number' ? String(properties.horzOffset / 100) : '0';
        if (this.contentEl.ownerDocument.activeElement !== this.objectOffsetYInput) this.objectOffsetYInput.value = typeof properties.vertOffset === 'number' ? String(properties.vertOffset / 100) : '0';
        if (this.contentEl.ownerDocument.activeElement !== this.objectTreatAsCharInput) this.objectTreatAsCharInput.checked = properties.treatAsChar === true;
        if (this.contentEl.ownerDocument.activeElement !== this.objectTextWrapSelect) this.objectTextWrapSelect.value = properties.textWrap === 'TopAndBottom' ? 'TopAndBottom' : 'Square';
      }
    }
    if (object?.kind === 'equation' && objectRoot) {
      const script = (object.properties as Record<string, unknown> | undefined)?.script;
      if (this.contentEl.ownerDocument.activeElement !== this.equationScriptInput) {
        this.equationScriptInput.value = typeof script === 'string' ? script : '';
        this.scheduleEquationPreview();
      }
    }
    if (!object || !objectRoot) for (const control of [this.objectOffsetXInput, this.objectOffsetYInput, this.objectTreatAsCharInput, this.objectTextWrapSelect]) control.hidden = true;
    if (this.equationApplyButton) this.equationApplyButton.hidden = object?.kind !== 'equation' || !objectRoot;
  }
  private installMenuBar(parent: HTMLElement): void {
    this.commandRegistry = new CommandRegistry();
    const register = (
      id: string,
      _label: string,
      run: () => unknown,
      options: { shortcut?: string; available?: () => boolean; reason?: () => string | undefined } = {},
    ): void => {
      const definition = editorCommandDefinition(id);
      if (!definition) throw new Error(`명령 카탈로그에 등록되지 않은 ID: ${id}`);
      this.commandRegistry.register({
        ...definition,
        run: () => {
          if (this.composing) throw new Error('한글 조합을 마친 뒤 명령을 실행하세요.');
          return run();
        },
        isAvailable: () => !this.composing && (options.available?.() ?? true),
        unavailableReason: () => this.composing ? '한글 조합을 마친 뒤 사용하세요.' : options.reason?.(),
      });
    };
    const editBlockReason = (): string | undefined => !this.state ? '문서를 먼저 여세요.'
      : this.composing ? '한글 조합을 마친 뒤 사용하세요.'
        : this.formMode ? '양식 모드에서는 누름틀 값만 입력할 수 있습니다.'
        : this.saving || this.inputLocks ? '현재 작업이 끝난 뒤 사용하세요.'
          : this.capabilityCheckPending ? '문서 저장 안전성을 확인하고 있습니다.'
            : this.capabilitiesReadOnly() ? this.capabilities?.readOnlyReasons.join(' ') || '읽기 전용 문서입니다.' : undefined;
    const bodyEditReason = (): string | undefined => editBlockReason()
      ?? (this.selected && isParagraph(this.selected) && this.selected.address.kind === 'body' && !this.selected.address.cellPath?.length && !this.selected.address.containerKinds?.includes('textBox') ? undefined : '글상자가 아닌 본문 문단을 선택하세요.');
    const fieldInsertReason = (): string | undefined => editBlockReason()
      ?? (this.selected && isParagraph(this.selected) && this.selected.address.kind === 'body' && !this.selected.address.containerKinds?.includes('textBox') ? undefined : '본문 또는 표 셀 문단을 선택하세요.');
    const tableEditReason = (): string | undefined => editBlockReason()
      ?? (this.selectedTableCell() ? undefined : '본문의 표 셀 안 문단을 선택하세요. 중첩 표 구조 변경은 지원하지 않습니다.');
    const objectEditReason = (): string | undefined => {
      const object = this.selectedObject;
      return editBlockReason() ?? (object && object.address.kind === 'body' && !object.address.cellPath?.length
        && ['picture', 'shape', 'equation'].includes(object.kind) ? undefined : '속성을 편집할 본문 그림·수식·도형을 선택하세요.');
    };
    const tableStructureReason = (action: TableStructureAction): string | undefined => {
      const blocked = tableEditReason();
      if (blocked) return blocked;
      const current = this.selectedTableCell()!;
      if (action === 'delete-row' && current.table.rows <= 1) return '표의 마지막 행은 삭제할 수 없습니다.';
      if (action === 'delete-column' && current.table.cols <= 1) return '표의 마지막 칸은 삭제할 수 없습니다.';
      return undefined;
    };
    register('file.save', '저장', () => this.save(), {
      shortcut: 'Mod+S', available: () => !!this.state,
      reason: () => '문서가 열리지 않았습니다.',
    });
    register('file.new-document', '새 HWPX 문서', () => this.plugin.createNewDocument(), { shortcut: 'Alt+N' });
    register('file.open', 'HWP/HWPX 문서 열기', () => this.plugin.openDocumentPicker());
    register('file.save-as', '새 파일로 저장', () => this.saveAs(), { shortcut: 'Mod+Shift+S' });
    register('file.save-hwp', 'HWP 형식으로 저장…', () => this.saveAs('hwp'));
    register('file.save-hwpx', 'HWPX 형식으로 저장…', () => this.saveAs('hwpx'));
    register('file.print', '인쇄 / PDF로 저장', () => this.openPrintDialog(), { available: () => !!this.state && !this.draft && !this.composing, reason: () => !this.state ? '문서가 아직 준비되지 않았습니다.' : this.draft ? '미적용 입력을 먼저 처리하세요.' : this.composing ? '한글 조합을 마친 뒤 인쇄하세요.' : undefined });
    register('file.reload', '다시 불러오기', () => this.reloadFromDisk());
    register('file.refresh-index', '검색 인덱스 갱신', () => this.refreshIndex());
    register('edit.undo', '되돌리기', () => this.historyCommand(false), { shortcut: 'Mod+Z', available: () => this.historyAvailable(false), reason: () => '되돌릴 변경이 없습니다.' });
    register('edit.redo', '다시 실행', () => this.historyCommand(true), { shortcut: 'Mod+Shift+Z', available: () => this.historyAvailable(true), reason: () => '다시 실행할 변경이 없습니다.' });
    const hasTextSelection = (): boolean => !!this.textarea && (this.textarea.selectionEnd > this.textarea.selectionStart || !this.rangeIsCollapsed(this.selectionRange()));
    register('edit.cut', '오려두기', () => this.runClipboardCommand('cut'), {
      shortcut: 'Mod+X', available: () => hasTextSelection() && !this.composing && !this.capabilitiesReadOnly() && !this.selectionMutationReason(),
      reason: () => this.selectionMutationReason() ?? (!hasTextSelection() ? '먼저 오려낼 텍스트를 선택하세요.' : this.composing ? '한글 조합을 마친 뒤 오려두세요.' : '읽기 전용 상태에서는 오려낼 수 없습니다.'),
    });
    register('edit.copy', '복사', () => this.runClipboardCommand('copy'), {
      shortcut: 'Mod+C', available: () => hasTextSelection() && !this.composing,
      reason: () => !hasTextSelection() ? '먼저 복사할 텍스트를 선택하세요.' : '한글 조합을 마친 뒤 복사하세요.',
    });
    register('edit.paste', '붙이기', () => this.runClipboardCommand('paste'), {
      shortcut: 'Mod+V', available: () => !!this.state && !this.composing && !this.capabilitiesReadOnly() && !this.selectionMutationReason(),
      reason: () => this.selectionMutationReason() ?? (!this.state ? '문서를 먼저 여세요.' : this.composing ? '한글 조합을 마친 뒤 붙여넣으세요.' : '읽기 전용 상태에서는 붙여넣을 수 없습니다.'),
    });
    register('edit.compare', '변경 비교', () => this.showDocumentChanges());
    register('edit.document-history', '문서 이력 관리', () => {}, { available: () => false, reason: () => '이 플러그인은 저장 전 백업과 복구 저널을 사용합니다.' });
    register('edit.recover-input', '미적용 입력 복구', () => this.openInputRecovery());
    register('edit.delete', '지우기', () => this.deleteSelectedRange(), {
      shortcut: 'Ctrl+E', available: () => !!this.selectionRange() && !this.rangeIsCollapsed(this.selectionRange()) && !editBlockReason() && !this.selectionMutationReason(),
      reason: () => editBlockReason() ?? this.selectionMutationReason() ?? '지울 범위를 먼저 선택하세요.',
    });
    register('edit.select-all', '모두 선택', () => this.selectBodySection(), {
      shortcut: 'Mod+A', available: () => !!this.selected && isParagraph(this.selected), reason: () => '본문 문단을 먼저 선택하세요.',
    });
    for (const [alignment, label] of [['left', '왼쪽 정렬'], ['center', '가운데 정렬'], ['right', '오른쪽 정렬'], ['justify', '양쪽 정렬'], ['distribute', '배분 정렬'], ['split', '나눔 정렬']] as const) {
      register(`format.align-${alignment}`, label, () => this.paragraphFormat(alignment), {
        available: () => !editBlockReason() && !this.formattingReason({ paragraph: {} }),
        reason: () => editBlockReason() ?? this.formattingReason({ paragraph: {} }),
      });
    }
    const rootInsertReason = (): string | undefined => editBlockReason() ?? (!this.selected || !isParagraph(this.selected) || this.selected.address.kind !== 'body' || this.selected.address.cellPath?.length || this.selected.address.containerKinds?.includes('textBox') ? '본문 문단을 선택하세요.' : undefined);
    register('insert.picture-file', '그림', () => this.pictureFileInput?.click(), { available: () => !rootInsertReason(), reason: rootInsertReason });
    register('insert.equation-dialog', '수식', () => this.openEquationInsertDialog(), { available: () => !rootInsertReason(), reason: rootInsertReason });
    register('insert.shape-draw', '도형 그리기', () => this.startShapeDrawMode('rectangle'), { available: () => !rootInsertReason(), reason: rootInsertReason });
    register('insert.text-box-draw', '글상자 그리기', () => this.startShapeDrawMode('textBox'), { available: () => !rootInsertReason(), reason: rootInsertReason });
    const captionTargetReason = (): string | undefined => {
      const object = this.selectedObject;
      if (object) return object.kind === 'picture' && object.address.kind === 'body' && !object.address.cellPath?.length
        ? undefined : '본문 그림 또는 표를 선택하세요. 그림·표 캡션만 지원합니다.';
      return this.selectedTableCell() ? undefined : '본문 그림 또는 표 셀 안 문단을 선택하세요.';
    };
    for (const [id, direction] of [
      ['insert.caption-top', 'Top'], ['insert.caption-bottom', 'Bottom'], ['insert.caption-left', 'Left'], ['insert.caption-right', 'Right'], ['insert.caption-none', 'None'],
    ] as const) register(id, direction === 'None' ? '캡션 없음' : `캡션 ${direction}`, () => this.setCaptionDirection(direction), {
      available: () => !editBlockReason() && !captionTargetReason(),
      reason: () => editBlockReason() ?? captionTargetReason(),
    });
    register('view.previous-page', '이전 쪽', async () => {
      if (this.draft || this.composing) throw new Error('입력을 적용한 뒤 쪽을 이동하세요.');
      if (this.page > 0) { this.page--; await this.renderPage(true); }
    }, { available: () => this.page > 0 && !this.draft && !this.composing, reason: () => this.draft || this.composing ? '미적용 입력을 먼저 처리하세요.' : '첫 쪽입니다.' });
    register('view.next-page', '다음 쪽', async () => {
      if (this.draft || this.composing) throw new Error('입력을 적용한 뒤 쪽을 이동하세요.');
      if (this.state && this.page + 1 < this.state.pageCount) { this.page++; await this.renderPage(true); }
    }, { available: () => !!this.state && this.page + 1 < this.state.pageCount && !this.draft && !this.composing, reason: () => this.draft || this.composing ? '미적용 입력을 먼저 처리하세요.' : '마지막 쪽입니다.' });
    register('view.fit-width', '폭 맞춤', () => this.applyZoomPreset('fit-width'), { available: () => !!this.state });
    register('view.fit-page', '쪽 맞춤', () => this.applyZoomPreset('fit-page'), { available: () => !!this.state && !!this.pageLayout });
    register('view.zoom-in', '확대', () => this.stepZoom(1), { available: () => !!this.state && this.zoomPercent < 500 });
    register('view.zoom-out', '축소', () => this.stepZoom(-1), { available: () => !!this.state && this.zoomPercent > 50 });
    for (const percent of [50, 75, 100, 125, 150, 200, 300]) {
      register(`view.zoom-${percent}`, `${percent}%`, () => this.applyZoomPreset(String(percent)), { available: () => !!this.state });
    }
    register('file.about', '제품 정보', () => this.openProductInfo());
    register('tool.settings', '환경 설정', () => this.openPluginSettings());
    register('view.form-mode', '양식 모드', () => this.toggleFormMode(), {
      shortcut: 'Ctrl+Shift+F', available: () => !!this.state && !this.composing && !this.draft,
      reason: () => this.draft || this.composing ? '미적용 입력 또는 한글 조합을 먼저 처리하세요.' : '문서를 먼저 여세요.',
    });
    register('view.toggle-toolbars', '도구 상자 접기/펴기', () => this.toggleToolbars(), { shortcut: 'Ctrl+F1' });
    register('view.toggle-format-toolbox', '서식 도구줄 접기/펴기', () => {
      const chrome = this.plugin.settings.editorChrome;
      return this.plugin.setEditorChrome({ ...chrome, formatToolbox: !chrome.formatToolbox });
    });
    register('view.toggle-all-chrome', '메뉴 모두 접기/펴기', () => this.toggleAllChrome(), { shortcut: 'Ctrl+Shift+F1' });
    register('view.go-to-page', '찾아가기', () => this.openGoToDialog(), { shortcut: 'Alt+G' });
    register('view.ruler', '눈금자', () => this.setRulerVisible(!this.rulerVisible));
    register('view.grid', '격자 보기', () => this.setGridSettings({ ...this.gridSettings, visible: !this.gridSettings.visible }));
    register('view.grid-settings', '격자 설정', () => this.openGridSettingsDialog());
    register('view.paragraph-marks', '문단 부호', () => this.toggleDisplayOption('showParagraphMarks'));
    register('view.control-codes', '조판 부호', () => this.toggleDisplayOption('showControlCodes'));
    register('view.transparent-borders', '투명 선', () => this.toggleDisplayOption('showTransparentBorders'));
    register('view.overflow', '잘림 보기', () => this.toggleDisplayOption('showOverflow'));
    register('insert.paragraph', '새 문단', () => this.insertParagraph(), { available: () => !bodyEditReason(), reason: bodyEditReason });
    register('insert.table', '표 삽입', () => this.openTableGridDialog(), { available: () => !bodyEditReason(), reason: bodyEditReason });
    register('insert.table-custom', '사용자 지정 표 삽입', () => this.openCustomTableDialog(), { available: () => !bodyEditReason(), reason: bodyEditReason });
    register('insert.clickhere-field', '누름틀 삽입', () => this.openClickHereFieldModal(), {
      available: () => !fieldInsertReason() && !this.formMode && !this.draft && !this.composing,
      reason: () => this.formMode ? '양식 모드를 끈 뒤 누름틀을 삽입하세요.' : this.draft || this.composing ? '미적용 입력 또는 한글 조합을 먼저 처리하세요.' : fieldInsertReason(),
    });
    const clickHereSelectedReason = (): string | undefined => editBlockReason()
      ?? (this.selected && !isParagraph(this.selected) && this.selected.fieldType === 'clickhere' ? undefined : '고치거나 지울 누름틀을 선택하세요. 문서의 누름틀을 누르거나 문서 탐색의 필드 목록에서 고르세요.');
    register('field.edit', '필드 고치기', () => this.openFieldEditDialog(), { available: () => !clickHereSelectedReason(), reason: clickHereSelectedReason });
    register('field.remove', '필드 지우기', () => this.openFieldRemoveDialog(), { available: () => !clickHereSelectedReason(), reason: clickHereSelectedReason });
    register('insert.character-table', '문자표', () => this.openCharacterTable(), {
      shortcut: 'Alt+F10', available: () => !editBlockReason() && !!this.selected && isParagraph(this.selected),
      reason: () => editBlockReason() ?? '먼저 문서 문단을 선택하세요.',
    });
    register('insert.bookmark', '책갈피', () => this.openBookmarkModal(), { available: () => !!this.state && !!this.path, reason: () => '문서를 먼저 여세요.' });
    register('view.go-to-bookmark', '책갈피로 이동', () => this.pickBookmark(), { available: () => !!this.state && !!this.path && !this.draft, reason: () => this.draft ? '미적용 입력을 먼저 처리하세요.' : '문서를 먼저 여세요.' });
    register('insert.page-break', '쪽 나누기', () => this.insertPageBreak('page'), { shortcut: 'Mod+Enter', available: () => !bodyEditReason(), reason: bodyEditReason });
    register('insert.column-break', '단 나누기', () => this.insertPageBreak('column'), { shortcut: 'Mod+Shift+Enter', available: () => !bodyEditReason(), reason: bodyEditReason });
    const noteInsertReason = (): string | undefined => this.draft ? '미적용 입력을 먼저 적용하거나 취소하세요.' : bodyEditReason();
    register('insert.footnote', '각주 삽입', () => this.insertNote('footnote'), { available: () => !noteInsertReason(), reason: noteInsertReason });
    register('insert.endnote', '미주 삽입', () => this.insertNote('endnote'), { available: () => !noteInsertReason(), reason: noteInsertReason });
    register('insert.endnote-shape', '미주 모양', () => this.openEndnoteShapeModal(), {
      available: () => !editBlockReason() && !!this.formattingModel?.sections.length,
      reason: () => editBlockReason() ?? (!this.formattingModel?.sections.length ? '구역 설정을 아직 읽지 못했습니다.' : undefined),
    });
    for (const [id, property] of [['format.bold', 'bold'], ['format.italic', 'italic'], ['format.underline', 'underline'], ['format.strikethrough', 'strikethrough']] as const) {
      register(id, property === 'bold' ? '굵게' : property === 'italic' ? '기울임' : property === 'underline' ? '밑줄' : '취소선', () => this.toggleCharacterProperty(property), {
        ...(property === 'bold' ? { shortcut: 'Mod+B' } : property === 'italic' ? { shortcut: 'Mod+I' } : property === 'underline' ? { shortcut: 'Mod+U' } : {}),
        available: () => !editBlockReason() && !this.formattingReason({ character: {} }),
        reason: () => editBlockReason() ?? this.formattingReason({ character: {} }),
      });
    }
    for (const [id, effect, label] of CHARACTER_EFFECTS) {
      register(id, label, () => this.toggleCharacterEffect(effect), {
        available: () => !editBlockReason() && !this.formattingReason({ character: {} }),
        reason: () => editBlockReason() ?? this.formattingReason({ character: {} }),
      });
    }
    register('format.list-level-down', '목록 수준 내리기', () => this.changeListLevel(-1), {
      available: () => this.canChangeListLevel(-1), reason: () => this.listLevelReason(-1),
    });
    register('format.toggle-numbering', '번호 목록 토글', () => this.toggleParagraphList('numbering'), {
      available: () => !this.listToggleReason(), reason: () => this.listToggleReason(),
    });
    register('format.toggle-bullet', '글머리표 토글', () => this.toggleParagraphList('bullet'), {
      available: () => !this.listToggleReason(), reason: () => this.listToggleReason(),
    });
    register('format.list-level-up', '목록 수준 올리기', () => this.changeListLevel(1), {
      available: () => this.canChangeListLevel(1), reason: () => this.listLevelReason(1),
    });
    for (const [id, direction] of [['format.line-spacing-decrease', -1], ['format.line-spacing-increase', 1]] as const) {
      register(id, direction < 0 ? '줄 간격 줄이기' : '줄 간격 늘리기', () => this.adjustLineSpacing(direction), {
        shortcut: direction < 0 ? 'Mod+Shift+Alt+[' : 'Mod+Shift+Alt+]',
        available: () => this.canAdjustLineSpacing(), reason: () => this.lineSpacingReason(),
      });
    }
    const fontSizeReason = (): string | undefined => characterFormatReason()
      ?? (this.selectedFontSizes().length > 1 ? '서로 다른 글자 크기를 한 번에 증감할 수 없습니다. 같은 크기 범위를 선택하세요.' : undefined);
    register('format.font-size-increase', '글자 크기 늘리기', () => this.adjustFontSize(1), {
      shortcut: 'Mod+]', available: () => !fontSizeReason(), reason: fontSizeReason,
    });
    register('format.font-size-decrease', '글자 크기 줄이기', () => this.adjustFontSize(-1), {
      shortcut: 'Mod+[', available: () => !fontSizeReason(), reason: fontSizeReason,
    });
    const characterFormatReason = (): string | undefined => editBlockReason() ?? this.formattingReason({ character: {} });
    for (const [id, label, metric, direction, shortcut] of [
      ['format.ratio-increase', '장평 늘리기', 'ratio', 1, 'Mod+Shift+]'],
      ['format.ratio-decrease', '장평 줄이기', 'ratio', -1, 'Mod+Shift+['],
      ['format.character-spacing-increase', '자간 넓히기', 'characterSpacing', 1, 'Mod+Alt+]'],
      ['format.character-spacing-decrease', '자간 좁히기', 'characterSpacing', -1, 'Mod+Alt+['],
    ] as const) {
      const metricReason = (): string | undefined => characterFormatReason()
        ?? (this.selectedUniformCharacterMetric(metric) === undefined ? '언어별 장평·자간이 다르거나 조회되지 않습니다. 글자 모양 대화상자에서 새 값을 지정하세요.' : undefined);
      register(id, label, () => this.adjustCharacterMetric(metric, direction), {
        shortcut, available: () => !metricReason(), reason: metricReason,
      });
    }
    const paragraphFormatReason = (): string | undefined => editBlockReason() ?? this.formattingReason({ paragraph: {} });
    const styleFormatReason = (): string | undefined => editBlockReason() ?? this.formattingReason({ styleId: 0 })
      ?? (!this.formattingModel?.styles.length ? '현재 문서의 문단 스타일 목록을 읽지 못했습니다.' : undefined);
    register('format.character-dialog', '글자 모양', () => this.openCharacterFormatDialog(), {
      shortcut: 'Alt+L', available: () => !characterFormatReason(), reason: characterFormatReason,
    });
    register('format.paragraph-dialog', '문단 모양', () => this.openParagraphFormatDialog(), {
      shortcut: 'Alt+T', available: () => !paragraphFormatReason(), reason: paragraphFormatReason,
    });
    register('format.style-dialog', '문단 스타일', () => this.openStyleSelectionDialog(), {
      shortcut: 'F6', available: () => !styleFormatReason(), reason: styleFormatReason,
    });
    register('format.copy-style', '모양 복사', () => this.copySelectedFormat(), {
      shortcut: 'Alt+C', available: () => !!this.selected && isParagraph(this.selected) && !this.hasMultiParagraphSelection() && !this.draft && !this.composing,
      reason: () => this.hasMultiParagraphSelection() ? '모양 복사는 한 문단 선택에서만 지원합니다.' : this.draft ? '미적용 입력을 먼저 적용하세요.' : '모양을 복사할 문단을 선택하세요.',
    });
    register('format.apply-copied-style', '모양 붙이기', () => this.applyCopiedFormat(), {
      available: () => !!this.copiedFormat && !editBlockReason() && !this.formattingReason(this.copiedFormat),
      reason: () => !this.copiedFormat ? '먼저 모양을 복사하세요.' : editBlockReason() ?? this.formattingReason(this.copiedFormat),
    });
    const styleDefinitionReason = (): string | undefined => editBlockReason() ?? (this.formattingModel?.styles.length ? undefined : '스타일 정보를 아직 읽지 못했습니다.');
    register('format.style-new', '스타일 추가', () => this.openStyleEditor('create'), { available: () => !styleDefinitionReason(), reason: styleDefinitionReason });
    register('format.style-edit', '스타일 편집', () => this.openStyleEditor('edit'), { available: () => !styleDefinitionReason(), reason: styleDefinitionReason });
    register('format.style-delete', '스타일 지우기', () => this.deleteStyleInteractive(), { available: () => !styleDefinitionReason(), reason: styleDefinitionReason });
    register('format.numbering-define', '문단 번호 모양', () => this.openNumberingDialog(), { available: () => !bodyEditReason(), reason: bodyEditReason });
    register('page.apply-settings', '쪽 설정 적용', () => this.applyPageSettings(), { available: () => !editBlockReason() && !!this.formattingModel?.sections.length, reason: () => editBlockReason() ?? (!this.formattingModel?.sections.length ? '쪽 설정 정보를 아직 읽지 못했습니다.' : undefined) });
    register('page.setup-dialog', '편집 용지', () => this.openPageSetupDialog(), { shortcut: 'F7', available: () => !editBlockReason() && !!this.formattingModel?.sections.length, reason: () => editBlockReason() ?? (!this.formattingModel?.sections.length ? '쪽 설정 정보를 아직 읽지 못했습니다.' : undefined) });
    const storyAddress = (): HeaderFooterAddress | Extract<DocumentAddress, { kind: 'footnote' | 'endnote' }> | undefined => {
      const address = this.selected && isParagraph(this.selected) ? this.selected.address : undefined;
      return address?.kind === 'headerFooter' || address?.kind === 'footnote' || address?.kind === 'endnote' ? address : undefined;
    };
    const storyReason = (): string | undefined => editBlockReason() ?? (!storyAddress() ? '머리말·꼬리말·각주·미주를 먼저 편집하세요.' : undefined);
    for (const direction of [-1, 1] as const) register(direction === -1 ? 'story.previous' : 'story.next', direction === -1 ? '이전 영역' : '다음 영역', () => this.navigateStory(direction), { available: () => !storyReason(), reason: storyReason });
    register('story.close', '편집 닫기', () => this.closeHeaderFooterEditor(), { available: () => !!storyAddress() && !this.composing, reason: storyReason });
    register('story.delete', '영역 지우기', () => this.deleteStory(), { available: () => !storyReason(), reason: storyReason });
    for (const [id, field] of [['page-number', 'pageNumber'], ['total-pages', 'totalPages'], ['file-name', 'fileName']] as const) {
      const reason = (): string | undefined => storyReason() ?? 'RHWP 직접 필드 삽입은 저장 재파싱 검증을 통과하지 못합니다. 쪽 메뉴의 머리말·꼬리말 템플릿을 사용하세요.';
      register(`story.${id}`, field, () => { throw new Error(reason()); }, { available: () => false, reason });
    }
    register('insert.hyperlink', '하이퍼링크', () => {}, { available: () => false, reason: () => 'RHWP 코어에 하이퍼링크 삽입 API가 없습니다.' });
    register('page.footer-template', '꼬리말', () => this.openHeaderFooterTemplateModal(false), { available: () => !editBlockReason() && !!this.documentTree && !!this.formattingModel?.sections.length, reason: () => editBlockReason() ?? '문서를 먼저 여세요.' });
    const headerFooterReason = (): string | undefined => editBlockReason() ?? (!this.documentTree || !this.formattingModel?.sections.length ? '문서를 먼저 여세요.' : undefined);
    for (const isHeader of [true, false]) {
      register(`page.edit-${isHeader ? 'header' : 'footer'}`, `${isHeader ? '머리말' : '꼬리말'} 편집…`, () => this.editHeaderFooter(isHeader), {
        available: () => !headerFooterReason() && !!this.findHeaderFooter(isHeader), reason: () => headerFooterReason() ?? '현재 쪽에 해당 영역이 없습니다.',
      });
      for (const applyTo of [0, 2, 1] as const) HEADER_FOOTER_TEMPLATES.forEach((label, templateId) => {
        register(headerFooterCommandId(isHeader, applyTo, templateId), label, () => this.applyHeaderFooterTemplate(isHeader, applyTo, templateId), {
          available: () => !headerFooterReason(), reason: headerFooterReason,
        });
      });
    }
    register('page.header-footer-template', '머리말 / 꼬리말', () => this.openHeaderFooterTemplateModal(), { available: () => !editBlockReason() && !!this.documentTree && !!this.formattingModel?.sections.length, reason: () => editBlockReason() ?? (!this.formattingModel?.sections.length ? '쪽 구역 정보를 아직 읽지 못했습니다.' : '문서를 먼저 여세요.') });
    const sectionReady = (): string | undefined => editBlockReason() ?? (!this.formattingModel?.sections.length ? '구역 설정을 아직 읽지 못했습니다.' : undefined);
    register('page.columns', '다단 설정', () => this.openColumnsDialog(), { available: () => !sectionReady(), reason: sectionReady });
    for (const [id, label, count] of [['page.columns-one', '단 하나', 1], ['page.columns-two', '단 둘', 2], ['page.columns-three', '단 셋', 3]] as const) {
      register(id, label, () => this.execute([{ type: 'setColumnSettings', section: this.activeSectionIndex(), properties: { count } }]), { available: () => !sectionReady(), reason: sectionReady });
    }
    register('page.border-fill', '쪽 테두리 / 배경', () => this.openPageBorderDialog(), { available: () => !sectionReady(), reason: sectionReady });
    register('page.section-settings', '구역 설정', () => this.openSectionSettingsDialog(), { available: () => !sectionReady(), reason: sectionReady });
    const pageHideReason = (): string | undefined => bodyEditReason() ?? (!this.formattingModel ? '쪽 정보를 아직 읽지 못했습니다.' : undefined);
    register('page.hide', '현재 쪽 감추기', () => this.openPageHideDialog(), { available: () => !pageHideReason(), reason: pageHideReason });
    register('page.new-number', '새 번호로 시작', () => this.openNewNumberDialog(), { available: () => !bodyEditReason(), reason: bodyEditReason });
    register('table.merge-cells', '선택 셀 병합', () => this.mergeSelectedCells(), { available: () => !tableEditReason(), reason: tableEditReason });
    register('table.split-cell', '선택 셀 나누기', () => this.splitSelectedCell(), { available: () => !tableEditReason(), reason: tableEditReason });
    for (const [operation, label] of [['thousands', '1,000 단위 구분 쉼표'], ['decimal-add', '자릿점 넣기'], ['decimal-remove', '자릿점 빼기']] as const) {
      register(`table.${operation}`, label, () => this.formatCellNumbers(operation), { available: () => !tableEditReason(), reason: tableEditReason });
    }
    register('table.borders-each', '각 셀마다 적용', () => this.openCellFormatDialog('each'), { available: () => !tableEditReason(), reason: tableEditReason });
    register('table.borders-outside', '하나의 셀처럼 적용', () => this.openCellFormatDialog('outside'), { available: () => !tableEditReason(), reason: tableEditReason });
    register('table.cell-properties', '표 / 셀 속성', () => this.openCellFormatDialog(), { available: () => !tableEditReason(), reason: tableEditReason });
    register('table.formula', '계산식', () => this.openFormulaDialog(), { available: () => !tableEditReason(), reason: tableEditReason });
    for (const [id, label, fn] of [['table.block-sum', '블록 합계', 'SUM'], ['table.block-average', '블록 평균', 'AVERAGE'], ['table.block-product', '블록 곱', 'PRODUCT']] as const) {
      register(id, label, () => this.blockCalculation(fn), { available: () => !tableEditReason(), reason: tableEditReason });
    }
    register('table.equalize-widths', '셀 너비를 같게', () => this.equalizeSelectedTable('width'), { available: () => !tableEditReason(), reason: tableEditReason });
    register('table.equalize-heights', '셀 높이를 같게', () => this.equalizeSelectedTable('height'), { available: () => !tableEditReason(), reason: tableEditReason });
    register('table.transpose', '행/열 바꿈', () => this.transposeSelectedTable(), { available: () => !tableEditReason(), reason: tableEditReason });
    const splitTableReason = (): string | undefined => tableEditReason() ?? (this.selectedTableCell()!.cell.row < 1 ? '나눌 위치의 줄(둘째 줄 이후)에 캐럿을 두세요. 그 줄부터 새 표가 됩니다.' : undefined);
    register('table.split-table', '표 나누기', () => this.splitSelectedTable(), { available: () => !splitTableReason(), reason: splitTableReason });
    register('table.merge-next', '표 붙이기', () => this.mergeNextTable(), { available: () => !tableEditReason(), reason: tableEditReason });
    register('table.delete', '표 지우기', () => this.deleteSelectedTable(), { available: () => !tableEditReason(), reason: tableEditReason });
    register('table.caption-toggle', '표 캡션 넣기/빼기', () => this.toggleTableCaption(), { available: () => !tableEditReason(), reason: tableEditReason });
    const tableStructureCommands: Array<[string, string, TableStructureAction, string?]> = [
      ['table.insert-row-above', '위에 행 삽입', 'insert-row-above'],
      ['table.insert-row-below', '아래에 행 삽입', 'insert-row-below'],
      ['table.delete-row', '행 삭제', 'delete-row'],
      ['table.insert-column-left', '왼쪽에 칸 삽입', 'insert-column-left'],
      ['table.insert-column-right', '오른쪽에 칸 삽입', 'insert-column-right'],
      ['table.delete-column', '칸 삭제', 'delete-column'],
    ];
    for (const [id, label, action, shortcut] of tableStructureCommands) register(id, label, () => this.editTableStructure(action), {
      ...(shortcut ? { shortcut } : {}), available: () => !tableStructureReason(action), reason: () => tableStructureReason(action),
    });
    register('table.insert-dialog', '줄/칸 추가하기…', () => this.openTableStructureDialog('insert'), { shortcut: 'Alt+Enter', available: () => !tableEditReason(), reason: tableEditReason });
    register('table.delete-dialog', '줄/칸 지우기…', () => this.openTableStructureDialog('delete'), { shortcut: 'Alt+Delete', available: () => !tableEditReason(), reason: tableEditReason });
    register('object.delete', '선택 개체 삭제', () => this.deleteSelectedObject(), {
      available: () => !!this.selectedObject && !editBlockReason() && this.selectedObject.address.kind === 'body' && !this.selectedObject.address.cellPath?.length,
      reason: () => !this.selectedObject ? '먼저 본문 개체를 선택하세요.' : editBlockReason() ?? '본문 개체만 삭제할 수 있습니다.',
    });
    const shapeOrPictureReason = (): string | undefined => {
      const object = this.selectedObject;
      return editBlockReason() ?? (object && object.address.kind === 'body' && !object.address.cellPath?.length && (object.kind === 'picture' || object.kind === 'shape')
        ? undefined : '본문의 그림이나 도형을 선택하세요. 수식은 지원하지 않습니다.');
    };
    register('object.rotate', '개체 회전', () => this.openObjectRotationDialog(), { available: () => !shapeOrPictureReason(), reason: shapeOrPictureReason });
    register('object.rotate-right', '오른쪽 90° 회전', () => this.rotateSelectedObject(90), { available: () => !shapeOrPictureReason(), reason: shapeOrPictureReason });
    register('object.rotate-left', '왼쪽 90° 회전', () => this.rotateSelectedObject(-90), { available: () => !shapeOrPictureReason(), reason: shapeOrPictureReason });
    register('object.flip-horizontal', '좌우 대칭', () => this.flipSelectedObject('horzFlip'), { available: () => !shapeOrPictureReason(), reason: shapeOrPictureReason });
    register('object.flip-vertical', '상하 대칭', () => this.flipSelectedObject('vertFlip'), { available: () => !shapeOrPictureReason(), reason: shapeOrPictureReason });
    const pictureReason = (): string | undefined => shapeOrPictureReason() ?? (this.selectedObject?.kind === 'picture' ? undefined : '캡션은 그림에서만 지원합니다.');
    register('object.caption-toggle', '그림 캡션 넣기/빼기', () => this.toggleSelectedPictureCaption(), { available: () => !pictureReason(), reason: pictureReason });
    for (const [id, label, operation] of [['object.z-front', '맨 앞으로', 'front'], ['object.z-forward', '앞으로', 'forward'], ['object.z-backward', '뒤로', 'backward'], ['object.z-back', '맨 뒤로', 'back'],
      ['object.z-in-front-of-text', '글 앞으로', 'inFrontOfText'], ['object.z-behind-text', '글 뒤로', 'behindText']] as const) {
      register(id, label, () => this.reorderSelectedObject(operation), { available: () => !shapeOrPictureReason(), reason: shapeOrPictureReason });
    }
    register('object.group', '개체 묶기', () => this.openObjectGroupDialog(), { available: () => !editBlockReason() && !!this.documentTree, reason: () => editBlockReason() ?? '문서 구조를 아직 읽지 못했습니다.' });
    const ungroupReason = (): string | undefined => shapeOrPictureReason() ?? (this.selectedObject?.kind === 'shape' ? undefined : '묶음 도형을 선택하세요.');
    register('object.ungroup', '개체 풀기', () => this.ungroupSelectedObject(), { available: () => !ungroupReason(), reason: ungroupReason });
    register('object.edit-properties', '선택 개체 속성', () => this.openObjectPropertiesDialog(), {
      available: () => !objectEditReason(), reason: objectEditReason,
    });
    register('tool.find', '찾기', () => { this.focusToolInput(this.searchQueryInput); }, { shortcut: 'Mod+F', available: () => !!this.state, reason: () => '문서를 먼저 여세요.' });
    register('tool.replace', '바꾸기', () => { this.focusToolInput(this.searchReplacementInput); }, { shortcut: 'Mod+H', available: () => !!this.state, reason: () => '문서를 먼저 여세요.' });
    register('tool.replace-current', '현재 검색 결과 바꾸기', () => this.replaceCurrentSearchResult(), {
      available: () => {
        const target = this.currentSearchTarget();
        return this.searchRevision === this.state?.revision && target?.searchResult === true
          && target.address.kind === 'body' && !target.address.cellPath?.length
          && !/[\r\n\u2028]/u.test(this.searchReplacementInput?.value ?? '');
      },
      reason: () => {
        const target = this.currentSearchTarget();
        if (this.searchRevision !== this.state?.revision) return '먼저 최신 검색 결과를 만드세요.';
        if (!target?.searchResult) return '바꿀 검색 결과를 선택하세요.';
        if (target.address.kind !== 'body' || target.address.cellPath?.length) return '현재 결과 바꾸기는 본문 문단만 지원합니다.';
        if (/[\r\n\u2028]/u.test(this.searchReplacementInput?.value ?? '')) return '현재 결과 바꾸기는 한 문단 안의 텍스트만 삽입할 수 있습니다.';
        return undefined;
      },
    });
    register('tool.next-search-result', '다음 검색 결과', () => this.showAdjacentSearchResult(1), { shortcut: 'Mod+L' });
    const menuItem = (id: string): MenuBarItem => {
      const command = this.commandRegistry.get(id);
      if (!command) throw new Error(`메뉴에서 명령을 찾을 수 없습니다: ${id}`);
      return {
        label: command.label,
        ...(command.shortcut ? { shortcut: command.shortcut } : {}),
        disabled: () => !this.commandRegistry.isAvailable(id),
        disabledReason: () => command.unavailableReason?.(),
        action: () => { void this.runEditorCommand(id); },
      };
    };
    const resolve = (item: MenuDefinitionItem): MenuBarItem => {
      if (item.kind === 'separator') return { label: '', separator: true };
      if (item.kind === 'disabled') return { label: item.label, disabled: () => true, disabledReason: () => item.reason };
      if (item.kind === 'submenu') return { label: item.label, children: item.items.map(resolve) };
      const resolved = menuItem(item.id);
      if (item.label) resolved.label = item.label;
      if (item.checked) resolved.checked = () => {
        switch (item.id) {
          case 'view.ruler': return this.rulerVisible;
          case 'view.grid': return this.gridSettings.visible;
          case 'view.form-mode': return this.formMode;
          case 'view.control-codes': return !!this.renderOptions.showControlCodes;
          case 'view.paragraph-marks': return !!this.renderOptions.showParagraphMarks;
          case 'view.transparent-borders': return !!this.renderOptions.showTransparentBorders;
          case 'view.overflow': return !!this.renderOptions.showOverflow;
          default: return false;
        }
      };
      return resolved;
    };
    this.disposeMenuBar = mountMenuBar(parent, EDITOR_MENU_DEFINITION.map(group => ({ label: group.label, items: group.items.map(resolve) })));
  }
  private build(): void {
    this.disposeMenuBar?.(); this.disposeMenuBar = undefined;
    this.commandToolbar?.dispose(); this.commandToolbar = undefined; this.storyToolbar?.dispose(); this.storyToolbar = undefined;
    this.formatToolbarResizeObserver?.disconnect(); this.formatToolbarResizeObserver = undefined; this.characterEffectsMenu?.dispose(); this.characterEffectsMenu = undefined;
    this.contentEl.empty(); this.contentEl.addClass('hwp-hands');
    this.contentEl.toggleClass('hwp-hands-preview-enabled', this.plugin.settings.editorPreviewEnabled);
    this.setEditorChrome(this.plugin.settings.editorChrome);
    const menuHost = this.contentEl.createDiv({ cls: 'hwp-menubar-host' });
    this.installMenuBar(menuHost);
    this.button(menuHost, '⌃', () => this.toggleToolbars()).setAttr('aria-label', '기본 도구 상자 접기/펴기');
    menuHost.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.contentEl.hasClass('hwp-menu-temporary')) this.contentEl.removeClass('hwp-menu-temporary');
    });
    menuHost.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('.hwp-menu-item')) this.contentEl.removeClass('hwp-menu-temporary');
    });
    const toolbar = this.contentEl.createDiv({ cls: 'hwp-toolbar' });
    // Hancom Office's 편집 ribbon order: 저장, 클립보드, 찾기, 입력, 각주·미주, 하이퍼링크·문자표, 모양, 개체, 머리말·꼬리말, 보기.
    // Lists, alignment and character effects live in the format toolbox below it, as in Hancom's second row.
    this.commandToolbar = mountCommandToolbar(toolbar, this.commandRegistry, [
      { label: '저장', tools: [{ command: 'file.save', icon: 'save', label: '저장하기' }] },
      { label: '클립보드', tools: [
        { command: 'edit.cut', icon: 'scissors', label: '오려 두기' },
        { command: 'edit.copy', icon: 'copy', label: '복사하기' },
        { command: 'edit.paste', icon: 'clipboard-paste', label: '붙이기' },
        { command: 'format.copy-style', icon: 'paintbrush', label: '모양 복사' },
      ] },
      { label: '찾기', tools: [{ command: 'tool.find', icon: 'search', label: '찾기', menu: FIND_MENU_COMMANDS }] },
      { label: '입력', tools: [
        { command: 'insert.shape-draw', icon: 'shapes', label: '도형' },
        { command: 'insert.picture-file', icon: 'image', label: '그림' },
        { command: 'insert.table', icon: 'table', label: '표' },
      ] },
      { label: '각주·미주', tools: [
        { command: 'insert.footnote', icon: 'superscript', label: '각주' },
        { command: 'insert.endnote', icon: 'list-end', label: '미주' },
      ] },
      { label: '하이퍼링크·문자표', tools: [
        { command: 'insert.hyperlink', icon: 'link', label: '하이퍼링크' },
        { command: 'insert.character-table', icon: 'omega', label: '문자표' },
      ] },
      { label: '모양', tools: [
        { command: 'format.character-dialog', icon: 'type', label: '글자 모양' },
        { command: 'format.paragraph-dialog', icon: 'align-left', label: '문단 모양' },
      ] },
      { label: '개체', tools: [{ command: 'object.edit-properties', icon: 'settings-2', label: '개체 속성' }] },
      { label: '개체 방향', visible: () => this.selectedObject?.kind === 'picture' || this.selectedObject?.kind === 'shape', tools: [
        { command: 'object.rotate-left', icon: 'rotate-ccw', label: '왼쪽 회전' },
        { command: 'object.rotate-right', icon: 'rotate-cw', label: '오른쪽 회전' },
        { command: 'object.flip-horizontal', icon: 'flip-horizontal', label: '좌우 대칭' },
        { command: 'object.flip-vertical', icon: 'flip-vertical', label: '상하 대칭' },
      ] },
      { label: '머리말·꼬리말', tools: [
        { command: 'page.header-footer-template', icon: 'panel-top', label: '머리말' },
        { command: 'page.footer-template', icon: 'panel-bottom', label: '꼬리말' },
      ] },
      { label: '보기', tools: [
        { command: 'view.control-codes', icon: 'pilcrow', label: '조판 부호' },
        { command: 'view.paragraph-marks', icon: 'text-cursor', label: '문단 부호' },
        { command: 'view.grid', icon: 'grid', label: '격자 보기' },
      ] },
      { label: '검토', tools: [
        { command: 'edit.compare', icon: 'git-compare', label: '변경 비교' },
        { command: 'edit.document-history', icon: 'history', label: '이력 관리' },
      ] },
      // Commands with no button above, grouped by menu. Groups that do not fit the pane join them under 더 보기.
      { label: '쪽', overflow: true, tools: [
        { command: 'insert.page-break', icon: 'file-plus' },
        { command: 'insert.column-break', icon: 'columns' },
        { command: 'page.columns', icon: 'columns-2' },
        { command: 'page.border-fill', icon: 'square-dashed' },
        { command: 'page.section-settings', icon: 'file-cog' },
        { command: 'page.new-number', icon: 'list-start' },
        { command: 'page.hide', icon: 'eye-off' },
      ] },
      { label: '표', overflow: true, tools: [
        { command: 'table.cell-properties', icon: 'settings-2' },
        { command: 'table.insert-row-below', icon: 'rows-3' },
        { command: 'table.delete-row', icon: 'rows-2' },
        { command: 'table.insert-column-right', icon: 'columns-3' },
        { command: 'table.delete-column', icon: 'columns-2' },
        { command: 'table.merge-cells', icon: 'combine' },
        { command: 'table.split-cell', icon: 'split' },
        { command: 'table.formula', icon: 'sigma' },
        { command: 'table.transpose', icon: 'arrow-right-left' },
        { command: 'table.split-table', icon: 'separator-horizontal' },
        { command: 'table.merge-next', icon: 'merge' },
      ] },
      { label: '입력과 개체', overflow: true, tools: [
        { command: 'insert.endnote-shape', icon: 'settings-2' },
        { command: 'insert.bookmark', icon: 'bookmark' },
        { command: 'object.rotate', icon: 'rotate-cw' },
        { command: 'object.z-front', icon: 'bring-to-front' },
        { command: 'object.group', icon: 'group' },
      ] },
      { label: '배율', overflow: true, tools: [
        { command: 'view.fit-width', icon: 'move-horizontal' },
        { command: 'view.fit-page', icon: 'maximize' },
      ] },
    ], id => this.runEditorCommand(id), (button, icon) => setIcon(button, icon));
    this.storyToolbar = mountCommandToolbar(toolbar, this.commandRegistry, [{ label: '본문 밖 영역 편집', tools: [
      { command: 'story.previous', icon: 'chevron-left', label: '이전' },
      { command: 'story.next', icon: 'chevron-right', label: '다음' },
      { command: 'story.close', icon: 'x', label: '닫기' },
      { command: 'story.delete', icon: 'trash-2', label: '지우기' },
      { command: 'story.page-number', icon: 'hash', label: '쪽 번호' },
      { command: 'story.total-pages', icon: 'files', label: '총 쪽수' },
      { command: 'story.file-name', icon: 'file-text', label: '파일 이름' },
    ] }, { label: '추가 도구', overflow: true, tools: [] }], id => this.runEditorCommand(id), (button, icon) => setIcon(button, icon));
    this.storyToolbar.element.hidden = true;
    this.statusEl = this.contentEl.createDiv({ cls: 'hwp-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.statusPageButton = this.button(this.statusEl, '1/1쪽', () => this.runEditorCommand('view.go-to-page'));
    if (this.statusPageButton) this.statusPageButton.setAttribute('aria-label', '쪽 번호로 이동');
    this.statusTextEl = this.statusEl.createSpan({ cls: 'hwp-status-text' });
    // The save/activity state never shrinks: a narrow tab ellipsizes the context text before it hides whether the document is saved.
    this.statusActivityEl = this.statusEl.createSpan({ cls: 'hwp-status-activity' });
    this.autosaveStatusEl = this.statusEl.createSpan({ cls: 'hwp-autosave-status', attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
    this.autosaveStatusEl.hidden = true;
    this.statusBannersEl = this.contentEl.createDiv({ cls: 'hwp-status-banners', attr: { role: 'region', 'aria-label': '문서 상태 알림' } });
    this.statusBannersEl.hidden = true;
    this.layoutWarningEl = this.statusBannersEl.createDiv({ cls: 'hwp-layout-warning', attr: { role: 'status', 'aria-live': 'polite' } });
    this.layoutWarningEl.setText('미주 위치와 쪽 나눔은 한컴 한글과 다를 수 있습니다. 최종 페이지를 확인할 때 한컴 한글에서 다시 여세요.');
    this.layoutWarningEl.hidden = true;
    this.resolutionPanel = this.statusBannersEl.createDiv({ cls: 'hwp-resolution-panel', attr: { role: 'group', 'aria-label': '저장, 충돌 및 복구 작업' } });
    this.resolutionMessage = this.resolutionPanel.createDiv({ cls: 'hwp-resolution-message', attr: { role: 'status', 'aria-live': 'polite' } });
    const resolutionActions = this.resolutionPanel.createDiv({ cls: 'hwp-edit-actions' });
    this.compareChangesButton = this.button(resolutionActions, '변경 비교', () => this.showDocumentChanges());
    this.saveCopyButton = this.button(resolutionActions, '변경본을 새 파일로 저장', () => this.saveAs());
    this.reloadConflictButton = this.button(resolutionActions, '디스크에서 다시 불러오기', () => this.reloadFromDisk());
    this.recoverInputButton = this.button(resolutionActions, '입력 복구 목록', () => this.openInputRecovery());
    this.resolutionPanel.hidden = true;
    // AI edits a person has not looked through yet. The marks are a review aid; saving stays a separate decision.
    this.editMarksEl = this.statusBannersEl.createDiv({ cls: 'hwp-edit-marks-banner', attr: { role: 'group', 'aria-label': '검토하지 않은 AI 편집' } });
    this.editMarksTextEl = this.editMarksEl.createSpan({ cls: 'hwp-edit-marks-text', attr: { role: 'status', 'aria-live': 'polite' } });
    this.button(this.editMarksEl, '위치 보기', () => this.revealNextEditMark());
    this.button(this.editMarksEl, '검토 완료', () => { if (this.path) this.plugin.editMarks.clear(this.path); });
    this.editMarksEl.hidden = true;
    const layout = this.contentEl.createDiv({ cls: 'hwp-layout' });
    const preview = layout.createDiv({ cls: 'hwp-preview' });
    const navigation = preview.createDiv({ cls: 'hwp-navigation' });
    this.button(navigation, '이전 쪽', () => this.runEditorCommand('view.previous-page'));
    this.pageLabel = navigation.createSpan({ attr: { role: 'status', 'aria-live': 'polite' } });
    this.button(navigation, '다음 쪽', () => this.runEditorCommand('view.next-page'));
    this.pageInput = navigation.createEl('input', { type: 'number', value: '1', cls: 'hwp-page-number', attr: { min: '1', step: '1', 'aria-label': '이동할 쪽 번호' } });
    this.button(navigation, '쪽 이동', () => this.goToPage());
    this.pageInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void this.guard(() => this.goToPage()); } };
    this.sectionGotoSelect = navigation.createEl('select', { attr: { 'aria-label': '이동할 구역' } });
    this.button(navigation, '구역 이동', () => this.goToSection());
    this.button(navigation, '폭 맞춤', () => this.runEditorCommand('view.fit-width'));
    this.button(navigation, '쪽 맞춤', () => this.runEditorCommand('view.fit-page'));
    this.zoomPreset = navigation.createEl('select', { cls: 'hwp-zoom-preset', attr: { 'aria-label': '미리보기 배율 프리셋' } });
    for (const [value, label] of [
      ['fit-width', '폭 맞춤'], ['fit-page', '쪽 맞춤'], ['50', '50%'], ['75', '75%'], ['100', '100%'],
      ['125', '125%'], ['150', '150%'], ['200', '200%'], ['300', '300%'], ['400', '400%'], ['500', '500%'], ['custom', '사용자 지정'],
    ]) this.zoomPreset.createEl('option', { value, text: label });
    this.zoomPreset.onchange = () => this.applyZoomPreset(this.zoomPreset.value);
    this.zoomInput = navigation.createEl('input', { type: 'range', value: '100', cls: 'hwp-zoom-input', attr: { min: '50', max: '500', step: '10', 'aria-label': '미리보기 배율' } });
    this.zoomLabel = navigation.createSpan({ text: '폭 맞춤', attr: { role: 'status', 'aria-live': 'polite' } });
    this.zoomInput.oninput = () => {
      this.zoomMode = 'custom';
      this.pageStack?.setScale(Number(this.zoomInput.value));
    };
    this.button(navigation, '−', () => this.runEditorCommand('view.zoom-out')).setAttr('aria-label', '축소');
    this.button(navigation, '+', () => this.runEditorCommand('view.zoom-in')).setAttr('aria-label', '확대');
    this.statusEl.append(navigation);
    const displayOptions = preview.createEl('details', { cls: 'hwp-view-options' });
    displayOptions.createEl('summary', { text: '쪽 표시 옵션' });
    const displayControls = displayOptions.createDiv({ cls: 'hwp-edit-search-options' });
    const addDisplayOption = (key: keyof PageRenderOptions, label: string): void => {
      const optionLabel = displayControls.createEl('label', { cls: 'hwp-check-label' });
      const input = optionLabel.createEl('input', { type: 'checkbox', attr: { 'aria-label': label } });
      input.checked = this.renderOptions[key] ?? false;
      this.displayOptionInputs.set(key, input);
      optionLabel.appendText(` ${label}`);
      input.addEventListener('change', () => {
        this.renderOptions = { ...this.renderOptions, [key]: input.checked };
        void this.pageStack?.invalidateAll();
      });
    };
    addDisplayOption('showParagraphMarks', '문단 부호');
    addDisplayOption('showControlCodes', '조판 부호');
    addDisplayOption('showTransparentBorders', '투명 선');
    addDisplayOption('showOverflow', '잘림 보기');
    this.previewEl = preview;
    const rulerHost = preview.createDiv({ cls: 'hwp-ruler-host', attr: { 'aria-hidden': 'true' } });
    const horizontalRuler = rulerHost.createEl('canvas', { cls: 'hwp-ruler hwp-ruler-h' });
    const scrollRow = preview.createDiv({ cls: 'hwp-scroll-row' });
    const verticalRuler = scrollRow.createEl('canvas', { cls: 'hwp-ruler hwp-ruler-v', attr: { 'aria-hidden': 'true' } });
    this.rulers = new PageRulers(horizontalRuler, verticalRuler);
    preview.toggleClass('hwp-ruler-on', this.rulerVisible);
    const scroll = this.pageScroll = scrollRow.createDiv({ cls: 'hwp-page-scroll', attr: { role: 'region', tabindex: '0', 'aria-label': '문서 쪽 미리보기. 스크롤해 문서 쪽을 보고 편집할 대상을 선택할 수 있습니다.' } });
    this.pageImages = new SvgPageImages(this.contentEl.ownerDocument);
    this.pageStack = new PageStack(scroll, {
      onActivate: (page, element) => this.onActivePageChanged(page, element),
      onUnmount: page => { this.pageLayouts.delete(page); this.pageImages?.release(page); },
      onMount: (page, element) => { this.updatePageSelectionOverlay(); this.applyGridToPage(page, element); this.scheduleRulerDraw(); },
      onScaleChange: percent => { this.reflectZoomScale(percent); this.applyGridToAllPages(); this.scheduleRulerDraw(); this.pageStack?.rerasterize(); },
      onRenderError: error => this.plugin.report(error),
    });
    this.pageStack.setRenderer((page, element, isCurrent) => this.renderPageInto(page, element, isCurrent));
    this.pageStack.setDocument(1, -1, []);
    this.pageResizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (this.zoomMode === 'fit-page' && this.pageLayout) this.applyZoomPreset('fit-page');
      this.scheduleRulerDraw();
    });
    this.pageResizeObserver?.observe(scroll);
    scroll.addEventListener('scroll', () => this.scheduleRulerDraw(), { passive: true });
    this.navigationStatus = this.statusEl.createDiv({ cls: 'hwp-navigation-status', attr: { role: 'status', 'aria-live': 'polite' } });
    scroll.addEventListener('pointerdown', event => this.startPageDrag(event));
    scroll.addEventListener('pointermove', event => this.autoScrollPageSelection(event));
    scroll.addEventListener('pointerup', event => this.finishPageDrag(event));
    scroll.addEventListener('pointercancel', () => {
      this.pageDragStart = undefined; this.pageCellDragStart = undefined; this.pageDragPreview = undefined; this.objectDragStart = undefined; this.tableResizeStart = undefined; this.shapeDrawStart = undefined;
      this.pageStack?.mountedPages().forEach(item => item.element.querySelectorAll('.hwp-shape-draw-preview, .hwp-table-resize-guide').forEach(overlay => overlay.remove()));
      this.updatePageSelectionOverlay();
    });
    scroll.addEventListener('keydown', event => this.onObjectKeydown(event));
    scroll.addEventListener('contextmenu', event => {
      const page = this.pageStack?.pageForTarget(event.target);
      if (page === undefined) return;
      event.preventDefault();
      void this.guard(() => this.showPageContextMenu(event, page));
    });
    scroll.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    });
    scroll.addEventListener('drop', event => {
      const page = this.pageStack?.pageForTarget(event.target);
      if (page === undefined || !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      const image = Array.from(event.dataTransfer.files).map(file => this.clipboardImage(file)).find((file): file is File => !!file);
      if (!image) { new Notice('PNG, JPG, GIF, BMP 그림 파일을 쪽 위에 놓으세요.'); return; }
      void this.guard(async () => {
        if (this.draft || this.composing) throw new Error('입력을 적용하고 한글 조합을 마친 뒤 그림을 놓으세요.');
        await this.pageStack?.setActivePage(page);
        const position = await this.selectPageTarget(event, undefined, undefined, true, page);
        if (!position) throw new Error('그림을 넣을 본문 문단 위치를 찾지 못했습니다.');
        if (position.address.kind !== 'body' || position.address.cellPath?.length || position.address.containerKinds?.includes('textBox')) {
          throw new Error('그림 파일은 글상자나 표 셀이 아닌 본문 문단에 놓으세요.');
        }
        await this.insertPicture(image);
      });
    });
    scroll.addEventListener('click', event => {
      if (event.target === this.textarea) return;
      const page = this.pageStack?.pageForTarget(event.target);
      if (page === undefined) return;
      if (this.suppressPageClick) { this.suppressPageClick = false; return; }
      void this.guardInput(async () => {
        // Direct mode commits typing as it happens, so a click right after typing finds a draft; apply it rather than refuse the click.
        if (this.draft && !this.composing) await this.applyDraft();
        await this.pageStack?.setActivePage(page);
        const anchor = event.shiftKey ? this.selectionAnchor : undefined;
        const position = await this.selectPageTarget(event, undefined, undefined, true, page);
        if (!position) return;
        if (event.detail >= 3) this.selectPageTextAt(position, true);
        else if (event.detail === 2) this.selectPageTextAt(position, false);
        else if (anchor) {
          const range = this.documentRange({ start: anchor, end: position });
          if (range && !this.rangeIsCollapsed(range)) this.setPageRangeSelection(range, position, anchor);
        } else this.selectionAnchor = position;
      });
    });
    const editor = layout.createDiv({ cls: 'hwp-edit-panel' });
    editor.createEl('h3', { text: '내용 편집' });
    editor.createEl('p', { cls: 'hwp-hint', text: '페이지에서 문단을 클릭하거나 드래그해 바로 편집하세요. 입력은 짧은 입력 묶음 뒤 문서에 자동 반영되고 Ctrl+Z로 되돌릴 수 있습니다. 한글 조합은 조합이 끝난 뒤 반영합니다. Enter는 문단을 나누고, 문단 앞뒤의 Backspace/Delete는 이웃 문단과 병합합니다.' });
    const mode = this.modeSelector = editor.createEl('select', { attr: { 'aria-label': '편집 대상 종류' } });
    for (const [value, label] of [['paragraphs', '본문 문단'], ['cells', '표 셀'], ['stories', '본문 밖 영역'], ['fields', '누름틀 / 필드']]) mode.createEl('option', { value, text: label });
    mode.onchange = () => {
      if (this.formMode) { mode.value = 'fields'; new Notice('양식 모드에서는 누름틀만 이동할 수 있습니다.'); return; }
      if (this.draft || this.composing) { mode.value = this.mode; new Notice('편집 중인 내용을 적용하거나 취소하세요.'); return; }
      this.mode = mode.value as typeof this.mode; void this.refresh();
    };
    this.selector = editor.createEl('select', { cls: 'hwp-target-select', attr: { 'aria-label': '편집할 문단 또는 셀' } });
    this.selector.onchange = () => {
      if (this.draft || this.composing) { this.selector.value = String(this.items.indexOf(this.selected!)); new Notice('편집 중인 내용을 적용하거나 취소하세요.'); return; }
      this.selectItem(Number(this.selector.value), false);
    };
    const itemPaging = editor.createDiv({ cls: 'hwp-edit-actions hwp-item-paging' });
    this.itemPagePrevious = this.button(itemPaging, '이전 100개', () => { this.itemPage--; this.renderItemPage(); });
    this.itemPageStatus = itemPaging.createSpan({ attr: { role: 'status', 'aria-live': 'polite' } });
    this.itemPageNext = this.button(itemPaging, '다음 100개', () => { this.itemPage++; this.renderItemPage(); });
    this.infoEl = editor.createDiv({ cls: 'hwp-target-info', attr: { role: 'status', 'aria-live': 'polite', tabindex: '-1' } });
    this.textareaHome = editor.createDiv({ cls: 'hwp-text-input-home' });
    this.textarea = this.textareaHome.createEl('textarea', { cls: 'hwp-text-input', attr: { 'aria-label': '문서 내용', spellcheck: 'false' } });
    this.textarea.addEventListener('focus', () => this.contentEl.addClass('hwp-selection-active'));
    this.textarea.addEventListener('blur', () => this.contentEl.removeClass('hwp-selection-active'));
    this.textarea.addEventListener('compositionstart', () => {
      markDocumentInput(this.textarea.ownerDocument);
      this.composing = true;
      this.directComposition = { start: this.textarea.selectionStart, end: this.textarea.selectionEnd, text: '', baseText: this.textarea.value };
      this.syncInlineEditor(); this.updateStatus(); this.updateToolState();
    });
    this.textarea.addEventListener('compositionupdate', event => {
      markDocumentInput(this.textarea.ownerDocument);
      this.lastInputAt = performance.now();
      this.updateAutosaveInput(true);
      if (this.directComposition) { this.directComposition.text = (event).data; this.syncInlineEditor(); }
    });
    this.textarea.addEventListener('compositionend', () => {
      markDocumentInput(this.textarea.ownerDocument);
      this.directComposition = undefined;
      this.composing = false;
      if (this.draft) this.draftAutosave.schedule(this.captureInputDraft());
      if (this.draft || this.pendingLiveRebase) this.scheduleLiveCommit();
      this.syncPageSelectionFromTextarea(); this.syncInlineEditor(); this.updateStatus(); this.updateToolState();
      const deferred = this.deferredCompositionCommand; this.deferredCompositionCommand = undefined;
      if (deferred) setTimeout(() => {
        if (this.path !== deferred.context.path || this.generation !== deferred.context.generation || this.composing) return;
        this.textarea.focus({ preventScroll: true }); void this.runEditorCommand(deferred.id);
      }, 0); // The browser's final input event follows compositionend.
    });
    this.textarea.addEventListener('beforeinput', event => this.onEditorBeforeInput(event));
    this.textarea.addEventListener('copy', event => this.onEditorCopy(event));
    this.textarea.addEventListener('cut', event => this.onEditorCut(event));
    this.textarea.addEventListener('paste', event => this.onEditorPaste(event));
    // Capture precedes callbacks that can schedule a cached SVG mount in another HWP leaf.
    this.textarea.addEventListener('input', () => markDocumentInput(this.textarea.ownerDocument), { capture: true });
    this.textarea.oninput = () => this.onEditorInput();
    this.textarea.onkeydown = event => this.onEditorKeydown(event);
    this.textarea.addEventListener('select', () => this.syncPageSelectionFromTextarea());
    this.textarea.addEventListener('keyup', () => this.syncPageSelectionFromTextarea());
    this.textarea.addEventListener('mousedown', () => {
      const range = this.pageSelection?.range, focus = this.pageSelection?.focus;
      if (!range || !focus || sameDocumentAddress(range.start.address, range.end.address)) return;
      this.pageSelection = { address: focus.address, start: focus.offset, end: focus.offset };
      this.selectionAnchor = focus; this.updatePageSelectionOverlay();
    });
    this.textarea.addEventListener('mouseup', () => {
      this.resetInputGroup(); this.syncPageSelectionFromTextarea();
      // A click inside the editor's own selected text collapses the caret only after mouseup and click have been dispatched (the
      // browser keeps the selection draggable until then), and no further event reports it. Read the caret again afterwards.
      const path = this.path, generation = this.generation;
      setTimeout(() => { if (path && path === this.path && generation === this.generation && !this.composing) this.syncPageSelectionFromTextarea(); }, 0);
    });
    const apply = editor.createDiv({ cls: 'hwp-edit-actions' });
    this.button(apply, '변경 적용', () => this.applyDraft());
    this.button(apply, '입력 취소', async () => {
      if (this.composing) throw new Error('한글 조합을 마친 뒤 입력을 취소하세요.');
      const unlock = this.lockInput();
      try { await this.discardAutosavedDraft(); this.draft = false; await this.refresh(); }
      finally { unlock(); }
    });
    this.toolReasonEl = editor.createDiv({ cls: 'hwp-tool-reason', attr: { role: 'status', 'aria-live': 'polite' } });
    const format = this.toolDetails(editor, '글자 · 문단 · 목록 · 스타일');
    this.formatStateEl = format.createDiv({ cls: 'hwp-format-state', attr: { 'aria-live': 'polite' } });
    const character = format.createDiv({ cls: 'hwp-edit-actions' });
    for (const [key, label] of [['bold', '굵게'], ['italic', '기울임'], ['underline', '밑줄'], ['strikethrough', '취소선']] as const) {
      // Hancom's 가 glyphs: the face shows the effect and the accessible name says it.
      const button = this.toolButton(character, '가', 'text', () => this.runEditorCommand(`format.${key}`));
      const shortcut = this.commandRegistry.get(`format.${key}`)?.shortcut;
      button.classList.add('hwp-format-glyph', `hwp-format-glyph-${key}`);
      button.setAttribute('aria-label', label);
      button.title = shortcut ? `${label} (${shortcut})` : label;
      this.characterButtons.set(key, button);
    }
    this.toolButton(character, '서식 해제', 'text', () => this.formatSelection({ bold: false, italic: false, underline: false, strikethrough: false }));
    this.toolButton(character, '모양 복사', 'text', () => this.runEditorCommand('format.copy-style'));
    this.applyCopiedStyleButton = this.toolButton(character, '모양 붙이기', 'text', () => this.runEditorCommand('format.apply-copied-style'));
    const fontRow = format.createDiv({ cls: 'hwp-edit-actions' });
    this.fontSizeInput = this.feature(fontRow.createEl('input', { type: 'number', value: '12', attr: { min: 1, max: 1000, step: '0.5', 'aria-label': '글자 크기 (pt)' } }), 'text');
    this.fontSizeInput.onchange = () => void this.guard(() => this.formatSelection({ fontSize: Number(this.fontSizeInput.value) }));
    this.toolButton(fontRow, '크기 −', 'text', () => this.runEditorCommand('format.font-size-decrease'));
    this.toolButton(fontRow, '크기 +', 'text', () => this.runEditorCommand('format.font-size-increase'));
    this.fontFamilyInput = this.feature(fontRow.createEl('input', { type: 'text', attr: { placeholder: '글꼴 이름', 'aria-label': '글꼴 이름' } }), 'text');
    this.fontFamilyInput.onchange = () => void this.guard(() => this.formatSelection({ fontFamily: this.fontFamilyInput.value.trim(), ...(this.fontLanguageSelect.value === 'all' ? {} : { fontLanguage: Number(this.fontLanguageSelect.value) }) }));
    const fontListId = `hwp-font-list-${randomUUID()}`;
    this.fontFamilyInput.setAttribute('list', fontListId);
    this.fontFamilySuggestions = fontRow.createEl('datalist', { attr: { id: fontListId } });
    this.toolButton(fontRow, '설치 글꼴 목록', 'text', () => this.loadSystemFonts());
    this.fontColorInput = this.feature(fontRow.createEl('input', { type: 'color', value: '#000000', attr: { 'aria-label': '글자 색상' } }), 'text');
    this.fontColorInput.onchange = () => void this.guard(() => this.formatSelection({ textColor: this.fontColorInput.value }));
    this.highlightColorInput = this.feature(fontRow.createEl('input', { type: 'color', value: '#ffff00', attr: { 'aria-label': '형광펜 색상' } }), 'text');
    this.highlightColorInput.onchange = () => void this.guard(() => this.formatSelection({ shadeColor: this.highlightColorInput.value }));
    this.toolButton(fontRow, '형광펜 없음', 'text', () => this.formatSelection({ shadeColor: '#ffffff' }));
    const paragraphFormat = format.createDiv({ cls: 'hwp-tool-grid' });
    this.alignmentSelect = this.feature(paragraphFormat.createEl('select', { attr: { 'aria-label': '문단 정렬' } }), 'paragraph');
    // Mixed or unread alignment selects this placeholder instead of leaving the box blank; it cannot be chosen.
    this.alignmentSelect.createEl('option', { value: '', text: '정렬 혼합 / 미확인', attr: { disabled: true, hidden: true } });
    for (const [value, label] of [['left', '왼쪽 정렬'], ['center', '가운데 정렬'], ['right', '오른쪽 정렬'], ['justify', '양쪽 정렬'], ['distribute', '배분 정렬'], ['split', '나눔 정렬']] as const) this.alignmentSelect.createEl('option', { value, text: label });
    this.alignmentSelect.onchange = () => { if (this.alignmentSelect.value) void this.guard(() => this.paragraphFormat(this.alignmentSelect.value as ParagraphAlignment)); };
    this.paragraphIndentInput = this.feature(paragraphFormat.createEl('input', { type: 'number', value: '0', attr: { step: '0.1', 'aria-label': '들여쓰기 (mm)', title: '들여쓰기 (mm)' } }), 'paragraph');
    this.paragraphSpacingBeforeInput = this.feature(paragraphFormat.createEl('input', { type: 'number', value: '0', attr: { min: '0', step: '0.1', 'aria-label': '앞 간격 (mm)', title: '문단 앞 간격 (mm)' } }), 'paragraph');
    this.paragraphSpacingAfterInput = this.feature(paragraphFormat.createEl('input', { type: 'number', value: '0', attr: { min: '0', step: '0.1', 'aria-label': '뒤 간격 (mm)', title: '문단 뒤 간격 (mm)' } }), 'paragraph');
    this.paragraphLineSpacingInput = this.feature(paragraphFormat.createEl('input', { type: 'number', value: '100', attr: { min: '0', step: '1', 'aria-label': '줄 간격 값 (%)', title: '줄 간격 값' } }), 'paragraph');
    this.paragraphLineSpacingTypeSelect = this.feature(paragraphFormat.createEl('select', { attr: { 'aria-label': '줄 간격 기준' } }), 'paragraph');
    for (const [value, label] of [['Percent', '퍼센트'], ['Fixed', '고정'], ['SpaceOnly', '여백만 지정'], ['Minimum', '최소']]) this.paragraphLineSpacingTypeSelect.createEl('option', { value, text: label });
    this.paragraphLineSpacingUnit = paragraphFormat.createEl('span', { cls: 'hwp-paragraph-unit-label', text: '%' });
    this.paragraphLineSpacingTypeSelect.onchange = () => {
      const percentMode = this.paragraphLineSpacingTypeSelect.value === 'Percent';
      const wasPercent = this.paragraphLineSpacingUnit.textContent === '%';
      this.paragraphLineSpacingUnit.setText(percentMode ? '%' : 'pt');
      this.paragraphLineSpacingInput.step = percentMode ? '1' : '0.1';
      this.paragraphLineSpacingInput.setAttribute('aria-label', `줄 간격 값 (${percentMode ? '%' : 'pt'})`);
      if (percentMode !== wasPercent) this.paragraphLineSpacingInput.value = percentMode ? '100' : '12';
    };
    this.lineSpacingDecreaseButton = this.toolButton(paragraphFormat, '줄 간격 −', 'paragraph', () => this.runEditorCommand('format.line-spacing-decrease'));
    this.lineSpacingIncreaseButton = this.toolButton(paragraphFormat, '줄 간격 +', 'paragraph', () => this.runEditorCommand('format.line-spacing-increase'));
    this.toolButton(paragraphFormat, '문단 속성 적용', 'paragraph', () => this.applyParagraphProperties());
    this.styleSelect = this.feature(format.createEl('select', { attr: { 'aria-label': '문단 스타일' } }), 'style');
    this.styleSelect.createEl('option', { value: '', text: '문단 스타일 선택' });
    this.styleSelect.onchange = () => { if (this.styleSelect.value) void this.guard(() => this.applyStyle(Number(this.styleSelect.value))); };
    this.listSelect = this.feature(format.createEl('select', { attr: { 'aria-label': '목록 서식' } }), 'list');
    this.listSelect.onchange = () => void this.guard(() => this.applyList(this.listSelect.value));
    this.numberingToggleButton = this.toolButton(format, '번호 목록', 'list', () => this.runEditorCommand('format.toggle-numbering'));
    this.bulletToggleButton = this.toolButton(format, '글머리표', 'list', () => this.runEditorCommand('format.toggle-bullet'));
    this.listLevelDownButton = this.toolButton(format, '수준 내리기', 'list', () => this.runEditorCommand('format.list-level-down'));
    this.listLevelUpButton = this.toolButton(format, '수준 올리기', 'list', () => this.runEditorCommand('format.list-level-up'));
    const formatToolbar = this.contentEl.ownerDocument.createElement('div');
    formatToolbar.className = 'hwp-format-toolbar'; formatToolbar.setAttribute('role', 'toolbar');
    formatToolbar.setAttribute('aria-label', '글자와 문단 서식'); formatToolbar.setAttribute('aria-orientation', 'horizontal');
    const formatScroller = this.contentEl.ownerDocument.createElement('div');
    formatScroller.className = 'hwp-format-toolbar-scroll'; formatToolbar.append(formatScroller);
    const formatOverflow = this.contentEl.ownerDocument.createElement('details');
    formatOverflow.className = 'hwp-format-toolbar-overflow';
    const formatOverflowSummary = this.contentEl.ownerDocument.createElement('summary');
    formatOverflowSummary.setAttribute('aria-label', '숨은 서식 도구'); formatOverflowSummary.textContent = '≡';
    const formatOverflowContent = this.contentEl.ownerDocument.createElement('div');
    formatOverflowContent.className = 'hwp-format-toolbar-overflow-content';
    formatOverflow.append(formatOverflowSummary, formatOverflowContent); formatToolbar.append(formatOverflow);
    const formatGroups: HTMLElement[] = [];
    const moveGroup = (label: string, elements: HTMLElement[]): void => {
      const group = this.contentEl.ownerDocument.createElement('div'); group.className = 'hwp-format-toolbar-group';
      group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
      for (const element of elements) group.append(element);
      formatScroller.append(group); formatGroups.push(group);
    };
    const characterControls = Array.from(character.children) as HTMLElement[];
    const fontControls = Array.from(fontRow.children) as HTMLElement[];
    const fontLanguage = this.fontLanguageSelect = format.createEl('select', { attr: { 'aria-label': '글꼴 적용 언어', title: '선택한 언어의 글꼴만 바꿉니다. 다른 언어의 글꼴은 유지합니다.' } });
    fontLanguage.createEl('option', { value: 'all', text: '모든 언어' });
    ['한글', '영문', '한자', '일본어', '기타', '기호', '사용자'].forEach((text, index) => fontLanguage.createEl('option', { value: String(index), text }));
    fontLanguage.onchange = () => this.updateToolState();
    this.toolbarLineSpacingSelect = this.feature(format.createEl('select', { attr: { 'aria-label': '문단 줄 간격 (%)' } }), 'paragraph');
    this.toolbarLineSpacingSelect.onchange = () => {
      if (!this.toolbarLineSpacingSelect.value) return;
      const lineSpacing = Number(this.toolbarLineSpacingSelect.value);
      void this.guard(() => this.applyParagraphFormat({ lineSpacing, lineSpacingType: 'Percent' }));
    };
    // Hancom starts its format row with 되돌리기 and 다시 실행; updateStatus keeps them in step with the registry.
    this.historyButtons = (['edit.undo', 'edit.redo'] as const).map(id => {
      const button = this.button(format, '', () => this.runEditorCommand(id));
      button.dataset.command = id; setIcon(button, id === 'edit.undo' ? 'undo-2' : 'redo-2');
      return button;
    });
    this.refreshHistoryButtons();
    moveGroup('되돌리기', this.historyButtons);
    moveGroup('스타일', [this.styleSelect]);
    moveGroup('글꼴 적용 언어', [fontLanguage]);
    moveGroup('글꼴', fontControls.slice(3, 6));
    const spinner = (decrease: HTMLButtonElement, increase: HTMLButtonElement, label: string): HTMLElement => {
      const controls = format.createDiv({ cls: 'hwp-format-spinner', attr: { role: 'group', 'aria-label': label } });
      for (const [button, text, name] of [[increase, '▴', `${label} 늘리기`], [decrease, '▾', `${label} 줄이기`]] as const) {
        button.setAttribute('aria-label', name); button.title = name; button.setText(text); controls.append(button);
      }
      return controls;
    };
    moveGroup('글자 크기', [fontControls[0], spinner(fontControls[1] as HTMLButtonElement, fontControls[2] as HTMLButtonElement, '글자 크기')]);
    this.characterEffectsMenu = createCommandMenuButton(character, this.commandRegistry, {
      label: '글자 효과', text: '효과', commands: CHARACTER_EFFECTS.map(([id]) => id),
      checked: id => { const effect = CHARACTER_EFFECTS.find(([command]) => command === id)?.[1]; return effect ? this.characterEffectState(effect) : undefined; },
      run: id => this.runEditorCommand(id),
    });
    this.feature(this.characterEffectsMenu.element, 'text');
    moveGroup('글자 모양', [...characterControls.slice(0, 4), this.characterEffectsMenu.element, this.characterEffectsMenu.menu]);
    moveGroup('색과 형광펜', fontControls.slice(6));
    const alignmentControls = format.createDiv({ cls: 'hwp-alignment-buttons' });
    for (const [value, label, icon] of [['left', '왼쪽 정렬', 'align-left'], ['center', '가운데 정렬', 'align-center'], ['right', '오른쪽 정렬', 'align-right'], ['justify', '양쪽 정렬', 'align-justify'], ['distribute', '배분 정렬', 'between-horizontal-start'], ['split', '나눔 정렬', 'between-horizontal-end']] as const) {
      const button = this.toolButton(alignmentControls, label, 'paragraph', () => this.runEditorCommand(`format.align-${value}`));
      button.setAttribute('aria-label', label); button.dataset.command = `format.align-${value}`;
      setIcon(button, icon); this.alignmentButtons.set(value, button);
    }
    moveGroup('정렬', [alignmentControls]);
    moveGroup('줄 간격', [this.toolbarLineSpacingSelect, spinner(this.lineSpacingDecreaseButton, this.lineSpacingIncreaseButton, '줄 간격')]);
    moveGroup('목록', [this.listSelect, this.numberingToggleButton, this.bulletToggleButton, this.listLevelDownButton, this.listLevelUpButton]);
    // Clearing and copying character shapes is not on Hancom's format row, so it goes last and is the first to move under ≡.
    moveGroup('글자 기타', characterControls.slice(4));
    this.statusEl.before(formatToolbar);
    const fitFormatGroups = (): void => {
      if (!formatToolbar.clientWidth) return;
      formatOverflow.hidden = false;
      for (const group of formatGroups) formatScroller.append(group);
      for (let index = formatGroups.length - 1; index >= 0 && formatScroller.scrollWidth > formatScroller.clientWidth; index--) {
        formatOverflowContent.prepend(formatGroups[index]);
      }
      formatOverflow.hidden = !formatOverflowContent.children.length;
    };
    this.formatToolbarResizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fitFormatGroups);
    this.formatToolbarResizeObserver?.observe(formatToolbar);
    fitFormatGroups();
    const structure = format.createDiv({ cls: 'hwp-edit-actions' });
    this.toolButton(structure, '다음 문단 추가', 'createTable', () => this.runEditorCommand('insert.paragraph'));
    this.toolButton(structure, '문단 삭제', 'createTable', () => this.deleteParagraph());
    const tables = this.toolDetails(editor, '표와 셀');
    const createTableRow = tables.createDiv({ cls: 'hwp-edit-actions' });
    createTableRow.createSpan({ text: '새 표' });
    this.tableRowsInput = this.feature(createTableRow.createEl('input', { type: 'number', value: '2', attr: { min: 1, max: 100, 'aria-label': '표 행 수' } }), 'createTable');
    this.tableColsInput = this.feature(createTableRow.createEl('input', { type: 'number', value: '2', attr: { min: 1, max: 100, 'aria-label': '표 열 수' } }), 'createTable');
    this.toolButton(createTableRow, '표 추가', 'createTable', () => this.runEditorCommand('insert.table-custom'));
    const tableStructureActions = tables.createDiv({ cls: 'hwp-edit-actions' });
    for (const [id, label] of [
      ['table.insert-row-above', '위에 행 삽입'], ['table.insert-row-below', '아래에 행 삽입'], ['table.delete-row', '행 삭제'],
      ['table.insert-column-left', '왼쪽에 칸 삽입'], ['table.insert-column-right', '오른쪽에 칸 삽입'], ['table.delete-column', '칸 삭제'],
    ]) this.toolButton(tableStructureActions, label, 'table', () => this.runEditorCommand(id));
    const cellActions = tables.createDiv({ cls: 'hwp-edit-actions' });
    this.mergeEndRowInput = this.feature(cellActions.createEl('input', { type: 'number', value: '1', attr: { min: 1, 'aria-label': '병합 끝 행' } }), 'table');
    this.mergeEndColInput = this.feature(cellActions.createEl('input', { type: 'number', value: '1', attr: { min: 1, 'aria-label': '병합 끝 열' } }), 'table');
    this.toolButton(cellActions, '선택 셀부터 범위 병합', 'table', () => this.runEditorCommand('table.merge-cells'));
    this.toolButton(cellActions, '선택 셀 분할', 'table', () => this.runEditorCommand('table.split-cell'));
    const cellFormat = tables.createDiv({ cls: 'hwp-edit-actions' });
    this.toolButton(cellFormat, '표 / 셀 속성…', 'table', () => this.runEditorCommand('table.cell-properties'));
    const contentTools = this.toolDetails(editor, '필드 · 그림 · 수식 · 도형 · 주석');
    contentTools.createEl('p', { cls: 'hwp-hint', text: '선택한 필드 값은 위 내용 입력란에서 수정합니다. 그림·수식·도형·각주·미주 삽입은 본문 문단에서 지원합니다.' });
    const equationRow = contentTools.createDiv({ cls: 'hwp-edit-actions' });
    this.equationScriptInput = this.feature(equationRow.createEl('textarea', { attr: { rows: '2', placeholder: '수식 스크립트', 'aria-label': '수식 스크립트' } }), 'objectInsert');
    this.equationScriptInput.addEventListener('input', () => this.scheduleEquationPreview());
    this.toolButton(equationRow, '수식 삽입', 'objectInsert', () => this.insertEquation());
    this.equationApplyButton = this.toolButton(equationRow, '선택 수식 적용', 'objectEdit', () => this.applySelectedEquation());
    this.equationPreviewEl = contentTools.createDiv({ cls: 'hwp-equation-preview', attr: { role: 'status', 'aria-label': '수식 미리보기' } });
    this.equationPreviewEl.hidden = true;
    const shapeRow = contentTools.createDiv({ cls: 'hwp-edit-actions' });
    this.shapeTypeSelect = this.feature(shapeRow.createEl('select', { attr: { 'aria-label': '도형 종류' } }), 'objectInsert');
    for (const [value, label] of [['rectangle', '사각형'], ['textBox', '글상자']]) this.shapeTypeSelect.createEl('option', { value, text: label });
    this.shapeWidthInput = this.feature(shapeRow.createEl('input', { type: 'number', value: '40', attr: { min: 0.01, max: 10000, 'aria-label': '도형 너비 (mm)' } }), 'objectInsert');
    this.shapeHeightInput = this.feature(shapeRow.createEl('input', { type: 'number', value: '20', attr: { min: 0.01, max: 10000, 'aria-label': '도형 높이 (mm)' } }), 'objectInsert');
    this.shapeTextInput = this.feature(shapeRow.createEl('input', { type: 'text', attr: { placeholder: '도형 설명 또는 글상자 내용', 'aria-label': '도형 설명 또는 글상자 내용' } }), 'objectInsert');
    this.toolButton(shapeRow, '도형 삽입', 'objectInsert', () => this.insertShape());
    this.shapeDrawButton = this.toolButton(shapeRow, '도형 그리기', 'objectInsert', () => this.toggleShapeDrawMode());
    this.shapeDrawButton.setAttribute('aria-pressed', 'false');
    this.shapeDrawButton.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.shapeDrawMode) return;
      event.preventDefault(); this.finishShapeDrawMode('도형 그리기를 취소했습니다.');
    });
    const pictureRow = contentTools.createDiv({ cls: 'hwp-edit-actions' });
    const pictureFile = this.feature(pictureRow.createEl('input', { type: 'file', attr: { accept: '.png,.jpg,.jpeg,.gif,.bmp,image/png,image/jpeg,image/gif,image/bmp', 'aria-label': '삽입할 그림' } }), 'objectInsert');
    this.pictureFileInput = pictureFile;
    pictureFile.onchange = () => { const file = pictureFile.files?.[0]; if (file) void this.guard(() => this.insertPicture(file)); pictureFile.value = ''; };
    const noteRow = contentTools.createDiv({ cls: 'hwp-edit-actions' });
    this.toolButton(noteRow, '각주 삽입', 'noteInsert', () => this.runEditorCommand('insert.footnote'));
    this.toolButton(noteRow, '미주 삽입', 'noteInsert', () => this.runEditorCommand('insert.endnote'));
    this.toolButton(noteRow, '미주 모양', 'page', () => this.runEditorCommand('insert.endnote-shape'));
    this.objectEditDetails = editor.createEl('details', { cls: 'hwp-tool-group' });
    this.objectEditDetails.createEl('summary', { text: '선택 개체 속성' });
    const objectEdit = this.objectEditDetails.createDiv({ cls: 'hwp-tool-content' });
    const objectRow = objectEdit.createDiv({ cls: 'hwp-edit-actions' });
    this.objectWidthInput = this.feature(objectRow.createEl('input', { type: 'number', value: '40', attr: { min: 0.01, step: '1', 'aria-label': '개체 너비 (mm)' } }), 'objectEdit');
    this.objectHeightInput = this.feature(objectRow.createEl('input', { type: 'number', value: '20', attr: { min: 0.01, step: '1', 'aria-label': '개체 높이 (mm)' } }), 'objectEdit');
    this.objectOffsetXInput = this.feature(objectRow.createEl('input', { type: 'number', value: '0', attr: { step: '1', 'aria-label': '개체 가로 위치 (mm)' } }), 'objectEdit');
    this.objectOffsetYInput = this.feature(objectRow.createEl('input', { type: 'number', value: '0', attr: { step: '1', 'aria-label': '개체 세로 위치 (mm)' } }), 'objectEdit');
    this.objectTreatAsCharInput = this.feature(objectRow.createEl('input', { type: 'checkbox', attr: { 'aria-label': '글자처럼 취급' } }), 'objectEdit');
    this.objectTextWrapSelect = this.feature(objectRow.createEl('select', { attr: { 'aria-label': '개체 배치 방식' } }), 'objectEdit');
    this.objectTextWrapSelect.createEl('option', { value: 'Square', text: '어울림' });
    this.objectTextWrapSelect.createEl('option', { value: 'TopAndBottom', text: '자리 차지' });
    this.objectDescriptionInput = this.feature(objectRow.createEl('input', { type: 'text', attr: { maxlength: 256, placeholder: '대체 설명', 'aria-label': '개체 설명' } }), 'objectEdit');
    this.toolButton(objectRow, '속성 적용', 'objectEdit', () => this.applyObjectProperties());
    this.toolButton(objectRow, '개체 삭제', 'objectEdit', () => this.deleteSelectedObject());
    const pageTools = this.toolDetails(editor, '쪽 · 용지 설정');
    this.pageSectionSelect = this.feature(pageTools.createEl('select', { attr: { 'aria-label': '설정할 구역' } }), 'page');
    this.pageSectionSelect.onchange = () => this.updateToolState();
    const pageSettingsRow = pageTools.createDiv({ cls: 'hwp-tool-grid' });
    for (const [key, label] of [['width', '너비'], ['height', '높이'], ['marginLeft', '왼쪽 여백'], ['marginRight', '오른쪽 여백'], ['marginTop', '위 여백'], ['marginBottom', '아래 여백'], ['marginHeader', '머리말 여백'], ['marginFooter', '꼬리말 여백'], ['marginGutter', '제본 여백']] as const) {
      const input = this.feature(pageSettingsRow.createEl('input', { type: 'number', value: '0', attr: { min: 0, step: '1', 'aria-label': `${label} (mm)` } }), 'page');
      input.dataset.pageProperty = key; this.pageNumberInputs.set(key, input);
    }
    const landscapeLabel = pageTools.createEl('label', { cls: 'hwp-check-label' });
    this.pageLandscapeInput = this.feature(landscapeLabel.createEl('input', { type: 'checkbox', attr: { 'aria-label': '가로 방향' } }), 'page');
    landscapeLabel.appendText(' 가로 방향');
    this.toolButton(pageTools, '쪽 설정 적용', 'page', () => this.runEditorCommand('page.apply-settings'));
    this.toolReasonEl.setText('페이지의 문단, 표 셀, 필드 또는 개체를 선택하세요.');
    const documentNavigation = this.toolDetails(editor, '문서 탐색');
    documentNavigation.createEl('p', { cls: 'hwp-hint', text: '목록은 검색어로 좁히고 20개씩 이동합니다. 개요 목록은 문단의 개요·제목 스타일을 사용합니다.' });
    this.outlineBrowser = this.createTargetBrowser(this.toolDetails(documentNavigation, '개요'), '개요 필터', '개요 제목 찾기', target => this.jumpToNavigationTarget(target));
    this.tableBrowser = this.createTargetBrowser(this.toolDetails(documentNavigation, '표 위치'), '표 필터', '표 내용 또는 위치 찾기', target => this.jumpToNavigationTarget(target));
    this.objectBrowser = this.createTargetBrowser(this.toolDetails(documentNavigation, '개체 위치'), '개체 필터', '그림·수식·도형 찾기', target => this.jumpToNavigationTarget(target));
    this.fieldBrowser = this.createTargetBrowser(this.toolDetails(documentNavigation, '필드'), '필드 필터', '필드 이름·값 찾기', target => this.jumpToNavigationTarget(target));
    this.searchBrowser = this.createTargetBrowser(this.toolDetails(documentNavigation, '검색 결과'), '검색 결과 필터', '검색 결과 좁히기', target => {
      this.searchCurrentIndex = this.searchBrowser?.entries.findIndex(entry => entry.value === target) ?? -1;
      if (this.searchBrowser) this.renderTargetBrowser(this.searchBrowser);
      return this.jumpToNavigationTarget(target);
    });
    // The edit panel is hidden, so the search block is a floating find bar over the pages.
    const findBar = preview.createDiv({ cls: 'hwp-find-bar', attr: { role: 'search', 'aria-label': '찾기와 바꾸기' } });
    findBar.hidden = true;
    this.findBarEl = findBar;
    const searchHost = findBar;
    searchHost.createEl('strong', { text: '검색 / 치환' });
    const query = this.searchQueryInput = searchHost.createEl('input', { type: 'search', attr: { placeholder: '검색어', 'aria-label': '검색어' } });
    const replacement = this.searchReplacementInput = searchHost.createEl('input', { type: 'text', attr: { placeholder: '바꿀 내용', 'aria-label': '바꿀 내용' } });
    query.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && !this.composing) {
        event.preventDefault(); void this.guard(() => this.runSearch());
      }
    });
    for (const input of [query, replacement]) input.addEventListener('keydown', event => { if (event.key === 'Escape' && findBar && !event.isComposing) { event.preventDefault(); this.closeFindBar(); } });
    const options = searchHost.createDiv({ cls: 'hwp-edit-search-options' });
    const caseSensitiveLabel = options.createEl('label', { cls: 'hwp-check-label' });
    this.searchCaseSensitiveInput = caseSensitiveLabel.createEl('input', { type: 'checkbox', attr: { 'aria-label': '대소문자 구분' } });
    caseSensitiveLabel.appendText(' 대소문자 구분');
    const includeStoriesLabel = options.createEl('label', { cls: 'hwp-check-label' });
    this.searchIncludeStoriesInput = includeStoriesLabel.createEl('input', { type: 'checkbox', attr: { 'aria-label': '표·글상자·머리말·꼬리말·각주 포함' } });
    this.searchIncludeStoriesInput.checked = true;
    includeStoriesLabel.appendText(' 표·글상자·머리말·꼬리말·각주 포함');
    const searchActions = searchHost.createDiv({ cls: 'hwp-edit-actions' });
    this.button(searchActions, '이전 결과', () => this.showAdjacentSearchResult(-1));
    this.button(searchActions, '다음 결과', () => this.showAdjacentSearchResult(1));
    this.button(searchActions, '검색', () => this.runSearch());
    this.button(searchActions, '현재 결과 바꾸기', () => this.runEditorCommand('tool.replace-current'));
    this.button(searchActions, '모두 바꾸기', () => this.execute([{ type: 'replaceText', query: query.value, replacement: replacement.value }]));
    this.button(searchActions, '닫기', () => this.closeFindBar());
  }
  private toggleToolbars(): void {
    const current = this.plugin.settings.editorChrome;
    void this.plugin.setEditorChrome({ ...current, basicToolbox: !current.basicToolbox });
  }
  private async toggleFormMode(): Promise<void> {
    if (this.draft || this.composing) throw new Error('미적용 입력 또는 한글 조합을 먼저 처리하세요.');
    const tree = this.documentTree;
    if (!tree) throw new Error('문서가 아직 준비되지 않았습니다.');
    if (!this.formMode) {
      this.modeBeforeForm = this.mode;
      this.selectedBeforeFormKey = this.selected ? isParagraph(this.selected) ? `paragraph:${this.selected.nodePath}` : `field:${this.selected.fieldId}` : undefined;
      this.formMode = true; this.mode = 'fields'; this.modeSelector.value = 'fields'; this.items = this.itemsForMode(tree);
      const fieldIndex = this.items.findIndex(item => !isParagraph(item));
      if (fieldIndex >= 0) await this.focusFormField(fieldIndex);
      else { this.clearSelection('양식 모드 · 입력 가능한 누름틀이 없습니다.'); new Notice('문서에 입력 가능한 누름틀이 없습니다.'); }
    } else {
      this.formMode = false; this.mode = this.modeBeforeForm ?? 'paragraphs'; this.modeBeforeForm = undefined;
      this.modeSelector.value = this.mode; this.items = this.itemsForMode(tree);
      const selectedKey = this.selectedBeforeFormKey; this.selectedBeforeFormKey = undefined;
      const index = this.items.findIndex(item => selectedKey === (isParagraph(item) ? `paragraph:${item.nodePath}` : `field:${item.fieldId}`));
      if (index >= 0) this.selectItem(index, false);
      else this.clearSelection('양식 모드를 종료했습니다. 문서에서 편집 대상을 선택하세요.');
    }
    this.syncInputDisabled(); this.updateToolState(); this.updateStatus();
  }
  private async focusFormField(index: number): Promise<void> {
    const field = this.items[index];
    if (!field || isParagraph(field) || !this.state || !this.path) throw new Error('누름틀 항목을 찾지 못했습니다.');
    const context = this.captureContext(), revision = this.state.revision;
    if (field.address) {
      const offset = typeof field.startCharIdx === 'number' ? Math.max(0, field.startCharIdx) : 0;
      const caret = await this.plugin.api.query.caret(context.path, { address: field.address, offset }, {
        sessionId: this.state.sessionId, expectedRevision: revision,
      });
      this.assertContext(context);
      const current = await this.plugin.api.documents.state(context.path); this.assertContext(context);
      if (current.revision !== revision) throw new Error('문서가 이동 중 변경되어 누름틀을 선택하지 않았습니다.');
      this.state = current; this.page = Math.min(caret.rect.pageIndex, Math.max(0, current.pageCount - 1));
      await this.renderPage(true); this.assertContext(context);
    }
    const latestIndex = this.items.findIndex(item => !isParagraph(item) && item.fieldId === field.fieldId);
    if (latestIndex < 0) throw new Error('누름틀 목록이 변경되었습니다. 다시 선택하세요.');
    this.selectItem(latestIndex, true);
    if (field.address) this.showFieldBoundaryCaret(field, typeof field.startCharIdx === 'number' ? field.startCharIdx : 0);
    this.textarea.focus({ preventScroll: true });
  }
  private showFieldBoundaryCaret(field: Field, offset: number): void {
    if (!field.address) return;
    const position = Math.max(0, Math.trunc(offset));
    this.pageSelection = { address: field.address, start: position, end: position };
    this.selectionAnchor = undefined;
    this.updatePageSelectionOverlay(); this.updateStatus();
  }
  private async moveFormField(delta: -1 | 1): Promise<void> {
    const fields = this.items.filter((item): item is Field => !isParagraph(item));
    if (!fields.length) throw new Error('이동할 수 있는 누름틀이 없습니다.');
    const current = fields.findIndex(field => field.fieldId === (this.selected && !isParagraph(this.selected) ? this.selected.fieldId : -1));
    const index = (current + delta + fields.length) % fields.length;
    const itemIndex = this.items.findIndex(item => !isParagraph(item) && item.fieldId === fields[index].fieldId);
    await this.focusFormField(itemIndex);
  }
  private openClickHereFieldModal(): void {
    if (!this.selected || !isParagraph(this.selected) || this.selected.address.kind !== 'body' || this.selected.address.containerKinds?.includes('textBox')) {
      throw new Error('본문 또는 표 셀의 문단을 선택한 뒤 누름틀을 삽입하세요.');
    }
    if (!this.rangeIsCollapsed(this.selectionRange())) throw new Error('누름틀은 선택 범위가 아닌 캐럿 위치에 삽입합니다.');
    const selected = structuredClone(this.selected), address = structuredClone(this.selected.address), context = this.captureContext(), revision = this.state?.revision;
    if (address.kind !== 'body') throw new Error('누름틀은 본문 또는 표 셀에만 넣을 수 있습니다.');
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const position = this.pageSelection?.focus ?? positionAfterEditorText(address, this.textarea.value, this.textarea.selectionEnd);
    const offset = Math.max(0, Math.min(selected.length, position.offset));
    new ClickHereFieldModal(this.app, async options => {
      await this.tasks.run(async () => {
        this.assertContext(context);
        if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 다시 선택한 뒤 누름틀을 삽입하세요.');
        await this.execute([{
          type: 'insertClickHereField',
          target: { section: address.section, paragraph: address.paragraph,
            ...(address.cellPath ? { cellPath: structuredClone(address.cellPath) } : {}),
            ...(address.containerKinds ? { containerKinds: [...address.containerKinds] } : {}) },
          offset, ...options,
        }], { address, offset }, true);
      });
      new Notice(`누름틀을 삽입했습니다: ${options.name}`);
    }).open();
  }
  private selectedClickHereField(): Field {
    const field = this.selected;
    if (!field || isParagraph(field) || field.fieldType !== 'clickhere') throw new Error('고치거나 지울 누름틀을 먼저 선택하세요.');
    return field;
  }
  private openFieldEditDialog(): void {
    const field = this.selectedClickHereField();
    this.openFormCommandDialog({
      title: `필드 고치기 (${field.name})`, hint: '이름은 문서 안에서 유일해야 이름으로 값을 쓸 수 있습니다. 바꾼 항목만 적용됩니다.', fields: fieldEditFields(field),
      build: (values, initial) => [fieldEditCommand(field, values, initial)].filter((command): command is Command => !!command),
    });
  }
  private openFieldRemoveDialog(): void {
    const field = this.selectedClickHereField();
    this.openFormCommandDialog({
      title: `필드 지우기 (${field.name})`, hint: '누름틀을 지우면 그 안에 입력한 내용도 함께 지워집니다. 내용을 남길 수 있고, 되돌리기로 복구할 수 있습니다.',
      fields: fieldRemoveFields(typeof field.value === 'string' && field.value.length > 0), submitLabel: '필드 지우기',
      build: values => [fieldRemoveCommand(field, values)], after: () => this.clearSelection('필드를 지웠습니다.'),
    });
  }
  private openCharacterTable(): void {
    new CharacterTableModal(this.app, character => this.tasks.run(() => this.insertCharacter(character))).open();
  }
  private async insertCharacter(character: string): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 문자를 삽입하세요.');
    if (Array.from(character).length !== 1) throw new Error('문자표에서는 한 번에 한 글자만 삽입할 수 있습니다.');
    const selected = this.selected;
    if (!selected || !isParagraph(selected)) throw new Error('문자를 넣을 문단을 먼저 선택하세요.');
    const range = this.selectionRange();
    let commands: Command[], after: TextPosition;
    if (range && !this.rangeIsCollapsed(range)) {
      if (!sameDocumentAddress(range.start.address, selected.address) || !sameDocumentAddress(range.end.address, selected.address)) {
        throw new Error('문자표는 한 문단 안에서 선택한 범위에만 삽입할 수 있습니다.');
      }
      const deletion: Extract<Command, { type: 'deleteRange' }> = { type: 'deleteRange', start: range.start, end: range.end };
      const insertion: Extract<Command, { type: 'insertText' }> = {
        type: 'insertText', target: selected.address, offset: range.start.offset, text: character,
        ...(this.pendingCaretProperties ? { characterProperties: this.pendingCaretProperties } : {}),
      };
      commands = [deletion, insertion];
      after = { address: selected.address, offset: range.start.offset + 1 };
    } else {
      const position = positionAfterEditorText(selected.address, this.textarea.value, this.textarea.selectionEnd);
      commands = [{
        type: 'insertText', target: position.address, offset: position.offset, text: character,
        ...(this.pendingCaretProperties ? { characterProperties: this.pendingCaretProperties } : {}),
      }];
      after = { address: position.address, offset: position.offset + 1 };
    }
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    try { await this.execute(commands, after, true); }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
      const deletion = commands.find((command): command is Extract<Command, { type: 'deleteRange' }> => command.type === 'deleteRange');
      if (code !== 'CONTENT_LOSS' || !deletion) throw error;
      const confirmed = await new Promise<boolean>(resolve => new ConfirmAnchoredDelete(this.app, resolve).open());
      if (!confirmed) return;
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('확인 중 문서가 변경되었습니다. 다시 선택한 뒤 문자를 삽입하세요.');
      await this.execute([{ ...deletion, deleteAnchoredContent: true }, commands.at(-1)!], after, true);
    }
  }
  private reflectZoomScale(percent?: number): void {
    if (percent === undefined) {
      this.zoomMode = 'fit-width';
      this.zoomLabel?.setText('폭 맞춤');
      if (this.zoomPreset) this.zoomPreset.value = 'fit-width';
      if (this.zoomInput) this.zoomInput.value = String(this.zoomPercent);
    } else {
      if (this.zoomMode !== 'fit-page') this.zoomMode = 'custom';
      this.zoomPercent = percent;
      if (this.zoomInput) this.zoomInput.value = String(percent);
      if (this.zoomPreset) {
        const hasPreset = Array.from(this.zoomPreset.options).some(option => option.value === String(percent));
        this.zoomPreset.value = this.zoomMode === 'fit-page' ? 'fit-page' : hasPreset ? String(percent) : 'custom';
      }
      this.zoomLabel?.setText(this.zoomMode === 'fit-page' ? `쪽 맞춤 · ${percent}%` : `${percent}%`);
    }
    if (this.state && this.statusEl) this.updateStatus();
  }
  private stepZoom(direction: 1 | -1): void {
    const steps = [50, 75, 100, 125, 150, 200, 300, 400, 500], current = this.zoomPercent;
    const next = direction > 0 ? steps.find(step => step > current) : [...steps].reverse().find(step => step < current);
    if (next !== undefined) this.applyZoomPreset(String(next));
  }
  /** `app.setting` is not public Obsidian API, so fall back to a hint when it is missing. */
  private openPluginSettings(): void {
    const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
    try {
      setting?.open?.(); setting?.openTabById?.(this.plugin.manifest.id);
      if (setting?.open && setting.openTabById) return;
    } catch { /* fall through to the hint */ }
    new Notice('Obsidian 설정 › HWP Hands 탭에서 환경 설정을 바꾸세요.');
  }
  private openProductInfo(): void {
    const dialog = new Modal(this.app);
    dialog.titleEl.setText('HWP Hands 제품 정보');
    dialog.contentEl.createEl('p', { text: `플러그인 ${this.plugin.manifest.version} · RHWP ${this.plugin.api.engineVersion} · 공개 API v${this.plugin.api.version}` });
    dialog.contentEl.createEl('p', { text: 'HWP Hands와 RHWP 코어는 MIT 라이선스입니다. 서드파티 고지는 설치된 main.js 앞부분의 주석과 공개 저장소의 THIRD_PARTY_NOTICES.md에서 확인할 수 있습니다.' });
    this.button(dialog.contentEl, '닫기', () => dialog.close());
    dialog.open();
  }
  private applyZoomPreset(value: string): void {
    if (!this.pageStack) return;
    if (value === 'fit-width') {
      this.zoomMode = 'fit-width'; this.pageStack.setScale(undefined); return;
    }
    if (value === 'fit-page') {
      if (!this.pageLayout) return;
      this.zoomMode = 'fit-page';
      this.pageStack.fitPage(this.pageLayout.info.width, this.pageLayout.info.height);
      return;
    }
    const percent = Number(value);
    if (!Number.isFinite(percent) || percent < 50 || percent > 500) return;
    this.zoomMode = 'custom'; this.pageStack.setScale(percent);
  }
  private async restorePendingViewState(): Promise<void> {
    const saved = this.pendingViewState;
    if (!saved || !this.state || !this.pageStack) return;
    this.pendingViewState = undefined;
    if (typeof saved.file === 'string' && saved.file !== this.path) return;
    if (typeof saved.ruler === 'boolean') this.setRulerVisible(saved.ruler);
    if (saved.grid !== undefined) this.setGridSettings(normalizeGridSettings(saved.grid));
    const requestedPage = Number(saved.page);
    if (Number.isSafeInteger(requestedPage) && requestedPage >= 0 && requestedPage < this.state.pageCount) {
      this.page = requestedPage;
      await this.pageStack.setActivePage(requestedPage);
    }
    if (saved.zoomMode === 'fit-width') this.applyZoomPreset('fit-width');
    else if (saved.zoomMode === 'fit-page') this.applyZoomPreset('fit-page');
    else {
      const percent = Number(saved.zoomPercent);
      if (Number.isFinite(percent) && percent >= 50 && percent <= 500) this.applyZoomPreset(String(percent));
    }
    const scrollTop = Number(saved.scrollTop);
    if (Number.isFinite(scrollTop) && scrollTop >= 0) this.pageStack.restoreScrollTop(scrollTop);
  }
  private setRulerVisible(visible: boolean): void {
    this.rulerVisible = visible;
    this.previewEl?.toggleClass('hwp-ruler-on', visible);
    if (visible) this.scheduleRulerDraw();
  }
  private scheduleRulerDraw(): void {
    if (!this.rulerVisible || !this.rulers || this.rulerFrameRequest !== undefined) return;
    const view = this.contentEl?.ownerDocument.defaultView ?? window;
    this.rulerFrameRequest = view.requestAnimationFrame(() => { this.rulerFrameRequest = undefined; this.drawRulers(); });
  }
  private drawRulers(): void {
    const rulers = this.rulers, page = this.pageEl, scroll = this.pageScroll, layout = this.pageLayout;
    if (!rulers || !this.rulerVisible) return;
    if (!page?.isConnected || !scroll || !layout) { rulers.clear(); return; }
    const geometry = pageGeometry(layout.info);
    const pageRect = page.getBoundingClientRect(), scrollRect = scroll.getBoundingClientRect();
    if (!geometry || !(pageRect.width > 0) || !(layout.info.width > 0)) { rulers.clear(); return; }
    const formatting = this.selected && isParagraph(this.selected) && this.selected.address.kind === 'body' ? this.selectedParagraphFormatting()?.properties : undefined;
    rulers.draw({
      geometry, scale: pageRect.width / layout.info.width,
      pageLeft: pageRect.left - scrollRect.left, pageTop: pageRect.top - scrollRect.top,
      width: scroll.clientWidth, height: scroll.clientHeight,
      ...(formatting ? { paragraph: { marginLeftPx: formatting.marginLeft, indentPx: formatting.indent } } : {}),
    });
  }
  private setGridSettings(settings: GridSettings): void {
    this.gridSettings = settings;
    this.applyGridToAllPages();
  }
  /** The grid is a pseudo-element of each page, driven by custom properties so re-rendering a page never loses it. */
  private applyGridToPage(page: number, element: HTMLElement): void {
    const layout = this.pageLayouts.get(page)?.layout, pageWidth = layout?.info.width ?? 0;
    const bounds = element.getBoundingClientRect();
    const scale = pageWidth > 0 && bounds.width > 0 ? bounds.width / pageWidth : 0;
    const background = gridBackground(this.gridSettings, pageGeometry(layout?.info), scale, 'rgba(53, 132, 228, 0.35)');
    element.toggleClass('hwp-grid-on', !!background);
    for (const [name, value] of [['--hwp-grid-image', background?.backgroundImage], ['--hwp-grid-size', background?.backgroundSize], ['--hwp-grid-position', background?.backgroundPosition]] as const) {
      if (value) element.style.setProperty(name, value); else element.style.removeProperty(name);
    }
  }
  private applyGridToAllPages(): void {
    const count = this.state?.pageCount ?? 0;
    for (let page = 0; page < count; page++) { const element = this.pageStack?.pageElement(page); if (element) this.applyGridToPage(page, element); }
  }
  private toggleDisplayOption(key: keyof PageRenderOptions): void {
    const input = this.displayOptionInputs.get(key);
    if (!input) throw new Error('쪽 표시 옵션을 찾을 수 없습니다.');
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
  }
  private openGridSettingsDialog(): void {
    const settings = this.gridSettings;
    new FormModal(this.app, {
      title: '격자 설정', hint: '격자는 화면에만 표시하며 문서에 저장하지 않습니다. 기준 위치부터 간격마다 선(또는 점)을 그립니다.', submitLabel: '적용',
      fields: [
        { key: 'visible', label: '격자 보기', kind: 'checkbox', value: settings.visible },
        { key: 'horizontalMm', label: '가로 간격', kind: 'number', value: settings.horizontalMm, min: GRID_MIN_MM, max: GRID_MAX_MM, unit: 'mm' },
        { key: 'verticalMm', label: '세로 간격', kind: 'number', value: settings.verticalMm, min: GRID_MIN_MM, max: GRID_MAX_MM, unit: 'mm' },
        { key: 'origin', label: '기준 위치', kind: 'select', value: settings.origin, options: [['body', '본문 영역 왼쪽 위'], ['paper', '용지 왼쪽 위']] },
        { key: 'style', label: '표시 방식', kind: 'select', value: settings.style, options: [['lines', '선'], ['dots', '점']] },
      ],
    }, async values => {
      this.setGridSettings(normalizeGridSettings({ visible: values.visible, horizontalMm: values.horizontalMm, verticalMm: values.verticalMm, origin: values.origin, style: values.style }));
    }).open();
  }
  private updateStatus(): void {
    this.updateAutosaveInput();
    this.renderAutosaveStatus();
    if (!this.state) return;
    this.scheduleRulerDraw();
    this.layoutWarningEl.hidden = !this.documentTree?.stories.some(story => story.kind === 'endnote');
    const readOnly = this.capabilitiesReadOnly();
    const reason = this.capabilityCheckError ?? (this.capabilities?.sessionId === this.state.sessionId ? this.capabilities.readOnlyReasons.join(' ') : '');
    const activity = this.saving ? '저장 중'
      : this.state.conflict ? '외부 파일 충돌'
        : this.capabilityCheckPending ? '저장 안전성 검증 중'
          : readOnly ? '읽기 전용'
          : this.composing ? '한글 조합 중'
            : this.draft ? '입력 중 · 자동 반영 대기'
              : this.state.dirty ? '저장되지 않은 변경'
                : '저장됨';
    const draftFailure = this.draftSaveError ? ' · 입력 복구본 저장 실패' : '';
    const operationFailure = this.operationError ? ` · 마지막 작업 실패: ${this.operationError.slice(0, 240)}` : '';
    const address = this.selected && isParagraph(this.selected) ? this.selected.address : undefined;
    const section = this.pageLayout?.info.sectionIndex ?? address?.section;
    const sectionLabel = Number.isSafeInteger(section) ? `구역: ${Number(section) + 1}/${this.sectionGotoSelect.options.length || 1}` : '';
    const cellContext = this.selectedTableCell();
    const block = this.cellBlockSelection;
    const cellLabel = block
      ? ` · 셀 블록 ${block.anchor.row + 1}행 ${block.anchor.col + 1}열–${block.focus.row + 1}행 ${block.focus.col + 1}열`
      : cellContext ? ` · 셀 ${cellContext.cell.row + 1}행 ${cellContext.cell.col + 1}열` : '';
    const fieldLabel = this.selected && !isParagraph(this.selected) ? ` · 필드 ${this.selected.name}` : '';
    const caretLabel = this.selected && isParagraph(this.selected)
      ? ` · ${codePointOffsetFromUtf16(this.textarea.value, this.textarea.selectionEnd)}자 위치`
      : this.selected && !isParagraph(this.selected) && this.pageSelection ? ` · 필드 경계 ${this.pageSelection.start + 1}자 위치` : '';
    const zoomLabel = this.zoomLabel?.textContent ? ` · ${this.zoomLabel.textContent}` : '';
    if (this.statusPageButton) this.statusPageButton.setText(`${this.page + 1}/${this.state.pageCount}쪽`);
    this.statusTextEl.setText(`${this.formMode ? '양식' : this.overwriteMode ? '수정' : '삽입'} · ${this.state.format.toUpperCase()}${this.statusPageButton ? '' : ` · ${this.page + 1}/${this.state.pageCount}쪽`}${sectionLabel ? ` · ${sectionLabel}` : ''}${cellLabel}${fieldLabel}${caretLabel}${zoomLabel}${operationFailure}`);
    this.statusTextEl.title = this.statusTextEl.textContent ?? '';
    this.statusActivityEl.setText(`${activity}${draftFailure}`);
    this.statusEl.toggleClass('hwp-conflict', this.state.conflict);
    this.statusEl.toggleClass('hwp-read-only', readOnly && !this.capabilityCheckPending);
    // Ordinary unsaved changes only show in the status line; closing the view asks to save (decision 69).
    // The panel appears for what needs a decision now: a disk conflict, a blocked save, or a failure.
    const blocked = readOnly && !this.capabilityCheckPending;
    const showPanel = this.state.conflict || !!readOnly || !!this.draftSaveError || !!this.operationError;
    this.resolutionPanel.hidden = !showPanel;
    const editMarks = this.currentEditMarks().length;
    if (this.editMarksEl && this.editMarksTextEl) { this.editMarksTextEl.setText(editMarksNotice(editMarks)); this.editMarksEl.hidden = !editMarks; }
    this.statusBannersEl.hidden = this.layoutWarningEl.hidden && this.resolutionPanel.hidden && !editMarks;
    const storyAddress = this.selected && isParagraph(this.selected) ? this.selected.address : undefined;
    const storyMode = storyAddress?.kind === 'headerFooter' || storyAddress?.kind === 'footnote' || storyAddress?.kind === 'endnote';
    if (this.commandToolbar) this.commandToolbar.element.hidden = storyMode;
    this.withSelectionFormatting(() => {
      if (this.storyToolbar) { this.storyToolbar.element.hidden = !storyMode; this.storyToolbar.refresh(); }
      this.commandToolbar?.refresh();
      this.refreshHistoryButtons();
    });
    this.compareChangesButton.hidden = !(this.baselineText !== undefined && this.state.conflict);
    this.saveCopyButton.hidden = !(this.state.conflict || blocked);
    this.reloadConflictButton.hidden = !this.state.conflict;
    this.recoverInputButton.hidden = !this.draftSaveError;
    this.saveCopyButton.disabled = this.capabilityCheckPending || this.saving || this.composing || (!!readOnly && this.draft);
    this.reloadConflictButton.disabled = this.saving || this.composing;
    this.compareChangesButton.disabled = this.saving;
    this.recoverInputButton.disabled = this.saving;
    const message = this.saving ? '문서를 검증하고 저장하고 있습니다.'
      : this.state.conflict ? '디스크 파일이 이 편집 세션의 기준 이후 변경되었습니다. 변경본을 새 파일로 보관하거나 디스크 버전을 다시 불러오세요.'
          : this.capabilityCheckPending ? '첫 쪽을 열었습니다. 원본 저장 안전성을 확인하는 동안 편집 도구를 잠시 사용할 수 없습니다.'
          : readOnly ? `현재 형식 저장은 차단되었습니다. 새 파일 저장은 선택한 형식의 검증 결과에 따라 가능할 수 있습니다.${reason ? ` ${reason}` : ''}`
            : this.operationError ? `작업을 완료하지 못했습니다. ${this.operationError}`
              : this.draftSaveError ? '입력 복구본을 저장하지 못했습니다. 복구 목록을 확인하세요.'
                : '문서에 저장되지 않은 변경이 있습니다.';
    this.resolutionMessage.setText(message);
    this.syncInputDisabled();
  }
  private async refresh(renderCurrentPage = true, changedPages?: readonly number[]): Promise<void> {
    if (!this.path || this.detaching) return; const generation = this.generation, path = this.path, refreshSequence = ++this.refreshSequence;
    // Every read below goes to the session by path. Once the view detaches, its lease may be gone and a read would reopen the file.
    const stale = () => generation !== this.generation || path !== this.path || refreshSequence !== this.refreshSequence || this.detaching;
    const oldObject = this.selectedObject;
    const tree = await this.plugin.api.query.tree(path);
    if (stale()) return;
    this.page = Math.min(this.page, tree.state.pageCount - 1);
    const needsCapabilities = !this.capabilities || this.capabilities.sessionId !== tree.state.sessionId || (!tree.state.dirty && this.capabilities.revision !== tree.state.revision);
    if (needsCapabilities) { this.capabilityCheckPending = true; this.capabilityCheckError = undefined; }
    const [formatting, openedText, objects] = await Promise.all([
      // Model runs cover the whole selection (layout runs only the current page) and need no extra page layout.
      this.plugin.api.query.formatting(path, { pages: [this.page], runs: 'model' }),
      this.baselineText === undefined ? this.plugin.api.query.text(path) : Promise.resolve(undefined),
      oldObject ? this.plugin.api.query.objects(path) : Promise.resolve(undefined),
    ]);
    if (stale()) return;
    const current = await this.plugin.api.documents.state(path);
    if (stale()) return;
    if (current.revision !== tree.state.revision) { await this.refresh(); return; }

    // A refresh that finds the same session at the same revision (keyboard navigation re-reads the structure) leaves the rendered pages
    // valid. Dropping their layouts while the page stack keeps the pages would leave no layout to place the caret or the inline editor on.
    const unchanged = !!this.state && this.state.sessionId === current.sessionId && this.state.revision === current.revision;
    const previousState = this.state, previousSelection = this.pageSelection, previousAnchor = this.selectionAnchor, previousBlock = this.cellBlockSelection;
    const previousStart = this.textarea.selectionStart, previousEnd = this.textarea.selectionEnd;
    this.state = current; this.documentTree = tree; this.formattingModel = formatting;
    // setDocument may synchronously activate a page and update the toolbar. Drop an
    // old-revision selection first so that callback never resolves it in the new tree.
    if (previousState && !unchanged && !this.draft && !this.composing) {
      this.selected = undefined; this.pageSelection = undefined; this.selectionAnchor = undefined;
      this.cellBlockSelection = undefined; this.inlineEditorActive = false;
    }
    // A changedPages event can arrive after another refresh already applied this revision. The page stack ignores a same-revision
    // setDocument, so dropping layouts here would leave a rendered page without a layout to place the caret or handles on.
    const invalidatedPages = unchanged ? [] : changedPages ?? (renderCurrentPage ? undefined : []);
    const invalidated = invalidatedPages === undefined ? undefined : new Set(invalidatedPages);
    for (const [page, cached] of this.pageLayouts) {
      if (invalidated === undefined || invalidated.has(page)) this.pageLayouts.delete(page);
      else cached.revision = current.revision;
    }
    this.pageStack?.setDocument(current.pageCount, current.revision, invalidatedPages, this.page);
    if (openedText !== undefined && this.baselineText === undefined) this.baselineText = openedText;
    this.selectedObject = oldObject ? objects?.find(item => item.kind === oldObject.kind && item.controlIndex === oldObject.controlIndex && sameDocumentAddress(item.address, oldObject.address)) : undefined;
    this.updateDocumentBrowsers(tree, formatting);
    if (this.searchRevision >= 0 && this.searchRevision !== tree.state.revision) {
      this.searchRevision = -1; this.searchCurrentIndex = -1; this.setTargetBrowser(this.searchBrowser, []);
    }
    if (!this.draft && !this.composing) {
      const key = this.selected && (isParagraph(this.selected) ? this.selected.nodePath : String(this.selected.fieldId));
      this.rebuildItemList(tree);
      const index = this.items.findIndex(item => (isParagraph(item) ? item.nodePath : String(item.fieldId)) === key);
      if (previousState && !unchanged) {
        this.clearSelection('문서가 변경되어 선택을 해제했습니다. 편집할 위치를 다시 선택하세요.');
      } else {
        this.selectItem(key ? index : previousState ? -1 : 0);
        if (unchanged && index >= 0) {
          this.pageSelection = previousSelection; this.selectionAnchor = previousAnchor; this.cellBlockSelection = previousBlock;
          this.textarea.setSelectionRange(previousStart, previousEnd);
          this.updatePageSelectionOverlay();
        }
      }
    }
    this.updateStatus();
    this.updateToolState();
    if (renderCurrentPage) await this.renderPage();
    else {
      const cached = this.pageLayouts.get(this.page);
      this.pageLayout = cached?.layout;
      this.pageLayoutRevision = cached?.revision ?? -1;
      this.pageLabel.setText(`${this.page + 1} / ${this.state.pageCount}쪽`);
      this.pageInput.value = String(this.page + 1); this.pageInput.max = String(this.state.pageCount);
      this.updatePageSelectionOverlay(true);
    }
    if (this.formMode && this.selected && !isParagraph(this.selected)) {
      this.showFieldBoundaryCaret(this.selected, typeof this.selected.startCharIdx === 'number' ? this.selected.startCharIdx : 0);
    }
    if (needsCapabilities && generation === this.generation && path === this.path && !this.detaching && this.state?.revision === tree.state.revision) {
      void this.loadCapabilities({ path, generation }, tree.state.revision);
    }
  }
  private async loadCapabilities(context: ViewContext, revision: number): Promise<void> {
    if (this.detaching) return;
    try {
      const capabilities = await this.plugin.api.query.capabilities(context.path);
      this.assertContext(context);
      if (this.state?.revision !== revision || capabilities.revision !== revision || capabilities.sessionId !== this.state.sessionId) return;
      this.capabilities = capabilities; this.capabilityCheckPending = false; this.capabilityCheckError = undefined;
    } catch (error) {
      if (context.generation !== this.generation || context.path !== this.path || this.state?.revision !== revision) return;
      this.capabilityCheckPending = false;
      this.capabilityCheckError = error instanceof Error ? error.message : String(error);
      this.plugin.report(error);
    }
    this.updateStatus(); this.updateToolState();
  }
  private rebuildItemList(tree: DocumentTree): void {
    this.items = this.itemsForMode(tree);
    this.itemLabels.clear();
    for (const p of tree.paragraphs) this.itemLabels.set(p.nodePath, `${p.section + 1}구역 · ${p.paragraph + 1}문단`);
    for (const [tableIndex, table] of tree.tables.entries()) for (const cell of table.cells) for (const p of cell.paragraphs) this.itemLabels.set(p.nodePath, `표 ${tableIndex + 1} · ${cell.row + 1}행 ${cell.col + 1}열 · ${p.cellPath!.at(-1)!.cellParaIndex + 1}문단`);
    for (const story of tree.stories) for (const paragraph of story.paragraphs) {
      const address = paragraph.address;
      const label = story.kind === 'headerFooter' ? `${story.label} · ${address.paragraph + 1}문단`
        : story.kind === 'textBox' ? `글상자 · ${address.section + 1}구역 ${address.paragraph + 1}문단`
          : `${story.kind === 'footnote' ? '각주' : '미주'} · ${address.section + 1}구역 ${address.paragraph + 1}문단`;
      this.itemLabels.set(paragraph.nodePath, label);
    }
  }
  private renderItemPage(selectedIndex = -1): void {
    const pageCount = Math.max(1, Math.ceil(this.items.length / EDITOR_ITEM_PAGE_SIZE));
    if (selectedIndex >= 0) this.itemPage = Math.floor(selectedIndex / EDITOR_ITEM_PAGE_SIZE);
    this.itemPage = Math.max(0, Math.min(this.itemPage, pageCount - 1));
    const start = this.itemPage * EDITOR_ITEM_PAGE_SIZE, end = Math.min(start + EDITOR_ITEM_PAGE_SIZE, this.items.length);
    this.selector.empty();
    for (let index = start; index < end; index++) {
      const item = this.items[index];
      this.selector.createEl('option', { value: String(index), text: `${isParagraph(item) ? this.itemLabels.get(String(item.nodePath)) : item.name}: ${(isParagraph(item) ? String(item.text) : item.value).slice(0, 70) || '(빈 내용)'}` });
    }
    this.itemPagePrevious.disabled = this.itemPage === 0;
    this.itemPageNext.disabled = this.itemPage + 1 >= pageCount;
    this.itemPageStatus.setText(this.items.length ? `${start + 1}–${end} / ${this.items.length}` : '항목 없음');
  }
  private itemsForMode(tree: DocumentTree): Array<TextParagraph | Field> {
    const items = this.mode === 'paragraphs' ? tree.paragraphs
      : this.mode === 'fields' ? tree.fields
        : this.mode === 'stories' ? tree.stories.flatMap(story => [...story.paragraphs])
          : tree.tables.flatMap(table => table.cells.flatMap(cell => cell.paragraphs));
    return (this.mode === 'fields' && this.formMode ? items.filter(item => isParagraph(item) || item.editableInForm !== false) : items);
  }
  private selectItem(index: number, inline = this.inlineEditorActive): void {
    const next = this.items[index];
    this.caretMoveSequence++;
    this.cellBlockSelection = undefined;
    if (this.selected?.nodePath !== next?.nodePath) { this.resetInputGroup(); this.pendingCaretProperties = undefined; this.preferredCaretX = undefined; this.selectionAnchor = undefined; }
    this.selected = next; this.renderItemPage(this.selected ? index : -1); this.selector.value = this.selected ? String(index) : ''; this.draftRevision = this.state?.revision ?? 0;
    this.textarea.value = this.selected ? (isParagraph(this.selected) ? editorTextFromModel(this.selected.text) : this.selected.value) : '';
    this.textarea.placeholder = this.selected && !isParagraph(this.selected) && typeof this.selected.guide === 'string' ? this.selected.guide : '';
    if (!this.selected || !isParagraph(this.selected) || this.inlineCellSelection?.paragraphPath !== this.selected.nodePath) this.inlineCellSelection = undefined;
    this.inlineEditorActive = !!this.selected && inline;
    this.pageSelection = this.selected && isParagraph(this.selected) ? { address: this.selected.address, start: 0, end: 0 } : undefined;
    this.syncInputDisabled(); this.infoEl.setText(this.selected ? String(isParagraph(this.selected) ? this.itemLabels.get(String(this.selected.nodePath)) : this.selected.name) : '편집 대상이 없습니다.');
    this.updatePageSelectionOverlay(true);
    this.updateToolState(); this.updateStatus();
  }
  private clearSelection(label: string): void {
    this.caretMoveSequence++;
    this.cellBlockSelection = undefined;
    this.resetInputGroup(); this.pendingCaretProperties = undefined; this.preferredCaretX = undefined; this.selectionAnchor = undefined; this.selected = undefined; this.inlineEditorActive = false; this.pageSelection = undefined; this.selector.selectedIndex = -1; this.textarea.value = ''; this.textarea.placeholder = ''; this.syncInputDisabled(); this.infoEl.setText(label); this.updatePageSelectionOverlay(true); this.updateToolState(); this.updateStatus();
  }
  private async renderPage(scrollIntoView = false): Promise<void> {
    if (!this.path || !this.state || !this.pageStack) return;
    // Resume once the active page is on screen; neighbour pages finish in the background and redraw overlays through onMount.
    await this.pageStack.setActivePage(this.page, scrollIntoView, true, 'active');
    this.page = this.pageStack.currentPage;
    const cached = this.pageLayouts.get(this.page);
    this.pageLayout = cached?.layout;
    this.pageLayoutRevision = cached?.revision ?? -1;
    this.pageLabel.setText(`${this.page + 1} / ${this.state.pageCount}쪽`);
    this.pageInput.value = String(this.page + 1); this.pageInput.max = String(this.state.pageCount);
    this.updatePageSelectionOverlay(true); this.updateToolState(); this.updateStatus();
  }
  private async renderPageInto(page: number, element: HTMLElement, isCurrent: () => boolean): Promise<boolean> {
    if (!this.path || !this.state || this.detaching) return false;
    // Decided once: the active page may change while this render waits, and an active render must never wait on its own image.
    const active = page === this.page;
    let bitmap: ImageBitmap | undefined;
    let shown: (() => void) | undefined;
    if (active) this.activePageShown = new Promise<void>(resolve => { shown = resolve; });
    try {
      const context = this.captureContext(), revision = this.state.revision;
      if (documentInputNeedsPaint(element.ownerDocument, this.lastInputAt)) {
        // Even a cache hit clones a page's large layout before resolving. Let the input frames run before requesting any page,
        // including neighbours; otherwise those promise callbacks can delay the input handler before SVG mounting starts.
        await afterActivePagePaint(Promise.resolve(), element.ownerDocument.defaultView ?? window, INPUT_FRAME_GUARD_MS);
        if (!isCurrent() || context.generation !== this.generation || context.path !== this.path) return false;
      }
      let rendered: { layout: PageLayout; revision: number; sessionId?: string; bitmap?: ImageBitmap; svg?: string };
      try {
        const canvas = await this.plugin.manager.renderCanvasPage(context.path, page,
          this.pageStack?.rasterScale(page) ?? 1,
          { sessionId: this.state.sessionId, expectedRevision: revision }, this.renderOptions);
        bitmap = canvas.bitmap; rendered = canvas;
      } catch (error) {
        if (!(error instanceof HwpHandsError)) throw error;
        if (error.code === 'REVISION_CONFLICT') {
          // An edit queued before this request moved the document on; this is a stale request, not a failure.
          if (isCurrent() && context.generation === this.generation && context.path === this.path) void this.refresh().catch(error => this.plugin.report(error));
          return false;
        }
        if (error.code !== 'ENGINE_ERROR') throw error;
        // The Worker Canvas refuses pages whose embedded pictures it cannot decode safely. Show those pages as sanitized SVG.
        const svg = await this.plugin.api.render.page(context.path, page, this.renderOptions);
        if (!svg.layout) return false;
        rendered = { layout: svg.layout, revision: svg.revision, svg: svg.svg };
      }
      if (!isCurrent() || context.generation !== this.generation || context.path !== this.path || !rendered.layout) return false;
      if (rendered.revision !== revision || this.state?.revision !== revision) {
        void this.refresh().catch(error => this.plugin.report(error));
        return false;
      }
      if (!active) {
        // The neighbour's SVG was requested with the active page's, but its sanitize and decode wait until the active page shows.
        // Each mount is its own task, so several neighbours never form one long task either.
        await afterActivePagePaint(this.activePageShown, element.ownerDocument.defaultView ?? window);
        if (!isCurrent() || context.generation !== this.generation || context.path !== this.path) return false;
      } else if (documentInputNeedsPaint(element.ownerDocument, this.lastInputAt)) {
        // A cached page in another leaf can resolve during the input event itself. Its sanitize/decode must also let that input's
        // frames go first; a per-view timestamp protects only the edited leaf.
        await afterActivePagePaint(Promise.resolve(), element.ownerDocument.defaultView ?? window, INPUT_FRAME_GUARD_MS);
        if (!isCurrent() || context.generation !== this.generation || context.path !== this.path) return false;
      }
      if (this.state?.revision !== revision || (rendered.sessionId !== undefined && this.state.sessionId !== rendered.sessionId)) return false;
      // The Worker returned pixels and layout from one serialized document revision.
      let content = element.querySelector<HTMLElement>(':scope > .hwp-page-content');
      if (!content) {
        content = element.ownerDocument.createElement('div');
        content.className = 'hwp-page-content';
        element.replaceChildren(content);
      }
      const label = `${page + 1}쪽 시각 미리보기. 문서 내용 입력창에서 내용을 읽고 편집할 수 있습니다.`;
      if (bitmap) {
        this.pageImages?.release(page);
        mountCanvasPage(content, { bitmap }, label);
        shown?.(); shown = undefined;
      } else {
        releaseCanvases(content);
        this.pageImages?.mount(page, content, rendered.svg!, label);
        if (shown) { void (this.pageImages?.settled(page) ?? Promise.resolve()).then(shown); shown = undefined; }
      }
      this.pageLayouts.set(page, { layout: rendered.layout, revision: rendered.revision });
      this.pageStack?.setPageSize(page, rendered.layout.info.width, rendered.layout.info.height);
      if (page === this.page) {
        this.pageEl = element; this.pageLayout = rendered.layout; this.pageLayoutRevision = rendered.revision;
        this.updatePageSelectionOverlay(true); this.updateToolState(); this.updateStatus();
      }
      return true;
    } finally { bitmap?.close(); shown?.(); }
  }
  private onActivePageChanged(page: number, element: HTMLElement): void {
    this.page = page; this.pageEl = element;
    const cached = this.pageLayouts.get(page);
    this.pageLayout = cached?.layout;
    this.pageLayoutRevision = cached?.revision ?? -1;
    if (this.pageLabel) this.pageLabel.setText(`${page + 1} / ${this.state?.pageCount ?? 1}쪽`);
    if (this.pageInput) { this.pageInput.value = String(page + 1); this.pageInput.max = String(this.state?.pageCount ?? 1); }
    if (this.pageEl) { this.updatePageSelectionOverlay(true); }
    if (this.state) { this.updateToolState(); this.updateStatus(); }
    this.scheduleRulerDraw();
  }
  private async goToPage(): Promise<void> {
    if (this.draft || this.composing) throw new Error('입력을 적용하거나 조합을 마친 뒤 쪽을 이동하세요.');
    if (!this.state) throw new Error('문서가 아직 준비되지 않았습니다.');
    const requested = Number(this.pageInput.value);
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > this.state.pageCount) {
      throw new Error(`쪽 번호는 1부터 ${this.state.pageCount} 사이여야 합니다.`);
    }
    this.page = requested - 1;
    await this.renderPage(true);
    this.navigationStatus.setText(`${requested}쪽으로 이동했습니다.`);
  }
  private async goToSection(): Promise<void> {
    if (this.draft || this.composing) throw new Error('입력을 적용하거나 조합을 마친 뒤 구역을 이동하세요.');
    const section = Number(this.sectionGotoSelect.value), tree = this.documentTree;
    if (!Number.isSafeInteger(section) || section < 0 || !tree) throw new Error('이동할 구역을 읽지 못했습니다.');
    const paragraph = tree.paragraphs.find(item => item.address.kind === 'body' && item.address.section === section
      && !item.address.cellPath?.length && !item.address.containerKinds?.includes('textBox'));
    if (!paragraph) throw new Error(`구역 ${section + 1}에 이동할 본문 문단이 없습니다.`);
    await this.goToParagraphOffset(paragraph, 0, `구역 ${section + 1} 첫 문단`);
  }
  /** Moves the page, selection and caret to a code point offset of a body paragraph, re-checking the revision. */
  private async goToParagraphOffset(paragraph: TextParagraph, offset: number, label: string): Promise<void> {
    const tree = this.documentTree, state = this.state;
    if (!tree || !state || !this.path) throw new Error('이동할 문서 상태를 읽지 못했습니다.');
    const context = this.captureContext(), revision = state.revision;
    const caret = await this.plugin.api.query.caret(context.path, { address: paragraph.address, offset }, {
      sessionId: state.sessionId, expectedRevision: revision,
    });
    this.assertContext(context);
    const latest = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (latest.revision !== revision || this.state?.revision !== revision) throw new Error('이동 중 문서가 변경되어 이동을 취소했습니다.');
    const page = Math.min(Math.max(0, caret.rect.pageIndex), Math.max(0, latest.pageCount - 1));
    this.page = page; this.selectedObject = undefined;
    await this.pageStack?.setActivePage(page, true, false); this.assertContext(context);
    this.mode = 'paragraphs'; this.modeSelector.value = this.mode; this.items = this.itemsForMode(tree);
    const index = this.items.findIndex(item => isParagraph(item) && item.nodePath === paragraph.nodePath);
    if (index < 0) throw new Error('이동할 문단을 편집 목록에서 찾지 못했습니다.');
    this.selectItem(index, false);
    const native = utf16OffsetFromCodePoint(this.textarea.value, offset);
    this.textarea.setSelectionRange(native, native);
    const position: TextPosition = { address: paragraph.address, offset };
    this.pageSelection = { address: paragraph.address, start: offset, end: offset, focus: position };
    this.selectionAnchor = position; this.updatePageSelectionOverlay();
    this.textarea.focus({ preventScroll: true });
    this.navigationStatus.setText(`${label} · ${page + 1}쪽으로 이동했습니다.`);
  }
  private async listBookmarks(): Promise<Bookmark[]> {
    if (!this.path) return [];
    const context = this.captureContext(), items: Bookmark[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.plugin.api.query.structure(context.path, { collection: 'bookmarks', offset, limit: 500 });
      this.assertContext(context);
      items.push(...(page.items as Bookmark[]));
      if (offset + 500 >= page.total) return items;
    }
  }
  private async goToBookmark(bookmark: Bookmark): Promise<void> {
    if (this.draft || this.composing) throw new Error('입력을 적용하거나 조합을 마친 뒤 이동하세요.');
    const tree = this.documentTree;
    const paragraph = tree?.paragraphs.find(item => item.address.kind === 'body' && item.address.section === bookmark.address.section
      && item.address.paragraph === bookmark.address.paragraph && !item.address.cellPath?.length && !item.address.containerKinds?.includes('textBox'));
    if (!paragraph) throw new Error(`책갈피 "${bookmark.name}"의 문단을 찾지 못했습니다. 문서를 다시 불러온 뒤 시도하세요.`);
    await this.goToParagraphOffset(paragraph, Math.min(bookmark.offset, paragraph.length), `책갈피 "${bookmark.name}"`);
  }
  private async pickBookmark(): Promise<void> {
    const bookmarks = await this.listBookmarks();
    if (!bookmarks.length) { new Notice('이 문서에는 책갈피가 없습니다.'); return; }
    new BookmarkPickerModal(this.app, bookmarks, bookmark => { void this.goToBookmark(bookmark).catch(error => new Notice(String(error instanceof Error ? error.message : error), 8000)); }).open();
  }
  private openBookmarkModal(): void {
    const blocked = (): string | undefined => {
      if (!this.state) return '문서를 먼저 여세요.';
      if (this.composing) return '한글 조합을 마친 뒤 사용하세요.';
      if (this.formMode) return '양식 모드에서는 책갈피를 편집할 수 없습니다.';
      if (this.saving || this.inputLocks) return '현재 작업이 끝난 뒤 사용하세요.';
      if (this.capabilityCheckPending) return '문서 저장 안전성을 확인하고 있습니다.';
      return this.capabilitiesReadOnly() ? this.capabilities?.readOnlyReasons.join(' ') || '읽기 전용 문서입니다.' : undefined;
    };
    const addBlocked = (): string | undefined => !(this.selected && isParagraph(this.selected) && this.selected.address.kind === 'body' && !this.selected.address.cellPath?.length && !this.selected.address.containerKinds?.includes('textBox'))
      ? '책갈피를 추가할 글상자가 아닌 본문 문단을 선택하세요(표 셀 안은 지원하지 않습니다).'
      : undefined;
    new BookmarkModal(this.app, {
      list: () => this.listBookmarks(),
      add: async name => { const blocked = addBlocked(); if (blocked) throw new Error(blocked); const paragraph = this.rootBodyParagraph(); await this.execute([{ type: 'addBookmark', target: paragraph.address, offset: this.insertionOffset(paragraph), name }]); },
      rename: (name, newName) => this.execute([{ type: 'renameBookmark', name, newName }]),
      remove: name => this.execute([{ type: 'deleteBookmark', name }]),
      goTo: bookmark => this.goToBookmark(bookmark),
      editBlockedReason: blocked, addBlockedReason: addBlocked,
    }).open();
  }
  private async selectPageTarget(event: MouseEvent, dragStart?: number, dragEnd?: number, focus = false, page = this.page): Promise<TextPosition | undefined> {
    this.resetInputGroup();
    const cached = this.pageLayouts.get(page), layout = cached?.layout, tree = this.documentTree, state = this.state;
    const pageElement = this.pageStack?.pageElement(page);
    if (!layout || !tree || !state || cached?.revision !== state.revision || !pageElement) return undefined;
    if (this.draft || this.composing) { new Notice('페이지에서 다른 대상을 선택하기 전에 입력을 적용하거나 취소하세요.'); return undefined; }
    const context = this.captureContext(), revision = state.revision;
    let hit = this.pageHitAt(event.clientX, event.clientY, page);
    const bounds = pageElement.getBoundingClientRect();
    const pagePoint = pagePointFromClient(event.clientX, event.clientY, bounds, layout.info);
    if (pagePoint) {
      const engineHit = await this.plugin.api.query.hitTest(context.path, {
        page,
        x: pagePoint.x,
        y: pagePoint.y,
      }, { sessionId: state.sessionId, expectedRevision: state.revision });
      this.assertContext(context);
      if (this.state?.revision !== state.revision) { await this.refresh(); return; }
      if (engineHit?.kind === 'field' && engineHit.address && dragStart !== undefined && dragEnd !== undefined) {
        const paragraph = this.paragraphForAddress(tree, engineHit.address);
        if (paragraph) hit = { kind: 'paragraph', paragraph, offset: engineHit.offset ?? 0 };
      } else if (engineHit?.kind === 'field' && engineHit.field) {
        const field = tree.fields.find(item => item.fieldId === engineHit.field!.fieldId);
        if (field) hit = { kind: 'field', field, offset: engineHit.offset ?? 0 };
      } else if ((engineHit?.kind === 'paragraph' || engineHit?.kind === 'tableCell') && engineHit.address && engineHit.offset !== undefined) {
        const paragraph = this.paragraphForAddress(tree, engineHit.address);
        if (paragraph) {
          if (hit?.kind === 'tableCell') hit = { ...hit, paragraph: paragraph as Paragraph, offset: engineHit.offset };
          else hit = { kind: 'paragraph', paragraph, offset: engineHit.offset };
        }
      }
    }
    if (!hit) return undefined;
    if (this.formMode && hit.kind !== 'field') {
      new Notice('양식 모드에서는 누름틀만 선택하고 입력할 수 있습니다.');
      return undefined;
    }
    if (this.formMode && hit.kind === 'field' && hit.field.editableInForm === false) {
      new Notice('이 누름틀은 양식 모드에서 입력할 수 없습니다.');
      return undefined;
    }
    if (hit.kind === 'object') {
      const objects = await this.plugin.api.query.objects(context.path);
      this.assertContext(context);
      const latest = await this.plugin.api.documents.state(context.path);
      this.assertContext(context);
      if (latest.revision !== revision || this.state?.revision !== revision) { await this.refresh(); return undefined; }
      const object = objects.find(item => item.nodePath === hit.object.nodePath);
      if (!object) return undefined;
      this.selectedObject = object;
      this.clearSelection(`${objectKindLabel(object)} 선택 · ${this.itemLabels.get(object.nodePath) ?? object.nodePath}`);
      this.pageScroll.focus({ preventScroll: true });
      if (object.kind === 'equation' && event.type === 'click' && event.detail >= 2) {
        this.openObjectPropertiesDialog();
      }
      return undefined;
    }
    this.selectedObject = undefined;
    if (hit.kind === 'tableCell' && !hit.paragraph) {
      this.clearSelection(`표 셀 선택 · ${hit.row + 1}행 ${hit.col + 1}열`);
      return undefined;
    }
    const paragraph = hit.kind === 'paragraph' ? hit.paragraph : hit.kind === 'tableCell' ? hit.paragraph : undefined;
    if (paragraph && paragraph.address.kind !== 'body') {
      if (this.selected && isParagraph(this.selected) && this.selected.address.kind === 'body') {
        this.storyReturnPosition = { address: this.selected.address,
          offset: positionAfterEditorText(this.selected.address, this.textarea.value, this.textarea.selectionEnd).offset };
      }
    } else if (paragraph?.address.kind === 'body' && this.selected && isParagraph(this.selected)
      && this.selected.address.kind !== 'body') this.storyReturnPosition = undefined;
    const sameActiveStory = !!paragraph && this.inlineEditorActive && !!this.selected && isParagraph(this.selected)
      && sameDocumentAddress(this.selected.address, paragraph.address);
    if (event.type === 'click' && paragraph
      && !shouldEnterStoryOnClick(paragraph.address.kind, event.detail, sameActiveStory)) {
      this.infoEl.setText('머리말·꼬리말·각주·미주는 두 번 클릭해 편집하세요.');
      return undefined;
    }
    const desiredMode = hit.kind === 'field' ? 'fields'
      : !paragraph ? this.mode
        : paragraph.address.kind !== 'body' || isTextboxParagraph(paragraph) ? 'stories'
          : isTableCell(paragraph) ? 'cells' : 'paragraphs';
    const modeChanged = this.mode !== desiredMode;
    this.mode = desiredMode; this.modeSelector.value = desiredMode;
    const latest = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (latest.revision !== revision) { await this.refresh(); return; }
    if (this.state?.revision !== revision) return;
    this.state = latest; this.updateStatus(); this.updateToolState();
    if (modeChanged) { this.items = this.itemsForMode(tree); this.renderItemPage(); }
    const index = hit.kind === 'field'
      ? this.items.findIndex(item => !isParagraph(item) && item.fieldId === hit.field.fieldId)
      : paragraph ? this.items.findIndex(item => isParagraph(item) && item.nodePath === paragraph.nodePath) : -1;
    let selectedPosition: TextPosition | undefined;
    if (index >= 0) {
      this.inlineCellSelection = hit.kind === 'tableCell' && paragraph
        ? { paragraphPath: paragraph.nodePath, tablePath: hit.table.nodePath, cellIndex: hit.cellIndex }
        : undefined;
      this.selectItem(index, !!paragraph || hit.kind === 'field');
      if (hit.kind === 'field') {
        this.infoEl.setText(`${this.itemLabels.get(String(hit.field.nodePath)) ?? hit.field.name} · 필드`);
        this.showFieldBoundaryCaret(hit.field, hit.offset ?? (typeof hit.field.startCharIdx === 'number' ? hit.field.startCharIdx : 0));
        this.textarea.focus({ preventScroll: true });
      }
      else if (paragraph) {
        const hitOffset = hit.kind === 'paragraph' || hit.kind === 'tableCell' ? hit.offset ?? 0 : 0;
        const start = Math.min(dragStart ?? hitOffset, dragEnd ?? hitOffset);
        const end = Math.max(dragStart ?? hitOffset, dragEnd ?? hitOffset);
        const selected = this.selected;
        if (selected && isParagraph(selected)) {
          selectedPosition = { address: selected.address, offset: hitOffset };
          this.textarea.setSelectionRange(utf16OffsetFromCodePoint(this.textarea.value, start), utf16OffsetFromCodePoint(this.textarea.value, end));
          this.pageSelection = { address: selected.address, start, end };
          this.updatePageSelectionOverlay();
          this.updateToolState();
          if (focus) this.textarea.focus({ preventScroll: true });
        }
        this.infoEl.setText(`${this.itemLabels.get(String(paragraph.nodePath)) ?? paragraph.nodePath} · ${start + 1}자 위치`);
      }
    }
    return selectedPosition;
  }
  private target(): DocumentAddress {
    if (!this.selected || !isParagraph(this.selected)) throw new Error('본문 문단, 셀 또는 본문 밖 영역을 선택하세요.');
    return this.selected.address;
  }
  private async applyDraft(focusAfter = false): Promise<number | undefined> {
    this.directInputCommit.cancel();
    if (!this.draft) return undefined;
    if (this.composing) throw new Error('한글 조합을 마친 뒤 내용을 적용하세요.');
    const snapshot = this.captureDraftApplySnapshot(), unlock = this.lockInput();
    try {
      await this.draftAutosave.flush(this.captureInputDraft(snapshot.selected, snapshot.value, snapshot.context.path, snapshot.revision));
      return await this.applyDraftSnapshot(snapshot, true, [], undefined, focusAfter);
    } finally { unlock(); }
  }
  /**
   * Another writer (API, another view) can commit while the user is typing. The draft was captured at `snapshot.revision`; when the
   * edited paragraph is untouched in the current revision the typed change still applies, so rebase it. Otherwise the typed text stays
   * in the editor (and the autosaved draft) and the conflict is reported instead of silently dropping or overwriting either side.
   */
  private async rebasedDraftRevision(snapshot: DraftApplySnapshot): Promise<number> {
    const path = snapshot.context.path;
    const current = await this.plugin.api.documents.state(path);
    this.assertContext(snapshot.context);
    if (current.revision === snapshot.revision || !isParagraph(snapshot.selected)) return snapshot.revision;
    const selected = snapshot.selected, tree = await this.plugin.api.query.tree(path);
    this.assertContext(snapshot.context);
    const paragraph = this.paragraphForAddress(tree, selected.address);
    if (!paragraph || paragraph.nodePath !== selected.nodePath || paragraph.text !== selected.text) {
      throw new Error('입력하는 동안 다른 작성자가 이 문단을 바꿨습니다. 입력한 내용은 편집창과 복구 목록에 남아 있습니다.');
    }
    this.resetInputGroup(); // the other writer's commit ends the typing group, so this change starts a new undo step
    return tree.state.revision;
  }
  private async applyDraftSnapshot(snapshot: DraftApplySnapshot, alreadyBackedUp: boolean, trailingCommands: Command[] = [], finalPosition?: TextPosition, focusAfter = false,
    keepTyping = false): Promise<number> {
    if (!this.draft) throw new Error('적용할 편집 내용이 없습니다.');
    if (this.composing) throw new Error('한글 조합을 마친 뒤 내용을 적용하세요.');
    this.assertContext(snapshot.context);
    const selected = snapshot.selected, wasInline = this.inlineEditorActive;
    let commands: Command[];
    let position = finalPosition;
    if (isParagraph(selected)) {
      commands = paragraphEditCommands(selected.address, selected.text, snapshot.value, this.pendingCaretProperties);
      position ??= positionAfterEditorText(selected.address, snapshot.value, snapshot.selectionEnd);
    } else {
      if (selected.sessionId === undefined || selected.revision === undefined) throw new Error('필드 주소가 오래되어 다시 선택해야 합니다.');
      commands = [{ type: 'setFieldById', fieldId: selected.fieldId, sessionId: selected.sessionId, revision: selected.revision, value: snapshot.value }];
    }
    commands.push(...trailingCommands);
    if (commands.length > 500) throw new Error('한 번의 편집에 500개 넘는 문단 명령을 적용할 수 없습니다.');
    if (!alreadyBackedUp) await this.draftAutosave.flush(this.captureInputDraft(snapshot.selected, snapshot.value, snapshot.context.path, snapshot.revision));
    // The path, selected item, text, and expected revision stay bound to the user's original Apply action.
    let revision = snapshot.revision, changedPages: readonly number[] | undefined;
    if (commands.length) {
      const expectedRevision = await this.rebasedDraftRevision(snapshot);
      const command = commands.length === 1 && (commands[0].type === 'insertText' || commands[0].type === 'deleteText') ? commands[0] : undefined;
      const groupedInput = !!command && isParagraph(selected) && selected.address.kind === 'body' && !('kind' in command.target);
      if (!groupedInput) this.resetInputGroup();
      else {
        if (this.inputGroupTarget !== selected.nodePath) { this.resetInputGroup(); this.inputGroupTarget = selected.nodePath; }
        this.inputGroupId ??= `typing-${randomUUID()}`;
      }
      let applied: Awaited<ReturnType<typeof this.plugin.api.edit.transaction>>;
      try {
        applied = await this.plugin.manager.transactionFromView(snapshot.context.path, commands, {
          expectedRevision, origin: 'input', ...(groupedInput && this.inputGroupId ? { groupId: this.inputGroupId } : {}),
        });
      } catch (error) { this.resetInputGroup(); throw error; }
      revision = applied.revision; this.assertContext(snapshot.context);
      if (applied.pageCountDelta === 0) changedPages = applied.changedPages;
    }
    if (keepTyping) return this.continueTypingAfterCommit(snapshot, revision, changedPages);
    // Cleanup still reads the old tree: keep draft coordinates clamped until it finishes.
    this.draftSaveError = undefined;
    try { await this.discardAutosavedDraft(); }
    catch (error) {
      await this.draftAutosave.detach();
      new Notice('입력은 적용했지만 오래된 복구본을 정리하지 못했습니다. 복구 목록에서 확인한 뒤 폐기하세요.', 8000);
      this.plugin.report(error);
    }
    this.pageSelection = undefined; this.selectionAnchor = undefined;
    this.textarea.setSelectionRange(0, 0);
    this.draft = false;
    await this.refresh();
    if (position && this.state?.revision === revision) { this.inlineEditorActive = wasInline; this.restoreTextPosition(position, focusAfter); }
    else if (!isParagraph(selected) && this.state?.revision === revision) {
      // refresh() folds the selection after any revision change; a field the user just filled stays selected for Tab navigation.
      // Folding also cleared the inline flag, and a non-inline editor sits in the hidden panel of the focused view where it cannot
      // keep focus, so the next Tab would never reach the editor. Restore both as the paragraph path does.
      const index = this.items.findIndex(item => !isParagraph(item) && item.fieldId === selected.fieldId);
      if (index >= 0) {
        this.inlineEditorActive = wasInline; this.selectItem(index, wasInline);
        if (this.formMode) { const field = this.selected; if (field && !isParagraph(field)) this.showFieldBoundaryCaret(field, typeof field.startCharIdx === 'number' ? field.startCharIdx : 0); }
        if (focusAfter) this.textarea.focus({ preventScroll: true });
      }
    }
    return revision;
  }
  private async execute(commands: Command[], afterPosition?: TextPosition, focusAfter = false): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 명령을 실행하세요.');
    if (this.formMode) throw new Error('양식 모드에서는 누름틀 값만 입력할 수 있습니다.');
    const context = this.captureContext(), stableCommands = structuredClone(commands), wasInline = this.inlineEditorActive;
    const formattingSelection = isNonstructuralFormatting(stableCommands) ? this.captureFormattingSelection() : undefined;
    const initialRevision = this.draft ? this.draftRevision : this.state?.revision;
    if (initialRevision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const unlock = this.lockInput();
    try {
      const appliedRevision = this.draft ? await this.applyDraft() : undefined;
      this.assertContext(context);
      if (this.draft) throw new Error('추가 입력을 적용한 뒤 명령을 실행하세요.');
      const receipt = await this.plugin.manager.transactionFromView(context.path, stableCommands, { expectedRevision: appliedRevision ?? initialRevision, origin: 'command' });
      this.assertContext(context); await this.refresh();
      if (this.state?.revision === receipt.revision) {
        this.inlineEditorActive = wasInline;
        if (formattingSelection) this.restoreFormattingSelection(formattingSelection, stableCommands, receipt.revision);
        if (afterPosition) this.restoreTextPosition(afterPosition, focusAfter);
      }
    } finally { unlock(); }
  }
  private async showDocumentChanges(): Promise<void> {
    if (this.baselineText === undefined) throw new Error('비교할 기준 텍스트가 아직 준비되지 않았습니다.');
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const currentText = await this.plugin.api.query.text(context.path); this.assertContext(context);
    const current = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (current.revision !== revision) throw new Error('비교 중 문서가 변경되었습니다. 다시 열어 비교하세요.');
    const draft = this.draft && this.selected ? {
      target: isParagraph(this.selected) ? this.itemLabels.get(this.selected.nodePath) ?? this.selected.nodePath : this.selected.name,
      text: this.textarea.value,
    } : undefined;
    new DocumentChangesModal(this.app, this.baselineText, currentText, draft).open();
  }
  private async openInputRecovery(): Promise<void> {
    if (this.draft || this.composing) await this.draftAutosave.flush(this.captureInputDraft());
    new InputDraftRecoveryModal(this.app, this.plugin).open();
  }
  private async reloadFromDisk(confirmed = false): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 다시 불러오세요.');
    const context = this.captureContext();
    const reload = async () => {
      this.assertContext(context);
      const unlock = this.lockInput();
      try {
        await this.plugin.api.documents.reload(context.path, { discardChanges: true });
        this.assertContext(context);
        this.draft = false; await this.discardAutosavedDraft();
        this.baselineText = undefined; this.capabilities = undefined; this.operationError = undefined;
        await this.refresh();
      } finally { unlock(); }
    };
    if (!confirmed && (this.draft || this.state?.dirty || this.state?.conflict)) new ConfirmDiscard(this.app, async () => {
      try { await this.tasks.run(reload); }
      catch (error) { this.operationError = error instanceof Error ? error.message : String(error); this.updateStatus(); throw error; }
    }).open();
    else await reload();
  }
  async save(): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 저장하세요.');
    if (this.state?.conflict) throw new Error('디스크 파일이 변경되었습니다. 변경본을 새 파일로 저장하거나 디스크 버전을 다시 불러오세요.');
    if (this.capabilitiesReadOnly()) {
      throw new Error(this.capabilityCheckError ?? this.capabilities?.readOnlyReasons.join(' ') ?? '문서 저장 안전성을 확인 중입니다. 확인이 끝나면 다시 시도하세요.');
    }
    const context = this.captureContext(), initialRevision = this.draft ? this.draftRevision : this.state?.revision;
    if (initialRevision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    this.saving = true; this.updateStatus();
    try {
      const appliedRevision = this.draft ? await this.applyDraft() : undefined;
      this.assertContext(context);
      if (this.draft) throw new Error('남은 입력을 적용한 뒤 문서를 저장하세요.');
      const result = await this.plugin.api.documents.save(context.path, { expectedRevision: appliedRevision ?? initialRevision });
      this.assertContext(context);
      for (const warning of result.warnings) new Notice(warning, 8000);
      this.baselineText = undefined;
      new Notice('한글 문서를 저장했습니다.'); await this.refresh();
    } catch (error) {
      try {
        const capabilities = await this.plugin.api.query.capabilities(context.path); this.assertContext(context);
        this.capabilities = capabilities;
      } catch { /* Preserve the original save error; the next refresh can retry the capability query. */ }
      throw error;
    } finally {
      this.saving = false; this.updateStatus(); this.updateToolState();
    }
  }
  private saveAs(requestedFormat?: 'hwp' | 'hwpx', afterCopy?: () => Promise<void>): void {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 새 파일로 저장하세요.');
    const context = this.captureContext();
    const draftSnapshot = this.draft ? this.captureDraftApplySnapshot() : undefined;
    const initialRevision = draftSnapshot?.revision ?? this.state?.revision;
    if (initialRevision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const readOnly = this.capabilitiesReadOnly();
    const currentFormat = this.state?.format ?? 'hwpx';
    const alternateFormat = currentFormat === 'hwp' ? 'hwpx' : 'hwp';
    const copyFormat = requestedFormat ?? (readOnly && this.capabilities?.saveFormats[alternateFormat].available ? alternateFormat : currentFormat);
    const suggestedPath = context.path.replace(/\.(hwp|hwpx)$/i, ` - 사본.${copyFormat}`);
    const unlock = this.lockInput();
    try { new SaveAsModal(this.app, suggestedPath, copyFormat, async (destination, targetFormat) => {
      try { await this.tasks.run(async () => {
        this.saving = true; this.updateStatus();
        try {
          this.assertContext(context);
          if (this.composing) throw new Error('한글 조합을 마친 뒤 새 파일로 저장하세요.');
          if (draftSnapshot && !this.draft) throw new Error('저장 대화상자를 연 뒤 편집 상태가 바뀌었습니다. 다시 시도하세요.');
          const revision = draftSnapshot ? await this.applyDraftSnapshot(draftSnapshot, false) : initialRevision;
          this.assertContext(context);
          if (this.draft) throw new Error('남은 입력을 적용한 뒤 새 파일로 저장하세요.');
          const copy = await this.plugin.api.documents.saveAs(context.path, destination, { expectedRevision: revision });
          this.assertContext(context);
          if (copy.format !== targetFormat) throw new Error('저장 결과 형식이 선택한 사본 형식과 다릅니다.');
          new Notice(`재열기를 확인한 ${copy.format.toUpperCase()} ${copy.pageCount}쪽 사본을 저장했습니다: ${destination}`);
          for (const warning of copy.warnings ?? []) new Notice(warning, 8000);
          const file = this.app.vault.getAbstractFileByPath(destination);
          if (file instanceof TFile) setTimeout(() => { void this.app.workspace.getLeaf('tab').openFile(file); }, 0);
        } finally { this.saving = false; this.updateStatus(); this.updateToolState(); }
      });
      // The copy is already saved; a failure after it is reported on its own instead of as a failed save.
      if (afterCopy) await afterCopy().catch(error => this.plugin.report(error)); }
      catch (error) { this.operationError = error instanceof Error ? error.message : String(error); this.updateStatus(); throw error; }
    }, unlock).open(); } catch (error) { unlock(); throw error; }
  }
  private openPrintDialog(): void {
    const state = this.state;
    if (!state) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const context = this.captureContext();
    new PrintPagesModal(this.app, state.pageCount, async (firstPage, lastPage, progress, isCancelled) => {
      await this.tasks.run(async () => {
        const pages: Array<{ page: number; svg: string; width: number; height: number }> = [];
        const total = lastPage - firstPage + 1;
        for (let page = firstPage; page <= lastPage; page++) {
          if (isCancelled()) return;
          progress(page - firstPage + 1, total);
          pages.push({ page, ...await this.plugin.api.render.page(context.path, page) });
          this.assertContext(context);
        }
        if (isCancelled()) return;
        const owner = this.contentEl.ownerDocument, win = owner.defaultView;
        if (!win || typeof win.print !== 'function') throw new Error('현재 Obsidian/Electron 창이 인쇄를 지원하지 않습니다.');
        const surface = owner.createElement('main');
        surface.className = 'hwp-print-surface'; surface.setAttribute('aria-label', '인쇄할 문서 쪽');
        const pageImages = new SvgPageImages(owner), images: HTMLImageElement[] = [];
        for (const item of pages) {
          const page = owner.createElement('section'); page.className = 'hwp-print-page';
          page.style.width = `${item.width}px`; page.style.height = `${item.height}px`;
          const imageHost = owner.createElement('div'); imageHost.className = 'hwp-print-page-image'; page.append(imageHost);
          pageImages.mount(item.page, imageHost, item.svg, `문서 ${item.page + 1}쪽`);
          const image = imageHost.querySelector('img'); if (image) images.push(image);
          surface.append(page);
        }
        owner.body.append(surface); owner.body.classList.add('hwp-printing');
        let timeout: number | undefined, finishPrint: (() => void) | undefined;
        const printed = new Promise<void>((resolve, reject) => {
          const finish = (): void => { if (timeout !== undefined) win.clearTimeout(timeout); win.removeEventListener('afterprint', finish); resolve(); };
          finishPrint = finish;
          win.addEventListener('afterprint', finish, { once: true });
          timeout = win.setTimeout(finish, 300000);
          try { void Promise.all(images.map(image => image.decode?.().catch(() => undefined) ?? Promise.resolve())).then(() => { if (!isCancelled()) { win.focus(); win.print(); } else finish(); }).catch(reject); }
          catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
        });
        try { await printed; }
        finally { if (timeout !== undefined) win.clearTimeout(timeout); if (finishPrint) win.removeEventListener('afterprint', finishPrint); owner.body.classList.remove('hwp-printing'); pageImages.dispose(); surface.remove(); }
      });
    }).open();
  }
  /** Keyboard, Obsidian hotkey, menu, and toolbar undo/redo share this entry so a pending live-input draft is committed first. */
  private async historyCommand(redo: boolean): Promise<void> {
    if (this.draft) await this.applyDraft(true);
    await this.history(redo);
  }
  private historyAvailable(redo: boolean): boolean {
    const pendingLiveDraft = this.draft;
    return redo ? !!this.state?.canRedo && !pendingLiveDraft : !!this.state?.canUndo || pendingLiveDraft;
  }
  private async history(redo: boolean): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 undo/redo를 실행하세요.');
    if (this.draft) throw new Error('편집 중인 내용을 적용하거나 취소하세요.');
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const savedPosition = this.selected && isParagraph(this.selected)
      ? this.pageSelection?.focus ?? positionAfterEditorText(this.selected.address, this.textarea.value, this.textarea.selectionEnd)
      : undefined;
    const unlock = this.lockInput();
    try {
      await this.plugin.api.edit[redo ? 'redo' : 'undo'](context.path, { expectedRevision: revision });
      this.assertContext(context); await this.refresh();
      if (savedPosition) {
        try { await this.restoreHistoryCaret(savedPosition); }
        catch (error) { new Notice('변경은 되돌렸지만 캐럿 위치를 복원하지 못했습니다.'); this.plugin.report(error); }
      }
    } finally { unlock(); }
  }
  private async restoreHistoryCaret(position: TextPosition): Promise<void> {
    const tree = this.documentTree, state = this.state;
    if (!tree || !state) return;
    let paragraph = this.paragraphForAddress(tree, position.address);
    if (!paragraph && position.address.kind === 'body') {
      paragraph = tree.paragraphs.filter(item => item.address.kind === 'body' && item.address.section === position.address.section)
        .sort((left, right) => Math.abs(left.address.kind === 'body' ? left.address.paragraph - position.address.paragraph : 0)
          - Math.abs(right.address.kind === 'body' ? right.address.paragraph - position.address.paragraph : 0))[0];
    }
    if (!paragraph) return;
    const address = paragraph.address, target: TextPosition = { address, offset: Math.max(0, Math.min(paragraph.length, position.offset)) };
    this.mode = address.kind !== 'body' || address.containerKinds?.includes('textBox') ? 'stories'
      : address.cellPath?.length || address.containerKinds?.includes('tableCell') ? 'cells' : 'paragraphs';
    this.modeSelector.value = this.mode; this.items = this.itemsForMode(tree);
    const index = this.items.findIndex(item => isParagraph(item) && item.nodePath === paragraph.nodePath);
    if (index < 0) return;
    const context = this.captureContext();
    const caret = await this.plugin.api.query.caret(context.path, target, { sessionId: state.sessionId, expectedRevision: state.revision });
    this.assertContext(context);
    if (this.state?.revision !== state.revision) return;
    await this.pageStack?.setActivePage(caret.rect.pageIndex, true);
    this.selectItem(index, true); this.restoreTextPosition(caret.position, true);
  }
  async refreshIndex(): Promise<void> {
    const context = this.captureContext();
    const path = await this.plugin.api.index.refresh(context.path); this.assertContext(context);
    new Notice(`검색 인덱스 생성: ${path}`);
  }
  canRunEditorCommand(id: string): boolean { return this.commandRegistry.isAvailable(id); }
  runEditorCommand(id: string): Promise<void> {
    if (this.composing && ['format.bold', 'format.italic', 'format.underline'].includes(id)) {
      this.deferredCompositionCommand = { id, context: this.captureContext() };
      this.textarea.blur(); // Request native IME completion; apply formatting only after compositionend.
      return Promise.resolve();
    }
    const run = async (): Promise<void> => { await this.commandRegistry.run(id); };
    // Obsidian handles the Mod+Z hotkey before the textarea does, so undo/redo must wait for an in-flight input commit instead of being dropped as busy.
    const queueAfterCurrent = id === 'edit.undo' || id === 'edit.redo';
    return this.buttonActionDepth ? run() : queueAfterCurrent ? this.guard(run, false, true) : this.guardInput(run);
  }
  runSaveCommand(): void { void this.runEditorCommand('file.save'); }
  runRefreshIndexCommand(): void { void this.runEditorCommand('file.refresh-index'); }
  private async formatSelection(properties: Extract<Command, { type: 'formatText' }>['properties']): Promise<void> {
    await this.applySelectionFormatting({ character: properties });
  }
  private async copySelectedFormat(): Promise<void> {
    if (this.draft || this.composing) throw new Error('미적용 입력이나 한글 조합을 마친 뒤 모양을 복사하세요.');
    if (this.hasMultiParagraphSelection()) throw new Error('모양 복사는 한 문단 선택에서만 지원합니다.');
    if (!this.selected || !isParagraph(this.selected)) throw new Error('모양을 복사할 문단을 선택하세요.');
    const formatting = this.selectedParagraphFormatting();
    if (!formatting) throw new Error('선택 문단의 서식 정보를 읽지 못했습니다.');
    const character = this.selectedCharacterFormat();
    const native = formatting.nativeShape;
    const lineSpacingType = formatting.properties?.lineSpacingType;
    const supportedLineSpacingType = lineSpacingType && ['Percent', 'Fixed', 'SpaceOnly', 'Minimum', 'BetweenLines'].includes(lineSpacingType)
      ? lineSpacingType as NonNullable<CopiedFormat['paragraph']['lineSpacingType']> : undefined;
    const paragraph: CopiedFormat['paragraph'] = {
      ...(formatting.properties?.alignment ? { alignment: formatting.properties.alignment } : {}),
      ...(typeof native?.LeftMargin === 'number' ? { marginLeft: native.LeftMargin } : {}),
      ...(typeof native?.RightMargin === 'number' ? { marginRight: native.RightMargin } : {}),
      ...(typeof native?.Indentation === 'number' ? { indent: native.Indentation } : {}),
      ...(typeof native?.PrevSpacing === 'number' ? { spacingBefore: native.PrevSpacing } : {}),
      ...(typeof native?.NextSpacing === 'number' ? { spacingAfter: native.NextSpacing } : {}),
      ...(typeof native?.LineSpacing === 'number' ? { lineSpacing: native.LineSpacing } : {}),
      ...(supportedLineSpacingType ? { lineSpacingType: supportedLineSpacingType } : {}),
    };
    if (!Object.keys(character).length && !Object.keys(paragraph).length) throw new Error('선택 문단에서 복사할 수 있는 서식이 없습니다.');
    this.copiedFormat = { character, paragraph };
    this.updateToolState(); this.updateStatus();
    new Notice('선택한 글자·문단 모양을 복사했습니다.');
  }
  private async applyCopiedFormat(): Promise<void> {
    if (!this.copiedFormat) throw new Error('먼저 모양을 복사하세요.');
    const character = Object.keys(this.copiedFormat.character).length ? this.copiedFormat.character : undefined;
    const paragraph = Object.keys(this.copiedFormat.paragraph).length ? this.copiedFormat.paragraph : undefined;
    if (!character && !paragraph) throw new Error('복사한 서식 값이 없습니다.');
    await this.applySelectionFormatting({ ...(character ? { character } : {}), ...(paragraph ? { paragraph } : {}) });
    new Notice('복사한 모양을 적용했습니다.');
  }
  private selectedFormattingParagraphs() {
    if (this.toolFormatting) return this.toolFormatting.paragraphs();
    if (!this.formattingModel) return [];
    const block = this.cellBlockSelection;
    const table = block && this.documentTree?.tables.find(item => item.nodePath === block.tablePath);
    const whole = block && table ? cellsInCellBlock(table, block).flatMap(cell => cell.paragraphs.map(paragraph => paragraph.address)) : [];
    return selectedFormatting(this.formattingModel, whole.length ? [] : this.selectionSegments(), whole);
  }
  private selectedFormattingRuns() {
    if (this.toolFormatting) return this.toolFormatting.runs();
    if (!this.formattingModel) return [];
    const block = this.cellBlockSelection;
    const table = block && this.documentTree?.tables.find(item => item.nodePath === block.tablePath);
    const whole = block && table ? cellsInCellBlock(table, block).flatMap(cell => cell.paragraphs.map(paragraph => paragraph.address)) : [];
    return selectedCharacterRuns(this.formattingModel, whole.length ? [] : this.selectionSegments(), whole);
  }
  private selectedCharacterFormat(): CharacterFormatUpdate {
    const relevant = this.selectedFormattingRuns();
    const result: CharacterFormatUpdate = {};
    for (const key of ['bold', 'italic', 'underline', 'strikethrough', 'fontFamily', 'fontSize', 'textColor', 'shadeColor',
      'underlineType', 'underlineColor', 'underlineShape', 'strikeColor', 'strikeShape', 'outlineType', 'shadowType', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
      'subscript', 'superscript', 'emboss', 'engrave', 'emphasisDot', 'kerning'] as const) {
      if (this.toolFormatting?.expired) return {};
      const value = uniformValue(relevant.map(run => run.properties[key]));
      if (value !== undefined) Object.assign(result, { [key]: value });
    }
    const ratio = this.selectedUniformCharacterMetric('ratio'), characterSpacing = this.selectedUniformCharacterMetric('characterSpacing'), relativeSize = this.selectedUniformCharacterMetric('relativeSize'), characterOffset = this.selectedUniformCharacterMetric('characterOffset');
    if (ratio !== undefined) result.ratio = ratio;
    if (characterSpacing !== undefined) result.characterSpacing = characterSpacing;
    if (relativeSize !== undefined) result.relativeSize = relativeSize;
    if (characterOffset !== undefined) result.characterOffset = characterOffset;
    if (!this.cellBlockSelection && this.selectionSegments().every(range => this.rangeIsCollapsed(range)) && this.pendingCaretProperties) Object.assign(result, this.pendingCaretProperties);
    if (result.fontFamilies) { delete result.fontFamily; delete result.fontLanguage; }
    return this.toolFormatting?.expired ? {} : result;
  }
  private selectedUniformCharacterMetric(metric: 'ratio' | 'characterSpacing' | 'relativeSize' | 'characterOffset'): number | undefined {
    const relevant = this.selectedFormattingRuns();
    const key = metric === 'ratio' ? 'ratios' : metric === 'characterSpacing' ? 'spacings' : metric === 'relativeSize' ? 'relativeSizes' : 'charOffsets';
    const arrays = relevant.map(run => run.properties[key]);
    if (!arrays.length || arrays.some(values => !Array.isArray(values) || values.length !== 7 || values.some(value => !Number.isFinite(value)))) return undefined;
    const values = new Set(arrays.flat());
    return values.size === 1 ? arrays[0]![0] : undefined;
  }
  private selectedFontSizes(): number[] {
    return [...new Set(this.selectedFormattingRuns().map(run => run.properties.fontSize).filter((size): size is number => typeof size === 'number'))];
  }
  private async adjustFontSize(direction: -1 | 1): Promise<void> {
    const current = this.selectedCharacterFormat().fontSize ?? (Number(this.fontSizeInput.value) || 12);
    const fontSize = Math.max(1, Math.min(1000, Math.round((current + direction) * 2) / 2));
    this.fontSizeInput.value = String(fontSize);
    await this.formatSelection({ fontSize });
  }
  private async adjustCharacterMetric(metric: 'ratio' | 'characterSpacing', direction: -1 | 1): Promise<void> {
    const current = this.selectedCharacterFormat()[metric];
    if (current === undefined) throw new Error('선택한 글자의 장평·자간이 언어별로 달라 증감할 수 없습니다. 글자 모양 대화상자에서 새 값을 지정하세요.');
    const next = metric === 'ratio' ? Math.max(50, Math.min(200, current + direction)) : Math.max(-50, Math.min(50, current + direction));
    await this.formatSelection({ [metric]: next });
  }
  private updateFontSuggestions(): void {
    if (!this.fontFamilySuggestions) return;
    const documentFamilies = (this.formattingModel?.styles.flatMap(style => [
      style.detail.charProps.fontFamily,
      ...(style.detail.charProps.fontFamilies ?? []),
    ]) ?? []).concat(this.formattingModel?.paragraphs.flatMap(paragraph => paragraph.characterRuns.map(run => run.properties.fontFamily)) ?? []);
    const families = [...new Set([...documentFamilies, ...this.systemFontFamilies].map(family => family?.trim()).filter((family): family is string => !!family))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    this.fontFamilySuggestions.replaceChildren(...families.map(family => {
      const option = this.contentEl.ownerDocument.createElement('option'); option.value = family; return option;
    }));
  }
  private async loadSystemFonts(): Promise<void> {
    const navigator: LocalFontAccessNavigator | undefined = this.contentEl.ownerDocument.defaultView?.navigator;
    if (!navigator?.queryLocalFonts) throw new Error('현재 Obsidian/Electron은 설치 글꼴 목록 API를 제공하지 않습니다. 글꼴 이름을 직접 입력할 수 있습니다.');
    const fonts = await navigator.queryLocalFonts();
    this.systemFontFamilies = [...new Set(fonts.map(font => font.family.trim()).filter(Boolean))];
    this.updateFontSuggestions();
    new Notice(this.systemFontFamilies.length
      ? `설치 글꼴 ${this.systemFontFamilies.length}개를 목록에 불러왔습니다.`
      : '브라우저에서 설치 글꼴을 반환하지 않았습니다. 글꼴 이름을 직접 입력할 수 있습니다.');
  }
  private openCharacterFormatDialog(): void {
    new CharacterFormatModal(this.app, this.selectedCharacterFormat(), properties => this.formatSelection(properties)).open();
  }
  private openParagraphFormatDialog(): void {
    new ParagraphFormatModal(this.app, this.selectedParagraphFormatting()?.properties ?? {}, properties => this.applyParagraphFormat(properties)).open();
  }
  private openStyleSelectionDialog(): void {
    const formatting = this.selectedParagraphFormatting();
    new StyleSelectionModal(this.app, this.formattingModel?.styles ?? [], formatting?.style?.id, styleId => this.applyStyle(styleId)).open();
  }
  private async applyParagraphFormat(properties: Extract<Command, { type: 'formatParagraph' }>['properties']): Promise<void> {
    await this.applySelectionFormatting({ paragraph: properties });
  }
  private async toggleCharacterProperty(property: 'bold' | 'italic' | 'underline' | 'strikethrough'): Promise<void> {
    if (this.draft) await this.applyDraft(true);
    await this.formatSelection({ [property]: this.selectedCharacterFormat()[property] !== true });
  }
  /** A color input cannot show "mixed", so mixed or unread values are marked and named instead of passing for black. */
  private markMixedControl(input: HTMLInputElement, mixed: boolean, label: string): void {
    input.classList.toggle('hwp-format-mixed', mixed);
    if (mixed) { input.dataset.mixed = 'true'; input.setAttribute('aria-description', `${label}: 혼합 / 미확인`); input.title = `${label}: 혼합 / 미확인`; }
    else { delete input.dataset.mixed; input.removeAttribute('aria-description'); input.title = label; }
    if (input.type !== 'color') input.placeholder = mixed ? '혼합' : input === this.fontFamilyInput ? '글꼴 이름' : '';
  }
  /** Turning on one of 양각/음각 or 위/아래 첨자 turns its partner off, as RHWP does; 외곽선 toggles the plain outline (type 1). */
  private async toggleCharacterEffect(effect: CharacterEffect): Promise<void> {
    if (this.draft) await this.applyDraft(true);
    const next = this.characterEffectState(effect) !== true;
    if (effect === 'outline') { await this.formatSelection({ outlineType: next ? 1 : 0 }); return; }
    const partner = ({ emboss: 'engrave', engrave: 'emboss', superscript: 'subscript', subscript: 'superscript' } as const)[effect];
    await this.formatSelection(next ? { [effect]: true, [partner]: false } : { [effect]: false });
  }
  /** On, off, or mixed across the selection; a pending caret change wins as it does for 굵게. Unknown values read as off. */
  private characterEffectState(effect: CharacterEffect): boolean | 'mixed' | undefined {
    if (!this.formattingModel || !this.selected || !isParagraph(this.selected)) return undefined;
    const read = (properties: Pick<CharacterProperties, 'outlineType' | 'emboss' | 'engrave' | 'superscript' | 'subscript'>): boolean | undefined => effect === 'outline'
      ? (typeof properties.outlineType === 'number' ? properties.outlineType > 0 : undefined) : properties[effect];
    const collapsed = !this.cellBlockSelection && this.selectionSegments().every(range => this.rangeIsCollapsed(range));
    const pending = collapsed && this.pendingCaretProperties ? read(this.pendingCaretProperties) : undefined;
    if (pending !== undefined) return pending;
    const values = new Set(this.selectedFormattingRuns().map(run => read(run.properties) === true));
    return values.size > 1 ? 'mixed' : values.has(true);
  }
  private async paragraphFormat(alignment: ParagraphAlignment): Promise<void> {
    await this.applySelectionFormatting({ paragraph: { alignment } });
  }
  private canAdjustLineSpacing(): boolean {
    if (!this.state || this.formMode || this.composing || this.capabilityCheckPending || this.inputLocks || this.saving || this.capabilitiesReadOnly()
      || !!this.formattingReason({ paragraph: {} })) return false;
    const paragraphs = this.selectedFormattingParagraphs();
    const value = uniformValue(paragraphs.map(paragraph => paragraph.properties?.lineSpacing));
    return !!paragraphs.length && paragraphs.every(paragraph => paragraph.properties?.lineSpacingType === undefined || paragraph.properties.lineSpacingType === 'Percent')
      && (paragraphs.length === 1 || value !== undefined);
  }
  private lineSpacingReason(): string {
    if (this.formMode) return '양식 모드를 끈 뒤 문단 서식을 바꾸세요.';
    if (this.composing) return '미적용 입력을 적용하거나 한글 조합을 마친 뒤 사용하세요.';
    if (this.capabilitiesReadOnly()) return this.capabilities?.readOnlyReasons.join(' ') || '읽기 전용 상태에서는 줄 간격을 바꿀 수 없습니다.';
    if (!this.selected || !isParagraph(this.selected)) return '줄 간격을 바꿀 문단을 선택하세요.';
    const reason = this.formattingReason({ paragraph: {} }); if (reason) return reason;
    const mode = this.selectedParagraphFormatting()?.properties?.lineSpacingType;
    if (mode && mode !== 'Percent') return '줄 간격 증감은 퍼센트 모드에서만 사용할 수 있습니다.';
    if (this.selectedFormattingParagraphs().length > 1) return '서로 다른 줄 간격은 문단 모양에서 새 값을 지정하세요.';
    return '현재 문서 작업 상태에서는 줄 간격을 바꿀 수 없습니다.';
  }
  private async adjustLineSpacing(direction: -1 | 1): Promise<void> {
    if (!this.canAdjustLineSpacing()) throw new Error(this.lineSpacingReason());
    const current = this.selectedParagraphFormatting()?.properties?.lineSpacing;
    const lineSpacing = stepPercentLineSpacing(current, direction);
    this.paragraphLineSpacingTypeSelect.value = 'Percent';
    this.paragraphLineSpacingInput.value = String(lineSpacing);
    await this.applySelectionFormatting({ paragraph: { lineSpacing, lineSpacingType: 'Percent' } });
  }
  private async applyParagraphProperties(): Promise<void> {
    const present = (input: HTMLInputElement): boolean => input.value.trim() !== '';
    const properties: Extract<Command, { type: 'formatParagraph' }>['properties'] = {
      ...(this.alignmentSelect.value ? { alignment: this.alignmentSelect.value as ParagraphAlignment } : {}),
      ...(present(this.paragraphIndentInput) ? { indent: millimetersToDoubledHwpUnits(Number(this.paragraphIndentInput.value)) } : {}),
      ...(present(this.paragraphSpacingBeforeInput) ? { spacingBefore: millimetersToHwpUnits(Number(this.paragraphSpacingBeforeInput.value)) } : {}),
      ...(present(this.paragraphSpacingAfterInput) ? { spacingAfter: millimetersToHwpUnits(Number(this.paragraphSpacingAfterInput.value)) } : {}),
      ...(present(this.paragraphLineSpacingInput) ? {
        lineSpacing: this.paragraphLineSpacingTypeSelect.value === 'Percent' ? Number(this.paragraphLineSpacingInput.value) : pointsToHwpUnits(Number(this.paragraphLineSpacingInput.value)),
        lineSpacingType: this.paragraphLineSpacingTypeSelect.value as 'Percent' | 'Fixed' | 'SpaceOnly' | 'Minimum',
      } : {}),
    };
    if (Object.values(properties).some(value => typeof value === 'number' && !Number.isFinite(value))) throw new Error('문단 서식 값은 유한한 숫자여야 합니다.');
    await this.applySelectionFormatting({ paragraph: properties });
  }
  private async insertPageBreak(kind: 'page' | 'column'): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 쪽 나누기를 실행하세요.');
    if (this.draft) await this.applyDraft(true);
    const selected = this.selected;
    if (!selected || !isParagraph(selected) || selected.address.kind !== 'body' || selected.address.cellPath?.length || selected.address.containerKinds?.includes('textBox')) {
      throw new Error('쪽 나누기는 본문 문단에서만 삽입할 수 있습니다.');
    }
    const offset = codePointOffsetFromUtf16(this.textarea.value, this.textarea.selectionStart);
    const position = positionAfterEditorText(selected.address, this.textarea.value, this.textarea.selectionStart);
    if (position.address.kind !== 'body' || position.address.cellPath?.length || position.address.containerKinds?.includes('textBox')) throw new Error('쪽 나누기 위치를 본문 문단으로 확인하지 못했습니다.');
    const target = { section: position.address.section, paragraph: position.address.paragraph };
    await this.execute([{ type: 'insertPageBreak', target, offset, kind }], position, true);
  }
  private async applyStyle(styleId: number): Promise<void> {
    if (!Number.isSafeInteger(styleId) || styleId < 0) throw new Error('문단 스타일을 선택하세요.');
    await this.applySelectionFormatting({ styleId });
  }
  private async applyList(value: string): Promise<void> {
    let list: Extract<Command, { type: 'setParagraphList' }>['list'];
    if (value === 'none') list = { kind: 'none' };
    else if (value === 'numbering:auto') list = { kind: 'numbering' };
    else if (value.startsWith('numbering:')) list = { kind: 'numbering', numberingId: Number(value.slice('numbering:'.length)) };
    else if (value.startsWith('bullet:')) {
      const bulletId = value.slice('bullet:'.length);
      const definition = this.formattingModel?.bullets.find(item => String(item.id) === bulletId);
      list = { kind: 'bullet', char: definition?.char ?? '•' };
    } else throw new Error('목록 서식을 선택하세요.');
    await this.applySelectionFormatting({ list });
  }
  private listToggleReason(): string | undefined {
    if (!this.state) return '문서를 먼저 여세요.';
    if (this.composing) return '미적용 입력을 적용하거나 한글 조합을 마친 뒤 사용하세요.';

    if (this.formMode) return '양식 모드에서는 목록 서식을 바꿀 수 없습니다.';
    if (this.capabilityCheckPending || this.inputLocks || this.saving) return '문서 검증 또는 저장이 끝난 뒤 다시 시도하세요.';
    if (this.capabilitiesReadOnly()) return this.capabilities?.readOnlyReasons.join(' ') || '읽기 전용 문서에서는 목록을 바꿀 수 없습니다.';
    const reason = this.formattingReason({ list: { kind: 'none' } }); if (reason) return reason;
    return undefined;
  }
  private async toggleParagraphList(kind: 'numbering' | 'bullet'): Promise<void> {
    const reason = this.listToggleReason();
    if (reason) throw new Error(reason);
    const current = this.currentParagraphList();
    let list: Extract<Command, { type: 'setParagraphList' }>['list'];
    if (current?.kind === kind) list = { kind: 'none' };
    else if (kind === 'numbering') list = { kind: 'numbering' };
    else {
      const selectedBullet = this.listSelect?.value.startsWith('bullet:') ? this.listSelect.value.slice('bullet:'.length) : undefined;
      const definition = selectedBullet && selectedBullet !== 'default' ? this.formattingModel?.bullets.find(item => String(item.id) === selectedBullet) : undefined;
      list = { kind: 'bullet', char: definition?.char ?? '•' };
    }
    await this.applySelectionFormatting({ list });
  }
  private currentParagraphList(): Exclude<ParagraphList, { kind: 'none' }> | undefined {
    if (!this.selected || !isParagraph(this.selected) || this.selected.address.kind !== 'body'
      || (this.selected.address.cellPath?.length ?? 0) > 1) return undefined;
    const properties = this.selectedParagraphFormatting()?.properties;
    const level = typeof properties?.paraLevel === 'number' ? properties.paraLevel : 0;
    if (properties?.headType === 'Number') return {
      kind: 'numbering', ...(typeof properties.numberingId === 'number' ? { numberingId: properties.numberingId } : {}), level,
    };
    if (properties?.headType === 'Bullet') {
      const bullet = this.formattingModel?.bullets.find(item => item.id === properties.numberingId);
      return { kind: 'bullet', char: bullet?.char ?? '•', level };
    }
    return undefined;
  }
  private maxListLevel(list: Exclude<ParagraphList, { kind: 'none' }>): number {
    if (list.kind === 'bullet') return 6;
    return Math.max(0, (this.formattingModel?.numbering.find(item => item.id === list.numberingId)?.levelFormats.length ?? 1) - 1);
  }
  private canChangeListLevel(delta: -1 | 1): boolean {
    if (this.listToggleReason()) return false;
    const list = this.currentParagraphList();
    if (!list) return false;
    const level = list.level ?? 0;
    return delta < 0 ? level > 0 : level < this.maxListLevel(list);
  }
  private listLevelReason(delta: -1 | 1): string {
    if (this.composing) return '미적용 입력을 적용하거나 한글 조합을 마친 뒤 사용하세요.';
    if (this.capabilitiesReadOnly()) return this.capabilities?.readOnlyReasons.join(' ') || '읽기 전용 문서에서는 목록 수준을 바꿀 수 없습니다.';
    const list = this.currentParagraphList();
    if (!list) return '본문 또는 직속 표 셀의 번호/글머리표 문단을 선택하세요.';
    const level = list.level ?? 0;
    if (delta < 0 && level <= 0) return '가장 바깥 수준보다 더 내릴 수 없습니다.';
    if (delta > 0 && level >= this.maxListLevel(list)) return '정의된 목록 수준의 끝입니다.';
    return '문서 작업을 마친 뒤 다시 시도하세요.';
  }
  private async changeListLevel(delta: -1 | 1): Promise<void> {
    if (!this.canChangeListLevel(delta)) throw new Error(this.listLevelReason(delta));
    const list = this.currentParagraphList();
    if (!list) throw new Error(this.listLevelReason(delta));
    await this.applySelectionFormatting({ list: { ...list, level: (list.level ?? 0) + delta } });
  }
  private async tableTarget(): Promise<{ table: Table; row: number; col: number }> {
    const context = this.selectedTableCell();
    if (!context) throw new Error('본문의 표 셀 안 문단을 선택하세요. 중첩 표 구조 변경은 지원하지 않습니다.');
    return { table: context.table, row: context.cell.row, col: context.cell.col };
  }
  private async editTableStructure(action: TableStructureAction): Promise<void> {
    const { table, row, col } = await this.tableTarget();
    const target = { ...table.address, control: table.control };
    const command: Command = action === 'insert-row-above' ? { type: 'insertTableRow', table: target, row, below: false }
      : action === 'insert-row-below' ? { type: 'insertTableRow', table: target, row, below: true }
        : action === 'delete-row' ? { type: 'deleteTableRow', table: target, row }
          : action === 'insert-column-left' ? { type: 'insertTableColumn', table: target, col, right: false }
            : action === 'insert-column-right' ? { type: 'insertTableColumn', table: target, col, right: true }
              : { type: 'deleteTableColumn', table: target, col };
    await this.execute([command]);
  }
  private openTableStructureDialog(kind: 'insert' | 'delete'): void {
    const options: ReadonlyArray<readonly [TableStructureAction, string]> = kind === 'insert'
      ? [['insert-row-above', '위에 줄'], ['insert-row-below', '아래에 줄'], ['insert-column-left', '왼쪽에 칸'], ['insert-column-right', '오른쪽에 칸']]
      : [['delete-row', '줄'], ['delete-column', '칸']];
    new FormModal(this.app, {
      title: kind === 'insert' ? '줄/칸 추가하기' : '줄/칸 지우기',
      fields: [
        { key: 'action', label: '대상', kind: 'select', value: options[0][0], options },
        { key: 'count', label: '개수', kind: 'number', value: 1, min: 1, max: 100, integer: true },
      ],
    }, async values => {
      const action = values.action as TableStructureAction, count = Number(values.count);
      const { table, row, col } = await this.tableTarget();
      if (action === 'delete-row' && count >= table.rows || action === 'delete-column' && count >= table.cols) {
        throw new Error('표의 마지막 줄이나 칸은 삭제할 수 없습니다.');
      }
      if (action === 'delete-row' && row + count > table.rows || action === 'delete-column' && col + count > table.cols) {
        throw new Error('현재 셀부터 지울 줄이나 칸이 표 범위를 벗어납니다.');
      }
      const target = { ...table.address, control: table.control };
      const command: Command = action === 'insert-row-above' ? { type: 'insertTableRow', table: target, row, below: false }
        : action === 'insert-row-below' ? { type: 'insertTableRow', table: target, row, below: true }
          : action === 'delete-row' ? { type: 'deleteTableRow', table: target, row }
            : action === 'insert-column-left' ? { type: 'insertTableColumn', table: target, col, right: false }
              : action === 'insert-column-right' ? { type: 'insertTableColumn', table: target, col, right: true }
                : { type: 'deleteTableColumn', table: target, col };
      await this.execute(Array.from({ length: count }, () => structuredClone(command)));
    }).open();
  }
  /** Bounds of the active F5 cell block on this table, or of the current cell when no block is active. */
  private tableBlockBounds(table: Table, row: number, col: number): { startRow: number; startCol: number; endRow: number; endCol: number; isBlock: boolean } {
    if (this.cellBlockSelection?.tablePath === table.nodePath) {
      const cells = cellsInCellBlock(table, this.cellBlockSelection);
      if (cells.length) return {
        startRow: Math.min(...cells.map(cell => cell.row)), startCol: Math.min(...cells.map(cell => cell.col)),
        endRow: Math.max(...cells.map(cell => cell.row + cell.rowSpan - 1)), endCol: Math.max(...cells.map(cell => cell.col + cell.colSpan - 1)), isBlock: true,
      };
    }
    return { startRow: row, startCol: col, endRow: row, endCol: col, isBlock: false };
  }
  private openFormulaDialog(): void {
    const current = this.selectedTableCell();
    if (!current) throw new Error('본문의 표 셀 안 문단을 선택하세요.');
    const { table, cell } = current, label = cellReference(cell.row, cell.col);
    this.openFormCommandDialog({
      title: `계산식 (${label} 칸에 결과 입력)`,
      hint: '칸 주소는 A1 형식입니다(A가 첫 칸, 1이 첫 줄). 예: =SUM(A1:A3), =AVERAGE(B1:B4), =B2*C2. 표 밖 칸을 가리키거나 계산할 수 없는 식은 적용되지 않습니다.',
      fields: [
        { key: 'formula', label: '계산식', kind: 'text', value: '=', required: true, maxLength: MAX_FORMULA_LENGTH },
        { key: 'format', label: '결과 형식', kind: 'select', value: 'raw', options: [['raw', '그대로'], ['integer', '정수(반올림)'], ['decimal1', '소수 1자리'], ['decimal2', '소수 2자리']] },
        { key: 'thousandsSeparator', label: '세 자리마다 쉼표로 자리 구분', kind: 'checkbox', value: true },
      ],
      build: values => [{ type: 'setTableFormula', table: { ...table.address, control: table.control }, row: cell.row, col: cell.col, formula: String(values.formula),
        format: values.format as 'raw' | 'integer' | 'decimal1' | 'decimal2', thousandsSeparator: values.thousandsSeparator === true }],
    });
  }
  private async blockCalculation(fn: BlockFunction): Promise<void> {
    const { table, row, col } = await this.tableTarget();
    const block = this.tableBlockBounds(table, row, col);
    const plan = blockFormulaPlan(block, { rows: table.rows, cols: table.cols }, fn);
    if (!plan) throw new Error('결과를 쓸 수 있는 칸이 블록 오른쪽이나 아래에 없습니다. 블록 옆에 빈 칸을 만든 뒤 다시 시도하세요.');
    const target = table.cells.find(cell => plan.row >= cell.row && plan.row < cell.row + cell.rowSpan && plan.col >= cell.col && plan.col < cell.col + cell.colSpan);
    if (target?.paragraphs.some(paragraph => paragraph.text.trim())) throw new Error(`결과를 쓸 ${cellReference(plan.row, plan.col)} 칸이 비어 있지 않아 덮어쓰지 않았습니다. 빈 칸을 옆에 두고 다시 시도하세요.`);
    await this.execute([{ type: 'setTableFormula', table: { ...table.address, control: table.control }, row: plan.row, col: plan.col, formula: plan.formula, thousandsSeparator: true }]);
    new Notice(`${cellReference(plan.row, plan.col)} 칸에 ${plan.formula}을 적용했습니다.`);
  }
  private async equalizeSelectedTable(axis: 'width' | 'height'): Promise<void> {
    const { table, row, col } = await this.tableTarget();
    const block = this.tableBlockBounds(table, row, col);
    const wide = axis === 'width';
    const from = block.isBlock && (wide ? block.endCol > block.startCol : block.endRow > block.startRow) ? (wide ? block.startCol : block.startRow) : 0;
    const to = block.isBlock && (wide ? block.endCol > block.startCol : block.endRow > block.startRow) ? (wide ? block.endCol : block.endRow) : (wide ? table.cols : table.rows) - 1;
    const cells = equalizeTableCellSizes(table.cells, axis, from, to);
    if (!cells.length) { new Notice(`선택한 ${wide ? '칸' : '줄'}의 ${wide ? '너비' : '높이'}가 이미 같습니다.`); return; }
    await this.execute([{ type: 'resizeTableCells', table: { ...table.address, control: table.control }, cells }]);
  }
  private async transposeSelectedTable(): Promise<void> {
    const { table } = await this.tableTarget();
    await this.execute([{ type: 'transposeTable', table: { ...table.address, control: table.control } }]);
  }
  private async splitSelectedTable(): Promise<void> {
    const { table, row } = await this.tableTarget();
    await this.execute([{ type: 'splitTable', table: { ...table.address, control: table.control }, atRow: row }]);
  }
  private async mergeNextTable(): Promise<void> {
    const { table } = await this.tableTarget();
    await this.execute([{ type: 'mergeTableWithNext', table: { ...table.address, control: table.control } }]);
  }
  private async toggleTableCaption(): Promise<void> {
    const { table } = await this.tableTarget();
    const has = table.properties?.hasCaption === true;
    await this.execute([{ type: 'setTableProperties', table: { ...table.address, control: table.control }, properties: { hasCaption: !has } }]);
    new Notice(has ? '표 캡션을 뺐습니다.' : '표 캡션을 넣었습니다. 캡션 글은 현재 편집할 수 없습니다.');
  }
  private async setCaptionDirection(direction: 'Top' | 'Bottom' | 'Left' | 'Right' | 'None'): Promise<void> {
    const object = this.selectedObject;
    if (object) {
      if (object.kind !== 'picture' || object.address.kind !== 'body' || object.address.cellPath?.length) {
        throw new Error('본문 그림 또는 표를 선택하세요. 그림·표 캡션만 지원합니다.');
      }
      const target = this.objectTarget();
      await this.execute([{ type: 'setObjectProperties', object: target, properties: direction === 'None'
        ? { hasCaption: false }
        : { hasCaption: true, captionDirection: direction } }]);
      return;
    }
    const { table } = await this.tableTarget();
    await this.execute([{ type: 'setTableProperties', table: { ...table.address, control: table.control }, properties: direction === 'None'
      ? { hasCaption: false }
      : { hasCaption: true, captionDirection: direction } }]);
  }
  private async deleteSelectedTable(): Promise<void> {
    const { table } = await this.tableTarget();
    const hasText = table.cells.some(cell => cell.paragraphs.some(paragraph => paragraph.text.length > 0));
    if (hasText) {
      const context = this.captureContext(), revision = this.state?.revision;
      const confirmed = await new Promise<boolean>(resolve => new ConfirmActionModal(this.app, {
        title: '표를 지울까요?', message: `${table.rows}줄 × ${table.cols}칸 표와 그 안의 내용이 삭제됩니다. 되돌리기로 복구할 수 있습니다.`, confirmLabel: '표 지우기',
      }, resolve).open());
      if (!confirmed) return;
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('확인하는 동안 문서가 바뀌어 표 지우기를 취소했습니다. 다시 시도하세요.');
    }
    await this.execute([{ type: 'deleteTable', table: { ...table.address, control: table.control } }]);
  }
  private async mergeSelectedCells(): Promise<void> {
    const { table, row, col } = await this.tableTarget();
    let startRow = row, startCol = col, endRow = Number(this.mergeEndRowInput.value) - 1, endCol = Number(this.mergeEndColInput.value) - 1;
    if (this.cellBlockSelection?.tablePath === table.nodePath) {
      const cells = cellsInCellBlock(table, this.cellBlockSelection);
      if (cells.length) {
        startRow = Math.min(...cells.map(cell => cell.row)); startCol = Math.min(...cells.map(cell => cell.col));
        endRow = Math.max(...cells.map(cell => cell.row + cell.rowSpan - 1)); endCol = Math.max(...cells.map(cell => cell.col + cell.colSpan - 1));
      }
    }
    await this.execute([{ type: 'mergeTableCells', table: { ...table.address, control: table.control }, startRow, startCol, endRow, endCol }]);
  }
  private async splitSelectedCell(): Promise<void> {
    const { table, row, col } = await this.tableTarget();
    const cell = table.cells.find(item => row >= item.row && row < item.row + item.rowSpan && col >= item.col && col < item.col + item.colSpan);
    if (!cell) throw new Error('선택한 셀을 표 구조에서 찾지 못했습니다. 다시 선택하세요.');
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const rows = cell.rowSpan > 1 ? cell.rowSpan : 2, columns = cell.colSpan > 1 ? cell.colSpan : 2;
    new SplitCellModal(this.app, rows, columns, async (rowCount, columnCount, equalRowHeight) => {
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 최신 셀을 다시 선택하세요.');
      await this.execute([{ type: 'splitTableCell', table: { ...table.address, control: table.control }, row, col,
        rows: rowCount, cols: columnCount, equalRowHeight }]);
    }).open();
  }
  private async formatCellNumbers(operation: CellNumberOperation): Promise<void> {
    if (this.draft) await this.applyDraft(true);
    const { table, row, col } = await this.tableTarget();
    const cells = this.cellBlockSelection?.tablePath === table.nodePath ? cellsInCellBlock(table, this.cellBlockSelection)
      : table.cells.filter(cell => cell.row === row && cell.col === col);
    const tree = this.documentTree;
    const anchors = tree ? [...tree.controls.filter(control => control.ctrlId !== 'secd' && control.ctrlId !== 'cold'), ...tree.fields, ...tree.objects] : [];
    const protectedCells = new Set(cells.filter(cell => cell.paragraphs.some(paragraph => anchors.some(anchor => anchor.address && sameDocumentAddress(anchor.address, paragraph.address)))).map(cell => cell.index));
    const { commands, skipped } = cellNumberFormatCommands(table, cells, operation, protectedCells);
    if (commands.length) await this.execute(commands);
    this.navigationStatus.setText(`숫자 변환: ${commands.length}개 셀 변경${skipped ? `, ${skipped}개 셀 건너뜀` : ''}`);
  }
  private async openCellFormatDialog(borderMode: 'each' | 'outside' = 'each'): Promise<void> {
    if (this.draft || this.composing) throw new Error('미적용 입력을 처리하고 한글 조합을 마친 뒤 표 속성을 여세요.');
    const { table, row, col } = await this.tableTarget();
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const block = this.cellBlockSelection?.tablePath === table.nodePath ? completeCellBlockRange(table, this.cellBlockSelection) : undefined;
    const cells = (block ? cellsInCellBlock(table, block) : table.cells.filter(cell => cell.row === row && cell.col === col))
      .map(cell => ({ row: cell.row, col: cell.col, rowSpan: cell.rowSpan, colSpan: cell.colSpan }));
    if (!cells.length) throw new Error('서식을 적용할 표 셀을 찾지 못했습니다.');
    if (cells.length > 500) throw new Error('한 번에 서식을 적용할 셀은 500개 이하여야 합니다. F5 범위를 줄이세요.');
    const selectedCell = table.cells.find(cell => cell.row === row && cell.col === col) ?? table.cells[0];
    const cellProperties = selectedCell?.properties;
    const colorOr = (value: string | undefined, fallback: string): string => value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    const sourcePatternType = cellProperties?.patternType, sourceBorderType = cellProperties?.borderTop?.type;
    const patternType = typeof sourcePatternType === 'number' && Number.isSafeInteger(sourcePatternType) && sourcePatternType >= 0 && sourcePatternType <= 64 ? sourcePatternType : 0;
    const borderType = typeof sourceBorderType === 'number' && Number.isSafeInteger(sourceBorderType) && sourceBorderType >= 0 && sourceBorderType <= 32 ? sourceBorderType : 1;
    const initial: TableCellFormatValues = {
      cellSpacing: table.properties?.cellSpacing ?? 0, repeatHeader: table.properties?.repeatHeader ?? false,
      fillMode: 'keep', fillColor: colorOr(cellProperties?.fillColor, '#ffffff'),
      patternColor: colorOr(cellProperties?.patternColor, '#000000'), patternType,
      isHeader: cellProperties?.isHeader ?? false,
      verticalAlign: cellProperties?.verticalAlign ?? 0, padding: cellProperties?.paddingLeft ?? 0,
      borderMode, borderType,
      borderColor: colorOr(cellProperties?.borderTop?.color, '#000000'),
    };
    new TableCellFormatModal(this.app, initial, async value => {
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('표 또는 문서가 바뀌었습니다. 최신 셀을 다시 선택한 뒤 속성을 적용하세요.');
      const tableAddress = { ...table.address, control: table.control };
      await this.execute(tableCellFormatCommands(tableAddress, cells, block, value, initial));
    }).open();
  }
  private rootBodyParagraph(): TextParagraph {
    if (!this.selected || !isParagraph(this.selected) || this.selected.address.kind !== 'body' || this.selected.address.cellPath?.length || this.selected.address.containerKinds?.includes('textBox')) {
      throw new Error('그림·수식·도형은 본문 문단을 선택해야 삽입할 수 있습니다.');
    }
    return this.selected;
  }
  private insertionOffset(paragraph: TextParagraph): number {
    if (this.pageSelection && sameDocumentAddress(this.pageSelection.address, paragraph.address)) return Math.min(this.pageSelection.start, this.pageSelection.end);
    return Array.from(paragraph.text).length;
  }
  private async insertNote(kind: 'footnote' | 'endnote'): Promise<void> {
    if (this.draft) throw new Error('미적용 입력을 먼저 적용하거나 취소하세요.');
    const paragraph = this.rootBodyParagraph(), target = paragraph.address, offset = this.insertionOffset(paragraph);
    const context = this.captureContext(), initialRevision = this.state?.revision;
    if (initialRevision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const unlock = this.lockInput();
    let result: Awaited<ReturnType<typeof this.plugin.api.edit.transaction>> | undefined;
    try {
      this.assertContext(context);
      result = await this.plugin.manager.transactionFromView(context.path, [{ type: 'insertNote', kind, target, offset }], { expectedRevision: initialRevision, origin: 'command' });
      this.assertContext(context);
      await this.refresh();
    } finally { unlock(); }
    const tree = this.documentTree;
    if (!tree) throw new Error('노트를 삽입했지만 문서 구조를 다시 읽지 못했습니다.');
    const notes = tree.stories.filter((story): story is Extract<DocumentTree['stories'][number], { kind: 'footnote' | 'endnote' }> =>
      story.kind === kind && (story.kind === 'footnote' || story.kind === 'endnote') && sameDocumentAddress(story.anchor, target));
    const insertResult = result?.results[0];
    const resultControlIndex = insertResult && typeof insertResult === 'object' && !Array.isArray(insertResult)
      ? (typeof insertResult.controlIdx === 'number' ? insertResult.controlIdx : typeof insertResult.controlIndex === 'number' ? insertResult.controlIndex : undefined)
      : undefined;
    const story = (resultControlIndex === undefined ? undefined : notes.find(item => item.controlIndex === resultControlIndex)) ?? notes.at(-1);
    const first = story?.availability === 'available' ? story.paragraphs[0] : undefined;
    if (!first) { new Notice(`${kind === 'footnote' ? '각주' : '미주'}를 삽입했습니다. 본문 밖 영역 목록에서 노트를 선택해 편집하세요.`); return; }
    const current = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (current.revision !== this.state?.revision) throw new Error('노트를 삽입한 뒤 문서가 변경되어 편집 위치를 열지 않았습니다.');
    const caret = await this.plugin.api.query.caret(context.path, { address: first.address, offset: 0 }, { sessionId: current.sessionId, expectedRevision: current.revision });
    this.assertContext(context);
    const latest = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (latest.revision !== current.revision) throw new Error('노트 위치를 여는 중 문서가 변경되어 다시 시도해야 합니다.');
    this.mode = 'stories'; this.modeSelector.value = this.mode; this.items = this.itemsForMode(tree); this.renderItemPage();
    const index = this.items.findIndex(item => isParagraph(item) && item.nodePath === first.nodePath);
    if (index < 0) throw new Error('삽입한 노트가 본문 밖 영역 편집 목록에 없습니다.');
    this.state = latest; this.page = Math.min(caret.rect.pageIndex, latest.pageCount - 1); await this.renderPage(true);
    this.selectItem(index, true); this.textarea.setSelectionRange(0, 0); this.textarea.focus({ preventScroll: true });
    this.infoEl.setText(`${kind === 'footnote' ? '각주' : '미주'} 편집 · 본문 밖 영역`);
  }
  /** The section shown by the page selector, falling back to the visible page's or the selected paragraph's section. */
  private activeSectionIndex(): number {
    const selectedSection = this.selected && isParagraph(this.selected) ? this.selected.address.section : undefined;
    const visibleSection = this.pageLayout?.info.sectionIndex ?? selectedSection ?? 0;
    const requestedSection = Number(this.pageSectionSelect?.value);
    return this.formattingModel?.sections.some(section => section.section === requestedSection) ? requestedSection : visibleSection;
  }
  private openFormCommandDialog(options: { title: string; hint?: string; fields: FormField[]; submitLabel?: string; validate?: (values: FormValues) => string | undefined; after?: () => void; build: (values: FormValues, initial: FormValues) => Command[] }): void {
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    const initial = initialFormValues(options.fields);
    new FormModal(this.app, options, async values => {
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 시도하세요.');
      const commands = options.build(values, initial);
      if (!commands.length) { new Notice('변경한 내용이 없습니다.'); return; }
      await this.execute(commands);
      options.after?.();
    }).open();
  }
  private currentSectionSettings(): { section: number; settings: NonNullable<HwpView['formattingModel']>['sections'][number] } {
    const section = this.activeSectionIndex(), settings = this.formattingModel?.sections.find(item => item.section === section);
    if (!settings) throw new Error('구역 설정을 읽지 못했습니다.');
    return { section, settings };
  }
  private openColumnsDialog(): void {
    const { section, settings } = this.currentSectionSettings();
    this.openFormCommandDialog({ title: `다단 설정 (구역 ${section + 1})`, fields: columnFields(settings.columns), build: (values, initial) => [columnCommand(section, values, initial)].filter((command): command is Command => !!command) });
  }
  private openPageBorderDialog(): void {
    const { section, settings } = this.currentSectionSettings();
    this.openFormCommandDialog({ title: `쪽 테두리 / 배경 (구역 ${section + 1})`, hint: '선택한 선 모양은 네 변에 같게 적용됩니다. "첫 쪽 제외" 같은 쪽 범위 지정은 RHWP 코어가 저장하지 않아 지원하지 않습니다.', fields: pageBorderFields(settings.pageBorderFill),
      build: (values, initial) => [pageBorderCommand(section, values, initial)].filter((command): command is Command => !!command) });
  }
  private openSectionSettingsDialog(): void {
    const { section, settings } = this.currentSectionSettings(), count = this.formattingModel?.sections.length ?? 1;
    this.openFormCommandDialog({ title: `구역 설정 (구역 ${section + 1})`, hint: '"모든 구역"을 고르면 바꾼 항목만 모든 구역에 적용합니다.', fields: sectionFields(settings.sectionDef), build: (values, initial) => sectionCommands(section, count, values, initial) });
  }
  private openPageHideDialog(): void {
    const paragraph = this.rootBodyParagraph(), { settings } = this.currentSectionSettings();
    const entry = settings.pageHides.find(item => item.paragraph === paragraph.address.paragraph);
    this.openFormCommandDialog({ title: '현재 쪽 감추기', hint: '선택한 문단이 있는 쪽에만 적용합니다. 모두 끄면 감추기를 해제합니다.', fields: pageHideFields(entry), build: values => [pageHideCommand(paragraph.address, values)] });
  }
  private openNewNumberDialog(): void {
    const paragraph = this.rootBodyParagraph(), offset = this.insertionOffset(paragraph);
    this.openFormCommandDialog({ title: '새 번호로 시작', hint: '캐럿 위치부터 쪽 번호를 지정한 번호로 다시 시작합니다.', fields: newNumberFields(), build: values => [newNumberCommand(paragraph.address, offset, values)] });
  }
  private openStyleEditor(mode: 'create' | 'edit'): void {
    const styles = this.formattingModel?.styles ?? [];
    if (!styles.length) throw new Error('스타일 정보를 아직 읽지 못했습니다.');
    const open = (style?: (typeof styles)[number]): void => {
      const fields = styleFields(mode, style, styles);
      this.openFormCommandDialog({
        title: mode === 'create' ? '스타일 추가' : `스타일 편집 (${style!.name})`,
        hint: mode === 'create' ? '기본 스타일의 모양에서 시작합니다. 바꾼 항목만 새 스타일에 적용됩니다.' : '바꾼 항목만 스타일에 적용되며, 이 스타일을 쓰는 문단에 바로 반영됩니다.',
        fields, submitLabel: mode === 'create' ? '추가' : '적용',
        build: (values, initial) => [styleCommand(mode, style?.id, values, initial, style)].filter((command): command is Command => !!command),
      });
    };
    if (mode === 'create') { open(); return; }
    new StylePickerModal(this.app, styles, '편집할 스타일 이름', chosen => { try { open(chosen); } catch (error) { new Notice(String(error instanceof Error ? error.message : error), 8000); } }).open();
  }
  private deleteStyleInteractive(): void {
    const styles = (this.formattingModel?.styles ?? []).filter(style => style.id !== 0);
    if (!styles.length) throw new Error('지울 수 있는 스타일이 없습니다. 기본 스타일(바탕글)은 지울 수 없습니다.');
    new StylePickerModal(this.app, styles, '지울 스타일 이름', chosen => {
      const context = this.captureContext(), revision = this.state?.revision;
      void (async () => {
        const confirmed = await new Promise<boolean>(resolve => new ConfirmActionModal(this.app, {
          title: `"${chosen.name}" 스타일을 지울까요?`, message: '이 스타일을 쓰는 문단은 기본 스타일(바탕글)로 바뀝니다. 되돌리기로 복구할 수 있습니다.', confirmLabel: '스타일 지우기',
        }, resolve).open());
        if (!confirmed) return;
        this.assertContext(context);
        if (this.state?.revision !== revision) throw new Error('확인하는 동안 문서가 바뀌어 스타일 지우기를 취소했습니다. 다시 시도하세요.');
        await this.execute([{ type: 'deleteStyle', styleId: chosen.id }]);
      })().catch(error => new Notice(String(error instanceof Error ? error.message : error), 8000));
    }).open();
  }
  private openNumberingDialog(): void {
    this.rootBodyParagraph();
    const context = this.captureContext(), revision = this.state?.revision;
    new FormModal(this.app, {
      title: '문단 번호 모양', hint: '고른 모양으로 번호 정의를 만들고 현재 문단에 적용합니다. 정의와 적용은 각각 되돌릴 수 있습니다.', submitLabel: '만들고 적용',
      fields: [
        { key: 'preset', label: '번호 모양', kind: 'select', value: NUMBERING_PRESETS[0].id, options: NUMBERING_PRESETS.map(item => [item.id, item.label] as const) },
        { key: 'startNumber', label: '시작 번호', kind: 'number', value: 1, min: 1, max: 65535, integer: true },
      ],
    }, async values => {
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 시도하세요.');
      await this.execute([numberingCommand(String(values.preset), values.startNumber as number)]);
      const ids = (this.formattingModel?.numbering ?? []).map(item => item.id);
      if (!ids.length) throw new Error('만든 번호 정의를 읽지 못했습니다.');
      const paragraph = this.rootBodyParagraph();
      await this.execute([{ type: 'setParagraphList', target: paragraph.address, list: { kind: 'numbering', numberingId: Math.max(...ids), level: 0 } }]);
    }).open();
  }
  private openEndnoteShapeModal(): void {
    const sectionIndex = this.activeSectionIndex();
    const settings = this.formattingModel?.sections.find(section => section.section === sectionIndex)?.endnoteShape;
    if (!settings) { new Notice('미주 모양 설정을 읽지 못했습니다.'); return; }
    new EndnoteShapeModal(this.app, settings, (properties: EndnoteShapeProperties) => this.execute([{ type: 'setEndnoteShape', section: sectionIndex, properties }])).open();
  }
  private async insertEquation(): Promise<void> {
    const paragraph = this.rootBodyParagraph(), script = this.equationScriptInput.value.trim();
    if (!script) throw new Error('삽입할 수식 스크립트를 입력하세요.');
    await this.execute([{ type: 'insertEquation', target: paragraph.address, offset: this.insertionOffset(paragraph), script }]);
    this.equationScriptInput.value = '';
    this.clearEquationPreview();
  }
  private openEquationInsertDialog(): void {
    const paragraph = this.rootBodyParagraph(), context = this.captureContext(), revision = this.state?.revision;
    const offset = this.insertionOffset(paragraph);
    new FormModal(this.app, {
      title: '수식 넣기', fields: [equationScriptField()], submitLabel: '삽입',
      validate: values => equationScriptError(String(values.script ?? '')),
      preview: this.equationDialogPreview(),
    }, async values => {
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 다시 수식을 넣으세요.');
      await this.execute([{ type: 'insertEquation', target: paragraph.address, offset, script: String(values.script).trim() }]);
    }).open();
  }
  private equationDialogPreview(properties: Record<string, unknown> = {}): (values: FormValues) => Promise<string | undefined> {
    const context = this.captureContext(), state = this.state;
    return async values => {
      const script = String(values.script ?? '').trim();
      if (!script) return undefined;
      const error = equationScriptError(script);
      if (error) throw new Error(error);
      this.assertContext(context);
      if (!context || !state || this.state?.revision !== state.revision) throw new Error('문서가 바뀌었습니다. 수식 대화상자를 다시 여세요.');
      const svg = await this.plugin.api.query.equationPreview(context.path, script, { sessionId: state.sessionId, expectedRevision: state.revision }, {
        ...(typeof properties.fontSize === 'number' ? { fontSize: properties.fontSize } : {}),
        ...(typeof properties.color === 'string' ? { color: properties.color } : {}),
      });
      this.assertContext(context);
      if (this.state?.revision !== state.revision) throw new Error('문서가 바뀌었습니다. 수식 대화상자를 다시 여세요.');
      return svg;
    };
  }
  private async applySelectedEquation(): Promise<void> {
    const object = this.objectTarget(), script = this.equationScriptInput.value.trim();
    if (object.kind !== 'equation') throw new Error('수식 개체를 선택한 뒤 스크립트를 적용하세요.');
    if (!script) throw new Error('적용할 수식 스크립트를 입력하세요.');
    if (script.length > 4096) throw new Error('수식 스크립트는 4096자 이하여야 합니다.');
    await this.execute([{ type: 'setObjectProperties', object, properties: { script } }]);
  }
  private scheduleEquationPreview(): void {
    if (this.equationPreviewTimer) clearTimeout(this.equationPreviewTimer);
    const sequence = ++this.equationPreviewSequence;
    this.equationPreviewTimer = setTimeout(() => {
      this.equationPreviewTimer = undefined;
      void this.renderEquationPreview(sequence);
    }, 220);
  }
  private clearEquationPreview(): void {
    if (this.equationPreviewTimer) clearTimeout(this.equationPreviewTimer);
    this.equationPreviewTimer = undefined;
    this.equationPreviewSequence++;
    this.pageImages?.release(-1);
    this.equationPreviewEl?.replaceChildren();
    if (this.equationPreviewEl) this.equationPreviewEl.hidden = true;
  }
  private async renderEquationPreview(sequence: number): Promise<void> {
    const script = this.equationScriptInput.value.trim(), state = this.state;
    this.pageImages?.release(-1);
    this.equationPreviewEl.replaceChildren();
    if (!script || !state) { this.equationPreviewEl.hidden = true; return; }
    if (script.length > 4096) {
      this.equationPreviewEl.hidden = false;
      this.equationPreviewEl.setText('수식 스크립트 미리보기는 4096자까지 지원합니다.');
      return;
    }
    this.equationPreviewEl.hidden = false;
    this.equationPreviewEl.setText('수식 미리보기를 만드는 중…');
    const context = this.captureContext();
    if (!context) return;
    const equationProperties = this.selectedObject?.kind === 'equation' && this.selectedObject.properties && typeof this.selectedObject.properties === 'object'
      ? this.selectedObject.properties as Record<string, unknown> : undefined;
    const previewOptions = {
      ...(typeof equationProperties?.fontSize === 'number' ? { fontSize: equationProperties.fontSize } : {}),
      ...(typeof equationProperties?.color === 'string' ? { color: equationProperties.color } : {}),
    };
    try {
      const svg = await this.plugin.api.query.equationPreview(context.path, script, { sessionId: state.sessionId, expectedRevision: state.revision }, previewOptions);
      this.assertContext(context);
      if (sequence !== this.equationPreviewSequence || script !== this.equationScriptInput.value.trim() || this.state?.revision !== state.revision) return;
      const mounted = this.pageImages?.mount(-1, this.equationPreviewEl, svg, '수식 미리보기', 'hwp-equation-preview-image') ?? false;
      if (!mounted) this.equationPreviewEl.setAttribute('aria-label', '수식 미리보기');
    } catch (error) {
      if (sequence !== this.equationPreviewSequence) return;
      this.equationPreviewEl.setText(`수식 미리보기를 만들 수 없습니다. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private toggleShapeDrawMode(): void {
    if (this.shapeDrawMode) {
      this.shapeDrawMode = false;
      if (this.shapeDrawButton) { this.shapeDrawButton.textContent = '도형 그리기'; this.shapeDrawButton.setAttribute('aria-pressed', 'false'); }
      this.navigationStatus.setText('도형 그리기를 취소했습니다.');
      return;
    }
    if (this.draft || this.composing || this.formMode || this.capabilityCheckPending || this.capabilitiesReadOnly()) {
      throw new Error('현재 문서 상태에서는 도형을 그릴 수 없습니다.');
    }
    this.shapeDrawMode = true;
    if (this.shapeDrawButton) { this.shapeDrawButton.textContent = '그리기 취소'; this.shapeDrawButton.setAttribute('aria-pressed', 'true'); }
    this.navigationStatus.setText('본문 쪽에서 끌어 도형 크기를 정하세요. 표 셀과 글상자 안에서는 그릴 수 없습니다.');
  }
  private openGoToDialog(): void {
    if (!this.state) throw new Error('문서가 아직 준비되지 않았습니다.');
    const sectionCount = this.sectionGotoSelect.options.length;
    new FormModal(this.app, {
      title: '찾아가기', hint: '쪽, 구역 또는 책갈피 위치로 이동합니다.', submitLabel: '이동',
      fields: [
        { key: 'kind', label: '이동 대상', kind: 'select', value: 'page', options: [['page', '쪽'], ['section', '구역'], ['bookmark', '책갈피']] },
        { key: 'number', label: '번호', kind: 'number', value: this.page + 1, min: 1, integer: true,
          enabledWhen: values => values.kind !== 'bookmark' },
      ],
      validate: values => values.kind === 'page' && Number(values.number) > (this.state?.pageCount ?? 0) ? `쪽 번호는 1부터 ${this.state?.pageCount ?? 0} 사이여야 합니다.`
        : values.kind === 'section' && Number(values.number) > sectionCount ? `구역 번호는 1부터 ${sectionCount} 사이여야 합니다.` : undefined,
    }, async values => {
      if (values.kind === 'bookmark') { setTimeout(() => { void this.pickBookmark(); }, 0); return; }
      if (values.kind === 'section') { this.sectionGotoSelect.value = String(Number(values.number) - 1); await this.goToSection(); }
      else { this.pageInput.value = String(values.number); await this.goToPage(); }
    }).open();
  }
  private startShapeDrawMode(shape: 'rectangle' | 'textBox'): void {
    if (this.shapeDrawMode) this.finishShapeDrawMode();
    this.shapeTypeSelect.value = shape;
    this.toggleShapeDrawMode();
  }
  private finishShapeDrawMode(message?: string): void {
    this.shapeDrawMode = false;
    this.shapeDrawStart = undefined;
    if (this.shapeDrawButton) { this.shapeDrawButton.textContent = '도형 그리기'; this.shapeDrawButton.setAttribute('aria-pressed', 'false'); }
    this.pageStack?.mountedPages().forEach(item => item.element.querySelector('.hwp-shape-draw-preview')?.remove());
    if (message) this.navigationStatus.setText(message);
  }
  private async insertShapeAt(target: Extract<DocumentAddress, { kind: 'body' }>, offset: number, width: number, height: number,
    shape: 'rectangle' | 'textBox', value: string): Promise<void> {
    for (const [name, size] of [['너비', width], ['높이', height]] as const) {
      if (!Number.isSafeInteger(size) || size < 1 || size > 1_000_000) throw new Error(`도형 ${name}는 0.01~10000mm 범위여야 합니다.`);
    }
    await this.execute([{ type: 'insertShape', target, offset, shape, width, height, treatAsChar: true, textWrap: 'Square',
      description: value.slice(0, 256), ...(shape === 'textBox' && value ? { text: value } : {}) }]);
    this.shapeTextInput.value = '';
  }
  private async insertShape(): Promise<void> {
    const paragraph = this.rootBodyParagraph(), shape = this.shapeTypeSelect.value as 'rectangle' | 'textBox', value = this.shapeTextInput.value.trim();
    const target = paragraph.address;
    if (target.kind !== 'body') throw new Error('도형을 넣을 본문 문단을 찾지 못했습니다.');
    const width = Number(this.shapeWidthInput.value), height = Number(this.shapeHeightInput.value);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 10000 || height > 10000) throw new Error('도형 너비와 높이는 0.01~10000mm 범위로 입력하세요.');
    await this.insertShapeAt(target, this.insertionOffset(paragraph), Math.round(width * 100), Math.round(height * 100), shape, value);
  }
  private async insertPicture(file: File): Promise<void> {
    const paragraph = this.rootBodyParagraph(), extension = file.name.split('.').at(-1)?.toLowerCase();
    if (!extension || !['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(extension)) throw new Error('PNG, JPG, GIF, BMP 그림만 삽입할 수 있습니다.');
    if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('그림 파일은 1바이트~10MiB 범위여야 합니다.');
    const bitmap = await createImageBitmap(file);
    const naturalWidthPx = bitmap.width, naturalHeightPx = bitmap.height; bitmap.close();
    if (!naturalWidthPx || !naturalHeightPx || naturalWidthPx > 100_000 || naturalHeightPx > 100_000) throw new Error('그림의 가로·세로 픽셀은 각각 100000 이하여야 합니다.');
    const naturalWidthUnits = naturalWidthPx * 26.4583, naturalHeightUnits = naturalHeightPx * 26.4583;
    const scale = Math.min(1, 15000 / naturalWidthUnits, 1_000_000 / Math.max(naturalWidthUnits, naturalHeightUnits));
    const width = Math.max(1, Math.round(naturalWidthUnits * scale)), height = Math.max(1, Math.round(naturalHeightUnits * scale));
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    await this.execute([{ type: 'insertPicture', target: paragraph.address, offset: this.insertionOffset(paragraph), imageBase64: btoa(binary), extension: extension as 'png' | 'jpg' | 'jpeg' | 'gif' | 'bmp', width, height, naturalWidthPx, naturalHeightPx, description: file.name.slice(0, 256) }]);
  }
  private objectTarget(): Extract<Command, { type: 'setObjectProperties' }>['object'] {
    const object = this.selectedObject;
    if (!object || object.address.kind !== 'body' || object.address.cellPath?.length || !['picture', 'shape', 'equation'].includes(object.kind)) throw new Error('본문의 그림·수식·도형을 선택하세요. 중첩 셀 개체 편집은 지원하지 않습니다.');
    return { address: object.address, controlIndex: object.controlIndex, kind: object.kind as 'picture' | 'shape' | 'equation' };
  }
  private async applyObjectProperties(): Promise<void> {
    const object = this.objectTarget(), properties: Record<string, unknown> = {};
    for (const [key, input] of [['width', this.objectWidthInput], ['height', this.objectHeightInput]] as const) {
      if (!input.value.trim()) continue;
      const value = Number(input.value);
      if (!Number.isFinite(value) || value <= 0 || value > 10000) throw new Error('개체 너비와 높이는 0.01~10000mm 범위로 입력하세요.');
      properties[key] = Math.round(value * 100);
    }
    if (object.kind !== 'equation') {
      for (const [key, input] of [['horzOffset', this.objectOffsetXInput], ['vertOffset', this.objectOffsetYInput]] as const) {
        if (!input.value.trim()) continue;
        const value = Number(input.value);
        if (!Number.isFinite(value) || Math.abs(value) > 10000) throw new Error('개체 위치는 -10000~10000mm 범위로 입력하세요.');
        properties[key] = Math.round(value * 100);
      }
      properties.treatAsChar = this.objectTreatAsCharInput.checked;
      properties.textWrap = this.objectTextWrapSelect.value;
    }
    const description = this.objectDescriptionInput.value;
    properties.description = description;
    await this.execute([{ type: 'setObjectProperties', object, properties: properties as Extract<Command, { type: 'setObjectProperties' }>['properties'] }]);
  }
  private openObjectPropertiesDialog(): void {
    const object = this.objectTarget(), properties = this.selectedObjectProperties();
    const context = this.captureContext(), revision = this.state?.revision;
    const fields = objectFields(object.kind, properties), initial = initialFormValues(fields);
    new FormModal(this.app, {
      title: object.kind === 'equation' ? '수식 고치기' : '개체 속성', submitLabel: '적용', fields,
      ...(object.kind === 'equation' ? { validate: (values: FormValues) => equationScriptError(String(values.script ?? '')), preview: this.equationDialogPreview(properties) } : {}),
    }, async values => {
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 개체를 다시 선택하세요.');
      const command = objectCommand(object, values, initial);
      if (command) await this.execute([command]);
    }).open();
  }
  private selectedObjectProperties(): Record<string, unknown> {
    const properties = this.selectedObject?.properties;
    return properties && typeof properties === 'object' ? properties as Record<string, unknown> : {};
  }
  private openObjectRotationDialog(): void {
    const object = this.objectTarget();
    const current = Number(this.selectedObjectProperties().rotationAngle);
    this.openFormCommandDialog({
      title: '개체 회전',
      hint: '한컴 한글과 같은 저장 값(도)으로 회전합니다. 0은 회전 없음입니다.',
      fields: [{ key: 'angle', label: '회전 각도', kind: 'number', value: Number.isFinite(current) ? current % 360 : 0, min: 0, max: 359, integer: true, unit: '도' }],
      build: (values, initial) => values.angle === initial.angle ? [] : [{ type: 'setObjectProperties', object, properties: { rotationAngle: values.angle as number } }],
    });
  }
  private async rotateSelectedObject(degrees: -90 | 90): Promise<void> {
    const object = this.objectTarget();
    const current = Number(this.selectedObjectProperties().rotationAngle);
    const angle = ((Number.isFinite(current) ? current : 0) + degrees + 360) % 360;
    await this.execute([{ type: 'setObjectProperties', object, properties: { rotationAngle: angle } }]);
  }
  private async flipSelectedObject(key: 'horzFlip' | 'vertFlip'): Promise<void> {
    const object = this.objectTarget();
    const current = this.selectedObjectProperties()[key] === true;
    await this.execute([{ type: 'setObjectProperties', object, properties: { [key]: !current } }]);
  }
  private async toggleSelectedPictureCaption(): Promise<void> {
    const object = this.objectTarget();
    if (object.kind !== 'picture') throw new Error('캡션은 그림에서만 지원합니다.');
    const current = this.selectedObjectProperties().hasCaption === true;
    await this.execute([{ type: 'setObjectProperties', object, properties: { hasCaption: !current } }]);
  }
  private async reorderSelectedObject(operation: 'front' | 'back' | 'forward' | 'backward' | 'inFrontOfText' | 'behindText'): Promise<void> {
    const object = this.objectTarget();
    if (object.kind === 'equation') throw new Error('수식은 순서를 바꿀 수 없습니다.');
    await this.execute([{ type: 'setObjectZOrder', object, operation }]);
  }
  private openObjectGroupDialog(): void {
    const tree = this.documentTree;
    if (!tree) throw new Error('문서 구조를 아직 읽지 못했습니다.');
    const candidates = tree.objects.filter(object => object.address.kind === 'body' && !object.address.cellPath?.length && (object.kind === 'picture' || object.kind === 'shape')).slice(0, 60);
    if (candidates.length < 2) throw new Error('묶을 수 있는 본문 그림·도형이 둘 이상 필요합니다.');
    const selectedPath = this.selectedObject?.nodePath;
    const label = (object: DocumentObject): string => {
      const properties = object.properties && typeof object.properties === 'object' ? object.properties as Record<string, unknown> : {};
      const size = typeof properties.width === 'number' && typeof properties.height === 'number' ? ` · ${Math.round(hwpUnitsToMillimeters(properties.width))}×${Math.round(hwpUnitsToMillimeters(properties.height))}mm` : '';
      const description = typeof properties.description === 'string' && properties.description ? ` · ${properties.description.slice(0, 20)}` : '';
      return `${objectKindLabel(object)} · 문단 ${object.address.paragraph + 1}${size}${description}`;
    };
    const fields: FormField[] = candidates.map((object, index) => ({ key: `o${index}`, label: label(object), kind: 'checkbox', value: object.nodePath === selectedPath }));
    this.openFormCommandDialog({
      title: '개체 묶기', hint: '묶을 그림·도형을 둘 이상 고르세요. 묶으면 개체 번호가 바뀌므로 선택이 해제됩니다.', submitLabel: '묶기', fields,
      validate: values => candidates.filter((_, index) => values[`o${index}`] === true).length < 2 ? '묶을 개체를 둘 이상 고르세요.' : undefined,
      build: values => [{ type: 'groupObjects', objects: candidates.filter((_, index) => values[`o${index}`] === true).map(object => ({ address: object.address, controlIndex: object.controlIndex, kind: object.kind as 'picture' | 'shape' })) }],
      after: () => { this.selectedObject = undefined; },
    });
  }
  private async ungroupSelectedObject(): Promise<void> {
    const object = this.objectTarget();
    await this.execute([{ type: 'ungroupObject', object }]);
    this.selectedObject = undefined;
  }
  private async deleteSelectedObject(): Promise<void> {
    const object = this.objectTarget();
    await this.execute([{ type: 'deleteObject', object }]);
    this.selectedObject = undefined;
  }
  private openPageSetupDialog(): void {
    const section = Number(this.pageSectionSelect.value), current = this.formattingModel?.sections.find(item => item.section === Number(this.pageSectionSelect.value));
    const context = this.captureContext(), revision = this.state?.revision;
    if (!Number.isSafeInteger(section) || section < 0 || !current || revision === undefined) throw new Error('편집할 구역의 용지 정보를 읽지 못했습니다.');
    new PageSetupModal(this.app, current.pageDef, async properties => {
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 최신 상태를 확인한 뒤 용지 설정을 적용하세요.');
      await this.execute([{ type: 'setPageSettings', section, properties }]);
    }).open();
  }
  private findHeaderFooter(isHeader: boolean): HeaderFooterStory | undefined {
    const section = this.pageLayout?.info.sectionIndex ?? Number(this.pageSectionSelect.value);
    return this.documentTree?.stories.find((story): story is HeaderFooterStory => story.kind === 'headerFooter'
      && story.section === section && story.isHeader === isHeader && !!story.paragraphs[0] && !!this.pageLayout && headerFooterPageApplies(story.paragraphs[0].address as HeaderFooterAddress, this.pageLayout.info));
  }
  private async editHeaderFooter(isHeader: boolean): Promise<void> {
    if (this.draft) await this.applyDraft(true);
    if (this.selected && isParagraph(this.selected) && this.selected.address.kind === 'body') {
      this.storyReturnPosition = { address: this.selected.address, offset: positionAfterEditorText(this.selected.address, this.textarea.value, this.textarea.selectionEnd).offset };
    }
    const paragraph = this.findHeaderFooter(isHeader)?.paragraphs[0];
    if (!paragraph) throw new Error('현재 쪽에 해당 머리말·꼬리말이 없습니다.');
    this.mode = 'stories'; this.modeSelector.value = this.mode;
    this.items = this.itemsForMode(this.documentTree!);
    const index = this.items.findIndex(item => isParagraph(item) && sameDocumentAddress(item.address, paragraph.address));
    if (index < 0) throw new Error('머리말·꼬리말 문단을 찾지 못했습니다.');
    this.selectItem(index, true); this.textarea.focus({ preventScroll: true });
  }
  private async applyHeaderFooterTemplate(isHeader: boolean, applyTo: 0 | 1 | 2, templateId: number): Promise<void> {
    const section = this.pageLayout?.info.sectionIndex ?? Number(this.pageSectionSelect.value);
    if (!this.formattingModel?.sections.some(item => item.section === section)) throw new Error('현재 구역을 확인하지 못했습니다.');
    await this.execute([{ type: 'applyHeaderFooterTemplate', section, isHeader, applyTo, templateId }]);

  }
  private openHeaderFooterTemplateModal(initialIsHeader?: boolean): void {
    const tree = this.documentTree, revision = this.state?.revision;
    const selectedAddress = this.selected && isParagraph(this.selected) ? this.selected.address : undefined;
    const section = this.pageLayout?.info.sectionIndex ?? selectedAddress?.section ?? Number(this.pageSectionSelect.value);
    if (!tree || revision === undefined || !Number.isSafeInteger(section) || section < 0
      || !this.formattingModel?.sections.some(item => item.section === section)) {
      throw new Error('머리말·꼬리말을 편집할 구역을 확인하지 못했습니다.');
    }
    const context = this.captureContext();
    const selectedStoryAddress = selectedAddress?.kind === 'headerFooter' ? selectedAddress : undefined;
    const stories = tree.stories.filter((story): story is HeaderFooterStory => story.kind === 'headerFooter' && story.section === section);
    new HeaderFooterTemplateModal(this.app, section, stories, initialIsHeader ?? selectedStoryAddress?.isHeader ?? true,
      (selectedStoryAddress?.applyTo ?? 0) as 0 | 1 | 2, async command => {
        this.assertContext(context);
        if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 최신 상태를 확인한 뒤 머리말·꼬리말을 변경하세요.');
        await this.execute(command.type === 'apply'
          ? [{ type: 'applyHeaderFooterTemplate', section, isHeader: command.isHeader, applyTo: command.applyTo, templateId: command.templateId }]
          : [{ type: 'deleteHeaderFooter', section, isHeader: command.isHeader, applyTo: command.applyTo }]);
      }).open();
  }
  private async navigateStory(direction: -1 | 1): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 영역을 이동하세요.');
    if (this.draft) await this.applyDraft(true);
    const address = this.selected && isParagraph(this.selected) ? this.selected.address : undefined;
    if (address?.kind === 'headerFooter') return this.navigateHeaderFooterPage(direction);
    if (!address || (address.kind !== 'footnote' && address.kind !== 'endnote') || !this.documentTree || !this.state) throw new Error('각주·미주를 먼저 선택하세요.');
    const stories = this.documentTree.stories.filter(story => story.kind === address.kind && 'availability' in story && story.availability === 'available');
    const index = stories.findIndex(story => 'controlIndex' in story && story.section === address.section && story.controlIndex === address.controlIndex && 'anchor' in story && sameDocumentAddress(story.anchor, address.anchor));
    const paragraph = stories[index + direction]?.paragraphs[0];
    if (!paragraph) { this.navigationStatus.setText('그 방향에 같은 종류의 영역이 없습니다.'); return; }
    const context = this.captureContext(), revision = this.state.revision;
    const caret = await this.plugin.api.query.caret(context.path, { address: paragraph.address, offset: 0 }, { sessionId: this.state.sessionId, expectedRevision: revision });
    this.assertContext(context);
    if (this.state?.revision !== revision) throw new Error('영역 이동 중 문서가 바뀌었습니다.');
    this.page = caret.rect.pageIndex; await this.renderPage(true); this.assertContext(context);
    const itemIndex = this.items.findIndex(item => isParagraph(item) && sameDocumentAddress(item.address, paragraph.address));
    if (itemIndex < 0) throw new Error('영역 문단을 찾지 못했습니다.');
    this.selectItem(itemIndex, true); this.restoreTextPosition(caret.position, true);
  }
  private async deleteStory(): Promise<void> {
    if (this.draft) await this.applyDraft(true);
    const address = this.selected && isParagraph(this.selected) ? this.selected.address : undefined;
    if (!address || address.kind === 'body' || !this.state) throw new Error('지울 영역을 먼저 선택하세요.');
    const context = this.captureContext(), revision = this.state.revision;
    const confirmed = await new Promise<boolean>(resolve => new ConfirmActionModal(this.app, { title: '본문 밖 영역 지우기', message: '현재 영역의 모든 문단과 내용을 지웁니다. 되돌리기로 복원할 수 있습니다.', confirmLabel: '영역 지우기' }, resolve).open());
    if (!confirmed) return;
    this.assertContext(context);
    if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 영역을 다시 확인하세요.');
    await this.closeHeaderFooterEditor();
    if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 영역을 다시 확인하세요.');
    await this.execute(address.kind === 'headerFooter'
      ? [{ type: 'deleteHeaderFooter', section: address.section, isHeader: address.isHeader, applyTo: address.applyTo as 0 | 1 | 2 }]
      : [{ type: 'deleteNote', target: address }]);
  }
  private async navigateHeaderFooterPage(direction: -1 | 1): Promise<void> {
    if (this.draft || this.composing) throw new Error('머리말·꼬리말 쪽을 이동하기 전에 입력을 적용하고 한글 조합을 마치세요.');
    const selected = this.selected, state = this.state;
    if (!selected || !isParagraph(selected) || selected.address.kind !== 'headerFooter' || !state || !this.path) {
      throw new Error('머리말이나 꼬리말을 먼저 편집하세요.');
    }
    const address: HeaderFooterAddress = selected.address, context = this.captureContext(), revision = state.revision;
    const caretPosition = this.pageSelection?.focus ?? positionAfterEditorText(address, this.textarea.value, this.textarea.selectionEnd);
    const target = await this.plugin.api.query.navigateHeaderFooterPage(context.path, this.page, address.isHeader, direction,
      { sessionId: state.sessionId, expectedRevision: revision });
    this.assertContext(context);
    const latest = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (latest.revision !== revision || this.state?.revision !== revision) throw new Error('이동 중 문서가 바뀌어 쪽 이동을 취소했습니다.');
    if (!target.ok || target.pageIndex === undefined || target.section === undefined || target.isHeader === undefined || target.applyTo === undefined) {
      this.navigationStatus.setText(direction < 0 ? '앞쪽에 같은 머리말·꼬리말 영역이 없습니다.' : '뒤쪽에 같은 머리말·꼬리말 영역이 없습니다.');
      return;
    }
    const destinationStory = this.documentTree?.stories.find((story): story is HeaderFooterStory => story.kind === 'headerFooter'
      && story.section === target.section && story.isHeader === target.isHeader && story.applyTo === target.applyTo);
    const destinationParagraph = destinationStory?.paragraphs[Math.min(address.paragraph, Math.max(0, (destinationStory?.paragraphs.length ?? 1) - 1))];
    if (!destinationParagraph) throw new Error('이동한 쪽의 머리말·꼬리말 문단을 찾지 못했습니다.');
    this.state = latest; this.page = Math.min(target.pageIndex, latest.pageCount - 1);
    await this.renderPage(true); this.assertContext(context);
    const index = this.items.findIndex(item => isParagraph(item) && sameDocumentAddress(item.address, destinationParagraph.address));
    if (index < 0) throw new Error('현재 머리말·꼬리말 문단을 찾지 못했습니다. 문서 구조를 새로 읽으세요.');
    this.selectItem(index, true);
    this.restoreTextPosition({ address: destinationParagraph.address, offset: Math.min(destinationParagraph.length, caretPosition.offset) }, true);
    this.navigationStatus.setText(`${this.page + 1}쪽 ${target.isHeader ? '머리말' : '꼬리말'} 편집 중`);
  }
  private async closeHeaderFooterEditor(): Promise<void> {
    if (this.composing) throw new Error('한글 조합을 마친 뒤 본문 밖 영역 편집을 닫으세요.');
    if (this.draft) await this.applyDraft(true);
    const selected = this.selected, tree = this.documentTree, state = this.state;
    if (!selected || !isParagraph(selected) || !['headerFooter', 'footnote', 'endnote'].includes(selected.address.kind) || !tree || !state || !this.path) {
      throw new Error('현재 본문 밖 영역 편집 모드가 아닙니다.');
    }
    const context = this.captureContext(), revision = state.revision;
    const returned = this.storyReturnPosition && this.paragraphForAddress(tree, this.storyReturnPosition.address)?.address.kind === 'body'
      ? this.storyReturnPosition
      : undefined;
    const noteAnchor = selected.address.kind === 'footnote' || selected.address.kind === 'endnote' ? selected.address.anchor : undefined;
    const paragraph = returned ? this.paragraphForAddress(tree, returned.address) : noteAnchor ? this.paragraphForAddress(tree, noteAnchor) : tree.paragraphs.find(item =>
      item.address.kind === 'body' && item.address.section === selected.address.section
      && !item.address.cellPath?.length && !item.address.containerKinds?.includes('textBox'));
    if (!paragraph) {
      this.storyReturnPosition = undefined;
      this.clearSelection('본문 밖 영역 편집을 닫았습니다.');
      this.pageScroll.focus({ preventScroll: true });
      return;
    }
    // The remembered address was stamped at an older revision (typing in the header changed it); only its offset is still good.
    const position = { address: paragraph.address, offset: returned ? Math.min(returned.offset, paragraph.length) : 0 };
    const caret = await this.plugin.api.query.caret(context.path, position, { sessionId: state.sessionId, expectedRevision: revision });
    this.assertContext(context);
    const latest = await this.plugin.api.documents.state(context.path); this.assertContext(context);
    if (latest.revision !== revision || this.state?.revision !== revision) throw new Error('이동 중 문서가 바뀌어 편집 닫기를 취소했습니다.');
    this.mode = 'paragraphs'; this.modeSelector.value = this.mode; this.items = this.itemsForMode(tree);
    const index = this.items.findIndex(item => isParagraph(item) && sameDocumentAddress(item.address, paragraph.address));
    if (index < 0) throw new Error('돌아갈 본문 문단을 찾지 못했습니다.');
    this.state = latest; this.page = Math.min(caret.rect.pageIndex, latest.pageCount - 1);
    await this.renderPage(true); this.assertContext(context);
    this.selectItem(index, true); this.restoreTextPosition(caret.position, true);
    this.storyReturnPosition = undefined;
    this.navigationStatus.setText(`${this.page + 1}쪽 본문으로 돌아왔습니다.`);
  }
  private async applyPageSettings(): Promise<void> {
    const section = Number(this.pageSectionSelect.value);
    if (!Number.isSafeInteger(section) || section < 0) throw new Error('쪽 설정 구역을 선택하세요.');
    const properties: PageSettingsProperties = { landscape: this.pageLandscapeInput.checked };
    const dimensions: { width?: number; height?: number } = {};
    for (const [key, input] of this.pageNumberInputs) {
      if (!input.value.trim()) continue;
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0 || value > 10000) throw new Error('쪽 크기와 여백은 0~10000mm 범위로 입력하세요.');
      const units = millimetersToHwpUnits(value);
      (properties as Record<string, unknown>)[key] = units;
      if (key === 'width') dimensions.width = units;
      if (key === 'height') dimensions.height = units;
    }
    if (dimensions.width !== undefined && dimensions.height !== undefined && (this.pageLandscapeInput.checked ? dimensions.width < dimensions.height : dimensions.width > dimensions.height)) {
      (properties as Record<string, unknown>).width = dimensions.height;
      (properties as Record<string, unknown>).height = dimensions.width;
    }
    if (dimensions.width !== undefined && dimensions.width < 1000 || dimensions.height !== undefined && dimensions.height < 1000) throw new Error('쪽 너비와 높이는 10mm 이상이어야 합니다.');
    await this.execute([{ type: 'setPageSettings', section, properties }]);
  }
  private async insertParagraph(): Promise<void> {
    const target = this.target();
    if (!('kind' in target) || target.kind !== 'body' || target.cellPath?.length || target.containerKinds?.includes('textBox')) throw new Error('본문 문단을 선택하세요.');
    await this.execute([{ type: 'insertParagraph', section: target.section, index: target.paragraph + 1, text: '' }]);
  }
  private async deleteParagraph(): Promise<void> {
    const target = this.target();
    if (!('kind' in target) || target.kind !== 'body' || target.cellPath?.length) throw new Error('본문 문단을 선택하세요.');
    await this.execute([{ type: 'deleteParagraph', section: target.section, index: target.paragraph }]);
  }
  private openTableGridDialog(): void {
    const context = this.captureContext(), revision = this.state?.revision;
    if (revision === undefined) throw new Error('문서 상태가 아직 준비되지 않았습니다.');
    new TableGridModal(this.app, async (rows, columns) => {
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 최신 상태를 확인한 뒤 표를 만드세요.');
      await this.createTable(rows, columns);
    }).open();
  }
  private openCustomTableDialog(): void {
    const paragraph = this.rootBodyParagraph(), offset = this.insertionOffset(paragraph);
    const context = this.captureContext(), revision = this.state?.revision;
    new FormModal(this.app, {
      title: '사용자 지정 표 삽입', submitLabel: '삽입', fields: [
        { key: 'rows', label: '줄 수', kind: 'number', value: Number(this.tableRowsInput.value) || 2, min: 1, max: 100, integer: true },
        { key: 'cols', label: '칸 수', kind: 'number', value: Number(this.tableColsInput.value) || 2, min: 1, max: 100, integer: true },
      ],
      validate: values => Number(values.rows) * Number(values.cols) > 1000 ? '표는 최대 1000셀까지 삽입할 수 있습니다.' : undefined,
    }, async values => {
      this.assertContext(context);
      if (this.state?.revision !== revision) throw new Error('문서가 바뀌었습니다. 표 삽입 대화상자를 다시 여세요.');
      await this.execute([{ type: 'createTable', target: paragraph.address, offset, rows: Number(values.rows), cols: Number(values.cols) }]);
    }).open();
  }
  private async createTable(rowsOverride?: number, columnsOverride?: number): Promise<void> {
    const target = this.target();
    if (!('kind' in target) || target.kind !== 'body' || target.cellPath?.length || target.containerKinds?.includes('textBox')) throw new Error('표는 글상자가 아닌 본문 문단에서 만들 수 있습니다.');
    const rows = rowsOverride ?? Number(this.tableRowsInput.value), cols = columnsOverride ?? Number(this.tableColsInput.value);
    if (!Number.isInteger(rows) || rows < 1 || rows > 100 || !Number.isInteger(cols) || cols < 1 || cols > 100 || rows * cols > 1000) throw new Error('표 크기는 1~100행·열, 최대 1000셀로 입력하세요.');
    const offset = this.pageSelection && sameDocumentAddress(this.pageSelection.address, target) ? Math.min(this.pageSelection.start, this.pageSelection.end) : 0;
    await this.execute([{ type: 'createTable', target: { section: target.section, paragraph: target.paragraph }, offset, rows, cols }]);
  }
}

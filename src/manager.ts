import { createHash, randomUUID } from 'node:crypto';
import { copyRootOutputAnchors, rootOutputCandidates } from './output-anchor-candidates';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Command, DocumentTree, Target, DocumentCapabilities, DocumentEvent, DocumentLease, DocumentSearchMatch, ErrorCode, EventType, Field, Format, FormattingModel, FormattingOptions, HwpHandsApiV1, IndexStatus, NodeSelector, NodeSelection, ObjectResource, ObjectResourceTarget, Paragraph, PageLayout, PageRenderOptions, QueryContext, Receipt, RootOutputAnchor, SaveFormatCapability, SaveResult, SearchMatch, SnapshotOptions, State, StoryParagraph, StructurePage, StructurePageOptions, TextSelection, TextSelectionTarget, TransactionOptions, VerificationOptions, VerificationReport } from './api';
import { HwpHandsError } from './api';
import { ENGINE_VERSION, imageBase64ByteLength, integer } from './engine-common';
import type { EnginePort, EngineProvider } from './engine-port';
import { inspectIndex, makeIndex } from './markdown-index';
import { createRecoveryV3Header, createRecoveryV3Line, encodeRecoveryV3, type RecoveryV3Header, type RecoveryV3Line } from './recovery-journal';
import { AutosaveScheduler, type AutosaveCandidate, type AutosaveDocumentHandle, type AutosaveInput, type AutosaveOutcome, type AutosaveSchedulerOptions, type AutosaveStatus, type AutosaveViewHandle } from './autosave-scheduler';
import { EditActorLedger, validateActionActor, validateEditActor, validatePersistedActors, type EditActor, type PersistedActors } from './edit-actors';
import { PreparedSaveStore, canonicalSaveJson, type PreparedSave, type PreparedSaveArtifact, type PreparedSavePermit, type PreparedSaveReceipt, type PreparedSaveTicket } from './prepared-save';
import { prepareNewSave, executeNewSave, type NewSaveRequest } from './prepared-new-save';
import { assertHwpSourceSafe, hwpSourceGuard, type HwpSourceGuard } from './hwp-source-guard';
import { MAX_NEW_TABS, inspectNewTabs, writeTabWidths } from './tab-widths';
import { restoreSectionTails, inspectSectionTails, type SectionTailsInspection } from './section-tails';

export interface CleanupCandidate { path: string; kind: 'backup' | 'temporary'; bytes: number; modifiedAt: number; reason: string }
export interface CleanupPlan {
  candidates: CleanupCandidate[];
  managedBackups: number;
  retainedBackups: number;
  legacyBackups: number;
  recoveryRecords: number;
  inputDrafts: number;
  temporaryFiles: number;
}
export interface Storage {
  read(path: string): Promise<Uint8Array>;
  readBounded?(path: string, maxBytes: number): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  create(path: string, bytes: Uint8Array): Promise<void>;
  /** Prepared creation never makes undeclared parent folders or overwrites a file. */
  pathKind?(path: string): Promise<'file' | 'folder' | null>;
  createFolder?(path: string): Promise<void>;
  createPrepared?(path: string, bytes: Uint8Array): Promise<void>;
  backup(path: string, bytes: Uint8Array): Promise<string>;
  /** Drops this document's backups beyond the retained generations after a verified save. */
  pruneBackups?(path: string): Promise<string[]>;
  writeIndex(path: string, content: string, source: string): Promise<void>;
  readIndex?(path: string): Promise<string | undefined>;
  removeManagedIndex?(path: string, source: string): Promise<boolean>;
  moveManagedIndex?(oldPath: string, newPath: string, oldSource: string, newSource: string, sourceHash: string): Promise<boolean>;
  readRecovery(path: string, maxBytes?: number): Promise<Recovery | undefined>;
  writeRecovery(path: string, recovery: Recovery): Promise<void>;
  appendRecovery?(path: string, line: RecoveryV3Line, maxBytes: number): Promise<void>;
  removeRecovery(path: string): Promise<void>;
  /** Every readable recovery record of at most maxBytes, for telling a person what is waiting. Unreadable or larger ones are left out. */
  recoveryRecords?(maxBytes: number): Promise<Recovery[]>;
  cleanupPlan?(now?: number): Promise<CleanupPlan>;
  cleanupManagedFiles?(paths: string[], now?: number): Promise<string[]>;
}
export type RecoveryAction = { commands: Command[]; origin?: 'input' | 'command' | 'api'; groupId?: string; undoBoundary?: boolean; actor?: EditActor; editId?: string } | { history: 'undo' | 'redo' };
export interface RecoveryV1 { version: 1; path: string; baseHash: string; seedHash: string; seed: string; actions: RecoveryAction[]; historyLimit: number; intendedSaveHash?: string }
export interface RecoveryV2 {
  version: 2; pluginVersion: string; engineVersion: string; commandSchema: number; path: string; baseHash: string;
  seedHash: string; seedBytes: number; actionCount: number; commandCount: number; historyLimit: number;
  intendedSaveHash?: string; payload: string; payloadBytes: number; expandedBytes: number; payloadHash: string; recordHash: string;
}
export interface RecoveryV3 extends RecoveryV3Header { actions: RecoveryAction[]; sequence: number; tailHash: string; truncatedTail: boolean }
export type Recovery = RecoveryV1 | RecoveryV2 | RecoveryV3;
export interface ManagerOptions { backup: boolean; autoIndex: boolean; historyLimit: number; maxFileBytes: number }
export const DEFAULT_OPTIONS: ManagerOptions = { backup: true, autoIndex: false, historyLimit: 30, maxFileBytes: 50 * 1024 * 1024 };
export const DEFAULT_SESSION_IDLE_MS = 60_000;
/** Internal opt-in. Main stays disabled until Undo/recovery, actor policy and GUI acceptance are complete. */
export interface ManagerAutosaveOptions extends Omit<AutosaveSchedulerOptions, 'save'> {
  /** Test/custom executor override; omitting it selects the manager's validated pipeline. */
  save?(candidate: AutosaveCandidate): Promise<AutosaveOutcome>;
  /** Explicit supported range; required for the validated pipeline. No production thresholds are inferred. */
  limits?: { maxCandidateBytes: number; maxPages: number };
  blockReason(this: void, state: State): string | undefined;
}
const COMMAND_SCHEMA_VERSION = 1;
const MAX_RECOVERY_ACTIONS = 10_000;
const MAX_RECOVERY_COMMANDS = 20_000;
const MAX_TRANSACTION_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_ACTIONS = 256;
// Failed validation and retained typing history must not trigger an export on every following edit.
const CHECKPOINT_RETRY_ACTIONS = 256;
const CHECKPOINT_RETRY_BYTES = 8 * 1024 * 1024;
const QUERY_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const QUERY_CACHE_MAX_ENTRY_BYTES = 3 * 1024 * 1024;
// The structure and formatting of a long document exceed the entry limit, and then every typed key reads the whole document again.
// One newest result of each is kept apart from the shared budget so a typed edit can carry it to the next revision.
const TYPING_CARRY_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const STRUCTURE_PAGE_MAX_ITEMS = 500;
const INPUT_GROUP_IDLE_MS = 300;
const EVENT_TYPES = new Set<string>(['opened', 'changed', 'saved', 'reloaded', 'conflict', 'closed', 'renamed']);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const actionSize = (action: RecoveryAction): number => Buffer.byteLength(JSON.stringify(action), 'utf8');
const actionsSize = (actions: RecoveryAction[]): number => 2 + actions.reduce((bytes, action, index) => bytes + actionSize(action) + (index ? 1 : 0), 0);
// Empty seed and [] are already present in the object framing; substitute their exact JSON lengths.
export const recoveryExpandedSize = (seedBytes: number, actionBytes: number, actors: PersistedActors): number =>
  Buffer.byteLength(JSON.stringify({ seed: '', actions: [], actors }), 'utf8') - 2 + 4 * Math.ceil(seedBytes / 3) + actionBytes;
function normalizeNoFillPatternMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNoFillPatternMetadata);
  if (!value || typeof value !== 'object') return value;
  const normalized = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeNoFillPatternMetadata(item)]));
  if (normalized.fillType === 'none') {
    delete normalized.patternColor;
    delete normalized.patternType;
  }
  return normalized;
}
function inputGroupCommandsJoin(previous: Command, next: Command): boolean {
  if (previous.type !== next.type || (next.type !== 'insertText' && next.type !== 'deleteText')) return false;
  if (previous.type !== 'insertText' && previous.type !== 'deleteText') return false;
  const key = (target: unknown): string | undefined => {
    if (!target || typeof target !== 'object') return undefined;
    const item = target as { section?: unknown; paragraph?: unknown; cellPath?: unknown; containerKinds?: unknown };
    if (!Number.isSafeInteger(item.section) || !Number.isSafeInteger(item.paragraph)) return undefined;
    return JSON.stringify({ section: item.section, paragraph: item.paragraph, cellPath: item.cellPath, containerKinds: item.containerKinds });
  };
  const previousKey = key(previous.target), nextKey = key(next.target);
  if (!previousKey || previousKey !== nextKey) return false;
  if (next.type === 'insertText' && previous.type === 'insertText') {
    if (JSON.stringify(previous.characterProperties ?? {}) !== JSON.stringify(next.characterProperties ?? {})) return false;
    if (typeof previous.text !== 'string' || typeof next.text !== 'string' || !Number.isSafeInteger(previous.offset) || !Number.isSafeInteger(next.offset)) return false;
    return !previous.text.includes('\n') && !previous.text.includes('\t') && !next.text.includes('\n') && !next.text.includes('\t')
      && next.offset === previous.offset + Array.from(previous.text).length;
  }
  return next.type === 'deleteText' && previous.type === 'deleteText'
    && Number.isSafeInteger(previous.offset) && Number.isSafeInteger(next.offset) && Number.isSafeInteger(previous.count)
    && (next.offset === previous.offset || next.offset === previous.offset - previous.count);
}
function estimateCacheBytes(root: unknown, maxBytes: number): number {
  const pending: unknown[] = [root], seen = new Set<object>();
  let bytes = 0;
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') bytes += value.length * 2;
    else if (typeof value === 'number') bytes += 8;
    else if (typeof value === 'boolean') bytes += 4;
    else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value); bytes += 32;
      if (value instanceof Uint8Array) bytes += value.byteLength;
      else if (Array.isArray(value)) { bytes += value.length * 16; if (bytes > maxBytes) return maxBytes + 1; for (const item of value) pending.push(item); }
      else for (const [key, item] of Object.entries(value)) { bytes += key.length * 2; pending.push(item); }
    }
    if (bytes > maxBytes) return maxBytes + 1;
  }
  return bytes;
}
function recoveryRecordHash(recovery: Omit<RecoveryV2, 'recordHash'>): string {
  const metadata = {
    version: recovery.version, pluginVersion: recovery.pluginVersion, engineVersion: recovery.engineVersion,
    commandSchema: recovery.commandSchema, path: recovery.path, baseHash: recovery.baseHash,
    seedHash: recovery.seedHash, seedBytes: recovery.seedBytes, actionCount: recovery.actionCount,
    commandCount: recovery.commandCount, historyLimit: recovery.historyLimit,
    intendedSaveHash: recovery.intendedSaveHash, payloadBytes: recovery.payloadBytes,
    expandedBytes: recovery.expandedBytes, payloadHash: recovery.payloadHash
  };
  return hash(Buffer.from(JSON.stringify(metadata), 'utf8'));
}
function validateRecoveryActions(value: unknown): { actions: RecoveryAction[]; commandCount: number } {
const commandTypes = new Set(['insertText', 'insertLineBreak', 'insertTab', 'pasteHtml', 'deleteText', 'replaceParagraph', 'replaceRange', 'deleteRange', 'splitParagraph', 'mergeParagraph', 'deleteParagraphAt', 'replaceText', 'insertParagraph', 'insertCellParagraph', 'deleteParagraph', 'setCellText', 'setField', 'setFieldById', 'insertClickHereField', 'updateField', 'removeField', 'formatText', 'formatParagraph', 'setParagraphStyle', 'setParagraphList', 'createStyle', 'updateStyle', 'deleteStyle', 'createNumbering', 'createTable', 'insertTableRow', 'deleteTableRow', 'insertTableColumn', 'deleteTableColumn', 'mergeTableCells', 'splitTableCell', 'resizeTableCells', 'setTableProperties', 'setCellProperties', 'transposeTable', 'splitTable', 'mergeTableWithNext', 'deleteTable', 'setTableFormula', 'insertNote', 'deleteNote', 'setEndnoteShape', 'applyHeaderFooterTemplate', 'deleteHeaderFooter', 'insertPageBreak', 'setPageSettings', 'setPageHide', 'insertNewNumber', 'addBookmark', 'renameBookmark', 'deleteBookmark', 'setColumnSettings', 'setPageBorderFill', 'setSectionDefinition', 'insertEquation', 'insertPicture', 'insertShape', 'setObjectProperties', 'setObjectZOrder', 'groupObjects', 'ungroupObject', 'deleteObject']);
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_ACTIONS) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 작업 수가 올바르지 않습니다.');
  commandTypes.add('formatRange'); commandTypes.add('formatCellBlock'); commandTypes.add('setFields'); commandTypes.add('setFieldsAt');
  let commandCount = 0;
  let activeGroupId: string | undefined, activeGroupLastCommand: Command | undefined, activeGroupActor: unknown;
  for (const action of value) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new HwpHandsError('VERIFY_FAILED', '복구 기록에 잘못된 작업이 있습니다.');
    const item = action as Record<string, unknown>;
    const keys = Object.keys(item);
    if ('history' in item) {
      if (keys.length !== 1) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 작업의 필드 구성이 올바르지 않습니다.');
      if (item.history !== 'undo' && item.history !== 'redo') throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 undo/redo 작업이 올바르지 않습니다.');
      activeGroupId = undefined;
      activeGroupLastCommand = undefined;
      continue;
    }
    if (keys.some(key => !['commands', 'origin', 'groupId', 'undoBoundary', 'actor', 'editId'].includes(key))) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 작업의 필드 구성이 올바르지 않습니다.');
    validateActionActor(item.actor, item.editId);
    if (!('commands' in item) || !Array.isArray(item.commands) || item.commands.length < 1 || item.commands.length > 500) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 명령 묶음이 올바르지 않습니다.');
    if (item.origin !== undefined && item.origin !== 'input' && item.origin !== 'command' && item.origin !== 'api') throw new HwpHandsError('VERIFY_FAILED', '복구 기록 origin이 올바르지 않습니다.');
    if (item.groupId !== undefined) {
      // eslint-disable-next-line no-control-regex -- Recovery group IDs must reject control characters.
      if (typeof item.groupId !== 'string' || !item.groupId.length || item.groupId.length > 128 || /[\u0000-\u001f\u007f]/.test(item.groupId) || item.origin !== 'input' || typeof item.undoBoundary !== 'boolean' || item.commands.length !== 1) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 입력 그룹 메타데이터가 올바르지 않습니다.');
      const command = item.commands[0] as { type?: unknown; target?: { kind?: unknown } } | undefined;
      if (!command || typeof command !== 'object') throw new HwpHandsError('VERIFY_FAILED', '복구 기록 입력 그룹의 명령이 올바르지 않습니다.');
      if ((command.type !== 'insertText' && command.type !== 'deleteText') || command.target?.kind !== undefined) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 입력 그룹에 지원하지 않는 명령이 있습니다.');
      if (item.undoBoundary === false && activeGroupId !== item.groupId) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 입력 그룹 경계 순서가 올바르지 않습니다.');
      if (item.undoBoundary === false && JSON.stringify(item.actor) !== JSON.stringify(activeGroupActor)) throw new HwpHandsError('VERIFY_FAILED', '복구 입력 그룹의 편집 주체가 변경되었습니다.');
      if (item.undoBoundary === false && (!activeGroupLastCommand || !inputGroupCommandsJoin(activeGroupLastCommand, command as Command))) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 입력 그룹의 연속 위치가 올바르지 않습니다.');
      activeGroupId = item.undoBoundary ? item.groupId : activeGroupId;
      activeGroupLastCommand = command as Command;
      activeGroupActor = item.actor;
    } else {
      if (item.undoBoundary !== undefined) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 입력 그룹 경계가 없습니다.');
      activeGroupId = undefined;
      activeGroupLastCommand = undefined;
    }
    commandCount += item.commands.length;
    for (const command of item.commands) {
      if (!command || typeof command !== 'object' || Array.isArray(command) || !commandTypes.has(String((command as { type?: unknown }).type))) throw new HwpHandsError('VERIFY_FAILED', '복구 기록에 지원하지 않는 명령이 있습니다.');
    }
  }
  if (commandCount > MAX_RECOVERY_COMMANDS) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 명령 수가 제한을 초과합니다.');
  return { actions: value as RecoveryAction[], commandCount };
}
function decodeBase64(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new HwpHandsError('VERIFY_FAILED', `복구 기록 ${label} 인코딩이 올바르지 않습니다.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new HwpHandsError('VERIFY_FAILED', `복구 기록 ${label} 인코딩이 올바르지 않습니다.`);
  return bytes;
}
export function documentPath(input: string): string {
  if (typeof input !== 'string') throw new HwpHandsError('INVALID_PATH', '볼트 상대 경로를 사용하세요.');
  const path = input.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /[:\0\r\n]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.obsidian' || p.toLowerCase() === '.trash') || !/\.(hwp|hwpx)$/i.test(path)) {
    throw new HwpHandsError('INVALID_PATH', '볼트 안의 .hwp 또는 .hwpx 상대 경로가 필요합니다.');
  }
  return path;
}
function fileNameFromPath(path: string): string { return path.slice(path.lastIndexOf('/') + 1); }
function pathWithFormat(path: string, format: Format): string { return path.replace(/\.(?:hwp|hwpx)$/i, `.${format}`); }
function folderPath(input: string): string {
  if (typeof input !== 'string') throw new HwpHandsError('INVALID_PATH', '볼트 상대 경로를 사용하세요.');
  const path = input.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /[:\0\r\n]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.obsidian' || p.toLowerCase() === '.trash')) {
    throw new HwpHandsError('INVALID_PATH', '볼트 안의 상대 폴더 경로가 필요합니다.');
  }
  return path;
}
const within = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
interface DecodedRecovery { path: string; baseHash: string; seed: Uint8Array; actions: RecoveryAction[]; actors?: PersistedActors; historyLimit: number; intendedSaveHash?: string; migrated: boolean; journalSequence?: number; journalTailHash?: string; journalNeedsRewrite?: boolean }
/** AI edits in a recovery record that no explicit save approved. Counts recorded edits; it does not replay undo and redo. */
export function unapprovedAiEdits(record: Recovery): number {
  const actors = (record as { actors?: PersistedActors }).actors, actions = (record as { actions?: RecoveryAction[] }).actions;
  const approved = new Set(Array.isArray(actors?.approved) ? actors.approved : []);
  const seeded = Array.isArray(actors?.seed) ? actors.seed.filter(entry => entry?.actor?.kind === 'ai' && !approved.has(entry.id)).length : 0;
  return seeded + (Array.isArray(actions) ? actions.filter(action => 'commands' in action && action.actor?.kind === 'ai' && !approved.has(action.editId ?? '')).length : 0);
}
/** One applied (not dry-run) transaction, as the manager recorded it. */
export interface AppliedEdit { path: string; sessionId: string; revisionBefore: number; revisionAfter: number; commands: Command[]; actor: EditActor['kind'] }
interface Session { path: string; sessionId: string; engine: EnginePort; followingSignature?: { revision: number; page: number; value: string }; pageCount: number; revision: number; references: number; legacyReferences: number; idleTimer?: ReturnType<typeof setTimeout>; dirty: boolean; conflict: boolean; baseHash: string; sourceGuard: HwpSourceGuard; sectionTails: SectionTailsInspection; undo: number[]; redo: number[]; origins: Map<number, number>; actorLedger: EditActorLedger; seed: Uint8Array; actions: RecoveryAction[]; actionBytes: number; commandCount: number; checkpointAttempt?: { seed: Uint8Array; actionCount: number; actionBytes: number; result: 'success' | 'validation-failed' }; historyLimit: number; journalSequence?: number; journalTailHash?: string; journalActionCount: number; journalNeedsRewrite?: boolean; journalIntendedSaveHash?: string; activeGroup?: { id: string; snapshot: number; lastAt: number; lastCommand: Command; actor: EditActor }; /** Since the working copy last matched the file: undefined = no edit, an id = only this AI actor's own edits, null = anything else. */ soleAiActor?: string | null; /** Its unsaved changes were replayed from an earlier run's recovery record and nobody was asked yet. */ recoveredUnasked?: boolean; capabilityCache?: DocumentCapabilities; writePreflight?: SaveFormatCapability; queryCache: Map<string, { value: unknown; bytes: number }>; queryCacheBytes: number; typingCarry: Map<string, { value: unknown; bytes: number }> }
interface PathTransition { prefixes: string[]; promise: Promise<void>; release: () => void }
type VerificationDetails = Omit<VerificationReport, keyof State>;
interface PreservationBuckets { buckets: Record<string, unknown>; coverageWarnings: string[] }

export function preservationStructureEqual(before: unknown, after: unknown): boolean {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return JSON.stringify(before) === JSON.stringify(after);
  const source = before as Record<string, unknown>, exported = after as Record<string, unknown>;
  if (!Array.isArray(source.controls) || !Array.isArray(exported.controls) || source.controls.length !== exported.controls.length) return JSON.stringify(before) === JSON.stringify(after);
  const controls = exported.controls.map((control: unknown, index: number) => {
    const original = source.controls as Array<Record<string, unknown>>;
    if (!control || typeof control !== 'object' || !original[index] || original[index].ctrlId !== 'tbl') return control;
    const copy = control as Record<string, unknown>;
    if (copy.ctrlId !== 'tbl' || !copy.props || typeof copy.props !== 'object' || !original[index].props || typeof original[index].props !== 'object') return control;
    const oldProps = original[index].props as Record<string, unknown>, newProps = copy.props as Record<string, unknown>;
    // RHWP 0.9.0 writes a grown table height in the saved copy (grown_table_heights.rs); a shrink or any other change is still a loss.
    if (typeof oldProps.Height !== 'number' || typeof newProps.Height !== 'number' || !Number.isFinite(oldProps.Height) || !Number.isFinite(newProps.Height) || newProps.Height < oldProps.Height) return control;
    return { ...copy, props: { ...newProps, Height: oldProps.Height } };
  });
  return JSON.stringify(source) === JSON.stringify({ ...exported, controls });
}
export class DocumentManager {
  readonly api: HwpHandsApiV1;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<EventType | '*', Set<(event: DocumentEvent) => void>>();
  private readonly transitions: PathTransition[] = [];
  private transitionTail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private disposed = false;
  private readonly autosave?: AutosaveScheduler;
  private readonly autosaveDocuments = new Map<string, AutosaveDocumentHandle>();
  private readonly autosaveListeners = new Map<string, Set<(status: AutosaveStatus) => void>>();
  private readonly inputReaders = new Map<string, Set<() => AutosaveInput>>();
  private readonly inputGenerations = new Map<string, number>();
  private readonly appliedListeners = new Set<(edit: AppliedEdit) => void>();
  private readonly preparedSaves = new PreparedSaveStore();
  constructor(private readonly storage: Storage, private readonly engineProvider: EngineProvider, public options: ManagerOptions = { ...DEFAULT_OPTIONS }, private readonly pluginVersion = '0.3.0', private readonly autosaveOptions?: ManagerAutosaveOptions) {
    if (autosaveOptions) {
      if (!autosaveOptions.save && (!autosaveOptions.limits || [autosaveOptions.limits.maxCandidateBytes, autosaveOptions.limits.maxPages].some(value => !Number.isSafeInteger(value) || value <= 0))) {
        throw new HwpHandsError('INVALID_ARGUMENT', '검증된 자동 저장에는 후보 바이트·쪽 수 상한이 필요합니다.');
      }
      this.autosave = new AutosaveScheduler({ ...autosaveOptions, save: autosaveOptions.save ? candidate => autosaveOptions.save!(candidate) : candidate => this.executeAutosave(candidate),
        onStatus: (sessionId, status) => {
          for (const listener of [...(this.autosaveListeners.get(sessionId) ?? [])]) this.deliverAutosaveStatus(listener, status);
          if (status.phase === 'closed') this.autosaveListeners.delete(sessionId);
          try { autosaveOptions.onStatus?.(sessionId, structuredClone(status)); } catch { /* Owner observers cannot interrupt saving. */ }
        },
      });
    }
    const run = <T>(path: string, fn: (s: Session) => T | Promise<T>): Promise<T> => this.run(path, async path => {
      const s = await this.session(path);
      return this.stampResult(s, await fn(s));
    });
    const optionsRecord = (value: unknown, label: string, optional = false) => this.optionsRecord(value, label, optional);
    const optionalBoolean = (value: Record<string, unknown>, key: string) => this.optionalBoolean(value, key);
    const optionalPages = (value: Record<string, unknown>, label: string) => this.optionalPages(value, label);
    function queryParagraphs(path: string, options?: { includeCells?: boolean; includeStories?: false }): Promise<Paragraph[]>;
    function queryParagraphs(path: string, options: { includeCells?: boolean; includeStories: true }): Promise<Array<Paragraph | StoryParagraph>>;
    function queryParagraphs(path: string, options?: { includeCells?: boolean; includeStories?: boolean }): Promise<Array<Paragraph | StoryParagraph>> {
      return run(path, s => {
        const value = optionsRecord(options, 'paragraphs', true), includeCells = optionalBoolean(value, 'includeCells'), includeStories = optionalBoolean(value, 'includeStories');
        return includeStories ? s.engine.paragraphs(includeCells, true) : includeCells ? s.engine.paragraphs(true) : s.engine.paragraphs();
      });
    }
    const queryStructure = (path: string, options: StructurePageOptions): Promise<StructurePage> => run(path, async s => {
      const value = this.optionsRecord(options, 'structure'), collection = value.collection;
      if (collection !== 'paragraphs' && collection !== 'tables' && collection !== 'fields' && collection !== 'controls' && collection !== 'objects' && collection !== 'stories' && collection !== 'bookmarks') {
        throw new HwpHandsError('INVALID_ARGUMENT', 'collection must be paragraphs, tables, fields, controls, objects, stories, or bookmarks.');
      }
      const offset = value.offset ?? 0, limit = value.limit ?? 100;
      if (typeof offset !== 'number' || typeof limit !== 'number') throw new HwpHandsError('INVALID_ARGUMENT', 'offset and limit must be numbers.');
      integer(offset, 'offset'); integer(limit, 'limit', STRUCTURE_PAGE_MAX_ITEMS);
      if (limit < 1) throw new HwpHandsError('INVALID_ARGUMENT', 'limit must be between 1 and 500.');
      if (!Number.isSafeInteger(offset + limit)) throw new HwpHandsError('INVALID_ARGUMENT', 'offset + limit is out of range.');
      const includeCells = this.optionalBoolean(value, 'includeCells'), includeStories = this.optionalBoolean(value, 'includeStories');
      const key = `structure:${s.revision}:${collection}:${includeCells}:${includeStories}`;
      if (collection === 'paragraphs' && !includeCells && !includeStories) {
        const page = await this.cachedQuery(s, `${key}:${offset}:${limit}`, () => s.engine.paragraphRange(offset, limit));
        return { state: this.state(s), collection, offset, limit, total: page.total, items: page.items };
      }
      let items: unknown[];
      switch (collection) {
        case 'paragraphs': items = await this.cachedQuery(s, key, () => includeStories ? s.engine.paragraphs(includeCells, true) : includeCells ? s.engine.paragraphs(true) : s.engine.paragraphs()); break;
        case 'tables': items = await this.cachedQuery(s, key, () => s.engine.tables()); break;
        case 'fields': items = await this.cachedQuery(s, key, () => s.engine.fields()); break;
        case 'controls': items = await this.cachedQuery(s, key, () => s.engine.controls()); break;
        case 'objects': items = await this.cachedQuery(s, key, () => s.engine.objects(undefined, false)); break;
        case 'stories': items = (await this.cachedQuery(s, `tree:${s.revision}`, () => s.engine.tree())).stories; break;
        case 'bookmarks': items = (await this.cachedQuery(s, `tree:${s.revision}`, () => s.engine.tree())).bookmarks; break;
      }
      return { state: this.state(s), collection, offset, limit, total: items.length, items: items.slice(offset, offset + limit) } as StructurePage;
    });
    function querySearch(path: string, query: string, options?: { caseSensitive?: boolean; includeStories?: false }): Promise<SearchMatch[]>;
    function querySearch(path: string, query: string, options: { caseSensitive?: boolean; includeStories: true }): Promise<DocumentSearchMatch[]>;
    function querySearch(path: string, query: string, options?: { caseSensitive?: boolean; includeStories?: boolean }): Promise<DocumentSearchMatch[]> {
      return run(path, s => {
        const value = optionsRecord(options, 'search', true), caseSensitive = optionalBoolean(value, 'caseSensitive'), includeStories = optionalBoolean(value, 'includeStories');
        return includeStories ? s.engine.searchDocument(query, caseSensitive) : s.engine.search(query, caseSensitive);
      });
    }
    const queryFormatting = (path: string, options?: FormattingOptions): Promise<FormattingModel> => {
      return run(path, s => {
        const value = optionsRecord(options, 'formatting', true), pages = optionalPages(value, 'formatting'), runs = value.runs ?? 'layout';
        if (runs !== 'layout' && runs !== 'model') throw new HwpHandsError('INVALID_ARGUMENT', 'formatting runs must be "layout" or "model".');
        const includeNativeShape = value.includeNativeShape === undefined ? true : optionalBoolean(value, 'includeNativeShape');
        return this.cachedQuery(s, `formatting:${s.revision}:${pages ? [...pages].sort((a, b) => a - b).join(',') : 'all'}${includeNativeShape ? '' : ':without-native'}:${runs}`, () => s.engine.formatting(pages, runs, includeNativeShape), runs === 'model');
      });
    };
    const queryObjectResource = (path: string, target: ObjectResourceTarget, options: { expectedRevision: number }): Promise<ObjectResource> => {
      return run(path, s => { this.expect(s, this.expectedRevisionOption(options, 'objectResource')); this.expectAddressContext(s, target?.address); return s.engine.objectResource(target); });
    };
    const querySelectNode = (path: string, selector: NodeSelector, context: QueryContext): Promise<NodeSelection> => run(path, s => {
      this.expectQueryContext(s, context); return s.engine.selectNode(selector);
    });
    const querySelectText = (path: string, target: TextSelectionTarget, context: QueryContext): Promise<TextSelection> => run(path, s => {
      this.expectQueryContext(s, context); this.expectAddressContext(s, target?.address); return s.engine.selectText(target);
    });
    this.api = {
      version: 1, engineVersion: ENGINE_VERSION,
      documents: {
        open: path => this.run(path, async path => { const s = await this.session(path); s.references++; s.legacyReferences++; return this.state(s); }),
        acquire: path => this.acquireLease(path),
        state: path => run(path, s => this.state(s)),
        list: () => [...this.sessions.values()].map(s => this.state(s)),
        create: path => this.run(path, async path => {
          await this.engineProvider.initialize(); const engine = await this.engineProvider.blank();
          let warnings: string[];
          try { const output = await this.readableExport(engine, path, this.options.maxFileBytes); warnings = output.warnings; await this.storage.create(path, output.bytes); } finally { await engine.free(); }
          return { ...this.state(await this.session(path)), warnings };
        }),
        close: path => this.withAutosavePathsPaused([path], 'close', () => this.run(path, async path => {
          const s = this.sessions.get(path); if (!s) return;
          if (s.dirty) throw new HwpHandsError('UNSAVED_CHANGES', '저장되지 않은 변경이 있습니다. 저장하거나 reload로 명시적으로 버린 뒤 닫으세요.');
          if (s.legacyReferences > 0) { s.legacyReferences--; s.references--; }
          else if (s.references > 0) throw new HwpHandsError('INVALID_ARGUMENT', '다른 화면 또는 API 소비자가 이 세션을 사용 중입니다.');
          else { await this.closeSession(s); return; }
          if (s.references === 0) await this.closeSession(s);
        })),
        reload: (path, options) => this.withAutosavePathsPaused([path], 'reload', () => run(path, s => {
          const value = this.optionsRecord(options, 'reload', true);
          return this.reload(s, this.optionalBoolean(value, 'discardChanges'));
        })),
        save: (path, options) => this.withAutosavePathsPaused([path], 'manual-save', () => run(path, s => this.withAutosavePaused(s, 'manual-save', () => this.save(s, this.expectedRevisionOption(options, 'save'))))),
        saveAs: (path, destination, options) => this.withAutosavePathsPaused([path, destination], 'save-as', () => this.runPaths([path, destination], async () => {
          const source = documentPath(path), target = documentPath(destination);
          const s = await this.session(source);
          this.expect(s, this.expectedRevisionOption(options, 'saveAs'));
          return this.withAutosavePaused(s, 'save-as', async () => {
            s.activeGroup = undefined;
            if (target === s.path) throw new HwpHandsError('INVALID_ARGUMENT', '새 파일 경로를 사용하세요.');
            if (this.sessions.has(target)) throw new HwpHandsError('FILE_CONFLICT', '대상 문서 세션이 이미 열려 있습니다.');
            const { bytes, warnings } = await this.readableExport(s.engine, target, this.options.maxFileBytes, s.sourceGuard, s.sectionTails); await this.storage.create(target, bytes);
            return { ...this.state(await this.session(target)), warnings };
          });
        }))
      },
      query: {
        outputAnchorCandidates: async (path, archiveSha256, anchors) => this.previewRootOutputAnchors(path, archiveSha256, anchors),
        outputAnchorCandidatesIfOpen: async (path, archiveSha256, anchors) => this.previewRootOutputAnchors(path, archiveSha256, anchors, true),
        text: path => run(path, s => s.engine.allText()),
        paragraphs: queryParagraphs,
        tables: path => run(path, s => s.engine.tables()),
        tableCoverage: (path, table, context) => run(path, async s => {
          this.expectQueryContext(s, context); this.expectAddressContext(s, table);
          const key = `table-coverage:${s.revision}:${table.section}:${table.paragraph}:${table.control}`;
          return { sessionId: s.sessionId, revision: s.revision, ...await this.cachedQuery(s, key, () => s.engine.tableCoverage(table)) };
        }),
        fields: path => run(path, s => s.engine.fields()),
        controls: path => run(path, s => s.engine.controls()),
        objects: path => run(path, s => s.engine.objects(undefined, true)),
        capabilities: path => run(path, s => this.capabilities(s)),
        formatting: queryFormatting,
        outline: path => run(path, s => s.engine.outline()),
        metadata: path => run(path, s => s.engine.metadata()),
        tree: path => run(path, async s => ({ state: this.state(s), ...await this.cachedQuery(s, `tree:${s.revision}`, () => s.engine.tree(), true) })),
        structure: queryStructure,
        snapshot: (path, options) => run(path, async s => ({ state: this.state(s), ...await s.engine.documentSnapshot({ pages: this.optionalPages(this.optionsRecord(options, 'snapshot', true), 'snapshot') }) })),
        search: querySearch,
        layout: (path, page) => run(path, s => this.cachedQuery(s, `layout:${s.revision}:${page}`, () => s.engine.layout(page))),
        verify: (path, options) => run(path, async s => {
          const value = this.optionsRecord(options, 'verify'), expectedRevision = this.expectedRevisionOption(value, 'verify');
          this.expect(s, expectedRevision);
          const targetFormat = value.format ?? this.state(s).format;
          if (targetFormat !== 'hwp' && targetFormat !== 'hwpx') throw new HwpHandsError('INVALID_ARGUMENT', 'format must be hwp or hwpx.');
          const pages = await this.verifyPages(s.engine, { ...value, expectedRevision });
          const result = await this.inspectExport(s.engine, pathWithFormat(s.path, targetFormat), this.state(s).format, pages);
          delete result.bytes;
          return { ...this.state(s), ...result };
        }),
        objectResource: queryObjectResource,
        selectNode: querySelectNode,
        selectText: querySelectText,
        hitTest: (path, point, context) => run(path, s => {
          this.expectQueryContext(s, context); return s.engine.hitTest(point);
        }),
        caret: (path, position, context, options) => run(path, s => {
          this.expectQueryContext(s, context); this.expectAddressContext(s, position?.address);
          const value = this.optionsRecord(options, 'caret', true), pageHint = value.pageHint;
          if (pageHint !== undefined) integer(pageHint as number, 'pageHint');
          return s.engine.caret(position, { ...(pageHint === undefined ? {} : { pageHint: pageHint as number }) });
        }),
        selectionRects: (path, range, context) => run(path, s => {
          this.expectQueryContext(s, context); this.expectAddressContext(s, range?.start?.address); this.expectAddressContext(s, range?.end?.address);
          return s.engine.selectionRects(range);
        }),
        copy: (path, range, context) => run(path, s => {
          this.expectQueryContext(s, context); this.expectAddressContext(s, range?.start?.address); this.expectAddressContext(s, range?.end?.address);
          return s.engine.copy(range);
        }),
        equationPreview: (path, script, context, options) => run(path, s => {
          this.expectQueryContext(s, context);
          const value = this.optionsRecord(options, 'equationPreview', true);
          const fontSize = value.fontSize ?? 12, color = value.color ?? '#202020';
          if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize < 1 || fontSize > 1000) throw new HwpHandsError('INVALID_ARGUMENT', 'fontSize must be 1–1000pt.');
          if (typeof color !== 'string' || !/^#?[\da-f]{6}$/i.test(color)) throw new HwpHandsError('INVALID_ARGUMENT', 'color must use #RRGGBB.');
          return s.engine.renderEquationPreview(script, Math.round(fontSize * 100), Number.parseInt(color.replace(/^#/, ''), 16));
        }),
        moveCaret: (path, position, motion, options) => run(path, s => {
          this.expectQueryContext(s, options); this.expectAddressContext(s, position?.address);
          if (options?.pageHint !== undefined) integer(options.pageHint, 'pageHint');
          return s.engine.moveCaret(position, motion, options?.preferredX, options?.pageHint);
        }),
        navigateHeaderFooterPage: (path, currentPage, isHeader, direction, context) => run(path, s => {
          this.expectQueryContext(s, context);
          return s.engine.navigateHeaderFooterPage(currentPage, isHeader, direction);
        }),
      },
      edit: {
        transaction: (path, commands, options) => run(path, s => this.transaction(s, commands, options)),
        undo: (path, options) => run(path, s => this.history(s, this.expectedRevisionOption(options, 'undo'), false)),
        redo: (path, options) => run(path, s => this.history(s, this.expectedRevisionOption(options, 'redo'), true))
      },
      render: { page: (path, page, options?: PageRenderOptions) => run(path, s => {
        const value = this.optionsRecord(options, 'render', true);
        const renderOptions: PageRenderOptions = {
          showParagraphMarks: this.optionalBoolean(value, 'showParagraphMarks'),
          showControlCodes: this.optionalBoolean(value, 'showControlCodes'),
          showTransparentBorders: this.optionalBoolean(value, 'showTransparentBorders'),
          showOverflow: this.optionalBoolean(value, 'showOverflow'),
        };
        const optionKey = `${Number(renderOptions.showParagraphMarks)}${Number(renderOptions.showControlCodes)}${Number(renderOptions.showTransparentBorders)}${Number(renderOptions.showOverflow)}`;
        return this.cachedQuery(s, `render:${s.revision}:${page}:${optionKey}`, async () => {
          const [render, layout] = await Promise.all([s.engine.page(page, renderOptions), this.cachedQuery(s, `layout:${s.revision}:${page}`, () => s.engine.layout(page))]);
          return { revision: s.revision, ...render, layout };
        });
      }) },
      index: {
        refresh: path => run(path, async s => {
          if (s.dirty || s.conflict) throw new HwpHandsError('UNSAVED_CHANGES', '원본을 먼저 저장하세요.');
          await this.checkDisk(s); return this.index(s);
        }),
        status: path => {
          const source = documentPath(path);
          return this.runPaths([source], async () => {
            const bytes = await this.storage.read(source), sourceSha256 = hash(bytes), indexPath = `${source}.index.md`;
            const content = await this.storage.readIndex?.(indexPath);
            if (content === undefined) return { path: source, indexPath, state: 'missing', sourceSha256 } satisfies IndexStatus;
            const inspection = inspectIndex(content);
            if (inspection.state !== 'managed') return { path: source, indexPath, state: inspection.state, sourceSha256 } satisfies IndexStatus;
            return {
              path: source, indexPath,
              state: inspection.source === source && inspection.sourceSha256 === sourceSha256 ? 'current' : 'stale',
              sourceSha256, indexSourceSha256: inspection.sourceSha256
            } satisfies IndexStatus;
          });
        }
      },
      events: { on: (type, listener) => {
        if (type !== '*' && !EVENT_TYPES.has(type)) throw new HwpHandsError('INVALID_ARGUMENT', 'Unknown document event type.');
        if (typeof listener !== 'function') throw new HwpHandsError('INVALID_ARGUMENT', 'An event listener function is required.');
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(listener); return () => { this.listeners.get(type)?.delete(listener); };
      } }
    };
  }
  /** Internal display projection. The transferable is never placed in the query cache. */
  renderCanvasPage(path: string, page: number, scale: number, context: QueryContext, options?: PageRenderOptions) {
    return this.run(path, async path => {
      const s = await this.session(path);
      this.expectQueryContext(s, context);
      const result = await s.engine.canvasPage(page, scale, options);
      return { ...result, revision: s.revision, sessionId: s.sessionId };
    });
  }
  /** Internal preview; it does not mint an observation or authorize an edit. */
  previewRootOutputAnchors(input: string, archiveSha256: string, anchors: readonly RootOutputAnchor[], requireOpen = false) {
    if (typeof archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(archiveSha256))
      throw new HwpHandsError('INVALID_ARGUMENT', 'Invalid output archive hash.');
    const fixed = copyRootOutputAnchors(anchors);
    return this.run(input, async path => {
      const s = requireOpen ? this.sessions.get(path) : await this.session(path);
      if (!s) throw new HwpHandsError('NOT_FOUND', 'The document session is not open.');
      if (this.state(s).format !== 'hwpx' || s.dirty || s.conflict || s.baseHash !== archiveSha256)
        throw new HwpHandsError('FILE_CONFLICT', 'The open document does not match the output archive.');
      const readCurrent = () => requireOpen
        ? this.storage.readBounded?.(path, this.options.maxFileBytes) ?? Promise.reject(new HwpHandsError('VERIFY_FAILED', 'Bounded document reading is unavailable.'))
        : this.storage.read(path);
      if (hash(await readCurrent()) !== archiveSha256)
        throw new HwpHandsError('FILE_CONFLICT', 'The output file changed.');
      const revision = s.revision, sessionId = s.sessionId;
      const candidates = rootOutputCandidates(await s.engine.paragraphs(), fixed);
      if (s.revision !== revision || s.sessionId !== sessionId || s.dirty || s.conflict ||
          s.baseHash !== archiveSha256 || hash(await readCurrent()) !== archiveSha256)
        throw new HwpHandsError('FILE_CONFLICT', 'The document changed during output coordinate inspection.');
      return this.stampResult(s, { archiveSha256, sessionId, revision, candidates });
    });
  }

  private run<T>(input: string, callback: (path: string) => Promise<T>): Promise<T> {
    const path = documentPath(input);
    return this.runPaths([path], async () => callback(path));
  }
  private runPaths<T>(inputs: string[], callback: (paths: string[]) => Promise<T>, ignoreTransitions = false): Promise<T> {
    const paths = [...new Set(inputs.map(documentPath))].sort();
    if (this.disposed) return Promise.reject(new HwpHandsError('CLOSED', '플러그인이 종료되었습니다.'));
    if (!ignoreTransitions) {
      const transitions = this.transitions.filter(t => paths.some(path => t.prefixes.some(prefix => within(path, prefix))));
      if (transitions.length) return Promise.all(transitions.map(t => t.promise)).then(() => this.runPaths(paths, callback));
    }
    const previous = Promise.all(paths.map(path => this.pending.get(path) ?? Promise.resolve()));
    const current = previous.catch(() => undefined).then(async () => {
      if (this.disposed) throw new HwpHandsError('CLOSED', '플러그인이 종료되었습니다.');
      for (const path of paths) this.cancelIdle(this.sessions.get(path));
      try { return await callback(paths); } catch (error) {
        if (error instanceof HwpHandsError) throw error;
        throw new HwpHandsError('ENGINE_ERROR', error instanceof Error ? error.message : String(error));
      } finally { for (const path of paths) this.scheduleIdle(path); }
    });
    for (const path of paths) this.pending.set(path, current);
    void current.then(() => paths.forEach(path => this.finish(path, current)), () => paths.forEach(path => this.finish(path, current)));
    return current;
  }
  private finish(path: string, current: Promise<unknown>): void { if (this.pending.get(path) === current) this.pending.delete(path); }
  private async cachedQuery<T>(s: Session, key: string, load: () => T | Promise<T>, carry = false): Promise<T> {
    const cached = s.queryCache.get(key);
    if (cached) {
      s.queryCache.delete(key); s.queryCache.set(key, cached);
      return structuredClone(cached.value) as T;
    }
    const kept = s.typingCarry.get(key);
    if (kept) return structuredClone(kept.value) as T;
    const value = await load();
    const bytes = estimateCacheBytes(value, carry ? TYPING_CARRY_MAX_ENTRY_BYTES : QUERY_CACHE_MAX_ENTRY_BYTES);
    if (!bytes) return value;
    if (bytes > QUERY_CACHE_MAX_ENTRY_BYTES) {
      if (carry && bytes <= TYPING_CARRY_MAX_ENTRY_BYTES) {
        const kind = key.slice(0, key.indexOf(':'));
        for (const other of [...s.typingCarry.keys()]) if (other.startsWith(`${kind}:`)) s.typingCarry.delete(other);
        s.typingCarry.set(key, { value: structuredClone(value), bytes });
      }
      return value;
    }
    while (s.queryCache.size && s.queryCacheBytes + bytes > QUERY_CACHE_MAX_BYTES) {
      const oldest = s.queryCache.keys().next().value;
      if (oldest === undefined) break;
      const removed = s.queryCache.get(oldest)!;
      s.queryCache.delete(oldest); s.queryCacheBytes -= removed.bytes;
    }
    s.queryCache.set(key, { value: structuredClone(value), bytes }); s.queryCacheBytes += bytes;
    return value;
  }
  private clearQueryCache(s: Session, predicate: (key: string) => boolean = () => true): void {
    for (const [key, entry] of s.queryCache) if (predicate(key)) { s.queryCache.delete(key); s.queryCacheBytes -= entry.bytes; }
    for (const key of [...s.typingCarry.keys()]) if (predicate(key)) s.typingCarry.delete(key);
  }
  invalidateRenderingCaches(path?: string): void {
    const selected = path === undefined ? [...this.sessions.values()] : [this.sessions.get(documentPath(path))].filter((session): session is Session => !!session);
    for (const s of selected) this.clearQueryCache(s, key => key.startsWith('layout:') || key.startsWith('render:'));
  }
  private maxRecoveryBytes(): number { return Math.max(1024 * 1024, this.options.maxFileBytes * 2); }
  private decodeRecovery(record: Recovery, path: string): DecodedRecovery {
    if (!record || typeof record !== 'object') throw new HwpHandsError('VERIFY_FAILED', '복구 기록 형식이 올바르지 않습니다.');
    const maxBytes = this.maxRecoveryBytes();
    if (record.version === 3) {
      if (record.path !== path || typeof record.baseHash !== 'string' || !HASH_PATTERN.test(record.baseHash) || typeof record.seedHash !== 'string' || !HASH_PATTERN.test(record.seedHash) || typeof record.recordHash !== 'string' || !HASH_PATTERN.test(record.recordHash) || typeof record.tailHash !== 'string' || !HASH_PATTERN.test(record.tailHash)) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 경로 또는 해시가 올바르지 않습니다. 기존 기록을 보존했습니다.');
      if (typeof record.pluginVersion !== 'string' || !record.pluginVersion || record.pluginVersion.length > 64 || record.engineVersion !== ENGINE_VERSION || record.commandSchema !== COMMAND_SCHEMA_VERSION) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 플러그인·엔진·명령 스키마 버전을 지원하지 않습니다. 기존 기록을 보존했습니다.');
      if (!Number.isInteger(record.historyLimit) || record.historyLimit < 1 || record.historyLimit > 100 || !Number.isInteger(record.seedBytes) || record.seedBytes < 1 || record.seedBytes > this.options.maxFileBytes || !Number.isSafeInteger(record.sequence) || record.sequence < 0 || record.sequence > MAX_RECOVERY_ACTIONS || !Array.isArray(record.actions) || record.sequence !== record.actions.length || typeof record.truncatedTail !== 'boolean' || (record.intendedSaveHash !== undefined && !HASH_PATTERN.test(record.intendedSaveHash))) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 크기 또는 설정값이 올바르지 않습니다.');
      if (typeof record.seed !== 'string' || record.seed.length > Math.ceil(this.options.maxFileBytes * 4 / 3) + 4 || Buffer.byteLength(JSON.stringify(record), 'utf8') > maxBytes) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 크기가 제한을 초과합니다.');
      const seed = decodeBase64(record.seed, 'seed');
      const { actions, commandCount } = validateRecoveryActions(record.actions);
      if (!seed.byteLength || seed.byteLength !== record.seedBytes || seed.byteLength > this.options.maxFileBytes || hash(seed) !== record.seedHash || commandCount > MAX_RECOVERY_COMMANDS) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 seed 무결성 또는 크기가 올바르지 않습니다.');
      const { actions: _actions, sequence: _sequence, tailHash: _tailHash, truncatedTail: _truncatedTail, recordHash: _recordHash, ...headerFields } = record;
      const expectedHeader = createRecoveryV3Header(headerFields);
      if (record.recordHash !== expectedHeader.recordHash) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 manifest 해시 검증에 실패했습니다.');
      let expectedTail = expectedHeader.recordHash;
      for (let index = 0; index < actions.length; index++) expectedTail = createRecoveryV3Line(index + 1, expectedTail, actions[index]).hash;
      if (record.tailHash !== expectedTail) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 hash chain 검증에 실패했습니다.');
      return {
        path, baseHash: record.baseHash, seed, actions, actors: record.actors === undefined ? undefined : validatePersistedActors(record.actors), historyLimit: record.historyLimit, intendedSaveHash: record.intendedSaveHash,
        migrated: record.pluginVersion !== this.pluginVersion || !this.storage.appendRecovery,
        journalSequence: record.sequence, journalTailHash: record.tailHash, journalNeedsRewrite: record.truncatedTail,
      };
    }
    if (record.version === 1) {
      if (record.path !== path || typeof record.baseHash !== 'string' || !HASH_PATTERN.test(record.baseHash) || typeof record.seedHash !== 'string' || !HASH_PATTERN.test(record.seedHash)) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 경로 또는 해시가 올바르지 않습니다.');
      if (!Number.isInteger(record.historyLimit) || record.historyLimit < 1 || record.historyLimit > 100 || (record.intendedSaveHash !== undefined && !HASH_PATTERN.test(record.intendedSaveHash))) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 설정값이 올바르지 않습니다.');
      if (typeof record.seed !== 'string' || record.seed.length > Math.ceil(this.options.maxFileBytes * 4 / 3) + 4 || Buffer.byteLength(JSON.stringify(record), 'utf8') > maxBytes) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 크기가 제한을 초과합니다.');
      const seed = decodeBase64(record.seed, 'seed');
      const { actions, commandCount } = validateRecoveryActions(record.actions);
      if (!seed.byteLength || seed.byteLength > this.options.maxFileBytes || hash(seed) !== record.seedHash || commandCount > MAX_RECOVERY_COMMANDS) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 seed 무결성 또는 크기가 올바르지 않습니다.');
      return { path, baseHash: record.baseHash, seed, actions, historyLimit: record.historyLimit, intendedSaveHash: record.intendedSaveHash, migrated: true };
    }
    if (record.version !== 2) throw new HwpHandsError('VERIFY_FAILED', '지원하지 않는 복구 기록 버전입니다. 기존 복구 파일을 보존했습니다.');
    if (record.path !== path || typeof record.baseHash !== 'string' || !HASH_PATTERN.test(record.baseHash) || typeof record.seedHash !== 'string' || !HASH_PATTERN.test(record.seedHash) || typeof record.payloadHash !== 'string' || !HASH_PATTERN.test(record.payloadHash) || typeof record.recordHash !== 'string' || !HASH_PATTERN.test(record.recordHash)) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 경로 또는 해시가 올바르지 않습니다.');
    if (typeof record.pluginVersion !== 'string' || !record.pluginVersion || record.pluginVersion.length > 64 || record.engineVersion !== ENGINE_VERSION || record.commandSchema !== COMMAND_SCHEMA_VERSION) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 플러그인·엔진·명령 스키마 버전을 지원하지 않습니다. 기존 복구 파일을 보존했습니다.');
    if (!Number.isInteger(record.historyLimit) || record.historyLimit < 1 || record.historyLimit > 100 || !Number.isInteger(record.seedBytes) || record.seedBytes < 1 || record.seedBytes > this.options.maxFileBytes || !Number.isInteger(record.actionCount) || record.actionCount < 0 || record.actionCount > MAX_RECOVERY_ACTIONS || !Number.isInteger(record.commandCount) || record.commandCount < 0 || record.commandCount > MAX_RECOVERY_COMMANDS || !Number.isInteger(record.payloadBytes) || record.payloadBytes < 1 || record.payloadBytes > maxBytes || !Number.isInteger(record.expandedBytes) || record.expandedBytes < 1 || record.expandedBytes > maxBytes || (record.intendedSaveHash !== undefined && !HASH_PATTERN.test(record.intendedSaveHash))) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 크기 또는 설정값이 올바르지 않습니다.');
    if (typeof record.payload !== 'string' || record.payload.length > Math.ceil(maxBytes * 4 / 3) + 4 || record.payload.length + path.length + 2048 > maxBytes) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 payload 크기가 제한을 초과합니다.');
    const compressed = decodeBase64(record.payload, 'payload');
    if (compressed.byteLength !== record.payloadBytes || hash(compressed) !== record.payloadHash) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 payload 해시 또는 크기가 올바르지 않습니다.');
    const { recordHash: _recordHash, ...recordBody } = record;
    if (recoveryRecordHash(recordBody) !== record.recordHash) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 메타데이터 검사에 실패했습니다.');
    let expanded: Uint8Array;
    try { expanded = inflateSync(compressed, { maxOutputLength: maxBytes }); }
    catch (error) { throw new HwpHandsError('VERIFY_FAILED', '복구 기록 압축 데이터를 풀 수 없습니다.', String(error)); }
    if (expanded.byteLength !== record.expandedBytes) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 압축 해제 크기가 일치하지 않습니다.');
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(expanded).toString('utf8')); }
    catch (error) { throw new HwpHandsError('VERIFY_FAILED', '복구 기록 payload JSON이 올바르지 않습니다.', String(error)); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['seed', 'actions', 'actors'].includes(key)) || !('seed' in payload) || !('actions' in payload)) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 payload 필드가 올바르지 않습니다.');
    const content = payload as { seed: unknown; actions: unknown; actors?: unknown }, seed = decodeBase64(content.seed, 'seed');
    const { actions, commandCount } = validateRecoveryActions(content.actions);
    if (seed.byteLength !== record.seedBytes || hash(seed) !== record.seedHash || actions.length !== record.actionCount || commandCount !== record.commandCount) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 seed 또는 명령 지문이 일치하지 않습니다.');
    return { path, baseHash: record.baseHash, seed, actions, actors: content.actors === undefined ? undefined : validatePersistedActors(content.actors), historyLimit: record.historyLimit, intendedSaveHash: record.intendedSaveHash, migrated: record.pluginVersion !== this.pluginVersion || !!this.storage.appendRecovery };
  }
  private async session(path: string): Promise<Session> {
    const existing = this.sessions.get(path); if (existing) return existing;
    await this.engineProvider.initialize(); const bytes = await this.storage.read(path);
    if (bytes.byteLength > this.options.maxFileBytes) throw new HwpHandsError('INVALID_ARGUMENT', '문서가 설정된 최대 크기를 초과합니다.');
    const diskHash = hash(bytes), recoveryRecord = await this.storage.readRecovery(path, this.maxRecoveryBytes()), recovery = recoveryRecord ? this.decodeRecovery(recoveryRecord, path) : undefined;
    const replayRecovery = !!recovery?.actions.length && recovery.intendedSaveHash !== diskHash;
    const seed = replayRecovery ? recovery.seed : bytes;
    const sourceGuard = hwpSourceGuard(path, bytes, replayRecovery ? seed : undefined);
    if (sourceGuard === 'tracked') assertHwpSourceSafe(sourceGuard);
    const engine = await this.engineProvider.parse(seed);
    let pageCount: number;
    try {
      if (/\.hwpx$/i.test(path) && (await engine.paragraphRange(0, 1)).total === 0) {
        throw new HwpHandsError('VERIFY_FAILED', 'HWPX section XML produced no body paragraphs; the document was not opened to prevent presenting malformed content as an empty file.');
      }
      pageCount = await engine.pages();
    } catch (error) { await engine.free(); throw error; }
    const s: Session = {
      path, sessionId: randomUUID(), engine, pageCount, revision: ++this.sequence, references: 0, legacyReferences: 0,
      dirty: false, conflict: false, baseHash: diskHash, sourceGuard,
      sectionTails: /\.hwp$/i.test(path) ? inspectSectionTails(replayRecovery && recovery.baseHash !== diskHash ? seed : bytes) : { status: 'clear' },
      undo: [], redo: [], origins: new Map(), actorLedger: new EditActorLedger(), seed, actions: [], actionBytes: 2, commandCount: 0,
      historyLimit: this.options.historyLimit, journalSequence: recovery?.journalSequence, journalTailHash: recovery?.journalTailHash,
      journalActionCount: recovery?.journalSequence ?? 0, journalNeedsRewrite: recovery?.journalNeedsRewrite,
      journalIntendedSaveHash: replayRecovery ? recovery?.intendedSaveHash : undefined,
      queryCache: new Map(), queryCacheBytes: 0, typingCarry: new Map(),
    };
    try {
      if (replayRecovery && recovery) {
        const legacyActors = !recovery.actors || recovery.actions.some(action => 'commands' in action && !action.actor);
        const actorState = recovery.actors ?? { version: 1 as const,
          seed: hash(seed) === recovery.baseHash ? [] : [{ id: 'legacy-seed:' + hash(seed), actor: { kind: 'unknown' as const } }], approved: [] };
        recovery.actions = recovery.actions.map((action, index) => 'commands' in action && !action.actor
          ? { ...action, actor: { kind: 'unknown' as const }, editId: 'legacy:' + hash(seed).slice(0, 32) + ':' + index } : action);
        const actorIds = [...actorState.seed.map(entry => entry.id), ...recovery.actions.flatMap(action => 'commands' in action ? [action.editId!] : [])];
        if (new Set(actorIds).size !== actorIds.length || actorState.approved.some(id => !actorIds.includes(id))) throw new HwpHandsError('VERIFY_FAILED', '복구 원장의 편집 식별자/저장 승인 참조가 올바르지 않습니다.');
        s.actorLedger = new EditActorLedger(actorState.seed, actorState.approved);
        if (legacyActors) { recovery.migrated = true; s.journalNeedsRewrite = true; }
        s.baseHash = recovery.baseHash;
        s.historyLimit = Math.min(100, Math.max(1, recovery.historyLimit));
        for (const [actionIndex, action] of recovery.actions.entries()) {
          if ('commands' in action) {
            if (action.groupId !== undefined && action.undoBoundary === false) {
              try { for (const command of action.commands) await s.engine.execute(command); }
              catch (error) { throw new HwpHandsError('VERIFY_FAILED', `복구 작업 ${actionIndex + 1}을 재생할 수 없습니다.`, String(error)); }
              s.actorLedger.apply(action.actor!, action.editId!);
              continue;
            }
            const snapshot = await s.engine.snapshot();
            s.actorLedger.capture(snapshot);
            try { for (const command of action.commands) await s.engine.execute(command); }
            catch (error) { await s.engine.restore(snapshot); await this.discardSnapshot(s, snapshot); throw new HwpHandsError('VERIFY_FAILED', `복구 작업 ${actionIndex + 1}을 재생할 수 없습니다.`, String(error)); }
            s.actorLedger.apply(action.actor!, action.editId!);
            s.undo.push(snapshot); s.origins.set(snapshot, actionIndex); await this.trim(s, s.undo); await this.clearHistory(s, s.redo);
          } else {
            const from = action.history === 'redo' ? s.redo : s.undo, to = action.history === 'redo' ? s.undo : s.redo;
            if (!from.length) throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 실행 취소 순서가 올바르지 않습니다.');
            const current = await s.engine.snapshot(), target = from.pop()!;
            s.actorLedger.capture(current);
            try { await s.engine.restore(target); } catch (error) { await this.discardSnapshot(s, current); throw new HwpHandsError('VERIFY_FAILED', `복구 작업 ${actionIndex + 1}을 재생할 수 없습니다.`, String(error)); }
            s.actorLedger.restore(target);
            await this.discardSnapshot(s, target); s.origins.delete(target); to.push(current); s.origins.set(current, actionIndex); await this.trim(s, to);
          }
        }
        s.pageCount = await s.engine.pages();
        s.actions = recovery.actions; s.actionBytes = actionsSize(s.actions); s.commandCount = s.actions.reduce((count, action) => count + ('commands' in action ? action.commands.length : 0), 0); s.dirty = true; s.soleAiActor = null; s.conflict = diskHash !== s.baseHash;
        s.recoveredUnasked = true;
        if (recovery.migrated) { try { await this.persistRecovery(s); } catch (error) { console.error('HWP Hands recovery migration:', error); } }
      } else if (recoveryRecord) { await this.storage.removeRecovery(path); }
    } catch (error) { await this.release(s); throw error; }
    this.sessions.set(path, s); this.emit('opened', s); return s;
  }
  private state(s: Session): State {
    return { path: s.path, format: /\.hwpx$/i.test(s.path) ? 'hwpx' : 'hwp', sessionId: s.sessionId, revision: s.revision, dirty: s.dirty, conflict: s.conflict, pageCount: s.pageCount, canUndo: !!s.undo.length, canRedo: !!s.redo.length };
  }
  private stampResult<T>(s: Session, value: T): T {
    const stamp = (item: unknown): unknown => {
      if (!item || typeof item !== 'object' || ArrayBuffer.isView(item)) return item;
      if (Array.isArray(item)) return item.map(stamp);
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(item)) result[key] = stamp(nested);
      const kind = result.kind;
      if ((kind === 'body' || kind === 'headerFooter' || kind === 'footnote' || kind === 'endnote') && Number.isSafeInteger(result.section) && Number.isSafeInteger(result.paragraph)) {
        result.sessionId = s.sessionId; result.revision = s.revision;
      }
      if (Number.isSafeInteger(result.fieldId) && typeof result.name === 'string') {
        result.sessionId = s.sessionId; result.revision = s.revision;
      }
      return result;
    };
    return stamp(value) as T;
  }
  private optionsRecord(value: unknown, label: string, optional = false): Record<string, unknown> {
    if (value === undefined && optional) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HwpHandsError('INVALID_ARGUMENT', `${label} options must be an object.`);
    return value as Record<string, unknown>;
  }
  private optionalBoolean(options: Record<string, unknown>, key: string): boolean {
    const value = options[key];
    if (value === undefined) return false;
    if (typeof value !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be a boolean.`);
    return value;
  }
  private optionalPages(options: Record<string, unknown>, label: string): number[] | undefined {
    const pages = options.pages;
    if (pages === undefined) return undefined;
    if (!Array.isArray(pages)) throw new HwpHandsError('INVALID_ARGUMENT', `${label} pages must be an array of page indices.`);
    return pages as number[];
  }
  private expectedRevisionOption(options: unknown, label: string): number {
    const value = this.optionsRecord(options, label).expectedRevision;
    integer(value as number, 'expectedRevision');
    return value as number;
  }
  private emit(type: EventType, s: Session, extras: Partial<DocumentEvent> = {}): void {
    this.syncAutosave(type, s);
    const event: DocumentEvent = { type, state: this.state(s), ...extras };
    for (const listener of [...(this.listeners.get(type) ?? []), ...(this.listeners.get('*') ?? [])]) {
      try { listener(structuredClone(event)); } catch (error) { console.error('HWP Hands event listener:', error); }
    }
  }
  private syncAutosave(type: EventType, s: Session): void {
    if (type === 'closed') { this.inputReaders.delete(s.sessionId); this.inputGenerations.delete(s.sessionId); }
    if (!this.autosave) return;
    let document = this.autosaveDocuments.get(s.sessionId);
    if (type === 'closed') {
      document?.dispose(); this.autosaveDocuments.delete(s.sessionId); return;
    }
    if (!document) {
      document = this.autosave.track(s.sessionId, s.path, () => ({
        revision: s.revision, dirty: s.dirty,
        blockedReason: this.disposed || this.sessions.get(s.path) !== s ? 'session-closed'
          : this.transitions.some(t => t.prefixes.some(prefix => within(s.path, prefix))) ? 'path-transition'
          : s.conflict ? 'file-conflict' : s.actorLedger.blockReason() ?? this.autosaveOptions!.blockReason(this.state(s)),
      }));
      this.autosaveDocuments.set(s.sessionId, document);
    }
    if (type === 'renamed') document.relocate(s.path);
    else document.changed();
  }
  /** Looks up an existing incarnation; it never queries by path or reopens a closed session. */
  observeAutosaveInput(sessionId: string, read: () => AutosaveInput): AutosaveViewHandle {
    if (this.disposed || ![...this.sessions.values()].some(s => s.sessionId === sessionId)) return { changed() {}, dispose() {} };
    const readers = this.inputReaders.get(sessionId) ?? new Set<() => AutosaveInput>(), reader = () => read();
    this.inputReaders.set(sessionId, readers); readers.add(reader);
    const bump = () => this.inputGenerations.set(sessionId, (this.inputGenerations.get(sessionId) ?? 0) + 1);
    bump();
    const autosave = this.autosaveDocuments.get(sessionId)?.attachView(reader);
    let active = true;
    return { changed: () => { if (active && this.inputReaders.get(sessionId) === readers) { bump(); autosave?.changed(); } },
      dispose: () => { if (active) { active = false; readers.delete(reader); if (this.inputReaders.get(sessionId) === readers) bump(); autosave?.dispose(); } } };
  }
  /** Internal: the commands of every applied transaction, so the agent facade can keep handles across a person's edits. Not public API. */
  observeApplied(listener: (edit: AppliedEdit) => void): () => void {
    this.appliedListeners.add(listener);
    return () => { this.appliedListeners.delete(listener); };
  }
  /**
   * Recovery records of documents that are not open and hold AI edits no person saved. Opening such a document replays them.
   * Reads the records only; nothing is opened, replayed or removed.
   */
  async recoveredAiEdits(maxBytes = 16 * 1024 * 1024): Promise<Array<{ path: string; aiEdits: number }>> {
    const records = await this.storage.recoveryRecords?.(maxBytes) ?? [];
    return records.flatMap(record => {
      const aiEdits = unapprovedAiEdits(record);
      return aiEdits && typeof record.path === 'string' && !this.sessions.has(record.path) ? [{ path: record.path, aiEdits }] : [];
    }).sort((a, b) => a.path.localeCompare(b.path));
  }
  /** True while any view of the session has composition, an unflushed draft or a running input task. */
  humanInputActive(sessionId: string): boolean { return !this.stableInput(sessionId); }
  /** Edits since the last approved save that no person made. Zero for an unknown session. */
  pendingActorEdits(sessionId: string): { ai: number; unknown: number } {
    const pending = [...this.sessions.values()].find(s => s.sessionId === sessionId)?.actorLedger.current() ?? [];
    return { ai: pending.filter(entry => entry.actor.kind === 'ai').length, unknown: pending.filter(entry => entry.actor.kind === 'unknown').length };
  }
  private stableInput(sessionId: string): boolean {
    try { return [...(this.inputReaders.get(sessionId) ?? [])].every(read => { const input = read(); return !input.composing && !input.pending && !input.busy; }); }
    catch { return false; }
  }
  autosaveStatus(sessionId: string): AutosaveStatus | undefined { return this.autosaveDocuments.get(sessionId)?.status(); }
  /** Passive session subscription; no path lookup, queue entry, input notification or new session. */
  observeAutosaveStatus(sessionId: string, listener: (status: AutosaveStatus) => void): () => void {
    const document = this.autosaveDocuments.get(sessionId);
    if (!document || this.disposed) return () => {};
    const observers = this.autosaveListeners.get(sessionId) ?? new Set<(status: AutosaveStatus) => void>();
    this.autosaveListeners.set(sessionId, observers);
    // Independent subscriptions even when the same callback is registered twice.
    const observer = (status: AutosaveStatus) => listener(status);
    observers.add(observer); this.deliverAutosaveStatus(observer, document.status());
    return () => {
      observers.delete(observer);
      if (!observers.size && this.autosaveListeners.get(sessionId) === observers) this.autosaveListeners.delete(sessionId);
    };
  }
  private deliverAutosaveStatus(listener: (status: AutosaveStatus) => void, status: AutosaveStatus): void {
    try { listener(structuredClone(status)); } catch { /* Each view receives its own copy and cannot interrupt another view. */ }
  }
  async flushAutosave(sessionId: string): Promise<AutosaveStatus | undefined> { return this.autosaveDocuments.get(sessionId)?.flush(); }
  private pauseAutosave(s: Session | undefined, reason: string): () => void { return s ? this.autosaveDocuments.get(s.sessionId)?.pause(reason) ?? (() => {}) : () => {}; }
  /** Pause at invocation, before joining the file queue, so a validator already holding it sees the lifecycle request. */
  private async withAutosavePathsPaused<T>(inputs: string[], reason: string, action: () => Promise<T>): Promise<T> {
    const paths = [...new Set(inputs.map(documentPath))];
    const resumes = paths.map(path => this.pauseAutosave(this.sessions.get(path), reason));
    try { return await action(); } finally { for (const resume of resumes) resume(); }
  }
  private async withAutosavePaused<T>(s: Session, reason: string, action: () => Promise<T>): Promise<T> {
    const resume = this.pauseAutosave(s, reason);
    try { return await action(); } finally { resume(); }
  }
  private expect(s: Session, expected: number): void {
    integer(expected, 'expectedRevision');
    if (expected !== s.revision) throw new HwpHandsError('REVISION_CONFLICT', '문서가 변경되었습니다. 현재 상태를 다시 조회하세요.', { expectedRevision: expected, actualRevision: s.revision });
  }
  private expectQueryContext(s: Session, context: QueryContext): void {
    if (!context || typeof context !== 'object' || typeof context.sessionId !== 'string') throw new HwpHandsError('INVALID_ARGUMENT', 'sessionId and expectedRevision are required for this query.');
    this.expect(s, context.expectedRevision);
    if (context.sessionId !== s.sessionId) throw new HwpHandsError('REVISION_CONFLICT', '대상 주소가 다른 문서 세션에서 조회되었습니다.', { expectedSessionId: context.sessionId, actualSessionId: s.sessionId });
  }
  private expectAddressContext(s: Session, target: { sessionId?: string; revision?: number } | undefined): void {
    if (!target || typeof target !== 'object') return;
    if (target.sessionId !== undefined && target.sessionId !== s.sessionId) throw new HwpHandsError('REVISION_CONFLICT', '대상 주소가 다른 문서 세션에서 조회되었습니다.', { expectedSessionId: target.sessionId, actualSessionId: s.sessionId });
    if (target.revision !== undefined && target.revision !== s.revision) throw new HwpHandsError('REVISION_CONFLICT', '대상 주소가 오래되었습니다. 현재 문서 구조를 다시 조회하세요.', { expectedTargetRevision: target.revision, actualRevision: s.revision });
  }
  private async probeSaveFormat(s: Session, format: Format): Promise<SaveFormatCapability> {
    try { await this.readableExport(s.engine, pathWithFormat(s.path, format), this.options.maxFileBytes, s.sourceGuard, s.sectionTails); return { available: true }; }
    catch (error) { return { available: false, reason: error instanceof Error ? error.message : String(error), errorCode: error instanceof HwpHandsError ? error.code : 'VERIFY_FAILED' }; }
  }
  private async probeSaveFormats(s: Session): Promise<Record<Format, SaveFormatCapability>> {
    // One format after the other keeps a single long request queued in the worker that every open document shares, so another
    // document's page waits for at most that request instead of the whole probe.
    const current = this.state(s).format, other: Format = current === 'hwp' ? 'hwpx' : 'hwp';
    const first = await this.probeSaveFormat(s, current), second = await this.probeSaveFormat(s, other);
    return current === 'hwp' ? { hwp: first, hwpx: second } : { hwp: second, hwpx: first };
  }
  private async capabilities(s: Session): Promise<DocumentCapabilities> {
    if (s.capabilityCache?.revision === s.revision) return s.capabilityCache;
    const [saveFormats, fields] = await Promise.all([this.probeSaveFormats(s), s.engine.fields()]);
    const format = this.state(s).format, current = saveFormats[format];
    const nameCounts = new Map<string, number>(), idCounts = new Map<number, number>();
    for (const field of fields) { nameCounts.set(field.name, (nameCounts.get(field.name) ?? 0) + 1); idCounts.set(field.fieldId, (idCounts.get(field.fieldId) ?? 0) + 1); }
    const ambiguousFieldNames = [...nameCounts].filter(([, count]) => count > 1).map(([name]) => name).sort();
    const ambiguousFieldIds = [...idCounts].filter(([, count]) => count > 1).map(([id]) => id).sort((a, b) => a - b);
    const readOnlyReasons = current.available ? [] : [current.reason ?? '현재 형식으로 안전한 저장을 확인하지 못했습니다.'];
    const result: DocumentCapabilities = {
      sessionId: s.sessionId, revision: s.revision, format, readOnly: !current.available, readOnlyReasons,
      queries: { text: 'partial', structure: 'partial', formatting: 'partial', layout: 'full', pictureResource: 'partial' },
      edits: {
        text: 'partial', fieldsById: ambiguousFieldIds.length ? 'partial' : 'full',
        fieldsByName: ambiguousFieldNames.length ? 'partial' : 'full', characterFormatting: 'partial',
        paragraphFormatting: 'partial', tables: 'partial', objects: 'partial', pageSettings: 'partial',
      },
      saveFormats, ambiguousFieldNames, ambiguousFieldIds,
      limitations: [
        '문자·문단 서식, 표 편집은 공개 명령의 일부 범위만 지원합니다.',
        '필드 이름 기반 쓰기는 해당 이름이 현재 문서에서 유일할 때만 허용됩니다. fieldId는 이 sessionId/revision 안에서만 유효합니다.',
        '셀 앵커 각주·미주 본문과 문자 run 서식은 RHWP core 제한으로 조회할 수 없습니다.',
        '표 구조·셀/표 서식은 root-body 표에서 지원하며 중첩 표 구조 변경은 거절합니다.',
        '그림·수식·사각형/글상자 삽입과 root-body 개체 속성/삭제를 지원합니다. 차트와 중첩 개체 쓰기는 제공하지 않습니다.',
        '용지 크기/여백, 본문 페이지 나누기·단 나누기를 지원합니다. 단 정의 및 구역 전체 속성 변경은 제공하지 않습니다.',
      ],
      saveWarnings: ['RHWP 내보내기로 글자·서식·배치가 달라질 수 있습니다. 저장은 재파싱과 첫 페이지 렌더 성공 여부로 판단합니다.', '엔진의 내용 손실 보고는 저장 경고로 전달합니다. query.verify는 별도로 원본 보존 지문과 선택 페이지의 SVG·layout·쪽 수를 비교합니다.'],
    };
    s.capabilityCache = result;
    s.writePreflight = current;
    return result;
  }
  private async assertWritable(s: Session): Promise<void> {
    const format = this.state(s).format;
    const baseline = s.writePreflight ?? (s.capabilityCache?.revision === s.revision ? s.capabilityCache.saveFormats[format] : undefined) ?? await this.probeSaveFormat(s, format);
    s.writePreflight = baseline;
    if (!baseline.available) throw new HwpHandsError(baseline.errorCode ?? 'VERIFY_FAILED', '현재 형식의 안전한 내보내기 검증에 실패해 문서를 읽기 전용으로 열었습니다.', { readOnlyReasons: [baseline.reason ?? '저장 검증에 실패했습니다.'] });
  }
  private validateCommandContext(s: Session, command: Command): void {
    if (!command || typeof command !== 'object') return;
    const candidate = command as Command & { target?: { sessionId?: string; revision?: number }; table?: { sessionId?: string; revision?: number }; object?: { address?: { sessionId?: string; revision?: number } }; start?: { address?: { sessionId?: string; revision?: number } }; end?: { address?: { sessionId?: string; revision?: number } } };
    this.expectAddressContext(s, candidate.target);
    this.expectAddressContext(s, candidate.table);
    this.expectAddressContext(s, candidate.object?.address);
    const grouped = (command as { objects?: unknown }).objects;
    if (Array.isArray(grouped)) for (const item of grouped) this.expectAddressContext(s, (item as { address?: { sessionId?: string; revision?: number } } | null)?.address);
    this.expectAddressContext(s, candidate.start?.address);
    this.expectAddressContext(s, candidate.end?.address);
    if (command.type === 'formatRange') {
      this.expectAddressContext(s, command.range?.start?.address);
      this.expectAddressContext(s, command.range?.end?.address);
    }
    if (command.type === 'setFieldById' || command.type === 'setFields' || command.type === 'setFieldsAt' || command.type === 'updateField' || command.type === 'removeField') {
      this.expectQueryContext(s, { sessionId: command.sessionId, expectedRevision: command.revision });
    }
  }
  private async trim(s: Session, ids: number[]): Promise<void> {
    while (ids.length > s.historyLimit) { const id = ids.shift()!; await this.discardSnapshot(s, id); s.origins.delete(id); }
  }
  private async clearHistory(s: Session, ids: number[]): Promise<void> { for (const id of ids) { await this.discardSnapshot(s, id); s.origins.delete(id); } ids.length = 0; }
  private async discardSnapshot(s: Session, id: number): Promise<void> {
    s.actorLedger.discard(id);
    try { await s.engine.discard(id); } catch (error) { console.error('HWP Hands snapshot cleanup:', error); }
  }
  private async restoreInputGroup(s: Session, groupId: string): Promise<void> {
    const group = s.activeGroup, origin = group && s.origins.get(group.snapshot);
    if (!group || group.id !== groupId || origin === undefined) throw new HwpHandsError('VERIFY_FAILED', '입력 그룹의 undo 경계를 찾을 수 없습니다.');
    await s.engine.restore(group.snapshot);
    let replaying = false;
    for (const action of s.actions.slice(origin)) {
      if ('commands' in action && action.groupId === groupId) {
        replaying = true;
        for (const command of action.commands) await s.engine.execute(command);
      } else if (replaying) break;
    }
    s.pageCount = await s.engine.pages();
  }
  private async firstAffectedPage(engine: EnginePort, commands: readonly Command[]): Promise<number | undefined> {
    const targets: Array<{ section: number; paragraph: number }> = [];
    for (const command of commands) {
      let candidates: unknown[];
      switch (command.type) {
        case 'insertText': case 'insertLineBreak': case 'insertTab': case 'pasteHtml': case 'deleteText': case 'replaceParagraph': case 'splitParagraph': case 'mergeParagraph':
        case 'deleteParagraphAt': case 'insertCellParagraph': case 'formatText': case 'formatParagraph': case 'setParagraphStyle': case 'setParagraphList':
          candidates = [command.target]; break;
        case 'replaceRange': case 'deleteRange': candidates = [command.start.address, command.end.address]; break;
        case 'formatRange': candidates = [command.range.start.address, command.range.end.address]; break;
        case 'formatCellBlock': candidates = [command.table]; break;
        default: return undefined;
      }
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') return undefined;
        const address = candidate as { kind?: unknown; section?: unknown; paragraph?: unknown };
        if ((address.kind !== undefined && address.kind !== 'body') || !Number.isSafeInteger(address.section) || !Number.isSafeInteger(address.paragraph)) return undefined;
        targets.push({ section: address.section as number, paragraph: address.paragraph as number });
      }
    }
    if (!targets.length) return undefined;
    const pages = await Promise.all(targets.map(async target => engine.pageOfPosition(target)));
    return pages.every((page): page is number => page !== undefined) ? Math.min(...pages) : undefined;
  }
  /** The one plain root paragraph a typed edit changes, or undefined when the edit may change more than that paragraph's text. */
  private typingTarget(commands: readonly Command[]): Target | undefined {
    let found: Target | undefined;
    for (const command of commands) {
      if (command.type !== 'insertText' && command.type !== 'deleteText') return undefined;
      const target = command.target as Target & { kind?: unknown };
      if (!target || (target.kind !== undefined && target.kind !== 'body') || target.cellPath?.length || !Number.isSafeInteger(target.section) || !Number.isSafeInteger(target.paragraph)) return undefined;
      // A line or paragraph break in the text may become structure.
      if (command.type === 'insertText' && Array.from(command.text).some(character => [10, 13, 0x2028, 0x2029].includes(character.codePointAt(0)!))) return undefined;
      if (found && (found.section !== target.section || found.paragraph !== target.paragraph)) return undefined;
      found = { section: target.section, paragraph: target.paragraph };
    }
    return found;
  }
  /**
   * The cached `tree` and model-run `formatting` of the current revision with the typed paragraph read again from the engine.
   * Nothing is changed here: the caller applies `replace` once the edit is certain. Returns nothing when the paragraph anchors a
   * control, field, object, bookmark, table or story (their positions move with the text), or when anything does not line up.
   */
  private async typingCachePatch(s: Session, target: Target): Promise<Array<{ key: (revision: number) => string; entry: { value: unknown; bytes: number }; large: boolean; replace: () => void }>> {
    try {
      const treeKey = `tree:${s.revision}`, treeEntry = s.queryCache.get(treeKey) ?? s.typingCarry.get(treeKey);
      if (!treeEntry) return [];
      const tree = treeEntry.value as DocumentTree, section = tree.sections[target.section], current = section?.paragraphs[target.paragraph];
      if (!section || !current) return [];
      const here = (address?: { section?: unknown; paragraph?: unknown }): boolean => !!address && address.section === target.section && address.paragraph === target.paragraph;
      if (tree.tables.some(item => here(item.address)) || tree.fields.some(item => here(item.address)) || tree.controls.some(item => here(item.address))
        || tree.objects.some(item => here(item.address) || here(item.anchor)) || tree.bookmarks.some(item => here(item.address))
        || tree.stories.some(item => 'anchor' in item && here(item.anchor))) return [];
      const flat = tree.paragraphs.indexOf(current);
      const patch = await s.engine.paragraphPatch(target);
      if (flat < 0 || !patch || patch.rootParagraphs !== tree.paragraphs.length || patch.paragraph.nodePath !== current.nodePath) return [];
      const prefix = `formatting:${s.revision}`;
      const carried: Array<{ key: (revision: number) => string; entry: { value: unknown; bytes: number }; large: boolean; replace: () => void }> = [{
        key: revision => `tree:${revision}`, entry: treeEntry, large: !s.queryCache.has(treeKey),
        replace: () => { const paragraph = structuredClone(patch.paragraph); section.paragraphs[target.paragraph] = paragraph; tree.paragraphs[flat] = paragraph; },
      }];
      for (const [key, entry, large] of [...[...s.queryCache].map(item => [...item, false] as const), ...[...s.typingCarry].map(item => [...item, true] as const)]) {
        if (!key.startsWith(`${prefix}:`) || !key.endsWith(':model') || key.includes(':without-native:')) continue;
        const formatting = entry.value as FormattingModel;
        const index = formatting.paragraphs.findIndex(item => item.address.kind === 'body' && !item.address.cellPath?.length && here(item.address));
        if (index < 0) continue;
        carried.push({ key: revision => `formatting:${revision}${key.slice(prefix.length)}`, entry, large, replace: () => { formatting.paragraphs[index] = structuredClone(patch.formatting); } });
      }
      return carried;
    } catch { return []; }
  }
  private async pageTextSignature(engine: EnginePort, page: number): Promise<string | undefined> {
    try { return await engine.pageTextSignature(page); } catch { return undefined; }
  }
  private inputCommandsJoin(previous: Command, next: Command): boolean {
    return inputGroupCommandsJoin(previous, next);
  }
  /** Only the built-in view calls this entry point; public API origin never selects a trusted actor. */
  transactionFromView(path: string, commands: Command[], options: TransactionOptions): Promise<Receipt> {
    return this.run(path, async path => this.transaction(await this.session(path), commands, options, { kind: 'human' }));
  }
  /** Internal bridge for future AI session adapters. Editing permission still never authorizes an original save. */
  transactionFromAi(path: string, commands: Command[], options: TransactionOptions, actorId: string, signal?: AbortSignal): Promise<Receipt> {
    const actor = validateEditActor({ kind: 'ai', id: actorId });
    return this.run(path, async path => this.transaction(await this.session(path), commands, options, actor, signal));
  }
  /** Undo requested by an AI tool: the human-input check runs inside the document queue, before and after the snapshot restore. */
  undoFromAi(path: string, options: { expectedRevision: number }, signal?: AbortSignal): Promise<State> {
    return this.run(path, async path => {
      const s = await this.session(path), generation = this.inputGenerations.get(s.sessionId) ?? 0;
      return this.history(s, this.expectedRevisionOption(options, 'undo'), false, () => {
        if (signal?.aborted) throw new HwpHandsError('CANCELLED', 'AI 되돌리기가 취소됐습니다.');
        if ((this.inputGenerations.get(s.sessionId) ?? 0) !== generation || !this.stableInput(s.sessionId))
          throw new HwpHandsError('CANCELLED', '사람이 이 문서에 입력 중이라 AI 편집을 되돌리지 않았습니다.', { reason: 'human-input' });
      }, true);
    });
  }
  /**
   * Drops a working copy nobody is looking at when every change since it last matched the file is this AI actor's own.
   * The host calls it only after a person confirmed. A person's or another actor's edit, an undo by a person, a replayed
   * recovery record or a file conflict leaves the decision to the person on screen.
   */
  discardFromAi(path: string, options: { expectedRevision: number; sessionId: string }, actorId: string, signal?: AbortSignal): Promise<State> {
    const actor = validateEditActor({ kind: 'ai', id: actorId }) as { kind: 'ai'; id: string };
    const source = documentPath(path);
    return this.withAutosavePathsPaused([source], 'reload', () => this.run(source, async path => {
      const s = this.sessions.get(path);
      if (!s || s.sessionId !== options?.sessionId) throw new HwpHandsError('CLOSED', '버릴 작업본이 이미 닫혔거나 다른 세션입니다.');
      this.expect(s, options.expectedRevision);
      if (!this.stableInput(s.sessionId)) throw new HwpHandsError('CANCELLED', '사람이 이 문서에 입력 중이라 버리지 않았습니다.', { reason: 'human-input' });
      if (!s.dirty || s.conflict || s.soleAiActor !== actor.id) throw new HwpHandsError('INVALID_ARGUMENT', '마지막 저장 이후 변경이 모두 이 대화의 AI 편집이라고 확인할 수 없어 버리지 않았습니다.', { reason: 'mixed-edits' });
      return this.reload(s, true, () => { if (signal?.aborted) throw new HwpHandsError('CANCELLED', 'AI 작업본 버리기가 취소됐습니다.'); });
    }));
  }
  private async transaction(s: Session, commands: Command[], options: TransactionOptions, actor: EditActor = { kind: 'unknown' }, signal?: AbortSignal): Promise<Receipt> {
    const value = this.optionsRecord(options, 'transaction'), expectedRevision = value.expectedRevision;
    integer(expectedRevision as number, 'expectedRevision');
    if (value.dryRun !== undefined && typeof value.dryRun !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'dryRun must be a boolean.');
    const origin = value.origin ?? 'api', groupId = value.groupId;
    if (origin !== 'input' && origin !== 'command' && origin !== 'api') throw new HwpHandsError('INVALID_ARGUMENT', 'origin must be input, command, or api.');
    // eslint-disable-next-line no-control-regex -- Input group IDs must reject control characters.
    if (groupId !== undefined && (typeof groupId !== 'string' || !groupId.length || groupId.length > 128 || /[\u0000-\u001f\u007f]/.test(groupId))) throw new HwpHandsError('INVALID_ARGUMENT', 'groupId must be a non-empty string of at most 128 characters.');
    this.expect(s, expectedRevision as number);
    if (!Array.isArray(commands) || !commands.length || commands.length > 500) throw new HwpHandsError('INVALID_ARGUMENT', '트랜잭션은 1~500개 명령을 받습니다.');
    for (const command of commands) {
      if (!command || typeof command !== 'object' || Array.isArray(command) || typeof (command as { type?: unknown }).type !== 'string') throw new HwpHandsError('INVALID_ARGUMENT', '트랜잭션 명령은 type을 가진 객체여야 합니다.');
      this.validateCommandContext(s, command);
      if (command.type === 'insertPicture') imageBase64ByteLength(command.imageBase64);
    }
    if (commands.length > 1 && commands.some(command => command?.type === 'setFieldById' || command?.type === 'setFields' || command?.type === 'setFieldsAt' || command?.type === 'updateField' || command?.type === 'removeField')) throw new HwpHandsError('INVALID_ARGUMENT', 'fieldId는 조회 revision에 종속되므로 한 트랜잭션에서 단독 명령으로 적용하세요.');
    const firstCommand = commands[0] as Command & { target?: { kind?: unknown } } | undefined;
    if (groupId !== undefined && (origin !== 'input' || value.dryRun === true || commands.length !== 1 || (firstCommand?.type !== 'insertText' && firstCommand?.type !== 'deleteText') || firstCommand?.target?.kind !== undefined)) {
      throw new HwpHandsError('INVALID_ARGUMENT', '입력 그룹은 dryRun이 아닌 단일 본문 insertText/deleteText 명령에만 사용할 수 있습니다.');
    }
    let serializedCommands: string;
    try { serializedCommands = JSON.stringify(commands); }
    catch (error) { throw new HwpHandsError('INVALID_ARGUMENT', '트랜잭션 명령은 JSON으로 직렬화할 수 있어야 합니다.', String(error)); }
    if (Buffer.byteLength(serializedCommands, 'utf8') > MAX_TRANSACTION_BYTES) throw new HwpHandsError('INVALID_ARGUMENT', '트랜잭션 인자 크기가 16 MiB 제한을 초과합니다.');
    const inputGeneration = this.inputGenerations.get(s.sessionId) ?? 0;
    const yieldToHuman = (): void => {
      if (signal?.aborted) throw new HwpHandsError('CANCELLED', 'AI 편집 또는 미리보기가 취소됐습니다.');
      if (actor.kind === 'ai' && ((this.inputGenerations.get(s.sessionId) ?? 0) !== inputGeneration || !this.stableInput(s.sessionId)))
        throw new HwpHandsError('CANCELLED', '사람이 이 문서에 입력 중이라 AI 편집을 적용하지 않았습니다.', { reason: 'human-input' });
    };
    yieldToHuman();
    await this.assertWritable(s);
    yieldToHuman();
    const recordedCommands = structuredClone(commands);
    const firstPageBefore = await this.firstAffectedPage(s.engine, recordedCommands);
    // Typing rarely moves the text of the next page. Its layout fingerprint tells whether the pages after the edited one changed.
    const typing = recordedCommands.every(command => command.type === 'insertText' || command.type === 'deleteText');
    const kept = s.followingSignature;
    const followingBefore = !typing || firstPageBefore === undefined ? undefined
      : kept && kept.revision === s.revision && kept.page === firstPageBefore + 1 ? kept.value : await this.pageTextSignature(s.engine, firstPageBefore + 1);
    const group = typeof groupId === 'string';
    const now = Date.now();
    const continuation = group && s.activeGroup?.id === groupId && now - s.activeGroup.lastAt <= INPUT_GROUP_IDLE_MS
      && this.inputCommandsJoin(s.activeGroup.lastCommand, recordedCommands[0]) && JSON.stringify(s.activeGroup.actor) === JSON.stringify(actor);
    const before = continuation ? undefined : await s.engine.snapshot();
    const previousActors = s.actorLedger.current();
    if (before !== undefined) s.actorLedger.capture(before);
    const oldPageCount = s.pageCount;
    let restored = false;
    try {
      yieldToHuman();
      const results: Record<string, import('./api').Json>[] = [];
      for (const command of recordedCommands) { yieldToHuman(); results.push(await s.engine.execute(command)); }
      yieldToHuman();
      // Reflow can affect following pages; use the earliest resolvable edited page as the invalidation frontier.
      const pageCountAfter = await s.engine.pages(), pageCountDelta = pageCountAfter - oldPageCount;
      const firstPageAfter = await this.firstAffectedPage(s.engine, recordedCommands);
      const pageTotal = Math.max(oldPageCount, pageCountAfter);
      const firstChangedPage = firstPageBefore === undefined || firstPageAfter === undefined || pageTotal === 0
        ? 0 : Math.min(firstPageBefore, firstPageAfter, pageTotal - 1);
      const followingAfter = followingBefore !== undefined && pageCountDelta === 0 && firstPageAfter === firstPageBefore
        ? await this.pageTextSignature(s.engine, firstChangedPage + 1) : undefined;
      const followingKept = followingAfter !== undefined && followingAfter === followingBefore;
      const changedPages = followingKept ? [firstChangedPage]
        : Array.from({ length: Math.max(0, pageTotal - firstChangedPage) }, (_, index) => firstChangedPage + index);
      yieldToHuman();
      if (value.dryRun === true) { await s.engine.restore(before!); restored = true; yieldToHuman(); return { ...this.state(s), changedPages, pageCountBefore: oldPageCount, pageCountAfter, pageCountDelta, results }; }
      if (before !== undefined) s.origins.set(before, s.actions.length);
      const action: RecoveryAction = group
        ? { commands: recordedCommands, origin: 'input', groupId: groupId, undoBoundary: !continuation, actor, editId: randomUUID() }
        : { commands: recordedCommands, origin, actor, editId: randomUUID() };
      s.actorLedger.apply(actor, action.editId!);
      s.actionBytes += actionSize(action) + (s.actions.length ? 1 : 0);
      s.commandCount += recordedCommands.length;
      s.actions.push(action);
      try { await this.persistRecovery(s); }
      catch (error) { s.actions.pop(); s.actionBytes -= actionSize(action) + (s.actions.length ? 1 : 0); s.commandCount -= recordedCommands.length; if (before !== undefined) s.origins.delete(before); throw error; }
      if (before !== undefined) { s.undo.push(before); await this.trim(s, s.undo); }
      await this.clearHistory(s, s.redo);
      s.activeGroup = group ? { id: groupId, snapshot: continuation ? s.activeGroup!.snapshot : before!, lastAt: now, lastCommand: recordedCommands[0], actor } : undefined;
      s.soleAiActor = actor.kind === 'ai' && (!s.dirty || s.soleAiActor === actor.id) ? actor.id : null;
      // A typed edit changes one paragraph: carry the structure and formatting a view just read over to the new revision.
      const typingTarget = this.typingTarget(recordedCommands);
      const carried = typingTarget ? await this.typingCachePatch(s, typingTarget) : [];
      this.clearQueryCache(s); s.pageCount = pageCountAfter; s.dirty = true; s.revision = ++this.sequence; s.capabilityCache = undefined;
      for (const item of carried) {
        item.replace();
        if (item.large) s.typingCarry.set(item.key(s.revision), item.entry);
        else { s.queryCache.set(item.key(s.revision), item.entry); s.queryCacheBytes += item.entry.bytes; }
      }
      // The next key of the same burst asks about the same page at this revision.
      s.followingSignature = followingAfter === undefined ? undefined : { revision: s.revision, page: firstChangedPage + 1, value: followingAfter };
      for (const listener of this.appliedListeners) {
        try { listener({ path: s.path, sessionId: s.sessionId, revisionBefore: expectedRevision as number, revisionAfter: s.revision, commands: recordedCommands, actor: actor.kind }); }
        catch (error) { console.error('HWP Hands applied-edit listener:', error); }
      }
      this.emit('changed', s, { changedPages, origin, ...(group ? { groupId } : {}) });
      return { ...this.state(s), changedPages, pageCountBefore: oldPageCount, pageCountAfter, pageCountDelta, results };
    } catch (error) {
      s.actorLedger.setCurrent(previousActors);
      if (before !== undefined && !restored) { await s.engine.restore(before); restored = true; }
      else if (continuation) {
        try { await this.restoreInputGroup(s, groupId); }
        catch (rollbackError) { throw new HwpHandsError('VERIFY_FAILED', '입력 그룹 편집을 원상 복구하지 못했습니다.', { cause: String(error), rollback: String(rollbackError) }); }
      }
      throw error;
    } finally { if (restored && before !== undefined) await this.discardSnapshot(s, before); }
  }
  private async history(s: Session, expected: number, redo: boolean, guard?: () => void, fromAi = false): Promise<State> {
    this.expect(s, expected); guard?.(); s.activeGroup = undefined; const from = redo ? s.redo : s.undo, to = redo ? s.undo : s.redo;
    if (!from.length) return this.state(s);
    const current = await s.engine.snapshot(), target = from.at(-1)!, currentOrigin = s.actions.length, previousPageCount = s.pageCount;
    s.actorLedger.capture(current);
    const previousActors = s.actorLedger.current();
    s.origins.set(current, currentOrigin);
    try {
      guard?.(); await s.engine.restore(target); guard?.(); s.actorLedger.restore(target); s.pageCount = await s.engine.pages(); guard?.(); const action: RecoveryAction = { history: redo ? 'redo' : 'undo' }; s.actionBytes += actionSize(action) + (s.actions.length ? 1 : 0); s.actions.push(action);
      try { await this.persistRecovery(s); } catch (error) { s.actions.pop(); s.actionBytes -= actionSize(action) + (s.actions.length ? 1 : 0); throw error; }
    } catch (error) { await s.engine.restore(current); s.actorLedger.setCurrent(previousActors); s.pageCount = previousPageCount; await this.discardSnapshot(s, current); s.origins.delete(current); throw error; }
    from.pop(); await this.discardSnapshot(s, target); s.origins.delete(target); to.push(current); await this.trim(s, to);
    if (!fromAi || !s.dirty) s.soleAiActor = null;
    this.clearQueryCache(s); s.dirty = true; s.revision = ++this.sequence; s.capabilityCache = undefined; s.writePreflight = undefined; this.emit('changed', s, { origin: 'history' }); return this.state(s);
  }
  private async verifyPages(engine: EnginePort, options: VerificationOptions): Promise<number[]> {
    const count = await engine.pages(), pages = options.pages ?? (count ? [0] : []);
    if (!Array.isArray(pages)) throw new HwpHandsError('INVALID_ARGUMENT', 'pages must be an array of page indices.');
    const selected: number[] = [];
    for (const page of pages) { integer(page, 'page', count - 1); if (!selected.includes(page)) selected.push(page); }
    return selected;
  }
  private async preservationBuckets(engine: EnginePort, runs: 'scan' | 'model' = 'scan'): Promise<PreservationBuckets> {
    const [snapshot, objects] = await Promise.all([engine.preservationSnapshot(runs), engine.objects()]);
    const resources: Array<{ address: unknown; controlIndex: number; mimeType: string; byteLength: number; sha256: string }> = [];
    for (const object of objects.filter(item => item.kind === 'picture')) {
      if (object.resource?.availability !== 'referenced') throw new HwpHandsError('VERIFY_FAILED', `그림 참조 자원을 확인할 수 없습니다: ${object.nodePath}`);
      const resource = await engine.objectResource({ kind: 'picture', address: object.address, controlIndex: object.controlIndex });
      resources.push({ address: object.address, controlIndex: object.controlIndex, mimeType: resource.mimeType, byteLength: resource.bytes.byteLength, sha256: hash(resource.bytes) });
    }
    return {
      buckets: {
        ...snapshot.buckets,
        formatting: normalizeNoFillPatternMetadata(snapshot.buckets.formatting),
        resources,
      },
      coverageWarnings: snapshot.coverageWarnings,
    };
  }
  /** Explicit fidelity diagnostics, also used for replay-safe recovery seeds. Not a user-file save gate. */
  private async inspectExport(engine: EnginePort, destination: string, sourceFormat: Format, pages: number[], probeSource?: () => Promise<PreservationBuckets>, maxBytes?: number): Promise<VerificationDetails & { bytes?: Uint8Array }> {
    const targetFormat: Format = /\.hwpx$/i.test(destination) ? 'hwpx' : 'hwp', beforeCount = await engine.pages();
    const warnings: string[] = [];
    const fail = (error: unknown, afterCount?: number): VerificationDetails & { bytes?: Uint8Array } => ({
      targetFormat, passed: false, compared: [], differences: [], unsupportedCoverage: [],
      error: { code: error instanceof HwpHandsError ? error.code : 'VERIFY_FAILED', message: error instanceof Error ? error.message : String(error) },
      pages: { beforeCount, ...(afterCount === undefined ? {} : { afterCount, delta: afterCount - beforeCount }), rendered: [] }, warnings,
    });
    let bytes: Uint8Array;
    try {
      const fileName = fileNameFromPath(destination);
      const hasHeaderFooterFileName = (await engine.tree()).stories.some(story => story.kind === 'headerFooter'
        && story.paragraphs.some(paragraph => paragraph.dynamicFields?.some(field => field.type === 'fileName')));
      bytes = await engine.export(targetFormat, hasHeaderFooterFileName ? fileName : undefined);
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new HwpHandsError('INVALID_ARGUMENT', '자동 저장 후보가 바이트 상한을 초과합니다.');
    } catch (error) { return fail(error); }
    let copy: EnginePort;
    try { copy = await this.engineProvider.parse(bytes); } catch (error) { return fail(new HwpHandsError('VERIFY_FAILED', `내보낸 파일을 재파싱할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`)); }
    try {
      let before: PreservationBuckets, after: PreservationBuckets;
      try {
        [before, after] = probeSource
          ? [await probeSource(), await this.preservationBuckets(copy, 'model')]
          : await Promise.all([this.preservationBuckets(engine), this.preservationBuckets(copy)]);
      }
      catch (error) { return fail(new HwpHandsError('VERIFY_FAILED', `보존 지문을 완성하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`), await copy.pages()); }
      const categories = Object.keys(before.buckets);
      const differences = categories.filter(category => category === 'structure'
        ? !preservationStructureEqual(before.buckets[category], after.buckets[category])
        : JSON.stringify(before.buckets[category]) !== JSON.stringify(after.buckets[category]));
      const afterCount = await copy.pages();
      if (targetFormat === sourceFormat && beforeCount !== afterCount) differences.push('pageCount');
      if (targetFormat !== sourceFormat && beforeCount !== afterCount) warnings.push(`형식 변환 중 페이지 수가 ${beforeCount}쪽에서 ${afterCount}쪽으로 바뀌었습니다.`);
      const unsupportedCoverage = [...new Set([...before.coverageWarnings, ...after.coverageWarnings])];
      const rendered: VerificationReport['pages']['rendered'] = [];
      for (const page of pages) {
        const diagnostics: string[] = [];
        try {
          const [beforeLayout, beforeRender] = await Promise.all([engine.layout(page), engine.page(page)]);
          const layoutSignature = (layout: PageLayout) => JSON.stringify({ info: layout.info, textRuns: layout.textRuns, controls: layout.controls });
          const svgBeforeHash = hash(Buffer.from(beforeRender.svg, 'utf8'));
          const layoutBeforeHash = hash(Buffer.from(layoutSignature(beforeLayout), 'utf8'));
          const beforeSummary = { page, width: beforeLayout.info.width, height: beforeLayout.info.height, textRunCount: beforeLayout.textRuns.length, controlCount: beforeLayout.controls.length };
          if (page >= afterCount) {
            diagnostics.push('내보낸 결과에 비교할 쪽이 없습니다.');
            warnings.push(`${page + 1}쪽 렌더 결과를 내보낸 파일에서 찾지 못했습니다.`);
            rendered.push({ page, before: beforeSummary, diagnostics });
            continue;
          }
          const [afterLayout, afterRender] = await Promise.all([copy.layout(page), copy.page(page)]);
          const svgAfterHash = hash(Buffer.from(afterRender.svg, 'utf8'));
          const layoutAfterHash = hash(Buffer.from(layoutSignature(afterLayout), 'utf8'));
          const svgEqual = svgBeforeHash === svgAfterHash, layoutEqual = layoutBeforeHash === layoutAfterHash;
          if (!svgEqual) diagnostics.push('렌더된 SVG가 내보내기 전후에 다릅니다.');
          if (!layoutEqual) diagnostics.push('쪽 크기·텍스트 run·개체 배치가 내보내기 전후에 다릅니다.');
          if (diagnostics.length) warnings.push(`${page + 1}쪽: ${diagnostics.join(' ')}`);
          rendered.push({
            page, before: beforeSummary,
            after: { page, width: afterLayout.info.width, height: afterLayout.info.height, textRunCount: afterLayout.textRuns.length, controlCount: afterLayout.controls.length },
            svgEqual, layoutEqual, svgBeforeHash, svgAfterHash, layoutBeforeHash, layoutAfterHash, diagnostics,
          });
        } catch (error) {
          diagnostics.push(`쪽 렌더/layout 비교를 완료하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
          warnings.push(`${page + 1}쪽 layout 진단을 완료하지 못했습니다.`);
          rendered.push({ page, diagnostics });
        }
      }
      if (differences.length) warnings.push(`재파싱 보존 지문이 달라진 영역: ${differences.join(', ')}.`);
      return {
        bytes, targetFormat, passed: differences.length === 0, compared: categories.concat(targetFormat === sourceFormat ? ['pageCount'] : []), differences,
        unsupportedCoverage, pages: { beforeCount, afterCount, delta: afterCount - beforeCount, rendered }, warnings,
      };
    } finally { await copy.free(); }
  }
  private async verifiedExport(engine: EnginePort, destination: string, sourceFormat: Format, probeSource?: () => Promise<PreservationBuckets>, maxBytes?: number): Promise<Uint8Array> {
    const result = await this.inspectExport(engine, destination, sourceFormat, [], probeSource, maxBytes);
    if (result.error) throw new HwpHandsError(result.error.code, result.error.message);
    if (!result.passed || !result.bytes) throw new HwpHandsError('VERIFY_FAILED', '저장 후 재열기 검증에서 원본 보존 지문이 달라졌습니다.', { differences: result.differences, unsupportedCoverage: result.unsupportedCoverage });
    return result.bytes;
  }
  /** User-file save gate: RHWP must be able to reopen and render the exported file. Fidelity is diagnostic only. */
  private async readableExport(engine: EnginePort, destination: string, maxBytes: number, sourceGuard: HwpSourceGuard = 'clear', tails: SectionTailsInspection = { status: 'clear' }): Promise<{ bytes: Uint8Array; warnings: string[] }> {
    assertHwpSourceSafe(sourceGuard);
    const format: Format = /\.hwpx$/i.test(destination) ? 'hwpx' : 'hwp';
    // RHWP can rebuild the raw control offsets incorrectly after editing a paragraph
    // that has multiple fields, even when the IDs are distinct. A readable export
    // can then attach a field to unrelated text, so compare those fields after reparse.
    const fieldLocation = (field: Field): string | undefined => field.address && JSON.stringify([field.address.section, field.address.paragraph, field.address.cellPath ?? []]);
    const fields = await engine.fields(), groups = new Map<string, Field[]>();
    for (const field of fields) {
      const location = fieldLocation(field); if (!location) continue;
      const group = groups.get(location) ?? []; group.push(field); groups.set(location, group);
    }
    const multipleFields = [...groups].filter(([, group]) => group.length > 1);
    const exported = await engine.exportWithReport(format, fileNameFromPath(destination));
    let bytes = exported.bytes;
    const { contentLoss } = exported;
    if (bytes.byteLength > maxBytes) throw new HwpHandsError('INVALID_ARGUMENT', '저장 결과가 설정된 최대 크기를 초과합니다.');
    const compatibilityWarnings: string[] = [];
    if (tails.status === 'unknown') compatibilityWarnings.push('원본 HWP의 바탕쪽 또는 수식 캡션 보존 여부를 확인하지 못했습니다. 한글에서 확인하세요.');
    else if (tails.status === 'available' && format === 'hwp') {
      const restored = restoreSectionTails(bytes, tails.value);
      if (restored.skipped || restored.bytes.byteLength > maxBytes) compatibilityWarnings.push('원본의 바탕쪽 또는 수식 캡션을 안전하게 복원하지 못해 엔진 출력으로 저장합니다. 한글에서 확인하세요.');
      else bytes = restored.bytes;
    } else if (tails.status === 'available' && format === 'hwpx') compatibilityWarnings.push('HWP 바탕쪽·수식 캡션의 보존을 HWPX 변환에서 확인하지 못했습니다.');
    const inspectedTabs = inspectNewTabs(bytes, format), tabs = inspectedTabs ?? [], tabWarnings: string[] = [];
    if (!inspectedTabs) tabWarnings.push('저장 결과의 탭 폭을 검사하지 못했습니다. 한글에서 간격을 확인하세요.');
    let copy: EnginePort | undefined;
    try {
      copy = await this.engineProvider.parse(bytes);
      if (tabs.length) {
        if (tabs.length === MAX_NEW_TABS) tabWarnings.push(`탭 폭 검사는 최대 ${MAX_NEW_TABS}개까지 수행했습니다. 나머지 탭은 한글에서 확인하세요.`);
        let fixed: ReturnType<typeof writeTabWidths> | undefined;
        try { fixed = writeTabWidths(bytes, format, await copy.measureTabs(tabs)); } catch { /* leave unmeasured tabs in the engine output */ }
        const remaining = fixed && fixed.bytes.byteLength <= maxBytes ? tabs.length - fixed.written : tabs.length;
        if (remaining > 0) tabWarnings.push(`새 탭 ${remaining}개의 폭을 확인하지 못해 엔진 출력 그대로 저장합니다. 한글에서 간격을 확인하세요.`);
        if (fixed && fixed.written > 0 && fixed.bytes.byteLength <= maxBytes) {
          bytes = fixed.bytes;
          await copy.free(); copy = undefined;
          copy = await this.engineProvider.parse(bytes);
        }
      }
      if (multipleFields.length) {
        const reopened = await copy.fields();
        const signature = (field: Field) => [field.fieldType ?? null, field.name, field.value, field.startCharIdx ?? null, field.endCharIdx ?? null];
        for (const [location, expected] of multipleFields) {
          const actual = reopened.filter(field => fieldLocation(field) === location);
          if (JSON.stringify(expected.map(signature)) !== JSON.stringify(actual.map(signature)))
            throw new HwpHandsError('CONTENT_LOSS', '한 문단의 여러 필드가 저장 후 달라져 저장을 차단했습니다. 원본과 복구 기록은 보존됩니다.');
        }
      }
      const pages = await copy.pages();
      if (!Number.isSafeInteger(pages) || pages < 1) throw new Error('내보낸 파일에 열 수 있는 페이지가 없습니다.');
      const page = await copy.page(0);
      if (typeof page.svg !== 'string' || !/<svg\b/.test(page.svg) || !Number.isFinite(page.width) || page.width <= 0
        || !Number.isFinite(page.height) || page.height <= 0) throw new Error('내보낸 파일의 첫 페이지 렌더가 유효하지 않습니다.');
    } catch (error) {
      if (error instanceof HwpHandsError && error.code === 'CONTENT_LOSS') throw error;
      const guidance = format === 'hwp'
        ? ' 저장 대상에는 기록하지 않았습니다. HWPX로 다른 이름 저장하거나 PDF로 내보내기를 시도할 수 있습니다.'
        : ' 저장 대상에는 기록하지 않았습니다.';
      throw new HwpHandsError('VERIFY_FAILED', `내보낸 파일을 다시 열 수 없습니다: ${error instanceof Error ? error.message : String(error)}${guidance}`);
    } finally { await copy?.free(); }
    return { bytes, warnings: [...compatibilityWarnings, ...tabWarnings, ...(contentLoss.count > 0
      ? [`RHWP가 저장 시 내용 손실 ${contentLoss.count}건을 보고했습니다: ${JSON.stringify(contentLoss.losses)}`] : [])] };
  }
  private async checkDisk(s: Session): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try { bytes = await this.storage.read(s.path); } catch (error) { s.conflict = true; this.emit('conflict', s); throw error; }
    if (hash(bytes) !== s.baseHash) { s.conflict = true; this.emit('conflict', s); throw new HwpHandsError('FILE_CONFLICT', '다른 프로그램이 파일을 변경했습니다. 새 파일로 저장하거나 디스크 파일을 다시 불러오세요.'); }
    return bytes;
  }
  private async save(s: Session, expected: number): Promise<SaveResult> {
    this.expect(s, expected); s.activeGroup = undefined; const original = await this.checkDisk(s);
    if (!s.dirty) { s.conflict = false; return { ...this.state(s), warnings: [] }; }
    let output: { bytes: Uint8Array; warnings: string[] };
    try { output = await this.readableExport(s.engine, s.path, this.options.maxFileBytes, s.sourceGuard, s.sectionTails); }
    catch (error) {
      s.capabilityCache = undefined;
      s.writePreflight = { available: false, reason: error instanceof Error ? error.message : String(error), errorCode: error instanceof HwpHandsError ? error.code : 'VERIFY_FAILED' };
      throw error;
    }
    const result = (await this.commitVerifiedExport(s, output.bytes, original, { ...this.options }))!;
    result.warnings.unshift(...output.warnings); return result;
  }
  /** Internal overwrite preparation. Does not write user files or grant an AI save permission. */
  prepareSave(path: string, context: { sessionId: string; expectedRevision: number }): Promise<PreparedSave> {
    const requested = structuredClone(context);
    return this.withAutosavePathsPaused([path], 'commit-prepare', () => this.run(path, async path => {
      const s = await this.session(path); this.expectQueryContext(s, requested);
      const options = { ...this.options }, engine = s.engine, source = { path, sessionId: s.sessionId, revision: s.revision, baseHash: s.baseHash };
      const actors = s.actorLedger.fingerprint(), dirty = s.dirty, generation = this.inputGenerations.get(s.sessionId) ?? 0;
      const current = () => !this.disposed && this.sessions.get(path) === s && s.engine === engine && s.path === path
        && s.revision === source.revision && s.baseHash === source.baseHash && s.dirty === dirty && !s.conflict
        && s.actorLedger.fingerprint() === actors && canonicalSaveJson(this.options) === canonicalSaveJson(options)
        && (this.inputGenerations.get(s.sessionId) ?? 0) === generation && this.stableInput(s.sessionId)
        && !this.transitions.some(t => t.prefixes.some(prefix => within(path, prefix)));
      const assertCurrent = () => { if (!current()) throw new HwpHandsError('REVISION_CONFLICT', '저장 준비 중 문서·옵션·입력이 변경되었습니다. 다시 준비하고 승인하세요.'); };
      assertCurrent(); const original = await this.checkDisk(s); assertCurrent();
      const artifacts: PreparedSaveArtifact[] = [], writeSet: PreparedSave['writeSet'] = [], warnings: string[] = [];
      if (dirty) {
        const { bytes, warnings: exportWarnings } = await this.readableExport(engine, path, options.maxFileBytes, s.sourceGuard, s.sectionTails); assertCurrent();
        warnings.push(...exportWarnings);
        const outputHash = hash(bytes);
        artifacts.push({ path, before: original, after: bytes });
        writeSet.push({ path, role: 'primary', op: 'modify', sha256Before: source.baseHash, sha256Expected: outputHash, sizeBytes: bytes.byteLength });
        if (options.autoIndex) {
          if (!this.storage.readIndex) throw new HwpHandsError('INVALID_ARGUMENT', '준비된 인덱스 저장에는 readIndex가 필요합니다.');
          const indexPath = `${path}.index.md`, existing = await this.storage.readIndex(indexPath), inspection = existing === undefined ? undefined : inspectIndex(existing);
          if (existing !== undefined && (inspection?.state !== 'managed' || inspection.source !== path)) warnings.push('사용자가 수정하거나 소유한 인덱스는 저장 대상에서 제외했습니다.');
          else {
            const tree = await engine.tree(); assertCurrent();
            const content = makeIndex({ ...this.state(s), dirty: false, conflict: false }, outputHash, tree.paragraphs, tree.tables, tree.fields, tree.stories);
            const before = existing === undefined ? null : Buffer.from(existing, 'utf8'), after = Buffer.from(content, 'utf8');
            artifacts.push({ path: indexPath, before, after });
            writeSet.push({ path: indexPath, role: 'derived', op: before === null ? 'create' : 'modify', sha256Before: before === null ? null : hash(before), sha256Expected: hash(after), sizeBytes: after.byteLength });
          }
        }
      }
      await this.checkDisk(s); assertCurrent();
      return this.preparedSaves.add({ mode: 'overwrite', source, destination: path, format: this.state(s).format,
        saveOptions: options, writeSet, report: { pendingActors: s.actorLedger.current(), warnings } }, artifacts, current);
    }));
  }
  /** Resolves a new destination and a disk template without creating a working copy. */
  resolveNewDocument(destination: string, template?: string): Promise<{ destination: string; template?: { path: string; sha256: string } }> {
    destination = documentPath(destination); template = template === undefined ? undefined : documentPath(template);
    return this.runPaths([destination, ...(template ? [template] : [])], async () => {
      if (!this.storage.pathKind) throw new HwpHandsError('INVALID_ARGUMENT', '새 경로 검사를 지원하지 않는 저장소입니다.');
      if (this.sessions.has(destination) || await this.storage.pathKind(destination) !== null) throw new HwpHandsError('FILE_CONFLICT', '새 문서 경로가 이미 있습니다.');
      if (template && this.sessions.get(template)?.dirty) throw new HwpHandsError('UNSAVED_CHANGES', '템플릿 작업본을 먼저 저장하세요.');
      return { destination, ...(template ? { template: { path: template, sha256: hash(await this.storage.read(template)) } } : {}) };
    });
  }
  /** Freezes a copy, blank document or disk template. Source actors and Undo are never approved by saving a copy. */
  prepareNewDocument(request: NewSaveRequest): Promise<PreparedSave> {
    request = structuredClone(request);
    request.destination = documentPath(request.destination);
    if (request.source) request.source.path = documentPath(request.source.path);
    if (request.template) request.template.path = documentPath(request.template.path);
    if (request.source && request.template) return Promise.reject(new HwpHandsError('INVALID_ARGUMENT', '사본과 템플릿을 동시에 지정할 수 없습니다.'));
    const from = request.source?.path ?? request.template?.path;
    if (from && (from.toLowerCase() === request.destination.toLowerCase() || from.split('.').at(-1)!.toLowerCase() !== request.destination.split('.').at(-1)!.toLowerCase()))
      return Promise.reject(new HwpHandsError('INVALID_ARGUMENT', '같은 형식의 새 경로를 사용하세요.'));
    const paths = [request.destination, ...(request.source ? [request.source.path] : []), ...(request.template ? [request.template.path] : [])];
    return this.withAutosavePathsPaused(paths, 'commit-prepare', () => this.runPaths(paths, async () => {
      const options = { ...this.options }, s = request.source ? await this.session(request.source.path) : undefined;
      if (s) this.expectQueryContext(s, request.source!);
      const engine = s?.engine, revision = s?.revision, baseHash = s?.baseHash, dirty = s?.dirty, actors = s?.actorLedger.fingerprint();
      const generation = s ? this.inputGenerations.get(s.sessionId) ?? 0 : 0;
      const current = () => !this.disposed && canonicalSaveJson(this.options) === canonicalSaveJson(options)
        && !this.sessions.has(request.destination)
        && !this.transitions.some(t => paths.some(path => t.prefixes.some(prefix => within(path, prefix))))
        && !(request.template && (() => { const template = this.sessions.get(request.template.path); return template && (template.dirty || !this.stableInput(template.sessionId)); })());
      return prepareNewSave(request, { storage: this.storage, store: this.preparedSaves, engines: this.engineProvider, options, current,
        export: (engine, path, maxBytes, templateTails) => this.readableExport(engine, path, maxBytes, s?.sourceGuard, templateTails ?? s?.sectionTails),
        ...(s ? { source: { value: { path: s.path, sessionId: s.sessionId, revision: s.revision, baseHash: s.baseHash }, engine: s.engine, state: this.state(s), actors: s.actorLedger.current(),
          current: () => this.sessions.get(s.path) === s && s.path === request.source!.path && s.engine === engine && s.revision === revision
            && s.baseHash === baseHash && s.dirty === dirty && !s.conflict && s.actorLedger.fingerprint() === actors
            && (this.inputGenerations.get(s.sessionId) ?? 0) === generation && this.stableInput(s.sessionId),
          check: async () => { await this.checkDisk(s); } } } : {}),
      });
    }));
  }
  preparedSaveStatus(preparationId: string): PreparedSaveReceipt | undefined { return this.preparedSaves.status(preparationId); }
  cancelPreparedSave(preparationId: string): void { this.preparedSaves.cancel(preparationId); }
  /** Host hooks must not re-enter this manager's file queue. Duplicate calls return a passive pending/terminal receipt. */
  async executePreparedSave(ticket: PreparedSaveTicket, permit: PreparedSavePermit): Promise<PreparedSaveReceipt> {
    const { record, duplicate } = this.preparedSaves.claim(ticket);
    if (duplicate) return structuredClone(record.receipt!);
    const prep = record.preparation, receipt = record.receipt!;
    if (prep.mode !== 'overwrite') {
      const paths = [prep.destination, ...(prep.source ? [prep.source.path] : []), ...(prep.template ? [prep.template.path] : [])];
      try {
        await this.withAutosavePathsPaused(paths, 'commit-execute', () => this.runPaths(paths, () => executeNewSave(record, permit, this.storage, async () => {
          if (prep.source) { const s = this.sessions.get(prep.source.path); if (!s) throw new HwpHandsError('REVISION_CONFLICT', '원본 세션이 닫혔습니다.'); await this.checkDisk(s); }
        })));
      } catch (error) { receipt.state = 'not_written'; receipt.error = { code: 'REVISION_CONFLICT', message: String(error) }; }
      return this.preparedSaves.finish(record);
    }
    const source = prep.source!;

    let attempted = false;
    const assertCurrent = () => {
      if (!permit || !permit.signal || permit.signal.aborted || Date.parse(record.ticket!.expiresAt) <= Date.now()
        || Date.parse(prep.expiresAt) <= Date.now() || !record.current()) throw new HwpHandsError('REVISION_CONFLICT', '저장 승인 상태가 만료되거나 문서·입력이 변경되었습니다. 다시 준비하고 승인하세요.');
      permit.assertAuthorized();
    };
    const failed = (error: unknown) => {
      receipt.error = { code: error instanceof HwpHandsError ? error.code : 'VERIFY_FAILED', message: error instanceof Error ? error.message : String(error) };
      receipt.state = attempted ? 'unknown' : 'not_written';
    };
    const observe = async () => {
      // Observe under the source queue, before subsequent human/autosave writes can run.
      for (const entry of prep.writeSet) {
        if (entry.kind === 'folder') throw new HwpHandsError('INVALID_ARGUMENT', 'overwrite에는 새 폴더가 없습니다.');
        const item = receipt.entries.find(item => item.path === entry.path)!;
        try {
          const bytes = entry.role === 'primary' ? await this.storage.read(entry.path) : await this.storage.readIndex!(entry.path).then(text => text === undefined ? null : Buffer.from(text, 'utf8'));
          const actual = bytes === null ? null : hash(bytes); if (actual !== null) item.sha256After = actual;
          item.state = actual === entry.sha256Expected ? (actual === entry.sha256Before ? 'unchanged' : 'written')
            : actual === entry.sha256Before ? 'not_written' : 'unknown';
        } catch { item.state = attempted ? 'unknown' : 'not_written'; }
      }
      if (attempted) receipt.state = receipt.entries.every(entry => entry.state === 'written' || entry.state === 'unchanged') ? 'written'
        : receipt.entries.some(entry => entry.state === 'unknown') ? 'unknown'
        : receipt.entries.some(entry => entry.state === 'written') ? 'partial' : 'not_written';
    };
    try {
      await this.withAutosavePathsPaused([source.path], 'commit-execute', () => this.run(source.path, async path => {
        try {
          assertCurrent(); const s = this.sessions.get(path)!;
          const readArtifact = async (item: PreparedSaveArtifact): Promise<Uint8Array | null> => {
            if (item.path === path) return this.storage.read(path);
            const text = await this.storage.readIndex!(item.path); return text === undefined ? null : Buffer.from(text, 'utf8');
          };
          const checkBefore = async () => {
            for (const item of record.artifacts) {
              const bytes = await readArtifact(item), entry = prep.writeSet.find(entry => entry.kind !== 'folder' && entry.path === item.path)!;
              if (entry.kind === 'folder') throw new HwpHandsError('INVALID_ARGUMENT', '잘못된 overwrite 항목');
              if ((bytes === null ? null : hash(bytes)) !== entry.sha256Before) throw new HwpHandsError('FILE_CONFLICT', '승인한 저장 대상이 디스크에서 변경되었습니다.');
              if (hash(item.after) !== entry.sha256Expected) throw new HwpHandsError('VERIFY_FAILED', '준비한 저장 바이트가 변경되었습니다.');
            }
            assertCurrent(); await this.checkDisk(s); assertCurrent();
          };
          await checkBefore();
          if (!prep.writeSet.length) { receipt.state = 'written'; return; }
          await permit.persistCheckpoint({ preparation: structuredClone(prep), ticketId: record.ticket!.ticketId,
            artifacts: record.artifacts.map(item => ({ path: item.path, before: item.before?.slice() ?? null, after: item.after.slice() })) });
          await checkBefore();
          const primary = record.artifacts[0];
          const result = await this.commitVerifiedExport(s, primary.after, primary.before!, { ...prep.saveOptions, autoIndex: false },
            () => { assertCurrent(); return true; }, () => { assertCurrent(); attempted = true; }, true, checkBefore);
          if (!result) throw new HwpHandsError('REVISION_CONFLICT', '저장 승인이 변경되었습니다.');
          receipt.warnings.push(...result.warnings);
          // After the primary write starts, finish/observe this revision even if new input arrives. Never retry it.
          for (const item of record.artifacts.slice(1)) {
            const entry = prep.writeSet.find(entry => entry.kind !== 'folder' && entry.path === item.path)!, before = await readArtifact(item);
            if (entry.kind === 'folder') throw new HwpHandsError('INVALID_ARGUMENT', '잘못된 overwrite 항목');
            if ((before === null ? null : hash(before)) !== entry.sha256Before) throw new HwpHandsError('FILE_CONFLICT', '원본 저장 후 인덱스 파일이 변경되었습니다.');
            await this.checkDisk(s);
            const finalBefore = await readArtifact(item);
            if ((finalBefore === null ? null : hash(finalBefore)) !== entry.sha256Before) throw new HwpHandsError('FILE_CONFLICT', '인덱스 쓰기 직전에 파일이 변경되었습니다.');
            let indexError: unknown;
            try { await this.storage.writeIndex(item.path, Buffer.from(item.after).toString('utf8'), path); } catch (error) { indexError = error; }
            const after = await readArtifact(item);
            if (!after || hash(after) !== entry.sha256Expected) throw indexError instanceof Error ? indexError : new HwpHandsError('VERIFY_FAILED', '준비된 인덱스 저장 후 해시가 일치하지 않습니다.');
            if (indexError) receipt.warnings.push(`인덱스 쓰기 호출은 오류를 반환했지만 디스크 해시가 일치합니다: ${indexError instanceof Error ? indexError.message : JSON.stringify(indexError)}`);
          }
          receipt.state = 'written';
        } catch (error) { failed(error); }
        finally { await observe(); }
      }));
    } catch (error) { failed(error); }
    return this.preparedSaves.finish(record);
  }
  /** Read-only rollback preflight; the host must lock, compare again and perform its own checkpoint restore. */
  async checkPreparedSaveRollback(preparationId: string): Promise<{ allowed: boolean; reason?: string }> {
    const record = this.preparedSaves.get(preparationId), receipt = structuredClone(record.receipt);
    if (!receipt || (receipt.state !== 'written' && receipt.state !== 'partial') || !receipt.entries.length) return { allowed: false, reason: 'no-terminal-write' };
    return this.run(record.preparation.destination, async path => {
      const s = this.sessions.get(path);
      if (s?.dirty || !this.stableInput(s?.sessionId ?? record.preparation.source?.sessionId ?? '')) return { allowed: false, reason: 'unsaved-input' };
      for (const entry of receipt.entries) {
        if (record.preparation.writeSet.find(item => item.path === entry.path)?.kind === 'folder') return { allowed: false, reason: 'host-folder-preflight-required' };
        if (!entry.sha256After || (entry.state !== 'written' && entry.state !== 'unchanged')) return { allowed: false, reason: 'unverified-after-hash' };
        try {
          const bytes = entry.path === path ? await this.storage.read(path) : await this.storage.readIndex!(entry.path).then(text => text === undefined ? null : Buffer.from(text, 'utf8'));
          if (!bytes || hash(bytes) !== entry.sha256After) return { allowed: false, reason: 'after-hash-changed' };
        } catch { return { allowed: false, reason: 'after-hash-unreadable' }; }
      }
      return { allowed: true };
    });
  }
  /** Holds the existing file queue through verification/commit. Later commands run after this revision, never inside it. */
  private async executeAutosave(candidate: AutosaveCandidate): Promise<AutosaveOutcome> {
    if (this.disposed || !candidate.isCurrent()) return { deferred: 'stale-candidate' };
    return this.run(candidate.path, async path => {
      // Do not call session(path): a late candidate must never reopen a closed incarnation.
      const s = this.sessions.get(path);
      if (!s || s.sessionId !== candidate.sessionId || s.revision !== candidate.revision || !candidate.isCurrent()) return { deferred: 'stale-candidate' };
      const options = { ...this.options }, limits = { ...this.autosaveOptions!.limits! };
      const policy = this.autosaveOptions!.blockReason, engine = s.engine, baseHash = s.baseHash, format = this.state(s).format, actors = s.actorLedger.fingerprint();
      const current = () => !this.disposed && this.sessions.get(path) === s && s.engine === engine
        && s.sessionId === candidate.sessionId && s.path === path && s.revision === candidate.revision
        && s.baseHash === baseHash && this.state(s).format === format && s.dirty && !s.conflict
        && s.actorLedger.fingerprint() === actors && !s.actorLedger.blockReason()
        && Object.keys(options).every(key => this.options[key as keyof ManagerOptions] === options[key as keyof ManagerOptions])
        && this.autosaveOptions!.blockReason === policy
        && this.autosaveOptions!.limits?.maxCandidateBytes === limits.maxCandidateBytes
        && this.autosaveOptions!.limits?.maxPages === limits.maxPages && candidate.isCurrent();
      if (!current()) return { deferred: 'stale-candidate' };
      if (s.pageCount > limits.maxPages) return { deferred: 'unsupported-autosave-size' };
      const maxBytes = Math.min(options.maxFileBytes, limits.maxCandidateBytes);
      const original = await this.checkDisk(s);
      if (!current()) return { deferred: 'stale-candidate' };
      if (original.byteLength > maxBytes) return { deferred: 'unsupported-autosave-size' };
      const { bytes, warnings } = await this.readableExport(engine, path, maxBytes, s.sourceGuard, s.sectionTails);
      if (!current()) return { deferred: 'stale-candidate' };
      const result = await this.commitVerifiedExport(s, bytes, original, options, current, () => candidate.writing());
      return result ? { savedRevision: candidate.revision, warnings: [...warnings, ...result.warnings] } : { deferred: 'stale-candidate' };
    });
  }
  /** Shared binary safety stages. A guard selects autosave's retention and stale-discard policy. */
  private async commitVerifiedExport(s: Session, bytes: Uint8Array, original: Uint8Array, options: ManagerOptions, current?: () => boolean, onWrite?: () => void, approveActors = false, beforeWrite?: () => Promise<void>): Promise<SaveResult | undefined> {
    if (current && !current()) return;
    const outputHash = hash(bytes);
    const unchanged = !!current && outputHash === s.baseHash;
    const backupPath = options.backup && !unchanged ? await this.storage.backup(s.path, original) : undefined;
    if (current && !current()) return;
    await this.persistRecovery(s, outputHash);
    // Even a stale/failed attempt may have written its intended-save marker. The next edit must replace it.
    if (current) s.journalNeedsRewrite = true;
    if (current && !current()) return;
    await this.checkDisk(s); // Detect changes made while the backup was being written.
    if (current && !current()) return;
    if (beforeWrite) await beforeWrite();
    if (current && !current()) return;
    onWrite?.();
    if (current && !current()) return;
    let writeError: unknown;
    if (!unchanged) { try { await this.storage.write(s.path, bytes); } catch (error) { writeError = error; } }
    let written: Uint8Array;
    try { written = await this.storage.read(s.path); }
    catch (error) {
      s.conflict = true; this.emit('conflict', s);
      throw new HwpHandsError('VERIFY_FAILED', '저장 후 원본을 다시 읽을 수 없습니다. 백업과 복구 기록을 보존했습니다.', { backupPath, writeError: writeError instanceof Error ? writeError.message : JSON.stringify(writeError ?? ''), verifyError: String(error) });
    }
    const writtenHash = hash(written);
    if (writtenHash !== outputHash) {
      if (writtenHash !== s.baseHash) { s.conflict = true; this.emit('conflict', s); }
      throw new HwpHandsError('VERIFY_FAILED', '저장 후 디스크 내용이 예상 결과와 다릅니다. 백업과 복구 기록을 보존했습니다.', { backupPath, expectedHash: outputHash, actualHash: writtenHash, writeError: writeError instanceof Error ? writeError.message : JSON.stringify(writeError) });
    }
    s.baseHash = hash(bytes); s.dirty = false; s.soleAiActor = undefined; s.conflict = false; s.writePreflight = { available: true };
    const warnings: string[] = writeError === undefined ? [] : [`쓰기 호출은 오류를 반환했지만 디스크 해시가 저장 결과와 일치합니다: ${writeError instanceof Error ? writeError.message : JSON.stringify(writeError)}`]; let indexPath: string | undefined;
    // Automatic saves retain the intended-save marker and the active Undo seed/actions. A later edit
    // rewrites the marker with the new baseHash; manual save retains its existing cleanup contract.
    if (!current || approveActors) s.actorLedger.approveCurrent();
    if (!current) {
      try { await this.storage.removeRecovery(s.path); s.journalNeedsRewrite = true; s.journalIntendedSaveHash = undefined; s.checkpointAttempt = undefined; } catch (error) { warnings.push(`복구 기록 정리 실패: ${String(error)}`); }
    }
    // Only after the new file is verified on disk, so a failed save never costs an older backup.
    if (backupPath && this.storage.pruneBackups) { try { await this.storage.pruneBackups(s.path); } catch (error) { console.error('HWP Hands backup pruning:', error); } }
    if (options.autoIndex) { try { indexPath = await this.index(s, !!current); } catch (error) { warnings.push(`원본은 저장했지만 인덱스 생성에 실패했습니다: ${String(error)}`); } }
    this.emit('saved', s); return { ...this.state(s), backupPath, indexPath, warnings };
  }
  private async index(s: Session, reuseCurrent = false): Promise<string> {
    const path = `${s.path}.index.md`;
    if (s.dirty || s.conflict) throw new HwpHandsError('UNSAVED_CHANGES', '원본을 먼저 저장하세요.');
    const sourceHash = s.baseHash, revision = s.revision;
    if (reuseCurrent) {
      const existing = await this.storage.readIndex?.(path), inspection = existing === undefined ? undefined : inspectIndex(existing);
      if (inspection?.state === 'managed' && inspection.source === s.path && inspection.sourceSha256 === sourceHash) {
        await this.checkDisk(s); return path;
      }
    }
    const tree = await s.engine.tree();
    await this.checkDisk(s);
    if (s.baseHash !== sourceHash || s.revision !== revision || s.dirty || s.conflict) throw new HwpHandsError('FILE_CONFLICT', '인덱스 생성 중 원본 문서가 변경되었습니다. 다시 시도하세요.');
    const content = makeIndex(this.state(s), sourceHash, tree.paragraphs, tree.tables, tree.fields, tree.stories);
    await this.storage.writeIndex(path, content, s.path); return path;
  }
  async syncIndexRename(oldInput: string, newInput: string): Promise<void> {
    const oldSource = documentPath(oldInput), newSource = documentPath(newInput);
    const oldIndex = `${oldSource}.index.md`, newIndex = `${newSource}.index.md`;
    await this.externalChange(newSource);
    const bytes = await this.storage.read(newSource), sourceHash = hash(bytes);
    const moved = await this.storage.moveManagedIndex?.(oldIndex, newIndex, oldSource, newSource, sourceHash);
    if (!moved && this.storage.removeManagedIndex) {
      const existing = await this.storage.readIndex?.(oldIndex);
      const inspection = existing === undefined ? undefined : inspectIndex(existing);
      if (inspection?.state === 'managed' && inspection.source === oldSource && inspection.sourceSha256 !== sourceHash) {
        await this.storage.removeManagedIndex(oldIndex, oldSource);
      }
    }
    if (!this.options.autoIndex) return;
    const session = this.sessions.get(newSource);
    if (session?.dirty || session?.conflict) return;
    const status = await this.api.index.status(newSource);
    if (status.state === 'missing' || status.state === 'stale') await this.api.index.refresh(newSource);
  }
  async removeSourceIndex(input: string): Promise<boolean> {
    const source = documentPath(input);
    return this.storage.removeManagedIndex?.(`${source}.index.md`, source) ?? false;
  }
  private async reload(s: Session, discard: boolean, assertCurrent?: () => void): Promise<State> {
    if (s.dirty && !discard) throw new HwpHandsError('UNSAVED_CHANGES', '저장되지 않은 변경이 있습니다. discardChanges를 지정하거나 새 파일로 저장하세요.');
    const resume = this.pauseAutosave(s, 'reload');
    try {
      assertCurrent?.();
      const bytes = await this.storage.read(s.path);
      assertCurrent?.();
      if (bytes.byteLength > this.options.maxFileBytes) throw new HwpHandsError('INVALID_ARGUMENT', '문서 크기 제한을 초과합니다.');
      const sourceGuard = hwpSourceGuard(s.path, bytes);
      if (sourceGuard === 'tracked') assertHwpSourceSafe(sourceGuard);
      const replacement = await this.engineProvider.parse(bytes);
      try { assertCurrent?.(); await this.storage.removeRecovery(s.path); } catch (error) { await replacement.free(); throw error; }
      this.clearQueryCache(s); await this.release(s); s.engine = replacement; s.pageCount = await replacement.pages(); s.undo = []; s.redo = []; s.activeGroup = undefined; s.actorLedger = new EditActorLedger(); s.baseHash = hash(bytes); s.sourceGuard = sourceGuard; s.sectionTails = /\.hwp$/i.test(s.path) ? inspectSectionTails(bytes) : { status: 'clear' }; s.seed = bytes; s.actions = []; s.actionBytes = 2; s.commandCount = 0; s.checkpointAttempt = undefined; s.journalSequence = undefined; s.journalTailHash = undefined; s.journalActionCount = 0; s.journalNeedsRewrite = undefined; s.journalIntendedSaveHash = undefined; s.dirty = false; s.soleAiActor = undefined; s.conflict = false; s.revision = ++this.sequence; s.capabilityCache = undefined; s.writePreflight = undefined;
      this.emit('reloaded', s); return this.state(s);
    } finally { resume(); }
  }
  externalChange(path: string): Promise<void> {
    if (!this.sessions.has(path) || this.disposed) return Promise.resolve();
    return this.run(path, async path => {
      const s = this.sessions.get(path); if (!s) return;
      let bytes: Uint8Array;
      try { bytes = await this.storage.read(path); } catch { s.conflict = true; this.emit('conflict', s); return; }
      if (hash(bytes) === s.baseHash) return;
      if (s.dirty) { s.conflict = true; this.emit('conflict', s); } else { await this.reload(s, false); }
    });
  }
  async handleExternalModify(input: string): Promise<void> {
    const path = documentPath(input);
    await this.externalChange(path);
    if (!this.options.autoIndex) return;
    const session = this.sessions.get(path);
    if (session?.dirty || session?.conflict) return;
    const status = await this.api.index.status(path);
    if (status.state === 'missing' || status.state === 'stale') await this.api.index.refresh(path);
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    oldPath = documentPath(oldPath);
    if (this.disposed) return;
    const resume = this.pauseAutosave(this.sessions.get(oldPath), 'rename');
    try {
    let path: string;
    if (!/\.(hwp|hwpx)$/i.test(newPath)) {
      await this.run(oldPath, async () => {
        const s = this.sessions.get(oldPath); if (!s) return;
        if (!s.dirty) { this.emit('closed', s); await this.release(s); this.sessions.delete(oldPath); return; }
        await this.persistRecovery(s);
        this.clearQueryCache(s); s.conflict = true; s.revision = ++this.sequence; this.emit('conflict', s);
      });
      return;
    }
    path = documentPath(newPath);
    if (path === oldPath) return;
    await this.runPaths([oldPath, path], async () => {
      const s = this.sessions.get(oldPath); if (!s) return;
      if (this.sessions.has(path)) throw new HwpHandsError('FILE_CONFLICT', '대상 문서 세션이 이미 열려 있습니다.');
      const moveRecovery = s.dirty || s.journalIntendedSaveHash !== undefined;
      if (moveRecovery) await this.persistRecovery(s, s.dirty ? undefined : s.baseHash, path);
      this.clearQueryCache(s); this.sessions.delete(oldPath); s.path = path; this.sessions.set(path, s); s.revision = ++this.sequence; s.capabilityCache = undefined; s.writePreflight = undefined;
      if (moveRecovery) {
        try { await this.storage.removeRecovery(oldPath); } catch (error) { console.error('HWP Hands stale recovery cleanup:', error); }
      }
      this.emit('renamed', s, { oldPath });
    });
    } finally { resume(); }
  }
  async renameFolder(oldInput: string, newInput: string): Promise<void> {
    const oldPath = folderPath(oldInput), newPath = folderPath(newInput);
    if (oldPath === newPath || newPath.startsWith(`${oldPath}/`) || this.disposed) return;
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    const transition: PathTransition = { prefixes: [oldPath, newPath], promise, release };
    this.transitions.push(transition);
    const resumes = [...this.sessions.values()].filter(s => within(s.path, oldPath) || within(s.path, newPath)).map(s => this.pauseAutosave(s, 'rename'));
    const previousTransition = this.transitionTail;
    let finishTransition!: () => void;
    this.transitionTail = new Promise<void>(resolve => { finishTransition = resolve; });
    try {
      await previousTransition.catch(() => undefined);
      const affected = new Set<string>();
      for (const path of [...this.sessions.keys(), ...this.pending.keys()]) {
        if (within(path, oldPath)) affected.add(path);
        if (within(path, newPath)) affected.add(path);
      }
      await Promise.allSettled([...new Set([...affected].map(path => this.pending.get(path)).filter((p): p is Promise<unknown> => !!p))]);
      const moves = [...this.sessions.keys()].filter(path => within(path, oldPath)).map(source => ({ source, target: `${newPath}${source.slice(oldPath.length)}` }));
      const targets = new Set<string>();
      for (const move of moves) {
        documentPath(move.target);
        if (targets.has(move.target) || (this.sessions.has(move.target) && !moves.some(other => other.source === move.target))) throw new HwpHandsError('FILE_CONFLICT', `대상 문서 세션이 이미 열려 있습니다: ${move.target}`);
        targets.add(move.target);
      }
      await this.runPaths(moves.flatMap(move => [move.source, move.target]), async () => {
        for (const move of moves) {
          const s = this.sessions.get(move.source);
          if (s && (s.dirty || s.journalIntendedSaveHash !== undefined)) await this.persistRecovery(s, s.dirty ? undefined : s.baseHash, move.target);
        }
        for (const move of moves) {
          const s = this.sessions.get(move.source); if (!s) continue;
          this.clearQueryCache(s); this.sessions.delete(move.source); s.path = move.target; s.revision = ++this.sequence; s.capabilityCache = undefined; s.writePreflight = undefined; this.sessions.set(move.target, s);
        }
        for (const move of moves) {
          const s = this.sessions.get(move.target); if (!s) continue;
          if (s.dirty || s.journalIntendedSaveHash !== undefined) { try { await this.storage.removeRecovery(move.source); } catch (error) { console.error('HWP Hands stale recovery cleanup:', error); } }
          this.emit('renamed', s, { oldPath: move.source });
        }
      }, true);
    } finally {
      this.transitions.splice(this.transitions.indexOf(transition), 1);
      release(); finishTransition();
      for (const resume of resumes) resume();
      // A session may have finished opening from an earlier queued request after the transition began.
      for (const s of this.sessions.values()) if (within(s.path, oldPath) || within(s.path, newPath)) this.autosaveDocuments.get(s.sessionId)?.changed();
    }
  }
  private cancelIdle(s: Session | undefined): void {
    if (s?.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = undefined; }
  }
  private async closeSession(s: Session): Promise<void> {
    this.cancelIdle(s);
    if (this.sessions.get(s.path) !== s) return;
    this.emit('closed', s); await this.release(s); this.sessions.delete(s.path);
  }
  private scheduleIdle(path: string): void {
    const s = this.sessions.get(path);
    // Dirty sessions have a durable recovery journal and stay resident until they are saved or discarded.
    if (!s || s.references > 0 || s.dirty || this.disposed) return;
    this.cancelIdle(s);
    s.idleTimer = setTimeout(() => {
      s.idleTimer = undefined;
      if (this.sessions.get(path) === s && s.references === 0 && !s.dirty) void this.closeSession(s).catch(error => console.error('HWP Hands idle cleanup:', error));
    }, DEFAULT_SESSION_IDLE_MS);
    const timer = s.idleTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }
  private async release(s: Session): Promise<void> {
    this.cancelIdle(s);
    try { await this.clearHistory(s, s.undo); await this.clearHistory(s, s.redo); }
    finally { await s.engine.free(); }
  }
  async retainView(path: string): Promise<DocumentLease> { return this.acquireLease(path); }
  /** Internal, once per session: whether a view should ask to keep changes replayed from an earlier run (decision 69). */
  takeRecoveredUnasked(sessionId: string): boolean {
    const s = [...this.sessions.values()].find(item => item.sessionId === sessionId);
    if (!s?.recoveredUnasked) return false;
    s.recoveredUnasked = false;
    return s.dirty;
  }
  /** Internal, for the close prompt: an unsaved working copy that no view or API consumer holds any more. */
  unheldUnsaved(path: string): State | undefined {
    const s = this.sessions.get(documentPath(path));
    return s && !this.disposed && s.dirty && s.references === 0 ? this.state(s) : undefined;
  }
  /** Internal, the close prompt's "save": saves only while nobody took the working copy up again, then lets it idle out. */
  saveUnheld(path: string, options: { sessionId: string; expectedRevision: number }): Promise<SaveResult> {
    const source = documentPath(path);
    return this.withAutosavePathsPaused([source], 'manual-save', () => this.run(source, async path => {
      const s = this.unheldSession(path, options);
      const result = await this.withAutosavePaused(s, 'manual-save', () => this.save(s, options.expectedRevision));
      this.scheduleIdle(path); return result;
    }));
  }
  /** Internal, the close prompt's "don't save": drops the changes and their recovery record, then lets the session idle out. */
  discardUnheld(path: string, options: { sessionId: string; expectedRevision: number }): Promise<State> {
    const source = documentPath(path);
    return this.withAutosavePathsPaused([source], 'reload', () => this.run(source, async path => {
      const s = this.unheldSession(path, options);
      const state = await this.reload(s, true);
      this.scheduleIdle(path); return state;
    }));
  }
  private unheldSession(path: string, options: { sessionId: string; expectedRevision: number }): Session {
    const s = this.sessions.get(path);
    if (!s || s.sessionId !== options?.sessionId) throw new HwpHandsError('CLOSED', '문서 작업본이 이미 닫혔거나 다른 세션입니다.');
    if (s.references > 0) throw new HwpHandsError('INVALID_ARGUMENT', '다른 화면 또는 API 소비자가 이 문서를 다시 사용하고 있습니다.');
    this.expect(s, options.expectedRevision);
    return s;
  }
  private async acquireLease(path: string): Promise<DocumentLease> {
    const session = await this.run(path, async path => {
      const s = await this.session(path); s.references++; return s;
    });
    let active = true;
    return {
      state: this.state(session),
      release: async () => {
        if (!active) return;
        active = false;
        if (this.disposed) return;
        await this.runPaths([session.path], async () => { if (session.references > 0) session.references--; });
        // Rename may have moved the session while release waited on the path transition.
        this.scheduleIdle(session.path);
      }
    };
  }
  async cleanupPlan(now?: number): Promise<CleanupPlan> {
    if (this.storage.cleanupPlan) return this.storage.cleanupPlan(now);
    return { candidates: [], managedBackups: 0, retainedBackups: 0, legacyBackups: 0, recoveryRecords: 0, inputDrafts: 0, temporaryFiles: 0 };
  }
  async cleanupStorage(paths: string[], now?: number): Promise<string[]> {
    if (!this.storage.cleanupManagedFiles) return [];
    return this.storage.cleanupManagedFiles(paths, now);
  }
  private async checkpointRecovery(s: Session, force = false): Promise<boolean> {
    const actionBytes = s.actionBytes;
    if (!force && s.actions.length <= CHECKPOINT_ACTIONS && actionBytes <= CHECKPOINT_RETRY_BYTES) return false;
    const attempt = s.checkpointAttempt;
    if (!force && attempt?.seed === s.seed && s.actions.length - attempt.actionCount < CHECKPOINT_RETRY_ACTIONS
      && actionBytes - attempt.actionBytes < CHECKPOINT_RETRY_BYTES) return false;
    const retained = [...s.origins].map(([id, origin]) => ({ id, origin }));
    if (retained.some(entry => entry.origin === undefined)) throw new HwpHandsError('VERIFY_FAILED', 'undo/redo 복구 위치를 찾을 수 없습니다.');
    const checkpointOrigin = retained.length ? Math.min(...retained.map(entry => entry.origin)) : s.actions.length;
    if (checkpointOrigin <= 0) return false;
    const checkpointId = retained.find(entry => entry.origin === checkpointOrigin)?.id;
    const current = await s.engine.snapshot();
    let seed: Uint8Array;
    try {
      if (checkpointId !== undefined) await s.engine.restore(checkpointId);
      try { seed = await this.verifiedExport(s.engine, s.path, this.state(s).format); }
      catch (error) {
        // A readable but changed seed could invalidate replay coordinates. Keep the original seed/actions instead.
        if (error instanceof HwpHandsError && (error.code === 'CONTENT_LOSS' || error.code === 'VERIFY_FAILED')) {
          s.checkpointAttempt = { seed: s.seed, actionCount: s.actions.length, actionBytes, result: 'validation-failed' };
          return false;
        }
        throw error;
      }
    } finally {
      await s.engine.restore(current); await this.discardSnapshot(s, current);
    }
    if (seed.byteLength > this.options.maxFileBytes) throw new HwpHandsError('INVALID_ARGUMENT', '복구 체크포인트가 문서 크기 제한을 초과합니다.');
    s.actorLedger.seed = checkpointId === undefined ? s.actorLedger.current() : s.actorLedger.at(checkpointId);
    s.seed = seed; s.actions = s.actions.slice(checkpointOrigin); s.actionBytes = actionsSize(s.actions);
    s.commandCount = s.actions.reduce((count, action) => count + ('commands' in action ? action.commands.length : 0), 0);
    for (const [id, origin] of s.origins) s.origins.set(id, origin - checkpointOrigin);
    s.checkpointAttempt = { seed, actionCount: s.actions.length, actionBytes: s.actionBytes, result: 'success' };
    return true;
  }
  private async persistRecovery(s: Session, intendedSaveHash?: string, path = s.path): Promise<void> {
    const previous = { seed: s.seed, actions: s.actions, actionBytes: s.actionBytes, commandCount: s.commandCount, actorSeed: s.actorLedger.seed, origins: new Map(s.origins), checkpointAttempt: s.checkpointAttempt };
    try { await this.writeRecoveryRecord(s, intendedSaveHash, path); }
    catch (error) {
      // A failed checkpoint write cannot move the in-memory replay origin ahead of the durable journal.
      s.seed = previous.seed; s.actions = previous.actions; s.actionBytes = previous.actionBytes; s.commandCount = previous.commandCount; s.actorLedger.seed = previous.actorSeed; s.origins = previous.origins; s.checkpointAttempt = previous.checkpointAttempt;
      throw error;
    }
  }
  private async writeRecoveryRecord(s: Session, intendedSaveHash?: string, path = s.path): Promise<void> {
    const projectedActors = s.actorLedger.persistent(s.actions.flatMap(action => 'commands' in action ? [action.editId!] : []));
    const overLimit = s.actions.length > MAX_RECOVERY_ACTIONS || s.commandCount > MAX_RECOVERY_COMMANDS
      || recoveryExpandedSize(s.seed.byteLength, s.actionBytes, projectedActors) > this.maxRecoveryBytes();
    const checkpointed = await this.checkpointRecovery(s, overLimit);
    if (s.actions.length > MAX_RECOVERY_ACTIONS) throw new HwpHandsError('INVALID_ARGUMENT', `복구 기록 작업 수가 ${MAX_RECOVERY_ACTIONS}개 제한을 초과합니다.`);
    const commandCount = s.commandCount;
    if (commandCount > MAX_RECOVERY_COMMANDS) throw new HwpHandsError('INVALID_ARGUMENT', `복구 기록 명령 수가 ${MAX_RECOVERY_COMMANDS}개 제한을 초과합니다.`);
    const actors = s.actorLedger.persistent(s.actions.flatMap(action => 'commands' in action ? [action.editId!] : []));
    const maxBytes = this.maxRecoveryBytes();
    const expandedBytes = recoveryExpandedSize(s.seed.byteLength, s.actionBytes, actors);
    if (expandedBytes > maxBytes) throw new HwpHandsError('INVALID_ARGUMENT', `복구 기록이 ${Math.round(maxBytes / 1024 / 1024)} MiB 제한을 초과합니다. 더 작은 단위로 편집하거나 저장하세요.`);
    if (this.storage.appendRecovery) {
      const rewrite = checkpointed || s.journalNeedsRewrite === true || s.journalTailHash === undefined || intendedSaveHash !== undefined || s.journalIntendedSaveHash !== intendedSaveHash || path !== s.path || s.actions.length !== s.journalActionCount + 1;
      if (rewrite) {
        const header = createRecoveryV3Header({
          pluginVersion: this.pluginVersion, engineVersion: ENGINE_VERSION, commandSchema: COMMAND_SCHEMA_VERSION,
          path, baseHash: s.baseHash, seedHash: hash(s.seed), seedBytes: s.seed.byteLength,
          seed: Buffer.from(s.seed).toString('base64'), historyLimit: s.historyLimit, intendedSaveHash,
          actors,
        });
        let tailHash = header.recordHash;
        for (let index = 0; index < s.actions.length; index++) tailHash = createRecoveryV3Line(index + 1, tailHash, s.actions[index]).hash;
        const recovery: RecoveryV3 = { ...header, actions: structuredClone(s.actions), sequence: s.actions.length, tailHash, truncatedTail: false };
        if (Buffer.byteLength(encodeRecoveryV3(recovery), 'utf8') > maxBytes) throw new HwpHandsError('INVALID_ARGUMENT', `복구 저널이 ${Math.round(maxBytes / 1024 / 1024)} MiB 제한을 초과합니다. 더 작은 단위로 편집하거나 저장하세요.`);
        await this.storage.writeRecovery(path, recovery);
        s.journalSequence = recovery.sequence; s.journalTailHash = recovery.tailHash; s.journalActionCount = s.actions.length; s.journalNeedsRewrite = false; s.journalIntendedSaveHash = intendedSaveHash;
      } else {
        const action = s.actions.at(-1);
        if (!action || s.journalSequence === undefined || !s.journalTailHash) throw new HwpHandsError('VERIFY_FAILED', '복구 저널 append 위치를 확인할 수 없습니다.');
        const line = createRecoveryV3Line(s.journalSequence + 1, s.journalTailHash, action);
        if (Buffer.byteLength(`${JSON.stringify(line)}\n`, 'utf8') > maxBytes) throw new HwpHandsError('INVALID_ARGUMENT', `복구 저널이 ${Math.round(maxBytes / 1024 / 1024)} MiB 제한을 초과합니다. 더 작은 단위로 편집하거나 저장하세요.`);
        await this.storage.appendRecovery(path, line, maxBytes);
        s.journalSequence = line.seq; s.journalTailHash = line.hash; s.journalActionCount = s.actions.length;
      }
      s.actorLedger.retainApprovals(actors.approved);
      return;
    }
    const expanded = Buffer.from(JSON.stringify({ seed: Buffer.from(s.seed).toString('base64'), actions: s.actions, actors }), 'utf8');
    const compressed = deflateSync(expanded, { level: 6 });
    const candidate: Omit<RecoveryV2, 'recordHash'> = {
      version: 2, pluginVersion: this.pluginVersion, engineVersion: ENGINE_VERSION, commandSchema: COMMAND_SCHEMA_VERSION,
      path, baseHash: s.baseHash, seedHash: hash(s.seed), seedBytes: s.seed.byteLength,
      actionCount: s.actions.length, commandCount, historyLimit: s.historyLimit, intendedSaveHash,
      payload: compressed.toString('base64'), payloadBytes: compressed.byteLength, expandedBytes,
      payloadHash: hash(compressed)
    };
    const recovery: RecoveryV2 = { ...candidate, recordHash: recoveryRecordHash(candidate) };
    if (Buffer.byteLength(JSON.stringify(recovery), 'utf8') > maxBytes) throw new HwpHandsError('INVALID_ARGUMENT', `복구 파일이 ${Math.round(maxBytes / 1024 / 1024)} MiB 제한을 초과합니다. 더 작은 단위로 편집하거나 저장하세요.`);
    await this.storage.writeRecovery(path, recovery);
    s.actorLedger.retainApprovals(actors.approved);
    s.journalActionCount = s.actions.length; s.journalIntendedSaveHash = intendedSaveHash;
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.autosave?.dispose(); this.autosaveDocuments.clear(); this.autosaveListeners.clear(); this.inputReaders.clear(); this.inputGenerations.clear(); await Promise.allSettled([...this.pending.values()]);
    this.preparedSaves.dispose();
    await Promise.allSettled([...this.sessions.values()].map(s => this.release(s)));
    this.sessions.clear(); this.listeners.clear();
    await this.engineProvider.dispose();
  }
}

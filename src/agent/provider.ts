import { DESCRIPTOR_TOOLS, EDIT_TOOLS, EDIT_TOOL_NAMES, CHECK_TOOL, SAVE_TOOL, CREATE_TOOL, SAVE_INSTRUCTIONS, EDIT_INSTRUCTIONS, INSTRUCTIONS, TOOL_EXAMPLES, contractGuide, validateToolInput } from './tool-catalog';
import type { BodyAddress, DocumentLease, Field, HwpHandsApiV1, Json, Paragraph, State, StoryParagraph, Table } from '../api';
import { HwpHandsError } from '../api';
import { AgentCommits, COMMIT_TOOL_NAMES, type CommitBridge, type CommitContext, type CommitTarget } from './commit';
import { AgentEdits, PREVIEW_CHARS, addressKey, checkboxBulletKey, clip, fieldKey, fieldPlaceKey, type EditBridge, type EditContext, type ResolvedTarget, type Shown } from './edit';
import { AgentEditor, ToolError, actorIdOf, type Caller, type EditorCapability, type TurnScope } from './editor';
import { SelectionGuard, addressPreserving, type AllowedRange } from './selection';
import type { EditMarks } from './marks';
import { inspectQuality } from './quality';
import { inspectImages } from './quality-images';
import { paragraphLayout } from './paragraph-layout';
import { indexParagraphLayouts, paragraphLayoutSummary, spanningTableCandidates } from './layout-summary';
import { isInputField } from './field-kinds';
import { domainErrorDetails, inputAt } from './error-details';
import { noteHandle, noteParagraphKey } from './notes';
import { runKey, runText, styleKey, styleText } from './styles';
import { sectionKey, sectionView } from './sections';
import { collectRevisionTables, TableCellIndex, TableRowIndex, tableTextFragments, tableTextPage } from './table-read';
import type { AgentPrivacy } from './privacy';
import type { ReadProgress } from '../../contracts/agentinterop/read-progress-v1/protocol';
import type { RewriteComputeRequest, RewriteComputeResult } from './rewrite-compute';

/**
 * Agent facade (agentinterop v1). An agent host discovers this object on the plugin instance under
 * AGENT_CAPABILITY_PROVIDER and calls describe()/callTool(). It knows nothing about any particular host.
 * API v1 stays the low-level surface; this layer gives a model short handles, paging and structured errors.
 * Handles are bound to one document epoch. A session or revision change starts a new epoch, except this layer's own
 * text replacements, which keep every paragraph address. Edit tools exist only when the plugin passes an edit bridge.
 */
export const AGENT_CAPABILITY_PROVIDER = Symbol.for('dev.agentinterop.capability-provider');
export const PROVIDERS_CHANGED_EVENT = 'agentinterop:providers-changed';

type JsonObject = { [key: string]: Json };
interface ToolResult { content: Array<{ type: 'text'; text: string }>; structuredContent?: JsonObject; isError?: boolean; _meta?: JsonObject }
interface InvocationContext extends EditContext { scope?: TurnScope }
export interface AgentProviderOptions {
  version: string;
  /** Person-controlled, persisted outside HWP/HWPX. Never supplied by a host or model. */
  privacy?: AgentPrivacy;
  /** Paths of documents that currently have a visible editor view. */
  viewPaths?: () => string[];
  leaseIdleMs?: number;
  now?: () => number;
  /** Internal worker computation; no document state or write authority is passed. */
  rewriteCompute?: (request: RewriteComputeRequest, signal?: AbortSignal) => Promise<RewriteComputeResult>;
  /** Internal opt-in. With it the provider also describes and runs session-effect edit tools. */
  edit?: EditBridge;
  /** Person-only confirmation for a single rejected replacement; never a model or host flag. */
  approveFormatException?: (request: { path: string; before: string; after: string }, signal?: AbortSignal) => Promise<boolean>;
  /** Brings the document to the front for a person and moves to the paragraph or page. Absent without a workspace. */
  reveal?: (path: string, target: { address?: BodyAddress; page?: number }) => Promise<void>;
  /** Review marks the editor views draw where AI edits landed. Used only with edit tools. */
  marks?: EditMarks;
  /** Internal opt-in, used only with edit tools. With it the provider also describes a commit-effect save tool and the commit capability. */
  commit?: CommitBridge;
}
export interface AgentCapabilityProvider {
  readonly protocol: 'agentinterop';
  readonly protocolVersion: 1;
  describe(): Promise<JsonObject>;
  callTool(name: string, args: JsonObject, ctx?: InvocationContext): Promise<ToolResult>;
  editor: EditorCapability;
  /** Present with edit tools: fixes the document a session call would edit, without changing anything. */
  resolveTarget?<Name extends string>(name: Name, args: JsonObject, ctx: InvocationContext): Promise<Name extends 'create_document' ? CommitTarget : ResolvedTarget>;
  /** Present with the save tool: prepares, performs and reports one approved write of a document file. A host never saves through callTool. */
  commit?: Pick<AgentCommits, 'prepare' | 'execute' | 'status'>;
  dispose(): Promise<void>;
}

const READ_BUDGET_CHARS = 8000;
const MAX_BLOCKS = 80;
const MAX_MATCHES = 20;
/** Documents one conversation may keep open with no view on them, and leases of all conversations together. */
const MAX_HELD_DOCUMENTS = 5, MAX_HELD_TOTAL = 10;
const SNIPPET_RADIUS = 40;
const MAX_SELECTION_HANDLES = 50;
interface Epoch { path: string; sessionId: string; revision: number; id: string; all?: Array<Paragraph | StoryParagraph>; withStories?: boolean; tables?: Table[]; tableIndex?: TableCellIndex; marks?: Marks }
/** Struck-through or non-black text. In review drafts these usually mean "delete" and "add", and plain text drops them. */
interface MarkSpan { start: number; end: number; text: string; strike: boolean; color?: string }
interface Marks { spans: Map<string, MarkSpan[]>; boxes: Map<string, string>; coverage: 'complete' | 'partial' | 'unavailable' }
interface MarkCount { strikethrough: number; textColor: number; partial: boolean }
interface Held { lease: DocumentLease; usedAt: number; owners: Set<string>; timer?: ReturnType<typeof setTimeout> }
interface Cursor { kind: string; epoch: string; binding: string; position: number; tablePosition?: import('./table-read').TableTextPosition; layoutTablePosition?: number }

export function createAgentProvider(api: HwpHandsApiV1, options: AgentProviderOptions): AgentCapabilityProvider {
  const raw = createUnwrappedProvider(api, options), privacy = options.privacy;
  if (!privacy) return raw;
  // Only contract path fields are inspected; search text, document content and model strings are not path declarations.
  const paths = (value: unknown): unknown[] => {
    if (!value || typeof value !== 'object') return [];
    const object = value as Record<string, unknown>;
    return [object.path, object.destination, ...(typeof object.template === 'string' ? [object.template] : paths(object.template)),
      ...['document', 'source', 'target', 'scope', 'args'].flatMap(name => paths(object[name]))];
  };
  const run = <T>(inputs: unknown[], signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    privacy.run(inputs.flatMap(paths), signal, action);
  const failure = (): ToolResult => ({ isError: true, content: [{ type: 'text', text: 'AI 비공개 설정으로 이 요청을 차단했다. 사람이 HWP Hands에서 설정을 확인해야 한다.' }],
    structuredContent: { code: 'AI_PRIVATE', retryable: false, ...domainErrorDetails('AI_PRIVATE') }, _meta: { 'dev.agentinterop/error': { code: 'AI_PRIVATE', retryable: false } } });
  return {
    ...raw,
    async callTool(name, args, ctx) {
      let started = false;
      try { return await run([args, ctx], ctx?.signal, signal => { started = true; return raw.callTool(name, args, { ...ctx, signal }); }); }
      catch (error) { if (error instanceof ToolError && error.code === 'AI_PRIVATE') {
        const result = failure();
        // A policy change can arrive after a command finished. Never misreport that as "not applied".
        if (ctx?.target) result._meta!['dev.agentinterop/sessionEdit'] = { applied: started ? 'unknown' : 'no', path: ctx.target.document.path,
          sessionId: ctx.target.document.sessionId, documentEpoch: ctx.target.document.documentEpoch, revisionBefore: ctx.target.revision, changedHandles: [], changedPages: [] };
        return result;
      } throw error; }
    },
    ...(raw.resolveTarget ? { resolveTarget: ((name: string, args: JsonObject, ctx: InvocationContext) =>
      run([args, ctx], ctx.signal, signal => raw.resolveTarget!(name, args, { ...ctx, signal }))) } : {}),
    editor: {
      capture: ctx => run([ctx], ctx.signal, signal => raw.editor.capture({ ...ctx, signal })),
      openDocuments: ctx => run([ctx], ctx.signal, signal => raw.editor.openDocuments({ ...ctx, signal })),
      release: (caller, documents) => raw.editor.release(caller, documents),
      reveal: (ctx, target) => run([ctx, target], ctx.signal, signal => raw.editor.reveal({ ...ctx, signal }, target)),
      ...(raw.editor.discardAgentChanges ? { discardAgentChanges: (target: Parameters<NonNullable<EditorCapability['discardAgentChanges']>>[0], ctx: Parameters<EditorCapability['capture']>[0]) =>
        run([target, ctx], ctx.signal, signal => raw.editor.discardAgentChanges!(target, { ...ctx, signal })) } : {}),
    },
    ...(raw.commit ? { commit: {
      prepare: (request: Parameters<AgentCommits['prepare']>[0], ctx: CommitContext) => run([request, ctx], ctx.signal, signal => raw.commit!.prepare(request, { ...ctx, signal })),
      execute: (ticket: Parameters<AgentCommits['execute']>[0], ctx: CommitContext) => run([ticket, ctx], ctx.signal, signal => raw.commit!.execute(ticket, { ...ctx, signal })),
      status: (id: string, ctx?: CommitContext) => run([ctx], ctx?.signal, () => raw.commit!.status(id, ctx)),
    } } : {}),
  };
}

function createUnwrappedProvider(api: HwpHandsApiV1, options: AgentProviderOptions): AgentCapabilityProvider {
  const epochs = new Map<string, Epoch>();
  const held = new Map<string, Held>();
  const cursors = new Map<string, Cursor>();
  const used = new Set<string>();
  const now = options.now ?? (() => Date.now());
  const idleMs = options.leaseIdleMs ?? 5 * 60_000;
  let sequence = 0, disposed = false;

  const token = (prefix: string): string => {
    for (;;) {
      const value = `${prefix}${Math.floor(Math.random() * 0xffffff).toString(16)}${(++sequence).toString(36)}`;
      if (!used.has(value)) { used.add(value); return value; }
    }
  };
  const remember = (cursor: Cursor): string => {
    const id = token('c');
    cursors.set(id, cursor);
    if (cursors.size > 256) cursors.delete(cursors.keys().next().value as string);
    return id;
  };
  const release = async (path: string): Promise<void> => {
    const entry = held.get(path); if (!entry) return;
    held.delete(path); if (entry.timer) clearTimeout(entry.timer);
    await entry.lease.release().catch(() => undefined);
  };
  /** Keeps the session alive between calls so handles survive; released after an idle period. Unsaved content is never discarded here. */
  const hold = async (path: string, caller?: Caller): Promise<void> => {
    let entry = held.get(path);
    const owner = caller ? JSON.stringify([caller.pluginId, caller.conversationId]) : undefined;
    if (!entry || (owner && !entry.owners.has(owner))) {
      const views = new Set(options.viewPaths?.() ?? []), unsaved = new Set(api.documents.list().filter(state => state.dirty).map(state => state.path));
      const oldestFirst = [...held.entries()].filter(([other]) => other !== path && !options.privacy?.blocked(other)).sort((a, b) => a[1].usedAt - b[1].usedAt);
      const refuse = (paths: string[]): never => { throw new ToolError('HOLD_LIMIT', `화면에 없는 미저장 한글 문서를 ${paths.length}개 붙잡고 있어 다른 문서를 더 열지 않았다. 사람이 그 문서들을 저장하거나 버리거나 화면에서 연 뒤에 다시 할 수 있다.`, false, undefined, { held: paths }); };
      // A conversation keeps at most five documents nobody sees. A saved one is let go for the next; unsaved ones wait for a person.
      const mine = owner && !views.has(path) ? oldestFirst.filter(([other, item]) => item.owners.has(owner) && !views.has(other)) : [];
      if (mine.length >= MAX_HELD_DOCUMENTS) {
        const saved = mine.find(([other]) => !unsaved.has(other));
        if (!saved) refuse(mine.map(([other]) => other));
        await release(saved![0]);
      }
      if (!entry && held.size >= MAX_HELD_TOTAL) {
        // A view keeps its own session alive, so its lease goes first; then the longest unused saved document.
        const spare = oldestFirst.find(([other]) => held.has(other) && views.has(other)) ?? oldestFirst.find(([other]) => held.has(other) && !unsaved.has(other));
        if (!spare) refuse(oldestFirst.map(([other]) => other));
        await release(spare![0]);
      }
    }
    if (!entry) {
      entry = { lease: await api.documents.acquire(path), usedAt: now(), owners: new Set() };
      held.set(path, entry);
    }
    entry.usedAt = now();
    if (owner) entry.owners.add(owner);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void release(path); }, idleMs);
    (entry.timer as { unref?: () => void }).unref?.();
  };
  const epochFor = (state: State): Epoch => {
    const current = epochs.get(state.path);
    if (current && current.sessionId === state.sessionId && current.revision === state.revision) return current;
    const next: Epoch = { path: state.path, sessionId: state.sessionId, revision: state.revision, id: token('d') };
    epochs.set(state.path, next);
    return next;
  };
  const unsubscribeEpochs = api.events.on('*', event => {
    if (['closed', 'reloaded', 'renamed'].includes(event.type)) {
      epochs.delete(event.state.path);
      if (event.oldPath) epochs.delete(event.oldPath);
      edits?.sessionEnded(event.oldPath ?? event.state.path, event.state.sessionId);
    }
    if (event.type === 'saved') edits?.saved(event.state.path);
  });
  const same = (epoch: Pick<Epoch, 'sessionId' | 'revision'>, state: Pick<State, 'sessionId' | 'revision'>): void => {
    if (state.sessionId !== epoch.sessionId || state.revision !== epoch.revision) throw new ToolError('CURSOR_STALE', '읽는 동안 문서가 바뀌었다. 처음부터 다시 읽어라.', true);
  };
  const open = async (path: unknown, caller?: Caller): Promise<{ state: State; epoch: Epoch }> => {
    options.privacy?.assert(path);
    if (typeof path !== 'string' || !/\.(hwp|hwpx)$/i.test(path)) throw new ToolError('INVALID_ARGUMENT', 'path는 .hwp 또는 .hwpx 문서 경로여야 한다.', true, undefined, inputAt('path', { allowed: ['.hwp', '.hwpx'] }));
    await hold(path, caller);
    if (options.privacy?.blocked(path)) { await release(path); options.privacy.assert(path); }
    const state = await api.documents.state(path);
    return { state, epoch: epochFor(state) };
  };
  const resumed = (id: unknown, kind: string, epoch: Epoch, binding: string): number => {
    if (id === undefined) return 0;
    const cursor = typeof id === 'string' ? cursors.get(id) : undefined;
    if (!cursor || cursor.kind !== kind || cursor.epoch !== epoch.id || cursor.binding !== binding) throw new ToolError('CURSOR_STALE', 'cursor가 이 문서 상태나 요청과 맞지 않는다. cursor 없이 다시 불러라.', true, epoch, inputAt('cursor'));
    return cursor.position;
  };
  const resource = (epoch: Epoch): JsonObject => ({ 'dev.agentinterop/resource': { path: epoch.path, sessionId: epoch.sessionId, documentEpoch: epoch.id, revision: epoch.revision } });
  const header = (state: State): string => `문서 ${state.path} · 작업본 revision ${state.revision} · ${state.pageCount}쪽${state.dirty ? ' · 저장 안 한 변경 있음' : ''}`;
  const withWorkingCopySource = (result: ToolResult): ToolResult => {
    const stamp = result._meta?.['dev.agentinterop/resource'] as JsonObject | undefined;
    if (!stamp || result.isError) return result;
    return { ...result, structuredContent: { ...result.structuredContent,
      source: { kind: 'working-copy', path: stamp.path!, sessionId: stamp.sessionId!, revision: stamp.revision! } } };
  };
  const tablesOf = async (epoch: Epoch): Promise<Table[]> => {
    if (epoch.tables) return epoch.tables;
    const snapshot = { ...epoch };
    const tables = await collectRevisionTables(epoch, async offset => {
      const page = await api.query.structure(epoch.path, { collection: 'tables', offset, limit: 500 });
      return { state: { ...epoch, ...page.state }, tables: page.collection === 'tables' ? page.items : [],
        total: page.total, isTablePage: page.collection === 'tables' };
    }, same);
    same(snapshot, await api.documents.state(epoch.path));
    same(snapshot, epoch);
    return epoch.tables = tables;
  };
  const tableKey = (table: Table): string => `${table.address.section}|${table.address.paragraph}|${JSON.stringify(table.address.cellPath ?? [])}`;
  type Cell = Table['cells'][number];
  const cellColumns = (cell: Cell): string => `c${cell.col + 1}${cell.colSpan > 1 ? `~${cell.col + cell.colSpan}` : ''}`;
  const cellPlace = (cell: Cell): string => `${cellColumns(cell)}${cell.rowSpan > 1 ? ` · r${cell.row + 1}~${cell.row + cell.rowSpan}` : ''}`;
  const cellContent = (cell: Cell, show: (paragraph: Cell['paragraphs'][number]) => string = paragraph => paragraph.text): string => {
    const values = cell.paragraphs.map(show);
    return values.some(value => value.trim()) ? values.join(' / ') : '(빈 칸)';
  };
  const markKey = (address: BodyAddress): string =>
    JSON.stringify([address.section, address.paragraph, (address.cellPath ?? []).map(step => [step.controlIndex, step.cellIndex, step.cellParaIndex])]);
  const markColor = (value: string | undefined): string | undefined => value && !/^#0{6}$/i.test(value) ? value.toLowerCase() : undefined;
  /** Marked character spans of every body and cell paragraph, read once per document state from the model runs (no page layout). */
  const marksOf = async (epoch: Epoch): Promise<Marks> => {
    if (epoch.marks) return epoch.marks;
    const snapshot = { ...epoch };
    let model;
    try { model = await api.query.formatting(epoch.path, { runs: 'model', includeNativeShape: false }); }
    catch (error) {
      if (error instanceof HwpHandsError && ['CANCELLED', 'CLOSED', 'REVISION_CONFLICT'].includes(error.code)) throw error;
      same(snapshot, await api.documents.state(epoch.path));
      same(snapshot, epoch);
      // Text stays readable without its marks; the result says they were not checked.
      return epoch.marks = { spans: new Map(), boxes: new Map(), coverage: 'unavailable' };
    }
    same(snapshot, await api.documents.state(epoch.path));
    same(snapshot, epoch);
    const spans = new Map<string, MarkSpan[]>(), boxes = new Map<string, string>();
    const bulletChars = new Map(model.bullets.map(bullet => [bullet.id, bullet.char]));
    let partial = false;
    for (const paragraph of model.paragraphs) {
      if (paragraph.address.kind !== 'body') continue;
      if (paragraph.address.cellPath?.length && paragraph.properties?.headType === 'Bullet') {
        const char = bulletChars.get(paragraph.properties.numberingId ?? -1);
        if (char && '□☐▢❑◻☑☒'.includes(char)) boxes.set(markKey(paragraph.address), char);
      }
      if (paragraph.characterCoverage !== 'complete') partial = true;
      const merged: MarkSpan[] = [];
      for (const run of paragraph.characterRuns) {
        const strike = run.properties.strikethrough === true, color = markColor(run.properties.textColor);
        if (!strike && !color) continue;
        const last = merged.at(-1);
        if (last && last.end === run.offset && last.strike === strike && last.color === color) { last.end = run.offset + run.length; last.text += run.text; }
        else merged.push({ start: run.offset, end: run.offset + run.length, text: run.text, strike, ...(color ? { color } : {}) });
      }
      if (merged.length) spans.set(markKey(paragraph.address), merged);
    }
    return epoch.marks = { spans, boxes, coverage: partial ? 'partial' : 'complete' };
  };
  /** Display text with marked spans wrapped. Only for showing: observations, handles and edits keep the plain text. */
  const markedText = (text: string, address: BodyAddress, marks: Marks, count: MarkCount): string => {
    const spans = marks.spans.get(markKey(address));
    if (!spans) return text;
    const points = Array.from(text);
    let shown = '', at = 0;
    for (const span of spans) {
      const piece = points.slice(span.start, span.end).join('');
      // A run that does not line up with the shown text is left unmarked rather than placed on the wrong words.
      if (span.start < at || span.end > points.length || piece !== span.text) { count.partial = true; continue; }
      if (!piece.trim()) continue;
      let wrapped = piece;
      if (span.strike) { wrapped = `⟦취소선⟧${wrapped}⟦/취소선⟧`; count.strikethrough++; }
      if (span.color) { wrapped = `⟦글자색 ${span.color}⟧${wrapped}⟦/글자색⟧`; count.textColor++; }
      shown += points.slice(at, span.start).join('') + wrapped;
      at = span.end;
    }
    return shown + points.slice(at).join('');
  };
  /** Handle of a paragraph from its typed address. Root paragraphs are numbered in document order within the epoch. */
  const handleOf = (epoch: Epoch, paragraph: Paragraph | StoryParagraph, rootIndex: Map<string, number>, tables: Table[]): string => {
    const address = paragraph.address;
    if (address.kind === 'headerFooter') return `${epoch.id}:h${address.section + 1}${address.isHeader ? 'a' : 'b'}${address.applyTo}.p${address.paragraph + 1}`;
    if (address.kind === 'footnote' || address.kind === 'endnote') return `${noteHandle(epoch, address)}.p${address.paragraph + 1}`;
    const body = address as BodyAddress, root = (rootIndex.get(`${body.section}|${body.paragraph}`) ?? 0) + 1, path = body.cellPath ?? [];
    if (!path.length) return `${epoch.id}:p${root}`;
    const step = path[0];
    if (path.length === 1 && body.containerKinds?.[0] !== 'textBox') {
      const index = tables.findIndex(table => table.address.section === body.section && table.address.paragraph === body.paragraph && !(table.address.cellPath?.length) && table.control === step.controlIndex);
      const cell = index < 0 ? undefined : tables[index].cells[step.cellIndex];
      if (cell) return `${epoch.id}:t${index + 1}:r${cell.row + 1}c${cell.col + 1}.p${step.cellParaIndex + 1}`;
    }
    // Text boxes and nested containers are read-only in this phase.
    return `${epoch.id}:x${root}c${path.map(item => `${item.controlIndex}.${item.cellIndex}`).join('-')}.p${path.at(-1)!.cellParaIndex + 1}`;
  };

  /** Body and cell paragraphs of the epoch, read once per document state. */
  const paragraphsOf = async (epoch: Epoch): Promise<Array<Paragraph | StoryParagraph>> => {
    if (epoch.all) return epoch.all;
    const snapshot = { ...epoch };
    const all = await api.query.paragraphs(epoch.path, { includeCells: true });
    same(snapshot, await api.documents.state(epoch.path));
    same(snapshot, epoch);
    epoch.withStories = false;
    return epoch.all = all;
  };
  const locate = async (state: State, handle: string): Promise<BodyAddress | undefined> => {
    const epoch = epochs.get(state.path);
    if (!epoch || epoch.sessionId !== state.sessionId || epoch.revision !== state.revision || !handle.startsWith(`${epoch.id}:`)) return undefined;
    const all = await paragraphsOf(epoch), tables = await tablesOf(epoch), rootIndex = rootIndexOf(all);
    const table = /^[^:]+:t(\d+)$/.exec(handle);
    if (table) return tables[Number(table[1]) - 1]?.address;
    // A cell handle without a paragraph number means the first paragraph of the cell.
    const found = all.find(paragraph => { const own = handleOf(epoch, paragraph, rootIndex, tables); return own === handle || own === `${handle}.p1`; });
    return found?.address.kind === 'body' ? found.address : undefined;
  };
  const editor = new AgentEditor(api, { token, epoch: state => epochFor(state).id, viewPaths: () => options.viewPaths?.() ?? [], locate,
    ...(options.privacy ? { accessible: (path: string) => !options.privacy!.blocked(path) } : {}),
    ...(options.reveal ? { reveal: options.reveal } : {}),
    ...(options.edit?.discard ? { discard: (state: State, caller: Caller, signal?: AbortSignal) => options.edit!.discard!(state.path, { expectedRevision: state.revision, sessionId: state.sessionId }, actorIdOf(caller), signal) } : {}),
    owners: path => [...(held.get(path)?.owners ?? [])].map(owner => (JSON.parse(owner) as [string, string])[1]),
    release: async (caller, documents) => {
      edits?.released(caller);
      for (const [path, entry] of held) {
        if (documents && !documents.some(doc => doc.path === path && doc.sessionId === entry.lease.state.sessionId)) continue;
        const owned = entry.owners.delete(JSON.stringify([caller.pluginId, caller.conversationId]));
        if (owned && !entry.owners.size) await release(path);
      }
    } });
  const rootIndexOf = (paragraphs: Array<Paragraph | StoryParagraph>): Map<string, number> => {
    const rootIndex = new Map<string, number>();
    let roots = 0;
    for (const paragraph of paragraphs) if (paragraph.address.kind === 'body' && !paragraph.address.cellPath?.length) rootIndex.set(`${paragraph.address.section}|${paragraph.address.paragraph}`, roots++);
    return rootIndex;
  };
  const edits = options.edit ? new AgentEdits({
    api, bridge: options.edit, token, open: (path, caller) => open(path, caller), ref: state => editor.ref(state),
    ...(options.rewriteCompute ? { rewriteCompute: options.rewriteCompute } : {}),
    ...(options.approveFormatException ? { approveFormatException: options.approveFormatException } : {}),
    handles: async (epoch, paragraphs) => {
      const tables = await tablesOf(epoch), rootIndex = rootIndexOf(paragraphs);
      return paragraphs.map(paragraph => handleOf(epoch as Epoch, paragraph, rootIndex, tables));
    },
    tables: epoch => tablesOf(epoch),
    // Text, field value and format edits keep every address: the epoch survives, cached texts do not.
    advance: (epoch, revision) => { const own = epoch as Epoch; own.revision = revision; own.all = undefined; own.withStories = undefined; own.tables = undefined; own.marks = undefined; },
    expire: path => { epochs.delete(path); },
    ...(options.marks ? { marks: options.marks } : {}),
  }) : undefined;
  const commits = edits && options.commit ? new AgentCommits({ bridge: options.commit, open: (path, caller) => open(path, caller), ref: state => editor.ref(state),
    created: async (path, caller) => { await open(path, caller); await options.reveal?.(path, {}); } }) : undefined;
  const unsubscribePrivacy = options.privacy?.onChange(() => {
    // Previously captured scopes, observations, cursors and approvals never regain authority after reveal.
    epochs.clear(); cursors.clear(); editor.invalidate(); edits?.dispose(); commits?.dispose();
  });
  // A person's edit that keeps every paragraph address (typing, deleting text, formatting) does not end the epoch:
  // handles stay, what was read of untouched paragraphs still counts, and an edited paragraph no longer matches what was seen.
  const unsubscribeApplied = options.edit?.onApplied?.(event => {
    edits?.documentChanged(event.path, event.sessionId);
    if (event.actor === 'ai') return; // This layer advances or expires for its own edits.
    const epoch = epochs.get(event.path), kept = addressPreserving(event.commands);
    if (!kept) return;
    options.marks?.carried(event.path, event.sessionId, event.revisionBefore, event.revisionAfter);
    editor.carried(event.sessionId, event.revisionBefore, event.revisionAfter, kept);
    if (!epoch || epoch.sessionId !== event.sessionId || epoch.revision !== event.revisionBefore) return;
    epoch.revision = event.revisionAfter; epoch.all = undefined; epoch.withStories = undefined; epoch.tables = undefined; epoch.tableIndex = undefined; epoch.marks = undefined;
    edits?.observations.advance(epoch, event.revisionBefore, event.revisionAfter);
  });
  const observed = (ctx: InvocationContext | undefined, epoch: Epoch, shown: Shown[]): JsonObject =>
    edits?.observations.record(ctx?.caller, epoch, shown) ?? {};
  async function context(ctx?: InvocationContext): Promise<ToolResult> {
    const views = new Set(options.viewPaths?.() ?? []);
    const documents = api.documents.list().filter(state => !options.privacy?.blocked(state.path)).map(state => ({ path: state.path, format: state.format, pages: state.pageCount, unsavedChanges: state.dirty, conflict: state.conflict, visible: views.has(state.path) }));
    const lines = documents.length
      ? documents.map(item => `- ${item.path} · ${item.pages}쪽${item.unsavedChanges ? ' · 저장 안 한 변경 있음' : ''}${item.visible ? ' · 화면에 열림' : ' · 화면에 없음'}`)
      : ['열려 있는 한글 문서가 없다. 읽을 문서의 Vault 경로를 path로 지정해 read_document를 부를 수 있다.'];
    const captured = ctx?.scope && ctx.caller ? editor.read(ctx.scope, ctx.caller) : undefined;
    // Handles of the selected paragraphs exist only while the selection still describes the document as it is now.
    const selected = captured?.allowed ? await selectionHandles(captured.scope.path, captured.allowed, ctx?.caller) : [];
    const scope = captured ? { path: captured.scope.path, revision: captured.scope.revision, page: captured.view.page,
      changedSinceCapture: captured.changed, humanInput: captured.view.humanInput,
      ...(captured.scope.selection ? { selection: { ...captured.scope.selection, handles: selected } } : {}) } : undefined;
    return { content: [{ type: 'text', text: ['HWP Hands에 열린 한글 문서:', ...lines,
      ...(captured ? [`제출 시 문서: ${captured.scope.path}${captured.changed ? ' · 제출 뒤 문서가 바뀜' : ''}`] : []),
      ...(selected.length ? [`사람이 선택한 문단: ${selected.join(', ')}`] : [])].join('\n') }],
      structuredContent: { documents, ...(scope ? { scope } : {}) }, _meta: { 'dev.agentinterop/evidencePaths': documents.map(item => item.path) } };
  }

  /** Paragraphs a selection touches, when both ends are in the body or in the same cell. A partly selected paragraph is listed whole. */
  async function selectionHandles(path: string, allowed: AllowedRange, caller?: Caller): Promise<string[]> {
    const { state, epoch } = await open(path, caller);
    if (!allowed.usable || allowed.sessionId !== state.sessionId || allowed.revision !== state.revision) return [];
    const all = (await paragraphsOf(epoch)).filter((paragraph): paragraph is Paragraph => paragraph.address.kind === 'body'), tables = await tablesOf(epoch), rootIndex = rootIndexOf(all);
    same(epoch, state);
    const inside = new SelectionGuard(allowed, all).siblings(all);
    return inside.length > MAX_SELECTION_HANDLES ? [] : inside.map(paragraph => handleOf(epoch, paragraph, rootIndex, tables));
  }

  async function read(args: JsonObject, ctx?: InvocationContext): Promise<ToolResult> {
    const { state, epoch } = await open(args.path, ctx?.caller);
    if (args.layoutSummary === true && (args.mode !== 'layout' || args.target !== undefined)) throw new ToolError('INVALID_ARGUMENT', 'layoutSummary는 target 없는 layout 모드에서만 사용한다.', true, epoch, inputAt('layoutSummary'));
    if (args.mode === 'sections') {
      const snapshot = { ...epoch }, offset = resumed(args.cursor, 'sections', snapshot, 'sections');
      const model = await api.query.formatting(snapshot.path, { pages: [] }), tree = await api.query.tree(snapshot.path);
      same(snapshot, await api.documents.state(snapshot.path));
      if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '구역 조회가 취소됐다.');
      const sections: JsonObject[] = [], shown: Shown[] = [];
      let budget = READ_BUDGET_CHARS, consumed = 0, truncated = false;
      for (const section of model.sections.slice(offset, offset + ((args.limit ?? 40) as number))) {
        const handle = `${snapshot.id}:section${section.section + 1}`, view = sectionView(section, tree.stories), text = JSON.stringify(view);
        if (text.length + handle.length + 30 > budget && consumed) break;
        if (text.length + handle.length + 30 > budget) { sections.push({ handle, truncated: true }); consumed++; truncated = true; break; }
        sections.push({ handle, ...view }); shown.push({ handle, key: sectionKey(section.section), text }); budget -= text.length + handle.length + 30; consumed++;
      }
      const next = offset + consumed, complete = next >= model.sections.length;
      const cursor = !complete ? remember({ kind: 'sections', epoch: snapshot.id, binding: 'sections', position: next }) : undefined;
      const result: JsonObject = { sections, totalSections: model.sections.length, complete, truncated, ...(cursor ? { cursor } : {}),
        units: { lengths: 'native HWP units (7200/inch); update_section.page uses mm', section: 'zero based; handle suffix is one based', applyTo: '0 both, 1 even, 2 odd' },
        coverage: { headerFooterText: 'logical text and dynamic fields', innerObjects: 'unsupported' } };
      return { content: [{ type: 'text', text: `${header(state)}\n구역·쪽 설정(JSON):\n${JSON.stringify(result)}` }], structuredContent: result,
        _meta: { ...resource(snapshot), ...observed(ctx, snapshot, shown) } };
    }
    if (args.mode === 'styles') {
      const snapshot = { ...epoch }, offset = resumed(args.cursor, 'styles', snapshot, 'styles');
      const model = await api.query.formatting(snapshot.path, { pages: [] });
      same(snapshot, await api.documents.state(snapshot.path));
      if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '스타일 조회가 취소됐다.');
      const styles: JsonObject[] = [], shown: Shown[] = [];
      let budget = READ_BUDGET_CHARS, consumed = 0, truncated = false;
      for (const style of model.styles.slice(offset, offset + ((args.limit ?? 40) as number))) {
        const handle = `${snapshot.id}:style${style.id}`, size = styleText(style).length + handle.length + 30;
        if (size > budget && consumed) break;
        if (size > budget) {
          styles.push({ handle, name: clip(style.name), truncated: true }); consumed++; truncated = true; break;
        }
        styles.push(JSON.parse(JSON.stringify({ handle, ...style })) as JsonObject);
        shown.push({ handle, key: styleKey(style.id), text: styleText(style) }); budget -= size; consumed++;
      }
      const next = offset + consumed, complete = next >= model.styles.length;
      const cursor = !complete ? remember({ kind: 'styles', epoch: snapshot.id, binding: 'styles', position: next }) : undefined;
      const result: JsonObject = { styles, complete, truncated, totalStyles: model.styles.length, ...(cursor ? { cursor } : {}),
        units: { fontSize: 'pt', paraProps: 'native HWP units', fontLanguage: '0 Korean, 1 Latin, 2 Hanja, 3 Japanese, 4 Other, 5 Symbol, 6 User' } };
      return { content: [{ type: 'text', text: `${header(state)}\n스타일 정의(JSON):\n${JSON.stringify(result)}` }], structuredContent: result,
        _meta: { ...resource(snapshot), ...observed(ctx, snapshot, shown) } };
    }
    if (args.mode === 'notes') {
      const snapshot = { ...epoch }, offset = resumed(args.cursor, 'notes', snapshot, 'notes');
      const page = await api.query.structure(snapshot.path, { collection: 'stories', offset, limit: (args.limit ?? 40) as number });
      same(snapshot, page.state);
      if (page.collection !== 'stories') throw new ToolError('ENGINE_ERROR', '각주·미주 목록을 읽지 못했다.', false, snapshot);
      const all = await api.query.paragraphs(snapshot.path), roots = rootIndexOf(all);
      same(snapshot, await api.documents.state(snapshot.path));
      if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '각주·미주 조회가 취소됐다.');
      const notes: JsonObject[] = [], shown: Shown[] = [];
      let budget = READ_BUDGET_CHARS, consumed = 0, truncated = false;
      for (const story of page.items) {
        if (story.kind !== 'footnote' && story.kind !== 'endnote') { consumed++; continue; }
        const handle = noteHandle(snapshot, story), anchor = !story.anchor.cellPath?.length ? `${snapshot.id}:p${(roots.get(`${story.anchor.section}|${story.anchor.paragraph}`) ?? -1) + 1}` : undefined;
        const paragraphs = story.paragraphs.map((p, i) => ({ handle: `${handle}.p${i + 1}`, text: p.text, length: p.length }));
        const item: JsonObject = { handle, kind: story.kind, section: story.section + 1, ...(story.number !== undefined ? { number: story.number } : {}),
          ...(anchor ? { anchor } : {}), availability: story.availability, paragraphs };
        const size = JSON.stringify(item).length;
        if (size > budget && consumed > 0) break;
        if (size > budget) {
          // Advance past an oversized story, but never issue an observation for omitted text.
          notes.push({ handle, kind: story.kind, availability: story.availability, ...(anchor ? { anchor } : {}), truncated: true,
            paragraphCount: paragraphs.length, preview: clip(story.paragraphs[0]?.text ?? '') });
          consumed++; truncated = true; break;
        }
        notes.push(item); budget -= size; consumed++;
        if (story.availability === 'available') for (const p of story.paragraphs) if (p.address.kind === 'footnote' || p.address.kind === 'endnote')
          shown.push({ handle: `${handle}.p${p.address.paragraph + 1}`, key: noteParagraphKey(p.address), text: p.text });
      }
      const next = offset + consumed, complete = next >= page.total;
      const cursor = !complete ? remember({ kind: 'notes', epoch: snapshot.id, binding: 'notes', position: next }) : undefined;
      const result: JsonObject = { scope: 'footnotes+endnotes', notes, scannedStories: consumed, totalStories: page.total, complete, truncated,
        coverage: { text: 'available anchors only', nestedAnchors: 'unsupported', characterFormatting: 'unsupported', innerObjects: 'unsupported' }, ...(cursor ? { cursor } : {}) };
      return { content: [{ type: 'text', text: `${header(state)}\n각주·미주(JSON, 본문과 별도):\n${JSON.stringify(result)}` }], structuredContent: result,
        _meta: { ...resource(snapshot), ...observed(ctx, snapshot, shown) } };
    }
    if (args.mode === 'quality') {
      // Freeze the revision: another own edit can advance the mutable cached epoch while queries await.
      const snapshot = { ...epoch };
      const fields = await api.query.structure(epoch.path, { collection: 'fields', limit: 500 });
      same(snapshot, fields.state);
      const paragraphs = await api.query.structure(epoch.path, { collection: 'paragraphs', includeCells: true, limit: 500 });
      same(snapshot, paragraphs.state);
      if (fields.collection !== 'fields' || paragraphs.collection !== 'paragraphs') throw new ToolError('ENGINE_ERROR', '작성 점검 목록을 읽지 못했다.', false, snapshot);
      const body = paragraphs.items.filter((item): item is Paragraph => item.address.kind === 'body');
      const objects = await api.query.structure(epoch.path, { collection: 'objects', limit: 500 });
      same(snapshot, objects.state);
      if (objects.collection !== 'objects') throw new ToolError('ENGINE_ERROR', '그림 목록을 읽지 못했다.', false, snapshot);
      const images = await inspectImages(objects.items, objects.total, snapshot.id,
        object => api.query.objectResource(snapshot.path, { kind: 'picture', address: object.address, controlIndex: object.controlIndex }, { expectedRevision: snapshot.revision }), ctx?.signal);
      const tables = await tablesOf(epoch), roots = rootIndexOf(body);
      const handles = body.map(paragraph => handleOf(snapshot, paragraph, roots, tables));
      // A heading is what the document marks as an outline level; the final state check below covers this read too.
      const levels = new Map((await api.query.formatting(epoch.path, { pages: [] })).paragraphs
        .filter(p => p.address.kind === 'body' && !p.address.cellPath?.length && p.properties?.headType === 'Outline')
        .map(p => [addressKey(p.address as BodyAddress), p.properties?.paraLevel ?? 0]));
      const outline = { total: levels.size, items: body.flatMap((paragraph, index) => {
        const level = paragraph.address.cellPath?.length ? undefined : levels.get(addressKey(paragraph.address));
        return level === undefined ? [] : [{ index, level }];
      }) };
      same(snapshot, await api.documents.state(epoch.path));
      if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '작성 점검이 취소됐다.');
      const report = inspectQuality({ fields: fields.items, fieldTotal: fields.total, paragraphs: body, paragraphTotal: paragraphs.total,
        handles, epoch: snapshot.id, placeholders: (args.placeholders ?? []) as string[], limit: (args.limit ?? 40) as number, images, outline });
      return { content: [{ type: 'text', text: `${header(state)}\n작성 품질 점검(저장 보존 검증과 별도):\n${JSON.stringify(report)}` }],
        structuredContent: { quality: report }, _meta: resource(snapshot) };
    }
    if (args.mode === 'formatting') {
      const snapshot = { ...epoch };
      const handle = args.target;
      if (typeof handle !== 'string' || !handle.startsWith(`${epoch.id}:`)) throw new ToolError('HANDLE_EXPIRED', '현재 문단 핸들을 target으로 지정하라.', true, epoch, inputAt('target'));
      const all = await paragraphsOf(epoch), tables = await tablesOf(epoch), roots = rootIndexOf(all);
      const paragraph = all.find(item => { const own = handleOf(epoch, item, roots, tables); return own === handle || own === `${handle}.p1`; });
      if (!paragraph || paragraph.address.kind !== 'body') throw new ToolError('UNSUPPORTED_TARGET', '본문 또는 표 셀 문단 핸들이 필요하다.', false, epoch, inputAt('target'));
      const offset = args.runOffset ?? 0;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new ToolError('INVALID_ARGUMENT', 'runOffset은 0 이상의 정수다.', true, epoch, inputAt('runOffset', { allowed: { minimum: 0 } }));
      const model = await api.query.formatting(epoch.path, { runs: 'model' });
      same(snapshot, await api.documents.state(epoch.path));
      const format = model.paragraphs.find(item => item.address.kind === 'body' && addressKey(item.address) === addressKey(paragraph.address as BodyAddress));
      if (!format) throw new ToolError('UNSUPPORTED_TARGET', '이 문단의 서식을 읽을 수 없다.', false, epoch, inputAt('target'));
      const runs = format.characterRuns.slice(offset, offset + 5).map(run => ({ ...run, text: clip(run.text), textTruncated: Array.from(run.text).length > PREVIEW_CHARS }));
      const next = offset + runs.length;
      const result = JSON.parse(JSON.stringify({ target: handle, revision: state.revision, style: format.style, properties: format.properties,
        propertyCoverage: format.propertyCoverage, characterCoverage: format.characterCoverage, missingRanges: format.missingRanges,
        units: { offset: 'Unicode code point', fontSize: 'pt', paragraphLengths: 'px at 96dpi', percentLineSpacing: '%' },
        runs, complete: next >= format.characterRuns.length, ...(next < format.characterRuns.length ? { nextRunOffset: next } : {}) })) as JsonObject;
      return { content: [{ type: 'text', text: `${header(state)}\n서식(JSON, offset/length는 Unicode code point):\n${JSON.stringify(result)}` }], structuredContent: result,
        _meta: { ...resource(snapshot), ...observed(ctx, snapshot, format.characterRuns.slice(offset, offset + 5).map(run => ({ handle,
          key: runKey(paragraph.address as BodyAddress, run), text: runText(run) }))) } };
    }
    if (args.mode === 'table') {
      const snapshot = { ...epoch }, target = args.target;
      if (typeof target !== 'string' || !target.startsWith(`${epoch.id}:t`)) throw new ToolError('HANDLE_EXPIRED', '현재 표 읽기용 핸들을 target으로 지정하라.', true, epoch, inputAt('target'));
      const tables = await tablesOf(epoch), index = Number(target.slice(`${epoch.id}:t`.length)) - 1;
      if (!Number.isSafeInteger(index) || index < 0 || target !== `${epoch.id}:t${index + 1}` || !tables[index]) throw new ToolError('UNSUPPORTED_TARGET', '현재 문서의 표 핸들이 필요하다.', false, epoch, inputAt('target'));
      const table = tables[index], start = resumed(args.cursor, 'table', snapshot, target);
      const tablePosition = typeof args.cursor === 'string' ? cursors.get(args.cursor)?.tablePosition : undefined;
      if (args.cursor !== undefined && !tablePosition) throw new ToolError('CURSOR_STALE', '표 cursor 위치가 유효하지 않다.', true, epoch, inputAt('cursor'));
      const cellIndex = epoch.revision === snapshot.revision && epoch.tables === tables ? (epoch.tableIndex ??= new TableCellIndex()) : new TableCellIndex();
      const { page, next: nextPosition } = tableTextPage(tableTextFragments(table, tablePosition, cellIndex)), next = start + page.length;
      same(snapshot, await api.documents.state(snapshot.path));
      if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '표 읽기가 취소됐다.');
      const cursor = nextPosition ? remember({ kind: 'table', epoch: snapshot.id, binding: target, position: next, tablePosition: nextPosition }) : undefined;
      const fragments = page.map(fragment => {
        const cell = cellIndex.at(table, fragment.row, fragment.col);
        const paragraphTarget = !table.address.cellPath?.length && cell?.paragraphs[fragment.paragraph - 1]
          ? `${target}:r${fragment.row}c${fragment.col}.p${fragment.paragraph}` : undefined;
        return { ...fragment, ...(paragraphTarget ? { paragraphTarget } : {}) };
      });
      return { content: [{ type: 'text', text: `${header(state)}\n표 셀 텍스트 단편 ${page.length ? start + 1 : 0}~${next}. 읽기 전용이며 서식은 paragraphTarget으로 mode=formatting 조회, 누름틀·중첩 개체는 별도 확인이 필요하다.${cursor ? ` 계속: cursor=${cursor}` : ''}` }],
        structuredContent: { target, rows: table.rows, cols: table.cols, from: page.length ? start + 1 : 0, to: next, offsetUnit: 'Unicode code point', fragments, complete: !cursor, ...(cursor ? { cursor } : {}), coverage: 'cell-text-only; formatting, fields and nested objects not verified' }, _meta: resource(snapshot) };
    }
    if (args.mode === 'layout') {
      // Page count and how much of the body area the last pages use, from this plugin's own page layout.
      const snapshot = { ...epoch }, pageCount = state.pageCount, pages: { page: number; bodyHeight: number; usedHeight: number; usedPercent: number }[] = [];
      if (args.layoutSummary === true) {
        if (pageCount > 80) throw new ToolError('LIMIT_EXCEEDED', '문단 조판 요약은 80쪽 이하 문서에서만 지원한다.', false);
        const limit = args.limit ?? 20;
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new ToolError('INVALID_ARGUMENT', '문단 조판 요약은 한 번에 1~20개다.', true, epoch, inputAt('limit'));
        const offset = resumed(args.cursor, 'layout', snapshot, 'paragraph-summary');
        const tableOffset = typeof args.cursor === 'string' ? cursors.get(args.cursor)?.layoutTablePosition : 0;
        if (tableOffset === undefined) throw new ToolError('CURSOR_STALE', '조판 요약 cursor 위치가 유효하지 않다.', true, epoch, inputAt('cursor'));
        const all = await paragraphsOf(epoch), tables = await tablesOf(epoch), roots = rootIndexOf(all);
        const body = all.filter((paragraph): paragraph is Paragraph => paragraph.address.kind === 'body');
        const layouts = [];
        for (let page = 0; page < pageCount; page++) {
          if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '조판 측정이 취소됐다.');
          layouts.push(await api.query.layout(snapshot.path, page));
        }
        same(snapshot, await api.documents.state(snapshot.path));
        if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '조판 측정이 취소됐다.');
        const layoutIndex = await indexParagraphLayouts(layouts, ctx?.signal);
        const items: JsonObject[] = [];
        let bytes = 0;
        for (const paragraph of body.slice(offset, offset + limit)) {
          const measured = paragraphLayoutSummary(paragraph.address, paragraph.text, layouts, layoutIndex);
          const item = { target: handleOf(snapshot, paragraph, roots, tables), ...measured };
          const size = JSON.stringify(item).length;
          if (items.length && bytes + size > 7000) break;
          if (size > 7000) throw new ToolError('LIMIT_EXCEEDED', '문단 조판 요약이 출력 예산을 초과했다.', false);
          bytes += size; items.push(item);
        }
        const spanning = spanningTableCandidates(layouts);
        const spanningTables = spanning.slice(tableOffset, tableOffset + 8).map(item => {
          const index = tables.findIndex(table => !table.address.cellPath?.length && table.address.section === item.section && table.address.paragraph === item.paragraph && table.control === item.controlIndex);
          const nested = tables.some(table => !!table.address.cellPath?.length && table.address.section === item.section && table.address.paragraph === item.paragraph);
          return { ...item, ...(index >= 0 && !nested ? { target: `${snapshot.id}:t${index + 1}` } : {}) };
        });
        const render = (cursor?: string) => {
          const next = offset + items.length;
          const result: JsonObject = { layoutSource: 'rhwp_estimate', engineVersion: api.engineVersion, fontSubstitution: 'unknown', lineFillBasis: 'run_span_over_column_width', pageBoundaryCoverage: 'single-column body text without controls', revision: state.revision, pageCount, items, total: body.length, paragraphsComplete: next >= body.length, complete: !cursor, ...(cursor ? { cursor } : {}), spanningTables: { candidates: spanningTables, total: spanning.length, offset: tableOffset, complete: tableOffset + spanningTables.length >= spanning.length, identity: 'candidate; nested table anchors may be ambiguous' } };
          const text = `${header(state)}\n문단별 조판 추정 ${offset + (items.length ? 1 : 0)}~${next}/${body.length}. 실제 한글 조판과 다를 수 있다.${cursor ? ` 계속: cursor=${cursor}` : ''}`;
          return { result, text };
        };
        // Reserve room for the wrapper's working-copy source and host's joined text.
        for (;;) {
          const preview = render(offset + items.length < body.length || tableOffset + spanningTables.length < spanning.length ? 'c'.repeat(128) : undefined);
          const source = { kind: 'working-copy', path: snapshot.path, sessionId: snapshot.sessionId, revision: snapshot.revision };
          if (preview.text.length + 1 + JSON.stringify({ ...preview.result, source }).length <= 11500) break;
          if (spanningTables.length > 1) spanningTables.pop();
          else if (items.length > 1) items.pop();
          else throw new ToolError('LIMIT_EXCEEDED', '문단 조판 요약이 출력 예산을 초과했다.', false);
        }
        same(snapshot, await api.documents.state(snapshot.path));
        if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '조판 측정이 취소됐다.');
        const next = offset + items.length;
        const tableNext = tableOffset + spanningTables.length;
        const cursor = next < body.length || tableNext < spanning.length ? remember({ kind: 'layout', epoch: snapshot.id, binding: 'paragraph-summary', position: next, layoutTablePosition: tableNext }) : undefined;
        const rendered = render(cursor);
        return { content: [{ type: 'text', text: rendered.text }], structuredContent: rendered.result, _meta: resource(snapshot) };
      }
      if (args.target !== undefined) {
        const handle = args.target;
        if (typeof handle !== 'string' || !handle.startsWith(`${epoch.id}:`)) throw new ToolError('HANDLE_EXPIRED', '현재 문단 핸들을 target으로 지정하라.', true, epoch, inputAt('target'));
        if (pageCount > 80) throw new ToolError('LIMIT_EXCEEDED', '문단 줄 측정은 80쪽 이하 문서에서만 지원한다.', false);
        const all = await paragraphsOf(epoch), tables = await tablesOf(epoch), roots = rootIndexOf(all);
        const paragraph = all.find(item => { const own = handleOf(epoch, item, roots, tables); return own === handle || own === `${handle}.p1`; });
        if (!paragraph || paragraph.address.kind !== 'body') throw new ToolError('UNSUPPORTED_TARGET', '본문 또는 표 셀 문단 핸들이 필요하다.', false, epoch, inputAt('target'));
        const layouts = [];
        for (let page = 0; page < pageCount; page++) {
          if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '조판 측정이 취소됐다.');
          layouts.push(await api.query.layout(snapshot.path, page));
        }
        same(snapshot, await api.documents.state(snapshot.path));
        const measured = paragraphLayout(paragraph.address, paragraph.text, layouts);
        return { content: [{ type: 'text', text: `${header(state)}\n${handle}의 조판 추정 ${measured.estimatedLineCount}줄, 문자 범위 ${measured.coverage}. 글꼴·위 첨자·단·개체에 따라 부정확할 수 있으므로 화면에서 확인한다.` }],
          structuredContent: { target: handle, revision: state.revision, ...measured, engine: 'rhwp', estimated: true }, _meta: resource(snapshot) };
      }
      for (let page = Math.max(0, pageCount - 2); page < pageCount; page++) {
        if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '조판 측정이 취소됐다.');
        const layout = await api.query.layout(snapshot.path, page), info = layout.info;
        const top = info.marginTop + info.marginHeader, bottom = info.height - info.marginBottom - info.marginFooter, height = bottom - top;
        // Header and footer content (page numbers) sit outside the body area and are left out.
        const ends = [...layout.runs.map(run => [run.y, run.y + run.h]), ...layout.controls.map(control => [control.y, control.y + control.height])]
          .filter(([start]) => start >= top - 0.5 && start < bottom).map(([, end]) => end);
        const usedHeight = ends.length ? Math.min(height, Math.max(0, Math.max(...ends) - top)) : 0;
        pages.push({ page: page + 1, bodyHeight: Math.round(height * 10) / 10, usedHeight: Math.round(usedHeight * 10) / 10, usedPercent: height > 0 ? Math.round(usedHeight / height * 100) : 0 });
      }
      same(snapshot, await api.documents.state(snapshot.path));
      const measured = { pageCount, pages, unit: 'px at 96dpi', engine: 'rhwp', engineVersion: api.engineVersion };
      return { content: [{ type: 'text', text: `${header(state)}\n조판 측정(HWP Hands 조판 기준, 실제 한글과 다를 수 있음): 전체 ${pageCount}쪽. ${pages.map(page => `${page.page}쪽 본문 영역 ${page.usedPercent}% 사용`).join(', ')}.` }],
        structuredContent: measured, _meta: resource(snapshot) };
    }
    if (args.mode === 'outline') {
      const outline = await api.query.outline(epoch.path);
      return { content: [{ type: 'text', text: `${header(state)}\n개요(JSON):\n${JSON.stringify(outline)}` }], _meta: resource(epoch) };
    }
    // Freeze the revision while asynchronous body queries run.
    const snapshot = { ...epoch };
    const limit = typeof args.limit === 'number' ? args.limit : 40, offset = resumed(args.cursor, 'read', snapshot, 'blocks');
    const page = await api.query.structure(epoch.path, { collection: 'paragraphs', offset, limit });
    same(snapshot, page.state);
    if (page.collection !== 'paragraphs') throw new ToolError('ENGINE_ERROR', '문단 목록을 읽지 못했다.', false, epoch);
    const tables = await tablesOf(epoch), hosted = new Map<string, Table[]>();
    for (const table of tables) if (!table.address.cellPath?.length) hosted.set(tableKey(table), [...(hosted.get(tableKey(table)) ?? []), table]);
    // Fields sit inside paragraphs but are not part of their text, so each shown paragraph lists its fields with their values.
    // A value shown in full counts as seen for fill_fields, by name when the name is unique and always by place.
    const fields = await api.query.fields(epoch.path);
    same(snapshot, await api.documents.state(epoch.path));
    const named = new Map<string, number>(), fieldsAt = new Map<string, Array<{ field: Field; place: number }>>();
    // Only input fields (누름틀) are listed; hyperlink and other fields keep their place number but are never offered for fill_fields.
    fields.forEach((field, place) => {
      if (!isInputField(field)) return;
      named.set(field.name, (named.get(field.name) ?? 0) + 1);
      if (field.address) fieldsAt.set(addressKey(field.address), [...(fieldsAt.get(addressKey(field.address)) ?? []), { field, place }]);
    });
    let contentComplete = true;
    const listFields = (address: BodyAddress, indent: string, block: string[], blockShown: Shown[]): void => {
      for (const { field, place } of fieldsAt.get(addressKey(address)) ?? []) {
        const unique = named.get(field.name) === 1, placed = `${epoch.id}:f${place + 1}`;
        block.push(`${indent}누름틀 ${JSON.stringify(field.name)}${unique ? '' : ` [${placed}]`} = ${JSON.stringify(clip(field.value))}`);
        if (Array.from(field.value).length > PREVIEW_CHARS) { contentComplete = false; continue; }
        blockShown.push({ handle: placed, key: fieldPlaceKey(place), text: field.value });
        if (unique) blockShown.push({ handle: `${epoch.id}:f:${field.name}`, key: fieldKey(field.name), text: field.value });
      }
    };
    const marks = await marksOf(epoch), marked: MarkCount = { strikethrough: 0, textColor: 0, partial: false };
    const lines = [header(state)], handles: string[] = [], tableReadTargets: string[] = [], shown: Shown[] = [];
    let budget = READ_BUDGET_CHARS, consumed = 0;
    for (const [index, item] of page.items.entries()) {
      const paragraph = item as Paragraph, handle = `${epoch.id}:p${offset + index + 1}`, block: string[] = [], blockTableHandles: string[] = [], blockShown: Shown[] = [{ handle, address: paragraph.address, text: paragraph.text }];
      const blockMarked: MarkCount = { strikethrough: 0, textColor: 0, partial: false };
      const show = (text: string, address: BodyAddress): string => markedText(text, address, marks, blockMarked);
      block.push(`[${handle}] ${show(paragraph.text, paragraph.address)}`);
      listFields(paragraph.address, '  ', block, blockShown);
      for (const table of hosted.get(tableKey(paragraph as unknown as Table)) ?? []) {
        const name = `${epoch.id}:t${tables.indexOf(table) + 1}`;
        let overlay: { coveredCellIndices: number[]; complete: boolean };
        try { overlay = await api.query.tableCoverage(snapshot.path, { section: table.section, paragraph: table.paragraph, control: table.control }, { sessionId: snapshot.sessionId, expectedRevision: snapshot.revision }); }
        catch { overlay = { coveredCellIndices: [], complete: false }; }
        same(snapshot, await api.documents.state(snapshot.path));
        const occupied = new Set(overlay.coveredCellIndices);
        const rowIndex = new TableRowIndex(table.cells);
        block.push(`[${name}] 표 ${table.rows}행×${table.cols}열 (${handle}에 있음)${overlay.complete ? '' : ' [겹친 개체 위치 확인 불가]'}`);
        for (let row = 0; row < table.rows; row++) {
          const cells = rowIndex.cellsAt(row);
          // Every cell names its columns, so an empty or merged cell never shifts the column numbers a form is filled by.
          const covered = rowIndex.coveredAt(row);
          const parts = [...cells.map(cell => ({ col: cell.col, text: `[${cellPlace(cell)}] ${occupied.has(cell.index) ? '[겹친 개체] ' : ''}${cellContent(cell, p => `${marks.boxes.has(markKey(p.address)) ? `[체크 상자 ${marks.boxes.get(markKey(p.address))}] ` : ''}${show(p.text, p.address)}`)}` })),
            ...covered.map(cell => ({ col: cell.col, text: `[${cellColumns(cell)}] (r${cell.row + 1}c${cell.col + 1}과 병합)` }))].sort((a, b) => a.col - b.col);
          block.push(`  r${row + 1}: ${parts.map(part => part.text).join(' | ')}`);
          for (const cell of cells) cell.paragraphs.forEach((p, k) => {
            const handle = `${name}:r${cell.row + 1}c${cell.col + 1}.p${k + 1}`, bullet = marks.boxes.get(markKey(p.address));
            blockShown.push({ handle, address: p.address, text: p.text });
            if (bullet) blockShown.push({ handle, key: checkboxBulletKey(p.address), text: bullet });
            listFields(p.address, '    ', block, blockShown);
          });
        }
        blockTableHandles.push(name);
      }
      const size = block.reduce((sum, line) => sum + line.length + 1, 0);
      // A block is returned whole or not at all, so a handle never covers text the model did not see.
      if (size > budget && consumed > 0) break;
      if (size > budget) {
        contentComplete = false;
        const prefix = paragraph.text.slice(0, budget);
        lines.push(`[${handle}] ${prefix}${prefix.length < paragraph.text.length ? `…(문단 ${paragraph.text.length}자 중 앞부분만 표시)` : ''}`);
        if (blockTableHandles.length) { tableReadTargets.push(...blockTableHandles); lines.push(`표 내용이 길이 제한으로 생략되었습니다. 읽기 전용 표 핸들: ${blockTableHandles.join(', ')}. mode=table과 target으로 셀 텍스트를 이어 읽으세요. 서식과 중첩 개체는 별도 확인이 필요합니다.`); }
        else if (prefix.length === paragraph.text.length) lines.push('문단에 속한 일부 내용이 길이 제한으로 생략되었습니다. 문서를 직접 확인하세요.');
        handles.push(handle); consumed++; break;
      }
      lines.push(...block); handles.push(...blockTableHandles, handle); shown.push(...blockShown); budget -= size; consumed++;
      marked.strikethrough += blockMarked.strikethrough; marked.textColor += blockMarked.textColor; marked.partial ||= blockMarked.partial;
    }
    const next = offset + consumed, remaining = page.total - next;
    const cursor = remaining > 0 ? remember({ kind: 'read', epoch: epoch.id, binding: 'blocks', position: next }) : undefined;
    if (cursor) lines.push(`… 계속: cursor=${cursor} (남은 블록 ${remaining})`);
    const markCoverage = marks.coverage === 'complete' && marked.partial ? 'partial' : marks.coverage;
    const legend = [
      ...(marked.strikethrough || marked.textColor ? ['⟦취소선⟧…⟦/취소선⟧과 ⟦글자색 #rrggbb⟧…⟦/글자색⟧은 원문의 글자 서식 표시다(본문 글자가 아님). 검토 문서에서는 흔히 삭제·추가를 뜻한다. 문구를 찾거나 바꿀 때는 표시를 빼고 원문만 쓴다.'] : []),
      ...(markCoverage !== 'complete' ? ['취소선·글자색 표시는 일부 문단에서 확인하지 못했다. 필요하면 formatting 모드로 해당 문단을 확인한다.'] : []),
    ];
    lines.splice(1, 0, ...legend);
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { handles, ...(tableReadTargets.length ? { tableReadTargets } : {}), totalBlocks: page.total, from: offset + 1, to: next, ...(cursor ? { cursor } : {}), complete: remaining <= 0, contentComplete,
      formatMarks: { strikethrough: marked.strikethrough, textColor: marked.textColor, coverage: markCoverage } }, _meta: { ...resource(snapshot), ...observed(ctx, snapshot, shown),
      'dev.agentinterop/readProgress': { source: { kind: 'working-copy', path: snapshot.path, sessionId: snapshot.sessionId, documentEpoch: snapshot.id, revision: snapshot.revision },
        scope: 'body-blocks', unit: 'block', from: page.total ? offset + 1 : 0, to: next, total: page.total, hasMore: remaining > 0, contentComplete, ...(cursor ? { nextCursor: cursor } : {}) } satisfies ReadProgress } };
  }

  async function find(args: JsonObject, ctx?: InvocationContext): Promise<ToolResult> {
    const { state, epoch } = await open(args.path, ctx?.caller);
    const query = args.query as string, includeStories = args.includeStories === true, limit = typeof args.limit === 'number' ? args.limit : MAX_MATCHES;
    if (typeof query !== 'string' || !query.length) throw new ToolError('INVALID_ARGUMENT', 'query가 비어 있다.', true, epoch, inputAt('query', { allowed: { minLength: 1 } }));
    const start = resumed(args.cursor, 'find', epoch, JSON.stringify([query, includeStories]));
    if (!epoch.all || epoch.withStories !== includeStories) {
      // One whole-list read per document state; later calls for the same state reuse it.
      const all = includeStories ? await api.query.paragraphs(epoch.path, { includeCells: true, includeStories: true }) : await api.query.paragraphs(epoch.path, { includeCells: true });
      same(epoch, await api.documents.state(epoch.path));
      epoch.all = all; epoch.withStories = includeStories;
    }
    const tables = await tablesOf(epoch), rootIndex = rootIndexOf(epoch.all);
    const needle = Array.from(query), matches: Array<{ handle: string; offset: number; text: string;
      context: { text: string; offset: number; truncatedBefore: boolean; truncatedAfter: boolean }; snippet: string }> = [];
    const shown = new Map<string, Shown>();
    let ordinal = 0, more = false;
    outer: for (const paragraph of epoch.all) {
      if (!paragraph.text.includes(query)) continue;
      const source = Array.from(paragraph.text);
      for (let offset = 0; offset + needle.length <= source.length; offset++) {
        if (!needle.every((character, index) => source[offset + index] === character)) continue;
        if (ordinal++ < start) continue;
        if (matches.length === limit) { more = true; break outer; }
        const from = Math.max(0, offset - SNIPPET_RADIUS), to = Math.min(source.length, offset + needle.length + SNIPPET_RADIUS);
        const handle = handleOf(epoch, paragraph, rootIndex, tables);
        // A match snippet is a full observation only when its window covers the whole paragraph.
        if (paragraph.address.kind === 'body') shown.set(handle, { handle, address: paragraph.address, text: paragraph.text, full: shown.get(handle)?.full === true || (from === 0 && to === source.length) });
        matches.push({ handle, offset, text: source.slice(offset, offset + needle.length).join(''),
          context: { text: source.slice(from, to).join(''), offset: from, truncatedBefore: from > 0, truncatedAfter: to < source.length },
          // Kept for display consumers. Exact text above never inserts or strips punctuation.
          snippet: `${from ? '…' : ''}${source.slice(from, offset).join('')}«${query}»${source.slice(offset + needle.length, to).join('')}${to < source.length ? '…' : ''}` });
      }
    }
    const cursor = more ? remember({ kind: 'find', epoch: epoch.id, binding: JSON.stringify([query, includeStories]), position: start + matches.length }) : undefined;
    const lines = [header(state), matches.length ? `"${query}" ${start + 1}번째부터 ${matches.length}곳:` : start ? `"${query}"의 일치가 더 없다.` : `"${query}"를 찾지 못했다.`,
      '치환에는 text 또는 context.text의 실제 문구를 사용한다. snippet은 강조 표시 전용이다. offset은 문단 내 Unicode code point 기준이며 생략 여부는 truncatedBefore/After로 표시한다.',
      ...matches.map(({ snippet: _snippet, ...match }) => JSON.stringify(match))];
    if (cursor) lines.push(`… 계속: cursor=${cursor}`);
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { matches, snippetFormat: 'highlighted-display-only', complete: !more, scope: includeStories ? 'body+cells+stories' : 'body+cells', ...(cursor ? { cursor } : {}) }, _meta: { ...resource(epoch), ...observed(ctx, epoch, [...shown.values()]) } };
  }

  const failure = (error: unknown): ToolResult => {
    const known = error instanceof ToolError, host = error instanceof HwpHandsError;
    const code = known ? error.code : host ? (error.code === 'NOT_FOUND' || error.code === 'INVALID_PATH' ? 'TARGET_REQUIRED' : error.code) : 'ENGINE_ERROR';
    const retryable = known ? error.retryable : host && error.code === 'REVISION_CONFLICT';
    const message = known ? error.message : host && (error.code === 'NOT_FOUND' || error.code === 'INVALID_PATH') ? '그 경로의 한글 문서를 찾을 수 없다. Vault 경로를 확인하라.' : error instanceof Error ? error.message : '문서를 읽지 못했다.';
    return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { code, retryable, ...domainErrorDetails(code, known ? error.extra : {}) }, _meta: { 'dev.agentinterop/error': { code, retryable }, ...(known && error.state ? resource(error.state) : {}) } };
  };

  return {
    protocol: 'agentinterop',
    protocolVersion: 1,
    async describe() {
      const tools = [...DESCRIPTOR_TOOLS, ...(edits ? [...EDIT_TOOLS, CHECK_TOOL] : []),
        ...(commits ? [SAVE_TOOL, ...(options.commit?.prepareNew && options.commit?.resolveNew ? [CREATE_TOOL] : [])] : [])];
      const instructions = edits ? (commits ? EDIT_INSTRUCTIONS.replace(' 저장은 사람이 한다.', '') + SAVE_INSTRUCTIONS : EDIT_INSTRUCTIONS) : INSTRUCTIONS;
      return structuredClone({ provider: { id: 'hwp-hands', name: 'HWP Hands', version: options.version,
        description: edits ? (commits ? '한글(HWP/HWPX) 문서를 읽고 작업본을 편집하고 저장한다.' : '한글(HWP/HWPX) 문서를 읽고 작업본을 편집한다.') : '한글(HWP/HWPX) 문서를 읽는다.' },
        instructions: instructions.replace(tools.some(tool => tool.name === 'create_document') ? '' : ' 새 파일은 create_document로 만든 뒤 읽고 편집한다.', '') + contractGuide(tools),
        tools: tools.map(tool => TOOL_EXAMPLES[tool.name as string]
          ? { ...tool, description: `${typeof tool.description === 'string' ? tool.description : JSON.stringify(tool.description)}\n입력 예(핸들은 실제 조회값 사용): ${JSON.stringify(TOOL_EXAMPLES[tool.name as string])}` } : tool) });
    },
    editor: editor.capability,
    ...(edits ? { resolveTarget: ((name: string, args: JsonObject, ctx: InvocationContext) => commits && COMMIT_TOOL_NAMES.includes(name) ? commits.resolveTarget(name, args, ctx) : edits.resolveTarget(name, args, ctx)) as AgentCapabilityProvider['resolveTarget'] } : {}),
    // The functions are captured once: a host holds on to the exact ones it discovered.
    ...(commits ? { commit: {
      prepare: (request: Parameters<AgentCommits['prepare']>[0], ctx: CommitContext) => { if (disposed) throw new HwpHandsError('CANCELLED', 'HWP Hands가 종료됐다.'); return commits.prepare(request, ctx); },
      execute: (ticket: Parameters<AgentCommits['execute']>[0], ctx: CommitContext) => { if (disposed) throw new HwpHandsError('CANCELLED', 'HWP Hands가 종료됐다.'); return commits.execute(ticket, ctx); },
      status: (preparationId: string, ctx?: CommitContext) => commits.status(preparationId, ctx),
    } } : {}),
    async callTool(name, args, ctx) {
      if (disposed) return failure(new ToolError('CLOSED', 'HWP Hands가 종료됐다.', false));
      try {
        if (ctx?.signal?.aborted) throw new HwpHandsError('CANCELLED', '도구 호출이 취소됐다.');
        if (DESCRIPTOR_TOOLS.some(tool => tool.name === name) || (edits && name === 'check_before_save')) {
          const issue = validateToolInput(name, args ?? {});
          if (issue) throw new ToolError('INVALID_ARGUMENT', issue.message, true, undefined, issue.details);
        }
        if (name === 'get_editor_context') return await context(ctx);
        if (name === 'read_document') return withWorkingCopySource(await read(args ?? {}, ctx));
        if (name === 'find_text') return withWorkingCopySource(await find(args ?? {}, ctx));
        if (edits && EDIT_TOOL_NAMES.includes(name)) {
          const selection = editor.allowed(ctx?.scope, ctx?.caller);
          return await edits.call(name, args ?? {}, { ...ctx, ...(selection ? { selection } : {}) });
        }
        if (edits && name === 'check_before_save') return await edits.check(args ?? {}, ctx ?? {});
        if (commits && COMMIT_TOOL_NAMES.includes(name)) return failure(new ToolError('INVALID_ARGUMENT', '저장은 host의 저장 승인 절차로만 할 수 있다.', false));
        return failure(new ToolError('INVALID_ARGUMENT', '사용할 수 없는 도구다. available의 이름을 확인하라.', true, undefined,
          { available: [...DESCRIPTOR_TOOLS, ...(edits ? [...EDIT_TOOLS, CHECK_TOOL] : [])].map(tool => tool.name!), suggestion: 'describe()에서 현재 도구 목록을 다시 확인하라.' }));
      } catch (error) { return failure(error); }
    },
    async dispose() {
      disposed = true;
      editor.dispose();
      edits?.dispose(); commits?.dispose();
      unsubscribeEpochs(); unsubscribeApplied?.(); unsubscribePrivacy?.();
      await Promise.all([...held.keys()].map(release));
      epochs.clear(); cursors.clear();
    },
  };
}

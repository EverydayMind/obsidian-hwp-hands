import type { ActiveViewContext, BodyAddress, HwpHandsApiV1, Json, SelectionRange, State } from '../api';
import { HwpHandsError } from '../api';
import { allowedRange, overlaps, type AllowedRange } from './selection';

/** A refusal a model can act on: stable code, whether the same call may be retried, and optional recovery material. */
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly state?: { path: string; sessionId: string; revision: number; id: string },
    readonly extra: { [key: string]: Json } = {}) { super(message); }
}
export interface Caller { pluginId: string; conversationId: string; runId: string; turnId: string }
/** The edit actor a conversation is recorded as in the manager's ledger. */
export const actorIdOf = (caller: Caller): string => `${caller.pluginId}:${caller.conversationId}`.slice(0, 128);
export interface DocumentRef { path: string; sessionId: string; incarnation: string; documentEpoch: string }
export interface TurnScope extends DocumentRef {
  providerId: string; revision: number; contextId: string; capturedAt: string;
  selection?: { selectionId: string; handles: string[]; text: string };
}
export interface EditorContext { caller: Caller; signal: AbortSignal; requestId: string; scope?: TurnScope }
export interface OpenDocumentRef extends DocumentRef { hasView: boolean; dirty: boolean; heldForAgent: string[] }
export interface EditorCapability {
  capture(ctx: EditorContext): Promise<TurnScope | null>;
  openDocuments(ctx: EditorContext): Promise<OpenDocumentRef[]>;
  release(caller: Caller, documents?: DocumentRef[]): Promise<void>;
  /**
   * A person asked to see the place: brings the document to the front and moves to the handle's paragraph, or to the page (from 1).
   * Never called by a model. `located` is false when the handle is no longer valid and only the document (or page) was shown.
   */
  reveal(ctx: EditorContext, target: RevealTarget): Promise<{ revealed: true; located: boolean }>;
  /**
   * A person confirmed in the host that an unsaved working copy nobody has on screen may be dropped. It is dropped only when
   * every change since it last matched the file is this conversation's own AI edit. Never called by a model. Present with edit tools.
   */
  discardAgentChanges?(target: DocumentRef, ctx: EditorContext): Promise<{ applied: 'yes'; path: string; sessionId: string; revisionBefore: number; revisionAfter: number }>;
}
export interface RevealTarget { document: Pick<DocumentRef, 'path'> & Partial<DocumentRef>; handle?: string; page?: number }
interface Captured { caller: string; scope: TurnScope; view: ActiveViewContext; range?: SelectionRange; allowed?: AllowedRange }

/** The provider owns selection coordinates. Host/model copies never become coordinates. */
export class AgentEditor {
  readonly capability: EditorCapability;
  private readonly snapshots = new Map<string, Captured>();
  private readonly incarnations = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  constructor(private api: HwpHandsApiV1, private options: {
    token: (prefix: string) => string; epoch: (state: State) => string;
    viewPaths: () => string[]; owners: (path: string) => string[];
    release: (caller: Caller, documents?: DocumentRef[]) => Promise<void>;
    /** Address of a handle of the document as it is now; undefined for a stale or unknown handle. */
    locate: (state: State, handle: string) => Promise<BodyAddress | undefined>;
    accessible?: (path: string) => boolean;
    reveal?: (path: string, target: { address?: BodyAddress; page?: number }) => Promise<void>;
    discard?: (state: State, caller: Caller, signal?: AbortSignal) => Promise<State>;
  }) {
    this.unsubscribe = api.events.on('*', event => {
      if (['closed', 'reloaded', 'renamed'].includes(event.type)) {
        this.incarnations.delete(event.state.sessionId);
        for (const [id, item] of this.snapshots) if (item.scope.sessionId === event.state.sessionId) this.snapshots.delete(id);
      }
    });
    this.capability = {
      capture: ctx => this.capture(ctx),
      openDocuments: async ctx => {
        this.check(ctx);
        const paths = new Set(this.options.viewPaths());
        return this.api.documents.list().filter(state => this.options.accessible?.(state.path) !== false).map(state => ({ ...this.ref(state), hasView: paths.has(state.path),
          dirty: state.dirty, heldForAgent: this.options.owners(state.path) }));
      },
      release: async (caller, documents) => {
        for (const [id, item] of this.snapshots) {
          const owner: { conversationId?: unknown; pluginId?: unknown } = JSON.parse(item.caller) as { conversationId?: unknown; pluginId?: unknown };
          if (owner.conversationId === caller.conversationId && owner.pluginId === caller.pluginId
            && (!documents || documents.some(doc => doc.sessionId === item.scope.sessionId))) this.snapshots.delete(id);
        }
        await this.options.release(caller, documents);
      },
      reveal: async (ctx, target) => {
        this.check(ctx);
        const path = target?.document?.path, page = target?.page;
        if (!this.options.reveal) throw new HwpHandsError('INVALID_ARGUMENT', '이 환경에는 문서를 보여 줄 화면이 없다.');
        if (typeof path !== 'string' || !/\.(hwp|hwpx)$/i.test(path)) throw new HwpHandsError('INVALID_ARGUMENT', '보여 줄 문서는 .hwp 또는 .hwpx 경로여야 한다.');
        if (page !== undefined && (!Number.isInteger(page) || page < 1)) throw new HwpHandsError('INVALID_ARGUMENT', 'page는 1부터 세는 쪽 번호다.');
        // A handle counts only for the very session it came from; otherwise the person still gets the document.
        const state = this.api.documents.list().find(item => item.path === path);
        const same = !!state && state.sessionId === target.document.sessionId && this.incarnations.get(state.sessionId) === target.document.incarnation;
        const address = same && typeof target.handle === 'string' ? await this.options.locate(state, target.handle) : undefined;
        this.check(ctx);
        await this.options.reveal(path, address ? { address } : page !== undefined && (!state || page <= state.pageCount) ? { page } : {});
        return { revealed: true, located: !!address || target.handle === undefined };
      },
      ...(options.discard ? { discardAgentChanges: async (target: DocumentRef, ctx: EditorContext) => {
        this.check(ctx);
        const state = this.api.documents.list().find(item => item.path === target?.path);
        if (!state || state.sessionId !== target.sessionId || this.incarnations.get(state.sessionId) !== target.incarnation) throw new HwpHandsError('CLOSED', '버릴 작업본이 이미 닫혔거나 다시 열렸다.');
        // What a person has on screen is theirs to discard there.
        if (this.options.viewPaths().includes(state.path)) throw new HwpHandsError('INVALID_ARGUMENT', '화면에 열린 문서는 사람이 화면에서 직접 버린다.', { reason: 'has-view' });
        const after = await options.discard!(state, ctx.caller, ctx.signal);
        return { applied: 'yes' as const, path: after.path, sessionId: after.sessionId, revisionBefore: state.revision, revisionAfter: after.revision };
      } } : {}),
    };
  }
  private check(ctx: EditorContext): void {
    if (this.disposed || ctx.signal.aborted) throw new HwpHandsError('CANCELLED', '문맥 조회가 취소됐다.');
    if (!ctx.caller.pluginId || !ctx.caller.conversationId || !ctx.caller.runId || !ctx.caller.turnId)
      throw new HwpHandsError('INVALID_ARGUMENT', '문맥 조회에는 대화와 제출 턴 식별자가 필요하다.');
  }
  ref(state: State): DocumentRef {
    let incarnation = this.incarnations.get(state.sessionId);
    if (!incarnation) { incarnation = this.options.token('i'); this.incarnations.set(state.sessionId, incarnation); }
    return { path: state.path, sessionId: state.sessionId, incarnation, documentEpoch: this.options.epoch(state) };
  }
  private async capture(ctx: EditorContext): Promise<TurnScope | null> {
    this.check(ctx);
    const view = await this.api.views?.activeContext();
    this.check(ctx);
    if (!view || view.humanInput.composing || view.humanInput.draftPending) return null;
    if (this.options.accessible?.(view.path) === false) return null;
    const state = this.api.documents.list().find(item => item.path === view.path);
    if (!state || state.sessionId !== view.sessionId || state.revision !== view.revision) return null;
    // Never silently turn an oversized selection into whole-document scope.
    if (view.selection && view.selection.text.length > 12000) throw new HwpHandsError('INVALID_ARGUMENT', '선택 범위가 너무 크다. 범위를 줄여 다시 요청하라.');
    const scope: TurnScope = { ...this.ref(state), providerId: 'hwp-hands', revision: state.revision,
      contextId: this.options.token('ctx'), capturedAt: new Date().toISOString(),
      ...(view.selection ? { selection: { selectionId: this.options.token('sel'), handles: [], text: view.selection.text } } : {}) };
    this.snapshots.set(scope.contextId, { caller: this.binding(ctx.caller), scope: structuredClone(scope), view: structuredClone(view), range: structuredClone(view.selection?.range),
      ...(view.selection ? { allowed: allowedRange(state.sessionId, state.revision, view.selection.range) } : {}) });
    if (this.snapshots.size > 128) this.snapshots.delete(this.snapshots.keys().next().value!);
    return scope;
  }
  private binding(caller: Caller): string {
    return JSON.stringify({ pluginId: caller.pluginId, conversationId: caller.conversationId, runId: caller.runId, turnId: caller.turnId });
  }
  /** The range the edits of this turn must stay in: undefined when the turn had no selection, 'stale' when its scope is gone. */
  allowed(scope: TurnScope | undefined, caller: Caller | undefined): AllowedRange | 'stale' | undefined {
    if (!scope?.selection) return undefined;
    const found = this.snapshots.get(scope.contextId);
    return this.disposed || !caller || !found?.allowed || found.caller !== this.binding(caller) ? 'stale' : found.allowed;
  }
  /** A person's edit that kept every paragraph address: selections it did not touch follow the document, the others end. */
  carried(sessionId: string, before: number, after: number, edit: Parameters<typeof overlaps>[1]): void {
    for (const item of this.snapshots.values()) {
      const range = item.allowed;
      if (range && range.sessionId === sessionId && range.revision === before) range.revision = overlaps(range, edit) ? -1 : after;
    }
  }
  read(scope: TurnScope, caller: Caller): { scope: TurnScope; view: ActiveViewContext; changed: boolean; range?: SelectionRange; allowed?: AllowedRange } {
    const found = this.snapshots.get(scope.contextId);
    if (this.disposed || !found || found.caller !== this.binding(caller)) throw new HwpHandsError('INVALID_ARGUMENT', '선택 문맥이 만료됐거나 이 제출 턴과 다르다. 다시 요청하라.');
    const current = this.api.documents.list().find(state => state.path === found.scope.path);
    if (!current || current.sessionId !== found.scope.sessionId) throw new HwpHandsError('CLOSED', '문맥의 문서가 닫혔다.');
    if (this.options.accessible?.(current.path) === false) throw new ToolError('AI_PRIVATE', 'AI 비공개 문서의 선택 문맥을 제공하지 않는다.', false);
    return { ...structuredClone({ scope: found.scope, view: found.view, changed: current.revision !== found.scope.revision, ...(found.range ? { range: found.range } : {}) }),
      ...(found.allowed ? { allowed: found.allowed } : {}) };
  }
  invalidate(): void { this.snapshots.clear(); this.incarnations.clear(); }
  dispose(): void { this.disposed = true; this.unsubscribe(); this.invalidate(); }
}

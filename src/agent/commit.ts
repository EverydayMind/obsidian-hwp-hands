import type { Json, State } from '../api';
import { HwpHandsError } from '../api';
import { bytesHash, canonicalSaveJson, type PreparedSave, type PreparedSavePermit, type PreparedSaveReceipt, type PreparedSaveTicket } from '../prepared-save';
import type { Caller, DocumentRef } from './editor';
import { documentPath } from '../manager';
import type { NewSaveRequest } from '../prepared-new-save';
import type { PreparedSaveFolder } from '../prepared-save';
import { validateToolInput } from './tool-catalog';

/**
 * agentinterop v1, commit effect: saving a working copy to its file. The host asks the provider to prepare the exact bytes
 * (no file is written), shows a person that one write, checkpoints the files itself, and only then hands back a ticket.
 * This layer maps that protocol onto the manager's prepared overwrite, which keeps the save invariants (backup, verification,
 * readback, recovery journal, human-input guard). The ticket binds what was approved to what is written; it is not authentication.
 */
type JsonObject = { [key: string]: Json };
export const COMMIT_TOOL_NAMES = ['save_document', 'create_document'];
export interface CommitBridge {
  /** DocumentManager.prepareSave: fixes the bytes of an overwrite in memory. Writes no user file. */
  prepare(path: string, context: { sessionId: string; expectedRevision: number }): Promise<PreparedSave>;
  resolveNew?(destination: string, template?: string): Promise<{ destination: string; template?: { path: string; sha256: string } }>;
  prepareNew?(request: NewSaveRequest): Promise<PreparedSave>;
  /** DocumentManager.executePreparedSave. */
  execute(ticket: PreparedSaveTicket, permit: PreparedSavePermit): Promise<PreparedSaveReceipt>;
  /** DocumentManager.preparedSaveStatus: a passive copy, never waits for the file queue. */
  status(preparationId: string): PreparedSaveReceipt | undefined;
  /** DocumentManager.cancelPreparedSave: frees the bytes of a preparation that was never executed. */
  cancel(preparationId: string): void;
}
export type CommitTarget = { kind: 'existing'; document: DocumentRef; revision: number; destination?: string } | { kind: 'new'; destination: string; template?: { path: string; sha256: string } };
export interface CommitContext { caller?: Caller; signal?: AbortSignal; target?: CommitTarget }
export interface CommitEnvironment {
  bridge: CommitBridge;
  open(path: unknown, caller?: Caller): Promise<{ state: State }>;
  ref(state: State): DocumentRef;
  created?(path: string, caller: Caller): Promise<void>;
}
interface FileEntry { kind: 'file'; path: string; op: 'modify' | 'create'; role: 'primary' | 'derived'; sha256Before: string | null; sha256Expected: string; sizeBytes: number }
type WriteEntry = FileEntry | PreparedSaveFolder;
export interface CommitPreparation {
  preparationId: string; mode: 'overwrite' | 'save_as' | 'create'; source?: DocumentRef & { revision: number; baseHash: string }; template?: { path: string; sha256: string }; destination: string; format: string;
  saveOptions: JsonObject; writeSet: WriteEntry[]; preparationDigest: string; providerInternalWrites: string[]; report: JsonObject; expiresAt: string;
}
export interface CommitTicket {
  ticketId: string; preparationId: string; preparationDigest: string; caller: Caller; destination: string; writeSet: WriteEntry[]; expiresAt: string;
  source?: CommitPreparation['source']; providerIdentity?: JsonObject; approvedAt?: string;
}
export interface CommitReceipt {
  preparationId: string; ticketId: string; preparationDigest: string; state: PreparedSaveReceipt['state'];
  entries: Array<{ path: string; kind: 'file' | 'folder'; state: 'written' | 'unchanged' | 'not_written' | 'unknown'; sha256After?: string }>;
  warnings: string[]; error?: { code: string; message: string };
}
interface Prepared { internal: PreparedSave; shown: CommitPreparation; caller: string; state: 'open' | 'executed' | 'dropped' }
const extension = (path: string) => path.split('.').at(-1)!.toLowerCase();
const owner = (caller: Caller): string => JSON.stringify([caller.pluginId, caller.conversationId, caller.runId]);

export class AgentCommits {
  private readonly prepared = new Map<string, Prepared>();
  constructor(private env: CommitEnvironment) {}

  async resolveTarget(name: string, args: JsonObject, ctx: CommitContext): Promise<CommitTarget> {
    if (ctx.signal?.aborted) throw new HwpHandsError('CANCELLED', '대상 확인이 취소됐다.');
    const issue = validateToolInput(name, args);
    if (issue) throw new HwpHandsError('INVALID_ARGUMENT', issue.message, issue.details);
    if (name === 'create_document') {
      if (!this.env.bridge.resolveNew || !this.env.bridge.prepareNew) throw new HwpHandsError('INVALID_ARGUMENT', '새 문서 생성을 지원하지 않는다.');
      const destination = documentPath(args?.path as string), template = args?.template === undefined ? undefined : documentPath(args.template as string);
      if (template && extension(template) !== extension(destination)) throw new HwpHandsError('INVALID_ARGUMENT', '템플릿과 새 문서는 같은 형식이어야 한다.');
      return { kind: 'new', ...await this.env.bridge.resolveNew(destination, template) };
    }
    const { state } = await this.env.open(args?.path, ctx.caller);
    if (args?.destination !== undefined) {
      const destination = documentPath(args.destination as string);
      if (!this.env.bridge.resolveNew || !this.env.bridge.prepareNew || extension(destination) !== extension(state.path) || destination.toLowerCase() === state.path.toLowerCase())
        throw new HwpHandsError('INVALID_ARGUMENT', '같은 형식의 새 경로를 사용하라.');
      await this.env.bridge.resolveNew(destination);
      return { kind: 'existing', document: this.env.ref(state), revision: state.revision, destination };
    }
    return { kind: 'existing', document: this.env.ref(state), revision: state.revision };
  }

  /** Fixes the bytes that would be written. Changes no user file, backup or journal. */
  async prepare(request: { tool: string; args: JsonObject; target: CommitTarget }, ctx: CommitContext): Promise<CommitPreparation> {
    if (!COMMIT_TOOL_NAMES.includes(request?.tool)) throw new HwpHandsError('INVALID_ARGUMENT', `저장 도구가 아니다: ${String(request?.tool)}`);
    if (!ctx?.caller) throw new HwpHandsError('INVALID_ARGUMENT', '저장 대상이 확정되지 않았다.');
    const resolved = await this.resolveTarget(request.tool, request.args, ctx);
    if (canonicalSaveJson(resolved) !== canonicalSaveJson(request.target)) throw new HwpHandsError('REVISION_CONFLICT', '확정한 문서·템플릿과 지금 대상이 다르다. 다시 준비하라.');
    const destination = resolved.kind === 'new' ? resolved.destination : resolved.destination ?? resolved.document.path;
    for (const record of this.prepared.values()) if (record.state === 'open' && record.caller === owner(ctx.caller) && record.shown.destination === destination) this.drop(record);
    const internal = resolved.kind === 'new'
      ? await this.env.bridge.prepareNew!({ destination, ...(resolved.template ? { template: resolved.template } : {}) })
      : resolved.destination ? await this.env.bridge.prepareNew!({ destination, source: { path: resolved.document.path, sessionId: resolved.document.sessionId, expectedRevision: resolved.revision } })
        : await this.env.bridge.prepare(resolved.document.path, { sessionId: resolved.document.sessionId, expectedRevision: resolved.revision });
    const ai = internal.report.pendingActors.filter(item => item.actor.kind === 'ai').length, unknown = internal.report.pendingActors.length - ai;
    const body: Omit<CommitPreparation, 'preparationDigest'> = {
      preparationId: internal.preparationId, mode: internal.mode,
      ...(internal.source && resolved.kind === 'existing' ? { source: { ...resolved.document, revision: internal.source.revision, baseHash: internal.source.baseHash } } : {}),
      ...(internal.template ? { template: internal.template } : {}),
      destination: internal.destination, format: internal.format, saveOptions: { ...internal.saveOptions },
      writeSet: internal.writeSet.map(entry => entry.kind === 'folder' ? entry : ({ kind: 'file' as const, path: entry.path, op: entry.op, role: entry.role, sha256Before: entry.sha256Before, sha256Expected: entry.sha256Expected, sizeBytes: entry.sizeBytes })),
      providerInternalWrites: internal.mode === 'overwrite' && internal.writeSet.length ? [`HWP Hands 폴더에 ${internal.saveOptions.backup ? '저장 전 원본 백업과 ' : ''}복구 기록을 남긴다.`] : [],
      report: { summary: [...(ai ? [`저장되는 내용에 사람이 아직 저장하지 않은 AI 편집 ${ai}건이 들어 있다.`] : []), ...(unknown ? [`주체를 알 수 없는 편집 ${unknown}건이 들어 있다.`] : [])], warnings: internal.report.warnings.slice(0, 20).map(item => item.slice(0, 300)) },
      expiresAt: internal.expiresAt,
    };
    // Sorted-key JSON, so the host recomputes the same digest from the fields it shows a person.
    const shown: CommitPreparation = { ...body, preparationDigest: bytesHash(Buffer.from(canonicalSaveJson(body))) };
    const record: Prepared = { internal, shown, caller: owner(ctx.caller), state: 'open' };
    this.prepared.set(shown.preparationId, record);
    // Nothing to write means nothing to execute.
    if (!shown.writeSet.length) this.drop(record);
    if (this.prepared.size > 16) { const oldest = this.prepared.values().next().value!; this.drop(oldest); this.prepared.delete(oldest.shown.preparationId); }
    return structuredClone(shown);
  }

  /**
   * Writes exactly what was prepared. The host has checkpointed the write set and consumed its permit before this call;
   * this side re-checks session, revision, human input and disk hashes inside the document queue and never retries a write it started.
   */
  async execute(ticket: CommitTicket, ctx: CommitContext): Promise<CommitReceipt> {
    const record = this.prepared.get(ticket?.preparationId);
    if (!record) throw new HwpHandsError('NOT_FOUND', '저장 준비를 찾을 수 없다. 다시 실행하지 말고 host의 체크포인트로 확인하라.');
    const { internal, shown } = record;
    const refuse = (code: string, message: string): CommitReceipt => ({ preparationId: shown.preparationId, ticketId: String(ticket.ticketId), preparationDigest: shown.preparationDigest,
      state: 'not_written', entries: shown.writeSet.map(entry => ({ path: entry.path, kind: entry.kind, state: 'not_written' })), warnings: [], error: { code: code.slice(0, 64), message: message.slice(0, 1000) } });
    if (!ctx?.caller || owner(ctx.caller) !== record.caller || !ticket.caller || owner(ticket.caller) !== record.caller) return refuse('TARGET_MISMATCH', '저장을 준비한 대화·실행과 다른 호출이다. 저장하지 않았다.');
    if (record.state === 'dropped') return refuse('REVISION_CONFLICT', '이 저장 준비는 새 준비로 대체됐거나 쓸 내용이 없었다. 저장하지 않았다.');
    if (ticket.preparationDigest !== shown.preparationDigest || ticket.destination !== shown.destination || canonicalSaveJson(ticket.source) !== canonicalSaveJson(shown.source) || canonicalSaveJson(ticket.writeSet) !== canonicalSaveJson(shown.writeSet))
      return refuse('INVALID_ARGUMENT', '저장 ticket이 승인한 준비 상태와 일치하지 않는다. 저장하지 않았다.');
    const signal = ctx.signal ?? new AbortController().signal;
    const first = record.state === 'open'; record.state = 'executed';
    let receipt: PreparedSaveReceipt;
    try {
      receipt = await this.env.bridge.execute(
        { ticketId: ticket.ticketId, preparationId: internal.preparationId, preparationDigest: internal.preparationDigest, source: structuredClone(internal.source),
          destination: internal.destination, writeSet: structuredClone(internal.writeSet), expiresAt: ticket.expiresAt },
        // The host persisted its checkpoint and its run reference before it issued this ticket (agentinterop v1 commit order).
        { signal, assertAuthorized: () => { if (signal.aborted) throw new HwpHandsError('CANCELLED', '저장이 취소됐다.'); }, persistCheckpoint: async () => undefined });
    } catch (error) {
      // The manager refuses a mismatched or reused ticket before it queues anything.
      return refuse(error instanceof HwpHandsError ? error.code : 'VERIFY_FAILED', error instanceof Error ? error.message : String(error));
    }
    if (first && shown.mode !== 'overwrite' && receipt.state === 'written' && this.env.created) {
      try { await this.env.created(shown.destination, ctx.caller); }
      catch { receipt.warnings.push('파일은 저장됐지만 화면을 열지 못했습니다. 문서 경로에서 직접 여세요.'); }
    }
    return this.shown(record, receipt);
  }

  /** Result of an execution that is running or finished. Never writes and never waits for the document queue. */
  async status(preparationId: string, _ctx?: CommitContext): Promise<CommitReceipt | { state: 'unknown_preparation' }> {
    const record = this.prepared.get(preparationId);
    if (!record) return { state: 'unknown_preparation' };
    let receipt: PreparedSaveReceipt | undefined;
    try { receipt = record.state === 'dropped' ? undefined : this.env.bridge.status(record.internal.preparationId); } catch { return { state: 'unknown_preparation' }; }
    return receipt ? this.shown(record, receipt)
      : { preparationId, ticketId: 'none', preparationDigest: record.shown.preparationDigest, state: 'not_written', entries: record.shown.writeSet.map(entry => ({ path: entry.path, kind: entry.kind, state: 'not_written' as const })), warnings: [] };
  }

  private shown(record: Prepared, receipt: PreparedSaveReceipt): CommitReceipt {
    return { preparationId: record.shown.preparationId, ticketId: receipt.ticketId, preparationDigest: record.shown.preparationDigest, state: receipt.state,
      entries: receipt.entries.map(entry => ({ path: entry.path, kind: record.shown.writeSet.find(item => item.path === entry.path)!.kind, state: entry.state, ...(entry.sha256After ? { sha256After: entry.sha256After } : {}) })),
      warnings: receipt.warnings.slice(0, 64).map(item => item.slice(0, 1000)),
      ...(receipt.error ? { error: { code: receipt.error.code.slice(0, 64), message: receipt.error.message.slice(0, 1000) } } : {}) };
  }

  private drop(record: Prepared): void {
    if (record.state !== 'open') return;
    record.state = 'dropped';
    try { this.env.bridge.cancel(record.internal.preparationId); } catch { /* Already expired in the manager. */ }
  }

  dispose(): void { for (const record of this.prepared.values()) this.drop(record); this.prepared.clear(); }
}

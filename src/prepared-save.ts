import { createHash, randomUUID } from 'node:crypto';
import { HwpHandsError, type Format } from './api';
import type { ActorContribution } from './edit-actors';
import type { ManagerOptions } from './manager';

/** Internal prepared-save primitives, not the AgentInterop authorization contract. */
export interface PreparedSaveSource { path: string; sessionId: string; revision: number; baseHash: string }
export interface PreparedSaveEntry {
  kind?: 'file';
  path: string; role: 'primary' | 'derived'; op: 'modify' | 'create';
  sha256Before: string | null; sha256Expected: string; sizeBytes: number;
}
export interface PreparedSaveFolder { kind: 'folder'; path: string; role: 'folder'; op: 'create'; existedBefore: false }
export type PreparedWriteEntry = PreparedSaveEntry | PreparedSaveFolder;
export interface PreparedSave {
  preparationId: string; preparationDigest: string; mode: 'overwrite' | 'save_as' | 'create';
  source?: PreparedSaveSource; template?: { path: string; sha256: string }; destination: string; format: Format; saveOptions: ManagerOptions;
  writeSet: PreparedWriteEntry[]; report: { pendingActors: ActorContribution[]; warnings: string[] }; expiresAt: string;
}
export interface PreparedSaveTicket {
  ticketId: string; preparationId: string; preparationDigest: string;
  source?: PreparedSaveSource; destination: string; writeSet: PreparedWriteEntry[]; expiresAt: string;
}
export interface PreparedSaveArtifact { path: string; before: Uint8Array | null; after: Uint8Array }
export interface PreparedSaveCheckpoint {
  preparation: PreparedSave; ticketId: string; artifacts: PreparedSaveArtifact[];
}
export interface PreparedSavePermit {
  signal: AbortSignal;
  /** Host checks approval, caller/run, provider identity and grant. No self-reported grant is trusted here. */
  assertAuthorized(): void;
  /** Must resolve only after the complete checkpoint and its run reference are durable. */
  persistCheckpoint(checkpoint: PreparedSaveCheckpoint): Promise<void>;
}
export interface PreparedSaveReceipt {
  preparationId: string; ticketId: string; preparationDigest: string;
  state: 'pending' | 'written' | 'not_written' | 'partial' | 'unknown';
  entries: { path: string; state: 'written' | 'unchanged' | 'not_written' | 'unknown'; sha256After?: string }[];
  warnings: string[]; error?: { code: string; message: string };
}
export const bytesHash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
// Sorting object keys lets the future host independently bind the same approval snapshot.
export function canonicalSaveJson(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, normalize(entry)])) : item;
  return JSON.stringify(normalize(value));
}
export interface PreparedSaveRecord {
  preparation: PreparedSave; artifacts: PreparedSaveArtifact[]; current: () => boolean;
  ticket?: PreparedSaveTicket; receipt?: PreparedSaveReceipt; completedAt?: number;
}
const TTL = 10 * 60_000, RECEIPT_TTL = 24 * 60 * 60_000, MAX_BYTES = 100 * 1024 * 1024;

/** Bounded volatile artifacts; durable checkpoints/receipts remain the host adapter's responsibility. */
export class PreparedSaveStore {
  private readonly records = new Map<string, PreparedSaveRecord>();
  private readonly tickets = new Map<string, string>();
  add(value: Omit<PreparedSave, 'preparationId' | 'preparationDigest' | 'expiresAt'>, artifacts: PreparedSaveArtifact[], current: () => boolean): PreparedSave {
    this.prune();
    const live = [...this.records.values()].filter(record => record.completedAt === undefined);
    const size = (items: PreparedSaveArtifact[]) => items.reduce((sum, item) => sum + (item.before?.byteLength ?? 0) + item.after.byteLength, 0);
    if (live.length >= 2 || live.reduce((sum, record) => sum + size(record.artifacts), size(artifacts)) > MAX_BYTES) {
      throw new HwpHandsError('INVALID_ARGUMENT', '저장 준비 보관 한도(2개/100 MiB)를 초과했습니다. 기존 준비를 취소하세요.');
    }
    const body = { ...structuredClone(value), preparationId: randomUUID(), expiresAt: new Date(Date.now() + TTL).toISOString() };
    const preparation = { ...body, preparationDigest: bytesHash(Buffer.from(canonicalSaveJson(body))) };
    this.records.set(preparation.preparationId, { preparation, artifacts: artifacts.map(item => ({ path: item.path, before: item.before?.slice() ?? null, after: item.after.slice() })), current });
    return structuredClone(preparation);
  }
  get(id: string): PreparedSaveRecord {
    this.prune();
    const record = this.records.get(id);
    if (!record) throw new HwpHandsError('NOT_FOUND', '저장 준비를 찾을 수 없습니다. 실행을 재전송하지 말고 host checkpoint를 확인하세요.');
    return record;
  }
  /** Claims synchronously before queueing; duplicate execution never waits for the running file queue. */
  claim(value: PreparedSaveTicket): { record: PreparedSaveRecord; duplicate: boolean } {
    const ticket = structuredClone(value), record = this.get(ticket.preparationId), prep = record.preparation;
    if (record.ticket) {
      if (canonicalSaveJson(record.ticket) !== canonicalSaveJson(ticket)) throw new HwpHandsError('INVALID_ARGUMENT', '이미 다른 ticket으로 실행한 저장 준비입니다.');
      return { record, duplicate: true };
    }
    if (!ticket.ticketId || ticket.ticketId.length > 128 || this.tickets.has(ticket.ticketId)
      || ticket.preparationDigest !== prep.preparationDigest || ticket.destination !== prep.destination
      || canonicalSaveJson(ticket.source) !== canonicalSaveJson(prep.source) || canonicalSaveJson(ticket.writeSet) !== canonicalSaveJson(prep.writeSet)
      || !Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) > Date.parse(prep.expiresAt)) {
      throw new HwpHandsError('INVALID_ARGUMENT', '저장 ticket이 승인한 준비 상태와 일치하지 않습니다.');
    }
    record.ticket = ticket; this.tickets.set(ticket.ticketId, prep.preparationId);
    record.receipt = { preparationId: prep.preparationId, preparationDigest: prep.preparationDigest, ticketId: ticket.ticketId,
      state: 'pending', entries: prep.writeSet.map(entry => ({ path: entry.path, state: 'not_written' })), warnings: [...prep.report.warnings] };
    return { record, duplicate: false };
  }
  status(id: string): PreparedSaveReceipt | undefined { return structuredClone(this.get(id).receipt); }
  finish(record: PreparedSaveRecord): PreparedSaveReceipt {
    record.completedAt = Date.now(); record.artifacts = []; record.current = () => false;
    return structuredClone(record.receipt!);
  }
  cancel(id: string): void {
    const record = this.get(id);
    if (record.ticket) throw new HwpHandsError('INVALID_ARGUMENT', '실행된 저장 준비는 상태 조회로 확인하세요.');
    this.records.delete(id);
  }
  dispose(): void { this.records.clear(); this.tickets.clear(); }
  private prune(): void {
    for (const [id, record] of this.records) {
      if ((!record.ticket && Date.parse(record.preparation.expiresAt) <= Date.now())
        || (record.completedAt !== undefined && record.completedAt + RECEIPT_TTL <= Date.now())) {
        this.records.delete(id); if (record.ticket) this.tickets.delete(record.ticket.ticketId);
      }
    }
  }
}

import { HwpHandsError } from './api';

/** Internal provenance. Public transaction origin is a UI hint, never evidence of a human actor. */
export type EditActor = { kind: 'human' } | { kind: 'unknown' } | { kind: 'ai'; id: string };
export interface ActorContribution { id: string; actor: Exclude<EditActor, { kind: 'human' }> }
export interface PersistedActors { version: 1; seed: ActorContribution[]; approved: string[] }
const MAX_ACTORS = 10000;
// eslint-disable-next-line no-control-regex -- Persisted actor identifiers exclude control characters.
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const invalid = (): never => { throw new HwpHandsError('VERIFY_FAILED', '복구 기록의 편집 주체/저장 승인 원장이 올바르지 않습니다. 기존 기록을 보존했습니다.'); };
export function validateEditActor(value: unknown): EditActor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>, keys = Object.keys(item);
  if ((item.kind === 'human' || item.kind === 'unknown') && keys.length === 1) return { kind: item.kind };
  if (item.kind === 'ai' && keys.length === 2 && keys.includes('id') && validId(item.id)) return { kind: 'ai', id: item.id };
  return invalid();
}
export function validateActionActor(actor: unknown, editId: unknown): void {
  if (actor === undefined && editId === undefined) return; // Legacy records are conservatively migrated by the manager.
  validateEditActor(actor); if (!validId(editId)) invalid();
}
export function validatePersistedActors(value: unknown): PersistedActors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3 || item.version !== 1 || !Array.isArray(item.seed) || !Array.isArray(item.approved)
    || item.seed.length > MAX_ACTORS || item.approved.length > MAX_ACTORS) return invalid();
  const ids = new Set<string>();
  const entries: unknown[] = item.seed;
  const approved: unknown[] = item.approved;
  const seed = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2
      ) return invalid();
    const candidate = entry as Record<string, unknown>;
    if (!validId(candidate.id) || ids.has(candidate.id)) return invalid();
    const actor = validateEditActor(candidate.actor); if (actor.kind === 'human') return invalid();
    ids.add(candidate.id); return { id: candidate.id, actor };
  });
  if (approved.some(id => !validId(id)) || new Set(approved).size !== approved.length) return invalid();
  return { version: 1, seed, approved: approved as string[] };
}

/** Snapshot provenance follows the same Undo/Redo boundaries as the engine; approvals survive history replay. */
export class EditActorLedger {
  private active: ActorContribution[];
  private readonly snapshots = new Map<number, ActorContribution[]>();
  private readonly approved: Set<string>;
  constructor(public seed: ActorContribution[] = [], approved: string[] = []) {
    this.seed = structuredClone(seed); this.approved = new Set(approved); this.active = structuredClone(seed).filter(entry => !this.approved.has(entry.id));
  }
  current(): ActorContribution[] { return structuredClone(this.active.filter(entry => !this.approved.has(entry.id))); }
  setCurrent(value: ActorContribution[]): void { this.active = structuredClone(value); }
  capture(snapshot: number): void { this.snapshots.set(snapshot, this.current()); }
  at(snapshot: number): ActorContribution[] {
    const value = this.snapshots.get(snapshot); if (!value) throw new HwpHandsError('VERIFY_FAILED', 'Undo 편집 주체 원장을 찾을 수 없습니다.');
    return structuredClone(value.filter(entry => !this.approved.has(entry.id)));
  }
  restore(snapshot: number): void { this.active = this.at(snapshot); }
  discard(snapshot: number): void { this.snapshots.delete(snapshot); }
  apply(actor: EditActor, id: string): void {
    if (actor.kind !== 'human' && !this.approved.has(id)) {
      if (this.active.length >= MAX_ACTORS || this.active.some(entry => entry.id === id)) invalid();
      this.active.push({ id, actor: structuredClone(actor) });
    }
  }
  blockReason(): string | undefined {
    const pending = this.active.filter(entry => !this.approved.has(entry.id));
    return pending.some(entry => entry.actor.kind === 'ai') ? 'unapproved-ai' : pending.length ? 'unknown-actor' : undefined;
  }
  /** Call only after the exact explicit save has passed binary write/readback. saveAs does not approve the original. */
  approveCurrent(): void {
    const ids = new Set(this.active.map(entry => entry.id));
    for (const id of ids) this.approved.add(id);
    this.active = []; this.seed = this.seed.filter(entry => !ids.has(entry.id));
    for (const [snapshot, entries] of this.snapshots) this.snapshots.set(snapshot, entries.filter(entry => !ids.has(entry.id)));
  }
  persistent(actionIds: string[]): PersistedActors {
    const retained = new Set([...this.seed.map(entry => entry.id), ...actionIds]);
    const value = { version: 1 as const, seed: structuredClone(this.seed), approved: [...this.approved].filter(id => retained.has(id)) };
    return validatePersistedActors(value);
  }
  retainApprovals(ids: string[]): void { this.approved.clear(); for (const id of ids) this.approved.add(id); }
  fingerprint(): string { return JSON.stringify([this.active, [...this.approved]]); }
}

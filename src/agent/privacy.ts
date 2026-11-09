import { ToolError } from './editor';

export interface AgentPrivacyData { version: 1; blockedPaths: string[]; retiredPaths?: string[] }
const denied = (): ToolError => new ToolError('AI_PRIVATE', 'AI 비공개 설정으로 이 요청을 차단했다. 사람이 HWP Hands에서 설정을 확인해야 한다.', false);
const key = (path: string): string => path.replaceAll('\\', '/').normalize('NFC').toLowerCase();
const valid = (path: unknown): path is string => typeof path === 'string' && !!path && !path.startsWith('/')
  && !/[:\0\r\n]/.test(path) && !path.replaceAll('\\', '/').split('/').some(part => !part || part === '.' || part === '..');

/** Whole-document exclusion only. No document text, guessed ranges or marks enter this store. */
export class AgentPrivacy {
  private paths = new Set<string>();
  private retired = new Set<string>();
  private invalid = false;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(data?: unknown, private inventory?: () => Iterable<string>) {
    if (data === undefined) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) { this.invalid = true; return; }
    const input = data as Partial<AgentPrivacyData>;
    if (input.version !== 1 || !Array.isArray(input.blockedPaths) || !input.blockedPaths.every(valid)) { this.invalid = true; return; }
    this.paths = new Set(input.blockedPaths.map(key));
    if (input.retiredPaths !== undefined) {
      if (!Array.isArray(input.retiredPaths) || !input.retiredPaths.every(path => valid(path) && this.paths.has(key(path)))) { this.invalid = true; return; }
      this.retired = new Set(input.retiredPaths.map(key));
    }
  }
  get needsRepair(): boolean { return this.invalid; }
  configured(path: string): boolean { return this.paths.has(key(path)); }
  /** An unobserved move/deletion must not turn a private file at a new path into an ordinary AI input. */
  get needsReview(): boolean {
    if (!this.inventory || !this.paths.size) return false;
    try {
      const existing = new Set([...this.inventory()].map(key));
      return [...this.paths].some(path => !this.retired.has(path) && !existing.has(path));
    } catch { return true; }
  }
  blocked(path: string): boolean { return this.invalid || this.needsReview || this.paths.has(key(path)); }
  assert(path: unknown): void { if (this.invalid || this.needsReview || typeof path === 'string' && this.paths.has(key(path))) throw denied(); }
  private data(paths = this.paths): AgentPrivacyData {
    const retiredPaths = [...this.retired].filter(path => paths.has(path)).sort();
    return { version: 1, blockedPaths: [...paths].sort(), ...(retiredPaths.length ? { retiredPaths } : {}) };
  }
  snapshot(): AgentPrivacyData { if (this.invalid) throw denied(); return this.data(); }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { this.generation++; for (const listener of this.listeners) listener(); }

  /** Hide immediately; reveal only after durable persistence. Failed writes always leave the gate closed. */
  set(path: string, hidden: boolean, persist: (data: AgentPrivacyData) => Promise<void>): Promise<void> {
    if (!valid(path)) return Promise.reject(denied());
    if (this.invalid) return Promise.reject(denied());
    if (hidden && (!this.paths.has(key(path)) || this.retired.has(key(path)))) { this.paths.add(key(path)); this.retired.delete(key(path)); this.changed(); }
    const operation = this.pending.catch(() => undefined).then(async () => {
      for (;;) {
        const generation = this.generation, wanted = new Set(this.paths);
        if (!hidden) wanted.delete(key(path));
        await persist(this.data(wanted));
        // A Vault rename or another hide may have arrived during disk I/O.
        if (this.generation !== generation) continue;
        if (!hidden && this.paths.delete(key(path))) { this.retired.delete(key(path)); this.changed(); }
        return;
      }
    });
    this.pending = operation;
    return operation;
  }

  persist(persist: (data: AgentPrivacyData) => Promise<void>): Promise<void> {
    const operation = this.pending.catch(() => undefined).then(async () => {
      for (;;) {
        const generation = this.generation;
        await persist(this.snapshot());
        if (generation === this.generation) return;
      }
    });
    this.pending = operation; return operation;
  }

  /** Keep the old path blocked too: deletion/replacement must never silently remove privacy. */
  renamed(oldPath: string, newPath: string): boolean {
    if (this.invalid || !valid(oldPath) || !valid(newPath)) return false;
    const before = key(oldPath), after = key(newPath);
    let changed = false;
    for (const path of [...this.paths]) if (path === before || path.startsWith(`${before}/`)) {
      const moved = after + path.slice(before.length);
      if (!this.paths.has(moved)) { this.paths.add(moved); changed = true; }
      if (path !== moved) {
        if (!this.retired.has(path)) { this.retired.add(path); changed = true; }
        if (this.retired.delete(moved)) changed = true;
      }
    }
    if (changed) this.changed();
    return changed;
  }

  /** Cancels active AI commands and withholds both results and engine errors if policy changes while awaiting. */
  async run<T>(paths: unknown[], signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assert(undefined);
    for (const path of paths) this.assert(path);
    const generation = this.generation, controller = new AbortController();
    const unsubscribe = this.onChange(() => controller.abort());
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const result = await action(combined);
      if (this.generation !== generation) throw denied();
      this.assert(undefined);
      for (const path of paths) this.assert(path);
      return result;
    } catch (error) {
      if (this.generation !== generation) throw denied();
      this.assert(undefined);
      for (const path of paths) this.assert(path);
      throw error;
    }
    finally { unsubscribe(); }
  }
}

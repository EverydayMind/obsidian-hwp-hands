/** Internal scheduling only. The executor must validate a candidate and recheck isCurrent before writing. */
export interface AutosaveSnapshot { revision: number; dirty: boolean; blockedReason?: string }
export interface AutosaveInput { composing: boolean; pending: boolean; busy?: boolean }
export interface AutosaveCandidate {
  readonly sessionId: string;
  readonly path: string;
  readonly revision: number;
  readonly generation: number;
  isCurrent(): boolean;
  /** Reports the binary write/readback stage without changing input generation or the idle deadline. */
  writing(): void;
}
export type AutosaveOutcome = { savedRevision: number; warnings?: string[] } | { deferred: string };
export interface AutosaveStatus {
  phase: 'idle' | 'waiting' | 'blocked' | 'validating' | 'saving' | 'saved' | 'failed' | 'closed';
  revision?: number;
  reason?: string;
  warnings?: string[];
  errorCode?: string;
}
export interface AutosaveSchedulerOptions {
  // Policy is supplied by the owner after measurement; this module does not choose a production idle interval.
  idleMs: number;
  save(candidate: AutosaveCandidate): Promise<AutosaveOutcome>;
  onStatus?(sessionId: string, status: AutosaveStatus): void;
}
export interface AutosaveViewHandle { changed(): void; dispose(): void }
export interface AutosaveDocumentHandle {
  changed(): void;
  attachView(read: () => AutosaveInput): AutosaveViewHandle;
  pause(reason: string): () => void;
  relocate(path: string): void;
  flush(): Promise<AutosaveStatus>;
  status(): AutosaveStatus;
  dispose(): void;
}
interface Document {
  sessionId: string;
  path: string;
  read: () => AutosaveSnapshot;
  views: Set<() => AutosaveInput>;
  holds: Map<symbol, string>;
  generation: number;
  lastActivity: number;
  status: AutosaveStatus;
  failure?: string;
  failureCode?: string;
  completed?: AutosaveStatus;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  waiters: Array<(status: AutosaveStatus) => void>;
}

/** One execution globally, one coalesced request per session, no periodic retries or shutdown writes. */
export class AutosaveScheduler {
  private readonly documents = new Map<string, Document>();
  private readonly ready = new Map<string, Document>();
  private pumping = false;
  private disposed = false;

  constructor(private readonly options: AutosaveSchedulerOptions) {
    if (!Number.isFinite(options.idleMs) || options.idleMs <= 0 || options.idleMs > 2_147_483_647) {
      throw new Error('Autosave idleMs must be a positive timer interval.');
    }
  }

  track(sessionId: string, path: string, read: () => AutosaveSnapshot): AutosaveDocumentHandle {
    if (this.disposed || this.documents.has(sessionId)) throw new Error('Autosave session is closed or already tracked.');
    const doc: Document = { sessionId, path, read, views: new Set(), holds: new Map(), generation: 0, lastActivity: performance.now(), status: { phase: 'idle' }, waiters: [] };
    this.documents.set(sessionId, doc);
    const handle: AutosaveDocumentHandle = {
      changed: () => this.changed(doc),
      attachView: readInput => {
        if (!this.live(doc)) return { changed() {}, dispose() {} };
        // Each registration has an independent lifetime, including two registrations of the same reader.
        const reader = () => readInput();
        doc.views.add(reader); this.changed(doc);
        let attached = true;
        return {
          changed: () => { if (attached) this.changed(doc); },
          dispose: () => { if (attached) { attached = false; doc.views.delete(reader); this.changed(doc); } },
        };
      },
      pause: reason => {
        if (!this.live(doc)) return () => {};
        const token = Symbol(); doc.holds.set(token, reason); this.changed(doc);
        return () => { if (doc.holds.delete(token)) this.changed(doc); };
      },
      relocate: next => { if (this.live(doc) && doc.path !== next) { doc.path = next; this.changed(doc); } },
      flush: () => this.flush(doc),
      status: () => structuredClone(doc.status),
      dispose: () => this.close(doc),
    };
    this.changed(doc);
    return handle;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const doc of [...this.documents.values()]) this.close(doc);
    // A running validator may finish, but its candidate is invalid and cannot schedule another attempt.
  }

  private live(doc: Document): boolean { return !this.disposed && this.documents.get(doc.sessionId) === doc; }
  private notify(doc: Document, status: AutosaveStatus): void {
    if (status.phase !== 'closed' && status.revision === doc.completed?.revision && doc.completed?.warnings?.length) {
      status = { ...status, warnings: [...doc.completed.warnings] };
    }
    if (JSON.stringify(doc.status) === JSON.stringify(status)) return;
    doc.status = status;
    try { this.options.onStatus?.(doc.sessionId, structuredClone(status)); } catch { /* An observer cannot interrupt preservation. */ }
  }
  private settle(doc: Document): void {
    for (const resolve of doc.waiters.splice(0)) resolve(structuredClone(doc.status));
  }
  private cancelPending(doc: Document): void {
    if (doc.timer !== undefined) clearTimeout(doc.timer);
    doc.timer = undefined; this.ready.delete(doc.sessionId);
  }
  private close(doc: Document): void {
    if (this.documents.get(doc.sessionId) !== doc) return;
    this.cancelPending(doc); this.documents.delete(doc.sessionId); doc.views.clear(); doc.holds.clear(); doc.generation++;
    this.notify(doc, { phase: 'closed' }); this.settle(doc);
  }
  private inspect(doc: Document): { snapshot: AutosaveSnapshot; reason?: string } | undefined {
    if (!this.live(doc)) return;
    try {
      const snapshot = doc.read();
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('Invalid autosave revision.');
      let reason = doc.holds.values().next().value ?? snapshot.blockedReason;
      // Pending input matters even when the model currently reports clean.
      for (const read of doc.views) {
        const input = read();
        reason ??= input.composing ? 'composition' : input.pending ? 'pending-input' : input.busy ? 'view-busy' : undefined;
      }
      return { snapshot, reason };
    } catch (error) {
      doc.failure = error instanceof Error ? error.message : String(error);
      doc.failureCode = undefined;
      this.cancelPending(doc); this.notify(doc, { phase: 'failed', reason: doc.failure }); this.settle(doc);
    }
  }
  private changed(doc: Document): void {
    if (!this.live(doc)) return;
    doc.generation++; doc.lastActivity = performance.now(); this.cancelPending(doc);
    this.schedule(doc);
    // A queued explicit flush was superseded by input; report waiting/blocking instead of leaving its promise unresolved.
    if (!doc.running) this.settle(doc);
  }
  private schedule(doc: Document): void {
    this.cancelPending(doc);
    const inspected = this.inspect(doc); if (!inspected) return;
    const { snapshot, reason } = inspected;
    if (snapshot.dirty || snapshot.revision !== doc.completed?.revision) doc.completed = undefined;
    if (!snapshot.dirty && !reason) {
      // A successful explicit save/discard reload also ends a previous automatic-save failure.
      doc.failure = undefined; doc.failureCode = undefined;
      this.notify(doc, doc.completed ?? { phase: 'idle', revision: snapshot.revision });
      return;
    }
    if (doc.failure) { this.notify(doc, { phase: 'failed', revision: snapshot.revision, reason: doc.failure, ...(doc.failureCode ? { errorCode: doc.failureCode } : {}) }); return; }
    if (reason) { this.notify(doc, { phase: 'blocked', revision: snapshot.revision, reason }); return; }
    this.notify(doc, { phase: 'waiting', revision: snapshot.revision });
    doc.timer = setTimeout(() => {
      doc.timer = undefined;
      if (this.live(doc)) this.enqueue(doc);
    }, Math.max(0, doc.lastActivity + this.options.idleMs - performance.now()));
    (doc.timer as unknown as { unref?: () => void }).unref?.();
  }
  private enqueue(doc: Document): void {
    this.ready.set(doc.sessionId, doc);
    void this.pump();
  }
  private async flush(doc: Document): Promise<AutosaveStatus> {
    if (!this.live(doc)) return { phase: 'closed' };
    if (doc.running) {
      await doc.running;
      if (!this.live(doc) || doc.failure) return structuredClone(doc.status);
    } else { doc.failure = undefined; doc.failureCode = undefined; } // Explicit retry only. A timer or a new edit never retries a failed save.
    this.cancelPending(doc);
    const inspected = this.inspect(doc); if (!inspected) return structuredClone(doc.status);
    if (inspected.reason || !inspected.snapshot.dirty) {
      this.schedule(doc); return structuredClone(doc.status);
    }
    const result = new Promise<AutosaveStatus>(resolve => doc.waiters.push(resolve));
    this.enqueue(doc); return result;
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (this.ready.size && !this.disposed) {
        const doc = this.ready.values().next().value!;
        this.ready.delete(doc.sessionId);
        if (!this.live(doc)) continue;
        // Defer start to a microtask so running is set before callbacks can notify new input or flush.
        const running = Promise.resolve().then(() => this.attempt(doc));
        doc.running = running;
        try { await running; }
        finally { doc.running = undefined; this.settle(doc); }
      }
    } finally { this.pumping = false; }
  }
  private async attempt(doc: Document): Promise<void> {
    const inspected = this.inspect(doc); if (!inspected) return;
    const { snapshot, reason } = inspected;
    if (doc.failure || reason || !snapshot.dirty) { this.schedule(doc); return; }
    const candidate: AutosaveCandidate = {
      sessionId: doc.sessionId, path: doc.path, revision: snapshot.revision, generation: doc.generation,
      isCurrent: () => {
        if (!this.live(doc) || doc.path !== candidate.path || doc.generation !== candidate.generation) return false;
        const latest = this.inspect(doc);
        return !!latest && !doc.failure && !latest.reason && latest.snapshot.dirty && latest.snapshot.revision === candidate.revision;
      },
      writing: () => {
        if (candidate.isCurrent()) this.notify(doc, { phase: 'saving', revision: candidate.revision });
      },
    };
    this.notify(doc, { phase: 'validating', revision: candidate.revision });
    try {
      if (!candidate.isCurrent()) { this.schedule(doc); return; }
      const outcome = await this.options.save(candidate);
      if (!this.live(doc)) return;
      if ('deferred' in outcome) {
        // A superseded request must not hold the latest input/renamed target under an old policy verdict.
        if (doc.generation !== candidate.generation) this.schedule(doc);
        else { this.cancelPending(doc); this.notify(doc, { phase: 'blocked', revision: candidate.revision, reason: outcome.deferred }); }
        return;
      }
      if (outcome.savedRevision !== candidate.revision) throw new Error('Executor saved a different autosave revision.');
      const latest = this.inspect(doc); if (!latest) return;
      if (latest.snapshot.revision === candidate.revision && !latest.snapshot.dirty && doc.path === candidate.path) {
        doc.completed = { phase: 'saved', revision: candidate.revision, ...(outcome.warnings?.length ? { warnings: [...outcome.warnings] } : {}) };
        this.schedule(doc);
      } else if (latest.snapshot.revision === candidate.revision && latest.snapshot.dirty && doc.generation === candidate.generation) {
        throw new Error('Executor reported a save but the same revision remains dirty.');
      } else this.schedule(doc);
    } catch (error) {
      if (!this.live(doc)) return;
      const latest = this.inspect(doc);
      if (latest && !latest.snapshot.dirty && !latest.reason) { this.schedule(doc); return; }
      doc.failure = error instanceof Error ? error.message : String(error);
      doc.failureCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      this.cancelPending(doc); this.notify(doc, { phase: 'failed', revision: candidate.revision, reason: doc.failure, ...(doc.failureCode ? { errorCode: doc.failureCode } : {}) });
    }
  }
}

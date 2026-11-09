import { HwpHandsError, type ErrorCode } from './api';
import { closeBitmaps } from './canvas-page';
import { ENGINE_RPC_METHODS, type EnginePort, type EngineProvider, type EngineRpcMethod } from './engine-port';
import type { RewriteComputeRequest, RewriteComputeResult } from './agent/rewrite-compute';

export interface EngineProgress {
  requestId: number;
  method: string;
  phase: 'started' | 'completed' | 'failed' | 'cancel-requested' | 'cancelled';
  activeCount: number;
  cancelable: boolean;
  elapsedMs?: number;
}
type ProgressListener = (progress: EngineProgress) => void;
type Factory = (source: string) => Worker;
type RequestMessage =
  | { type: 'initialize'; wasm: ArrayBuffer }
  | { type: 'create'; handle: number; kind: 'parse'; bytes: ArrayBuffer }
  | { type: 'create'; handle: number; kind: 'blank' }
  | { type: 'call'; handle: number; method: EngineRpcMethod; args: unknown[] }
  | { type: 'rewrite-compute'; request: RewriteComputeRequest };
type WorkerMessage =
  | { id: number; type: 'progress'; method: string; phase: 'started' }
  | { id: number; type: 'response'; ok: true; result?: unknown }
  | { id: number; type: 'response'; ok: false; error: { code: string; message: string; details?: unknown } };
interface Pending {
  method: string;
  cancelable: boolean;
  startedAt: number;
  started: boolean;
  cancelRequested: boolean;
  resolve(value: { result: unknown; cancelled: boolean }): void;
  reject(error: unknown): void;
}
interface Operation { method: EngineRpcMethod; args: unknown[]; result?: unknown }
interface RemoteRecord { handle: number; seed?: Uint8Array; blank: boolean; operations: Operation[]; snapshotOffsets: Map<number, number> }
const RPC_METHODS = new Set<string>(ENGINE_RPC_METHODS);
const NON_CANCELLABLE = new Set<EngineRpcMethod>(['free', 'snapshot', 'restore', 'discard']);
const ERROR_CODES = new Set<ErrorCode>(['INVALID_PATH', 'NOT_FOUND', 'INVALID_ARGUMENT', 'REVISION_CONFLICT', 'FILE_CONFLICT', 'UNSAVED_CHANGES', 'CONTENT_LOSS', 'VERIFY_FAILED', 'ENGINE_ERROR', 'CANCELLED', 'CLOSED']);

export class WorkerEngineProvider implements EngineProvider {
  private worker?: Worker;
  private workerUrl?: string;
  private sourcePromise?: Promise<string>;
  private wasmPromise?: Promise<Uint8Array>;
  private bootPromise?: Promise<void>;
  private requestId = 0;
  private handleId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly engines = new Map<number, RemoteRecord>();
  private disposed = false;

  constructor(
    private readonly readWorker: () => Promise<string>,
    private readonly readWasm: () => Promise<Uint8Array>,
    private readonly onProgress: ProgressListener = () => {},
    private readonly workerFactory?: Factory,
  ) {}

  get canCancelCurrent(): boolean {
    return [...this.pending.values()].some(request => request.started && request.cancelable && !request.cancelRequested);
  }

  cancelCurrent(): boolean {
    const entry = [...this.pending.entries()].find(([, request]) => request.started && request.cancelable && !request.cancelRequested);
    if (!entry) return false;
    const [requestId, request] = entry;
    request.cancelRequested = true;
    this.notify(requestId, request, 'cancel-requested');
    return true;
  }

  async initialize(): Promise<void> {
    await this.ensureReady();
  }

  /** Bounded read-only planning runs away from the renderer; cancellation never writes a document. */
  async rewriteCompute(request: RewriteComputeRequest, signal?: AbortSignal): Promise<RewriteComputeResult> {
    if (signal?.aborted) throw new HwpHandsError('CANCELLED', '재작성 계산이 취소됐습니다.');
    await this.ensureReady();
    if (signal?.aborted) throw new HwpHandsError('CANCELLED', '재작성 계산이 취소됐습니다.');
    const { result } = await this.send({ type: 'rewrite-compute', request }, 'rewrite-compute', false);
    if (signal?.aborted) throw new HwpHandsError('CANCELLED', '재작성 계산이 취소됐습니다.');
    return result as RewriteComputeResult;
  }

  async parse(bytes: Uint8Array): Promise<EnginePort> {
    await this.ensureReady();
    const handle = ++this.handleId;
    const copy = Uint8Array.from(bytes);
    await this.send({ type: 'create', handle, kind: 'parse', bytes: copy.buffer }, 'open document', false, [copy.buffer]);
    const record: RemoteRecord = { handle, seed: bytes, blank: false, operations: [], snapshotOffsets: new Map() };
    this.engines.set(handle, record);
    return this.port(record);
  }

  async blank(): Promise<EnginePort> {
    await this.ensureReady();
    const handle = ++this.handleId;
    await this.send({ type: 'create', handle, kind: 'blank' }, 'create document', false);
    const record: RemoteRecord = { handle, blank: true, operations: [], snapshotOffsets: new Map() };
    this.engines.set(handle, record);
    return this.port(record);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const request of this.pending.values()) request.reject(new HwpHandsError('CLOSED', 'The HWP engine worker provider has been disposed.'));
    this.pending.clear();
    this.stopWorker();
    this.engines.clear();
  }

  private port(record: RemoteRecord): EnginePort {
    return new Proxy({}, {
      get: (_target, property) => {
        if (typeof property !== 'string' || !RPC_METHODS.has(property)) return undefined;
        return (...args: unknown[]) => this.invoke(record, property as EngineRpcMethod, args);
      },
    }) as EnginePort;
  }

  private async invoke(record: RemoteRecord, method: EngineRpcMethod, args: unknown[]): Promise<unknown> {
    await this.ensureReady();
    const { result, cancelled } = await this.send(
      { type: 'call', handle: record.handle, method, args }, method, !NON_CANCELLABLE.has(method),
    );
    if (method === 'snapshot' && typeof result === 'number') {
      record.snapshotOffsets.set(result, record.operations.length);
      record.operations.push({ method, args: [], result });
    } else if (method === 'execute' || method === 'restore') record.operations.push({ method, args: [...args] });
    else if (method === 'discard' && typeof args[0] === 'number') {
      const id = args[0], offset = record.snapshotOffsets.get(id), latestOffset = Math.max(-1, ...record.snapshotOffsets.values());
      const previous = record.operations.at(-1);
      if (offset !== undefined && offset === latestOffset && previous?.method === 'restore' && previous.args[0] === id) {
        record.operations.splice(offset);
        for (const [snapshotId, snapshotOffset] of record.snapshotOffsets) if (snapshotOffset >= offset) record.snapshotOffsets.delete(snapshotId);
      } else {
        record.operations.push({ method, args: [...args] });
        record.snapshotOffsets.delete(id);
      }
    }
    else if (method === 'free') this.engines.delete(record.handle);
    if (cancelled) { closeBitmaps(result); throw new HwpHandsError('CANCELLED', `문서 작업이 안전한 작업 경계에서 취소되었습니다: ${method}.`); }
    return result;
  }

  private async ensureReady(): Promise<void> {
    if (this.disposed) throw new HwpHandsError('CLOSED', 'The HWP engine worker provider has been disposed.');
    if (this.worker && !this.bootPromise) return;
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = this.bootAndRestore().catch(error => { this.stopWorker(); throw error; }).finally(() => { this.bootPromise = undefined; });
    return this.bootPromise;
  }

  private async bootAndRestore(): Promise<void> {
    const source = await (this.sourcePromise ??= this.readWorker().catch(error => { this.sourcePromise = undefined; throw error; }));
    const worker = this.workerFactory ? this.workerFactory(source) : this.createBlobWorker(source);
    this.worker = worker;
    worker.onmessage = event => this.receive(event.data as WorkerMessage);
    worker.onerror = event => this.crash(event.message || 'The HWP engine worker stopped unexpectedly.');
    worker.onmessageerror = () => this.crash('The HWP engine worker returned an unreadable message.');
    this.wasmPromise ??= this.readWasm().catch(error => { this.wasmPromise = undefined; throw error; });
    const wasm = await this.wasmPromise;
    const copy = Uint8Array.from(wasm);
    await this.send({ type: 'initialize', wasm: copy.buffer }, 'initialize WASM', false, [copy.buffer]);
    for (const record of this.engines.values()) await this.restoreRecord(record);
  }

  private createBlobWorker(source: string): Worker {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    this.workerUrl = url;
    return new Worker(url);
  }

  private async restoreRecord(record: RemoteRecord): Promise<void> {
    const bytes = record.blank ? undefined : Uint8Array.from(record.seed!).buffer;
    const create: RequestMessage = record.blank
      ? { type: 'create', handle: record.handle, kind: 'blank' }
      : { type: 'create', handle: record.handle, kind: 'parse', bytes: bytes! };
    await this.send(create, 'restore session', false, create.type === 'create' && create.kind === 'parse' ? [create.bytes] : [], true);
    const snapshots = new Map<number, number>();
    for (const operation of record.operations) {
      const args = [...operation.args];
      if ((operation.method === 'restore' || operation.method === 'discard') && typeof args[0] === 'number') {
        const mapped = snapshots.get(args[0]);
        if (mapped === undefined) throw new HwpHandsError('ENGINE_ERROR', 'A worker recovery snapshot could not be mapped.');
        args[0] = mapped;
      }
      const { result } = await this.send({ type: 'call', handle: record.handle, method: operation.method, args }, `recover ${operation.method}`, false, [], true);
      if (operation.method === 'snapshot' && typeof operation.result === 'number' && typeof result === 'number') snapshots.set(operation.result, result);
    }
  }

  private send(message: RequestMessage, method: string, cancelable: boolean, transfer: Transferable[] = [], replay = false): Promise<{ result: unknown; cancelled: boolean }> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const pending: Pending = { method, cancelable, startedAt: performance.now(), started: false, cancelRequested: false, resolve, reject };
      this.pending.set(id, pending);
      try {
        if (!this.worker) throw new HwpHandsError('ENGINE_ERROR', 'The HWP engine worker is not available.');
        this.worker.postMessage({ ...message, id }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (replay) pending.started = true;
    });
  }

  private receive(message: WorkerMessage): void {
    const request = this.pending.get(message.id);
    if (!request) { if (message.type === 'response' && message.ok) closeBitmaps(message.result); return; }
    if (message.type === 'progress') {
      request.started = true;
      this.notify(message.id, request, 'started');
      return;
    }
    this.pending.delete(message.id);
    const elapsedMs = performance.now() - request.startedAt;
    if (!message.ok) {
      this.notify(message.id, request, 'failed', elapsedMs);
      const code = ERROR_CODES.has(message.error.code as ErrorCode) ? message.error.code as ErrorCode : 'ENGINE_ERROR';
      request.reject(new HwpHandsError(code, message.error.message, message.error.details));
      return;
    }
    this.notify(message.id, request, request.cancelRequested ? 'cancelled' : 'completed', elapsedMs);
    request.resolve({ result: message.result, cancelled: request.cancelRequested });
  }

  private notify(requestId: number, request: Pending, phase: EngineProgress['phase'], elapsedMs?: number): void {
    try { this.onProgress({ requestId, method: request.method, phase, activeCount: this.pending.size, cancelable: request.cancelable, ...(elapsedMs === undefined ? {} : { elapsedMs }) }); }
    catch (error) { console.error('HWP Hands engine progress listener:', error); }
  }

  private crash(message: string): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    const pending = [...this.pending];
    this.pending.clear();
    for (const [id, request] of pending) {
      this.notify(id, request, 'failed', performance.now() - request.startedAt);
      request.reject(new HwpHandsError('ENGINE_ERROR', message));
    }
    worker.terminate();
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = undefined;
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    worker?.terminate();
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = undefined;
  }
}

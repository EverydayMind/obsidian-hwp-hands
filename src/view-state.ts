import { HwpHandsError } from './api';

export interface ViewContext { path: string; generation: number }

/**
 * Whether a document event should make a view re-read its file. A view that has begun closing or switching files must not: a read
 * on a path whose session was closed meanwhile reopens the document without a lease, and the fresh session then starts the whole
 * save-safety probe in the worker every document shares, delaying the next document the user opens.
 */
export function viewFollowsEvent(event: { type: string; state: { path: string } }, path: string, detaching: boolean): boolean {
  return !detaching && !!path && event.state.path === path && event.type !== 'opened' && event.type !== 'closed';
}

export function assertViewContext(context: ViewContext, currentPath: string, currentGeneration: number): void {
  if (context.path !== currentPath || context.generation !== currentGeneration) {
    throw new HwpHandsError('REVISION_CONFLICT', '작업을 시작한 문서가 바뀌어 결과를 적용하지 않았습니다.');
  }
}

export class ViewTaskGate {
  private pending?: Promise<void>;
  constructor(private readonly onChanged?: (busy: boolean) => void) {}
  get busy(): boolean { return this.pending !== undefined; }
  private notify(): void { try { this.onChanged?.(this.busy); } catch { /* Input observers cannot interrupt the operation. */ } }
  private track<T>(operation: Promise<T>): Promise<T> {
    let pending: Promise<void>;
    pending = operation.then(() => undefined, () => undefined).finally(() => {
      if (this.pending === pending) { this.pending = undefined; this.notify(); }
    });
    this.pending = pending;
    this.notify();
    return operation;
  }
  run<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.pending) return Promise.reject(new HwpHandsError('INVALID_ARGUMENT', '다른 화면 작업이 진행 중입니다.'));
    return this.track(Promise.resolve().then(action));
  }
  runImmediately<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.pending) return Promise.reject(new HwpHandsError('INVALID_ARGUMENT', 'Another view operation is in progress.'));
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
    const operation = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    const tracked = this.track(operation);
    try { resolve(action()); } catch (error) { reject(error); }
    return tracked;
  }
  runAfterCurrent<T>(action: () => Promise<T> | T): Promise<T> {
    return this.track(this.pending ? this.pending.then(action) : Promise.resolve().then(action));
  }
  wait(): Promise<void> { return this.pending ?? Promise.resolve(); }
}

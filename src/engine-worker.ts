import { HwpHandsError } from './api';
import { ENGINE_RPC_METHODS, type EngineRpcMethod } from './engine-port';
import { initializeEngine, RhwpEngine } from './engine';
import { closeBitmaps } from './canvas-page';
import { computeRewrite, type RewriteComputeRequest } from './agent/rewrite-compute';

type Request =
  | { id: number; type: 'initialize'; wasm: ArrayBuffer }
  | { id: number; type: 'create'; handle: number; kind: 'parse'; bytes: ArrayBuffer }
  | { id: number; type: 'create'; handle: number; kind: 'blank' }
  | { id: number; type: 'call'; handle: number; method: EngineRpcMethod; args: unknown[] }
  | { id: number; type: 'rewrite-compute'; request: RewriteComputeRequest };
type Response = { id: number; type: 'response'; ok: true; result?: unknown } | { id: number; type: 'response'; ok: false; error: { code: string; message: string; details?: unknown } };
type Progress = { id: number; type: 'progress'; method: string; phase: 'started' };
type Scope = {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: Response | Progress, transfer?: Transferable[]): void;
};
type Measurer = { measureTextWidth: (font: string, text: string) => number };

const scope = globalThis as unknown as Scope;
const engines = new Map<number, RhwpEngine>();
const allowedMethods = new Set<string>(ENGINE_RPC_METHODS);
let initialized = false;
let context: OffscreenCanvasRenderingContext2D | null = null;

(globalThis as typeof globalThis & Measurer).measureTextWidth = (font, text) => {
  context ??= new OffscreenCanvas(2, 2).getContext('2d');
  if (!context) throw new HwpHandsError('ENGINE_ERROR', 'Worker OffscreenCanvas 2D context is unavailable.');
  context.font = font;
  return context.measureText(text).width;
};

function transferables(value: unknown, output: Transferable[] = [], seen = new Set<object>()): Transferable[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) { output.push(value); return output; }
  if (value instanceof Uint8Array) { output.push(value.buffer as ArrayBuffer); return output; }
  if (value instanceof ArrayBuffer) { output.push(value); return output; }
  if (Array.isArray(value)) { for (const item of value) transferables(item, output, seen); return output; }
  for (const nested of Object.values(value)) transferables(nested, output, seen);
  return output;
}

function sendError(id: number, error: unknown): void {
  const known = error instanceof HwpHandsError ? error : undefined;
  const response: Response = {
    id, type: 'response', ok: false,
    error: {
      code: known?.code ?? 'ENGINE_ERROR', message: error instanceof Error ? error.message : String(error),
      ...(known?.details === undefined ? {} : { details: known.details }),
    },
  };
  try { scope.postMessage(response); }
  catch { scope.postMessage({ ...response, error: { code: response.error.code, message: response.error.message } }); }
}

scope.onmessage = event => { void handleMessage(event); };
async function handleMessage(event: MessageEvent<Request>): Promise<void> {
  const request = event.data;
  try {
    if (request.type === 'initialize') {
      if (!initialized) {
        await initializeEngine(async () => new Uint8Array(request.wasm));
        initialized = true;
      }
      scope.postMessage({ id: request.id, type: 'response', ok: true, result: true });
      return;
    }
    if (!initialized) throw new HwpHandsError('ENGINE_ERROR', 'The HWP engine worker has not been initialized.');
    if (request.type === 'rewrite-compute') {
      scope.postMessage({ id: request.id, type: 'response', ok: true, result: computeRewrite(request.request) });
      return;
    }
    if (request.type === 'create') {
      const engine = request.kind === 'parse' ? RhwpEngine.parse(new Uint8Array(request.bytes)) : RhwpEngine.blank();
      engines.set(request.handle, engine);
      scope.postMessage({ id: request.id, type: 'response', ok: true, result: request.handle });
      return;
    }
    const engine = engines.get(request.handle);
    if (!engine) throw new HwpHandsError('CLOSED', 'The HWP document worker session has been released.');
    if (!allowedMethods.has(request.method)) throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported worker engine method.');
    scope.postMessage({ id: request.id, type: 'progress', method: request.method, phase: 'started' });
    const method = (engine as unknown as Record<string, (...args: unknown[]) => unknown>)[request.method];
    if (typeof method !== 'function') throw new HwpHandsError('INVALID_ARGUMENT', 'The HWP engine method is unavailable.');
    const result = await method.apply(engine, request.args);
    if (request.method === 'free') engines.delete(request.handle);
    try { scope.postMessage({ id: request.id, type: 'response', ok: true, result }, transferables(result)); }
    catch (error) { closeBitmaps(result); throw error; }
  } catch (error) {
    sendError(request.id, error);
  }
}

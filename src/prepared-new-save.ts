import { HwpHandsError, type Format, type State } from './api';
import type { EnginePort, EngineProvider } from './engine-port';
import type { ActorContribution } from './edit-actors';
import type { ManagerOptions, Storage } from './manager';
import { makeIndex } from './markdown-index';
import { bytesHash, type PreparedSave, type PreparedSaveArtifact, type PreparedSavePermit, type PreparedSaveReceipt, type PreparedSaveRecord, type PreparedSaveSource, type PreparedSaveStore } from './prepared-save';
import { assertHwpSourceSafe, hwpSourceGuard } from './hwp-source-guard';
import { inspectSectionTails, type SectionTailsInspection } from './section-tails';

export interface NewSaveRequest {
  destination: string;
  source?: { path: string; sessionId: string; expectedRevision: number };
  template?: { path: string; sha256: string };
}
interface Source {
  value: PreparedSaveSource; engine: EnginePort; state: State; actors: ActorContribution[];
  current(): boolean; check(): Promise<void>;
}
interface Environment {
  storage: Storage; store: PreparedSaveStore; engines: EngineProvider; options: ManagerOptions;
  current(): boolean; source?: Source;
  export(engine: EnginePort, path: string, maxBytes: number, templateTails?: SectionTailsInspection): Promise<{ bytes: Uint8Array; warnings: string[] }>;
}
const conflict = (message: string): never => { throw new HwpHandsError('FILE_CONFLICT', message); };
const parents = (path: string): string[] => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
const needStorage = (storage: Storage) => {
  if (!storage.pathKind || !storage.createFolder || !storage.createPrepared) throw new HwpHandsError('INVALID_ARGUMENT', '준비된 새 경로 저장을 지원하지 않는 저장소입니다.');
};

/** Only reads the destination/template and fixes export bytes; it never creates a file, folder or session. */
export async function prepareNewSave(request: NewSaveRequest, env: Environment): Promise<PreparedSave> {
  const { storage, source, options } = env, destination = request.destination;
  needStorage(storage);
  const current = () => env.current() && (!source || source.current());
  const assertCurrent = () => { if (!current()) throw new HwpHandsError('REVISION_CONFLICT', '문서·입력·저장 옵션이 변경되었습니다. 다시 준비하세요.'); };
  const checkInputs = async () => {
    assertCurrent();
    if (source) await source.check();
    if (request.template && bytesHash(await storage.read(request.template.path)) !== request.template.sha256) conflict('템플릿이 변경되었습니다.');
    assertCurrent();
  };
  await checkInputs();
  if (await storage.pathKind!(destination) !== null) conflict('새 문서 경로가 이미 있습니다.');
  const writeSet: PreparedSave['writeSet'] = [], folders = parents(destination);
  for (const path of folders) {
    const kind = await storage.pathKind!(path);
    if (kind === 'file') conflict('부모 경로에 파일이 있습니다.');
    if (kind === null) writeSet.push({ kind: 'folder', path, op: 'create', role: 'folder', existedBefore: false });
  }
  if (writeSet.length > 62) throw new HwpHandsError('INVALID_PATH', '새 폴더가 너무 많습니다.');
  let engine = source?.engine, templateTails: SectionTailsInspection | undefined = undefined;
  try {
    if (!engine) {
      await env.engines.initialize();
      if (request.template) {
        const bytes = await storage.read(request.template.path);
        if (bytes.byteLength > options.maxFileBytes) throw new HwpHandsError('INVALID_ARGUMENT', '템플릿 크기 상한을 초과했습니다.');
        if (bytesHash(bytes) !== request.template.sha256) conflict('템플릿이 변경되었습니다.');
        assertHwpSourceSafe(hwpSourceGuard(request.template.path, bytes));
        if (/\.hwp$/i.test(request.template.path)) templateTails = inspectSectionTails(bytes);
        engine = await env.engines.parse(bytes);
      } else engine = await env.engines.blank();
    }
    const { bytes, warnings } = await env.export(engine, destination, options.maxFileBytes, templateTails);
    const outputHash = bytesHash(bytes), artifacts: PreparedSaveArtifact[] = [{ path: destination, before: null, after: bytes }];
    writeSet.push({ path: destination, role: 'primary', op: 'create', sha256Before: null, sha256Expected: outputHash, sizeBytes: bytes.byteLength });
    if (options.autoIndex) {
      if (!storage.readIndex) throw new HwpHandsError('INVALID_ARGUMENT', '인덱스 준비에는 readIndex가 필요합니다.');
      const path = `${destination}.index.md`;
      if (await storage.pathKind!(path) !== null) conflict('새 문서의 인덱스 경로가 이미 있습니다.');
      const tree = await engine.tree(), format = destination.toLowerCase().endsWith('.hwpx') ? 'hwpx' : 'hwp';
      const state: State = { path: destination, format, dirty: false, conflict: false, sessionId: 'prepared', revision: 0,
        pageCount: await engine.pages(), canUndo: false, canRedo: false };
      const after = Buffer.from(makeIndex(state, outputHash, tree.paragraphs, tree.tables, tree.fields, tree.stories), 'utf8');
      artifacts.push({ path, before: null, after });
      writeSet.push({ path, role: 'derived', op: 'create', sha256Before: null, sha256Expected: bytesHash(after), sizeBytes: after.byteLength });
    }
    await checkInputs();
    for (const entry of writeSet) if (await storage.pathKind!(entry.path) !== null) conflict('준비 중 새 경로가 생성되었습니다.');
    return env.store.add({ mode: source ? 'save_as' : 'create', ...(source ? { source: source.value } : {}),
      ...(request.template ? { template: request.template } : {}), destination, format: destination.toLowerCase().endsWith('.hwpx') ? 'hwpx' : 'hwp',
      saveOptions: options, writeSet, report: { pendingActors: source?.actors ?? [], warnings } }, artifacts, current);
  } finally { if (engine && !source) await engine.free(); }
}

/** The manager holds source/template/destination queues through the final readback and receipt observation. */
export async function executeNewSave(record: PreparedSaveRecord, permit: PreparedSavePermit, storage: Storage,
  checkSource: () => Promise<void>): Promise<PreparedSaveReceipt> {
  needStorage(storage);
  const prep = record.preparation, receipt = record.receipt!, made = new Set<string>();
  let attempted = false;
  const assertCurrent = () => {
    if (!permit?.signal || permit.signal.aborted || !record.current() || Date.parse(prep.expiresAt) <= Date.now() || Date.parse(record.ticket!.expiresAt) <= Date.now())
      throw new HwpHandsError('REVISION_CONFLICT', '저장 승인 상태나 문서·입력이 변경되었습니다. 다시 준비하세요.');
    permit.assertAuthorized();
  };
  const checkBefore = async () => {
    assertCurrent(); await checkSource();
    if (prep.template && bytesHash(await storage.read(prep.template.path)) !== prep.template.sha256) conflict('승인 후 템플릿이 변경되었습니다.');
    for (const entry of prep.writeSet) {
      const expected = made.has(entry.path) ? 'folder' : null;
      if (await storage.pathKind!(entry.path) !== expected) conflict('승인 후 새 경로가 변경되었습니다.');
    }
    for (const path of parents(prep.destination)) {
      if (!prep.writeSet.some(entry => entry.path === path) && await storage.pathKind!(path) !== 'folder') conflict('부모 폴더가 변경되었습니다.');
    }
    for (const item of record.artifacts) {
      const entry = prep.writeSet.find(entry => entry.kind !== 'folder' && entry.path === item.path);
      if (!entry || entry.kind === 'folder' || bytesHash(item.after) !== entry.sha256Expected) throw new HwpHandsError('VERIFY_FAILED', '고정한 바이트가 변경되었습니다.');
    }
    assertCurrent();
  };
  try {
    await checkBefore();
    await permit.persistCheckpoint({ preparation: structuredClone(prep), ticketId: record.ticket!.ticketId,
      artifacts: record.artifacts.map(item => ({ path: item.path, before: null, after: item.after.slice() })) });
    await checkBefore();
    for (const entry of prep.writeSet) if (entry.kind === 'folder') {
      await checkBefore(); assertCurrent(); attempted = true;
      await storage.createFolder!(entry.path); made.add(entry.path);
    }
    await checkBefore(); assertCurrent();
    const primary = record.artifacts[0]; attempted = true;
    let writeError: unknown;
    try { await storage.createPrepared!(primary.path, primary.after); } catch (error) { writeError = error; }
    const errorMessage = writeError instanceof Error ? writeError.message : typeof writeError === 'string' ? writeError : JSON.stringify(writeError);
    if (bytesHash(await storage.read(primary.path)) !== bytesHash(primary.after)) throw writeError instanceof Error ? writeError : new HwpHandsError('VERIFY_FAILED', errorMessage ?? '새 파일 저장 후 바이트가 다릅니다.');
    if (writeError) receipt.warnings.push(`생성 호출은 오류를 반환했지만 디스크 해시가 일치합니다: ${errorMessage}`);
    // Once binary creation has started, observe that write and retain later source input. No retry or actor approval.
    for (const item of record.artifacts.slice(1)) {
      if (await storage.pathKind!(item.path) !== null || bytesHash(await storage.read(primary.path)) !== bytesHash(primary.after)) conflict('인덱스 쓰기 전 원본이나 경로가 변경되었습니다.');
      await storage.writeIndex(item.path, Buffer.from(item.after).toString('utf8'), prep.destination);
      if (bytesHash(Buffer.from((await storage.readIndex!(item.path)) ?? '', 'utf8')) !== bytesHash(item.after)) throw new HwpHandsError('VERIFY_FAILED', '새 인덱스 readback이 다릅니다.');
    }
  } catch (error) {
    receipt.error = { code: error instanceof HwpHandsError ? error.code : 'VERIFY_FAILED', message: error instanceof Error ? error.message : String(error) };
  }
  for (const entry of prep.writeSet) {
    const result = receipt.entries.find(item => item.path === entry.path)!;
    try {
      const kind = await storage.pathKind!(entry.path);
      if (entry.kind === 'folder') result.state = kind === 'folder' ? 'written' : kind === null ? 'not_written' : 'unknown';
      else if (kind === null) result.state = 'not_written';
      else {
        const bytes = entry.role === 'primary' ? await storage.read(entry.path) : Buffer.from((await storage.readIndex!(entry.path)) ?? '', 'utf8');
        result.sha256After = bytesHash(bytes); result.state = result.sha256After === entry.sha256Expected ? 'written' : 'unknown';
      }
    } catch { result.state = attempted ? 'unknown' : 'not_written'; }
  }
  receipt.state = !attempted ? 'not_written' : receipt.entries.every(entry => entry.state === 'written') ? 'written'
    : receipt.entries.some(entry => entry.state === 'unknown') ? 'unknown' : receipt.entries.some(entry => entry.state === 'written') ? 'partial' : 'not_written';
  return receipt;
}

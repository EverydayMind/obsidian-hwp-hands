import { randomUUID } from 'node:crypto';

export interface InputDraftInput {
  path: string;
  target?: unknown;
  value: string;
  revision: number;
}

export interface InputDraftRecord extends InputDraftInput {
  version: 1;
  id: string;
  createdAt: string;
}

export interface InputDraftEntry {
  id: string;
  record?: InputDraftRecord;
  error?: string;
}

export interface InputDraftAdapter {
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const MAX_DRAFT_BYTES = 24 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const sizeOf = (value: string): number => new TextEncoder().encode(value).byteLength;

function parseDraft(value: unknown, fallbackId: string, fallbackCreatedAt: string): InputDraftRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('초안 JSON이 객체가 아닙니다.');
  const item = value as Record<string, unknown>;
  if (item.version !== undefined && item.version !== 1) throw new Error('지원하지 않는 초안 버전입니다.');
  if (typeof item.path !== 'string' || !item.path || item.path.length > 2048) throw new Error('원본 문서 경로가 올바르지 않습니다.');
  if (typeof item.value !== 'string' || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0) throw new Error('초안 내용 또는 revision이 올바르지 않습니다.');
  if (item.target !== undefined && (!item.target || typeof item.target !== 'object' || Array.isArray(item.target))) throw new Error('편집 대상 정보가 올바르지 않습니다.');
  const id = typeof item.id === 'string' ? item.id : fallbackId;
  if (!SAFE_ID.test(id)) throw new Error('초안 식별자가 올바르지 않습니다.');
  const createdAt = typeof item.createdAt === 'string' && !Number.isNaN(Date.parse(item.createdAt)) ? item.createdAt : fallbackCreatedAt;
  const record: InputDraftRecord = {
    version: 1, id, createdAt, path: item.path,
    ...(item.target === undefined ? {} : { target: item.target }), value: item.value, revision: Number(item.revision)
  };
  if (sizeOf(JSON.stringify(record)) > MAX_DRAFT_BYTES) throw new Error('초안이 허용된 크기를 초과합니다.');
  return record;
}

function fallbackTime(id: string): string {
  const timestamp = /^([0-9]{10,})-/.exec(id)?.[1];
  const milliseconds = timestamp ? Number(timestamp) : Number.NaN;
  return new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now()).toISOString();
}

export function inputDraftTargetLabel(target: unknown): string {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return '대상 정보 없음';
  const item = target as Record<string, unknown>;
  if (typeof item.name === 'string' && item.name) return `필드: ${item.name}`;
  const address = item.address && typeof item.address === 'object' ? item.address as Record<string, unknown> : undefined;
  if (address?.kind === 'headerFooter') return `${address.isHeader ? '머리말' : '꼬리말'}: ${Number(address.section) + 1}구역`;
  if (address?.kind === 'footnote' || address?.kind === 'endnote') return `${address.kind === 'footnote' ? '각주' : '미주'}: ${Number(address.section) + 1}구역`;
  if (address?.kind === 'body' && Number.isInteger(address.section) && Number.isInteger(address.paragraph)) {
    const prefix = Array.isArray(address.cellPath) ? '표/글상자 안 문단' : '본문 문단';
    return `${prefix}: ${Number(address.section) + 1}구역 ${Number(address.paragraph) + 1}번째`;
  }
  if (Number.isInteger(item.section) && Number.isInteger(item.paragraph)) {
    const prefix = Array.isArray(item.cellPath) ? '표 안 문단' : '본문 문단';
    return `${prefix}: ${Number(item.section) + 1}구역 ${Number(item.paragraph) + 1}번째`;
  }
  return '대상 정보 없음';
}

export function validateInputDraftCopyPath(input: string): string {
  if (typeof input !== 'string') throw new Error('Vault 상대 경로를 사용하세요.');
  const path = input.trim().replaceAll('\\', '/');
  const parts = path.split('/');
  if (!path || path.startsWith('/') || /[:\0\r\n]/.test(path) || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.obsidian' || part.toLowerCase() === '.trash') || !/\.txt$/i.test(path)) {
    throw new Error('Vault 안의 안전한 .txt 상대 경로를 입력하세요.');
  }
  return path;
}

export class InputDraftStore {
  constructor(
    private readonly adapter: InputDraftAdapter,
    private readonly directory: string,
    private readonly atomicRename: (source: string, destination: string) => Promise<void>
  ) {}

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('초안 식별자가 올바르지 않습니다.');
    return `${this.directory}/${id}.json`;
  }

  async save(input: InputDraftInput, existingId?: string): Promise<string> {
    const id = existingId ?? `${Date.now()}-${randomUUID()}`;
    if (!SAFE_ID.test(id)) throw new Error('초안 식별자가 올바르지 않습니다.');
    if (!await this.adapter.exists(this.directory)) await this.adapter.mkdir(this.directory);
    const filename = this.file(id), temporary = `${filename}.tmp-${randomUUID()}`;
    let createdAt = new Date().toISOString();
    if (existingId && await this.adapter.exists(filename)) {
      try { createdAt = parseDraft(JSON.parse(await this.adapter.read(filename)), id, fallbackTime(id)).createdAt; }
      catch { /* Replace an unreadable autosave with the current in-memory draft. */ }
    }
    const record = parseDraft({ ...input, version: 1, id, createdAt }, id, createdAt);
    const json = JSON.stringify(record);
    if (sizeOf(json) > MAX_DRAFT_BYTES) throw new Error('초안이 허용된 크기를 초과합니다.');
    try {
      await this.adapter.write(temporary, json);
      await this.atomicRename(temporary, filename);
    } catch (error) {
      try { if (await this.adapter.exists(temporary)) await this.adapter.remove(temporary); } catch { /* Keep the previous complete draft. */ }
      throw error;
    }
    return id;
  }

  async list(): Promise<InputDraftEntry[]> {
    if (!await this.adapter.exists(this.directory)) return [];
    const { files } = await this.adapter.list(this.directory);
    const entries: InputDraftEntry[] = [];
    for (const file of files) {
      const prefix = `${this.directory}/`;
      if (!file.startsWith(prefix) || file.slice(prefix.length).includes('/') || !file.toLowerCase().endsWith('.json')) continue;
      const id = file.slice(prefix.length, -5);
      if (!SAFE_ID.test(id)) continue;
      try {
        const json = await this.adapter.read(file);
        if (sizeOf(json) > MAX_DRAFT_BYTES) throw new Error('초안 파일이 허용된 크기를 초과합니다.');
        entries.push({ id, record: parseDraft(JSON.parse(json), id, fallbackTime(id)) });
      } catch (error) {
        entries.push({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return entries.sort((a, b) => (b.record?.createdAt ?? '').localeCompare(a.record?.createdAt ?? '') || a.id.localeCompare(b.id));
  }

  async read(id: string): Promise<InputDraftRecord> {
    const filename = this.file(id);
    const json = await this.adapter.read(filename);
    if (sizeOf(json) > MAX_DRAFT_BYTES) throw new Error('초안 파일이 허용된 크기를 초과합니다.');
    return parseDraft(JSON.parse(json), id, fallbackTime(id));
  }

  async remove(id: string): Promise<void> {
    const filename = this.file(id);
    if (await this.adapter.exists(filename)) await this.adapter.remove(filename);
  }
}

export class InputDraftAutosave {
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  private currentId?: string;
  private initialWriteQueued = false;
  constructor(private readonly save: (draft: InputDraftInput, existingId?: string) => Promise<string>, private readonly delayMs = 250, private readonly onError: (error: unknown) => void = () => undefined) {}
  get id(): string | undefined { return this.currentId; }

  schedule(snapshot: InputDraftInput): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.currentId && !this.initialWriteQueued) {
      this.initialWriteQueued = true;
      void this.enqueue(snapshot).catch(this.onError);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(snapshot).catch(this.onError);
    }, this.delayMs);
  }

  private enqueue(snapshot: InputDraftInput): Promise<void> {
    const work = this.tail.then(async () => {
      try { this.currentId = await this.save(snapshot, this.currentId); }
      catch (error) { if (!this.currentId) this.initialWriteQueued = false; throw error; }
    });
    this.tail = work.catch(() => undefined);
    return work;
  }

  async flush(snapshot: InputDraftInput): Promise<string> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tail;
    if (!this.currentId) this.initialWriteQueued = true;
    await this.enqueue(snapshot);
    if (!this.currentId) throw new Error('초안 복구본을 저장하지 못했습니다.');
    return this.currentId;
  }

  async discard(remove: (id: string) => Promise<void>): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tail;
    if (this.currentId) await remove(this.currentId);
    this.currentId = undefined;
    this.initialWriteQueued = false;
  }

  async detach(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tail;
    this.currentId = undefined;
    this.initialWriteQueued = false;
  }

  async drain(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tail;
  }
}

export async function flushInputDraftOnLeave(
  autosave: InputDraftAutosave,
  snapshot: InputDraftInput,
  apply: () => Promise<void>
): Promise<{ status: 'applied' } | { status: 'retained'; id: string; error: unknown }> {
  await autosave.flush(snapshot);
  try {
    await apply();
    return { status: 'applied' };
  } catch (error) {
    const id = await autosave.flush(snapshot);
    return { status: 'retained', id, error };
  }
}

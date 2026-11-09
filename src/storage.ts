import { FileSystemAdapter, TFile, TFolder, type Vault } from 'obsidian';
import { createHash, randomUUID } from 'node:crypto';
import { open, readdir, rename, stat } from 'node:fs/promises';
import type { CleanupCandidate, CleanupPlan, Recovery, RecoveryV3, Storage } from './manager';
import { HwpHandsError } from './api';
import { inspectIndex, rebaseIndex } from './markdown-index';
import { decodeRecoveryV3, encodeRecoveryV3, type RecoveryV3Line } from './recovery-journal';

export const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => Uint8Array.from(bytes).buffer;
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
/** Backups kept per document; a verified save drops older ones (decision 69). */
export const KEEP_BACKUPS_PER_SOURCE = 3;
const TEMPORARY_RETENTION_MS = 24 * 60 * 60 * 1000;
const BACKUP_NAME = /^.+-([a-f0-9]{32})-([0-9]{13})-([a-f0-9]{8})\.bak$/i;
const TEMP_UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

interface ManagedEntry { path: string; name: string; bytes: number; modifiedAt: number }

export class VaultStorage implements Storage {
  constructor(private readonly vault: Vault, private readonly pluginDirectory: string) {}
  private file(path: string): TFile {
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new HwpHandsError('NOT_FOUND', `파일을 찾을 수 없습니다: ${path}`);
    return file;
  }
  async read(path: string): Promise<Uint8Array> { return new Uint8Array(await this.vault.readBinary(this.file(path))); }
  async readBounded(path: string, maxBytes: number): Promise<Uint8Array> {
    const file = this.file(path), adapter = this.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter) || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new HwpHandsError('VERIFY_FAILED', 'Bounded document reading is unavailable.');
    const handle = await open(adapter.getFullPath(file.path), 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > maxBytes) throw new HwpHandsError('FILE_CONFLICT', 'The output file exceeds the read limit.');
      const buffer = Buffer.allocUnsafe(info.size + 1); let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > info.size) throw new HwpHandsError('FILE_CONFLICT', 'The output file grew during reading.');
      return new Uint8Array(buffer.buffer, buffer.byteOffset, offset);
    } finally { await handle.close(); }
  }
  async write(path: string, bytes: Uint8Array): Promise<void> { await this.vault.modifyBinary(this.file(path), arrayBuffer(bytes)); }
  async pathKind(path: string): Promise<'file' | 'folder' | null> {
    const value = await this.vault.adapter.stat(path);
    return value === null ? null : value.type;
  }
  async createFolder(path: string): Promise<void> {
    if (await this.pathKind(path) !== null) throw new HwpHandsError('FILE_CONFLICT', `경로가 이미 있습니다: ${path}`);
    await this.vault.createFolder(path);
  }
  async createPrepared(path: string, bytes: Uint8Array): Promise<void> {
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent && !(this.vault.getAbstractFileByPath(parent) instanceof TFolder)) throw new HwpHandsError('FILE_CONFLICT', '승인한 부모 폴더가 없습니다.');
    if (await this.pathKind(path) !== null) throw new HwpHandsError('FILE_CONFLICT', `경로가 이미 있습니다: ${path}`);
    await this.vault.createBinary(path, arrayBuffer(bytes));
  }
  async create(path: string, bytes: Uint8Array): Promise<void> {
    if (await this.vault.adapter.exists(path)) throw new HwpHandsError('FILE_CONFLICT', `파일이 이미 있습니다: ${path}`);
    const parts = path.split('/'); parts.pop(); let folder = '';
    for (const part of parts) {
      folder = folder ? `${folder}/${part}` : part;
      if (!await this.vault.adapter.exists(folder)) await this.vault.createFolder(folder);
    }
    await this.vault.createBinary(path, arrayBuffer(bytes));
  }
  async backup(path: string, bytes: Uint8Array): Promise<string> {
    const folder = `${this.pluginDirectory}/backups`;
    if (!await this.vault.adapter.exists(folder)) await this.vault.adapter.mkdir(folder);
    const name = path.split('/').at(-1)!.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
    const sourceKey = createHash('sha256').update(path).digest('hex').slice(0, 32);
    const destination = `${folder}/${name}-${sourceKey}-${Date.now()}-${randomUUID().slice(0, 8)}.bak`;
    try {
      await this.vault.adapter.writeBinary(destination, arrayBuffer(bytes));
      const backup = new Uint8Array(await this.vault.adapter.readBinary(destination));
      if (!sameBytes(bytes, backup)) throw new HwpHandsError('VERIFY_FAILED', `원본 백업을 다시 읽은 내용이 다릅니다: ${destination}`);
      return destination;
    } catch (error) {
      try { if (await this.vault.adapter.exists(destination)) await this.vault.adapter.remove(destination); }
      catch (cleanupError) { throw new HwpHandsError('VERIFY_FAILED', '백업 파일 검증에 실패했고 불완전한 백업을 정리하지 못했습니다.', { destination, error: String(error), cleanupError: String(cleanupError) }); }
      throw error;
    }
  }
  /** Removes this document's managed backups beyond the newest KEEP_BACKUPS_PER_SOURCE. Legacy and other documents' files stay. */
  async pruneBackups(path: string): Promise<string[]> {
    const sourceKey = createHash('sha256').update(path).digest('hex').slice(0, 32);
    const entries = (await this.managedEntries(`${this.pluginDirectory}/backups`)).flatMap(entry => {
      const match = BACKUP_NAME.exec(entry.name);
      return match && match[1].toLowerCase() === sourceKey ? [{ entry, timestamp: Number(match[2]) }] : [];
    });
    entries.sort((left, right) => right.timestamp - left.timestamp || right.entry.name.localeCompare(left.entry.name));
    const removed: string[] = [];
    for (const { entry } of entries.slice(KEEP_BACKUPS_PER_SOURCE)) {
      if (await this.vault.adapter.exists(entry.path)) { await this.vault.adapter.remove(entry.path); removed.push(entry.path); }
    }
    return removed;
  }
  async writeIndex(path: string, content: string, source: string): Promise<void> {
    const generated = inspectIndex(content);
    if (generated.state !== 'managed' || generated.source !== source || createHash('sha256').update(await this.read(source)).digest('hex') !== generated.sourceSha256) {
      throw new HwpHandsError('FILE_CONFLICT', `원본이 인덱스 생성 이후 변경되었습니다: ${source}`);
    }
    if (await this.vault.adapter.exists(path)) {
      const existing = await this.vault.adapter.read(path);
      const inspection = inspectIndex(existing);
      if (inspection.state !== 'managed' || inspection.source !== source) throw new HwpHandsError('FILE_CONFLICT', `사용자 편집 또는 관리되지 않는 인덱스를 덮어쓸 수 없습니다: ${path}`);
      if (await this.vault.adapter.read(path) !== existing) throw new HwpHandsError('FILE_CONFLICT', `인덱스 파일이 갱신 중 변경되었습니다: ${path}`);
      if (existing === content) return;
      await this.vault.modify(this.file(path), content);
    } else { await this.vault.create(path, content); }
  }
  async readIndex(path: string): Promise<string | undefined> {
    return await this.vault.adapter.exists(path) ? this.vault.adapter.read(path) : undefined;
  }
  async removeManagedIndex(path: string, source: string): Promise<boolean> {
    const existing = await this.readIndex(path);
    if (existing === undefined) return false;
    const inspection = inspectIndex(existing);
    if (inspection.state !== 'managed' || inspection.source !== source) return false;
    if (await this.readIndex(path) !== existing) return false;
    try { await this.vault.delete(this.file(path)); }
    catch (error) {
      // Another actor (a host rollback, the user) removed it after the checks: nothing is left to delete.
      if (!(await this.vault.adapter.exists(path))) return false;
      throw error;
    }
    return true;
  }
  async moveManagedIndex(oldPath: string, newPath: string, oldSource: string, newSource: string, sourceHash: string): Promise<boolean> {
    if (createHash('sha256').update(await this.read(newSource)).digest('hex') !== sourceHash) return false;
    const target = await this.readIndex(newPath);
    if (target !== undefined) {
      const inspection = inspectIndex(target);
      if (inspection.state !== 'managed') return false;
      if (inspection.source === newSource && inspection.sourceSha256 === sourceHash) {
        if (oldPath !== newPath) await this.removeManagedIndex(oldPath, oldSource);
        return true;
      }
      if (inspection.source !== oldSource || inspection.sourceSha256 !== sourceHash) return false;
      const rebased = rebaseIndex(target, newSource);
      if (!rebased || await this.readIndex(newPath) !== target) return false;
      await this.vault.modify(this.file(newPath), rebased);
      if (oldPath !== newPath) await this.removeManagedIndex(oldPath, oldSource);
      return true;
    }

    const existing = await this.readIndex(oldPath);
    if (existing === undefined) return false;
    const inspection = inspectIndex(existing);
    if (inspection.state !== 'managed' || inspection.source !== oldSource || inspection.sourceSha256 !== sourceHash) return false;
    const rebased = rebaseIndex(existing, newSource);
    if (!rebased) return false;
    await this.writeIndex(newPath, rebased, newSource);
    await this.removeManagedIndex(oldPath, oldSource);
    return true;
  }
  private recoveryPath(path: string): string { return `${this.pluginDirectory}/recovery/${createHash('sha256').update(path).digest('hex')}.json`; }
  async readRecovery(path: string, maxBytes = 100 * 1024 * 1024): Promise<Recovery | undefined> {
    const filename = this.recoveryPath(path);
    if (!await this.vault.adapter.exists(filename)) return undefined;
    const details = await this.vault.adapter.stat(filename);
    if (details && details.size > maxBytes) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 파일이 읽기 제한을 초과합니다. 기존 기록은 보존했습니다.');
    const content = await this.vault.adapter.read(filename);
    if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new HwpHandsError('VERIFY_FAILED', '복구 기록 파일이 읽기 제한을 초과합니다. 기존 기록은 보존했습니다.');
    try {
      const firstLine = content.split('\n', 1)[0];
      const header = JSON.parse(firstLine) as { version?: unknown };
      if (header?.version === 3) return decodeRecoveryV3(content, maxBytes) as unknown as RecoveryV3;
      return JSON.parse(content) as Recovery;
    } catch (error) { throw new HwpHandsError('VERIFY_FAILED', '복구 기록 JSON 또는 hash chain을 읽을 수 없습니다. 기존 기록은 보존했습니다.', String(error)); }
  }
  async recoveryRecords(maxBytes: number): Promise<Recovery[]> {
    const records: Recovery[] = [];
    for (const entry of await this.managedEntries(`${this.pluginDirectory}/recovery`)) {
      if (!/^[a-f0-9]{64}\.json$/i.test(entry.name) || entry.bytes > maxBytes) continue;
      try {
        const content = await this.vault.adapter.read(entry.path), header = JSON.parse(content.split('\n', 1)[0]) as { version?: unknown };
        records.push(header?.version === 3 ? decodeRecoveryV3(content, maxBytes) as unknown as RecoveryV3 : JSON.parse(content) as Recovery);
      } catch { /* A record that cannot be read is reported when its document is opened. */ }
    }
    return records;
  }
  async writeRecovery(path: string, recovery: Recovery): Promise<void> {
    const folder = `${this.pluginDirectory}/recovery`;
    if (!await this.vault.adapter.exists(folder)) await this.vault.adapter.mkdir(folder);
    const filename = this.recoveryPath(path), temporary = `${filename}.tmp-${randomUUID()}`;
    // Rename the complete journal so a partial write cannot replace the last usable recovery.
    if (!(this.vault.adapter instanceof FileSystemAdapter)) throw new HwpHandsError('INVALID_ARGUMENT', '복구 기록은 데스크톱 파일 시스템을 필요로 합니다.');
    const serialized = recovery.version === 3 ? encodeRecoveryV3(recovery) : JSON.stringify(recovery);
    await this.vault.adapter.write(temporary, serialized);
    try { await rename(this.vault.adapter.getFullPath(temporary), this.vault.adapter.getFullPath(filename)); }
    catch (error) { if (await this.vault.adapter.exists(temporary)) await this.vault.adapter.remove(temporary); throw error; }
  }
  async appendRecovery(path: string, line: RecoveryV3Line, maxBytes: number): Promise<void> {
    if (!(this.vault.adapter instanceof FileSystemAdapter)) throw new HwpHandsError('INVALID_ARGUMENT', '복구 저널 append는 데스크톱 파일 시스템을 필요로 합니다.');
    const filename = this.recoveryPath(path);
    if (!await this.vault.adapter.exists(filename)) throw new HwpHandsError('VERIFY_FAILED', '복구 저널 append 대상이 없습니다. 기존 기록을 보존하고 다음 편집에서 체크포인트를 다시 만드세요.');
    const absolutePath = this.vault.adapter.getFullPath(filename);
    const lineBytes = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8');
    const details = await stat(absolutePath);
    if (details.size + lineBytes.byteLength > maxBytes) throw new HwpHandsError('INVALID_ARGUMENT', '복구 저널 크기가 설정 제한을 초과합니다. 저장하거나 더 작은 단위로 편집하세요.');
    const handle = await open(absolutePath, 'a');
    try {
      await handle.writeFile(lineBytes);
      await handle.sync();
    } catch (error) {
      try { await handle.truncate(details.size); await handle.sync(); }
      catch (rollbackError) { throw new HwpHandsError('VERIFY_FAILED', '복구 저널 append 실패 뒤 미완성 꼬리를 정리하지 못했습니다. 기존 기록을 보존하세요.', { appendError: String(error), rollbackError: String(rollbackError) }); }
      throw error;
    }
    finally { await handle.close(); }
  }
  async removeRecovery(path: string): Promise<void> {
    const filename = this.recoveryPath(path);
    if (await this.vault.adapter.exists(filename)) await this.vault.adapter.remove(filename);
  }

  private async managedEntries(folder: string): Promise<ManagedEntry[]> {
    const adapter = this.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter) || !await adapter.exists(folder)) return [];
    const root = adapter.getFullPath(folder), result: ManagedEntry[] = [];
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const path = `${folder}/${item.name}`;
      const details = await stat(adapter.getFullPath(path));
      result.push({ path, name: item.name, bytes: details.size, modifiedAt: details.mtimeMs });
    }
    return result;
  }

  async cleanupPlan(now = Date.now()): Promise<CleanupPlan> {
    const backupFolder = `${this.pluginDirectory}/backups`;
    const backups = await this.managedEntries(backupFolder);
    const groups = new Map<string, Array<{ entry: ManagedEntry; timestamp: number }>>();
    let legacyBackups = 0;
    for (const entry of backups) {
      const match = BACKUP_NAME.exec(entry.name);
      if (!match) { legacyBackups++; continue; }
      const group = groups.get(match[1]) ?? [];
      group.push({ entry, timestamp: Number(match[2]) }); groups.set(match[1], group);
    }
    const candidates: CleanupCandidate[] = [];
    for (const entries of groups.values()) {
      entries.sort((left, right) => right.timestamp - left.timestamp || right.entry.name.localeCompare(left.entry.name));
      for (const { entry } of entries.slice(KEEP_BACKUPS_PER_SOURCE)) {
        candidates.push({ path: entry.path, kind: 'backup', bytes: entry.bytes, modifiedAt: entry.modifiedAt, reason: `문서별 최신 ${KEEP_BACKUPS_PER_SOURCE}개 이후 백업` });
      }
    }
    const recoveryFolder = `${this.pluginDirectory}/recovery`, draftFolder = `${this.pluginDirectory}/input-drafts`;
    const [recovery, drafts] = await Promise.all([this.managedEntries(recoveryFolder), this.managedEntries(draftFolder)]);
    let temporaryFiles = 0;
    for (const entry of [...recovery, ...drafts]) {
      const isRecoveryTemp = entry.path.startsWith(`${recoveryFolder}/`) && new RegExp(`^[a-f0-9]{64}\\.json\\.tmp-${TEMP_UUID}$`, 'i').test(entry.name);
      const isDraftTemp = entry.path.startsWith(`${draftFolder}/`) && new RegExp(`^[A-Za-z0-9._-]{1,128}\\.json\\.tmp-${TEMP_UUID}$`).test(entry.name);
      if (isRecoveryTemp || isDraftTemp) {
        temporaryFiles++;
        if (entry.modifiedAt < now - TEMPORARY_RETENTION_MS) candidates.push({ path: entry.path, kind: 'temporary', bytes: entry.bytes, modifiedAt: entry.modifiedAt, reason: '24시간 이상 된 미완성 임시 파일' });
      }
    }
    return {
      candidates: candidates.sort((a, b) => a.path.localeCompare(b.path)),
      managedBackups: backups.length - legacyBackups,
      retainedBackups: backups.length - legacyBackups - candidates.filter(item => item.kind === 'backup').length,
      legacyBackups,
      recoveryRecords: recovery.filter(entry => entry.name.endsWith('.json') && !entry.name.includes('.tmp-')).length,
      inputDrafts: drafts.filter(entry => entry.name.endsWith('.json') && !entry.name.includes('.tmp-')).length,
      temporaryFiles
    };
  }

  async cleanupManagedFiles(paths: string[], now = Date.now()): Promise<string[]> {
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new HwpHandsError('INVALID_ARGUMENT', '정리할 플러그인 파일 경로가 올바르지 않습니다.');
    const allowed = new Set((await this.cleanupPlan(now)).candidates.map(candidate => candidate.path));
    const removed: string[] = [];
    for (const path of [...new Set(paths)]) {
      if (!allowed.has(path)) continue;
      if (await this.vault.adapter.exists(path)) { await this.vault.adapter.remove(path); removed.push(path); }
    }
    return removed;
  }
}

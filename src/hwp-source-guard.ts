import * as CFB from 'cfb';
import { inflateRawSync } from 'node:zlib';
import { HwpHandsError } from './api';
import { hwpxMemoCountOf } from './tab-widths';

/** This engine cannot retain Hancom HWP memo bodies. Never treat an unreadable section as memo-free. */
export type HwpSourceGuard = 'clear' | 'memo' | 'tracked' | 'unknown';

const MAX_SECTION_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const HWP_MAGIC = Buffer.from('HWP Document File', 'ascii');

export function inspectHwpSource(bytes: Uint8Array): HwpSourceGuard {
  try {
    const container = CFB.read(Buffer.from(bytes), { type: 'buffer' });
    const entries = container.FullPaths.map((path, index) => ({ path, entry: container.FileIndex[index] }));
    const root = entries.filter(({ path }) => /^[^/]+\/FileHeader$/i.test(path));
    if (root.length !== 1 || !root[0].entry || root[0].entry.type !== 2) return 'unknown';
    const header = Buffer.from(root[0].entry.content);
    if (header.length < 40 || !header.subarray(0, HWP_MAGIC.length).equals(HWP_MAGIC)) return 'unknown';
    const flags = header.readUInt32LE(36);
    if (flags & 6) return 'unknown'; // encrypted or distribution sections cannot be inspected
    if ((flags & 0x4000) || entries.some(({ path, entry }) => /^[^/]+\/ViewText\/Section\d+$/i.test(path) && entry?.type === 2)) return 'tracked';
    const sections = entries.filter(({ path }) => /^[^/]+\/BodyText\/Section\d+$/i.test(path));
    const names = sections.map(({ path }) => Number(path.match(/Section(\d+)$/i)![1]));
    if (!sections.length || new Set(names).size !== sections.length || names.some(n => !Number.isSafeInteger(n) || n >= sections.length)) return 'unknown';
    let total = 0;
    for (const { entry } of sections) {
      if (!entry || entry.type !== 2 || !entry.content || entry.size !== entry.content.length) return 'unknown';
      const data = flags & 1 ? inflateRawSync(Buffer.from(entry.content), { maxOutputLength: MAX_SECTION_BYTES }) : Buffer.from(entry.content);
      total += data.length;
      if (data.length > MAX_SECTION_BYTES || total > MAX_TOTAL_BYTES) return 'unknown';
      let offset = 0;
      while (offset < data.length) {
        if (offset + 4 > data.length) return 'unknown';
        const word = data.readUInt32LE(offset); offset += 4;
        const tag = word & 0x3ff;
        let size = word >>> 20;
        if (size === 0xfff) {
          if (offset + 4 > data.length) return 'unknown';
          size = data.readUInt32LE(offset); offset += 4;
        }
        if (size > data.length - offset) return 'unknown';
        if (tag === 93) return 'memo';
        offset += size;
      }
    }
    return 'clear';
  } catch { return 'unknown'; }
}

export function assertHwpSourceSafe(status: HwpSourceGuard): void {
  if (status === 'memo') throw new HwpHandsError('CONTENT_LOSS', '원본 문서에 메모가 있어 저장하거나 형식을 바꾸면 메모 본문이 유실될 수 있습니다. 원본과 복구 기록을 보존했으며 저장을 차단했습니다.');
  if (status === 'tracked') throw new HwpHandsError('CONTENT_LOSS', '변경 추적 HWP는 삭제된 글을 현재 본문으로 읽거나 변경 기록을 유실할 수 있어 처리를 차단했습니다. 원본과 복구 기록은 보존됩니다.');
  if (status === 'unknown') throw new HwpHandsError('VERIFY_FAILED', '원본 문서의 메모 보존 여부를 확인할 수 없어 저장을 차단했습니다. 원본과 복구 기록은 보존됩니다.');
}

export function hwpSourceGuard(path: string, bytes: Uint8Array, recoverySeed?: Uint8Array): HwpSourceGuard {
  const inspect = /\.hwp$/i.test(path) ? inspectHwpSource : /\.hwpx$/i.test(path) ? (file: Uint8Array): HwpSourceGuard => {
    const count = hwpxMemoCountOf(file);
    return count === null ? 'unknown' : count > 0 ? 'memo' : 'clear';
  } : undefined;
  if (!inspect) return 'clear';
  const source = inspect(bytes);
  if (!recoverySeed || recoverySeed === bytes || source === 'tracked') return source;
  const recovery = inspect(recoverySeed);
  return recovery === 'tracked' ? 'tracked' : source === 'memo' || recovery === 'memo' ? 'memo'
    : source === 'unknown' || recovery === 'unknown' ? 'unknown' : 'clear';
}

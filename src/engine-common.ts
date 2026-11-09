import { HwpHandsError } from './api';

export const ENGINE_VERSION = '0.8.7-hwp-editor.10';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function imageBase64ByteLength(value: unknown): number {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.length % 4 !== 0) {
    throw new HwpHandsError('INVALID_ARGUMENT', 'imageBase64 must be canonical base64 for an image no larger than 10 MiB.');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const byteLength = value.length / 4 * 3 - padding;
  if (!byteLength || byteLength > MAX_IMAGE_BYTES) throw new HwpHandsError('INVALID_ARGUMENT', 'imageBase64 must encode an image from 1 byte through 10 MiB.');
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index++) {
    const code = value.charCodeAt(index);
    if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47)) {
      throw new HwpHandsError('INVALID_ARGUMENT', 'imageBase64 contains invalid characters or padding.');
    }
  }
  return byteLength;
}

export function integer(value: number, label: string, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new HwpHandsError('INVALID_ARGUMENT', `${label} 범위가 올바르지 않습니다: ${value}`);
}

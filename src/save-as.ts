import { L } from './i18n/locale';
export type HwpDocumentFormat = 'hwp' | 'hwpx';

/** Adds or aligns a copy's extension with the explicitly selected export format. */
export function saveAsDestination(input: string, format: HwpDocumentFormat): string {
  const path = input.trim().replaceAll('\\', '/');
  if (!path) throw new Error(L({ ko: '저장할 Vault 경로를 입력하세요.', en: "Enter the Vault path to save." }));
  const slash = path.lastIndexOf('/');
  const basename = path.slice(slash + 1);
  if (!basename) throw new Error(L({ ko: '파일 이름을 입력하세요.', en: "Enter a file name." }));
  const dot = basename.lastIndexOf('.');
  if (dot < 0) return `${path}.${format}`;
  const extension = basename.slice(dot + 1);
  if (!/^(hwp|hwpx)$/i.test(extension)) throw new Error(L({ ko: '사본 형식은 HWP 또는 HWPX를 선택하세요.', en: "Select HWP or HWPX for the copy format." }));
  return `${path.slice(0, slash + 1)}${basename.slice(0, dot)}.${format}`;
}

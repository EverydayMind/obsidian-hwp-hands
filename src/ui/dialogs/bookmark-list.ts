import { LT, L } from '../../i18n/locale';
// Pure helpers for the bookmark dialogs (no `obsidian` import so they are unit-testable).
import type { Bookmark } from '../../api';

export const MAX_BOOKMARK_NAME_LENGTH = 250;
export type BookmarkSort = 'name' | 'position';

/** Mirrors the engine's name rules so the dialog can explain a rejection before sending the command. */
export function validateBookmarkName(value: string, existing: readonly string[], current?: string): string | undefined {
  const name = value.trim();
  if (!name) return L({ ko: '책갈피 이름을 입력하세요.', en: "Enter a bookmark name." });
  if (name.length > MAX_BOOKMARK_NAME_LENGTH) return LT({ ko: () => `책갈피 이름은 ${MAX_BOOKMARK_NAME_LENGTH}자를 넘을 수 없습니다.`, en: () => `Bookmark names cannot exceed ${MAX_BOOKMARK_NAME_LENGTH} characters.` });
  // eslint-disable-next-line no-control-regex -- Bookmark names must reject HWP control characters.
  if (/[\u0000-\u001f\u007f]/.test(name)) return L({ ko: '책갈피 이름에는 제어 문자를 쓸 수 없습니다.', en: "Bookmark names cannot contain control characters." });
  if (current !== undefined && name === current) return L({ ko: '현재 이름과 같습니다.', en: "Same as the current name." });
  if (existing.includes(name)) return LT({ ko: () => `"${name}" 책갈피가 이미 있습니다.`, en: () => `Bookmark "${name}" already exists.` });
  return undefined;
}

/** The smallest unused `책갈피N` name. */
export function suggestBookmarkName(existing: readonly string[]): string {
  const used = new Set(existing);
  for (let index = 1; ; index++) if (!used.has(LT({ ko: () => `책갈피${index}`, en: () => `Bookmark${index}` }))) return LT({ ko: () => `책갈피${index}`, en: () => `Bookmark${index}` });
}

export function sortBookmarks(bookmarks: readonly Bookmark[], mode: BookmarkSort): Bookmark[] {
  const collator = new Intl.Collator('ko');
  const byName = (left: Bookmark, right: Bookmark): number => collator.compare(left.name, right.name);
  return [...bookmarks].sort(mode === 'name' ? byName
    : (left, right) => left.address.section - right.address.section || left.address.paragraph - right.address.paragraph || left.offset - right.offset || byName(left, right));
}

export function bookmarkPositionLabel(bookmark: Bookmark): string {
  return LT({ ko: () => `구역 ${bookmark.address.section + 1} · 문단 ${bookmark.address.paragraph + 1} · 위치 ${bookmark.offset}`, en: () => `Section ${bookmark.address.section + 1} · paragraph ${bookmark.address.paragraph + 1} · offset ${bookmark.offset}` });
}

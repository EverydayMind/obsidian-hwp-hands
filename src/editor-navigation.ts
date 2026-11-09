import type { Field, FormattingModel, Paragraph } from './api';

export interface BrowseEntry<T> { value: T; label: string; filterText: string }

/** Computes a same-paragraph optimistic caret step using the editor's code-point offsets. */
export function optimisticHorizontalCaretOffset(text: string, offset: number, motion: 'left' | 'right'): number | undefined {
  const length = Array.from(text).length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) return undefined;
  const next = offset + (motion === 'left' ? -1 : 1);
  return next >= 0 && next <= length && next !== offset ? next : undefined;
}

export function fieldBrowseEntries(fields: Field[]): BrowseEntry<Field>[] {
  return fields.filter((field): field is Field & { address: NonNullable<Field['address']> } => !!field.address).map(field => {
    const label = `필드 · ${field.name || '(이름 없음)'} · ${field.value || '(빈 값)'}`;
    return { value: field, label, filterText: `${label} ${field.fieldId} ${field.address.section + 1}구역 ${field.address.paragraph + 1}문단` };
  });
}

/** Returns a bounded slice for search/filter driven navigation lists. */
export function browsePage<T>(entries: BrowseEntry<T>[], query: string, page: number, pageSize = 20): { items: BrowseEntry<T>[]; page: number; pageCount: number; total: number } {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle ? entries.filter(entry => entry.filterText.toLocaleLowerCase().includes(needle)) : entries;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.max(0, Math.min(Math.trunc(page) || 0, pageCount - 1));
  return { items: filtered.slice(safePage * pageSize, (safePage + 1) * pageSize), page: safePage, pageCount, total: filtered.length };
}

/** HWP outlines are commonly encoded as paragraph styles; RHWP's generic clause JSON may be empty. */
export function outlineParagraphs(paragraphs: Paragraph[], formatting: FormattingModel): Paragraph[] {
  const byPath = new Map(formatting.paragraphs.map(item => [item.nodePath, item]));
  return paragraphs.filter(paragraph => {
    if (paragraph.address.cellPath?.length || paragraph.address.containerKinds?.length || !paragraph.text.trim()) return false;
    const item = byPath.get(paragraph.nodePath);
    const styleName = item?.style?.name ?? '';
    if (/^(개요|제목|heading|outline|차례)\s*\d*$/iu.test(styleName.trim())) return true;
    const headType = item?.properties?.headType ?? paragraph.properties.headType;
    return typeof headType === 'string' && /^(outline|heading)$/iu.test(headType.trim());
  });
}

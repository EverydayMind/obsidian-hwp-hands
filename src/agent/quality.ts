import type { Field, Json, Paragraph } from '../api';
import type { ImageInspection } from './quality-images';
import { hyperlinkTarget, isInputField, linkVerdict } from './field-kinds';

type JsonObject = { [key: string]: Json };
const CONTEXT_CHARS = 120;
const contextOf = (text: string, offset = 0): string => {
  const points = Array.from(text), start = Math.max(0, offset - 40);
  return (start ? '…' : '') + points.slice(start, start + CONTEXT_CHARS).join('') + (start + CONTEXT_CHARS < points.length ? '…' : '');
};

/** No title/whitespace heuristics: a heading is only a paragraph the document marks as an outline level (개요 n),
 * never a guess from symbols such as □/○ or from font size. Findings are advice, never save approval or edit observations.
 */
export function inspectQuality(input: {
  fields: Field[]; fieldTotal: number; paragraphs: Paragraph[]; paragraphTotal: number;
  handles: string[]; epoch: string; placeholders: string[]; limit: number;
  images?: ImageInspection;
  /** Body-root paragraphs with headType Outline, in document order: index into `paragraphs` and the 0-based level. */
  outline?: { items: Array<{ index: number; level: number }>; total: number };
}): JsonObject {
  const findings: JsonObject[] = [];
  let total = 0, resultChars = 0;
  const add = (finding: JsonObject): void => {
    total++;
    const size = JSON.stringify(finding).length;
    if (findings.length < input.limit && resultChars + size <= 6000) { findings.push(finding); resultChars += size; }
  };
  input.fields.forEach((field, index) => {
    if (!isInputField(field) || field.value !== '') return;
    add({ code: 'unfilled_field', severity: 'info', handle: `${input.epoch}:f${index + 1}`,
      context: contextOf(field.name), suggest: '사용자가 값을 제공했는지 확인하라. 의도적인 빈 입력란일 수 있다. 채우려면 read_document로 현재 값을 확인한 뒤 fill_fields를 사용하라.' });
  });
  let links = 0, linksUnchecked = 0;
  input.fields.forEach((field, index) => {
    if (field.fieldType !== 'hyperlink') return;
    links++;
    const target = typeof field.command === 'string' ? hyperlinkTarget(field.command) : '';
    const verdict = target ? linkVerdict(target) : 'unchecked';
    if (verdict === 'unchecked') { linksUnchecked++; return; }
    if (verdict === 'valid') return;
    add({ code: 'invalid_link', severity: 'warning', handle: `${input.epoch}:f${index + 1}`, reason: verdict,
      context: contextOf(target), suggest: '링크 주소 형식이 올바르지 않다. 표시 문자열과 링크 대상을 사람이 확인해 고쳐야 한다. 이 도구들은 하이퍼링크를 고치지 않으며 fill_fields로 덮어쓰지 마라.' });
  });
  const placeholders = [...new Set(input.placeholders)];
  input.paragraphs.forEach((paragraph, index) => {
    for (const marker of placeholders) {
      const offset = paragraph.text.indexOf(marker);
      if (offset < 0) continue;
      add({ code: 'placeholder_left', severity: 'warning', handle: input.handles[index],
        context: contextOf(paragraph.text, Array.from(paragraph.text.slice(0, offset)).length),
        suggest: '지정한 자리표시자가 남아 있다. 이 문단을 다시 읽고 실제 값과 의도를 확인한 뒤 기존 편집 도구를 사용하라.' });
    }
  });
  let previous: number | undefined;
  for (const { index, level } of input.outline?.items ?? []) {
    const paragraph = input.paragraphs[index], handle = input.handles[index];
    if (!paragraph.text.trim()) add({ code: 'empty_heading', severity: 'info', handle, context: `개요 ${level + 1} 문단에 글자가 없다.`,
      suggest: '개요 번호만 남은 문단인지, 개체만 담은 문단인지 사람이 화면에서 확인하라. 자동으로 지우거나 채우지 마라.' });
    if (previous !== undefined && level > previous + 1) add({ code: 'heading_skip', severity: 'warning', handle,
      context: contextOf(`개요 ${previous + 1} 다음 개요 ${level + 1}: ${paragraph.text}`),
      suggest: '개요 수준이 건너뛰었다. 의도한 구조인지 사용자에게 확인한 뒤 바꿀 때만 format_text의 style로 개요 수준을 지정하라.' });
    previous = level;
  }
  input.images?.findings.forEach(add);
  const fieldsComplete = input.fields.length === input.fieldTotal;
  const paragraphsComplete = input.paragraphs.length === input.paragraphTotal;
  const outlineComplete = input.outline !== undefined && paragraphsComplete && input.outline.items.length === input.outline.total;
  return { findings, totalFoundInScannedContent: total, truncated: total > findings.length || !fieldsComplete || (placeholders.length > 0 && !paragraphsComplete) || (input.images !== undefined && !input.images.complete)
    || (input.outline !== undefined && !outlineComplete),
    coverage: {
      unfilled_field: { status: fieldsComplete ? 'complete' : 'partial', scanned: input.fields.length, total: input.fieldTotal },
      placeholder_left: { status: placeholders.length ? (paragraphsComplete ? 'complete' : 'partial') : 'not_requested',
        scope: 'body+cells', scanned: input.paragraphs.length, total: input.paragraphTotal },
      missing_image: input.images ? { status: input.images.complete ? 'complete' : 'partial', scope: 'body+cells',
        scanned: input.images.scanned, picturesInScannedObjects: input.images.pictures, unchecked: input.images.unchecked,
        scannedObjects: input.images.objectCount, totalObjects: input.images.objectTotal,
        check: 'nonempty-resource-bytes', decoding: 'unsupported' } : { status: 'unsupported' },
      invalid_link: { status: fieldsComplete ? 'complete' : 'partial', scope: 'body+cells+textBoxes', scanned: links, unchecked: linksUnchecked,
        check: 'http/https/ftp absolute URL with letter-digit-hyphen host labels', reachability: 'unsupported' },
      broken_ref: { status: 'unsupported' },
      heading_quality: input.outline ? { status: outlineComplete ? 'complete' : 'partial', scope: 'body outline paragraphs', basis: 'headType=Outline',
        scanned: input.outline.items.length, total: input.outline.total, symbolHeadings: 'unsupported' } : { status: 'unsupported' },
      revisions_and_comments: { status: 'unsupported' },
      stories: { status: 'unsupported' },
    },
  };
}

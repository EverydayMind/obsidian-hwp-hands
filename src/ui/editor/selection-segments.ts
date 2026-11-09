import type { DocumentAddress, DocumentTree, Paragraph, RangeFormatProperties, SelectionRange, StoryParagraph, TextPosition } from '../../api';
import { HwpHandsError } from '../../api';

export type SelectionParagraph = Paragraph | StoryParagraph;

export function isRootBodyAddress(address: DocumentAddress): boolean {
  return address.kind === 'body' && !address.cellPath?.length && !address.containerKinds?.includes('textBox');
}

export function selectionParagraphIndex(address: DocumentAddress): number {
  return address.kind === 'body' && address.cellPath?.length ? address.cellPath.at(-1)!.cellParaIndex : address.paragraph;
}

/** Position identity without session/revision; the final paragraph number is excluded. */
export function selectionContainerKey(address: DocumentAddress): string {
  if (address.kind === 'body') {
    if (!address.cellPath?.length) return JSON.stringify(['body', address.section]);
    return JSON.stringify(['body', address.section, address.paragraph, address.cellPath.map((step, index) =>
      [step.controlIndex, step.cellIndex, index === address.cellPath!.length - 1 ? null : step.cellParaIndex]), address.containerKinds ?? []]);
  }
  if (address.kind === 'headerFooter') return JSON.stringify(['headerFooter', address.section, address.isHeader, address.applyTo]);
  return JSON.stringify([address.kind, address.section, address.anchor.paragraph, address.anchor.cellPath ?? [], address.controlIndex]);
}

export function selectionPositionKey(position: TextPosition): string {
  return JSON.stringify([selectionContainerKey(position.address), selectionParagraphIndex(position.address), position.offset]);
}

export function treeTextParagraphs(tree: DocumentTree): SelectionParagraph[] {
  const result: SelectionParagraph[] = [...tree.paragraphs, ...tree.tables.flatMap(table => table.cells.flatMap(cell => cell.paragraphs)), ...tree.stories.flatMap<SelectionParagraph>(story => story.paragraphs)];
  return [...new Map(result.map(paragraph => [selectionPositionKey({ address: paragraph.address, offset: 0 }), paragraph])).values()];
}

export function formattingUnavailableReason(address: DocumentAddress, changes: RangeFormatProperties): string | undefined {
  const nested = address.kind === 'body' && (address.cellPath?.length ?? 0) > 1;
  const textBox = address.kind === 'body' && address.containerKinds?.includes('textBox');
  if (changes.character && (address.kind === 'footnote' || address.kind === 'endnote')) return '각주·미주 안에서는 글자 모양을 바꿀 수 없습니다(RHWP 코어 미지원).';
  if (changes.paragraph && nested) return '중첩 표 셀에서는 문단 모양을 바꿀 수 없습니다(RHWP 코어 미지원).';
  if (changes.styleId !== undefined && (address.kind !== 'body' || nested || textBox)) return '이 대상에서는 문단 스타일을 적용할 수 없습니다(RHWP 코어 미지원).';
  if (changes.list && (address.kind !== 'body' || nested)) return '이 대상에서는 문단 번호·글머리표를 적용할 수 없습니다(RHWP 코어 미지원).';
  return undefined;
}

/** Ordered engine ranges; only root body selections may cross section boundaries. */
export function normalizeSelectionSegments(tree: DocumentTree, anchor: TextPosition, focus: TextPosition): SelectionRange[] {
  const paragraphs = treeTextParagraphs(tree);
  const resolve = (position: TextPosition): TextPosition => {
    const paragraph = paragraphs.find(item => selectionContainerKey(item.address) === selectionContainerKey(position.address)
      && selectionParagraphIndex(item.address) === selectionParagraphIndex(position.address));
    if (!paragraph || !Number.isSafeInteger(position.offset) || position.offset < 0 || position.offset > paragraph.length) throw new HwpHandsError('INVALID_ARGUMENT', '선택 위치가 현재 문서에 없습니다.');
    return { address: paragraph.address, offset: position.offset };
  };
  const first = resolve(anchor), second = resolve(focus);
  if (isRootBodyAddress(first.address) && isRootBodyAddress(second.address)) {
    const compare = first.address.section - second.address.section || first.address.paragraph - second.address.paragraph || first.offset - second.offset;
    const start = compare <= 0 ? first : second, end = compare <= 0 ? second : first;
    return tree.sections.filter(section => section.index >= start.address.section && section.index <= end.address.section).map(section => {
      const head = section.paragraphs[0], tail = section.paragraphs.at(-1);
      if (!head || !tail) throw new HwpHandsError('INVALID_ARGUMENT', '선택 구역에 문단이 없습니다.');
      return { start: section.index === start.address.section ? start : { address: head.address, offset: 0 },
        end: section.index === end.address.section ? end : { address: tail.address, offset: tail.length } };
    });
  }
  if (selectionContainerKey(first.address) !== selectionContainerKey(second.address)) throw new HwpHandsError('INVALID_ARGUMENT', '선택은 같은 셀·글상자·본문 밖 영역 안에 있어야 합니다.');
  const compare = selectionParagraphIndex(first.address) - selectionParagraphIndex(second.address) || first.offset - second.offset;
  return [compare <= 0 ? { start: first, end: second } : { start: second, end: first }];
}

export function selectAllTextRange(tree: DocumentTree, address: DocumentAddress): SelectionRange | undefined {
  const paragraphs = treeTextParagraphs(tree).filter(paragraph => isRootBodyAddress(address)
    ? isRootBodyAddress(paragraph.address) : selectionContainerKey(paragraph.address) === selectionContainerKey(address))
    .sort((a, b) => a.address.section - b.address.section || selectionParagraphIndex(a.address) - selectionParagraphIndex(b.address));
  const first = paragraphs[0], last = paragraphs.at(-1);
  return first && last ? { start: { address: first.address, offset: 0 }, end: { address: last.address, offset: last.length } } : undefined;
}

export function selectionMutationUnavailableReason(segments: readonly SelectionRange[]): string | undefined {
  if (segments.length > 1) return '여러 구역에 걸친 삭제·오려두기·덮어 입력은 지원하지 않습니다. 한 구역 안에서 다시 선택하세요.';
  const range = segments[0];
  if (range && range.start.address.kind !== 'body' && selectionParagraphIndex(range.start.address) !== selectionParagraphIndex(range.end.address)) {
    return '머리말·꼬리말·각주·미주의 삭제·덮어 입력은 한 문단 안에서만 지원합니다.';
  }
  return undefined;
}

export function selectionPlainText(tree: DocumentTree, segments: readonly SelectionRange[]): string {
  const paragraphs = treeTextParagraphs(tree);
  return segments.map(range => paragraphs.filter(paragraph => selectionContainerKey(paragraph.address) === selectionContainerKey(range.start.address)
    && selectionParagraphIndex(paragraph.address) >= selectionParagraphIndex(range.start.address)
    && selectionParagraphIndex(paragraph.address) <= selectionParagraphIndex(range.end.address))
    .sort((a, b) => selectionParagraphIndex(a.address) - selectionParagraphIndex(b.address))
    .map(paragraph => Array.from(paragraph.text).slice(selectionParagraphIndex(paragraph.address) === selectionParagraphIndex(range.start.address) ? range.start.offset : 0,
      selectionParagraphIndex(paragraph.address) === selectionParagraphIndex(range.end.address) ? range.end.offset : paragraph.length).join('')).join('\n')).join('\n');
}

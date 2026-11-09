import { HwpHandsError, type Paragraph, type RootOutputAnchor } from './api';

/** Caller-supplied coordinates are candidates, never observations or edit authority. */
export function copyRootOutputAnchors(input: readonly RootOutputAnchor[]): RootOutputAnchor[] {
  if (!Array.isArray(input) || input.length > 5000) throw new HwpHandsError('INVALID_ARGUMENT', 'Invalid output anchor count.');
  const items = Object.getOwnPropertyDescriptors(input);
  const blocks = new Set<number>(), positions = new Set<number>();
  return Array.from({ length: input.length }, (_, index) => {
    const slot = items[index];
    if (!slot || !('value' in slot) || !slot.value || typeof slot.value !== 'object' || Array.isArray(slot.value))
      throw new HwpHandsError('INVALID_ARGUMENT', 'Invalid output anchor.');
    const properties = Object.getOwnPropertyDescriptors(slot.value);
    const blockIndex: unknown = properties.blockIndex && 'value' in properties.blockIndex ? properties.blockIndex.value : undefined;
    const section: unknown = properties.section && 'value' in properties.section ? properties.section.value : undefined;
    const paragraph: unknown = properties.paragraph && 'value' in properties.paragraph ? properties.paragraph.value : undefined;
    if (!Number.isSafeInteger(blockIndex) || (blockIndex as number) < 0 || section !== 0 ||
        !Number.isSafeInteger(paragraph) || (paragraph as number) < 0 || blocks.has(blockIndex as number) || positions.has(paragraph as number))
      throw new HwpHandsError('INVALID_ARGUMENT', 'Invalid or duplicate output anchor.');
    blocks.add(blockIndex as number); positions.add(paragraph as number);
    return { blockIndex: blockIndex as number, section: 0, paragraph: paragraph as number };
  });
}

export function rootOutputCandidates(paragraphs: readonly Paragraph[], anchors: readonly RootOutputAnchor[]) {
  const roots = paragraphs.filter(item => item.address.kind === 'body' && !item.address.cellPath?.length);
  if (roots.length !== paragraphs.length || roots.some((item, index) => item.address.section !== 0 || item.address.paragraph !== index))
    throw new HwpHandsError('VERIFY_FAILED', 'Ambiguous body paragraph structure.');
  return anchors.map(anchor => {
    const paragraph = roots[anchor.paragraph];
    return paragraph ? { blockIndex: anchor.blockIndex, state: 'candidate' as const, address: paragraph.address } :
      { blockIndex: anchor.blockIndex, state: 'unavailable' as const, reason: 'paragraph_missing' as const };
  });
}

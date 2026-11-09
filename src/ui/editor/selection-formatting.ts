import type { CharacterRun, DocumentAddress, FormattingModel, ParagraphFormatting, SelectionRange } from '../../api';
import { selectionContainerKey, selectionParagraphIndex } from './selection-segments';

// A formatting model is replaced on every refresh and its addresses are never edited, so a model address's container key is computed
// once. Building it for every paragraph on every scan cost about 10 ms per scan on a 6,400-paragraph document, and one tool refresh
// evaluates about ten commands that each scan. Selection addresses are keyed afresh for every scan.
const modelContainerKeys = new WeakMap<DocumentAddress, string>();
function modelContainerKey(address: DocumentAddress): string {
  let key = modelContainerKeys.get(address);
  if (key === undefined) { key = selectionContainerKey(address); modelContainerKeys.set(address, key); }
  return key;
}
const paragraphKey = (containerKey: string, address: DocumentAddress): string => `${containerKey}\u0000${selectionParagraphIndex(address)}`;

type SelectionMatch = { whole: true } | { whole: false; range: SelectionRange };
/** Matches model paragraphs against whole paragraphs first, then the first range that contains them. */
function selectionMatcher(ranges: readonly SelectionRange[], wholeParagraphs: readonly DocumentAddress[]): (address: DocumentAddress) => SelectionMatch | undefined {
  const prepared = ranges.map(range => ({
    range, key: selectionContainerKey(range.start.address),
    from: selectionParagraphIndex(range.start.address), to: selectionParagraphIndex(range.end.address),
  }));
  const whole = new Set(wholeParagraphs.map(address => paragraphKey(selectionContainerKey(address), address)));
  return address => {
    if (!prepared.length && !whole.size) return undefined;
    const key = modelContainerKey(address);
    if (whole.size && whole.has(paragraphKey(key, address))) return { whole: true };
    const index = selectionParagraphIndex(address);
    const match = prepared.find(item => item.key === key && index >= item.from && index <= item.to);
    return match ? { whole: false, range: match.range } : undefined;
  };
}

function rangeBounds(paragraph: ParagraphFormatting, range: SelectionRange): { start: number; end: number } {
  const index = selectionParagraphIndex(paragraph.address);
  return {
    start: index === selectionParagraphIndex(range.start.address) ? range.start.offset : 0,
    end: index === selectionParagraphIndex(range.end.address) ? range.end.offset : Infinity,
  };
}
/** The run at a collapsed caret, or the last run before it. */
function caretRun(paragraph: ParagraphFormatting, offset: number): CharacterRun | undefined {
  return paragraph.characterRuns.find(run => offset >= run.offset && offset < run.offset + run.length)
    ?? [...paragraph.characterRuns].reverse().find(run => run.offset + run.length <= offset);
}

/** One toolbar update shares the scan and stops rather than treating partial coverage as uniform. */
export class SelectionFormattingContext {
  private readonly deadline: number;
  private selected?: { paragraphs: ParagraphFormatting[]; runs: CharacterRun[] };
  constructor(private readonly model: FormattingModel, private readonly ranges: readonly SelectionRange[],
    private readonly whole: readonly DocumentAddress[] = [], milliseconds = 16,
    private readonly now: () => number = () => performance.now()) {
    this.deadline = now() + milliseconds;
  }
  get expired(): boolean { return this.now() >= this.deadline; }
  private read() {
    if (this.expired) return { paragraphs: [], runs: [] };
    if (this.selected) return this.selected;
    const match = selectionMatcher(this.ranges, this.whole);
    const paragraphs: ParagraphFormatting[] = [], runs: CharacterRun[] = [];
    for (const paragraph of this.model.paragraphs) {
      if (this.expired) return { paragraphs: [], runs: [] };
      const found = match(paragraph.address);
      if (!found) continue;
      paragraphs.push(paragraph);
      if (found.whole) {
        for (const run of paragraph.characterRuns) {
          if (this.expired) return { paragraphs: [], runs: [] };
          runs.push(run);
        }
      }
      else {
        const { start, end } = rangeBounds(paragraph, found.range);
        if (start === end) {
          const run = caretRun(paragraph, start);
          if (run) runs.push(run);
        } else for (const run of paragraph.characterRuns) {
          if (this.expired) return { paragraphs: [], runs: [] };
          if (run.offset < end && run.offset + run.length > start) runs.push(run);
        }
      }
    }
    if (this.expired) return { paragraphs: [], runs: [] };
    return this.selected = { paragraphs, runs };
  }
  paragraphs(): ParagraphFormatting[] { return this.read().paragraphs; }
  runs(): CharacterRun[] { return this.read().runs; }
}

export function paragraphInRange(address: DocumentAddress, range: SelectionRange): boolean {
  const index = selectionParagraphIndex(address);
  return selectionContainerKey(address) === selectionContainerKey(range.start.address)
    && index >= selectionParagraphIndex(range.start.address) && index <= selectionParagraphIndex(range.end.address);
}

export function selectedFormatting(model: FormattingModel, ranges: readonly SelectionRange[], wholeParagraphs: readonly DocumentAddress[] = []): ParagraphFormatting[] {
  const match = selectionMatcher(ranges, wholeParagraphs);
  return model.paragraphs.filter(paragraph => !!match(paragraph.address));
}

export function selectedCharacterRuns(model: FormattingModel, ranges: readonly SelectionRange[], wholeParagraphs: readonly DocumentAddress[] = []): CharacterRun[] {
  const match = selectionMatcher(ranges, wholeParagraphs);
  return model.paragraphs.flatMap(paragraph => {
    const found = match(paragraph.address);
    if (!found) return [];
    if (found.whole) return paragraph.characterRuns;
    const { start, end } = rangeBounds(paragraph, found.range);
    if (start === end) {
      const run = caretRun(paragraph, start);
      return run ? [run] : [];
    }
    return paragraph.characterRuns.filter(run => run.offset < end && run.offset + run.length > start);
  });
}

/** Unknown values participate in the comparison so partial coverage is never presented as uniform. */
export function uniformValue<T>(values: readonly T[]): T | undefined {
  if (!values.length || values[0] === undefined) return undefined;
  const key = JSON.stringify(values[0]);
  return values.every(value => JSON.stringify(value) === key) ? values[0] : undefined;
}

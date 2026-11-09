import type { BodyAddress, PageLayout } from '../api';
import { addressKey } from './edit';
import { PositionedLines } from './positioned-lines';

/** Approximate visible lines from positioned runs, while checking that run offsets actually cover the text. */
export function paragraphLayout(address: BodyAddress, text: string, pages: PageLayout[]) {
  const chars = Array.from(text), covered = new Set<number>(), lines: Array<{ page: number; column: number; y: number }> = [];
  const indexed = new PositionedLines<(typeof lines)[number]>();
  let uncertain = false;
  for (const layout of pages) for (const run of layout.runs) {
    const own = run.documentAddress ?? run.address;
    if (!own || own.kind !== 'body' || addressKey(own) !== addressKey(address)) continue;
    const column = layout.info.columns.findIndex(c => run.x >= c.x && run.x < c.x + c.width);
    if (!Number.isFinite(run.y) || column < 0) uncertain = true;
    else if (!indexed.find(layout.page, column, run.y)) {
      const line = { page: layout.page, column, y: run.y };
      lines.push(line); indexed.add(line);
    }
    if (!Number.isSafeInteger(run.offset) || run.offset! < 0) { uncertain = true; continue; }
    for (const [index, char] of Array.from(run.text).entries()) {
      const pos = run.offset! + index;
      if (chars[pos] === char && !covered.has(pos)) covered.add(pos); else uncertain = true;
    }
  }
  const complete = chars.every((char, index) => /[\r\n]/.test(char) || covered.has(index));
  return { estimatedLineCount: lines.length, coveredCharacters: covered.size, totalCharacters: chars.length,
    coverage: complete && !uncertain && lines.length > 0 ? 'complete' : 'partial', pages: [...new Set(lines.map(line => line.page + 1))] };
}

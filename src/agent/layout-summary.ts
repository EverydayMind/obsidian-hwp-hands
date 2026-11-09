import { HwpHandsError, type BodyAddress, type LayoutTextRun, type PageLayout } from '../api';
import { addressKey } from './edit';
import { paragraphLayout } from './paragraph-layout';
import { PositionedLines } from './positioned-lines';

type Line = { page: number; column: number; y: number; left: number; right: number };
const columnOf = (layout: PageLayout, run: LayoutTextRun): number =>
  layout.info.columns.findIndex(column => run.x >= column.x && run.x < column.x + column.width);
const bodyRun = (run: LayoutTextRun): BodyAddress | null => {
  const address = run.documentAddress ?? run.address;
  return address?.kind === 'body' ? address : null;
};

type LayoutIndex = Map<string, Map<number, LayoutTextRun[]>>;
/** Index once per request so each page of 20 paragraphs does not rescan all runs. */
export async function indexParagraphLayouts(pages: PageLayout[], signal?: AbortSignal): Promise<LayoutIndex> {
  const index: LayoutIndex = new Map();
  let visited = 0;
  for (const [number, page] of pages.entries()) {
    if (signal?.aborted) throw new HwpHandsError('CANCELLED', '조판 측정이 취소됐다.');
    for (const run of page.runs) {
      if (++visited % 4096 === 0) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (signal?.aborted) throw new HwpHandsError('CANCELLED', '조판 측정이 취소됐다.');
      }
      const address = bodyRun(run);
      if (!address) continue;
      const key = addressKey(address), perPage = index.get(key) ?? new Map<number, LayoutTextRun[]>();
      const bucket = perPage.get(page.page) ?? [];
      bucket.push(run); perPage.set(page.page, bucket); index.set(key, perPage);
    }
    if (number % 8 === 7) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  if (signal?.aborted) throw new HwpHandsError('CANCELLED', '조판 측정이 취소됐다.');
  return index;
}

/** Additional layout facts are conservative when the engine omits positions or content. */
export function paragraphLayoutSummary(address: BodyAddress, text: string, pages: PageLayout[], index?: LayoutIndex) {
  const own = index?.get(addressKey(address));
  const selectedPages = index ? pages.map(page => ({ ...page, runs: own?.get(page.page) ?? [] })) : pages;
  const base = paragraphLayout(address, text, selectedPages), lines: Line[] = [];
  const indexed = new PositionedLines<Line>();
  let incompleteGeometry = false;
  for (const layout of selectedPages) for (const run of layout.runs) {
    const own = bodyRun(run);
    if (!own || addressKey(own) !== addressKey(address)) continue;
    const column = columnOf(layout, run), width = Number.isFinite(run.w) ? run.w : run.width;
    if (column < 0 || !Number.isFinite(run.x) || !Number.isFinite(run.y) || !Number.isFinite(width) || width < 0) { incompleteGeometry = true; continue; }
    let line = indexed.find(layout.page, column, run.y);
    if (!line) { line = { page: layout.page, column, y: run.y, left: run.x, right: run.x + width }; lines.push(line); indexed.add(line); }
    else { line.left = Math.min(line.left, run.x); line.right = Math.max(line.right, run.x + width); }
  }
  lines.sort((a, b) => a.page - b.page || a.column - b.column || a.y - b.y);
  const last = lines.at(-1), page = last && pages.find(item => item.page === last.page);
  const width = page && last ? page.info.columns[last.column]?.width : undefined;
  const lastLineFillRatio = base.coverage === 'complete' && !incompleteGeometry && last && width && width > 0
    ? Math.round(Math.max(0, Math.min(1, (last.right - last.left) / width)) * 1000) / 1000 : null;
  const boundary = (line: Line | undefined, first: boolean): boolean | null => {
    if (!line || base.coverage !== 'complete' || incompleteGeometry) return null;
    const layout = pages.find(item => item.page === line.page);
    if (!layout || layout.info.columns.length !== 1 || layout.controls.length) return null;
    const runs = layout.runs.filter(run => bodyRun(run) !== null);
    if (!runs.length || runs.some(run => !Number.isFinite(run.y) || columnOf(layout, run) !== 0)) return null;
    const edge = runs.reduce((value, run) => first ? Math.min(value, run.y) : Math.max(value, run.y), first ? Infinity : -Infinity);
    if (Math.abs(line.y - edge) <= 2 && runs.some(run => Math.abs(run.y - edge) <= 2 && addressKey(bodyRun(run)!) !== addressKey(address))) return null;
    return Math.abs(line.y - edge) <= 2;
  };
  return { ...base, lastLineFillRatio, startsPage: boundary(lines[0], true), endsPage: boundary(last, false) };
}

/** Geometry yields candidate table anchors; nested identity is not guaranteed by this API. */
export function spanningTableCandidates(pages: PageLayout[]) {
  const groups = new Map<string, { section: number; paragraph: number; controlIndex: number; pages: Set<number> }>();
  for (const page of pages) for (const control of page.controls) {
    if (control.type !== 'table' || ![control.section, control.paragraph, control.controlIndex].every(value => Number.isSafeInteger(value) && value >= 0)) continue;
    const key = `${control.section}:${control.paragraph}:${control.controlIndex}`;
    const item = groups.get(key) ?? { section: control.section, paragraph: control.paragraph, controlIndex: control.controlIndex, pages: new Set<number>() };
    item.pages.add(page.page + 1); groups.set(key, item);
  }
  return [...groups.values()].filter(item => item.pages.size > 1).map(item => ({ ...item, pages: [...item.pages].sort((a, b) => a - b) }));
}

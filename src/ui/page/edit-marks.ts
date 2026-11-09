import type { PageLayout } from '../../api';
import type { EditMark } from '../../agent/marks';

/** Rectangles of AI edit marks on one laid-out page, in page units: the text lines of a marked paragraph, or a marked table. */
export function editMarkRects(layout: PageLayout, marks: readonly EditMark[]): Array<{ x: number; y: number; width: number; height: number }> {
  const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const mark of marks) {
    const { section, paragraph } = mark.address, path = JSON.stringify(mark.address.cellPath ?? []);
    if (mark.table !== undefined) {
      const control = layout.controls.find(item => item.type === 'table' && item.section === section && item.paragraph === paragraph && item.controlIndex === mark.table);
      if (control) rects.push({ x: control.x, y: control.y, width: control.width, height: control.height });
      continue;
    }
    for (const run of layout.textRuns) {
      const address = run.documentAddress ?? run.address;
      if (!address || address.kind !== 'body' || address.section !== section || address.paragraph !== paragraph || JSON.stringify(address.cellPath ?? []) !== path) continue;
      rects.push({ x: run.x, y: run.y, width: Math.max(1, run.w), height: Math.max(1, run.h) });
    }
  }
  return rects;
}

/** Text of the banner that tells a person AI edits wait for a look; empty when there is nothing to show. */
export function editMarksNotice(count: number): string {
  return count > 0 ? `AI가 고친 곳 ${count}곳을 아직 검토하지 않았습니다.` : '';
}

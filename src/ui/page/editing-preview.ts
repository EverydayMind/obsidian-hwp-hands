import type { CaretRect, CharacterProperties, ParagraphProperties } from '../../api';
import type { PreviewSpan } from '../editor/preview-spans';

export interface PreviewBox { x: number; y: number; width: number; height: number }
export interface EditingPreviewInput {
  page: number; width: number; height: number; bounds: PreviewBox; masks: readonly PreviewBox[];
  spans: readonly PreviewSpan[]; caret: number; composition?: { start: number; end: number };
  lineHeight: number; paragraph?: ParagraphProperties;
  /** Hanging indent of every line and the first line's offset from it, in page pixels. */
  paddingLeft?: number; textIndent?: number;
  /** One unedited engine line and the width the engine gave it, used to match the browser's advances to the engine's. */
  fit?: { spans: readonly PreviewSpan[]; width: number };
  /** How many engine lines `bounds` and `spans` replace, and the unedited engine lines after them. */
  segmentLines?: number;
  below?: ReadonlyArray<{ x: number; width: number; spans: readonly PreviewSpan[]; masks: readonly PreviewBox[] }>;
}
/**
 * The engine lines an edit touches: from the line holding the first changed character (or the caret, if earlier)
 * to the line holding the last replaced one. `before` and `after` are code points; `caret` is an offset in `after`.
 */
export function previewSegment(lines: ReadonlyArray<{ start: number; end: number }>, before: readonly string[], after: readonly string[], caret: number): { first: number; last: number } {
  let prefix = 0, suffix = 0, first = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  lines.forEach((line, index) => { if (line.start <= Math.min(prefix, caret)) first = index; });
  const replacedEnd = prefix === before.length && prefix === after.length ? Math.min(caret, before.length) : before.length - suffix;
  let last = lines.findIndex((line, index) => index >= first && line.end >= replacedEnd);
  if (last < 0) last = lines.length - 1;
  // A caret past the redrawn text (text the page does not lay out) needs everything after the edit redrawn.
  if (last < lines.length - 1 && caret > after.length - (before.length - lines[last].end)) last = lines.length - 1;
  return { first, last };
}
/**
 * Extra letter spacing, in page pixels, that makes the browser lay `count` characters out as wide as the engine did.
 * Fonts and spaces rarely measure alike in both, and a paragraph's worth of drift moves the caret line.
 */
export function fitTracking(engineWidth: number, naturalWidth: number, count: number, fontSize: number): number {
  if (![engineWidth, naturalWidth, fontSize].every(Number.isFinite) || engineWidth <= 0 || naturalWidth <= 0 || count < 8) return 0;
  const limit = Math.max(1, fontSize) * 0.3;
  return Math.max(-limit, Math.min(limit, (engineWidth - naturalWidth) / count));
}
export interface PreviewLine<Run> { y: number; x: number; right: number; height: number; start: number; end: number; runs: Run[] }
/** Groups a paragraph's laid-out runs into lines, top to bottom, with each line's code point range. */
export function previewLines<Run extends { text: string; x: number; y: number; w: number; h: number; offset?: number; charStart?: number }>(runs: readonly Run[]): PreviewLine<Run>[] {
  const lines = new Map<number, PreviewLine<Run>>();
  for (const run of runs) {
    const start = run.offset ?? run.charStart ?? 0, end = start + Array.from(run.text).length, line = lines.get(run.y);
    if (!line) lines.set(run.y, { y: run.y, x: run.x, right: run.x + run.w, height: run.h, start, end, runs: [run] });
    else { line.x = Math.min(line.x, run.x); line.right = Math.max(line.right, run.x + run.w); line.height = Math.max(line.height, run.h);
      line.start = Math.min(line.start, start); line.end = Math.max(line.end, end); line.runs.push(run); }
  }
  return [...lines.values()].sort((a, b) => a.y - b.y);
}
export interface PreviewFlowInput {
  bounds: PreviewBox; fallbackWidth: number; paragraph?: ParagraphProperties;
  /** Whether the first laid-out line on this page is the paragraph's first line, and how many lines it has here. */
  startsParagraph: boolean; lineCount: number;
  /** Text column of a body paragraph; absent where the line origin is not known (cells, fields, notes). */
  column?: { x: number; width: number };
  lineHeight: number; firstLineHeight: number;
}
const px = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
/**
 * Places the preview flow where the engine laid the paragraph out. The engine keeps line spacing below the text while
 * CSS splits it above and below, so the box starts half the extra leading higher.
 */
export function previewFlow(input: PreviewFlowInput): { bounds: PreviewBox; paddingLeft: number; textIndent: number } {
  const { bounds, paragraph, column } = input, indent = px(paragraph?.indent);
  const hang = Math.max(0, -indent), first = Math.max(0, indent);
  const leftAligned = paragraph?.alignment !== 'center' && paragraph?.alignment !== 'right';
  const offsets = [...(input.startsParagraph ? [first] : []), ...(input.lineCount > 1 || !input.startsParagraph ? [hang] : [])];
  const fromRuns = bounds.x - Math.min(...offsets);
  const fromColumn = column ? column.x + px(paragraph?.marginLeft) : undefined;
  // A list head or a model the layout does not follow puts runs left of the column origin: trust the runs then.
  // Centred or right-aligned text outside a known column has no recoverable line origin and keeps its run box.
  const left = fromColumn !== undefined && fromColumn <= bounds.x + 0.5 ? fromColumn : leftAligned ? fromRuns : undefined;
  const paddingLeft = left === undefined ? 0 : hang, textIndent = left === undefined || !input.startsParagraph ? 0 : first - hang;
  const right = Math.max(bounds.x + bounds.width, column ? column.x + column.width - px(paragraph?.marginRight) : bounds.x + input.fallbackWidth);
  const lift = Math.max(0, (input.lineHeight - input.firstLineHeight) / 2);
  const x = left ?? bounds.x;
  return { bounds: { x, y: bounds.y - lift, width: Math.max(1, right - x), height: bounds.height + lift }, paddingLeft, textIndent };
}
const WIDE = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
/** Splits text where full-width and half-width characters meet, so a width ratio can be approximated per advance. */
export function widthClasses(text: string): Array<{ text: string; wide: boolean }> {
  const parts: Array<{ text: string; wide: boolean }> = [];
  for (const character of Array.from(text)) {
    const wide = WIDE.test(character), last = parts.at(-1);
    if (last && last.wide === wide) last.text += character; else parts.push({ text: character, wide });
  }
  return parts;
}
const safeColor = (value: unknown): string | undefined => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;

/** A disposable display layer. Text is never read back into the document model. */
export class EditingPreview {
  private element?: HTMLDivElement;
  private caret?: HTMLSpanElement;
  private page = 0;
  private width = 1;
  private height = 1;
  private fit = 0;
  private mounted?: string;
  mount(host: HTMLElement, input: EditingPreviewInput): void {
    // One key reaches here several times with the same content; rebuilding and re-measuring each time costs layout work.
    const signature = JSON.stringify(input);
    if (this.mounted === signature && this.element?.parentElement === host) return;
    this.clear(); this.mounted = signature; this.page = input.page; this.width = input.width; this.height = input.height; this.fit = 0;
    const owner = host.ownerDocument, root = owner.createElement('div');
    root.className = 'hwp-editing-preview'; root.setAttribute('aria-hidden', 'true');
    const place = (element: HTMLElement, box: PreviewBox) => {
      element.style.left = `${box.x / input.width * 100}%`; element.style.top = `${box.y / input.height * 100}%`;
      element.style.width = `${box.width / input.width * 100}%`; element.style.height = `${box.height / input.height * 100}%`;
    };
    const write = (parent: HTMLElement, text: string, properties: CharacterProperties, className?: string) => {
      const ratio = properties.ratios?.[0], scaled = typeof ratio === 'number' && Number.isFinite(ratio) && ratio !== 100;
      for (const part of scaled ? widthClasses(text) : [{ text, wide: true }]) {
        const piece = owner.createElement('span'); piece.textContent = part.text;
        if (className) piece.className = className;
        this.format(piece, properties, input.width, part.wide); parent.append(piece);
      }
    };
    host.insertBefore(root, host.querySelector(':scope > textarea')); this.element = root;
    if (input.fit?.spans.length) {
      const probe = owner.createElement('div'); probe.className = 'hwp-preview-flow';
      Object.assign(probe.style, { visibility: 'hidden', whiteSpace: 'pre', width: 'max-content', left: '0', top: '0' });
      for (const span of input.fit.spans) write(probe, span.text, span.properties);
      root.append(probe);
      const measured = probe.getBoundingClientRect().width, page = host.getBoundingClientRect().width;
      if (measured > 0 && page > 0) this.fit = fitTracking(input.fit.width, measured / page * input.width,
        input.fit.spans.reduce((count, span) => count + Array.from(span.text).length, 0), input.fit.spans[0].properties.fontSize ?? 14);
      probe.remove();
    }
    for (const mask of input.masks) { const cover = owner.createElement('div'); cover.className = 'hwp-preview-mask'; place(cover, mask); root.append(cover); }
    const flow = owner.createElement('div'); flow.className = 'hwp-preview-flow';
    place(flow, input.bounds); flow.style.removeProperty('height'); flow.style.minHeight = `${input.bounds.height / input.width * 100}cqw`;
    flow.style.lineHeight = `${input.lineHeight / input.width * 100}cqw`;
    const alignment = input.paragraph?.alignment;
    flow.style.textAlign = alignment === 'center' || alignment === 'right' || alignment === 'justify' ? alignment : alignment === 'distribute' ? 'justify' : 'left';
    if (alignment === 'distribute') flow.classList.add('hwp-preview-flow-distributed');
    if (input.paddingLeft || input.textIndent) {
      flow.classList.add('hwp-preview-flow-padded'); flow.style.paddingLeft = `${(input.paddingLeft ?? 0) / input.width * 100}cqw`;
      flow.style.textIndent = `${(input.textIndent ?? 0) / input.width * 100}cqw`;
    }
    flow.style.fontSize = `${(input.spans[0]?.properties.fontSize ?? 14) / input.width * 100}cqw`;
    const makeCaret = (properties = input.spans.at(-1)?.properties ?? {}) => {
      const caret = owner.createElement('span'); caret.className = 'hwp-preview-caret'; caret.textContent = '\u200b';
      this.format(caret, properties, input.width); this.caret = caret; flow.append(caret);
    };
    let placed = false;
    for (const span of input.spans) {
      const cuts = [...new Set([span.start, span.end, input.caret, input.composition?.start, input.composition?.end]
        .filter((value): value is number => value !== undefined && value >= span.start && value <= span.end))].sort((a, b) => a - b);
      for (let index = 0; index < cuts.length; index++) {
        const from = cuts[index], to = cuts[index + 1];
        if (from === input.caret && !placed) { makeCaret(span.properties); placed = true; }
        if (to === undefined || to <= from) continue;
        write(flow, span.text.slice(from - span.start, to - span.start).replace(/\u2028/g, '\n'), span.properties,
          input.composition && from >= input.composition.start && to <= input.composition.end ? 'hwp-ime-composition-text' : undefined);
      }
    }
    if (!placed) makeCaret();
    root.append(flow);
    // Keep the engine's untouched lines until the edit changes the line count.
    // Then include their text in the same flow so the overflow can join the
    // next line instead of moving each old line down as a separate block.
    const scale = host.getBoundingClientRect().width / input.width, expected = input.segmentLines ?? 1;
    if (!input.below?.length || !(scale > 0) || Math.round(flow.getBoundingClientRect().height / (input.lineHeight * scale)) === expected) return;
    for (const line of input.below) {
      for (const mask of line.masks) { const cover = owner.createElement('div'); cover.className = 'hwp-preview-mask'; place(cover, mask); root.insertBefore(cover, flow); }
      for (const span of line.spans) write(flow, span.text.replace(/\u2028/g, '\n'), span.properties);
    }
  }
  caretRect(host: HTMLElement): CaretRect | undefined {
    const box = this.caret?.getBoundingClientRect(), page = host.getBoundingClientRect();
    if (!box || !page.width || !page.height || !box.height) return undefined;
    return { pageIndex: this.page, x: (box.left - page.left) / page.width * this.width,
      y: (box.top - page.top) / page.height * this.height, height: box.height / page.height * this.height };
  }
  clear(): void { this.element?.remove(); this.element = undefined; this.caret = undefined; this.mounted = undefined; }
  private format(span: HTMLElement, properties: CharacterProperties, width: number, wide = true): void {
    const size = Number.isFinite(properties.fontSize) ? Math.max(1, Math.min(512, properties.fontSize!)) : 14;
    span.style.fontSize = `${size / width * 100}cqw`; span.style.fontFamily = properties.fontFamily ?? 'inherit';
    span.style.fontWeight = properties.bold ? '700' : '400'; span.style.fontStyle = properties.italic ? 'italic' : 'normal';
    span.style.color = safeColor(properties.textColor) ?? '#111';
    span.style.backgroundColor = safeColor(properties.shadeColor) ?? 'transparent';
    span.style.textDecoration = [properties.underline ? 'underline' : '', properties.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
    // HTML text cannot be condensed per glyph, so a width ratio is shown as its change in advance: a full-width
    // character advances one em and a half-width one about half. Line breaks follow; glyph shapes stay unscaled.
    const spacing = properties.spacings?.[0], ratio = properties.ratios?.[0];
    const tracking = (typeof spacing === 'number' && Number.isFinite(spacing) ? spacing : 0)
      + (typeof ratio === 'number' && Number.isFinite(ratio) ? (Math.max(50, Math.min(200, ratio)) - 100) * (wide ? 1 : 0.5) : 0);
    if (tracking || this.fit) span.style.letterSpacing = `${size * tracking / width + this.fit / width * 100}cqw`;
  }
}

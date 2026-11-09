// Canvas rulers beside the page scroll area (UX_PARITY_PLAN U2-07). They only show where the paper, the body area and the current
// paragraph's indents lie for the page being read; dragging a marker to edit is not supported.
import { indentMarkers, PX_PER_MM, rulerBands, rulerTicks, type PageGeometry } from './view-aids';

export const RULER_THICKNESS = 20;

/** What the rulers draw. Positions are in the scroll area's client pixels (0 = its left/top edge). */
export interface RulerFrame {
  geometry: PageGeometry;
  /** page CSS width divided by the paper width at 100% */
  scale: number;
  pageLeft: number; pageTop: number;
  /** length of the horizontal / vertical ruler in CSS pixels */
  width: number; height: number;
  /** left margin and first-line indent of the paragraph under the caret, in 96 dpi pixels at 100% (unknown values are ignored) */
  paragraph?: { marginLeftPx?: unknown; indentPx?: unknown };
}

interface Palette { background: string; paper: string; margin: string; tick: string; label: string; accent: string }

function palette(element: HTMLElement): Palette {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const read = (name: string, fallback: string): string => style?.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--background-secondary-alt', '#e8e8e8'), paper: read('--background-primary', '#ffffff'), margin: read('--background-modifier-border', '#cccccc'),
    tick: read('--text-muted', '#666666'), label: read('--text-normal', '#222222'), accent: read('--interactive-accent', '#3584e4'),
  };
}

function fit(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | undefined {
  const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d') ?? undefined;
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

export class PageRulers {
  constructor(private readonly horizontal: HTMLCanvasElement, private readonly vertical: HTMLCanvasElement) {}

  clear(): void {
    for (const canvas of [this.horizontal, this.vertical]) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  draw(frame: RulerFrame | undefined): void {
    if (!frame || frame.width <= 0 || frame.height <= 0) { this.clear(); return; }
    const colors = palette(this.horizontal);
    this.drawHorizontal(frame, colors);
    this.drawVertical(frame, colors);
  }

  private drawHorizontal(frame: RulerFrame, colors: Palette): void {
    const context = fit(this.horizontal, frame.width, RULER_THICKNESS);
    if (!context) return;
    const { geometry, scale } = frame, thickness = RULER_THICKNESS;
    context.fillStyle = colors.background; context.fillRect(0, 0, frame.width, thickness);
    const bands = rulerBands(frame.pageLeft, scale, geometry.widthPx, geometry.bodyLeftPx, geometry.bodyRightPx);
    context.fillStyle = colors.margin; context.fillRect(bands.paper[0], 3, bands.paper[1] - bands.paper[0], thickness - 6);
    context.fillStyle = colors.paper; context.fillRect(bands.body[0], 3, bands.body[1] - bands.body[0], thickness - 6);
    context.font = '9px sans-serif'; context.textBaseline = 'top'; context.textAlign = 'left';
    for (const tick of rulerTicks(frame.width, frame.pageLeft, PX_PER_MM * scale, geometry.widthPx / PX_PER_MM)) {
      const height = tick.kind === 'cm' ? 8 : tick.kind === 'half' ? 6 : 3;
      context.fillStyle = colors.tick; context.fillRect(Math.round(tick.position), thickness - 3 - height, 1, height);
      if (tick.label) { context.fillStyle = colors.label; context.fillText(tick.label, Math.round(tick.position) + 2, 2); }
    }
    if (frame.paragraph) {
      const markers = indentMarkers(geometry.bodyLeftPx, scale, frame.pageLeft, frame.paragraph.marginLeftPx, frame.paragraph.indentPx);
      context.fillStyle = colors.accent;
      this.triangle(context, markers.firstLinePx, 1, 'down');
      this.triangle(context, markers.leftPx, thickness - 1, 'up');
    }
  }

  private drawVertical(frame: RulerFrame, colors: Palette): void {
    const context = fit(this.vertical, RULER_THICKNESS, frame.height);
    if (!context) return;
    const { geometry, scale } = frame, thickness = RULER_THICKNESS;
    context.fillStyle = colors.background; context.fillRect(0, 0, thickness, frame.height);
    const bands = rulerBands(frame.pageTop, scale, geometry.heightPx, geometry.bodyTopPx, geometry.bodyBottomPx);
    context.fillStyle = colors.margin; context.fillRect(3, bands.paper[0], thickness - 6, bands.paper[1] - bands.paper[0]);
    context.fillStyle = colors.paper; context.fillRect(3, bands.body[0], thickness - 6, bands.body[1] - bands.body[0]);
    context.font = '9px sans-serif'; context.textBaseline = 'middle'; context.textAlign = 'left';
    for (const tick of rulerTicks(frame.height, frame.pageTop, PX_PER_MM * scale, geometry.heightPx / PX_PER_MM)) {
      const length = tick.kind === 'cm' ? 8 : tick.kind === 'half' ? 6 : 3;
      context.fillStyle = colors.tick; context.fillRect(thickness - 3 - length, Math.round(tick.position), length, 1);
      if (tick.label) { context.fillStyle = colors.label; context.fillText(tick.label, 2, Math.round(tick.position) + 7); }
    }
  }

  private triangle(context: CanvasRenderingContext2D, x: number, y: number, direction: 'up' | 'down'): void {
    const half = 4, rise = direction === 'down' ? 6 : -6;
    context.beginPath(); context.moveTo(x - half, y); context.lineTo(x + half, y); context.lineTo(x, y + rise); context.closePath(); context.fill();
  }
}

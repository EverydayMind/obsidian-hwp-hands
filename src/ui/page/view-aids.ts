// Pure geometry for the rulers and the grid overlay. Kept free of the DOM and `obsidian` so it is unit-tested (UX_PARITY_PLAN U2-07, U8-04).
// All lengths are CSS pixels at 100% zoom (96 dpi), the unit of the engine's per-page layout info.

export const PX_PER_MM = 96 / 25.4;
const finite = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** The paper and the body area of one page. */
export interface PageGeometry { widthPx: number; heightPx: number; bodyLeftPx: number; bodyTopPx: number; bodyRightPx: number; bodyBottomPx: number }
/** The layout info fields the geometry needs (`PageInfo` from the page layout). */
export interface PageInfoLike { width: number; height: number; bodyLeft: number; bodyRight: number; marginTop: number; marginHeader: number; marginBottom: number; marginFooter: number }

/**
 * Paper size and body area of one page from its layout info. The engine already applies the gutter and facing-page mirroring to
 * `bodyLeft`/`bodyRight`, so odd and even pages differ; the body starts below the top margin plus the header height and ends above the
 * bottom margin plus the footer height.
 */
export function pageGeometry(info: Partial<PageInfoLike> | undefined): PageGeometry | undefined {
  if (!info) return undefined;
  const width = finite(info.width), height = finite(info.height);
  if (!(width > 0) || !(height > 0)) return undefined;
  const left = finite(info.bodyLeft), right = finite(info.bodyRight, width);
  const top = finite(info.marginTop) + finite(info.marginHeader), bottom = height - finite(info.marginBottom) - finite(info.marginFooter);
  if (!(right > left) || !(bottom > top)) return undefined;
  return { widthPx: width, heightPx: height, bodyLeftPx: left, bodyTopPx: top, bodyRightPx: right, bodyBottomPx: bottom };
}

export interface RulerTick { position: number; kind: 'mm' | 'half' | 'cm'; label?: string }
/**
 * Ticks along a ruler. `originPx` is where 0 cm sits in the ruler's own pixels and `pxPerMm` is the on-screen size of a millimetre.
 * Ticks are only produced inside `[0, lengthPx]`; below about 2 px per millimetre the millimetre ticks are dropped so the ruler stays readable.
 */
export function rulerTicks(lengthPx: number, originPx: number, pxPerMm: number, extentMm: number): RulerTick[] {
  if (!(pxPerMm > 0) || !(lengthPx > 0) || !(extentMm > 0)) return [];
  const ticks: RulerTick[] = [];
  const everyMm = pxPerMm >= 2 ? 1 : 5;
  for (let mm = 0; mm <= extentMm; mm += everyMm) {
    const position = originPx + mm * pxPerMm;
    if (position < 0) continue;
    if (position > lengthPx) break;
    if (mm % 10 === 0) ticks.push({ position, kind: 'cm', ...(mm > 0 ? { label: String(mm / 10) } : {}) });
    else if (mm % 5 === 0) ticks.push({ position, kind: 'half' });
    else ticks.push({ position, kind: 'mm' });
  }
  return ticks;
}

export interface RulerBands { paper: [number, number]; body: [number, number] }
/** Where the paper and its body area lie on a ruler, in the ruler's own pixels. */
export function rulerBands(originPx: number, scale: number, paperPx: number, bodyStartPx: number, bodyEndPx: number): RulerBands {
  return { paper: [originPx, originPx + paperPx * scale], body: [originPx + bodyStartPx * scale, originPx + bodyEndPx * scale] };
}

export interface IndentMarkers { /** left edge of the paragraph's lines after the first */ leftPx: number; /** where the first line starts */ firstLinePx: number }
/** Indent markers on the horizontal ruler from a paragraph's left margin and first-line indent (negative indent = hanging). */
export function indentMarkers(bodyLeftPx: number, scale: number, originPx: number, marginLeftPx: unknown, indentPx: unknown): IndentMarkers {
  const left = bodyLeftPx + finite(marginLeftPx);
  return { leftPx: originPx + left * scale, firstLinePx: originPx + (left + finite(indentPx)) * scale };
}

export type GridOrigin = 'paper' | 'body';
export type GridStyle = 'lines' | 'dots';
export interface GridSettings { visible: boolean; horizontalMm: number; verticalMm: number; origin: GridOrigin; style: GridStyle }
export const DEFAULT_GRID: GridSettings = { visible: false, horizontalMm: 5, verticalMm: 5, origin: 'body', style: 'lines' };
export const GRID_MIN_MM = 1, GRID_MAX_MM = 100;
const clampMm = (value: unknown, fallback: number): number => {
  const number = finite(value, fallback);
  return Math.min(GRID_MAX_MM, Math.max(GRID_MIN_MM, Math.round(number * 10) / 10));
};
/** Restores grid settings from saved view state, replacing anything out of range or of the wrong type. */
export function normalizeGridSettings(value: unknown): GridSettings {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    visible: record.visible === true,
    horizontalMm: clampMm(record.horizontalMm, DEFAULT_GRID.horizontalMm), verticalMm: clampMm(record.verticalMm, DEFAULT_GRID.verticalMm),
    origin: record.origin === 'paper' ? 'paper' : 'body', style: record.style === 'dots' ? 'dots' : 'lines',
  };
}

export interface GridBackground { backgroundImage: string; backgroundSize: string; backgroundPosition: string }
/**
 * CSS for a grid drawn over one page element. `scale` is the page's CSS width divided by its width at 100%. A background tiles in both
 * directions, so lines also appear left of and above the origin.
 */
export function gridBackground(settings: GridSettings, geometry: PageGeometry | undefined, scale: number, color: string): GridBackground | undefined {
  if (!settings.visible || !(scale > 0)) return undefined;
  const dx = settings.horizontalMm * PX_PER_MM * scale, dy = settings.verticalMm * PX_PER_MM * scale;
  // A grid denser than ~3 px would only paint a solid colour.
  if (dx < 3 || dy < 3) return undefined;
  const originX = settings.origin === 'body' && geometry ? geometry.bodyLeftPx * scale : 0, originY = settings.origin === 'body' && geometry ? geometry.bodyTopPx * scale : 0;
  const image = settings.style === 'dots'
    ? `radial-gradient(circle at 0 0, ${color} 1.1px, transparent 1.6px)`
    : `linear-gradient(to right, ${color} 1px, transparent 1px), linear-gradient(to bottom, ${color} 1px, transparent 1px)`;
  const round = (value: number): string => `${Math.round(value * 100) / 100}px`;
  return { backgroundImage: image, backgroundSize: `${round(dx)} ${round(dy)}`, backgroundPosition: `${round(originX)} ${round(originY)}` };
}

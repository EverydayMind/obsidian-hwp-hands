import { HwpHandsError } from './api';
import type { PageLayout } from './api';

export interface CanvasPage {
  bitmap: ImageBitmap;
  layout: PageLayout;
  width: number;
  height: number;
  scale: number;
}

/** 16 MiB per page surface; PageStack limits mounted pages and concurrent work. */
export function canvasScale(width: number, height: number, requested: number): number {
  if (![width, height, requested].every(Number.isFinite) || width <= 0 || height <= 0 || requested <= 0) {
    throw new HwpHandsError('INVALID_ARGUMENT', 'Invalid Canvas page dimensions or scale.');
  }
  return Math.min(requested, 5, 8192 / width, 8192 / height, Math.sqrt(4_194_304 / ((width + 1) * (height + 1))));
}

/** Consume transfer-only resources, including late replies and cancelled requests. */
export function closeBitmaps(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
  seen.add(value);
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) { value.close(); return; }
  for (const nested of Object.values(value)) closeBitmaps(nested, seen);
}

/** drawImage copies the pixels; the transferred bitmap is always closed by the caller. */
export function mountCanvasPage(host: HTMLElement, page: Pick<CanvasPage, 'bitmap'>, label: string): void {
  const canvas = host.ownerDocument.createElement('canvas');
  canvas.className = 'hwp-page-canvas';
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', label);
  canvas.width = page.bitmap.width; canvas.height = page.bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new HwpHandsError('ENGINE_ERROR', 'Canvas 2D display is unavailable.');
  context.drawImage(page.bitmap, 0, 0);
  releaseCanvases(host);
  host.replaceChildren(canvas);
}

/** Detached canvases keep their backing store until collected; shrink them when a page surface is replaced or removed. */
export function releaseCanvases(host: ParentNode): void {
  for (const canvas of host.querySelectorAll('canvas')) canvas.width = canvas.height = 1;
}

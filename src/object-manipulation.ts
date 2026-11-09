import type { PictureProperties, ShapeProperties, EquationProperties } from './api';

export type ObjectResizeHandle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type EditableObjectProperties = PictureProperties | ShapeProperties | EquationProperties;
export interface ObjectDragProperties { width?: number; height?: number; horzOffset?: number; vertOffset?: number }

export interface ObjectRect { x: number; y: number; width: number; height: number }

const HUNDREDTH_MM_PER_CSS_PIXEL = 25.4 / 96 * 100;

export function objectUnitsToCssPixels(value: number): number {
  return value / HUNDREDTH_MM_PER_CSS_PIXEL;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function clampObjectLength(value: number): number {
  return Math.max(1, Math.min(1_000_000, Math.round(value)));
}

function clampObjectOffset(value: number): number {
  return Math.max(-1_000_000, Math.min(1_000_000, Math.round(value)));
}

export function objectRectAfterDrag(
  rect: ObjectRect,
  handle: ObjectResizeHandle,
  deltaX: number,
  deltaY: number,
  preserveAspectRatio = false,
): ObjectRect {
  finite(deltaX, 'deltaX'); finite(deltaY, 'deltaY');
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new Error('The selected object must have a valid page rectangle.');
  }
  if (handle === 'move') return { ...rect, x: rect.x + deltaX, y: rect.y + deltaY };
  const horizontal = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const vertical = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  if (!horizontal && !vertical) throw new Error('A resize handle is required.');
  let width = Math.max(1, rect.width + horizontal * deltaX);
  let height = Math.max(1, rect.height + vertical * deltaY);
  if (preserveAspectRatio) {
    let scale: number;
    if (horizontal && vertical) {
      const widthScale = width / rect.width, heightScale = height / rect.height;
      scale = Math.abs(widthScale - 1) >= Math.abs(heightScale - 1) ? widthScale : heightScale;
    } else if (horizontal) scale = width / rect.width;
    else scale = height / rect.height;
    scale = Math.max(0.05, Math.min(20, scale));
    width = rect.width * scale; height = rect.height * scale;
  }
  return {
    x: horizontal < 0 ? rect.x + rect.width - width : rect.x,
    y: vertical < 0 ? rect.y + rect.height - height : rect.y,
    width,
    height,
  };
}

/** Convert a page drag into one revision-bound object property update. */
export function objectPropertiesForDrag(
  properties: EditableObjectProperties,
  rect: ObjectRect,
  handle: ObjectResizeHandle,
  deltaX: number,
  deltaY: number,
  preserveAspectRatio = false,
): Partial<ObjectDragProperties> {
  if (handle === 'move') {
    finite(deltaX, 'deltaX'); finite(deltaY, 'deltaY');
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      throw new Error('The selected object must have a valid page rectangle.');
    }
    return {
      horzOffset: clampObjectOffset((('horzOffset' in properties && typeof properties.horzOffset === 'number') ? properties.horzOffset : 0) + deltaX * HUNDREDTH_MM_PER_CSS_PIXEL),
      vertOffset: clampObjectOffset((('vertOffset' in properties && typeof properties.vertOffset === 'number') ? properties.vertOffset : 0) + deltaY * HUNDREDTH_MM_PER_CSS_PIXEL),
    };
  }

  const horizontal = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const vertical = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const next = objectRectAfterDrag(rect, handle, deltaX, deltaY, preserveAspectRatio);

  const initialWidth = properties.width ?? rect.width * HUNDREDTH_MM_PER_CSS_PIXEL;
  const initialHeight = properties.height ?? rect.height * HUNDREDTH_MM_PER_CSS_PIXEL;
  const result: Partial<ObjectDragProperties> = {
    ...(horizontal || preserveAspectRatio ? { width: clampObjectLength(initialWidth * next.width / rect.width) } : {}),
    ...(vertical || preserveAspectRatio ? { height: clampObjectLength(initialHeight * next.height / rect.height) } : {}),
  };
  if (horizontal < 0) result.horzOffset = clampObjectOffset((('horzOffset' in properties && typeof properties.horzOffset === 'number') ? properties.horzOffset : 0) + (next.x - rect.x) * HUNDREDTH_MM_PER_CSS_PIXEL);
  if (vertical < 0) result.vertOffset = clampObjectOffset((('vertOffset' in properties && typeof properties.vertOffset === 'number') ? properties.vertOffset : 0) + (next.y - rect.y) * HUNDREDTH_MM_PER_CSS_PIXEL);
  return result;
}

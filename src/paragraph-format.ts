import { L } from './i18n/locale';
export function stepPercentLineSpacing(current: number | undefined, direction: -1 | 1): number {
  if (current !== undefined && (!Number.isFinite(current) || current < 0)) throw new Error(L({ ko: '줄 간격 값이 올바르지 않습니다.', en: "Invalid line spacing." }));
  return Math.max(0, Math.min(1000, Math.round((current ?? 100) + direction * 5)));
}

export function millimetersToHwpUnits(value: number): number {
  if (!Number.isFinite(value)) throw new Error(L({ ko: '길이는 유한한 mm 값이어야 합니다.', en: "Length must be a finite mm value." }));
  return Math.round(value * 7200 / 25.4);
}

export function millimetersToDoubledHwpUnits(value: number): number {
  if (!Number.isFinite(value)) throw new Error(L({ ko: '길이는 유한한 mm 값이어야 합니다.', en: "Length must be a finite mm value." }));
  return Math.round(value * 7200 / 25.4 * 2);
}

export function hwpUnitsToMillimeters(value: number): number {
  if (!Number.isFinite(value)) throw new Error(L({ ko: 'HWP 길이는 유한한 숫자여야 합니다.', en: "HWP length must be finite." }));
  return value * 25.4 / 7200;
}

export function pointsToHwpUnits(value: number): number {
  if (!Number.isFinite(value)) throw new Error(L({ ko: '줄 간격은 유한한 pt 값이어야 합니다.', en: "Line spacing must be a finite pt value." }));
  return Math.round(value * 100 * 2);
}

export function hwpUnitsToPoints(value: number): number {
  if (!Number.isFinite(value)) throw new Error(L({ ko: 'HWP 줄 간격은 유한한 숫자여야 합니다.', en: "HWP line spacing must be finite." }));
  return value / (100 * 2);
}

export function pixelsToMillimeters(value: number): number {
  if (!Number.isFinite(value)) throw new Error(L({ ko: '문단 px 값은 유한한 숫자여야 합니다.', en: "Paragraph px value must be finite." }));
  return value * 25.4 / 96;
}

export function pixelsToPoints(value: number): number {
  if (!Number.isFinite(value)) throw new Error(L({ ko: '문단 px 값은 유한한 숫자여야 합니다.', en: "Paragraph px value must be finite." }));
  return value * 72 / 96;
}

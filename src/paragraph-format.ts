export function stepPercentLineSpacing(current: number | undefined, direction: -1 | 1): number {
  if (current !== undefined && (!Number.isFinite(current) || current < 0)) throw new Error('줄 간격 값이 올바르지 않습니다.');
  return Math.max(0, Math.min(1000, Math.round((current ?? 100) + direction * 5)));
}

export function millimetersToHwpUnits(value: number): number {
  if (!Number.isFinite(value)) throw new Error('길이는 유한한 mm 값이어야 합니다.');
  return Math.round(value * 7200 / 25.4);
}

export function millimetersToDoubledHwpUnits(value: number): number {
  if (!Number.isFinite(value)) throw new Error('길이는 유한한 mm 값이어야 합니다.');
  return Math.round(value * 7200 / 25.4 * 2);
}

export function hwpUnitsToMillimeters(value: number): number {
  if (!Number.isFinite(value)) throw new Error('HWP 길이는 유한한 숫자여야 합니다.');
  return value * 25.4 / 7200;
}

export function pointsToHwpUnits(value: number): number {
  if (!Number.isFinite(value)) throw new Error('줄 간격은 유한한 pt 값이어야 합니다.');
  return Math.round(value * 100 * 2);
}

export function hwpUnitsToPoints(value: number): number {
  if (!Number.isFinite(value)) throw new Error('HWP 줄 간격은 유한한 숫자여야 합니다.');
  return value / (100 * 2);
}

export function pixelsToMillimeters(value: number): number {
  if (!Number.isFinite(value)) throw new Error('문단 px 값은 유한한 숫자여야 합니다.');
  return value * 25.4 / 96;
}

export function pixelsToPoints(value: number): number {
  if (!Number.isFinite(value)) throw new Error('문단 px 값은 유한한 숫자여야 합니다.');
  return value * 72 / 96;
}

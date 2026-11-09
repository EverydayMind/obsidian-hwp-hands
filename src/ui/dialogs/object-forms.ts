import type { Command, EquationProperties, PictureProperties, ShapeProperties } from '../../api';
import type { FormField, FormValues } from './form-values';
import { changedProperties } from './page-section-forms';

type ObjectTarget = Extract<Command, { type: 'setObjectProperties' }>['object'];
export const equationScriptField = (script = ''): FormField => ({ key: 'script', label: '수식 스크립트', kind: 'text', value: script, required: true, maxLength: 4096, rows: 4 });
export const equationScriptError = (script: string): string | undefined => !script.trim() ? '수식 스크립트를 입력하세요.'
  : script.length > 4096 || script.includes('\0') ? '수식 스크립트는 NUL 없이 4096자 이하여야 합니다.' : undefined;

export function objectFields(kind: ObjectTarget['kind'], current: Record<string, unknown>): FormField[] {
  const mm = (key: string, fallback: number): number => typeof current[key] === 'number' ? current[key] / 100 : fallback;
  return [
    { key: 'width', label: '너비', kind: 'number', value: mm('width', 40), min: 0.01, max: 10000, unit: 'mm' },
    { key: 'height', label: '높이', kind: 'number', value: mm('height', 20), min: 0.01, max: 10000, unit: 'mm' },
    { key: 'description', label: '설명', kind: 'text', value: typeof current.description === 'string' ? current.description : '', maxLength: 256 },
    ...(kind === 'equation' ? [equationScriptField(typeof current.script === 'string' ? current.script : '')] : [
      { key: 'horzOffset', label: '가로 위치', kind: 'number', value: mm('horzOffset', 0), min: -10000, max: 10000, unit: 'mm' },
      { key: 'vertOffset', label: '세로 위치', kind: 'number', value: mm('vertOffset', 0), min: -10000, max: 10000, unit: 'mm' },
      { key: 'treatAsChar', label: '글자처럼 취급', kind: 'checkbox', value: current.treatAsChar === true },
      { key: 'textWrap', label: '본문 배치', kind: 'select', value: current.textWrap === 'TopAndBottom' ? 'TopAndBottom' : 'Square', options: [['Square', '어울림'], ['TopAndBottom', '자리 차지']] },
    ] as FormField[]),
  ];
}

/** Compare converted initial values so opening a dialog does not round or reset untouched properties. */
export function objectCommand(object: ObjectTarget, values: FormValues, initial: FormValues): Extract<Command, { type: 'setObjectProperties' }> | undefined {
  const convert = (input: FormValues): PictureProperties | ShapeProperties | EquationProperties => ({
    width: Math.round(Number(input.width) * 100), height: Math.round(Number(input.height) * 100), description: String(input.description).trim(),
    ...(object.kind === 'equation' ? { script: String(input.script).trim() } : {
      horzOffset: Math.round(Number(input.horzOffset) * 100), vertOffset: Math.round(Number(input.vertOffset) * 100),
      treatAsChar: input.treatAsChar === true, textWrap: input.textWrap as 'Square' | 'TopAndBottom',
    }),
  });
  const properties = changedProperties(convert(values), convert(initial));
  return Object.keys(properties).length ? { type: 'setObjectProperties', object, properties } : undefined;
}

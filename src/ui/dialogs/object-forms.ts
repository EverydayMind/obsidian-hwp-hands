import { L } from '../../i18n/locale';
import type { Command, EquationProperties, PictureProperties, ShapeProperties } from '../../api';
import type { FormField, FormValues } from './form-values';
import { changedProperties } from './page-section-forms';

type ObjectTarget = Extract<Command, { type: 'setObjectProperties' }>['object'];
export const equationScriptField = (script = ''): FormField => ({ key: 'script', label: L({ ko: '수식 스크립트', en: "Equation script" }), kind: 'text', value: script, required: true, maxLength: 4096, rows: 4 });
export const equationScriptError = (script: string): string | undefined => !script.trim() ? L({ ko: '수식 스크립트를 입력하세요.', en: "Enter an equation script." })
  : script.length > 4096 || script.includes('\0') ? L({ ko: '수식 스크립트는 NUL 없이 4096자 이하여야 합니다.', en: "Equation script must be at most 4096 characters without NUL." }) : undefined;

export function objectFields(kind: ObjectTarget['kind'], current: Record<string, unknown>): FormField[] {
  const mm = (key: string, fallback: number): number => typeof current[key] === 'number' ? current[key] / 100 : fallback;
  return [
    { key: 'width', label: L({ ko: '너비', en: "Width" }), kind: 'number', value: mm('width', 40), min: 0.01, max: 10000, unit: 'mm' },
    { key: 'height', label: L({ ko: '높이', en: "Height" }), kind: 'number', value: mm('height', 20), min: 0.01, max: 10000, unit: 'mm' },
    { key: 'description', label: L({ ko: '설명', en: "Description" }), kind: 'text', value: typeof current.description === 'string' ? current.description : '', maxLength: 256 },
    ...(kind === 'equation' ? [equationScriptField(typeof current.script === 'string' ? current.script : '')] : [
      { key: 'horzOffset', label: L({ ko: '가로 위치', en: "Horizontal position" }), kind: 'number', value: mm('horzOffset', 0), min: -10000, max: 10000, unit: 'mm' },
      { key: 'vertOffset', label: L({ ko: '세로 위치', en: "Vertical position" }), kind: 'number', value: mm('vertOffset', 0), min: -10000, max: 10000, unit: 'mm' },
      { key: 'treatAsChar', label: L({ ko: '글자처럼 취급', en: "Treat as character" }), kind: 'checkbox', value: current.treatAsChar === true },
      { key: 'textWrap', label: L({ ko: '본문 배치', en: "Text wrapping" }), kind: 'select', value: current.textWrap === 'TopAndBottom' ? 'TopAndBottom' : 'Square', options: [['Square', L({ ko: '어울림', en: "Square" })], ['TopAndBottom', L({ ko: '자리 차지', en: "Top and bottom" })]] },
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

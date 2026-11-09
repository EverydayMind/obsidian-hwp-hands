// Pure field model and validation for generic form dialogs. Kept free of the `obsidian` module so it is unit-testable.
export type FormValue = string | number | boolean;
export type FormValues = Record<string, FormValue>;
interface FormFieldBase { key: string; label: string; hint?: string; /** Greyed out (and not validated) while this returns false. */ enabledWhen?: (values: FormValues) => boolean }
export type FormField = FormFieldBase & (
  | { kind: 'number'; value: number; min?: number; max?: number; step?: number; integer?: boolean; unit?: string }
  | { kind: 'select'; value: string; options: ReadonlyArray<readonly [string, string]> }
  | { kind: 'checkbox'; value: boolean }
  | { kind: 'color'; value: string }
  | { kind: 'text'; value: string; maxLength?: number; required?: boolean; rows?: number }
);
export interface FormParseResult { values: FormValues; error?: { key: string; message: string } }

export function initialFormValues(fields: readonly FormField[]): FormValues {
  return Object.fromEntries(fields.map(field => [field.key, field.value]));
}

/** Parses raw DOM strings/booleans into typed values and reports the first invalid enabled field. */
export function parseFormValues(fields: readonly FormField[], raw: Readonly<Record<string, FormValue>>): FormParseResult {
  const values: FormValues = {};
  const provisional: FormValues = {};
  for (const field of fields) provisional[field.key] = raw[field.key] ?? field.value;
  for (const field of fields) {
    const input = provisional[field.key];
    if (field.enabledWhen && !field.enabledWhen(provisional)) { values[field.key] = field.value; continue; }
    switch (field.kind) {
      case 'number': {
        const text = typeof input === 'string' ? input.trim() : String(input);
        const parsed = text === '' ? Number.NaN : Number(text);
        const range = field.min !== undefined && field.max !== undefined ? `${field.min}~${field.max}` : field.min !== undefined ? `${field.min} 이상` : field.max !== undefined ? `${field.max} 이하` : '유효한 숫자';
        if (!Number.isFinite(parsed) || (field.integer && !Number.isInteger(parsed)) || (field.min !== undefined && parsed < field.min) || (field.max !== undefined && parsed > field.max)) {
          return { values, error: { key: field.key, message: `${field.label}은(는) ${field.integer ? '정수 ' : ''}${range}${field.unit ? ` ${field.unit}` : ''} 범위로 입력하세요.` } };
        }
        values[field.key] = parsed; break;
      }
      case 'select': {
        if (typeof input !== 'string' || !field.options.some(([value]) => value === input)) return { values, error: { key: field.key, message: `${field.label}에서 목록의 항목을 고르세요.` } };
        values[field.key] = input; break;
      }
      case 'checkbox': values[field.key] = input === true || input === 'true'; break;
      case 'color': {
        if (typeof input !== 'string' || !/^#[0-9a-f]{6}$/i.test(input)) return { values, error: { key: field.key, message: `${field.label}은(는) #RRGGBB 형식이어야 합니다.` } };
        values[field.key] = input.toLowerCase(); break;
      }
      case 'text': {
        const text = typeof input === 'string' ? input.trim() : String(input);
        if (field.required && !text) return { values, error: { key: field.key, message: `${field.label}을(를) 입력하세요.` } };
        if (field.maxLength !== undefined && Array.from(text).length > field.maxLength) return { values, error: { key: field.key, message: `${field.label}은(는) ${field.maxLength}자 이하로 입력하세요.` } };
        values[field.key] = text; break;
      }
    }
  }
  return { values };
}

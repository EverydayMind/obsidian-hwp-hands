import { L } from '../../i18n/locale';
// Field definitions and value→command conversion for the click-here field edit and removal dialogs (pure, unit-tested).
import type { Command } from '../../api';
import type { FormField, FormValues } from './form-values';

// Query results carry these as loosely typed JSON values, so only the shape the dialogs rely on is declared here.
interface EditableField { name: string; guide?: unknown; memo?: unknown; editableInForm?: unknown }
interface StampedField { fieldId: number; sessionId?: string; revision?: number }

export function fieldEditFields(field: EditableField): FormField[] {
  return [
    { key: 'name', label: L({ ko: '필드 이름', en: "Field name" }), kind: 'text', value: typeof field.name === 'string' ? field.name : '', required: true, maxLength: 128 },
    { key: 'guide', label: L({ ko: '안내문', en: "Prompt" }), kind: 'text', value: typeof field.guide === 'string' ? field.guide : '', maxLength: 256 },
    { key: 'memo', label: L({ ko: '메모', en: "Memo" }), kind: 'text', value: typeof field.memo === 'string' ? field.memo : '', maxLength: 1024 },
    { key: 'editable', label: L({ ko: '양식 모드에서 입력 허용', en: "Allow input in form mode" }), kind: 'checkbox', value: field.editableInForm !== false },
  ];
}

function stamp(field: StampedField): { fieldId: number; sessionId: string; revision: number } {
  if (field.sessionId === undefined || field.revision === undefined) throw new Error(L({ ko: '필드 주소가 오래되어 다시 선택해야 합니다.', en: "The field address is stale. Select it again." }));
  return { fieldId: field.fieldId, sessionId: field.sessionId, revision: field.revision };
}

/** Only the properties that differ from the dialog's initial values are sent. Undefined when nothing changed. */
export function fieldEditCommand(field: StampedField, values: FormValues, initial: FormValues): Command | undefined {
  const changes: { name?: string; guide?: string; memo?: string; editable?: boolean } = {};
  if (values.name !== initial.name) changes.name = String(values.name);
  if (values.guide !== initial.guide) changes.guide = String(values.guide);
  if (values.memo !== initial.memo) changes.memo = String(values.memo);
  if (values.editable !== initial.editable) changes.editable = values.editable === true;
  return Object.keys(changes).length ? { type: 'updateField', ...stamp(field), ...changes } : undefined;
}

/** Removing a click-here field also removes what was typed into it, so the dialog lets the user keep that text. */
export function fieldRemoveFields(hasText: boolean): FormField[] {
  return [{
    key: 'mode', label: L({ ko: '지우는 방법', en: "Deletion mode" }), kind: 'select', value: hasText ? 'keep' : 'all',
    options: [['keep', L({ ko: '필드만 지우고 입력한 내용은 남기기', en: "Delete field only, preserving entered content" })], ['all', L({ ko: '필드와 입력한 내용을 모두 지우기', en: "Delete field and entered content" })]],
    ...(hasText ? {} : { hint: L({ ko: '입력한 내용이 없는 필드입니다.', en: "This field has no entered content." }) }),
  }];
}
export function fieldRemoveCommand(field: StampedField, values: FormValues): Command {
  return { type: 'removeField', ...stamp(field), keepText: values.mode === 'keep' };
}

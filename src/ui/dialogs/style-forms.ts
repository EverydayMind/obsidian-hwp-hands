// Field definitions and value→command conversion for the style editor and the numbering shape dialog (pure, unit-tested).
import type { CharacterFormatProperties, Command, ParagraphFormatProperties, ParagraphAlignment, StyleDefinition } from '../../api';
import { millimetersToDoubledHwpUnits, millimetersToHwpUnits, pixelsToMillimeters } from '../../paragraph-format';
import { changedProperties } from './page-section-forms';
import type { FormField, FormValues } from './form-values';

const ALIGNMENTS: ReadonlyArray<readonly [string, string]> = [['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽'], ['justify', '양쪽'], ['distribute', '배분'], ['split', '나눔']];
const round = (value: number, digits = 2): number => Math.round(value * 10 ** digits) / 10 ** digits;
const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const mm = (px: unknown): number => round(pixelsToMillimeters(finite(px, 0)));

/** Fields for a new style (`style` undefined; starts from the default style's formatting) or for editing `style`. */
export function styleFields(mode: 'create' | 'edit', style: StyleDefinition | undefined, styles: readonly StyleDefinition[], base: StyleDefinition | undefined = styles[0]): FormField[] {
  const source = style ?? base;
  const char = source?.detail.charProps ?? {}, para = source?.detail.paraProps ?? {};
  const percent = para.lineSpacingType === 'Percent' || mode === 'create';
  const alignment = ALIGNMENTS.some(([value]) => value === para.alignment) ? String(para.alignment) : 'left';
  const nextOptions: Array<readonly [string, string]> = [...(mode === 'create' ? [['self', '자기 자신'] as const] : []), ...styles.map(item => [String(item.id), item.name] as const)];
  return [
    { key: 'name', label: '스타일 이름', kind: 'text', value: style?.name ?? '', required: true, maxLength: 60 },
    { key: 'englishName', label: '영문 이름', kind: 'text', value: style?.englishName ?? '', maxLength: 60 },
    ...(mode === 'create' ? [{ key: 'kind', label: '종류', kind: 'select', value: 'paragraph', options: [['paragraph', '문단 스타일'], ['character', '글자 스타일']] } as FormField] : []),
    { key: 'nextStyleId', label: '다음 문단에 쓸 스타일', kind: 'select', value: mode === 'create' ? 'self' : String(style?.nextStyleId ?? 0), options: nextOptions },
    { key: 'fontFamily', label: '글꼴', kind: 'text', value: typeof char.fontFamily === 'string' ? char.fontFamily : '', maxLength: 64 },
    { key: 'fontSize', label: '글자 크기', kind: 'number', value: round(finite(char.fontSize, 10), 1), min: 1, max: 1000, unit: 'pt' },
    { key: 'bold', label: '굵게', kind: 'checkbox', value: char.bold === true },
    { key: 'italic', label: '기울임', kind: 'checkbox', value: char.italic === true },
    { key: 'underline', label: '밑줄', kind: 'checkbox', value: char.underline === true },
    { key: 'strikethrough', label: '취소선', kind: 'checkbox', value: char.strikethrough === true },
    { key: 'textColor', label: '글자 색', kind: 'color', value: typeof char.textColor === 'string' && /^#[0-9a-f]{6}$/i.test(char.textColor) ? char.textColor : '#000000' },
    { key: 'alignment', label: '정렬', kind: 'select', value: alignment, options: ALIGNMENTS },
    { key: 'marginLeft', label: '왼쪽 여백', kind: 'number', value: mm(para.marginLeft), min: -1000, max: 1000, unit: 'mm' },
    { key: 'marginRight', label: '오른쪽 여백', kind: 'number', value: mm(para.marginRight), min: -1000, max: 1000, unit: 'mm' },
    { key: 'indent', label: '첫 줄 들여쓰기', kind: 'number', value: mm(para.indent), min: -1000, max: 1000, unit: 'mm' },
    { key: 'spacingBefore', label: '문단 앞 간격', kind: 'number', value: mm(para.spacingBefore), min: 0, max: 1000, unit: 'mm' },
    { key: 'spacingAfter', label: '문단 뒤 간격', kind: 'number', value: mm(para.spacingAfter), min: 0, max: 1000, unit: 'mm' },
    { key: 'lineSpacing', label: percent ? '줄 간격' : '줄 간격(퍼센트가 아니어서 여기서는 바꿀 수 없음)', kind: 'number', value: percent ? finite(para.lineSpacing, 160) : finite(para.lineSpacing, 0), min: 0, max: 1000, unit: '%', enabledWhen: () => percent },
  ];
}

const characterProperties = (values: FormValues): CharacterFormatProperties => ({
  ...(String(values.fontFamily) ? { fontFamily: String(values.fontFamily) } : {}),
  fontSize: values.fontSize as number, bold: values.bold as boolean, italic: values.italic as boolean, underline: values.underline as boolean,
  strikethrough: values.strikethrough as boolean, textColor: values.textColor as string,
});
const paragraphProperties = (values: FormValues): ParagraphFormatProperties => ({
  alignment: values.alignment as ParagraphAlignment,
  marginLeft: millimetersToDoubledHwpUnits(values.marginLeft as number), marginRight: millimetersToDoubledHwpUnits(values.marginRight as number),
  indent: millimetersToDoubledHwpUnits(values.indent as number),
  spacingBefore: millimetersToHwpUnits(values.spacingBefore as number), spacingAfter: millimetersToHwpUnits(values.spacingAfter as number),
  lineSpacingType: 'Percent', lineSpacing: values.lineSpacing as number,
});

/** Command for the dialog values, sending only the formatting that differs from the dialog's initial values. Undefined when nothing changed. */
export function styleCommand(mode: 'create' | 'edit', styleId: number | undefined, values: FormValues, initial: FormValues, current?: StyleDefinition): Command | undefined {
  const characterChanges = changedProperties(characterProperties(values), characterProperties(initial));
  const percentOnly = mode === 'create' || current?.detail.paraProps.lineSpacingType === 'Percent';
  const rawParagraph = changedProperties(paragraphProperties(values), paragraphProperties(initial));
  const { lineSpacing, lineSpacingType, ...otherParagraph } = rawParagraph;
  const paragraphChanges: ParagraphFormatProperties = percentOnly && lineSpacing !== undefined ? { ...otherParagraph, lineSpacing, lineSpacingType: 'Percent' } : otherParagraph;
  void lineSpacingType;
  const nextStyleId = values.nextStyleId === 'self' ? undefined : Number(values.nextStyleId);
  const common = {
    ...(Object.keys(characterChanges).length ? { characterProperties: characterChanges } : {}),
    ...(Object.keys(paragraphChanges).length ? { paragraphProperties: paragraphChanges } : {}),
  };
  if (mode === 'create') {
    return { type: 'createStyle', name: String(values.name), ...(String(values.englishName) ? { englishName: String(values.englishName) } : {}),
      kind: values.kind as 'paragraph' | 'character', ...(nextStyleId === undefined ? {} : { nextStyleId }), ...common };
  }
  const changes: Extract<Command, { type: 'updateStyle' }> = { type: 'updateStyle', styleId: styleId!, ...common };
  if (values.name !== initial.name) changes.name = String(values.name);
  if (values.englishName !== initial.englishName) changes.englishName = String(values.englishName);
  if (values.nextStyleId !== initial.nextStyleId && nextStyleId !== undefined) changes.nextStyleId = nextStyleId;
  return Object.keys(changes).length > 2 ? changes : undefined;
}

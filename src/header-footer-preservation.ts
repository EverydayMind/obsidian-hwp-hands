import type { CharacterProperties, CharacterRun, HeaderFooterDynamicField } from './api';

export interface PreservedCharacterRun {
  offset: number;
  length: number;
  text: string;
  properties: CharacterProperties;
  source: CharacterRun['source'];
  fieldStyles?: CharacterProperties[];
}

function propertiesKey(properties: CharacterProperties): string {
  return JSON.stringify(Object.fromEntries(Object.entries(properties).sort(([left], [right]) => left.localeCompare(right))));
}

/** Collapse a native field's variable display text to its edit token while retaining every style span. */
export function normalizeHeaderFooterCharacterRuns(
  runs: CharacterRun[], fields: HeaderFooterDynamicField[], textValue: string,
): PreservedCharacterRun[] {
  const chars = Array.from(textValue), textLength = chars.length;
  const styles = Array<{ properties: CharacterProperties; source: CharacterRun['source'] } | undefined>(textLength);
  for (const run of runs) {
    const text = Array.from(run.text);
    if (!Number.isSafeInteger(run.offset) || run.offset < 0 || run.length !== text.length || run.offset + run.length > textLength) {
      throw new Error('머리말·꼬리말 문자 서식 범위가 원문과 맞지 않습니다.');
    }
    for (let index = 0; index < text.length; index++) {
      const offset = run.offset + index;
      if (styles[offset]) throw new Error('머리말·꼬리말 문자 서식 범위가 겹칩니다.');
      styles[offset] = { properties: run.properties, source: run.source };
    }
  }
  if (styles.some(style => !style)) throw new Error('머리말·꼬리말 문자 서식 조회 범위가 완전하지 않습니다.');

  const ordered = [...fields].sort((left, right) => left.start - right.start || left.end - right.end);
  let priorEnd = 0;
  for (const field of ordered) {
    if (!Number.isSafeInteger(field.start) || !Number.isSafeInteger(field.end) || field.start < priorEnd || field.end <= field.start || field.end > textLength || Array.from(field.marker).length !== 1) {
      throw new Error('머리말·꼬리말 동적 필드 범위가 올바르지 않습니다.');
    }
    priorEnd = field.end;
  }

  const result: PreservedCharacterRun[] = [];
  let inputOffset = 0;
  const appendText = (value: string, style: NonNullable<typeof styles[number]>): void => {
    const previous = result.at(-1);
    if (previous && !previous.fieldStyles && previous.offset + previous.length === resultLength(result)
      && previous.source === style.source && propertiesKey(previous.properties) === propertiesKey(style.properties)) {
      previous.text += value;
      previous.length += Array.from(value).length;
      return;
    }
    result.push({ offset: resultLength(result), length: Array.from(value).length, text: value, properties: style.properties, source: style.source });
  };
  for (const field of ordered) {
    while (inputOffset < field.start) {
      appendText(chars[inputOffset], styles[inputOffset]!);
      inputOffset++;
    }
    const fieldStyles: CharacterProperties[] = [];
    let previousKey: string | undefined;
    for (let offset = field.start; offset < field.end; offset++) {
      const properties = styles[offset]!.properties;
      const key = propertiesKey(properties);
      if (key !== previousKey) fieldStyles.push(properties);
      previousKey = key;
    }
    result.push({ offset: resultLength(result), length: 1, text: field.marker, properties: styles[field.start]!.properties, source: styles[field.start]!.source, fieldStyles });
    inputOffset = field.end;
  }
  while (inputOffset < textLength) {
    appendText(chars[inputOffset], styles[inputOffset]!);
    inputOffset++;
  }
  return result;
}

function resultLength(runs: PreservedCharacterRun[]): number {
  return runs.reduce((length, run) => length + run.length, 0);
}

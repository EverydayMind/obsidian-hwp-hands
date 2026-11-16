import { getLocale, type Locale } from './locale';

/** Persisted vocabulary: writers and bilingual readers share these exact pairs. */
export const INDEX_FORMATS = {
  sourceLink: { ko: '원본 문서 열기', en: 'Open the source document' },
  notice: { ko: '> 자동 생성한 검색용 인덱스입니다. 원본 편집은 HWP Hands에서 수행하세요.', en: '> Automatically generated search index. Edit the source document in HWP Hands.' },
  body: { ko: '## 본문', en: '## Body' },
  table: { ko: '## 표', en: '## Table' },
  fields: { ko: '## 필드', en: '## Fields' },
  header: { ko: '머리말', en: 'Header' },
  footer: { ko: '꼬리말', en: 'Footer' },
  textBox: { ko: '글상자', en: 'Text box' },
  footnote: { ko: '각주', en: 'Footnote' },
  endnote: { ko: '미주', en: 'Endnote' },
  section: { ko: (number: number) => `${number}구역`, en: (number: number) => `Section ${number}` },
  cell: { ko: (row: number, col: number) => `${row}행 ${col}열`, en: (row: number, col: number) => `Row ${row}, Column ${col}` },
} as const;

export function indexFormat(locale: Locale = getLocale()) {
  return Object.fromEntries(Object.entries(INDEX_FORMATS).map(([key, pair]) => [key, pair[locale]])) as {
    [K in keyof typeof INDEX_FORMATS]: (typeof INDEX_FORMATS)[K][Locale];
  };
}

/** Only inspect structural link labels, never user document prose. */
export function sourceLinkLocale(line: string): Locale | undefined {
  return (['ko', 'en'] as const).find(locale => line.startsWith(`[${INDEX_FORMATS.sourceLink[locale]}](`));
}

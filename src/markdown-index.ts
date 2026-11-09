import { createHash } from 'node:crypto';
import type { DocumentStory, Field, Paragraph, State, StoryParagraph, Table } from './api';

export const INDEX_MARKER = '<!-- hwp-hands:index:v2';
const INDEX_MARKER_PATTERN = /^<!-- (?:hwp-hands|hwp-editor):index:v2 sha256=([a-f0-9]{64}) -->$/;
const legacyMarker = (content: string): boolean => /(?:hwp-hands|hwp-editor):index:v1/.test(content);
const hashText = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const plain = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}[\]()#!|])/g, '\\$1');

export type IndexInspection =
  | { state: 'managed'; source: string; sourceSha256: string; integritySha256: string }
  | { state: 'modified' | 'legacy' | 'unmanaged' };

export interface IndexStatus {
  path: string;
  indexPath: string;
  state: 'missing' | 'current' | 'stale' | 'modified' | 'legacy' | 'unmanaged';
  sourceSha256: string;
  indexSourceSha256?: string;
}

export function inspectIndex(content: string): IndexInspection {
  const newline = content.indexOf('\n');
  if (newline < 0) return legacyMarker(content) ? { state: 'legacy' } : { state: 'unmanaged' };
  const marker = INDEX_MARKER_PATTERN.exec(content.slice(0, newline).replace(/\r$/, ''));
  if (!marker) {
    return legacyMarker(content) ? { state: 'legacy' }
      : content.includes(INDEX_MARKER) || content.includes('<!-- hwp-editor:index:v2') ? { state: 'modified' } : { state: 'unmanaged' };
  }
  const body = content.slice(newline + 1);
  if (hashText(body) !== marker[1]) return { state: 'modified' };
  const lines = body.split(/\r?\n/);
  const sourceLine = lines.find(line => line.startsWith('source: '));
  const hashLine = lines.find(line => line.startsWith('source_sha256: '));
  if (!sourceLine || !hashLine) return { state: 'modified' };
  try {
    const source: unknown = JSON.parse(sourceLine.slice('source: '.length));
    const sourceSha256: unknown = JSON.parse(hashLine.slice('source_sha256: '.length));
    if (typeof source !== 'string' || typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) return { state: 'modified' };
    return { state: 'managed', source, sourceSha256, integritySha256: marker[1] };
  } catch { return { state: 'modified' }; }
}

function wrapManagedIndex(body: string): string {
  return `<!-- hwp-hands:index:v2 sha256=${hashText(body)} -->\n${body}`;
}

function storyLabel(story: DocumentStory): string {
  if (story.kind === 'headerFooter') return `${story.isHeader ? '머리말' : '꼬리말'} · ${story.section + 1}구역`;
  if (story.kind === 'textBox') return `글상자 · ${story.section + 1}구역`;
  return `${story.kind === 'footnote' ? '각주' : '미주'} · ${story.section + 1}구역 · ${story.number ?? story.controlIndex + 1}`;
}

export function makeIndex(state: State, sourceHash: string, paragraphs: Paragraph[], tables: Table[], fields: Field[], stories: DocumentStory[] = []): string {
  const body = [
    '---', 'hwp_hands_index: 2', `source: ${JSON.stringify(state.path)}`, `source_sha256: ${JSON.stringify(sourceHash)}`,
    `format: ${state.format}`, `pages: ${state.pageCount}`, `indexed_at: ${JSON.stringify(new Date().toISOString())}`,
    '---', '', `# ${plain(state.path.split('/').at(-1)!)}`, '',
    `[원본 문서 열기](<${encodeURIComponent(state.path.split('/').at(-1)!)}>)`, '',
    '> 자동 생성한 검색용 인덱스입니다. 원본 편집은 HWP Hands에서 수행하세요.', '', '## 본문', ''
  ];
  for (const paragraph of paragraphs) body.push(`<!-- ${paragraph.nodePath} -->`, plain(paragraph.text), '');
  for (const [index, table] of tables.entries()) {
    body.push(`## 표 ${index + 1}`, '', `<!-- ${table.nodePath} -->`, '');
    for (const cell of table.cells) body.push(`- ${cell.row + 1}행 ${cell.col + 1}열 (${cell.rowSpan}×${cell.colSpan}): ${plain(cell.paragraphs.map(paragraph => paragraph.text).join(' / '))}`);
    body.push('');
  }
  if (fields.length) { body.push('## 필드', ''); for (const field of fields) body.push(`- ${plain(field.name)}: ${plain(field.value)}`); body.push(''); }
  for (const story of stories) {
    const paragraphs = story.paragraphs as Array<Paragraph | StoryParagraph>;
    if (!paragraphs.length) continue;
    body.push(`## ${plain(storyLabel(story))}`, '');
    for (const paragraph of paragraphs) body.push(`<!-- ${paragraph.nodePath} -->`, plain(paragraph.text), '');
  }
  return wrapManagedIndex(body.join('\n') + '\n');
}

/** Rebase a verified generated index after a source rename without touching its indexed text. */
export function rebaseIndex(content: string, source: string): string | undefined {
  const inspection = inspectIndex(content);
  if (inspection.state !== 'managed') return undefined;
  const newline = content.indexOf('\n'), lines = content.slice(newline + 1).split(/\r?\n/);
  const endFrontmatter = lines.indexOf('---', 1);
  if (endFrontmatter < 0) return undefined;
  const header = lines.slice(0, endFrontmatter + 1), body = lines.slice(endFrontmatter + 1);
  const sourceIndex = header.findIndex(line => line.startsWith('source: '));
  const titleIndex = body.findIndex(line => line.startsWith('# '));
  const linkIndex = body.findIndex(line => line.startsWith('[원본 문서 열기]('));
  if (sourceIndex < 0 || titleIndex < 0 || linkIndex < 0) return undefined;
  const basename = source.split('/').at(-1)!;
  header[sourceIndex] = `source: ${JSON.stringify(source)}`;
  body[titleIndex] = `# ${plain(basename)}`;
  body[linkIndex] = `[원본 문서 열기](<${encodeURIComponent(basename)}>)`;
  return wrapManagedIndex([...header, ...body].join('\n'));
}

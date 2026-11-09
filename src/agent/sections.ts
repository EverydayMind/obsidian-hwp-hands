import type { DocumentStory, HeaderFooterStory, Json, SectionPageSettings } from '../api';

export const sectionKey = (section: number): string => `section:${section}`;
/** Stable across revision stamps; includes logical dynamic fields rather than flattening them to display text. */
export function sectionView(settings: SectionPageSettings, stories: DocumentStory[]): { [key: string]: Json } {
  const headers = stories.filter((s): s is HeaderFooterStory => s.kind === 'headerFooter' && s.section === settings.section).map(s => ({
    isHeader: s.isHeader, applyTo: s.applyTo, label: s.label, paragraphs: s.paragraphs.map(p => ({
      text: p.text, length: p.length, ...(p.logicalText !== undefined ? { logicalText: p.logicalText } : {}),
      ...(p.dynamicFields ? { dynamicFields: p.dynamicFields } : {}),
    })),
  }));
  return JSON.parse(JSON.stringify({ ...settings, headers })) as { [key: string]: Json };
}

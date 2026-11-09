// Numbering shape presets for the "문단 번호 모양" dialog. Number format codes follow the HWP numbering table
// (0 digits, 1 circled digits, 2/3 upper/lower roman, 4/5 upper/lower latin, 8 Hangul syllables).
import type { Command } from '../../api';

export interface NumberingPreset { id: string; label: string; levelFormats: string[]; numberFormats: number[] }
export const NUMBERING_PRESETS: readonly NumberingPreset[] = [
  { id: 'outline', label: '1. 가. 1) 가) (1) (가) ①', levelFormats: ['^1.', '^2.', '^3)', '^4)', '(^5)', '(^6)', '^7'], numberFormats: [0, 8, 0, 8, 0, 8, 1] },
  { id: 'digits', label: '1. 1.1. 1.1.1.', levelFormats: ['^1.', '^1.^2.', '^1.^2.^3.', '^1.^2.^3.^4.', '^1.^2.^3.^4.^5.', '^1.^2.^3.^4.^5.^6.', '^1.^2.^3.^4.^5.^6.^7.'], numberFormats: [0, 0, 0, 0, 0, 0, 0] },
  { id: 'roman', label: 'I. A. 1. a. (1) (a) ①', levelFormats: ['^1.', '^2.', '^3.', '^4.', '(^5)', '(^6)', '^7'], numberFormats: [2, 4, 0, 5, 0, 5, 1] },
  { id: 'circled', label: '① ② ③ …', levelFormats: ['^1', '^2', '^3', '^4', '^5', '^6', '^7'], numberFormats: [1, 1, 1, 1, 1, 1, 1] },
  { id: 'hangul', label: '가. 나. 다. …', levelFormats: ['^1.', '^2.', '^3.', '^4.', '^5.', '^6.', '^7.'], numberFormats: [8, 8, 8, 8, 8, 8, 8] },
];

export function numberingPreset(id: string): NumberingPreset {
  const preset = NUMBERING_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error('알 수 없는 번호 모양입니다.');
  return preset;
}
export function numberingCommand(presetId: string, startNumber: number): Command {
  const preset = numberingPreset(presetId);
  return { type: 'createNumbering', levelFormats: [...preset.levelFormats], numberFormats: [...preset.numberFormats], startNumber };
}

import type { BodyAddress, CharacterRun, StyleDefinition } from '../api';

export const styleKey = (id: number): string => `style:${id}`;
export const styleText = (style: StyleDefinition): string => JSON.stringify(style);
export const runKey = (address: BodyAddress, run: Pick<CharacterRun, 'offset' | 'length'>): string =>
  JSON.stringify(['format', address.section, address.paragraph, address.cellPath ?? [], run.offset, run.length]);
export const runText = (run: CharacterRun): string => JSON.stringify(run.properties);

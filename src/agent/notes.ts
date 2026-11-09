import type { NoteAddress, NoteStory } from '../api';

/** Revision-bound coordinates, never a persistent document identifier. */
export const noteHandle = (epoch: { id: string }, note: Pick<NoteStory, 'kind' | 'section' | 'anchor' | 'controlIndex'>): string =>
  `${epoch.id}:${note.kind === 'footnote' ? 'fn' : 'en'}s${note.section + 1}p${note.anchor.paragraph + 1}c${note.controlIndex}`;
export const noteParagraphKey = (address: NoteAddress): string =>
  JSON.stringify(['note', address.kind, address.section, address.anchor.paragraph, address.anchor.cellPath ?? [], address.controlIndex, address.paragraph]);

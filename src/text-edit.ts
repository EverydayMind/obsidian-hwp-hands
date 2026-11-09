import type { CaretMotion, Command, DocumentAddress, Target, TextPosition } from './api';

export function shouldEnterStoryOnClick(kind: DocumentAddress['kind'], clickCount: number, alreadyEditing: boolean): boolean {
  const requiresDoubleClick = kind === 'headerFooter' || kind === 'footnote' || kind === 'endnote';
  return !requiresDoubleClick || alreadyEditing || clickCount >= 2;
}

export function caretMotionForKey(key: string, modifiers: { control?: boolean; shift?: boolean; alt?: boolean }): CaretMotion | undefined {
  if (modifiers.alt) return undefined;
  const control = !!modifiers.control;
  if (key === 'ArrowLeft') return control ? 'wordLeft' : 'left';
  if (key === 'ArrowRight') return control ? 'wordRight' : 'right';
  if (key === 'ArrowUp' && !control) return 'up';
  if (key === 'ArrowDown' && !control) return 'down';
  if (key === 'PageUp' && !control) return 'pageUp';
  if (key === 'PageDown' && !control) return 'pageDown';
  if (key === 'Home' && control) return 'documentStart';
  if (key === 'End' && control) return 'documentEnd';
  if (key === 'Home' && !control) return 'lineStart';
  if (key === 'End' && !control) return 'lineEnd';
  return undefined;
}

export function codePointOffsetFromUtf16(text: string, utf16Offset: number): number {
  const end = Math.max(0, Math.min(text.length, Math.trunc(utf16Offset)));
  let codeUnits = 0, codePoints = 0;
  for (const character of text) {
    const next = codeUnits + character.length;
    if (next > end) break;
    codeUnits = next; codePoints++;
  }
  return codePoints;
}

export function utf16OffsetFromCodePoint(text: string, codePointOffset: number): number {
  const target = Math.max(0, Math.trunc(codePointOffset));
  let codeUnits = 0, codePoints = 0;
  for (const character of text) {
    if (codePoints >= target) break;
    codeUnits += character.length; codePoints++;
  }
  return codeUnits;
}

export function inputReplacementRange(text: string, selectionStart: number, selectionEnd: number, overwrite: boolean): { start: number; end: number } {
  const start = Math.max(0, Math.min(text.length, Math.trunc(selectionStart)));
  const end = Math.max(start, Math.min(text.length, Math.trunc(selectionEnd)));
  if (!overwrite || start !== end) return { start, end };
  const codePoint = codePointOffsetFromUtf16(text, start);
  const boundary = utf16OffsetFromCodePoint(text, codePoint);
  if (boundary !== start) return { start, end };
  const next = utf16OffsetFromCodePoint(text, codePoint + 1);
  const nextCharacter = text.slice(start, next);
  if (!nextCharacter || nextCharacter === '\n' || nextCharacter === '\u2028' || nextCharacter === '\r') return { start, end };
  return { start, end: next };
}

export function siblingAddress(address: DocumentAddress, delta: number): DocumentAddress | undefined {
  if (!Number.isInteger(delta)) return undefined;
  if (address.kind === 'body' && address.cellPath?.length) {
    const cellPath = address.cellPath.map(step => ({ ...step }));
    const last = cellPath.at(-1)!;
    if (last.cellParaIndex + delta < 0) return undefined;
    cellPath[cellPath.length - 1] = { ...last, cellParaIndex: last.cellParaIndex + delta };
    return { ...address, cellPath };
  }
  const paragraph = address.paragraph + delta;
  return paragraph < 0 ? undefined : { ...address, paragraph };
}

export function normalizeEditorText(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function clipboardHtmlForText(value: string): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<p>${escaped.replace(/\r\n?|\n|\u2028/g, '<br>')}</p>`;
}

/** RHWP paragraph text uses `\n` for a forced line break. The textarea uses U+2028 to distinguish it from Enter. */
export function editorTextFromModel(value: string): string { return value.replace(/\n/g, '\u2028'); }
function modelTextFromEditor(value: string): string { return value.replace(/\u2028/g, '\n'); }

function commandTarget(address: DocumentAddress): DocumentAddress | Target {
  if (address.kind !== 'body') return address;
  return {
    section: address.section,
    paragraph: address.paragraph,
    ...(address.cellPath ? { cellPath: address.cellPath.map(step => ({ ...step })) } : {}),
    ...(address.containerKinds ? { containerKinds: [...address.containerKinds] } : {}),
  };
}

export function paragraphEditCommands(
  address: DocumentAddress,
  original: string,
  value: string,
  characterProperties?: Extract<Command, { type: 'insertText' }>['characterProperties'],
): Command[] {
  const next = normalizeEditorText(value), editorOriginal = editorTextFromModel(original);
  if (next === editorOriginal) return [];
  const before = Array.from(editorOriginal), after = Array.from(next);
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before.at(-1 - suffix) === after.at(-1 - suffix)) suffix++;
  const removed = before.slice(prefix, before.length - suffix).join('');
  const inserted = after.slice(prefix, after.length - suffix).join('');
  const inlineCommands = (target: DocumentAddress | Target, offset: number, text: string): Command[] => {
    const commands: Command[] = [];
    let cursor = offset;
    const segments = text.split('\u2028');
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      if (segment) commands.push({ type: 'insertText', target, offset: cursor, text: segment, ...(characterProperties ? { characterProperties: { ...characterProperties } } : {}) });
      cursor += Array.from(segment).length;
      if (index < segments.length - 1) { commands.push({ type: 'insertLineBreak', target, offset: cursor }); cursor++; }
    }
    return commands;
  };
  if (!inserted.includes('\n')) {
    if (removed.length === 0) return inlineCommands(commandTarget(address), prefix, inserted);
    if (address.kind === 'body' && inserted.length === 0) return [{ type: 'deleteText', target: commandTarget(address), offset: prefix, count: Array.from(removed).length }];
    return [{ type: 'replaceParagraph', target: address, text: modelTextFromEditor(next), expectedText: original }];
  }
  if (address.kind === 'body' && address.containerKinds?.includes('textBox')) {
    return [{ type: 'replaceParagraph', target: address, text: modelTextFromEditor(next), expectedText: original }];
  }

  const lines = inserted.split('\n'), commands: Command[] = [];
  if (removed) commands.push({ type: 'replaceParagraph', target: address, text: modelTextFromEditor(before.slice(0, prefix).concat(before.slice(before.length - suffix)).join('')), expectedText: original });
  for (let index = 0; index < lines.length; index++) {
    const target = siblingAddress(address, index);
    if (!target) throw new Error('문단 위치를 계산하지 못했습니다.');
    const text = lines[index];
    commands.push(...inlineCommands(target, index === 0 ? prefix : 0, text));
    if (index < lines.length - 1) commands.push({ type: 'splitParagraph', target, offset: (index === 0 ? prefix : 0) + Array.from(text).length });
  }
  if (commands.length > 500) throw new Error('한 번에 붙여 넣을 문단이 너무 많습니다 (최대 250개).');
  return commands;
}

export function positionAfterEditorText(address: DocumentAddress, value: string, utf16Caret: number): TextPosition {
  const next = normalizeEditorText(value), prefix = next.slice(0, Math.max(0, Math.min(next.length, utf16Caret)));
  const beforeCaret = Array.from(prefix), splitAt = beforeCaret.lastIndexOf('\n');
  if (address.kind === 'body' && address.containerKinds?.includes('textBox')) return { address, offset: beforeCaret.length };
  const paragraphDelta = beforeCaret.filter(character => character === '\n').length;
  const target = siblingAddress(address, paragraphDelta);
  if (!target) throw new Error('편집 후 문단 위치를 계산하지 못했습니다.');
  const offset = beforeCaret.length - splitAt - 1;
  return { address: target, offset };
}

import type { CharacterFormatProperties, CharacterProperties, CharacterRun } from '../../api';
import { scriptCategory } from '../../font-language';

/** Display properties use CSS pixels for fontSize, unlike model character properties (points). */
export interface PreviewSpan { text: string; start: number; end: number; properties: CharacterProperties }
export interface PreviewText { text: string; composition?: { start: number; end: number } }
/** The receiver range an IME composition replaces, in UTF-16 offsets of `baseText`, and the text composed so far. */
export interface ImeCompositionRange { start: number; end: number; text: string; baseText: string }
export function compositionPreview(base: string, start: number, end: number, text: string): PreviewText {
  const low = Math.max(0, Math.min(base.length, start, end)), high = Math.max(low, Math.min(base.length, Math.max(start, end)));
  return { text: base.slice(0, low) + text + base.slice(high), composition: { start: low, end: low + text.length } };
}

/** The part of `spans` inside UTF-16 `[from, to)`, with offsets rebased to `from`. */
export function sliceSpans(spans: readonly PreviewSpan[], from: number, to = Infinity): PreviewSpan[] {
  return spans.filter(span => span.end > from && span.start < to).map(span => {
    const start = Math.max(span.start, from), end = Math.min(span.end, to);
    return { text: span.text.slice(start - span.start, end - span.start), start: start - from, end: end - from, properties: span.properties };
  });
}

const displayProperties =(properties: CharacterProperties): CharacterProperties => {
  const relative = properties.relativeSizes?.[0];
  return { ...properties, ...(properties.fontSize === undefined ? {}
    : { fontSize: properties.fontSize * 96 / 72 * (typeof relative === 'number' && relative > 0 ? relative / 100 : 1) }) };
};

/** Model runs and pending sizes are points (scaled by the run's relative size); layout fallback is already CSS pixels. Offsets returned are UTF-16. */
export function previewSpans(base: string, value: string, runs: readonly CharacterRun[], fallback: CharacterProperties = {}, pending?: CharacterFormatProperties): PreviewSpan[] {
  const before = Array.from(base), after = Array.from(value);
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const ordered = runs.map(run => ({ ...run, properties: { ...fallback, ...displayProperties(run.properties) } })).sort((a, b) => a.offset - b.offset);
  const insertionRun = ordered.find(run => prefix >= run.offset && prefix < run.offset + run.length)
    ?? [...ordered].reverse().find(run => run.offset + run.length <= prefix);
  const inserted: CharacterProperties = { ...fallback, ...insertionRun?.properties, ...(pending ? displayProperties(pending) : {}) };
  const insertedByLanguage = new Map<number, CharacterProperties>();
  const spans: PreviewSpan[] = [];
  let runIndex = 0, utf16 = 0;
  for (let index = 0; index < after.length; index++) {
    const original = index < prefix ? index : index >= after.length - suffix ? before.length - after.length + index : undefined;
    if (original !== undefined) while (runIndex < ordered.length && ordered[runIndex].offset + ordered[runIndex].length <= original) runIndex++;
    const run = original !== undefined ? ordered[runIndex] : undefined;
    let properties = original === undefined ? inserted : run && original >= run.offset ? run.properties : fallback;
    if (original === undefined && inserted.fontFamilies && !(pending?.fontFamily && pending.fontLanguage === undefined)) {
      const language = scriptCategory(after[index].codePointAt(0)!);
      let resolved = insertedByLanguage.get(language);
      if (!resolved) {
        resolved = { ...inserted, fontFamily: pending?.fontLanguage === language ? pending.fontFamily : inserted.fontFamilies[language] ?? inserted.fontFamily };
        insertedByLanguage.set(language, resolved);
      }
      properties = resolved;
    }
    const text = after[index], previous = spans.at(-1);
    if (previous?.properties === properties) { previous.text += text; previous.end += text.length; }
    else spans.push({ text, start: utf16, end: utf16 + text.length, properties });
    utf16 += text.length;
  }
  return spans;
}

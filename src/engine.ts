import { scriptCategory } from './font-language';
import init, { HwpDocument } from '@rhwp/core';
import { canvasScale, type CanvasPage } from './canvas-page';
import { ENGINE_VERSION, imageBase64ByteLength, integer } from './engine-common';
import type { MeasuredTab, TabSpot } from './tab-widths';
import { FORMULA_FORMATS, MAX_FORMULA_LENGTH, formatFormulaResult, formulaReferences } from './table-formula';
import { formattingUnavailableReason, selectionContainerKey, selectionParagraphIndex } from './ui/editor/selection-segments';
export { ENGINE_VERSION, imageBase64ByteLength, integer, MAX_IMAGE_BYTES } from './engine-common';
import type {
  BodyAddress, BulletDefinition, CaretContext, CaretMotion, CaretQueryOptions, CaretQueryResult, CaretRect, Cell, CharacterProperties, CharacterRun, Command, ContainerKind, Control, EndnoteShapeProperties,
  DocumentAddress, DocumentObject, DocumentSnapshot, DocumentStory, DocumentTree, EquationProperties, Field, Format,
  CellProperties, CopiedSelection, EditableObjectTarget, FormattingModel, HeaderFooterAddress, Json, LayoutControl, LayoutTextRun, NativeParagraphShape, NodeSelection, NodeSelector,
  HitTestResult, HeaderFooterDynamicField, NoteAddress, NumberingDefinition, ObjectResource, ObjectResourceTarget, PageInfo, PageLayout, PagePoint, PageRenderOptions, PageSettingsProperties,
  Paragraph, ParagraphFormatting, ParagraphProperties, PictureProperties, SearchMatch, SectionPageSettings, TableCellProperties,
  ParagraphList, ShapeProperties, SnapshotOptions, StoryParagraph, StorySearchMatch, StyleDefinition, StyleReference, TableProperties, TextPosition, TextSelection, TextSelectionTarget, TextTarget,
  SelectionRange, SelectionRect, Table, Target, TextBoxStory,
  Bookmark, ColumnSettingsProperties, PageBorderFillProperties, PageHideEntry, PageHideProperties, SectionDefinitionProperties,
} from './api';
import { HwpHandsError } from './api';
import { hitTestPage, layoutSelectionRects } from './page-hit-test';
import { normalizeHeaderFooterCharacterRuns } from './header-footer-preservation';
import { parseNoteInfo } from './note-json';
import { REWRITE_DIFF_VERSION, rewriteDiff, rewriteHunks, rewriteShapeRuns, type RewriteShapeRun } from './agent/rewrite-diff';

const MAX_PASTE_HTML_BYTES = 1_048_576;

type CursorList = {
  listId: number; isCell: boolean; hostListId: number; sectionIndex: number; hostPara: number;
  controlIndex: number; cellIndex: number; paraCount: number; row?: number; col?: number;
  rowSpan?: number; colSpan?: number; cellCount?: number;
};
type CursorModel = { lists: CursorList[] };
/** Section/column definitions and page-hide controls: their order inside a paragraph head differs between HWP and HWPX. */
const HEAD_STRUCTURE_CONTROLS: ReadonlySet<string> = new Set(['secd', 'cold', 'pghd']);
type RawControl = { ctrlId: string; ctrlCh: number; userDesc: string; list: number; para: number; pos: number; controlIndex: number; props: Record<string, Json> };
type RawObject = { para: number; controlIndex: number; kind: string; listId: number | null; anchored: boolean };
type RawLayoutTextRun = {
  text: string; x: number; y: number; w: number; h: number; charX?: number[]; fontFamily?: string;
  fontSize?: number; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean;
  textColor?: string; charShapeId?: number; paraShapeId?: number; secIdx?: number; paraIdx?: number;
  charStart?: number; parentParaIdx?: number; cellPath?: Target['cellPath'];
};
type RawLayoutControls = { controls?: Array<Record<string, unknown>> };
type StructuralModel = { starts: number[]; lists: CursorList[]; byListId: Map<number, CursorList> };
/** HWP table caption directions as the engine numbers them. */
const TABLE_CAPTION_DIRECTIONS: Readonly<Record<number, 'Left' | 'Right' | 'Top' | 'Bottom'>> = { 0: 'Left', 1: 'Right', 2: 'Top', 3: 'Bottom' };
function signedInteger(value: number, label: string, limit = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || Math.abs(value) > limit) throw new HwpHandsError('INVALID_ARGUMENT', `${label} 범위가 올바르지 않습니다: ${value}`);
}
function text(value: string): void {
  if (typeof value !== 'string' || value.length > 1_000_000 || value.includes('\0')) throw new HwpHandsError('INVALID_ARGUMENT', '텍스트가 올바르지 않습니다.');
}
export function nodePath(target: Target): string {
  return `sec[${target.section}]/para[${target.paragraph}]` + (target.cellPath ?? []).map((p, index) => target.containerKinds?.[index] === 'textBox'
    ? `/ctrl[${p.controlIndex}]/textbox/para[${p.cellParaIndex}]`
    : `/ctrl[${p.controlIndex}]/cell[${p.cellIndex}]/para[${p.cellParaIndex}]`).join('');
}
function parsed<T>(value: string): T { return JSON.parse(value) as T; }
function sameNoteStory(left: NoteAddress, right: NoteAddress): boolean {
  return left.kind === right.kind && left.section === right.section && left.controlIndex === right.controlIndex
    && nodePath(left.anchor) === nodePath(right.anchor);
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
function plainTextHtml(value: string): string { return value.split(/\r?\n/).map(part => `<p>${escapeHtml(part)}</p>`).join(''); }
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (!sameJsonValue(left[index], right[index])) return false;
    return true;
  }
  const leftRecord = left as Record<string, unknown>, rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key) || !sameJsonValue(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}
/** Character properties read for model runs, keyed by character shape and script category. */
interface ModelRunShapes { byKey: Map<string, CharacterProperties>; distinct: CharacterProperties[] }
function sameCharacterProperties(left: CharacterProperties, right: CharacterProperties): boolean {
  return sameJsonValue(left, right);
}
function checked(value: string): Record<string, Json> {
  const result = parsed<Record<string, Json>>(value);
  if (result.ok === false) { const detail = result.error ?? result.message ?? '문서 편집 실패'; throw new HwpHandsError('ENGINE_ERROR', typeof detail === 'object' ? JSON.stringify(detail) : String(detail), result); }
  return result;
}
function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HwpHandsError('INVALID_ARGUMENT', `${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).length) throw new HwpHandsError('INVALID_ARGUMENT', `${label} must contain at least one property.`);
  return record;
}
function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new HwpHandsError('INVALID_ARGUMENT', `${label} has unsupported properties: ${unknown.join(', ')}.`);
}
function hexColor(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^#?[\da-f]{6}$/i.test(value)) throw new HwpHandsError('INVALID_ARGUMENT', `${label} must use #RRGGBB.`);
  return `#${value.replace(/^#/, '').toLowerCase()}`;
}
function colorNumber(value: string): number { return Number.parseInt(hexColor(value, 'color').slice(1), 16); }
function colorString(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? `#${Math.max(0, Math.trunc(value)).toString(16).padStart(6, '0').slice(-6)}` : undefined;
}
function decodeImageBase64(value: unknown): Uint8Array {
  const expectedBytes = imageBase64ByteLength(value);
  if (typeof value !== 'string') throw new HwpHandsError('INVALID_ARGUMENT', 'imageBase64 must be a string.');
  let binary: string;
  try { binary = atob(value); } catch { throw new HwpHandsError('INVALID_ARGUMENT', 'imageBase64 is not valid base64.'); }
  if (binary.length !== expectedBytes || btoa(binary) !== value) throw new HwpHandsError('INVALID_ARGUMENT', 'imageBase64 is not canonical base64.');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
function validateImageSignature(bytes: Uint8Array, extension: string): void {
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  const gif = bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6)));
  const bmp = bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
  const normalized = extension.toLowerCase() === 'jpeg' ? 'jpg' : extension.toLowerCase();
  if (!(normalized === 'jpg' && jpeg || normalized === 'png' && png || normalized === 'gif' && gif || normalized === 'bmp' && bmp)) {
    throw new HwpHandsError('INVALID_ARGUMENT', 'The image bytes do not match the declared PNG, JPG, GIF or BMP extension.');
  }
}
let initialization: Promise<void> | undefined;
export async function initializeEngine(readWasm: () => Promise<Uint8Array>): Promise<void> {
  if (!initialization) initialization = (async () => { await init({ module_or_path: await readWasm() }); })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}

/** Internal adapter. No raw WASM object escapes through the public API. */
export class RhwpEngine {
  private currentFileName = '';
  constructor(private readonly document: HwpDocument) {}
  static parse(bytes: Uint8Array): RhwpEngine { return new RhwpEngine(new HwpDocument(bytes)); }
  static blank(): RhwpEngine {
    const doc = HwpDocument.createEmpty();
    try { doc.createBlankDocument(); return new RhwpEngine(doc); } catch (error) { doc.free(); throw error; }
  }
  private readonly memo = new Map<string, unknown>();
  private mutating = 0;
  free(): void { this.memo.clear(); this.document.free(); }
  snapshot(): number { return this.document.saveSnapshot(); }
  restore(id: number): void { this.memo.clear(); try { checked(this.document.restoreSnapshot(id)); } finally { this.memo.clear(); } }
  discard(id: number): void { this.document.discardSnapshot(id); }
  pages(): number { return this.document.pageCount(); }
  /**
   * A fingerprint of where the engine put a page's text. Equal fingerprints before and after an edit mean the page, and
   * so every page after it, was laid out the same. Undefined for a page without text, which cannot show that.
   */
  pageTextSignature(page: number): string | undefined {
    if (!Number.isSafeInteger(page) || page < 0 || page >= this.document.pageCount()) return undefined;
    let layout: string;
    try { layout = this.document.getPageTextLayout(page); } catch { return undefined; }
    if (!layout.includes('"text"')) return undefined;
    let low = 0x811c9dc5, high = 0x01000193;
    for (let index = 0; index < layout.length; index++) {
      const code = layout.charCodeAt(index);
      low = Math.imul(low ^ code, 0x01000193); high = Math.imul(high + code, 0x85ebca6b) ^ (high >>> 13);
    }
    return `${layout.length}:${(low >>> 0).toString(16)}:${(high >>> 0).toString(16)}`;
  }
  pageOfPosition(target: Target): number | undefined {
    if (!target || !Number.isSafeInteger(target.section) || !Number.isSafeInteger(target.paragraph)) return undefined;
    try {
      const result = parsed<{ ok?: boolean; page?: number }>(this.document.getPageOfPosition(target.section, target.paragraph));
      return result.ok === true && Number.isSafeInteger(result.page) && (result.page as number) >= 0 ? result.page : undefined;
    } catch { return undefined; }
  }
  metadata(): Record<string, Json> { return parsed(this.document.getDocumentInfo()); }
  renderEquationPreview(script: string, fontSize = 1200, color = 0x202020): string {
    if (typeof script !== 'string' || script.length > 4096 || script.includes('\0')) throw new HwpHandsError('INVALID_ARGUMENT', 'Equation script must be at most 4096 characters.');
    integer(fontSize, 'fontSize', 100_000);
    if (fontSize < 100) throw new HwpHandsError('INVALID_ARGUMENT', 'fontSize must be 1–1000pt.');
    integer(color, 'color', 0xffffff);
    const svg = this.document.renderEquationPreview(script, fontSize, color);
    if (typeof svg !== 'string' || svg.length > 1_048_576 || !/^\s*<svg\b/i.test(svg)) throw new HwpHandsError('ENGINE_ERROR', 'The equation preview renderer returned invalid SVG.');
    return svg;
  }
  private structuralModel(): StructuralModel {
    const starts = [0];
    for (let section = 0; section < this.document.getSectionCount(); section++) starts.push(starts[section] + this.document.getParagraphCount(section));
    const lists = parsed<CursorModel>(this.document.getCursorModel()).lists;
    return { starts, lists, byListId: new Map(lists.map(list => [list.listId, list])) };
  }
  private rootTarget(globalParagraph: number, model: StructuralModel): Target {
    for (let section = model.starts.length - 2; section >= 0; section--) {
      if (globalParagraph >= model.starts[section]) return { section, paragraph: globalParagraph - model.starts[section] };
    }
    throw new HwpHandsError('ENGINE_ERROR', `RHWP root paragraph is outside all document sections: ${globalParagraph}`);
  }
  private addressForListParagraph(listId: number, paragraph: number, model: StructuralModel, depth = 0, sectionHint?: number): BodyAddress {
    if (depth > 32) throw new HwpHandsError('ENGINE_ERROR', 'Document list nesting exceeds the supported depth.');
    if (listId === 0) return { ...(sectionHint === undefined ? this.rootTarget(paragraph, model) : { section: sectionHint, paragraph }), kind: 'body' };
    const list = model.byListId.get(listId);
    if (!list) throw new HwpHandsError('ENGINE_ERROR', `RHWP list address is missing: ${listId}`);
    const host = this.addressForListParagraph(list.hostListId, list.hostPara, model, depth + 1, list.sectionIndex);
    const kind: ContainerKind = list.isCell ? 'tableCell' : 'textBox';
    return {
      ...host,
      cellPath: [...(host.cellPath ?? []), { controlIndex: list.controlIndex, cellIndex: list.cellIndex, cellParaIndex: paragraph }],
      containerKinds: [...(host.containerKinds ?? []), kind],
      kind: 'body',
    };
  }
  private inferContainerKinds(target: Target, model: StructuralModel): ContainerKind[] {
    if (!target.cellPath?.length) return [];
    const kinds: ContainerKind[] = [];
    let listId = 0;
    let paragraph = target.paragraph;
    for (const step of target.cellPath) {
      const list = model.lists.find(item => item.hostListId === listId && item.sectionIndex === target.section && item.hostPara === paragraph && item.controlIndex === step.controlIndex && item.cellIndex === step.cellIndex);
      if (!list) return target.containerKinds ?? [];
      kinds.push(list.isCell ? 'tableCell' : 'textBox');
      listId = list.listId;
      paragraph = step.cellParaIndex;
    }
    return kinds;
  }
  private controlAddress(control: RawControl, model: StructuralModel): BodyAddress {
    return this.addressForListParagraph(control.list, control.para, model);
  }
  /** The memo is not part of the field list; the click-here properties call is the only place that returns it. */
  private clickHereMemo(raw: Record<string, unknown>): { memo?: string } {
    if (raw.fieldType !== 'clickhere' || typeof raw.fieldId !== 'number') return {};
    try {
      const props = parsed<{ ok?: boolean; memo?: unknown }>(this.document.getClickHereProps(raw.fieldId));
      return props.ok === false || typeof props.memo !== 'string' ? {} : { memo: props.memo };
    } catch { return {}; }
  }
  fields(model = this.structuralModel()): Field[] {
    return (parsed<Array<Record<string, unknown>>>(this.document.getFieldList())).map(listed => {
      const raw: Record<string, unknown> = { ...listed, ...this.clickHereMemo(listed) };
      const location = raw.location && typeof raw.location === 'object' ? raw.location as Record<string, unknown> : undefined;
      if (!location || typeof location.sectionIndex !== 'number' || typeof location.paraIndex !== 'number') return raw as Field;
      const path = Array.isArray(location.path) ? location.path as Array<Record<string, unknown>> : [];
      let address: BodyAddress = { section: location.sectionIndex, paragraph: location.paraIndex, kind: 'body' };
      if (path.length) {
        const steps = path.filter(step => step.type === 'cell' || step.type === 'textBox' || step.type === 'textbox');
        const cellPath = steps.map(step => ({ controlIndex: Number(step.controlIndex), cellIndex: Number(step.cellIndex ?? 0), cellParaIndex: Number(step.paraIndex ?? step.cellParaIndex) }));
        if (steps.length && cellPath.every(step => Number.isSafeInteger(step.controlIndex) && Number.isSafeInteger(step.cellIndex) && Number.isSafeInteger(step.cellParaIndex))) {
          address = { ...address, cellPath, containerKinds: steps.map(step => step.type === 'cell' ? 'tableCell' : 'textBox') };
        }
      }
      if (!address.cellPath?.length && typeof raw.listId === 'number' && typeof raw.paraInList === 'number' && model.byListId.has(raw.listId)) {
        address = this.addressForListParagraph(raw.listId, raw.paraInList, model);
      }
      return { ...raw, address, nodePath: nodePath(address) } as Field;
    });
  }
  private objectAddress(object: RawObject, model: StructuralModel, controls: RawControl[]): BodyAddress {
    const list = object.listId === null ? undefined : model.byListId.get(object.listId);
    if (list?.isCell) return this.addressForListParagraph(list.listId, object.para, model);
    if (list) return this.addressForListParagraph(list.hostListId, list.hostPara, model, 0, list.sectionIndex);
    const control = controls.find(item => item.para === object.para && item.controlIndex === object.controlIndex);
    if (control) return this.controlAddress(control, model);
    return { ...this.rootTarget(object.para, model), kind: 'body' };
  }
  objects(model = this.structuralModel(), includeDetails = true): DocumentObject[] {
    const controls = parsed<RawControl[]>(this.document.getControls());
    return parsed<RawObject[]>(this.document.getObjects()).map(object => {
      const address = this.objectAddress(object, model, controls);
      const result: DocumentObject = { ...object, address, anchor: address, nodePath: `${nodePath(address)}/ctrl[${object.controlIndex}]` };
      if (!includeDetails) return result;
      const path = JSON.stringify(address.cellPath ?? []);
      try {
        if (object.kind === 'picture') {
          const raw = address.cellPath?.length
            ? this.document.getCellPicturePropertiesByPath(address.section, address.paragraph, path, object.controlIndex)
            : this.document.getPictureProperties(address.section, address.paragraph, object.controlIndex);
          result.properties = parsed<PictureProperties>(raw);
          result.resource = { kind: 'image', mimeType: this.document.getControlImageMime(address.section, address.paragraph, path, object.controlIndex), availability: 'referenced' };
        } else if (object.kind === 'shape') {
          const raw = address.cellPath?.length
            ? this.document.getCellShapePropertiesByPath(address.section, address.paragraph, path, object.controlIndex)
            : this.document.getShapeProperties(address.section, address.paragraph, object.controlIndex);
          result.properties = parsed<ShapeProperties>(raw);
        } else if (object.kind === 'equation') {
          let raw: Record<string, Json> | undefined;
          if (!address.cellPath?.length) raw = parsed<Record<string, Json>>(this.document.getEquationProperties(address.section, address.paragraph, object.controlIndex, -1, -1));
          else if (address.cellPath.length === 1) {
            const host = address.cellPath[0];
            raw = parsed<Record<string, Json>>(this.document.getEquationProperties(address.section, address.paragraph, object.controlIndex, host.cellIndex, host.cellParaIndex));
          }
          if (raw) result.properties = {
            ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
            ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
            ...(typeof raw.treatAsChar === 'boolean' ? { treatAsChar: raw.treatAsChar } : {}),
            ...(typeof raw.script === 'string' ? { script: raw.script } : {}),
            ...(typeof raw.fontName === 'string' ? { fontName: raw.fontName } : {}),
            ...(typeof raw.fontSize === 'number' ? { fontSize: raw.fontSize / 100 } : {}),
            ...(colorString(raw.color) ? { color: colorString(raw.color)! } : {}),
          } satisfies EquationProperties;
        }
      } catch {
        result.resource = object.kind === 'picture' ? { kind: 'image', mimeType: 'application/octet-stream', availability: 'missing' } : result.resource;
      }
      return result;
    });
  }
  controls(model = this.structuralModel()): Control[] {
    const objectKinds = new Map(this.objects(model, false).map(object => [`${nodePath(object.address)}|${object.controlIndex}`, object.kind]));
    return (parsed<RawControl[]>(this.document.getControls())).map(control => {
      const address = this.controlAddress(control, model);
      const objectKind = objectKinds.get(`${nodePath(address)}|${control.controlIndex}`);
      return { ...control, address, nodePath: nodePath(address), ...(objectKind ? { objectKind } : {}) };
    });
  }
  outline(): Json { return parsed(this.document.getStructure('auto')); }
  allText(): string { return parsed<string>(this.document.getTextFileUnicode()); }
  private validateTarget(t: Target, model = this.structuralModel()): void {
    if (!t || typeof t !== 'object') throw new HwpHandsError('INVALID_ARGUMENT', '문단 주소가 필요합니다.');
    integer(t.section, 'section', this.document.getSectionCount() - 1);
    integer(t.paragraph, 'paragraph', this.document.getParagraphCount(t.section) - 1);
    if (t.cellPath !== undefined) {
      if (!Array.isArray(t.cellPath) || !t.cellPath.length || t.cellPath.length > 16) throw new HwpHandsError('INVALID_ARGUMENT', 'cellPath가 올바르지 않습니다.');
      let hostListId = 0, hostParagraph = t.paragraph;
      for (const [index, p] of t.cellPath.entries()) {
        integer(p.controlIndex, 'controlIndex'); integer(p.cellIndex, 'cellIndex'); integer(p.cellParaIndex, 'cellParaIndex');
        const list = model.lists.find(candidate => candidate.hostListId === hostListId && candidate.sectionIndex === t.section && candidate.hostPara === hostParagraph && candidate.controlIndex === p.controlIndex && candidate.cellIndex === p.cellIndex);
        if (!list || p.cellParaIndex >= list.paraCount) throw new HwpHandsError('INVALID_ARGUMENT', 'cellPath does not identify an existing cell paragraph.', { index, step: p });
        if (t.containerKinds?.[index] && t.containerKinds[index] !== (list.isCell ? 'tableCell' : 'textBox')) throw new HwpHandsError('INVALID_ARGUMENT', 'containerKinds does not match the addressed container.', { index });
        hostListId = list.listId; hostParagraph = p.cellParaIndex;
      }
      if (t.containerKinds && (t.containerKinds.length !== t.cellPath.length || t.containerKinds.some(kind => kind !== 'tableCell' && kind !== 'textBox'))) throw new HwpHandsError('INVALID_ARGUMENT', 'containerKinds must correspond to every cellPath step.');
    } else if (t.containerKinds?.length) {
      throw new HwpHandsError('INVALID_ARGUMENT', 'containerKinds requires a cellPath.');
    }
  }
  paragraph(t: Target, model = this.structuralModel()): Paragraph {
    const normalized: Target = { ...structuredClone(t), ...(t.cellPath && !t.containerKinds ? { containerKinds: this.inferContainerKinds(t, model) } : {}) };
    this.validateTarget(normalized, model);
    const d = this.document, path = JSON.stringify(normalized.cellPath);
    const length = normalized.cellPath ? d.getCellParagraphLengthByPath(normalized.section, normalized.paragraph, path) : d.getParagraphLength(normalized.section, normalized.paragraph);
    const value = normalized.cellPath ? d.getTextInCellByPath(normalized.section, normalized.paragraph, path, 0, length) : d.getTextRange(normalized.section, normalized.paragraph, 0, length);
    // Nested-cell paragraph formatting is read via the resolved list context only when supported.
    const properties = normalized.cellPath ? {} : parsed<Record<string, Json>>(d.getParaPropertiesAt(normalized.section, normalized.paragraph));
    const address: BodyAddress = { ...structuredClone(normalized), kind: 'body' };
    return { ...normalized, kind: 'body', address, nodePath: nodePath(normalized), text: value, length, properties };
  }
  private paragraphAt(target: TextTarget, model = this.structuralModel()): Paragraph | StoryParagraph {
    if (!target || typeof target !== 'object') throw new HwpHandsError('INVALID_ARGUMENT', 'A text address is required.');
    const kind = (target as { kind?: unknown }).kind;
    if (kind === undefined || kind === 'body') return this.paragraph(target, model);
    if (kind !== 'headerFooter' && kind !== 'footnote' && kind !== 'endnote') throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported text address kind.');
    const storyTarget = target as HeaderFooterAddress | NoteAddress;
    const key = this.addressKey(storyTarget), matches = (this.paragraphList(true, true, model) as Array<Paragraph | StoryParagraph>).filter(item => this.addressKey(item.address) === key);
    if (matches.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', matches.length ? 'The story paragraph address is ambiguous.' : 'The story paragraph is unavailable in this document.');
    return matches[0];
  }
  /**
   * Whole-document lists are rebuilt from the engine one paragraph at a time, and a view reads several of them after every
   * edit. They are kept until the document next changes; while a command runs nothing is kept, since it may read between its own steps.
   */
  private memoized<T>(key: string, build: () => T): T {
    if (this.mutating) return build();
    if (!this.memo.has(key)) this.memo.set(key, build());
    return this.memo.get(key) as T;
  }
  private rootParagraphs(model = this.structuralModel()): Paragraph[][] { return this.memoized('roots', () => this.buildRootParagraphs(model)); }
  private buildRootParagraphs(model: StructuralModel): Paragraph[][] {
    return Array.from({ length: this.document.getSectionCount() }, (_, section) =>
      Array.from({ length: this.document.getParagraphCount(section) }, (_, paragraph) => this.paragraph({ section, paragraph }, model)));
  }
  private stories(model = this.structuralModel()): DocumentStory[] { return this.memoized('stories', () => this.buildStories(model)); }
  private buildStories(model: StructuralModel): DocumentStory[] {
    const d = this.document;
    const stories: DocumentStory[] = [];
    const controls = parsed<RawControl[]>(d.getControls());
    // A text box owns its text in cell 0; a shape caption is another non-cell list (cell 1) that the path-based text API rejects.
    for (const list of model.lists.filter(candidate => !candidate.isCell && candidate.cellIndex === 0)) {
      const anchor = this.addressForListParagraph(list.hostListId, list.hostPara, model);
      stories.push({
        kind: 'textBox', section: anchor.section, anchor, controlIndex: list.controlIndex,
        paragraphs: Array.from({ length: list.paraCount }, (_, paragraph) => this.paragraph(this.addressForListParagraph(list.listId, paragraph, model), model)),
      });
    }
    try {
      const headerFooterList = parsed<{ items?: Array<{ sectionIdx: number; isHeader: boolean; applyTo: number; label?: string }> }>(d.getHeaderFooterList(0, true, 0));
      for (const item of headerFooterList.items ?? []) {
        const headerFooter = parsed<{ exists?: boolean; paraCount?: number }>(d.getHeaderFooter(item.sectionIdx, item.isHeader, item.applyTo));
        if (headerFooter.exists === false) continue;
        const paragraphs: StoryParagraph[] = [];
        for (let paragraph = 0; paragraph < (headerFooter.paraCount ?? 0); paragraph++) {
          const info = parsed<{ text?: string; charCount?: number; logicalText?: string; dynamicFields?: HeaderFooterDynamicField[] }>(d.getHeaderFooterParaInfo(item.sectionIdx, item.isHeader, item.applyTo, paragraph));
          const address: HeaderFooterAddress = { kind: 'headerFooter', section: item.sectionIdx, isHeader: item.isHeader, applyTo: item.applyTo, paragraph };
          const value = info.text ?? '';
          paragraphs.push({ address, nodePath: `sec[${item.sectionIdx}]/${item.isHeader ? 'header' : 'footer'}[${item.applyTo}]/para[${paragraph}]`, text: value, length: info.charCount ?? Array.from(value).length, properties: {}, ...(info.logicalText !== undefined ? { logicalText: info.logicalText } : {}), ...(info.dynamicFields ? { dynamicFields: info.dynamicFields } : {}) });
        }
        stories.push({ kind: 'headerFooter', section: item.sectionIdx, isHeader: item.isHeader, applyTo: item.applyTo, label: item.label ?? '', paragraphs });
      }
    } catch { /* Some valid documents do not define header/footer lists. */ }
    for (const control of controls.filter(item => item.ctrlId === 'fn' || item.ctrlId === 'en')) {
      const anchor = this.controlAddress(control, model);
      if (anchor.cellPath?.length) {
        const kind = control.ctrlId === 'fn' ? 'footnote' : 'endnote';
        stories.push({ kind, section: anchor.section, anchor, controlIndex: control.controlIndex, availability: 'unsupportedNestedAnchor', paragraphs: [] });
        continue;
      }
      const note = parseNoteInfo<{ number?: number; texts?: string[] }>(d.getFootnoteInfo(anchor.section, anchor.paragraph, control.controlIndex));
      const kind = control.ctrlId === 'fn' ? 'footnote' : 'endnote';
      const paragraphs = (note.texts ?? []).map((value, paragraph): StoryParagraph => {
        const address: NoteAddress = { kind, section: anchor.section, anchor, controlIndex: control.controlIndex, paragraph };
        return { address, nodePath: `${nodePath(anchor)}/${kind}[${control.controlIndex}]/para[${paragraph}]`, text: value, length: Array.from(value).length, properties: {} };
      });
      stories.push({ kind, section: anchor.section, anchor, controlIndex: control.controlIndex, number: note.number, availability: 'available', paragraphs });
    }
    return stories;
  }
  paragraphs(): Paragraph[];
  paragraphs(includeCells: boolean): Paragraph[];
  paragraphs(includeCells: boolean, includeStories: true): Array<Paragraph | StoryParagraph>;
  paragraphs(includeCells = false, includeStories = false): Paragraph[] | Array<Paragraph | StoryParagraph> {
    return this.paragraphList(includeCells, includeStories, this.structuralModel());
  }
  paragraphRange(offset: number, limit: number): { items: Paragraph[]; total: number } {
    integer(offset, 'offset'); integer(limit, 'limit', 500);
    if (limit < 1 || !Number.isSafeInteger(offset + limit)) throw new HwpHandsError('INVALID_ARGUMENT', 'paragraph range is out of bounds.');
    const model = this.structuralModel(), sectionCount = this.document.getSectionCount();
    const counts = Array.from({ length: sectionCount }, (_, section) => this.document.getParagraphCount(section));
    const total = counts.reduce((sum, count) => sum + count, 0), end = Math.min(total, offset + limit);
    let sectionStart = 0;
    const items: Paragraph[] = [];
    for (const [section, count] of counts.entries()) {
      const first = Math.max(0, offset - sectionStart), last = Math.min(count, end - sectionStart);
      for (let paragraph = first; paragraph < last; paragraph++) items.push(this.paragraph({ section, paragraph }, model));
      sectionStart += count;
      if (sectionStart >= end) break;
    }
    return { items, total };
  }
  private paragraphList(includeCells: boolean, includeStories: boolean, model: StructuralModel): Paragraph[] | Array<Paragraph | StoryParagraph> {
    return this.memoized(`paragraphs:${includeCells}:${includeStories}`, () => this.buildParagraphList(includeCells, includeStories, model));
  }
  private buildParagraphList(includeCells: boolean, includeStories: boolean, model: StructuralModel): Paragraph[] | Array<Paragraph | StoryParagraph> {
    const roots = this.rootParagraphs(model);
    if (!includeCells) {
      if (!includeStories) return roots.flat();
      const stories = this.stories(model);
      const bodyStories = stories.filter((story): story is TextBoxStory => story.kind === 'textBox').flatMap(story => story.paragraphs);
      const nonBodyStories = stories.filter(story => story.kind !== 'textBox').flatMap(story => story.paragraphs);
      return [...roots.flat(), ...bodyStories, ...nonBodyStories];
    }
    const tables = this.tables(model);
    const stories = includeStories ? this.stories(model) : [];
    const containers = new Map<string, Array<{ controlIndex: number; table?: Table; textbox?: TextBoxStory }>>();
    const add = (address: BodyAddress, entry: { controlIndex: number; table?: Table; textbox?: TextBoxStory }): void => {
      const key = nodePath(address), items = containers.get(key) ?? [];
      items.push(entry); containers.set(key, items);
    };
    for (const table of tables) add(table.address, { controlIndex: table.control, table });
    for (const story of stories) if (story.kind === 'textBox') add(story.anchor, { controlIndex: story.controlIndex, textbox: story });
    const result: Paragraph[] = [], visited = new Set<string>();
    const visit = (paragraph: Paragraph): void => {
      if (visited.has(paragraph.nodePath)) return;
      visited.add(paragraph.nodePath); result.push(paragraph);
      for (const child of (containers.get(paragraph.nodePath) ?? []).sort((a, b) => a.controlIndex - b.controlIndex)) {
        if (child.table) for (const cell of child.table.cells) for (const nested of cell.paragraphs) visit(nested);
        if (child.textbox) for (const nested of child.textbox.paragraphs) visit(nested);
      }
    };
    for (const section of roots) for (const paragraph of section) visit(paragraph);
    if (!includeStories) return result;
    const nonBody = stories.filter(story => story.kind !== 'textBox').flatMap(story => story.paragraphs);
    return [...result, ...nonBody];
  }
  tables(model = this.structuralModel()): Table[] { return this.memoized('tables', () => this.buildTables(model)); }
  private buildTables(model: StructuralModel): Table[] {
    const controls = parsed<RawControl[]>(this.document.getControls());
    const tables: Table[] = [];
    for (const control of controls.filter(item => item.ctrlId === 'tbl')) {
      const address = this.controlAddress(control, model);
      const hostParagraph = control.list === 0 ? control.para - model.starts[address.section] : control.para;
      const cellLists = model.lists.filter(list => list.isCell && list.hostListId === control.list && list.hostPara === hostParagraph &&
        list.controlIndex === control.controlIndex && list.sectionIndex === address.section).sort((a, b) => a.cellIndex - b.cellIndex);
      if (!cellLists.length) continue;
      const cells: Cell[] = cellLists.map(cell => {
        let properties: TableCellProperties | undefined;
        if (!address.cellPath?.length) try {
          const raw = parsed<Record<string, Json>>(this.document.getCellProperties(address.section, hostParagraph, control.controlIndex, cell.cellIndex));
          const border = (key: string): TableCellProperties['borderLeft'] => raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key]) ? raw[key] : undefined;
          properties = {
            width: typeof raw.width === 'number' ? raw.width : 0,
            height: typeof raw.height === 'number' ? raw.height : 0,
            ...(typeof raw.paddingLeft === 'number' ? { paddingLeft: raw.paddingLeft } : {}),
            ...(typeof raw.paddingRight === 'number' ? { paddingRight: raw.paddingRight } : {}),
            ...(typeof raw.paddingTop === 'number' ? { paddingTop: raw.paddingTop } : {}),
            ...(typeof raw.paddingBottom === 'number' ? { paddingBottom: raw.paddingBottom } : {}),
            ...(typeof raw.verticalAlign === 'number' ? { verticalAlign: raw.verticalAlign } : {}),
            ...(typeof raw.textDirection === 'number' ? { textDirection: raw.textDirection } : {}),
            ...(typeof raw.isHeader === 'boolean' ? { isHeader: raw.isHeader } : {}),
            ...(typeof raw.cellProtect === 'boolean' ? { cellProtect: raw.cellProtect } : {}),
            ...(typeof raw.applyInnerMargin === 'boolean' ? { applyInnerMargin: raw.applyInnerMargin } : {}),
            ...(border('borderLeft') ? { borderLeft: border('borderLeft') } : {}), ...(border('borderRight') ? { borderRight: border('borderRight') } : {}),
            ...(border('borderTop') ? { borderTop: border('borderTop') } : {}), ...(border('borderBottom') ? { borderBottom: border('borderBottom') } : {}),
            ...(typeof raw.fillType === 'string' ? { fillType: raw.fillType } : {}),
            ...(typeof raw.fillColor === 'string' ? { fillColor: raw.fillColor } : {}), ...(typeof raw.patternColor === 'string' ? { patternColor: raw.patternColor } : {}),
            ...(typeof raw.patternType === 'number' ? { patternType: raw.patternType } : {}),
          };
        } catch { /* Native cell properties are only available for root-body tables. */ }
        return {
          index: cell.cellIndex, row: cell.row ?? 0, col: cell.col ?? 0, rowSpan: cell.rowSpan ?? 1, colSpan: cell.colSpan ?? 1,
          paragraphs: Array.from({ length: cell.paraCount }, (_, paragraph) => this.paragraph(this.addressForListParagraph(cell.listId, paragraph, model), model)),
          ...(properties ? { properties } : {}),
        };
      });
      let properties: Table['properties'];
      if (!address.cellPath?.length) try {
        const raw = parsed<Record<string, Json>>(this.document.getTableProperties(address.section, hostParagraph, control.controlIndex));
        properties = {
          ...(typeof raw.cellSpacing === 'number' ? { cellSpacing: raw.cellSpacing } : {}),
          ...(typeof raw.paddingLeft === 'number' ? { paddingLeft: raw.paddingLeft } : {}),
          ...(typeof raw.paddingRight === 'number' ? { paddingRight: raw.paddingRight } : {}),
          ...(typeof raw.paddingTop === 'number' ? { paddingTop: raw.paddingTop } : {}),
          ...(typeof raw.paddingBottom === 'number' ? { paddingBottom: raw.paddingBottom } : {}),
          ...(typeof raw.pageBreak === 'number' ? { pageBreak: raw.pageBreak } : {}),
          ...(typeof raw.repeatHeader === 'boolean' ? { repeatHeader: raw.repeatHeader } : {}),
          ...(typeof raw.hasCaption === 'boolean' ? { hasCaption: raw.hasCaption } : {}),
          ...(raw.hasCaption === true && typeof raw.captionDirection === 'number' && TABLE_CAPTION_DIRECTIONS[raw.captionDirection] ? { captionDirection: TABLE_CAPTION_DIRECTIONS[raw.captionDirection] } : {}),
        };
      } catch { /* Native table properties are only available for root-body tables. */ }
      tables.push({
        ...address, kind: 'table', address, control: control.controlIndex,
        nodePath: `${nodePath(address)}/ctrl[${control.controlIndex}]`,
        rows: Math.max(...cells.map(cell => cell.row + cell.rowSpan)),
        cols: Math.max(...cells.map(cell => cell.col + cell.colSpan)),
        cells, ...(properties ? { properties } : {}),
      });
    }
    return tables;
  }
  bookmarks(): Bookmark[] {
    const raw = parsed<Array<{ name: string; sec: number; para: number; ctrlIdx: number; charPos: number }>>(this.document.getBookmarks());
    return raw.map(item => {
      const address: BodyAddress = { section: item.sec, paragraph: item.para, kind: 'body' };
      return { name: item.name, address, nodePath: nodePath(address), controlIndex: item.ctrlIdx, offset: item.charPos };
    });
  }
  private clickHereField(fieldId: unknown): Field {
    if (typeof fieldId !== 'number') throw new HwpHandsError('INVALID_ARGUMENT', 'fieldId must be a number.');
    integer(fieldId, 'fieldId');
    const matches = this.fields().filter(field => field.fieldId === fieldId);
    if (matches.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', matches.length ? 'fieldId가 현재 문서에서 모호합니다.' : 'fieldId를 찾을 수 없습니다.', { fieldId });
    if (matches[0].fieldType !== 'clickhere') throw new HwpHandsError('INVALID_ARGUMENT', '누름틀 필드만 고치거나 지울 수 있습니다.', { fieldId, fieldType: matches[0].fieldType ?? null });
    return matches[0];
  }
  private formFieldRange(field: Field): { address: BodyAddress; start: number; end: number } {
    const address = field.address, start = field.startCharIdx, end = field.endCharIdx;
    if (field.fieldType !== 'clickhere' || !address || address.kind !== 'body' || address.containerKinds?.includes('textBox')
      || typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
      throw new HwpHandsError('INVALID_ARGUMENT', '누름틀 답안의 위치를 확인할 수 없습니다.');
    const paragraph = this.paragraph(address), value = typeof field.value === 'string' ? field.value : '';
    if (end > paragraph.length || Array.from(paragraph.text).slice(start, end).join('') !== value)
      throw new HwpHandsError('VERIFY_FAILED', '누름틀 답안과 문단 범위가 일치하지 않습니다.');
    return { address, start, end };
  }
  private writeFormField(before: Field[], index: number, value: string, byPlace = false, normalize = true): void {
    const field = before[index], original = this.formFieldRange(field), address = original.address;
    if (byPlace) for (const [otherIndex, other] of before.entries()) {
      if (otherIndex === index || other.fieldId !== field.fieldId || !other.address || this.addressKey(other.address) !== this.addressKey(address)) continue;
      const range = this.formFieldRange(other);
      if (!(original.end < range.start || range.end < original.start))
        throw new HwpHandsError('INVALID_ARGUMENT', '같은 ID 누름틀의 범위가 겹치거나 맞닿아 있어 안전하게 구별할 수 없습니다.');
    }
    const originalText = this.paragraph(address).text;
    let shapes: Array<{ startOffset: number; endOffset: number; charShapeId: number }> = [];
    if (original.end > original.start) {
      const raw = address.cellPath?.length
        ? this.document.getCharShapeRunsInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath), original.start, original.end)
        : this.document.getCharShapeRuns(address.section, address.paragraph, original.start, original.end);
      shapes = parsed<Array<{ startOffset: number; endOffset: number; charShapeId: number }>>(raw);
      let covered = original.start;
      for (const run of shapes) {
        if (run.startOffset !== covered || run.endOffset <= covered || run.endOffset > original.end || !Number.isSafeInteger(run.charShapeId) || run.charShapeId < 0)
          throw new HwpHandsError('VERIFY_FAILED', '누름틀 글자 서식 범위가 올바르지 않습니다.');
        covered = run.endOffset;
      }
      if (covered !== original.end) throw new HwpHandsError('VERIFY_FAILED', '누름틀 글자 서식 범위가 불완전합니다.');
      if (value && Array.from(value).length !== original.end - original.start && new Set(shapes.map(run => run.charShapeId)).size > 1)
        throw new HwpHandsError('INVALID_ARGUMENT', '길이가 바뀌는 혼합 서식 누름틀 답안은 안전하게 교체할 수 없습니다.');
    }
    if (byPlace) {
      if (original.end > original.start) this.remove(address, original.start, original.end - original.start);
      if (value) this.insert(address, original.start, value);
    } else checked(this.document.setFieldValue(field.fieldId, value));
    const after = this.fields(), updated = after[index];
    if (after.length !== before.length || !updated || updated.name !== field.name || updated.fieldType !== field.fieldType || updated.value !== value
      || before.some((item, i) => i !== index && (after[i]?.name !== item.name || after[i]?.fieldType !== item.fieldType || after[i]?.value !== item.value)))
      throw new HwpHandsError('VERIFY_FAILED', '누름틀을 채우는 동안 다른 필드가 달라졌습니다.');
    const range = this.formFieldRange(updated);
    if (this.addressKey(range.address) !== this.addressKey(address)) throw new HwpHandsError('VERIFY_FAILED', '누름틀의 문단이 변경되었습니다.');
    if (byPlace) {
      const chars = Array.from(originalText), expected = [...chars.slice(0, original.start), ...Array.from(value), ...chars.slice(original.end)].join('');
      if (updated.fieldId !== field.fieldId || this.paragraph(range.address).text !== expected
        || before.some((item, i) => i !== index && (after[i]?.fieldId !== item.fieldId || !item.address || !after[i]?.address || this.addressKey(item.address) !== this.addressKey(after[i].address))))
        throw new HwpHandsError('VERIFY_FAILED', '같은 ID의 누름틀을 안전하게 분리하지 못했습니다.');
    }
    if (shapes.length && range.end > range.start) {
      const restored = range.end - range.start === original.end - original.start
        ? shapes.map(run => ({ ...run, startOffset: run.startOffset - original.start + range.start, endOffset: run.endOffset - original.start + range.start }))
        : [{ startOffset: range.start, endOffset: range.end, charShapeId: shapes[0].charShapeId }];
      const json = JSON.stringify(restored);
      checked(range.address.cellPath?.length
        ? this.document.setCharShapeRunsInCellByPath(range.address.section, range.address.paragraph, JSON.stringify(range.address.cellPath), range.start, range.end, json)
        : this.document.setCharShapeRuns(range.address.section, range.address.paragraph, range.start, range.end, json));
    }
    if (normalize) this.normalizeFormAnswer(range.address, range.start, range.end);
  }
  private fieldText(value: unknown, label: string, maxLength: number, allowEmpty: boolean): string {
    if (typeof value !== 'string') throw new HwpHandsError('INVALID_ARGUMENT', `${label} must be a string.`);
    const trimmed = value.trim();
    // The click-here command string stores these three texts with length prefixes; control characters would corrupt it.
    // eslint-disable-next-line no-control-regex -- HWP names must reject control characters.
    if ((!allowEmpty && !trimmed) || Array.from(trimmed).length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new HwpHandsError('INVALID_ARGUMENT', `${label} must be ${allowEmpty ? 0 : 1}–${maxLength} characters without control characters.`);
    }
    return trimmed;
  }
  private updateField(c: Extract<Command, { type: 'updateField' }>): Record<string, Json> {
    rejectUnknownKeys(c, ['type', 'fieldId', 'sessionId', 'revision', 'name', 'guide', 'memo', 'editable'], 'updateField');
    const field = this.clickHereField(c.fieldId);
    if (c.name === undefined && c.guide === undefined && c.memo === undefined && c.editable === undefined) throw new HwpHandsError('INVALID_ARGUMENT', 'updateField requires at least one of name, guide, memo or editable.');
    if (c.editable !== undefined && typeof c.editable !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'editable must be a boolean.');
    const current = checked(this.document.getClickHereProps(field.fieldId)) as { guide?: string; memo?: string; name?: string; editable?: boolean };
    const name = c.name === undefined ? String(current.name ?? field.name) : this.fieldText(c.name, 'name', 128, false);
    if (c.name !== undefined && this.fields().some(item => item.fieldId !== field.fieldId && item.name === name)) throw new HwpHandsError('INVALID_ARGUMENT', `Field "${name}" already exists; name-based writes need unique names.`);
    const guide = c.guide === undefined ? String(current.guide ?? '') : this.fieldText(c.guide, 'guide', 256, true);
    const memo = c.memo === undefined ? String(current.memo ?? '') : this.fieldText(c.memo, 'memo', 1024, true);
    return checked(this.document.updateClickHereProps(field.fieldId, guide, memo, name, c.editable ?? current.editable ?? true));
  }
  private removeField(c: Extract<Command, { type: 'removeField' }>): Record<string, Json> {
    rejectUnknownKeys(c, ['type', 'fieldId', 'sessionId', 'revision', 'keepText'], 'removeField');
    if (c.keepText !== undefined && typeof c.keepText !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'keepText must be a boolean.');
    const field = this.clickHereField(c.fieldId), address = field.address, start = field.startCharIdx;
    // RHWP exposes removal by caret position for body paragraphs and one-level cell paragraphs only.
    if (!address || address.kind !== 'body' || address.containerKinds?.includes('textBox') || (address.cellPath?.length ?? 0) > 1 || typeof start !== 'number') {
      throw new HwpHandsError('INVALID_ARGUMENT', '본문 문단과 표 셀(한 단계) 안의 누름틀만 지울 수 있습니다.');
    }
    const entered = typeof field.value === 'string' ? field.value : '';
    const step = address.cellPath?.[0];
    // Removing a click-here field removes the text typed into it as well; "keepText" puts that text back where the field started.
    const result = step
      ? checked(this.document.removeFieldAtInCell(address.section, address.paragraph, step.controlIndex, step.cellIndex, step.cellParaIndex, start, false))
      : checked(this.document.removeFieldAt(address.section, address.paragraph, start));
    if (c.keepText === true && entered) this.insert(address, start, entered);
    return result;
  }
  private bookmarkName(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new HwpHandsError('INVALID_ARGUMENT', `${label} must be a string.`);
    const name = value.trim();
    // HWP5 stores the name with a 16-bit length prefix; Studio caps it at 250 UTF-16 code units.
    // eslint-disable-next-line no-control-regex -- HWP names must reject control characters.
    if (!name || name.length > 250 || /[\u0000-\u001f\u007f]/.test(name)) throw new HwpHandsError('INVALID_ARGUMENT', `${label} must be 1–250 characters without control characters.`);
    return name;
  }
  private findBookmark(name: string): Bookmark {
    const found = this.bookmarks().find(item => item.name === name);
    if (!found) throw new HwpHandsError('INVALID_ARGUMENT', `Bookmark "${name}" does not exist.`);
    return found;
  }
  tree(model = this.structuralModel()): DocumentTree {
    const sections = this.rootParagraphs(model).map((paragraphs, index) => ({ index, paragraphs }));
    return {
      sections, paragraphs: sections.flatMap(section => section.paragraphs), tables: this.tables(model), fields: this.fields(model),
      controls: this.controls(model), objects: this.objects(model, false), stories: this.stories(model), bookmarks: this.bookmarks(),
    };
  }
  search(query: string, caseSensitive = false): SearchMatch[] {
    text(query); if (!query) throw new HwpHandsError('INVALID_ARGUMENT', '검색어가 비어 있습니다.');
    type Match = { sec: number; para: number; charOffset: number; length: number; cellContext?: { parentPara: number; ctrlIdx: number; cellIdx: number; cellPara: number }; cellPath?: Target['cellPath'] };
    const matches = parsed<Match[]>(this.document.searchAllText(query, caseSensitive, true));
    return matches.map(m => {
      const t: Target = { section: m.sec, paragraph: m.cellContext?.parentPara ?? m.para };
      if (m.cellPath) t.cellPath = m.cellPath;
      else if (m.cellContext) t.cellPath = [{ controlIndex: m.cellContext.ctrlIdx, cellIndex: m.cellContext.cellIdx, cellParaIndex: m.cellContext.cellPara }];
      const paragraph = this.paragraph(t);
      const points = Array.from(paragraph.text);
      const utf16Offset = Array.from(paragraph.text.slice(0, m.charOffset)).length;
      const utf16End = Array.from(paragraph.text.slice(0, m.charOffset + m.length)).length;
      const candidates = [{ offset: m.charOffset, length: m.length }, { offset: utf16Offset, length: utf16End - utf16Offset }];
      const match = candidates.find(({ offset, length }) => offset >= 0 && length > 0 && offset + length <= points.length
        && (caseSensitive ? points.slice(offset, offset + length).join('') === query
          : points.slice(offset, offset + length).join('').toLowerCase() === query.toLowerCase()));
      return match ? { ...paragraph.address, kind: 'body' as const, address: paragraph.address, nodePath: paragraph.nodePath, ...match, text: paragraph.text } : undefined;
    }).filter((match): match is SearchMatch => match !== undefined);
  }
  searchDocument(query: string, caseSensitive = false): import('./api').DocumentSearchMatch[] {
    const matches: Array<SearchMatch | StorySearchMatch> = this.search(query, caseSensitive);
    const seen = new Set(matches.map(match => `${match.nodePath}|${match.offset}|${match.length}`));
    const needle = Array.from(caseSensitive ? query : query.toLowerCase());
    for (const paragraph of this.paragraphs(true, true)) {
      const source = Array.from(caseSensitive ? paragraph.text : paragraph.text.toLowerCase()), starts: number[] = [], ends: number[] = [];
      Array.from(paragraph.text).forEach((character, index) => {
        const foldedLength = Array.from(caseSensitive ? character : character.toLowerCase()).length;
        for (let part = 0; part < foldedLength; part++) { starts.push(index); ends.push(index + 1); }
      });
      // Whole-string casing can depend on neighbours (for example, Greek final sigma).
      if (starts.length !== source.length) {
        starts.length = 0; ends.length = 0;
        const points = Array.from(paragraph.text);
        for (let index = 0; index < points.length; index++) {
          const before = Array.from(points.slice(0, index).join('').toLowerCase()).length;
          const after = Array.from(points.slice(0, index + 1).join('').toLowerCase()).length;
          for (let part = before; part < after; part++) { starts.push(index); ends.push(index + 1); }
        }
      }
      for (let offset = 0; offset <= source.length - needle.length; offset++) {
        if (!needle.every((character, index) => source[offset + index] === character)) continue;
        const endIndex = offset + needle.length - 1;
        if (offset > 0 && starts[offset] === starts[offset - 1]) continue;
        if (endIndex + 1 < source.length && ends[endIndex] === ends[endIndex + 1]) continue;
        const originalOffset = starts[offset], length = ends[endIndex] - originalOffset;
        const key = `${paragraph.nodePath}|${originalOffset}|${length}`;
        if (!seen.has(key)) {
          if (paragraph.address.kind === 'body') matches.push({ ...paragraph.address, kind: 'body', address: paragraph.address, nodePath: paragraph.nodePath, offset: originalOffset, length, text: paragraph.text });
          else matches.push({ address: paragraph.address, nodePath: paragraph.nodePath, offset: originalOffset, length, text: paragraph.text });
          seen.add(key);
        }
        while (offset + 1 < source.length && starts[offset + 1] < originalOffset + length) offset++;
      }
    }
    return matches;
  }
  private listPosition(target: Target, model: StructuralModel): { listId: number; paragraph: number } | undefined {
    let listId = 0, paragraph = target.paragraph;
    for (const step of target.cellPath ?? []) {
      const list = model.lists.find(item => item.hostListId === listId && item.sectionIndex === target.section &&
        item.hostPara === paragraph && item.controlIndex === step.controlIndex && item.cellIndex === step.cellIndex);
      if (!list) return undefined;
      listId = list.listId; paragraph = step.cellParaIndex;
    }
    return { listId, paragraph: listId === 0 ? model.starts[target.section] + target.paragraph : paragraph };
  }
  private characterPropertiesRaw(address: BodyAddress | HeaderFooterAddress, offset: number, cellPathJson?: string): string {
    const d = this.document;
    return address.kind === 'body'
      ? (address.cellPath?.length
        ? d.getCellCharPropertiesAtByPath(address.section, address.paragraph, cellPathJson ?? JSON.stringify(address.cellPath), offset)
        : d.getCharPropertiesAt(address.section, address.paragraph, offset))
      : d.getCharPropertiesInHeaderFooter(address.section, address.isHeader, address.applyTo, address.paragraph, offset);
  }
  private characterPropertiesFromRaw(raw: string): CharacterProperties {
    const properties = parsed<CharacterProperties>(raw);
    return typeof properties.fontSize === 'number' ? { ...properties, fontSize: properties.fontSize / 100 } : properties;
  }
  private characterProperties(address: BodyAddress | HeaderFooterAddress, offset: number): CharacterProperties {
    return this.characterPropertiesFromRaw(this.characterPropertiesRaw(address, offset));
  }
  private paragraphFormat(paragraph: Paragraph | StoryParagraph, model: StructuralModel, includeNativeShape = true): Omit<ParagraphFormatting, 'characterRuns' | 'characterCoverage' | 'missingRanges'> {
    const address = paragraph.address;
    if (address.kind === 'body') {
      let properties: ParagraphProperties | undefined, style: StyleReference | undefined;
      if (!address.cellPath?.length) {
        // paragraphList read these from the same immutable query model; avoid a second WASM/JSON read per root paragraph.
        properties = paragraph.properties;
        style = parsed<StyleReference>(this.document.getStyleAt(address.section, address.paragraph));
      } else if (address.cellPath.length === 1) {
        const step = address.cellPath[0];
        properties = parsed<ParagraphProperties>(this.document.getCellParaPropertiesAt(address.section, address.paragraph, step.controlIndex, step.cellIndex, step.cellParaIndex));
        style = parsed<StyleReference>(this.document.getCellStyleAt(address.section, address.paragraph, step.controlIndex, step.cellIndex, step.cellParaIndex));
      }
      let nativeShape: NativeParagraphShape | undefined;
      const position = includeNativeShape ? this.listPosition(address, model) : undefined;
      if (position) nativeShape = parsed<NativeParagraphShape>(this.document.getParaShapeSet(position.listId, position.paragraph));
      const propertyCoverage = properties ? 'complete' : nativeShape ? 'nativeOnly' : 'unavailable';
      return { address, nodePath: paragraph.nodePath, propertyCoverage, ...(style ? { style } : {}), ...(properties ? { properties } : {}), ...(nativeShape ? { nativeShape } : {}) };
    }
    if (address.kind === 'headerFooter') {
      const properties = parsed<ParagraphProperties>(this.document.getParaPropertiesInHf(address.section, address.isHeader, address.applyTo, address.paragraph));
      return { address, nodePath: paragraph.nodePath, properties, propertyCoverage: 'complete' };
    }
    const properties = parsed<ParagraphProperties>(this.document.getParaPropertiesInFootnote(address.section, address.anchor.paragraph, address.controlIndex, address.paragraph));
    return { address, nodePath: paragraph.nodePath, properties, propertyCoverage: 'complete' };
  }
  private addressKey(address: ParagraphFormatting['address']): string {
    if (address.kind === 'body') return nodePath(address);
    if (address.kind === 'headerFooter') return `sec[${address.section}]/${address.isHeader ? 'header' : 'footer'}[${address.applyTo}]/para[${address.paragraph}]`;
    return `${address.kind}:${address.section}:${nodePath(address.anchor)}:ctrl[${address.controlIndex}]/para[${address.paragraph}]`;
  }
  private scanCharacterRuns(address: BodyAddress | HeaderFooterAddress, textValue: string): CharacterRun[] {
    const chars = Array.from(textValue), runs: CharacterRun[] = [];
    const cellPathJson = address.kind === 'body' && address.cellPath?.length ? JSON.stringify(address.cellPath) : undefined;
    let previousRaw: string | undefined;
    for (let offset = 0; offset < chars.length; offset++) {
      const raw = this.characterPropertiesRaw(address, offset, cellPathJson);
      const previous = runs.at(-1);
      if (previous && raw === previousRaw) {
        previous.text += chars[offset]; previous.length++;
      } else {
        const properties = this.characterPropertiesFromRaw(raw);
        if (previous && sameCharacterProperties(previous.properties, properties)) {
          previous.text += chars[offset]; previous.length++;
        } else runs.push({ offset, length: 1, text: chars[offset], properties, source: 'addressedRead' });
      }
      previousRaw = raw;
    }
    return runs;
  }
  /**
   * A body or table-cell paragraph's character runs straight from its shape runs: one engine read per paragraph and one property read per
   * character shape and script category, independent of which pages were laid out.
   */
  private modelCharacterRuns(paragraph: Paragraph, shapes: ModelRunShapes): CharacterRun[] {
    const address = paragraph.address, chars = Array.from(paragraph.text);
    const cellPathJson = address.cellPath?.length ? JSON.stringify(address.cellPath) : undefined;
    const raw = cellPathJson ? this.document.getCharShapeRunsInCellByPath(address.section, address.paragraph, cellPathJson, 0, paragraph.length)
      : this.document.getCharShapeRuns(address.section, address.paragraph, 0, paragraph.length);
    const spans: Array<{ offset: number; end: number; properties: CharacterProperties }> = [];
    for (const shape of parsed<Array<{ startOffset: number; endOffset: number; charShapeId: number }>>(raw)) {
      for (let offset = shape.startOffset; offset < shape.endOffset;) {
        const category = scriptCategory(chars[offset]?.codePointAt(0) ?? 0);
        let end = offset + 1;
        while (end < shape.endOffset && scriptCategory(chars[end]?.codePointAt(0) ?? 0) === category) end++;
        const key = `${shape.charShapeId}:${category}`;
        let properties = shapes.byKey.get(key);
        if (!properties) {
          // Equal properties share one object, so merging neighbouring spans below is a reference comparison.
          const read = this.characterPropertiesFromRaw(this.characterPropertiesRaw(address, offset, cellPathJson));
          properties = shapes.distinct.find(item => sameCharacterProperties(item, read)) ?? read;
          if (properties === read) shapes.distinct.push(read);
          shapes.byKey.set(key, properties);
        }
        const previous = spans.at(-1);
        if (previous && previous.end === offset && previous.properties === properties) previous.end = end;
        else spans.push({ offset, end, properties });
        offset = end;
      }
    }
    return spans.map(span => ({ offset: span.offset, length: span.end - span.offset, text: chars.slice(span.offset, span.end).join(''), properties: span.properties, source: 'addressedRead' }));
  }
  private paragraphFormatting(paragraph: Paragraph | StoryParagraph, model: StructuralModel, modelRuns: boolean, shapeProperties: ModelRunShapes, layoutRuns: Map<string, CharacterRun[]>, includeNativeShape = true): ParagraphFormatting {
    const base = this.paragraphFormat(paragraph, model, includeNativeShape), key = this.addressKey(paragraph.address);
    const length = paragraph.length;
    let runs: CharacterRun[], characterCoverage: ParagraphFormatting['characterCoverage'];
    if (paragraph.address.kind === 'footnote' || paragraph.address.kind === 'endnote') {
      runs = []; characterCoverage = 'unsupported';
    } else if (paragraph.address.kind === 'headerFooter' || paragraph.address.kind === 'body' && paragraph.address.containerKinds?.includes('textBox')) {
      runs = this.scanCharacterRuns(paragraph.address, paragraph.text); characterCoverage = 'complete';
    } else if (modelRuns) {
      runs = this.modelCharacterRuns(paragraph as Paragraph, shapeProperties); characterCoverage = 'partial';
    } else {
      const candidates = layoutRuns.get(key) ?? [];
      candidates.sort((a, b) => a.offset - b.offset || a.length - b.length);
      runs = [];
      for (const candidate of candidates) {
        const duplicate = runs.find(existing => existing.offset === candidate.offset && existing.length === candidate.length);
        if (duplicate) continue;
        const previous = runs.at(-1);
        if (previous && previous.offset + previous.length === candidate.offset && JSON.stringify(previous.properties) === JSON.stringify(candidate.properties)) {
          previous.length += candidate.length; previous.text += candidate.text;
        } else runs.push(candidate);
      }
      characterCoverage = 'partial';
    }
    const ranges = runs.map(run => [run.offset, run.offset + run.length] as const).sort((a, b) => a[0] - b[0]);
    const missingRanges: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) missingRanges.push({ start: cursor, end: start });
      cursor = Math.max(cursor, end);
    }
    if (cursor < length) missingRanges.push({ start: cursor, end: length });
    if (characterCoverage !== 'unsupported' && !missingRanges.length) characterCoverage = 'complete';
    return { ...base, characterRuns: runs, characterCoverage, ...(missingRanges.length ? { missingRanges } : {}) };
  }
  /**
   * One root body paragraph as `tree` and model-run `formatting` report it, with the root paragraph count. After a typed
   * edit this is all that differs from the previous revision, so a caller holding that revision need not read the document again.
   */
  paragraphPatch(target: Target): { rootParagraphs: number; paragraph: Paragraph; formatting: ParagraphFormatting } | undefined {
    if (!target || !Number.isSafeInteger(target.section) || !Number.isSafeInteger(target.paragraph) || target.cellPath?.length) return undefined;
    const model = this.structuralModel();
    if (target.section < 0 || target.section >= model.starts.length - 1 || target.paragraph < 0 || target.paragraph >= this.document.getParagraphCount(target.section)) return undefined;
    const paragraph = this.paragraph({ section: target.section, paragraph: target.paragraph }, model);
    return { rootParagraphs: model.starts.at(-1)!, paragraph, formatting: this.paragraphFormatting(paragraph, model, true, { byKey: new Map(), distinct: [] }, new Map()) };
  }
  private buildFormatting(model: StructuralModel, layouts: PageLayout[], pageSelection = layouts.map(layout => layout.page), modelRuns = false, includeNativeShape = true): FormattingModel {
    const paragraphs = this.paragraphList(true, true, model) as Array<Paragraph | StoryParagraph>;
    const shapeProperties: ModelRunShapes = { byKey: new Map(), distinct: [] };
    const byAddress = new Map(paragraphs.map(paragraph => [this.addressKey(paragraph.address), paragraph]));
    const layoutRuns = new Map<string, CharacterRun[]>();
    for (const layout of layouts) for (const run of layout.textRuns) {
      if (!run.address || run.offset === undefined || !run.text) continue;
      const key = this.addressKey(run.address), paragraph = byAddress.get(key);
      if (!paragraph) continue;
      const source = Array.from(paragraph.text), length = Array.from(run.text).length;
      if (run.offset < 0 || run.offset >= source.length || !length) continue;
      const properties = this.characterProperties(run.address, run.offset);
      const textValue = source.slice(run.offset, run.offset + length).join('');
      const segments = layoutRuns.get(key) ?? [];
      segments.push({ offset: run.offset, length: Array.from(textValue).length, text: textValue, properties, source: 'pageLayout' });
      layoutRuns.set(key, segments);
    }
    const formattingParagraphs: ParagraphFormatting[] = paragraphs.map(paragraph => this.paragraphFormatting(paragraph, model, modelRuns, shapeProperties, layoutRuns, includeNativeShape));
    const styles = parsed<Array<Omit<StyleDefinition, 'detail'>>>(this.document.getStyleList()).map(style => {
      const detail = parsed<StyleDefinition['detail']>(this.document.getStyleDetail(style.id));
      const charProps = typeof detail.charProps.fontSize === 'number'
        ? { ...detail.charProps, fontSize: detail.charProps.fontSize / 100 }
        : detail.charProps;
      return { ...style, detail: { ...detail, charProps } };
    });
    const pageHideControls = this.controls(model).filter(control => control.ctrlId === 'pghd' && !control.address.cellPath?.length);
    const sections = Array.from({ length: this.document.getSectionCount() }, (_, section): SectionPageSettings => ({
      section,
      pageHides: pageHideControls.filter(control => control.address.section === section)
        .map((control): PageHideEntry => ({ paragraph: control.address.paragraph, ...this.pageHideAt(section, control.address.paragraph) })),
      pageDef: parsed<Record<string, Json>>(this.document.getPageDef(section)),
      sectionDef: parsed<Record<string, Json>>(this.document.getSectionDef(section)),
      columns: parsed<Record<string, Json>>(this.document.getColumnDef(section)),
      pageBorderFill: parsed<Record<string, Json>>(this.document.getPageBorderFill(section)),
      endnoteShape: parsed<Record<string, Json>>(this.document.getEndnoteShape(section)),
    }));
    return {
      pageSelection,
      styles,
      numbering: parsed<NumberingDefinition[]>(this.document.getNumberingList()),
      bullets: parsed<BulletDefinition[]>(this.document.getBulletList()),
      sections,
      paragraphs: formattingParagraphs,
      objects: this.objects(model, true),
    };
  }
  formatting(pageSelection?: number[], runs: 'layout' | 'model' = 'layout', includeNativeShape = true): FormattingModel {
    const model = this.structuralModel(), pages = this.selectPages(pageSelection);
    // Model runs need no layout: building one costs as much as the rest of the formatting model on a large document.
    if (runs === 'model') return this.buildFormatting(model, [], pages, true, includeNativeShape);
    return this.buildFormatting(model, pages.map(page => this.pageLayout(page, model)), pages, false, includeNativeShape);
  }
  documentSnapshot(options?: SnapshotOptions): Omit<DocumentSnapshot, 'state'> {
    const pageCount = this.pages(), pages = this.selectPages(options?.pages, pageCount), model = this.structuralModel();
    const structure = this.tree(model), layouts = pages.map(page => this.pageLayout(page, model));
    const text = this.allText();
    return {
      content: { text, codePoints: Array.from(text).length },
      structure,
      formatting: this.buildFormatting(model, layouts),
      layout: { pageCount, pages: layouts },
    };
  }
  /**
   * `runs: 'model'` reads body and table-cell character runs from the character shape runs (decision 42) instead of one property read
   * per character. Both give the same snapshot on every fixture, and the model read takes under a second where the scan takes about ten
   * on a 516-page document. Only the open-time writeability probe uses it; save and verify keep the per-character scan.
   */
  preservationSnapshot(runs: 'scan' | 'model' = 'scan'): { buckets: Record<string, unknown>; coverageWarnings: string[] } {
    if (runs !== 'scan' && runs !== 'model') throw new HwpHandsError('INVALID_ARGUMENT', 'Preservation runs must be "scan" or "model".');
    const model = this.structuralModel(), tree = this.tree(model), paragraphs = this.paragraphList(true, true, model) as Array<Paragraph | StoryParagraph>;
    const shapes: ModelRunShapes = { byKey: new Map(), distinct: [] };
    const formatting = this.buildFormatting(model, []), paragraphFormatting = new Map(formatting.paragraphs.map(item => [this.addressKey(item.address), item]));
    const normalizeProperties = (value: Record<string, unknown>): Record<string, unknown> => {
      if (value.fillType === 'solid' && value.patternColor === '#999999' && value.patternType === -1) {
        return { ...value, fillType: 'none', patternColor: '#000000', patternType: 0 };
      }
      return value;
    };
    const coverageWarnings: string[] = [];
    const formattedParagraphs = paragraphs.map(paragraph => {
      const key = this.addressKey(paragraph.address), base = paragraphFormatting.get(key);
      if (!base) throw new HwpHandsError('VERIFY_FAILED', `Preservation snapshot is missing paragraph formatting at ${key}.`);
      const { address: _address, nodePath: _nodePath, characterRuns: _runs, characterCoverage: _coverage, missingRanges: _missing, ...properties } = base;
      const note = paragraph.address.kind === 'footnote' || paragraph.address.kind === 'endnote';
      if (note) coverageWarnings.push('각주·미주 문자 서식은 현재 RHWP 코어에서 조회되지 않아 텍스트와 문단 속성만 비교합니다.');
      // Text-box and header/footer paragraphs have no shape-run read, as in buildFormatting.
      const characterRuns = runs === 'model' && paragraph.address.kind === 'body' && !paragraph.address.containerKinds?.includes('textBox')
        ? this.modelCharacterRuns(paragraph as Paragraph, shapes)
        : paragraph.address.kind === 'body' || paragraph.address.kind === 'headerFooter'
          ? this.scanCharacterRuns(paragraph.address, paragraph.text)
          : [];
      const preservedText = 'logicalText' in paragraph ? (paragraph.logicalText ?? paragraph.text) : paragraph.text;
      const preservedCharacterRuns = 'logicalText' in paragraph
        ? normalizeHeaderFooterCharacterRuns(characterRuns, paragraph.dynamicFields ?? [], paragraph.text)
        : characterRuns;
      return {
        address: paragraph.address,
        text: preservedText.replaceAll('\r\n', '\n'),
        paragraphProperties: {
          ...properties,
          ...(properties.properties ? { properties: normalizeProperties(properties.properties as unknown as Record<string, unknown>) } : {}),
        },
        characterRuns: preservedCharacterRuns,
        characterCoverage: note ? 'unsupported' : 'complete',
      };
    });
    if (model.lists.some(list => !list.isCell && list.cellIndex !== 0)) {
      coverageWarnings.push('도형 캡션 본문은 현재 구조 조회 범위 밖이라 텍스트와 서식을 보존 지문에 포함하지 않습니다.');
    }
    if (tree.stories.some(story => (story.kind === 'footnote' || story.kind === 'endnote') && story.availability === 'unsupportedNestedAnchor')) {
      coverageWarnings.push('셀에 고정된 각주·미주 본문은 현재 RHWP 코어에서 노출되지 않아 보존 지문에 포함되지 않습니다.');
    }
    if (formattedParagraphs.some(item => item.paragraphProperties.propertyCoverage !== 'complete')) {
      coverageWarnings.push('일부 깊은 중첩 문단은 현재 RHWP 코어 제한으로 정규화 문단 속성 대신 native 문단 모양만 비교합니다.');
    }
    const address = (value: BodyAddress | HeaderFooterAddress | NoteAddress): unknown => value;
    const paragraphReference = (value: Paragraph | StoryParagraph): unknown => ({ address: address(value.address), text: ('logicalText' in value ? (value.logicalText ?? value.text) : value.text).replaceAll('\r\n', '\n') });
    const buckets: Record<string, unknown> = {
      text: {
        fullText: this.allText().replaceAll('\r\n', '\n'),
        paragraphs: formattedParagraphs.map(({ address: itemAddress, text }) => ({ address: itemAddress, text })),
      },
      structure: {
        sections: tree.sections.map(section => ({ index: section.index, paragraphs: section.paragraphs.map(paragraphReference) })),
        tables: tree.tables.map(table => ({
          address: table.address, control: table.control, rows: table.rows, cols: table.cols, properties: table.properties,
          cells: table.cells.map(cell => ({ row: cell.row, col: cell.col, rowSpan: cell.rowSpan, colSpan: cell.colSpan, properties: cell.properties && this.normalizeCellProperties(cell.properties), paragraphs: cell.paragraphs.map(paragraphReference) })),
        })),
        fields: tree.fields.map(field => ({ name: field.name, value: field.value, address: field.address })),
        controls: tree.controls.filter(control => !HEAD_STRUCTURE_CONTROLS.has(control.ctrlId)).map(control => {
          const props = { ...control.props };
          // RHWP reports a different default TextWrap enum after round-trip; visual control geometry is checked by query.verify.
          delete props.TextWrap;
          return { ctrlId: control.ctrlId, ctrlCh: control.ctrlCh, userDesc: control.userDesc, controlIndex: control.controlIndex, pos: control.pos, props, address: control.address, objectKind: control.objectKind };
        }),
        // HWPX writes the page-hide control after the section and column definitions while HWP keeps insertion order, so these
        // paragraph-head controls are compared by presence per paragraph rather than by control index or character position.
        headControls: tree.controls.filter(control => HEAD_STRUCTURE_CONTROLS.has(control.ctrlId))
          .map(control => ({ ctrlId: control.ctrlId, ctrlCh: control.ctrlCh, userDesc: control.userDesc, props: control.props, address: control.address }))
          .sort((left, right) => nodePath(left.address).localeCompare(nodePath(right.address)) || left.ctrlId.localeCompare(right.ctrlId)),
        objects: tree.objects.map(object => ({ kind: object.kind, address: object.address, controlIndex: object.controlIndex, anchored: object.anchored, properties: object.properties, resource: object.resource })),
        stories: tree.stories.map(story => ({
          kind: story.kind, section: story.section, ...(story.kind === 'headerFooter' ? { isHeader: story.isHeader, applyTo: story.applyTo } : { anchor: story.anchor, controlIndex: story.controlIndex }),
          ...(story.kind === 'headerFooter' ? { label: story.label } : story.kind !== 'textBox' ? { availability: story.availability, number: story.number } : {}),
          paragraphs: story.paragraphs.map(paragraphReference),
        })),
      },
      formatting: {
        styles: formatting.styles.map(style => ({ ...style, detail: {
          ...style.detail,
          charProps: normalizeProperties(style.detail.charProps as unknown as Record<string, unknown>),
          paraProps: normalizeProperties(style.detail.paraProps as unknown as Record<string, unknown>),
        } })),
        objects: formatting.objects.map(object => ({ kind: object.kind, address: object.address, controlIndex: object.controlIndex, anchored: object.anchored, properties: object.properties, resource: object.resource })),
        paragraphs: formattedParagraphs,
      },
    };
    // These buckets are fresh plain-data projections consumed read-only by internal verification.
    return { buckets, coverageWarnings: [...new Set(coverageWarnings)] };
  }
  private normalizeCellProperties(properties: NonNullable<Cell['properties']>): NonNullable<Cell['properties']> {
    if (properties.fillType === 'pattern') return properties;
    const { patternColor: _patternColor, patternType: _patternType, ...rest } = properties;
    return rest;
  }
  private selectPages(selection?: number[], pageCount = this.pages()): number[] {
    const pages = selection ?? Array.from({ length: pageCount }, (_, page) => page);
    if (!Array.isArray(pages)) throw new HwpHandsError('INVALID_ARGUMENT', 'pages must be an array of page indices.');
    const selected: number[] = [];
    for (const page of pages) { integer(page, 'page', pageCount - 1); if (!selected.includes(page)) selected.push(page); }
    return selected;
  }
  objectResource(target: ObjectResourceTarget): ObjectResource {
    if (!target || typeof target !== 'object' || target.kind !== 'picture') throw new HwpHandsError('INVALID_ARGUMENT', 'Only picture objects have binary image resources.');
    const model = this.structuralModel();
    const address: BodyAddress = { ...target.address, ...(target.address?.cellPath && !target.address.containerKinds ? { containerKinds: this.inferContainerKinds(target.address, model) } : {}) };
    this.validateTarget(address, model);
    integer(target.controlIndex, 'controlIndex');
    const addressKey = nodePath(address);
    const exists = this.objects(model, false).some(object => object.kind === 'picture' && object.controlIndex === target.controlIndex && nodePath(object.address) === addressKey);
    if (!exists) throw new HwpHandsError('INVALID_ARGUMENT', 'The picture address and control index do not identify a document picture.');
    const path = JSON.stringify(address.cellPath ?? []);
    try {
      const mimeType = this.document.getControlImageMime(address.section, address.paragraph, path, target.controlIndex);
      const bytes = this.document.getControlImageData(address.section, address.paragraph, path, target.controlIndex);
      return { kind: 'image', mimeType, bytes: bytes.slice(), address, controlIndex: target.controlIndex };
    } catch (error) {
      throw new HwpHandsError('ENGINE_ERROR', `Picture resource is unavailable: ${String(error)}`);
    }
  }
  selectNode(selector: NodeSelector): NodeSelection {
    if (!selector || typeof selector !== 'object' || typeof selector.kind !== 'string') throw new HwpHandsError('INVALID_ARGUMENT', 'A typed node selector is required.');
    const model = this.structuralModel();
    if (selector.kind === 'paragraph') {
      const node = (this.paragraphList(true, true, model) as Array<Paragraph | StoryParagraph>).find(item => item.nodePath === selector.nodePath);
      if (!node) throw new HwpHandsError('INVALID_ARGUMENT', 'The paragraph nodePath is not present in this document revision.');
      return { kind: 'paragraph', nodePath: node.nodePath, address: node.address, text: node.text, length: node.length };
    }
    if (selector.kind === 'table') {
      const nodes = this.tables(model).filter(item => item.nodePath === selector.nodePath);
      if (nodes.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', nodes.length ? 'The table nodePath is ambiguous.' : 'The table nodePath is not present in this document revision.');
      const node = nodes[0];
      return { kind: 'table', nodePath: node.nodePath, address: node.address, controlIndex: node.control, rows: node.rows, cols: node.cols };
    }
    if (selector.kind === 'field') {
      integer(selector.fieldId, 'fieldId');
      const nodes = this.fields(model).filter(item => item.fieldId === selector.fieldId);
      if (nodes.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', nodes.length ? 'fieldId is ambiguous in this revision.' : 'fieldId is not present in this document revision.');
      const node = nodes[0];
      return { kind: 'field', nodePath: node.nodePath ?? `field[${node.fieldId}]`, fieldId: node.fieldId, name: node.name, value: node.value, ...(node.address ? { address: node.address } : {}) };
    }
    if (selector.kind === 'control') {
      integer(selector.controlIndex, 'controlIndex'); this.validateTarget(selector.address, model);
      const key = nodePath(selector.address);
      const nodes = this.controls(model).filter(item => item.controlIndex === selector.controlIndex && nodePath(item.address) === key);
      if (nodes.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', nodes.length ? 'The control selector is ambiguous.' : 'The control is not present in this document revision.');
      const node = nodes[0];
      return { kind: 'control', nodePath: node.nodePath, address: node.address, controlIndex: node.controlIndex, ctrlId: node.ctrlId };
    }
    if (selector.kind === 'object') {
      const nodes = this.objects(model, false).filter(item => item.nodePath === selector.nodePath);
      if (nodes.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', nodes.length ? 'The object nodePath is ambiguous.' : 'The object nodePath is not present in this document revision.');
      const node = nodes[0];
      return { kind: 'object', nodePath: node.nodePath, address: node.address, controlIndex: node.controlIndex, objectKind: node.kind };
    }
    throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported node selector kind.');
  }
  selectText(target: TextSelectionTarget): TextSelection {
    if (!target || typeof target !== 'object' || !target.address || typeof target.address !== 'object') throw new HwpHandsError('INVALID_ARGUMENT', 'A document address is required for text selection.');
    const model = this.structuralModel(), key = this.addressKey(target.address);
    const nodes = this.paragraphList(true, true, model) as Array<Paragraph | StoryParagraph>;
    const paragraphs = nodes.filter(item => this.addressKey(item.address) === key);
    if (paragraphs.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', paragraphs.length ? 'The text address is ambiguous.' : 'The text address is not present in this document revision.');
    const paragraph = paragraphs[0];
    integer(target.offset, 'offset', paragraph.length); integer(target.length, 'length', paragraph.length - target.offset);
    const text = Array.from(paragraph.text).slice(target.offset, target.offset + target.length).join('');
    return { address: paragraph.address, offset: target.offset, length: target.length, text };
  }
  canvasPage(page: number, requestedScale: number, options?: PageRenderOptions): CanvasPage {
    integer(page, 'page', this.pages() - 1);
    const layout = this.layout(page), { width, height } = layout.info;
    const scale = canvasScale(width, height, requestedScale);
    const canvas = new OffscreenCanvas(1, 1);
    this.document.setShowParagraphMarks(options?.showParagraphMarks ?? false);
    this.document.setShowControlCodes(options?.showControlCodes ?? false);
    this.document.setShowTransparentBorders(options?.showTransparentBorders ?? false);
    this.document.setClipEnabled(options?.showOverflow !== true);
    try {
      this.document.renderPageToOffscreenCanvas(page, canvas, scale);
      return { bitmap: canvas.transferToImageBitmap(), layout, width, height, scale };
    } finally {
      canvas.width = canvas.height = 1;
      this.document.setShowParagraphMarks(false);
      this.document.setShowControlCodes(false);
      this.document.setShowTransparentBorders(false);
      this.document.setClipEnabled(true);
    }
  }
  page(page: number, options?: PageRenderOptions): { svg: string; width: number; height: number } {
    integer(page, 'page', this.pages() - 1);
    const info = parsed<{ width: number; height: number }>(this.document.getPageInfo(page));
    this.document.setShowParagraphMarks(options?.showParagraphMarks ?? false);
    this.document.setShowControlCodes(options?.showControlCodes ?? false);
    this.document.setShowTransparentBorders(options?.showTransparentBorders ?? false);
    this.document.setClipEnabled(options?.showOverflow !== true);
    try { return { svg: this.document.renderPageSvg(page), width: info.width, height: info.height }; }
    finally {
      this.document.setShowParagraphMarks(false);
      this.document.setShowControlCodes(false);
      this.document.setShowTransparentBorders(false);
      this.document.setClipEnabled(true);
    }
  }
  private cursorRect(position: TextPosition, model: StructuralModel, pageHint?: number): CaretRect {
    const target = position?.address;
    if (!target || typeof target !== 'object') throw new HwpHandsError('INVALID_ARGUMENT', 'A document address is required for the caret query.');
    const paragraph = this.paragraphAt(target, model);
    integer(position.offset, 'offset', paragraph.length);
    let raw: string;
    if (target.kind === 'body' && target.cellPath?.length) {
      raw = this.document.getCursorRectByPath(target.section, target.paragraph, JSON.stringify(target.cellPath), position.offset);
    } else if (target.kind === 'body') {
      raw = this.document.getCursorRect(target.section, target.paragraph, position.offset);
    } else if (target.kind === 'headerFooter') {
      raw = this.document.getCursorRectInHeaderFooter(target.section, target.isHeader, target.applyTo, target.paragraph, position.offset, -1);
    } else {
      raw = this.document.getCursorRectInNote(target.section, target.anchor.paragraph, target.controlIndex, target.paragraph, position.offset);
    }
    const rect = parsed<CaretRect>(raw);
    if (!Number.isSafeInteger(rect.pageIndex) || ![rect.x, rect.y, rect.height].every(Number.isFinite) || rect.height <= 0) {
      throw new HwpHandsError('ENGINE_ERROR', 'RHWP returned an invalid caret rectangle.', rect);
    }
    if (pageHint !== undefined) {
      integer(pageHint, 'pageHint', this.pages() - 1);
      const layout = this.pageLayout(pageHint, model);
      const runs = layout.textRuns.filter(run => {
        const candidate = run.documentAddress ?? run.address;
        if (!candidate || this.addressKey(candidate) !== this.addressKey(paragraph.address)) return false;
        const base = run.offset ?? run.charStart ?? 0, length = Array.from(run.text).length;
        return position.offset >= base && position.offset <= base + length;
      }).sort((left, right) => {
        const leftBase = left.offset ?? left.charStart ?? 0, rightBase = right.offset ?? right.charStart ?? 0;
        return Number(rightBase === position.offset) - Number(leftBase === position.offset);
      });
      const run = runs[0];
      if (run) {
        const base = run.offset ?? run.charStart ?? 0, local = position.offset - base, length = Array.from(run.text).length;
        const x = run.charX.length > local ? run.x + run.charX[local] : local === length ? run.x + run.w : run.x + run.w * (length ? local / length : 0);
        return { pageIndex: pageHint, x, y: run.y, height: Math.max(1, run.h) };
      }
    }
    return rect;
  }
  caret(position: TextPosition, options: CaretQueryOptions = {}): CaretQueryResult {
    const model = this.structuralModel();
    const paragraph = this.paragraphAt(position?.address, model);
    const rect = this.cursorRect(position, model, options.pageHint);
    const address = paragraph.address;
    const paragraphFormatting = this.paragraphFormat(paragraph, model);
    const context: CaretContext = { section: address.section, paragraph, paragraphProperties: paragraphFormatting.properties ?? paragraph.properties,
      ...(paragraphFormatting.style ? { style: paragraphFormatting.style } : {}) };
    try {
      if (address.kind === 'body' || address.kind === 'headerFooter') {
        context.characterProperties = this.characterProperties(address, position.offset);
      }
    } catch { /* Some story and cell positions do not expose character properties in the current RHWP core. */ }
    const field = this.fields(model).find(item => item.address && this.addressKey(item.address) === this.addressKey(address)
      && (typeof item.startCharIdx !== 'number' || typeof item.endCharIdx !== 'number'
        ? true : position.offset >= item.startCharIdx && position.offset <= item.endCharIdx));
    if (field) context.field = field;
    if (address.kind === 'body' && address.cellPath?.length) {
      const step = address.cellPath.at(-1)!;
      if (address.containerKinds?.at(-1) === 'tableCell') {
        const parentAddress: BodyAddress = { kind: 'body', section: address.section, paragraph: address.paragraph,
          ...(address.cellPath.length > 1 ? { cellPath: address.cellPath.slice(0, -1), containerKinds: address.containerKinds?.slice(0, -1) } : {}) };
        const table = this.tables(model).find(item => item.control === step.controlIndex && this.addressKey(item.address) === this.addressKey(parentAddress));
        const cell = table?.cells.find(item => item.index === step.cellIndex);
        if (table && cell) context.cell = { tableNodePath: table.nodePath, controlIndex: table.control, cellIndex: cell.index, row: cell.row, col: cell.col };
      }
    }
    return { position: { address, offset: position.offset }, rect, context };
  }
  /** Measure serialized zero-width tabs against the current model; unresolvable locations are left unchanged. */
  measureTabs(spots: TabSpot[]): MeasuredTab[] {
    if (!Array.isArray(spots) || spots.length > 5000) throw new HwpHandsError('INVALID_ARGUMENT', '탭 측정은 5,000개 이하여야 합니다.');
    const model = this.structuralModel(), tables = this.tables(model), result: MeasuredTab[] = [];
    for (const spot of spots) {
      try {
        let paragraph = this.paragraph({ section: spot.sec, paragraph: spot.para }, model);
        for (const step of spot.cells) {
          const candidates = tables.filter(table => this.addressKey(table.address) === this.addressKey(paragraph.address)).sort((a, b) => a.control - b.control);
          const table = candidates[step.table], cell = table?.cells.find(item => item.index === step.cell);
          const next = cell?.paragraphs[step.para];
          if (!next) throw new Error('tab cell unavailable');
          paragraph = next;
        }
        const offsets = Array.from(paragraph.text).flatMap((char, index) => char === '\t' ? [index] : []);
        if (offsets.length !== spot.tabs || offsets[spot.tab] === undefined) continue;
        const offset = offsets[spot.tab], address = paragraph.address;
        const first = this.cursorRect({ address, offset: 0 }, model), before = this.cursorRect({ address, offset }, model), after = this.cursorRect({ address, offset: offset + 1 }, model);
        if (before.pageIndex !== after.pageIndex || Math.abs(before.y - after.y) > 1) continue;
        const width = Math.round((after.x - before.x) * 75);
        if (!Number.isSafeInteger(width) || width <= 0 || width > 0x7fffffff) continue;
        const properties: (ParagraphProperties & { tabAutoRight?: boolean }) | undefined = this.paragraphFormat(paragraph, model).properties;
        if (!properties || !Array.isArray(properties.tabStops) || typeof properties.tabAutoRight !== 'boolean') continue;
        const origin = first.x - (properties.marginLeft ?? 0) - Math.max(properties.indent ?? 0, 0);
        const at = before.x - origin;
        let type = properties.tabAutoRight ? 1 : 0, fill = 0;
        for (const raw of properties.tabStops) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.position !== 'number' || typeof raw.type !== 'number' || typeof raw.fill !== 'number') throw new Error('tab stop unavailable');
          if (raw.position / 150 > at + 0.5) { type = raw.type; fill = raw.fill; break; }
        }
        if (!Number.isInteger(type) || type < 0 || type > 3 || !Number.isInteger(fill) || fill < 0 || fill > 255) continue;
        result.push({ ...spot, width, type, fill });
      } catch { /* Never guess an unmatched or unmeasurable tab. */ }
    }
    return result;
  }
  hitTest(point: PagePoint): HitTestResult | undefined {
    integer(point?.page, 'page', this.pages() - 1);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new HwpHandsError('INVALID_ARGUMENT', 'Page coordinates must be finite numbers.');
    const pageInfo = parsed<PageInfo>(this.document.getPageInfo(point.page));
    if (point.x < 0 || point.y < 0 || point.x > pageInfo.width || point.y > pageInfo.height) return undefined;
    const model = this.structuralModel(), tree = this.tree(model), layout = this.pageLayout(point.page, model);
    const fallback = hitTestPage(layout, point.x, point.y, tree);
    if (fallback?.kind === 'object') return { kind: 'object', object: fallback.object };
    if (fallback?.kind === 'field') return { kind: 'field', address: fallback.field.address, offset: fallback.offset, field: fallback.field };
    if (fallback?.kind === 'tableCell') {
      return { kind: 'tableCell', ...(fallback.paragraph ? { address: fallback.paragraph.address, offset: 0 } : {}),
        cell: { tableNodePath: fallback.table.nodePath, controlIndex: fallback.table.control, cellIndex: fallback.cellIndex, row: fallback.row, col: fallback.col } };
    }
    if (fallback?.kind === 'paragraph' && (fallback.paragraph.address.kind !== 'body' || fallback.paragraph.address.cellPath?.length)) {
      return { kind: 'paragraph', address: fallback.paragraph.address, offset: fallback.offset };
    }
    const raw = parsed<{ sectionIndex: number; paragraphIndex: number; charOffset: number }>(this.document.hitTest(point.page, point.x, point.y));
    if (!Number.isSafeInteger(raw.sectionIndex) || !Number.isSafeInteger(raw.paragraphIndex) || !Number.isSafeInteger(raw.charOffset)) return undefined;
    const paragraph = this.paragraph({ section: raw.sectionIndex, paragraph: raw.paragraphIndex }, model);
    const offset = Math.min(paragraph.length, Math.max(0, raw.charOffset));
    const field = this.fields(model).find(item => item.address && this.addressKey(item.address) === this.addressKey(paragraph.address)
      && typeof item.startCharIdx === 'number' && typeof item.endCharIdx === 'number' && offset >= item.startCharIdx && offset <= item.endCharIdx);
    return field ? { kind: 'field', address: paragraph.address, offset, field } : { kind: 'paragraph', address: paragraph.address, offset };
  }
  selectionRects(range: SelectionRange): SelectionRect[] {
    if (!range?.start?.address || !range?.end?.address) throw new HwpHandsError('INVALID_ARGUMENT', 'Both endpoints of a selection are required.');
    const startAddress = range.start.address, endAddress = range.end.address;
    const model = this.structuralModel();
    const startParagraph = this.paragraphAt(startAddress, model), endParagraph = this.paragraphAt(endAddress, model);
    integer(range.start.offset, 'start.offset', startParagraph.length);
    integer(range.end.offset, 'end.offset', endParagraph.length);
    const ordered = startAddress.kind === endAddress.kind
      && startAddress.section === endAddress.section
      && (startAddress.kind === 'headerFooter' && endAddress.kind === 'headerFooter'
        ? startAddress.isHeader === endAddress.isHeader && startAddress.applyTo === endAddress.applyTo
        : startAddress.kind === 'footnote' || startAddress.kind === 'endnote'
          ? (endAddress.kind === 'footnote' || endAddress.kind === 'endnote') && sameNoteStory(startAddress, endAddress)
          : false);
    if (ordered && startAddress.kind !== 'body' && endAddress.kind !== 'body') {
      if (startAddress.paragraph > endAddress.paragraph || startAddress.paragraph === endAddress.paragraph && range.start.offset > range.end.offset) {
        throw new HwpHandsError('INVALID_ARGUMENT', 'Story selection endpoints must be in document order.');
      }
      const pages = this.pages(), rects: SelectionRect[] = [];
      if (startAddress.kind === 'headerFooter' && endAddress.kind === 'headerFooter') {
        for (let page = 0; page < pages; page++) {
          const info = parsed<PageInfo>(this.document.getPageInfo(page));
          if (info.sectionIndex !== startAddress.section) continue;
          rects.push(...parsed<SelectionRect[]>(this.document.getSelectionRectsInHeaderFooter(
            startAddress.section, startAddress.isHeader, startAddress.applyTo, page,
            startAddress.paragraph, range.start.offset, endAddress.paragraph, range.end.offset,
          )));
        }
      } else if (startAddress.kind === 'footnote' && endAddress.kind === 'footnote') {
        for (let page = 0; page < pages; page++) {
          const info = parsed<PageInfo>(this.document.getPageInfo(page));
          if (info.sectionIndex !== startAddress.section) continue;
          for (let index = 0; index < 128; index++) {
            let reference: { ok?: boolean; sectionIdx?: number; paraIdx?: number; controlIdx?: number; sourceType?: string } | null;
            try { reference = parsed(this.document.getPageFootnoteInfo(page, index)); } catch { break; }
            if (!reference || reference.ok === false) break;
            if (reference.sectionIdx !== startAddress.section || reference.paraIdx !== startAddress.anchor.paragraph
              || reference.controlIdx !== startAddress.controlIndex || reference.sourceType === 'endnote') continue;
            rects.push(...parsed<SelectionRect[]>(this.document.getSelectionRectsInFootnote(
              page, index, startAddress.paragraph, range.start.offset, endAddress.paragraph, range.end.offset,
            )));
          }
        }
      }
      // Endnote geometry has no dedicated RHWP query. The page text layout provides a
      // conservative fallback, and is also useful for header/footer or footnote pages
      // where the specialized query returns no rectangle.
      if (!rects.length) {
        for (let page = 0; page < pages; page++) {
          const layout = this.pageLayout(page, model);
          if (layout.info.sectionIndex !== startAddress.section) continue;
          for (let paragraph = startAddress.paragraph; paragraph <= endAddress.paragraph; paragraph++) {
            const address = { ...startAddress, paragraph };
            const text = this.paragraphAt(address, model);
            const from = paragraph === startAddress.paragraph ? range.start.offset : 0;
            const to = paragraph === endAddress.paragraph ? range.end.offset : text.length;
            rects.push(...layoutSelectionRects(layout, address, from, to).map(({ x, y, width, height }) => ({ pageIndex: page, x, y, width, height })));
          }
        }
      }
      return this.validateSelectionRects(rects);
    }
    let raw: string;
    if (startAddress.kind === 'body' && endAddress.kind === 'body' && !startAddress.cellPath?.length && !endAddress.cellPath?.length) {
      if (startAddress.section !== endAddress.section) throw new HwpHandsError('INVALID_ARGUMENT', 'A body selection must stay within one section.');
      if (startAddress.paragraph > endAddress.paragraph || startAddress.paragraph === endAddress.paragraph && range.start.offset > range.end.offset) {
        throw new HwpHandsError('INVALID_ARGUMENT', 'Selection endpoints must be in document order.');
      }
      raw = this.document.getSelectionRects(startAddress.section, startAddress.paragraph, range.start.offset, endAddress.paragraph, range.end.offset);
    } else if (startAddress.kind === 'body' && endAddress.kind === 'body' && startAddress.cellPath?.length && endAddress.cellPath?.length) {
      const startPath = startAddress.cellPath, endPath = endAddress.cellPath;
      const sameCell = startAddress.section === endAddress.section && startAddress.paragraph === endAddress.paragraph
        && startPath.length === endPath.length && startPath.every((step, index) => step.controlIndex === endPath[index].controlIndex
          && step.cellIndex === endPath[index].cellIndex && (index < startPath.length - 1 || (startAddress.containerKinds?.[index] ?? 'tableCell') === (endAddress.containerKinds?.[index] ?? 'tableCell')));
      if (!sameCell) throw new HwpHandsError('INVALID_ARGUMENT', 'A cell selection must stay inside the same table cell or text box.');
      const startPara = startPath.at(-1)!.cellParaIndex, endPara = endPath.at(-1)!.cellParaIndex;
      if (startPara > endPara || startPara === endPara && range.start.offset > range.end.offset) throw new HwpHandsError('INVALID_ARGUMENT', 'Selection endpoints must be in document order.');
      if (startPath.length === 1 && (startAddress.containerKinds?.[0] ?? 'tableCell') === 'tableCell') {
        raw = this.document.getSelectionRectsInCell(startAddress.section, startAddress.paragraph, startPath[0].controlIndex, startPath[0].cellIndex,
          startPara, range.start.offset, endPara, range.end.offset);
      } else {
        raw = this.document.getSelectionRectsInCellByPath(startAddress.section, startAddress.paragraph, JSON.stringify(startPath), startPara, range.start.offset, endPara, range.end.offset);
      }
    } else {
      throw new HwpHandsError('INVALID_ARGUMENT', 'Selections across body, table cells, and story paragraphs are not supported by this RHWP query.');
    }
    return this.validateSelectionRects(parsed<SelectionRect[]>(raw));
  }
  private validateSelectionRects(rects: SelectionRect[]): SelectionRect[] {
    if (!Array.isArray(rects) || rects.some(rect => !Number.isSafeInteger(rect.pageIndex) || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))) {
      throw new HwpHandsError('ENGINE_ERROR', 'RHWP returned invalid selection rectangles.');
    }
    return rects;
  }
  copy(range: SelectionRange): CopiedSelection {
    if (!range?.start?.address || !range?.end?.address) throw new HwpHandsError('INVALID_ARGUMENT', 'Both endpoints of a selection are required.');
    const startAddress = range.start.address, endAddress = range.end.address, model = this.structuralModel();
    const startParagraph = this.paragraphAt(startAddress, model), endParagraph = this.paragraphAt(endAddress, model);
    integer(range.start.offset, 'start.offset', startParagraph.length); integer(range.end.offset, 'end.offset', endParagraph.length);
    let paragraphs: Paragraph[];
    let html: string;
    if (startAddress.kind === 'body' && endAddress.kind === 'body' && !startAddress.cellPath?.length && !endAddress.cellPath?.length) {
      if (startAddress.section !== endAddress.section || startAddress.paragraph > endAddress.paragraph
        || startAddress.paragraph === endAddress.paragraph && range.start.offset > range.end.offset) {
        throw new HwpHandsError('INVALID_ARGUMENT', 'A body selection must be ordered and stay within one section.');
      }
      paragraphs = Array.from({ length: endAddress.paragraph - startAddress.paragraph + 1 }, (_, index) =>
        this.paragraph({ section: startAddress.section, paragraph: startAddress.paragraph + index }, model));
      html = this.document.exportSelectionHtml(startAddress.section, startAddress.paragraph, range.start.offset, endAddress.paragraph, range.end.offset);
    } else if (startAddress.kind === 'body' && endAddress.kind === 'body' && startAddress.cellPath?.length && endAddress.cellPath?.length) {
      const startPath = startAddress.cellPath, endPath = endAddress.cellPath;
      const sameCell = startAddress.section === endAddress.section && startAddress.paragraph === endAddress.paragraph
        && startPath.length === endPath.length && startPath.every((step, index) => step.controlIndex === endPath[index].controlIndex
          && step.cellIndex === endPath[index].cellIndex && (index < startPath.length - 1 || (startAddress.containerKinds?.[index] ?? 'tableCell') === (endAddress.containerKinds?.[index] ?? 'tableCell')));
      const startPara = startPath.at(-1)!.cellParaIndex, endPara = endPath.at(-1)!.cellParaIndex;
      if (!sameCell || startPara > endPara || startPara === endPara && range.start.offset > range.end.offset) {
        throw new HwpHandsError('INVALID_ARGUMENT', 'A cell selection must be ordered and stay inside one table cell or text box.');
      }
      paragraphs = Array.from({ length: endPara - startPara + 1 }, (_, index) => {
        const cellPath = startPath.map((step, depth) => depth === startPath.length - 1 ? { ...step, cellParaIndex: startPara + index } : step);
        return this.paragraph({ section: startAddress.section, paragraph: startAddress.paragraph, cellPath,
          ...(startAddress.containerKinds ? { containerKinds: startAddress.containerKinds } : {}) }, model);
      });
      html = startPath.length === 1 && (startAddress.containerKinds?.[0] ?? 'tableCell') === 'tableCell'
        ? this.document.exportSelectionInCellHtml(startAddress.section, startAddress.paragraph, startPath[0].controlIndex, startPath[0].cellIndex,
          startPara, range.start.offset, endPara, range.end.offset)
        : this.document.exportSelectionInCellHtmlByPath(startAddress.section, startAddress.paragraph, JSON.stringify(startPath),
          startPara, range.start.offset, endPara, range.end.offset);
    } else if (startAddress.kind === 'headerFooter' && endAddress.kind === 'headerFooter'
      && startAddress.section === endAddress.section && startAddress.isHeader === endAddress.isHeader
      && startAddress.applyTo === endAddress.applyTo && (startAddress.paragraph < endAddress.paragraph
        || startAddress.paragraph === endAddress.paragraph && range.start.offset <= range.end.offset)) {
      const result = parsed<{ ok?: boolean; text?: string }>(this.document.copySelectionInHeaderFooter(
        startAddress.section, startAddress.isHeader, startAddress.applyTo, startAddress.paragraph, range.start.offset,
        endAddress.paragraph, range.end.offset,
      ));
      if (result.ok !== true || typeof result.text !== 'string') throw new HwpHandsError('ENGINE_ERROR', 'RHWP could not copy the header/footer selection.');
      return { text: result.text, html: plainTextHtml(result.text) };
    } else if ((startAddress.kind === 'footnote' || startAddress.kind === 'endnote')
      && (endAddress.kind === 'footnote' || endAddress.kind === 'endnote') && sameNoteStory(startAddress, endAddress)
      && (startAddress.paragraph < endAddress.paragraph || startAddress.paragraph === endAddress.paragraph && range.start.offset <= range.end.offset)) {
      const selected = Array.from({ length: endAddress.paragraph - startAddress.paragraph + 1 }, (_, index) =>
        this.paragraphAt({ ...startAddress, paragraph: startAddress.paragraph + index }, model));
      const parts = selected.map((paragraph, index) => {
        const chars = Array.from(paragraph.text);
        return chars.slice(index === 0 ? range.start.offset : 0, index === selected.length - 1 ? range.end.offset : chars.length).join('');
      });
      const text = parts.join('\n');
      return { text, html: parts.map(part => `<p>${escapeHtml(part)}</p>`).join('') };
    } else {
      throw new HwpHandsError('INVALID_ARGUMENT', 'Selection endpoints must stay ordered inside one body region or story.');
    }
    const textValue = paragraphs.map((paragraph, index) => {
      const chars = Array.from(paragraph.text);
      return chars.slice(index === 0 ? range.start.offset : 0, index === paragraphs.length - 1 ? range.end.offset : chars.length).join('');
    }).join('\n');
    return { text: textValue, html };
  }
  moveCaret(position: TextPosition, motion: CaretMotion, preferredX?: number, pageHint?: number): import('./api').MoveCaretResult {
    const model = this.structuralModel();
    const current = this.caret(position, pageHint === undefined ? {} : { pageHint }), address = current.position.address;
    const paragraph = current.context.paragraph;
    if (preferredX !== undefined && !Number.isFinite(preferredX)) throw new HwpHandsError('INVALID_ARGUMENT', 'preferredX must be finite.');
    let target: TextPosition = current.position;
    let nextPreferredX = preferredX;
    let targetPageHint: number | undefined;
    const orderedParagraphs = (): Array<Paragraph | StoryParagraph> => this.paragraphList(true, true, model) as Array<Paragraph | StoryParagraph>;
    const adjacentParagraph = (direction: -1 | 1): TextPosition => {
      const all = orderedParagraphs();
      let items: Array<Paragraph | StoryParagraph>;
      if (address.kind === 'body' && address.cellPath?.length) {
        const currentPath = address.cellPath;
        const last = currentPath.at(-1)!;
        const sameFlow = (candidate: DocumentAddress): boolean => candidate.kind === 'body'
          && candidate.section === address.section && candidate.paragraph === address.paragraph
          && candidate.cellPath?.length === currentPath.length
          && candidate.cellPath.every((step, index) => step.controlIndex === currentPath[index].controlIndex
            && step.cellIndex === currentPath[index].cellIndex
            && (index === currentPath.length - 1 || step.cellParaIndex === currentPath[index].cellParaIndex)
            && (candidate.containerKinds?.[index] ?? 'tableCell') === (address.containerKinds?.[index] ?? 'tableCell'));
        items = all.filter(item => sameFlow(item.address)).sort((left, right) => {
          const leftIndex = left.address.kind === 'body' ? left.address.cellPath?.at(-1)?.cellParaIndex ?? -1 : -1;
          const rightIndex = right.address.kind === 'body' ? right.address.cellPath?.at(-1)?.cellParaIndex ?? -1 : -1;
          return leftIndex - rightIndex;
        });
        if (!items.some(item => item.address.kind === 'body' && item.address.cellPath?.at(-1)?.cellParaIndex === last.cellParaIndex)) return current.position;
      } else if (address.kind === 'body') {
        items = this.rootParagraphs(model).flat();
      } else if (address.kind === 'headerFooter') {
        items = all.filter((item): item is StoryParagraph => item.address.kind === 'headerFooter'
          && item.address.section === address.section && item.address.isHeader === address.isHeader && item.address.applyTo === address.applyTo);
      } else {
        items = all.filter((item): item is StoryParagraph => item.address.kind === address.kind && sameNoteStory(item.address, address));
      }
      const index = items.findIndex(item => this.addressKey(item.address) === this.addressKey(address));
      const adjacent = items[index + direction];
      if (!adjacent) return current.position;
      return { address: adjacent.address, offset: direction < 0 ? adjacent.length : 0 };
    };
    if (motion === 'up' || motion === 'down') {
      if (address.kind !== 'body') throw new HwpHandsError('INVALID_ARGUMENT', 'Vertical caret movement is currently available in the body and its cells.');
      const delta = motion === 'up' ? -1 : 1, x = preferredX ?? current.rect.x;
      const result = address.cellPath?.length
        ? parsed<Record<string, unknown>>(this.document.moveVerticalByPath(address.section, address.paragraph, JSON.stringify(address.cellPath), position.offset, delta, x))
        : parsed<Record<string, unknown>>(this.document.moveVertical(address.section, address.paragraph, position.offset, delta, x, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff));
      const section = result.sectionIndex, paragraphIndex = result.paragraphIndex, offset = result.charOffset;
      if (!Number.isSafeInteger(section) || !Number.isSafeInteger(paragraphIndex) || !Number.isSafeInteger(offset)) {
        throw new HwpHandsError('ENGINE_ERROR', 'RHWP returned an invalid vertical caret position.', result);
      }
      const cellPath = Array.isArray(result.cellPath) ? result.cellPath as Target['cellPath'] : undefined;
      const nextAddress: BodyAddress = { kind: 'body', section: section as number, paragraph: paragraphIndex as number,
        ...(cellPath?.length ? { cellPath, containerKinds: this.inferContainerKinds({ section: section as number, paragraph: paragraphIndex as number, cellPath }, model) } : {}) };
      target = { address: nextAddress, offset: offset as number };
      nextPreferredX = typeof result.preferredX === 'number' && Number.isFinite(result.preferredX) ? result.preferredX : x;
      targetPageHint = Number.isSafeInteger(result.pageIndex) ? result.pageIndex as number : undefined;
    } else if (motion === 'pageUp' || motion === 'pageDown') {
      const direction = motion === 'pageUp' ? -1 : 1;
      const targetPage = Math.max(0, Math.min(this.pages() - 1, current.rect.pageIndex + direction));
      const layout = this.pageLayout(targetPage, model), x = preferredX ?? current.rect.x;
      const candidates = layout.textRuns.filter(run => (run.documentAddress ?? run.address) && run.text.length > 0)
        .sort((left, right) => Math.abs(left.y - current.rect.y) - Math.abs(right.y - current.rect.y));
      let best: { address: import('./api').DocumentAddress; offset: number; x: number } | undefined;
      for (const run of candidates) {
        const address = (run.documentAddress ?? run.address)!;
        const length = Array.from(run.text).length, base = run.offset ?? run.charStart ?? 0;
        let local = 0, distance = Number.POSITIVE_INFINITY;
        for (let index = 0; index <= length; index++) {
          const charX = run.charX.length > index ? run.x + run.charX[index] : run.x + run.w * (length ? index / length : 0);
          const nextDistance = Math.abs(charX - x);
          if (nextDistance < distance) { distance = nextDistance; local = index; }
        }
        best = { address, offset: base + local, x: run.charX.length > local ? run.x + run.charX[local] : run.x + run.w * (length ? local / length : 0) };
        break;
      }
      if (best) {
        target = { address: best.address, offset: best.offset };
        nextPreferredX = best.x;
        targetPageHint = targetPage;
      } else nextPreferredX = undefined;
    } else if (motion === 'cellPrevious' || motion === 'cellNext') {
      if (address.kind !== 'body' || !address.cellPath?.length || address.containerKinds?.at(-1) === 'textBox') {
        throw new HwpHandsError('INVALID_ARGUMENT', 'Cell navigation requires a table-cell caret position.');
      }
      const last = address.cellPath.at(-1)!;
      const parentAddress: BodyAddress = { kind: 'body', section: address.section, paragraph: address.paragraph,
        ...(address.cellPath.length > 1 ? { cellPath: address.cellPath.slice(0, -1), containerKinds: address.containerKinds?.slice(0, -1) } : {}) };
      const table = this.tables(model).find(item => item.control === last.controlIndex && this.addressKey(item.address) === this.addressKey(parentAddress));
      const cellIndex = table?.cells.findIndex(cell => cell.index === last.cellIndex) ?? -1;
      const cell = table?.cells[cellIndex + (motion === 'cellNext' ? 1 : -1)];
      const destination = cell?.paragraphs[motion === 'cellNext' ? 0 : cell.paragraphs.length - 1];
      if (destination) target = { address: destination.address, offset: motion === 'cellNext' ? 0 : destination.length };
      nextPreferredX = undefined;
    } else if (motion === 'lineStart' || motion === 'lineEnd') {
      let raw: string;
      if (address.kind === 'body' && !address.cellPath?.length) raw = this.document.getLineInfo(address.section, address.paragraph, position.offset);
      else if (address.kind === 'body' && address.cellPath?.length === 1 && (address.containerKinds?.[0] ?? 'tableCell') === 'tableCell') {
        const step = address.cellPath[0];
        raw = this.document.getLineInfoInCell(address.section, address.paragraph, step.controlIndex, step.cellIndex, step.cellParaIndex, position.offset);
      } else throw new HwpHandsError('INVALID_ARGUMENT', 'Line-edge movement is unavailable for this story or nested text box.');
      const info = parsed<{ charStart: number; charEnd: number }>(raw);
      const offset = motion === 'lineStart' ? info.charStart : info.charEnd;
      integer(offset, 'line offset', paragraph.length); target = { address, offset }; nextPreferredX = undefined;
    } else if (motion === 'paragraphStart') { target = { address, offset: 0 }; nextPreferredX = undefined; }
    else if (motion === 'paragraphEnd') { target = { address, offset: paragraph.length }; nextPreferredX = undefined; }
    else if (motion === 'documentStart' || motion === 'documentEnd') {
      const roots = this.rootParagraphs(model).flat();
      const destination = roots[motion === 'documentStart' ? 0 : roots.length - 1];
      if (destination) target = { address: destination.address, offset: motion === 'documentStart' ? 0 : destination.length };
      nextPreferredX = undefined;
    } else if (motion === 'previous' || motion === 'next') {
      target = adjacentParagraph(motion === 'previous' ? -1 : 1); nextPreferredX = undefined;
    } else if (motion === 'left' || motion === 'right' || motion === 'wordLeft' || motion === 'wordRight') {
      const chars = Array.from(paragraph.text), direction = motion === 'left' || motion === 'wordLeft' ? -1 : 1;
      let offset = position.offset + direction;
      if (motion === 'wordLeft' || motion === 'wordRight') {
        const isWord = (value: string | undefined) => !!value && /[\p{L}\p{N}_]/u.test(value);
        if (direction < 0) {
          let index = Math.min(position.offset, chars.length);
          while (index > 0 && !isWord(chars[index - 1])) index--;
          while (index > 0 && isWord(chars[index - 1])) index--;
          offset = index;
        } else {
          let index = Math.min(position.offset, chars.length);
          while (index < chars.length && !isWord(chars[index])) index++;
          while (index < chars.length && isWord(chars[index])) index++;
          offset = index;
        }
      }
      if (offset < 0 || offset > chars.length) target = adjacentParagraph(direction);
      else target = { address, offset };
      nextPreferredX = undefined;
    } else {
      throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported caret motion.');
    }
    return { ...this.caret(target, targetPageHint === undefined ? {} : { pageHint: targetPageHint }), ...(nextPreferredX === undefined ? {} : { preferredX: nextPreferredX }) };
  }
  navigateHeaderFooterPage(currentPage: number, isHeader: boolean, direction: -1 | 1): import('./api').HeaderFooterPageNavigationResult {
    integer(currentPage, 'currentPage', this.pages() - 1);
    if (typeof isHeader !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'isHeader must be boolean.');
    if (direction !== -1 && direction !== 1) throw new HwpHandsError('INVALID_ARGUMENT', 'direction must be -1 or 1.');
    const result = parsed<{ ok?: boolean; pageIndex?: number; sectionIdx?: number; isHeader?: boolean; applyTo?: number }>(
      this.document.navigateHeaderFooterByPage(currentPage, isHeader, direction),
    );
    if (result.ok !== true) return { ok: false };
    if (!Number.isSafeInteger(result.pageIndex) || result.pageIndex! < 0 || result.pageIndex! >= this.pages()
      || !Number.isSafeInteger(result.sectionIdx) || result.sectionIdx! < 0 || result.sectionIdx! >= this.document.getSectionCount()
      || result.isHeader !== isHeader || !Number.isSafeInteger(result.applyTo) || result.applyTo! < 0 || result.applyTo! > 2) {
      throw new HwpHandsError('ENGINE_ERROR', 'RHWP returned an invalid header/footer page destination.', result);
    }
    return { ok: true, pageIndex: result.pageIndex, section: result.sectionIdx, isHeader: result.isHeader, applyTo: result.applyTo };
  }
  private pageLayout(page: number, model: StructuralModel): PageLayout {
    integer(page, 'page', this.pages() - 1);
    const info = parsed<PageInfo>(this.document.getPageInfo(page));
    const storyParagraphs = (this.paragraphList(true, true, model) as Array<Paragraph | StoryParagraph>)
      .filter((paragraph): paragraph is StoryParagraph => paragraph.address.kind !== 'body');
    const rawText = parsed<{ runs?: RawLayoutTextRun[] }>(this.document.getPageTextLayout(page));
    const textRuns: LayoutTextRun[] = (rawText.runs ?? []).map(run => {
      let documentAddress: BodyAddress | StoryParagraph['address'] | undefined;
      if (typeof run.secIdx === 'number' && Array.isArray(run.cellPath) && run.cellPath.length && typeof run.parentParaIdx === 'number') {
        const target: Target = { section: run.secIdx, paragraph: run.parentParaIdx, cellPath: run.cellPath };
        const containerKinds = this.inferContainerKinds(target, model);
        documentAddress = { ...target, containerKinds, kind: 'body' };
      } else if (typeof run.secIdx === 'number' && Number.isSafeInteger(run.paraIdx) && run.secIdx < this.document.getSectionCount()) {
        const paragraphCount = this.document.getParagraphCount(run.secIdx), paraIndex = run.paraIdx!;
        if (paraIndex < paragraphCount) documentAddress = { section: run.secIdx, paragraph: paraIndex, kind: 'body' };
        else if (typeof run.text === 'string' && run.text.trim()) {
          const storyKind = paraIndex === 0xffff_ffff ? 'headerFooter' : paraIndex > 0x7fff_ffff ? 'footnote' : 'endnote';
          const isHeader = storyKind === 'headerFooter' ? run.y < info.height / 2 : undefined;
          const candidates = storyParagraphs.filter(paragraph => paragraph.address.section === run.secIdx
            && paragraph.address.kind === storyKind
            && (storyKind !== 'headerFooter' || (paragraph.address.kind === 'headerFooter' && paragraph.address.isHeader === isHeader))
            && paragraph.text.includes(run.text.trim()));
          if (candidates.length === 1) documentAddress = candidates[0].address;
        }
      }
      return {
        ...run,
        text: run.text, x: run.x, y: run.y, w: run.w, h: run.h, width: run.w, height: run.h, charX: run.charX ?? [],
        fontFamily: run.fontFamily ?? '', fontSize: run.fontSize ?? 0, bold: run.bold ?? false,
        italic: run.italic ?? false, underline: run.underline ?? false, strikethrough: run.strikethrough ?? false,
        textColor: run.textColor ?? '#000000', ...(run.charShapeId === undefined ? {} : { charShapeId: run.charShapeId }),
        ...(run.paraShapeId === undefined ? {} : { paraShapeId: run.paraShapeId }),
        ...(documentAddress?.kind === 'body' ? { address: documentAddress } : {}), ...(documentAddress ? { documentAddress } : {}),
        ...(run.charStart === undefined ? {} : { offset: run.charStart }),
      };
    });
    const rawControls = parsed<RawLayoutControls>(this.document.getPageControlLayout(page));
    const controls: LayoutControl[] = (rawControls.controls ?? []).map(raw => ({
      type: String(raw.type), x: Number(raw.x), y: Number(raw.y), width: Number(raw.w), height: Number(raw.h),
      section: Number(raw.secIdx), paragraph: Number(raw.paraIdx), controlIndex: Number(raw.controlIdx),
      plane: Number(raw.plane ?? 0), zOrder: Number(raw.zOrder ?? 0), stableIndex: Array.isArray(raw.stableIndex) ? raw.stableIndex as number[] : [],
      ...(typeof raw.wrap === 'string' ? { wrap: raw.wrap } : {}),
      ...(Array.isArray(raw.cells) ? { cells: raw.cells.map(cell => {
        const value = cell as Record<string, unknown>;
        return { x: Number(value.x), y: Number(value.y), width: Number(value.w), height: Number(value.h), row: Number(value.row), col: Number(value.col), rowSpan: Number(value.rowSpan), colSpan: Number(value.colSpan), cellIndex: Number(value.cellIdx) };
      }) } : {}),
    }));
    return { page, info, runs: textRuns, textRuns, controls };
  }
  layout(page: number): PageLayout { return this.pageLayout(page, this.structuralModel()); }
  export(format: Format, fileName?: string): Uint8Array {
    const output = this.exportWithReport(format, fileName);
    if (output.contentLoss.count > 0) throw new HwpHandsError('CONTENT_LOSS', '엔진이 저장 시 내용 손실을 보고했습니다.', output.contentLoss);
    return output.bytes;
  }
  exportWithReport(format: Format, fileName?: string): { bytes: Uint8Array; contentLoss: { count: number; losses: Json[] } } {
    if (fileName === undefined) return this.exportCurrent(format);
    text(fileName);
    const previousFileName = this.currentFileName;
    this.document.setFileName(fileName);
    this.currentFileName = fileName;
    try { return this.exportCurrent(format); }
    finally {
      this.document.setFileName(previousFileName);
      this.currentFileName = previousFileName;
    }
  }
  private exportCurrent(format: Format): { bytes: Uint8Array; contentLoss: { count: number; losses: Json[] } } {
    const output = format === 'hwp' ? this.document.exportHwpWithReport() : this.document.exportHwpxWithReport();
    try {
      const report = parsed<{ count: number; losses: Json[] }>(output.contentLoss());
      return { bytes: output.takeBytes(), contentLoss: report };
    } finally { output.free(); }
  }
  private insert(t: TextTarget, offset: number, value: string): Record<string, Json> {
    text(value); const p = this.paragraphAt(t); integer(offset, 'offset', p.length); const address = p.address;
    if (address.kind === 'body') return checked(address.cellPath?.length
      ? this.document.insertTextInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath), offset, value)
      : this.document.insertText(address.section, address.paragraph, offset, value));
    if (address.kind === 'headerFooter') return checked(this.document.insertTextInHeaderFooter(address.section, address.isHeader, address.applyTo, address.paragraph, offset, value));
    return checked(this.document.insertTextInFootnote(address.section, address.anchor.paragraph, address.controlIndex, address.paragraph, offset, value));
  }
  /**
   * A new root paragraph in front of `address`: the text goes in at its head and the paragraph is split right after it.
   * The new paragraph takes that paragraph's shape and first character shape; section, column, header and footer controls
   * stay at the head of the section, and inline tables and objects stay with the old text. Text typed at the head of a
   * paragraph whose field starts there would land inside the field, so a paragraph with a field is refused.
   */
  private insertBefore(address: Target, value: string): Record<string, Json> {
    const key = nodePath(address);
    if (this.fields(this.structuralModel()).some(field => field.address && nodePath(field.address) === key))
      throw new HwpHandsError('INVALID_ARGUMENT', '누름틀이 있는 문단 앞에는 그 문단의 서식으로 문단을 넣을 수 없습니다.', { reason: 'anchored-content' });
    // Splitting at offset 0 would keep inline objects in the new paragraph, so an empty one is made around a placeholder.
    const placed = value || ' ';
    const result = this.insert(address, 0, placed);
    this.splitParagraphAt(address, Array.from(placed).length);
    if (!value) this.remove(address, 0, 1);
    return result;
  }
  private pasteHtml(target: TextTarget, offset: number, html: string): Record<string, Json> {
    if (typeof html !== 'string' || html.includes('\0')) throw new HwpHandsError('INVALID_ARGUMENT', 'pasteHtml requires a valid HTML string.');
    if (new TextEncoder().encode(html).byteLength > MAX_PASTE_HTML_BYTES) throw new HwpHandsError('INVALID_ARGUMENT', 'pasteHtml exceeds the 1 MiB limit.');
    const paragraph = this.paragraphAt(target), address = paragraph.address;
    integer(offset, 'offset', paragraph.length);
    if (address.kind !== 'body') throw new HwpHandsError('INVALID_ARGUMENT', 'pasteHtml is supported only in the body and table cells.');
    return checked(address.cellPath?.length
      ? this.document.pasteHtmlInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath), offset, html)
      : this.document.pasteHtml(address.section, address.paragraph, offset, html));
  }
  private remove(t: TextTarget, offset: number, count: number): Record<string, Json> {
    const p = this.paragraphAt(t); integer(offset, 'offset', p.length); integer(count, 'count', p.length - offset); const address = p.address;
    if (address.kind === 'body') return checked(address.cellPath?.length
      ? this.document.deleteTextInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath), offset, count)
      : this.document.deleteText(address.section, address.paragraph, offset, count));
    if (address.kind === 'headerFooter') return checked(this.document.deleteTextInHeaderFooter(address.section, address.isHeader, address.applyTo, address.paragraph, offset, count));
    return checked(this.document.deleteTextInFootnote(address.section, address.anchor.paragraph, address.controlIndex, address.paragraph, offset, count));
  }
  private replace(t: TextTarget, value: string, expectedText?: string, preserveFormatting = false, normalizeFormAnswer = false, rewriteFormatting = false, rewriteVersion?: string): Record<string, Json> {
    text(value); const p = this.paragraphAt(t);
    if (typeof preserveFormatting !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'preserveFormatting must be boolean.');
    if (typeof normalizeFormAnswer !== 'boolean' || (normalizeFormAnswer && (p.address.kind !== 'body' || !p.address.cellPath?.length || p.address.containerKinds?.includes('textBox')))) throw new HwpHandsError('INVALID_ARGUMENT', '양식 답안 정리는 표 셀 문단에서만 지원합니다.');
    if (expectedText !== undefined && expectedText !== p.text) throw new HwpHandsError('REVISION_CONFLICT', '문단 원문이 변경되었습니다.');
    if (typeof rewriteFormatting !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'rewriteFormatting must be boolean.');
    if ((!rewriteFormatting && rewriteVersion !== undefined) || (rewriteFormatting && rewriteVersion !== REWRITE_DIFF_VERSION))
      throw new HwpHandsError('INVALID_ARGUMENT', '지원하지 않는 재작성 알고리즘 버전입니다.');
    if (rewriteFormatting) {
      if (expectedText === undefined || preserveFormatting || normalizeFormAnswer || p.address.kind !== 'body' || p.address.cellPath?.length || !p.text
        // eslint-disable-next-line no-control-regex -- Replacement text must reject control characters.
        || Array.from(p.text).length > 2000 || Array.from(value).length > 20000 || /[\u0000-\u001f\u007f]/u.test(p.text) || /[\u0000-\u001f\u007f]/u.test(value))
        throw new HwpHandsError('INVALID_ARGUMENT', '재작성은 원문이 확인된 일반 본문 문단에서만 지원합니다.');
      if (this.hasAnchors(p.address)) throw new HwpHandsError('INVALID_ARGUMENT', '앵커가 있는 문단은 재작성할 수 없습니다.', { reason: 'anchored-content' });
      const oldLength = Array.from(p.text).length, newLength = Array.from(value).length;
      if (oldLength !== p.length) throw new HwpHandsError('VERIFY_FAILED', '문단 문자 오프셋을 확인하지 못했습니다.');
      let expectedRuns: RewriteShapeRun[], hunks;
      try {
        const runs = parsed<RewriteShapeRun[]>(this.document.getCharShapeRuns(p.address.section, p.address.paragraph, 0, p.length));
        const edits = rewriteDiff(p.text, value);
        expectedRuns = rewriteShapeRuns(p.text, value, runs, edits);
        hunks = rewriteHunks(edits);
      } catch {
        throw new HwpHandsError('VERIFY_FAILED', '재작성의 원문 서식 또는 계산 한도를 확인하지 못했습니다.');
      }
      for (const hunk of hunks.reverse()) {
        if (hunk.removed) this.remove(t, hunk.start, hunk.removed);
        if (hunk.inserted) this.insert(t, hunk.start, hunk.inserted);
      }
      if (expectedRuns.length) checked(this.document.setCharShapeRuns(p.address.section, p.address.paragraph, 0, newLength, JSON.stringify(expectedRuns)));
      const actual = this.paragraphAt(t);
      if (actual.text !== value || actual.length !== newLength) throw new HwpHandsError('VERIFY_FAILED', '재작성 결과의 텍스트를 확인하지 못했습니다.');
      const actualRuns = newLength ? parsed<RewriteShapeRun[]>(this.document.getCharShapeRuns(p.address.section, p.address.paragraph, 0, newLength)) : [];
      const expanded = (runs: RewriteShapeRun[]): number[] => {
        const ids: number[] = [];
        for (const run of runs) {
          if (run.startOffset !== ids.length || !Number.isSafeInteger(run.endOffset) || run.endOffset <= run.startOffset || run.endOffset > newLength || !Number.isSafeInteger(run.charShapeId) || run.charShapeId < 0)
            throw new HwpHandsError('VERIFY_FAILED', '재작성 결과의 글자 서식 범위를 확인하지 못했습니다.');
          while (ids.length < run.endOffset) ids.push(run.charShapeId);
        }
        if (ids.length !== newLength) throw new HwpHandsError('VERIFY_FAILED', '재작성 결과의 글자 서식이 불완전합니다.');
        return ids;
      };
      const expectedIds = expanded(expectedRuns);
      if (expanded(actualRuns).some((id, index) => id !== expectedIds[index])) throw new HwpHandsError('VERIFY_FAILED', '재작성 결과의 글자 서식이 다릅니다.');
      return { ok: true };
    }
    // Preserve unchanged runs and anchored controls by applying only the minimal text difference.
    const oldChars = Array.from(p.text), newChars = Array.from(value);
    let start = 0, tail = 0;
    while (start < oldChars.length && start < newChars.length && oldChars[start] === newChars[start]) start++;
    while (tail < oldChars.length - start && tail < newChars.length - start && oldChars.at(-1 - tail) === newChars.at(-1 - tail)) tail++;
    if (oldChars.length !== newChars.length || oldChars.slice(start, oldChars.length - tail).length) {
      if (p.address.kind === 'body' && this.hasAnchors(p.address)) {
        throw new HwpHandsError('INVALID_ARGUMENT', 'A paragraph with anchored controls, fields or objects cannot be replaced as plain text.', { reason: 'anchored-content' });
      }
    }
    const removed = oldChars.length - start - tail, inserted = newChars.length - start - tail;
    type ShapeRun = { startOffset: number; endOffset: number; charShapeId: number };
    let restore: ShapeRun[] | undefined;
    const address = p.address;
    if (preserveFormatting && (removed || inserted)) {
      if (address.kind !== 'body' || address.containerKinds?.includes('textBox')) {
        throw new HwpHandsError('INVALID_ARGUMENT', '서식 보존 치환은 본문과 표 셀에서만 지원합니다.', { reason: 'format-preservation' });
      }
      const runs = parsed<ShapeRun[]>(address.cellPath?.length
        ? this.document.getCharShapeRunsInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath), 0, p.length)
        : this.document.getCharShapeRuns(address.section, address.paragraph, 0, p.length));
      let covered = 0;
      for (const run of runs) {
        if (run.startOffset !== covered || run.endOffset <= covered || run.endOffset > p.length || !Number.isSafeInteger(run.charShapeId) || run.charShapeId < 0)
          throw new HwpHandsError('INVALID_ARGUMENT', '원래 글자 서식 범위를 확인하지 못했습니다.', { reason: 'format-preservation' });
        covered = run.endOffset;
      }
      if (covered !== p.length) throw new HwpHandsError('INVALID_ARGUMENT', '원래 글자 서식 범위가 불완전합니다.', { reason: 'format-preservation' });
      const cut = (from: number, to: number, shift = 0): ShapeRun[] => runs.filter(run => run.startOffset < to && run.endOffset > from)
        .map(run => ({ ...run, startOffset: Math.max(from, run.startOffset) + shift, endOffset: Math.min(to, run.endOffset) + shift }));
      const replaced = cut(start, start + removed);
      if (inserted && removed !== inserted && new Set(replaced.map(run => run.charShapeId)).size > 1)
        throw new HwpHandsError('INVALID_ARGUMENT', '길이가 달라지는 혼합 서식 치환은 서식을 안전하게 대응시킬 수 없습니다. 같은 서식의 문구 단위로 나누어 수정하세요.', { reason: 'format-preservation', kind: 'mixed-length' });
      // Equal-length replacements keep each original position's complete native shape.
      // A length change inherits the replaced span's single shape; pure insertion uses the left neighbour (right at paragraph start).
      const inherited = replaced[0]?.charShapeId ?? runs.find(run => run.startOffset <= Math.max(0, start - 1) && run.endOffset > Math.max(0, start - 1))?.charShapeId;
      restore = [...cut(0, start),
        ...(inserted === removed ? replaced : inserted && inherited !== undefined ? [{ startOffset: start, endOffset: start + inserted, charShapeId: inherited }] : []),
        ...cut(start + removed, p.length, inserted - removed)];
    }
    if (removed) this.remove(t, start, removed);
    const added = newChars.slice(start, newChars.length - tail).join('');
    if (added) this.insert(t, start, added);
    if (restore?.length && address.kind === 'body') {
      checked(address.cellPath?.length
        ? this.document.setCharShapeRunsInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath), 0, newChars.length, JSON.stringify(restore))
        : this.document.setCharShapeRuns(address.section, address.paragraph, 0, newChars.length, JSON.stringify(restore)));
    }
    if (normalizeFormAnswer && value && address.kind === 'body') this.normalizeFormAnswer(address, 0, Array.from(value).length);
    return { ok: true };
  }
  private normalizeFormAnswer(address: BodyAddress, start: number, end: number): void {
    if (start === end) return;
    const paragraph = this.paragraph(address), runs = this.modelCharacterRuns(paragraph, { byKey: new Map(), distinct: [] })
      .filter(run => run.offset < end && run.offset + run.length > start);
    let covered = start;
    for (const run of runs) {
      const from = Math.max(start, run.offset), to = Math.min(end, run.offset + run.length);
      if (from !== covered || to <= from || typeof run.properties.italic !== 'boolean' || typeof run.properties.textColor !== 'string' || !/^#[\da-f]{6}$/i.test(run.properties.textColor))
        throw new HwpHandsError('VERIFY_FAILED', '양식 답안의 글자 서식을 확인할 수 없습니다.');
      covered = to;
    }
    if (covered !== end) throw new HwpHandsError('VERIFY_FAILED', '양식 답안의 글자 서식 범위가 불완전합니다.');
    for (const run of runs) {
      const white = run.properties.textColor!.toLowerCase() === '#ffffff';
      if (run.properties.italic || (!white && run.properties.textColor!.toLowerCase() !== '#000000'))
        this.applyCharacterFormat(address, Math.max(start, run.offset), Math.min(end, run.offset + run.length), { italic: false, ...(white ? {} : { textColor: '#000000' }) });
    }
  }
  private hasAnchors(address: BodyAddress, model = this.structuralModel()): boolean {
    const key = nodePath(address);
    // Section/column definitions are structural controls, not inline anchors that a text edit can consume.
    return this.controls(model).some(control => nodePath(control.address) === key && control.ctrlId !== 'secd' && control.ctrlId !== 'cold')
      || this.fields(model).some(field => field.address && nodePath(field.address) === key)
      || this.objects(model, false).some(object => nodePath(object.address) === key);
  }
  private replaceRange(start: TextPosition, end: TextPosition, value: string): Record<string, Json> {
    text(value);
    if (!start?.address || !end?.address || start.address.kind !== 'body' || end.address.kind !== 'body' || start.address.cellPath?.length || end.address.cellPath?.length || start.address.section !== end.address.section) {
      throw new HwpHandsError('INVALID_ARGUMENT', 'Multi-paragraph replacement is limited to one section of the root body.');
    }
    const model = this.structuralModel(), first = this.paragraph(start.address, model), last = this.paragraph(end.address, model);
    integer(start.offset, 'start.offset', first.length); integer(end.offset, 'end.offset', last.length);
    if (start.address.paragraph > end.address.paragraph || start.address.paragraph === end.address.paragraph && start.offset > end.offset) throw new HwpHandsError('INVALID_ARGUMENT', 'The replacement range is reversed.');
    if (start.address.paragraph === end.address.paragraph) {
      if (this.hasAnchors(start.address, model)) throw new HwpHandsError('INVALID_ARGUMENT', 'A range inside a paragraph with anchored controls or fields cannot be replaced safely.');
      const count = end.offset - start.offset;
      if (count) this.remove(start.address, start.offset, count);
      if (value) this.insert(start.address, start.offset, value);
      return { ok: true, section: start.address.section, paragraph: start.address.paragraph, offset: start.offset };
    }
    for (let paragraph = start.address.paragraph; paragraph <= end.address.paragraph; paragraph++) {
      const address: BodyAddress = { kind: 'body', section: start.address.section, paragraph };
      if (this.hasAnchors(address, model)) throw new HwpHandsError('INVALID_ARGUMENT', 'A range crossing anchored controls or fields cannot be replaced safely.', { paragraph });
    }
    const result = checked(this.document.deleteRange(start.address.section, start.address.paragraph, start.offset, end.address.paragraph, end.offset));
    const paragraph = Number(result.paraIdx), offset = Number(result.charOffset);
    integer(paragraph, 'paraIdx', this.document.getParagraphCount(start.address.section) - 1);
    integer(offset, 'charOffset');
    if (value) this.insert({ section: start.address.section, paragraph }, offset, value);
    return { ok: true, section: start.address.section, paragraph, offset };
  }
  private deleteRange(start: TextPosition, end: TextPosition, deleteAnchoredContent = false): Record<string, Json> {
    if (typeof deleteAnchoredContent !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'deleteAnchoredContent must be a boolean.');
    if (!start?.address || !end?.address || start.address.kind !== 'body' || end.address.kind !== 'body'
      || start.address.section !== end.address.section) {
      throw new HwpHandsError('INVALID_ARGUMENT', 'Range deletion is limited to one body section or one table cell.');
    }
    const startAddress = start.address, endAddress = end.address;
    const startPath = startAddress.cellPath ?? [], endPath = endAddress.cellPath ?? [];
    if (!!startPath.length !== !!endPath.length) throw new HwpHandsError('INVALID_ARGUMENT', 'A range cannot cross between the body and a table cell.');
    if (startPath.length) {
      const sameCell = startAddress.paragraph === endAddress.paragraph && startPath.length === endPath.length
        && startPath.every((step, index) => {
          const other = endPath[index];
          return step.controlIndex === other.controlIndex && step.cellIndex === other.cellIndex
            && (index === startPath.length - 1 || step.cellParaIndex === other.cellParaIndex)
            && (startAddress.containerKinds?.[index] ?? 'tableCell') === (endAddress.containerKinds?.[index] ?? 'tableCell');
        });
      if (!sameCell) throw new HwpHandsError('INVALID_ARGUMENT', 'A range must stay inside one table cell or text box.');
    }
    const model = this.structuralModel();
    const startParagraph = this.paragraphAt(startAddress, model), endParagraph = this.paragraphAt(endAddress, model);
    integer(start.offset, 'start.offset', startParagraph.length); integer(end.offset, 'end.offset', endParagraph.length);
    const first = startPath.length ? startPath.at(-1)!.cellParaIndex : startAddress.paragraph;
    const last = endPath.length ? endPath.at(-1)!.cellParaIndex : endAddress.paragraph;
    if (first > last || first === last && start.offset > end.offset) throw new HwpHandsError('INVALID_ARGUMENT', 'The deletion range is reversed.');
    if (first === last && start.offset === end.offset) return { ok: true, section: startAddress.section, paragraph: startAddress.paragraph, offset: start.offset };
    const addresses: BodyAddress[] = [];
    for (let paragraph = first; paragraph <= last; paragraph++) {
      addresses.push(startPath.length
        ? { ...startAddress, cellPath: startPath.map((step, index) => index === startPath.length - 1 ? { ...step, cellParaIndex: paragraph } : { ...step }) }
        : { ...startAddress, paragraph });
    }
    const anchored = addresses.find(address => this.hasAnchors(address, model));
    if (anchored && !deleteAnchoredContent) {
      throw new HwpHandsError('CONTENT_LOSS', 'The deletion range includes a field, inline control or object. Set deleteAnchoredContent=true only after explicit confirmation.', { address: anchored });
    }
    if (!startPath.length) {
      const count = last - first;
      if (!count) {
        if (anchored && deleteAnchoredContent) return checked(this.document.deleteRange(startAddress.section, startAddress.paragraph, start.offset, endAddress.paragraph, end.offset));
        if (end.offset > start.offset) this.remove(startAddress, start.offset, end.offset - start.offset);
        return { ok: true, section: startAddress.section, paragraph: startAddress.paragraph, offset: start.offset };
      }
      return checked(this.document.deleteRange(startAddress.section, startAddress.paragraph, start.offset, endAddress.paragraph, end.offset));
    }
    if (first === last) {
      if (anchored && deleteAnchoredContent) return checked(this.document.deleteRangeInCellByPath(
        startAddress.section, startAddress.paragraph, JSON.stringify(startPath), first, start.offset, last, end.offset,
      ));
      if (end.offset > start.offset) this.remove(startAddress, start.offset, end.offset - start.offset);
      return { ok: true, section: startAddress.section, paragraph: startAddress.paragraph, offset: start.offset };
    }
    return checked(this.document.deleteRangeInCellByPath(
      startAddress.section, startAddress.paragraph, JSON.stringify(startPath), first, start.offset, last, end.offset,
    ));
  }
  private splitParagraphAt(target: TextTarget, offset: number, verifyRewriteFormatting = false): Record<string, Json> {
    const paragraph = this.paragraphAt(target), address = paragraph.address;
    integer(offset, 'offset', paragraph.length);
    if (typeof verifyRewriteFormatting !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'verifyRewriteFormatting must be boolean.');
    if (verifyRewriteFormatting) {
      if (address.kind !== 'body' || address.cellPath?.length || !paragraph.text || offset <= 0 || offset >= paragraph.length
        || Array.from(paragraph.text).length !== paragraph.length || this.hasAnchors(address)) throw new HwpHandsError('INVALID_ARGUMENT', '재작성 분할의 원문 범위를 확인하지 못했습니다.');
      const shape = (p: Paragraph): string => {
        const model = this.structuralModel(), format = this.paragraphFormat(p, model);
        if (!format.nativeShape || !format.style || !format.properties) throw new HwpHandsError('VERIFY_FAILED', '문단 속성을 확인하지 못했습니다.');
        return JSON.stringify({ nativeShape: format.nativeShape, style: format.style, properties: format.properties });
      };
      const runs = (p: Paragraph): number[] => {
        const found = parsed<RewriteShapeRun[]>(this.document.getCharShapeRuns(p.address.section, p.address.paragraph, 0, p.length)), ids: number[] = [];
        for (const run of found) {
          if (run.startOffset !== ids.length || !Number.isSafeInteger(run.endOffset) || run.endOffset <= run.startOffset || run.endOffset > p.length || !Number.isSafeInteger(run.charShapeId) || run.charShapeId < 0)
            throw new HwpHandsError('VERIFY_FAILED', '분할 전후 글자 서식 범위를 확인하지 못했습니다.');
          while (ids.length < run.endOffset) ids.push(run.charShapeId);
        }
        if (ids.length !== p.length) throw new HwpHandsError('VERIFY_FAILED', '분할 전후 글자 서식이 불완전합니다.');
        return ids;
      };
      const beforeShape = shape(paragraph as Paragraph), beforeRuns = runs(paragraph as Paragraph), chars = Array.from(paragraph.text);
      const result = checked(this.document.splitParagraph(address.section, address.paragraph, offset, null));
      const first = this.paragraphAt(address) as Paragraph, second = this.paragraphAt({ ...address, paragraph: address.paragraph + 1 }) as Paragraph;
      if (first.text !== chars.slice(0, offset).join('') || second.text !== chars.slice(offset).join('') || shape(first) !== beforeShape || shape(second) !== beforeShape
        || JSON.stringify([...runs(first), ...runs(second)]) !== JSON.stringify(beforeRuns)) throw new HwpHandsError('VERIFY_FAILED', '재작성 분할의 텍스트 또는 서식이 달라졌습니다.');
      return result;
    }
    if (address.kind === 'body') return checked(address.cellPath?.length
      ? this.document.splitParagraphInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath), offset, null)
      : this.document.splitParagraph(address.section, address.paragraph, offset, null));
    if (address.kind === 'headerFooter') return checked(this.document.splitParagraphInHeaderFooter(address.section, address.isHeader, address.applyTo, address.paragraph, offset, null));
    return checked(this.document.splitParagraphInFootnote(address.section, address.anchor.paragraph, address.controlIndex, address.paragraph, offset, null));
  }
  private insertCellParagraph(c: Extract<Command, { type: 'insertCellParagraph' }>): Record<string, Json> {
    text(c.text); text(c.expectedText);
    // eslint-disable-next-line no-control-regex -- This text must reject control characters.
    if (/[\u0000-\u001f\u007f]/.test(c.text) || (c.position !== 'before' && c.position !== 'after'))
      throw new HwpHandsError('INVALID_ARGUMENT', '셀 문단에는 줄바꿈 없는 텍스트와 before/after 위치가 필요합니다.');
    const model = this.structuralModel(), paragraph = this.paragraphAt(c.target, model), address = paragraph.address;
    if (address.kind !== 'body' || address.cellPath?.length !== 1 || address.containerKinds?.includes('textBox'))
      throw new HwpHandsError('INVALID_ARGUMENT', '직접 표 셀 문단만 삽입 기준으로 사용할 수 있습니다.');
    if (paragraph.text !== c.expectedText) throw new HwpHandsError('REVISION_CONFLICT', '셀 문단의 내용이 관측한 값과 다릅니다.');
    if (this.hasAnchors(address, model)) throw new HwpHandsError('INVALID_ARGUMENT', '개체나 필드가 있는 셀 문단을 삽입 기준으로 사용할 수 없습니다.', { reason: 'anchored-content' });
    const next = structuredClone(address), step = next.cellPath!.at(-1)!;
    const count = this.document.getCellParagraphCountByPath(address.section, address.paragraph, JSON.stringify(address.cellPath));
    if (c.position === 'before') {
      this.insertBefore(address, c.text);
      step.cellParaIndex++;
    } else {
      this.splitParagraphAt(address, paragraph.length);
      step.cellParaIndex++;
      if (c.text) this.insert(next, 0, c.text);
    }
    const original = c.position === 'before' ? next : address;
    const inserted = c.position === 'before' ? address : next;
    if (this.document.getCellParagraphCountByPath(address.section, address.paragraph, JSON.stringify(address.cellPath)) !== count + 1
      || this.paragraph(original).text !== c.expectedText || this.paragraph(inserted).text !== c.text)
      throw new HwpHandsError('VERIFY_FAILED', '셀 문단 삽입 결과가 예상과 달라 변경을 되돌립니다.');
    return { ok: true };
  }
  private mergeParagraphAt(target: TextTarget): Record<string, Json> {
    const paragraph = this.paragraphAt(target), address = paragraph.address;
    if (address.kind === 'body') {
      if (address.cellPath?.length) {
        const last = address.cellPath.at(-1)!;
        if (last.cellParaIndex === 0) throw new HwpHandsError('INVALID_ARGUMENT', 'The first paragraph in a cell cannot be merged backward.');
        return checked(this.document.mergeParagraphInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath)));
      }
      if (address.paragraph === 0) throw new HwpHandsError('INVALID_ARGUMENT', 'The first paragraph in a section cannot be merged backward.');
      return checked(this.document.mergeParagraph(address.section, address.paragraph));
    }
    if (address.paragraph === 0) throw new HwpHandsError('INVALID_ARGUMENT', 'The first paragraph in a story cannot be merged backward.');
    if (address.kind === 'headerFooter') return checked(this.document.mergeParagraphInHeaderFooter(address.section, address.isHeader, address.applyTo, address.paragraph));
    return checked(this.document.mergeParagraphInFootnote(address.section, address.anchor.paragraph, address.controlIndex, address.paragraph));
  }
  private deleteParagraphAt(target: TextTarget): Record<string, Json> {
    const model = this.structuralModel(), paragraph = this.paragraphAt(target, model), address = paragraph.address;
    if (address.kind === 'body' && !address.cellPath?.length) {
      if (this.hasAnchors(address, model)) throw new HwpHandsError('INVALID_ARGUMENT', 'A paragraph with anchored controls or fields cannot be deleted safely.', { reason: 'anchored-content' });
      if (address.paragraph === 0 || this.document.getParagraphCount(address.section) <= 1) throw new HwpHandsError('INVALID_ARGUMENT', 'The first or only paragraph in a section cannot be deleted.', { reason: 'first-paragraph' });
      return checked(this.document.deleteParagraph(address.section, address.paragraph));
    }
    let siblingCount: number;
    if (address.kind === 'body') {
      if (this.hasAnchors(address, model)) throw new HwpHandsError('INVALID_ARGUMENT', 'A paragraph with anchored controls or fields cannot be deleted safely.');
      const position = this.listPosition(address, model), list = position && model.byListId.get(position.listId);
      if (!position || !list) throw new HwpHandsError('INVALID_ARGUMENT', 'The cell paragraph container could not be resolved.');
      siblingCount = list.paraCount;
      if (siblingCount > 1) return checked(this.document.deleteParagraphInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath)));
    } else {
      const siblings = this.paragraphList(true, true, model) as Array<Paragraph | StoryParagraph>;
      siblingCount = siblings.filter(item => {
        const other = item.address;
        if (other.kind !== address.kind) return false;
        if (other.kind === 'headerFooter' && address.kind === 'headerFooter') return other.section === address.section && other.isHeader === address.isHeader && other.applyTo === address.applyTo;
        if ((other.kind === 'footnote' || other.kind === 'endnote') && (address.kind === 'footnote' || address.kind === 'endnote')) return other.section === address.section && other.controlIndex === address.controlIndex && this.addressKey(other.anchor) === this.addressKey(address.anchor);
        return false;
      }).length;
    }
    this.replace(address, '');
    if (siblingCount <= 1) return { ok: true, emptiedRequiredParagraph: true };
    const index = address.kind === 'body' ? address.cellPath!.at(-1)!.cellParaIndex : address.paragraph;
    if (index > 0) return this.mergeParagraphAt(address);
    if (address.kind === 'body') {
      const nextPath = address.cellPath!.map(step => ({ ...step }));
      nextPath[nextPath.length - 1] = { ...nextPath.at(-1)!, cellParaIndex: 1 };
      return this.mergeParagraphAt({ ...address, cellPath: nextPath });
    }
    return this.mergeParagraphAt({ ...address, paragraph: 1 });
  }
  private setParagraphStyle(target: Target, styleId: number, model = this.structuralModel()): Record<string, Json> {
    this.validateTarget(target, model); integer(styleId, 'styleId');
    const styles = parsed<Array<{ id: number }>>(this.document.getStyleList());
    if (!styles.some(style => style.id === styleId)) throw new HwpHandsError('INVALID_ARGUMENT', 'styleId is not defined in this document.');
    if (!target.cellPath?.length) return checked(this.document.applyStyle(target.section, target.paragraph, styleId));
    if (target.cellPath.length !== 1 || target.containerKinds?.[0] === 'textBox') throw new HwpHandsError('INVALID_ARGUMENT', 'Style application is supported for root paragraphs and direct table cells only.');
    const step = target.cellPath[0];
    return checked(this.document.applyCellStyle(target.section, target.paragraph, step.controlIndex, step.cellIndex, step.cellParaIndex, styleId));
  }
  private setParagraphList(target: Target, list: ParagraphList, model = this.structuralModel()): Record<string, Json> {
    this.validateTarget(target, model);
    if ((target.cellPath?.length ?? 0) > 1) throw new HwpHandsError('INVALID_ARGUMENT', 'Paragraph lists are supported in root paragraphs and direct cells only; nested-cell list formatting is unavailable in 현재 RHWP 코어.');
    const position = this.listPosition(target, model);
    if (!position) throw new HwpHandsError('INVALID_ARGUMENT', 'The paragraph list position could not be resolved.');
    let properties: Record<string, Json>;
    if (list.kind === 'none') properties = { headType: 'None', numberingId: 0, paraLevel: 0 };
    else if (list.kind === 'numbering') {
      const definitions = parsed<Array<{ id: number; levelFormats?: string[] }>>(this.document.getNumberingList());
      const numberingId = list.numberingId ?? this.document.ensureDefaultNumbering();
      if (list.numberingId !== undefined) integer(numberingId, 'numberingId', Math.max(0, ...definitions.map(item => item.id)) || Number.MAX_SAFE_INTEGER);
      else integer(numberingId, 'numberingId');
      const definition = definitions.find(item => item.id === numberingId) ?? (list.numberingId === undefined ? { id: numberingId, levelFormats: [''] } : undefined);
      if (!definition) throw new HwpHandsError('INVALID_ARGUMENT', 'numberingId is not defined in this document.');
      const level = list.level ?? 0; integer(level, 'level', Math.max(0, (definition.levelFormats?.length ?? 1) - 1));
      properties = { headType: 'Number', numberingId, paraLevel: level };
    } else if (list.kind === 'bullet') {
      const char = list.char ?? '•';
      if (Array.from(char).length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', 'Bullet char must be one Unicode code point.');
      const numberingId = this.document.ensureDefaultBullet(char);
      const level = list.level ?? 0; integer(level, 'level', 6);
      properties = { headType: 'Bullet', numberingId, paraLevel: level };
    } else throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported paragraph list kind.');
    return checked(this.document.applyParaFormatAtCursor(position.listId, position.paragraph, JSON.stringify(properties)));
  }
  private validateCharacterProperties(value: unknown): asserts value is Extract<Command, { type: 'formatText' }>['properties'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HwpHandsError('INVALID_ARGUMENT', 'Character properties must be an object.');
    const properties = value as Record<string, unknown>;
    const booleanKeys = new Set(['bold', 'italic', 'underline', 'strikethrough', 'subscript', 'superscript', 'emboss', 'engrave', 'kerning']);
    const allowedKeys = new Set([...booleanKeys, 'fontFamilies', 'fontLanguage', 'fontFamily', 'fontSize', 'textColor', 'shadeColor', 'ratio', 'characterSpacing', 'relativeSize', 'characterOffset', 'underlineType', 'underlineColor', 'underlineShape', 'strikeColor', 'strikeShape', 'outlineType', 'shadowType', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'emphasisDot']);
    for (const [key, property] of Object.entries(properties)) {
      if (!allowedKeys.has(key)) throw new HwpHandsError('INVALID_ARGUMENT', `Unsupported character property: ${key}.`);
      if (booleanKeys.has(key) && typeof property !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be boolean.`);
    }
    if (properties.fontSize !== undefined && (typeof properties.fontSize !== 'number' || !Number.isFinite(properties.fontSize) || properties.fontSize < 1 || properties.fontSize > 1000)) throw new HwpHandsError('INVALID_ARGUMENT', 'fontSize must be 1–1000pt.');
    if (properties.ratio !== undefined && (typeof properties.ratio !== 'number' || !Number.isSafeInteger(properties.ratio) || properties.ratio < 50 || properties.ratio > 200)) throw new HwpHandsError('INVALID_ARGUMENT', 'ratio must be an integer from 50 to 200 percent.');
    if (properties.characterSpacing !== undefined && (typeof properties.characterSpacing !== 'number' || !Number.isSafeInteger(properties.characterSpacing) || properties.characterSpacing < -50 || properties.characterSpacing > 50)) throw new HwpHandsError('INVALID_ARGUMENT', 'characterSpacing must be an integer from -50 to 50 percent.');
    if (properties.relativeSize !== undefined && (typeof properties.relativeSize !== 'number' || !Number.isSafeInteger(properties.relativeSize) || properties.relativeSize < 10 || properties.relativeSize > 250)) throw new HwpHandsError('INVALID_ARGUMENT', 'relativeSize must be an integer from 10 to 250 percent.');
    if (properties.characterOffset !== undefined && (typeof properties.characterOffset !== 'number' || !Number.isSafeInteger(properties.characterOffset) || properties.characterOffset < -100 || properties.characterOffset > 100)) throw new HwpHandsError('INVALID_ARGUMENT', 'characterOffset must be an integer from -100 to 100 percent.');
    if (properties.underlineType !== undefined && !['None', 'Bottom', 'Top'].includes(properties.underlineType as string)) throw new HwpHandsError('INVALID_ARGUMENT', 'underlineType must be None, Bottom or Top.');
    if (properties.outlineType !== undefined && (typeof properties.outlineType !== 'number' || !Number.isSafeInteger(properties.outlineType) || properties.outlineType < 0 || properties.outlineType > 7)) throw new HwpHandsError('INVALID_ARGUMENT', 'outlineType must be an integer from 0 to 7.');
    if (properties.shadowType !== undefined && (typeof properties.shadowType !== 'number' || !Number.isSafeInteger(properties.shadowType) || properties.shadowType < 0 || properties.shadowType > 2)) throw new HwpHandsError('INVALID_ARGUMENT', 'shadowType must be 0, 1 or 2.');
    for (const key of ['underlineShape', 'strikeShape'] as const) if (properties[key] !== undefined && (typeof properties[key] !== 'number' || !Number.isSafeInteger(properties[key]) || properties[key] < 0 || properties[key] > 10)) throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be an integer from 0 to 10.`);
    if (properties.emphasisDot !== undefined && (typeof properties.emphasisDot !== 'number' || !Number.isSafeInteger(properties.emphasisDot) || properties.emphasisDot < 0 || properties.emphasisDot > 6)) throw new HwpHandsError('INVALID_ARGUMENT', 'emphasisDot must be an integer from 0 to 6.');
    for (const key of ['shadowOffsetX', 'shadowOffsetY'] as const) if (properties[key] !== undefined && (typeof properties[key] !== 'number' || !Number.isSafeInteger(properties[key]) || properties[key] < -100 || properties[key] > 100)) throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be an integer from -100 to 100 percent.`);
    if (properties.superscript === true && properties.subscript === true) throw new HwpHandsError('INVALID_ARGUMENT', 'superscript and subscript cannot both be true.');
    if (properties.emboss === true && properties.engrave === true) throw new HwpHandsError('INVALID_ARGUMENT', 'emboss and engrave cannot both be true.');
    for (const key of ['textColor', 'shadeColor', 'underlineColor', 'strikeColor', 'shadowColor'] as const) if (properties[key] !== undefined && (typeof properties[key] !== 'string' || !/^#[\da-f]{6}$/i.test(properties[key]))) throw new HwpHandsError('INVALID_ARGUMENT', `${key} must use #RRGGBB.`);
    if (properties.fontFamily !== undefined && (typeof properties.fontFamily !== 'string' || !properties.fontFamily.trim() || properties.fontFamily.length > 128)) throw new HwpHandsError('INVALID_ARGUMENT', 'fontFamily must be a non-empty string of at most 128 characters.');
    if (properties.fontFamilies !== undefined && (!Array.isArray(properties.fontFamilies) || properties.fontFamilies.length !== 7 || Array.from(properties.fontFamilies).some(name => typeof name !== 'string' || !name.trim() || name.length > 128) || properties.fontFamily !== undefined || properties.fontLanguage !== undefined)) throw new HwpHandsError('INVALID_ARGUMENT', 'fontFamilies needs seven nonempty names and cannot be combined with fontFamily/fontLanguage.');
    if (properties.fontLanguage !== undefined && (!Number.isInteger(properties.fontLanguage) || (properties.fontLanguage as number) < 0 || (properties.fontLanguage as number) > 6 || properties.fontFamily === undefined)) throw new HwpHandsError('INVALID_ARGUMENT', 'fontLanguage must be 0–6 and requires fontFamily.');
  }
  /** RHWP's character-shape modification JSON for validated format properties (also used for style definitions). */
  private characterModsJson(properties: Extract<Command, { type: 'formatText' }>['properties'], current?: CharacterProperties): string {
    this.validateCharacterProperties(properties);
    const { fontFamilies, fontLanguage, fontFamily, fontSize, ratio, characterSpacing, relativeSize, characterOffset, ...characterProperties } = properties;
    let fontIds = fontFamilies?.map((name, language) => this.document.findOrCreateFontIdForLang(language, name.trim()));
    if (fontIds?.some(id => id < 0)) throw new HwpHandsError('INVALID_ARGUMENT', 'A font slot could not be registered.');
    if (fontLanguage !== undefined) {
      const families = current?.fontFamilies;
      if (!families || families.length !== 7 || families.some(name => typeof name !== 'string' || !name.trim())) throw new HwpHandsError('INVALID_ARGUMENT', 'All seven current font slots must be readable before a language-specific change.');
      fontIds = families.map((name, language) => this.document.findOrCreateFontIdForLang(language, language === fontLanguage ? fontFamily!.trim() : name));
      if (fontIds.some(id => id < 0)) throw new HwpHandsError('INVALID_ARGUMENT', 'The requested language font could not be registered.');
    }
    const fontId = fontFamily === undefined || fontLanguage !== undefined ? undefined : this.document.findOrCreateFontId(fontFamily.trim());
    if (fontId !== undefined && fontId < 0) throw new HwpHandsError('INVALID_ARGUMENT', 'The requested font family could not be registered in this document.');
    return JSON.stringify({
      ...characterProperties,
      ...(fontIds === undefined ? {} : { fontIds }),
      ...(ratio === undefined ? {} : { ratios: Array(7).fill(ratio) }),
      ...(characterSpacing === undefined ? {} : { spacings: Array(7).fill(characterSpacing) }),
      ...(relativeSize === undefined ? {} : { relativeSizes: Array(7).fill(relativeSize) }),
      ...(characterOffset === undefined ? {} : { charOffsets: Array(7).fill(characterOffset) }),
      ...(fontId === undefined ? {} : { fontId }),
      ...(fontSize === undefined ? {} : { fontSize: fontSize * 100 }),
    });
  }
  private applyCharacterFormat(target: TextTarget, start: number, end: number, properties: Extract<Command, { type: 'formatText' }>['properties'], model = this.structuralModel(),
    resolved?: Paragraph | StoryParagraph, preparedJson?: string): Record<string, Json> {
    if (preparedJson === undefined) this.validateCharacterProperties(properties);
    const paragraph = resolved ?? this.paragraphAt(target, model), address = paragraph.address;
    integer(start, 'start', paragraph.length); integer(end, 'end', paragraph.length);
    if (end < start) throw new HwpHandsError('INVALID_ARGUMENT', 'Character format range is reversed.');
    if (properties.fontLanguage !== undefined && preparedJson === undefined) {
      if (address.kind !== 'body' && address.kind !== 'headerFooter') throw new HwpHandsError('INVALID_ARGUMENT', 'Language font changes are unavailable in notes.');
      // Resolve each original shape independently; a selection can contain different untouched language fonts.
      const runs = address.kind === 'body' && !address.containerKinds?.includes('textBox')
        ? this.modelCharacterRuns(paragraph as Paragraph, { byKey: new Map(), distinct: [] })
        : this.scanCharacterRuns(address, paragraph.text);
      const spans = runs.filter(run => run.offset < end && run.offset + run.length > start).map(run => ({
        start: Math.max(start, run.offset), end: Math.min(end, run.offset + run.length), json: this.characterModsJson(properties, run.properties),
      }));
      if (start === end) spans.push({ start, end, json: this.characterModsJson(properties, this.characterProperties(address, start)) });
      if (!spans.length) throw new HwpHandsError('INVALID_ARGUMENT', 'The selected font slots could not be read.');
      for (const span of spans) this.applyCharacterFormat(target, span.start, span.end, properties, model, paragraph, span.json);
      return { ok: true };
    }
    const json = preparedJson ?? this.characterModsJson(properties);
    if (address.kind === 'body') return checked(address.cellPath?.length
      ? this.document.applyCharFormatInCellByPath(address.section, address.paragraph, JSON.stringify(address.cellPath), start, end, json)
      : this.document.applyCharFormat(address.section, address.paragraph, start, end, json));
    if (address.kind === 'headerFooter') return checked(this.document.applyCharFormatInHeaderFooter(address.section, address.isHeader, address.applyTo, address.paragraph, start, address.paragraph, end, json));
    throw new HwpHandsError('INVALID_ARGUMENT', 'Character formatting is not supported in footnote/endnote paragraphs by 현재 RHWP 코어.');
  }
  /** RHWP's paragraph-shape modification JSON for validated paragraph format properties (also used for style definitions). */
  private paragraphModsJson(properties: Extract<Command, { type: 'formatParagraph' }>['properties']): string {
    if (properties.alignment !== undefined && !['left', 'center', 'right', 'justify', 'distribute', 'split'].includes(properties.alignment)) throw new HwpHandsError('INVALID_ARGUMENT', 'alignment must be left, center, right, justify, distribute or split.');
    for (const [key, value] of Object.entries(properties)) {
      if (key === 'alignment' || key === 'lineSpacingType') continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < (key === 'spacingBefore' || key === 'spacingAfter' || key === 'lineSpacing' ? 0 : -100000) || value > 100000) throw new HwpHandsError('INVALID_ARGUMENT', `Invalid paragraph property: ${key}`);
    }
    if (properties.lineSpacingType !== undefined && !['Percent', 'Fixed', 'SpaceOnly', 'Minimum', 'BetweenLines'].includes(properties.lineSpacingType)) throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported lineSpacingType.');
    const normalizedProperties = properties.lineSpacingType === 'BetweenLines'
      ? { ...properties, lineSpacingType: 'SpaceOnly' }
      : properties;
    return JSON.stringify(normalizedProperties);
  }
  private applyParagraphFormat(target: TextTarget, properties: Extract<Command, { type: 'formatParagraph' }>['properties'], model = this.structuralModel(),
    resolved?: Paragraph | StoryParagraph, preparedJson?: string): Record<string, Json> {
    const paragraph = resolved ?? this.paragraphAt(target, model), address = paragraph.address;
    const json = preparedJson ?? this.paragraphModsJson(properties);
    if (address.kind === 'body') {
      if ((address.cellPath?.length ?? 0) > 1) throw new HwpHandsError('INVALID_ARGUMENT', 'Paragraph formatting is unavailable in nested table cells in 현재 RHWP 코어.');
      const position = this.listPosition(address, model);
      if (!position) throw new HwpHandsError('INVALID_ARGUMENT', 'The paragraph list position could not be resolved.');
      return checked(this.document.applyParaFormatAtCursor(position.listId, position.paragraph, json));
    }
    if (address.kind === 'headerFooter') return checked(this.document.applyParaFormatInHf(address.section, address.isHeader, address.applyTo, address.paragraph, json));
    return checked(this.document.applyParaFormatInFootnote(address.section, address.anchor.paragraph, address.controlIndex, address.paragraph, json));
  }
  private formatRange(c: Extract<Command, { type: 'formatRange' }>): Record<string, Json> {
    if (!c.range?.start?.address || !c.range?.end?.address) throw new HwpHandsError('INVALID_ARGUMENT', 'Both range endpoints are required.');
    const model = this.structuralModel();
    const first = this.paragraphAt(c.range.start.address, model), last = this.paragraphAt(c.range.end.address, model);
    integer(c.range.start.offset, 'start.offset', first.length); integer(c.range.end.offset, 'end.offset', last.length);
    const start = selectionParagraphIndex(first.address), end = selectionParagraphIndex(last.address);
    if (selectionContainerKey(first.address) !== selectionContainerKey(last.address) || start > end || start === end && c.range.start.offset > c.range.end.offset) {
      throw new HwpHandsError('INVALID_ARGUMENT', 'A formatting range must be ordered inside one section, cell, text box or story.');
    }
    const paragraphs = (this.paragraphList(true, true, model) as Array<Paragraph | StoryParagraph>)
      .filter(item => selectionContainerKey(item.address) === selectionContainerKey(first.address)
        && selectionParagraphIndex(item.address) >= start && selectionParagraphIndex(item.address) <= end)
      .sort((left, right) => selectionParagraphIndex(left.address) - selectionParagraphIndex(right.address));
    if (paragraphs.length !== end - start + 1) throw new HwpHandsError('INVALID_ARGUMENT', 'The formatting range contains unavailable paragraphs.');
    return this.applyRangeFormatting(paragraphs.map((paragraph, index) => ({ paragraph,
      start: index === 0 ? c.range.start.offset : 0, end: index === paragraphs.length - 1 ? c.range.end.offset : paragraph.length })), c, model);
  }
  private formatCellBlock(c: Extract<Command, { type: 'formatCellBlock' }>): Record<string, Json> {
    const model = this.structuralModel(); this.validateTarget(c.table, model); integer(c.table.control, 'table.control');
    const key = this.addressKey({ ...c.table, kind: 'body' });
    const table = this.tables(model).find(item => this.addressKey(item.address) === key && item.control === c.table.control);
    if (!table) throw new HwpHandsError('INVALID_ARGUMENT', 'The addressed table is unavailable.');
    integer(c.startRow, 'startRow', table.rows - 1); integer(c.endRow, 'endRow', table.rows - 1);
    integer(c.startCol, 'startCol', table.cols - 1); integer(c.endCol, 'endCol', table.cols - 1);
    if (c.startRow > c.endRow || c.startCol > c.endCol) throw new HwpHandsError('INVALID_ARGUMENT', 'Cell block bounds are reversed.');
    const cells = table.cells.filter(cell => cell.row <= c.endRow && cell.row + cell.rowSpan > c.startRow
      && cell.col <= c.endCol && cell.col + cell.colSpan > c.startCol);
    return this.applyRangeFormatting(cells.flatMap(cell => cell.paragraphs.map(paragraph => ({ paragraph, start: 0, end: paragraph.length }))), c, model);
  }
  private applyRangeFormatting(entries: Array<{ paragraph: Paragraph | StoryParagraph; start: number; end: number }>,
    changes: import('./api').RangeFormatProperties, model: StructuralModel): Record<string, Json> {
    if (!entries.length || changes.character === undefined && changes.paragraph === undefined && changes.styleId === undefined && changes.list === undefined) {
      throw new HwpHandsError('INVALID_ARGUMENT', 'Range formatting needs a nonempty range and at least one formatting change.');
    }
    for (const entry of entries) {
      const reason = formattingUnavailableReason(entry.paragraph.address, changes);
      if (reason) throw new HwpHandsError('INVALID_ARGUMENT', reason);
    }
    if (changes.character !== undefined) this.validateCharacterProperties(changes.character);
    const paragraphJson = changes.paragraph !== undefined ? this.paragraphModsJson(changes.paragraph) : undefined;
    if (changes.styleId !== undefined) {
      integer(changes.styleId, 'styleId');
      if (!this.styleEntries().some(style => style.id === changes.styleId)) throw new HwpHandsError('INVALID_ARGUMENT', 'styleId is not defined in this document.');
    }
    checked(this.document.beginBatch());
    try {
      const characterJson = changes.character !== undefined && changes.character.fontLanguage === undefined ? this.characterModsJson(changes.character) : undefined;
      for (const { paragraph, start, end } of entries) {
        if (changes.character !== undefined) this.applyCharacterFormat(paragraph.address, start, end, changes.character, model, paragraph, characterJson);
        if (changes.paragraph !== undefined) this.applyParagraphFormat(paragraph.address, changes.paragraph, model, paragraph, paragraphJson);
        if (changes.styleId !== undefined) this.setParagraphStyle(paragraph.address, changes.styleId, model);
        if (changes.list !== undefined) this.setParagraphList(paragraph.address, changes.list, model);
      }
    } finally { checked(this.document.endBatch()); }
    return { ok: true, paragraphs: entries.length };
  }
  private styleEntries(): Array<{ id: number; name: string; englishName: string; type: number; nextStyleId: number }> {
    return parsed<Array<{ id: number; name: string; englishName: string; type: number; nextStyleId: number }>>(this.document.getStyleList());
  }
  private styleName(value: unknown, label: string, optional = false): string {
    if (typeof value !== 'string') throw new HwpHandsError('INVALID_ARGUMENT', `${label} must be a string.`);
    const name = value.trim();
    // eslint-disable-next-line no-control-regex -- HWP names must reject control characters.
    if ((!name && !optional) || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new HwpHandsError('INVALID_ARGUMENT', `${label} must be ${optional ? '0' : '1'}–60 characters without control characters.`);
    return name;
  }
  private styleShapes(id: number, character: unknown, paragraph: unknown): void {
    const charJson = character === undefined ? '{}' : this.characterModsJson(objectRecord(character, 'characterProperties'), parsed<{ charProps?: CharacterProperties }>(this.document.getStyleDetail(id)).charProps);
    const paraJson = paragraph === undefined ? '{}' : this.paragraphModsJson(objectRecord(paragraph, 'paragraphProperties'));
    if (charJson === '{}' && paraJson === '{}') return;
    if (!this.document.updateStyleShapes(id, charJson, paraJson)) throw new HwpHandsError('ENGINE_ERROR', 'RHWP could not update the style formatting.');
  }
  private createStyle(c: Extract<Command, { type: 'createStyle' }>): Record<string, Json> {
    const name = this.styleName(c.name, 'name'), englishName = c.englishName === undefined ? '' : this.styleName(c.englishName, 'englishName', true);
    const styles = this.styleEntries();
    if (styles.some(style => style.name === name)) throw new HwpHandsError('INVALID_ARGUMENT', `A style named "${name}" already exists.`);
    if (c.kind !== undefined && c.kind !== 'paragraph' && c.kind !== 'character') throw new HwpHandsError('INVALID_ARGUMENT', 'kind must be paragraph or character.');
    if (c.nextStyleId !== undefined) { integer(c.nextStyleId, 'nextStyleId'); if (!styles.some(style => style.id === c.nextStyleId)) throw new HwpHandsError('INVALID_ARGUMENT', 'nextStyleId does not match an existing style.'); }
    const id = this.document.createStyle(JSON.stringify({ name, englishName, type: c.kind === 'character' ? 1 : 0, nextStyleId: c.nextStyleId ?? 0 }));
    if (!Number.isSafeInteger(id) || id < 0) throw new HwpHandsError('ENGINE_ERROR', 'RHWP could not create the style.');
    // A paragraph style continues with itself by default, like Hancom's.
    if (c.nextStyleId === undefined && c.kind !== 'character') this.document.updateStyle(id, JSON.stringify({ name, englishName, nextStyleId: id }));
    this.styleShapes(id, c.characterProperties, c.paragraphProperties);
    return { ok: true, styleId: id, name };
  }
  private updateStyle(c: Extract<Command, { type: 'updateStyle' }>): Record<string, Json> {
    integer(c.styleId, 'styleId');
    const styles = this.styleEntries(), current = styles.find(style => style.id === c.styleId);
    if (!current) throw new HwpHandsError('INVALID_ARGUMENT', 'The addressed style does not exist.');
    if (c.name === undefined && c.englishName === undefined && c.nextStyleId === undefined && c.characterProperties === undefined && c.paragraphProperties === undefined) throw new HwpHandsError('INVALID_ARGUMENT', 'updateStyle needs at least one property to change.');
    const name = c.name === undefined ? current.name : this.styleName(c.name, 'name'), englishName = c.englishName === undefined ? current.englishName : this.styleName(c.englishName, 'englishName', true);
    if (name !== current.name && styles.some(style => style.name === name)) throw new HwpHandsError('INVALID_ARGUMENT', `A style named "${name}" already exists.`);
    if (c.styleId === 0 && name !== current.name) throw new HwpHandsError('INVALID_ARGUMENT', 'The default style cannot be renamed.');
    let nextStyleId = current.nextStyleId;
    if (c.nextStyleId !== undefined) { integer(c.nextStyleId, 'nextStyleId'); if (!styles.some(style => style.id === c.nextStyleId)) throw new HwpHandsError('INVALID_ARGUMENT', 'nextStyleId does not match an existing style.'); nextStyleId = c.nextStyleId; }
    if (name !== current.name || englishName !== current.englishName || nextStyleId !== current.nextStyleId) {
      if (!this.document.updateStyle(c.styleId, JSON.stringify({ name, englishName, nextStyleId }))) throw new HwpHandsError('ENGINE_ERROR', 'RHWP could not update the style.');
    }
    this.styleShapes(c.styleId, c.characterProperties, c.paragraphProperties);
    return { ok: true, styleId: c.styleId, name };
  }
  private deleteStyle(styleId: number): Record<string, Json> {
    integer(styleId, 'styleId');
    if (styleId === 0) throw new HwpHandsError('INVALID_ARGUMENT', 'The default style cannot be deleted.');
    if (!this.styleEntries().some(style => style.id === styleId)) throw new HwpHandsError('INVALID_ARGUMENT', 'The addressed style does not exist.');
    if (!this.document.deleteStyle(styleId)) throw new HwpHandsError('ENGINE_ERROR', 'RHWP could not delete the style.');
    return { ok: true, styleId };
  }
  private createNumbering(c: Extract<Command, { type: 'createNumbering' }>): Record<string, Json> {
    if (!Array.isArray(c.levelFormats) || c.levelFormats.length < 1 || c.levelFormats.length > 7) throw new HwpHandsError('INVALID_ARGUMENT', 'levelFormats must contain 1–7 level formats.');
    if (!Array.isArray(c.numberFormats) || c.numberFormats.length !== c.levelFormats.length) throw new HwpHandsError('INVALID_ARGUMENT', 'numberFormats must have one entry per level format.');
    // eslint-disable-next-line no-control-regex -- Numbering formats must reject control characters.
    for (const format of c.levelFormats) if (typeof format !== 'string' || !format.length || format.length > 16 || /[\u0000-\u001f\u007f]/.test(format) || !/\^[1-7]/.test(format)) throw new HwpHandsError('INVALID_ARGUMENT', 'Each level format must be 1–16 characters and contain a level placeholder such as ^1.');
    for (const code of c.numberFormats) integer(code, 'numberFormats', 16);
    const startNumber = c.startNumber ?? 1; integer(startNumber, 'startNumber', 65535);
    const id = this.document.createNumbering(JSON.stringify({ levelFormats: c.levelFormats, numberFormats: c.numberFormats, startNumber }));
    if (!Number.isSafeInteger(id) || id < 1) throw new HwpHandsError('ENGINE_ERROR', 'RHWP could not create the numbering definition.');
    return { ok: true, numberingId: id };
  }
  private tableForTarget(target: Target & { control: number }): Table {
    if (!target || typeof target !== 'object' || target.cellPath?.length) throw new HwpHandsError('INVALID_ARGUMENT', 'Table structure and properties commands require a root-body table address.');
    this.validateTarget(target);
    integer(target.control, 'control');
    const table = this.tables().find(candidate => candidate.section === target.section && candidate.paragraph === target.paragraph && candidate.control === target.control);
    if (!table) throw new HwpHandsError('INVALID_ARGUMENT', 'The addressed table no longer exists. Query the document structure again.');
    return table;
  }
  /** Rendered-page evidence for floating pictures/shapes over a root table. Missing geometry is explicit. */
  tableCoverage(target: Target & { control: number }): { coveredCellIndices: number[]; complete: boolean } {
    const table = this.tableForTarget(target), floating = new Set(['picture', 'image', 'shape', 'group', 'ole', 'textbox']);
    const objects = this.objects();
    if (!objects.some(object => floating.has(object.kind.toLowerCase())))
      return { coveredCellIndices: [], complete: true };
    type Box = { pageIndex?: unknown };
    let boxes: Box[];
    try {
      boxes = parsed<Box[]>(this.document.getTableCellBboxesByPath(target.section, target.paragraph,
        JSON.stringify([{ controlIndex: target.control, cellIndex: 0, cellParaIndex: 0 }])));
    } catch { return { coveredCellIndices: [], complete: false }; }
    if (!Array.isArray(boxes) || !boxes.length || boxes.some(box => !Number.isSafeInteger(box.pageIndex) || (box.pageIndex as number) < 0 || (box.pageIndex as number) >= this.pages()))
      return { coveredCellIndices: [], complete: false };
    const covered = new Set<number>(), seen = new Set<number>();
    let complete = true;
    for (const page of new Set(boxes.map(box => box.pageIndex as number))) {
      let controls: Array<Record<string, unknown>>;
      try { controls = parsed<RawLayoutControls>(this.document.getPageControlLayout(page)).controls ?? []; }
      catch { complete = false; continue; }
      const matching = controls.filter(item => item.type === 'table' && item.secIdx === target.section && item.paraIdx === target.paragraph && item.controlIdx === target.control);
      if (!matching.length) { complete = false; continue; }
      const candidates = controls.filter(item => {
        if (typeof item.type !== 'string' || !floating.has(item.type.toLowerCase())) return false;
        const matches = objects.filter(object => !object.address.cellPath?.length && object.address.section === item.secIdx
          && object.address.paragraph === item.paraIdx && object.controlIndex === item.controlIdx);
        // The layout's wrap value may be cached after a z-order edit; a uniquely addressed model object is current.
        const properties = matches.length === 1 ? matches[0].properties : undefined;
        const wrap = properties && 'textWrap' in properties && typeof properties.textWrap === 'string' ? properties.textWrap : item.wrap;
        return typeof wrap !== 'string' || wrap.toLowerCase() !== 'behindtext';
      });
      for (const item of matching) {
        if (!Array.isArray(item.cells)) { complete = false; continue; }
        for (const raw of item.cells) {
          const box = raw as Record<string, unknown>, cell = table.cells.find(value => value.row === box.row && value.col === box.col);
          const coords = [box.x, box.y, box.w, box.h];
          if (!cell || coords.some(value => typeof value !== 'number' || !Number.isFinite(value)) || (box.w as number) <= 0 || (box.h as number) <= 0) { complete = false; continue; }
          seen.add(cell.index);
          for (const object of candidates) {
            const geometry = [object.x, object.y, object.w, object.h];
            if (geometry.some(value => typeof value !== 'number' || !Number.isFinite(value)) || (object.w as number) <= 0 || (object.h as number) <= 0) { complete = false; continue; }
            const x = (object.x as number) + (object.w as number) / 2, y = (object.y as number) + (object.h as number) / 2;
            if (x >= (box.x as number) && x <= (box.x as number) + (box.w as number) && y >= (box.y as number) && y <= (box.y as number) + (box.h as number))
              covered.add(cell.index);
          }
        }
      }
    }
    if (table.cells.some(cell => !seen.has(cell.index))) complete = false;
    return { coveredCellIndices: [...covered].sort((a, b) => a - b), complete };
  }
  private tableCellAt(table: Table, row: number, col: number): Table['cells'][number] {
    integer(row, 'row', table.rows - 1); integer(col, 'col', table.cols - 1);
    const cell = table.cells.find(candidate => row >= candidate.row && row < candidate.row + candidate.rowSpan && col >= candidate.col && col < candidate.col + candidate.colSpan);
    if (!cell) throw new HwpHandsError('INVALID_ARGUMENT', 'The addressed table cell does not exist.');
    return cell;
  }
  private cellHasContent(table: Table, cell: Table['cells'][number]): boolean {
    if (cell.paragraphs.some(paragraph => paragraph.length > 0)) return true;
    const contains = (address: BodyAddress | undefined): boolean => {
      const step = address?.cellPath?.[0];
      return address?.section === table.section && address.paragraph === table.paragraph && step?.controlIndex === table.control && step.cellIndex === cell.index;
    };
    if (this.controls().some(control => contains(control.address)) || this.objects(undefined, false).some(object => contains(object.address)) || this.fields().some(field => contains(field.address))) return true;
    return false;
  }
  private rootParagraph(target: Target, label: string): Paragraph {
    if (!target || typeof target !== 'object') throw new HwpHandsError('INVALID_ARGUMENT', 'A body paragraph address is required.');
    if (target.cellPath?.length) throw new HwpHandsError('INVALID_ARGUMENT', `${label} currently requires a root-body paragraph.`);
    return this.paragraph(target);
  }
  private pageSettings(section: number, properties: PageSettingsProperties): Record<string, Json> {
    integer(section, 'section', this.document.getSectionCount() - 1);
    const value = objectRecord(properties, 'Page settings');
    const allowed = ['width', 'height', 'marginLeft', 'marginRight', 'marginTop', 'marginBottom', 'marginHeader', 'marginFooter', 'marginGutter', 'landscape', 'binding'] as const;
    rejectUnknownKeys(value, allowed, 'Page settings');
    const next = { ...parsed<Record<string, Json>>(this.document.getPageDef(section)) };
    for (const [key, item] of Object.entries(value)) {
      if (key === 'landscape') {
        if (typeof item !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'landscape must be a boolean.');
      } else {
        integer(item as number, key, key === 'binding' ? 3 : 1_000_000);
        if (key === 'width' || key === 'height') {
          if ((item as number) < 1000) throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be at least 1000 HWP units.`);
        }
      }
      next[key] = item as Json;
    }
    const width = next.width as number, height = next.height as number;
    if ((next.marginLeft as number) + (next.marginRight as number) + (next.marginGutter as number) >= width ||
      (next.marginTop as number) + (next.marginBottom as number) >= height ||
      (next.marginHeader as number) > height || (next.marginFooter as number) > height) {
      throw new HwpHandsError('INVALID_ARGUMENT', 'Page size and margins leave no printable body area.');
    }
    return checked(this.document.setPageDef(section, JSON.stringify(next)));
  }
  private setEndnoteShape(section: number, properties: EndnoteShapeProperties): Record<string, Json> {
    integer(section, 'section', this.document.getSectionCount() - 1);
    const value = objectRecord(properties, 'Endnote shape');
    const allowed = ['numberFormat', 'userChar', 'prefixChar', 'suffixChar', 'startNumber', 'separatorEnabled', 'separatorLength', 'separatorMarginTop', 'separatorMarginBottom', 'noteSpacing', 'separatorLineType', 'separatorLineWidth', 'separatorColor', 'numbering', 'placement'] as const;
    rejectUnknownKeys(value, allowed, 'Endnote shape');
    const next = parsed<Record<string, Json>>(this.document.getEndnoteShape(section));
    delete next.ok;
    const numberFormats = ['digit', 'circledDigit', 'upperRoman', 'lowerRoman', 'upperAlpha', 'lowerAlpha', 'hangulSyllable', 'hangulJamo', 'hangulDigit', 'hanjaDigit'];
    const lineTypes = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11];
    const lineWidths = Array.from({ length: 16 }, (_, index) => index);
    for (const [key, item] of Object.entries(value)) {
      if (['numberFormat'].includes(key)) {
        if (typeof item !== 'string' || !numberFormats.includes(item)) throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported endnote numberFormat.');
      } else if (['userChar', 'prefixChar', 'suffixChar'].includes(key)) {
        if (typeof item !== 'string' || Array.from(item).length > 1) throw new HwpHandsError('INVALID_ARGUMENT', `${key} must contain at most one character.`);
      } else if (key === 'separatorEnabled') {
        if (typeof item !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'separatorEnabled must be a boolean.');
      } else if (key === 'separatorColor') {
        if (typeof item !== 'string' || !/^#[0-9a-f]{6}$/i.test(item)) throw new HwpHandsError('INVALID_ARGUMENT', 'separatorColor must be a #RRGGBB color.');
      } else if (key === 'numbering') {
        if (typeof item !== 'string' || !['continue', 'restartSection', 'restartPage'].includes(item)) throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported endnote numbering mode.');
      } else if (key === 'placement') {
        if (typeof item !== 'string' || !['documentEnd', 'sectionEnd'].includes(item)) throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported endnote placement.');
      } else {
        integer(item as number, key, key === 'startNumber' ? 32767 : key === 'separatorLineType' ? 11 : key === 'separatorLineWidth' ? 15 : 100_000);
        if (key === 'startNumber' && (item as number) < 1) throw new HwpHandsError('INVALID_ARGUMENT', 'startNumber must be at least 1.');
        if (key === 'separatorLineType' && !lineTypes.includes(item as number)) throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported endnote separator line type.');
        if (key === 'separatorLineWidth' && !lineWidths.includes(item as number)) throw new HwpHandsError('INVALID_ARGUMENT', 'Unsupported endnote separator line width.');
      }
      next[key] = item as Json;
    }
    return checked(this.document.applyEndnoteShape(section, JSON.stringify(next)));
  }
  private pageHideAt(section: number, paragraph: number): Required<PageHideProperties> {
    const raw = parsed<Record<string, Json>>(this.document.getPageHide(section, paragraph));
    const flag = (key: string): boolean => raw.exists === true && raw[key] === true;
    return { hideHeader: flag('hideHeader'), hideFooter: flag('hideFooter'), hideMasterPage: flag('hideMasterPage'), hideBorder: flag('hideBorder'), hideFill: flag('hideFill'), hidePageNumber: flag('hidePageNum') };
  }
  private setPageHide(target: Target, properties: PageHideProperties): Record<string, Json> {
    this.rootParagraph(target, 'Page hiding');
    const value = objectRecord(properties, 'Page hide');
    rejectUnknownKeys(value, ['hideHeader', 'hideFooter', 'hideMasterPage', 'hideBorder', 'hideFill', 'hidePageNumber'], 'Page hide');
    for (const [key, item] of Object.entries(value)) if (typeof item !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be a boolean.`);
    const next = { ...this.pageHideAt(target.section, target.paragraph), ...value } as Required<PageHideProperties>;
    return checked(this.document.setPageHide(target.section, target.paragraph, next.hideHeader, next.hideFooter, next.hideMasterPage, next.hideBorder, next.hideFill, next.hidePageNumber));
  }
  private setColumnSettings(section: number, properties: ColumnSettingsProperties): Record<string, Json> {
    integer(section, 'section', this.document.getSectionCount() - 1);
    const value = objectRecord(properties, 'Column settings');
    rejectUnknownKeys(value, ['count', 'type', 'sameWidth', 'spacing'], 'Column settings');
    const current = parsed<Record<string, Json>>(this.document.getColumnDef(section));
    const types = ['normal', 'distribute', 'parallel'];
    let count = Math.max(1, Number(current.columnCount) || 1), type = Number(current.columnType) || 0, sameWidth = current.sameWidth !== false, spacing = Number(current.spacing) || 0;
    if (value.count !== undefined) { integer(value.count as number, 'count', 8); if (!value.count) throw new HwpHandsError('INVALID_ARGUMENT', 'count must be 1–8.'); count = value.count as number; }
    if (value.type !== undefined) { const index = typeof value.type === 'string' ? types.indexOf(value.type) : -1; if (index < 0) throw new HwpHandsError('INVALID_ARGUMENT', 'type must be normal, distribute or parallel.'); type = index; }
    if (value.sameWidth !== undefined) { if (typeof value.sameWidth !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'sameWidth must be a boolean.'); sameWidth = value.sameWidth; }
    if (value.spacing !== undefined) { integer(value.spacing as number, 'spacing', 32767); spacing = value.spacing as number; }
    return checked(this.document.setColumnDef(section, count, type, sameWidth ? 1 : 0, spacing));
  }
  private setPageBorderFill(section: number, properties: PageBorderFillProperties): Record<string, Json> {
    integer(section, 'section', this.document.getSectionCount() - 1);
    const value = objectRecord(properties, 'Page border and fill');
    rejectUnknownKeys(value, ['basis', 'spacingLeft', 'spacingRight', 'spacingTop', 'spacingBottom', 'headerInside', 'footerInside', 'fillArea', 'borderLeft', 'borderRight', 'borderTop', 'borderBottom', 'fillType', 'fillColor', 'patternColor', 'patternType'], 'Page border and fill');
    const next = parsed<Record<string, Json>>(this.document.getPageBorderFill(section));
    delete next.ok;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'basis') { if (item !== 'paper' && item !== 'page') throw new HwpHandsError('INVALID_ARGUMENT', 'basis must be paper or page.'); }
      else if (key === 'fillArea') { if (!['paper', 'page', 'border'].includes(String(item))) throw new HwpHandsError('INVALID_ARGUMENT', 'fillArea must be paper, page or border.'); }
      else if (key === 'headerInside' || key === 'footerInside') { if (typeof item !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be a boolean.`); }
      else if (key.startsWith('spacing')) integer(item as number, key, 100_000);
      else if (key === 'fillType') { if (!['none', 'solid', 'pattern'].includes(String(item))) throw new HwpHandsError('INVALID_ARGUMENT', 'fillType must be none, solid or pattern.'); }
      else if (key === 'fillColor' || key === 'patternColor') value[key] = hexColor(item, key);
      else if (key === 'patternType') integer(item as number, key, 64);
      else {
        const border = objectRecord(item, key);
        rejectUnknownKeys(border, ['type', 'width', 'color'], key);
        if (border.type !== undefined) integer(border.type as number, `${key}.type`, 16);
        if (border.width !== undefined) integer(border.width as number, `${key}.width`, 15);
        if (border.color !== undefined) border.color = hexColor(border.color, `${key}.color`);
        value[key] = { ...(next[key] as Record<string, Json> | undefined), ...border };
      }
      next[key] = value[key] as Json;
    }
    return checked(this.document.setPageBorderFill(section, JSON.stringify(next)));
  }
  private setSectionDefinition(section: number, properties: SectionDefinitionProperties): Record<string, Json> {
    integer(section, 'section', this.document.getSectionCount() - 1);
    const value = objectRecord(properties, 'Section definition');
    rejectUnknownKeys(value, ['pageNum', 'pageNumType', 'pictureNum', 'tableNum', 'equationNum', 'columnSpacing', 'defaultTabSpacing', 'hideHeader', 'hideFooter', 'hideMasterPage', 'hideBorder', 'hideFill', 'hideEmptyLine'], 'Section definition');
    const next = parsed<Record<string, Json>>(this.document.getSectionDef(section));
    delete next.ok;
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('hide')) { if (typeof item !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be a boolean.`); }
      else integer(item as number, key, key === 'pageNumType' ? 2 : key === 'columnSpacing' || key === 'defaultTabSpacing' ? 100_000 : 65535);
      next[key] = item as Json;
    }
    return checked(this.document.setSectionDef(section, JSON.stringify(next)));
  }
  private hasMergedCells(table: Table): boolean { return table.cells.some(cell => cell.rowSpan > 1 || cell.colSpan > 1); }
  private transposeTable(target: Target & { control: number }): Record<string, Json> {
    const table = this.tableForTarget(target);
    if (this.hasMergedCells(table)) throw new HwpHandsError('INVALID_ARGUMENT', 'A table with merged cells cannot be transposed. Split the merged cells first.');
    return checked(this.document.transposeTableCellsInPlace(table.section, table.paragraph, table.control));
  }
  private splitTable(target: Target & { control: number }, atRow: number): Record<string, Json> {
    const table = this.tableForTarget(target);
    integer(atRow, 'atRow', table.rows - 1);
    if (atRow < 1) throw new HwpHandsError('INVALID_ARGUMENT', 'A table can only be split before its second row or later.');
    if (table.cells.some(cell => cell.row < atRow && atRow < cell.row + cell.rowSpan)) throw new HwpHandsError('INVALID_ARGUMENT', 'The split line cuts through a merged cell.');
    return checked(this.document.splitTable(table.section, table.paragraph, table.control, atRow));
  }
  private mergeTableWithNext(target: Target & { control: number }): Record<string, Json> {
    const table = this.tableForTarget(target);
    // RHWP joins the next table in document order; the split command leaves one empty paragraph between the halves.
    const next = this.tables().filter(candidate => candidate.section === table.section && !candidate.address.cellPath?.length
      && (candidate.paragraph > table.paragraph || candidate.paragraph === table.paragraph && candidate.control > table.control))
      .sort((left, right) => left.paragraph - right.paragraph || left.control - right.control)[0];
    if (!next) throw new HwpHandsError('INVALID_ARGUMENT', 'There is no table after this one to join.');
    if (next.cols !== table.cols) throw new HwpHandsError('INVALID_ARGUMENT', `Both tables need the same number of columns (${table.cols} and ${next.cols}).`);
    const inline = new Set(['secd', 'cold', 'pghd']);
    const between = (paragraph: number): boolean => this.paragraph({ section: table.section, paragraph }).length > 0
      || this.controls().some(control => control.address.section === table.section && control.address.paragraph === paragraph && !control.address.cellPath?.length && !inline.has(control.ctrlId)
        && !(control.ctrlId === 'tbl' && paragraph === next.paragraph && control.controlIndex === next.control));
    for (let paragraph = table.paragraph + 1; paragraph <= next.paragraph; paragraph++) {
      if (between(paragraph)) throw new HwpHandsError('INVALID_ARGUMENT', 'Text or objects between the two tables would be discarded by joining. Move or delete them first.');
    }
    return checked(this.document.mergeTableWithNext(table.section, table.paragraph, table.control));
  }
  private deleteTable(target: Target & { control: number }): Record<string, Json> {
    const table = this.tableForTarget(target);
    return checked(this.document.deleteTableControl(table.section, table.paragraph, table.control));
  }
  private setTableFormula(c: Extract<Command, { type: 'setTableFormula' }>): Record<string, Json> {
    const table = this.tableForTarget(c.table), cell = this.tableCellAt(table, c.row, c.col);
    if (typeof c.formula !== 'string') throw new HwpHandsError('INVALID_ARGUMENT', 'formula must be a string.');
    const formula = c.formula.trim();
    if (formula.length < 2 || formula.length > MAX_FORMULA_LENGTH || !formula.startsWith('=') || formula.includes('\0')) throw new HwpHandsError('INVALID_ARGUMENT', `formula must start with = and contain 2–${MAX_FORMULA_LENGTH} characters.`);
    const format = c.format ?? 'raw';
    if (!FORMULA_FORMATS.includes(format)) throw new HwpHandsError('INVALID_ARGUMENT', 'format must be raw, integer, decimal1 or decimal2.');
    if (c.thousandsSeparator !== undefined && typeof c.thousandsSeparator !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'thousandsSeparator must be a boolean.');
    // RHWP evaluates references outside the table as 0 without complaint; refuse them so a typo is not written as a result.
    const outside = formulaReferences(formula).find(reference => reference.row >= table.rows || reference.col >= table.cols);
    if (outside) throw new HwpHandsError('INVALID_ARGUMENT', `Cell reference ${outside.text.toUpperCase()} is outside the ${table.rows}×${table.cols} table.`);
    let evaluated: Record<string, Json>;
    try { evaluated = checked(this.document.evaluateTableFormula(table.section, table.paragraph, table.control, cell.row, cell.col, formula, false)); }
    catch (error) { throw new HwpHandsError('INVALID_ARGUMENT', `계산식을 평가하지 못했습니다: ${error instanceof Error ? error.message.replace(/^렌더링 오류:\s*/, '') : String(error)}`); }
    if (typeof evaluated.result !== 'number' || !Number.isFinite(evaluated.result)) throw new HwpHandsError('INVALID_ARGUMENT', 'The formula did not produce a finite number.');
    const written = formatFormulaResult(evaluated.result, format, c.thousandsSeparator === true);
    this.replace({ section: table.section, paragraph: table.paragraph, cellPath: [{ controlIndex: table.control, cellIndex: cell.index, cellParaIndex: 0 }] }, written);
    return { ok: true, result: evaluated.result, text: written, formula, row: cell.row, col: cell.col };
  }
  private setTableProperties(target: Target & { control: number }, properties: TableProperties): Record<string, Json> {
    const table = this.tableForTarget(target), value = objectRecord(properties, 'Table properties');
    const allowed = ['cellSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'pageBreak', 'repeatHeader', 'hasCaption', 'captionDirection'] as const;
    rejectUnknownKeys(value, allowed, 'Table properties');
    for (const [key, item] of Object.entries(value)) {
      if (key === 'repeatHeader' || key === 'hasCaption') { if (typeof item !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be a boolean.`); }
      else if (key === 'captionDirection') { if (!Object.values(TABLE_CAPTION_DIRECTIONS).includes(item as never)) throw new HwpHandsError('INVALID_ARGUMENT', 'captionDirection must be Top, Bottom, Left or Right.'); }
      else {
        integer(item as number, key, 100_000);
        if (key === 'pageBreak' && (item as number) > 2) throw new HwpHandsError('INVALID_ARGUMENT', 'pageBreak must be 0, 1 or 2.');
      }
    }
    const native: Record<string, unknown> = { ...value };
    if (value.captionDirection !== undefined) {
      // RHWP reads the caption direction as a number and silently ignores the name, so it is converted here.
      const current = parsed<Record<string, Json>>(this.document.getTableProperties(table.section, table.paragraph, table.control));
      if (value.hasCaption !== true && !(value.hasCaption === undefined && current.hasCaption === true)) throw new HwpHandsError('INVALID_ARGUMENT', 'captionDirection needs a table caption (hasCaption: true).');
      native.captionDirection = Number(Object.entries(TABLE_CAPTION_DIRECTIONS).find(([, name]) => name === value.captionDirection)![0]);
    }
    return checked(this.document.setTableProperties(table.section, table.paragraph, table.control, JSON.stringify(native)));
  }
  private setCellProperties(target: Target & { control: number }, row: number, col: number, properties: CellProperties): Record<string, Json> {
    const table = this.tableForTarget(target), cell = this.tableCellAt(table, row, col), value = objectRecord(properties, 'Cell properties');
    const allowed = ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'verticalAlign', 'textDirection', 'isHeader', 'cellProtect', 'borderLeft', 'borderRight', 'borderTop', 'borderBottom', 'fillType', 'fillColor', 'patternColor', 'patternType'] as const;
    rejectUnknownKeys(value, allowed, 'Cell properties');
    for (const [key, item] of Object.entries(value)) {
      if (['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].includes(key)) integer(item as number, key, 100_000);
      else if (key === 'verticalAlign') integer(item as number, key, 2);
      else if (key === 'textDirection') integer(item as number, key, 3);
      else if (key === 'isHeader' || key === 'cellProtect') { if (typeof item !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be a boolean.`); }
      else if (key === 'fillType') { if (!['none', 'solid', 'pattern'].includes(String(item))) throw new HwpHandsError('INVALID_ARGUMENT', 'fillType must be none, solid or pattern.'); }
      else if (key === 'fillColor' || key === 'patternColor') value[key] = hexColor(item, key);
      else if (key === 'patternType' && item !== -1) integer(item as number, key, 64);
      else if (key.startsWith('border')) {
        const border = objectRecord(item, key);
        rejectUnknownKeys(border, ['type', 'width', 'color'], key);
        if (border.type !== undefined) integer(border.type as number, `${key}.type`, 32);
        if (border.width !== undefined) integer(border.width as number, `${key}.width`, 10_000);
        if (border.color !== undefined) border.color = hexColor(border.color, `${key}.color`);
      }
    }
    // RHWP defaults omitted border widths to zero even on a fill-only update, and
    // propagates those widths to neighbouring cells. Supply the current edges.
    const fillOnly = Object.keys(value).every(key => ['fillType', 'fillColor', 'patternColor', 'patternType'].includes(key));
    if (value.fillType === 'solid' && value.patternType === undefined) value.patternType = -1;
    if (fillOnly) {
      for (const key of ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'] as const) {
        if (cell.properties?.[key]) value[key] = { ...cell.properties[key] };
      }
    }
    const result = checked(this.document.setCellProperties(table.section, table.paragraph, table.control, cell.index, JSON.stringify(value)));
    if (fillOnly && Array.isArray(result.changes)) {
      const neighbours = (result.changes as Array<{ cellIdx: number; beforeId: number }>).filter(change => change.cellIdx !== cell.index)
        .map(change => ({ cellIdx: change.cellIdx, id: change.beforeId }));
      if (neighbours.length) checked(this.document.applyCellBorderFillIds(table.section, table.paragraph, table.control, JSON.stringify({ cells: neighbours, zones: [] })));
    }
    return result;
  }
  private objectForTarget(target: EditableObjectTarget): DocumentObject {
    if (!target || typeof target !== 'object' || !target.address || !['picture', 'shape', 'equation'].includes(target.kind)) throw new HwpHandsError('INVALID_ARGUMENT', 'An editable picture, shape or equation address is required.');
    integer(target.controlIndex, 'controlIndex');
    this.validateTarget(target.address);
    if (target.address.cellPath?.length) throw new HwpHandsError('INVALID_ARGUMENT', 'Object property changes and deletion currently require a root-body object.');
    const wanted = nodePath(target.address);
    const object = this.objects(undefined, false).find(candidate => candidate.kind === target.kind && candidate.controlIndex === target.controlIndex && nodePath(candidate.address) === wanted);
    if (!object) throw new HwpHandsError('INVALID_ARGUMENT', 'The addressed object no longer exists. Query the document structure again.');
    return object;
  }
  private setObjectProperties(target: EditableObjectTarget, properties: PictureProperties | ShapeProperties | import('./api').EquationProperties): Record<string, Json> {
    const object = this.objectForTarget(target), value = objectRecord(properties, 'Object properties');
    const geometry = ['width', 'height'];
    for (const key of geometry) if (value[key] !== undefined) {
      integer(value[key] as number, key, 1_000_000);
      if ((value[key] as number) < 1) throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be positive HWP units.`);
    }
    if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 256 || value.description.includes('\0'))) throw new HwpHandsError('INVALID_ARGUMENT', 'description must be at most 256 characters.');
    if (value.treatAsChar !== undefined && typeof value.treatAsChar !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'treatAsChar must be a boolean.');
    if (value.textWrap !== undefined && (typeof value.textWrap !== 'string' || !['Square', 'TopAndBottom'].includes(value.textWrap))) throw new HwpHandsError('INVALID_ARGUMENT', 'textWrap must be Square or TopAndBottom.');
    if (value.horzOffset !== undefined) signedInteger(value.horzOffset as number, 'horzOffset', 1_000_000);
    if (value.vertOffset !== undefined) signedInteger(value.vertOffset as number, 'vertOffset', 1_000_000);
    if (value.rotationAngle !== undefined) integer(value.rotationAngle as number, 'rotationAngle', 3600);
    if (target.kind === 'equation') {
      rejectUnknownKeys(value, ['width', 'height', 'description', 'treatAsChar', 'textWrap', 'horzOffset', 'vertOffset', 'rotationAngle', 'script', 'fontName', 'fontSize', 'color'], 'Equation properties');
      if (value.script !== undefined && (typeof value.script !== 'string' || value.script.length > 4096 || value.script.includes('\0'))) throw new HwpHandsError('INVALID_ARGUMENT', 'Equation script must be at most 4096 characters.');
      if (value.fontName !== undefined && (typeof value.fontName !== 'string' || !value.fontName.trim() || value.fontName.length > 128)) throw new HwpHandsError('INVALID_ARGUMENT', 'fontName must be a non-empty string of at most 128 characters.');
      if (value.fontSize !== undefined && (typeof value.fontSize !== 'number' || !Number.isFinite(value.fontSize) || value.fontSize < 1 || value.fontSize > 1000)) throw new HwpHandsError('INVALID_ARGUMENT', 'fontSize must be 1–1000pt.');
      const { fontSize, color, ...rest } = value;
      const native = { ...rest, ...(fontSize === undefined ? {} : { fontSize: (fontSize) * 100 }), ...(color === undefined ? {} : { color: colorNumber(color as string) }) };
      return checked(this.document.setEquationProperties(object.address.section, object.address.paragraph, object.controlIndex, -1, -1, JSON.stringify(native)));
    }
    rejectUnknownKeys(value, ['width', 'height', 'description', 'treatAsChar', 'textWrap', 'horzOffset', 'vertOffset', 'rotationAngle', 'horzFlip', 'vertFlip', 'hasCaption', 'captionDirection'], 'Object properties');
    for (const key of ['horzFlip', 'vertFlip', 'hasCaption']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be a boolean.`);
    if (value.captionDirection !== undefined && (typeof value.captionDirection !== 'string' || !['Top', 'Bottom', 'Left', 'Right'].includes(value.captionDirection))) throw new HwpHandsError('INVALID_ARGUMENT', 'captionDirection must be Top, Bottom, Left or Right.');
    // RHWP moves a shape's caption anchor when the document is saved and reopened, so captions are limited to pictures.
    if (target.kind === 'shape' && (value.hasCaption !== undefined || value.captionDirection !== undefined)) throw new HwpHandsError('INVALID_ARGUMENT', 'Captions are supported on pictures only; shape captions do not survive a save and reopen unchanged.');
    const json = JSON.stringify(value);
    return target.kind === 'picture'
      ? checked(this.document.setPictureProperties(object.address.section, object.address.paragraph, object.controlIndex, json))
      : checked(this.document.setShapeProperties(object.address.section, object.address.paragraph, object.controlIndex, json));
  }
  private setObjectZOrder(target: EditableObjectTarget, operation: string): Record<string, Json> {
    const object = this.objectForTarget(target);
    if (target.kind === 'equation') throw new HwpHandsError('INVALID_ARGUMENT', 'Equations cannot be reordered.');
    if (!['front', 'back', 'forward', 'backward', 'inFrontOfText', 'behindText'].includes(operation)) throw new HwpHandsError('INVALID_ARGUMENT', 'operation must be front, back, forward, backward, inFrontOfText or behindText.');
    // setControlZOrderAt addresses the paragraph by its document-wide index.
    const globalParagraph = this.structuralModel().starts[object.address.section] + object.address.paragraph;
    return checked(this.document.setControlZOrderAt(globalParagraph, object.controlIndex, operation));
  }
  private groupObjects(targets: EditableObjectTarget[]): Record<string, Json> {
    if (!Array.isArray(targets) || targets.length < 2 || targets.length > 64) throw new HwpHandsError('INVALID_ARGUMENT', 'Grouping needs 2–64 objects.');
    const objects = targets.map(target => {
      const object = this.objectForTarget(target);
      if (target.kind === 'equation') throw new HwpHandsError('INVALID_ARGUMENT', 'Equations cannot be grouped.');
      return object;
    });
    if (new Set(objects.map(object => `${nodePath(object.address)}|${object.controlIndex}`)).size !== objects.length) throw new HwpHandsError('INVALID_ARGUMENT', 'The same object appears more than once.');
    if (new Set(objects.map(object => object.address.section)).size !== 1) throw new HwpHandsError('INVALID_ARGUMENT', 'Grouped objects must be in the same section.');
    return checked(this.document.groupShapes(JSON.stringify({ sectionIdx: objects[0].address.section, targets: objects.map(object => ({ paraIdx: object.address.paragraph, controlIdx: object.controlIndex })) })));
  }
  private ungroupObject(target: EditableObjectTarget): Record<string, Json> {
    const object = this.objectForTarget(target);
    if (target.kind !== 'shape') throw new HwpHandsError('INVALID_ARGUMENT', 'Only a group of shapes can be ungrouped.');
    let result: Record<string, Json>;
    try { result = checked(this.document.ungroupShape(object.address.section, object.address.paragraph, object.controlIndex)); }
    catch (error) { throw new HwpHandsError('INVALID_ARGUMENT', `The object is not a group: ${error instanceof Error ? error.message.replace(/^렌더링 오류:\s*/, '') : String(error)}`); }
    return result;
  }
  private deleteObject(target: EditableObjectTarget): Record<string, Json> {
    const object = this.objectForTarget(target);
    if (target.kind === 'picture') return checked(this.document.deletePictureControl(object.address.section, object.address.paragraph, object.controlIndex));
    if (target.kind === 'shape') return checked(this.document.deleteShapeControl(object.address.section, object.address.paragraph, object.controlIndex));
    return checked(this.document.deleteEquationControl(object.address.section, object.address.paragraph, object.controlIndex));
  }
  private insertImage(target: Target, offset: number, imageBase64: string, extension: string, width: number, height: number, naturalWidthPx: number, naturalHeightPx: number, description = ''): Record<string, Json> {
    const paragraph = this.rootParagraph(target, 'Picture insertion'); integer(offset, 'offset', paragraph.length);
    for (const [key, value] of [['width', width], ['height', height], ['naturalWidthPx', naturalWidthPx], ['naturalHeightPx', naturalHeightPx]] as const) {
      integer(value, key, key.endsWith('Px') ? 100_000 : 1_000_000);
      if (!value) throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be positive.`);
    }
    if (typeof extension !== 'string' || !['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(extension.toLowerCase())) throw new HwpHandsError('INVALID_ARGUMENT', 'extension must be png, jpg, jpeg, gif or bmp.');
    if (typeof description !== 'string' || description.length > 256 || description.includes('\0')) throw new HwpHandsError('INVALID_ARGUMENT', 'description must be at most 256 characters.');
    const bytes = decodeImageBase64(imageBase64); validateImageSignature(bytes, extension);
    return checked(this.document.insertPicture(target.section, target.paragraph, offset, '[]', bytes, width, height, naturalWidthPx, naturalHeightPx, extension.toLowerCase() === 'jpeg' ? 'jpg' : extension.toLowerCase(), description));
  }
  execute(c: Command): Record<string, Json> {
    // Typed text changes one root paragraph. The whole-document lists are kept across it with that paragraph read again,
    // so the queries that follow every key do not rebuild them from the engine.
    const typed = this.mutating ? undefined : this.typedRootTarget(c);
    const kept = typed && this.memo.has('roots') ? new Map(this.memo) : undefined;
    const countBefore = typed ? this.document.getParagraphCount(typed.section) : -1;
    let done = false;
    this.mutating++; this.memo.clear();
    try { const result = this.executeCommand(c); done = true; return result; }
    finally {
      this.mutating--; this.memo.clear();
      if (done && typed && kept && this.document.getParagraphCount(typed.section) === countBefore) this.carryTypedParagraph(kept, typed);
    }
  }
  private typedRootTarget(c: Command): Target | undefined {
    if (!c || (c.type !== 'insertText' && c.type !== 'deleteText')) return undefined;
    const target = c.target as Target & { kind?: unknown };
    if (!target || (target.kind !== undefined && target.kind !== 'body') || target.cellPath?.length || !Number.isSafeInteger(target.section) || !Number.isSafeInteger(target.paragraph)) return undefined;
    if (target.section < 0 || target.section >= this.document.getSectionCount()) return undefined;
    if (c.type === 'insertText' && (typeof c.text !== 'string' || Array.from(c.text).some(character => [10, 13, 0x2028, 0x2029].includes(character.codePointAt(0)!)))) return undefined;
    return { section: target.section, paragraph: target.paragraph };
  }
  private carryTypedParagraph(kept: Map<string, unknown>, target: Target): void {
    try {
      const roots = kept.get('roots') as Paragraph[][], old = roots[target.section]?.[target.paragraph];
      if (!old) return;
      const next = this.paragraph(target, this.structuralModel());
      if (next.nodePath !== old.nodePath) return;
      // The flat lists hold the same paragraph objects as the root list.
      const places: Array<[unknown[], number]> = [[roots[target.section], target.paragraph]];
      for (const [key, value] of kept) if (key.startsWith('paragraphs:')) { const index = (value as unknown[]).indexOf(old); if (index < 0) return; places.push([value as unknown[], index]); }
      for (const [list, index] of places) list[index] = next;
      for (const [key, value] of kept) this.memo.set(key, value);
    } catch { this.memo.clear(); }
  }
  private executeCommand(c: Command): Record<string, Json> {
    const d = this.document;
    if (!c || typeof c !== 'object') throw new HwpHandsError('INVALID_ARGUMENT', '편집 명령이 올바르지 않습니다.');
    switch (c.type) {
      case 'insertText': {
        if (c.characterProperties !== undefined) this.validateCharacterProperties(c.characterProperties);
        const result = this.insert(c.target, c.offset, c.text);
        if (c.characterProperties !== undefined) {
          const properties = c.characterProperties;
          const length = Array.from(c.text).length;
          if (length && Object.keys(properties).length) this.applyCharacterFormat(c.target, c.offset, c.offset + length, properties);
        }
        return result;
      }
      case 'insertLineBreak': return this.insert(c.target, c.offset, '\n');
      case 'insertTab': return this.insert(c.target, c.offset, '\t');
      case 'pasteHtml': return this.pasteHtml(c.target, c.offset, c.html);
      case 'deleteText': return this.remove(c.target, c.offset, c.count);
      case 'replaceParagraph': return this.replace(c.target, c.text, c.expectedText, c.preserveFormatting, c.normalizeFormAnswer, c.rewriteFormatting, c.rewriteVersion);
      case 'replaceRange': return this.replaceRange(c.start, c.end, c.text);
      case 'deleteRange': return this.deleteRange(c.start, c.end, c.deleteAnchoredContent ?? false);
      case 'splitParagraph': return this.splitParagraphAt(c.target, c.offset, c.verifyRewriteFormatting);
      case 'mergeParagraph': return this.mergeParagraphAt(c.target);
      case 'deleteParagraphAt': return this.deleteParagraphAt(c.target);
      case 'insertCellParagraph': return this.insertCellParagraph(c);
      case 'replaceText':
        text(c.query); text(c.replacement); if (!c.query) throw new HwpHandsError('INVALID_ARGUMENT', '치환 검색어가 비어 있습니다.');
        return checked(d.replaceAll(c.query, c.replacement, c.caseSensitive ?? false));
      case 'insertParagraph':
        integer(c.section, 'section', d.getSectionCount() - 1); integer(c.index, 'index', d.getParagraphCount(c.section)); text(c.text);
        if (c.like !== undefined && c.like !== 'previous' && c.like !== 'next') throw new HwpHandsError('INVALID_ARGUMENT', "like must be 'previous' or 'next'.");
        if (c.like === 'previous' && c.index === 0) throw new HwpHandsError('INVALID_ARGUMENT', '구역의 첫 문단 앞에는 앞 문단이 없습니다.');
        if (c.like === 'next' && c.index >= d.getParagraphCount(c.section)) throw new HwpHandsError('INVALID_ARGUMENT', '구역의 마지막 문단 뒤에는 다음 문단이 없습니다.');
        // The engine's own insertion copies the previous paragraph, and at the head of a section it moves the section, column,
        // header and footer controls into the second paragraph: a saved file then carries two section definitions.
        if (c.like === 'next' || c.index === 0) return this.insertBefore({ section: c.section, paragraph: c.index }, c.text);
        checked(d.insertParagraph(c.section, c.index)); return this.insert({ section: c.section, paragraph: c.index }, 0, c.text);
      case 'deleteParagraph':
        integer(c.section, 'section', d.getSectionCount() - 1); integer(c.index, 'index', d.getParagraphCount(c.section) - 1);
        if (c.index === 0 || d.getParagraphCount(c.section) <= 1) throw new HwpHandsError('INVALID_ARGUMENT', '구역의 첫 문단은 삭제할 수 없습니다.', { reason: 'first-paragraph' });
        return this.deleteParagraphAt({ section: c.section, paragraph: c.index });
      case 'setCellText': {
        if (c.table.cellPath) throw new HwpHandsError('INVALID_ARGUMENT', '중첩 셀은 replaceParagraph와 cellPath로 편집하세요.');
        this.validateTarget(c.table); integer(c.table.control, 'control'); integer(c.row, 'row'); integer(c.col, 'col');
        const table = this.tables().find(t => t.section === c.table.section && t.paragraph === c.table.paragraph && t.control === c.table.control);
        const cell = table?.cells.find(cell => c.row >= cell.row && c.row < cell.row + cell.rowSpan && c.col >= cell.col && c.col < cell.col + cell.colSpan);
        if (!cell) throw new HwpHandsError('INVALID_ARGUMENT', '표 셀을 찾을 수 없습니다.');
        const cellParaIndex = c.cellParagraph ?? 0; integer(cellParaIndex, 'cellParagraph', cell.paragraphs.length - 1);
        return this.replace({ section: table!.section, paragraph: table!.paragraph, cellPath: [{ controlIndex: table!.control, cellIndex: cell.index, cellParaIndex }] }, c.text);
      }
      case 'setField': {
        text(c.name); text(c.value);
        if (c.normalizeFormAnswer !== undefined && typeof c.normalizeFormAnswer !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'normalizeFormAnswer must be boolean.');
        const fields = this.fields(), matches = fields.filter(field => field.name === c.name);
        if (matches.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', matches.length ? '필드 이름이 중복되었습니다. fieldId를 사용하세요.' : '필드 이름을 찾을 수 없습니다.', { name: c.name, fieldIds: matches.map(field => field.fieldId) });
        if (fields.filter(field => field.fieldId === matches[0].fieldId).length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', 'fieldId가 현재 문서에서 모호합니다.', { fieldId: matches[0].fieldId });
        if (c.normalizeFormAnswer) { this.writeFormField(fields, fields.indexOf(matches[0]), c.value); return { ok: true }; }
        return checked(d.setFieldValue(matches[0].fieldId, c.value));
      }
      case 'setFieldById': {
        integer(c.fieldId, 'fieldId'); text(c.value);
        const matches = this.fields().filter(field => field.fieldId === c.fieldId);
        if (matches.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', matches.length ? 'fieldId가 현재 문서에서 모호합니다.' : 'fieldId를 찾을 수 없습니다.', { fieldId: c.fieldId });
        return checked(d.setFieldValue(c.fieldId, c.value));
      }
      case 'setFields': {
        if (!Array.isArray(c.values) || !c.values.length || c.values.length > 100) throw new HwpHandsError('INVALID_ARGUMENT', 'setFields는 1~100개의 값을 받습니다.');
        if (c.normalizeFormAnswer !== undefined && typeof c.normalizeFormAnswer !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'normalizeFormAnswer must be boolean.');
        const before = this.fields();
        const targets = c.values.map(item => {
          integer(item?.fieldId, 'fieldId'); text(item.value);
          const matches = before.flatMap((field, index) => field.fieldId === item.fieldId ? [index] : []);
          if (matches.length !== 1) throw new HwpHandsError('INVALID_ARGUMENT', matches.length ? 'fieldId가 현재 문서에서 모호합니다.' : 'fieldId를 찾을 수 없습니다.', { fieldId: item.fieldId });
          return { index: matches[0], name: before[matches[0]].name, value: item.value };
        });
        if (new Set(targets.map(target => target.index)).size !== targets.length) throw new HwpHandsError('INVALID_ARGUMENT', '같은 필드를 두 번 지정했습니다.');
        // A value never adds or removes a field, so a field keeps its place in the list. Its id is looked up again by that
        // place before each write; anything else means the list changed and the transaction is rolled back.
        for (const target of targets) {
          const now = this.fields(), field = now[target.index];
          if (now.length !== before.length || !field || field.name !== target.name) throw new HwpHandsError('VERIFY_FAILED', '필드 값을 쓰는 동안 필드 목록이 달라졌습니다.');
          if (c.normalizeFormAnswer) this.writeFormField(now, target.index, target.value);
          else checked(d.setFieldValue(field.fieldId, target.value));
        }
        return { ok: true, count: targets.length };
      }
      case 'setFieldsAt': {
        if (!Array.isArray(c.values) || !c.values.length || c.values.length > 100) throw new HwpHandsError('INVALID_ARGUMENT', 'setFieldsAt는 1~100개의 값을 받습니다.');
        if (c.normalizeFormAnswer !== undefined && typeof c.normalizeFormAnswer !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'normalizeFormAnswer must be boolean.');
        const before = this.fields();
        const indices = new Set<number>();
        for (const item of c.values) {
          integer(item?.index, 'index', before.length - 1); integer(item?.fieldId, 'fieldId'); text(item.name); text(item.expectedValue); text(item.value);
          const field = before[item.index];
          if (indices.has(item.index)) throw new HwpHandsError('INVALID_ARGUMENT', '같은 누름틀을 두 번 지정했습니다.');
          indices.add(item.index);
          if (!field || field.fieldId !== item.fieldId || field.name !== item.name || field.value !== item.expectedValue || field.fieldType !== 'clickhere')
            throw new HwpHandsError('REVISION_CONFLICT', '누름틀 목록이나 관측한 값이 변경되었습니다.');
        }
        for (const item of c.values) {
          const now = this.fields(), field = now[item.index];
          if (now.length !== before.length || !field || field.fieldId !== item.fieldId || field.name !== item.name || field.value !== item.expectedValue)
            throw new HwpHandsError('VERIFY_FAILED', '누름틀을 채우는 동안 목록이 달라졌습니다.');
          const duplicate = now.filter(candidate => candidate.fieldId === field.fieldId).length > 1;
          this.writeFormField(now, item.index, item.value, duplicate, c.normalizeFormAnswer === true);
        }
        return { ok: true, count: c.values.length };
      }
      case 'insertClickHereField': {
        text(c.guide); text(c.memo); text(c.name);
        if (!c.name.trim()) throw new HwpHandsError('INVALID_ARGUMENT', '필드 이름은 비어 있을 수 없습니다.');
        if (typeof c.editable !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', '필드 editable 값은 boolean이어야 합니다.');
        this.validateTarget(c.target);
        const paragraph = this.paragraph(c.target);
        if (paragraph.address.kind !== 'body') throw new HwpHandsError('INVALID_ARGUMENT', '누름틀 필드는 본문 문단에만 넣을 수 있습니다.');
        if (paragraph.address.containerKinds?.includes('textBox')) throw new HwpHandsError('INVALID_ARGUMENT', '글상자에는 누름틀 필드를 넣을 수 없습니다.');
        integer(c.offset, 'offset', paragraph.length);
        const result = c.target.cellPath?.length
          ? d.insertClickHereFieldByPath(c.target.section, c.target.paragraph, JSON.stringify(c.target.cellPath), c.offset, c.guide, c.memo, c.name, c.editable)
          : d.insertClickHereField(c.target.section, c.target.paragraph, c.offset, c.guide, c.memo, c.name, c.editable);
        return checked(result);
      }
      case 'updateField': return this.updateField(c);
      case 'removeField': return this.removeField(c);
      case 'formatText': return this.applyCharacterFormat(c.target, c.start, c.end, c.properties);
      case 'formatParagraph': return this.applyParagraphFormat(c.target, c.properties);
      case 'formatRange': return this.formatRange(c);
      case 'formatCellBlock': return this.formatCellBlock(c);
      case 'createStyle': return this.createStyle(c);
      case 'updateStyle': return this.updateStyle(c);
      case 'deleteStyle': return this.deleteStyle(c.styleId);
      case 'createNumbering': return this.createNumbering(c);
      case 'setParagraphStyle': return this.setParagraphStyle(c.target, c.styleId);
      case 'setParagraphList': return this.setParagraphList(c.target, c.list);
      case 'createTable':
        if (c.target.cellPath) throw new HwpHandsError('INVALID_ARGUMENT', '표 생성은 본문에서 지원합니다.');
        integer(c.rows, 'rows', 100); integer(c.cols, 'cols', 100);
        if (!c.rows || !c.cols || c.rows * c.cols > 1000) throw new HwpHandsError('INVALID_ARGUMENT', '표는 1~100행/열, 최대 1000셀입니다.');
        integer(c.offset, 'offset', this.paragraph(c.target).length);
        return checked(d.createTable(c.target.section, c.target.paragraph, c.offset, c.rows, c.cols));
      case 'insertTableRow': {
        const table = this.tableForTarget(c.table); integer(c.row, 'row', table.rows - 1);
        if (c.below !== undefined && typeof c.below !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'below must be a boolean.');
        return checked(d.insertTableRow(table.section, table.paragraph, table.control, c.row, c.below ?? true));
      }
      case 'deleteTableRow': {
        const table = this.tableForTarget(c.table); integer(c.row, 'row', table.rows - 1);
        if (table.rows <= 1) throw new HwpHandsError('INVALID_ARGUMENT', 'A table must keep at least one row.');
        return checked(d.deleteTableRow(table.section, table.paragraph, table.control, c.row));
      }
      case 'insertTableColumn': {
        const table = this.tableForTarget(c.table); integer(c.col, 'col', table.cols - 1);
        if (c.right !== undefined && typeof c.right !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'right must be a boolean.');
        return checked(d.insertTableColumn(table.section, table.paragraph, table.control, c.col, c.right ?? true));
      }
      case 'deleteTableColumn': {
        const table = this.tableForTarget(c.table); integer(c.col, 'col', table.cols - 1);
        if (table.cols <= 1) throw new HwpHandsError('INVALID_ARGUMENT', 'A table must keep at least one column.');
        return checked(d.deleteTableColumn(table.section, table.paragraph, table.control, c.col));
      }
      case 'mergeTableCells': {
        const table = this.tableForTarget(c.table);
        integer(c.startRow, 'startRow', table.rows - 1); integer(c.endRow, 'endRow', table.rows - 1);
        integer(c.startCol, 'startCol', table.cols - 1); integer(c.endCol, 'endCol', table.cols - 1);
        if (c.startRow > c.endRow || c.startCol > c.endCol || c.startRow === c.endRow && c.startCol === c.endCol) throw new HwpHandsError('INVALID_ARGUMENT', 'The merge range must contain at least two cells in row-major order.');
        const covered = new Set<string>();
        const mergeCells: Table['cells'] = [];
        for (const cell of table.cells) {
          const bottom = cell.row + cell.rowSpan - 1, right = cell.col + cell.colSpan - 1;
          const overlaps = cell.row <= c.endRow && bottom >= c.startRow && cell.col <= c.endCol && right >= c.startCol;
          if (!overlaps) continue;
          mergeCells.push(cell);
          if (cell.row < c.startRow || cell.col < c.startCol || bottom > c.endRow || right > c.endCol) throw new HwpHandsError('INVALID_ARGUMENT', 'A merge range cannot cut through an existing merged cell.');
          for (let row = cell.row; row <= bottom; row++) for (let col = cell.col; col <= right; col++) {
            const key = `${row}:${col}`; if (covered.has(key)) throw new HwpHandsError('INVALID_ARGUMENT', 'The table contains overlapping cell spans.'); covered.add(key);
          }
        }
        if (covered.size !== (c.endRow - c.startRow + 1) * (c.endCol - c.startCol + 1)) throw new HwpHandsError('INVALID_ARGUMENT', 'The merge range includes a missing cell.');
        const firstCell = mergeCells.find(cell => cell.row === c.startRow && cell.col === c.startCol);
        if (!firstCell) throw new HwpHandsError('INVALID_ARGUMENT', 'The merge range has no top-left destination cell.');
        if (mergeCells.some(cell => cell.index !== firstCell.index && this.cellHasContent(table, cell))) {
          throw new HwpHandsError('INVALID_ARGUMENT', 'Merging would discard content or controls in a non-anchor cell. Move that content first.');
        }
        return checked(d.mergeTableCells(table.section, table.paragraph, table.control, c.startRow, c.startCol, c.endRow, c.endCol));
      }
      case 'splitTableCell': {
        const table = this.tableForTarget(c.table), cell = this.tableCellAt(table, c.row, c.col);
        const hasRows = c.rows !== undefined, hasCols = c.cols !== undefined;
        if (hasRows !== hasCols) throw new HwpHandsError('INVALID_ARGUMENT', 'rows and cols must be supplied together.');
        if (!hasRows && cell.rowSpan === 1 && cell.colSpan === 1) throw new HwpHandsError('INVALID_ARGUMENT', 'The addressed cell is not merged.');
        if (c.equalRowHeight !== undefined && typeof c.equalRowHeight !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'equalRowHeight must be a boolean.');
        if (hasRows && hasCols) {
          integer(c.rows!, 'rows', 100); integer(c.cols!, 'cols', 100);
          if (c.rows! * c.cols! < 2 || c.rows! * c.cols! > 1000) throw new HwpHandsError('INVALID_ARGUMENT', 'Cell split must produce 2–1000 cells.');
          return checked(d.splitTableCellInto(table.section, table.paragraph, table.control, c.row, c.col, c.rows!, c.cols!, c.equalRowHeight ?? true, false));
        }
        return checked(d.splitTableCell(table.section, table.paragraph, table.control, c.row, c.col));
      }
      case 'resizeTableCells': {
        const table = this.tableForTarget(c.table);
        if (!Array.isArray(c.cells) || !c.cells.length || c.cells.length > 1000) throw new HwpHandsError('INVALID_ARGUMENT', 'cells must contain 1–1000 cell size changes.');
        const seen = new Set<number>();
        const changes = c.cells.map(item => {
          if (!item || typeof item !== 'object') throw new HwpHandsError('INVALID_ARGUMENT', 'Each cell size change must be an object.');
          const cell = this.tableCellAt(table, item.row, item.col);
          if (seen.has(cell.index)) throw new HwpHandsError('INVALID_ARGUMENT', 'A table cell can only be resized once per command.'); seen.add(cell.index);
          if (item.widthDelta === undefined && item.heightDelta === undefined) throw new HwpHandsError('INVALID_ARGUMENT', 'Each resize needs widthDelta or heightDelta.');
          if (item.widthDelta !== undefined) signedInteger(item.widthDelta, 'widthDelta', 100_000);
          if (item.heightDelta !== undefined) signedInteger(item.heightDelta, 'heightDelta', 100_000);
          return { cellIdx: cell.index, ...(item.widthDelta === undefined ? {} : { widthDelta: item.widthDelta }), ...(item.heightDelta === undefined ? {} : { heightDelta: item.heightDelta }) };
        });
        return checked(d.resizeTableCells(table.section, table.paragraph, table.control, JSON.stringify(changes)));
      }
      case 'transposeTable': return this.transposeTable(c.table);
      case 'splitTable': return this.splitTable(c.table, c.atRow);
      case 'mergeTableWithNext': return this.mergeTableWithNext(c.table);
      case 'deleteTable': return this.deleteTable(c.table);
      case 'setTableFormula': return this.setTableFormula(c);
      case 'setTableProperties': return this.setTableProperties(c.table, c.properties);
      case 'setCellProperties': {
        const table = this.tableForTarget(c.table); this.tableCellAt(table, c.row, c.col);
        return this.setCellProperties(c.table, c.row, c.col, c.properties);
      }
      case 'deleteNote': {
        const paragraph = this.paragraphAt(c.target), address = paragraph.address;
        if (address.kind !== 'footnote' && address.kind !== 'endnote') throw new HwpHandsError('INVALID_ARGUMENT', 'Select a footnote or endnote.');
        return checked(d.deleteFootnote(address.section, address.anchor.paragraph, address.controlIndex));
      }
      case 'insertNote': {
        const paragraph = this.rootParagraph(c.target, 'Footnote and endnote insertion'); integer(c.offset, 'offset', paragraph.length);
        if (c.kind === 'footnote') return checked(d.insertFootnote(c.target.section, c.target.paragraph, c.offset));
        if (c.kind === 'endnote') return checked(d.insertEndnote(c.target.section, c.target.paragraph, c.offset));
        throw new HwpHandsError('INVALID_ARGUMENT', 'kind must be footnote or endnote.');
      }
      case 'setEndnoteShape': return this.setEndnoteShape(c.section, c.properties);
      case 'applyHeaderFooterTemplate': {
        integer(c.section, 'section', this.document.getSectionCount() - 1);
        if (typeof c.isHeader !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'isHeader must be boolean.');
        integer(c.applyTo, 'applyTo', 2);
        integer(c.templateId, 'templateId', 10);
        return checked(d.applyHfTemplate(c.section, c.isHeader, c.applyTo, c.templateId));
      }
      case 'deleteHeaderFooter': {
        integer(c.section, 'section', this.document.getSectionCount() - 1);
        if (typeof c.isHeader !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'isHeader must be boolean.');
        integer(c.applyTo, 'applyTo', 2);
        return checked(d.deleteHeaderFooter(c.section, c.isHeader, c.applyTo));
      }
      case 'insertPageBreak': {
        const paragraph = this.rootParagraph(c.target, 'Page and column breaks'); integer(c.offset, 'offset', paragraph.length);
        const kind = c.kind ?? 'page';
        if (kind === 'page') return checked(d.insertPageBreak(c.target.section, c.target.paragraph, c.offset));
        if (kind === 'column') return checked(d.insertColumnBreak(c.target.section, c.target.paragraph, c.offset));
        throw new HwpHandsError('INVALID_ARGUMENT', 'kind must be page or column.');
      }
      case 'setPageSettings': return this.pageSettings(c.section, c.properties);
      case 'setPageHide': return this.setPageHide(c.target, c.properties);
      case 'insertNewNumber': {
        const paragraph = this.rootParagraph(c.target, 'New page number'); integer(c.offset, 'offset', paragraph.length);
        integer(c.number, 'number', 65535); if (!c.number) throw new HwpHandsError('INVALID_ARGUMENT', 'number must be 1–65535.');
        return checked(d.insertNewNumber(c.target.section, c.target.paragraph, c.offset, c.number));
      }
      case 'addBookmark': {
        const paragraph = this.rootParagraph(c.target, 'Bookmark insertion'); integer(c.offset, 'offset', paragraph.length);
        const name = this.bookmarkName(c.name, 'name');
        if (this.bookmarks().some(item => item.name === name)) throw new HwpHandsError('INVALID_ARGUMENT', `Bookmark "${name}" already exists.`);
        return checked(d.addBookmark(c.target.section, c.target.paragraph, c.offset, name));
      }
      case 'renameBookmark': {
        const current = this.findBookmark(this.bookmarkName(c.name, 'name')), newName = this.bookmarkName(c.newName, 'newName');
        if (newName === current.name) throw new HwpHandsError('INVALID_ARGUMENT', 'newName must differ from the current bookmark name.');
        if (this.bookmarks().some(item => item.name === newName)) throw new HwpHandsError('INVALID_ARGUMENT', `Bookmark "${newName}" already exists.`);
        return checked(d.renameBookmark(current.address.section, current.address.paragraph, current.controlIndex, newName));
      }
      case 'deleteBookmark': {
        const current = this.findBookmark(this.bookmarkName(c.name, 'name'));
        return checked(d.deleteBookmark(current.address.section, current.address.paragraph, current.controlIndex));
      }
      case 'setColumnSettings': return this.setColumnSettings(c.section, c.properties);
      case 'setPageBorderFill': return this.setPageBorderFill(c.section, c.properties);
      case 'setSectionDefinition': return this.setSectionDefinition(c.section, c.properties);
      case 'insertEquation': {
        const paragraph = this.rootParagraph(c.target, 'Equation insertion'); integer(c.offset, 'offset', paragraph.length); text(c.script);
        if (!c.script.length || c.script.length > 4096) throw new HwpHandsError('INVALID_ARGUMENT', 'Equation script must contain 1–4096 characters.');
        const fontSize = c.fontSize ?? 12; if (!Number.isFinite(fontSize) || fontSize < 1 || fontSize > 1000) throw new HwpHandsError('INVALID_ARGUMENT', 'fontSize must be 1–1000pt.');
        return checked(d.insertEquation(c.target.section, c.target.paragraph, c.offset, c.script, Math.round(fontSize * 100), colorNumber(c.color ?? '#000000')));
      }
      case 'insertPicture': return this.insertImage(c.target, c.offset, c.imageBase64, c.extension, c.width, c.height, c.naturalWidthPx, c.naturalHeightPx, c.description);
      case 'insertShape': {
        const paragraph = this.rootParagraph(c.target, 'Shape insertion'); integer(c.offset, 'offset', paragraph.length);
        if (c.shape !== 'rectangle' && c.shape !== 'textBox') throw new HwpHandsError('INVALID_ARGUMENT', 'shape must be rectangle or textBox.');
        for (const [key, value] of [['width', c.width], ['height', c.height]] as const) { integer(value, key, 1_000_000); if (!value) throw new HwpHandsError('INVALID_ARGUMENT', `${key} must be positive HWP units.`); }
        if (c.treatAsChar !== undefined && typeof c.treatAsChar !== 'boolean') throw new HwpHandsError('INVALID_ARGUMENT', 'treatAsChar must be a boolean.');
        if (c.textWrap !== undefined && c.textWrap !== 'Square' && c.textWrap !== 'TopAndBottom') throw new HwpHandsError('INVALID_ARGUMENT', 'textWrap must be Square or TopAndBottom.');
        if (c.description !== undefined && (typeof c.description !== 'string' || c.description.length > 256 || c.description.includes('\0'))) throw new HwpHandsError('INVALID_ARGUMENT', 'description must be at most 256 characters.');
        if (c.horzOffset !== undefined) signedInteger(c.horzOffset, 'horzOffset', 1_000_000);
        if (c.vertOffset !== undefined) signedInteger(c.vertOffset, 'vertOffset', 1_000_000);
        if (c.text !== undefined) text(c.text);
        if (c.shape === 'rectangle' && c.text) throw new HwpHandsError('INVALID_ARGUMENT', 'Text can only be inserted in a textBox shape.');
        const result = checked(d.createShapeControl(JSON.stringify({
          sectionIdx: c.target.section, paraIdx: c.target.paragraph, charOffset: c.offset, width: c.width, height: c.height,
          horzOffset: c.horzOffset ?? 0, vertOffset: c.vertOffset ?? 0, treatAsChar: c.treatAsChar ?? false, textWrap: c.textWrap ?? 'Square',
        })));
        const controlIndex = result.controlIdx;
        if (typeof controlIndex !== 'number' || !Number.isSafeInteger(controlIndex)) throw new HwpHandsError('ENGINE_ERROR', 'RHWP did not return the inserted shape address.');
        if (c.shape === 'textBox') {
          const globalParagraph = this.structuralModel().starts[c.target.section] + c.target.paragraph;
          checked(d.setTextBoxAt(globalParagraph, controlIndex, true));
          const textBoxIndex = d.getTextBoxControlIndex(c.target.section, c.target.paragraph);
          if (textBoxIndex < 0) throw new HwpHandsError('ENGINE_ERROR', 'RHWP did not create the requested text box.');
          if (c.text) checked(d.insertTextInCellByPath(c.target.section, c.target.paragraph, JSON.stringify([{ controlIndex: textBoxIndex, cellIndex: 0, cellParaIndex: 0 }]), 0, c.text));
        }
        if (c.description !== undefined) checked(d.setShapeProperties(c.target.section, c.target.paragraph, controlIndex, JSON.stringify({ description: c.description })));
        return result;
      }
      case 'setObjectProperties': return this.setObjectProperties(c.object, c.properties);
      case 'setObjectZOrder': return this.setObjectZOrder(c.object, c.operation);
      case 'groupObjects': return this.groupObjects(c.objects);
      case 'ungroupObject': return this.ungroupObject(c.object);
      case 'deleteObject': return this.deleteObject(c.object);
      default: throw new HwpHandsError('INVALID_ARGUMENT', '지원하지 않는 편집 명령입니다.');
    }
  }
}

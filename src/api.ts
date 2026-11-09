/** API v1: all indices are zero based; text offsets count Unicode code points. */
export type Format = 'hwp' | 'hwpx';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface CellStep { controlIndex: number; cellIndex: number; cellParaIndex: number }
export type ContainerKind = 'tableCell' | 'textBox';
export interface Target { section: number; paragraph: number; cellPath?: CellStep[]; containerKinds?: ContainerKind[]; sessionId?: string; revision?: number }
export type BodyAddress = Target & { kind: 'body' };
export interface HeaderFooterAddress { kind: 'headerFooter'; section: number; isHeader: boolean; applyTo: number; paragraph: number; sessionId?: string; revision?: number }
export interface HeaderFooterPageNavigationResult { ok: boolean; pageIndex?: number; section?: number; isHeader?: boolean; applyTo?: number }
export interface NoteAddress { kind: 'footnote' | 'endnote'; section: number; anchor: BodyAddress; controlIndex: number; paragraph: number; sessionId?: string; revision?: number }
export type DocumentAddress = BodyAddress | HeaderFooterAddress | NoteAddress;
export type TextTarget = Target | HeaderFooterAddress | NoteAddress;
export interface CharacterProperties {
  fontFamily?: string; fontSize?: number; bold?: boolean; italic?: boolean; underline?: boolean;
  underlineType?: 'None' | 'Bottom' | 'Top'; underlineColor?: string; underlineShape?: number;
  strikethrough?: boolean; strikeColor?: string; strikeShape?: number; textColor?: string; shadeColor?: string;
  outlineType?: number; shadowType?: number; shadowColor?: string; shadowOffsetX?: number; shadowOffsetY?: number;
  subscript?: boolean; superscript?: boolean; emboss?: boolean; engrave?: boolean; emphasisDot?: number; kerning?: boolean; charShapeId?: number;
  fontFamilies?: string[]; ratios?: number[]; spacings?: number[]; relativeSizes?: number[]; charOffsets?: number[];
}
/** Character formatting inputs. `ratio`, `characterSpacing`, `relativeSize` and `characterOffset` are integer percent values shared by all seven HWP language slots. Extended underline, strike, outline, shadow, emphasis, and script/emboss effects are validated against 현재 RHWP 코어 ranges. */
export interface CharacterFormatProperties {
  /** With fontFamily, changes only this HWP language slot (0 Korean, 1 Latin, 2 Hanja, 3 Japanese, 4 Other, 5 Symbol, 6 User). Omit to change all slots. */
  fontLanguage?: number;
  /** Explicit names for all seven slots; mutually exclusive with fontFamily/fontLanguage. */
  fontFamilies?: string[];
  bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean;
  underlineType?: 'None' | 'Bottom' | 'Top'; underlineColor?: string; underlineShape?: number;
  strikeColor?: string; strikeShape?: number;
  outlineType?: number; shadowType?: number; shadowColor?: string; shadowOffsetX?: number; shadowOffsetY?: number;
  subscript?: boolean; superscript?: boolean; emboss?: boolean; engrave?: boolean; emphasisDot?: number; kerning?: boolean;
  fontFamily?: string; fontSize?: number; textColor?: string; shadeColor?: string;
  ratio?: number; characterSpacing?: number; relativeSize?: number; characterOffset?: number;
}
export interface ParagraphProperties {
  /** Resolved query values use CSS px at 96dpi except Percent lineSpacing, which is the raw percentage value. */
  alignment?: ParagraphAlignment; lineSpacing?: number; lineSpacingType?: string;
  marginLeft?: number; marginRight?: number; indent?: number; spacingBefore?: number; spacingAfter?: number;
  paraShapeId?: number; headType?: string; paraLevel?: number; numberingId?: number;
  widowOrphan?: boolean; keepWithNext?: boolean; keepLines?: boolean; pageBreakBefore?: boolean;
  tabStops?: Json[];
}
export type ParagraphLineSpacingType = 'Percent' | 'Fixed' | 'SpaceOnly' | 'Minimum' | 'BetweenLines';
/** Paragraph formatting inputs in the engine's raw units (see docs/API.md): margins and indent are doubled HWP units, spacing is HWP units, Percent line spacing is a percentage. */
export interface ParagraphFormatProperties { alignment?: ParagraphAlignment; marginLeft?: number; marginRight?: number; indent?: number; spacingBefore?: number; spacingAfter?: number; lineSpacing?: number; lineSpacingType?: ParagraphLineSpacingType }
/** A nonstructural formatting operation applied atomically to a whole selection. */
export interface RangeFormatProperties {
  character?: CharacterFormatProperties;
  paragraph?: ParagraphFormatProperties;
  styleId?: number;
  list?: ParagraphList;
}
export type ParagraphAlignment = 'left' | 'center' | 'right' | 'justify' | 'distribute' | 'split';
export interface CharacterRun { offset: number; length: number; text: string; properties: CharacterProperties; source: 'pageLayout' | 'addressedRead' }
export interface StyleReference { id: number; name: string }
export interface StyleDefinition extends StyleReference {
  englishName: string; type: number; nextStyleId: number; paraShapeId: number; charShapeId: number;
  detail: { charProps: CharacterProperties; paraProps: ParagraphProperties };
}
export interface NumberingDefinition { id: number; levelFormats: string[]; startNumber: number }
export interface BulletDefinition { id: number; char: string }
export interface NativeParagraphShape {
  LeftMargin?: number; RightMargin?: number; Indentation?: number; PrevSpacing?: number; NextSpacing?: number;
  LineSpacing?: number; LineSpacingType?: number; AlignType?: number; HeadingType?: number; Level?: number;
  WidowOrphan?: number; KeepWithNext?: number; KeepLinesTogether?: number; PagebreakBefore?: number;
}
export interface PageHideProperties {
  hideHeader?: boolean; hideFooter?: boolean; hideMasterPage?: boolean; hideBorder?: boolean; hideFill?: boolean; hidePageNumber?: boolean;
}
/** A "hide on this page" control anchored at a body paragraph. */
export interface PageHideEntry extends Required<PageHideProperties> { paragraph: number }
export interface SectionPageSettings {
  section: number; pageDef: Record<string, Json>; sectionDef: Record<string, Json>;
  columns: Record<string, Json>; pageBorderFill: Record<string, Json>; endnoteShape: Record<string, Json>;
  pageHides: PageHideEntry[];
}
/** Section multi-column settings. `spacing` is HWP units; `type` follows the Hancom column types. */
export interface ColumnSettingsProperties { count?: number; type?: 'normal' | 'distribute' | 'parallel'; sameWidth?: boolean; spacing?: number }
export interface PageBorderFillProperties {
  basis?: 'paper' | 'page'; spacingLeft?: number; spacingRight?: number; spacingTop?: number; spacingBottom?: number;
  headerInside?: boolean; footerInside?: boolean; fillArea?: 'paper' | 'page' | 'border';
  borderLeft?: BorderLineProperties; borderRight?: BorderLineProperties; borderTop?: BorderLineProperties; borderBottom?: BorderLineProperties;
  fillType?: 'none' | 'solid' | 'pattern'; fillColor?: string; patternColor?: string; patternType?: number;
}
/** Section definition. `pageNumType` is 0 continue, 1 odd, 2 even; `pageNum` > 0 starts the section at that number. */
export interface SectionDefinitionProperties {
  pageNum?: number; pageNumType?: number; pictureNum?: number; tableNum?: number; equationNum?: number;
  columnSpacing?: number; defaultTabSpacing?: number; hideHeader?: boolean; hideFooter?: boolean; hideMasterPage?: boolean;
  hideBorder?: boolean; hideFill?: boolean; hideEmptyLine?: boolean;
}
export interface EndnoteShapeProperties {
  numberFormat?: string; userChar?: string; prefixChar?: string; suffixChar?: string; startNumber?: number;
  separatorEnabled?: boolean; separatorLength?: number; separatorMarginTop?: number; separatorMarginBottom?: number;
  noteSpacing?: number; separatorLineType?: number; separatorLineWidth?: number; separatorColor?: string;
  numbering?: string; placement?: string;
}
export interface ParagraphFormatting {
  address: DocumentAddress; nodePath?: string; style?: StyleReference; properties?: ParagraphProperties;
  propertyCoverage: 'complete' | 'nativeOnly' | 'unavailable';
  nativeShape?: NativeParagraphShape; characterRuns: CharacterRun[]; characterCoverage: 'complete' | 'partial' | 'unsupported';
  missingRanges?: Array<{ start: number; end: number }>;
}
export interface ImageResourceReference { kind: 'image'; mimeType: string; availability: 'referenced' | 'missing' }
export type ObjectCaptionDirection = 'Top' | 'Bottom' | 'Left' | 'Right';
/** `rotationAngle` is the engine's stored value in degrees (0–3600); flips mirror the object. A picture's `hasCaption` adds or removes its caption (the caption text is not addressable through the API); shape captions are not supported. */
export interface PictureProperties { width?: number; height?: number; description?: string; treatAsChar?: boolean; textWrap?: 'Square' | 'TopAndBottom'; horzOffset?: number; vertOffset?: number; rotationAngle?: number; horzFlip?: boolean; vertFlip?: boolean; hasCaption?: boolean; captionDirection?: ObjectCaptionDirection }
export interface ShapeProperties { width?: number; height?: number; description?: string; treatAsChar?: boolean; textWrap?: 'Square' | 'TopAndBottom'; horzOffset?: number; vertOffset?: number; rotationAngle?: number; horzFlip?: boolean; vertFlip?: boolean }
export type ObjectZOrderOperation = 'front' | 'back' | 'forward' | 'backward' | 'inFrontOfText' | 'behindText';
export interface EquationProperties { width?: number; height?: number; script?: string; fontName?: string; fontSize?: number; color?: string; treatAsChar?: boolean }
export interface BorderLineProperties { type?: number; width?: number; color?: string }
export interface TableProperties {
  cellSpacing?: number; paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  pageBreak?: number; repeatHeader?: boolean;
  /** Table caption (the numbered "표 N" label). The caption text itself cannot be edited through the API. */
  hasCaption?: boolean; captionDirection?: 'Top' | 'Bottom' | 'Left' | 'Right';
}
/** How a formula result is written into its cell: raw, rounded to an integer, or fixed to one or two decimals. */
export type TableFormulaFormat = 'raw' | 'integer' | 'decimal1' | 'decimal2';
export interface CellProperties {
  paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  verticalAlign?: number; textDirection?: number; isHeader?: boolean; cellProtect?: boolean;
  borderLeft?: BorderLineProperties; borderRight?: BorderLineProperties; borderTop?: BorderLineProperties; borderBottom?: BorderLineProperties;
  fillType?: 'none' | 'solid' | 'pattern'; fillColor?: string; patternColor?: string; patternType?: number;
}
export interface TableCellProperties {
  width: number; height: number; paddingLeft?: number; paddingRight?: number; paddingTop?: number; paddingBottom?: number;
  verticalAlign?: number; textDirection?: number; isHeader?: boolean; cellProtect?: boolean; applyInnerMargin?: boolean;
  borderLeft?: BorderLineProperties; borderRight?: BorderLineProperties; borderTop?: BorderLineProperties; borderBottom?: BorderLineProperties;
  fillType?: string; fillColor?: string; patternColor?: string; patternType?: number;
}
export type EditableObjectKind = 'picture' | 'shape' | 'equation';
export interface EditableObjectTarget { address: BodyAddress; controlIndex: number; kind: EditableObjectKind }
export type ObjectProperties = PictureProperties | ShapeProperties | EquationProperties | Record<string, Json>;
export interface Paragraph extends Target {
  kind: 'body'; address: BodyAddress; nodePath: string; text: string; length: number; properties: ParagraphProperties;
}
/** Caller-provided output coordinates; not proof of an edit target. */
export interface RootOutputAnchor { blockIndex: number; section: number; paragraph: number }
export type OutputAnchorCandidate =
  | { blockIndex: number; state: 'candidate'; address: BodyAddress }
  | { blockIndex: number; state: 'unavailable'; reason: 'paragraph_missing' };
export interface OutputAnchorCandidateResult {
  archiveSha256: string; sessionId: string; revision: number; candidates: OutputAnchorCandidate[];
}
export interface Cell { index: number; row: number; col: number; rowSpan: number; colSpan: number; paragraphs: Paragraph[]; properties?: TableCellProperties }
export interface Table extends Target { kind: 'table'; address: BodyAddress; nodePath: string; control: number; rows: number; cols: number; cells: Cell[]; properties?: TableProperties }
/** Cells whose rendered area contains the centre of a visible overlaid object. */
export interface TableCoverage { sessionId: string; revision: number; coveredCellIndices: number[]; complete: boolean }
export interface HeaderFooterDynamicField { start: number; end: number; type: 'pageNumber' | 'totalPages' | 'fileName'; marker: string }
export interface StoryParagraph { address: HeaderFooterAddress | NoteAddress; nodePath: string; text: string; length: number; properties: ParagraphProperties; logicalText?: string; dynamicFields?: HeaderFooterDynamicField[] }
export interface HeaderFooterStory { kind: 'headerFooter'; section: number; isHeader: boolean; applyTo: number; label: string; paragraphs: StoryParagraph[] }
export interface NoteStory { kind: 'footnote' | 'endnote'; section: number; anchor: BodyAddress; controlIndex: number; number?: number; availability: 'available' | 'unsupportedNestedAnchor'; paragraphs: StoryParagraph[] }
export interface TextBoxStory { kind: 'textBox'; section: number; anchor: BodyAddress; controlIndex: number; paragraphs: Paragraph[] }
export type DocumentStory = HeaderFooterStory | NoteStory | TextBoxStory;
export interface Section { index: number; paragraphs: Paragraph[] }
export interface Control extends Record<string, Json | BodyAddress | undefined> {
  ctrlId: string; ctrlCh: number; userDesc: string; list: number; para: number; pos: number;
  controlIndex: number; props: Record<string, Json>; address: BodyAddress; nodePath: string; objectKind?: string;
}
export interface DocumentObject extends Record<string, Json | BodyAddress | ObjectProperties | ImageResourceReference | undefined> {
  kind: string; para: number; controlIndex: number; address: BodyAddress; anchor?: BodyAddress; nodePath: string;
  properties?: ObjectProperties; resource?: ImageResourceReference;
}
/** A document bookmark. `offset` uses the same code point offsets as text commands; names are unique in a document. */
export interface Bookmark { name: string; address: BodyAddress; nodePath: string; controlIndex: number; offset: number }
export interface DocumentTree {
  sections: Section[]; paragraphs: Paragraph[]; tables: Table[]; fields: Field[];
  controls: Control[]; objects: DocumentObject[]; stories: DocumentStory[]; bookmarks: Bookmark[];
}
export interface StructurePageOptions { collection: 'paragraphs' | 'tables' | 'fields' | 'controls' | 'objects' | 'stories' | 'bookmarks'; offset?: number; limit?: number; includeCells?: boolean; includeStories?: boolean }
export type StructurePage =
  | { state: State; collection: 'paragraphs'; offset: number; limit: number; total: number; items: Array<Paragraph | StoryParagraph> }
  | { state: State; collection: 'tables'; offset: number; limit: number; total: number; items: Table[] }
  | { state: State; collection: 'fields'; offset: number; limit: number; total: number; items: Field[] }
  | { state: State; collection: 'controls'; offset: number; limit: number; total: number; items: Control[] }
  | { state: State; collection: 'objects'; offset: number; limit: number; total: number; items: DocumentObject[] }
  | { state: State; collection: 'stories'; offset: number; limit: number; total: number; items: DocumentStory[] }
  | { state: State; collection: 'bookmarks'; offset: number; limit: number; total: number; items: Bookmark[] };
export interface PageInfo {
  pageIndex: number; pageNumber: number; width: number; height: number; sectionIndex: number;
  marginLeft: number; marginRight: number; marginTop: number; marginBottom: number;
  marginHeader: number; marginFooter: number; bodyLeft: number; bodyRight: number;
  marginGutter: number; bindingMirrored: boolean; columns: Array<{ x: number; width: number }>;
  headerArea?: { x: number; y: number; width: number; height: number };
  footerArea?: { x: number; y: number; width: number; height: number };
}
export interface LayoutTextRun {
  text: string; x: number; y: number; w: number; h: number; width: number; height: number; charX: number[];
  fontFamily: string; fontSize: number; bold: boolean; italic: boolean; underline: boolean;
  strikethrough: boolean; textColor: string; charShapeId?: number; paraShapeId?: number; ratio?: number; letterSpacing?: number;
  secIdx?: number; paraIdx?: number; charStart?: number; parentParaIdx?: number; controlIdx?: number; cellIdx?: number;
  cellParaIdx?: number; cellPath?: CellStep[];
  address?: BodyAddress; documentAddress?: DocumentAddress; offset?: number;
}
export interface LayoutCell { x: number; y: number; width: number; height: number; row: number; col: number; rowSpan: number; colSpan: number; cellIndex: number }
export interface LayoutControl {
  type: string; x: number; y: number; width: number; height: number; section: number; paragraph: number;
  controlIndex: number; plane: number; zOrder: number; stableIndex: number[]; wrap?: string; cells?: LayoutCell[];
}
export interface PageLayout { page: number; info: PageInfo; runs: LayoutTextRun[]; textRuns: LayoutTextRun[]; controls: LayoutControl[] }
export interface FormattingModel {
  pageSelection: number[]; styles: StyleDefinition[]; numbering: NumberingDefinition[]; bullets: BulletDefinition[];
  sections: SectionPageSettings[]; paragraphs: ParagraphFormatting[]; objects: DocumentObject[];
}
export interface DocumentSnapshot {
  state: State; content: { text: string; codePoints: number }; structure: DocumentTree;
  formatting: FormattingModel; layout: { pageCount: number; pages: PageLayout[] };
}
export interface QueryContext { sessionId: string; expectedRevision: number }
export type NodeSelector =
  | { kind: 'paragraph'; nodePath: string }
  | { kind: 'table'; nodePath: string }
  | { kind: 'field'; fieldId: number }
  | { kind: 'control'; address: BodyAddress; controlIndex: number }
  | { kind: 'object'; nodePath: string };
export type NodeSelection =
  | { kind: 'paragraph'; nodePath: string; address: DocumentAddress; text: string; length: number }
  | { kind: 'table'; nodePath: string; address: BodyAddress; controlIndex: number; rows: number; cols: number }
  | { kind: 'field'; nodePath: string; fieldId: number; name: string; value: string; address?: BodyAddress }
  | { kind: 'control'; nodePath: string; address: BodyAddress; controlIndex: number; ctrlId: string }
  | { kind: 'object'; nodePath: string; address: BodyAddress; controlIndex: number; objectKind: string };
export interface TextSelectionTarget { address: DocumentAddress; offset: number; length: number }
export interface TextSelection extends TextSelectionTarget { text: string }
export interface TextPosition { address: DocumentAddress; offset: number }
export interface CaretRect { pageIndex: number; x: number; y: number; height: number }
export interface CaretContext {
  section: number;
  paragraph: Paragraph | StoryParagraph;
  paragraphProperties: ParagraphProperties;
  style?: StyleReference;
  characterProperties?: CharacterProperties;
  field?: Field;
  cell?: { tableNodePath: string; controlIndex: number; cellIndex: number; row: number; col: number };
}
export interface CaretQueryOptions { pageHint?: number }
export interface CaretQueryResult { position: TextPosition; rect: CaretRect; context: CaretContext }
export interface PagePoint { page: number; x: number; y: number }
export interface HitTestResult {
  kind: 'paragraph' | 'field' | 'tableCell' | 'object';
  address?: DocumentAddress;
  offset?: number;
  field?: Field;
  object?: DocumentObject;
  cell?: { tableNodePath: string; controlIndex: number; cellIndex: number; row: number; col: number };
}
export interface SelectionRange { start: TextPosition; end: TextPosition }
export interface SelectionRect { pageIndex: number; x: number; y: number; width: number; height: number }
export interface CopiedSelection { text: string; html: string }
export type CaretMotion = 'left' | 'right' | 'wordLeft' | 'wordRight' | 'up' | 'down' | 'pageUp' | 'pageDown' | 'lineStart' | 'lineEnd'
  | 'paragraphStart' | 'paragraphEnd' | 'documentStart' | 'documentEnd' | 'previous' | 'next' | 'cellPrevious' | 'cellNext';
export interface MoveCaretOptions extends QueryContext { preferredX?: number; pageHint?: number }
export interface MoveCaretResult extends CaretQueryResult { preferredX?: number }
export type ParagraphList = { kind: 'none' } | { kind: 'numbering'; numberingId?: number; level?: number } | { kind: 'bullet'; char?: string; level?: number };
export type CapabilityLevel = 'full' | 'partial' | 'unsupported';
export interface SaveFormatCapability { available: boolean; reason?: string; errorCode?: ErrorCode }
export interface DocumentCapabilities {
  sessionId: string; revision: number; format: Format; readOnly: boolean; readOnlyReasons: string[];
  queries: { text: CapabilityLevel; structure: CapabilityLevel; formatting: CapabilityLevel; layout: CapabilityLevel; pictureResource: CapabilityLevel };
  edits: { text: CapabilityLevel; fieldsById: CapabilityLevel; fieldsByName: CapabilityLevel; characterFormatting: CapabilityLevel; paragraphFormatting: CapabilityLevel; tables: CapabilityLevel; objects: CapabilityLevel; pageSettings: CapabilityLevel };
  saveFormats: Record<Format, SaveFormatCapability>; ambiguousFieldNames: string[]; ambiguousFieldIds: number[];
  limitations: string[]; saveWarnings: string[];
}
export interface SnapshotOptions { pages?: number[] }
/**
 * `runs: 'model'` reads the character runs of every body and table-cell paragraph from the document model, so they are complete for all
 * pages and no page layout is built; `pages` then only fills `pageSelection`. The default `'layout'` reads runs from the selected pages.
 * `includeNativeShape: false` skips native paragraph shapes; paragraphs without other properties report unavailable coverage.
 */
export interface FormattingOptions extends SnapshotOptions { runs?: 'layout' | 'model'; includeNativeShape?: boolean }
export interface ObjectResourceTarget { kind: 'picture'; address: BodyAddress; controlIndex: number }
export interface ObjectResource { kind: 'image'; mimeType: string; bytes: Uint8Array; address: BodyAddress; controlIndex: number }
export interface Field extends Record<string, Json | BodyAddress | undefined> {
  fieldId: number; name: string; value: string; address?: BodyAddress; nodePath?: string; sessionId?: string; revision?: number;
}
export interface State {
  path: string; format: Format; sessionId: string; revision: number; dirty: boolean; conflict: boolean;
  pageCount: number; canUndo: boolean; canRedo: boolean;
}
export interface VerificationPageSummary {
  page: number; width: number; height: number; textRunCount: number; controlCount: number;
}
export interface VerificationPage {
  page: number; before?: VerificationPageSummary; after?: VerificationPageSummary;
  svgEqual?: boolean; layoutEqual?: boolean; diagnostics: string[];
  svgBeforeHash?: string; svgAfterHash?: string; layoutBeforeHash?: string; layoutAfterHash?: string;
}
export interface VerificationReport extends State {
  targetFormat: Format; passed: boolean; compared: string[]; differences: string[];
  unsupportedCoverage: string[]; error?: { code: ErrorCode; message: string };
  pages: { beforeCount: number; afterCount?: number; delta?: number; rendered: VerificationPage[] };
  warnings: string[];
}
export interface VerificationOptions { expectedRevision: number; format?: Format; pages?: number[] }
/** `showOverflow` is Hancom's "잘림 보기": content that spills outside its cell, frame or page is drawn instead of clipped. */
export interface PageRenderOptions { showParagraphMarks?: boolean; showControlCodes?: boolean; showTransparentBorders?: boolean; showOverflow?: boolean }
export interface IndexStatus {
  path: string; indexPath: string; state: 'missing' | 'current' | 'stale' | 'modified' | 'legacy' | 'unmanaged';
  sourceSha256: string; indexSourceSha256?: string;
}
export interface SearchMatch extends Target { kind: 'body'; address: BodyAddress; nodePath: string; offset: number; length: number; text: string }
export interface StorySearchMatch { address: HeaderFooterAddress | NoteAddress; nodePath: string; offset: number; length: number; text: string }
export type DocumentSearchMatch = SearchMatch | StorySearchMatch;
export type Command =
  | { type: 'insertText'; target: TextTarget; offset: number; text: string; characterProperties?: CharacterFormatProperties }
  | { type: 'insertLineBreak'; target: TextTarget; offset: number }
  | { type: 'insertTab'; target: TextTarget; offset: number }
  | { type: 'pasteHtml'; target: TextTarget; offset: number; html: string }
  | { type: 'deleteText'; target: TextTarget; offset: number; count: number }
  | { type: 'replaceParagraph'; target: TextTarget; text: string; expectedText?: string; preserveFormatting?: boolean; normalizeFormAnswer?: boolean; rewriteFormatting?: boolean; rewriteVersion?: 'myers-codepoint-v1' }
  | { type: 'replaceRange'; start: TextPosition; end: TextPosition; text: string }
  | { type: 'deleteRange'; start: TextPosition; end: TextPosition; deleteAnchoredContent?: boolean }
  | { type: 'splitParagraph'; target: TextTarget; offset: number; verifyRewriteFormatting?: boolean }
  | { type: 'mergeParagraph'; target: TextTarget }
  | { type: 'deleteParagraphAt'; target: TextTarget }
  | { type: 'replaceText'; query: string; replacement: string; caseSensitive?: boolean }
  | { type: 'insertParagraph'; section: number; index: number; text: string; like?: 'previous' | 'next' }
  | { type: 'insertCellParagraph'; target: Target; position: 'before' | 'after'; text: string; expectedText: string }
  | { type: 'deleteParagraph'; section: number; index: number }
  | { type: 'setCellText'; table: Target & { control: number }; row: number; col: number; text: string; cellParagraph?: number }
  | { type: 'setField'; name: string; value: string; normalizeFormAnswer?: boolean }
  | { type: 'setFieldById'; fieldId: number; sessionId: string; revision: number; value: string }
  | { type: 'setFields'; sessionId: string; revision: number; values: Array<{ fieldId: number; value: string }>; normalizeFormAnswer?: boolean }
  | { type: 'setFieldsAt'; sessionId: string; revision: number; values: Array<{ index: number; fieldId: number; name: string; expectedValue: string; value: string }>; normalizeFormAnswer?: boolean }
  | { type: 'insertClickHereField'; target: Target; offset: number; guide: string; memo: string; name: string; editable: boolean }
  | { type: 'updateField'; fieldId: number; sessionId: string; revision: number; name?: string; guide?: string; memo?: string; editable?: boolean }
  | { type: 'removeField'; fieldId: number; sessionId: string; revision: number; keepText?: boolean }
  | { type: 'formatText'; target: TextTarget; start: number; end: number; properties: CharacterFormatProperties }
  | { type: 'formatParagraph'; target: TextTarget; properties: ParagraphFormatProperties }
  | ({ type: 'formatRange'; range: SelectionRange } & RangeFormatProperties)
  | ({ type: 'formatCellBlock'; table: Target & { control: number }; startRow: number; startCol: number; endRow: number; endCol: number } & RangeFormatProperties)
  | { type: 'createStyle'; name: string; englishName?: string; kind?: 'paragraph' | 'character'; nextStyleId?: number; characterProperties?: CharacterFormatProperties; paragraphProperties?: ParagraphFormatProperties }
  | { type: 'updateStyle'; styleId: number; name?: string; englishName?: string; nextStyleId?: number; characterProperties?: CharacterFormatProperties; paragraphProperties?: ParagraphFormatProperties }
  | { type: 'deleteStyle'; styleId: number }
  | { type: 'createNumbering'; levelFormats: string[]; numberFormats: number[]; startNumber?: number }
  | { type: 'setParagraphStyle'; target: Target; styleId: number }
  | { type: 'setParagraphList'; target: Target; list: ParagraphList }
  | { type: 'createTable'; target: Target; offset: number; rows: number; cols: number }
  | { type: 'insertTableRow'; table: Target & { control: number }; row: number; below?: boolean }
  | { type: 'deleteTableRow'; table: Target & { control: number }; row: number }
  | { type: 'insertTableColumn'; table: Target & { control: number }; col: number; right?: boolean }
  | { type: 'deleteTableColumn'; table: Target & { control: number }; col: number }
  | { type: 'mergeTableCells'; table: Target & { control: number }; startRow: number; startCol: number; endRow: number; endCol: number }
  | { type: 'splitTableCell'; table: Target & { control: number }; row: number; col: number; rows?: number; cols?: number; equalRowHeight?: boolean }
  | { type: 'resizeTableCells'; table: Target & { control: number }; cells: Array<{ row: number; col: number; widthDelta?: number; heightDelta?: number }> }
  | { type: 'setTableProperties'; table: Target & { control: number }; properties: TableProperties }
  | { type: 'setCellProperties'; table: Target & { control: number }; row: number; col: number; properties: CellProperties }
  | { type: 'transposeTable'; table: Target & { control: number } }
  | { type: 'splitTable'; table: Target & { control: number }; atRow: number }
  | { type: 'mergeTableWithNext'; table: Target & { control: number } }
  | { type: 'deleteTable'; table: Target & { control: number } }
  | { type: 'setTableFormula'; table: Target & { control: number }; row: number; col: number; formula: string; format?: TableFormulaFormat; thousandsSeparator?: boolean }
  | { type: 'deleteNote'; target: NoteAddress }
  | { type: 'insertNote'; kind: 'footnote' | 'endnote'; target: Target; offset: number }
  | { type: 'setEndnoteShape'; section: number; properties: EndnoteShapeProperties }
  | { type: 'applyHeaderFooterTemplate'; section: number; isHeader: boolean; applyTo: 0 | 1 | 2; templateId: number }
  | { type: 'deleteHeaderFooter'; section: number; isHeader: boolean; applyTo: 0 | 1 | 2 }
  | { type: 'insertPageBreak'; target: Target; offset: number; kind?: 'page' | 'column' }
  | { type: 'setPageSettings'; section: number; properties: PageSettingsProperties }
  | { type: 'setPageHide'; target: Target; properties: PageHideProperties }
  | { type: 'insertNewNumber'; target: Target; offset: number; number: number }
  | { type: 'addBookmark'; target: Target; offset: number; name: string }
  | { type: 'renameBookmark'; name: string; newName: string }
  | { type: 'deleteBookmark'; name: string }
  | { type: 'setColumnSettings'; section: number; properties: ColumnSettingsProperties }
  | { type: 'setPageBorderFill'; section: number; properties: PageBorderFillProperties }
  | { type: 'setSectionDefinition'; section: number; properties: SectionDefinitionProperties }
  | { type: 'insertEquation'; target: Target; offset: number; script: string; fontSize?: number; color?: string }
  | { type: 'insertPicture'; target: Target; offset: number; imageBase64: string; extension: 'png' | 'jpg' | 'jpeg' | 'gif' | 'bmp'; width: number; height: number; naturalWidthPx: number; naturalHeightPx: number; description?: string }
  | { type: 'insertShape'; target: Target; offset: number; shape: 'rectangle' | 'textBox'; width: number; height: number; horzOffset?: number; vertOffset?: number; treatAsChar?: boolean; textWrap?: 'Square' | 'TopAndBottom'; description?: string; text?: string }
  | { type: 'setObjectProperties'; object: EditableObjectTarget; properties: PictureProperties | ShapeProperties | EquationProperties }
  | { type: 'setObjectZOrder'; object: EditableObjectTarget; operation: ObjectZOrderOperation }
  | { type: 'groupObjects'; objects: EditableObjectTarget[] }
  | { type: 'ungroupObject'; object: EditableObjectTarget }
  | { type: 'deleteObject'; object: EditableObjectTarget };
export interface PageSettingsProperties {
  width?: number; height?: number; marginLeft?: number; marginRight?: number; marginTop?: number;
  marginBottom?: number; marginHeader?: number; marginFooter?: number; marginGutter?: number;
  landscape?: boolean; binding?: number;
}
export interface Receipt extends State {
  changedPages: number[]; pageCountBefore: number; pageCountAfter: number; pageCountDelta: number;
  results: Record<string, Json>[];
}
export type EventType = 'opened' | 'changed' | 'saved' | 'reloaded' | 'conflict' | 'closed' | 'renamed';
export interface DocumentEvent { type: EventType; state: State; oldPath?: string; changedPages?: number[]; origin?: 'input' | 'command' | 'api' | 'history'; groupId?: string }
export interface TransactionOptions { expectedRevision: number; dryRun?: boolean; origin?: 'input' | 'command' | 'api'; groupId?: string }
export interface SaveResult extends State { backupPath?: string; indexPath?: string; warnings: string[] }
export interface NewFileResult extends State { warnings?: string[] }
export interface DocumentLease { readonly state: State; release(): Promise<void> }
export interface ActiveViewContext {
  path: string; sessionId: string; revision: number; page: number;
  selection?: { range: SelectionRange; text: string };
  caret?: TextPosition;
  humanInput: { active: boolean; composing: boolean; draftPending: boolean };
}
export interface EditorViews {
  /** Last focused live editor, including pop-outs. Undefined if closed or changed during capture. */
  activeContext(): Promise<ActiveViewContext | undefined>;
  list(): Array<{ path: string; sessionId: string; revision: number }>;
  onContextChanged(listener: () => void): () => void;
  /** Human-requested navigation in an existing view; never grants edit authority. */
  revealOutputAnchor?(input: { path: string; archiveSha256: string; anchor: RootOutputAnchor; sessionId: string; revision: number }, signal?: AbortSignal): Promise<{ revealed: true; located: true }>;
}
export interface HwpHandsApiV1 {
  readonly version: 1;
  readonly engineVersion: string;
  /** Present in the Obsidian plugin; absent in a headless DocumentManager. */
  views?: EditorViews;
  documents: {
    open(path: string): Promise<State>;
    acquire(path: string): Promise<DocumentLease>;
    close(path: string): Promise<void>;
    list(): State[];
    state(path: string): Promise<State>;
    create(path: string): Promise<NewFileResult>;
    reload(path: string, options?: { discardChanges?: boolean }): Promise<State>;
    save(path: string, options: { expectedRevision: number }): Promise<SaveResult>;
    saveAs(path: string, destination: string, options: { expectedRevision: number }): Promise<NewFileResult>;
  };
  query: {
    /** Optional on older v1 implementations. Returns candidates only; no edit observation is issued. */
    outputAnchorCandidates?(path: string, archiveSha256: string, anchors: readonly RootOutputAnchor[]): Promise<OutputAnchorCandidateResult>;
    /** Like outputAnchorCandidates, but never creates a document session. */
    outputAnchorCandidatesIfOpen?(path: string, archiveSha256: string, anchors: readonly RootOutputAnchor[]): Promise<OutputAnchorCandidateResult>;
    text(path: string): Promise<string>;
    paragraphs(path: string, options?: { includeCells?: boolean; includeStories?: false }): Promise<Paragraph[]>;
    paragraphs(path: string, options: { includeCells?: boolean; includeStories: true }): Promise<Array<Paragraph | StoryParagraph>>;
    tables(path: string): Promise<Table[]>;
    tableCoverage(path: string, table: Target & { control: number }, context: QueryContext): Promise<TableCoverage>;
    fields(path: string): Promise<Field[]>;
    controls(path: string): Promise<Control[]>;
    objects(path: string): Promise<DocumentObject[]>;
    capabilities(path: string): Promise<DocumentCapabilities>;
    formatting(path: string, options?: FormattingOptions): Promise<FormattingModel>;
    outline(path: string): Promise<Json>;
    metadata(path: string): Promise<Record<string, Json>>;
    tree(path: string): Promise<{ state: State } & DocumentTree>;
    structure(path: string, options: StructurePageOptions): Promise<StructurePage>;
    snapshot(path: string, options?: SnapshotOptions): Promise<DocumentSnapshot>;
    search(path: string, query: string, options?: { caseSensitive?: boolean; includeStories?: false }): Promise<SearchMatch[]>;
    search(path: string, query: string, options: { caseSensitive?: boolean; includeStories: true }): Promise<DocumentSearchMatch[]>;
    layout(path: string, page: number): Promise<PageLayout>;
    verify(path: string, options: VerificationOptions): Promise<VerificationReport>;
    objectResource(path: string, target: ObjectResourceTarget, options: { expectedRevision: number }): Promise<ObjectResource>;
    selectNode(path: string, selector: NodeSelector, context: QueryContext): Promise<NodeSelection>;
    selectText(path: string, target: TextSelectionTarget, context: QueryContext): Promise<TextSelection>;
    hitTest(path: string, point: PagePoint, context: QueryContext): Promise<HitTestResult | undefined>;
    caret(path: string, position: TextPosition, context: QueryContext, options?: CaretQueryOptions): Promise<CaretQueryResult>;
    selectionRects(path: string, range: SelectionRange, context: QueryContext): Promise<SelectionRect[]>;
    copy(path: string, range: SelectionRange, context: QueryContext): Promise<CopiedSelection>;
    moveCaret(path: string, position: TextPosition, motion: CaretMotion, options: MoveCaretOptions): Promise<MoveCaretResult>;
    equationPreview(path: string, script: string, context: QueryContext, options?: { fontSize?: number; color?: string }): Promise<string>;
    navigateHeaderFooterPage(path: string, currentPage: number, isHeader: boolean, direction: -1 | 1, context: QueryContext): Promise<HeaderFooterPageNavigationResult>;
  };
  edit: {
    transaction(path: string, commands: Command[], options: TransactionOptions): Promise<Receipt>;
    undo(path: string, options: { expectedRevision: number }): Promise<State>;
    redo(path: string, options: { expectedRevision: number }): Promise<State>;
  };
  render: { page(path: string, page: number, options?: PageRenderOptions): Promise<{ revision: number; svg: string; width: number; height: number; layout?: PageLayout }> };
  index: { refresh(path: string): Promise<string>; status(path: string): Promise<IndexStatus> };
  events: { on(type: EventType | '*', listener: (event: DocumentEvent) => void): () => void };
}
export type ErrorCode = 'INVALID_PATH' | 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'REVISION_CONFLICT' | 'FILE_CONFLICT' | 'UNSAVED_CHANGES' | 'CONTENT_LOSS' | 'VERIFY_FAILED' | 'ENGINE_ERROR' | 'CANCELLED' | 'CLOSED';
export class HwpHandsError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) { super(message); this.name = 'HwpHandsError'; }
}

/** @deprecated Use HwpHandsApiV1. Kept for existing API v1 consumers. */
export type HwpEditorApiV1 = HwpHandsApiV1;
/** @deprecated Use HwpHandsError. */
export { HwpHandsError as HwpEditorError };

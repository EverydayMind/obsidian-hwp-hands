import type { Paragraph, StoryParagraph } from './api';
import type { RhwpEngine } from './engine';

type AsyncEngineMethods = {
  [K in keyof RhwpEngine]: RhwpEngine[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Awaited<Result> | Promise<Awaited<Result>>
    : never
};
export type EnginePort = Omit<AsyncEngineMethods, 'paragraphs'> & {
  paragraphs(): Paragraph[] | Promise<Paragraph[]>;
  paragraphs(includeCells: boolean): Paragraph[] | Promise<Paragraph[]>;
  paragraphs(includeCells: boolean, includeStories: true): Array<Paragraph | StoryParagraph> | Promise<Array<Paragraph | StoryParagraph>>;
};

export interface EngineProvider {
  initialize(): Promise<void>;
  parse(bytes: Uint8Array): Promise<EnginePort>;
  blank(): Promise<EnginePort>;
  dispose(): Promise<void>;
}

export const ENGINE_RPC_METHODS = [
  'free', 'snapshot', 'restore', 'discard', 'pages', 'canvasPage', 'pageOfPosition', 'pageTextSignature', 'paragraphPatch', 'metadata', 'fields', 'objects', 'controls', 'outline', 'allText',
  'paragraph', 'paragraphs', 'paragraphRange', 'tables', 'tableCoverage', 'tree', 'search', 'searchDocument', 'formatting', 'documentSnapshot', 'renderEquationPreview',
  'preservationSnapshot', 'objectResource', 'selectNode', 'selectText', 'hitTest', 'caret', 'measureTabs', 'selectionRects', 'copy', 'moveCaret', 'navigateHeaderFooterPage', 'page', 'layout', 'export', 'exportWithReport', 'execute',
] as const satisfies readonly (keyof EnginePort)[];

export type EngineRpcMethod = typeof ENGINE_RPC_METHODS[number];

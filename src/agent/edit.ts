import { LT, L } from '../i18n/locale';
import { validateToolInput } from './tool-catalog';
import { domainErrorDetails, inputAt } from './error-details';
import { isInputField } from './field-kinds';
export { EDIT_TOOL_NAMES } from './tool-catalog';
import type { BodyAddress, CharacterFormatProperties, Command, HwpHandsApiV1, Json, NoteAddress, NoteStory, PageSettingsProperties, Paragraph, ParagraphFormatProperties, Receipt, SectionDefinitionProperties, State, Table, TransactionOptions } from '../api';
import { noteHandle, noteParagraphKey } from './notes';
import { runKey, runText, styleKey, styleText } from './styles';
import { sectionKey, sectionView } from './sections';
import { HwpHandsError } from '../api';
import { ToolError, actorIdOf, type Caller, type DocumentRef } from './editor';
import { SelectionGuard, containerOf, orderOf, type AllowedRange } from './selection';
import { shiftedParagraph, type EditMark, type EditMarks } from './marks';
import { REWRITE_ALIGNMENT_VERSION, type RewriteSplitHint } from './rewrite-align';
import { REWRITE_DIFF_VERSION } from './rewrite-diff';
import { computeRewrite, type RewriteComputeRequest, type RewriteComputeResult } from './rewrite-compute';

/**
 * Session-effect tools of the agent facade: edits of the shared working copy, never of the file.
 * One call is one transaction and one undo step. An edit needs proof that the model was shown the current text
 * of every paragraph it changes (an observation token the host confirms was in the model's last request).
 * Protection the engine applies to paragraphs with fields, controls or objects is never worked around here.
 */
type JsonObject = { [key: string]: Json };
export interface ToolResult { content: Array<{ type: 'text'; text: string }>; structuredContent?: JsonObject; isError?: boolean; _meta?: JsonObject }
export interface EditBridge {
  /** DocumentManager.transactionFromAi: records the AI actor so unapproved AI changes are never autosaved. */
  transaction(path: string, commands: Command[], options: TransactionOptions, actorId: string, signal?: AbortSignal): Promise<Receipt>;
  /** DocumentManager.undoFromAi: the human-input check runs inside the document queue. */
  undo(path: string, options: { expectedRevision: number }, signal?: AbortSignal): Promise<State>;
  /** Edits since the last approved save that no person made, from the manager's actor ledger. */
  pendingEdits(sessionId: string): { ai: number; unknown: number };
  /** DocumentManager.observeApplied: every applied transaction with its commands, for keeping handles across a person's edits. */
  onApplied?(listener: (edit: { path: string; sessionId: string; revisionBefore: number; revisionAfter: number; commands: Command[]; actor: 'human' | 'ai' | 'unknown' }) => void): () => void;
  /** DocumentManager.discardFromAi: drops a working copy whose every change is this actor's own. */
  discard?(path: string, options: { expectedRevision: number; sessionId: string }, actorId: string, signal?: AbortSignal): Promise<State>;
}
export interface ResolvedTarget { kind: 'existing'; document: DocumentRef; revision: number }
export interface EditContext { caller?: Caller; signal?: AbortSignal; target?: ResolvedTarget; observations?: string[];
  /** Internal, set from the validated tool input, never a host authorization token. */
  preview?: boolean;
  /** Internal only: a human may approve one otherwise rejected text replacement. */
  formatException?: boolean;
  formatExceptionApplied?: boolean;
  /** The range the person had selected when submitting the turn; 'stale' when that scope no longer exists. Set by the provider, never by the host. */
  selection?: AllowedRange | 'stale' }
export interface EditEpoch { path: string; sessionId: string; revision: number; id: string }
export interface EditEnvironment {
  api: HwpHandsApiV1;
  bridge: EditBridge;
  approveFormatException?: (request: { path: string; before: string; after: string }, signal?: AbortSignal) => Promise<boolean>;
  rewriteCompute?: (request: RewriteComputeRequest, signal?: AbortSignal) => Promise<RewriteComputeResult>;
  token(prefix: string): string;
  open(path: unknown, caller?: Caller): Promise<{ state: State; epoch: EditEpoch }>;
  ref(state: State): DocumentRef;
  /** Handles of all body and cell paragraphs of the epoch, in document order. */
  handles(epoch: EditEpoch, paragraphs: Paragraph[]): Promise<string[]>;
  /** All tables of the epoch in handle order (`t<n>` is index n-1). */
  tables(epoch: EditEpoch): Promise<Table[]>;
  /** The provider's own structure-preserving edit moved the document from one revision to the next. */
  advance(epoch: EditEpoch, revision: number): void;
  expire(path: string): void;
  /** Where edits landed, for the review marks a person sees on the page. */
  marks?: EditMarks;
}

const MAX_OBSERVATIONS = 256, MAX_COMMANDS = 500, MAX_CANDIDATES = 5, SNIPPET_RADIUS = 40, MAX_OPERATIONS = 20, MAX_INSERTED = 50, MAX_FIELDS = 100, MAX_CELLS = 100, MAX_NAMES = 30, MAX_LOG = 50, MAX_TABLE_ROWS = 50, MAX_TABLE_COLS = 20, MAX_NEW_ROWS = 20;
export const addressKey = (address: BodyAddress): string => JSON.stringify([address.section, address.paragraph, address.cellPath ?? []]);
const conversationOf = (caller: Caller): string => JSON.stringify([caller.pluginId, caller.conversationId]);
export const PREVIEW_CHARS = 200;
const observedRetrySuggestion = () => L({ ko: '아직 적용되지 않았다. 같은 인자로 같은 도구를 다시 호출하면 적용된다. 그 사이 다른 편집을 했다면 다시 읽고 새 핸들로 호출하라.', en: "Not applied yet. Call the same tool again with the same arguments to apply. If any other edit occurred meanwhile, reread and use fresh handles." });
export const clip = (value: string): string => { const points = Array.from(value); return points.length > PREVIEW_CHARS ? `${points.slice(0, PREVIEW_CHARS).join('')}…` : value; };
/** Where a supplied expectedText departs from a paragraph the model has fully read. A soft line break at the end of a
 * paragraph reads as an empty line and edge spaces are hard to count, so the exact current text is returned as JSON
 * (`\n` visible). whitespaceOnly is a fact about the two strings, not a judgement that the target is right. */
function expectedTextMismatch(target: string, expected: string, current: string): { message: string; details: JsonObject } {
  const a = Array.from(expected), b = Array.from(current);
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  const squeeze = (value: string): string => value.replace(/\s+/gu, ' ').trim(), whitespaceOnly = squeeze(expected) === squeeze(current);
  const around = (points: string[]): string => points.slice(Math.max(0, at - SNIPPET_RADIUS / 2), at + SNIPPET_RADIUS / 2).join('');
  const whole = b.length <= PREVIEW_CHARS * 10;
  return {
    message: whitespaceOnly
      ? LT({ ko: () => `${target}의 원문과 expectedText는 공백·줄바꿈만 다르다(${at + 1}번째 글자부터). ${whole ? 'currentText가 지금 원문 전체다. JSON의 \\n은 문단 안 줄바꿈이다.' : 'currentAround를 확인하라.'}`, en: () => `${target} original text and expectedText differ only in whitespace/line breaks (from character ${at + 1}). ${whole ? 'currentText is the entire current original. JSON \\\\n denotes an in-paragraph line break.' : 'Check currentAround.'}` })
      : LT({ ko: () => `${target}의 현재 원문이 expectedText와 다르다(${at + 1}번째 글자부터). 대상 문단과 변경안이 맞는지 ${whole ? 'currentText' : 'currentAround'}로 다시 대조하라.`, en: () => `${target} current original differs from expectedText (from character ${at + 1}). Compare the target paragraph and proposed change again using ${whole ? 'currentText' : 'currentAround'}.` }),
    details: { firstDifference: at, whitespaceOnly, expectedAround: around(a), currentAround: around(b), ...(whole ? { currentText: current } : {}),
      suggestion: whitespaceOnly ? L({ ko: '대상이 맞는지 확인하고 currentText를 기준으로 expectedText와 변경안을 다시 만든다. 다시 읽어도 화면 표시는 같다.', en: "Check the target and rebuild expectedText and the proposed change from currentText. Rereading shows the same onscreen content." }) : L({ ko: '대상 핸들이 맞는지 확인한다. 다른 문단이면 맞는 핸들로, 같은 문단이면 currentText를 기준으로 변경안을 다시 만든다.', en: "Check the target handle. For a different paragraph, use the correct handle; for the same paragraph, rebuild the change from currentText." }) },
  };
}
/** Small stable id (FNV-1a, two seeds). Identifies "the same requested operation" for the host's failure ledger; not a security value. */
export function operationId(parts: unknown[]): string {
  const text = JSON.stringify(parts);
  return [0x811c9dc5, 0x01000193].map(seed => {
    let hash = seed;
    for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return hash.toString(16).padStart(8, '0');
  }).join('');
}

/** `key` names something that is not a paragraph (a field value); otherwise the paragraph address is the key. */
export interface Shown { handle: string; address?: BodyAddress; key?: string; text: string; /** False when the model saw only a snippet of the paragraph. Default true. */ full?: boolean }
const shownKey = (item: Shown): string => item.key ?? addressKey(item.address!);
export const fieldKey = (name: string): string => `field:${name}`;
/** A field addressed by its place in the document's field list (a `d…:f3` handle), for names that several fields share. */
export const fieldPlaceKey = (place: number): string => `field#${place}`;
export const checkboxBulletKey = (address: BodyAddress): string => `checkbox-bullet:${addressKey(address)}`;
interface Observation { conversation: string; path: string; sessionId: string; revision: number; texts: Map<string, { text: string; full: boolean }> }
/** What each conversation was shown, per paragraph address, at one document revision. Memory only. */
export class Observations {
  private readonly items = new Map<string, Observation>();
  constructor(private token: (prefix: string) => string) {}
  /** Returns the `_meta` fragment for a result that showed these paragraphs in full or as a match snippet. */
  record(caller: Caller | undefined, epoch: EditEpoch, shown: Shown[]): JsonObject {
    if (!caller || !shown.length) return {};
    const token = this.token('obs');
    this.items.set(token, { conversation: conversationOf(caller), path: epoch.path, sessionId: epoch.sessionId, revision: epoch.revision,
      texts: new Map(shown.map(item => [shownKey(item), { text: item.text, full: item.full !== false }])) });
    if (this.items.size > MAX_OBSERVATIONS) this.items.delete(this.items.keys().next().value as string);
    return { 'dev.agentinterop/observations': [{ token, handles: shown.map(item => item.handle), complete: true }] };
  }
  /**
   * Texts this conversation was shown for the document exactly as it is now, and whether in full.
   * An observation of any other revision proves nothing.
   */
  shown(caller: Caller, tokens: string[] | undefined, state: State): Map<string, Map<string, boolean>> {
    const result = new Map<string, Map<string, boolean>>();
    for (const token of tokens ?? []) {
      const item = this.items.get(token);
      if (!item || item.conversation !== conversationOf(caller) || item.path !== state.path || item.sessionId !== state.sessionId || item.revision !== state.revision) continue;
      for (const [key, seen] of item.texts) {
        const texts = result.get(key) ?? new Map<string, boolean>();
        texts.set(seen.text, seen.full || texts.get(seen.text) === true); result.set(key, texts);
      }
    }
    return result;
  }
  /** Our own address-preserving edit (text, field value, format) keeps every address; untouched paragraphs stay observed, edited ones no longer match their old text. */
  advance(epoch: EditEpoch, from: number, to: number): void {
    for (const item of this.items.values()) if (item.path === epoch.path && item.sessionId === epoch.sessionId && item.revision === from) item.revision = to;
  }
  forget(predicate: (item: { conversation: string; sessionId: string }) => boolean): void {
    for (const [token, item] of this.items) if (predicate(item)) this.items.delete(token);
  }
  clear(): void { this.items.clear(); }
}

class EditError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly extra: JsonObject = {}, readonly meta: JsonObject = {}, readonly applied: 'no' | 'unknown' = 'no') { super(message); }
}
class PreviewReady extends Error {
  expectedTextLeadingSpaceAdjusted?: Array<{ handle: string; expected: number; current: number }>;
  rewriteDetails?: JsonObject;
  constructor(readonly result: Receipt, readonly commands: string[], readonly changed: Change[], readonly summary?: string) { super('preview'); }
}
interface Match { paragraph: Paragraph; handle: string; offsets: number[] }
type Receipter = (applied: 'yes' | 'no' | 'unknown', extra?: JsonObject) => JsonObject;
type Fail = (code: string, message: string, retryable: boolean, extra?: JsonObject, meta?: JsonObject) => never;
type CallerContext = EditContext & { caller: Caller };
type Change = { handle: string; before: string; after: string };
type NextRole = 'inserted' | 'changed' | 'before' | 'after' | 'table';
type NextHandle = { handle: string; text: string; role: NextRole };
interface Logged { sessionId: string; revision: number; tool: string; summary: string }
// eslint-disable-next-line no-control-regex -- HWP text validation rejects control characters.
const control = (value: unknown): boolean => typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value);
const record = (value: unknown): JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as JsonObject;
const target = (address: BodyAddress): BodyAddress => ({ kind: 'body', section: address.section, paragraph: address.paragraph, ...(address.cellPath?.length ? { cellPath: address.cellPath } : {}) });

export class AgentEdits {
  readonly observations: Observations;
  /** The last AI edit per document: only that one can be undone, and only while nothing happened after it. */
  private readonly last = new Map<string, { conversation: string; sessionId: string; revision: number; selection?: { range: AllowedRange; before: AllowedRange } }>();
  /** What this layer applied to each document since its last save, for check_before_save. A person may have undone some of it. */
  private readonly log = new Map<string, Logged[]>();
  private readonly checks = new Map<string, { key: string; result: ToolResult }>();
  private readonly formatApprovals = new Map<string, { status: 'pending' | 'approved' | 'rejected' | 'failed'; controller: AbortController; expires: number; path: string; sessionId: string; conversation: string }>();
  constructor(private env: EditEnvironment) { this.observations = new Observations(prefix => env.token(prefix)); }

  async resolveTarget(_name: string, args: JsonObject, ctx: EditContext): Promise<ResolvedTarget> {
    if (ctx.signal?.aborted) throw new HwpHandsError('CANCELLED', L({ ko: '대상 확인이 취소됐다.', en: "Target resolution was cancelled." }));
    const { state } = await this.env.open(args?.path, ctx.caller);
    return { kind: 'existing', document: this.env.ref(state), revision: state.revision };
  }

  async call(name: string, args: JsonObject, ctx: EditContext): Promise<ToolResult> {
    const result = await this.callInternal(name, args, ctx);
    if (name !== 'apply_draft') return result;
    const valid = !validateToolInput(name, args), selected = valid ? [...args.accept as number[]].sort((a, b) => a - b) : [];
    const edit = result._meta?.['dev.agentinterop/sessionEdit'] as JsonObject | undefined;
    const preview = result.structuredContent?.preview === true, applied = edit?.applied;
    const accepted = applied === 'unknown' ? null : applied === 'yes' ? selected : [];
    const remaining = valid ? (args.paragraphs as string[]).map((_, i) => i + 1).filter(i => !accepted?.includes(i)) : [];
    // Reuse paragraph validation without exposing its synthetic operation coordinates.
    const details = result.structuredContent;
    if (typeof details?.path === 'string') {
      const match = /^operations\[0\]\.paragraphs\[(\d+)\]$/.exec(details.path);
      if (match) { details.path = `paragraphs[${selected[Number(match[1])] - 1}]`; details.index = selected[Number(match[1])] - 1; }
      else if (details.path === 'operations[0].target' || details.path === 'operations[0].action') {
        if (details.path.endsWith('.action')) { delete details.allowed; details.rule = 'body paragraph anchor'; }
        details.path = 'target'; delete details.index;
      }
    }
    return { ...result, structuredContent: { ...details, draft: {
      status: applied === 'unknown' ? 'unknown' : applied === 'yes' ? 'applied' : preview ? 'preview' : 'not_applied',
      selected, accepted, remaining: applied === 'unknown' ? null : remaining, saved: false,
      ...(typeof edit?.revisionAfter === 'number' ? { revision: edit.revisionAfter } : typeof edit?.revisionBefore === 'number' ? { revision: edit.revisionBefore } : {}),
    } } };
  }

  private async callInternal(name: string, args: JsonObject, ctx: EditContext): Promise<ToolResult> {
    let state: State | undefined, epoch: EditEpoch | undefined;
    const receipt = (applied: 'yes' | 'no' | 'unknown', extra: JsonObject = {}): JsonObject => {
      // The receipt always names the document the host pinned, so a refusal is never mistaken for an edit elsewhere.
      const document = ctx.target?.document, path = state?.path ?? document?.path, sessionId = state?.sessionId ?? document?.sessionId;
      if (!path || !sessionId) return {};
      const documentEpoch = epoch?.id ?? document?.documentEpoch ?? 'unknown';
      return { 'dev.agentinterop/resource': { path, sessionId, documentEpoch, revision: state?.revision ?? ctx.target?.revision ?? 0 },
        'dev.agentinterop/sessionEdit': { applied, path, sessionId, documentEpoch, revisionBefore: state?.revision ?? ctx.target?.revision ?? 0, changedHandles: [], changedPages: [], ...extra } };
    };
    try {
      if (!ctx.caller || !ctx.target) throw new EditError('TARGET_REQUIRED', L({ ko: '편집 대상이 확정되지 않았다. host가 대상을 확정한 뒤 다시 호출해야 한다.', en: "The edit target is unresolved. The host must resolve it before calling again." }), false);
      if (ctx.signal?.aborted) throw new EditError('CANCELLED', L({ ko: '편집이 취소됐다.', en: "Editing was cancelled." }), false);
      // The provider's own refusals (a lease limit) keep their code on the way through an edit tool.
      ({ state, epoch } = await this.env.open(args.path, ctx.caller).catch(error => { throw error instanceof ToolError ? new EditError(error.code, error.message, error.retryable, error.extra) : error; }));
      const actual = this.env.ref(state), pinned = ctx.target.document;
      if (ctx.target.kind !== 'existing' || pinned.path !== actual.path || pinned.sessionId !== actual.sessionId || pinned.incarnation !== actual.incarnation) {
        state = undefined; epoch = undefined;
        throw new EditError('TARGET_MISMATCH', L({ ko: '승인된 문서와 지금 열린 문서가 다르다. 편집하지 않았다.', en: "The open document differs from the approved document. Nothing was edited." }), false);
      }
      const issue = validateToolInput(name, args);
      if (issue) throw new EditError('INVALID_ARGUMENT', issue.message, true, issue.details, receipt('no', { operationId: operationId([state.path, name, args]) }));
      const runCtx: CallerContext = { ...ctx, caller: ctx.caller, preview: args.preview === true,
        formatException: name === 'replace_text' || name === 'edit_paragraphs', formatExceptionApplied: false };
      if (name === 'undo_last_edit') return await this.undo(ctx.caller, state, epoch, receipt, ctx.signal);
      const guard = await this.scope(runCtx, state, epoch, receipt), before = guard ? structuredClone(guard.range) : undefined;
      const result = await this.run(name, args, runCtx, state, epoch, receipt, guard);
      if (runCtx.preview) return { ...result, structuredContent: { ...result.structuredContent, preview: true, executable: true, applied: false, preservationVerified: false } };
      // An undo of this edit puts the selection back where it was.
      const last = this.last.get(epoch.path);
      if (guard && before && last?.revision === guard.range.revision) last.selection = { range: guard.range, before };
      if (runCtx.formatExceptionApplied) return { ...result,
        content: [...result.content, { type: 'text', text: L({ ko: '사용자가 이 편집의 서식 보존 예외를 승인했다. 글자 서식이 달라졌을 수 있으므로 확인해야 한다.', en: "The user approved a formatting preservation exception for this edit. Character formatting may have changed; inspect it." }) }],
        structuredContent: { ...result.structuredContent, formatPreservation: 'waived' } };
      return result;
    } catch (error) {
      if (error instanceof PreviewReady) {
        const result = error.result;
        return { content: [{ type: 'text', text: LT({ ko: () => `실제 엔진 미리보기 통과. 작업본을 복원했고 적용·저장은 하지 않았다. 예상 변경: ${error.summary ?? error.commands.slice(0, 20).join(', ')}. 실적용에는 현재 문서의 대상·관측·선택을 다시 검증한다.`, en: () => `Real-engine preview passed. The working copy was restored; nothing was applied or saved. Projected changes: ${error.summary ?? error.commands.slice(0, 20).join(', ')}. Applying requires revalidating the current document target, observations, and selection.` }) }],
          structuredContent: { ok: true, preview: true, executable: true, changed: error.rewriteDetails ? error.changed : error.changed.slice(0, 10), operations: error.rewriteDetails ? error.commands : error.commands.slice(0, 20), operationCount: error.commands.length, ...(error.expectedTextLeadingSpaceAdjusted ? { expectedTextLeadingSpaceAdjusted: error.expectedTextLeadingSpaceAdjusted } : {}), ...(error.rewriteDetails ?? {}),
            truncated: error.rewriteDetails ? false : error.changed.length > 10 || error.commands.length > 20, ...(error.summary ? { summary: error.summary } : {}),
            changedPages: result.changedPages.slice(0, 50).map(page => page + 1), pageCountBefore: result.pageCountBefore, pageCountAfter: result.pageCountAfter,
            pageCountDelta: result.pageCountDelta, revision: result.revision, applied: false, preservationVerified: false },
          _meta: receipt('no', { operationId: operationId([state?.path ?? ctx.target?.document.path, name, args]) }) };
      }
      const known = error instanceof EditError, host = error instanceof HwpHandsError;
      const reason = host && error.details && typeof error.details === 'object' ? (error.details as { reason?: unknown }).reason : undefined;
      const code = known ? error.code : reason === 'format-preservation' ? 'FORMAT_PRESERVATION_REQUIRED' : reason === 'human-input' ? 'HUMAN_EDITING' : reason === 'anchored-content' ? 'PROTECTED_CONTENT' : reason === 'first-paragraph' ? 'UNSUPPORTED_TARGET'
        : host && (error.code === 'NOT_FOUND' || error.code === 'INVALID_PATH') ? 'TARGET_REQUIRED' : host ? error.code : 'ENGINE_ERROR';
      const retryable = known ? error.retryable : code === 'HUMAN_EDITING' || code === 'REVISION_CONFLICT';
      const message = known ? error.message
        : code === 'HUMAN_EDITING' ? L({ ko: '사람이 이 문서에 입력 중이라 편집하지 않았다. 잠시 뒤 다시 시도할 수 있다.', en: "A person is typing in this document, so nothing was edited. You can retry shortly." })
        : code === 'PROTECTED_CONTENT' ? L({ ko: '바꾸려는 문단에 누름틀·표·그림 같은 개체가 있어 편집하지 않았다. 이 문단은 사람이 화면에서 직접 고쳐야 한다.', en: "The paragraph contains fields, tables, pictures, or other objects, so nothing was edited. A person must edit this paragraph directly onscreen." })
        : code === 'UNSUPPORTED_TARGET' ? L({ ko: '구역의 첫 문단은 지울 수 없다. 편집하지 않았다.', en: "The first paragraph of a section cannot be deleted. Nothing was edited." })
        : code === 'REVISION_CONFLICT' ? L({ ko: '편집하는 사이 문서가 바뀌어 편집하지 않았다. 다시 읽고 시도하라.', en: "The document changed during editing. Nothing was edited; reread and retry." })
        : error instanceof Error ? error.message : L({ ko: '편집하지 못했다.', en: "Could not edit." });
      // A failed rollback is the one case where the engine cannot say whether the document changed.
      const applied = known ? error.applied : host && error.code === 'VERIFY_FAILED' ? 'unknown' : 'no';
      return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { code, retryable, ...domainErrorDetails(code, known ? error.extra : {}) },
        _meta: { 'dev.agentinterop/error': { code, retryable }, ...receipt(applied), ...(known ? error.meta : {}) } };
    }
  }
  private async execute(ctx: CallerContext, state: State, epoch: EditEpoch, commands: Command[], changed: Change[] = [], summary?: string): Promise<Receipt> {
    const options: TransactionOptions = { expectedRevision: state.revision, origin: 'api', ...(ctx.preview ? { dryRun: true } : {}) };
    let result: Receipt;
    try {
      result = await this.env.bridge.transaction(epoch.path, commands, options, actorIdOf(ctx.caller), ctx.signal);
    } catch (error) {
      const command = commands[0];
      const details = error instanceof HwpHandsError && error.details && typeof error.details === 'object' ? error.details as { reason?: unknown; kind?: unknown } : undefined;
      if (details?.reason !== 'format-preservation' || ctx.signal?.aborted) throw error;
      const refuse = (confirmation: string, suggestion: string, message: string): never => {
        throw new EditError('FORMAT_PRESERVATION_REQUIRED', message, false,
          { rule: 'format-preservation', suggestion, preview: ctx.preview === true, commandCount: commands.length, confirmation });
      };
      const inspect = L({ ko: 'read_document(mode="formatting", target=해당 문단 핸들)로 서식을 읽고, 현재 원문과 수정안을 비교한 뒤 같은 서식 구간으로 나눈다.', en: "Read formatting with read_document(mode=\"formatting\", target=the paragraph handle), compare the current original and proposal, then split into uniformly formatted runs." });
      if (ctx.preview) return refuse('not_requested', LT({ ko: () => `${inspect} 미리보기에서는 예외 확인창이 열리지 않는다.${ctx.formatException && details.kind === 'mixed-length' && this.env.approveFormatException ? ' 변경안을 검토한 뒤 단일 문단의 실제 편집에서만 예외 확인을 요청할 수 있다.' : ''}`, en: () => `${inspect} Exception dialogs do not open in preview.${ctx.formatException && details.kind === 'mixed-length' && this.env.approveFormatException ? ' After reviewing the proposal, you may request exception confirmation only for an actual single-paragraph edit.' : ''}` }),
        L({ ko: '서식 보존 미리보기가 실패했다. 편집하지 않았으며 예외 확인창도 열지 않았다.', en: "Formatting preservation preview failed. Nothing was edited and no exception dialog was opened." }));
      if (!ctx.formatException || details.kind !== 'mixed-length' || commands.length !== 1 || command?.type !== 'replaceParagraph'
        || command.preserveFormatting !== true || command.expectedText === undefined) return refuse('not_available', LT({ ko: () => `${inspect} 한 문단씩 다시 검토한다.`, en: () => `${inspect} Review one paragraph at a time again.` }),
        L({ ko: '이 편집은 서식 보존이 불가능해 거절했다. 예외 확인창은 열지 않았다.', en: "This edit was refused because formatting cannot be preserved. No exception dialog was opened." }));
      if (!this.env.approveFormatException) return refuse('unavailable', LT({ ko: () => `${inspect} 사람의 확인창을 사용할 수 없으므로 화면에서 직접 편집한다.`, en: () => `${inspect} A confirmation dialog is unavailable; edit directly onscreen.` }),
        L({ ko: '서식 보존이 불가능하며 이 환경에는 예외 확인창이 없다. 편집하지 않았다.', en: "Formatting cannot be preserved and this environment has no exception dialog. Nothing was edited." }));
      // Approval is out of band: the failed host call returns first. A later call must pass the host's
      // target, grant, observation and selection checks again before consuming the exact approval.
      const key = JSON.stringify([conversationOf(ctx.caller), epoch.path, state.sessionId, state.revision, command]);
      let approval = this.formatApprovals.get(key);
      if (approval && approval.expires <= Date.now()) { approval.controller.abort(); this.formatApprovals.delete(key); approval = undefined; }
      if (approval?.status === 'rejected') return refuse('rejected', L({ ko: '사람이 취소한 결정을 존중하고 같은 요청을 자동 반복하지 않는다.', en: "Respect the person's cancellation and do not repeat the same request automatically." }),
        L({ ko: '사람이 서식 보존 예외를 승인하지 않았다. 편집하지 않았다.', en: "The person did not approve the formatting preservation exception. Nothing was edited." }));
      if (approval?.status === 'failed') return refuse('failed', L({ ko: '확인창 실행 상태를 확인하고 현재 문서를 다시 읽는다. 편집 결과를 성공으로 간주하지 않는다.', en: "Check the confirmation dialog state and reread the current document. Do not treat the edit as successful." }),
        L({ ko: '서식 보존 예외 확인 요청이 실패했다. 편집하지 않았다.', en: "Requesting formatting exception confirmation failed. Nothing was edited." }));
      if (!approval) {
        while (this.formatApprovals.size >= 16) { const oldest = this.formatApprovals.keys().next().value as string; this.formatApprovals.get(oldest)?.controller.abort(); this.formatApprovals.delete(oldest); }
        const item = { status: 'pending' as 'pending' | 'approved' | 'rejected' | 'failed', controller: new AbortController(), expires: Date.now() + 5 * 60_000,
          path: epoch.path, sessionId: state.sessionId, conversation: conversationOf(ctx.caller) };
        this.formatApprovals.set(key, item);
        const timer = setTimeout(() => { if (this.formatApprovals.get(key) === item) { this.formatApprovals.delete(key); item.controller.abort(); } }, 5 * 60_000);
        item.controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        void this.env.approveFormatException({ path: epoch.path, before: command.expectedText, after: command.text }, item.controller.signal)
          .then(yes => { if (this.formatApprovals.get(key) === item && !item.controller.signal.aborted) item.status = yes ? 'approved' : 'rejected'; })
          .catch(() => { if (this.formatApprovals.get(key) === item) item.status = 'failed'; });
        return refuse('requested', L({ ko: '사람의 확인창 결정을 기다린다. 승인하면 같은 문서·같은 변경을 다시 요청하고, 취소하면 반복하지 않는다.', en: "Wait for the person's dialog decision. After approval, repeat the same change in the same document; after cancellation, do not repeat." }),
          L({ ko: '혼합 서식 보존을 위해 편집하지 않았다. 서식 변경 가능성을 설명하는 확인창을 요청했다.', en: "Nothing was edited to preserve mixed formatting. Requested a confirmation dialog explaining possible formatting changes." }));
      }
      if (approval.status !== 'approved') return refuse('pending', L({ ko: '사람의 확인창 결정을 기다린다. 승인하면 같은 문서·같은 변경을 다시 요청한다.', en: "Wait for the person's dialog decision. After approval, repeat the same change in the same document." }),
        L({ ko: '서식 보존 예외 확인을 기다리고 있다. 편집하지 않았다.', en: "Waiting for formatting exception confirmation. Nothing was edited." }));
      this.formatApprovals.delete(key);
      approval.controller.abort();
      if (ctx.signal?.aborted) throw error;
      result = await this.env.bridge.transaction(epoch.path, [{ ...command, preserveFormatting: false }], options, actorIdOf(ctx.caller), ctx.signal);
      ctx.formatExceptionApplied = true;
    }
    // Exit before any facade ledger, handle, selection or review-mark bookkeeping.
    if (ctx.preview) throw new PreviewReady(result, commands.map(c => c.type), changed, summary);
    return result;
  }
  private probe(ctx: CallerContext, state: State, epoch: EditEpoch, commands: Command[]): Promise<Receipt> {
    return this.env.bridge.transaction(epoch.path, commands, { expectedRevision: state.revision, dryRun: true, origin: 'api' }, actorIdOf(ctx.caller), ctx.signal);
  }

  private run(name: string, args: JsonObject, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, guard?: SelectionGuard): Promise<ToolResult> {
    if (name === 'update_section') return this.section(args, ctx, state, epoch, receipt, guard);
    if (name === 'edit_styles') return this.styles(args, ctx, state, epoch, receipt, guard);
    if (name === 'edit_notes') return this.notes(args, ctx, state, epoch, receipt, guard);
    if (name === 'replace_text') return this.replace(args, ctx, state, epoch, receipt, guard);
    if (name === 'apply_draft') {
      const accepted = new Set(args.accept as number[]);
      return this.paragraphs({ operations: [{ action: args.position === 'before' ? 'insert_before' : 'insert_after', target: args.target!,
        paragraphs: (args.paragraphs as string[]).filter((_, index) => accepted.has(index + 1)) }] }, ctx, state, epoch, receipt, guard, { tool: 'apply_draft', input: args });
    }
    if (name === 'edit_paragraphs') return this.paragraphs(args, ctx, state, epoch, receipt, guard);
    if (name === 'rewrite_paragraphs') return this.rewriteParagraphs(args, ctx, state, epoch, receipt, guard);
    if (name === 'update_table') return this.table(args, ctx, state, epoch, receipt, guard);
    if (name === 'insert_table') return this.insertTable(args, ctx, state, epoch, receipt, guard);
    if (name === 'fill_fields') return this.fields(args, ctx, state, epoch, receipt, guard);
    if (name === 'format_text') return this.format(args, ctx, state, epoch, receipt, guard);
    throw new EditError('INVALID_ARGUMENT', LT({ ko: () => `알 수 없는 도구: ${name}`, en: () => `Unknown tool: ${name}` }), false);
  }
  /** The selection of the turn as a guard for this call. A turn without a selection has none. */
  private async scope(ctx: EditContext, state: State, epoch: EditEpoch, receipt: Receipter): Promise<SelectionGuard | undefined> {
    const allowed = ctx.selection;
    if (!allowed) return undefined;
    if (allowed === 'stale' || allowed.sessionId !== state.sessionId || allowed.revision !== state.revision)
      throw new EditError('SELECTION_STALE', L({ ko: '요청을 보낸 뒤 선택한 범위의 문서가 바뀌어 편집하지 않았다. 범위를 넓혀 다시 시도하지 말고, 사용자가 범위를 다시 선택해 요청하게 하라.', en: "The selected document changed after submission; nothing was edited. Do not retry with a broader scope. Ask the user to select the scope again and submit a new request." }), false, {}, receipt('no'));
    const paragraphs = await this.env.api.query.paragraphs(epoch.path, { includeCells: true });
    await this.unchanged(state, epoch, this.failer(receipt, operationId([state.path, 'selection'])));
    return new SelectionGuard(allowed, paragraphs);
  }
  /** Refuses an edit outside the selection and tells the model which paragraphs the selection touches. */
  private async outside(guard: SelectionGuard, epoch: EditEpoch, fail: Fail, what: string): Promise<never> {
    const all = await this.env.api.query.paragraphs(epoch.path, { includeCells: true }), handles = await this.env.handles(epoch, all);
    const inside = new Set(guard.siblings(all));
    return fail('OUTSIDE_SELECTION', LT({ ko: () => `${what} 사용자가 선택한 범위 밖이라 편집하지 않았다. 이 요청에서는 선택한 범위 안만 고칠 수 있다. 범위를 바꾸려면 사용자가 다시 선택해 요청해야 한다.`, en: () => `${what} is outside the user selection; nothing was edited. This request may only edit within that selection. The user must select a new scope and submit again to change it.` }), false,
      { allowed: all.flatMap((paragraph, index) => inside.has(paragraph) ? [handles[index]] : []).slice(0, MAX_INSERTED) });
  }

  private matches(paragraphs: Paragraph[], handles: string[], find: string, within: string | undefined): Match[] {
    const needle = Array.from(find), result: Match[] = [];
    paragraphs.forEach((paragraph, index) => {
      const handle = handles[index];
      if (within !== undefined && handle !== within && !handle.startsWith(`${within}:`) && !handle.startsWith(`${within}.`)) return;
      if (!paragraph.text.includes(find)) return;
      const source = Array.from(paragraph.text), offsets: number[] = [];
      // Left to right, non-overlapping, counted in code points.
      for (let offset = 0; offset + needle.length <= source.length;) {
        if (needle.every((character, at) => source[offset + at] === character)) { offsets.push(offset); offset += needle.length; } else offset++;
      }
      if (offsets.length) result.push({ paragraph, handle, offsets });
    });
    return result;
  }

  private async replace(args: JsonObject, ctx: EditContext & { caller: Caller }, state: State, epoch: EditEpoch,
    receipt: (applied: 'yes' | 'no' | 'unknown', extra?: JsonObject) => JsonObject, guard?: SelectionGuard): Promise<ToolResult> {
    const find = args.find, replace = args.replace, within = args.within, occurrence = args.occurrence ?? 'only', nth = args.occurrenceIndex;
    const operation = operationId([state.path, find, replace]);
    const fail = (code: string, message: string, retryable: boolean, extra: JsonObject = {}, meta: JsonObject = {}): never => {
      throw new EditError(code, message, retryable, extra, { ...receipt('no', { operationId: operation }), ...meta });
    };
    if (typeof find !== 'string' || !find.length || typeof replace !== 'string') return fail('INVALID_ARGUMENT', L({ ko: 'find는 비어 있지 않은 문자열, replace는 문자열이어야 한다.', en: "find must be a nonempty string; replace must be a string." }), true, inputAt(typeof find !== 'string' || !find.length ? 'find' : 'replace'));
    // eslint-disable-next-line no-control-regex -- HWP replacement text must exclude control characters.
    if (/[\u0000-\u001f\u007f]/.test(replace)) return fail('INVALID_ARGUMENT', L({ ko: 'replace에 줄바꿈이나 제어문자를 넣을 수 없다. 한 문단 안의 문구만 바꾼다.', en: "replace cannot contain line breaks or control characters. Only phrases within one paragraph can be replaced." }), true, inputAt('replace', { rule: 'single paragraph text' }));
    if (occurrence !== 'only' && occurrence !== 'all' && occurrence !== 'nth') return fail('INVALID_ARGUMENT', L({ ko: 'occurrence는 only, all, nth 중 하나다.', en: "occurrence must be only, all, or nth." }), true, inputAt('occurrence', { allowed: ['only', 'all', 'nth'] }));
    if ((occurrence === 'nth') !== (nth !== undefined)) return fail('INVALID_ARGUMENT', L({ ko: 'occurrenceIndex는 occurrence가 nth일 때만, 그리고 그때는 반드시 준다.', en: "occurrenceIndex is required with occurrence=nth and forbidden otherwise." }), true, inputAt('occurrenceIndex', { rule: 'requires occurrence=nth' }));
    if (within !== undefined && (typeof within !== 'string' || !within.startsWith(`${epoch.id}:`)))
      return fail('HANDLE_EXPIRED', L({ ko: 'within의 핸들이 지금 문서 상태의 것이 아니다. 다시 읽어 새 핸들을 써라.', en: "The within handle does not belong to the current document state. Reread and use a fresh handle." }), true, inputAt('within'));
    const paragraphs = await this.env.api.query.paragraphs(epoch.path, { includeCells: true });
    const current = await this.env.api.documents.state(epoch.path);
    if (current.sessionId !== state.sessionId || current.revision !== state.revision) return fail('REVISION_CONFLICT', L({ ko: '읽는 사이 문서가 바뀌었다. 다시 시도하라.', en: "The document changed during reading. Try again." }), true);
    const handles = await this.env.handles(epoch, paragraphs);
    let found = this.matches(paragraphs, handles, find, within);
    if (guard && found.length) {
      // With a selection, only matches inside it count: "only", "nth" and "all" are about the selected text.
      const length = Array.from(find).length;
      found = found.map(match => ({ ...match, offsets: match.offsets.filter(offset => guard.covers(match.paragraph.address, offset, offset + length)) })).filter(match => match.offsets.length);
      if (!found.length) return await this.outside(guard, epoch, fail, LT({ ko: () => `"${clip(find)}"는`, en: () => `"${clip(find)}"` }));
    }
    const total = found.reduce((sum, match) => sum + match.offsets.length, 0);
    // A candidate shows a window around the match; it is a full observation only when the window covers the paragraph.
    const covered = (match: Match): boolean => { const length = Array.from(match.paragraph.text).length, offset = match.offsets[0]; return offset <= SNIPPET_RADIUS && length - offset - Array.from(find).length <= SNIPPET_RADIUS; };
    const shownMeta = (items: Match[]): JsonObject => this.observations.record(ctx.caller, epoch, items.map(match => ({ handle: match.handle, address: match.paragraph.address, text: match.paragraph.text, full: covered(match) })));
    const snippet = (match: Match, offset: number): string => {
      const source = Array.from(match.paragraph.text), length = Array.from(find).length;
      const from = Math.max(0, offset - SNIPPET_RADIUS), to = Math.min(source.length, offset + length + SNIPPET_RADIUS);
      return `${from ? '…' : ''}${source.slice(from, offset).join('')}«${find}»${source.slice(offset + length, to).join('')}${to < source.length ? '…' : ''}`;
    };
    const candidates = (items: Match[]): JsonObject[] => items.flatMap(match => match.offsets.map(offset => ({ handle: match.handle, snippet: snippet(match, offset) }))).slice(0, MAX_CANDIDATES);
    if (!total) return fail('TEXT_NOT_FOUND', LT({ ko: () => `"${find}"를 본문과 표 셀에서 찾지 못했다. 바꾸지 않았다.`, en: () => `Could not find "${find}" in body or table cells. Nothing was changed.` }), true, inputAt('find'));
    if (occurrence === 'only' && total > 1) {
      const shown = found.slice(0, MAX_CANDIDATES);
      return fail('AMBIGUOUS_MATCH', LT({ ko: () => `"${find}"가 ${total}곳에 있어 바꾸지 않았다. within에 핸들을 주거나 occurrence를 nth 또는 all로 지정하라.`, en: () => `Found "${find}" in ${total} locations; nothing was changed. Supply a within handle or set occurrence to nth or all.` }), true, inputAt('find', { total, candidates: candidates(shown) }), shownMeta(shown));
    }
    if (occurrence === 'nth') {
      if (typeof nth !== 'number' || !Number.isInteger(nth) || nth < 1 || nth > total) return fail('INVALID_ARGUMENT', LT({ ko: () => `occurrenceIndex는 1부터 ${total}까지의 정수여야 한다.`, en: () => `occurrenceIndex must be an integer from 1 to ${total}.` }), true,
        inputAt('occurrenceIndex', { rule: 'document-range', allowed: { minimum: 1, maximum: total }, total }));
      let seen = 0;
      found = found.flatMap(match => { const picked = match.offsets.filter(() => ++seen === nth); return picked.length ? [{ ...match, offsets: picked }] : []; });
    }
    if (found.length > MAX_COMMANDS) return fail('LIMIT_EXCEEDED', LT({ ko: () => `한 번에 바꿀 수 있는 문단은 ${MAX_COMMANDS}개다. within으로 범위를 나눠라.`, en: () => `At most ${MAX_COMMANDS} paragraphs can be changed per call. Split the scope with within.` }), true, { limit: MAX_COMMANDS });
    // Observation guard: every paragraph about to change must have been shown to the model exactly as it is now.
    const shown = this.observations.shown(ctx.caller, ctx.observations, state);
    const unseen = found.filter(match => !shown.get(addressKey(match.paragraph.address))?.has(match.paragraph.text));
    if (unseen.length) {
      const list = unseen.slice(0, MAX_CANDIDATES);
      return fail('OBSERVATION_REQUIRED', L({ ko: '아직 적용되지 않았다. 바꾸려는 문단의 지금 내용을 아래에 보여 주었다. 요청과 맞으면 같은 호출을 다시 보내면 적용된다.', en: "Not applied yet. Current content of the target paragraphs is shown below. If it matches the request, send the same call again to apply." }), true,
        { candidates: candidates(list), suggestion: observedRetrySuggestion() }, shownMeta(list));
    }
    const needleLength = Array.from(find).length;
    const edits = found.map(match => {
      const source = Array.from(match.paragraph.text), parts: string[] = [];
      let at = 0;
      for (const offset of match.offsets) { parts.push(source.slice(at, offset).join(''), replace); at = offset + needleLength; }
      parts.push(source.slice(at).join(''));
      return { ...match, after: parts.join('') };
    }).filter(edit => edit.after !== edit.paragraph.text);
    const done = found.reduce((sum, match) => sum + match.offsets.length, 0);
    if (!edits.length) return { content: [{ type: 'text', text: LT({ ko: () => `"${find}"는 이미 같은 문구다. 바꾼 것이 없다.`, en: () => `"${find}" is already the same text. Nothing changed.` }) }], structuredContent: { ok: true, changed: [], replaced: 0, undoAvailable: false },
      _meta: receipt('no', { operationId: operation }) };
    if (ctx.signal?.aborted) return fail('CANCELLED', L({ ko: '편집이 취소됐다.', en: "Editing was cancelled." }), false);
    const commands: Command[] = edits.flatMap(edit => {
      let current = edit.paragraph.text;
      // Separate matches must never delete and reinsert the unchanged text between them.
      return [...edit.offsets].reverse().map(offset => {
        const source = Array.from(current), expectedText = current;
        current = source.slice(0, offset).join('') + replace + source.slice(offset + needleLength).join('');
        return { type: 'replaceParagraph' as const, target: target(edit.paragraph.address), text: current, expectedText, preserveFormatting: true };
      });
    });
    if (commands.length > MAX_COMMANDS) return fail('LIMIT_EXCEEDED', LT({ ko: () => `한 번에 바꿀 수 있는 문구는 ${MAX_COMMANDS}개다. within으로 범위를 나눠라.`, en: () => `At most ${MAX_COMMANDS} phrases can be changed per call. Split the scope with within.` }), true, { limit: MAX_COMMANDS });
    const applied = await this.execute(ctx, state, epoch, commands, edits.map(edit => ({ handle: edit.handle, before: clip(edit.paragraph.text), after: clip(edit.after) }))).catch(error => {
      if (!(error instanceof HwpHandsError) || (error.details as { reason?: unknown } | undefined)?.reason !== 'anchored-content') throw error;
      return fail('PROTECTED_CONTENT', L({ ko: '보호된 개체가 있는 문단이라 편집하지 않았다. 위치 보기로 열어 사람이 직접 고쳐야 한다.', en: "The paragraph contains protected objects; nothing was edited. A person must open it with reveal and edit directly." }), false, {},
        { 'dev.agentinterop/reveal': edits.length === 1 ? { handle: edits[0].handle } : {} });
    });
    // The edit kept every paragraph address, so the epoch and untouched observations carry over to the new revision.
    this.env.advance(epoch, applied.revision);
    this.observations.advance(epoch, state.revision, applied.revision);
    guard?.rewritten(edits, applied.revision);
    this.env.marks?.add(epoch.path, applied.sessionId, state.revision, applied.revision, edits.map(edit => ({ address: edit.paragraph.address })));
    this.last.set(epoch.path, { conversation: conversationOf(ctx.caller), sessionId: applied.sessionId, revision: applied.revision });
    this.note(epoch.path, applied, 'replace_text', LT({ ko: () => `"${clip(find)}" → "${clip(replace)}" ${done}곳`, en: () => `"${clip(find)}" → "${clip(replace)}" in ${done} locations` }));
    const changed = edits.map(edit => ({ handle: edit.handle, before: clip(edit.paragraph.text), after: clip(edit.after) }));
    const pages = applied.changedPages.map(page => page + 1);
    const observed = this.observations.record(ctx.caller, epoch, edits.map(edit => ({ handle: edit.handle, address: edit.paragraph.address, text: edit.after, full: Array.from(edit.after).length <= PREVIEW_CHARS })));
    return {
      content: [{ type: 'text', text: LT({ ko: () => `${changed.map(item => item.handle).slice(0, 10).join(', ')}${changed.length > 10 ? ' 등' : ''}에서 ${done}곳 바꿈.${pages.length ? ` ${pages[0]}쪽부터 다시 그림.` : ''}`, en: () => `Replaced ${done} matches in ${changed.map(item => item.handle).slice(0, 10).join(', ')}${changed.length > 10 ? ' and others' : ''}.${pages.length ? ` Redrawing from page ${pages[0]}.` : ''}` }) }],
      structuredContent: { ok: true, replaced: done, changed: changed.slice(0, 20), changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo },
      _meta: { ...receipt('yes', { revisionAfter: applied.revision, undo: { available: applied.canUndo, revision: applied.revision }, changedHandles: changed.map(item => item.handle).slice(0, 1000), changedPages: pages.slice(0, 5000), operationId: operation }),
        'dev.agentinterop/resource': { path: epoch.path, sessionId: epoch.sessionId, documentEpoch: epoch.id, revision: applied.revision },
        'dev.agentinterop/changePreview': changed.slice(0, 50), ...observed },
    };
  }

  private async paragraphs(args: JsonObject, ctx: EditContext & { caller: Caller }, state: State, epoch: EditEpoch,
    receipt: (applied: 'yes' | 'no' | 'unknown', extra?: JsonObject) => JsonObject, guard?: SelectionGuard, source?: { tool: string; input: JsonObject }): Promise<ToolResult> {
    const operation = source ? operationId([state.path, source.tool, source.input]) : operationId([state.path, 'edit_paragraphs', args.operations ?? null]);
    const fail = (code: string, message: string, retryable: boolean, extra: JsonObject = {}, meta: JsonObject = {}): never => {
      throw new EditError(code, message, retryable, extra, { ...receipt('no', { operationId: operation }), ...meta });
    };
    const list = args.operations;
    if (!Array.isArray(list) || !list.length || list.length > MAX_OPERATIONS) return fail('INVALID_ARGUMENT', LT({ ko: () => `operations는 1~${MAX_OPERATIONS}개의 배열이어야 한다.`, en: () => `operations must be an array of 1–${MAX_OPERATIONS} items.` }), true, inputAt('operations', { allowed: { minItems: 1, maxItems: MAX_OPERATIONS } }));
    // eslint-disable-next-line no-control-regex -- HWP operations reject control characters.
    const bad = (value: unknown): boolean => typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value);
    type Operation = { action: 'set' | 'insert_after' | 'insert_before' | 'delete'; target: string; text?: string; expectedText?: string; lines?: string[]; style?: string };
    const operations: Operation[] = list.map((raw, index) => {
      const item = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}), action = item.action, target = item.target, at = `operations[${index}]`;
      if (action !== 'set' && action !== 'insert_after' && action !== 'insert_before' && action !== 'delete') return fail('INVALID_ARGUMENT', LT({ ko: () => `${at}.action은 set, insert_after, insert_before, delete 중 하나다.`, en: () => `${at}.action must be set, insert_after, insert_before, or delete.` }), true,
        inputAt(`${at}.action`, { allowed: ['set', 'insert_after', 'insert_before', 'delete'] }));
      if (typeof target !== 'string' || !target.startsWith(`${epoch.id}:`)) return fail('HANDLE_EXPIRED', LT({ ko: () => `${at}.target의 핸들이 지금 문서 상태의 것이 아니다. 다시 읽어 새 핸들을 써라.`, en: () => `${at}.target handle does not belong to the current document state. Reread and use a fresh handle.` }), true, inputAt(`${at}.target`));
      const style = item.style === undefined ? {} : { style: item.style as string };
      if (item.style !== undefined && (action === 'delete' || bad(item.style) || !(item.style as string).length)) return fail('INVALID_ARGUMENT', LT({ ko: () => `${at}.style은 set·insert_after·insert_before에만 주는 문단 스타일 이름이다.`, en: () => `${at}.style is a paragraph style name for set, insert_after, or insert_before only.` }), true, inputAt(`${at}.style`));
      if (action === 'set') {
        if (item.expectedText !== undefined && typeof item.expectedText !== 'string') return fail('INVALID_ARGUMENT', LT({ ko: () => `${at}.expectedText는 문자열이어야 한다.`, en: () => `${at}.expectedText must be a string.` }), true, inputAt(`${at}.expectedText`));
        if (item.paragraphs !== undefined || bad(item.text)) return fail('INVALID_ARGUMENT', LT({ ko: () => `${at}: set에는 줄바꿈 없는 text만 준다.`, en: () => `${at}: set accepts only text without line breaks.` }), true, inputAt(`${at}.${item.paragraphs !== undefined ? 'paragraphs' : 'text'}`,
          typeof item.text === 'string' && item.paragraphs === undefined ? { suggestion: L({ ko: '화면 줄 수는 줄바꿈이 아니라 문장 길이로 맞추고 read_document(mode=layout)으로 추정 줄 수를 확인한다. 문단을 나누려면 set 뒤 insert_after의 paragraphs로 새 문단을 넣는다.', en: "Adjust onscreen line counts through sentence length, not line breaks; check estimated lines with read_document(mode=layout). To split paragraphs, use set followed by insert_after paragraphs." }) } : {}));
        return { action, target, text: item.text as string, ...(item.expectedText !== undefined ? { expectedText: item.expectedText } : {}), ...style };
      }
      if (action === 'delete') {
        if (item.text !== undefined || item.paragraphs !== undefined) return fail('INVALID_ARGUMENT', LT({ ko: () => `${at}: delete에는 text와 paragraphs를 주지 않는다.`, en: () => `${at}: delete does not accept text or paragraphs.` }), true, inputAt(`${at}.${item.text !== undefined ? 'text' : 'paragraphs'}`));
        return { action, target };
      }
      const lines = item.paragraphs;
      if (item.text !== undefined || !Array.isArray(lines) || !lines.length || lines.length > MAX_INSERTED || lines.some(bad)) {
        const line = Array.isArray(lines) ? lines.findIndex(bad) : -1;
        return fail('INVALID_ARGUMENT', LT({ ko: () => `${at}: 삽입에는 줄바꿈 없는 문자열 1~${MAX_INSERTED}개의 paragraphs만 준다. 문단마다 배열 항목 하나다.`, en: () => `${at}: insertion accepts only paragraphs containing 1–${MAX_INSERTED} strings without line breaks. One array item per paragraph.` }), true,
          inputAt(item.text !== undefined ? `${at}.text` : line >= 0 ? `${at}.paragraphs[${line}]` : `${at}.paragraphs`));
      }
      const markdown = (lines as string[]).findIndex(line => {
        const value = line.trim();
        return (value.startsWith('|') && value.endsWith('|') && (value.match(/\|/g)?.length ?? 0) >= 3)
          || (value.includes('|') && value.includes('-') && /^[|\s:-]+$/.test(value));
      });
      if (!source && markdown >= 0) return fail('INVALID_ARGUMENT', L({ ko: '삽입 문단에 Markdown 표 행을 넣을 수 없다. insert_table에 before 또는 after와 rows: [["열1", "열2"], ["값1", "값2"]]를 줘라. 제목 앞에 넣으려면 before에 그 제목 문단을 준다.', en: 'Inserted paragraphs cannot contain Markdown table rows. Call insert_table with before or after and rows: [["Column 1", "Column 2"], ["Value 1", "Value 2"]]. To insert before a heading, pass that heading paragraph as before.' }), true,
        inputAt(`${at}.paragraphs[${markdown}]`));
      return { action, target, lines: lines as string[], ...style };
    });
    const exclusive = operations.filter(item => item.action === 'delete').map(item => item.target);
    const seen = new Set<string>();
    for (const [index, item] of operations.entries()) {
      const key = `${item.action}|${item.target}`;
      if (seen.has(key) || (item.action !== 'delete' && exclusive.includes(item.target))) return fail('INVALID_ARGUMENT', LT({ ko: () => `${item.target}에 겹치는 작업이 있다. 한 문단에는 같은 작업을 한 번만, 지우는 문단에는 다른 작업을 주지 않는다.`, en: () => `Overlapping operations on ${item.target}. Apply each action only once per paragraph; a deleted paragraph cannot have other actions.` }), true,
        inputAt(`operations[${index}].target`, { rule: 'one action per paragraph' }));
      seen.add(key);
    }
    const all = await this.env.api.query.paragraphs(epoch.path, { includeCells: true });
    const current = await this.env.api.documents.state(epoch.path);
    if (current.sessionId !== state.sessionId || current.revision !== state.revision) return fail('REVISION_CONFLICT', L({ ko: '읽는 사이 문서가 바뀌었다. 다시 시도하라.', en: "The document changed during reading. Try again." }), true);
    const handles = await this.env.handles(epoch, all), byHandle = new Map(handles.map((handle, index) => [handle, all[index]]));
    const shown = this.observations.shown(ctx.caller, ctx.observations, state);
    const resolved = operations.map((item, index) => {
      const paragraph = byHandle.get(item.target), root = !!paragraph && !paragraph.address.cellPath?.length;
      if (!paragraph) return fail('HANDLE_EXPIRED', LT({ ko: () => `${item.target}은 본문이나 표 셀의 문단 핸들이 아니다. read_document가 준 문단 핸들을 써라.`, en: () => `${item.target} is not a body or table-cell paragraph handle. Use a paragraph handle from read_document.` }), true, inputAt(`operations[${index}].target`));
      if (!root && source?.tool === 'apply_draft') return fail('UNSUPPORTED_TARGET', L({ ko: '초안 채택은 본문 문단 기준으로만 지원한다.', en: "Draft acceptance is supported only relative to body paragraphs." }), false, inputAt(`operations[${index}].target`));
      const cell = /:t\d+:r\d+c\d+\.p\d+$/.test(item.target);
      if (!root && (!cell || paragraph.address.cellPath?.length !== 1 || paragraph.address.containerKinds?.includes('textBox')))
        return fail('UNSUPPORTED_TARGET', LT({ ko: () => `${item.target}: 글상자와 중첩 표 안은 편집하지 않는다.`, en: () => `${item.target}: text boxes and nested tables are not edited.` }), false, inputAt(`operations[${index}].target`));
      return { ...item, paragraph };
    });
    // A whole paragraph is rewritten or removed only if the model saw all of it; an insertion needs its anchor seen.
    const unseen = resolved.filter(item => {
      const full = shown.get(addressKey(item.paragraph.address))?.get(item.paragraph.text);
      return item.action === 'set' || item.action === 'delete' ? full !== true : full === undefined;
    });
    if (unseen.length) {
      const blocks = unseen.slice(0, MAX_CANDIDATES).map(item => ({ handle: item.target, address: item.paragraph.address, text: item.paragraph.text }));
      const clipped = blocks.filter(block => Array.from(block.text).length > PREVIEW_CHARS * 5);
      return fail('OBSERVATION_REQUIRED', clipped.length
        ? L({ ko: '고치려는 문단을 전부 확인하지 않았다. read_document로 그 문단을 읽은 뒤 다시 요청하라.', en: "Target paragraphs have not been fully inspected. Read them with read_document before requesting again." })
        : L({ ko: '아직 적용되지 않았다. 고치려는 문단의 지금 내용 전체를 아래에 보여 주었다. 요청과 맞으면 같은 호출을 다시 보내면 적용된다.', en: "Not applied yet. Entire current content of the target paragraphs is shown below. If it matches the request, send the same call again to apply." }), true,
        { blocks: blocks.filter(block => !clipped.includes(block)).map(block => ({ handle: block.handle, text: block.text })), ...(!clipped.length ? { suggestion: observedRetrySuggestion() } : {}) },
        this.observations.record(ctx.caller, epoch, blocks.filter(block => !clipped.includes(block))));
    }
    const expectedTextLeadingSpaceAdjusted: Array<{ handle: string; expected: number; current: number }> = [];
    for (const [index, item] of resolved.entries()) {
      if (item.action !== 'set' || item.expectedText === undefined || item.expectedText === item.paragraph.text) continue;
      const expected = item.expectedText.match(/^ */)![0].length;
      const current = item.paragraph.text.match(/^ */)![0].length;
      const remainder = item.expectedText.slice(expected);
      if (remainder.length > 0 && /\S/u.test(remainder) && remainder === item.paragraph.text.slice(current)
          && item.text!.match(/^ */)![0].length === expected) {
        item.text = ' '.repeat(current) + item.text!.slice(expected);
        expectedTextLeadingSpaceAdjusted.push({ handle: item.target, expected, current });
        continue;
      }
      const mismatch = expectedTextMismatch(item.target, item.expectedText, item.paragraph.text);
      return fail('REVISION_CONFLICT', mismatch.message, true, inputAt(`operations[${index}].expectedText`, { rule: 'expected-paragraph-text', ...mismatch.details }));
    }
    for (const item of guard ? resolved : []) {
      const address = item.paragraph.address;
      const inside = item.action === 'set' ? (item.text === item.paragraph.text ? guard!.touches(address) : guard!.rewrite(item.paragraph, item.text!))
        : item.action === 'delete' ? guard!.whole(address) : guard!.insertion(address, item.action === 'insert_before');
      if (!inside) return await this.outside(guard!, epoch, fail, LT({ ko: () => `${item.target}의 ${item.action}은`, en: () => `${item.action} on ${item.target}` }));
    }
    const styleIds = new Map<string, number>();
    for (const [index, item] of resolved.entries()) if (item.style !== undefined && !styleIds.has(item.style)) styleIds.set(item.style, await this.styleId(epoch, item.style, fail, `operations[${index}].style`));
    const sets = resolved.filter(item => item.action === 'set' && item.text !== item.paragraph.text);
    const styled = resolved.filter(item => item.action === 'set' && item.style !== undefined);
    const structural = resolved.filter(item => item.action !== 'set');
    const cellStructural = structural.filter(item => item.paragraph.address.cellPath?.length);
    for (const item of cellStructural.filter(item => item.action === 'delete')) {
      const container = containerOf(item.paragraph.address);
      const count = all.filter(p => containerOf(p.address) === container).length;
      const removals = cellStructural.filter(p => p.action === 'delete' && containerOf(p.paragraph.address) === container).length;
      if (removals >= count) return fail('UNSUPPORTED_TARGET', L({ ko: '표 셀에는 최소 한 문단이 필요하므로 마지막 문단을 지울 수 없다. 내용을 비우려면 set을 사용하라.', en: "A table cell requires at least one paragraph; its last paragraph cannot be deleted. Use set to clear its content." }), false);
    }
    if (!sets.length && !styled.length && !structural.length) return { content: [{ type: 'text', text: L({ ko: '이미 같은 내용이다. 바꾼 것이 없다.', en: "Content is already identical. Nothing changed." }) }], structuredContent: { ok: true, changed: [], undoAvailable: false, expectedTextLeadingSpaceAdjusted }, _meta: receipt('no', { operationId: operation }) };
    // Text rewrites keep every address, so they go first. Structural edits follow from the end of the document
    // backwards; at one paragraph: insert after it, then delete it, then insert before it. No earlier command moves a later target.
    const commands: Command[] = sets.map(item => ({ type: 'replaceParagraph', target: target(item.paragraph.address), text: item.text!, expectedText: item.paragraph.text, preserveFormatting: true }));
    for (const item of styled) commands.push({ type: 'setParagraphStyle', target: target(item.paragraph.address), styleId: styleIds.get(item.style!)! });
    const rank = { insert_after: 0, delete: 1, insert_before: 2, set: 3 };
    // A new paragraph looks like its anchor: after it, the engine copies the anchor; before it, `like: 'next'` splits the anchor.
    // Text typed at the head of a paragraph with a field would enter the field, so there the paragraph before is copied as before.
    const withField = new Set(structural.some(item => item.action === 'insert_before')
      ? (await this.env.api.query.fields(epoch.path)).flatMap(field => field.address && !field.address.cellPath?.length ? [addressKey(field.address)] : []) : []);
    for (const item of [...structural].sort((a, b) => b.paragraph.address.section - a.paragraph.address.section || b.paragraph.address.paragraph - a.paragraph.address.paragraph
      || Number(!!b.paragraph.address.cellPath?.length) - Number(!!a.paragraph.address.cellPath?.length)
      || orderOf(b.paragraph.address) - orderOf(a.paragraph.address) || rank[a.action] - rank[b.action])) {
      const { section, paragraph: index } = item.paragraph.address;
      if (item.paragraph.address.cellPath?.length) {
        const address = target(item.paragraph.address), path = address.cellPath!, cellIndex = path.at(-1)!.cellParaIndex;
        if (item.action === 'delete') commands.push({ type: 'deleteParagraphAt', target: address });
        else {
          const lines = item.action === 'insert_after' ? [...item.lines!].reverse() : item.lines!;
          for (const [offset, value] of lines.entries()) {
            const anchor = structuredClone(address);
            if (item.action === 'insert_before') anchor.cellPath!.at(-1)!.cellParaIndex += offset;
            const changedAnchor = sets.find(set => set.target === item.target)?.text ?? item.paragraph.text;
            commands.push({ type: 'insertCellParagraph', target: anchor, position: item.action === 'insert_before' ? 'before' : 'after', text: value, expectedText: changedAnchor });
            if (item.style !== undefined) {
              const added = structuredClone(anchor);
              added.cellPath!.at(-1)!.cellParaIndex = cellIndex + (item.action === 'insert_before' ? offset : 1);
              commands.push({ type: 'setParagraphStyle', target: added, styleId: styleIds.get(item.style)! });
            }
          }
        }
        continue;
      }
      const like = item.action === 'insert_before' && !withField.has(addressKey(item.paragraph.address)) ? { like: 'next' as const } : {};
      if (item.action === 'delete') commands.push({ type: 'deleteParagraph', section, index });
      else item.lines!.forEach((text, offset) => {
        const at = index + offset + (item.action === 'insert_after' ? 1 : 0);
        commands.push({ type: 'insertParagraph', section, index: at, text, ...like });
        // The style lands on the new paragraph before any later command (always at or before this position) can move it.
        if (item.style !== undefined) commands.push({ type: 'setParagraphStyle', target: { section, paragraph: at }, styleId: styleIds.get(item.style)! });
      });
    }
    if (commands.length > MAX_COMMANDS) return fail('LIMIT_EXCEEDED', LT({ ko: () => `한 번에 낼 수 있는 편집 명령은 ${MAX_COMMANDS}개다. 나눠서 요청하라.`, en: () => `At most ${MAX_COMMANDS} edit commands per call. Split the request.` }), true, { limit: MAX_COMMANDS });
    if (ctx.signal?.aborted) return fail('CANCELLED', L({ ko: '편집이 취소됐다.', en: "Editing was cancelled." }), false);
    let applied: Receipt;
    try { applied = await this.execute(ctx, state, epoch, commands, [
      ...sets.map(item => ({ handle: item.target, before: clip(item.paragraph.text), after: clip(item.text!) })),
      ...structural.map(item => ({ handle: item.target, before: clip(item.paragraph.text), after: item.action === 'delete' ? L({ ko: '(문단 삭제)', en: "(paragraph deleted)" }) : clip(item.lines!.join('\n')) })),
    ]);
    } catch (error) {
      if (error instanceof PreviewReady) error.expectedTextLeadingSpaceAdjusted = expectedTextLeadingSpaceAdjusted;
      throw error;
    }
    this.last.set(epoch.path, { conversation: conversationOf(ctx.caller), sessionId: applied.sessionId, revision: applied.revision });
    const inserted = structural.reduce((sum, item) => sum + (item.lines?.length ?? 0), 0), deleted = structural.filter(item => item.action === 'delete').length;
    this.note(epoch.path, applied, source?.tool ?? 'edit_paragraphs', LT({ ko: () => `문단 ${sets.length}개 고침, ${inserted}개 넣음, ${deleted}개 지움${styled.length ? `, ${styled.length}개 스타일 지정` : ''}`, en: () => `Changed ${sets.length} paragraphs, inserted ${inserted}, deleted ${deleted}${styled.length ? `, styled ${styled.length}` : ''}` }));
    const changed = [
      ...sets.map(item => ({ handle: item.target, before: clip(item.paragraph.text), after: clip(item.text!) })),
      ...styled.filter(item => !sets.includes(item)).map(item => ({ handle: item.target, before: clip(item.paragraph.text), after: LT({ ko: () => `[스타일 ${item.style}] ${clip(item.paragraph.text)}`, en: () => `[Style ${item.style}] ${clip(item.paragraph.text)}` }) })),
      ...structural.map(item => item.action === 'delete'
        ? { handle: item.target, before: clip(item.paragraph.text), after: '' }
        : { handle: item.target, before: '', after: clip(item.lines!.join(' ⏎ ')) }),
    ];
    guard?.rewritten(sets.map(item => ({ paragraph: item.paragraph, after: item.text! })), applied.revision);
    const moves = structural.filter(item => !item.paragraph.address.cellPath?.length).map(item => ({ action: item.action as 'insert_after' | 'insert_before' | 'delete', index: item.paragraph.address.paragraph, count: item.lines?.length ?? 1 }));
    if (moves.length) guard?.restructured(moves, applied.revision);
    for (const container of new Set(cellStructural.map(item => containerOf(item.paragraph.address)))) {
      const group = cellStructural.filter(item => containerOf(item.paragraph.address) === container);
      guard?.cellRestructured(group[0].paragraph.address, group.map(item => ({ action: item.action as 'insert_after' | 'insert_before' | 'delete', index: orderOf(item.paragraph.address), count: item.lines?.length ?? 1 })), applied.revision);
    }
    // Structural operations are body paragraphs of one section; rewritten and new paragraphs are marked where they are after the edit.
    const section = structural[0]?.paragraph.address.section, sameSection = structural.every(item => item.paragraph.address.section === section);
    const moved = (address: BodyAddress): EditMark[] => {
      if (!structural.length || address.section !== section) return [{ address }];
      const paragraph = shiftedParagraph(address.paragraph, moves);
      return paragraph === undefined ? [] : [{ address: { ...address, paragraph } }];
    };
    if (cellStructural.length) this.env.marks?.clear(epoch.path);
    else if (!structural.length || sameSection) this.env.marks?.add(epoch.path, applied.sessionId, state.revision, applied.revision, [
      ...[...sets, ...styled].flatMap(item => moved(item.paragraph.address)),
      ...structural.flatMap(item => {
        const anchor = item.action === 'delete' ? undefined : shiftedParagraph(item.paragraph.address.paragraph, moves);
        return anchor === undefined ? [] : item.lines!.map((_, offset) => ({ address: { section: section, paragraph: item.action === 'insert_after' ? anchor + 1 + offset : anchor - item.lines!.length + offset } }));
      }),
    ], structural.length ? { section: section, changes: moves } : undefined);
    else this.env.marks?.clear(epoch.path);
    let observed: JsonObject = {};
    let continuation: Awaited<ReturnType<AgentEdits['nextHandles']>>;
    if (structural.length) this.env.expire(epoch.path); // Paragraph numbers moved: every handle and observation of this document is stale.
    else {
      this.env.advance(epoch, applied.revision);
      this.observations.advance(epoch, state.revision, applied.revision);
      observed = this.observations.record(ctx.caller, epoch, sets.map(item => ({ handle: item.target, address: item.paragraph.address, text: item.text!, full: Array.from(item.text!).length <= PREVIEW_CHARS })));
    }
    if (structural.length && !source) {
      const changesFor = (address: BodyAddress) => structural.filter(item => address.section === item.paragraph.address.section
        && containerOf(address) === containerOf(item.paragraph.address)).map(item => ({ action: item.action as 'insert_after' | 'insert_before' | 'delete', index: orderOf(item.paragraph.address), count: item.lines?.length ?? 1 }));
      const relocated = (address: BodyAddress): BodyAddress | undefined => {
        const rootMoves = structural.filter(item => !item.paragraph.address.cellPath?.length && item.paragraph.address.section === address.section)
          .map(item => ({ action: item.action as 'insert_after' | 'insert_before' | 'delete', index: item.paragraph.address.paragraph, count: item.lines?.length ?? 1 }));
        const paragraph = shiftedParagraph(address.paragraph, rootMoves);
        if (paragraph === undefined) return undefined;
        const moved = { ...structuredClone(address), paragraph };
        if (address.cellPath?.length) {
          const index = shiftedParagraph(orderOf(address), changesFor(address));
          if (index === undefined) return undefined;
          moved.cellPath!.at(-1)!.cellParaIndex = index;
        }
        return moved;
      };
      const selected = new Map<string, NextRole>();
      const select = (address: BodyAddress | undefined, role: NextRole) => { if (address) selected.set(addressKey(address), role); };
      for (const item of [...sets, ...styled]) select(relocated(item.paragraph.address), 'changed');
      for (const item of structural) {
        const address = item.paragraph.address, anchor = relocated(address);
        if (item.action === 'delete') {
          const siblings = all.filter(p => p.address.section === address.section && containerOf(p.address) === containerOf(address));
          const at = siblings.findIndex(p => addressKey(p.address) === addressKey(address));
          for (const [step, role] of [[-1, 'before'], [1, 'after']] as const) {
            for (let i = at + step; i >= 0 && i < siblings.length; i += step) {
              const survivor = relocated(siblings[i].address);
              if (survivor) { if (!selected.has(addressKey(survivor))) select(survivor, role); break; }
            }
          }
        } else if (anchor) for (let offset = 0; offset < item.lines!.length; offset++) {
          const added = structuredClone(anchor), index = orderOf(anchor) + (item.action === 'insert_after' ? 1 : -item.lines!.length) + offset;
          if (added.cellPath?.length) added.cellPath.at(-1)!.cellParaIndex = index;
          else added.paragraph = index;
          select(added, 'inserted');
        }
      }
      continuation = await this.nextHandles(ctx, epoch.path, applied, selected, true);
      observed = continuation?.observed ?? {};
    }
    const pages = applied.changedPages.map(page => page + 1);
    return {
      content: [{ type: 'text', text: LT({ ko: () => `문단 ${sets.length}개 고침, ${inserted}개 넣음, ${deleted}개 지움.${styled.length ? ` ${styled.length}개에 스타일 지정.` : ''}${structural.length ? continuation ? ' 핸들이 바뀌었다. 아래 새 핸들로 바로 이어서 편집할 수 있다. 다른 곳을 편집할 때만 다시 읽는다.' : ' 문단 번호가 바뀌었으니 계속 편집하려면 문서를 다시 읽어라.' : ''}${continuation ? this.nextLines(continuation.handles) : ''}`, en: () => `Changed ${sets.length} paragraphs, inserted ${inserted}, deleted ${deleted}.${styled.length ? ` Styled ${styled.length}.` : ''}${structural.length ? continuation ? ' Handles changed. Continue immediately with the new handles below; reread only to edit elsewhere.' : ' Paragraph numbers changed; reread the document before further editing.' : ''}${continuation ? this.nextLines(continuation.handles) : ''}` }) }],
      structuredContent: { ok: true, expectedTextLeadingSpaceAdjusted, changed: changed.slice(0, 20), inserted, deleted, changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo, ...(structural.length ? { handlesExpired: true } : {}), ...(continuation ? { next: { handles: continuation.handles } } : {}) },
      _meta: { ...receipt('yes', { revisionAfter: applied.revision, undo: { available: applied.canUndo, revision: applied.revision }, changedHandles: changed.map(item => item.handle), changedPages: pages.slice(0, 5000), operationId: operation }),
        'dev.agentinterop/changePreview': changed.slice(0, 50), ...observed },
    };
  }

  /** Optional continuation: failure to read a stable post-edit snapshot must never undo a successful edit. */
  private async nextHandles(ctx: CallerContext, path: string, applied: Receipt, selected: Map<string, NextRole>, neighbors = false): Promise<{ handles: NextHandle[]; observed: JsonObject } | undefined> {
    try {
      const { state, epoch } = await this.env.open(path, ctx.caller);
      const stable = (current: Pick<State, 'sessionId' | 'revision'>) => current.sessionId === applied.sessionId && current.revision === applied.revision;
      if (!stable(state)) return undefined;
      const snapshot = { ...epoch };
      const all = await this.env.api.query.paragraphs(path, { includeCells: true });
      const handles = await this.env.handles(epoch, all);
      const chosen = new Map(selected);
      if (neighbors) {
        const roots = all.filter(p => !p.address.cellPath?.length);
        const affected = new Set(all.filter(p => ['inserted', 'changed'].includes(selected.get(addressKey(p.address)) ?? '')).map(p => `${p.address.section}:${p.address.paragraph}`));
        for (let i = 0; i < roots.length; i++) if (affected.has(`${roots[i].address.section}:${roots[i].address.paragraph}`)) {
          for (const [index, role] of [[i - 1, 'before'], [i + 1, 'after']] as const) {
            const neighbor = roots[index];
            if (neighbor && !affected.has(`${neighbor.address.section}:${neighbor.address.paragraph}`) && !chosen.has(addressKey(neighbor.address))) chosen.set(addressKey(neighbor.address), role);
          }
        }
      }
      const shown = all.flatMap((paragraph, i) => {
        const role = chosen.get(addressKey(paragraph.address));
        return role ? [{ ...paragraph, handle: handles[i], role }] : [];
      }).slice(0, 12);
      const current = await this.env.open(path, ctx.caller);
      if (!stable(current.state) || current.epoch.id !== snapshot.id || epoch.revision !== snapshot.revision) return undefined;
      if (!shown.length) return undefined;
      return { handles: shown.map(p => ({ handle: p.handle, text: clip(p.text), role: p.role })),
        observed: this.observations.record(ctx.caller, epoch, shown.filter(p => Array.from(p.text).length <= PREVIEW_CHARS).map(p => ({ handle: p.handle, address: p.address, text: p.text }))) };
    } catch { return undefined; }
  }

  private nextLines(handles: NextHandle[]): string { return `\n${handles.map(item => `[${item.handle}] ${item.text}`).join('\n')}`; }

  private failer(receipt: Receipter, operation: string): Fail {
    return (code, message, retryable, extra = {}, meta = {}) => { throw new EditError(code, message, retryable, extra, { ...receipt('no', { operationId: operation }), ...meta }); };
  }
  private async rewriteParagraphs(args: JsonObject, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, guard?: SelectionGuard): Promise<ToolResult> {
    const operation = operationId([state.path, 'rewrite_paragraphs', args]), fail = this.failer(receipt, operation);
    const all = await this.env.api.query.paragraphs(epoch.path, { includeCells: true });
    const handles = await this.env.handles(epoch, all), byHandle = new Map(handles.map((handle, index) => [handle, all[index]]));
    const from = byHandle.get(args.from as string), to = byHandle.get(args.to as string);
    if (!from || !to || !(args.from as string).startsWith(`${epoch.id}:`) || !(args.to as string).startsWith(`${epoch.id}:`))
      return fail('HANDLE_EXPIRED', L({ ko: '본문 범위 핸들을 다시 읽어라.', en: "Reread the body range handles." }), true);
    if (from.address.cellPath?.length || to.address.cellPath?.length || from.address.section !== to.address.section || from.address.paragraph > to.address.paragraph)
      return fail('UNSUPPORTED_TARGET', L({ ko: '같은 구역의 순서대로 된 본문 문단 범위만 지원한다.', en: "Only ordered body paragraph ranges in the same section are supported." }), false);
    const section = from.address.section, root = all.filter(p => p.address.section === section && !p.address.cellPath?.length);
    const range = root.filter(p => p.address.paragraph >= from.address.paragraph && p.address.paragraph <= to.address.paragraph);
    if (range.length !== to.address.paragraph - from.address.paragraph + 1 || range.length > 80)
      return fail('LIMIT_EXCEEDED', L({ ko: '범위가 불완전하거나 80문단을 넘는다. 범위를 나누어라.', en: "The range is incomplete or exceeds 80 paragraphs. Split it." }), true, { item: 'range', limit: 80 });
    const tree = await this.env.api.query.tree(epoch.path);
    await this.unchanged(state, epoch, fail);
    const handleOf = (p: Paragraph) => handles[all.indexOf(p)];
    // eslint-disable-next-line no-control-regex -- HWP control characters mark protected paragraphs.
    const protectedAt = (p: Paragraph) => p.address.paragraph === 0 || /[\u0000-\u001f\u007f]/u.test(p.text)
      || tree.controls.some(c => addressKey(c.address) === addressKey(p.address) && !['secd', 'cold'].includes(c.ctrlId))
      || tree.fields.some(f => f.address && addressKey(f.address) === addressKey(p.address))
      || tree.objects.some(o => addressKey(o.address) === addressKey(p.address));
    const fixed = range.filter(protectedAt);
    if (fixed.length) return fail('PROTECTED_CONTENT', L({ ko: '개체·필드·강제 줄바꿈·구역 첫 문단을 제외하고 범위를 나누어라.', en: "Split the range around objects, fields, forced line breaks, and the section's first paragraph." }), false, { handles: fixed.map(handleOf) });
    const shown = this.observations.shown(ctx.caller, ctx.observations, state);
    const unseen = range.filter(p => shown.get(addressKey(p.address))?.get(p.text) !== true);
    if (unseen.length) return fail('OBSERVATION_REQUIRED', L({ ko: '범위의 모든 문단을 전체 읽은 뒤 다시 요청하라.', en: "Read all paragraphs in the range in full before requesting again." }), true, { handles: unseen.map(handleOf) });
    if (guard && range.some(p => !guard.whole(p.address))) return await this.outside(guard, epoch, fail, L({ ko: '문단 재작성 범위는', en: "The paragraph rewrite range" }));
    const source = range.filter(p => p.text !== ''), proposed = [...args.paragraphs as string[]];
    if (!source.length) return fail('UNSUPPORTED_TARGET', L({ ko: '서식 출처가 될 내용 문단이 없다.', en: "No content paragraph can serve as a formatting source." }), false);
    if (proposed.some(value => !value.trim() || control(value))) return fail('INVALID_ARGUMENT', L({ ko: '출력은 비어 있지 않고 제어 문자와 줄바꿈이 없는 논리 문단이어야 한다.', en: "Output must be nonempty logical paragraphs without control characters or line breaks." }), true);
    const inputs = source.map(p => ({ handle: handleOf(p), text: p.text })), hints = structuredClone((args.splitHints ?? []) as unknown as RewriteSplitHint[]);
    const calculate = async (request: RewriteComputeRequest): Promise<Extract<RewriteComputeResult, { ok: true }>> => {
      if (ctx.signal?.aborted) return fail('CANCELLED', L({ ko: '재작성이 취소됐다.', en: "Rewriting was cancelled." }), false);
      const result = this.env.rewriteCompute ? await this.env.rewriteCompute(request, ctx.signal) : computeRewrite(request);
      if (ctx.signal?.aborted) return fail('CANCELLED', L({ ko: '재작성이 취소됐다.', en: "Rewriting was cancelled." }), false);
      if (!result.ok) {
        const code = result.reason === 'delete' ? 'UNSUPPORTED_TARGET' : result.reason === 'limit' ? 'LIMIT_EXCEEDED' : result.reason === 'cancelled' ? 'CANCELLED' : 'INVALID_ARGUMENT';
        return fail(code, result.reason === 'delete' ? L({ ko: '삭제가 필요한 범위다. 후보 문단을 포함하거나 범위를 줄여라.', en: "This range requires deletion. Include the candidate paragraphs or narrow the range." }) : L({ ko: '문단 대응을 안전하게 계산하지 못했다. 범위나 분할 힌트를 확인하라.', en: "Could not safely align paragraphs. Check the range or split hints." }), result.reason !== 'cancelled', { reason: result.reason, ...result.details });
      }
      return result;
    };
    const first = await calculate({ kind: 'align', source: inputs, output: proposed, hints, steps: 0 });
    if (first.kind !== 'align') return fail('ENGINE_ERROR', L({ ko: '재작성 정렬 결과가 올바르지 않다.', en: "Invalid rewrite alignment result." }), false);
    const aligned = first.pairs; let steps = first.steps;
    const final = [...proposed], corrections: JsonObject[] = [];
    for (const pair of aligned) if (pair.source !== undefined && pair.kind !== 'unchanged') {
      const original = source[pair.source].text.match(/^ */)![0], index = pair.outputStart, supplied = final[index].match(/^ */)![0];
      if (original !== supplied) { final[index] = original + final[index].slice(supplied.length); corrections.push({ handle: inputs[pair.source].handle, output: index, before: supplied.length, after: original.length }); }
    }
    const textCommands: Command[] = [], structural: Array<{ index: number; commands: Command[]; count: number; before: boolean }> = [];
    const rows: JsonObject[] = [], changes: Change[] = [];
    let lastSource: number | undefined;
    for (const pair of aligned) {
      if (ctx.signal?.aborted) return fail('CANCELLED', L({ ko: '재작성이 취소됐다.', en: "Rewriting was cancelled." }), false);
      if (pair.kind === 'insert') {
        const before = lastSource === undefined, ref = source[lastSource ?? 0], index = ref.address.paragraph + (before ? 0 : 1);
        if (guard && !guard.insertion(ref.address, before)) return await this.outside(guard, epoch, fail, L({ ko: '새 문단 삽입은', en: "New paragraph insertion" }));
        const command: Command = { type: 'insertParagraph', section, index, text: final[pair.outputStart], ...(before ? { like: 'next' as const } : {}) };
        const existing = structural.find(item => item.index === index && item.before === before);
        if (existing) { existing.commands.unshift(command); existing.count++; } else structural.push({ index, commands: [command], count: 1, before });
        rows.push({ kind: 'insert', outputStart: pair.outputStart, outputEnd: pair.outputEnd, source: handleOf(ref), before: '', after: [final[pair.outputStart]] });
        changes.push({ handle: handleOf(ref), before: '', after: final[pair.outputStart] });
        continue;
      }
      const index = pair.source!, paragraph = source[index], values = final.slice(pair.outputStart, pair.outputEnd), joined = values.join('');
      lastSource = index;
      const diff = await calculate({ kind: 'diff', before: paragraph.text, after: joined, steps });
      if (diff.kind !== 'diff') return fail('ENGINE_ERROR', L({ ko: '재작성 diff 결과가 올바르지 않다.', en: "Invalid rewrite diff result." }), false);
      const hunks = diff.hunks; steps = diff.steps;
      rows.push({ kind: pair.kind, source: handleOf(paragraph), outputStart: pair.outputStart, outputEnd: pair.outputEnd, before: paragraph.text, after: values,
        hunks: hunks, ...(pair.lowSimilarityPair ? { lowSimilarityPair: true } : {}) });
      changes.push({ handle: handleOf(paragraph), before: paragraph.text, after: values.join('\n') });
      if (joined !== paragraph.text) textCommands.push({ type: 'replaceParagraph', target: target(paragraph.address), text: joined, expectedText: paragraph.text, rewriteFormatting: true, rewriteVersion: REWRITE_DIFF_VERSION });
      if (pair.kind === 'split') {
        const splits: Command[] = []; let offset = 0;
        for (const value of values.slice(0, -1)) { offset += Array.from(value).length; splits.unshift({ type: 'splitParagraph', target: target(paragraph.address), offset, verifyRewriteFormatting: true }); }
        structural.push({ index: paragraph.address.paragraph + 1, commands: splits, count: splits.length, before: false });
      }
    }
    const details: JsonObject = { algorithm: REWRITE_ALIGNMENT_VERSION, diffAlgorithm: REWRITE_DIFF_VERSION, pairs: rows, indentationAdjusted: corrections, emptyParagraphsPreserved: range.filter(p => p.text === '').map(handleOf), saved: false };
    const commands = [...textCommands, ...structural.sort((a, b) => b.index - a.index || Number(a.before) - Number(b.before) || Number(a.commands[0]?.type === 'splitParagraph') - Number(b.commands[0]?.type === 'splitParagraph')).flatMap(item => item.commands)];
    if (JSON.stringify({ details, changed: changes, changePreview: changes, operations: commands.map(command => command.type) }).length + 500 > 12000)
      return fail('LIMIT_EXCEEDED', L({ ko: '전체 변경안을 표시할 수 없다. 범위를 줄여라.', en: "Cannot display the entire proposed change. Narrow the range." }), true, { item: 'preview', limit: 12000 });
    if (commands.length > MAX_COMMANDS) return fail('LIMIT_EXCEEDED', L({ ko: '명령이 너무 많다. 범위를 줄여라.', en: "Too many commands. Narrow the range." }), true, { item: 'commands', limit: MAX_COMMANDS });
    if (!commands.length) return { content: [{ type: 'text', text: L({ ko: '변경할 내용이 없다.', en: "No changes to make." }) }], structuredContent: { ok: true, changed: changes, ...details, undoAvailable: false }, _meta: receipt('no', { operationId: operation }) };
    await this.unchanged(state, epoch, fail);
    const second = await calculate({ kind: 'align', source: inputs, output: proposed, hints, steps: 0 });
    if (second.kind !== 'align' || JSON.stringify(second.pairs) !== JSON.stringify(aligned)) return fail('REVISION_CONFLICT', L({ ko: '재계산 결과가 달라 편집하지 않았다.', en: "Recomputed result differs; nothing was edited." }), false);
    let repeatSteps = second.steps;
    for (const [i, pair] of second.pairs.entries()) if (pair.source !== undefined) {
      const recalculated = await calculate({ kind: 'diff', before: source[pair.source].text, after: final.slice(pair.outputStart, pair.outputEnd).join(''), steps: repeatSteps });
      if (recalculated.kind !== 'diff' || JSON.stringify(recalculated.hunks) !== JSON.stringify(rows[i].hunks)) return fail('REVISION_CONFLICT', L({ ko: '재계산 결과가 달라 편집하지 않았다.', en: "Recomputed result differs; nothing was edited." }), false);
      repeatSteps = recalculated.steps;
    }
    await this.unchanged(state, epoch, fail);
    let applied: Receipt;
    try { applied = await this.execute(ctx, state, epoch, commands, changes, L({ ko: '문단 재작성', en: "Paragraph rewrite" })); }
    catch (error) { if (error instanceof PreviewReady) error.rewriteDetails = details; throw error; }
    this.last.set(epoch.path, { conversation: conversationOf(ctx.caller), sessionId: applied.sessionId, revision: applied.revision });
    this.note(epoch.path, applied, 'rewrite_paragraphs', LT({ ko: () => `문단 재작성 ${rows.length}건`, en: () => `${rows.length} paragraph rewrites` }));
    const moves = structural.map(item => ({ action: item.before ? 'insert_before' as const : 'insert_after' as const, index: item.before ? item.index : item.index - 1, count: item.count }));
    guard?.rewritten(aligned.flatMap(pair => pair.source === undefined ? [] : [{ paragraph: source[pair.source], after: final.slice(pair.outputStart, pair.outputEnd).join('') }]), applied.revision);
    if (moves.length) guard?.restructured(moves, applied.revision);
    const marks = aligned.filter(pair => pair.source !== undefined).map(pair => ({ address: { section, paragraph: shiftedParagraph(source[pair.source!].address.paragraph, moves) ?? 0 } }));
    this.env.marks?.add(epoch.path, applied.sessionId, state.revision, applied.revision, marks, moves.length ? { section, changes: moves } : undefined);
    let observed: JsonObject = {};
    if (moves.length) this.env.expire(epoch.path);
    else { this.env.advance(epoch, applied.revision); this.observations.advance(epoch, state.revision, applied.revision); observed = this.observations.record(ctx.caller, epoch, aligned.flatMap(pair => pair.source === undefined ? [] : [{ handle: inputs[pair.source].handle, address: source[pair.source].address, text: final[pair.outputStart], full: Array.from(final[pair.outputStart]).length <= PREVIEW_CHARS }])); }
    const pages = applied.changedPages.map(page => page + 1);
    return { content: [{ type: 'text', text: L({ ko: '문단 재작성을 작업본에 적용했다. 저장은 별도이며 한 번에 되돌릴 수 있다.', en: "Applied paragraph rewriting to the working copy. Saving is separate; it can be undone in one step." }) }],
      structuredContent: { ok: true, changed: changes, ...details, handlesExpired: !!moves.length, undoAvailable: applied.canUndo, changedPages: pages.slice(0, 50) },
      _meta: { ...receipt('yes', { revisionAfter: applied.revision, undo: { available: applied.canUndo, revision: applied.revision }, changedHandles: changes.map(change => change.handle), changedPages: pages.slice(0, 5000), operationId: operation }), 'dev.agentinterop/changePreview': changes, ...observed } };
  }
  private async notes(args: JsonObject, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, guard?: SelectionGuard): Promise<ToolResult> {
    const operation = operationId([state.path, 'edit_notes', args]), fail = this.failer(receipt, operation);
    const handle = args.target as string;
    if (!handle.startsWith(`${epoch.id}:`)) return fail('HANDLE_EXPIRED', L({ ko: '각주·미주를 다시 읽고 현재 핸들을 사용하라.', en: "Reread footnotes/endnotes and use current handles." }), true, inputAt('target'));
    const shown = this.observations.shown(ctx.caller, ctx.observations, state);
    let commands: Command[], changed: Change[], summary: string;
    if (args.action === 'insert') {
      const paragraphs = await this.env.api.query.paragraphs(epoch.path), handles = await this.env.handles(epoch, paragraphs);
      const paragraph = paragraphs[handles.indexOf(handle)];
      if (!paragraph || paragraph.address.cellPath?.length) return fail('UNSUPPORTED_TARGET', L({ ko: '각주·미주는 본문 문단에만 넣는다. 중첩 앵커는 지원하지 않는다.', en: "Footnotes/endnotes can only be inserted in body paragraphs. Nested anchors are unsupported." }), false, inputAt('target'));
      const offset = args.offset as number;
      if (offset > paragraph.length) return fail('INVALID_ARGUMENT', L({ ko: 'offset이 문단 길이를 넘었다.', en: "offset exceeds paragraph length." }), true,
        { path: 'offset', rule: 'range', allowed: { minimum: 0, maximum: paragraph.length }, suggestion: L({ ko: '본문을 다시 읽고 위치를 지정하라.', en: "Reread the body and specify a position." }) });
      if (guard && !guard.whole(paragraph.address)) return await this.outside(guard, epoch, fail, L({ ko: '각주·미주 삽입은', en: "Footnote/endnote insertion" }));
      if (shown.get(addressKey(paragraph.address))?.get(paragraph.text) !== true) return fail('OBSERVATION_REQUIRED', L({ ko: '각주를 넣을 본문 문단 전체를 read_document로 먼저 읽어라.', en: "First read the entire body anchor paragraph with read_document." }), true);
      const tree = await this.env.api.query.tree(epoch.path);
      const at = (address: BodyAddress | undefined): boolean => !!address && addressKey(address) === addressKey(paragraph.address);
      if (tree.fields.some(f => at(f.address)) || tree.objects.some(o => at(o.address)) || tree.controls.some(c => at(c.address) && !['secd', 'cold', 'pghd'].includes(c.ctrlId)))
        return fail('PROTECTED_CONTENT', L({ ko: '누름틀·개체·기존 각주 앵커가 있는 문단에 새 각주를 넣지 않는다. 사람이 위치를 확인해야 한다.', en: "Cannot insert a note into a paragraph containing input fields, objects, or an existing note anchor. A person must check the position." }), false);
      commands = [{ type: 'insertNote', kind: args.kind as NoteStory['kind'], target: target(paragraph.address), offset }];
      summary = LT({ ko: () => `${args.kind === 'footnote' ? '각주' : '미주'} 삽입`, en: () => `Insert ${args.kind === 'footnote' ? 'footnote' : 'endnote'}` });
      changed = [{ handle, before: clip(paragraph.text), after: L({ ko: '(빈 각주·미주 추가; notes로 재조회)', en: "(Empty footnote/endnote added; reread with notes)" }) }];
    } else {
      let note: NoteStory | undefined;
      for (let offset = 0; ; offset += 500) {
        const page = await this.env.api.query.structure(epoch.path, { collection: 'stories', offset, limit: 500 });
        if (page.collection !== 'stories') return fail('ENGINE_ERROR', L({ ko: '각주·미주 목록을 읽지 못했다.', en: "Could not read the footnote/endnote list." }), false);
        if (page.state.sessionId !== state.sessionId || page.state.revision !== state.revision) return fail('REVISION_CONFLICT', L({ ko: '각주를 읽는 사이 문서가 바뀌었다.', en: "The document changed while reading notes." }), true);
        note = page.items.find((s): s is NoteStory => (s.kind === 'footnote' || s.kind === 'endnote') && handle.startsWith(`${noteHandle(epoch, s)}.p`));
        if (note || offset + page.items.length >= page.total) break;
      }
      if (!note || note.availability !== 'available' || note.anchor.cellPath?.length) return fail('UNSUPPORTED_TARGET', L({ ko: '본문 앵커의 각주·미주 문단만 지원한다. 중첩 앵커는 지원하지 않는다.', en: "Only note paragraphs with body anchors are supported. Nested anchors are unsupported." }), false, inputAt('target'));
      const paragraph = note.paragraphs.find(p => `${noteHandle(epoch, note)}.p${p.address.paragraph + 1}` === handle);
      if (!paragraph || (paragraph.address.kind !== 'footnote' && paragraph.address.kind !== 'endnote')) return fail('HANDLE_EXPIRED', L({ ko: '각주·미주 문단 핸들이 없다. 다시 읽어라.', en: "No footnote/endnote paragraph handle. Reread." }), true, inputAt('target'));
      if (guard && !guard.whole(note.anchor)) return await this.outside(guard, epoch, fail, L({ ko: '각주·미주 편집은', en: "Footnote/endnote editing" }));
      if (note.paragraphs.some(p => shown.get(noteParagraphKey(p.address as NoteAddress))?.get(p.text) !== true))
        return fail('OBSERVATION_REQUIRED', L({ ko: 'read_document(mode=notes)로 각주·미주 전체를 읽어야 한다. 검색 문맥이나 잘린 조회만으로 편집하지 않는다.', en: "Read the entire note with read_document(mode=notes). Search context or truncated reads are insufficient for editing." }), true);
      const text = args.text as string, after = paragraph.text + text;
      commands = [
        { type: 'insertText', target: paragraph.address, offset: paragraph.length, text },
        // Native note offsets have differed around the first paragraph's auto-number/tab.
        // Assert the exact result inside the transaction so an offset regression rolls back.
        { type: 'replaceParagraph', target: paragraph.address, expectedText: after, text: after },
      ];
      summary = LT({ ko: () => `${note.kind === 'footnote' ? '각주' : '미주'} 끝에 텍스트 추가`, en: () => `Append text to ${note.kind === 'footnote' ? 'footnote' : 'endnote'}` });
      changed = [{ handle, before: clip(paragraph.text), after: clip(after) }];
    }
    await this.unchanged(state, epoch, fail);
    const { applied, pages, meta } = await this.commit('edit_notes', ctx, state, epoch, receipt, operation, commands, changed, { structural: true, summary });
    // Inserting a body anchor can change offsets. A selected turn must be captured again.
    if (args.action === 'append') guard?.kept(applied.revision);
    this.env.marks?.clear(epoch.path);
    return { content: [{ type: 'text', text: LT({ ko: () => `${summary}. 계속 편집하려면 문서를 다시 읽어라. 문자 서식의 엄격 보존은 미지원이다.`, en: () => `${summary}. Reread the document before further editing. Strict character formatting preservation is unsupported.` }) }],
      structuredContent: { ok: true, handlesExpired: true, undoAvailable: applied.canUndo, changedPages: pages.slice(0, 50), characterFormatting: 'unsupported' }, _meta: meta };
  }
  private note(path: string, applied: State, tool: string, summary: string): void {
    const list = this.log.get(path) ?? [];
    list.push({ sessionId: applied.sessionId, revision: applied.revision, tool, summary });
    if (list.length > MAX_LOG) list.shift();
    this.log.set(path, list);
  }
  private async styles(args: JsonObject, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, guard?: SelectionGuard): Promise<ToolResult> {
    const operation = operationId([state.path, 'edit_styles', args]), fail = this.failer(receipt, operation);
    if (guard) return fail('OUTSIDE_SELECTION', L({ ko: '스타일 정의는 문서 전체의 설정이다. 선택 범위를 문서 전체 권한으로 확대하지 않는다. 적용은 format_text의 style을 사용하라.', en: "Style definitions affect the entire document. Do not expand selection authority to the whole document. Apply using format_text style." }), false);
    const model = await this.env.api.query.formatting(epoch.path, { pages: [], runs: 'model' });
    await this.unchanged(state, epoch, fail);
    const name = typeof args.name === 'string' ? args.name.trim() : undefined;
    const characterProperties = args.character as CharacterFormatProperties | undefined, raw = args.paragraph as JsonObject | undefined;
    const paragraphProperties: ParagraphFormatProperties | undefined = raw ? {
      ...(raw.alignment === undefined ? {} : { alignment: raw.alignment as ParagraphFormatProperties['alignment'] }),
      ...(raw.lineSpacingPercent === undefined ? {} : { lineSpacing: Math.round(raw.lineSpacingPercent as number), lineSpacingType: 'Percent' as const }),
    } : undefined;
    let command: Command, label: string;
    if (args.action === 'create') {
      if (model.styles.some(s => s.name === name)) return fail('AMBIGUOUS_MATCH', L({ ko: '같은 이름의 스타일이 이미 있어 새로 만들지 않았다.', en: "A style with the same name already exists; none was created." }), true, { path: 'name', rule: 'unique style name', suggestion: L({ ko: 'styles를 조회하고 기존 정의를 선택하거나 다른 이름을 지정하라.', en: "Query styles and select an existing definition or specify another name." }) });
      command = { type: 'createStyle', name: name!, kind: 'paragraph', ...(characterProperties ? { characterProperties } : {}), ...(paragraphProperties ? { paragraphProperties } : {}) };
      label = LT({ ko: () => `문단 스타일 "${name}" 생성`, en: () => `Create paragraph style "${name}"` });
    } else {
      const handle = args.target as string;
      if (!handle.startsWith(`${epoch.id}:`)) return fail('HANDLE_EXPIRED', L({ ko: '스타일을 다시 조회하고 현재 핸들을 사용하라.', en: "Query styles again and use a current handle." }), true, inputAt('target'));
      const style = model.styles.find(s => `${epoch.id}:style${s.id}` === handle);
      if (!style || style.type !== 0) return fail('UNSUPPORTED_TARGET', L({ ko: '현재 문단 스타일 핸들이 필요하다. 문자 스타일 패치는 지원하지 않는다.', en: "A current paragraph style handle is required. Character style patching is unsupported." }), false, inputAt('target'));
      if (name !== undefined && model.styles.some(s => s.id !== style.id && s.name === name)) return fail('AMBIGUOUS_MATCH', L({ ko: '같은 이름의 다른 스타일이 있다. 임의로 합치지 않는다.', en: "Another style has the same name. Styles are not merged arbitrarily." }), true, { path: 'name', rule: 'unique style name', suggestion: L({ ko: '다른 이름을 지정하라.', en: "Specify another name." }) });
      const seen = this.observations.shown(ctx.caller, ctx.observations, state);
      if (seen.get(styleKey(style.id))?.get(styleText(style)) !== true) return fail('OBSERVATION_REQUIRED', L({ ko: 'read_document(mode=styles)로 변경할 정의 전체를 먼저 읽어라.', en: "First read the entire definition with read_document(mode=styles)." }), true);
      // The core cannot identify style use in every story/nested container. A global patch
      // must not silently reformat content whose style use or text was never observed.
      if (model.paragraphs.some(p => p.address.kind !== 'body' || p.address.containerKinds?.includes('textBox') || (p.address.kind === 'body' && (p.address.cellPath?.length ?? 0) > 1) || !p.style))
        return fail('UNSUPPORTED_TARGET', L({ ko: 'story·중첩 컨테이너의 스타일 사용 여부를 완전히 확인할 수 없어 전역 정의를 변경하지 않았다.', en: "Could not fully verify style usage in stories/nested containers; the global definition was not changed." }), false);
      const paragraphs = await this.env.api.query.paragraphs(epoch.path, { includeCells: true });
      const affected = model.paragraphs.filter(p => p.style?.id === style.id);
      if (affected.some(p => {
        const paragraph = paragraphs.find(item => addressKey(item.address) === addressKey(p.address as BodyAddress));
        return !paragraph || seen.get(addressKey(paragraph.address))?.get(paragraph.text) !== true;
      })) return fail('OBSERVATION_REQUIRED', L({ ko: '이 스타일을 쓰는 모든 본문·표 문단을 전체 조회한 뒤 패치하라.', en: "Fully read all body/table paragraphs using this style before patching." }), true, { affectedParagraphs: affected.length });
      command = { type: 'updateStyle', styleId: style.id, ...(name !== undefined ? { name } : {}), ...(characterProperties ? { characterProperties } : {}), ...(paragraphProperties ? { paragraphProperties } : {}) };
      label = LT({ ko: () => `문단 스타일 "${style.name}" 패치`, en: () => `Patch paragraph style "${style.name}"` });
    }
    await this.unchanged(state, epoch, fail);
    const { applied, pages, meta } = await this.commit('edit_styles', ctx, state, epoch, receipt, operation, [command], [], { structural: true, summary: label });
    this.env.marks?.clear(epoch.path);
    return { content: [{ type: 'text', text: LT({ ko: () => `${label}. 적용하거나 계속 편집하려면 다시 조회하라.`, en: () => `${label}. Query again before applying or continuing to edit.` }) }],
      structuredContent: { ok: true, handlesExpired: true, undoAvailable: applied.canUndo, changedPages: pages.slice(0, 50) }, _meta: meta };
  }
  private async section(args: JsonObject, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, guard?: SelectionGuard): Promise<ToolResult> {
    const operation = operationId([state.path, 'update_section', args]), fail = this.failer(receipt, operation), handle = args.target as string;
    if (!handle.startsWith(`${epoch.id}:`)) return fail('HANDLE_EXPIRED', L({ ko: 'sections로 현재 구역 핸들을 다시 읽어라.', en: "Reread current section handles with sections." }), true, inputAt('target'));
    const model = await this.env.api.query.formatting(epoch.path, { pages: [] }), tree = await this.env.api.query.tree(epoch.path);
    await this.unchanged(state, epoch, fail);
    const section = model.sections.find(s => `${epoch.id}:section${s.section + 1}` === handle);
    if (!section) return fail('UNSUPPORTED_TARGET', L({ ko: 'sections가 준 구역 핸들이 필요하다.', en: "A section handle from sections is required." }), false, inputAt('target'));
    const seen = this.observations.shown(ctx.caller, ctx.observations, state), view = sectionView(section, tree.stories);
    if (seen.get(sectionKey(section.section))?.get(JSON.stringify(view)) !== true) return fail('OBSERVATION_REQUIRED', L({ ko: 'sections로 해당 구역의 설정과 머리말·꼬리말을 전체 조회하라.', en: "Fully read section settings and headers/footers with sections." }), true);
    const roots = tree.sections[section.section].paragraphs;
    if (guard && roots.some(p => !guard.whole(p.address))) return await this.outside(guard, epoch, fail, L({ ko: '구역 설정 변경은', en: "Section settings change" }));
    const paragraphs = await this.env.api.query.paragraphs(epoch.path, { includeCells: true });
    if (paragraphs.filter(p => p.address.section === section.section).some(p => seen.get(addressKey(p.address))?.get(p.text) !== true))
      return fail('OBSERVATION_REQUIRED', L({ ko: '영향받는 구역의 본문·표 전체를 먼저 조회하라.', en: "First read the entire body and tables of the affected section." }), true);
    let command: Command;
    if (args.page !== undefined) {
      const page = args.page as JsonObject, properties: PageSettingsProperties = {};
      for (const [key, value] of Object.entries(page)) {
        if (key.endsWith('Mm')) (properties as Record<string, Json>)[key.slice(0, -2)] = Math.round((value as number) * 7200 / 25.4);
        else (properties as Record<string, Json>)[key] = value;
      }
      command = { type: 'setPageSettings', section: section.section, properties };
    } else if (args.definition !== undefined) command = { type: 'setSectionDefinition', section: section.section, properties: args.definition as SectionDefinitionProperties };
    else {
      const header = args.header as JsonObject, isHeader = header.kind === 'header', applyTo = ({ both: 0, even: 1, odd: 2 } as const)[header.applyTo as 'both' | 'even' | 'odd'];
      if (tree.stories.some(s => s.kind === 'headerFooter' && s.section === section.section && s.isHeader === isHeader && s.applyTo === applyTo))
        return fail('PROTECTED_CONTENT', L({ ko: '이 적용 쪽 종류에는 이미 머리말·꼬리말이 있다. 내부 개체를 완전히 관측할 수 없어 덮어쓰거나 삭제하지 않는다.', en: "A header/footer already exists for this page type. Internal objects cannot be fully observed, so it is neither overwritten nor deleted." }), false, inputAt('header.applyTo'));
      command = { type: 'applyHeaderFooterTemplate', section: section.section, isHeader, applyTo, templateId: header.templateId as number };
    }
    await this.unchanged(state, epoch, fail);
    const { applied, pages, meta } = await this.commit('update_section', ctx, state, epoch, receipt, operation, [command], [], { structural: true, summary: LT({ ko: () => `${handle} 구역 설정 변경`, en: () => `Change ${handle} section settings` }) });
    guard?.kept(applied.revision); this.env.marks?.clear(epoch.path);
    return { content: [{ type: 'text', text: LT({ ko: () => `${handle} 구역 설정을 변경했다. 계속 편집하려면 다시 읽어라.`, en: () => `Changed ${handle} section settings. Reread before continuing to edit.` }) }],
      structuredContent: { ok: true, handlesExpired: true, undoAvailable: applied.canUndo, changedPages: pages.slice(0, 50) }, _meta: meta };
  }
  private async unchanged(state: State, epoch: EditEpoch, fail: Fail): Promise<void> {
    const current = await this.env.api.documents.state(epoch.path);
    if (current.sessionId !== state.sessionId || current.revision !== state.revision) fail('REVISION_CONFLICT', L({ ko: '읽는 사이 문서가 바뀌었다. 다시 시도하라.', en: "The document changed during reading. Try again." }), true);
  }
  /** Id of the one paragraph style with exactly this name. */
  private async styleId(epoch: EditEpoch, name: string, fail: Fail, path: string): Promise<number> {
    const styles = (await this.env.api.query.formatting(epoch.path, { pages: [] })).styles.filter(style => style.type === 0);
    const found = styles.filter(style => style.name === name);
    if (found.length !== 1) return fail('STYLE_NOT_FOUND', LT({ ko: () => `"${name}"라는 문단 스타일이 ${found.length ? '여러 개 있다' : '없다'}. 바꾸지 않았다.`, en: () => `There ${found.length ? 'are multiple paragraph styles' : 'is no paragraph style'} named "${name}". Nothing was changed.` }), true, inputAt(path, { styles: styles.map(style => style.name).slice(0, MAX_NAMES) }));
    return found[0].id;
  }
  /** One transaction for the whole call. `structural` edits move addresses, so every handle and observation of the document expires. */
  private async commit(tool: string, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, operation: string, commands: Command[], changed: Change[],
    options: { structural?: boolean; observed?: Shown[]; summary: string; marks?: EditMark[]; moved?: { section: number; changes: Array<{ action: 'insert_after' | 'insert_before' | 'delete'; index: number; count: number }> } }): Promise<{ applied: Receipt; pages: number[]; meta: JsonObject }> {
    const fail = this.failer(receipt, operation);
    if (commands.length > MAX_COMMANDS) fail('LIMIT_EXCEEDED', LT({ ko: () => `한 번에 낼 수 있는 편집 명령은 ${MAX_COMMANDS}개다. 나눠서 요청하라.`, en: () => `At most ${MAX_COMMANDS} edit commands per call. Split the request.` }), true, { limit: MAX_COMMANDS });
    if (ctx.signal?.aborted) fail('CANCELLED', L({ ko: '편집이 취소됐다.', en: "Editing was cancelled." }), false);
    const applied = await this.execute(ctx, state, epoch, commands, changed, options.summary);
    this.last.set(epoch.path, { conversation: conversationOf(ctx.caller), sessionId: applied.sessionId, revision: applied.revision });
    this.note(epoch.path, applied, tool, options.summary);
    this.env.marks?.add(epoch.path, applied.sessionId, state.revision, applied.revision, options.marks ?? [], options.moved);
    let observed: JsonObject = {};
    if (options.structural) this.env.expire(epoch.path);
    else {
      this.env.advance(epoch, applied.revision);
      this.observations.advance(epoch, state.revision, applied.revision);
      observed = this.observations.record(ctx.caller, epoch, options.observed ?? []);
    }
    const pages = applied.changedPages.map(page => page + 1);
    return { applied, pages, meta: {
      ...receipt('yes', { revisionAfter: applied.revision, undo: { available: applied.canUndo, revision: applied.revision }, changedHandles: changed.map(item => item.handle).slice(0, 1000), changedPages: pages.slice(0, 5000), operationId: operation }),
      ...(options.structural ? {} : { 'dev.agentinterop/resource': { path: epoch.path, sessionId: epoch.sessionId, documentEpoch: epoch.id, revision: applied.revision } }),
      'dev.agentinterop/changePreview': changed.slice(0, 50), ...observed } };
  }

  /**
   * A field is named, or addressed by its place in the field list (`d…:f3`) when several fields share a name.
   * All values land in one transaction: named ones as one command each, placed ones as one atomic command.
   */
  private async fields(args: JsonObject, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, guard?: SelectionGuard): Promise<ToolResult> {
    const operation = operationId([state.path, 'fill_fields', args.values ?? null]), fail = this.failer(receipt, operation);
    const list = args.values;
    if (!Array.isArray(list) || !list.length || list.length > MAX_FIELDS) return fail('INVALID_ARGUMENT', LT({ ko: () => `values는 1~${MAX_FIELDS}개의 배열이어야 한다.`, en: () => `values must be an array of 1–${MAX_FIELDS} items.` }), true, inputAt('values', { allowed: { minItems: 1, maxItems: MAX_FIELDS } }));
    const values = list.map((raw, index) => {
      const item = record(raw), name = item.field, value = item.value;
      if (typeof name !== 'string' || !name.length || control(name) || control(value)) return fail('INVALID_ARGUMENT', LT({ ko: () => `values[${index}]: field는 누름틀 이름이나 누름틀 핸들, value는 줄바꿈 없는 문자열이다.`, en: () => `values[${index}]: field is an input field name or handle; value is a string without line breaks.` }), true,
        inputAt(`values[${index}].${typeof name !== 'string' || !name.length || control(name) ? 'field' : 'value'}`));
      return { name, value: value as string, at: `values[${index}].field` };
    });
    const all = await this.env.api.query.fields(epoch.path);
    await this.unchanged(state, epoch, fail);
    const names = [...new Set(all.filter(isInputField).map(field => field.name))].slice(0, MAX_NAMES);
    const placeHandle = (place: number): string => `${epoch.id}:f${place + 1}`;
    const resolved: Array<{ name: string; value: string; at: string; place: number; byPlace: boolean; handle: string; key: string }> = [];
    for (const item of values) {
      const placed = item.name.startsWith(`${epoch.id}:`) ? /^[^:]+:f(\d+)$/.exec(item.name) : null;
      if (placed) {
        const place = Number(placed[1]) - 1;
        if (!all[place]) return fail('HANDLE_EXPIRED', LT({ ko: () => `${item.name}이라는 누름틀이 없다. 채우지 않았다.`, en: () => `No input field named ${item.name}. Nothing was filled.` }), true, inputAt(item.at, { fields: names }));
        // A hyperlink, date or other field shares the place numbering; writing its value would rewrite its display text.
        const kind = typeof all[place].fieldType === 'string' ? all[place].fieldType : null;
        if (!isInputField(all[place])) return fail('UNSUPPORTED_TARGET', LT({ ko: () => `${item.name}은 누름틀이 아니라 ${kind ?? '다른'} 필드다. fill_fields는 누름틀만 채운다.`, en: () => `${item.name} is a ${kind ?? 'different'} field, not an input field. fill_fields only fills input fields.` }), false,
          inputAt(item.at, { rule: 'input field only', fieldType: kind }));
        resolved.push({ ...item, place, byPlace: true, handle: item.name, key: fieldPlaceKey(place) });
        continue;
      }
      if (item.name.startsWith(`${epoch.id}:`)) return fail('UNSUPPORTED_TARGET', LT({ ko: () => `${item.name}은 누름틀 핸들이 아니다. 누름틀은 이름이나 누름틀 핸들(${epoch.id}:f1)로 지정한다.`, en: () => `${item.name} is not an input field handle. Specify a name or input field handle (${epoch.id}:f1).` }), false, inputAt(item.at));
      const found = all.flatMap((field, place) => field.name === item.name && isInputField(field) ? [place] : []);
      if (!found.length) return fail('FIELD_NOT_FOUND', LT({ ko: () => `"${item.name}"라는 누름틀이 없다. 채우지 않았다.`, en: () => `No input field named "${item.name}". Nothing was filled.` }), true, inputAt(item.at, { fields: names }));
      if (found.length > 1) {
        // The candidates come with the paragraph each one sits in, and count as shown: the next request can name one by its handle.
        const texts = new Map((await this.env.api.query.paragraphs(epoch.path, { includeCells: true })).map(paragraph => [addressKey(paragraph.address), paragraph.text]));
        const candidates = found.slice(0, MAX_CANDIDATES * 4).map(place => ({ handle: placeHandle(place), value: clip(all[place].value), context: clip(all[place].address ? texts.get(addressKey(all[place].address)) ?? '' : '') }));
        return fail('AMBIGUOUS_MATCH', LT({ ko: () => `"${item.name}"라는 누름틀이 ${found.length}개라 채우지 않았다. 아래 후보 가운데 채울 누름틀의 핸들을 field에 줘라.`, en: () => `${found.length} input fields are named "${item.name}"; nothing was filled. Supply the desired candidate handle as field.` }), true, inputAt(item.at, { total: found.length, candidates }),
          this.observations.record(ctx.caller, epoch, found.slice(0, MAX_CANDIDATES * 4).map(place => ({ handle: placeHandle(place), key: fieldPlaceKey(place), text: all[place].value }))));
      }
      // The engine's by-name write sees every field kind; when another kind shares the name, write by place instead.
      const shared = all.some(field => field.name === item.name && !isInputField(field));
      resolved.push({ ...item, place: found[0], byPlace: shared, handle: `${epoch.id}:f:${item.name}`, key: fieldKey(item.name) });
    }
    const repeated = resolved.find((item, index) => resolved.findIndex(other => other.place === item.place) !== index);
    if (repeated) return fail('INVALID_ARGUMENT', L({ ko: '같은 누름틀을 두 번 지정했다.', en: "The same input field was specified twice." }), true, inputAt(repeated.at, { rule: 'one value per field' }));
    const fieldOf = (item: { place: number }) => all[item.place];
    // A field value has no offsets here, so its paragraph must be selected whole.
    for (const item of guard ? resolved : []) if (!fieldOf(item).address || !guard!.whole(fieldOf(item).address!)) return await this.outside(guard!, epoch, fail, LT({ ko: () => `누름틀 "${fieldOf(item).name}"은`, en: () => `Input field "${fieldOf(item).name}"` }));
    const shown = this.observations.shown(ctx.caller, ctx.observations, state);
    const unseen = resolved.filter(item => shown.get(item.key)?.get(fieldOf(item).value) !== true);
    if (unseen.length) return fail('OBSERVATION_REQUIRED', L({ ko: '아직 적용되지 않았다. 채우려는 누름틀의 지금 값을 아래에 보여 주었다. 요청과 맞으면 같은 호출을 다시 보내면 적용된다.', en: "Not applied yet. Current target input field values are shown below. If they match the request, send the same call again to apply." }), true,
      { fields: unseen.map(item => ({ field: item.name, value: fieldOf(item).value })), suggestion: observedRetrySuggestion() },
      this.observations.record(ctx.caller, epoch, unseen.map(item => ({ handle: item.handle, key: item.key, text: fieldOf(item).value }))));
    const edits = resolved.filter(item => item.value !== fieldOf(item).value);
    if (!edits.length) return { content: [{ type: 'text', text: L({ ko: '누름틀이 이미 같은 값이다. 바꾼 것이 없다.', en: "Input fields already have the same values. Nothing changed." }) }], structuredContent: { ok: true, changed: [], undoAvailable: false }, _meta: receipt('no', { operationId: operation }) };
    const changed = edits.map(item => ({ handle: item.handle, before: clip(fieldOf(item).value), after: clip(item.value) }));
    // Named fields: the engine looks each name up again per command, so an earlier value cannot misdirect a later one.
    // Placed fields: one command that finds every field again by its place before it writes.
    const duplicateIds = edits.some(item => all.filter(field => field.fieldId === fieldOf(item).fieldId).length > 1);
    const commands: Command[] = duplicateIds
      ? [{ type: 'setFieldsAt', sessionId: state.sessionId, revision: state.revision, values: edits.map(item => ({ index: item.place, fieldId: fieldOf(item).fieldId, name: fieldOf(item).name, expectedValue: fieldOf(item).value, value: item.value })), normalizeFormAnswer: true }]
      : edits.some(item => item.byPlace)
      ? [{ type: 'setFields', sessionId: state.sessionId, revision: state.revision, values: edits.map(item => ({ fieldId: fieldOf(item).fieldId, value: item.value })), normalizeFormAnswer: true }]
      : edits.map(item => ({ type: 'setField', name: item.name, value: item.value, normalizeFormAnswer: true }));
    const { applied, pages, meta } = await this.commit('fill_fields', ctx, state, epoch, receipt, operation, commands, changed,
      { summary: LT({ ko: () => `누름틀 ${edits.length}개 채움`, en: () => `Filled ${edits.length} input fields` }), observed: edits.map(item => ({ handle: item.handle, key: item.key, text: item.value })),
        marks: edits.flatMap(item => fieldOf(item).address ? [{ address: fieldOf(item).address! }] : []) });
    guard?.kept(applied.revision);
    return { content: [{ type: 'text', text: LT({ ko: () => `누름틀 ${edits.length}개 채움: ${edits.map(item => fieldOf(item).name).slice(0, 10).join(', ')}${edits.length > 10 ? ' 등' : ''}.`, en: () => `Filled ${edits.length} input fields: ${edits.map(item => fieldOf(item).name).slice(0, 10).join(', ')}${edits.length > 10 ? ' and others' : ''}.` }) }],
      structuredContent: { ok: true, changed: changed.slice(0, 20), filled: edits.length, changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo }, _meta: meta };
  }

  /** A new table before or after a body paragraph, filled in the same transaction. */
  private async insertTable(args: JsonObject, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, guard?: SelectionGuard): Promise<ToolResult> {
    const operation = operationId([state.path, 'insert_table', args.after ?? null, args.before ?? null, args.rows ?? null, args.headerRow ?? null, args.caption ?? null]), fail = this.failer(receipt, operation);
    const before = args.before !== undefined, field = before ? 'before' : 'after';
    if ((args.after === undefined) === (args.before === undefined)) return fail('INVALID_ARGUMENT', L({ ko: 'after와 before 중 정확히 하나를 줘라. 예: {path, before: "d…:p3", rows: [["값"]]}. 제목 앞에 넣으려면 before에 그 제목 문단을 준다.', en: 'Supply exactly one of after and before. Example: {path, before: "d…:p3", rows: [["Value"]]}. To insert before a heading, pass that heading paragraph as before.' }), true, inputAt('$'));
    const rows = args.rows, after = args[field], caption = args.caption;
    const width = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0].length : 0;
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_TABLE_ROWS || !width || width > MAX_TABLE_COLS || rows.some(row => !Array.isArray(row) || row.length !== width || row.some(control))) {
      const list = Array.isArray(rows) ? rows : [], row = list.findIndex(row => !Array.isArray(row) || row.length !== width || row.some(control)), wrong = list[row];
      const cell = Array.isArray(wrong) && wrong.length === width ? wrong.findIndex(control) : -1;
      return fail('INVALID_ARGUMENT', LT({ ko: () => `rows는 1~${MAX_TABLE_ROWS}행이고, 행마다 같은 수(1~${MAX_TABLE_COLS})의 줄바꿈 없는 문자열이다.`, en: () => `rows must contain 1–${MAX_TABLE_ROWS} rows, each with the same number (1–${MAX_TABLE_COLS}) of strings without line breaks.` }), true,
        inputAt(row < 0 ? 'rows' : cell < 0 ? `rows[${row}]` : `rows[${row}][${cell}]`, row >= 0 && cell < 0 ? { rule: 'same column count', allowed: { minItems: width, maxItems: width } } : {}));
    }
    if (args.headerRow !== undefined && typeof args.headerRow !== 'boolean') return fail('INVALID_ARGUMENT', L({ ko: 'headerRow는 true 또는 false다.', en: "headerRow must be true or false." }), true, inputAt('headerRow'));
    if (caption !== undefined && (control(caption) || !(caption as string).length)) return fail('INVALID_ARGUMENT', L({ ko: 'caption은 줄바꿈 없는 문자열이다.', en: "caption must be a string without line breaks." }), true, inputAt('caption'));
    if (typeof after !== 'string' || !after.startsWith(`${epoch.id}:`)) return fail('HANDLE_EXPIRED', LT({ ko: () => `${field}의 핸들이 지금 문서 상태의 것이 아니다. 다시 읽어 새 핸들을 써라. 제목 앞에 넣으려면 before에 그 제목 문단을 준다.`, en: () => `The ${field} handle does not belong to the current document state. Reread and use a fresh handle. To insert before a heading, pass that heading paragraph as before.` }), true, inputAt(field));
    const all = await this.env.api.query.paragraphs(epoch.path, { includeCells: true });
    await this.unchanged(state, epoch, fail);
    const handles = await this.env.handles(epoch, all), anchor = all[handles.indexOf(after)];
    if (!anchor) return fail('HANDLE_EXPIRED', LT({ ko: () => `${after}은 본문 문단 핸들이 아니다. read_document가 준 문단 핸들을 before 또는 after에 줘라. 제목 앞에는 before를 쓴다.`, en: () => `${after} is not a body paragraph handle. Pass a paragraph handle from read_document as before or after. Use before for insertion before a heading.` }), true, inputAt(field));
    if (anchor.address.cellPath?.length) return fail('UNSUPPORTED_TARGET', L({ ko: '표 칸이나 글상자 안에는 넣지 않는다. 본문 문단 핸들을 before 또는 after에 줘라. 제목 앞에는 before를 쓴다.', en: 'Tables cannot be inserted inside table cells or text boxes. Supply a body paragraph handle as before or after. Use before for insertion before a heading.' }), false, inputAt(field));
    if (before && (await this.env.api.query.fields(epoch.path)).some(item => item.address && addressKey(item.address) === addressKey(anchor.address)))
      return fail('UNSUPPORTED_TARGET', L({ ko: '누름틀이 있는 문단 앞에는 표를 넣을 수 없다. 다른 본문 문단을 before로 주거나, 뒤에 넣으려면 after로 줘라. 제목 앞에는 before에 그 제목 문단을 준다.', en: 'Cannot insert a table before a paragraph containing input fields. Supply another body paragraph as before, or use after to insert after it. For insertion before a heading, pass that heading paragraph as before.' }), false, inputAt(field));
    if (guard && !guard.insertion(anchor.address, before)) return await this.outside(guard, epoch, fail, LT({ ko: () => `${after} ${before ? '앞' : '뒤'}는`, en: () => `The position ${before ? 'before' : 'after'} ${after}` }));
    if (this.observations.shown(ctx.caller, ctx.observations, state).get(addressKey(anchor.address))?.get(anchor.text) === undefined)
      return fail('OBSERVATION_REQUIRED', L({ ko: '아직 적용되지 않았다. 표를 넣을 자리의 문단을 아래에 보여 주었다. 요청과 맞으면 같은 호출을 다시 보내면 적용된다.', en: "Not applied yet. The paragraph at the table insertion point is shown below. If it matches the request, send the same call again to apply." }), true,
        { blocks: [{ handle: after, text: clip(anchor.text) }], suggestion: observedRetrySuggestion() }, this.observations.record(ctx.caller, epoch, [{ handle: after, address: anchor.address, text: anchor.text, full: Array.from(anchor.text).length <= PREVIEW_CHARS }]));
    const { section, paragraph: index } = anchor.address, at = index + (before ? 0 : 1), cells = rows as string[][];
    const table = { section, paragraph: at, control: 0 };
    // Create at the requested body index. Before uses the engine's insertBefore path to keep section controls in place.
    // The table takes the new paragraph and one empty paragraph follows; the anchor's text and objects remain intact.
    const commands: Command[] = [{ type: 'insertParagraph', section, index: at, text: '', ...(before ? { like: 'next' as const } : {}) }, { type: 'createTable', target: { section, paragraph: at }, offset: 0, rows: cells.length, cols: width }];
    cells.forEach((row, r) => row.forEach((text, c) => { if (text) commands.push({ type: 'setCellText', table, row: r, col: c, text }); }));
    if (args.headerRow === true) commands.push({ type: 'formatCellBlock', table, startRow: 0, startCol: 0, endRow: 0, endCol: width - 1, character: { bold: true }, paragraph: { alignment: 'center' } });
    // The paragraph after the table must be the empty one the engine added; otherwise everything is rolled back.
    commands.push({ type: 'replaceParagraph', target: { section, paragraph: at + 1 }, text: '', expectedText: '' });
    if (caption !== undefined) commands.push({ type: 'insertText', target: { section, paragraph: at + 1 }, offset: 0, text: caption as string });
    if (commands.length > MAX_COMMANDS) return fail('LIMIT_EXCEEDED', LT({ ko: () => `한 번에 낼 수 있는 편집 명령은 ${MAX_COMMANDS}개다. 표를 나눠 넣거나 빈 칸을 줄여라.`, en: () => `At most ${MAX_COMMANDS} edit commands per call. Split the table or reduce empty cells.` }), true, { limit: MAX_COMMANDS });
    // A dry run of the first two commands changes nothing and tells where the engine would put the table, before the cells are addressed for real.
    const probe = await this.probe(ctx, state, epoch, commands.slice(0, 2));
    const made = probe.results[1] as { paraIdx?: Json; controlIdx?: Json } | undefined;
    if (made?.paraIdx !== at || typeof made.controlIdx !== 'number' || !Number.isInteger(made.controlIdx) || made.controlIdx < 0) return fail('UNSUPPORTED_TARGET', LT({ ko: () => `${after} ${before ? '앞' : '뒤'}에는 표가 놓일 자리를 확정하지 못해 넣지 않았다. 다른 본문 문단을 before 또는 after로 줘라. 제목 앞에는 before를 쓴다.`, en: () => `Could not determine a table placement ${before ? 'before' : 'after'} ${after}; nothing was inserted. Supply another body paragraph as before or after. Use before for insertion before a heading.` }), false, inputAt(field));
    // Section/column controls stay in the first paragraph. Use the probed table control index there too.
    table.control = made.controlIdx;
    const added = 2;
    const changed = [{ handle: after, before: '', after: clip(LT({ ko: () => `[표 ${cells.length}행×${width}열] ${cells[0].join(' | ')}${caption !== undefined ? ` ⏎ ${caption as string}` : ''}`, en: () => `[Table ${cells.length} rows × ${width} columns] ${cells[0].join(' | ')}${caption !== undefined ? ` ⏎ ${caption as string}` : ''}` })) }];
    const { applied, pages, meta } = await this.commit('insert_table', ctx, state, epoch, receipt, operation, commands, changed,
      { structural: true, summary: LT({ ko: () => `${cells.length}행×${width}열 표 넣음`, en: () => `Inserted ${cells.length}-row × ${width}-column table` }), moved: { section, changes: [{ action: before ? 'insert_before' : 'insert_after', index, count: added }] },
        marks: [{ address: { section, paragraph: at }, table: table.control }, ...(caption !== undefined ? [{ address: { section, paragraph: at + 1 } }] : [])] });
    guard?.restructured([{ action: before ? 'insert_before' : 'insert_after', index, count: added }], applied.revision);
    const selected = new Map<string, NextRole>([
      [addressKey({ kind: 'body', section, paragraph: at }), 'table'],
      [addressKey({ kind: 'body', section, paragraph: at + 1 }), caption !== undefined ? 'inserted' : 'after'],
      ...(caption !== undefined ? [[addressKey({ kind: 'body', section, paragraph: at + 2 }), 'after'] as [string, NextRole]] : []),
    ]);
    const continuation = await this.nextHandles(ctx, epoch.path, applied, selected);
    return { content: [{ type: 'text', text: LT({ ko: () => `${after} ${before ? '앞' : '뒤'}에 ${cells.length}행×${width}열 표를 넣었다.${continuation ? ' 핸들이 바뀌었다. 아래 새 핸들로 바로 이어서 편집할 수 있다. 다른 곳을 편집할 때만 다시 읽는다.' + this.nextLines(continuation.handles) : ' 핸들이 바뀌었으니 계속 편집하려면 문서를 다시 읽어라.'}`, en: () => `Inserted a ${cells.length}-row × ${width}-column table ${before ? 'before' : 'after'} ${after}.${continuation ? ' Handles changed. Continue immediately with the new handles below; reread only to edit elsewhere.' + this.nextLines(continuation.handles) : ' Handles changed; reread before continuing to edit.'}` }) }],
      structuredContent: { ok: true, changed, rows: cells.length, cols: width, changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo, handlesExpired: true, ...(continuation ? { next: { handles: continuation.handles } } : {}) }, _meta: { ...meta, ...continuation?.observed } };
  }

  private async table(args: JsonObject, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, guard?: SelectionGuard): Promise<ToolResult> {
    const operation = operationId([state.path, 'update_table', args.table ?? null, args.cells ?? null, args.checkBoxes ?? null, args.match ?? null, args.set ?? null, args.insertRowAfter ?? null, args.count ?? null, args.deleteRow ?? null, args.backgrounds ?? null, args.insertColumnAfter ?? null, args.deleteColumn ?? null, args.merge ?? null, args.split ?? null, args.deleteTable ?? null]);
    const fail = this.failer(receipt, operation);
    const modes = [args.cells !== undefined, args.match !== undefined || args.set !== undefined, ...['checkBoxes', 'insertRowAfter', 'deleteRow', 'backgrounds', 'insertColumnAfter', 'deleteColumn', 'merge', 'split', 'deleteTable'].map(key => args[key] !== undefined)].filter(Boolean).length;
    if (modes !== 1 || (args.match === undefined) !== (args.set === undefined)) return fail('INVALID_ARGUMENT', L({ ko: '표 작업은 정확히 하나를 준다. 허용 필드는 update_table inputSchema를 확인하라. match와 set은 함께 준다.', en: "Specify exactly one table operation. See update_table inputSchema for allowed fields. Supply match and set together." }), true,
      inputAt('$', { rule: 'exactly one table operation' }));
    if (args.overwrite !== undefined && (typeof args.overwrite !== 'boolean' || (args.cells === undefined && args.set === undefined))) return fail('INVALID_ARGUMENT', L({ ko: 'overwrite는 cells나 set과 함께 주는 true 또는 false다.', en: "overwrite is true or false, supplied with cells or set." }), true, inputAt('overwrite'));
    const count = args.count ?? 1;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_NEW_ROWS || (args.count !== undefined && args.insertRowAfter === undefined)) return fail('INVALID_ARGUMENT', LT({ ko: () => `count는 insertRowAfter와 함께 주는 1~${MAX_NEW_ROWS}의 정수다.`, en: () => `count must be an integer from 1 to ${MAX_NEW_ROWS}, supplied with insertRowAfter.` }), true,
      inputAt('count', { allowed: { minimum: 1, maximum: MAX_NEW_ROWS } }));
    const name = args.table, number = typeof name === 'string' ? /^([^:]+):t(\d+)$/.exec(name) : null;
    if (!number || number[1] !== epoch.id) return fail('HANDLE_EXPIRED', L({ ko: 'table의 핸들이 지금 문서 상태의 표 핸들이 아니다. 다시 읽어 새 핸들(d…:t1)을 써라.', en: "The table handle is not a table handle from the current document state. Reread and use a fresh handle (d…:t1)." }), true, inputAt('table'));
    const tables = await this.env.tables(epoch);
    await this.unchanged(state, epoch, fail);
    const table = tables[Number(number[2]) - 1];
    if (!table) return fail('HANDLE_EXPIRED', LT({ ko: () => `${number[0]}이라는 표가 없다. 다시 읽어라.`, en: () => `Table ${number[0]} does not exist. Reread.` }), true, inputAt('table', { tables: tables.length }));
    if (table.address.cellPath?.length) return fail('UNSUPPORTED_TARGET', L({ ko: '다른 표나 글상자 안의 표는 편집하지 않는다.', en: "Tables inside other tables or text boxes are not edited." }), false, inputAt('table'));
    const handle = name as string, shown = this.observations.shown(ctx.caller, ctx.observations, state);
    const cellHandle = (cell: Table['cells'][number]): string => `${handle}:r${cell.row + 1}c${cell.col + 1}`;
    const origin = { section: table.address.section, paragraph: table.address.paragraph, control: table.control };
    const seen = (paragraph: Paragraph): boolean | undefined => shown.get(addressKey(paragraph.address))?.get(paragraph.text);
    const blocks = (cells: Array<Table['cells'][number]>): Shown[] => cells.flatMap(cell => cell.paragraphs.map((paragraph, index) => ({ handle: `${cellHandle(cell)}.p${index + 1}`, address: paragraph.address, text: paragraph.text })));
    const observe = (cells: Array<Table['cells'][number]>, full: boolean): void => {
      const missing = cells.filter(cell => cell.paragraphs.some(paragraph => full ? seen(paragraph) !== true : seen(paragraph) === undefined));
      if (!missing.length) return;
      const list = blocks(missing).slice(0, MAX_CELLS);
      const complete = list.every(item => Array.from(item.text).length <= PREVIEW_CHARS);
      fail('OBSERVATION_REQUIRED', complete
        ? L({ ko: '아직 적용되지 않았다. 고치려는 표 칸의 지금 내용을 아래에 보여 주었다. 요청과 맞으면 같은 호출을 다시 보내면 적용된다.', en: "Not applied yet. Current target cell contents are shown below. If they match the request, send the same call again to apply." })
        : L({ ko: '고치려는 표 칸의 지금 내용 일부를 아래에 보여 주었다. 긴 칸은 read_document(mode=table)로 끝까지 읽은 뒤 다시 호출하라.', en: "Part of the current target cell contents is shown below. Read long cells through the end with read_document(mode=table) before calling again." }), true,
        { blocks: list.map(item => ({ handle: item.handle, text: clip(item.text) })), ...(complete ? { suggestion: observedRetrySuggestion() } : {}) }, this.observations.record(ctx.caller, epoch, list.filter(item => Array.from(item.text).length <= PREVIEW_CHARS)));
    };
    const position = (value: unknown, limit: number, label: string): number => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > limit) return fail('INVALID_ARGUMENT', LT({ ko: () => `${label}은 1부터 ${limit}까지의 정수다. 이 표는 ${table.rows}행×${table.cols}열이다.`, en: () => `${label} must be an integer from 1 to ${limit}. This table has ${table.rows} rows × ${table.cols} columns.` }), true,
        inputAt(label, { rule: 'document-range', allowed: { minimum: 1, maximum: limit }, rows: table.rows, cols: table.cols }));
      return value;
    };
    // `at` names the input object holding row/col (cells[2], split) so a merged-cell refusal points at it.
    const cellAt = (row: number, col: number, at: string): Table['cells'][number] => {
      const cell = table.cells.find(item => item.row === row - 1 && item.col === col - 1);
      if (cell) return cell;
      const cover = table.cells.find(item => row - 1 >= item.row && row - 1 < item.row + item.rowSpan && col - 1 >= item.col && col - 1 < item.col + item.colSpan);
      return fail('INVALID_ARGUMENT', cover ? LT({ ko: () => `r${row}c${col}은 병합된 칸 ${cellHandle(cover)}의 일부다. 그 칸을 지정하라.`, en: () => `r${row}c${col} is part of merged cell ${cellHandle(cover)}. Specify that cell.` }) : LT({ ko: () => `r${row}c${col} 칸이 없다.`, en: () => `Cell r${row}c${col} does not exist.` }), true,
        inputAt(at, cover ? { rule: 'merged-cell anchor', allowed: { row: cover.row + 1, col: cover.col + 1 }, cell: cellHandle(cover) } : { rule: 'existing cell' }));
    };
    const text = (cell: Table['cells'][number]): string => cell.paragraphs.map(paragraph => paragraph.text).join('\n').trim();
    const requireUncovered = async (cells: Table['cells']): Promise<void> => {
      let coverage: { coveredCellIndices: number[]; complete: boolean };
      try { coverage = await this.env.api.query.tableCoverage(epoch.path, origin, { sessionId: state.sessionId, expectedRevision: state.revision }); }
      catch (error) {
        if (error instanceof HwpHandsError && error.code === 'REVISION_CONFLICT') throw error;
        return fail('UNSUPPORTED_TARGET', L({ ko: '표에 겹친 개체 위치를 확인하지 못해 칸을 편집하지 않았다.', en: "Could not verify overlapping object positions; no cells were edited." }), false);
      }
      await this.unchanged(state, epoch, fail);
      const occupied = cells.filter(cell => coverage.coveredCellIndices.includes(cell.index));
      if (occupied.length) return fail('PROTECTED_CONTENT', LT({ ko: () => `${occupied.map(cellHandle).join(', ')} 칸에 떠 있는 그림이나 개체가 겹쳐 있어 편집하지 않았다.`, en: () => `Floating pictures or objects overlap cells ${occupied.map(cellHandle).join(', ')}; nothing was edited.` }), false,
        { cells: occupied.map(cellHandle), rule: 'floating object over cell' });
      if (!coverage.complete) return fail('UNSUPPORTED_TARGET', L({ ko: '표에 겹친 개체 위치를 모두 확인하지 못해 칸을 편집하지 않았다.', en: "Could not verify all overlapping object positions; no cells were edited." }), false);
    };

    if (args.checkBoxes !== undefined) {
      const list = args.checkBoxes;
      if (!Array.isArray(list) || !list.length || list.length > MAX_CELLS) return fail('INVALID_ARGUMENT', LT({ ko: () => `checkBoxes는 1~${MAX_CELLS}개다.`, en: () => `checkBoxes accepts 1–${MAX_CELLS} items.` }), true, inputAt('checkBoxes'));
      const used = new Set<number>();
      const requested = list.map((raw, index) => {
        const item = record(raw), at = `checkBoxes[${index}]`;
        if (item.choice !== undefined && (control(item.choice) || !(item.choice as string).trim())) return fail('INVALID_ARGUMENT', LT({ ko: () => `${at}.choice는 빈 값이 아닌 문구다.`, en: () => `${at}.choice must be a nonempty phrase.` }), true, inputAt(`${at}.choice`));
        const cell = cellAt(position(item.row, table.rows, `${at}.row`), position(item.col, table.cols, `${at}.col`), at);
        if (used.has(cell.index)) return fail('INVALID_ARGUMENT', L({ ko: '같은 칸을 두 번 지정했다.', en: "The same cell was specified twice." }), true, inputAt(at, { rule: 'one change per cell' }));
        used.add(cell.index); return { cell, choice: typeof item.choice === 'string' ? item.choice.trim() : '', at };
      });
      for (const item of guard ? requested : []) for (const paragraph of item.cell.paragraphs)
        if (!guard!.whole(paragraph.address)) return await this.outside(guard!, epoch, fail, LT({ ko: () => `${cellHandle(item.cell)} 칸은`, en: () => `Cell ${cellHandle(item.cell)}` }));
      observe(requested.map(item => item.cell), true);
      const formatting = await this.env.api.query.formatting(epoch.path, { pages: [], runs: 'model' });
      await this.unchanged(state, epoch, fail);
      const formats = new Map(formatting.paragraphs.filter(item => item.address.kind === 'body').map(item => [addressKey(item.address as BodyAddress), item]));
      const bullets = new Map(formatting.bullets.map(item => [item.id, item.char]));
      type Box = { paragraph: Paragraph; kind: 'bullet' | 'text'; offset: number; char: string; label: string };
      const targets = requested.map(item => {
        const boxes: Box[] = [];
        for (const paragraph of item.cell.paragraphs) {
          const format = formats.get(addressKey(paragraph.address));
          if (!format || format.propertyCoverage !== 'complete' || !format.properties) return fail('UNSUPPORTED_TARGET', L({ ko: '칸의 글머리표를 확인할 수 없어 체크하지 않았다.', en: "Could not verify cell bullets; nothing was checked." }), false, inputAt(item.at));
          const bullet = format.properties.headType === 'Bullet' ? bullets.get(format.properties.numberingId ?? -1) : undefined;
          if (format.properties.headType === 'Bullet' && !bullet) return fail('UNSUPPORTED_TARGET', L({ ko: '글머리표 정의를 확인할 수 없어 체크하지 않았다.', en: "Could not verify bullet definitions; nothing was checked." }), false, inputAt(item.at));
          if (bullet && '□☐▢❑◻☑☒'.includes(bullet)) boxes.push({ paragraph, kind: 'bullet', offset: 0, char: bullet, label: paragraph.text.trim() });
          const chars = Array.from(paragraph.text);
          for (let offset = 0; offset < chars.length; offset++) {
            const char = chars[offset]; if (!'□☐▢❑◻☑☒'.includes(char)) continue;
            let end = offset + 1; while (end < chars.length && !'□☐▢❑◻☑☒'.includes(chars[end])) end++;
            let label = chars.slice(offset + 1, end).join('').trim();
            if (!label) { let begin = offset - 1; while (begin >= 0 && !'□☐▢❑◻☑☒'.includes(chars[begin])) begin--; label = chars.slice(begin + 1, offset).join('').trim(); }
            boxes.push({ paragraph, kind: 'text', offset, char, label });
          }
        }
        const exact = item.choice ? boxes.filter(box => box.label === item.choice) : boxes;
        const matches = item.choice && exact.length !== 1 ? boxes.filter(box => box.label && (box.label.includes(item.choice) || item.choice.includes(box.label))) : exact;
        if (matches.length !== 1) return fail(boxes.length ? 'AMBIGUOUS_MATCH' : 'TEXT_NOT_FOUND', boxes.length ? L({ ko: '선택할 체크 상자를 하나로 고를 수 없다. choice에 옆 문구를 지정하라.', en: "Cannot choose one checkbox uniquely. Specify its adjacent phrase as choice." }) : L({ ko: '이 칸에 체크 상자가 없다.', en: "This cell has no checkbox." }), true,
          inputAt(item.at, { candidates: boxes.slice(0, MAX_CANDIDATES).map(box => ({ label: clip(box.label), checked: '☑☒'.includes(box.char) })) }));
        return { ...item, box: matches[0] };
      });
      const unseenBullets = targets.filter(item => item.box.kind === 'bullet' && shown.get(checkboxBulletKey(item.box.paragraph.address))?.get(item.box.char) !== true);
      if (unseenBullets.length) return fail('OBSERVATION_REQUIRED', L({ ko: '체크할 글머리표 상자를 보여 주었다. 확인 후 다시 요청하라.', en: "The bullet checkbox to select is shown. Inspect it and request again." }), true,
        { boxes: unseenBullets.map(item => ({ handle: cellHandle(item.cell), bullet: item.box.char })) },
        this.observations.record(ctx.caller, epoch, unseenBullets.map(item => ({ handle: cellHandle(item.cell), key: checkboxBulletKey(item.box.paragraph.address), text: item.box.char }))));
      const unchecked = targets.filter(item => !'☑☒'.includes(item.box.char));
      if (!unchecked.length) return { content: [{ type: 'text', text: L({ ko: '이미 체크되어 있다. 바꾼 것이 없다.', en: "Already checked. Nothing changed." }) }], structuredContent: { ok: true, changed: [], undoAvailable: false }, _meta: receipt('no', { operationId: operation }) };
      await requireUncovered(unchecked.map(item => item.cell));
      const changed = unchecked.map(item => ({ handle: `${cellHandle(item.cell)}.p${item.cell.paragraphs.indexOf(item.box.paragraph) + 1}`, before: item.box.char, after: '☑' }));
      const commands: Command[] = unchecked.map(({ box }) => {
        if (box.kind === 'bullet') return { type: 'setParagraphList', target: target(box.paragraph.address), list: { kind: 'bullet', char: '☑', level: box.paragraph.properties.paraLevel ?? 0 } };
        const chars = Array.from(box.paragraph.text); chars[box.offset] = '☑';
        return { type: 'replaceParagraph', target: target(box.paragraph.address), text: chars.join(''), expectedText: box.paragraph.text, preserveFormatting: true };
      });
      const { applied, pages, meta } = await this.commit('update_table', ctx, state, epoch, receipt, operation, commands, changed,
        { structural: true, summary: LT({ ko: () => `체크 상자 ${unchecked.length}개 선택`, en: () => `Select ${unchecked.length} checkboxes` }), marks: unchecked.map(item => ({ address: item.box.paragraph.address })) });
      guard?.kept(applied.revision);
      return { content: [{ type: 'text', text: LT({ ko: () => `체크 상자 ${unchecked.length}개를 선택했다. 다시 읽어라.`, en: () => `Selected ${unchecked.length} checkboxes. Reread.` }) }],
        structuredContent: { ok: true, changed, changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo, handlesExpired: true }, _meta: meta };
    }

    if (['insertColumnAfter', 'deleteColumn', 'merge', 'split', 'deleteTable'].some(key => args[key] !== undefined)) {
      // Structure changes can move every cell address. Require the whole table, including its body anchor.
      if (guard && !guard.whole({ section: origin.section, paragraph: origin.paragraph })) return await this.outside(guard, epoch, fail, LT({ ko: () => `${handle}의 구조를`, en: () => `Structure of ${handle}` }));
      let command: Command, summary: string, destructive = false;
      if (args.insertColumnAfter !== undefined || args.deleteColumn !== undefined) {
        destructive = args.deleteColumn !== undefined;
        const key = destructive ? 'deleteColumn' : 'insertColumnAfter', col = position(args[key], table.cols, key);
        if (destructive && table.cols <= 1) return fail('UNSUPPORTED_TARGET', L({ ko: '표의 마지막 열은 지울 수 없다. 표 전체 삭제는 deleteTable을 쓴다.', en: "The last table column cannot be deleted. Use deleteTable to delete the entire table." }), false, inputAt(key, { cols: table.cols }));
        const crossed = table.cells.filter(cell => col - 1 >= cell.col && col - 1 < cell.col + cell.colSpan);
        if (crossed.some(cell => cell.colSpan > 1)) return fail('UNSUPPORTED_TARGET', L({ ko: '가로 병합에 걸친 열은 바꾸지 않는다. 병합을 먼저 나누어야 한다.', en: "Columns spanning horizontal merges are not changed. Split the merged cells first." }), false,
          inputAt(key, { rule: 'no horizontal merge', mergedCells: crossed.filter(cell => cell.colSpan > 1).slice(0, MAX_CANDIDATES).map(cellHandle) }));
        command = destructive ? { type: 'deleteTableColumn', table: origin, col: col - 1 } : { type: 'insertTableColumn', table: origin, col: col - 1, right: true };
        summary = destructive ? LT({ ko: () => `표 ${col}열 지움`, en: () => `Delete table column ${col}` }) : LT({ ko: () => `표 ${col}열 오른쪽에 빈 열 넣음`, en: () => `Insert empty column to the right of table column ${col}` });
      } else if (args.merge !== undefined) {
        const range = record(args.merge);
        const startRow = position(range.startRow, table.rows, 'merge.startRow') - 1, endRow = position(range.endRow, table.rows, 'merge.endRow') - 1;
        const startCol = position(range.startCol, table.cols, 'merge.startCol') - 1, endCol = position(range.endCol, table.cols, 'merge.endCol') - 1;
        if (startRow > endRow || startCol > endCol || startRow === endRow && startCol === endCol) return fail('INVALID_ARGUMENT', L({ ko: '병합은 왼쪽 위부터 오른쪽 아래까지 두 칸 이상의 직사각형이어야 한다.', en: "A merge must form a rectangle of at least two cells from top-left to bottom-right." }), true,
          inputAt(startRow > endRow ? 'merge.endRow' : startCol > endCol ? 'merge.endCol' : 'merge', { rule: startRow > endRow || startCol > endCol ? 'start <= end' : 'at least two cells' }));
        // Engine validates complete coverage and refuses non-anchor text, fields, controls and objects.
        command = { type: 'mergeTableCells', table: origin, startRow, startCol, endRow, endCol };
        summary = L({ ko: '표 칸 병합', en: "Merge table cells" });
      } else if (args.split !== undefined) {
        const split = record(args.split), cell = cellAt(position(split.row, table.rows, 'split.row'), position(split.col, table.cols, 'split.col'), 'split');
        if (cell.rowSpan === 1 && cell.colSpan === 1) return fail('INVALID_ARGUMENT', L({ ko: '병합된 칸만 원래 격자로 나눌 수 있다.', en: "Only merged cells can be split to their original grid." }), true,
          inputAt('split', { rule: 'merged cell', mergedCells: table.cells.filter(item => item.rowSpan > 1 || item.colSpan > 1).slice(0, MAX_CANDIDATES).map(cellHandle) }));
        command = { type: 'splitTableCell', table: origin, row: cell.row, col: cell.col };
        summary = L({ ko: '표 병합 칸 나눔', en: "Split merged table cell" });
      } else {
        command = { type: 'deleteTable', table: origin }; summary = L({ ko: '표 전체 지움', en: "Delete entire table" }); destructive = true;
      }
      observe(table.cells, true);
      if (destructive) {
        // Probe ALL cells, including nested anchors, before the native destructive operation.
        const probe: Command[] = table.cells.flatMap(cell => cell.paragraphs.map(paragraph => ({ type: 'replaceParagraph', target: target(paragraph.address), text: `${paragraph.text}.`, expectedText: paragraph.text })));
        const anchored = await this.probe(ctx, state, epoch, probe)
          .then(() => false, error => { if (error instanceof HwpHandsError && (error.details as { reason?: unknown } | undefined)?.reason === 'anchored-content') return true; throw error; });
        if (anchored) return fail('PROTECTED_CONTENT', L({ ko: '표 안에 누름틀·개체·중첩 표가 있어 삭제하지 않는다. 사람이 화면에서 확인해야 한다.', en: "The table contains input fields, objects, or nested tables and will not be deleted. A person must inspect it onscreen." }), false, inputAt(args.deleteTable !== undefined ? 'deleteTable' : 'deleteColumn'));
      }
      const changed = [{ handle, before: clip(table.cells.map(text).join(' | ')), after: summary }];
      const { applied, pages, meta } = await this.commit('update_table', ctx, state, epoch, receipt, operation, [command], changed,
        { structural: true, summary, marks: [{ address: { section: origin.section, paragraph: origin.paragraph }, ...(args.deleteTable ? {} : { table: origin.control }) }] });
      guard?.kept(applied.revision);
      return { content: [{ type: 'text', text: LT({ ko: () => `${summary}. 핸들이 바뀌었으니 문서를 다시 읽어야 한다.`, en: () => `${summary}. Handles changed; reread the document.` }) }],
        structuredContent: { ok: true, changed, changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo, handlesExpired: true }, _meta: meta };
    }

    if (args.backgrounds !== undefined) {
      const list = args.backgrounds;
      if (!Array.isArray(list) || !list.length || list.length > MAX_CELLS) return fail('INVALID_ARGUMENT', LT({ ko: () => `backgrounds는 1~${MAX_CELLS}개의 배열이어야 한다.`, en: () => `backgrounds must be an array of 1–${MAX_CELLS} items.` }), true, inputAt('backgrounds', { allowed: { minItems: 1, maxItems: MAX_CELLS } }));
      const unique = new Set<number>();
      let changes = list.map((raw, index) => {
        const item = record(raw);
        if (item.color !== 'none' && (typeof item.color !== 'string' || !/^#[\da-f]{6}$/i.test(item.color))) return fail('INVALID_ARGUMENT', LT({ ko: () => `backgrounds[${index}].color는 #RRGGBB 또는 none(배경 지우기)이다.`, en: () => `backgrounds[${index}].color must be #RRGGBB or none (clear background).` }), true,
          inputAt(`backgrounds[${index}].color`, { allowed: ['#RRGGBB', 'none'] }));
        const cell = cellAt(position(item.row, table.rows, `backgrounds[${index}].row`), position(item.col, table.cols, `backgrounds[${index}].col`), `backgrounds[${index}]`);
        if (unique.has(cell.index)) return fail('INVALID_ARGUMENT', L({ ko: '같은 칸의 배경은 한 번만 지정한다.', en: "Specify each cell background only once." }), true, inputAt(`backgrounds[${index}]`, { rule: 'one change per cell', cell: cellHandle(cell) }));
        unique.add(cell.index);
        return { cell, color: item.color === 'none' ? null : (item.color).toLowerCase() };
      });
      // A fill affects the whole cell, including all its paragraphs.
      if (guard && changes.some(item => item.cell.paragraphs.some(paragraph => !guard.whole(paragraph.address)))) return await this.outside(guard, epoch, fail, L({ ko: '표 칸 배경은', en: "Table cell backgrounds" }));
      observe(changes.map(item => item.cell), true);
      changes = changes.filter(item => item.color === null ? item.cell.properties?.fillType !== 'none'
        : item.cell.properties?.fillType !== 'solid' || item.cell.properties.fillColor?.toLowerCase() !== item.color || item.cell.properties.patternType !== -1);
      if (!changes.length) return { content: [{ type: 'text', text: L({ ko: '표 칸 배경이 이미 같아 바꾼 것이 없다.', en: "Table cell backgrounds are already identical. Nothing changed." }) }], structuredContent: { ok: true, changed: [], undoAvailable: false }, _meta: receipt('no', { operationId: operation }) };
      const changed = changes.map(item => ({ handle: cellHandle(item.cell), before: item.cell.properties?.fillType === 'none' ? L({ ko: '배경 없음', en: "No background" }) : item.cell.properties?.fillColor ?? L({ ko: '기존 배경', en: "Existing background" }), after: item.color ?? L({ ko: '배경 없음', en: "No background" }) }));
      const commands: Command[] = changes.map(item => ({ type: 'setCellProperties', table: origin, row: item.cell.row, col: item.cell.col,
        properties: item.color === null ? { fillType: 'none' } : { fillType: 'solid', fillColor: item.color, patternType: -1 } }));
      const { applied, pages, meta } = await this.commit('update_table', ctx, state, epoch, receipt, operation, commands, changed,
        { summary: LT({ ko: () => `표 칸 ${changes.length}개 배경 바꿈`, en: () => `Change backgrounds of ${changes.length} table cells` }), marks: changes.flatMap(item => item.cell.paragraphs.map(paragraph => ({ address: paragraph.address }))) });
      guard?.kept(applied.revision);
      return { content: [{ type: 'text', text: LT({ ko: () => `표 칸 ${changes.length}개 배경을 바꿨다.`, en: () => `Changed backgrounds of ${changes.length} table cells.` }) }],
        structuredContent: { ok: true, changed: changed.slice(0, 20), changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo }, _meta: meta };
    }

    if (args.insertRowAfter !== undefined || args.deleteRow !== undefined) {
      const remove = args.deleteRow !== undefined, key = remove ? 'deleteRow' : 'insertRowAfter', row = position(args[key], table.rows, key);
      const cells = table.cells.filter(cell => row - 1 >= cell.row && row - 1 < cell.row + cell.rowSpan);
      if (cells.some(cell => cell.rowSpan > 1)) return fail('UNSUPPORTED_TARGET', LT({ ko: () => `${row}행에 세로로 병합된 칸이 있어 행을 ${remove ? '지우지' : '넣지'} 않았다. 사람이 화면에서 해야 한다.`, en: () => `Row ${row} has vertically merged cells; ${remove ? 'deletion' : 'insertion'} was not performed. A person must do it onscreen.` }), false,
        inputAt(key, { rule: 'no vertical merge', mergedCells: cells.filter(cell => cell.rowSpan > 1).slice(0, MAX_CANDIDATES).map(cellHandle) }));
      if (remove && table.rows <= 1) return fail('UNSUPPORTED_TARGET', L({ ko: '표의 마지막 행은 지울 수 없다.', en: "The last table row cannot be deleted." }), false, inputAt(key, { rows: table.rows }));
      // Rows change the table itself, so the paragraph that holds the table must be selected.
      if (guard && !guard.whole({ section: table.address.section, paragraph: table.address.paragraph })) return await this.outside(guard, epoch, fail, LT({ ko: () => `${handle}의 행은`, en: () => `Rows of ${handle}` }));
      observe(cells, remove);
      if (remove) {
        // Removing a row removes whatever is anchored in its cells, and the engine does not refuse that. Ask the engine, with a dry run
        // that changes nothing, whether it would protect any paragraph of the row from a plain text rewrite; if so, keep the row.
        const probe: Command[] = cells.flatMap(cell => cell.paragraphs.map(paragraph => ({ type: 'replaceParagraph', target: target(paragraph.address), text: `${paragraph.text}.`, expectedText: paragraph.text })));
        const anchored = await this.probe(ctx, state, epoch, probe)
          .then(() => false, error => { if (error instanceof HwpHandsError && (error.details as { reason?: unknown } | undefined)?.reason === 'anchored-content') return true; throw error; });
        if (anchored) return fail('PROTECTED_CONTENT', LT({ ko: () => `${row}행의 칸에 누름틀·표·그림 같은 개체가 있어 지우지 않았다. 이 행은 사람이 화면에서 직접 지워야 한다.`, en: () => `Row ${row} contains input fields, tables, pictures, or other objects and was not deleted. A person must delete it directly onscreen.` }), false, inputAt(key));
      }
      const added = LT({ ko: () => `빈 행${count > 1 ? ` ${count}개` : ''}`, en: () => `empty row${count > 1 ? `s (${count})` : ''}` });
      const changed = remove ? cells.map(cell => ({ handle: cellHandle(cell), before: clip(text(cell)), after: '' })) : [{ handle, before: '', after: LT({ ko: () => `${row}행 아래에 ${added}`, en: () => `${added} below row ${row}` }) }];
      // Each new row goes right below the given row, so the rows stack in the order a list continues; every one copies that row's shape.
      const commands: Command[] = remove ? [{ type: 'deleteTableRow', table: origin, row: row - 1 }] : Array.from({ length: count }, () => ({ type: 'insertTableRow' as const, table: origin, row: row - 1, below: true }));
      const { applied, pages, meta } = await this.commit('update_table', ctx, state, epoch, receipt, operation, commands, changed,
        { structural: true, summary: remove ? LT({ ko: () => `표 ${row}행 지움`, en: () => `Delete table row ${row}` }) : LT({ ko: () => `표 ${row}행 아래에 행 ${count}개 넣음`, en: () => `Insert ${count} rows below table row ${row}` }), marks: [{ address: { section: origin.section, paragraph: origin.paragraph }, table: origin.control }] });
      guard?.kept(applied.revision);
      return { content: [{ type: 'text', text: LT({ ko: () => `${remove ? `${row}행을 지웠다` : `${row}행 아래에 ${added}을 넣었다`}. 핸들이 바뀌었으니 계속 편집하려면 문서를 다시 읽어라.`, en: () => `${remove ? `Deleted row ${row}` : `Inserted ${added} below row ${row}`}. Handles changed; reread before continuing to edit.` }) }],
        structuredContent: { ok: true, changed: changed.slice(0, 20), rows: table.rows + (remove ? -1 : count), changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo, handlesExpired: true }, _meta: meta };
    }

    let wanted: Array<{ cell: Table['cells'][number]; text: string; at: string }>;
    if (args.cells !== undefined) {
      const list = args.cells;
      if (!Array.isArray(list) || !list.length || list.length > MAX_CELLS) return fail('INVALID_ARGUMENT', LT({ ko: () => `cells는 1~${MAX_CELLS}개의 배열이어야 한다.`, en: () => `cells must be an array of 1–${MAX_CELLS} items.` }), true, inputAt('cells', { allowed: { minItems: 1, maxItems: MAX_CELLS } }));
      wanted = list.map((raw, index) => {
        const item = record(raw);
        if (control(item.text)) return fail('INVALID_ARGUMENT', LT({ ko: () => `cells[${index}].text는 줄바꿈 없는 문자열이다.`, en: () => `cells[${index}].text must be a string without line breaks.` }), true, inputAt(`cells[${index}].text`));
        return { cell: cellAt(position(item.row, table.rows, `cells[${index}].row`), position(item.col, table.cols, `cells[${index}].col`), `cells[${index}]`), text: item.text as string, at: `cells[${index}]` };
      });
    } else {
      const rawMatch = record(args.match), list = args.set;
      if (typeof rawMatch.column !== 'string' || typeof rawMatch.equals !== 'string' || !Array.isArray(list) || !list.length || list.length > table.cols)
        return fail('INVALID_ARGUMENT', L({ ko: 'match는 {column, equals}, set은 {column, text}의 배열이다. column은 표 첫 행의 머리글이다.', en: "match is {column, equals}; set is an array of {column, text}. column is a header in the first table row." }), true,
          Array.isArray(list) && list.length > table.cols ? inputAt('set', { rule: 'document-range', allowed: { maxItems: table.cols }, cols: table.cols }) : inputAt(Array.isArray(list) && list.length ? 'match' : 'set'));
      if (table.cells.some(cell => cell.rowSpan > 1 || cell.colSpan > 1)) return fail('UNSUPPORTED_TARGET', L({ ko: '병합된 칸이 있는 표는 머리글로 찾지 않는다. cells에 행·열 번호를 줘라.', en: "Header-based lookup is unavailable for tables with merged cells. Supply row/column numbers in cells." }), true,
        inputAt('match', { rule: 'table without merged cells', suggestion: L({ ko: 'read_document로 표를 읽고 cells에 행·열 번호를 지정하라.', en: "Read the table with read_document and supply row/column numbers in cells." }) }));
      const headers = table.cells.filter(cell => cell.row === 0).sort((a, b) => a.col - b.col);
      const column = (value: unknown, label: string): number => {
        const found = typeof value === 'string' ? headers.filter(cell => text(cell) === value.trim()) : [];
        if (found.length !== 1) return fail(found.length ? 'AMBIGUOUS_MATCH' : 'INVALID_ARGUMENT', LT({ ko: () => `${label} "${String(value)}"인 머리글이 ${found.length ? '여러 개다' : '없다'}. 바꾸지 않았다.`, en: () => `There ${found.length ? 'are multiple headers' : 'is no header'} ${label} "${String(value)}". Nothing was changed.` }), true,
          inputAt(label, { rule: 'unique header', headers: headers.map(text).slice(0, MAX_NAMES) }));
        return found[0].col;
      };
      const match = { column: rawMatch.column, equals: rawMatch.equals };
      const key = column(match.column, 'match.column');
      const rows = table.cells.filter(cell => cell.col === key && cell.row > 0 && text(cell) === match.equals.trim());
      if (!rows.length) return fail('TEXT_NOT_FOUND', LT({ ko: () => `"${match.column}" 열에 "${match.equals}"인 행이 없다. 바꾸지 않았다.`, en: () => `No row in column "${match.column}" equals "${match.equals}". Nothing changed.` }), true, inputAt('match.equals'));
      if (rows.length > 1) return fail('AMBIGUOUS_MATCH', LT({ ko: () => `"${match.column}" 열에 "${match.equals}"인 행이 ${rows.length}개라 바꾸지 않았다. cells에 행·열 번호를 줘라.`, en: () => `${rows.length} rows in column "${match.column}" equal "${match.equals}"; nothing changed. Supply row/column numbers in cells.` }), true,
        inputAt('match.equals', { total: rows.length, candidates: rows.slice(0, MAX_CANDIDATES).map(cell => ({ handle: cellHandle(cell), snippet: LT({ ko: () => `${cell.row + 1}행`, en: () => `row ${cell.row + 1}` }) })) }));
      const row = rows[0].row;
      wanted = list.map((raw, index) => {
        const item = record(raw);
        if (control(item.text)) return fail('INVALID_ARGUMENT', LT({ ko: () => `set[${index}].text는 줄바꿈 없는 문자열이다.`, en: () => `set[${index}].text must be a string without line breaks.` }), true, inputAt(`set[${index}].text`));
        const col = column(item.column, `set[${index}].column`);
        return { cell: table.cells.find(cell => cell.row === row && cell.col === col)!, text: item.text as string, at: `set[${index}]` };
      });
      // The row was chosen by what the header and key cells say, so the model must have seen them.
      observe([...headers.filter(cell => cell.col === key || wanted.some(item => item.cell.col === cell.col)), rows[0]], false);
    }
    const repeated = wanted.find((item, index) => wanted.findIndex(other => other.cell.index === item.cell.index) !== index);
    if (repeated) return fail('INVALID_ARGUMENT', L({ ko: '같은 칸을 두 번 지정했다.', en: "The same cell was specified twice." }), true, inputAt(repeated.at, { rule: 'one value per cell', cell: cellHandle(repeated.cell) }));
    const many = wanted.filter(item => item.cell.paragraphs.length !== 1);
    if (many.length) return fail('UNSUPPORTED_TARGET', LT({ ko: () => `${many.map(item => cellHandle(item.cell)).slice(0, MAX_CANDIDATES).join(', ')} 칸은 문단이 여러 개다. edit_paragraphs의 set에 칸 문단 핸들(${cellHandle(many[0].cell)}.p1 등)을 줘라.`, en: () => `Cells ${many.map(item => cellHandle(item.cell)).slice(0, MAX_CANDIDATES).join(', ')} have multiple paragraphs. Supply cell paragraph handles (e.g. ${cellHandle(many[0].cell)}.p1) to edit_paragraphs set.` }), false,
      inputAt(many[0].at, { rule: 'single-paragraph cell', cells: many.map(item => cellHandle(item.cell)).slice(0, MAX_CANDIDATES) }));
    for (const item of guard ? wanted : []) {
      const paragraph = item.cell.paragraphs[0];
      if (!(item.text === paragraph.text ? guard!.touches(paragraph.address) : guard!.rewrite(paragraph, item.text))) return await this.outside(guard!, epoch, fail, LT({ ko: () => `${cellHandle(item.cell)} 칸은`, en: () => `Cell ${cellHandle(item.cell)}` }));
    }
    // A form names its items (성명, 소속) in cells beside the empty answer cells: a cell that holds text is written only on purpose.
    const filled = args.overwrite === true ? [] : wanted.filter(item => item.text !== item.cell.paragraphs[0].text && text(item.cell) !== '');
    if (filled.length) {
      const list = blocks(filled.map(item => item.cell)).slice(0, MAX_CELLS);
      return fail('CELL_NOT_EMPTY', LT({ ko: () => `${filled.map(item => cellHandle(item.cell)).slice(0, MAX_CANDIDATES).join(', ')} 칸에 이미 글이 있어 아무 칸도 바꾸지 않았다. 양식의 항목 이름 칸이 아닌지 확인하고, 사용자가 그 내용을 바꾸라고 했을 때만 overwrite: true로 다시 보내라.`, en: () => `Cells ${filled.map(item => cellHandle(item.cell)).slice(0, MAX_CANDIDATES).join(', ')} already contain text, so no cells were changed. Check whether these are form label cells. Resubmit with overwrite:true only if the user requested replacing that content.` }), true,
        inputAt(filled[0].at, { cells: list.map(item => ({ handle: item.handle, text: clip(item.text) })) }), this.observations.record(ctx.caller, epoch, list.filter(item => Array.from(item.text).length <= PREVIEW_CHARS)));
    }
    observe(wanted.map(item => item.cell), true);
    const edits = wanted.filter(item => item.text !== item.cell.paragraphs[0].text);
    if (!edits.length) return { content: [{ type: 'text', text: L({ ko: '표 칸이 이미 같은 내용이다. 바꾼 것이 없다.', en: "Table cells already contain identical content. Nothing changed." }) }], structuredContent: { ok: true, changed: [], undoAvailable: false }, _meta: receipt('no', { operationId: operation }) };
    await requireUncovered(edits.map(item => item.cell));
    const changed = edits.map(item => ({ handle: `${cellHandle(item.cell)}.p1`, before: clip(item.cell.paragraphs[0].text), after: clip(item.text) }));
    const { applied, pages, meta } = await this.commit('update_table', ctx, state, epoch, receipt, operation,
      edits.map(item => ({ type: 'replaceParagraph', target: target(item.cell.paragraphs[0].address), text: item.text, expectedText: item.cell.paragraphs[0].text, preserveFormatting: true, normalizeFormAnswer: true })), changed,
      { marks: edits.map(item => ({ address: item.cell.paragraphs[0].address })), summary: LT({ ko: () => `표 칸 ${edits.length}개 고침`, en: () => `Changed ${edits.length} table cells` }), observed: edits.map(item => ({ handle: `${cellHandle(item.cell)}.p1`, address: item.cell.paragraphs[0].address, text: item.text, full: Array.from(item.text).length <= PREVIEW_CHARS })) });
    guard?.rewritten(edits.map(item => ({ paragraph: item.cell.paragraphs[0], after: item.text })), applied.revision);
    return { content: [{ type: 'text', text: LT({ ko: () => `표 칸 ${edits.length}개 고침: ${changed.map(item => item.handle).slice(0, 10).join(', ')}${changed.length > 10 ? ' 등' : ''}.`, en: () => `Changed ${edits.length} table cells: ${changed.map(item => item.handle).slice(0, 10).join(', ')}${changed.length > 10 ? ' and others' : ''}.` }) }],
      structuredContent: { ok: true, changed: changed.slice(0, 20), changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo }, _meta: meta };
  }

  /** Formatting in people's units. Text and addresses stay as they are. */
  private async format(args: JsonObject, ctx: CallerContext, state: State, epoch: EditEpoch, receipt: Receipter, guard?: SelectionGuard): Promise<ToolResult> {
    const { path: _path, target: handle, find, style, match, preview: _preview, ...rest } = args;
    const operation = operationId([state.path, 'format_text', handle ?? null, find ?? null, style ?? null, match ?? null, rest]), fail = this.failer(receipt, operation);
    const character: CharacterFormatProperties = {}, paragraph: ParagraphFormatProperties = {}, labels: string[] = [];
    const number = (key: string, min: number, max: number): number | undefined => {
      const value = rest[key];
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return fail('INVALID_ARGUMENT', LT({ ko: () => `${key}는 ${min}부터 ${max}까지의 수다.`, en: () => `${key} must be a number from ${min} to ${max}.` }), true, inputAt(key, { allowed: { minimum: min, maximum: max } }));
      labels.push(`${key}=${value}`);
      return value;
    };
    for (const key of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
      const value = rest[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') return fail('INVALID_ARGUMENT', LT({ ko: () => `${key}는 true 또는 false다.`, en: () => `${key} must be true or false.` }), true, inputAt(key, { allowed: [true, false] }));
      character[key] = value; labels.push(`${key}=${value}`);
    }
    if (rest.fontFamily !== undefined) {
      if (typeof rest.fontFamily !== 'string' || !rest.fontFamily.trim() || rest.fontFamily.length > 128) return fail('INVALID_ARGUMENT', L({ ko: 'fontFamily는 1~128자의 글꼴 이름이다.', en: "fontFamily must be a font name of 1–128 characters." }), true, inputAt('fontFamily', { allowed: { minLength: 1, maxLength: 128 } }));
      character.fontFamily = rest.fontFamily; labels.push(`fontFamily=${rest.fontFamily}`);
    }
    if (rest.fontLanguage !== undefined) {
      if (typeof rest.fontLanguage !== 'number' || !Number.isInteger(rest.fontLanguage) || rest.fontLanguage < 0 || rest.fontLanguage > 6 || !character.fontFamily)
        return fail('INVALID_ARGUMENT', L({ ko: 'fontLanguage는 fontFamily와 함께 쓰는 0~6 정수다.', en: "fontLanguage must be an integer from 0 to 6, used with fontFamily." }), true, inputAt('fontLanguage', character.fontFamily ? { allowed: { minimum: 0, maximum: 6 } } : { rule: 'requires fontFamily' }));
      character.fontLanguage = rest.fontLanguage; labels.push(`fontLanguage=${rest.fontLanguage}`);
    }
    for (const [key, property] of [['color', 'textColor'], ['highlight', 'shadeColor']] as const) {
      const value = rest[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) return fail('INVALID_ARGUMENT', LT({ ko: () => `${key}는 #RRGGBB 형식이다.`, en: () => `${key} must use #RRGGBB format.` }), true, inputAt(key, { allowed: '#RRGGBB' }));
      character[property] = value; labels.push(`${key}=${value}`);
    }
    const size = number('fontSizePt', 1, 400), indent = number('indentMm', -200, 200), spacing = number('lineSpacingPercent', 50, 500), before = number('spaceBeforePt', 0, 500), after = number('spaceAfterPt', 0, 500);
    if (size !== undefined) character.fontSize = size;
    // The engine stores indent in doubled HWP units and paragraph spacing in HWP units (7200 per inch, 100 per point).
    if (indent !== undefined) paragraph.indent = Math.round(indent * 7200 / 25.4 * 2);
    if (spacing !== undefined) { paragraph.lineSpacing = Math.round(spacing); paragraph.lineSpacingType = 'Percent'; }
    if (before !== undefined) paragraph.spacingBefore = Math.round(before * 100);
    if (after !== undefined) paragraph.spacingAfter = Math.round(after * 100);
    if (rest.align !== undefined) {
      if (rest.align !== 'left' && rest.align !== 'center' && rest.align !== 'right' && rest.align !== 'justify') return fail('INVALID_ARGUMENT', L({ ko: 'align은 left, center, right, justify 중 하나다.', en: "align must be left, center, right, or justify." }), true, inputAt('align', { allowed: ['left', 'center', 'right', 'justify'] }));
      paragraph.alignment = rest.align; labels.push(`align=${rest.align}`);
    }
    const known = ['bold', 'italic', 'underline', 'strikethrough', 'fontFamily', 'fontLanguage', 'color', 'highlight', 'fontSizePt', 'indentMm', 'lineSpacingPercent', 'spaceBeforePt', 'spaceAfterPt', 'align'];
    const unknown = Object.keys(rest).filter(key => !known.includes(key));
    if (unknown.length) return fail('INVALID_ARGUMENT', LT({ ko: () => `알 수 없는 인자: ${unknown.join(', ')}`, en: () => `Unknown arguments: ${unknown.join(', ')}` }), true, inputAt(unknown[0], { rule: 'additionalProperties', allowed: known }));
    if (style !== undefined && (control(style) || !(style as string).length)) return fail('INVALID_ARGUMENT', L({ ko: 'style은 문단 스타일 이름이다.', en: "style is a paragraph style name." }), true, inputAt('style'));
    const hasCharacter = Object.keys(character).length > 0, hasParagraph = Object.keys(paragraph).length > 0;
    if (!hasCharacter && !hasParagraph && style === undefined) return fail('INVALID_ARGUMENT', L({ ko: '서식 인자를 하나 이상 줘라.', en: "Supply at least one formatting argument." }), true, inputAt('$', { rule: 'at least one format', allowed: [...known, 'style'] }));
    if (find !== undefined && (typeof find !== 'string' || !find.length)) return fail('INVALID_ARGUMENT', L({ ko: 'find는 비어 있지 않은 문자열이다.', en: "find must be a nonempty string." }), true, inputAt('find', { allowed: { minLength: 1 } }));
    if (find !== undefined && (hasParagraph || style !== undefined)) return fail('INVALID_ARGUMENT', L({ ko: 'find와 함께는 글자 서식만 준다. 문단 서식과 style은 find 없이 문단 전체에 준다.', en: "With find, supply character formatting only. Apply paragraph formatting/style to the entire paragraph without find." }), true,
      inputAt(style !== undefined ? 'style' : Object.keys(rest).find(key => ['indentMm', 'lineSpacingPercent', 'spaceBeforePt', 'spaceAfterPt', 'align'].includes(key))!, { rule: 'not allowed with find' }));
    if (typeof handle !== 'string' || !handle.startsWith(`${epoch.id}:`)) return fail('HANDLE_EXPIRED', L({ ko: 'target의 핸들이 지금 문서 상태의 것이 아니다. 다시 읽어 새 핸들을 써라.', en: "The target handle does not belong to the current document state. Reread and use a fresh handle." }), true, inputAt('target'));
    const all = await this.env.api.query.paragraphs(epoch.path, { includeCells: true });
    await this.unchanged(state, epoch, fail);
    const handles = await this.env.handles(epoch, all), found = all[handles.indexOf(handle)];
    if (!found) return fail('HANDLE_EXPIRED', LT({ ko: () => `${handle}은 본문이나 표 칸의 문단 핸들이 아니다. read_document가 준 문단 핸들을 써라.`, en: () => `${handle} is not a body or table-cell paragraph handle. Use a paragraph handle from read_document.` }), true, inputAt('target'));
    if (found.address.cellPath?.length && !/:t\d+:r\d+c\d+\.p\d+$/.test(handle)) return fail('UNSUPPORTED_TARGET', L({ ko: '글상자와 중첩 표 안은 서식을 바꾸지 않는다.', en: "Formatting in text boxes and nested tables is not changed." }), false, inputAt('target'));
    const source = Array.from(found.text);
    if (match !== undefined) {
      if (!hasCharacter || hasParagraph || style !== undefined || find !== undefined) return fail('INVALID_ARGUMENT', L({ ko: 'match에는 글자 서식 변경만 지정하라.', en: "With match, specify character formatting changes only." }), true, inputAt('match', { rule: 'character format only' }));
      const model = await this.env.api.query.formatting(epoch.path, { runs: 'model' });
      await this.unchanged(state, epoch, fail);
      const format = model.paragraphs.find(p => p.address.kind === 'body' && addressKey(p.address) === addressKey(found.address));
      if (!format || format.characterCoverage !== 'complete') return fail('UNSUPPORTED_TARGET', L({ ko: '이 문단의 글자 서식 구간을 완전히 조회할 수 없다.', en: "Cannot read all character formatting runs for this paragraph." }), false, inputAt('target'));
      const conditions = match as JsonObject;
      const runs = format.characterRuns.filter(run => (conditions.color === undefined || run.properties.textColor?.toLowerCase() === (conditions.color as string).toLowerCase())
        && (conditions.fontSizePt === undefined || run.properties.fontSize === conditions.fontSizePt));
      if (!runs.length) return fail('TEXT_NOT_FOUND', L({ ko: '지정한 서식 조건을 만족하는 구간이 없다. 바꾸지 않았다.', en: "No runs match the specified formatting conditions. Nothing changed." }), true, inputAt('match'));
      const observed = this.observations.shown(ctx.caller, ctx.observations, state);
      if (observed.get(addressKey(found.address))?.get(found.text) !== true || runs.some(run => observed.get(runKey(found.address, run))?.get(runText(run)) !== true))
        return fail('OBSERVATION_REQUIRED', L({ ko: '본문 전체와 조건에 맞는 모든 구간을 read_document(mode=formatting)으로 먼저 조회하라. nextRunOffset으로 이어 읽는다.', en: "First read the entire body text and all matching runs with read_document(mode=formatting). Continue with nextRunOffset." }), true);
      if (guard && runs.some(run => !guard.covers(found.address, run.offset, run.offset + run.length))) return await this.outside(guard, epoch, fail, L({ ko: '조건에 맞는 서식 구간은', en: "Matching formatting runs" }));
      const commands: Command[] = runs.map(run => ({ type: 'formatText', target: target(found.address), start: run.offset, end: run.offset + run.length, properties: character }));
      const changed = [{ handle, before: clip(found.text), after: LT({ ko: () => `[조건부 서식 ${labels.join(', ')}] ${clip(found.text)}`, en: () => `[Conditional formatting ${labels.join(', ')}] ${clip(found.text)}` }) }];
      const { applied, pages, meta } = await this.commit('format_text', ctx, state, epoch, receipt, operation, commands, changed, { summary: LT({ ko: () => `${handle} 조건부 서식`, en: () => `${handle} conditional formatting` }), marks: [{ address: found.address }] });
      guard?.kept(applied.revision);
      return { content: [{ type: 'text', text: LT({ ko: () => `${handle}의 관측한 ${runs.length}개 구간에 서식을 적용했다.`, en: () => `Applied formatting to ${runs.length} observed runs in ${handle}.` }) }],
        structuredContent: { ok: true, changed, matchedRuns: runs.length, ranges: runs.map(run => ({ offset: run.offset, length: run.length })), undoAvailable: applied.canUndo, changedPages: pages.slice(0, 50) }, _meta: meta };
    }
    let start = 0, end = source.length;
    if (typeof find === 'string') {
      const offsets = this.matches([found], [handle], find, undefined)[0]?.offsets ?? [];
      if (!offsets.length) return fail('TEXT_NOT_FOUND', LT({ ko: () => `"${find}"가 ${handle}에 없다. 바꾸지 않았다.`, en: () => `"${find}" is not in ${handle}. Nothing changed.` }), true, inputAt('find'));
      if (offsets.length > 1) return fail('AMBIGUOUS_MATCH', LT({ ko: () => `"${find}"가 ${handle}에 ${offsets.length}곳 있어 바꾸지 않았다. 앞뒤 글자를 더해 한 곳만 가리켜라.`, en: () => `"${find}" occurs ${offsets.length} times in ${handle}; nothing changed. Add surrounding characters to identify one location.` }), true, inputAt('find', { total: offsets.length }));
      start = offsets[0]!; end = start + Array.from(find).length;
    }
    // Character formatting needs its exact stretch selected; paragraph formatting and a style apply to any paragraph the selection touches.
    if (guard && !(hasCharacter ? guard.covers(found.address, start, end) : guard.touches(found.address))) return await this.outside(guard, epoch, fail, LT({ ko: () => `${handle}의 그 부분은`, en: () => `That part of ${handle}` }));
    const seen = this.observations.shown(ctx.caller, ctx.observations, state).get(addressKey(found.address))?.get(found.text);
    if (find === undefined ? seen !== true : seen === undefined) {
      const long = Array.from(found.text).length > PREVIEW_CHARS * 5;
      return fail('OBSERVATION_REQUIRED', long ? L({ ko: '서식을 바꾸려는 문단을 전부 확인하지 않았다. read_document로 그 문단을 읽은 뒤 다시 요청하라.', en: "The formatting target paragraph has not been fully inspected. Read it with read_document before requesting again." }) : L({ ko: '아직 적용되지 않았다. 서식을 바꾸려는 문단의 지금 내용을 아래에 보여 주었다. 요청과 맞으면 같은 호출을 다시 보내면 적용된다.', en: "Not applied yet. Current target paragraph content is shown below. If it matches the request, send the same call again to apply." }), true,
        long ? {} : { blocks: [{ handle, text: found.text }], suggestion: observedRetrySuggestion() }, long ? {} : this.observations.record(ctx.caller, epoch, [{ handle, address: found.address, text: found.text }]));
    }
    const address = target(found.address), commands: Command[] = [];
    if (style !== undefined) { commands.push({ type: 'setParagraphStyle', target: address, styleId: await this.styleId(epoch, style as string, fail, 'style') }); labels.unshift(`style=${style as string}`); }
    if (hasParagraph) commands.push({ type: 'formatParagraph', target: address, properties: paragraph });
    if (hasCharacter && end > start) commands.push({ type: 'formatText', target: address, start, end, properties: character });
    if (!commands.length) return fail('UNSUPPORTED_TARGET', L({ ko: '빈 문단에는 글자 서식을 줄 수 없다.', en: "Character formatting cannot be applied to empty paragraphs." }), false, inputAt('target', { rule: 'nonempty paragraph' }));
    const piece = clip(source.slice(start, end).join(''));
    const changed = [{ handle, before: piece, after: LT({ ko: () => `[서식 ${labels.join(', ')}] ${piece}`, en: () => `[Formatting ${labels.join(', ')}] ${piece}` }) }];
    const { applied, pages, meta } = await this.commit('format_text', ctx, state, epoch, receipt, operation, commands, changed, { summary: LT({ ko: () => `${handle} 서식 ${labels.join(', ')}`, en: () => `${handle} formatting ${labels.join(', ')}` }), marks: [{ address: found.address }] });
    guard?.kept(applied.revision);
    return { content: [{ type: 'text', text: LT({ ko: () => `${handle}${find === undefined ? '' : `의 "${clip(find)}"`}에 서식 적용: ${labels.join(', ')}.`, en: () => `Applied formatting to ${handle}${find === undefined ? '' : ` phrase "${clip(find)}"`}: ${labels.join(', ')}.` }) }],
      structuredContent: { ok: true, changed, format: labels, changedPages: pages.slice(0, 50), undoAvailable: applied.canUndo }, _meta: meta };
  }

  /**
   * Read effect: what a save would keep, what this document cannot do, and which edits still wait for a person's save.
   * The preservation check is slow on large documents and holds the document queue, so one result is kept per revision.
   */
  async check(args: JsonObject, ctx: EditContext): Promise<ToolResult> {
    const { state, epoch } = await this.env.open(args.path, ctx.caller);
    const raw = args.pages;
    if (raw !== undefined && (!Array.isArray(raw) || !raw.length || raw.length > 5 || raw.some(page => typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > state.pageCount)))
      throw new HwpHandsError('INVALID_ARGUMENT', LT({ ko: () => `pages는 1부터 ${state.pageCount}까지의 쪽 번호 1~5개다.`, en: () => `pages must contain 1–5 page numbers from 1 to ${state.pageCount}.` }));
    const pages = raw === undefined ? undefined : [...new Set(raw as number[])];
    const pending = this.env.bridge.pendingEdits(state.sessionId), applied = (this.log.get(epoch.path) ?? []).filter(item => item.sessionId === state.sessionId);
    const key = JSON.stringify([state.sessionId, state.revision, pages ?? null, pending, applied.length]), cached = this.checks.get(epoch.path);
    if (cached?.key === key) return cached.result;
    const report = await this.env.api.query.verify(epoch.path, { expectedRevision: state.revision, ...(pages ? { pages: pages.map(page => page - 1) } : {}) });
    const capabilities = await this.env.api.query.capabilities(epoch.path);
    const lines = [
      LT({ ko: () => `문서 ${state.path} · ${state.pageCount}쪽${state.dirty ? ' · 저장 안 한 변경 있음' : ''}`, en: () => `Document ${state.path} · ${state.pageCount} pages${state.dirty ? ' · unsaved changes' : ''}` }),
      LT({ ko: () => `저장 보존 검증(${report.targetFormat}, ${report.pages.rendered.map(page => page.page + 1).join('·') || '쪽 없음'}쪽 비교): ${report.passed ? '통과' : '차이 있음'}`, en: () => `Save preservation validation (${report.targetFormat}; compared pages ${report.pages.rendered.map(page => page.page + 1).join('·') || 'none'}): ${report.passed ? 'passed' : 'differences found'}` }),
      ...report.differences.slice(0, 10).map(item => LT({ ko: () => `- 차이: ${clip(item)}`, en: () => `- Difference: ${clip(item)}` })),
      ...(report.error ? [L({ ko: `- 오류: ${clip(report.error.message)}`, en: `- Error: ${clip(report.error.message)}` })] : []),
      ...report.warnings.slice(0, 5).map(item => LT({ ko: () => `- 경고: ${clip(item)}`, en: () => `- Warning: ${clip(item)}` })),
      capabilities.readOnly ? LT({ ko: () => `편집 불가: ${capabilities.readOnlyReasons.map(clip).join(' / ')}`, en: () => `Editing unavailable: ${capabilities.readOnlyReasons.map(clip).join(' / ')}` }) : L({ ko: '편집 가능', en: "Editing available" }),
      ...capabilities.limitations.map(item => LT({ ko: () => `- 제한: ${item}`, en: () => `- Limitation: ${item}` })),
      ...(capabilities.ambiguousFieldNames.length ? [LT({ ko: () => `- 이름이 겹쳐 fill_fields로 채울 수 없는 누름틀: ${capabilities.ambiguousFieldNames.slice(0, MAX_NAMES).join(', ')}`, en: () => `- Duplicate-name input fields that fill_fields cannot fill: ${capabilities.ambiguousFieldNames.slice(0, MAX_NAMES).join(', ')}` })] : []),
      LT({ ko: () => `사람의 저장을 기다리는 AI 편집 ${pending.ai}건${pending.unknown ? `, 주체를 모르는 편집 ${pending.unknown}건` : ''}`, en: () => `${pending.ai} AI edits awaiting a person's save${pending.unknown ? `, ${pending.unknown} edits with unknown actors` : ''}` }),
      ...applied.slice(-20).map(item => `- ${item.tool}: ${item.summary}`),
      ...(applied.length ? [L({ ko: '(위 목록은 이 도구들이 적용한 편집이다. 사람이 그 뒤 되돌렸을 수 있다.)', en: "(The list above records edits applied by these tools. A person may have undone them afterward.)" })] : []),
    ];
    const result: ToolResult = { content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { preservation: { passed: report.passed, format: report.targetFormat, differences: report.differences.slice(0, 10).map(clip), pages: report.pages.rendered.map(page => page.page + 1) },
        readOnly: capabilities.readOnly, pendingAiEdits: pending.ai, pendingUnknownEdits: pending.unknown, appliedEdits: applied.slice(-20).map(item => ({ tool: item.tool, summary: item.summary })) },
      _meta: { 'dev.agentinterop/resource': { path: epoch.path, sessionId: epoch.sessionId, documentEpoch: epoch.id, revision: state.revision } } };
    this.checks.set(epoch.path, { key, result });
    return result;
  }

  private async undo(caller: Caller, state: State, epoch: EditEpoch, receipt: (applied: 'yes' | 'no' | 'unknown', extra?: JsonObject) => JsonObject, signal?: AbortSignal): Promise<ToolResult> {
    const last = this.last.get(epoch.path), operation = operationId([state.path, 'undo', last?.revision ?? 0]);
    const refuse = (message: string): never => { throw new EditError('REVISION_CONFLICT', message, false, {}, receipt('no', { operationId: operation })); };
    if (!last || last.conversation !== conversationOf(caller) || last.sessionId !== state.sessionId) return refuse(L({ ko: '이 대화가 이 문서에서 되돌릴 수 있는 AI 편집이 없다.', en: "This conversation has no AI edit it can undo in this document." }));
    if (last.revision !== state.revision || !state.canUndo) return refuse(L({ ko: '마지막 AI 편집 뒤에 문서가 바뀌어 되돌리지 않았다. 사람의 편집을 지우지 않는다.', en: "The document changed after the last AI edit; nothing was undone. Human edits are not removed." }));
    // The manager checks for a typing person inside the document queue, before and after the restore.
    const after = await this.env.bridge.undo(epoch.path, { expectedRevision: state.revision }, signal);
    // An empty undo stack answers without an error and without a new revision.
    if (after.revision === state.revision) return refuse(L({ ko: '되돌릴 편집이 없다.', en: "No edit to undo." }));
    if (last.selection) {
      const { range, before } = last.selection;
      if (!before.empty) delete range.empty;
      Object.assign(range, before, { revision: after.revision });
    }
    this.env.marks?.undone(epoch.path, after.sessionId, after.revision);
    this.last.delete(epoch.path);
    this.log.get(epoch.path)?.pop();
    // Undo restores a snapshot: nothing proves which handles survive, so all of them expire.
    this.env.expire(epoch.path);
    return { content: [{ type: 'text', text: L({ ko: '마지막 AI 편집을 되돌렸다. 핸들이 모두 바뀌었으니 계속 편집하려면 문서를 다시 읽어라.', en: "Undid the last AI edit. All handles changed; reread before continuing to edit." }) }], structuredContent: { ok: true, undone: true },
      _meta: receipt('yes', { revisionAfter: after.revision, undo: { available: false }, operationId: operation }) };
  }

  /** Reload, rename and close end everything this layer knew about the session. */
  sessionEnded(path: string, sessionId: string): void {
    this.last.delete(path); this.log.delete(path); this.checks.delete(path); this.env.marks?.clear(path);
    this.clearFormatApprovals(item => item.path === path || item.sessionId === sessionId);
    this.observations.forget(item => item.sessionId === sessionId);
  }
  documentChanged(path: string, sessionId: string): void { this.clearFormatApprovals(item => item.path === path && item.sessionId === sessionId); }
  released(caller: Caller): void { this.observations.forget(item => item.conversation === conversationOf(caller)); this.clearFormatApprovals(item => item.conversation === conversationOf(caller)); }
  /** A save approves what was applied so far: the list for check_before_save starts again. */
  saved(path: string): void { this.log.delete(path); this.env.marks?.clear(path); }
  private clearFormatApprovals(predicate: (item: { path: string; sessionId: string; conversation: string }) => boolean): void {
    for (const [key, item] of this.formatApprovals) if (predicate(item)) { item.controller.abort(); this.formatApprovals.delete(key); }
  }
  dispose(): void { this.clearFormatApprovals(() => true); this.last.clear(); this.log.clear(); this.checks.clear(); this.observations.clear(); }
}

import { HwpHandsError, type BodyAddress, type HwpHandsApiV1, type RootOutputAnchor } from './api';
import { copyRootOutputAnchors } from './output-anchor-candidates';

type View = {
  readViewContext(): { context: { path: string; sessionId: string; revision: number; humanInput: { composing: boolean; draftPending: boolean } } } | undefined;
  revealPlace(target: { address: BodyAddress }, signal?: AbortSignal): Promise<void>;
};
type Request = { path: string; archiveSha256: string; anchor: RootOutputAnchor; sessionId: string; revision: number };

/** Human-only navigation: never opens a new view or changes document contents. */
export async function revealOutputAnchor(api: HwpHandsApiV1, input: Request,
  findView: (path: string) => View | undefined, focus: (view: View) => Promise<void>, signal?: AbortSignal) {
  const check = () => { if (signal?.aborted) throw new HwpHandsError('CANCELLED', 'Output navigation cancelled.'); };
  check();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HwpHandsError('INVALID_ARGUMENT', 'Invalid output navigation request.');
  const fields = Object.getOwnPropertyDescriptors(input);
  const value = (name: string): unknown => fields[name] && 'value' in fields[name] ? fields[name].value : undefined;
  const path = value('path'), archiveSha256 = value('archiveSha256'), sessionId = value('sessionId'), revision = value('revision');
  if (typeof path !== 'string' || !path || path.length > 4096 || typeof archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(archiveSha256) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || !Number.isSafeInteger(revision) || (revision as number) < 0)
    throw new HwpHandsError('INVALID_ARGUMENT', 'Invalid output navigation identity.');
  const [anchor] = copyRootOutputAnchors([value('anchor') as RootOutputAnchor]);
  const fixed = { path, archiveSha256, sessionId, revision: revision as number, anchor };
  if (!api.query.outputAnchorCandidatesIfOpen) throw new HwpHandsError('VERIFY_FAILED', 'Bounded output lookup is unavailable.');
  const view = findView(fixed.path);
  const matches = () => {
    const context = view?.readViewContext()?.context;
    return !!context && findView(fixed.path) === view && context.path === fixed.path && context.sessionId === fixed.sessionId &&
      context.revision === fixed.revision && !context.humanInput.composing && !context.humanInput.draftPending;
  };
  if (!view || !matches()) throw new HwpHandsError('REVISION_CONFLICT', 'The visible document is unavailable or changed.');
  const result = await api.query.outputAnchorCandidatesIfOpen(fixed.path, fixed.archiveSha256, [fixed.anchor]);
  check();
  const candidate = result.candidates[0];
  if (!matches() || result.archiveSha256 !== fixed.archiveSha256 || result.sessionId !== fixed.sessionId || result.revision !== fixed.revision ||
      result.candidates.length !== 1 || !candidate || candidate.state !== 'candidate' ||
      candidate.blockIndex !== fixed.anchor.blockIndex || candidate.address.sessionId !== fixed.sessionId ||
      candidate.address.revision !== fixed.revision || candidate.address.section !== fixed.anchor.section ||
      candidate.address.paragraph !== fixed.anchor.paragraph || candidate.address.cellPath?.length)
    throw new HwpHandsError('REVISION_CONFLICT', 'The document changed before navigation.');
  await view.revealPlace({ address: candidate.address }, signal);
  check();
  if (!matches()) throw new HwpHandsError('REVISION_CONFLICT', 'The document changed during navigation.');
  await focus(view);
  check();
  if (!matches()) throw new HwpHandsError('REVISION_CONFLICT', 'The document changed while focusing the view.');
  return { revealed: true as const, located: true as const };
}

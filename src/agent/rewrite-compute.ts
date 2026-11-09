import { alignRewrite, RewriteAlignmentError, type RewritePair, type RewriteSource, type RewriteSplitHint } from './rewrite-align';
import { rewriteDiff, rewriteHunks, type RewriteHunk } from './rewrite-diff';

export type RewriteComputeRequest =
  | { kind: 'align'; source: RewriteSource[]; output: string[]; hints: RewriteSplitHint[]; steps: number }
  | { kind: 'diff'; before: string; after: string; steps: number };
export type RewriteComputeResult =
  | { ok: true; kind: 'align'; pairs: RewritePair[]; steps: number }
  | { ok: true; kind: 'diff'; hunks: RewriteHunk[]; steps: number }
  | { ok: false; reason: 'limit' | 'ambiguous' | 'delete' | 'invalid-hint' | 'cancelled'; details: Record<string, unknown> };

/** Pure and bounded; a worker can compute it without access to document state. */
export function computeRewrite(request: RewriteComputeRequest): RewriteComputeResult {
  const budget = { steps: request.steps };
  try {
    if (request.kind === 'align') {
      const pairs = alignRewrite(request.source, request.output, request.hints, () => false, budget);
      return { ok: true, kind: 'align', pairs, steps: budget.steps };
    }
    const hunks = rewriteHunks(rewriteDiff(request.before, request.after, 20_000_000, budget));
    return { ok: true, kind: 'diff', hunks, steps: budget.steps };
  } catch (error) {
    if (error instanceof RewriteAlignmentError) return { ok: false, reason: error.reason, details: error.details };
    if (error instanceof Error && error.message === 'rewrite diff step limit exceeded') return { ok: false, reason: 'limit', details: { item: 'diff', limit: 20_000_000 } };
    throw error;
  }
}

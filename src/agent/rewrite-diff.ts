/** Deterministic code-point Myers edit script. The budget bounds both search and backtracking memory. */
export type RewriteEdit = { kind: 'equal' | 'delete' | 'insert'; text: string };
export type RewriteHunk = { start: number; removed: number; inserted: string };
export const REWRITE_DIFF_VERSION = 'myers-codepoint-v1';
export function rewriteDiff(before: string, after: string, maxSteps = 20_000_000, budget: { steps: number } = { steps: 0 }): RewriteEdit[] {
  const a = Array.from(before), b = Array.from(after), max = a.length + b.length;
  const tick = () => { if (++budget.steps > maxSteps) throw new Error('rewrite diff step limit exceeded'); };
  // Dense diagonals avoid copying thousands of Map entries on long differences.
  // -1 means an absent diagonal; the exact number of present keys still counts
  // toward the same deterministic budget used by the original algorithm.
  const center = max + 1, v = new Int32Array(2 * max + 3).fill(-1);
  v[center + 1] = 0;
  let present = 1;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    budget.steps += present;
    if (budget.steps > maxSteps) throw new Error('rewrite diff step limit exceeded');
    trace.push(v.slice(center - d - 1, center + d + 2));
    for (let k = -d; k <= d; k += 2) {
      tick();
      // On equal progress choose deletion.
      const left = v[center + k - 1], right = v[center + k + 1];
      let x = k === -d || (k !== d && left < right) ? Math.max(0, right) : Math.max(0, left) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { tick(); x++; y++; }
      if (v[center + k] === -1) present++;
      v[center + k] = x;
      if (x >= a.length && y >= b.length) {
        const reversed: RewriteEdit[] = [];
        for (let depth = d; depth > 0; depth--) {
          const previous = trace[depth], diagonal = x - y;
          const at = (k: number) => previous[k + depth + 1] ?? -1;
          const prevK = diagonal === -depth || (diagonal !== depth && at(diagonal - 1) < at(diagonal + 1)) ? diagonal + 1 : diagonal - 1;
          const prevX = Math.max(0, at(prevK)), prevY = prevX - prevK;
          while (x > prevX && y > prevY) { tick(); reversed.push({ kind: 'equal', text: a[--x] }); y--; }
          if (x === prevX) reversed.push({ kind: 'insert', text: b[--y] });
          else reversed.push({ kind: 'delete', text: a[--x] });
        }
        while (x > 0 && y > 0) { tick(); reversed.push({ kind: 'equal', text: a[--x] }); y--; }
        const result: RewriteEdit[] = [];
        for (const edit of reversed.reverse()) {
          const last = result.at(-1);
          if (last?.kind === edit.kind) last.text += edit.text;
          else result.push({ ...edit });
        }
        return result;
      }
    }
  }
  throw new Error('rewrite diff failed');
}

/** Adjacent inserts and deletes form one replacement; equal spans are never merged. */
export function rewriteHunks(edits: RewriteEdit[]): RewriteHunk[] {
  const hunks: RewriteHunk[] = [];
  let offset = 0, pending: RewriteHunk | undefined;
  for (const edit of edits) {
    const length = Array.from(edit.text).length;
    if (edit.kind === 'equal') { pending = undefined; offset += length; continue; }
    if (!pending) { pending = { start: offset, removed: 0, inserted: '' }; hunks.push(pending); }
    if (edit.kind === 'delete') { pending.removed += length; offset += length; }
    else pending.inserted += edit.text;
  }
  return hunks;
}

export type RewriteShapeRun = { startOffset: number; endOffset: number; charShapeId: number };

/** Compute the complete result runs from the original runs before any text is changed. */
export function rewriteShapeRuns(before: string, after: string, runs: RewriteShapeRun[], edits: RewriteEdit[]): RewriteShapeRun[] {
  const old = Array.from(before), updated = Array.from(after), shapes: number[] = [];
  for (const run of runs) {
    if (!Number.isSafeInteger(run.startOffset) || !Number.isSafeInteger(run.endOffset)
      || run.startOffset !== shapes.length || run.endOffset <= run.startOffset || run.endOffset > old.length
      || !Number.isSafeInteger(run.charShapeId) || run.charShapeId < 0) throw new Error('invalid original shape runs');
    while (shapes.length < run.endOffset) shapes.push(run.charShapeId);
  }
  if (!old.length || shapes.length !== old.length) throw new Error('incomplete original shape runs');
  if (edits.filter(edit => edit.kind !== 'insert').map(edit => edit.text).join('') !== before
    || edits.filter(edit => edit.kind !== 'delete').map(edit => edit.text).join('') !== after) throw new Error('invalid rewrite script');
  const result: number[] = [], hunks = rewriteHunks(edits);
  let offset = 0;
  for (const hunk of hunks) {
    result.push(...shapes.slice(offset, hunk.start));
    const inserted = Array.from(hunk.inserted).length;
    if (inserted === hunk.removed) result.push(...shapes.slice(hunk.start, hunk.start + hunk.removed));
    else if (inserted) {
      const anchor = hunk.removed ? hunk.start : Math.max(0, hunk.start - 1);
      const shape = shapes[anchor];
      if (shape === undefined) throw new Error('missing original shape anchor');
      for (let i = 0; i < inserted; i++) result.push(shape);
    }
    offset = hunk.start + hunk.removed;
  }
  result.push(...shapes.slice(offset));
  if (result.length !== updated.length) throw new Error('incomplete rewritten shape runs');
  const output: RewriteShapeRun[] = [];
  result.forEach((shape, index) => {
    const last = output.at(-1);
    if (last?.charShapeId === shape) last.endOffset++;
    else output.push({ startOffset: index, endOffset: index + 1, charShapeId: shape });
  });
  return output;
}

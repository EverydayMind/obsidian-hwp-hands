/** Paragraph alignment for rewrite v1. All coordinates refer to the original arrays. */
export type RewriteSource = { handle: string; text: string };
export type RewriteSplitHint = { source: string; outputStart: number; outputEnd: number };
export type RewritePair = { kind: 'unchanged' | 'modify' | 'insert' | 'split'; source?: number; outputStart: number; outputEnd: number; lowSimilarityPair?: boolean };
export class RewriteAlignmentError extends Error {
  constructor(readonly reason: 'limit' | 'ambiguous' | 'delete' | 'invalid-hint' | 'cancelled', readonly details: Record<string, unknown> = {}) { super(reason); }
}
export const REWRITE_ALIGNMENT_VERSION = 'paragraph-alignment-v1';
const SCALE = 1_000_000, MAX_STEPS = 20_000_000;

export function alignRewrite(source: RewriteSource[], output: string[], hints: RewriteSplitHint[] = [], cancelled: () => boolean = () => false, budget: { steps: number } = { steps: 0 }): RewritePair[] {
  const tick = (amount = 1) => { budget.steps += amount; if (budget.steps > MAX_STEPS) throw new RewriteAlignmentError('limit', { item: 'steps', limit: MAX_STEPS }); };
  const check = () => { if (cancelled()) throw new RewriteAlignmentError('cancelled'); };
  const sourceChars = source.map(item => Array.from(item.text)), outputChars = output.map(value => Array.from(value));
  const checkSize = (values: string[][], maxItems: number, item: string) => {
    if (values.length > maxItems) throw new RewriteAlignmentError('limit', { item, limit: maxItems });
    if (values.some(value => !value.length || value.length > 2000)) throw new RewriteAlignmentError('limit', { item: `${item}.length`, limit: 2000 });
    if (values.reduce((sum, value) => sum + value.length, 0) > 20000) throw new RewriteAlignmentError('limit', { item: `${item}.total`, limit: 20000 });
  };
  checkSize(sourceChars, 40, 'source'); checkSize(outputChars, 50, 'output');
  if (new Set(source.map(item => item.handle)).size !== source.length) throw new RewriteAlignmentError('ambiguous');
  const blocks: Array<{ s: number; a: number; b: number; hint: boolean }> = [];
  let previousSource = -1, previousEnd = 0;
  for (const hint of hints) {
    const s = source.findIndex(item => item.handle === hint.source);
    if (s <= previousSource || !Number.isSafeInteger(hint.outputStart) || !Number.isSafeInteger(hint.outputEnd)
      || hint.outputStart < previousEnd || hint.outputStart < 0 || hint.outputEnd > output.length || hint.outputEnd < hint.outputStart + 2)
      throw new RewriteAlignmentError('invalid-hint');
    blocks.push({ s, a: hint.outputStart, b: hint.outputEnd, hint: true }); previousSource = s; previousEnd = hint.outputEnd;
  }
  // Find the longest sequence of exact pairs and reject distinct optimal sequences.
  const matches: Array<{ s: number; o: number; length: number; ways: number; next: number }> = [];
  for (let s = 0; s < source.length; s++) for (let o = 0; o < output.length; o++) if (source[s].text === output[o]) {
    const ownHint = blocks.find(block => block.s === s);
    const compatible = blocks.every(block => s < block.s ? o < block.a : s > block.s ? o >= block.b : o >= block.a && o < block.b);
    if (!compatible && source.filter(item => item.text === source[s].text).length === 1 && output.filter(item => item === output[o]).length === 1)
      throw new RewriteAlignmentError('invalid-hint');
    if (!ownHint && compatible) matches.push({ s, o, length: 1, ways: 1, next: -1 });
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    const current = matches[i]; let best = 0, ways = 0, next = -1;
    for (let j = i + 1; j < matches.length; j++) {
      tick(); const candidate = matches[j];
      if (candidate.s <= current.s || candidate.o <= current.o) continue;
      if (candidate.length > best) { best = candidate.length; ways = candidate.ways; next = j; }
      else if (candidate.length === best) ways = Math.min(2, ways + candidate.ways);
    }
    if (best) { current.length += best; current.ways = ways; current.next = next; }
  }
  let best = 0, ways = 0, first = -1;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match.length > best) { best = match.length; ways = match.ways; first = i; }
    else if (match.length === best) ways = Math.min(2, ways + match.ways);
  }
  if (ways > 1) throw new RewriteAlignmentError('ambiguous', { item: 'exact-pairs' });
  for (let index = first; index >= 0; index = matches[index].next) {
    const match = matches[index];
    blocks.push({ s: match.s, a: match.o, b: match.o + 1, hint: false });
  }
  blocks.sort((a, b) => a.s - b.s);
  for (let i = 1; i < blocks.length; i++) if (blocks[i].s === blocks[i - 1].s || blocks[i].a < blocks[i - 1].b) throw new RewriteAlignmentError('invalid-hint');
  const distance = (a: string[], b: string[]): number => {
    const limit = Math.floor(Math.max(a.length, b.length) / 2);
    // Equal edges do not contribute to edit distance; trimming them makes ordinary
    // small revisions inexpensive without changing the original similarity scale.
    let head = 0, tail = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) { tick(); head++; }
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) { tick(); tail++; }
    if (head || tail) { a = a.slice(head, a.length - tail); b = b.slice(head, b.length - tail); }
    if (!a.length || !b.length) return Math.min(limit + 1, Math.max(a.length, b.length));
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i <= limit ? i : Infinity);
    for (let i = 1; i <= a.length; i++) {
      const row = Array<number>(b.length + 1).fill(Infinity); if (i <= limit) row[0] = i;
      let rowMin = row[0];
      for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
        tick(); row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); rowMin = Math.min(rowMin, row[j]);
      }
      if (rowMin > limit) return limit + 1;
      prev = row;
    }
    return Math.min(limit + 1, prev[b.length]);
  };
  const cost = (s: number, o: number) => Math.round(distance(sourceChars[s], outputChars[o]) * SCALE / Math.max(sourceChars[s].length, outputChars[o].length));
  const result: RewritePair[] = [];
  const segment = (s0: number, s1: number, o0: number, o1: number) => {
    check(); const n = s1 - s0, m = o1 - o0;
    if (n > m) throw new RewriteAlignmentError('delete', { candidates: source.slice(s0, s1).map(item => item.handle) });
    if (!n) { for (let o = o0; o < o1; o++) result.push({ kind: 'insert', outputStart: o, outputEnd: o + 1 }); return; }
    if (n === m) {
      for (let i = 0; i < n; i++) { const s = s0 + i, o = o0 + i; result.push({ kind: source[s].text === output[o] ? 'unchanged' : 'modify', source: s, outputStart: o, outputEnd: o + 1, ...(cost(s, o) > SCALE / 2 ? { lowSimilarityPair: true } : {}) }); }
      return;
    }
    if (n * m > 400) throw new RewriteAlignmentError('limit', { item: 'alignment-cells', limit: 400 });
    const costs = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => cost(s0 + i, o0 + j)));
    type Cell = { cost: number; ways: number; choice: 'pair' | 'insert' | 'end' };
    const dp: Cell[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => ({ cost: Infinity, ways: 0, choice: 'end' as const })));
    dp[n][m] = { cost: 0, ways: 1, choice: 'end' };
    for (let i = n; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      const insertion = dp[i][j + 1], pair = i < n && costs[i][j] <= SCALE / 2 ? dp[i + 1][j + 1] : undefined;
      const insertCost = insertion.cost + SCALE, pairCost = pair ? pair.cost + costs[i][j] : Infinity;
      const minimum = Math.min(insertCost, pairCost);
      dp[i][j] = { cost: minimum, ways: Math.min(2, (insertCost === minimum ? insertion.ways : 0) + (pairCost === minimum ? pair?.ways ?? 0 : 0)), choice: pairCost < insertCost ? 'pair' : 'insert' };
    }
    if (!dp[0][0].ways || !Number.isFinite(dp[0][0].cost) || dp[0][0].ways > 1) throw new RewriteAlignmentError('ambiguous', { item: 'alignment' });
    let i = 0, j = 0;
    while (j < m) {
      if (dp[i][j].choice === 'pair') { result.push({ kind: 'modify', source: s0 + i, outputStart: o0 + j, outputEnd: o0 + j + 1 }); i++; }
      else result.push({ kind: 'insert', outputStart: o0 + j, outputEnd: o0 + j + 1 });
      j++;
    }
  };
  let s = 0, o = 0;
  for (const block of blocks) {
    segment(s, block.s, o, block.a);
    result.push({ kind: block.hint ? 'split' : 'unchanged', source: block.s, outputStart: block.a, outputEnd: block.b });
    s = block.s + 1; o = block.b;
  }
  segment(s, source.length, o, output.length);
  return result;
}

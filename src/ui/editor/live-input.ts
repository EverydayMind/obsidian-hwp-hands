/**
 * Commits typed input to the document while the user keeps typing (EDITOR_UX_PLAN §3.6 item 1).
 *
 * `delayMs` 0 commits as soon as no commit is in flight; keys typed while a commit runs are folded into the next one, so at most one
 * commit is in flight and the burst is never split into more commits than the engine can keep up with. A positive delay keeps the
 * compatibility editor's debounce: the commit starts only after the typing pauses for that long.
 */
export class LiveInputCommitScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private rerun = false;

  constructor(private readonly commit: () => Promise<void>, private readonly delayMs: () => number) {}

  schedule(): void {
    if (this.running) { this.rerun = true; return; }
    if (this.timer !== undefined) clearTimeout(this.timer);
    const delay = this.delayMs();
    if (!Number.isSafeInteger(delay) || delay < 0) throw new Error('Input commit delay must be a non-negative integer.');
    this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, delay);
  }

  private start(): void {
    this.rerun = false;
    const run: Promise<void> = Promise.resolve().then(this.commit).catch(() => undefined).finally(() => {
      if (this.running === run) this.running = undefined;
      if (this.rerun) { this.rerun = false; this.schedule(); }
    });
    this.running = run;
  }

  /** Drops a scheduled commit; a commit already in flight finishes but does not run again. */
  cancel(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    this.rerun = false;
  }

  get pending(): boolean { return this.timer !== undefined || this.rerun; }
  get inFlight(): boolean { return this.running !== undefined; }
}

export interface RebasedInput {
  /** How many paragraphs after the committed paragraph the caret paragraph is (the committed text split there). */
  paragraphDelta: number;
  /** The committed text of the caret paragraph, as the receiver shows it. */
  base: string;
  /** The receiver text for the caret paragraph, including keys typed during the commit. */
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }

/**
 * After `committed` (the receiver text a commit sent) was applied, the receiver holds `current`: the committed text plus keys typed while
 * the commit was in flight. A `\n` in the receiver is a paragraph boundary (decision 19), so the committed paragraph may now be several
 * paragraphs. Returns the caret paragraph's committed text and its receiver text with the later keys, so typing continues there as a new
 * draft. Returns undefined when the later keys touched another paragraph or the caret left the changed paragraph; such input cannot be
 * moved to one paragraph and stays a conflicting draft instead of being dropped.
 *
 * `splitsParagraphs` is false for a text box, where `\n` is a line break inside the one paragraph.
 */
export function rebaseTypedInput(committed: string, current: string, selectionStart: number, selectionEnd: number, splitsParagraphs = true): RebasedInput | undefined {
  if (selectionStart < 0 || selectionEnd < selectionStart || selectionEnd > current.length) return undefined;
  if (!splitsParagraphs) return { paragraphDelta: 0, base: committed, value: current, selectionStart, selectionEnd };
  let prefix = 0;
  while (prefix < committed.length && prefix < current.length && committed[prefix] === current[prefix]) prefix++;
  if (prefix > 0 && prefix < committed.length && isHighSurrogate(committed.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (suffix < committed.length - prefix && suffix < current.length - prefix
    && committed[committed.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix++;
  if (suffix > 0 && suffix < committed.length - prefix && isHighSurrogate(committed.charCodeAt(committed.length - suffix - 1))) suffix--;
  // With no later keys the caret paragraph is wherever the caret now is; otherwise it is the committed line that holds the change.
  const anchor = committed === current ? Math.min(selectionEnd, committed.length) : prefix;
  if (committed !== current && committed.slice(prefix, committed.length - suffix).includes('\n')) return undefined;
  const lineStart = anchor === 0 ? 0 : committed.lastIndexOf('\n', anchor - 1) + 1;
  const nextBreak = committed.indexOf('\n', anchor);
  const lineEnd = nextBreak < 0 ? committed.length : nextBreak;
  const tail = committed.length - lineEnd;
  const value = current.slice(lineStart, current.length - tail);
  const start = selectionStart - lineStart, end = selectionEnd - lineStart;
  if (start < 0 || end > value.length) return undefined;
  const paragraphDelta = committed.slice(0, lineStart).split('\n').length - 1;
  return { paragraphDelta, base: committed.slice(lineStart, lineEnd), value, selectionStart: start, selectionEnd: end };
}

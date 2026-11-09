export type ClipboardWriteResult = 'written' | 'failed' | 'notHandled';

/** The caller may delete selected text only after `written`. */
export function writeClipboardSelection(
  event: ClipboardEvent,
  copied: { text: string; html: string } | undefined,
  hasMultiParagraphSelection: boolean,
): ClipboardWriteResult {
  const data = event.clipboardData;
  if (!data || !copied) {
    if (hasMultiParagraphSelection) {
      event.preventDefault();
      return 'failed';
    }
    return 'notHandled';
  }
  event.preventDefault();
  try { data.setData('text/plain', copied.text); }
  catch { return 'failed'; }
  try { data.setData('text/html', copied.html); }
  catch { /* Plain text is enough to safely complete a cut. */ }
  return 'written';
}

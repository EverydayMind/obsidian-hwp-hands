import type { Field } from '../api';

/** The AI field tools address input fields only. Hyperlinks, dates, bookmarks and other fields share the
 * engine's field list (and its place numbering) but are not 누름틀 and are never filled by fill_fields.
 */
export const isInputField = (field: Field): boolean => field.fieldType === 'clickhere';

/** The link target of a HWP hyperlink command: the first `;` segment with `\` escapes removed, trimmed (as the core reads it). */
export function hyperlinkTarget(command: string): string {
  let out = '';
  for (let at = 0; at < command.length; at++) {
    const char = command[at];
    if (char === '\\') { if (at + 1 < command.length) out += command[++at]; }
    else if (char === ';') break;
    else out += char;
  }
  return out.trim();
}

const NETWORK = new Set(['http:', 'https:', 'ftp:']);
/** Only network URLs are judged: a malformed URL or a host name that is not letters/digits/hyphens after IDNA (STD3 rules).
 * Reachability, internal bookmark targets, other schemes and file paths are `unchecked`, never `valid`.
 */
export function linkVerdict(target: string): 'valid' | 'unchecked' | 'not-a-url' | 'invalid-host' {
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(target)?.[1]?.toLowerCase();
  if (!scheme || !NETWORK.has(`${scheme}:`)) return 'unchecked';
  let url: URL;
  try { url = new URL(target); } catch { return 'not-a-url'; }
  const host = url.hostname;
  if (!host) return 'invalid-host';
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'valid';
  return host.replace(/\.$/, '').split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ? 'valid' : 'invalid-host';
}

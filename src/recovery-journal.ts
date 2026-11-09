import { createHash } from 'node:crypto';
import { validatePersistedActors, type PersistedActors } from './edit-actors';

export interface RecoveryV3Header {
  version: 3;
  pluginVersion: string;
  engineVersion: string;
  commandSchema: number;
  path: string;
  baseHash: string;
  seedHash: string;
  seedBytes: number;
  seed: string;
  historyLimit: number;
  intendedSaveHash?: string;
  actors?: PersistedActors;
  recordHash: string;
}

export interface RecoveryV3Line {
  seq: number;
  prevHash: string;
  action: unknown;
  hash: string;
}

export interface RecoveryV3Record extends RecoveryV3Header {
  actions: unknown[];
  sequence: number;
  tailHash: string;
  truncatedTail: boolean;
}

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function headerBody(header: Omit<RecoveryV3Header, 'recordHash'>): Omit<RecoveryV3Header, 'recordHash'> {
  return {
    version: 3,
    pluginVersion: header.pluginVersion,
    engineVersion: header.engineVersion,
    commandSchema: header.commandSchema,
    path: header.path,
    baseHash: header.baseHash,
    seedHash: header.seedHash,
    seedBytes: header.seedBytes,
    seed: header.seed,
    historyLimit: header.historyLimit,
    ...(header.intendedSaveHash === undefined ? {} : { intendedSaveHash: header.intendedSaveHash }),
    ...(header.actors === undefined ? {} : { actors: header.actors }),
  };
}

export function createRecoveryV3Header(value: Omit<RecoveryV3Header, 'version' | 'recordHash'>): RecoveryV3Header {
  const body = headerBody({ version: 3, ...value });
  return { ...body, recordHash: digest(JSON.stringify(body)) };
}

export function createRecoveryV3Line(seq: number, prevHash: string, action: unknown): RecoveryV3Line {
  const body = { seq, prevHash, action };
  return { ...body, hash: digest(JSON.stringify(body)) };
}

export function encodeRecoveryV3(record: RecoveryV3Record): string {
  const header = createRecoveryV3Header(record);
  const lines = [JSON.stringify(header)];
  let previous = header.recordHash;
  for (let index = 0; index < record.actions.length; index++) {
    const line = createRecoveryV3Line(index + 1, previous, record.actions[index]);
    lines.push(JSON.stringify(line));
    previous = line.hash;
  }
  return `${lines.join('\n')}\n`;
}

export function decodeRecoveryV3(content: string, maxBytes: number): RecoveryV3Record {
  if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new Error('Recovery v3 log exceeds its byte limit.');
  const allLines = content.split('\n');
  const terminated = content.endsWith('\n');
  if (terminated) allLines.pop();
  else allLines.pop(); // A final non-newline record was not durably acknowledged; ignore that tail.
  if (!allLines.length || !allLines[0]) throw new Error('Recovery v3 checkpoint header is missing.');

  let rawHeader: unknown;
  try { rawHeader = JSON.parse(allLines[0]); }
  catch (error) { throw new Error(`Recovery v3 checkpoint header is invalid: ${String(error)}`); }
  if (!rawHeader || typeof rawHeader !== 'object' || Array.isArray(rawHeader)) throw new Error('Recovery v3 checkpoint header is invalid.');
  const candidate = rawHeader as Record<string, unknown>;
  const allowedKeys = ['version', 'pluginVersion', 'engineVersion', 'commandSchema', 'path', 'baseHash', 'seedHash', 'seedBytes', 'seed', 'historyLimit', 'intendedSaveHash', 'actors', 'recordHash'];
  if (Object.keys(candidate).some(key => !allowedKeys.includes(key)) || candidate.version !== 3
    || typeof candidate.pluginVersion !== 'string' || typeof candidate.engineVersion !== 'string'
    || !Number.isSafeInteger(candidate.commandSchema) || typeof candidate.path !== 'string'
    || typeof candidate.baseHash !== 'string' || typeof candidate.seedHash !== 'string'
    || !Number.isSafeInteger(candidate.seedBytes) || typeof candidate.seed !== 'string'
    || !Number.isSafeInteger(candidate.historyLimit)
    || (candidate.intendedSaveHash !== undefined && typeof candidate.intendedSaveHash !== 'string')
    || typeof candidate.recordHash !== 'string') throw new Error('Recovery v3 checkpoint fields are invalid.');
  const body = headerBody(candidate as unknown as Omit<RecoveryV3Header, 'recordHash'>);
  const expectedHeaderHash = digest(JSON.stringify(body));
  if (candidate.recordHash !== expectedHeaderHash) throw new Error('Recovery v3 checkpoint hash does not match.');
  if (candidate.actors !== undefined) validatePersistedActors(candidate.actors);
  const header = { ...body, recordHash: expectedHeaderHash };

  const actions: unknown[] = [];
  let previous = header.recordHash;
  let sequence = 0;
  for (const text of allLines.slice(1)) {
    if (!text) throw new Error('Recovery v3 contains an empty action line.');
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch (error) { throw new Error(`Recovery v3 action line ${sequence + 1} is invalid: ${String(error)}`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Recovery v3 action line ${sequence + 1} is invalid.`);
    const line = raw as Record<string, unknown>;
    if (Object.keys(line).length !== 4 || Object.keys(line).some(key => !['seq', 'prevHash', 'action', 'hash'].includes(key))
      || line.seq !== sequence + 1 || line.prevHash !== previous || typeof line.hash !== 'string' || !('action' in line)) {
      throw new Error(`Recovery v3 action chain is invalid at line ${sequence + 1}.`);
    }
    const expected = createRecoveryV3Line(line.seq, line.prevHash, line.action);
    if (line.hash !== expected.hash) throw new Error(`Recovery v3 action hash is invalid at line ${sequence + 1}.`);
    actions.push(line.action);
    previous = line.hash;
    sequence++;
  }
  return { ...header, actions, sequence, tailHash: previous, truncatedTail: !terminated };
}

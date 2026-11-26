import { readFileSync, renameSync, openSync, closeSync, fsyncSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface StateLock { readonly pid: number; readonly startedAt: string | null; readonly id: string; }

export function readLock(file: string): StateLock {
  const text = readFileSync(`${file}.lock`, 'utf8').trim();
  if (/^[1-9]\d*$/.test(text)) {
    const pid = Number(text);
    if (!Number.isSafeInteger(pid)) throw new Error('keeper lock invalid');
    return { pid, startedAt: null, id: `pid:${text}` };
  }
  const lock = JSON.parse(text) as StateLock;
  if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.startedAt !== 'string'
    || !/^\d+$/.test(lock.startedAt) || typeof lock.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(lock.id)) throw new Error('keeper lock invalid');
  return lock;
}

export function show(file: string): string {
  const lock = readLock(file);
  if (lock.startedAt === null) return `pid-only lock\npid: ${lock.pid}\nid: ${lock.id}\n`;
  const now = BigInt(Math.floor(Date.now() / 1000));
  return `pid: ${lock.pid}\nstartedAt: ${lock.startedAt}\nid: ${lock.id}\nage: ${now - BigInt(lock.startedAt)} seconds\n`;
}

/** Operator must first confirm the old process has exited. Never guess that from a pid or an age. */
export function adopt(file: string, id: string): boolean {
  try {
    if (readLock(file).id !== id) return false;
    renameSync(`${file}.lock`, `${file}.lock.${randomUUID()}.adopted`);
    const fd = openSync(dirname(file), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly(): boolean {
  try { const started = process.argv[1]; return started !== undefined && import.meta.url === pathToFileURL(realpathSync(started)).href; }
  catch { return false; }
}
if (startedDirectly()) {
  try {
    const [command, file, id, ...extra] = process.argv.slice(2);
    if (!file || extra.length || (command === 'show' ? id !== undefined : command !== 'adopt' || !id)) throw new Error();
    if (command === 'show') process.stdout.write(show(file));
    else if (!adopt(file, id as string)) throw new Error();
  } catch {
    process.stderr.write('keeper lock command refused\n'); process.exitCode = 1;
  }
}

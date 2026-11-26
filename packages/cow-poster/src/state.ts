import { mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Log, ReservationStore } from './types';

const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
export class FileReservations implements ReservationStore {
  constructor(private readonly directory: string, private readonly chainId: number) {}
  private path(uid: string): string {
    if (!/^0x[0-9a-fA-F]{112}$/.test(uid)) throw new Error('invalid UID');
    return join(this.directory, `${this.chainId}-${uid.toLowerCase()}.json`);
  }
  async has(uid: string): Promise<boolean> {
    try { await stat(this.path(uid)); return true; }
    catch (error) { if (code(error) === 'ENOENT') return false; throw error; }
  }
  async reserve(uid: string): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let file;
    try { file = await open(this.path(uid), 'wx', 0o600); }
    catch (error) { if (code(error) === 'EEXIST') return false; throw error; }
    try { await file.writeFile(JSON.stringify({ chainId: this.chainId, uid, attemptedAt: Date.now() }) + '\n'); await file.sync(); }
    finally { await file.close(); }
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  }
}
export async function writeHealth(path: string, data: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const file = await open(temp, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(data) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}
export function jsonLog(write: (line: string) => void = line => { process.stdout.write(line); }): Log {
  return (event, fields = {}) => write(JSON.stringify({ time: new Date().toISOString(), event, ...fields },
    (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) + '\n');
}

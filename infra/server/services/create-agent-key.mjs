// Explicit server-only bootstrap. Stack startup never generates a wallet.
import { openSync, closeSync, writeFileSync, fsyncSync, existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from './agents/chain.mjs';

export function createAgentKey(file, generate = generatePrivateKey) {
  if (existsSync(file)) throw new Error('existing key preserved');
  const key = generate(), address = privateKeyToAccount(key).address;
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, `${key}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  return address;
}
if (process.argv[1] && import.meta.url === (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })()) {
  try {
    const [action, ...extra] = process.argv.slice(2);
    if (extra.length || ![undefined, '--dry-run', '--create'].includes(action)) throw new Error();
    if (action !== '--create') process.stdout.write('agent wallet: dry run; no randomness or files accessed\n');
    else {
      if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error();
      process.stdout.write(`${createAgentKey('/run/service-config/manager.key')}\n`);
    }
  } catch { process.stderr.write('agent wallet refused; use the server root-owned mount; existing files preserved\n'); process.exitCode = 1; }
}

// Founder-only, explicitly invoked on the server. Stack startup never creates a key.
import { createRequire } from 'node:module';
import { openSync, writeFileSync, fsyncSync, closeSync, existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createDeskKey(file, generate) {
  if (existsSync(file)) throw new Error('existing key preserved');
  const { generatePrivateKey, privateKeyToAccount } = createRequire(new URL('../../../packages/keeper/package.json', import.meta.url))('viem/accounts');
  const key = (generate ?? generatePrivateKey)();
  const address = privateKeyToAccount(key).address;
  const fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, `${key}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return address;
}
if (process.argv[1] && import.meta.url === (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })()) {
  try {
    const [action, ...extra] = process.argv.slice(2);
    if (extra.length || ![undefined, '--dry-run', '--create'].includes(action)) throw new Error();
    if (action !== '--create') process.stdout.write('desk wallet: dry run; no randomness or files accessed\n');
    else {
      if (process.getuid() !== 0) throw new Error();
      process.stdout.write(`${createDeskKey('/run/service-config/desk.key')}\n`);
    }
  } catch { process.stderr.write('desk wallet refused; check empty root-owned mount; existing files preserved\n'); process.exitCode = 1; }
}

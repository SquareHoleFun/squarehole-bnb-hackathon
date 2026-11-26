// Founder-only, inside the keeper image with a writable configuration mount. Never called by stack startup.
import { createRequire } from 'node:module';
import { existsSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--create', '--dry-run'].includes(args[0]))) throw new Error();
  if (args[0] !== '--create') {
    process.stdout.write('keeper wallet: dry run; founder may create a new mounted gas wallet; no randomness or files accessed\n');
  } else {
    const file = '/run/service-config/gas.key';
    const addressFile = '/run/service-config/gas.address';
    if (existsSync(file) || existsSync(addressFile)) throw new Error();
    const { generatePrivateKey, privateKeyToAccount } = createRequire(new URL('../../../packages/keeper/package.json', import.meta.url))('viem/accounts');
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    for (const [path, content] of [[file, key], [addressFile, address]]) {
      // Owner-only: the keeper refuses a key file with any group or other permission bit (runtime.mjs readKeyFile).
      const fd = openSync(path, 'wx', path === file ? 0o600 : 0o640);
      try { writeFileSync(fd, `${content}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    }
    process.stdout.write('keeper wallet created; public address is in gas.address; key was not printed\n');
  }
} catch {
  process.stderr.write('keeper wallet refused; check empty mounted paths and ownership; existing files preserved\n');
  process.exitCode = 1;
}

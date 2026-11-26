import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const path = name => fileURLToPath(new URL(name, import.meta.url));
const ipc = process.argv[2] === 'ipc';
const child = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings=ExperimentalWarning',
  '--import', path('../../scripts/register-ts.mjs'), '--import', path('./native-block-hook.mjs'), path('../webp-child.ts')], {
  stdio: ipc ? ['pipe', 'ignore', 'ignore', 'ipc'] : ['pipe', 'ignore', 'ignore'],
  env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
});
process.send?.(child.pid);
const input = readFileSync(path('../../../artwork/src/picture-fixtures/lossless.webp'));
if (ipc) child.stdin.end(input);
else child.stdin.write(input); // The parent's death, not the input boundary, closes this pipe.

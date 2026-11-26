// File-backed stdio works in restricted Linux runners where Node's synchronous stdin socketpair gets EPERM.
// Keep actual exit/error checks and captured bytes. This changes no production command or assertion.
import { spawnSync as spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function spawnSync(command, args, options = {}) {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/command-'));
  const input = join(dir, 'stdin');
  writeFileSync(input, options.input ?? '');
  const out = join(dir, 'stdout');
  const err = join(dir, 'stderr');
  const stdio = [openSync(input, 'r'), openSync(out, 'w'), openSync(err, 'w')];
  let result;
  try { result = spawn(command, args, { ...options, input: undefined, stdio }); }
  finally { stdio.forEach(fd => closeSync(fd)); }
  const stdout = readFileSync(out, options.encoding ?? null);
  const stderr = readFileSync(err, options.encoding ?? null);
  return { ...result, stdout, stderr, output: [null, stdout, stderr] };
}

export function execFileSync(command, args, options = {}) {
  const result = spawnSync(command, args, options);
  if (result.error || result.status !== 0) throw Object.assign(new Error(`${command}: ${result.error?.message ?? result.stderr}`), result);
  return result.stdout;
}

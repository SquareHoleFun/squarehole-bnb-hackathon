#!/usr/bin/env node
import { spawn } from 'node:child_process';

// Catch module/dependency failures too: loader diagnostics can contain local paths and provider details.
try {
  const { main } = await import('./main.mjs');
  process.exitCode = await main(process.argv.slice(2), {
    fetch: globalThis.fetch, env: process.env, stdin: process.stdin,
    stdout: process.stdout, stderr: process.stderr, spawn,
    clock: () => BigInt(Date.now()),
    wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds.toString())),
  });
} catch {
  process.stderr.write('drand-rescue could not start\n');
  process.exitCode = 1;
}

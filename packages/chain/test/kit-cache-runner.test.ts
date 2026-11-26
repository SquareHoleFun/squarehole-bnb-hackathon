import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
// URL imports exercise the Node helper without adding production TypeScript declarations.
const { hasToolOverrides, kitInputKey, ROOT } = await import(new URL('../../../scripts/kits/cache.mjs', import.meta.url).href);

// Native-library identity currently supports Linux only; keep every assertion enabled there.
it.skipIf(process.platform !== 'linux')('kit reuse requires Linux: Vitest and plain Node compute the same key', () => {
  const key = kitInputKey();
  expect(hasToolOverrides(), 'the pinned Vitest launcher must permit reuse').toBe(false);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH; // Compare with plain Node outside pnpm's Vitest launcher.
  // A regular stdout file also works in sandboxes that drop child output through pipes.
  const output = join(mkdtempSync(join(tmpdir(), 'kit-cache-runner-')), 'key');
  const stdout = openSync(output, 'w');
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { kitInputKey } from './scripts/kits/cache.mjs';
      process.stdout.write(String(kitInputKey()));
    `], { cwd: ROOT, env, stdio: ['ignore', stdout, 'pipe'] });
  } finally { closeSync(stdout); }
  expect(readFileSync(output, 'utf8')).toBe(key);
}, shLimit(30_000)); // Includes starting a second Node process and its cold dependency inventory.

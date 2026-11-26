import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyAlphaControls } from './alpha-rehearsal.mjs';
import { ROOT, json, run } from './lib/core-v2-local-runtime.mjs';

// Independent fallback controls, not a replacement for alpha-rehearsal.integration.test.mjs.
// ALPHA_HARDFORK=amsterdam selects the runtime explicitly; there is no profile override.
test('real contract controls and actual revert bytes match the trade decoder', { timeout: 1_800_000 }, async () => {
  const hardfork = process.env.ALPHA_HARDFORK;
  assert.ok(hardfork === undefined || hardfork === 'amsterdam');
  const args = ['test', '--match-path', 'test/box-v2/sepolia-all/Alpha*.t.sol',
    // One test executes an entire release. Same aggregate budget as profile.sepolia-rehearsal;
    // deployment safety checks and the individual 4M/15M trade/graduate calls remain unchanged.
    '--gas-limit', '10000000000',
    '--out', '../../.cache/alpha-forge-out', '--cache-path', '../../.cache/alpha-forge-cache', '-vv',
    ...(hardfork ? ['--hardfork', hardfork] : [])];
  const output = await run('forge', args, { env: { FOUNDRY_OFFLINE: 'true', FOUNDRY_FUZZ_RUNS: '256', FOUNDRY_THREADS: '4' }, timeoutMs: 1_700_000 });
  const out = join(ROOT, '.cache/alpha-controls', hardfork ?? 'default');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'forge.log'), output);
  const proof = verifyAlphaControls(output);
  writeFileSync(join(out, 'proof.json'), json(proof));
  assert.equal(proof.complete, false, 'contract controls must not claim an Anvil integration pass');
  assert.ok(proof.calls.length > 30);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAlphaRehearsal } from './alpha-rehearsal.mjs';

// Explicit integration command; never silently skips when anvil/listeners/artifacts are unavailable.
// node --experimental-transform-types --test packages/chain/scripts/alpha-rehearsal.integration.test.mjs
test('SH-ALPHA-REHEARSAL: real fresh-chain alpha, receipts, refunds, errors and drain', { timeout: 1_800_000 }, async () => {
  const result = await runAlphaRehearsal();
  assert.equal(result.complete, true);
  assert.equal(result.manifest.chainId, 31337);
  assert.ok(result.transactions.length > 50);
  assert.ok(BigInt(result.drain.nativeOut) > 19n * 10n ** 17n);
  assert.ok(BigInt(result.drain.nativeOut) < 2n * 10n ** 18n);
  assert.ok(BigInt(result.partial.refund) > 0n);
  assert.equal(result.graduated, true);
});

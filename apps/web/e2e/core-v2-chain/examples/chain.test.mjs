import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifact } from './chain.mjs';
import { ROOT } from './support.mjs';

test('offline replay reads the current build artifacts, including mapped fixture source names', () => {
  const scratch = new URL('.cache/examples-e2e/abi-tests/', ROOT); mkdirSync(scratch, { recursive: true });
  const out = mkdtempSync(new URL('out-', scratch));
  for (const [name, source] of [['BoxReceiverV2', 'BoxReceiverV2.sol'], ['LocalERC20', 'LocalQuoteMocks.sol'], ['JunkyardGold', 'JunkyardLocal.s.sol']]) {
    mkdirSync(join(out, source), { recursive: true });
    writeFileSync(join(out, source, `${name}.json`), JSON.stringify({ abi: [], ticket: 'current-build', name }));
  }
  const previous = process.env.SH_EXAMPLES_ARTIFACTS; process.env.SH_EXAMPLES_ARTIFACTS = out;
  try {
    for (const name of ['BoxReceiverV2', 'LocalERC20', 'JunkyardGold']) assert.equal(artifact(name).ticket, 'current-build');
  } finally {
    if (previous === undefined) delete process.env.SH_EXAMPLES_ARTIFACTS; else process.env.SH_EXAMPLES_ARTIFACTS = previous;
  }
});

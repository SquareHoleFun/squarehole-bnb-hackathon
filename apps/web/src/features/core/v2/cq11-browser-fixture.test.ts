import { expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoreManifestV2 } from '../../../../../../packages/chain/src/core/v2';
import { mixedDeployment } from './test-support/mixed-deployment';

it('CQ11-E4: the actual Playwright build embeds the combined deployment used by chain-v2 scenarios', async () => {
  const { manifest, body } = await mixedDeployment();
  expect(manifest.releases[0]?.safes.platform.address).toBe(manifest.chain.platformSafe.address.toLowerCase());
  // Deterministic generator: v1 is the recorded chain envelope; v2 comes from the
  // same synthetic publication used by the browser scenarios. No fixture hand edits.
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../e2e/fixtures/core-local/manifest-11155111.json');
  const generated = `${JSON.stringify(manifest, null, 2)}\n`;
  if (process.env.SH_WRITE_FIXTURES === '1') writeFileSync(path, generated);
  const committed = readFileSync(path, 'utf8');
  expect(committed).toBe(generated);
  expect(parseCoreManifestV2(JSON.parse(committed))).toEqual(manifest);
  expect(body.chainId).toBe(manifest.chainId);
  expect(body.row.registry.toLowerCase()).toBe(manifest.releases[0]?.registry.address.toLowerCase());
});

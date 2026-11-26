import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import * as rehearsal from './alpha-rehearsal.mjs';
import { CONTRACTS, ROOT, run } from './lib/core-v2-local-runtime.mjs';

const env = { FOUNDRY_OFFLINE: 'true', FOUNDRY_THREADS: '4' };
const outputRoot = join(ROOT, '.cache/alpha-forge-out');
// Every artifact read by _bootstrapAlpha, _deployLocalCoreV2 and its inherited _receiverCode.
// Keep this independent of the runner's build targets: imports can silently stop producing an artifact.
const artifacts = [
  'PoolManager', 'BoxRegistryV2', 'ListingRegistry', 'BoxCoordinatorV2', 'BoxTokenV2',
  'BoxHookV2Extension', 'BoxHookV2', 'BoxVaultV2', 'BoxCollectionV2', 'BoxReceiverV2',
  'BoxLaunchRouterV2', 'BoxTicketsV2', 'BoxRoyaltyRouterV2', 'HolderLedgerV2',
  'StarterSetLoaderV2', 'BoxTokenV2Ledger', 'ShopVaultV2', 'ItemLedgerV2', 'PileVaultV2',
  'BoxSpecV2Validator', 'BoxFactoryV2Parts', 'BoxFactoryV2Planner', 'BoxFactoryV2Checks', 'BoxFactoryV2',
  'ReceiverViews', 'EatPriceCoinFeeModuleV21', 'HoldersTFeeModuleV21', 'ItemsTFeeModuleV21',
  'PileFeeModuleV21', 'FeeModuleDirectoryV21', 'BoxReceiverV2Extension',
];

test('alpha output has its own read-only Foundry permission', async () => {
  const config = JSON.parse(await run('forge', ['config', '--json'], { env }));
  assert.ok(config.fs_permissions.some(({ access, path }) =>
    access === 'read' && resolve(CONTRACTS, path) === outputRoot), 'missing narrow alpha output read permission');
});

test('runner builds every bootstrap artifact from empty output and scripts can read them', { timeout: 1_800_000 }, async () => {
  assert.equal(typeof rehearsal.buildAlphaArtifacts, 'function', 'runner needs a standalone artifact build step');
  const hardfork = process.env.ALPHA_HARDFORK;
  assert.ok(hardfork === undefined || hardfork === 'amsterdam');
  mkdirSync(outputRoot, { recursive: true });
  const scratch = mkdtempSync(join(outputRoot, 'bootstrap-'));
  const outDir = join(scratch, 'out');
  const cacheDir = join(scratch, 'cache');
  mkdirSync(outDir);
  assert.deepEqual(readdirSync(outDir), []);
  const output = await rehearsal.buildAlphaArtifacts({ outDir, cacheDir });
  writeFileSync(join(scratch, 'build.log'), output);
  for (const name of artifacts) {
    const artifact = JSON.parse(readFileSync(join(outDir, `${name}.sol`, `${name}.json`), 'utf8'));
    assert.ok(artifact.bytecode.object.length > 2, `${name}: missing creation bytecode`);
  }
  // forge test permits artifact reads implicitly; a dry-run script exercises the real fs_permissions gate.
  // The probe imports no deployment code, so it cannot supply a missing dependency itself.
  const paths = artifacts.map(name => `${relative(CONTRACTS, outDir)}/${name}.sol/${name}.json`);
  const probe = await run('forge', ['script', 'test/box-v2/sepolia-all/AlphaArtifactRead.s.sol:AlphaArtifactRead',
    '--sig', 'run(string[])', `[${paths.join(',')}]`,
    '--out', relative(CONTRACTS, outDir), '--cache-path', relative(CONTRACTS, cacheDir),
    ...(hardfork ? ['--hardfork', hardfork] : [])], { env, timeoutMs: 900_000 });
  writeFileSync(join(scratch, 'read.log'), probe);
  assert.match(probe, /Script ran successfully/);
});

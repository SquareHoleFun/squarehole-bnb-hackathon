import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { decodeFunctionData, erc20Abi, type Hex } from 'viem';
import { listingRegistryV2Abi, listingBurnV21Abi } from '../src/core/v2/abi-v2.js';

const script = fileURLToPath(new URL('../scripts/sepolia-listing-batch.mjs', import.meta.url));
const coin = '0x1234567890123456789012345678901234567890';
const registry = '0x84Dc1E9Cd7da248f85133E5e03EF3A303a51072D';

// Exercise the real CLI without an RPC or TypeScript declarations for the standalone program.
function buildPreset(args: string[]) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { buildBatch } from ${JSON.stringify(new URL('../scripts/sepolia-listing-batch.mjs', import.meta.url).href)};
     process.stdout.write(JSON.stringify(buildBatch(JSON.parse(process.argv[1]))));`, JSON.stringify(args)],
  { encoding: 'utf8' });
}

test.each([
  ['tETH', 5, '1000000000000000000', false],
  ['tLINK', 5, '100000000000000000000', false],
  ['tUSDC', 3, '100000000', false],
  ['tNVDA', 4, '100000000000000000000', false],
  ['tGOLD', 5, '1000000000000000000', false],
  ['tPEPE', 5, '100000000000000000000000', false],
  ['tFROG', 5, '100000000000000000000000', true],
])('TA30 listing preset %s decodes against the release ABIs', (preset, classId, raise, burn) => {
  const result = buildPreset(['--test-coin', String(preset), '--token', coin]);
  expect(result.status, result.stderr).toBe(0);
  const batch = JSON.parse(result.stdout) as {
    chainId: string;
    transactions: { to: string; value: string; data: Hex }[];
  };
  expect(batch.chainId).toBe('11155111');
  expect(batch.transactions).toHaveLength(3);
  const [approve, listing, clear] = batch.transactions;
  if (!approve || !listing || !clear) throw new Error('missing listing calls');
  expect(approve.to).toBe(coin);
  expect(decodeFunctionData({ abi: erc20Abi, data: approve.data })).toEqual({
    functionName: 'approve', args: [registry, 10000n],
  });
  expect(listing.to).toBe(registry);
  expect(decodeFunctionData({ abi: burn ? listingBurnV21Abi : listingRegistryV2Abi, data: listing.data })).toEqual({
    functionName: burn ? 'addWithBurn' : 'add',
    args: burn ? [coin, classId, BigInt(raise), '0x42966c68'] : [coin, classId, BigInt(raise)],
  });
  expect(clear.to).toBe(coin);
  expect(decodeFunctionData({ abi: erc20Abi, data: clear.data })).toEqual({
    functionName: 'approve', args: [registry, 0n],
  });
  expect(batch.transactions.every(tx => tx.value === '0')).toBe(true);
});

test('TA30 preset accepts an exact raise override and rejects conflicting settings', () => {
  const result = buildPreset(['--test-coin', 'tUSDC', '--token', coin, '--raise', '9007199254740993']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('9007199254740993');
  for (const extra of [['--action', 'add'], ['--class', 'OTHER'], ['--amount', '20000'], ['--burn-selector', '0x42966c68']]) {
    expect(buildPreset(['--test-coin', 'tFROG', '--token', coin, ...extra]).status).toBe(1);
  }
  expect(buildPreset(['--test-coin', 'PEPE', '--token', coin]).status).toBe(1);
  expect(buildPreset(['--test-coin', 'tLINK']).status).toBe(1);
  expect(spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' }).stdout).toContain('--test-coin');
});

// Keep the standalone node:test CLI suite in the normal workspace test discovery without changing manifests.
test('SH-TA-20 offline Safe batch script suite', () => {
  const result = spawnSync(process.execPath, ['--test', 'packages/chain/scripts/sepolia-listing-batch.test.mjs'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, shLimit(40_000));

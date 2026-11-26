import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, zeroAddress } from 'viem';
import { listingRegistryV2Abi, listingBurnV21Abi } from '../src/core/v2/abi-v2.ts';
import { buildBatch } from './sepolia-listing-batch.mjs';

const registry = '0x84Dc1E9Cd7da248f85133E5e03EF3A303a51072D';
const safe = '0x9432380a67745b453886698F9539aC035DF80B34';
const coin = '0x1234567890123456789012345678901234567890';
const script = fileURLToPath(new URL('./sepolia-listing-batch.mjs', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const admit = action => ['--action', action, '--token', coin, '--class', 'OTHER', '--raise', '9007199254740993000001'];

function decoded(tx, abi, functionName, args, to) {
  assert.equal(tx.to, to);
  assert.equal(tx.value, '0');
  assert.deepEqual(decodeFunctionData({ abi, data: tx.data }), { functionName, args });
  const method = abi.find(entry => entry.type === 'function' && entry.name === functionName);
  assert.deepEqual(tx.contractMethod, {
    name: functionName,
    payable: false,
    inputs: method.inputs.map(({ name, type }) => ({ name, type })),
  });
  assert.deepEqual(tx.contractInputsValues, Object.fromEntries(method.inputs.map((input, i) => [input.name, String(args[i])])));
  // The decoded Safe form and raw calldata must encode the same operation.
  const displayed = method.inputs.map(input => input.type.startsWith('uint')
    ? BigInt(tx.contractInputsValues[input.name]) : tx.contractInputsValues[input.name]);
  assert.equal(encodeFunctionData({ abi, functionName, args: displayed }), tx.data);
}

test('TA20-1: default batch is Sepolia row 0 at 0.1 ETH for the recorded platform Safe', () => {
  const batch = buildBatch([]);
  const plan = JSON.parse(readFileSync(new URL('../../../docs/evidence/SH-SEPOLIA-CORE-V2-DEPLOY/reviewed-plan.json', import.meta.url)));
  assert.equal(batch.version, '1.0');
  assert.equal(batch.chainId, '11155111');
  assert.equal(batch.meta.createdFromSafeAddress, safe);
  assert.equal(batch.meta.createdFromSafeAddress, plan.safes.platform.address);
  assert.equal(batch.meta.createdFromSafeAddress, plan.listings['0'].lister);
  assert.equal(batch.meta.createdFromOwnerAddress, '');
  assert.equal(typeof batch.meta.name, 'string');
  assert.equal(typeof batch.meta.description, 'string');
  assert.equal(typeof batch.meta.txBuilderVersion, 'string');
  assert.ok(Number.isSafeInteger(batch.createdAt));
  assert.equal(batch.transactions.length, 1);
  decoded(batch.transactions[0], listingRegistryV2Abi, 'updateRaise', [0, 100000000000000000n], registry);
  assert.equal(batch.transactions[0].to, plan.listingRegistry);
  assert.doesNotThrow(() => JSON.stringify(batch));
});

test('TA20-1: explicit raises retain every raw digit, including the uint128 boundary', () => {
  for (const raise of ['1000000', '9007199254740993', ((1n << 128n) - 1n).toString()]) {
    const batch = buildBatch(['--action', 'updateRaise', '--chain-id', '11155111', '--raise', raise]);
    decoded(batch.transactions[0], listingRegistryV2Abi, 'updateRaise', [0, BigInt(raise)], registry);
  }
});

test('TA20-5: committed sample matches the default batch and decodes to the founder choice', () => {
  const sample = JSON.parse(readFileSync(new URL('../../../docs/evidence/SH-TA-20/update-raise-0.1-eth.json', import.meta.url)));
  const current = buildBatch([]);
  assert.deepEqual(sample, { ...current, createdAt: sample.createdAt });
  assert.ok(Number.isSafeInteger(sample.createdAt));
  decoded(sample.transactions[0], listingRegistryV2Abi, 'updateRaise', [0, 100000000000000000n], registry);
});

for (const action of ['add', 'addWithBurn']) {
  test(`TA20-2: ${action} preserves order, exact amounts, ABI fields and final zero approval`, () => {
    const amount = (1n << 200n) + 12345n;
    const batch = buildBatch([...admit(action), '--amount', amount.toString()]);
    assert.equal(batch.transactions.length, 3);
    decoded(batch.transactions[0], erc20Abi, 'approve', [registry, amount], coin);
    const args = [coin, 5, 9007199254740993000001n];
    if (action === 'addWithBurn') args.push('0x42966c68');
    decoded(batch.transactions[1], action === 'add' ? listingRegistryV2Abi : listingBurnV21Abi, action, args, registry);
    decoded(batch.transactions[2], erc20Abi, 'approve', [registry, 0n], coin);
    assert.doesNotThrow(() => JSON.stringify(batch));
  });
}

test('TA20-2: all admissible class flags map to the Solidity enum and default approval is 10000', () => {
  for (const [name, id] of [['STANDARD', 2], ['STABLE', 3], ['STOCK', 4], ['OTHER', 5]]) {
    const args = ['--action', 'add', '--token', coin, '--class', name, '--raise', '1000000'];
    const batch = buildBatch(args);
    decoded(batch.transactions[0], erc20Abi, 'approve', [registry, 10000n], coin);
    decoded(batch.transactions[1], listingRegistryV2Abi, 'add', [coin, id, 1000000n], registry);
    decoded(batch.transactions[2], erc20Abi, 'approve', [registry, 0n], coin);
  }
});

test('TA20-2: explicit supported burn selector and lowercase address normalize for Safe review', () => {
  const token = '0xabcdef1234567890123456789012345678901234';
  const batch = buildBatch(['--action', 'addWithBurn', '--token', token, '--class', 'OTHER',
    '--raise', '1000000', '--burn-selector', '0x42966c68']);
  decoded(batch.transactions[1], listingBurnV21Abi, 'addWithBurn', [getAddress(token), 5, 1000000n, '0x42966c68'], registry);
});

test('TA20-3: other chains, unknown/duplicate flags and irrelevant action inputs fail closed', () => {
  for (const chain of ['1', '31337', '011155111', '0xaa36a7', '11155111.0']) {
    assert.throws(() => buildBatch(['--chain-id', chain]), /11155111/);
  }
  for (const args of [
    ['--send'], ['--rpc', 'https://example.invalid'], ['--safe', safe], ['--registry', registry],
    ['--id', '1'], ['--action', 'setRoyaltyLot'], ['--action'], ['--raise'], ['--raise', '--out', 'x'],
    ['--raise', '1000000', '--raise', '2000000'], ['--chain-id', '1', '--chain-id', '11155111'],
    ['--token', coin], ['--amount', '10000'], ['--class', 'OTHER'], ['--burn-selector', '0x42966c68'],
    [...admit('add'), '--burn-selector', '0x42966c68'], ['unexpected'],
  ]) assert.throws(() => buildBatch(args), undefined, JSON.stringify(args));
});

test('TA20-3: raises must be canonical decimal strings within contract bounds', () => {
  for (const value of ['0', '-1', '999999', (1n << 128n).toString(), '0.1', '1e18', '0x100000', '01000000', '+1000000', ' 1000000', '']) {
    assert.throws(() => buildBatch(['--raise', value]), /raise/);
  }
});

test('TA20-3: admission needs explicit valid token, class and raise; allowance must cover the probe', () => {
  for (const missing of ['--token', '--class', '--raise']) {
    const args = admit('add');
    args.splice(args.indexOf(missing), 2);
    assert.throws(() => buildBatch(args), new RegExp(missing.slice(2)));
  }
  for (const token of [zeroAddress, '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', '0x1234', '0xgggggggggggggggggggggggggggggggggggggggg']) {
    const args = admit('add'); args[3] = token;
    assert.throws(() => buildBatch(args), /token/);
  }
  for (const name of ['NONE', 'NATIVE', '6', 'OTHER ']) {
    const args = admit('add'); args[5] = name;
    assert.throws(() => buildBatch(args), /class/);
  }
  for (const amount of ['0', '9999', '-1', '1e6', '1.5', (1n << 256n).toString()]) {
    assert.throws(() => buildBatch([...admit('add'), '--amount', amount]), /amount/);
  }
  for (const selector of ['0x', '0x12345678', '0x42966c6800']) {
    assert.throws(() => buildBatch([...admit('addWithBurn'), '--burn-selector', selector]), /burn-selector/);
  }
});

test('TA20-3: CLI writes importable JSON, refuses overwrites, and produces no file for invalid input', () => {
  mkdirSync(new URL('../../../.cache/tmp/', import.meta.url), { recursive: true });
  const dir = mkdtempSync(fileURLToPath(new URL('../../../.cache/tmp/ta20-', import.meta.url)));
  const out = `${dir}/batch.json`;
  const run = args => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  const result = run(['--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const saved = readFileSync(out, 'utf8');
  decoded(JSON.parse(saved).transactions[0], listingRegistryV2Abi, 'updateRaise', [0, 100000000000000000n], registry);
  assert.notEqual(run(['--out', out]).status, 0);
  assert.equal(readFileSync(out, 'utf8'), saved);
  const refused = `${dir}/refused.json`;
  assert.notEqual(run(['--chain-id', '1', '--out', refused]).status, 0);
  assert.equal(existsSync(refused), false);
  assert.notEqual(run([]).status, 0);
  assert.equal(run(['--help']).status, 0);
  // A fetch tripwire catches accidental HTTP RPC use by the actual CLI process.
  const guard = `${dir}/offline.mjs`;
  writeFileSync(guard, "globalThis.fetch = () => { throw new Error('network forbidden'); };\n");
  const offline = spawnSync(process.execPath, ['--import', guard, script, '--action', 'addWithBurn',
    '--token', coin, '--class', 'OTHER', '--raise', '1000000', '--out', `${dir}/offline.json`], { cwd: root, encoding: 'utf8' });
  assert.equal(offline.status, 0, offline.stderr);
});

test('one platform batch updates native raise before all six exact admission triples', async () => {
  const { buildMergedBatch } = await import('./sepolia-listing-batch.mjs');
  const symbols = ['tLINK', 'tUSDC', 'tNVDA', 'tGOLD', 'tPEPE', 'tFROG'];
  const coins = Object.fromEntries(symbols.map((s, i) => [s, `0x${BigInt(i + 100).toString(16).padStart(40, '0')}`]));
  const batch = buildMergedBatch(coins);
  assert.equal(batch.transactions.length, 19);
  assert.deepEqual(batch.transactions[0], buildBatch([]).transactions[0]);
  symbols.forEach((s, i) => assert.deepEqual(batch.transactions.slice(1 + 3 * i, 4 + 3 * i), buildBatch(['--test-coin', s, '--token', coins[s]]).transactions));
  assert.throws(() => buildMergedBatch({ ...coins, tFROG: coins.tLINK }), /distinct/);
  assert.throws(() => buildMergedBatch({ tLINK: coins.tLINK }), /six/);
});

test('SH-ALPHA-TETH-3: tETH preset requires its deployed address and builds exact probe/add/clear calls', () => {
  const batch = buildBatch(['--test-coin', 'tETH', '--token', coin]);
  assert.equal(batch.chainId, '11155111');
  assert.equal(batch.meta.createdFromSafeAddress, safe);
  assert.equal(batch.transactions.length, 3);
  decoded(batch.transactions[0], erc20Abi, 'approve', [registry, 10000n], coin);
  decoded(batch.transactions[1], listingRegistryV2Abi, 'add', [coin, 5, 10n ** 18n], registry);
  decoded(batch.transactions[2], erc20Abi, 'approve', [registry, 0n], coin);
  assert.equal(batch.transactions[1].contractInputsValues.raise, '1000000000000000000');
  assert.doesNotThrow(() => JSON.stringify(batch));
  assert.throws(() => buildBatch(['--test-coin', 'tETH']), /token/);
  for (const extra of [['--action', 'addWithBurn'], ['--class', 'STABLE'], ['--amount', '20000']]) {
    assert.throws(() => buildBatch(['--test-coin', 'tETH', '--token', coin, ...extra]), /conflicts/);
  }
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /tETH/);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const contracts = new URL('../../../', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('./receiver-baseline.json', import.meta.url), 'utf8').replaceAll('t_array(t_uint256)_storage', 't_array(t_uint256)10_storage'));
const artifact = JSON.parse(readFileSync(new URL('out/BoxReceiverV2.sol/BoxReceiverV2.json', contracts), 'utf8'));

// AST ids are compiler bookkeeping. Every slot, offset, type, member and encoding stays pinned.
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'astId' && key !== 'contract')
    .map(([key, item]) => [key.replace(/(t_(?:struct|enum)\([^)]*\))\d+/g, '$1'), normalize(item)]));
  return typeof value === 'string' ? value.replace(/(t_(?:struct|enum)\([^)]*\))\d+/g, '$1') : value;
}

test('ROOM-ABI: v2.1 adds only the appended eat, reward and pile interfaces to the unchanged v2 ABI', () => {
  const additions = { 'eatPendingP()': 'a280d93b', 'eatPriceCoin()': 'af678cf1', 'eatenP()': '1f0a6304', 'priceBurnSelector()': 'ef58443f',
    'rewardsPendingP()': 'e755e1e6',
    'rewardsPendingByKind()': '7efbb40c',
    'rewardBurnPendingT()': '9d303063',
    'implementation()': '5c60da1b',
    'receiverCode()': '', 'sideModule(bool)': '', 'modulePendingP(bool)': '', 'executeModule(bool)': '', 'feeModule(uint8)': '', 'verifyModules(uint8,uint8,uint32,uint32)': '',
    'moveToPile()': '7fc795c3', 'pileMovedP()': '1c672a74', 'pilePendingP()': 'e7b0d34e' };
  for (const key of Object.keys(additions)) if (additions[key] === '') additions[key] = execFileSync('cast', ['sig', key], { encoding: 'utf8' }).trim().slice(2);
  assert.deepEqual(artifact.methodIdentifiers, { ...baseline.methodIdentifiers, ...additions });
  const names = new Set([...Object.keys(additions).map((name) => name.slice(0, name.indexOf('('))), 'PriceCoinEaten', 'RewardsBought', 'RewardTBurned', 'PileFeesMoved', 'ModuleExecuted']);
  const oldConstructor = baseline.abi.find(e => e.type === 'constructor');
  const constructor = artifact.abi.find(e => e.type === 'constructor');
  assert.deepEqual(constructor.inputs.slice(0, -1), oldConstructor.inputs);
  assert.equal(constructor.inputs.at(-1).internalType, 'struct ReceiverCodeV21');
  assert.deepEqual(artifact.abi.filter((entry) => entry.type !== 'constructor' && !names.has(entry.name)), baseline.abi.filter(e => e.type !== 'constructor'));
  assert.equal(artifact.abi.filter((entry) => names.has(entry.name)).length, 22);
});

test('ROOM-STORAGE: every persistent slot and nested item receipt stays identical to the tag', () => {
  const layout = JSON.parse(execFileSync('forge', ['inspect', 'BoxReceiverV2', 'storageLayout', '--json', '--offline'],
    { cwd: fileURLToPath(contracts), encoding: 'utf8' }));
  const normalized = normalize(layout);
  assert.deepEqual(normalized.storage.slice(0, -6), baseline.storageLayout.storage);
  for (const [key, value] of Object.entries(baseline.storageLayout.types)) assert.deepEqual(normalized.types[key], value);
  assert.deepEqual(normalized.storage.slice(-6, -4).map(({ label, slot, offset, type }) => ({ label, slot, offset, type })), [
    { label: '_eatPendingP', slot: '24', offset: 0, type: 't_uint256' },
    { label: '_eatenP', slot: '25', offset: 0, type: 't_uint256' },
  ]);
  assert.equal(normalized.storage.at(-4).label, '_rewards');
  assert.equal(normalized.storage.at(-4).slot, '26');
  assert.equal(normalized.types[normalized.storage.at(-4).type].numberOfBytes, '320');
  assert.deepEqual(normalized.storage.slice(-3, -1).map(({ label, slot, offset, type }) => ({ label, slot, offset, type })), [
    { label: '_pilePendingP', slot: '36', offset: 0, type: 't_uint256' },
    { label: '_pileMovedP', slot: '37', offset: 0, type: 't_uint256' },
  ]);
});

test('ROOM-PART: the callback helper has no persistent storage and only its callback selector', () => {
  const name = 'BoxReceiverV2Extension';
  const part = JSON.parse(readFileSync(new URL(`out/${name}.sol/${name}.json`, contracts), 'utf8'));
  assert.deepEqual(part.methodIdentifiers, { 'receiverImplementation()': execFileSync('cast', ['sig', 'receiverImplementation()'], { encoding: 'utf8' }).trim().slice(2), 'unlockCallback(bytes)': baseline.methodIdentifiers['unlockCallback(bytes)'] });
  const layout = JSON.parse(execFileSync('forge', ['inspect', name, 'storageLayout', '--json', '--offline'],
    { cwd: fileURLToPath(contracts), encoding: 'utf8' }));
  assert.deepEqual(layout.storage, []);
});

test('FM-STORAGE: fixed core overlay matches all receiver slots and nested types', () => {
  const inspect = name => {
    let layout = JSON.parse(execFileSync('forge', ['inspect', name, 'storageLayout', '--json', '--offline'], { cwd: fileURLToPath(contracts), encoding: 'utf8' }));
    const wrapper = Object.entries(layout.types).find(([, type]) => type.label === 'struct ReceiverBooksV21.State');
    if (wrapper) layout = JSON.parse(JSON.stringify(layout).replaceAll(wrapper[0], 't_struct(CoreOverlay)_storage'));
    return normalize(layout);
  };
  const receiver = inspect('BoxReceiverV2');
  const witness = inspect('FeeCoreStorageWitness');
  assert.deepEqual(witness.types[witness.storage[0].type].members, receiver.storage);
  for (const [name, type] of Object.entries(receiver.types)) assert.deepEqual(witness.types[name], type);
  assert.deepEqual(receiver.storage.at(-1), { label: '_modulePending', offset: 0, slot: '38', type: 't_array(t_uint256)2_storage' });
});

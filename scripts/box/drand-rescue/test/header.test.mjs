import test from 'node:test';
import assert from 'node:assert/strict';
import { read, v } from './model.mjs';

const names = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom',
  'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas',
  'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash'];
const integers = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
const text = read('packages/contracts/test/box/backup/HeaderVectors.sol');
const vector = name => {
  const raw = `0x${text.match(new RegExp(`${name} = hex"([\\da-f]+)"`))[1]}`;
  const hash = text.match(new RegExp(`${name}_HASH = (0x[\\da-f]+)`))[1];
  const fields = v.fromRlp(raw);
  const block = Object.fromEntries(fields.slice(0, names.length).map((value, i) => [names[i], integers.has(names[i]) ? `0x${BigInt(value === '0x' ? 0n : value).toString(16)}` : value]));
  return { raw, hash, fields, block: { ...block, hash, transactions: [], uncles: [], size: '0x123' } };
};
const rpcFor = (block, raw) => ({ rpc: async method => {
  if (method === 'eth_getBlockByNumber') return block;
  assert.equal(method, 'debug_getRawHeader');
  if (raw === undefined) throw new Error('provider private text');
  return raw;
} });

test('both Solidity header vectors re-encode byte for byte and verified raw headers are used as is', async () => {
  const { blockHeader } = await import('../header.mjs');
  for (const name of ['MAINNET', 'SEPOLIA']) {
    const { raw, hash, fields, block } = vector(name);
    assert.equal(v.toRlp(fields), raw);
    assert.equal(v.keccak256(raw), hash);
    assert.equal(await blockHeader(rpcFor(block, raw), BigInt(block.number)), raw);
  }
});

test('field encoder builds the mainnet header with minimal integers, or refuses changes, gaps and unknown fields', async () => {
  const { blockHeader } = await import('../header.mjs');
  const { raw, block } = vector('MAINNET');
  assert.equal(await blockHeader(rpcFor(block), BigInt(block.number)), raw);
  for (const bad of [
    { ...block, timestamp: '0x1' }, { ...block, futureHeaderField: v.zeroHash },
    { ...block, blobGasUsed: undefined }, { ...block, miner: undefined }, { ...block, number: '0x1' },
  ]) await assert.rejects(blockHeader(rpcFor(bad), BigInt(block.number)), { message: 'backup header refused' });
  await assert.rejects(blockHeader(rpcFor(block, '0xc0'), BigInt(block.number)), { message: 'backup header refused' });
  // Sepolia has two unnamed appended fields: verified raw works, the named-field fallback refuses until their names are confirmed.
  const sepolia = vector('SEPOLIA');
  assert.equal(sepolia.fields.length, 23);
  await assert.rejects(blockHeader(rpcFor(sepolia.block), BigInt(sepolia.block.number)), { message: 'backup header refused' });
});

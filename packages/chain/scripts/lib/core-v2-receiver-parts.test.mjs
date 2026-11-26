import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { readReceiverParts } from './core-v2-receiver-parts.mjs';

const receiver = '0x1234567890123456789012345678901234567890';
const addresses = Array.from({ length: 7 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
const readContract = async ({ functionName, args }) => functionName === 'receiverCode' ? addresses.slice(0, 3) : [addresses[3 + args[0] - 6], keccak256('0x6000')];
const blockNumber = 9007199254740993n;

test('ROOM-WIRING: records the shared core, directory and four actions and hashes at the manifest block', async () => {
  const reads = [];
  const result = await readReceiverParts({ readContract, getCode: async input => { reads.push(input); return '0x6000'; } }, receiver, blockNumber);
  assert.deepEqual(reads, addresses.map(address => ({ address, blockNumber })));
  assert.equal(result.receiver, receiver);
  assert.equal(result.blockNumber, '9007199254740993');
  assert.equal(result.callback.address, reads[1].address);
  assert.equal(result.views.codeHash, keccak256('0x6000'));
  assert.equal(result.callback.codeHash, keccak256('0x6000'));
});

test('ROOM-WIRING: missing or oversized parts cannot produce local release evidence', async () => {
  for (const code of [undefined, '0x', `0x${'00'.repeat(22_119)}`]) {
    await assert.rejects(readReceiverParts({ readContract, getCode: async () => code }, receiver, blockNumber), /receiver views part/);
    let reads = 0;
    await assert.rejects(readReceiverParts({ readContract, getCode: async () => ++reads === 1 ? '0x00' : code }, receiver, blockNumber),
      /receiver callback part/);
  }

});

test('FM21: changed action code refuses a release manifest and every read is pinned', async () => {
  const pinned = async input => {
    assert.equal(input.blockNumber, blockNumber);
    return readContract(input);
  };
  await assert.rejects(readReceiverParts({ readContract: pinned, getCode: async ({ address, blockNumber: at }) => {
    assert.equal(at, blockNumber);
    return address === addresses[3] ? '0x6001' : '0x6000';
  } }, receiver, blockNumber), /changed receiver module 6/);
});

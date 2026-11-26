import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carriesPageFee, isConfirmedPageSend, permitWallet } from './wallet.mjs';

const account = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const tx = { from: account, to: target, data: '0x12345678', value: '0x3', gas: '0xe4e1c0' };
test('browser wallet sends only a once-permitted exact local transaction', async () => {
  const calls = [];
  const wallet = permitWallet(account, async transaction => { calls.push(transaction); return '0xhash'; });
  await assert.rejects(wallet.send(tx), /not permitted/);
  wallet.permit(tx);
  for (const patch of [{ to: account }, { from: target }, { value: '0x4' }, { data: '0x12345679' }, { gas: '0xffffff' }, { nonce: '0x2' }]) {
    await assert.rejects(wallet.send({ ...tx, ...patch }), /not permitted/);
  }
  assert.equal(await wallet.send(tx), '0xhash');
  await assert.rejects(wallet.send(tx), /not permitted/);
  assert.equal(calls.length, 1);
});

// SH-186: the page's own send, as packages/chain/src/write/executor.ts builds it (hex quantities, its own EIP-1559 fee).
const pageSend = { from: account, to: target, data: '0x12345678', value: '0x0', gas: '0xe4e1c0', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', chainId: '0xaa36a7' };
const confirmed = { to: target, data: '0x12345678' };
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

test('a page send is the confirmed call with a fee the page names itself', () => {
  assert.equal(isConfirmedPageSend(pageSend, confirmed, account, 11155111), true);
  // The account and the target in another letter case, a gas limit exactly at the cap, and no value field at all.
  const lettered = '0xabcdef0000000000000000000000000000000001'; const upper = '0xABCDEF0000000000000000000000000000000001';
  assert.equal(isConfirmedPageSend({ ...pageSend, from: upper, to: lettered }, { ...confirmed, to: upper }, lettered, 11155111), true);
  assert.equal(isConfirmedPageSend({ ...pageSend, gas: '0x1000000' }, confirmed, account, 11155111), true);
  assert.equal(isConfirmedPageSend(without(pageSend, 'value'), confirmed, account, 11155111), true);
  // Each side's letter case alone: the wallet's own account in capitals, the page's target in capitals.
  assert.equal(isConfirmedPageSend({ ...pageSend, from: lettered, to: lettered }, { ...confirmed, to: lettered }, upper, 11155111), true);
  assert.equal(isConfirmedPageSend({ ...pageSend, from: lettered, to: upper }, { ...confirmed, to: lettered }, lettered, 11155111), true);
});

test('a page send that differs from its confirmation, or carries another field, is refused', () => {
  for (const patch of [{ to: account }, { from: target }, { data: '0x12345679' }, { value: '0x1' }, { value: '0' }, { value: null }, { gas: '0x1000001' }, { gas: '15000000' },
    { chainId: '0x1' }, { chainId: 11155111 }, { nonce: '0x2' }, { gasPrice: '0x3b9aca00' }, { type: '0x2' }, { accessList: [] }]) {
    assert.equal(isConfirmedPageSend({ ...pageSend, ...patch }, confirmed, account, 11155111), false, JSON.stringify(patch));
  }
  for (const key of ['from', 'to', 'data', 'gas', 'chainId']) assert.equal(isConfirmedPageSend(without(pageSend, key), confirmed, account, 11155111), false, key);
  assert.equal(isConfirmedPageSend(pageSend, confirmed, account, 1), false);
  assert.equal(isConfirmedPageSend(pageSend, confirmed, target, 11155111), false);
  assert.equal(isConfirmedPageSend(null, confirmed, account, 11155111), false);
});

test('a page send that leaves the fee to the wallet is refused: both fields, hex quantities, a tip above zero and not above the cap', () => {
  assert.equal(carriesPageFee(pageSend), true);
  assert.equal(carriesPageFee({ maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00' }), true);
  for (const patch of [{ maxPriorityFeePerGas: '0x0' }, { maxFeePerGas: '0x3b9ac9ff' }, { maxFeePerGas: '2000000000' }, { maxFeePerGas: 2000000000 },
    { maxFeePerGas: '0x077359400' }, { maxFeePerGas: '0X77359400' }, { maxFeePerGas: '0x' }, { maxPriorityFeePerGas: '0x3B9ACA00' }, { maxPriorityFeePerGas: null }]) {
    assert.equal(carriesPageFee({ ...pageSend, ...patch }), false, JSON.stringify(patch));
    assert.equal(isConfirmedPageSend({ ...pageSend, ...patch }, confirmed, account, 11155111), false, JSON.stringify(patch));
  }
  for (const key of ['maxFeePerGas', 'maxPriorityFeePerGas']) {
    assert.equal(carriesPageFee(without(pageSend, key)), false, key);
    assert.equal(isConfirmedPageSend(without(pageSend, key), confirmed, account, 11155111), false, key);
  }
});

test('a send rejection consumes the permit instead of retrying a possibly mined transaction', async () => {
  let attempts = 0;
  const wallet = permitWallet(account, async () => { attempts++; throw new Error('receipt unavailable'); });
  wallet.permit(tx);
  await assert.rejects(wallet.send(tx), /receipt unavailable/);
  await assert.rejects(wallet.send(tx), /not permitted/);
  assert.equal(attempts, 1);
});

import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { itemLedgerV2Abi, pileVaultV2Abi } from '../abi-v2';
import { assertSendableCallV2, type WriteCallV2, type WriteTargetV2 } from '../write-calls-v2';
import { submitWrite } from '../../../write/executor';
import { NotSendableError } from '../../../write/calls';
import type { Eip1193RequestArguments } from '../../../write/eip1193';
import { A, B, H, m3Fixture } from '../../../../../indexer/src/core/v2/m3-fixture.test-support';
import { TEST_FEE_READER } from '../../../write/test-support/index';

const f = m3Fixture();
const target: WriteTargetV2 = { chainId: 1, token: f.at(1), coordinator: f.at(0), receiver: f.at(5), p: f.record.q,
  itemLedger: f.at(16), pile: f.at(3) };
const item = (ids: readonly bigint[], to = A): WriteCallV2 => ({ to: f.at(16), value: 0n,
  data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'claim', args: [ids, to] }) });
const sync = (n: bigint): WriteCallV2 => ({ to: f.at(16), value: 0n, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'sync', args: [n] }) });
const approve = (spender = f.at(3), amount = 2n ** 200n + 3n): WriteCallV2 => ({ to: f.at(1), value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });
const redeem = (amount = 2n ** 100n + 1n, min = 1n, to = A): WriteCallV2 => ({ to: f.at(3), value: 0n,
  data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'redeem', args: [amount, min, to] }) });
const seed: WriteCallV2 = { to: f.at(3), value: 0n, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'returnSeed' }) };
const valid = [item([1n]), sync(1n), sync(32n), approve(), redeem(), seed];
const invalid: [string, WriteCallV2, WriteTargetV2?][] = [
  ['empty ids', item([])], ['multiple ids', item([1n, 2n])], ['duplicate ids', item([1n, 1n])], ['zero id (format FIRST_ID=1)', item([0n])],
  ['item recipient', item([1n], B)], ['sync zero', sync(0n)], ['sync 33', sync(33n)],
  ['arbitrary spender', approve(B)], ['zero approval', approve(f.at(3), 0n)], ['approve on seed asset', { ...approve(), to: target.p }],
  ['zero T', redeem(0n)], ['zero minimum', redeem(1n, 0n)], ['redeem recipient', redeem(1n, 1n, B)],
  ['absent ledger', item([1n]), { ...target, itemLedger: undefined }], ['absent pile', seed, { ...target, pile: undefined }],
  ['zero role', seed, { ...target, pile: zeroAddress }], ['aliased role', seed, { ...target, pile: target.token }],
  ['removed push', { to: f.at(16), value: 0n, data: encodeFunctionData({ abi: parseAbi(['function claimFor(uint256[],address)']), functionName: 'claimFor', args: [[1n], A] }) }],
  ...valid.flatMap((call, i): [string, WriteCallV2][] => [
    [`foreign target ${i}`, { ...call, to: B }], [`native value ${i}`, { ...call, value: 1n }],
    [`trailing calldata ${i}`, { ...call, data: `${call.data}00` as Hex }],
  ]),
];

describe('M363-GUARD: only canonical caller-bound M3 calls reach a wallet', () => {
  it.each(valid.map((call, i) => [i, call] as const))('valid action %s preserves its exact bigint calldata', async (_i, call) => {
    const requests: Eip1193RequestArguments[] = [];
    const wallet = vi.fn(async (request: Eip1193RequestArguments) => {
      requests.push(request);
      if (request.method === 'eth_chainId') return '0x1';
      if (request.method === 'eth_accounts') return [A];
      if (request.method === 'eth_sendTransaction') return H(77);
      throw new Error(`unexpected wallet request ${request.method}`);
    });
    expect(() => assertSendableCallV2(call, target, A)).not.toThrow();
    expect(await submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', target, call, from: A, wallet, gasLimit: 2_000_000n })).toBe(H(77));
    const sends = requests.filter(r => r.method === 'eth_sendTransaction');
    expect(sends).toHaveLength(1);
    const params = sends[0]?.params;
    expect(Array.isArray(params) ? params[0] : null).toMatchObject({ from: A, to: call.to, data: call.data, value: '0x0' });
  });

  it.each(invalid)('%s is refused before any wallet request', async (_why, call, prepared = target) => {
    const wallet = vi.fn(async () => H(77));
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', target: prepared, call, from: A, wallet, gasLimit: 2_000_000n })).rejects.toBeInstanceOf(NotSendableError);
    expect(wallet).not.toHaveBeenCalled();
  });

  it('a returnSeed caller need not be the seeder and supplies no recipient', () => {
    expect(() => assertSendableCallV2(seed, target, B as Address)).not.toThrow();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi, parseAbi, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { coordinatorV2Abi, receiverV2Abi, holderLedgerV2Abi, itemLedgerV2Abi, pileVaultV2Abi } from '../abi-v2';
import { assertSendableCallV2, type WriteCallV2, type WriteTargetV2 } from '../write-calls-v2';
import { submitWrite } from '../../../write/executor';
import { NotSendableError } from '../../../write/calls';
import { A, B, H } from './wallet-fixture';
import { TEST_FEE_READER } from '../../../write/test-support/index';

const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const base: WriteTargetV2 = { chainId: 11155111, token: address(1), coordinator: address(2), receiver: address(3), p: address(4) };
const variants: [string, WriteTargetV2][] = [
  ['token only', base], ['open art', base], ['hidden art', base],
  ['holder token', { ...base, holderLedger: address(17) }],
  ['holder shop', { ...base, holderLedger: address(17) }],
  ['every-item art', { ...base, itemLedger: address(16) }],
  ['pile', { ...base, pile: address(5) }],
];
const call = (to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): WriteCallV2 => ({ to, value: 0n, data: encodeFunctionData({ abi, functionName, args }) });
const common = [
  call(base.token, erc20Abi, 'approve', [base.coordinator, 2n ** 200n + 1n]),
  call(base.coordinator, coordinatorV2Abi, 'claim', [2n ** 200n + 1n, A]),
  call(base.coordinator, coordinatorV2Abi, 'claim', [0n, A]),
  call(base.coordinator, coordinatorV2Abi, 'fail'), call(base.coordinator, coordinatorV2Abi, 'failClosed'),
  call(base.receiver, receiverV2Abi, 'claimCreator', [base.p, A]),
];
function actions(target: WriteTargetV2) {
  return [...common,
    ...(target.holderLedger ? [call(target.holderLedger, holderLedgerV2Abi, 'claim', [1n, A])] : []),
    ...(target.itemLedger ? [call(target.itemLedger, itemLedgerV2Abi, 'claim', [[1n], A]), call(target.itemLedger, itemLedgerV2Abi, 'sync', [32n])] : []),
    ...(target.pile ? [call(target.token, erc20Abi, 'approve', [target.pile, 1n]), call(target.pile, pileVaultV2Abi, 'redeem', [1n, 1n, A]), call(target.pile, pileVaultV2Abi, 'returnSeed')] : []),
  ];
}

describe('FINAL-WRITE: canonical caller-bound authority for every shipped box kind', () => {
  it.each(variants)('%s permits only its prepared role and canonical bytes', async (_kind, target) => {
    for (const valid of actions(target)) {
      expect(() => assertSendableCallV2(valid, target, A)).not.toThrow();
      for (const invalid of [{ ...valid, to: B }, { ...valid, value: 1n }, { ...valid, data: `${valid.data}00` as Hex }, { ...valid, data: valid.data.slice(0, -2) as Hex }]) {
        const wallet = vi.fn(async () => H(7));
        await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', target, call: invalid, from: A, wallet, gasLimit: 1_000_000n })).rejects.toBeInstanceOf(NotSendableError);
        expect(wallet).not.toHaveBeenCalled();
      }
    }
  });

  it('identical holder/coordinator selectors do not authorize another destination or an array overload', () => {
    const target = { ...base, holderLedger: address(17), itemLedger: address(16) };
    const scalar = call(target.holderLedger, holderLedgerV2Abi, 'claim', [1n, A]);
    expect(scalar.data).toBe(call(base.coordinator, coordinatorV2Abi, 'claim', [1n, A]).data);
    for (const invalid of [call(target.holderLedger, holderLedgerV2Abi, 'claim', [0n, A]),
      { ...scalar, to: target.itemLedger }, call(target.holderLedger, itemLedgerV2Abi, 'claim', [[1n], A]),
      call(target.itemLedger, itemLedgerV2Abi, 'claim', [[1n, 2n], A]),
      call(target.itemLedger, itemLedgerV2Abi, 'sync', [33n]),
      call(base.receiver, receiverV2Abi, 'claimCreator', [base.p, B]),
      call(base.coordinator, coordinatorV2Abi, 'claim', [1n, B])]) {
      expect(() => assertSendableCallV2(invalid, target, A)).toThrow(NotSendableError);
    }
  });

  it('retired push/converter calls, arbitrary spenders and zero/aliased roles are refused', () => {
    for (const signature of ['function claimFor(uint256,address)', 'function step(uint256,address)', 'function setApprovalForAll(address,bool)']) {
      const abi = parseAbi([signature]); const name = signature.split(' ')[1]?.split('(')[0];
      if (!name) throw new Error('missing test selector');
      const args = name === 'setApprovalForAll' ? [B, true] : [1n, A];
      expect(() => assertSendableCallV2(call(base.receiver, abi, name, args), base, A)).toThrow(NotSendableError);
    }
    expect(() => assertSendableCallV2(call(base.token, erc20Abi, 'approve', [B, 1n]), base, A)).toThrow(NotSendableError);
    const valid = common[1]; if (!valid) throw new Error('missing test action');
    for (const target of [{ ...base, holderLedger: zeroAddress }, { ...base, itemLedger: base.receiver }, { ...base, pile: base.token }]) {
      expect(() => assertSendableCallV2(valid, target, A)).toThrow(NotSendableError);
    }
  });

  it.each(['chain', 'account'])('a changed wallet %s cannot submit the prepared claim', async change => {
    const methods: string[] = [];
    const wallet = async ({ method }: { method: string }) => {
      methods.push(method);
      return method === 'eth_chainId' ? change === 'chain' ? '0x1' : '0xaa36a7' : [B];
    };
    const valid = common[1]; if (!valid) throw new Error('missing test action');
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', target: base, call: valid, from: A, wallet, gasLimit: 1_000_000n })).rejects.toThrow();
    expect(methods).not.toContain('eth_sendTransaction');
  });

  it('the submitted payload is immutable across wallet awaits and binds chain and exact bigint amount', async () => {
    const valid = { ...common[1] } as WriteCallV2;
    const expectedData = valid.data; let sent: unknown;
    const wallet = async ({ method, params }: { method: string; params?: readonly unknown[] | object }) => {
      if (method === 'eth_chainId') { Object.assign(valid, { to: B, data: '0x' }); return '0xaa36a7'; }
      if (method === 'eth_accounts') return [A];
      sent = params; return H(7);
    };
    await submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', target: base, call: valid, from: A, wallet, gasLimit: 1_000_000n });
    expect(sent).toEqual([expect.objectContaining({ to: base.coordinator, data: expectedData, from: A, chainId: '0xaa36a7', value: '0x0' })]);
  });
});

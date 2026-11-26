import { describe, expect, it } from 'vitest';
import { concatHex, encodeAbiParameters, keccak256, decodeFunctionData, getAddress, maxUint256, zeroAddress, zeroHash, type Abi, type Address } from 'viem';
import { boxCollectionAbi } from '../../abi/boxCollection';
import { boxTicketsAbi } from '../../abi/boxTickets';
import { submitWrite } from '../../write/executor';
import type { Eip1193Request } from '../../write/eip1193';
import { ROLE_V2 } from '../roles';
import { vaultV2Abi } from './abi-v2';
import * as v2 from './index';
import { assertSendableCallV2, type WriteTargetV2 } from './write-calls-v2';
import { TEST_FEE_READER, TEST_SEND_FEE_FIELDS } from '../../write/test-support/index';

const a = (n: bigint) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const from = a(100n);
// Synthetic wiring, never a recorded/deployed address fixture.
const record: v2.BoxRecordV2 = {
  boxId: 1n, templateId: zeroHash, specHash: zeroHash, creator: a(50n), pricingListingId: 0, q: zeroAddress,
  raise: 1n, poolManager: a(51n), poolId: zeroHash, creationBlock: 1n, openAt: 1n, randomness: a(52n),
  contracts: Array.from({ length: 24 }, (_, i) => a(BigInt(i + 1))), codeHashes: Array.from({ length: 24 }, () => zeroHash),
};
const reveal = { traitsPacked: (1n << 127n) + 1n, imageHash: zeroHash, avatarHash: zeroHash, modelHash: zeroHash, salt: zeroHash, proof: [zeroHash, zeroHash] };
const amount = (1n << 100n) + 3n;
const deadline = 2_000_000_000n;

describe('TA32 collection builders', () => {
  it('derives collection roles from the box record, not deployment implementations', () => {
    const t = v2.collectionTargetV2(11155111, record, from);
    for (const role of ['token', 'coordinator', 'receiver', 'vault', 'collection', 'tickets'] as const) expect(t[role]).toBe(record.contracts[ROLE_V2[role]]);
    expect(t.collectionCaller).toBe(from);
    expect(t.p).toBe(zeroAddress);
    expect(t.chainId).toBe(11155111);
    expect(t.drawValue).toBeUndefined();
    for (const role of ['token', 'coordinator', 'receiver', 'vault', 'collection'] as const) {
      const contracts = [...record.contracts]; contracts[ROLE_V2[role]] = zeroAddress;
      expect(() => v2.collectionTargetV2(11155111, { ...record, contracts }, from)).toThrow();
    }
    const contracts = [...record.contracts]; contracts[ROLE_V2.tickets] = zeroAddress;
    expect(v2.collectionTargetV2(11155111, { ...record, contracts }, from).tickets).toBeUndefined();
  });

  it('encodes all ten actions exactly as the canonical contract ABIs and passes the guard', () => {
    const t = { ...v2.collectionTargetV2(11155111, record, from), drawValue: 123n };
    const tickets = t.tickets as Address;
    const cases: readonly [v2.WriteCallV2, Abi, string, readonly unknown[], Address, bigint][] = [
      [v2.withdrawCallV2(t, 0n, amount, deadline, from), vaultV2Abi, 'withdraw', [0n, amount, deadline], t.vault, 0n],
      [v2.withdrawBatchCallV2(t, [0n, 2n], amount, deadline, from), vaultV2Abi, 'withdrawBatch', [[0n, 2n], amount, deadline], t.vault, 0n],
      [v2.returnItemCallV2(t, 0n, amount, deadline, from), vaultV2Abi, 'returnItem', [0n, amount, deadline], t.vault, 0n],
      [v2.returnItemsCallV2(t, [0n, 2n], amount, deadline, from), vaultV2Abi, 'returnItems', [[0n, 2n], amount, deadline], t.vault, 0n],
      [v2.takeCallV2(t, 2n, amount, deadline, from), boxTicketsAbi, 'take', [2n, amount, deadline], tickets, 0n],
      [v2.handBackCallV2(t, [1n, 2n], amount, deadline, from), boxTicketsAbi, 'handBack', [[1n, 2n], amount, deadline], tickets, 0n],
      [v2.drawCallV2(t, amount, deadline, from), boxTicketsAbi, 'draw', [amount, deadline], tickets, 123n],
      [v2.openCallV2(t, 1n, reveal, from), boxTicketsAbi, 'open', [1n, reveal], tickets, 0n],
      [v2.openDrawCallV2(t, 1n, reveal, from), boxTicketsAbi, 'openDraw', [1n, getAddress(from), reveal], tickets, 0n],
      [v2.revealCallV2(t, 0n, reveal, from), boxCollectionAbi, 'reveal', [0n, reveal.traitsPacked, reveal.imageHash, reveal.avatarHash, reveal.modelHash, reveal.salt, reveal.proof], t.collection, 0n],
    ];
    for (const [c, abi, name, args, to, value] of cases) {
      expect(c.to).toBe(to); expect(c.value).toBe(value);
      expect(decodeFunctionData({ abi, data: c.data })).toEqual({ functionName: name, args });
      expect(() => assertSendableCallV2(c, t, from)).not.toThrow();
    }
  });

  it('builds only the prepared exact approval and refuses unlimited T approval', () => {
    const base = v2.collectionTargetV2(11155111, record, from);
    for (const spender of ['vault', 'tickets'] as const) {
      const t = { ...base, collectionApproval: { kind: 'token' as const, spender, amount } };
      const c = v2.collectionTokenApprovalCallV2(t, from);
      expect(c.to).toBe(t.token); expect(c.value).toBe(0n);
      expect(decodeFunctionData({ abi: boxCollectionAbi, data: c.data }).args).toEqual([getAddress(t[spender] as Address), amount]);
      assertSendableCallV2(c, t, from);
      expect(() => v2.collectionTokenApprovalCallV2({ ...t, collectionApproval: { ...t.collectionApproval, amount: maxUint256 } }, from)).toThrow();
    }
    const t = { ...base, collectionApproval: { kind: 'item' as const, id: 0n } };
    const c = v2.collectionItemApprovalCallV2(t, from);
    expect(c.to).toBe(t.collection);
    expect(decodeFunctionData({ abi: boxCollectionAbi, data: c.data }).args).toEqual([getAddress(t.vault), 0n]);
    assertSendableCallV2(c, t, from);
    expect(() => v2.collectionTokenApprovalCallV2(t, from)).toThrow();
    expect(() => v2.collectionItemApprovalCallV2(base, from)).toThrow();
  });

  it('fails at build time on missing roles, wrong caller, bad proof shape and invalid arguments', () => {
    const t = v2.collectionTargetV2(11155111, record, from);
    expect(() => v2.withdrawCallV2(t, 0n, amount, deadline, a(101n))).toThrow();
    expect(() => v2.withdrawCallV2({ ...t, vault: undefined } as WriteTargetV2, 0n, amount, deadline, from)).toThrow();
    expect(() => v2.drawCallV2(t, amount, deadline, from)).toThrow();
    expect(() => v2.takeCallV2({ ...t, tickets: undefined }, 1n, amount, deadline, from)).toThrow();
    expect(() => v2.returnItemsCallV2(t, [], 0n, deadline, from)).toThrow();
    expect(() => v2.revealCallV2(t, 0n, { ...reveal, proof: ['0x1234'] }, from)).toThrow();
    expect(() => v2.openCallV2(t, 1n, { ...reveal, traitsPacked: 1n << 128n }, from)).toThrow();
  });

  it.each([
    [0n, '0x0'],
    [123n, '0x7b'],
    [9_007_199_254_740_993n, '0x20000000000001'],
  ] as const)('TA32-F1: submitWrite forwards the exact validated draw bounty of %s wei', async (drawValue, expectedValue) => {
    const target = { ...v2.collectionTargetV2(11155111, record, from), drawValue };
    const call = v2.drawCallV2(target, amount, deadline, from);
    let sent: unknown;
    const wallet: Eip1193Request = async request => {
      if (request.method === 'eth_chainId') return '0xaa36a7';
      if (request.method === 'eth_accounts') return [from];
      if (request.method !== 'eth_sendTransaction') throw new Error('unexpected wallet request');
      sent = request.params;
      return zeroHash;
    };
    await submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v2', target, call, from, wallet, gasLimit: 1_000_000n });
    expect(sent).toEqual([{ from, to: target.tickets, data: call.data, value: expectedValue, gas: '0xf4240', ...TEST_SEND_FEE_FIELDS, chainId: '0xaa36a7' }]);
  });
});

// The proof must authenticate at the collection's position, including non-one first ids.
describe('SH-EX-L4 checked reveal calls', () => {
  it('checks the root, exact depth and id range before returning unsigned calldata', () => {
    const t = v2.collectionTargetV2(11155111, record, from);
    const leaf = keccak256(encodeAbiParameters([
      { type: 'uint256' }, { type: 'uint128' }, ...Array.from({ length: 4 }, () => ({ type: 'bytes32' as const })),
    ], [9n, reveal.traitsPacked, reveal.imageHash, reveal.avatarHash, reveal.modelHash, reveal.salt]));
    const root = keccak256(concatHex([zeroHash, leaf]));
    const item = { ...reveal, proof: [zeroHash] };
    const build = (id = 9n, r = root, n = 2n, first = 8n, value = item) =>
      v2.checkedRevealCallV2(t, id, value, { root: r, firstId: first, size: n }, from);
    expect(build()).toEqual(v2.revealCallV2(t, 9n, item, from));
    expect(() => build(8n)).toThrow(/proof/);
    expect(() => build(10n)).toThrow();
    expect(() => build(9n, zeroHash)).toThrow(/proof/);
    expect(() => build(9n, root, 0n)).toThrow();
    expect(() => build(9n, root, 3n)).toThrow(/proof/);
    expect(() => build(9n, root, 2n, 8n, reveal)).toThrow(/proof/);
  });
});

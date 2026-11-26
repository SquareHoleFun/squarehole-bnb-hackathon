import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from 'viem';
import { holderLedgerV2Abi, itemLedgerV2Abi, coordinatorV2Abi } from '../abi-v2';
import { assertSendableCallV2, type WriteCallV2, type WriteTargetV2 } from '../write-calls-v2';
import { batchState, claimableNow, claimInOrder, withClaim, withRead } from '../../../../../../apps/web/src/features/core/v2/holder-claims';
import type { HolderClaimV2 } from '../../../../../../apps/web/src/features/core/v2/actions-v2';

const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const from = address(11), other = address(12);
const target: WriteTargetV2 = { chainId: 1, token: address(1), coordinator: address(2), receiver: address(5), p: address(6), holderLedger: address(17) };
const hash: Hex = `0x${'ab'.repeat(32)}`;
const amount = 2n ** 200n + 1n;
const call: WriteCallV2 = { to: address(17), value: 0n, data: encodeFunctionData({ abi: holderLedgerV2Abi, functionName: 'claim', args: [amount, from] }) };
const credit: HolderClaimV2 = { hash, batchId: 1n, holder: from, status: 'settled', hookClosed: true, fundingFinal: true, fundingP: amount,
  complete: true, holderCursor: 2n, noticeCursor: 0n, residueP: 0n, claimableP: amount, failedBox: true, payout: 'available' };

describe('M263-WRITE: holder transaction authority', () => {
  it('admits only the prepared role-17 claim, exact bigint batch, zero value and caller recipient', () => {
    expect(() => assertSendableCallV2(call, target, from)).not.toThrow();
    const cases: WriteCallV2[] = [
      { ...call, value: 1n }, { ...call, to: address(3) }, { ...call, to: other },
      { ...call, data: `${call.data}00` }, { ...call, data: '0x1234' },
      { ...call, data: encodeFunctionData({ abi: holderLedgerV2Abi, functionName: 'claim', args: [0n, from] }) },
      { ...call, data: encodeFunctionData({ abi: holderLedgerV2Abi, functionName: 'claim', args: [1n, other] }) },
      { ...call, data: encodeFunctionData({ abi: holderLedgerV2Abi, functionName: 'settleBatch', args: [1n, 16n] }) },
      { ...call, data: encodeFunctionData({ abi: holderLedgerV2Abi, functionName: 'flushResidue', args: [1n] }) },
      { ...call, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [address(17), 1n] }) },
      { ...call, data: encodeFunctionData({ abi: parseAbi(['function claimFor(uint256,address)']), functionName: 'claimFor', args: [1n, from] }) },
    ];
    for (const refused of cases) expect(() => assertSendableCallV2(refused, target, from)).toThrow();
    for (const holderLedger of [undefined, address(0), target.token, target.coordinator, target.receiver]) {
      expect(() => assertSendableCallV2(call, { ...target, holderLedger }, from)).toThrow();
    }
    // The identical selector remains independently valid for the coordinator's fixed no-buyer claim.
    expect(() => assertSendableCallV2({ ...call, to: target.coordinator, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [0n, from] }) }, target, from)).not.toThrow();
  });

  it('F127: both generated ledger ABIs omit removed pushes and retain owner claims', () => {
    for (const abi of [holderLedgerV2Abi, itemLedgerV2Abi]) {
      const names = abi.filter(e => e.type === 'function').map(e => e.name);
      expect(names).toContain('claim'); expect(names).not.toContain('claimFor');
    }
  });
});

describe('M263-SITE: receipt, credit and sequential claim states', () => {
  it('only a read at or after the receipt decides a claim; late older reads cannot erase reorg evidence', () => {
    let session = withRead({}, 1n, { block: 90n, credit });
    session = withClaim(session, 1n, { tx: hash, block: 100n, paidP: amount });
    expect(batchState(session['1'])).toEqual({ kind: 'claimed', amount, checked: false });
    expect(claimableNow(batchState(session['1']))).toBeNull();
    session = withRead(session, 1n, { block: 101n, credit });
    expect(batchState(session['1'])).toEqual({ kind: 'unconfirmed', amount, ready: true });
    expect(withRead(session, 1n, { block: 99n, credit: { ...credit, claimableP: 0n } })).toBe(session);
    session = withRead(session, 1n, { block: 102n, credit: { ...credit, claimableP: 0n, payout: 'empty' } });
    expect(batchState(session['1'])).toEqual({ kind: 'claimed', amount, checked: true });
  });

  it.each(['open', 'awaiting_funding', 'settling', 'settled'] as const)('keeps %s distinct and never makes unavailable credit sendable', status => {
    const state = batchState({ read: { block: 1n, credit: { ...credit, status, payout: 'unavailable', claimableP: status === 'settled' ? amount : null } } });
    expect(state.kind).toBe({ open: 'open', awaiting_funding: 'funding', settling: 'calculating', settled: 'paused' }[status]);
    expect(claimableNow(state)).toBeNull();
  });

  it('Claim all waits for each receipt and stops at the first rejection', async () => {
    const sent: bigint[] = []; let finish: () => void = () => { throw new Error('receipt gate missing'); };
    const receipt = new Promise<void>(resolve => { finish = resolve; });
    const run = claimInOrder([1n, 2n, 3n], async batch => { sent.push(batch); if (batch === 1n) await receipt; else throw new Error('rejected'); });
    expect(sent).toEqual([1n]); finish();
    expect(await run).toMatchObject({ done: 1, stoppedAt: 2n }); expect(sent).toEqual([1n, 2n]);
  });
});

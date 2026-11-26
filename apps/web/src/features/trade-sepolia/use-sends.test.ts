import { describe, expect, it } from 'vitest';
import { encodeFunctionData, type Address } from 'viem';
import { TRADE_ABI, type TradeCall } from '@squarehole/chain/trade-sepolia';
import { describeStep, isCoinPlan } from './use-sends';

const HELPER = '0x0000000000000000000000000000000000000040' as Address;
const COIN = '0x0000000000000000000000000000000000000060' as Address;
const approve = (amount: bigint): TradeCall => ({ to: COIN, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'approve', args: [HELPER, amount] }), value: 0n });
const call: TradeCall = { to: HELPER, data: '0x', value: 0n };

describe('the send engine’s words for a transaction (SH-ALPHA-TEST-COINS)', () => {
  it('a box trade, a drip and a swap by their plans; an approval and its clearing by their calls', () => {
    expect(describeStep('trade', { side: 'buy' } as never, call)).toBe('Buy');
    expect(describeStep('trade', { side: 'sell' } as never, call)).toBe('Sale');
    expect(describeStep('trade', { kind: 'faucet' } as never, call)).toBe('Drip');
    expect(describeStep('trade', { kind: 'pair' } as never, call)).toBe('Swap');
    expect(describeStep('approve', { kind: 'pair' } as never, approve(5n))).toBe('Approval');
    // A reset to zero before another amount, and the revocation, both clear the approval.
    expect(describeStep('approve', { side: 'buy' } as never, approve(0n))).toBe('Approval cleared');
    expect(describeStep('revoke', { kind: 'pair' } as never, approve(0n))).toBe('Approval cleared');
  });
  it('tells a coin plan from a box trade’s by its kind', () => {
    expect(isCoinPlan({ kind: 'faucet' } as never)).toBe(true);
    expect(isCoinPlan({ side: 'buy', phase: 3 } as never)).toBe(false);
  });
});

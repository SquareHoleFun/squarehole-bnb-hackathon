import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { coordinatorV2Abi } from '../../src/core/v2/chain-v2';
import { readFailureClaimV2 } from '../../src/core/v2/claims-reads-v2';
import { m2Fixture, logM2, H } from '../../src/core/v2/m2-fixture.test-support';
import { decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { applyV2Block, liveViewV2 } from '../../src/core/v2/views-v2';
import { readMoneyV2 } from '../../src/core/v2/money-v2';
import { serviceChainV2 } from '../core/scripted-core-chain';

const initial = (1n << 200n) + 7n;
const year = 365n * 86400n;
const errors = parseAbi(['error Error(string)']);

// Canonical read doubles match the RC5 permanent claim chronology in round2/Agreement.t.sol.
// A late receipt after closure must not resurrect the creator's original entitlement.
async function fixture(claimed: boolean, late: bigint, earlyGift = 0n) {
  const f = m2Fixture(false);
  const route = routeV2(f.release, f.manifest, [], [f.record]);
  const event = (name: string, args: Record<string, unknown>, index: number, block: number) => {
    const abi = coordinatorV2Abi.find(e => e.type === 'event' && e.name === name);
    if (!abi || abi.type !== 'event') throw new Error(`missing ${name}`);
    return logM2(abi, f.at(0), args, index, BigInt(block), H(block));
  };
  const failed = applyV2Block(undefined, { number: 100n, hash: H(100), parentHash: H(99), timestamp: 1000n },
    decodeV2Logs([
      event('BoxFailed', { caller: f.record.creator, cause: 1, timestamp: 1000n }, 0, 100),
      event('PotFixed', { pot: initial, tLeft: 0n, tip: 0n, closer: f.record.creator }, 1, 100),
    ], route), f.row).state;
  const now = 1000n + year - (earlyGift > 0n ? 1n : 0n);
  const next = applyV2Block(failed, { number: 101n, hash: H(101), parentHash: H(100), timestamp: now },
    decodeV2Logs(claimed ? [event('Claimed', { holder: f.record.creator, to: f.record.creator, t: 0n, p: initial }, 0, 101)] : [], route), f.row).state;
  const pot = (claimed ? 0n : initial) + late;
  const base = serviceChainV2({ headers: [], logs: [] }, [f]);
  const reader = { callAt: async (to: Address, data: Hex, hash: Hex) => {
    expect(hash).toBe(H(101));
    if (to.toLowerCase() !== f.at(0).toLowerCase()) return base.callAt(to, data, hash);
    const { functionName, args } = decodeFunctionData({ abi: coordinatorV2Abi, data });
    if (functionName === 'quoteClaim') expect(args).toEqual([0n]);
    if (functionName === 'quoteClaim' && claimed) throw Object.assign(new Error('claim closed'), { data: encodeErrorResult({ abi: coordinatorV2Abi, errorName: 'InvalidClaim' }) });
    if (!['failed', 'claimState', 'quoteClaim'].includes(functionName)) return base.callAt(to, data, hash);
    const result = functionName === 'failed' ? true : functionName === 'claimState' ? [pot, 0n] : initial;
    return encodeFunctionResult({ abi: coordinatorV2Abi, functionName, result } as never);
  } };
  // Exercise the production money-read boundary too, so adding a canonical quote there can fix this check.
  const money = await readMoneyV2(reader, f.row, next.view, 101n, H(101));
  return { f, reader, failed, next: { ...next, money }, now, route, event };
}

function withQuote(reader: { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }, coordinator: Address, reply: () => Hex) {
  return { callAt: async (to: Address, data: Hex, hash: Hex) => {
    if (to.toLowerCase() === coordinator.toLowerCase() && decodeFunctionData({ abi: coordinatorV2Abi, data }).functionName === 'quoteClaim') {
      expect(hash).toBe(H(101));
      return reply();
    }
    return reader.callAt(to, data, hash);
  } };
}

describe('FINAL2-OC01: published creator entitlement follows actual successful owner claim', () => {
  it('time alone cannot expire an unclaimed no-buyer claim; without a money read the snapshot states no amount', async () => {
    const { f, reader, failed, next, now } = await fixture(false, 19n);
    expect(await readFailureClaimV2(reader, f.row, f.record.creator, H(101), true)).toMatchObject({ amountP: initial });
    expect(liveViewV2(next, now).closing?.creatorEntitlement).toBe(initial);
    // INBOX af2: later inbox P can add to the remainder, so only the canonical quote states it (unavailable until read).
    expect(liveViewV2(failed, now).closing?.creatorEntitlement).toBeNull();
  });

  it.each([0n, initial + 19n])('a claimed no-buyer claim stays closed with %s late P', async late => {
    const { f, reader, failed, next, now } = await fixture(true, late);
    expect(await readFailureClaimV2(reader, f.row, f.record.creator, H(101), true)).toBeNull();
    expect(liveViewV2(failed, now - 1n).closing?.creatorEntitlement).toBeNull();
    expect(liveViewV2(next, now).closing?.creatorEntitlement,
      'the canonical claims reader says exhausted; the box snapshot must not offer the old amount').toBe(0n);
  });

  it('publishes the canonical quote even when event arithmetic would give a different amount', async () => {
    const { f, reader, next, now } = await fixture(false, 19n);
    const quoted = initial - 3n;
    const money = await readMoneyV2(withQuote(reader, f.at(0), () => encodeFunctionResult({ abi: coordinatorV2Abi, functionName: 'quoteClaim', result: quoted })), f.row, next.view, 101n, H(101));
    expect(money.claim).toMatchObject({ creatorEntitlement: quoted });
    expect(money.values['coordinator.creatorEntitlement']).toBe(String(quoted));
    expect(liveViewV2({ ...next, money }, now).closing?.creatorEntitlement).toBe(quoted);
  });

  it.each([
    encodeErrorResult({ abi: coordinatorV2Abi, errorName: 'InvalidClaim' }),
  ])('only a decoded exhaustion refusal becomes zero: %s', async data => {
    const { f, reader, next, now } = await fixture(false, initial + 19n);
    const money = await readMoneyV2(withQuote(reader, f.at(0), () => { throw new Error('RPC wrapper', { cause: { data } }); }), f.row, next.view, 101n, H(101));
    expect(liveViewV2({ ...next, money }, now).closing?.creatorEntitlement).toBe(0n);
  });

  it.each([
    new Error('RPC timeout: ClaimsClaimed'),
    Object.assign(new Error('unknown refusal'), { data: encodeErrorResult({ abi: errors, errorName: 'Error', args: ['unrecognized'] }) }),
    Object.assign(new Error('not failed'), { data: encodeErrorResult({ abi: coordinatorV2Abi, errorName: 'NotFailed' }) }),
    Object.assign(new Error('malformed revert'), { data: '0x1234' }),
  ])('propagates an unavailable quote instead of publishing zero or the initial pot: %s', async error => {
    const { f, reader, next } = await fixture(false, 0n);
    await expect(readMoneyV2(withQuote(reader, f.at(0), () => { throw error; }), f.row, next.view, 101n, H(101))).rejects.toBe(error);
  });

  it.each(['0x', encodeFunctionResult({ abi: coordinatorV2Abi, functionName: 'quoteClaim', result: initial + 1n })] as Hex[])(
    'refuses malformed or unbacked quotes: %s', async data => {
      const { f, reader, next } = await fixture(false, 0n);
      await expect(readMoneyV2(withQuote(reader, f.at(0), () => data), f.row, next.view, 101n, H(101))).rejects.toThrow();
    },
  );

  it('does not request a no-buyer quote for live boxes or an exhausted holder pot', async () => {
    const { f, reader, next, now } = await fixture(false, 0n);
    const unavailable = withQuote(reader, f.at(0), () => { throw new Error('unexpected no-buyer read'); });
    for (const claim of [null, next.view.claim && { ...next.view.claim, initialT: 7n, tLeft: 0n }]) {
      const view = { ...next.view, claim };
      const money = await readMoneyV2(unavailable, f.row, view, 101n, H(101));
      expect(money.claim).toMatchObject({ creatorEntitlement: 0n });
      expect(liveViewV2({ ...next, view, money }, now).closing?.creatorEntitlement ?? 0n).toBe(0n);
    }
  });

  it('never publishes a FIT sweep, nor a remainder from event arithmetic after late gifts', async () => {
    const { next, now } = await fixture(false, initial + 19n);
    const view = liveViewV2(next, now);
    expect(view.closing?.creatorEntitlement).toBe(initial);
    expect(view.closing).not.toHaveProperty('sweptToFit');
    expect(view.safePaid.fit).toEqual({});
  });
});
